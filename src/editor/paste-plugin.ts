/**
 * Paste-handling plugin.
 *
 * Two interventions over PM's default clipboard handling:
 *
 * 1. **Plain-paste-armed mode (F2).** Browsers won't let a web app
 *    read the clipboard programmatically without a permission prompt
 *    (Chrome's "Paste" chip, Firefox's "Paste" popup — Mozilla doesn't
 *    even offer a permanent grant), so a Verbatim-style "F2 pastes
 *    plain text" can't be a single-keystroke action in a browser.
 *    Instead F2 toggles a plugin-state flag; the next real `paste`
 *    event (a user-initiated Ctrl/Cmd+V) consumes the flag, strips
 *    all formatting, inserts the clipboard's `text/plain` content,
 *    and disarms. If `condenseOnPaste` is on (matches the F3 default
 *    condense), runs that immediately after. Pressing F2 again
 *    before the paste toggles the flag back off. The status-bar UI
 *    shows the armed state.
 *
 * 2. **Tag/analytic paste splits the destination container.** When
 *    PM's parsed clipboard slice's first child is a `tag` or
 *    `analytic` node and the cursor sits in a body slot
 *    (`card_body` / `cite_paragraph` / `undertag`) of a `card` /
 *    `analytic_unit`, the default "fit inline content where it
 *    matches" behavior strips the heading wrapper and converts to
 *    body text. That's wrong — the user wanted the structural
 *    type. We instead split the destination container: original
 *    keeps the pre-cursor children and pre-cursor body text; new
 *    container (card if pasted head is a tag, analytic_unit if it's
 *    an analytic) gets the pasted head + post-cursor body remainder
 *    + the original container's following children. Falls through
 *    to default PM behavior in any other shape (no head node,
 *    cursor not in a body slot, etc.).
 *
 * Order: armed mode wins over auto-split.
 */

import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { DOMParser as PMDOMParser, Fragment, Slice, type Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { schema } from '../schema/index.js';
import { condenseBranchC, condenseMerge } from './condense.js';
import { buildImageNodeFromBlob, insertImageNode } from './image-insert.js';

/**
 * Build a Slice representing `text` as plain inline content, splitting
 * on newlines into paragraph breaks. Exported for unit tests.
 *
 * - Single line → `Slice(Fragment(text), 0, 0)` so it merges into the
 *   selection's textblock without forcing a paragraph type.
 * - Multi-line → `Slice([paragraph(line0), paragraph(line1), …], 1, 1)`.
 *   The 1/1 opens mean the first line's content joins the cursor's
 *   block and intermediate splits inherit the surrounding block type
 *   (card_body inside a card, etc.). This is the same shape PM's
 *   default plain-text clipboard parser produces.
 */
export function buildPlainTextSlice(text: string): Slice {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length === 1) {
    return new Slice(
      lines[0] ? Fragment.from(schema.text(lines[0])) : Fragment.empty,
      0,
      0,
    );
  }
  const paragraphs = lines.map((line) =>
    schema.nodes['paragraph']!.create(null, line ? schema.text(line) : null),
  );
  return new Slice(Fragment.fromArray(paragraphs), 1, 1);
}

/** Block types that hold single-line / single-paragraph content
 *  in our schema. Plain-paste into these MUST flatten any
 *  internal newlines to spaces — pasting "Article Title\n" (a
 *  triple-click selection in the browser often carries that
 *  trailing newline) used to split the surrounding card at the
 *  newline boundary because the resulting multi-paragraph slice
 *  forced PM to break out of the single-line parent. */
const SINGLE_LINE_PASTE_PARENTS = new Set<string>([
  'tag',
  'cite_paragraph',
  'undertag',
  'analytic',
]);

/** Normalize clipboard text for paste into the given parent block.
 *  In single-line contexts (`SINGLE_LINE_PASTE_PARENTS`), collapse
 *  any whitespace run (newlines, tabs, repeated spaces) to a single
 *  space and trim the edges. In multi-paragraph contexts
 *  (`card_body`, `paragraph`, etc.) leave the text alone so
 *  intentional paragraph splits in the clipboard survive. */
export function normalizeClipboardTextForPaste(
  text: string,
  parentTypeName: string,
): string {
  if (SINGLE_LINE_PASTE_PARENTS.has(parentTypeName)) {
    return text.replace(/\s+/g, ' ').trim();
  }
  return text;
}

const SPLITTABLE_BODY_SLOTS = new Set<string>([
  'card_body',
  'cite_paragraph',
  'undertag',
]);

export interface PastePluginCtx {
  condenseOnPaste: () => boolean;
  paragraphIntegrity: () => boolean;
  usePilcrows: () => boolean;
  headingMode: () => 'strict' | 'respect' | 'demolish';
  /** Called whenever the armed flag flips, so the chrome can mirror it. */
  onArmedChange?: (armed: boolean) => void;
}

interface PluginState {
  plainPasteArmed: boolean;
}

export const plainPasteKey = new PluginKey<PluginState>('pmd-paste');

/** Is the next Ctrl/Cmd+V going to be treated as plain-paste? */
export function isPlainPasteArmed(state: EditorState): boolean {
  return plainPasteKey.getState(state)?.plainPasteArmed ?? false;
}

/** Toggle the plain-paste flag. Used by F2 in the browser edition,
 *  where Chromium's clipboard-permission UI forbids a synchronous
 *  one-keystroke paste. Electron's F2 path uses
 *  `applyPlainPasteFromText` directly instead. */
export function togglePlainPaste(): (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean {
  return (state, dispatch) => {
    if (!dispatch) return true;
    const armed = isPlainPasteArmed(state);
    dispatch(state.tr.setMeta(plainPasteKey, { plainPasteArmed: !armed }));
    return true;
  };
}

/** Replace the current selection with `text` as plain inline
 *  content, with the same condense-after-paste behavior the armed-
 *  mode `handlePaste` path uses. Exported for Electron's F2 flow,
 *  which fetches the clipboard via IPC and pastes directly without
 *  the browser-only "arm then Ctrl/Cmd+V" dance. No-op when `text`
 *  is empty. */
export function applyPlainPasteFromText(
  view: EditorView,
  text: string,
  ctx: {
    condenseOnPaste: () => boolean;
    paragraphIntegrity: () => boolean;
    usePilcrows: () => boolean;
    headingMode: () => 'strict' | 'respect' | 'demolish';
  },
): void {
  if (!text) return;
  // Mirror the in-handler normalization for the Electron F2 / menu
  // path. Single-line target parents (tag / cite_paragraph /
  // undertag / analytic) collapse internal whitespace; multi-line
  // parents pass through unchanged.
  const normalized = normalizeClipboardTextForPaste(
    text,
    view.state.selection.$from.parent.type.name,
  );
  if (!normalized) return;
  const slice = buildPlainTextSlice(normalized);
  let tr = view.state.tr.replaceSelection(slice);
  tr.setStoredMarks([]);
  view.dispatch(tr.scrollIntoView());
  if (ctx.condenseOnPaste()) {
    const cmd = ctx.paragraphIntegrity()
      ? condenseBranchC()
      : condenseMerge({
          withPilcrows: ctx.usePilcrows(),
          headingMode: ctx.headingMode(),
        });
    cmd(view.state, view.dispatch.bind(view));
  }
}

export function buildPastePlugin(ctx: PastePluginCtx): Plugin<PluginState> {
  return new Plugin<PluginState>({
    key: plainPasteKey,
    state: {
      init: () => ({ plainPasteArmed: false }),
      apply(tr, value) {
        const meta = tr.getMeta(plainPasteKey) as PluginState | undefined;
        if (meta && typeof meta.plainPasteArmed === 'boolean') {
          if (meta.plainPasteArmed !== value.plainPasteArmed) {
            ctx.onArmedChange?.(meta.plainPasteArmed);
          }
          return meta;
        }
        return value;
      },
    },
    props: {
      handlePaste(view, event, slice) {
        // Clipboard image paste — screenshots, copy-image from a
        // browser, etc. Take precedence over text / HTML branches
        // when the clipboard carries `image/*` file data; users
        // pasting a screenshot don't want the fallback text label.
        const files = event.clipboardData?.files;
        if (files && files.length > 0) {
          const imageFile = Array.from(files).find((f) => f.type.startsWith('image/'));
          if (imageFile) {
            event.preventDefault();
            void (async () => {
              const node = await buildImageNodeFromBlob(imageFile);
              if (node) insertImageNode(view, node);
            })();
            return true;
          }
        }
        const armed = isPlainPasteArmed(view.state);
        if (armed) {
          // Sticky-toggle behavior: plain-paste stays on until the user
          // explicitly turns it off (F2 again or the ribbon button).
          // Every Ctrl/Cmd+V while armed pastes plain.
          event.preventDefault();
          const raw = event.clipboardData?.getData('text/plain') ?? '';
          const text = normalizeClipboardTextForPaste(
            raw,
            view.state.selection.$from.parent.type.name,
          );
          if (!text) return true;
          const plainSlice = buildPlainTextSlice(text);
          let tr = view.state.tr.replaceSelection(plainSlice);
          tr.setStoredMarks([]);
          view.dispatch(tr.scrollIntoView());
          if (ctx.condenseOnPaste()) {
            const cmd = ctx.paragraphIntegrity()
              ? condenseBranchC()
              : condenseMerge({
                  withPilcrows: ctx.usePilcrows(),
                  headingMode: ctx.headingMode(),
                });
            cmd(view.state, view.dispatch.bind(view));
          }
          return true;
        }

        const head = detectPastedHead(slice, event);
        if (head) {
          // Synthesize a clean single-head slice so the split logic
          // doesn't have to second-guess PM's contextual re-shaping of
          // the original slice.
          const synthetic = new Slice(Fragment.from(head), 0, 0);
          const splitTr = tryPasteSplitContainer(view.state, synthetic);
          if (splitTr) {
            event.preventDefault();
            view.dispatch(splitTr.scrollIntoView());
            return true;
          }
        }

        // Multi-paragraph paste into a card_body cursor context:
        // pre-fit the slice into card_body children so PM doesn't
        // bubble the split up to the card level (which produces
        // a phantom empty-tag card sibling).
        const cardBodyTr = tryPasteAsCardBodies(view.state, slice);
        if (cardBodyTr) {
          event.preventDefault();
          view.dispatch(cardBodyTr.scrollIntoView());
          return true;
        }

        return false;
      },
    },
  });
}

/**
 * When the pasted slice's first child is a `tag` or `analytic` node and
 * the cursor is in a body slot of a `card` / `analytic_unit`, split the
 * container so the pasted head starts a new card / analytic_unit at
 * the cursor's position. Returns null otherwise so PM handles the
 * paste normally.
 *
 * Exported for unit tests.
 */
export function tryPasteSplitContainer(
  state: EditorState,
  slice: Slice,
): Transaction | null {
  if (slice.content.childCount === 0) return null;
  const pastedHead = slice.content.firstChild;
  if (!pastedHead) return null;
  const headName = pastedHead.type.name;
  if (headName !== 'tag' && headName !== 'analytic') return null;
  // Multi-node pastes (e.g. user copied a whole card with tag + bodies)
  // fall through to PM's default handling. A tag node ALONE is the
  // case the user described.
  if (slice.content.childCount !== 1) return null;

  const $from = state.selection.$from;
  if ($from.depth !== 2) return null;
  const cursorBody = $from.parent;
  if (!SPLITTABLE_BODY_SLOTS.has(cursorBody.type.name)) return null;
  const container = $from.node(1);
  const containerName = container.type.name;
  if (containerName !== 'card' && containerName !== 'analytic_unit') return null;

  let cursorIndex = -1;
  container.forEach((child, _o, idx) => {
    if (cursorIndex === -1 && child === cursorBody) cursorIndex = idx;
  });
  if (cursorIndex < 1) return null;

  const parentOffset = $from.parentOffset;
  const preContent = cursorBody.content.cut(0, parentOffset);
  const postContent = cursorBody.content.cut(parentOffset);

  const beforeChildren: PMNode[] = [];
  const followingChildren: PMNode[] = [];
  container.forEach((child, _o, idx) => {
    if (idx < cursorIndex) beforeChildren.push(child);
    else if (idx > cursorIndex) followingChildren.push(child);
  });

  const bodyType = cursorBody.type;
  const preBody = preContent.size > 0 ? bodyType.create(null, preContent) : null;
  const postBody = postContent.size > 0 ? bodyType.create(null, postContent) : null;

  const originalChildren = [...beforeChildren];
  if (preBody) originalChildren.push(preBody);

  const newContainerName: 'card' | 'analytic_unit' =
    headName === 'tag' ? 'card' : 'analytic_unit';

  // When splitting off an analytic_unit from a card, any following
  // children that are `analytic` (cite-position-alternative) must be
  // re-wrapped as card_body — analytic_unit's content rule only
  // permits one `analytic` (the head).
  const followingFitted = followingChildren.map((child) =>
    newContainerName === 'analytic_unit' && child.type.name === 'analytic'
      ? schema.nodes['card_body']!.create(null, child.content)
      : child,
  );

  const newChildren: PMNode[] = [pastedHead];
  if (postBody) newChildren.push(postBody);
  newChildren.push(...followingFitted);

  const originalContainer = container.copy(Fragment.fromArray(originalChildren));
  const newContainer = schema.nodes[newContainerName]!.create(null, newChildren);

  const containerFrom = $from.before(1);
  const containerTo = $from.after(1);
  const replacement = Fragment.fromArray([originalContainer, newContainer]);
  let tr = state.tr.replaceWith(containerFrom, containerTo, replacement);

  // Cursor at the end of the pasted head's text — same convention as
  // F7 (setTag), so the user can immediately edit the heading name.
  const newContainerStart = containerFrom + originalContainer.nodeSize;
  const cursorPos = newContainerStart + 1 + pastedHead.content.size + 1;
  try {
    tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
  } catch {
    /* schema rejected the position — selection stays where PM left it */
  }
  return tr;
}

/**
 * Pre-fit a multi-paragraph paste into a `card_body` cursor
 * context: convert each top-level paragraph in the slice into a
 * `card_body` of the same content, then `replaceSelection`. Lets
 * PM split WITHIN the card cleanly instead of bubbling the split
 * up to the card level and producing a phantom-empty-tag sibling
 * card. Returns null when the cursor isn't in a card_body, the
 * slice isn't a single-depth multi-paragraph shape, or the
 * cursor's containing card / analytic_unit isn't a valid target.
 *
 * Exported for tests.
 */
export function tryPasteAsCardBodies(
  state: EditorState,
  slice: Slice,
): Transaction | null {
  // Slice must be multi-paragraph at depth 1 (no nested
  // containers). Anything else falls through to PM's default.
  if (slice.content.childCount < 2) return null;
  for (let i = 0; i < slice.content.childCount; i++) {
    if (slice.content.child(i).type.name !== 'paragraph') return null;
  }

  // Cursor must be in a card_body inside a card or analytic_unit
  // (both accept card_body in their content rules).
  const sel = state.selection;
  if (!(sel instanceof TextSelection)) return null;
  const $from = sel.$from;
  if ($from.parent.type.name !== 'card_body') return null;
  if ($from.depth < 2) return null;
  const container = $from.node($from.depth - 1);
  const containerName = container.type.name;
  if (containerName !== 'card' && containerName !== 'analytic_unit') return null;

  const cardBodyType = schema.nodes['card_body'];
  if (!cardBodyType) return null;

  // Convert each paragraph child to a card_body, preserving
  // content (including any inline marks).
  const converted: PMNode[] = [];
  slice.content.forEach((p) => {
    converted.push(cardBodyType.create(null, p.content));
  });
  const newSlice = new Slice(
    Fragment.fromArray(converted),
    slice.openStart,
    slice.openEnd,
  );
  return state.tr.replace(sel.from, sel.to, newSlice);
}

/**
 * Find a `tag` or `analytic` node that the user is pasting, regardless
 * of how PM has shaped the slice. Two paths:
 *
 * 1. **Slice walk.** Walks `slice.content.firstChild` and its first
 *    descendants through single-child wrappers (a common shape when
 *    PM's `Slice.maxOpen` opens a slice down through the head's parent
 *    container before exposing the head itself).
 * 2. **HTML fallback.** PM may have unwrapped the head into bare
 *    inline content when fitting the slice to the cursor's body slot
 *    (`<h4 class="pmd-tag">…</h4>` → inline-only slice because card_body
 *    accepts `inline*`). The clipboard's `text/html` still carries
 *    the original markup, so re-parse it with PM's parser outside
 *    of any contextual fitting and pick out the head node.
 *
 * Exported for tests.
 */
export function detectPastedHead(slice: Slice, event: ClipboardEvent): PMNode | null {
  const fromSlice = findHeadInSlice(slice);
  if (fromSlice) return fromSlice;
  return parseHeadFromHTML(event);
}

function findHeadInSlice(slice: Slice): PMNode | null {
  if (slice.content.childCount === 0) return null;
  let node: PMNode | null = slice.content.firstChild;
  while (node) {
    const n = node.type.name;
    if (n === 'tag' || n === 'analytic') return node;
    // Only descend through single-child structural wrappers — a multi-
    // child container (whole-card paste, etc.) is a different shape and
    // falls through.
    if (node.isLeaf || node.childCount !== 1) return null;
    node = node.firstChild;
  }
  return null;
}

function parseHeadFromHTML(event: ClipboardEvent): PMNode | null {
  if (typeof document === 'undefined') return null;
  const html = event.clipboardData?.getData('text/html') ?? '';
  if (!html) return null;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  // PM's clipboard serializer prepends `<!--ProseMirror--><meta>` markers;
  // hop past them to find the first real structural element.
  let first: Element | null = wrap.firstElementChild;
  while (first && (first.tagName === 'META' || first.tagName === 'STYLE')) {
    first = first.nextElementSibling;
  }
  if (!first) return null;
  const isTag = first.tagName === 'H4' && first.classList.contains('pmd-tag');
  const isAnalytic = first.tagName === 'P' && first.classList.contains('pmd-analytic');
  if (!isTag && !isAnalytic) return null;
  // Re-parse without context: we don't pass `context: $from` so PM's
  // parser doesn't strip the head to fit the cursor's body slot.
  const wrapForParse = document.createElement('div');
  wrapForParse.appendChild(first.cloneNode(true));
  const parsed = PMDOMParser.fromSchema(schema).parseSlice(wrapForParse);
  const node = parsed.content.firstChild;
  if (!node) return null;
  if (node.type.name !== 'tag' && node.type.name !== 'analytic') return null;
  return node;
}
