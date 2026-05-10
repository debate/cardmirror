/**
 * Verbatim ribbon commands — structural style application
 * (ARCHITECTURE.md §15 ribbon-command parity).
 *
 * Phase 1: F4 / F5 / F6 / F7 — set current paragraph or heading to
 * Pocket / Hat / Block / Tag.
 *
 * Conversion rules:
 *   - paragraph at doc root → target heading (new id)
 *   - pocket / hat / block at doc root → target heading (preserve id)
 *   - tag inside card → dissolve card; tag → target heading. Card
 *     children that follow become loose doc-level siblings:
 *     card_body → paragraph, cite_paragraph → paragraph, undertag is
 *     kept, analytic gets wrapped in an analytic_unit.
 *   - analytic inside analytic_unit → analogous dissolve
 *   - card_body inside card/analytic_unit:
 *       - F4–F6 split the container: everything before the cursor body
 *         stays in the container; the cursor body becomes a heading
 *         after; following children lift out as loose paragraphs
 *         (card_body / cite_paragraph → paragraph, undertag kept,
 *         analytic wrapped in analytic_unit).
 *       - F7 splits into two cards: cursor body becomes the tag of
 *         a new card; following children (card_body / undertag /
 *         cite_paragraph / analytic) become that new card's body.
 *   - F7 on a tag → accept no-op
 *   - F7 on doc-level paragraph/heading → wrap as card with tag
 *     carrying the original content (preserve id on heading → tag)
 *   - F7 on analytic-as-anchor of analytic_unit → analytic_unit
 *     becomes card; analytic becomes tag
 *
 * Returns false (no-op) for contexts the command doesn't handle:
 * cite_paragraph / undertag cursors, or an analytic that's the
 * cite-slot of a card rather than the anchor of an analytic_unit.
 */

import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { Selection, TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import { schema } from '../schema/index.js';
import { newHeadingId } from '../schema/ids.js';

type HeadingTypeName = 'pocket' | 'hat' | 'block';

const DOC_HEADINGS = new Set<string>(['pocket', 'hat', 'block']);
const CONTAINER_HEAD = new Set<string>(['tag', 'analytic']);

/**
 * F4 / F5 / F6 — convert the current paragraph or heading to the target
 * doc-level heading type.
 */
export function setHeading(typeName: HeadingTypeName): Command {
  return (state, dispatch) => {
    if (!state.selection.empty) {
      return applyStructuralToSelection(state, dispatch, {
        mode: 'heading',
        headingType: typeName,
      });
    }
    const $from = state.selection.$from;

    if ($from.depth === 1) {
      const parent = $from.parent;
      const pname = parent.type.name;
      if (pname === typeName) return true;
      if (pname !== 'paragraph' && !DOC_HEADINGS.has(pname)) return false;
      if (!dispatch) return true;
      const id = pname === 'paragraph'
        ? newHeadingId()
        : ((parent.attrs['id'] as string | null) ?? newHeadingId());
      const tr = state.tr.setNodeMarkup(
        $from.before(1),
        schema.nodes[typeName]!,
        { id },
      );
      dispatch(tr.scrollIntoView());
      return true;
    }

    if ($from.depth === 2 && CONTAINER_HEAD.has($from.parent.type.name)) {
      return dissolveContainerToHeading(state, dispatch, typeName);
    }

    if ($from.depth === 2 && $from.parent.type.name === 'card_body') {
      return splitContainerAtBody(state, dispatch, { mode: 'heading', headingType: typeName });
    }

    return false;
  };
}

/**
 * F7 — convert the current paragraph or heading to a tag, wrapping in
 * a card. On an analytic-anchor, convert the analytic_unit to a card.
 */
export function setTag(): Command {
  return (state, dispatch) => {
    if (!state.selection.empty) {
      return applyStructuralToSelection(state, dispatch, { mode: 'tag' });
    }
    const $from = state.selection.$from;

    if ($from.depth === 1) {
      const parent = $from.parent;
      const pname = parent.type.name;
      if (pname !== 'paragraph' && !DOC_HEADINGS.has(pname)) return false;
      if (!dispatch) return true;
      const id = pname === 'paragraph'
        ? newHeadingId()
        : ((parent.attrs['id'] as string | null) ?? newHeadingId());
      const tagNode = schema.nodes['tag']!.create({ id }, parent.content);
      const cardNode = schema.nodes['card']!.create(null, [tagNode]);
      const from = $from.before(1);
      const to = $from.after(1);
      let tr = state.tr.replaceWith(from, to, cardNode);
      // After replace: doc → card@from → tag@(from+1) → content@(from+2)
      const cursorPos = from + 2 + Math.min($from.parentOffset, parent.content.size);
      tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
      // No scrollIntoView — wrapping in a card adds vertical chrome
      // (tag margin + card padding), so following the new selection
      // produces a jarring viewport scroll even when the cursor is
      // already visible. F4–F6 use setNodeMarkup and don't shift
      // layout, so their behavior matches without explicit suppression.
      dispatch(tr);
      return true;
    }

    if ($from.depth === 2 && $from.parent.type.name === 'tag') {
      return true;
    }

    if (
      $from.depth === 2 &&
      $from.parent.type.name === 'analytic' &&
      $from.node(1).type.name === 'analytic_unit' &&
      $from.node(1).firstChild === $from.parent
    ) {
      return convertAnalyticUnitToCard(state, dispatch);
    }

    if ($from.depth === 2 && $from.parent.type.name === 'card_body') {
      return splitContainerAtBody(state, dispatch, { mode: 'tag' });
    }

    return false;
  };
}

/**
 * Mod-F7 — same as F7 but produces analytic_unit / analytic instead of
 * card / tag. cite_paragraph and analytic following children get folded
 * into card_body (text preserved, custom type lost) because analytic_unit
 * only allows analytic + (card_body | undertag)*.
 */
export function setAnalytic(): Command {
  return (state, dispatch) => {
    if (!state.selection.empty) {
      return applyStructuralToSelection(state, dispatch, { mode: 'analytic' });
    }
    const $from = state.selection.$from;

    if ($from.depth === 1) {
      const parent = $from.parent;
      const pname = parent.type.name;
      if (pname !== 'paragraph' && !DOC_HEADINGS.has(pname)) return false;
      if (!dispatch) return true;
      const id = pname === 'paragraph'
        ? newHeadingId()
        : ((parent.attrs['id'] as string | null) ?? newHeadingId());
      const analyticNode = schema.nodes['analytic']!.create({ id }, parent.content);
      const unitNode = schema.nodes['analytic_unit']!.create(null, [analyticNode]);
      const from = $from.before(1);
      const to = $from.after(1);
      let tr = state.tr.replaceWith(from, to, unitNode);
      // doc → analytic_unit@from → analytic@(from+1) → content@(from+2)
      const cursorPos = from + 2 + Math.min($from.parentOffset, parent.content.size);
      tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
      dispatch(tr);
      return true;
    }

    if (
      $from.depth === 2 &&
      $from.parent.type.name === 'analytic' &&
      $from.node(1).type.name === 'analytic_unit' &&
      $from.node(1).firstChild === $from.parent
    ) {
      return true;
    }

    if (
      $from.depth === 2 &&
      $from.parent.type.name === 'tag' &&
      $from.node(1).type.name === 'card' &&
      $from.node(1).firstChild === $from.parent
    ) {
      return convertCardToAnalyticUnit(state, dispatch);
    }

    if ($from.depth === 2 && $from.parent.type.name === 'card_body') {
      return splitContainerAtBody(state, dispatch, { mode: 'analytic' });
    }

    return false;
  };
}

function convertCardToAnalyticUnit(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
): boolean {
  const $from = state.selection.$from;
  const tag = $from.parent;
  const card = $from.node(1);
  if (!dispatch) return true;

  const id = (tag.attrs['id'] as string | null) ?? newHeadingId();
  const analyticNode = schema.nodes['analytic']!.create({ id }, tag.content);
  const rest: PMNode[] = [];
  card.forEach((child, _offset, index) => {
    if (index === 0) return;
    rest.push(toAnalyticUnitChild(child));
  });
  const unitNode = schema.nodes['analytic_unit']!.create(null, [analyticNode, ...rest]);

  const from = $from.before(1);
  const to = $from.after(1);
  let tr = state.tr.replaceWith(from, to, unitNode);
  const cursorPos = from + 2 + Math.min($from.parentOffset, tag.content.size);
  tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
  dispatch(tr);
  return true;
}

function toAnalyticUnitChild(child: PMNode): PMNode {
  const t = child.type.name;
  if (t === 'card_body' || t === 'undertag') return child;
  // analytic_unit content = analytic (card_body | undertag)*; fold any
  // cite_paragraph or analytic (cite-slot) child into card_body so the
  // text comes along even though the styling can't.
  return schema.nodes['card_body']!.create(null, child.content);
}

type SplitMode =
  | { mode: 'heading'; headingType: HeadingTypeName }
  | { mode: 'tag' }
  | { mode: 'analytic' };

function splitContainerAtBody(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  opts: SplitMode,
): boolean {
  const $from = state.selection.$from;
  const cursorBody = $from.parent;
  if (cursorBody.type.name !== 'card_body') return false;
  const container = $from.node(1);
  const containerName = container.type.name;
  if (containerName !== 'card' && containerName !== 'analytic_unit') return false;

  let cursorIndex = -1;
  container.forEach((child, _offset, index) => {
    if (cursorIndex === -1 && child === cursorBody) cursorIndex = index;
  });
  if (cursorIndex < 1) return false;

  if (!dispatch) return true;

  const beforeChildren: PMNode[] = [];
  const followingChildren: PMNode[] = [];
  container.forEach((child, _offset, index) => {
    if (index < cursorIndex) beforeChildren.push(child);
    else if (index > cursorIndex) followingChildren.push(child);
  });
  const beforeContainer = container.copy(Fragment.fromArray(beforeChildren));

  let liftedNodes: PMNode[];
  let insideOffset: number;
  if (opts.mode === 'heading') {
    const headingType = schema.nodes[opts.headingType]!;
    const newHead = headingType.create({ id: newHeadingId() }, cursorBody.content);
    const followingLifted = followingChildren.map(liftCardChild);
    liftedNodes = [newHead, ...followingLifted];
    insideOffset = 1;
  } else if (opts.mode === 'tag') {
    const tagNode = schema.nodes['tag']!.create({ id: newHeadingId() }, cursorBody.content);
    // following children are already valid card content (card_body /
    // undertag / cite_paragraph / analytic), so pass through unchanged.
    const newCard = schema.nodes['card']!.create(null, [tagNode, ...followingChildren]);
    liftedNodes = [newCard];
    insideOffset = 2;
  } else {
    const analyticNode = schema.nodes['analytic']!.create({ id: newHeadingId() }, cursorBody.content);
    const followingForUnit = followingChildren.map(toAnalyticUnitChild);
    const newUnit = schema.nodes['analytic_unit']!.create(null, [analyticNode, ...followingForUnit]);
    liftedNodes = [newUnit];
    insideOffset = 2;
  }

  const containerFrom = $from.before(1);
  const containerTo = $from.after(1);
  const replacement = Fragment.fromArray([beforeContainer, ...liftedNodes]);
  let tr = state.tr.replaceWith(containerFrom, containerTo, replacement);

  const cursorPos =
    containerFrom + beforeContainer.nodeSize + insideOffset +
    Math.min($from.parentOffset, cursorBody.content.size);
  tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
  dispatch(tr);
  return true;
}

function dissolveContainerToHeading(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  typeName: HeadingTypeName,
): boolean {
  const $from = state.selection.$from;
  const head = $from.parent;
  const container = $from.node(1);
  // Only dissolve when the head is the container's required anchor.
  if (container.firstChild !== head) return false;
  if (container.type.name === 'card' && head.type.name !== 'tag') return false;
  if (container.type.name === 'analytic_unit' && head.type.name !== 'analytic') return false;

  if (!dispatch) return true;

  const id = (head.attrs['id'] as string | null) ?? newHeadingId();
  const newHeading = schema.nodes[typeName]!.create({ id }, head.content);

  const lifted: PMNode[] = [newHeading];
  container.forEach((child, _offset, index) => {
    if (index === 0) return;
    lifted.push(liftCardChild(child));
  });

  const from = $from.before(1);
  const to = $from.after(1);
  let tr = state.tr.replaceWith(from, to, Fragment.fromArray(lifted));
  const cursorPos = from + 1 + Math.min($from.parentOffset, head.content.size);
  tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
  dispatch(tr.scrollIntoView());
  return true;
}

function liftCardChild(child: PMNode): PMNode {
  const t = child.type.name;
  if (t === 'card_body' || t === 'cite_paragraph') {
    return schema.nodes['paragraph']!.create(null, child.content);
  }
  if (t === 'analytic') {
    return schema.nodes['analytic_unit']!.create(null, [child]);
  }
  return child;
}

function convertAnalyticUnitToCard(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
): boolean {
  const $from = state.selection.$from;
  const analytic = $from.parent;
  const unit = $from.node(1);
  if (!dispatch) return true;

  const id = (analytic.attrs['id'] as string | null) ?? newHeadingId();
  const tagNode = schema.nodes['tag']!.create({ id }, analytic.content);
  const rest: PMNode[] = [];
  unit.forEach((child, _offset, index) => {
    if (index === 0) return;
    rest.push(child);
  });
  const cardNode = schema.nodes['card']!.create(null, [tagNode, ...rest]);

  const from = $from.before(1);
  const to = $from.after(1);
  let tr = state.tr.replaceWith(from, to, cardNode);
  // After replace: doc → card@from → tag@(from+1) → content@(from+2)
  const cursorPos = from + 2 + Math.min($from.parentOffset, analytic.content.size);
  tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
  // No scrollIntoView — see setTag() above.
  dispatch(tr);
  return true;
}

// ---- Selection-spanning application ----

type StructuralMode =
  | { mode: 'heading'; headingType: HeadingTypeName }
  | { mode: 'tag' }
  | { mode: 'analytic' };

/**
 * Apply a structural-style command to every paragraph the selection
 * touches. Selection is contiguous, so the affected paragraphs are
 * contiguous too. Walk the doc-level slice that contains them, rebuild
 * it once, and dispatch a single replaceWith.
 *
 * Rules per affected node:
 *   - doc-level textblock (paragraph / pocket / hat / block / loose
 *     card_body / cite_paragraph / undertag): convert to the target
 *     style. Heading ids are preserved across heading→heading swaps.
 *   - card / analytic_unit: walk children. Once the first touched
 *     child is hit the container is broken — touched children become
 *     headings/tags/analytics, untouched children that follow lift to
 *     doc level (card_body / cite_paragraph → paragraph, undertag
 *     stays, analytic → analytic_unit). Untouched children that
 *     precede the first touched stay inside the original container.
 */
function applyStructuralToSelection(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  opts: StructuralMode,
): boolean {
  const { from, to } = state.selection;
  if (from === to) return false;

  let firstIdx = -1;
  let lastIdx = -1;
  let p = 0;
  state.doc.forEach((child, _offset, idx) => {
    const cStart = p;
    const cEnd = p + child.nodeSize;
    if (cEnd > from && cStart < to) {
      if (firstIdx === -1) firstIdx = idx;
      lastIdx = idx;
    }
    p = cEnd;
  });
  if (firstIdx === -1) return false;
  if (!dispatch) return true;

  let replaceFrom = -1;
  let replaceTo = -1;
  const newChildren: PMNode[] = [];
  p = 0;
  state.doc.forEach((child, _offset, idx) => {
    const cStart = p;
    const cEnd = p + child.nodeSize;
    p = cEnd;
    if (idx < firstIdx || idx > lastIdx) return;
    if (idx === firstIdx) replaceFrom = cStart;
    if (idx === lastIdx) replaceTo = cEnd;
    transformDocChild(child, cStart, from, to, opts, newChildren);
  });

  if (newChildren.length === 0) return false;
  const tr = state.tr.replaceWith(
    replaceFrom,
    replaceTo,
    Fragment.fromArray(newChildren),
  );
  // Place cursor at the first text position inside the new range.
  // Selection.near handles the case where replaceFrom+1 is inside a
  // non-textblock container (card / analytic_unit).
  try {
    tr.setSelection(Selection.near(tr.doc.resolve(replaceFrom + 1)));
  } catch {
    /* fallback to default mapped selection */
  }
  dispatch(tr);
  return true;
}

function transformDocChild(
  child: PMNode,
  childStart: number,
  selFrom: number,
  selTo: number,
  opts: StructuralMode,
  out: PMNode[],
): void {
  const t = child.type.name;

  if (child.isTextblock) {
    // paragraph / pocket / hat / block / loose card_body / cite_paragraph / undertag
    out.push(asTransformed(child, opts));
    return;
  }

  if (t === 'card' || t === 'analytic_unit') {
    let hitTouched = false;
    const preChildren: PMNode[] = [];
    const liftedChildren: PMNode[] = [];
    child.forEach((g, offset) => {
      const gStart = childStart + 1 + offset;
      const gEnd = gStart + g.nodeSize;
      const gTouched = gEnd > selFrom && gStart < selTo;
      if (gTouched) {
        hitTouched = true;
        liftedChildren.push(asTransformed(g, opts));
      } else if (hitTouched) {
        liftedChildren.push(liftCardChild(g));
      } else {
        preChildren.push(g);
      }
    });

    if (liftedChildren.length === 0) {
      out.push(child);
      return;
    }
    if (preChildren.length === 0) {
      out.push(...liftedChildren);
      return;
    }
    out.push(child.copy(Fragment.fromArray(preChildren)));
    out.push(...liftedChildren);
    return;
  }

  // Anything else (e.g., nested doc structures not in our schema) — pass through.
  out.push(child);
}

function asTransformed(child: PMNode, opts: StructuralMode): PMNode {
  const existingId =
    typeof child.attrs['id'] === 'string' && child.attrs['id']
      ? (child.attrs['id'] as string)
      : null;
  const id = existingId ?? newHeadingId();
  if (opts.mode === 'heading') {
    return schema.nodes[opts.headingType]!.create({ id }, child.content);
  }
  if (opts.mode === 'tag') {
    const tag = schema.nodes['tag']!.create({ id }, child.content);
    return schema.nodes['card']!.create(null, [tag]);
  }
  const a = schema.nodes['analytic']!.create({ id }, child.content);
  return schema.nodes['analytic_unit']!.create(null, [a]);
}

// ---- Keymap binding registry ----

/**
 * Stable identifiers for ribbon commands. The settings UI will store
 * user overrides keyed by these IDs — not by the current key string —
 * so renaming a default key doesn't strand user customizations.
 */
export type RibbonCommandId =
  | 'setPocket'
  | 'setHat'
  | 'setBlock'
  | 'setTag'
  | 'setAnalytic';

export const RIBBON_COMMAND_IDS: RibbonCommandId[] = [
  'setPocket',
  'setHat',
  'setBlock',
  'setTag',
  'setAnalytic',
];

export const RIBBON_COMMAND_LABELS: Record<RibbonCommandId, string> = {
  setPocket: 'Apply Pocket style',
  setHat: 'Apply Hat style',
  setBlock: 'Apply Block style',
  setTag: 'Apply Tag style',
  setAnalytic: 'Apply Analytic style',
};

/**
 * Default key bindings — match Verbatim's F4–F7. prosemirror-keymap
 * 'Mod-' resolves to Cmd on Mac, Ctrl elsewhere.
 */
export const DEFAULT_RIBBON_KEYS: Record<RibbonCommandId, string> = {
  setPocket: 'F4',
  setHat: 'F5',
  setBlock: 'F6',
  setTag: 'F7',
  setAnalytic: 'Mod-F7',
};

const COMMAND_FACTORIES: Record<RibbonCommandId, () => Command> = {
  setPocket: () => setHeading('pocket'),
  setHat: () => setHeading('hat'),
  setBlock: () => setHeading('block'),
  setTag: () => setTag(),
  setAnalytic: () => setAnalytic(),
};

/**
 * Produce a `keymap()`-ready binding object. Overrides replace the
 * default key for a given command; an empty string unbinds that
 * command. When a settings panel is added, it can pass user-stored
 * overrides here.
 */
export function buildRibbonKeymap(
  overrides: Partial<Record<RibbonCommandId, string>> = {},
): Record<string, Command> {
  const out: Record<string, Command> = {};
  for (const id of RIBBON_COMMAND_IDS) {
    const key = overrides[id] ?? DEFAULT_RIBBON_KEYS[id];
    if (!key) continue;
    out[key] = COMMAND_FACTORIES[id]();
  }
  return out;
}

/**
 * Build a Command for a given ribbon command ID. Used by the ribbon
 * toolbar buttons so they stay keyed by stable IDs alongside the
 * keymap — when a binding is rebound through settings, buttons and
 * keys both follow.
 */
export function getRibbonCommand(id: RibbonCommandId): Command {
  return COMMAND_FACTORIES[id]();
}

/**
 * Format a ProseMirror-keymap key string for display in a tooltip.
 * Substitutes the platform's modifier for "Mod-" and pretty-prints
 * the separator.
 */
export function formatKeyForDisplay(key: string): string {
  if (!key) return '';
  const isMac =
    typeof navigator !== 'undefined' &&
    /mac/i.test(navigator.platform ?? '');
  return key
    .replace(/Mod-/g, isMac ? '⌘' : 'Ctrl+')
    .replace(/Shift-/g, isMac ? '⇧' : 'Shift+')
    .replace(/Alt-/g, isMac ? '⌥' : 'Alt+')
    .replace(/-/g, '+');
}
