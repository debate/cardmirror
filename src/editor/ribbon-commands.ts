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

import { Fragment, type Mark, type MarkType, type Node as PMNode, type ResolvedPos } from 'prosemirror-model';
import { Selection, TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { toggleMark } from 'prosemirror-commands';
import { schema } from '../schema/index.js';
import { newHeadingId } from '../schema/ids.js';
import {
  condenseBranchC,
  condenseMerge,
  condenseWithWarning,
  uncondense,
  toggleCase,
} from './condense.js';
import { applyPlainPasteFromText, togglePlainPaste } from './paste-plugin.js';
import { getElectronHost, getHost } from './host/index.js';
import { classifyChar, isWordChar } from './word-break.js';
import {
  selectSimilar,
  getOperatingRanges,
  META_OPERATING_ON_SHADOW,
} from './similar-selection-plugin.js';
import {
  addRowAfter,
  addRowBefore,
  deleteRow,
  addColumnAfter,
  addColumnBefore,
  deleteColumn,
  deleteTable,
  mergeCells,
  splitCell,
} from 'prosemirror-tables';

type HeadingTypeName = 'pocket' | 'hat' | 'block';

const DOC_HEADINGS = new Set<string>(['pocket', 'hat', 'block']);
const CONTAINER_HEAD = new Set<string>(['tag', 'analytic']);
/** Body-slot textblocks that can appear as non-head children of a
 *  card or analytic_unit. When the cursor is in one of these and
 *  the user invokes a heading hotkey (F4-F7 / Mod-F7), the command
 *  splits the surrounding container at that body slot — the slot
 *  becomes the new heading; preceding body slots stay in the
 *  original container; following body slots lift out. */
const SPLITTABLE_BODY_SLOTS = new Set<string>(['card_body', 'cite_paragraph', 'undertag']);

/** Textblock types whose doc-level instances can be converted to
 *  a heading / tag / analytic / undertag in place. Body slots
 *  (cite_paragraph, undertag, card_body) can legally appear at doc
 *  level (per the schema's BLOCK_CONTENT) — e.g., after a card
 *  dissolve lifts them out — and the heading hotkeys should treat
 *  them like a plain paragraph. */
const DOC_LEVEL_CONVERTIBLE = new Set<string>([
  'paragraph',
  'cite_paragraph',
  'undertag',
  'card_body',
  'pocket',
  'hat',
  'block',
]);

/** Direct-formatting marks. Stripped when F8/F9/F10 ADD a named
 *  style — the named style's typography (cite 13pt bold, underline
 *  style, emphasis decorations) replaces direct overrides. F9 also
 *  strips these on toggle-off when
 *  `clearFormattingOnNamedStyleToggleOff` is true (Verbatim parity
 *  for "press F9 twice to clear formatting").
 *
 *  `underline_direct` is intentionally NOT in this set even though
 *  it IS technically direct formatting: F9's apply pass writes
 *  underline_direct for structural-block segments, so this strip
 *  must not run in the same pass or it would erase the just-added
 *  mark. F9's toggle-off pass removes underline_direct explicitly
 *  via `tr.removeMark(..., directMark)` so it's still cleared.
 *  Promotion strips (F4–F7) include underline_direct explicitly
 *  through `PROMOTION_STRIP_MARK_NAMES`.
 *
 *  `link` is excluded — semantic content, not formatting. */
const DIRECT_FORMATTING_MARK_NAMES = [
  'font_size',
  'font_color',
  'font_family',
  'bold',
  'italic',
  'strikethrough',
  'highlight',
  'shading',
] as const;

/** Apply-direction strip: the set used when adding a named-style
 *  mark (F8 Cite, F9 Underline, F10 Emphasis). `highlight` is
 *  *intentionally excluded* — users keep their highlights when
 *  applying a character style on top, since the highlight color
 *  marks "this is the argument-text" and survives a typographic
 *  re-skin. Shading still strips on apply (its semantic is closer
 *  to a font color than a content marker). The toggle-off direction
 *  of F9 still uses the full `DIRECT_FORMATTING_MARK_NAMES` set via
 *  `stripDirectFormatting` below — pressing F9 twice still clears
 *  highlight, matching Verbatim's "F9 twice → fully cleared". */
const APPLY_DIRECT_FORMATTING_STRIP_NAMES = [
  'font_size',
  'font_color',
  'font_family',
  'bold',
  'italic',
  'strikethrough',
  'shading',
] as const;

function stripDirectFormatting(tr: Transaction, from: number, to: number): void {
  for (const name of DIRECT_FORMATTING_MARK_NAMES) {
    const mt = schema.marks[name];
    if (mt) tr.removeMark(from, to, mt);
  }
}

function stripDirectFormattingOnApply(
  tr: Transaction,
  from: number,
  to: number,
): void {
  for (const name of APPLY_DIRECT_FORMATTING_STRIP_NAMES) {
    const mt = schema.marks[name];
    if (mt) tr.removeMark(from, to, mt);
  }
}

/** All marks stripped when body text is promoted into a structural
 *  block (F4–F7 / Mod-F7 / Mod-F8). The structural block's own
 *  typography applies — named-style marks (cite_mark / underline_mark
 *  / emphasis_mark / undertag_mark / analytic_mark) and any direct
 *  formatting lose meaning. `link` is preserved (semantic content);
 *  `pilcrow_marker` is also preserved (post-condense markers shouldn't
 *  silently vanish when their paragraph is restyled). */
const PROMOTION_STRIP_MARK_NAMES = [
  ...DIRECT_FORMATTING_MARK_NAMES,
  'underline_direct',
  'cite_mark',
  'underline_mark',
  'emphasis_mark',
  'undertag_mark',
  'analytic_mark',
] as const;
const PROMOTION_STRIP_SET = new Set<string>(PROMOTION_STRIP_MARK_NAMES);

function stripPromotionMarksOnTr(
  tr: Transaction,
  from: number,
  to: number,
): void {
  for (const name of PROMOTION_STRIP_MARK_NAMES) {
    const mt = schema.marks[name];
    if (mt) tr.removeMark(from, to, mt);
  }
}

/** Strip promotion-affected marks from every text/inline node in a
 *  fragment, returning a new fragment. Use this when building NEW
 *  structural nodes from existing body content (e.g., wrapping a
 *  paragraph in a card+tag — the tag should get clean content). */
function stripPromotionMarksOnFragment(fragment: Fragment): Fragment {
  const out: PMNode[] = [];
  fragment.forEach((child) => {
    const newMarks = child.marks.filter((m) => !PROMOTION_STRIP_SET.has(m.type.name));
    out.push(child.mark(newMarks));
  });
  return Fragment.fromArray(out);
}

/**
 * Same-type re-press helper: strip the `indent` attr off the node at
 * `depth` while preserving its type and every other attr. Returns
 * true unconditionally — the keystroke is consumed either way.
 * Used by every heading shortcut command's already-this-type branch
 * so re-pressing the shortcut clears indentation while leaving the
 * heading style itself intact.
 */
function stripIndentAtDepth(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  depth: number,
): boolean {
  const $from = state.selection.$from;
  const node = $from.node(depth);
  if ((node.attrs['indent'] ?? 0) === 0) return true;
  if (!dispatch) return true;
  const tr = state.tr.setNodeMarkup(
    $from.before(depth),
    null,
    { ...node.attrs, indent: 0 },
  );
  dispatch(tr);
  return true;
}

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
      if (pname === typeName) return stripIndentAtDepth(state, dispatch, 1);
      if (!DOC_LEVEL_CONVERTIBLE.has(pname)) return false;
      if (!dispatch) return true;
      // Preserve the existing id when converting between heading
      // types (pocket↔hat↔block); body slots get a fresh id.
      const id = DOC_HEADINGS.has(pname)
        ? ((parent.attrs['id'] as string | null) ?? newHeadingId())
        : newHeadingId();
      const tr = state.tr.setNodeMarkup(
        $from.before(1),
        schema.nodes[typeName]!,
        { id },
      );
      // The promoted heading takes its identity from the structural
      // type's CSS, so any prior named-style / direct formatting marks
      // on the source content are stripped.
      const contentFrom = $from.before(1) + 1;
      const contentTo = contentFrom + parent.content.size;
      stripPromotionMarksOnTr(tr, contentFrom, contentTo);
      dispatch(tr.scrollIntoView());
      return true;
    }

    if ($from.depth === 2 && CONTAINER_HEAD.has($from.parent.type.name)) {
      return dissolveContainerToHeading(state, dispatch, typeName);
    }

    if ($from.depth === 2 && SPLITTABLE_BODY_SLOTS.has($from.parent.type.name)) {
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
      if (!DOC_LEVEL_CONVERTIBLE.has(pname)) return false;
      if (!dispatch) return true;
      const id = DOC_HEADINGS.has(pname)
        ? ((parent.attrs['id'] as string | null) ?? newHeadingId())
        : newHeadingId();
      // Strip promotion-affected marks from the source content before
      // wrapping it — body-only named-style marks and direct overrides
      // don't belong on a tag's text.
      const cleanContent = stripPromotionMarksOnFragment(parent.content);
      const tagNode = schema.nodes['tag']!.create({ id }, cleanContent);
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
      return stripIndentAtDepth(state, dispatch, 2);
    }

    if (
      $from.depth === 2 &&
      $from.parent.type.name === 'analytic' &&
      $from.node(1).type.name === 'analytic_unit' &&
      $from.node(1).firstChild === $from.parent
    ) {
      return convertAnalyticUnitToCard(state, dispatch);
    }

    if ($from.depth === 2 && SPLITTABLE_BODY_SLOTS.has($from.parent.type.name)) {
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
      if (!DOC_LEVEL_CONVERTIBLE.has(pname)) return false;
      if (!dispatch) return true;
      const id = DOC_HEADINGS.has(pname)
        ? ((parent.attrs['id'] as string | null) ?? newHeadingId())
        : newHeadingId();
      const cleanContent = stripPromotionMarksOnFragment(parent.content);
      const analyticNode = schema.nodes['analytic']!.create({ id }, cleanContent);
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
      return stripIndentAtDepth(state, dispatch, 2);
    }

    if (
      $from.depth === 2 &&
      $from.parent.type.name === 'tag' &&
      $from.node(1).type.name === 'card' &&
      $from.node(1).firstChild === $from.parent
    ) {
      return convertCardToAnalyticUnit(state, dispatch);
    }

    if ($from.depth === 2 && SPLITTABLE_BODY_SLOTS.has($from.parent.type.name)) {
      return splitContainerAtBody(state, dispatch, { mode: 'analytic' });
    }

    return false;
  };
}

/**
 * Mod-F8 — convert the current paragraph to an undertag.
 *
 * Undertag is a body-level type (no outline level, no id) that's
 * valid both at doc root and inside card / analytic_unit. So unlike
 * setTag/setAnalytic, cursors inside card_body / cite_paragraph
 * stay in place: just the node type changes, the card structure is
 * preserved. Cursors at a tag or analytic anchor still dissolve
 * the surrounding container, since [undertag, …] isn't valid as
 * card / analytic_unit content.
 */
export function setUndertag(): Command {
  return (state, dispatch) => {
    if (!state.selection.empty) {
      return applyStructuralToSelection(state, dispatch, { mode: 'undertag' });
    }
    const $from = state.selection.$from;

    if ($from.depth === 1) {
      const parent = $from.parent;
      const pname = parent.type.name;
      if (pname === 'undertag') return stripIndentAtDepth(state, dispatch, 1);
      if (!DOC_LEVEL_CONVERTIBLE.has(pname)) return false;
      if (!dispatch) return true;
      const tr = state.tr.setNodeMarkup(
        $from.before(1),
        schema.nodes['undertag']!,
        null,
      );
      const contentFrom = $from.before(1) + 1;
      const contentTo = contentFrom + parent.content.size;
      stripPromotionMarksOnTr(tr, contentFrom, contentTo);
      dispatch(tr.scrollIntoView());
      return true;
    }

    if ($from.depth === 2) {
      const pname = $from.parent.type.name;
      if (pname === 'undertag') return stripIndentAtDepth(state, dispatch, 2);
      if (pname === 'card_body' || pname === 'cite_paragraph') {
        if (!dispatch) return true;
        const parent = $from.parent;
        const tr = state.tr.setNodeMarkup(
          $from.before(2),
          schema.nodes['undertag']!,
          null,
        );
        const contentFrom = $from.before(2) + 1;
        const contentTo = contentFrom + parent.content.size;
        stripPromotionMarksOnTr(tr, contentFrom, contentTo);
        dispatch(tr.scrollIntoView());
        return true;
      }
      if (pname === 'tag' || pname === 'analytic') {
        return dissolveContainerToUndertag(state, dispatch);
      }
    }

    return false;
  };
}

function dissolveContainerToUndertag(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
): boolean {
  const $from = state.selection.$from;
  const head = $from.parent;
  const container = $from.node(1);
  if (container.firstChild !== head) return false;
  if (container.type.name === 'card' && head.type.name !== 'tag') return false;
  if (container.type.name === 'analytic_unit' && head.type.name !== 'analytic') return false;
  if (!dispatch) return true;

  const undertagNode = schema.nodes['undertag']!.create(
    null,
    stripPromotionMarksOnFragment(head.content),
  );
  const nonHeadChildren: PMNode[] = [];
  container.forEach((child, _offset, index) => {
    if (index === 0) return;
    nonHeadChildren.push(child);
  });

  const containerStart = $from.before(1);
  const containerEnd = $from.after(1);

  // If the previous doc-level sibling is the same container type, absorb
  // [undertag, ...non-head children] into it. Card and analytic_unit both
  // accept undertag in their content, and the non-head children are already
  // valid card/analytic_unit content, so no per-child rewriting is needed.
  const containerIndex = $from.index(0);
  if (containerIndex > 0) {
    const prev = state.doc.child(containerIndex - 1);
    if (prev.type.name === container.type.name) {
      const prevStart = containerStart - prev.nodeSize;
      const newPrev = prev.copy(
        prev.content.append(Fragment.fromArray([undertagNode, ...nonHeadChildren])),
      );
      let tr = state.tr.replaceWith(prevStart, containerEnd, newPrev);
      const cursorPos =
        prevStart + 1 + prev.content.size + 1 +
        Math.min($from.parentOffset, head.content.size);
      tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
      dispatch(tr.scrollIntoView());
      return true;
    }
  }

  const lifted: PMNode[] = [undertagNode, ...nonHeadChildren.map(liftCardChild)];
  let tr = state.tr.replaceWith(
    containerStart,
    containerEnd,
    Fragment.fromArray(lifted),
  );
  const cursorPos = containerStart + 1 + Math.min($from.parentOffset, head.content.size);
  tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
  dispatch(tr.scrollIntoView());
  return true;
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
  // Tag → analytic is a same-tier swap (same structural role, just
  // different cite/analytic semantic). Preserve direct formatting the
  // user manually applied — the apply-style strip is only meant to
  // fire when promoting INTO a different kind of element.
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
  if (t === 'card_body' || t === 'undertag' || t === 'cite_paragraph') return child;
  // analytic_unit content = analytic (card_body | undertag | cite_paragraph)*;
  // a stray analytic (from a card's cite-slot) folds into card_body so
  // the text comes along.
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
  if (!SPLITTABLE_BODY_SLOTS.has(cursorBody.type.name)) return false;
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
  const cleanHeadContent = stripPromotionMarksOnFragment(cursorBody.content);
  if (opts.mode === 'heading') {
    const headingType = schema.nodes[opts.headingType]!;
    const newHead = headingType.create({ id: newHeadingId() }, cleanHeadContent);
    const followingLifted = followingChildren.map(liftCardChild);
    liftedNodes = [newHead, ...followingLifted];
    insideOffset = 1;
  } else if (opts.mode === 'tag') {
    const tagNode = schema.nodes['tag']!.create({ id: newHeadingId() }, cleanHeadContent);
    // following children are already valid card content (card_body /
    // undertag / cite_paragraph / analytic), so pass through unchanged.
    const newCard = schema.nodes['card']!.create(null, [tagNode, ...followingChildren]);
    liftedNodes = [newCard];
    insideOffset = 2;
  } else {
    const analyticNode = schema.nodes['analytic']!.create({ id: newHeadingId() }, cleanHeadContent);
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
  const newHeading = schema.nodes[typeName]!.create(
    { id },
    stripPromotionMarksOnFragment(head.content),
  );

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

/**
 * Verbatim's CopyPreviousCite, reframed for our schema.
 *
 * Source: cite_paragraph nodes whose end position is strictly before
 * the cursor, scoped first to the cursor's enclosing card. If that
 * yields nothing, walk doc-level siblings backward until we find a
 * card whose children include at least one cite_paragraph; take all
 * of that card's cite_paragraphs. Whitespace-only cites still count.
 *
 * Destination:
 *   - If the cursor is inside a card and its current paragraph is an
 *     EMPTY (or whitespace-only) card_body / cite_paragraph / undertag,
 *     REPLACE that paragraph with the cites.
 *   - If the cursor is inside a card otherwise (tag / non-empty body /
 *     empty heading-like child), INSERT the cites as siblings right
 *     after the cursor's paragraph.
 *   - If the cursor is NOT inside a card (doc-level paragraph, heading,
 *     analytic_unit), wrap the cites in a new card `[empty tag, cites]`
 *     and insert that card at doc level immediately after the cursor's
 *     doc-level ancestor. Cursor lands in the empty tag so the user
 *     can immediately type the new tag.
 *
 * The "in card" cases place the cursor at the end of the last inserted
 * cite_paragraph so the user can continue from there.
 */
/**
 * F8 / F10 — apply a body-only named-style mark (`cite_mark` /
 * `emphasis_mark`) to text in the selection. Both share the same
 * shape: structural textblocks (tag / analytic / pocket / hat / block)
 * and undertags are skipped, so a selection that spans them only marks
 * the body portions and the structural slots are left untouched.
 *
 * No-op when the selection is collapsed.
 *
 * Apply-only (not toggle): re-running on the same range is idempotent.
 * Schema `excludes` on these marks auto-strips conflicting
 * cite/underline/emphasis in the range when `tr.addMark` is called.
 */
const NAMED_STYLE_SKIP_BLOCKS = new Set(['tag', 'analytic', 'pocket', 'hat', 'block', 'undertag']);

/**
 * Word at the (collapsed) cursor — "continuous text uninterrupted by
 * whitespace" within the cursor's textblock. Returns null if the
 * selection isn't collapsed, the cursor isn't in a textblock, or the
 * cursor sits at a whitespace position with whitespace on both sides
 * (no word to act on).
 *
 * Inline leaves (images, etc.) count as word boundaries — a word
 * can't span a non-text inline node. Mark boundaries are *not* word
 * boundaries: "plain" + "bold" with no space between produces the
 * single word "plainbold" even though they're two text nodes.
 */
function wordRangeAtCursor(state: EditorState): { from: number; to: number } | null {
  const sel = state.selection;
  if (!sel.empty) return null;
  const $from = sel.$from;
  const parent = $from.parent;
  if (!parent.isTextblock) return null;
  const size = parent.content.size;
  if (size === 0) return null;

  // Per-position word-class map for the textblock. Inline leaves
  // (images, etc.) get a sentinel slot that the classifier reads
  // as non-word ('\0' classifies as 'punct'), which correctly
  // ends the word at the leaf boundary. Text node characters
  // classify via the spec's iterator (`isWordChar` from
  // `word-break.ts`) — letters, digits, U+0027, U+2019. Notably
  // `.` / `,` / `_` / hyphen / dash family / U+2018 are NOT word
  // characters under the spec, so `U.S.A.` is three words and
  // `user_name` is two.
  const chars = new Array<string>(size);
  let p = 0;
  parent.forEach((child) => {
    if (child.isText) {
      const t = child.text ?? '';
      for (let i = 0; i < t.length; i++) {
        chars[p + i] = t[i] ?? '\0';
      }
      p += t.length;
    } else {
      for (let i = 0; i < child.nodeSize; i++) {
        chars[p + i] = '\0';
      }
      p += child.nodeSize;
    }
  });
  const isW = (i: number): boolean => isWordChar(chars[i] ?? '\0');

  const offset = $from.parentOffset;
  let left = offset;
  while (left > 0 && isW(left - 1)) left--;
  let right = offset;
  while (right < size && isW(right)) right++;
  if (left === right) return null;

  const tbStart = $from.start();
  return { from: tbStart + left, to: tbStart + right };
}

/** Layer 3 formatting trim — strip ONE trailing space character
 *  from the end of each range, UNLESS the range minus that
 *  trailing space is entirely whitespace. The trim un-does Word-
 *  unit absorption (double-click and `Ctrl-Shift-Right` each pull
 *  a single trailing space onto the right edge of the selection);
 *  it must NOT also block the user from deliberately formatting a
 *  whitespace-only selection — e.g., shift-arrowing across a
 *  single space they want highlighted.
 *
 *  Single-char trim: a multi-unit selection like `word word word `
 *  loses the final space but keeps its internal spaces formatted.
 *  Selecting just ` ` (a single space) or `   ` (whitespace only)
 *  is left intact so the format applies to the whole range.
 *  Spec: see `word-selection-behavior.md` Layer 3. */
function trimRangesForFormatting(
  doc: PMNode,
  ranges: { from: number; to: number }[],
): { from: number; to: number }[] {
  return ranges.map(({ from, to }) => {
    if (from >= to) return { from, to };
    let last: string;
    try {
      last = doc.textBetween(to - 1, to);
    } catch {
      return { from, to };
    }
    if (last.length === 0) return { from, to };
    if (classifyChar(last) !== 'space') return { from, to };
    if (!hasNonSpaceChar(doc, from, to - 1)) return { from, to };
    return { from, to: to - 1 };
  });
}

/** True iff `[from, to)` contains at least one text character
 *  that doesn't classify as `'space'`. Walks text leaves; ignores
 *  block boundaries and non-text leaves. Used by the formatting
 *  trim to decide whether shaving the trailing space would leave
 *  any "real" content behind. */
function hasNonSpaceChar(doc: PMNode, from: number, to: number): boolean {
  if (from >= to) return false;
  let found = false;
  doc.nodesBetween(from, to, (node, pos) => {
    if (found) return false;
    if (!node.isText) return true;
    const text = node.text ?? '';
    const localStart = Math.max(0, from - pos);
    const localEnd = Math.min(text.length, to - pos);
    for (let i = localStart; i < localEnd; i++) {
      if (classifyChar(text[i] ?? '') !== 'space') {
        found = true;
        return false;
      }
    }
    return false;
  });
  return found;
}

/** Drop-in for `getOperatingRanges` in formatting-command sites:
 *  identical return shape, but ranges have their trailing space
 *  trimmed per Layer 3. Use the bare `getOperatingRanges` for any
 *  consumer that should see the user's selection unmodified. */
function getOperatingRangesForFormatting(
  state: EditorState,
): { ranges: { from: number; to: number }[]; fromShadow: boolean } {
  const op = getOperatingRanges(state);
  if (op.ranges.length === 0) return op;
  return {
    ranges: trimRangesForFormatting(state.doc, op.ranges),
    fromShadow: op.fromShadow,
  };
}

function applyBodyMark(
  markName: 'cite_mark' | 'emphasis_mark',
  opts: { expandToWordWhenEmpty?: boolean } = {},
): Command {
  return (state, dispatch) => {
    const markType = schema.marks[markName];
    if (!markType) return false;

    // Operating ranges: PM selection if non-empty, otherwise the
    // shadow-selection matches if any are active, otherwise fall
    // back to the per-command default (word-expand at cursor for
    // F10 Emphasis; nothing for F8 Cite).
    const op = getOperatingRangesForFormatting(state);
    let opRanges = op.ranges;
    if (opRanges.length === 0) {
      if (!opts.expandToWordWhenEmpty) return false;
      const word = wordRangeAtCursor(state);
      if (!word) return false;
      opRanges = [word];
    }

    // Collect per-textblock ranges; structural-block skip is enforced
    // by the nodesBetween callback (a touched tag / undertag yields
    // no range and contributes nothing).
    const ranges: { from: number; to: number }[] = [];
    for (const { from, to } of opRanges) {
      state.doc.nodesBetween(from, to, (node, pos) => {
        if (!node.isTextblock) return true;
        if (NAMED_STYLE_SKIP_BLOCKS.has(node.type.name)) return false;
        const tbStart = pos + 1;
        const tbEnd = pos + node.nodeSize - 1;
        const applyFrom = Math.max(tbStart, from);
        const applyTo = Math.min(tbEnd, to);
        if (applyFrom < applyTo) ranges.push({ from: applyFrom, to: applyTo });
        return false;
      });
    }
    if (ranges.length === 0) return false;
    if (!dispatch) return true;

    const tr = state.tr;
    const mark = markType.create();
    for (const r of ranges) {
      tr.addMark(r.from, r.to, mark);
      // F8 / F10 are one-directional applies — the named style's
      // typography is the run's new identity, so direct overrides
      // (font_size, bold, etc.) get cleared. Highlight is preserved:
      // it marks "this is the argument-text" and the user typically
      // wants it to survive a typographic re-skin. Shading still
      // strips (its semantic is closer to font color).
      stripDirectFormattingOnApply(tr, r.from, r.to);
    }
    if (op.fromShadow) tr.setMeta(META_OPERATING_ON_SHADOW, true);
    dispatch(tr);
    return true;
  };
}

export function applyCite(): Command {
  return applyBodyMark('cite_mark', { expandToWordWhenEmpty: true });
}

export function applyEmphasis(): Command {
  return applyBodyMark('emphasis_mark', { expandToWordWhenEmpty: true });
}

/**
 * Alt-F10 — apply `emphasis_mark` to the FIRST character of each
 * word inside the selection, expanding the selection to whole-word
 * boundaries first. Useful for marking the source letters of an
 * acronym: select "United States Capitol Police", run this, and
 * "U", "S", "C", "P" get emphasized.
 *
 * No-op on empty selection (the user explicitly asked for
 * selection-only behavior — no "emphasize the word at the cursor"
 * fallback like `applyEmphasis` has).
 *
 * Word definition matches `wordRangeAtCursor`: a maximal run of
 * non-whitespace characters within a single textblock. Inline
 * leaves (images, etc.) and structural-block boundaries break
 * words. Mark boundaries do NOT break a word.
 *
 * Structural blocks (tag / undertag / pocket / hat / block /
 * analytic) are skipped — `emphasis_mark` is a body-text mark
 * (same skip rule as `applyEmphasis`).
 *
 * Applied per word: the first character of the word (a single
 * code-unit slot — surrogate-pair edge case isn't relevant for
 * real-world acronyms) gets `emphasis_mark`, plus the same
 * direct-formatting stripping `applyEmphasis` does.
 */
export function emphasizeAcronym(): Command {
  return (state, dispatch) => {
    const markType = schema.marks['emphasis_mark'];
    if (!markType) return false;
    const sel = state.selection;
    if (sel.empty) return false;

    const firstLetterRanges: { from: number; to: number }[] = [];
    state.doc.nodesBetween(sel.from, sel.to, (node, pos) => {
      if (!node.isTextblock) return true;
      if (NAMED_STYLE_SKIP_BLOCKS.has(node.type.name)) return false;

      const tbStart = pos + 1;
      const tbEnd = pos + node.nodeSize - 1;
      const size = node.content.size;
      if (size === 0) return false;

      // Per-position word-class map for THIS textblock. `isW[i]` is
      // true iff the char at slot `i` classifies as a word-character
      // per the spec (`isWordChar` from `word-break.ts`): letters,
      // digits, `'` U+0027, `'` U+2019. Inline leaves (images, etc.)
      // get the sentinel `'\0'` which classifies as non-word and
      // therefore ends any in-progress word. Same index space as
      // `wordRangeAtCursor`. Under the spec `U.S.A.` becomes three
      // words (each letter standalone), so the F10 acronym command
      // emphasizes `U`, `S`, `A` separately — a more useful result
      // than the prior "treat the whole `U.S.A.` as one word" walk
      // that only emphasized the leading `U`.
      const isW = new Array<boolean>(size);
      let p = 0;
      node.forEach((child) => {
        if (child.isText) {
          const t = child.text ?? '';
          for (let i = 0; i < t.length; i++) {
            isW[p + i] = isWordChar(t[i] ?? '\0');
          }
          p += t.length;
        } else {
          for (let i = 0; i < child.nodeSize; i++) isW[p + i] = false;
          p += child.nodeSize;
        }
      });

      // Selection-clip range in textblock-local coords.
      const localFrom = Math.max(0, sel.from - tbStart);
      const localTo = Math.min(size, sel.to - tbStart);
      if (localFrom >= localTo) return false;

      // A word is "partially selected" iff at least one of its
      // word-class characters falls inside the selection. Find the
      // leftmost and rightmost word-class positions within
      // [localFrom, localTo). If none exist (selection is entirely
      // non-word chars), skip this block.
      let leftW = -1;
      let rightW = -1;
      for (let i = localFrom; i < localTo; i++) {
        if (isW[i] === true) {
          if (leftW < 0) leftW = i;
          rightW = i;
        }
      }
      if (leftW < 0) return false;

      // Expand to whole-word boundaries: extend left through
      // word-class slots preceding `leftW`, and right through
      // word-class slots following `rightW`. Smallest contiguous
      // range fully covering every partially-selected word.
      let expFrom = leftW;
      let expTo = rightW + 1;
      while (expFrom > 0 && isW[expFrom - 1] === true) expFrom--;
      while (expTo < size && isW[expTo] === true) expTo++;

      // Walk the expanded range; each non-word → word transition
      // (or the very first slot if it's word-class) is the start
      // of a new word, and the slot is the word's first character.
      let inWord = false;
      for (let i = expFrom; i < expTo; i++) {
        const isWord = isW[i] === true;
        if (isWord && !inWord) {
          firstLetterRanges.push({ from: tbStart + i, to: tbStart + i + 1 });
          inWord = true;
        } else if (!isWord) {
          inWord = false;
        }
      }
      // Stop descent into this textblock's children; we've already
      // processed the whole content.
      return false;
    });

    if (firstLetterRanges.length === 0) return false;
    if (!dispatch) return true;

    const tr = state.tr;
    const mark = markType.create();
    for (const r of firstLetterRanges) {
      tr.addMark(r.from, r.to, mark);
      // Same one-directional-apply semantics as F10 Emphasis:
      // direct overrides (font_size, bold, etc.) on the marked
      // character clear so the emphasis run renders as the named
      // style's typography. Highlight + shading follow the same
      // rules as `applyBodyMark`.
      stripDirectFormattingOnApply(tr, r.from, r.to);
    }
    dispatch(tr);
    return true;
  };
}

/**
 * Alt-F11 — apply the active `highlight` color to the FIRST
 * character of each word inside the selection, using the same
 * per-word-first-letter walk as `emphasizeAcronym`. Useful for
 * making an acronym's source letters pop visually (e.g., select
 * "United States Capitol Police", run this, and `U / S / C / P`
 * each carry the active highlight).
 *
 * Differences from `emphasizeAcronym`, parallel to the differences
 * between `applyHighlight` and `applyEmphasis`:
 *   - No structural-block skip — highlight is a runtime annotation,
 *     not a named style, and F11 itself works in tags / analytics.
 *   - No direct-formatting strip — highlight is additive; nothing
 *     about the marked character's other formatting should change.
 *
 * No-op on empty selection (matches the emphasize-acronym contract
 * — no "highlight the word at the cursor" fallback).
 */
export function highlightAcronym(activeColor: () => string): Command {
  return (state, dispatch) => {
    const markType = schema.marks['highlight'];
    if (!markType) return false;
    const sel = state.selection;
    if (sel.empty) return false;

    const firstLetterRanges: { from: number; to: number }[] = [];
    state.doc.nodesBetween(sel.from, sel.to, (node, pos) => {
      if (!node.isTextblock) return true;
      // No NAMED_STYLE_SKIP_BLOCKS gate — highlight is allowed in
      // structural textblocks (tags / analytics / pockets / etc.).

      const tbStart = pos + 1;
      const size = node.content.size;
      if (size === 0) return false;

      // Per-position word-class map, identical to emphasizeAcronym.
      const isW = new Array<boolean>(size);
      let p = 0;
      node.forEach((child) => {
        if (child.isText) {
          const t = child.text ?? '';
          for (let i = 0; i < t.length; i++) {
            isW[p + i] = isWordChar(t[i] ?? '\0');
          }
          p += t.length;
        } else {
          for (let i = 0; i < child.nodeSize; i++) isW[p + i] = false;
          p += child.nodeSize;
        }
      });

      const localFrom = Math.max(0, sel.from - tbStart);
      const localTo = Math.min(size, sel.to - tbStart);
      if (localFrom >= localTo) return false;

      let leftW = -1;
      let rightW = -1;
      for (let i = localFrom; i < localTo; i++) {
        if (isW[i] === true) {
          if (leftW < 0) leftW = i;
          rightW = i;
        }
      }
      if (leftW < 0) return false;

      let expFrom = leftW;
      let expTo = rightW + 1;
      while (expFrom > 0 && isW[expFrom - 1] === true) expFrom--;
      while (expTo < size && isW[expTo] === true) expTo++;

      let inWord = false;
      for (let i = expFrom; i < expTo; i++) {
        const isWord = isW[i] === true;
        if (isWord && !inWord) {
          firstLetterRanges.push({ from: tbStart + i, to: tbStart + i + 1 });
          inWord = true;
        } else if (!isWord) {
          inWord = false;
        }
      }
      return false;
    });

    if (firstLetterRanges.length === 0) return false;
    if (!dispatch) return true;

    const tr = state.tr;
    const color = activeColor();
    for (const r of firstLetterRanges) {
      // Replace any existing highlight color on this character so
      // the new acronym mark wins (parallel to applyHighlight's
      // remove-then-add for the "apply" branch).
      tr.removeMark(r.from, r.to, markType);
      tr.addMark(r.from, r.to, markType.create({ color }));
    }
    dispatch(tr);
    return true;
  };
}

/**
 * F9 / Mod-U — toggle Verbatim's "Underline" style on the selection.
 *
 * Two marks back this: `underline_mark` (named-style, used in body
 * textblocks — paragraph / card_body / cite_paragraph) and
 * `underline_direct` (direct formatting, used in structural
 * textblocks — tag / analytic / pocket / hat / block / undertag).
 * "Underlined" for toggle purposes means either mark is present.
 *
 * Empty selection: expand to the word at the cursor — the maximal
 * run of non-whitespace characters within the cursor's textblock —
 * and toggle that. No-op when the cursor is in whitespace, in an
 * empty textblock, or on a non-text leaf (no word to act on). Mark
 * boundaries do NOT break a word: "plain" + "bold" (two text nodes,
 * different marks, no whitespace between) acts as one word.
 *
 * Non-empty selection: walk the selection's text nodes. If every
 * character is already underlined, strip both underline marks
 * across the range. Otherwise, add the appropriate mark per parent
 * textblock type to characters that aren't yet underlined — body
 * gets `underline_mark` (auto-strips conflicting cite_mark and
 * emphasis_mark in that range, per the "body text has one of cite /
 * underline / emphasis" policy), structural gets `underline_direct`
 * (doesn't conflict with anything).
 */
export function applyUnderline(
  clearFormattingOnToggleOff: () => boolean = () => true,
): Command {
  return (state, dispatch) => {
    const namedMark = schema.marks['underline_mark']!;
    const directMark = schema.marks['underline_direct']!;

    // Operating ranges: PM selection > shadow ranges > word-at-cursor.
    const op = getOperatingRangesForFormatting(state);
    let opRanges = op.ranges;
    if (opRanges.length === 0) {
      const word = wordRangeAtCursor(state);
      if (!word) return false;
      opRanges = [word];
    }

    // "Already underlined?" check across all operating ranges. If
    // every text char in every range carries one of the two
    // underline marks, the gesture toggles OFF; otherwise it adds.
    let everyUnderlined = true;
    let anyText = false;
    for (const { from, to } of opRanges) {
      state.doc.nodesBetween(from, to, (node) => {
        if (!node.isText) return true;
        anyText = true;
        const u = node.marks.some(
          (m) => m.type === namedMark || m.type === directMark,
        );
        if (!u) everyUnderlined = false;
        return true;
      });
    }
    if (!anyText) return false;

    if (!dispatch) return true;

    const tr = state.tr;
    if (everyUnderlined) {
      // Toggle off: strip both underline marks across each range.
      for (const { from, to } of opRanges) {
        tr.removeMark(from, to, namedMark);
        tr.removeMark(from, to, directMark);
        // Verbatim's "press F9 twice clears formatting" — opt-out
        // via setting.
        if (clearFormattingOnToggleOff()) stripDirectFormatting(tr, from, to);
      }
    } else {
      // Toggle on: per-textblock segments across all operating
      // ranges. Body uses underline_mark (named-style with
      // excludes); structural uses underline_direct.
      const segments: { from: number; to: number; structural: boolean }[] = [];
      for (const { from, to } of opRanges) {
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (!node.isTextblock) return true;
          const tbStart = pos + 1;
          const tbEnd = pos + node.nodeSize - 1;
          const f = Math.max(tbStart, from);
          const t = Math.min(tbEnd, to);
          if (f < t) {
            segments.push({
              from: f,
              to: t,
              structural: STRUCTURAL_TEXTBLOCKS_FOR_UNDERLINE.has(node.type.name),
            });
          }
          return false;
        });
      }
      for (const seg of segments) {
        const markType = seg.structural ? directMark : namedMark;
        const otherMark = seg.structural ? namedMark : directMark;
        tr.removeMark(seg.from, seg.to, otherMark);
        tr.addMark(seg.from, seg.to, markType.create());
        stripDirectFormattingOnApply(tr, seg.from, seg.to);
      }
    }
    if (op.fromShadow) tr.setMeta(META_OPERATING_ON_SHADOW, true);
    dispatch(tr);
    return true;
  };
}

const STRUCTURAL_TEXTBLOCKS_FOR_UNDERLINE = new Set([
  'tag', 'analytic', 'pocket', 'hat', 'block', 'undertag',
]);

/**
 * Shadow-aware drop-in replacement for `toggleMark` from
 * `prosemirror-commands`. Falls back to PM's `toggleMark` when the
 * PM selection is non-empty (preserves the standard Word/PM toggle
 * semantic), but when the selection is collapsed AND the shadow
 * selection has matches, toggles the mark across every match in a
 * single transaction.
 */
function shadowAwareToggleMark(markType: MarkType): Command {
  return (state, dispatch, view) => {
    const op = getOperatingRangesForFormatting(state);

    // No operating ranges (empty PM selection, no shadow matches) —
    // defer to PM's storedMarks toggle. This is the cursor-only
    // path where the mark will be applied to the next typed
    // character.
    if (op.ranges.length === 0) {
      return toggleMark(markType)(state, dispatch, view);
    }

    // All-marked test: walk every operating range and decide
    // whether to add (some text char lacks the mark) or remove
    // (every text char already carries it). Matches PM's
    // `toggleMark` decision, generalized to multiple ranges.
    let allMarked = true;
    let anyText = false;
    for (const { from, to } of op.ranges) {
      state.doc.nodesBetween(from, to, (node) => {
        if (!node.isText) return true;
        anyText = true;
        if (!node.marks.some((m) => m.type === markType)) allMarked = false;
        return true;
      });
    }
    if (!anyText) return false;
    if (!dispatch) return true;

    // Unified add / remove across every operating range — the
    // ranges already have Layer 3's trailing-space trim baked in
    // (via `getOperatingRangesForFormatting`), so a double-
    // clicked `word ` only bolds the word, not the absorbed
    // space.
    const tr = state.tr;
    if (allMarked) {
      for (const { from, to } of op.ranges) tr.removeMark(from, to, markType);
    } else {
      const mark = markType.create();
      for (const { from, to } of op.ranges) tr.addMark(from, to, mark);
    }
    if (op.fromShadow) tr.setMeta(META_OPERATING_ON_SHADOW, true);
    dispatch(tr);
    return true;
  };
}

/**
 * F11 — toggle Highlight across the selection with the active
 * highlight color. Color-agnostic toggle: if every character in the
 * selection already carries any `highlight` mark, strip it. Otherwise
 * apply the active color to the whole range (replacing any existing
 * color in chars that were already highlighted).
 *
 * No structural-block skip — tags, analytics, etc. can carry
 * highlights (they're a runtime annotation, not a semantic style).
 * Empty selection: no-op (no word expansion — highlights typically
 * span multiple words and users select before applying).
 */
export function applyHighlight(activeColor: () => string): Command {
  return (state, dispatch) => {
    const highlightType = schema.marks['highlight'];
    if (!highlightType) return false;

    // Operating ranges: PM selection > shadow ranges. No word-expand
    // fallback — highlights typically span multiple words and users
    // select before applying.
    const op = getOperatingRangesForFormatting(state);
    if (op.ranges.length === 0) return false;

    let allMarked = true;
    let anyText = false;
    for (const { from, to } of op.ranges) {
      const r = scanTextMarkPresence(state.doc, from, to, 'highlight');
      if (r.anyText) anyText = true;
      if (!r.allMarked) allMarked = false;
    }
    if (!anyText) return false;

    if (!dispatch) return true;
    const tr = state.tr;
    if (allMarked) {
      for (const { from, to } of op.ranges) tr.removeMark(from, to, highlightType);
    } else {
      // Replace any existing highlight color with the active one
      // across each range. removeMark + addMark guarantees the new
      // color wins even where a different highlight already exists.
      for (const { from, to } of op.ranges) {
        tr.removeMark(from, to, highlightType);
        tr.addMark(from, to, highlightType.create({ color: activeColor() }));
      }
    }
    if (op.fromShadow) tr.setMeta(META_OPERATING_ON_SHADOW, true);
    dispatch(tr);
    return true;
  };
}

/**
 * Mod-F11 — toggle Shading (background color, `<w:shd w:fill="…"/>`).
 * Same toggle shape as F11. Shading is independent of highlight —
 * both can coexist on the same character. When both are present the
 * inner DOM wrapper (highlight, defined after shading in the schema)
 * wins visually. Highlight is rendered as the on-screen color;
 * shading remains in the data for round-trip and as the "protected
 * highlight" fallback that survives Word's Remove Highlighting.
 */
export function applyShading(activeColor: () => string): Command {
  return (state, dispatch) => {
    const shadingType = schema.marks['shading'];
    if (!shadingType) return false;

    const op = getOperatingRangesForFormatting(state);
    if (op.ranges.length === 0) return false;

    let allMarked = true;
    let anyText = false;
    for (const { from, to } of op.ranges) {
      const r = scanTextMarkPresence(state.doc, from, to, 'shading');
      if (r.anyText) anyText = true;
      if (!r.allMarked) allMarked = false;
    }
    if (!anyText) return false;

    if (!dispatch) return true;
    const tr = state.tr;
    if (allMarked) {
      for (const { from, to } of op.ranges) tr.removeMark(from, to, shadingType);
    } else {
      for (const { from, to } of op.ranges) {
        tr.removeMark(from, to, shadingType);
        tr.addMark(from, to, shadingType.create({ color: activeColor() }));
      }
    }
    if (op.fromShadow) tr.setMeta(META_OPERATING_ON_SHADOW, true);
    dispatch(tr);
    return true;
  };
}

/**
 * Direct-apply commands fed by the ribbon's color dropdowns. Each
 * applies the chosen value to the selection unconditionally — these
 * are "I picked this color, paint everything with it" gestures, not
 * toggles. No-op on collapsed selection.
 *
 * `setHighlightColor` and `setShadingColor` always write the mark.
 * `setFontColor` accepts null to remove the mark entirely ("Automatic"
 * in the dropdown). Hex values are normalized to uppercase, matching
 * the OOXML convention used elsewhere in the schema.
 */
export function setHighlightColor(color: string): Command {
  return (state, dispatch) => {
    const type = schema.marks['highlight'];
    if (!type) return false;
    const op = getOperatingRangesForFormatting(state);
    if (op.ranges.length === 0) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    for (const { from, to } of op.ranges) {
      tr.removeMark(from, to, type);
      tr.addMark(from, to, type.create({ color }));
    }
    if (op.fromShadow) tr.setMeta(META_OPERATING_ON_SHADOW, true);
    dispatch(tr);
    return true;
  };
}

export function setShadingColor(rgb: string): Command {
  return (state, dispatch) => {
    const type = schema.marks['shading'];
    if (!type) return false;
    const op = getOperatingRangesForFormatting(state);
    if (op.ranges.length === 0) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    for (const { from, to } of op.ranges) {
      tr.removeMark(from, to, type);
      tr.addMark(from, to, type.create({ color: rgb.toUpperCase() }));
    }
    if (op.fromShadow) tr.setMeta(META_OPERATING_ON_SHADOW, true);
    dispatch(tr);
    return true;
  };
}

/**
 * Verbatim's "Standardize Highlighting" (`UniHighlight`). Walks the
 * target range, finds every text run that carries a `highlight` mark,
 * and rewrites its color to the current active highlight color —
 * useful for collapsing a mix of cyan / yellow / etc. back to one
 * consistent color. Unhighlighted text is untouched.
 *
 * `scope`:
 *   - `'document'` — walk the whole doc (Verbatim parity).
 *   - `'selection'` — walk only the current selection. No-op when
 *     the selection is empty.
 */
export function uniHighlight(
  activeColor: () => string,
  scope: 'document' | 'selection' = 'document',
): Command {
  return runUniColor('highlight', activeColor, scope, false);
}

/**
 * Standardize Shading — same shape as `uniHighlight` but for the
 * `shading` mark. Shading uses RGB hex (no leading `#`); the active
 * color is normalized to uppercase to match the schema.
 */
export function uniShade(
  activeColor: () => string,
  scope: 'document' | 'selection' = 'document',
): Command {
  return runUniColor('shading', activeColor, scope, true);
}

/** Word's 15 named highlight colors with their canonical OOXML RGB
 *  values. Used to bridge between the `highlight` mark (which
 *  stores a name) and the `shading` mark (which stores hex RGB). */
const HIGHLIGHT_NAME_TO_HEX: Record<string, string> = {
  yellow: 'FFFF00',
  green: '00FF00',
  cyan: '00FFFF',
  magenta: 'FF00FF',
  blue: '0000FF',
  red: 'FF0000',
  darkBlue: '000080',
  darkCyan: '008080',
  darkGreen: '008000',
  darkMagenta: '800080',
  darkRed: '800000',
  darkYellow: '808000',
  darkGray: '808080',
  lightGray: 'C0C0C0',
  black: '000000',
};

function nearestHighlightName(hex: string): string {
  const upper = hex.toUpperCase();
  for (const [name, target] of Object.entries(HIGHLIGHT_NAME_TO_HEX)) {
    if (target === upper) return name;
  }
  // No exact match — pick the nearest by Euclidean RGB distance so
  // shading colors that aren't one of Word's 15 named highlights
  // still convert to *something* reasonable.
  const r = parseInt(upper.slice(0, 2), 16);
  const g = parseInt(upper.slice(2, 4), 16);
  const b = parseInt(upper.slice(4, 6), 16);
  let bestName = 'yellow';
  let bestDist = Infinity;
  for (const [name, target] of Object.entries(HIGHLIGHT_NAME_TO_HEX)) {
    const tr = parseInt(target.slice(0, 2), 16);
    const tg = parseInt(target.slice(2, 4), 16);
    const tb = parseInt(target.slice(4, 6), 16);
    const dist = (r - tr) ** 2 + (g - tg) ** 2 + (b - tb) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      bestName = name;
    }
  }
  return bestName;
}

/**
 * Convert every `highlight` mark in the current selection to a
 * `shading` mark with the equivalent RGB color (Word's 15 named
 * highlight colors map cleanly to their canonical RGBs). No-op on
 * empty selection. Unhighlighted text is untouched.
 */
export function highlightToShading(): Command {
  return (state, dispatch) => {
    const highlightType = schema.marks['highlight'];
    const shadingType = schema.marks['shading'];
    if (!highlightType || !shadingType) return false;
    if (state.selection.empty) return false;
    if (!dispatch) return true;
    // Trim trailing space (Layer 3).
    const [trimmed] = trimRangesForFormatting(state.doc, [
      { from: state.selection.from, to: state.selection.to },
    ]);
    const { from, to } = trimmed!;
    const tr = state.tr;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isText) return true;
      const hl = node.marks.find((m) => m.type === highlightType);
      if (!hl) return true;
      const colorName = String(hl.attrs['color'] ?? 'yellow');
      const hex = HIGHLIGHT_NAME_TO_HEX[colorName] ?? 'FFFF00';
      const start = Math.max(from, pos);
      const end = Math.min(to, pos + node.nodeSize);
      if (start >= end) return true;
      tr.removeMark(start, end, highlightType);
      tr.addMark(start, end, shadingType.create({ color: hex }));
      return true;
    });
    dispatch(tr);
    return true;
  };
}

/**
 * Convert every `shading` mark in the current selection to a
 * `highlight` mark whose color name matches the shading's RGB (exact
 * match first, then nearest-by-RGB-distance for arbitrary shades).
 * No-op on empty selection. Non-shaded text is untouched.
 */
export function shadingToHighlight(): Command {
  return (state, dispatch) => {
    const highlightType = schema.marks['highlight'];
    const shadingType = schema.marks['shading'];
    if (!highlightType || !shadingType) return false;
    if (state.selection.empty) return false;
    if (!dispatch) return true;
    // Trim trailing space (Layer 3).
    const [trimmed] = trimRangesForFormatting(state.doc, [
      { from: state.selection.from, to: state.selection.to },
    ]);
    const { from, to } = trimmed!;
    const tr = state.tr;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isText) return true;
      const sh = node.marks.find((m) => m.type === shadingType);
      if (!sh) return true;
      const hex = String(sh.attrs['color'] ?? 'D2D2D2');
      const name = nearestHighlightName(hex);
      const start = Math.max(from, pos);
      const end = Math.min(to, pos + node.nodeSize);
      if (start >= end) return true;
      tr.removeMark(start, end, shadingType);
      tr.addMark(start, end, highlightType.create({ color: name }));
      return true;
    });
    dispatch(tr);
    return true;
  };
}

function runUniColor(
  markName: 'highlight' | 'shading',
  activeColor: () => string,
  scope: 'document' | 'selection',
  upperHex: boolean,
): Command {
  return (state, dispatch) => {
    const type = schema.marks[markName];
    if (!type) return false;
    let from: number;
    let to: number;
    if (scope === 'selection') {
      if (state.selection.empty) return false;
      // Trim trailing space (Layer 3).
      const [trimmed] = trimRangesForFormatting(state.doc, [
        { from: state.selection.from, to: state.selection.to },
      ]);
      from = trimmed!.from;
      to = trimmed!.to;
    } else {
      from = 0;
      to = state.doc.content.size;
    }
    const color = upperHex ? activeColor().toUpperCase() : activeColor();
    if (!dispatch) return true;
    const tr = state.tr;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isText) return true;
      if (!node.marks.some((m) => m.type === type)) return true;
      const start = Math.max(from, pos);
      const end = Math.min(to, pos + node.nodeSize);
      if (start >= end) return true;
      tr.removeMark(start, end, type);
      tr.addMark(start, end, type.create({ color }));
      return true;
    });
    dispatch(tr);
    return true;
  };
}

export function setFontColor(rgb: string | null): Command {
  return (state, dispatch) => {
    const type = schema.marks['font_color'];
    if (!type) return false;
    const op = getOperatingRangesForFormatting(state);
    if (op.ranges.length === 0) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    for (const { from, to } of op.ranges) {
      tr.removeMark(from, to, type);
      if (rgb !== null) {
        tr.addMark(from, to, type.create({ color: rgb.toUpperCase() }));
      }
    }
    if (op.fromShadow) tr.setMeta(META_OPERATING_ON_SHADOW, true);
    dispatch(tr);
    return true;
  };
}

/**
 * Adjust the font_size of the selection by `delta` points (+1 or -1
 * for the ribbon's increment/decrement buttons). With an empty
 * selection, this nudges `storedMarks` so the next-typed character
 * picks up the adjusted size — same shape as `setFontSize`'s empty-
 * selection branch.
 *
 * The `effectivePt` callback derives the run's "current" size when
 * it has no `font_size` mark — e.g., a hat-paragraph run reports
 * 22pt, a `.pmd-cite` run reports 13pt, a body run reports 11pt.
 * Without this, increments off non-font_size-marked text would all
 * nudge from a hardcoded body default and produce surprising jumps
 * (cursor in a 22pt hat → +1 lands on 12pt).
 */
export function adjustFontSize(
  delta: number,
  effectivePt: (node: PMNode | null, parent: PMNode) => number,
): Command {
  return (state, dispatch) => {
    const type = schema.marks['font_size'];
    if (!type) return false;
    const sel = state.selection;
    const nudge = (pt: number) => Math.max(1, Math.min(409, pt + delta));

    // Shadow-selection path: if PM sel is empty but shadow matches
    // are active, nudge every text run inside each match (per-run
    // currentPt is the resolver's answer, so a 22pt + an 11pt run
    // get nudged from their own starting points).
    const shadowOp = sel.empty ? getOperatingRangesForFormatting(state) : null;
    if (shadowOp && shadowOp.fromShadow && shadowOp.ranges.length > 0) {
      if (!dispatch) return true;
      const tr = state.tr;
      for (const { from, to } of shadowOp.ranges) {
        state.doc.nodesBetween(from, to, (node, pos, parent) => {
          if (!node.isText || !parent) return true;
          const start = Math.max(from, pos);
          const end = Math.min(to, pos + node.nodeSize);
          if (start >= end) return true;
          const currentPt = effectivePt(node, parent);
          const targetHp = Math.round(nudge(currentPt) * 2);
          tr.removeMark(start, end, type);
          tr.addMark(start, end, type.create({ halfPoints: targetHp }));
          return true;
        });
      }
      tr.setMeta(META_OPERATING_ON_SHADOW, true);
      dispatch(tr);
      return true;
    }

    if (sel.empty) {
      if (!dispatch) return true;
      const $from = sel.$from;
      const parent = $from.parent;
      const current = state.storedMarks ?? $from.marks();
      const existing = current.find((m) => m.type === type);
      let currentPt: number;
      if (existing) {
        currentPt = Number(existing.attrs['halfPoints'] ?? 22) / 2;
      } else {
        // Look at the adjacent text node (before preferred), since the
        // cursor effectively "inherits" its run's identity. If neither
        // neighbor is text, fall through to parent default.
        const idx = $from.index();
        const before = idx > 0 ? parent.child(idx - 1) : null;
        const after = idx < parent.childCount ? parent.child(idx) : null;
        const adjacent =
          before?.isText ? before : after?.isText ? after : null;
        currentPt = effectivePt(adjacent, parent);
      }
      const withoutFs = current.filter((m) => m.type !== type);
      const next = type
        .create({ halfPoints: Math.round(nudge(currentPt) * 2) })
        .addToSet(withoutFs);
      dispatch(state.tr.setStoredMarks(next));
      return true;
    }

    if (!dispatch) return true;
    const tr = state.tr;
    // Trim trailing space (Layer 3) so a double-clicked word + its
    // absorbed space gets the font-size change on the word only.
    const [trimFrom, trimTo] = (() => {
      const [t] = trimRangesForFormatting(state.doc, [
        { from: sel.from, to: sel.to },
      ]);
      return [t!.from, t!.to];
    })();
    state.doc.nodesBetween(trimFrom, trimTo, (node, pos, parent) => {
      if (!node.isText || !parent) return true;
      const start = Math.max(trimFrom, pos);
      const end = Math.min(trimTo, pos + node.nodeSize);
      if (start >= end) return true;
      const currentPt = effectivePt(node, parent);
      const targetHp = Math.round(nudge(currentPt) * 2);
      tr.removeMark(start, end, type);
      tr.addMark(start, end, type.create({ halfPoints: targetHp }));
      return true;
    });
    dispatch(tr);
    return true;
  };
}

/**
 * Apply a `font_size` mark (or remove it, when `pt === null`) across
 * the selection. With an empty selection, the change updates the
 * editor's `storedMarks` so the next typed character picks it up —
 * Word's "type some number into the font-size box and start typing"
 * behavior. `pt` is in points (the chip's user-facing unit); we
 * convert to OOXML half-points internally.
 */
export function setFontSize(pt: number | null): Command {
  return (state, dispatch) => {
    const type = schema.marks['font_size'];
    if (!type) return false;
    const sel = state.selection;

    // Shadow-selection path: PM sel empty + shadow matches active →
    // apply across all matches as a single tr.
    const shadowOp = sel.empty ? getOperatingRangesForFormatting(state) : null;
    if (shadowOp && shadowOp.fromShadow && shadowOp.ranges.length > 0) {
      if (!dispatch) return true;
      const tr = state.tr;
      for (const { from, to } of shadowOp.ranges) {
        tr.removeMark(from, to, type);
        if (pt !== null) {
          tr.addMark(from, to, type.create({ halfPoints: Math.round(pt * 2) }));
        }
      }
      tr.setMeta(META_OPERATING_ON_SHADOW, true);
      dispatch(tr);
      return true;
    }

    if (sel.empty) {
      if (!dispatch) return true;
      const current = state.storedMarks ?? sel.$from.marks();
      const withoutFs = current.filter((m) => m.type !== type);
      const next =
        pt === null
          ? withoutFs
          : type.create({ halfPoints: Math.round(pt * 2) }).addToSet(withoutFs);
      dispatch(state.tr.setStoredMarks(next));
      return true;
    }
    if (!dispatch) return true;
    const tr = state.tr;
    // Trim trailing space (Layer 3).
    const [trimmed] = trimRangesForFormatting(state.doc, [
      { from: sel.from, to: sel.to },
    ]);
    const { from, to } = trimmed!;
    tr.removeMark(from, to, type);
    if (pt !== null) {
      tr.addMark(from, to, type.create({ halfPoints: Math.round(pt * 2) }));
    }
    dispatch(tr);
    return true;
  };
}

// ----------------------------------------------------------------
// F12 — Clear to Normal
//
// Verbatim parity adapted to our schema. Two coverage regimes:
//
//   - "Full" coverage (cursor in a paragraph, OR selection encompasses
//     a paragraph end-to-end): demote the paragraph's structural type
//     to body AND strip direct character formatting from its content.
//   - "Partial" coverage (selection covers only part of a paragraph):
//     strip marks across the selected sub-range only; paragraph type
//     is untouched.
//
// Mark sets:
//   - Demote/full: strip font_size, font_color, font_family, bold,
//     italic, strikethrough. Keep highlight, shading, named-style
//     marks (cite_mark / underline_mark / emphasis_mark / undertag_mark
//     / analytic_mark), link, pilcrow_marker. Also convert
//     `underline_direct` → `underline_mark` so direct underlining
//     survives the demotion as the body-valid variant.
//   - Partial: strip the above plus `underline_direct` AND all named-
//     style marks — partial is "clear character formatting" in the
//     Verbatim sense; only highlight/shading are exempted.
//
// Paragraph type demotion (full coverage):
//   - pocket / hat / block → paragraph (setNodeMarkup)
//   - tag → paragraph (dissolves the surrounding card; trailing
//     children of the card lift to doc level)
//   - analytic → paragraph (dissolves the analytic_unit)
//   - undertag at doc level → paragraph (setNodeMarkup)
//   - undertag inside a card / analytic_unit → card_body
//   - cite_paragraph, card_body, paragraph → no type change (only
//     the strip + underline_direct convert)

const F12_STRIP_DIRECT_NAMES = [
  'font_size',
  'font_color',
  'font_family',
  'bold',
  'italic',
  'strikethrough',
] as const;

const F12_STRIP_PARTIAL_NAMES = [
  ...F12_STRIP_DIRECT_NAMES,
  'underline_direct',
  'cite_mark',
  'underline_mark',
  'emphasis_mark',
  'undertag_mark',
  'analytic_mark',
] as const;

function stripMarkNamesOnTr(
  tr: Transaction,
  from: number,
  to: number,
  names: readonly string[],
): void {
  for (const name of names) {
    const mt = schema.marks[name];
    if (mt) tr.removeMark(from, to, mt);
  }
}

function convertUnderlineDirectToMarkOnTr(
  tr: Transaction,
  from: number,
  to: number,
  doc: PMNode,
): void {
  const directType = schema.marks['underline_direct'];
  const markType = schema.marks['underline_mark'];
  if (!directType || !markType) return;
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return true;
    if (!node.marks.some((m) => m.type === directType)) return true;
    const start = Math.max(from, pos);
    const end = Math.min(to, pos + node.nodeSize);
    if (start >= end) return true;
    tr.removeMark(start, end, directType);
    tr.addMark(start, end, markType.create());
    return true;
  });
}

function cleanFragmentForClearToNormal(
  fragment: Fragment,
  mode: 'cursor' | 'full',
): Fragment {
  const stripNames = mode === 'cursor' ? F12_STRIP_DIRECT_NAMES : F12_STRIP_PARTIAL_NAMES;
  const stripSet = new Set<string>(stripNames);
  const convertUnderlineDirect = mode === 'cursor';
  const directType = schema.marks['underline_direct'];
  const markType = schema.marks['underline_mark'];
  const out: PMNode[] = [];
  fragment.forEach((child) => {
    if (!child.isText) {
      out.push(child);
      return;
    }
    let newMarks: readonly Mark[] = child.marks.filter((m) => !stripSet.has(m.type.name));
    if (convertUnderlineDirect && directType && markType) {
      if (newMarks.some((m) => m.type === directType)) {
        newMarks = newMarks.filter((m) => m.type !== directType);
        if (!newMarks.some((m) => m.type === markType)) {
          newMarks = markType.create().addToSet(newMarks);
        }
      }
    }
    out.push(child.mark(newMarks));
  });
  return Fragment.fromArray(out);
}

interface ClearToNormalOp {
  nodeStart: number;
  nodeSize: number;
  typeName: string;
  /** Depth of the textblock in the original doc. */
  depth: number;
  /** `cursor` = empty selection at this paragraph; `full` = non-empty
   *  selection covers it end-to-end; `partial` = sub-range coverage. */
  mode: 'cursor' | 'full' | 'partial';
  partialFrom?: number;
  partialTo?: number;
}

export function clearToNormal(): Command {
  return (state, dispatch) => {
    const sel = state.selection;
    const isEmpty = sel.empty;

    // Shadow-selection path: when the PM selection is collapsed and
    // shadow matches are active, treat each match as a partial-mode
    // strip across its range. Structural demotes (cursor / full)
    // don't apply — the user picked specific runs to clean, not
    // whole paragraphs.
    if (isEmpty) {
      const shadowOp = getOperatingRangesForFormatting(state);
      if (shadowOp.fromShadow && shadowOp.ranges.length > 0) {
        if (!dispatch) return true;
        const tr = state.tr;
        for (const { from, to } of shadowOp.ranges) {
          applyClearToNormalPartial(tr, from, to);
        }
        tr.setMeta(META_OPERATING_ON_SHADOW, true);
        dispatch(tr);
        return true;
      }
    }

    const ops: ClearToNormalOp[] = [];
    state.doc.nodesBetween(sel.from, sel.to, (node, pos) => {
      if (!node.isTextblock) return true;
      const contentFrom = pos + 1;
      const contentTo = pos + node.nodeSize - 1;
      const $pos = state.doc.resolve(pos + 1);
      let mode: 'cursor' | 'full' | 'partial';
      if (isEmpty) {
        mode = 'cursor';
      } else if (sel.from <= contentFrom && sel.to >= contentTo) {
        mode = 'full';
      } else {
        mode = 'partial';
      }
      ops.push({
        nodeStart: pos,
        nodeSize: node.nodeSize,
        typeName: node.type.name,
        depth: $pos.depth,
        mode,
        partialFrom: mode === 'partial' ? Math.max(sel.from, contentFrom) : undefined,
        partialTo: mode === 'partial' ? Math.min(sel.to, contentTo) : undefined,
      });
      return false;
    });

    if (ops.length === 0) return false;
    if (!dispatch) return true;

    // Apply in reverse position order so earlier positions stay
    // stable through any dissolves (which can shrink the doc).
    const tr = state.tr;
    for (let i = ops.length - 1; i >= 0; i--) {
      const op = ops[i]!;
      if (op.mode === 'cursor' || op.mode === 'full') {
        applyClearToNormalDemote(tr, op);
      } else if (op.partialFrom != null && op.partialTo != null) {
        applyClearToNormalPartial(tr, op.partialFrom, op.partialTo);
      }
    }

    dispatch(tr);
    return true;
  };
}

/** Demote-and-strip path. Used for both `cursor` and `full` modes;
 *  the strip set + underline_direct handling differ:
 *    - cursor: keep named-style marks, convert underline_direct →
 *      underline_mark (so direct underlining survives the demotion).
 *    - full (entire paragraph in a non-empty selection): strip
 *      everything the partial-coverage path would, then demote on
 *      top of it. "Both behaviors at once."
 */
function applyClearToNormalDemote(tr: Transaction, op: ClearToNormalOp): void {
  const { nodeStart, nodeSize, typeName, depth, mode } = op;
  const contentFrom = nodeStart + 1;
  const contentTo = nodeStart + nodeSize - 1;
  const fragmentMode: 'cursor' | 'full' = mode === 'cursor' ? 'cursor' : 'full';
  const stripNames =
    fragmentMode === 'cursor' ? F12_STRIP_DIRECT_NAMES : F12_STRIP_PARTIAL_NAMES;

  let target: 'paragraph' | 'card_body' | null = null;
  let needDissolve = false;
  switch (typeName) {
    case 'pocket':
    case 'hat':
    case 'block':
      target = 'paragraph';
      break;
    case 'tag':
    case 'analytic':
      target = 'paragraph';
      needDissolve = true;
      break;
    case 'undertag':
      target = depth === 1 ? 'paragraph' : 'card_body';
      break;
    case 'cite_paragraph':
    case 'card_body':
    case 'paragraph':
      target = null;
      break;
    default:
      target = null;
  }

  if (needDissolve) {
    // Dissolve card / analytic_unit. The head's cleaned content
    // becomes a doc-level paragraph; trailing children lift out.
    const $head = tr.doc.resolve(contentFrom);
    const containerDepth = $head.depth - 1;
    if (containerDepth < 1) return;
    const container = $head.node(containerDepth);
    const containerStart = $head.before(containerDepth);
    if (container.firstChild !== $head.parent) return;

    const cleanedHead = cleanFragmentForClearToNormal(
      container.firstChild.content,
      fragmentMode,
    );
    const newPara = schema.nodes['paragraph']!.create(null, cleanedHead);
    const lifted: PMNode[] = [newPara];
    container.forEach((child, _off, index) => {
      if (index === 0) return;
      lifted.push(liftCardChild(child));
    });
    tr.replaceWith(containerStart, containerStart + container.nodeSize, Fragment.fromArray(lifted));
    return;
  }

  // Non-dissolve: strip + (conditionally) convert in place, then
  // change type if needed.
  stripMarkNamesOnTr(tr, contentFrom, contentTo, stripNames);
  if (fragmentMode === 'cursor') {
    convertUnderlineDirectToMarkOnTr(tr, contentFrom, contentTo, tr.doc);
  }
  if (target !== null && target !== typeName) {
    tr.setNodeMarkup(nodeStart, schema.nodes[target]!);
  }
}

function applyClearToNormalPartial(tr: Transaction, from: number, to: number): void {
  stripMarkNamesOnTr(tr, from, to, F12_STRIP_PARTIAL_NAMES);
}

// ----------------------------------------------------------------
// Shrink — Verbatim parity.
//
// Cycles the size of "filler" (non-underlined / non-emphasized) text
// through a small ramp:   11 → 8 → 7 → 6 → 5 → 4 → 11.  Mixed-size
// runs normalize to 8pt. Underlined and emphasized text keep their
// existing size — the point of Shrink is to compress the connective
// text while leaving the highlighted argument-text readable.
//
// Two kinds of "protected" ranges get optional special treatment,
// both gated by the same `shrinkRestoresOmissionsToNormal` setting
// (default off):
//   1. Bracketed-Omitted spans (`[…Omitted…]`, `[[…Omitted…]]`,
//      `<…Omitted…>`, `<<…Omitted…>>`, case-insensitive).
//   2. "Condense with warning" markers — `<open>PARAGRAPH INTEGRITY
//      (PAUSES|RESUMES)<close>` for all 6 delimiter variants
//      (`[`/`[[`/`<`/`<<`/`{`/`{{`), case-insensitive. We match every
//      variant regardless of the current `condenseWarningDelimiter`
//      setting so changing the delimiter mid-doc still protects older
//      markers.
//
// When the setting is ON: protected text is excluded from the size-
// cycle decision (otherwise a protected span stuck at Normal would
// make `sizes.size !== 1` and reset the cycle to 8pt, stranding the
// rest of the text) AND is restored to Normal at the end so it stays
// readable. When the setting is OFF: protected text is shrunk along
// with everything else.
//
// Scope:
//   - Empty selection, cursor inside a `card` (anywhere) → all
//     card_body paragraphs of that card.
//   - Empty selection, cursor inside an `analytic_unit` → all
//     card_body paragraphs of that unit.
//   - Empty selection, cursor in a doc-level `paragraph` → that
//     paragraph.
//   - Anything else with empty selection (pocket / hat / block /
//     doc-level undertag / doc-level cite_paragraph) → no-op.
//   - Non-empty selection → the parts of the selection that fall
//     inside card_body paragraphs (in cards or analytic_units) and
//     doc-level generic paragraphs. Tags, undertags, cite paragraphs,
//     headings within the selection are skipped (their content stays
//     at its existing size).

const SHRINK_NORMAL_TO_SMALL_PT = 8;
// Cycle order, for reference: 11 → 8 → 7 → 6 → 5 → 4 → 11.
// `i` for case-insensitive ("omitted" / "OMITTED" / etc. all match);
// `.*?` is non-greedy and JS `.` doesn't cross newlines by default,
// so each bracket pair stops at the nearest closer within the same
// paragraph. Double-bracket variants come first so the longer match
// wins when both shapes overlap.
const BUILTIN_PROTECTED_REGEXES: readonly RegExp[] = [
  // Omissions. Double-bracket variants first so the longer match wins
  // when both shapes overlap; the post-sort+merge in
  // findProtectedRanges collapses any residual overlap.
  /\[\[.*?Omitted.*?\]\]/gi,
  /<<.*?Omitted.*?>>/gi,
  /\{\{.*?Omitted.*?\}\}/gi,
  /\[.*?Omitted.*?\]/gi,
  /<.*?Omitted.*?>/gi,
  /\{.*?Omitted.*?\}/gi,
  // "Condense with warning" markers — all 6 delimiter variants, doubles
  // first. Matched regardless of the current `condenseWarningDelimiter`
  // setting so older markers (or markers from another user's setting
  // choice) stay protected after the setting changes. The `'custom'`
  // delimiter's markers get auto-added via `compileShrinkProtections`
  // when the user has configured one.
  /\[\[PARAGRAPH INTEGRITY (?:PAUSES|RESUMES)\]\]/gi,
  /<<PARAGRAPH INTEGRITY (?:PAUSES|RESUMES)>>/gi,
  /\{\{PARAGRAPH INTEGRITY (?:PAUSES|RESUMES)\}\}/gi,
  /\[PARAGRAPH INTEGRITY (?:PAUSES|RESUMES)\]/gi,
  /<PARAGRAPH INTEGRITY (?:PAUSES|RESUMES)>/gi,
  /\{PARAGRAPH INTEGRITY (?:PAUSES|RESUMES)\}/gi,
  // Footnote callouts — anything containing "FOOTNOTE" between any of
  // our six delimiter shapes. Doubles before singles so the longer
  // match wins when both shapes overlap.
  /\[\[.*?FOOTNOTE.*?\]\]/gi,
  /<<.*?FOOTNOTE.*?>>/gi,
  /\{\{.*?FOOTNOTE.*?\}\}/gi,
  /\[.*?FOOTNOTE.*?\]/gi,
  /<.*?FOOTNOTE.*?>/gi,
  /\{.*?FOOTNOTE.*?\}/gi,
  // Image alt-text fallbacks — anything containing "ALT TEXT" between
  // any of the six delimiter shapes. Doubles before singles so the
  // longer match wins when both shapes overlap.
  /\[\[.*?ALT TEXT.*?\]\]/gi,
  /<<.*?ALT TEXT.*?>>/gi,
  /\{\{.*?ALT TEXT.*?\}\}/gi,
  /\[.*?ALT TEXT.*?\]/gi,
  /<.*?ALT TEXT.*?>/gi,
  /\{.*?ALT TEXT.*?\}/gi,
];

const REGEX_ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

/** Escape a literal string for use as a regex source. */
function escapeRegexLiteral(s: string): string {
  return s.replace(REGEX_ESCAPE_RE, '\\$&');
}

/**
 * Combine the built-in protected patterns with user-supplied custom
 * protections and (if "Condense with warning" is using custom marker
 * strings) one auto-generated literal pattern per non-empty custom
 * marker. The custom markers are the WHOLE pause / resume paragraph
 * text — not delimiters around `PARAGRAPH INTEGRITY PAUSES/RESUMES`
 * — so they're escaped and protected as literal strings.
 *
 * Each user-custom entry is either a literal string (regex-escaped
 * and compiled with `gi`) or a raw regex source (compiled verbatim
 * with `gi`). Invalid regex sources and empty patterns are skipped.
 */
export function compileShrinkProtections(
  custom: readonly { pattern: string; isRegex: boolean }[],
  customPauseMarker: string,
  customResumeMarker: string,
): RegExp[] {
  const out: RegExp[] = [...BUILTIN_PROTECTED_REGEXES];
  for (const marker of [customPauseMarker, customResumeMarker]) {
    if (!marker) continue;
    try {
      out.push(new RegExp(escapeRegexLiteral(marker), 'gi'));
    } catch {
      // Defensive — escape should always produce valid regex.
    }
  }
  for (const rule of custom) {
    if (!rule.pattern) continue;
    const source = rule.isRegex
      ? rule.pattern
      : escapeRegexLiteral(rule.pattern);
    try {
      out.push(new RegExp(source, 'gi'));
    } catch {
      // Invalid user regex — silently skip rather than break shrink.
    }
  }
  return out;
}

const SHRINK_EXEMPT_MARK_NAMES = new Set([
  'underline_mark',
  'underline_direct',
  'emphasis_mark',
]);

export function shrinkText(
  effectivePt: (node: PMNode | null, parent: PMNode) => number,
  normalPt: () => number,
  restoreOmissions: () => boolean,
  protectionPatterns: () => readonly RegExp[],
): Command {
  return (state, dispatch) => {
    const ranges = computeShrinkScope(state);
    if (ranges.length === 0) return false;

    // If the protect-restore setting is on, identify protected spans
    // (built-in omissions + warning markers + user custom rules + auto-
    // generated patterns for the custom condense-with-warning delim)
    // up front so they can be excluded from both the size-cycle decision
    // and the size mutation. Otherwise treat them as regular text.
    const protectedRanges = restoreOmissions()
      ? findProtectedRanges(state.doc, ranges, protectionPatterns())
      : [];

    // Walk eligible (non-exempt) text nodes inside each range to
    // collect their effective sizes and the per-text-node sub-ranges
    // that the size change should touch. Within each text node, drop
    // any portion that overlaps a protected range.
    const eligible: { from: number; to: number }[] = [];
    const sizes = new Set<number>();
    for (const range of ranges) {
      state.doc.nodesBetween(range.from, range.to, (node, pos, parent) => {
        if (!node.isText || !parent) return true;
        if (node.marks.some((m) => SHRINK_EXEMPT_MARK_NAMES.has(m.type.name))) {
          return true;
        }
        const start = Math.max(range.from, pos);
        const end = Math.min(range.to, pos + node.nodeSize);
        if (start >= end) return true;
        const subRanges = subtractRanges(start, end, protectedRanges);
        if (subRanges.length === 0) return true;
        for (const sub of subRanges) eligible.push(sub);
        sizes.add(effectivePt(node, parent));
        return true;
      });
    }
    if (eligible.length === 0 && protectedRanges.length === 0) return false;

    const normal = normalPt();
    const newSize = nextShrinkSize(sizes, normal);
    if (!dispatch) return true;

    const tr = state.tr;
    const fontSizeType = schema.marks['font_size']!;
    const newHp = Math.round(newSize * 2);
    for (const { from, to } of eligible) {
      tr.removeMark(from, to, fontSizeType);
      tr.addMark(from, to, fontSizeType.create({ halfPoints: newHp }));
    }

    // Force protected ranges to Normal size. Done after the eligible
    // pass so they overwrite any pre-existing font_size mark.
    const normalHp = Math.round(normal * 2);
    for (const { from, to } of protectedRanges) {
      tr.removeMark(from, to, fontSizeType);
      tr.addMark(from, to, fontSizeType.create({ halfPoints: normalHp }));
    }

    dispatch(tr);
    return true;
  };
}

function nextShrinkSize(sizes: Set<number>, normalPt: number): number {
  if (sizes.size !== 1) return SHRINK_NORMAL_TO_SMALL_PT;
  const current = [...sizes][0]!;
  if (current > 8) return 8;
  if (current === 8) return 7;
  if (current === 7) return 6;
  if (current === 6) return 5;
  if (current === 5) return 4;
  if (current === 4) return normalPt;
  // Unusual size (e.g., 3pt, 9pt, 10pt) — jump back to Normal so the
  // user can re-enter the cycle from a known starting point.
  // Note: 9pt and 10pt aren't on the ramp but a value here means the
  // user manually set them; Normal is the safest exit.
  return normalPt;
}

function computeShrinkScope(state: import('prosemirror-state').EditorState): { from: number; to: number }[] {
  const sel = state.selection;
  if (sel.empty) {
    const $pos = sel.$from;
    if ($pos.depth < 1) return [];
    const docLevel = $pos.node(1);
    const docLevelStart = $pos.before(1);
    const t = docLevel.type.name;
    if (t === 'card' || t === 'analytic_unit') {
      const out: { from: number; to: number }[] = [];
      let offset = 1;
      docLevel.forEach((child) => {
        if (child.type.name === 'card_body') {
          const childStart = docLevelStart + offset;
          out.push({ from: childStart + 1, to: childStart + child.nodeSize - 1 });
        }
        offset += child.nodeSize;
      });
      return out;
    }
    if (t === 'paragraph') {
      return [{ from: docLevelStart + 1, to: docLevelStart + docLevel.nodeSize - 1 }];
    }
    return [];
  }

  // Non-empty selection: filter to card_body + doc-level paragraph.
  const out: { from: number; to: number }[] = [];
  state.doc.nodesBetween(sel.from, sel.to, (node, pos) => {
    if (!node.isTextblock) return true;
    const t = node.type.name;
    if (t !== 'card_body' && t !== 'paragraph') return false;
    const contentFrom = pos + 1;
    const contentTo = pos + node.nodeSize - 1;
    const from = Math.max(sel.from, contentFrom);
    const to = Math.min(sel.to, contentTo);
    if (from < to) out.push({ from, to });
    return false;
  });
  return out;
}

/**
 * Find all protected spans (omissions + "Condense with warning"
 * markers) within the given doc ranges, returned as sorted, merged
 * doc-position [from, to) ranges.
 *
 * Each scope range gets its text gathered with a per-char back-map to
 * doc positions so regex matches can be translated back into the doc.
 * Double-bracket variants are listed first in PROTECTED_RANGE_REGEXES
 * so the longer match wins on overlap; final sort+merge collapses any
 * residual overlap between variants (e.g. `[[…Omitted…]]` also
 * matches the inner `[…Omitted…]`).
 */
function findProtectedRanges(
  doc: PMNode,
  ranges: { from: number; to: number }[],
  patterns: readonly RegExp[],
): { from: number; to: number }[] {
  const matches: { from: number; to: number }[] = [];
  for (const range of ranges) {
    const charPos: number[] = [];
    let text = '';
    doc.nodesBetween(range.from, range.to, (node, pos) => {
      if (!node.isText || !node.text) return true;
      const start = Math.max(range.from, pos);
      const end = Math.min(range.to, pos + node.nodeSize);
      if (start >= end) return true;
      const slice = node.text.slice(start - pos, end - pos);
      for (let i = 0; i < slice.length; i++) charPos.push(start + i);
      text += slice;
      return true;
    });
    for (const re of patterns) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        // Defensive against zero-width matches (e.g. a user-supplied
        // regex like `(?=)` would match every position): advance
        // lastIndex by 1 to avoid an infinite loop.
        if (m[0].length === 0) {
          re.lastIndex = m.index + 1;
          continue;
        }
        const matchFrom = charPos[m.index];
        const matchTo = charPos[m.index + m[0].length - 1];
        if (matchFrom == null || matchTo == null) continue;
        matches.push({ from: matchFrom, to: matchTo + 1 });
      }
    }
  }
  if (matches.length === 0) return matches;
  matches.sort((a, b) => a.from - b.from || b.to - a.to);
  const merged: { from: number; to: number }[] = [];
  for (const r of matches) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to) {
      last.to = Math.max(last.to, r.to);
    } else {
      merged.push({ from: r.from, to: r.to });
    }
  }
  return merged;
}

/**
 * Return [start, end) minus any portions covered by `excludes`.
 * `excludes` must be sorted by `from` and non-overlapping (which
 * `findProtectedRanges` guarantees).
 */
function subtractRanges(
  start: number,
  end: number,
  excludes: { from: number; to: number }[],
): { from: number; to: number }[] {
  if (excludes.length === 0) return [{ from: start, to: end }];
  const out: { from: number; to: number }[] = [];
  let cursor = start;
  for (const e of excludes) {
    if (e.to <= cursor) continue;
    if (e.from >= end) break;
    if (e.from > cursor) out.push({ from: cursor, to: e.from });
    cursor = Math.max(cursor, e.to);
    if (cursor >= end) return out;
  }
  if (cursor < end) out.push({ from: cursor, to: end });
  return out;
}

/**
 * Walk text nodes in [from, to] and report whether every text char
 * carries a mark of the given name, plus whether any text was found
 * at all. Used by toggle commands to decide on-vs-off.
 */
function scanTextMarkPresence(
  doc: PMNode,
  from: number,
  to: number,
  markName: string,
): { allMarked: boolean; anyText: boolean } {
  let allMarked = true;
  let anyText = false;
  doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return true;
    anyText = true;
    if (!node.marks.some((m) => m.type.name === markName)) allMarked = false;
    return true;
  });
  return { allMarked, anyText };
}

export function copyPreviousCite(): Command {
  return (state, dispatch) => {
    // Collapse a non-empty selection to its start position.
    const $from = state.doc.resolve(state.selection.from);

    const cites = findPreviousCites(state.doc, $from);
    if (cites.length === 0) return false;
    if (!dispatch) return true;

    const dest = computeCitePasteLocation($from);
    const insertedCites = cites.map((c) => c.copy(c.content));
    const content = Fragment.fromArray(insertedCites);
    // Cursor at end of last cite's content (one position before the
    // last cite's closing token).
    const cursorPos = dest.from + content.size - 1;

    let tr = state.tr.replaceWith(dest.from, dest.to, content);
    try {
      tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
    } catch {
      tr = tr.setSelection(Selection.near(tr.doc.resolve(cursorPos)));
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/**
 * F2 — Paste Text. Browsers won't let a web app read the clipboard
 * silently (Chrome and Firefox both show a "Paste" prompt on
 * `navigator.clipboard.readText`, and Firefox doesn't even offer a
 * persistent grant), so F2 can't be a one-keystroke paste in the
 * browser. Instead F2 toggles a "plain paste armed" flag in the
 * `paste-plugin`; the next real `paste` event (Ctrl/Cmd+V) consumes
 * the flag, strips formatting, and disarms. See
 * `src/editor/paste-plugin.ts` for the consumer side.
 *
 * On Electron we have full clipboard read access, so F2 instead
 * fires an immediate paste of the clipboard's plain-text content —
 * matching Verbatim's one-keystroke behavior. The browser keeps
 * the toggle workflow because Chromium's clipboard-permission UI
 * forbids a programmatic synchronous read.
 */
export function pasteAsText(
  ctx: Pick<
    RibbonContext,
    'condenseOnPaste' | 'paragraphIntegrity' | 'usePilcrows' | 'headingMode'
  >,
): Command {
  return (state, dispatch, view) => {
    if (!dispatch) return true;
    const electron = getElectronHost();
    if (electron && view) {
      void runElectronPlainPaste(electron, view, ctx);
      return true;
    }
    return togglePlainPaste()(state, dispatch);
  };
}

async function runElectronPlainPaste(
  electron: { clipboardReadText: () => Promise<string> },
  view: EditorView,
  ctx: Pick<
    RibbonContext,
    'condenseOnPaste' | 'paragraphIntegrity' | 'usePilcrows' | 'headingMode'
  >,
): Promise<void> {
  let text: string;
  try {
    text = await electron.clipboardReadText();
  } catch (err) {
    console.warn('F2 plain paste — clipboard read failed:', err);
    return;
  }
  applyPlainPasteFromText(view, text, ctx);
}

/**
 * Remove every `link` mark from the current scope — Verbatim's
 * `RemoveHyperlinks` macro, parity-friendly. Selection-sensitive:
 *
 *   - Non-empty selection → strip link marks within the selection.
 *     Partial overlap with a link splits the mark, leaving the
 *     untouched portion linked (PM's natural `removeMark` behavior).
 *   - Empty selection → strip link marks across the whole doc.
 *
 * No-op (returns false) when no `link` mark is present in scope.
 * Other marks (font_size, color, bold, etc.) carried by linked runs
 * are untouched — only the `link` mark itself goes, which is what
 * removes both the URL data AND the browser's default `<a>` styling
 * (since our `link` mark renders as `<a href>` and the editor has no
 * CSS overriding that, the user-agent blue/underline came from being
 * inside an anchor and disappears with the wrapper).
 */
/**
 * Verbatim's `FixFormattingGaps` (extended) — normalize every short
 * word-to-word gap so its marks are the intersection of the two
 * bookends' marks. This both BRIDGES marks the bookends agree on
 * (so word-by-word formatting doesn't leave visual breaks) and
 * CLEANS UP marks the gap is wrongly carrying that aren't shared.
 *
 * Selection-sensitive (non-empty selection → that range; empty →
 * whole doc). Walks each textblock in scope independently — bridges
 * never cross paragraph breaks.
 *
 * The regex is
 *
 *   /[A-Za-z0-9'"‘’“”][.,;:?()\-! ]+(?=[A-Za-z0-9'"‘’“”])/g
 *
 * — left bookend (1 word char) + 1+ gap chars + lookahead at the
 * right bookend. Lookahead is critical: it lets single-char interior
 * words (e.g., "a", "I") serve as the right bookend of one match
 * and the left bookend of the next without `/g`'s lastIndex eating
 * them. Quotes are included in the bookend class so gaps adjacent
 * to quoted runs still bridge.
 *
 * The gap range — the chars strictly between the bookends — is
 * what we modify; the bookends themselves are never touched.
 *
 * **Target mark set** for each gap, computed from the two bookends'
 * marks. Six mark types are touched; everything else (bold, italic,
 * font_color, font_family, link, …) is left alone.
 *
 *   - Named-style (underline_mark / emphasis_mark / cite_mark,
 *     mutually exclusive via schema):
 *       - Same named-style on both → include that mark.
 *       - underline + emphasis (either order) → include underline
 *         (Verbatim's "underline wins on mixed",
 *         `Formatting.bas:1071-1074`).
 *       - Anything else → no named-style mark in the target.
 *   - highlight / shading: both bookends carry the mark → include
 *     with the FIRST bookend's color attr. Else → none.
 *   - font_size (uses the chip's effective-pt resolver — the same
 *     one the chip / increment buttons / shrink use):
 *       - Compute each bookend's effective pt (explicit font_size →
 *         named-style default → parent block default).
 *       - Pick the bookend with the SMALLER effective pt.
 *       - If that bookend has an explicit font_size mark → include
 *         the same mark in the target.
 *       - If that bookend is implicit → no font_size in the target.
 *       - Tie + both explicit → either; tie + at least one implicit
 *         → no font_size (prefer the cleanest gap).
 *
 * For each touched type: if the type IS in the target, `addMark` it
 * over the gap range (idempotent if already there with same attrs;
 * replaces attrs if different); if the type is NOT in the target,
 * `removeMark` it (idempotent if absent). PM tracks zero-step
 * transactions, so gaps whose marks already match the target
 * produce no actual transaction work.
 *
 * No-op (returns false) when every gap in scope already matches its
 * target.
 */
export function fixFormattingGaps(
  effectivePt: (node: PMNode | null, parent: PMNode) => number,
): Command {
  return (state, dispatch) => {
    const sel = state.selection;
    const from = sel.empty ? 0 : sel.from;
    const to = sel.empty ? state.doc.content.size : sel.to;

    const underlineType = schema.marks['underline_mark']!;
    const emphasisType = schema.marks['emphasis_mark']!;
    const citeType = schema.marks['cite_mark']!;
    const highlightType = schema.marks['highlight']!;
    const shadingType = schema.marks['shading']!;
    const fontSizeType = schema.marks['font_size']!;

    // Word-char class: ASCII alphanumerics + straight quotes
    // (`'` / `"`) + curly quotes (`‘`/`’`/`“`/`”`). Verbatim's
    // original regex is ASCII-only; we widen the bookend class so
    // a gap adjacent to a quoted run still bridges (e.g.,
    // `must supply " reasoned explanation"`, where the bookend on
    // one side is the curly quote).
    //
    // The right bookend is matched via lookahead so it ISN'T
    // consumed by `/g`'s lastIndex advance. Without the lookahead,
    // a sequence like "...word a word..." would lose the second gap
    // entirely — the regex would consume "...d a", advance past the
    // "a", and then can't start a new match at the following space
    // (not a bookend char). With the lookahead, the consumed match
    // is "...d " only; the next iteration can start at "a" and
    // match "a " for the second gap.
    const gapRegex = /[A-Za-z0-9'"‘’“”][.,;:?()\-! ]+(?=[A-Za-z0-9'"‘’“”])/g;

    type Add = {
      from: number;
      to: number;
      marksToAdd: Mark[];
      marksToRemove: MarkType[];
    };
    const adds: Add[] = [];

    state.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isTextblock) return true;
      const tbFrom = Math.max(from, pos + 1);
      const tbTo = Math.min(to, pos + node.nodeSize - 1);
      if (tbFrom >= tbTo) return false;

      // Walk inline children, building per-char (doc-pos, owning-
      // text-node) lookup arrays alongside the text we'll regex.
      let text = '';
      const charDocPos: number[] = [];
      const charNode: PMNode[] = [];
      let inlineOffset = 0;
      node.forEach((child) => {
        if (child.isText && child.text) {
          const childStart = pos + 1 + inlineOffset;
          const localFrom = Math.max(tbFrom, childStart);
          const localTo = Math.min(tbTo, childStart + child.nodeSize);
          if (localFrom < localTo) {
            const slice = child.text.slice(
              localFrom - childStart,
              localTo - childStart,
            );
            for (let i = 0; i < slice.length; i++) {
              charDocPos.push(localFrom + i);
              charNode.push(child);
            }
            text += slice;
          }
        }
        inlineOffset += child.nodeSize;
      });

      gapRegex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = gapRegex.exec(text)) !== null) {
        // Match shape (left-bookend + gap chars consumed; right
        // bookend is the lookahead):
        //   firstBookendIdx  = m.index
        //   gapStartIdx      = m.index + 1   (first gap char)
        //   gapEndIdx        = m.index + m[0].length - 1
        //   secondBookendIdx = m.index + m[0].length   (lookahead)
        const firstBookendIdx = m.index;
        const gapStartIdx = firstBookendIdx + 1;
        const gapEndIdx = firstBookendIdx + m[0].length - 1;
        const secondBookendIdx = firstBookendIdx + m[0].length;
        if (gapStartIdx > gapEndIdx) continue;
        const gapFromPos = charDocPos[gapStartIdx];
        const gapEndPos = charDocPos[gapEndIdx];
        if (gapFromPos == null || gapEndPos == null) continue;
        const firstNode = charNode[firstBookendIdx];
        const lastNode = charNode[secondBookendIdx];
        if (!firstNode || !lastNode) continue;

        // Gap-only doc range: just the chars BETWEEN the bookends,
        // never the bookends themselves. Matches the user's "F9 on
        // the blank space" mental model and avoids the schema's
        // `excludes` rule kicking in on a mixed-bookend bridge
        // (otherwise applying underline_mark across an emphasized
        // last bookend would strip its emphasis).
        const gapFrom = gapFromPos;
        const gapTo = gapEndPos + 1;

        const fm = firstNode.marks;
        const lm = lastNode.marks;
        const fmU = fm.some((mk) => mk.type === underlineType);
        const fmE = fm.some((mk) => mk.type === emphasisType);
        const fmC = fm.some((mk) => mk.type === citeType);
        const lmU = lm.some((mk) => mk.type === underlineType);
        const lmE = lm.some((mk) => mk.type === emphasisType);
        const lmC = lm.some((mk) => mk.type === citeType);
        const fmHl = fm.find((mk) => mk.type === highlightType);
        const lmHl = lm.find((mk) => mk.type === highlightType);
        const fmSh = fm.find((mk) => mk.type === shadingType);
        const lmSh = lm.find((mk) => mk.type === shadingType);
        const fmFs = fm.find((mk) => mk.type === fontSizeType);
        const lmFs = lm.find((mk) => mk.type === fontSizeType);
        const fmEpt = effectivePt(firstNode, node);
        const lmEpt = effectivePt(lastNode, node);

        const marksToAdd: Mark[] = [];
        const marksToRemove: MarkType[] = [];

        // Named-style target: same on both → that mark; mixed u/e →
        // underline; otherwise → none (and strip any stale named-
        // style mark from the gap).
        let namedStyle: MarkType | null = null;
        if (fmU && lmU) namedStyle = underlineType;
        else if (fmE && lmE) namedStyle = emphasisType;
        else if (fmC && lmC) namedStyle = citeType;
        else if ((fmU && lmE) || (fmE && lmU)) namedStyle = underlineType;
        if (namedStyle) {
          // The schema's `excludes` on the three named-style marks
          // strips the other two automatically when this one is
          // added in the gap range, so we don't need explicit
          // removeMark calls for them.
          marksToAdd.push(namedStyle.create());
        } else {
          marksToRemove.push(underlineType, emphasisType, citeType);
        }

        // highlight / shading: bridge when BOTH bookends have it,
        // first bookend's color wins on mismatch. Otherwise strip.
        if (fmHl && lmHl) marksToAdd.push(highlightType.create(fmHl.attrs));
        else marksToRemove.push(highlightType);
        if (fmSh && lmSh) marksToAdd.push(shadingType.create(fmSh.attrs));
        else marksToRemove.push(shadingType);

        // Font size: pick the bookend with the smaller effective
        // pt; that bookend's explicit mark (if any) becomes the
        // target. Ties: prefer the implicit side unless both are
        // explicit (in which case either works, halfPoints are the
        // same).
        let targetFs: Mark | null = null;
        if (fmEpt < lmEpt) {
          if (fmFs) targetFs = fmFs;
        } else if (lmEpt < fmEpt) {
          if (lmFs) targetFs = lmFs;
        } else if (fmFs && lmFs) {
          targetFs = fmFs;
        }
        if (targetFs) {
          marksToAdd.push(fontSizeType.create(targetFs.attrs));
        } else {
          marksToRemove.push(fontSizeType);
        }

        adds.push({ from: gapFrom, to: gapTo, marksToAdd, marksToRemove });
      }
      return false;
    });

    // Always build the tr so the no-op detection is accurate. Every
    // matched gap queues both addMark and removeMark calls; PM's
    // ops are idempotent for marks already-present (addMark) or
    // already-absent (removeMark), so a gap whose marks already
    // match the target produces no actual step. `tr.steps.length`
    // is the truth.
    const tr = state.tr;
    for (const { from: f, to: t, marksToAdd, marksToRemove } of adds) {
      for (const mt of marksToRemove) tr.removeMark(f, t, mt);
      for (const m of marksToAdd) tr.addMark(f, t, m);
    }
    if (tr.steps.length === 0) return false;
    if (!dispatch) return true;
    dispatch(tr);
    return true;
  };
}

/**
 * Verbatim's `ConvertAnalyticsToTags` — bulk swap every
 * `analytic_unit` in scope to a `card` (and its `analytic` heading
 * to a `tag`). Selection-sensitive:
 *
 *   - Non-empty selection → only units that intersect the selection.
 *   - Empty selection → every unit in the doc.
 *
 * The heading's `id`, inline content, and marks survive — this is
 * a same-tier swap (the existing per-cursor Mod-F7 path uses the
 * same shape; see DECISIONS 2026-05-12 "Style apply strips direct
 * formatting" for why this category is exempt from the promotion
 * strip). Body slots (`card_body` / `cite_paragraph` / `undertag`)
 * pass through untouched — they're legal in both containers.
 *
 * No-op (returns false) when no `analytic_unit` exists in scope.
 */
export function convertAnalyticsToTags(): Command {
  return (state, dispatch) => {
    const sel = state.selection;
    const from = sel.empty ? 0 : sel.from;
    const to = sel.empty ? state.doc.content.size : sel.to;

    const units: { node: PMNode; pos: number }[] = [];
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type.name === 'analytic_unit') {
        units.push({ node, pos });
        // Analytic_units don't nest, so no need to recurse.
        return false;
      }
      return true;
    });
    if (units.length === 0) return false;
    if (!dispatch) return true;

    const tr = state.tr;
    // Reverse-doc order so an earlier unit's position stays valid
    // through later replacements. analytic_unit ↔ card and analytic
    // ↔ tag are same-size swaps anyway (each side wraps with a
    // single open + close), but processing in reverse is the safer
    // default for multi-replace transactions.
    for (let i = units.length - 1; i >= 0; i--) {
      const { node: unit, pos } = units[i]!;
      const analytic = unit.firstChild;
      if (!analytic || analytic.type.name !== 'analytic') continue;
      const tagId =
        (analytic.attrs['id'] as string | null) ?? newHeadingId();
      const tagNode = schema.nodes['tag']!.create(
        { id: tagId },
        analytic.content,
      );
      const rest: PMNode[] = [];
      unit.forEach((child, _offset, idx) => {
        if (idx > 0) rest.push(child);
      });
      const cardNode = schema.nodes['card']!.create(null, [tagNode, ...rest]);
      tr.replaceWith(pos, pos + unit.nodeSize, cardNode);
    }
    dispatch(tr);
    return true;
  };
}

export function removeHyperlinks(): Command {
  return (state, dispatch) => {
    const linkType = schema.marks['link']!;
    const sel = state.selection;
    const from = sel.empty ? 0 : sel.from;
    const to = sel.empty ? state.doc.content.size : sel.to;
    // Pre-scan: bail before constructing a transaction if no run in
    // scope carries the mark. Keeps history clean and lets callers
    // use the return value as "did anything happen?"
    let found = false;
    state.doc.nodesBetween(from, to, (node) => {
      if (found) return false;
      if (node.marks.some((m) => m.type === linkType)) found = true;
      return !found;
    });
    if (!found) return false;
    if (!dispatch) return true;
    dispatch(state.tr.removeMark(from, to, linkType));
    return true;
  };
}

function findPreviousCites(doc: PMNode, $from: ResolvedPos): PMNode[] {
  // Phase 1: look in the cursor's enclosing card for cites whose end
  // is before the cursor.
  let cardDepth = -1;
  for (let d = $from.depth; d >= 0; d--) {
    if ($from.node(d).type.name === 'card') {
      cardDepth = d;
      break;
    }
  }
  if (cardDepth >= 0) {
    const card = $from.node(cardDepth);
    const cardStart = $from.before(cardDepth);
    const cursorPos = $from.pos;
    const here: PMNode[] = [];
    let childStart = cardStart + 1;
    card.forEach((child) => {
      const childEnd = childStart + child.nodeSize;
      if (child.type.name === 'cite_paragraph' && childEnd <= cursorPos) {
        here.push(child);
      }
      childStart = childEnd;
    });
    if (here.length > 0) return here;
  }

  // Phase 2: walk doc-level children backward (from the cursor's
  // enclosing card if any, else from the cursor itself). A "source"
  // is either a card whose children include at least one
  // cite_paragraph OR a run of consecutive free-floating
  // cite_paragraphs at doc level. The most recent source (in
  // document order) wins.
  const limitPos = cardDepth >= 0 ? $from.before(cardDepth) : $from.pos;
  let bestCites: PMNode[] = [];
  let currentGroup: PMNode[] = [];
  let pos = 0;
  doc.forEach((child) => {
    const childEnd = pos + child.nodeSize;
    pos = childEnd;
    if (childEnd > limitPos) return;
    const t = child.type.name;
    if (t === 'cite_paragraph') {
      currentGroup.push(child);
      return;
    }
    // Any non-cite_paragraph node breaks a free-floating cite run.
    if (currentGroup.length > 0) {
      bestCites = currentGroup;
      currentGroup = [];
    }
    if (t === 'card') {
      const found: PMNode[] = [];
      child.forEach((g) => {
        if (g.type.name === 'cite_paragraph') found.push(g);
      });
      if (found.length > 0) bestCites = found;
    }
  });
  if (currentGroup.length > 0) bestCites = currentGroup;
  return bestCites;
}

/** Body-like textblock types whose empty (or whitespace-only) instances
 *  are replaced by the cite rather than left behind. Headings
 *  (pocket/hat/block/tag/analytic) are not in this set — their empty
 *  form is a meaningful slot the user explicitly created. */
const REPLACE_IF_EMPTY = new Set(['paragraph', 'card_body', 'cite_paragraph', 'undertag']);

function isBlankParagraph(node: PMNode): boolean {
  return /^\s*$/.test(node.textContent);
}

interface CitePasteLocation {
  from: number;
  to: number;
}

/**
 * Where to drop the cite content. Three regimes, in priority
 * order:
 *
 *   1. If the cursor's paragraph is an empty body-like slot,
 *      replace it (the user explicitly placed the cursor in a
 *      blank slot — fill it).
 *   2. If the cursor is at the VERY START (parentOffset === 0)
 *      of a body-like paragraph (card_body / cite_paragraph /
 *      undertag / doc-level paragraph), insert the cite right
 *      BEFORE that paragraph. Without this branch, a cursor at
 *      offset 0 in the first card_body of a no-cite card sent
 *      the cite AFTER that body (between body 1 and body 2),
 *      surprising users who expected it between the tag and
 *      body 1 (i.e., between the previous sibling and the
 *      cursor's paragraph — "where the cursor visually is").
 *   3. Otherwise, insert as a sibling immediately after the
 *      cursor's paragraph. Covers cursor in a tag (cite
 *      naturally belongs after the tag), and cursor mid-/end-
 *      of-body.
 */
function computeCitePasteLocation($from: ResolvedPos): CitePasteLocation {
  if ($from.depth < 1) return { from: 0, to: 0 };
  const para = $from.parent;
  const paraDepth = $from.depth;
  if (REPLACE_IF_EMPTY.has(para.type.name) && isBlankParagraph(para)) {
    return { from: $from.before(paraDepth), to: $from.after(paraDepth) };
  }
  if (REPLACE_IF_EMPTY.has(para.type.name) && $from.parentOffset === 0) {
    const insertPos = $from.before(paraDepth);
    return { from: insertPos, to: insertPos };
  }
  const insertPos = $from.after(paraDepth);
  return { from: insertPos, to: insertPos };
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
  // Analytic → tag: same-tier swap, see convertCardToAnalyticUnit.
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
  | { mode: 'analytic' }
  | { mode: 'undertag' };

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
  // Selection-based promotion replaces the source paragraph entirely;
  // strip named-style and direct-formatting marks so the new structural
  // block carries only the canonical typography. Exception: tag↔analytic
  // is a same-tier swap (same structural role, different cite/analytic
  // semantic) so direct formatting carries through.
  const sameTierSwap =
    (opts.mode === 'tag' || opts.mode === 'analytic') &&
    (child.type.name === 'tag' || child.type.name === 'analytic');
  const cleanContent = sameTierSwap
    ? child.content
    : stripPromotionMarksOnFragment(child.content);
  if (opts.mode === 'undertag') {
    // Undertag has no id and no wrapping container — at doc level it
    // sits as a sibling, inside a card it sits among the body slots.
    return schema.nodes['undertag']!.create(null, cleanContent);
  }
  const id = existingId ?? newHeadingId();
  if (opts.mode === 'heading') {
    return schema.nodes[opts.headingType]!.create({ id }, cleanContent);
  }
  if (opts.mode === 'tag') {
    const tag = schema.nodes['tag']!.create({ id }, cleanContent);
    return schema.nodes['card']!.create(null, [tag]);
  }
  const a = schema.nodes['analytic']!.create({ id }, cleanContent);
  return schema.nodes['analytic_unit']!.create(null, [a]);
}

// ---- Keymap binding registry ----

/**
 * Stable identifiers for editor command bindings. The settings UI
 * will store user overrides keyed by these IDs — not by the current
 * key string — so renaming a default key doesn't strand user
 * customizations.
 *
 * `StructuralRibbonCommandId` is the subset rendered as buttons in
 * the formatting panel; the remainder are keyboard-only.
 */
export type StructuralRibbonCommandId =
  | 'setPocket'
  | 'setHat'
  | 'setBlock'
  | 'setTag'
  | 'setAnalytic'
  | 'setUndertag';

export type RibbonCommandId =
  | StructuralRibbonCommandId
  | 'toggleBold'
  | 'toggleItalic'
  | 'toggleStrikethrough'
  | 'toggleSuperscript'
  | 'toggleSubscript'
  | 'applyCite'
  | 'applyUnderline'
  | 'applyEmphasis'
  | 'emphasizeAcronym'
  | 'applyHighlight'
  | 'highlightAcronym'
  | 'applyShading'
  | 'condenseDefault'
  | 'condenseNoIntegrity'
  | 'condenseNoIntegrityWithPilcrows'
  | 'condenseWithWarning'
  | 'uncondense'
  | 'toggleCase'
  | 'copyPreviousCite'
  | 'pasteAsText'
  | 'clearToNormal'
  | 'shrink'
  | 'createReference'
  | 'highlightToShading'
  | 'shadingToHighlight'
  | 'standardizeHighlight'
  | 'standardizeShading'
  | 'toggleReadMode'
  | 'toggleCommentsVisible'
  | 'addCommentToSelection'
  | 'aiAskAboutSelection'
  | 'aiCreateCite'
  | 'wordCountSelection'
  | 'openShortcutsReference'
  | 'selectSimilar'
  | 'removeHyperlinks'
  | 'convertAnalyticsToTags'
  | 'fixFormattingGaps'
  | 'insertTable'
  | 'addRowAfter'
  | 'addRowBefore'
  | 'deleteTableRow'
  | 'addColumnAfter'
  | 'addColumnBefore'
  | 'deleteTableColumn'
  | 'mergeTableCells'
  | 'splitTableCell'
  | 'deleteTable'
  | 'newDocument'
  | 'openFile'
  | 'save'
  | 'saveAs'
  | 'toggleAutosave'
  | 'newSpeechDocument'
  | 'markActiveAsSpeech'
  | 'sendToSpeechAtCursor'
  | 'sendToSpeechAtEnd'
  | 'sendToDropzone'
  // Select / copy the cursor's enclosing structure (the current card /
  // analytic_unit / heading + its subtree), reusing the send-to-*
  // bounds logic but keyed off the cursor — any active selection is
  // ignored. No default bindings — wire up via Settings → Keybindings.
  | 'selectCurrentHeading'
  | 'copyCurrentHeading'
  // Quick Cards (see reference-docs/SPEC-quick-cards.md). Add saves the
  // current selection as a named, tagged snippet (no default binding);
  // the search palette opens on Mod-Shift-Space.
  | 'addQuickCard'
  | 'openQuickCardSearch'
  | 'insertImage'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'chromeScaleUp'
  | 'chromeScaleDown'
  | 'chromeScaleReset'
  | 'togglePaintbrushHighlight'
  | 'togglePaintbrushShading'
  | 'openFind'
  | 'openFindReplace'
  | 'openFindByProximity'
  | 'toggleNavPane'
  // Commands that ship without a default binding — added so users
  // can wire them up via Settings → Keybindings. Each maps to a
  // ribbon button or menu item that wasn't previously bindable.
  | 'adjustFontSizeUp'
  | 'adjustFontSizeDown'
  | 'applyFontColor'
  | 'openSettings'
  | 'toggleParagraphIntegrity'
  | 'selectSpeechDoc'
  | 'goHome'
  | 'openHighlightPicker'
  | 'openShadingPicker'
  | 'openFontColorPicker'
  | 'openFontSizePicker'
  | 'openDocToolsMenu'
  | 'openCardToolsMenu'
  | 'openTableMenu'
  // Multi-pane workspace navigation. All seven listed here for
  // user-rebindability via Settings → Keybindings; the shell
  // owns the implementations and the global keydown handler in
  // editor/index.ts dispatches when the key fires. No-ops in
  // single-doc mode.
  | 'focusSlot1'
  | 'focusSlot2'
  | 'focusSlot3'
  | 'sendDocToSlot1'
  | 'sendDocToSlot2'
  | 'sendDocToSlot3'
  | 'toggleSlotExpand'
  // Smart close — closes the focused slot's visible doc in
  // multi-pane mode; falls through to the standard window-close
  // prompt otherwise. Menu accelerator (Ctrl+W) stays
  // hardcoded as a discoverability cue; this registry entry is
  // the user-rebindable layer.
  | 'closeDocOrWindow';

export const STRUCTURAL_RIBBON_COMMAND_IDS: StructuralRibbonCommandId[] = [
  'setPocket',
  'setHat',
  'setBlock',
  'setTag',
  'setAnalytic',
  'setUndertag',
];

export const RIBBON_COMMAND_IDS: RibbonCommandId[] = [
  ...STRUCTURAL_RIBBON_COMMAND_IDS,
  'toggleBold',
  'toggleItalic',
  'toggleStrikethrough',
  'toggleSuperscript',
  'toggleSubscript',
  'applyCite',
  'applyUnderline',
  'applyEmphasis',
  'emphasizeAcronym',
  'applyHighlight',
  'highlightAcronym',
  'applyShading',
  'condenseDefault',
  'condenseNoIntegrity',
  'condenseNoIntegrityWithPilcrows',
  'condenseWithWarning',
  'uncondense',
  'toggleCase',
  'copyPreviousCite',
  'pasteAsText',
  'clearToNormal',
  'shrink',
  'createReference',
  'highlightToShading',
  'shadingToHighlight',
  'standardizeHighlight',
  'standardizeShading',
  'toggleReadMode',
  'toggleCommentsVisible',
  'addCommentToSelection',
  'aiAskAboutSelection',
  'aiCreateCite',
  'wordCountSelection',
  'openShortcutsReference',
  'selectSimilar',
  'removeHyperlinks',
  'convertAnalyticsToTags',
  'fixFormattingGaps',
  'insertTable',
  'addRowAfter',
  'addRowBefore',
  'deleteTableRow',
  'addColumnAfter',
  'addColumnBefore',
  'deleteTableColumn',
  'mergeTableCells',
  'splitTableCell',
  'deleteTable',
  'newDocument',
  'openFile',
  'save',
  'saveAs',
  'toggleAutosave',
  'newSpeechDocument',
  'markActiveAsSpeech',
  'sendToSpeechAtCursor',
  'sendToSpeechAtEnd',
  'sendToDropzone',
  'selectCurrentHeading',
  'copyCurrentHeading',
  'addQuickCard',
  'openQuickCardSearch',
  'insertImage',
  'zoomIn',
  'zoomOut',
  'zoomReset',
  'chromeScaleUp',
  'chromeScaleDown',
  'chromeScaleReset',
  'togglePaintbrushHighlight',
  'togglePaintbrushShading',
  'openFind',
  'openFindReplace',
  'openFindByProximity',
  'toggleNavPane',
  // Newly bindable ribbon actions (no default keys).
  'adjustFontSizeUp',
  'adjustFontSizeDown',
  'applyFontColor',
  'openSettings',
  'toggleParagraphIntegrity',
  'selectSpeechDoc',
  'goHome',
  'openHighlightPicker',
  'openShadingPicker',
  'openFontColorPicker',
  'openFontSizePicker',
  'openDocToolsMenu',
  'openCardToolsMenu',
  'openTableMenu',
  'focusSlot1',
  'focusSlot2',
  'focusSlot3',
  'sendDocToSlot1',
  'sendDocToSlot2',
  'sendDocToSlot3',
  'toggleSlotExpand',
  'closeDocOrWindow',
];

export const RIBBON_COMMAND_LABELS: Record<RibbonCommandId, string> = {
  setPocket: 'Apply Pocket Style',
  setHat: 'Apply Hat Style',
  setBlock: 'Apply Block Style',
  setTag: 'Apply Tag Style',
  setAnalytic: 'Apply Analytic Style',
  setUndertag: 'Apply Undertag Style',
  toggleBold: 'Bold',
  toggleItalic: 'Italic',
  toggleStrikethrough: 'Strikethrough',
  toggleSuperscript: 'Superscript',
  toggleSubscript: 'Subscript',
  applyCite: 'Apply Cite Style',
  applyUnderline: 'Toggle Underline',
  applyEmphasis: 'Apply Emphasis Style',
  emphasizeAcronym: 'Emphasize Acronym',
  applyHighlight: 'Toggle Highlight',
  highlightAcronym: 'Highlight Acronym',
  applyShading: 'Toggle Background Color',
  condenseDefault: 'Condense',
  condenseNoIntegrity: 'Condense Without Paragraph Integrity',
  condenseNoIntegrityWithPilcrows: 'Condense Without Paragraph Integrity (With Pilcrows)',
  condenseWithWarning: 'Condense With Warning',
  uncondense: 'Uncondense',
  toggleCase: 'Toggle Case',
  copyPreviousCite: 'Copy Previous Cite',
  pasteAsText: 'Paste Plain Text',
  clearToNormal: 'Clear',
  shrink: 'Shrink Card Text',
  createReference: 'Create Reference',
  highlightToShading: 'Highlight to Background',
  shadingToHighlight: 'Background to Highlight',
  standardizeHighlight: 'Standardize Highlighting',
  standardizeShading: 'Standardize Background Color',
  toggleReadMode: 'Toggle Read Mode',
  toggleCommentsVisible: 'Show / Hide Comments',
  addCommentToSelection: 'Add Comment to Selection',
  aiAskAboutSelection: 'Ask AI About Selection',
  aiCreateCite: 'Format Cite From Selection',
  wordCountSelection: 'Word Count Selection',
  openShortcutsReference: 'Open Keyboard Shortcuts',
  selectSimilar: 'Select Similar Formatting',
  removeHyperlinks: 'Remove Hyperlinks',
  convertAnalyticsToTags: 'Convert Analytics to Tags',
  fixFormattingGaps: 'Fix Formatting Gaps',
  insertTable: 'Insert Table',
  addRowAfter: 'Insert Row Below',
  addRowBefore: 'Insert Row Above',
  deleteTableRow: 'Delete Row',
  addColumnAfter: 'Insert Column Right',
  addColumnBefore: 'Insert Column Left',
  deleteTableColumn: 'Delete Column',
  mergeTableCells: 'Merge Cells',
  splitTableCell: 'Split Cell',
  deleteTable: 'Delete Table',
  newDocument: 'New Document',
  openFile: 'Open File',
  save: 'Save',
  saveAs: 'Save As…',
  toggleAutosave: 'Toggle Autosave',
  newSpeechDocument: 'New Speech Document',
  markActiveAsSpeech: 'Mark / Unmark Active Doc as the Speech Doc',
  sendToSpeechAtCursor: 'Send to Speech (At Cursor)',
  sendToSpeechAtEnd: 'Send to Speech (At End)',
  sendToDropzone: 'Send to Dropzone',
  selectCurrentHeading: 'Select Current Heading',
  copyCurrentHeading: 'Copy Current Heading',
  addQuickCard: 'Add Quick Card',
  openQuickCardSearch: 'Search Quick Cards',
  insertImage: 'Insert Image at Cursor',
  zoomIn: 'Zoom In',
  zoomOut: 'Zoom Out',
  zoomReset: 'Reset Zoom to 100%',
  chromeScaleUp: 'Chrome Scale Up',
  chromeScaleDown: 'Chrome Scale Down',
  chromeScaleReset: 'Reset Chrome Scale to 100%',
  togglePaintbrushHighlight: 'Toggle Highlight Paint Mode',
  togglePaintbrushShading: 'Toggle Background-Color Paint Mode',
  openFind: 'Find',
  openFindReplace: 'Find and Replace',
  openFindByProximity: 'Find by Proximity (No Category Boost)',
  toggleNavPane: 'Show / Hide Navigation Pane',
  adjustFontSizeUp: 'Increase Font Size by 1pt',
  adjustFontSizeDown: 'Decrease Font Size by 1pt',
  applyFontColor: 'Apply Font Color',
  openSettings: 'Open Settings',
  toggleParagraphIntegrity: 'Toggle Paragraph Integrity',
  selectSpeechDoc: 'Select Speech Document',
  goHome: 'Go to Home Screen',
  openHighlightPicker: 'Open Highlight Color Picker',
  openShadingPicker: 'Open Background Color Picker',
  openFontColorPicker: 'Open Font Color Picker',
  openFontSizePicker: 'Open Font Size Picker',
  openDocToolsMenu: 'Open Doc Tools Menu',
  openCardToolsMenu: 'Open Card Tools Menu',
  openTableMenu: 'Open Table Menu',
  focusSlot1: 'Focus Slot 1',
  focusSlot2: 'Focus Slot 2',
  focusSlot3: 'Focus Slot 3',
  sendDocToSlot1: 'Send Doc to Slot 1',
  sendDocToSlot2: 'Send Doc to Slot 2',
  sendDocToSlot3: 'Send Doc to Slot 3',
  toggleSlotExpand: 'Toggle Slot Expand / Restore',
  closeDocOrWindow: 'Close Doc or Window',
};

/**
 * Default key bindings. The value is a single key or an array of
 * keys; all bindings invoke the same command. The first entry is the
 * "primary" binding used for ribbon-button tooltips; the rest are
 * aliases (visible in the future rebinding UI). Verbatim's hotkeys
 * win where they exist; Word's Mod-B / Mod-I / Mod-U pipe in as
 * aliases for inline marks.
 */
export const DEFAULT_RIBBON_KEYS: Record<RibbonCommandId, string | string[]> = {
  setPocket: 'F4',
  setHat: 'F5',
  setBlock: 'F6',
  setTag: 'F7',
  setAnalytic: 'Mod-F7',
  setUndertag: 'Mod-F8',
  toggleBold: 'Mod-b',
  toggleItalic: 'Mod-i',
  toggleStrikethrough: '',
  toggleSuperscript: 'Mod-Shift-=',
  toggleSubscript: 'Mod-=',
  applyCite: 'F8',
  applyUnderline: ['F9', 'Mod-u'],
  applyEmphasis: 'F10',
  emphasizeAcronym: 'Alt-F10',
  applyHighlight: 'F11',
  highlightAcronym: 'Alt-F11',
  applyShading: 'Mod-F11',
  condenseDefault: 'F3',
  condenseNoIntegrity: 'Alt-F3',
  condenseNoIntegrityWithPilcrows: 'Mod-Alt-F3',
  condenseWithWarning: '',
  uncondense: 'Mod-Alt-Shift-F3',
  toggleCase: 'Shift-F3',
  copyPreviousCite: 'Alt-F8',
  pasteAsText: 'F2',
  clearToNormal: 'F12',
  shrink: 'Mod-8',
  // Menu / button commands — exposed for user-defined bindings via
  // the keybinding editor; no default key.
  createReference: '',
  highlightToShading: '',
  shadingToHighlight: '',
  standardizeHighlight: '',
  standardizeShading: '',
  toggleReadMode: '',
  toggleCommentsVisible: '',
  addCommentToSelection: '',
  aiAskAboutSelection: 'Mod-Shift-q',
  aiCreateCite: 'Mod-Shift-x',
  wordCountSelection: '',
  openShortcutsReference: '',
  selectSimilar: '',
  removeHyperlinks: '',
  convertAnalyticsToTags: '',
  fixFormattingGaps: '',
  // Table commands — no default keys; bind via the keybinding editor.
  insertTable: '',
  addRowAfter: '',
  addRowBefore: '',
  deleteTableRow: '',
  addColumnAfter: '',
  addColumnBefore: '',
  deleteTableColumn: '',
  mergeTableCells: '',
  splitTableCell: '',
  deleteTable: '',
  // Chrome won't let JS suppress its `Ctrl-N` (new window) or
  // `Ctrl-Shift-N` (new incognito window) defaults — both keys
  // are un-preventable in the browser, so the web edition has to
  // use `Mod-Alt-N`. Electron has no such restriction, so its
  // default is the conventional `Mod-N`. Both can be rebound in
  // Settings → Keybindings.
  newDocument: getHost().kind === 'electron' ? 'Mod-n' : 'Mod-Alt-n',
  openFile: 'Mod-o',
  save: 'Mod-s',
  saveAs: 'Mod-Shift-s',
  toggleAutosave: '',
  // Verbatim's "Send to speech" — bare backtick (next to 1 on US
  // layouts) for at-cursor, Alt-backtick for at-end-of-doc. Same
  // chord as the desktop app. Trade-off: a bare backtick keystroke
  // is consumed by the command; users who actually need to type a
  // literal "`" in evidence can rebind these via Settings →
  // Keybindings.
  sendToSpeechAtCursor: '`',
  sendToSpeechAtEnd: 'Alt-`',
  sendToDropzone: 'Mod-`',
  selectCurrentHeading: '',
  copyCurrentHeading: '',
  addQuickCard: '',
  openQuickCardSearch: 'Mod-Shift-Space',
  newSpeechDocument: '',
  markActiveAsSpeech: '',
  insertImage: '',
  // Zoom. Mod-=/Mod-- mirror Word's editor-zoom convention (the `=`
  // key is the unshifted version of `+`). Mod-= overlaps with
  // toggleSubscript's default; the editor's keymap resolves the
  // overlap in the user's favor via Settings → Keybindings, where
  // either command can be rebound. zoomReset stays unbound by
  // default — Mod-0 is a browser-level "reset zoom" chord that
  // Chromium won't always let the page intercept.
  zoomIn: 'Mod-=',
  zoomOut: 'Mod--',
  zoomReset: '',
  // Chrome scale — Mod-Alt versions of the editor-zoom chord.
  // Same physical keys with Alt added: reads as "zoom the whole
  // page, not just the doc". Wired to Chromium's per-frame
  // setZoomFactor on Electron (identical mechanism to the
  // browser's built-in Ctrl-+); no-op on the web edition (use
  // the browser's own page-zoom there).
  chromeScaleUp: 'Mod-Alt-=',
  chromeScaleDown: 'Mod-Alt--',
  chromeScaleReset: 'Mod-Alt-0',
  // Paintbrush toggles — no obvious convention here, so register
  // them in the keybinding registry without a default. Users who
  // want a hotkey for sticky highlight / shading can bind one in
  // Settings → Keybindings.
  togglePaintbrushHighlight: '',
  togglePaintbrushShading: '',
  // Browser-level Ctrl-F opens the page's find. Electron will let us
  // intercept (we drive our own bar); the web edition may see the
  // browser's UI also pop up. Documented + user-rebindable.
  openFind: 'Mod-f',
  openFindReplace: 'Mod-h',
  openFindByProximity: 'Alt-f',
  // No default — pickable in Settings → Keybindings. Hiding the
  // nav pane is a personal-workflow toggle that's already on the
  // ribbon + nav-pane × + pull-tab; the keybinding is a power-
  // user convenience layer, not a discoverable default.
  toggleNavPane: '',
  // Newly bindable ribbon actions. None get a default key — they're
  // all already reachable via the ribbon, so a default chord would
  // just be noise. Users who want a hotkey can pick one in
  // Settings → Keybindings.
  adjustFontSizeUp: '',
  adjustFontSizeDown: '',
  applyFontColor: '',
  openSettings: '',
  toggleParagraphIntegrity: '',
  selectSpeechDoc: '',
  goHome: '',
  openHighlightPicker: '',
  openShadingPicker: '',
  openFontColorPicker: '',
  openFontSizePicker: '',
  openDocToolsMenu: '',
  openCardToolsMenu: '',
  openTableMenu: '',
  focusSlot1: 'Mod-1',
  focusSlot2: 'Mod-2',
  focusSlot3: 'Mod-3',
  sendDocToSlot1: 'Mod-Shift-1',
  sendDocToSlot2: 'Mod-Shift-2',
  sendDocToSlot3: 'Mod-Shift-3',
  toggleSlotExpand: 'Mod-Shift-f',
  closeDocOrWindow: 'Mod-w',
};

/**
 * Live values the color-aware commands (F11 Highlight, Mod-F11
 * Shading) read at invocation time. Passed into `buildRibbonKeymap`
 * and `getRibbonCommand` so the editor can hand them a `settings`-
 * backed resolver. Defaults pull the schema's defaults, so tests can
 * call `getRibbonCommand('applyHighlight')` without wiring settings.
 */
export interface RibbonContext {
  highlightColor: () => string;
  shadingColor: () => string;
  /** Whether F3 (default condense) preserves paragraph integrity. */
  paragraphIntegrity: () => boolean;
  /** Whether F3 inserts 6-pt ¶ markers when merging (consulted only when
   *  paragraphIntegrity is false). */
  usePilcrows: () => boolean;
  /** How selection-based condense treats structural elements. See
   *  `condense.ts` and `settings.ts` for the rule table. */
  headingMode: () => 'strict' | 'respect' | 'demolish';
  /** Whether F2 (Paste Text) runs the default condense pass after pasting. */
  condenseOnPaste: () => boolean;
  /** Whether F9's toggle-off direction also strips direct formatting
   *  (Verbatim's "press F9 twice clears formatting"). */
  clearFormattingOnNamedStyleToggleOff: () => boolean;
  /** Resolves a text run's effective font-size in pt, accounting for
   *  font_size marks, named-style marks, and paragraph defaults — same
   *  resolver the chip / increment-decrement buttons use. Used by
   *  Shrink to compute its starting size. */
  effectivePtForNode: (node: PMNode | null, parent: PMNode) => number;
  /** Body "Normal" size in pt — the size Shrink jumps back to at the
   *  bottom of its cycle. */
  normalPt: () => number;
  /** Whether Shrink (Mod-8) excludes protected text (omissions,
   *  warning markers, user custom rules) from the cycle and pins
   *  them at Normal size. Off by default. */
  shrinkRestoresOmissionsToNormal: () => boolean;
  /** Compiled protected-range patterns Shrink uses to find spans to
   *  preserve at Normal size. The editor builds this from the static
   *  built-in patterns, the user's custom protections, and the
   *  custom condense-with-warning delimiter (if configured). */
  shrinkProtectionPatterns: () => readonly RegExp[];
  /** Full pause / resume marker text "Condense with warning" should
   *  emit. For the six built-in delimiter enum values this is the
   *  classic `<open>PARAGRAPH INTEGRITY PAUSES<close>` pairing; for
   *  the `'custom'` enum value it's the user-typed setting strings
   *  verbatim (which replace the entire marker, not just the
   *  brackets). The resolver lets the command consume one shape
   *  regardless of which the user picked. */
  condenseWarningMarkers: () => { pause: string; resume: string };
  /** Side-effecting actions for the menu-only / button-only commands.
   *  All four are no-ops by default so tests / standalone uses of
   *  `getRibbonCommand` don't need to wire them. The real editor
   *  binds these in `index.ts` to the corresponding modal / dialog /
   *  setting toggle. They are wrapped in Commands so the keybinding
   *  editor can rebind them like any other ribbon action. */
  runCreateReference: () => void;
  openWordCountDialog: () => void;
  toggleReadMode: () => void;
  openShortcutsReference: () => void;
  toggleCommentsVisible: () => void;
  addCommentToSelection: () => void;
  aiAskAboutSelection: () => void;
  aiCreateCite: () => void;
  /** File-level commands. These work regardless of whether the editor
   *  is mounted / has a doc loaded — they always run the same handler
   *  the corresponding ribbon button uses. */
  newDocument: () => void;
  openFile: () => void;
  save: () => void;
  saveAs: () => void;
  toggleAutosave: () => void;
  /** Speech-doc commands (Verbatim's `Paperless.SendToSpeech` family).
   *  All four are wired via the speech-doc registry — when the host
   *  hasn't installed a real implementation, the defaults are
   *  no-ops so tests / standalone uses don't crash. */
  newSpeechDocument: () => void;
  markActiveAsSpeech: () => void;
  sendToSpeechAtCursor: () => void;
  sendToSpeechAtEnd: () => void;
  sendToDropzone: () => void;
  /** Select / copy the cursor's enclosing structure (the current
   *  card / analytic_unit / heading + subtree). Keyed off the cursor;
   *  any active selection is ignored. */
  selectCurrentHeading: () => void;
  copyCurrentHeading: () => void;
  /** Save the current selection as a named, tagged quick card
   *  (opens the Add dialog). No-op + toast if the selection is empty. */
  addQuickCard: () => void;
  /** Open the floating quick-card search palette. Works with no
   *  active doc (browse-only; insert no-ops). */
  openQuickCardSearch: () => void;
  /** Open the file picker that prompts for an image to insert at
   *  the editor's current cursor. Pasting an image from the
   *  clipboard goes through paste-plugin instead — no ctx hook
   *  needed for that path. */
  insertImage: () => void;
  /** Zoom controls — bumps the persisted `zoomPct` setting one
   *  step up/down or resets it to 100%. The status-bar buttons
   *  use the same handlers. */
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
  /** Chrome scale — page-zoom analog of the editor zoom above.
   *  Bumps the persisted `chromeScalePct` setting (50–200, step
   *  10); on Electron this propagates to Chromium's
   *  `webFrame.setZoomFactor` so the whole page (chrome + doc)
   *  reflows at the new factor. No-op on the web edition. */
  chromeScaleUp: () => void;
  chromeScaleDown: () => void;
  chromeScaleReset: () => void;
  /** Paint-mode toggles for highlight / background-color. Mirror
   *  what clicking the ribbon's main color button does when the
   *  selection is empty (arming sticky paint until the next click
   *  or Escape). */
  togglePaintbrushHighlight: () => void;
  togglePaintbrushShading: () => void;
  /** Open the floating Find / Find+Replace bar. The proximity
   *  variant is Alt-F's behavior: no category boost, pure
   *  closest-match-to-cursor ranking. */
  openFind: () => void;
  openFindReplace: () => void;
  openFindByProximity: () => void;
  /** Flip the navigation-pane visibility setting. Per-window
   *  (transient), so toggling in one window leaves siblings
   *  untouched. */
  toggleNavPane: () => void;
  /** Most-recently-picked font color (hex, no `#`, e.g. `"FF0000"`)
   *  or `null` when the user has chosen "Automatic" / no explicit
   *  color. Read at invocation time by the `applyFontColor` command
   *  so a keybinding applies whatever color the user last picked
   *  in the ribbon swatch. */
  lastFontColor: () => string | null;
  /** Host-side actions exposed for keybinding parity with their
   *  ribbon-button counterparts. All optional (default no-op) so
   *  tests and headless callers don't have to wire them up. */
  openSettings: () => void;
  toggleParagraphIntegrity: () => void;
  selectSpeechDoc: () => void;
  goHome: () => void;
  openHighlightPicker: () => void;
  openShadingPicker: () => void;
  openFontColorPicker: () => void;
  openFontSizePicker: () => void;
  openDocToolsMenu: () => void;
  openCardToolsMenu: () => void;
  openTableMenu: () => void;
}

const DEFAULT_RIBBON_CONTEXT: RibbonContext = {
  highlightColor: () => 'yellow',
  shadingColor: () => 'D2D2D2',
  paragraphIntegrity: () => true,
  usePilcrows: () => false,
  headingMode: () => 'respect',
  condenseOnPaste: () => false,
  clearFormattingOnNamedStyleToggleOff: () => true,
  effectivePtForNode: () => 11,
  normalPt: () => 11,
  shrinkRestoresOmissionsToNormal: () => false,
  shrinkProtectionPatterns: () => BUILTIN_PROTECTED_REGEXES,
  condenseWarningMarkers: () => ({
    pause: '[PARAGRAPH INTEGRITY PAUSES]',
    resume: '[PARAGRAPH INTEGRITY RESUMES]',
  }),
  runCreateReference: () => {},
  openWordCountDialog: () => {},
  toggleReadMode: () => {},
  openShortcutsReference: () => {},
  toggleCommentsVisible: () => {},
  addCommentToSelection: () => {},
  aiAskAboutSelection: () => {},
  aiCreateCite: () => {},
  newDocument: () => {},
  openFile: () => {},
  save: () => {},
  saveAs: () => {},
  toggleAutosave: () => {},
  newSpeechDocument: () => {},
  markActiveAsSpeech: () => {},
  sendToSpeechAtCursor: () => {},
  sendToDropzone: () => {},
  sendToSpeechAtEnd: () => {},
  selectCurrentHeading: () => {},
  copyCurrentHeading: () => {},
  addQuickCard: () => {},
  openQuickCardSearch: () => {},
  insertImage: () => {},
  zoomIn: () => {},
  zoomOut: () => {},
  zoomReset: () => {},
  chromeScaleUp: () => {},
  chromeScaleDown: () => {},
  chromeScaleReset: () => {},
  togglePaintbrushHighlight: () => {},
  togglePaintbrushShading: () => {},
  openFind: () => {},
  openFindReplace: () => {},
  openFindByProximity: () => {},
  toggleNavPane: () => {},
  lastFontColor: () => null,
  openSettings: () => {},
  toggleParagraphIntegrity: () => {},
  selectSpeechDoc: () => {},
  goHome: () => {},
  openHighlightPicker: () => {},
  openShadingPicker: () => {},
  openFontColorPicker: () => {},
  openFontSizePicker: () => {},
  openDocToolsMenu: () => {},
  openCardToolsMenu: () => {},
  openTableMenu: () => {},
};

function commandFor(id: RibbonCommandId, ctx: RibbonContext): Command {
  switch (id) {
    case 'setPocket': return setHeading('pocket');
    case 'setHat': return setHeading('hat');
    case 'setBlock': return setHeading('block');
    case 'setTag': return setTag();
    case 'setAnalytic': return setAnalytic();
    case 'setUndertag': return setUndertag();
    case 'toggleBold': return shadowAwareToggleMark(schema.marks['bold']!);
    case 'toggleItalic': return shadowAwareToggleMark(schema.marks['italic']!);
    case 'toggleStrikethrough': return shadowAwareToggleMark(schema.marks['strikethrough']!);
    case 'toggleSuperscript': return shadowAwareToggleMark(schema.marks['superscript']!);
    case 'toggleSubscript': return shadowAwareToggleMark(schema.marks['subscript']!);
    case 'applyCite': return applyCite();
    case 'applyUnderline': return applyUnderline(ctx.clearFormattingOnNamedStyleToggleOff);
    case 'applyEmphasis': return applyEmphasis();
    case 'emphasizeAcronym': return emphasizeAcronym();
    case 'applyHighlight': return applyHighlight(ctx.highlightColor);
    case 'highlightAcronym': return highlightAcronym(ctx.highlightColor);
    case 'applyShading': return applyShading(ctx.shadingColor);
    case 'condenseDefault':
      // F3 reads paragraphIntegrity + usePilcrows at invocation time.
      return (state, dispatch) => {
        if (ctx.paragraphIntegrity()) {
          return condenseBranchC()(state, dispatch);
        }
        return condenseMerge({
          withPilcrows: ctx.usePilcrows(),
          headingMode: ctx.headingMode(),
        })(state, dispatch);
      };
    case 'condenseNoIntegrity':
      // Alt-F3: force no integrity + no pilcrows regardless of settings.
      return (state, dispatch) =>
        condenseMerge({ withPilcrows: false, headingMode: ctx.headingMode() })(state, dispatch);
    case 'condenseNoIntegrityWithPilcrows':
      // Mod-Alt-F3: force no integrity + pilcrows regardless of settings.
      return (state, dispatch) =>
        condenseMerge({ withPilcrows: true, headingMode: ctx.headingMode() })(state, dispatch);
    case 'condenseWithWarning':
      return condenseWithWarning(ctx.condenseWarningMarkers);
    case 'uncondense': return uncondense();
    case 'toggleCase': return toggleCase();
    case 'copyPreviousCite': return copyPreviousCite();
    case 'pasteAsText':
      return pasteAsText(ctx);
    case 'clearToNormal':
      return clearToNormal();
    case 'shrink':
      return shrinkText(
        ctx.effectivePtForNode,
        ctx.normalPt,
        ctx.shrinkRestoresOmissionsToNormal,
        ctx.shrinkProtectionPatterns,
      );
    case 'createReference':
      // Side-effecting (clipboard write + toast). Returns true so the
      // keymap consumes the keystroke even though no transaction fires.
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.runCreateReference();
        return true;
      };
    case 'highlightToShading':
      return highlightToShading();
    case 'shadingToHighlight':
      return shadingToHighlight();
    case 'standardizeHighlight':
      // Auto-scoped: selection-based when there's a selection, doc-
      // wide when there isn't. Keeps one menu item for both modes.
      return (state, dispatch, view) =>
        uniHighlight(
          ctx.highlightColor,
          state.selection.empty ? 'document' : 'selection',
        )(state, dispatch, view);
    case 'standardizeShading':
      return (state, dispatch, view) =>
        uniShade(
          ctx.shadingColor,
          state.selection.empty ? 'document' : 'selection',
        )(state, dispatch, view);
    case 'toggleReadMode':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.toggleReadMode();
        return true;
      };
    case 'toggleCommentsVisible':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.toggleCommentsVisible();
        return true;
      };
    case 'addCommentToSelection':
      // The mark + thread creation logic is view-aware, so the
      // command just delegates to the editor's side-effect hook.
      return (state, dispatch) => {
        if (state.selection.empty) return false;
        if (!dispatch) return true;
        ctx.addCommentToSelection();
        return true;
      };
    case 'aiAskAboutSelection':
      return (state, dispatch) => {
        if (state.selection.empty) return false;
        if (!dispatch) return true;
        ctx.aiAskAboutSelection();
        return true;
      };
    case 'aiCreateCite':
      return (state, dispatch) => {
        if (state.selection.empty) return false;
        if (!dispatch) return true;
        ctx.aiCreateCite();
        return true;
      };
    case 'wordCountSelection':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openWordCountDialog();
        return true;
      };
    case 'openShortcutsReference':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openShortcutsReference();
        return true;
      };
    case 'selectSimilar':
      return selectSimilar(ctx.effectivePtForNode);
    case 'removeHyperlinks':
      return removeHyperlinks();
    case 'convertAnalyticsToTags':
      return convertAnalyticsToTags();
    case 'fixFormattingGaps':
      return fixFormattingGaps(ctx.effectivePtForNode);
    case 'insertTable':
      return insertTable();
    case 'addRowAfter':
      return addRowAfter;
    case 'addRowBefore':
      return addRowBefore;
    case 'deleteTableRow':
      return deleteRow;
    case 'addColumnAfter':
      return addColumnAfter;
    case 'addColumnBefore':
      return addColumnBefore;
    case 'deleteTableColumn':
      return deleteColumn;
    case 'mergeTableCells':
      return mergeCells;
    case 'splitTableCell':
      return splitCell;
    case 'deleteTable':
      return deleteTable;
    case 'newDocument':
      // File-level commands: always available, even with no doc open
      // and no selection. PM-command convention: return `false` from
      // a "query" call (no dispatch) so the keybinding editor can
      // tell apart bound-but-unrunnable from bound-and-active, then
      // run the side effect on the real dispatch call.
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.newDocument();
        return true;
      };
    case 'openFile':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openFile();
        return true;
      };
    case 'save':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.save();
        return true;
      };
    case 'saveAs':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.saveAs();
        return true;
      };
    case 'toggleAutosave':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.toggleAutosave();
        return true;
      };
    case 'newSpeechDocument':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.newSpeechDocument();
        return true;
      };
    case 'markActiveAsSpeech':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.markActiveAsSpeech();
        return true;
      };
    case 'sendToSpeechAtCursor':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.sendToSpeechAtCursor();
        return true;
      };
    case 'sendToSpeechAtEnd':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.sendToSpeechAtEnd();
        return true;
      };
    case 'sendToDropzone':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.sendToDropzone();
        return true;
      };
    case 'selectCurrentHeading':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.selectCurrentHeading();
        return true;
      };
    case 'copyCurrentHeading':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.copyCurrentHeading();
        return true;
      };
    case 'addQuickCard':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.addQuickCard();
        return true;
      };
    case 'openQuickCardSearch':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openQuickCardSearch();
        return true;
      };
    case 'insertImage':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.insertImage();
        return true;
      };
    case 'zoomIn':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.zoomIn();
        return true;
      };
    case 'zoomOut':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.zoomOut();
        return true;
      };
    case 'zoomReset':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.zoomReset();
        return true;
      };
    case 'chromeScaleUp':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.chromeScaleUp();
        return true;
      };
    case 'chromeScaleDown':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.chromeScaleDown();
        return true;
      };
    case 'chromeScaleReset':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.chromeScaleReset();
        return true;
      };
    case 'togglePaintbrushHighlight':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.togglePaintbrushHighlight();
        return true;
      };
    case 'togglePaintbrushShading':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.togglePaintbrushShading();
        return true;
      };
    case 'openFind':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openFind();
        return true;
      };
    case 'openFindReplace':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openFindReplace();
        return true;
      };
    case 'openFindByProximity':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openFindByProximity();
        return true;
      };
    case 'toggleNavPane':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.toggleNavPane();
        return true;
      };
    // ─── No-default-binding commands (parity for ribbon actions
    //     that previously had inline click handlers only) ────────
    case 'adjustFontSizeUp':
      return adjustFontSize(1, ctx.effectivePtForNode);
    case 'adjustFontSizeDown':
      return adjustFontSize(-1, ctx.effectivePtForNode);
    case 'applyFontColor':
      // Apply the user's most-recently-picked font color (null =
      // strip the font_color mark / revert to theme default).
      return (state, dispatch, view) =>
        setFontColor(ctx.lastFontColor())(state, dispatch, view);
    case 'openSettings':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openSettings();
        return true;
      };
    case 'toggleParagraphIntegrity':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.toggleParagraphIntegrity();
        return true;
      };
    case 'selectSpeechDoc':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.selectSpeechDoc();
        return true;
      };
    case 'goHome':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.goHome();
        return true;
      };
    case 'openHighlightPicker':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openHighlightPicker();
        return true;
      };
    case 'openShadingPicker':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openShadingPicker();
        return true;
      };
    case 'openFontColorPicker':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openFontColorPicker();
        return true;
      };
    case 'openFontSizePicker':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openFontSizePicker();
        return true;
      };
    case 'openDocToolsMenu':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openDocToolsMenu();
        return true;
      };
    case 'openCardToolsMenu':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openCardToolsMenu();
        return true;
      };
    case 'openTableMenu':
      return (_state, dispatch) => {
        if (!dispatch) return true;
        ctx.openTableMenu();
        return true;
      };
    // Multi-pane workspace commands are dispatched via
    // `runViewlessRibbon` in `editor/index.ts` (they don't read
    // PM state or dispatch transactions). Return a no-op
    // PM Command so PM's keymap doesn't claim the key but also
    // doesn't crash; the viewless path is what actually fires.
    case 'focusSlot1':
    case 'focusSlot2':
    case 'focusSlot3':
    case 'sendDocToSlot1':
    case 'sendDocToSlot2':
    case 'sendDocToSlot3':
    case 'toggleSlotExpand':
    case 'closeDocOrWindow':
      return () => false;
  }
}

/**
 * Insert a default 3×3 table at the cursor. (Larger / smaller
 * tables can be reached via add-row / add-column after the fact.)
 * Inserts only if the cursor sits where a table is schema-legal.
 */
function insertTable(): Command {
  return (state, dispatch) => {
    const tableType = schema.nodes['table'];
    const rowType = schema.nodes['table_row'];
    const cellType = schema.nodes['table_cell'];
    const paragraphType = schema.nodes['paragraph'];
    if (!tableType || !rowType || !cellType || !paragraphType) return false;

    const rows = 3;
    const cols = 3;
    const cellContent = paragraphType.createAndFill();
    if (!cellContent) return false;
    const tableRows: PMNode[] = [];
    for (let r = 0; r < rows; r++) {
      const cells: PMNode[] = [];
      for (let c = 0; c < cols; c++) {
        cells.push(cellType.create(null, cellContent));
      }
      tableRows.push(rowType.create(null, cells));
    }
    const tableNode = tableType.create(null, tableRows);

    const $from = state.selection.$from;
    // Walk up from the cursor's deepest non-textblock ancestor outward,
    // finding the innermost container whose schema allows a `table`
    // child. doc / card / analytic_unit accept tables; card_body and
    // textblocks (paragraph, tag, etc.) don't. Insert immediately
    // before the ancestor that lives one level inside that container,
    // matching the prior doc-level "before current block" semantic —
    // so a cursor inside a card produces a card-internal table just
    // above the card_body the cursor is in.
    let depth = $from.depth;
    while (depth > 0) {
      const container = $from.node(depth - 1);
      const idx = $from.index(depth - 1);
      if (container.canReplaceWith(idx, idx, tableType)) break;
      depth--;
    }
    if (depth === 0) {
      // Even the doc rejected the table — schema misconfiguration.
      return false;
    }
    const insertAt = $from.before(depth);
    if (!dispatch) return true;
    dispatch(state.tr.insert(insertAt, tableNode).scrollIntoView());
    return true;
  };
}

/** Normalize a default-key value (string | string[]) to an array. */
function keysArray(spec: string | string[]): string[] {
  return Array.isArray(spec) ? spec : [spec];
}

/**
 * Primary key for a command — the binding shown to the user (tooltips
 * etc.). Aliases (further entries in the array) exist for the user's
 * muscle memory but aren't surfaced in the chrome.
 */
export function primaryKeyFor(
  id: RibbonCommandId,
  overrides: Partial<Record<RibbonCommandId, string | string[]>> = {},
): string {
  const spec = overrides[id] ?? DEFAULT_RIBBON_KEYS[id];
  const keys = keysArray(spec);
  return keys[0] ?? '';
}

/**
 * Produce a `keymap()`-ready binding object. Each command's keys
 * (primary + aliases) all bind to the same Command. Overrides replace
 * the default array for a given command; passing an empty string or
 * empty array unbinds it. When a settings panel is added, it can
 * pass user-stored overrides here.
 */
export function buildRibbonKeymap(
  overrides: Partial<Record<RibbonCommandId, string | string[]>> = {},
  ctx: RibbonContext = DEFAULT_RIBBON_CONTEXT,
): Record<string, Command> {
  const out: Record<string, Command> = {};
  for (const id of RIBBON_COMMAND_IDS) {
    const spec = overrides[id] ?? DEFAULT_RIBBON_KEYS[id];
    const cmd = commandFor(id, ctx);
    for (const key of keysArray(spec)) {
      if (!key) continue;
      out[key] = cmd;
    }
  }
  return out;
}

/**
 * Build a Command for a given ribbon command ID. Used by the ribbon
 * toolbar buttons so they stay keyed by stable IDs alongside the
 * keymap — when a binding is rebound through settings, buttons and
 * keys both follow.
 */
export function getRibbonCommand(
  id: RibbonCommandId,
  ctx: RibbonContext = DEFAULT_RIBBON_CONTEXT,
): Command {
  return commandFor(id, ctx);
}

/**
 * Build a ProseMirror-keymap-style key string from a KeyboardEvent —
 * `"F3"`, `"Alt-F3"`, `"Mod-Alt-F3"`, etc. Modifier order matches
 * the convention used in `DEFAULT_RIBBON_KEYS`.
 */
export function ribbonKeyStringFor(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Mod');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  // Normalize digits via `e.code` so `Mod-Shift-1` matches even
  // though Shift+1 produces `e.key === '!'` on US layouts (and
  // layout-specific shifted chars elsewhere). For non-digits keep
  // `e.key` — letters get the same character regardless of Shift
  // (uppercased), and PM-style keymap matching already accounts
  // for shifted symbol keys like `=` / `+`.
  if (/^Digit[0-9]$/.test(e.code)) {
    parts.push(e.code.slice(5));
  } else if (e.code === 'Space' || e.key === ' ') {
    // The space key's `e.key` is a literal " ", which would join into
    // "Mod-Shift- " and never match the canonical "Mod-Shift-Space"
    // binding. Normalize to PM's "Space" name so the global key
    // handler matches space bindings even when the editor is unfocused.
    parts.push('Space');
  } else {
    parts.push(e.key);
  }
  return parts.join('-');
}

/**
 * Look up a ribbon command ID by its current key binding. Returns
 * null if no command is bound to this key. Used by the global
 * F-key capture handler in `index.ts` to dispatch ribbon commands
 * when the editor isn't the focused element.
 */
export function ribbonCommandForKey(
  keyString: string,
  overrides: Partial<Record<RibbonCommandId, string | string[]>> = {},
): RibbonCommandId | null {
  for (const id of RIBBON_COMMAND_IDS) {
    const spec = overrides[id] ?? DEFAULT_RIBBON_KEYS[id];
    if (keysArray(spec).includes(keyString)) return id;
  }
  return null;
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
