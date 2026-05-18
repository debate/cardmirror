/**
 * Condense / Uncondense / Toggle Case — Verbatim parity for the F3
 * family. See `ARCHITECTURE.md §15 condense` for the full rule table;
 * docstring summary inline below.
 *
 * Three condense modes:
 *   - Branch C (paragraph integrity preserved): per-textblock
 *     whitespace cleanup, no merging.
 *   - Branch A (no integrity, no pilcrows): merge collapsible
 *     paragraphs with spaces at the original boundaries.
 *   - Branch B (no integrity, with pilcrows): merge with 6-pt ¶
 *     markers at the original boundaries — recoverable via Uncondense.
 *
 * `respectHeadings` modifies branches A and B for selection-based
 * runs: when true, only `card_body` and doc-level `paragraph` runs
 * merge (headings, cites, undertags remain separate paragraphs);
 * when false, every touched paragraph merges into one textblock
 * whose type = type of the first touched paragraph, with cards /
 * analytic_units whose head was touched dissolved and orphan body
 * slots absorbed into the receiving container.
 */

import { Fragment, type Node as PMNode, type Mark, type NodeType } from 'prosemirror-model';
import { TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import { schema } from '../schema/index.js';

// ---------- Pilcrow primitives ----------

/** Unicode pilcrow (U+00B6). Verbatim's condensed-paragraph marker. */
export const PILCROW_CHAR = '¶';
/** Half-points value matching Verbatim's 6-pt sized pilcrow. */
export const PILCROW_HALF_POINTS = 12;

/** Create a single pilcrow text node carrying the non-inclusive
 *  `pilcrow_marker` mark. Non-inclusive so the cursor adjacent to a
 *  pilcrow doesn't inherit it — typing near a pilcrow stays at the
 *  surrounding text size, not 6pt. */
export function makePilcrowText(): PMNode {
  const marker = schema.marks['pilcrow_marker']!.create();
  return schema.text(PILCROW_CHAR, [marker]);
}

/** Whether a single text character at index `i` of `node` is a pilcrow
 *  marker — recognized by either the new `pilcrow_marker` mark (current
 *  format) or the legacy `font_size` mark at 6-pt (pre-fix docs / docs
 *  imported from Verbatim's OOXML encoding, which the importer still
 *  reads as font_size). */
export function isPilcrowMarker(node: PMNode, i: number): boolean {
  if (!node.isText) return false;
  const text = node.text ?? '';
  if (text[i] !== PILCROW_CHAR) return false;
  if (node.marks.some((m) => m.type.name === 'pilcrow_marker')) return true;
  const fontSize = node.marks.find((m) => m.type.name === 'font_size');
  return !!fontSize && fontSize.attrs['halfPoints'] === PILCROW_HALF_POINTS;
}

// ---------- Node-type classification ----------

/** Body slots that participate in the collapse runs (when `respectHeadings`
 *  is true) and in the no-selection in-card collapse. */
const COLLAPSIBLE_TYPES = new Set(['card_body', 'paragraph']);
/** Structural elements always preserved when `respectHeadings` is true. */
const HEADING_TYPES = new Set(['pocket', 'hat', 'block', 'tag', 'analytic']);
/** Body slots that stay separate when `respectHeadings` is true (in addition
 *  to headings). */
const PRESERVED_BODY_SLOTS = new Set(['cite_paragraph', 'undertag']);

function isCollapsible(node: PMNode): boolean {
  return COLLAPSIBLE_TYPES.has(node.type.name);
}

function isHeading(node: PMNode): boolean {
  return HEADING_TYPES.has(node.type.name);
}

function isPreserved(node: PMNode): boolean {
  return isHeading(node) || PRESERVED_BODY_SLOTS.has(node.type.name);
}

// ---------- Whitespace cleanup ----------

/**
 * Tab and NBSP that count as cleanup-eligible whitespace per Verbatim's
 * `CondenseCard`. We don't have page / section / column / soft-line
 * break characters in the schema — those are docx-only artifacts.
 */
const TAB = '\t';
const NBSP = ' ';

/**
 * Cleaned inline content for one textblock. Walks the textblock's
 * inline children as a flat sequence of (char, marks) entries plus
 * non-text inline leaves, applies whitespace normalization, and
 * rebuilds a Fragment that preserves marks per character.
 *
 * Rules:
 *   - Tabs and NBSPs → regular space.
 *   - Runs of spaces (across mark boundaries) collapse to one space.
 *     The collapsed space inherits the marks of the *first* space in
 *     the run (this is what Word's Find/Replace effectively does and
 *     keeps inline formatting boundaries stable).
 *   - Leading spaces at the very start of the textblock are stripped.
 *   - Trailing single space is preserved (Verbatim's logic stops at
 *     "collapse multiple spaces", it doesn't trim trailing).
 *   - Non-text inline leaves (e.g., images) pass through untouched
 *     and break the whitespace run logically (a space immediately
 *     before/after a leaf is preserved verbatim).
 */
export function cleanTextblockContent(textblock: PMNode): Fragment {
  if (!textblock.isTextblock) return textblock.content;

  type Atom =
    | { kind: 'char'; ch: string; marks: readonly Mark[] }
    | { kind: 'leaf'; node: PMNode };

  // Flatten inline content to atoms.
  const atoms: Atom[] = [];
  textblock.content.forEach((child) => {
    if (child.isText) {
      const t = child.text ?? '';
      for (let i = 0; i < t.length; i++) {
        let ch = t[i]!;
        if (ch === TAB || ch === NBSP) ch = ' ';
        atoms.push({ kind: 'char', ch, marks: child.marks });
      }
    } else {
      atoms.push({ kind: 'leaf', node: child });
    }
  });

  // Collapse space runs in-place over the atoms array.
  // Drop leading spaces; collapse interior runs of >1 space.
  const cleaned: Atom[] = [];
  let sawNonSpaceOrLeaf = false;
  let prevWasSpace = false;
  for (const atom of atoms) {
    if (atom.kind === 'leaf') {
      cleaned.push(atom);
      sawNonSpaceOrLeaf = true;
      prevWasSpace = false;
      continue;
    }
    const isSpace = atom.ch === ' ';
    if (isSpace) {
      if (!sawNonSpaceOrLeaf) continue; // drop leading spaces
      if (prevWasSpace) continue; // collapse
      cleaned.push(atom);
      prevWasSpace = true;
    } else {
      cleaned.push(atom);
      sawNonSpaceOrLeaf = true;
      prevWasSpace = false;
    }
  }

  // Rebuild as a Fragment: contiguous chars with identical mark sets
  // group into a single text node; leaves stay separate.
  const nodes: PMNode[] = [];
  let buf = '';
  let bufMarks: readonly Mark[] = [];
  const flushText = () => {
    if (buf.length === 0) return;
    nodes.push(schema.text(buf, bufMarks));
    buf = '';
    bufMarks = [];
  };
  for (const atom of cleaned) {
    if (atom.kind === 'leaf') {
      flushText();
      nodes.push(atom.node);
      continue;
    }
    if (buf.length === 0) {
      buf = atom.ch;
      bufMarks = atom.marks;
    } else if (marksEqual(bufMarks, atom.marks)) {
      buf += atom.ch;
    } else {
      flushText();
      buf = atom.ch;
      bufMarks = atom.marks;
    }
  }
  flushText();

  return Fragment.fromArray(nodes);
}

function marksEqual(a: readonly Mark[], b: readonly Mark[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!a[i]!.eq(b[i]!)) return false;
  }
  return true;
}

// ---------- Branch C: paragraph integrity preserved ----------

interface ScopeResult {
  /** Textblocks (with positions) to apply the operation to. */
  textblocks: { node: PMNode; pos: number }[];
  /** True if no usable scope was found — caller should return false. */
  empty: boolean;
}

/**
 * Resolve the scope of a condense operation. With a non-empty selection,
 * scope = every textblock the selection touches. With an empty selection
 * inside a card or analytic_unit, scope = every textblock in that
 * container (tag included for whitespace cleanup; the caller decides
 * which subset to merge under no-integrity rules). Doc-level cursor
 * with no selection: empty scope.
 */
export function resolveCondenseScope(state: EditorState): ScopeResult {
  const { from, to, empty } = state.selection;
  const textblocks: { node: PMNode; pos: number }[] = [];

  if (!empty) {
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.isTextblock) {
        textblocks.push({ node, pos });
        return false;
      }
      return true;
    });
    return { textblocks, empty: textblocks.length === 0 };
  }

  // Empty selection — look for the enclosing card or analytic_unit.
  const $from = state.selection.$from;
  for (let d = $from.depth; d >= 0; d--) {
    const ancestor = $from.node(d);
    if (ancestor.type.name === 'card' || ancestor.type.name === 'analytic_unit') {
      const containerStart = d === 0 ? 0 : $from.before(d);
      ancestor.forEach((child, offset) => {
        if (child.isTextblock) {
          textblocks.push({ node: child, pos: containerStart + 1 + offset });
        }
      });
      return { textblocks, empty: textblocks.length === 0 };
    }
  }
  // Cursor at doc-level — no-op.
  return { textblocks: [], empty: true };
}

/** Body slots that get removed by Branch C when they end up empty
 *  after whitespace cleanup. Mirrors Verbatim's `^p^p` collapse:
 *  "paragraph return return paragraph" becomes "paragraph return
 *  paragraph". Structural headings, cite_paragraphs and undertags
 *  are kept even if empty — they're intentional placeholders, and
 *  removing an empty tag would dissolve its card. */
const REMOVABLE_EMPTY_TYPES = new Set(['card_body', 'paragraph']);

/**
 * Branch C: clean intra-paragraph whitespace in each scoped textblock,
 * then remove any `card_body` / doc-level `paragraph` that ended up
 * empty. No merging, no node-type changes, no structural fixup —
 * structural elements (headings, cites, undertags) keep existing even
 * when empty.
 *
 * Mirrors Verbatim's CondenseCard Branch C: clean intra-paragraph
 * whitespace, then `^p^w` (paragraph + whitespace) and `^p^p`
 * (consecutive paragraph breaks) iteratively collapsed. Both passes
 * combine to "empty/whitespace-only paragraphs between content
 * paragraphs disappear" — which is what Verbatim's two Find/Replace
 * loops do in sequence.
 */
export function condenseBranchC(): Command {
  return (state, dispatch) => {
    const { textblocks } = resolveCondenseScope(state);
    if (textblocks.length === 0) return false;

    let tr: Transaction | null = null;
    // Process in reverse document order so earlier positions stay
    // valid through the loop (deleting a later textblock doesn't shift
    // earlier ones).
    for (let i = textblocks.length - 1; i >= 0; i--) {
      const { node, pos } = textblocks[i]!;
      const cleaned = cleanTextblockContent(node);
      const isEmpty = cleaned.size === 0;
      const removable = REMOVABLE_EMPTY_TYPES.has(node.type.name);

      if (isEmpty && removable) {
        // Drop the whole textblock — its container's content expression
        // allows 0+ body slots, so the result stays schema-valid.
        if (!tr) tr = state.tr;
        tr.delete(pos, pos + node.nodeSize);
        continue;
      }
      if (fragmentsEqual(cleaned, node.content)) continue;
      if (!tr) tr = state.tr;
      tr.replaceWith(pos + 1, pos + node.nodeSize - 1, cleaned);
    }
    if (!tr) return false;
    if (!dispatch) return true;
    dispatch(tr);
    return true;
  };
}

function fragmentsEqual(a: Fragment, b: Fragment): boolean {
  if (a.childCount !== b.childCount) return false;
  for (let i = 0; i < a.childCount; i++) {
    if (!a.child(i).eq(b.child(i))) return false;
  }
  return true;
}

// ---------- Branches A / B: merging logic ----------

export type HeadingMode = 'strict' | 'respect' | 'demolish';

interface MergeOptions {
  withPilcrows: boolean;
  headingMode: HeadingMode;
}

/**
 * Branches A (no pilcrows) and B (with pilcrows) — both go through
 * this dispatcher. `headingMode` picks among three algorithms for
 * selection-based merges:
 *   - 'strict'   → no-op if the selection touches any structural
 *                  element (heading / cite_paragraph / undertag).
 *                  Otherwise behaves like 'respect' for body-only
 *                  selections.
 *   - 'respect'  → preserve structural elements; merge consecutive
 *                  collapsible runs only.
 *   - 'demolish' → collapse everything in the selection into one
 *                  textblock; dissolve any container whose head was
 *                  touched; reconstitute leftover body slots.
 *
 * No-selection cursor-in-container case uses the safe path
 * unconditionally — the in-card "implicit respect-headings" we
 * agreed on. The other paths only fire when there's an actual
 * selection.
 */
export function condenseMerge(opts: MergeOptions): Command {
  return (state, dispatch) => {
    const { empty } = state.selection;
    if (empty) {
      return condenseMergeInContainer(opts)(state, dispatch);
    }
    if (opts.headingMode === 'strict') {
      return condenseMergeSelectionStrict(opts)(state, dispatch);
    }
    if (opts.headingMode === 'demolish') {
      return condenseMergeSelectionDemolish(opts)(state, dispatch);
    }
    return condenseMergeSelectionPreserving(opts)(state, dispatch);
  };
}

/**
 * Strict mode: if the selection touches ANY structural element
 * (heading / cite_paragraph / undertag), no-op. Otherwise delegate
 * to the preserving path — which for a body-only selection collapses
 * the run normally.
 */
function condenseMergeSelectionStrict(opts: MergeOptions): Command {
  return (state, dispatch) => {
    const { from, to } = state.selection;
    let touchesStructural = false;
    state.doc.nodesBetween(from, to, (node) => {
      if (touchesStructural) return false;
      if (node.isTextblock && isPreserved(node)) {
        touchesStructural = true;
        return false;
      }
      return true;
    });
    if (touchesStructural) return false;
    return condenseMergeSelectionPreserving(opts)(state, dispatch);
  };
}

/**
 * No-selection variant: walk the enclosing card / analytic_unit's
 * children, build runs of consecutive collapsible-by-type body slots
 * (card_body — analytics inside cards don't occur in practice), and
 * merge each run into a single card_body. Tag, cite_paragraphs,
 * undertags stay as-is. Doc-level cursor: no-op.
 */
function condenseMergeInContainer(opts: MergeOptions): Command {
  return (state, dispatch) => {
    const $from = state.selection.$from;
    let containerDepth = -1;
    for (let d = $from.depth; d >= 0; d--) {
      const t = $from.node(d).type.name;
      if (t === 'card' || t === 'analytic_unit') {
        containerDepth = d;
        break;
      }
    }
    if (containerDepth < 0) return false;

    const container = $from.node(containerDepth);
    const containerStart = containerDepth === 0 ? 0 : $from.before(containerDepth);

    // Collect children with absolute positions so we can rebuild.
    const children: { node: PMNode; pos: number }[] = [];
    container.forEach((child, offset) => {
      children.push({ node: child, pos: containerStart + 1 + offset });
    });

    // Compute the new content for the container by walking children,
    // grouping consecutive collapsible nodes into runs, and merging
    // each run. Merge target type = type of the run's first source
    // (a run is always all-one-type because mixed types don't occur
    // as direct children of the same container).
    const newChildren: PMNode[] = [];
    let runBuffer: PMNode[] = [];
    const flushRun = () => {
      if (runBuffer.length === 0) return;
      if (runBuffer.length === 1) {
        newChildren.push(cleanedTextblock(runBuffer[0]!));
      } else {
        newChildren.push(mergeRun(runBuffer, opts.withPilcrows, runBuffer[0]!.type));
      }
      runBuffer = [];
    };
    for (const { node } of children) {
      if (isCollapsible(node)) {
        runBuffer.push(node);
      } else {
        flushRun();
        newChildren.push(cleanedTextblock(node));
      }
    }
    flushRun();

    if (newChildren.length === 0) return false;
    // Build new container; bail if unchanged.
    const newContainer = container.copy(Fragment.fromArray(newChildren));
    if (newContainer.eq(container)) return false;

    if (!dispatch) return true;
    const tr = state.tr.replaceWith(containerStart, containerStart + container.nodeSize, newContainer);
    // Map the selection forward into the new container.
    const newSel = TextSelection.near(tr.doc.resolve(Math.min($from.pos, tr.doc.content.size)));
    tr.setSelection(newSel);
    dispatch(tr);
    return true;
  };
}

/** Return the node with its inline content whitespace-cleaned; non-textblocks
 *  are passed through unchanged. */
function cleanedTextblock(node: PMNode): PMNode {
  if (!node.isTextblock) return node;
  const cleaned = cleanTextblockContent(node);
  if (fragmentsEqual(cleaned, node.content)) return node;
  return node.copy(cleaned);
}

/**
 * Merge a run of consecutive textblocks (all collapsible-by-type) into
 * a single textblock of `targetType`. Each source textblock's inline
 * content is whitespace-cleaned individually, then joined: with
 * pilcrows, a 6-pt ¶ text node between consecutive sources; without,
 * a single space (as a plain text node).
 *
 * Joiner marks: the space joiner inherits the marks of the trailing
 * text run of the preceding paragraph. Without this, a `schema.text(' ')`
 * with no marks defaults to the paragraph's base font-size (Normal),
 * so joining two 8-pt paragraphs would leave a literal 11-pt space at
 * each seam — the font-size-class plugin then sees a mixed-size
 * paragraph and bumps line-height to the larger strut, making the
 * merged paragraph look "11-pt-tall" even though most text is 8 pt.
 * Inheriting the trailing marks gives the joiner the same font-size /
 * highlight / bold / etc. as the run it's extending, which is the
 * visually correct continuation. Pilcrow joiners deliberately keep
 * their own intrinsic formatting (the 6-pt ¶ marker is the whole
 * point) so they don't inherit either way.
 *
 * The first source's marks are preserved; later sources' content
 * keeps its own marks. No attempt to merge marks across boundaries
 * (each source contributes a discrete inline run).
 */
function mergeRun(sources: PMNode[], withPilcrows: boolean, targetType: NodeType): PMNode {
  const inlines: PMNode[] = [];
  let trailingMarks: readonly Mark[] = [];
  for (let i = 0; i < sources.length; i++) {
    if (i > 0) {
      if (withPilcrows) {
        inlines.push(makePilcrowText());
      } else {
        inlines.push(schema.text(' ', trailingMarks as Mark[]));
      }
    }
    const cleaned = cleanTextblockContent(sources[i]!);
    cleaned.forEach((child) => inlines.push(child));
    trailingMarks = trailingTextMarks(cleaned);
  }
  return targetType.create(null, Fragment.fromArray(inlines));
}

/** Marks of the last text node in `fragment`, walking backwards past
 *  any trailing inline leaves. Returns an empty array if the fragment
 *  has no text node. Used by `mergeRun` to give the joiner space the
 *  formatting of the run it extends. */
function trailingTextMarks(fragment: Fragment): readonly Mark[] {
  for (let i = fragment.childCount - 1; i >= 0; i--) {
    const child = fragment.child(i);
    if (child.isText) return child.marks;
  }
  return [];
}

// ---------- Selection-based merging: respect-headings path ----------

/**
 * Selection-based merge with `respectHeadings: true`. Walk through every
 * doc-level container the selection intersects; for each container's
 * touched children, group consecutive collapsible-by-type touched
 * textblocks into runs and merge each run. Preserved-type touched
 * textblocks still get intra-paragraph whitespace cleanup.
 *
 * Implementation: we rebuild the document from the outermost level
 * that contains all touched content (doc), preserving everything
 * outside the selection range and applying run-merging within.
 */
function condenseMergeSelectionPreserving(opts: MergeOptions): Command {
  return (state, dispatch) => {
    const { from, to } = state.selection;

    // Find all textblocks the selection touches, with their parent
    // container path (so we can rebuild containers correctly).
    type Touched = { node: PMNode; pos: number; parent: PMNode; parentPos: number; indexInParent: number };
    const touched: Touched[] = [];
    state.doc.nodesBetween(from, to, (node, pos, parent, indexInParent) => {
      if (node.isTextblock && parent) {
        // Compute parent's pos: it's the position of `parent` in the doc.
        // pos is the position of `node` (the textblock). The parent's
        // position is pos - (offset within parent) - 1. We can derive it
        // by finding parent's start.
        const parentPos = findParentPos(state.doc, pos);
        touched.push({ node, pos, parent, parentPos, indexInParent });
        return false;
      }
      return true;
    });
    if (touched.length === 0) return false;

    // Group consecutive touched textblocks that share the same parent
    // AND are at consecutive indices. Each group is a "run candidate".
    type Group = { parent: PMNode; parentPos: number; items: Touched[] };
    const groups: Group[] = [];
    let currentGroup: Group | null = null;
    for (const t of touched) {
      if (
        currentGroup &&
        currentGroup.parent === t.parent &&
        currentGroup.items[currentGroup.items.length - 1]!.indexInParent + 1 === t.indexInParent
      ) {
        currentGroup.items.push(t);
      } else {
        currentGroup = { parent: t.parent, parentPos: t.parentPos, items: [t] };
        groups.push(currentGroup);
      }
    }

    let tr: Transaction | null = null;
    // Process groups in reverse so position changes don't invalidate earlier work.
    for (let gi = groups.length - 1; gi >= 0; gi--) {
      const group = groups[gi]!;
      // Inside this group, build runs of consecutive collapsible textblocks.
      const newChildren: PMNode[] = [];
      let runBuffer: PMNode[] = [];
      const flushRun = () => {
        if (runBuffer.length === 0) return;
        if (runBuffer.length === 1) {
          newChildren.push(cleanedTextblock(runBuffer[0]!));
        } else {
          newChildren.push(mergeRun(runBuffer, opts.withPilcrows, runBuffer[0]!.type));
        }
        runBuffer = [];
      };
      for (const item of group.items) {
        if (isCollapsible(item.node)) {
          runBuffer.push(item.node);
        } else {
          flushRun();
          newChildren.push(cleanedTextblock(item.node));
        }
      }
      flushRun();

      // Replace the group's textblocks in place. The replacement spans
      // from the first item's pos to the last item's pos + nodeSize.
      const first = group.items[0]!;
      const last = group.items[group.items.length - 1]!;
      const replaceFrom = first.pos;
      const replaceTo = last.pos + last.node.nodeSize;
      const oldFragment = Fragment.fromArray(group.items.map((i) => i.node));
      const newFragment = Fragment.fromArray(newChildren);
      if (fragmentsEqual(oldFragment, newFragment)) continue;
      if (!tr) tr = state.tr;
      tr.replaceWith(replaceFrom, replaceTo, newFragment);
    }

    if (!tr) return false;
    if (!dispatch) return true;
    dispatch(tr);
    return true;
  };
}

/** Find the position of the parent of a textblock at `pos`. The textblock's
 *  parent is the smallest node that wraps `pos`. */
function findParentPos(doc: PMNode, pos: number): number {
  const $pos = doc.resolve(pos);
  // depth - 1 = parent of the textblock at depth. The textblock is at
  // $pos.depth (resolved positions inside a textblock have depth = textblock
  // depth). But we resolved AT the textblock, not inside it; PM's resolve
  // semantics: $pos at the boundary just before the textblock has depth
  // equal to the parent's depth.
  // Simpler: use doc.resolve(pos).before($pos.depth) — but careful:
  return $pos.depth === 0 ? -1 : $pos.before($pos.depth);
}

// ---------- Selection-based merging: demolish path ----------

/**
 * Selection-based merge with `respectHeadings: false`. The destructive
 * path: every touched textblock contributes its full text to a single
 * merged textblock of type = type of the first touched paragraph.
 * Containers (cards / analytic_units) whose head was touched dissolve;
 * orphan body slots after the merge point absorb into the receiving
 * container.
 */
function condenseMergeSelectionDemolish(opts: MergeOptions): Command {
  return (state, dispatch) => {
    const { from, to } = state.selection;

    // Walk doc-level children. Identify the doc-level range that
    // contains all touched content, then rebuild it.
    let docFromIndex = -1;
    let docToIndex = -1;
    let cursor = 0;
    state.doc.forEach((child, _offset, idx) => {
      const childStart = cursor;
      const childEnd = cursor + child.nodeSize;
      if (childEnd > from && childStart < to) {
        if (docFromIndex === -1) docFromIndex = idx;
        docToIndex = idx;
      }
      cursor = childEnd;
    });
    if (docFromIndex === -1) return false;

    // Flatten the affected doc-level children into a sequence of
    // textblocks (paragraphs at any depth), tracking the position of
    // each.
    type Flat = { node: PMNode; touched: boolean };
    const flat: Flat[] = [];
    cursor = 0;
    let replaceFrom = -1;
    let replaceTo = -1;
    state.doc.forEach((child, _offset, idx) => {
      const childStart = cursor;
      cursor += child.nodeSize;
      if (idx < docFromIndex || idx > docToIndex) return;
      if (idx === docFromIndex) replaceFrom = childStart;
      if (idx === docToIndex) replaceTo = cursor;
      flattenForDemolish(child, childStart, from, to, flat);
    });
    if (replaceFrom === -1 || replaceTo === -1) return false;

    // Find first and last touched textblock indices in `flat`.
    let firstTouchedIdx = -1;
    let lastTouchedIdx = -1;
    for (let i = 0; i < flat.length; i++) {
      if (flat[i]!.touched) {
        if (firstTouchedIdx === -1) firstTouchedIdx = i;
        lastTouchedIdx = i;
      }
    }
    if (firstTouchedIdx === -1) return false;

    // Merge type = type of first touched textblock.
    const targetType = flat[firstTouchedIdx]!.node.type;

    // The merged textblock takes the type of the first touched node and
    // collects the FULL text of every touched textblock in between
    // (inclusive), with joiner spaces or pilcrows.
    const touchedNodes: PMNode[] = [];
    for (let i = firstTouchedIdx; i <= lastTouchedIdx; i++) {
      if (flat[i]!.touched) touchedNodes.push(flat[i]!.node);
    }
    const mergedNode = mergeRun(touchedNodes, opts.withPilcrows, targetType);

    // Build the replacement: pre-touched items, mergedNode, post-touched items.
    // Pre-touched: items in `flat` with index < firstTouchedIdx — these came
    // from containers that were partially clipped at the start; their content
    // stays in original container form (already preserved as `flat` entries).
    // Post-touched: items in `flat` with index > lastTouchedIdx — these are
    // untouched leftover body slots / containers.
    //
    // But `flat` is a flattened sequence of textblocks — we've lost container
    // structure. To rebuild correctly we need to track containers.
    //
    // For v1, simplification: pre-touched and post-touched body slots become
    // direct children of the receiving container; if the receiver itself is a
    // doc-level paragraph (no container), siblings stay at doc level.
    //
    // Determine the receiving container by walking up from `flat[firstTouchedIdx]`:
    // the container is the smallest enclosing card / analytic_unit that the
    // first touched node lives in (or doc if it's doc-level).
    //
    // For an MVP that handles the common cases the user described, see the
    // implementation below.

    const result = buildDemolishReplacement(
      state,
      flat,
      firstTouchedIdx,
      lastTouchedIdx,
      mergedNode,
      docFromIndex,
      docToIndex,
    );
    if (!result) return false;

    if (!dispatch) return true;
    const tr = state.tr.replaceWith(replaceFrom, replaceTo, result);
    dispatch(tr);
    return true;
  };
}

/**
 * Flatten a doc-level child (which may be a container) into a flat
 * sequence of textblocks with per-textblock touched flags.
 *
 * "Touched" = textblock range overlaps [from, to).
 */
function flattenForDemolish(
  child: PMNode,
  childStart: number,
  selFrom: number,
  selTo: number,
  out: { node: PMNode; touched: boolean }[],
): void {
  if (child.isTextblock) {
    const tbStart = childStart;
    const tbEnd = childStart + child.nodeSize;
    const touched = tbEnd > selFrom && tbStart < selTo;
    out.push({ node: child, touched });
    return;
  }
  // Container: walk children.
  let cursor = childStart + 1; // +1 for the container's opening token
  child.forEach((g) => {
    flattenForDemolish(g, cursor, selFrom, selTo, out);
    cursor += g.nodeSize;
  });
}

/**
 * Build the replacement fragment for the demolish path. The merged
 * textblock takes the position of the first touched node; pre- and
 * post-touched untouched siblings are placed around it. Containers
 * whose head was touched dissolve — their leftover body slots become
 * doc-level siblings (or absorb into the receiving container if
 * receiver is itself a container... this is the trickier case).
 *
 * MVP: build a flat sequence of doc-level nodes:
 *   - For each untouched node before the merged region: emit as-is
 *     (clean whitespace inside).
 *   - Emit the merged textblock at the cut point.
 *   - For each untouched node after the merged region: emit as-is.
 * Then walk back over the result and absorb orphan body slots
 * (card_body / cite_paragraph / undertag at doc level following the
 * merged node) into the most recent surviving container, if any.
 */
function buildDemolishReplacement(
  state: EditorState,
  flat: { node: PMNode; touched: boolean }[],
  firstTouchedIdx: number,
  lastTouchedIdx: number,
  mergedNode: PMNode,
  _docFromIndex: number,
  _docToIndex: number,
): Fragment | null {
  void state;
  // Step 1: emit the sequence at doc level — pre-touched, merged, post-touched.
  const seq: PMNode[] = [];
  for (let i = 0; i < firstTouchedIdx; i++) {
    if (!flat[i]!.touched) seq.push(cleanedTextblock(flat[i]!.node));
  }
  seq.push(mergedNode);
  for (let i = lastTouchedIdx + 1; i < flat.length; i++) {
    if (!flat[i]!.touched) seq.push(cleanedTextblock(flat[i]!.node));
  }

  // Step 2: walk `seq` and reconstitute containers — body slots
  // (card_body, cite_paragraph, undertag) lift to doc level absorption
  // logic. A tag/analytic starts a new container.
  return reconstituteContainers(seq);
}

/**
 * Walk a flat sequence of would-be-doc-level nodes. For each:
 *   - tag → start a new card; subsequent body slots absorb into it
 *     until the next heading or non-body node.
 *   - analytic → start a new analytic_unit; absorb subsequent body slots.
 *   - card_body / cite_paragraph / undertag → absorb into the current
 *     surviving container if any; otherwise lift to doc level as a
 *     paragraph (matching the schema doc content expression). To keep
 *     things simple and schema-valid, the demoted form for orphan body
 *     slots at doc level is a paragraph node.
 *   - Other doc-level nodes (pocket / hat / block / paragraph): just
 *     emit; container is broken.
 */
function reconstituteContainers(seq: PMNode[]): Fragment {
  type Pending =
    | { kind: 'card'; tag: PMNode; body: PMNode[] }
    | { kind: 'analytic_unit'; analytic: PMNode; body: PMNode[] };
  const out: PMNode[] = [];
  let pending: Pending | null = null;
  const flushPending = () => {
    if (!pending) return;
    if (pending.kind === 'card') {
      out.push(schema.nodes['card']!.create(null, [pending.tag, ...pending.body]));
    } else {
      out.push(schema.nodes['analytic_unit']!.create(null, [pending.analytic, ...pending.body]));
    }
    pending = null;
  };
  for (const node of seq) {
    const t = node.type.name;
    if (t === 'tag') {
      flushPending();
      pending = { kind: 'card', tag: node, body: [] };
      continue;
    }
    if (t === 'analytic') {
      flushPending();
      pending = { kind: 'analytic_unit', analytic: node, body: [] };
      continue;
    }
    if (t === 'card_body' || t === 'cite_paragraph' || t === 'undertag') {
      if (pending) {
        pending.body.push(node);
      } else {
        // Orphan body slot at doc level → demote to paragraph.
        const para = schema.nodes['paragraph']!.create(null, node.content);
        out.push(para);
      }
      continue;
    }
    // Anything else (pocket / hat / block / paragraph): emit as-is and
    // close any pending container.
    flushPending();
    out.push(node);
  }
  flushPending();
  return Fragment.fromArray(out);
}

// ---------- Uncondense ----------

/**
 * Reverse Branch B: find 6-pt ¶ markers in scope and split the
 * containing textblock at each marker, dropping the marker character
 * itself. Scope = selection if non-empty; else current card or
 * analytic_unit; else whole doc (only if cursor at very top — Verbatim
 * confirms before applying doc-wide; we skip the prompt for now and
 * just no-op at doc level with no selection).
 */
export function uncondense(): Command {
  return (state, dispatch) => {
    const { textblocks } = resolveCondenseScope(state);
    if (textblocks.length === 0) return false;

    // Scan textblocks for pilcrow markers. For each marker, plan a
    // split (record textblock pos + char index).
    type Split = { tbPos: number; tbNode: PMNode; charIndex: number };
    const splits: Split[] = [];
    for (const { node, pos } of textblocks) {
      let cursor = 0;
      node.content.forEach((child) => {
        if (child.isText) {
          for (let i = 0; i < (child.text ?? '').length; i++) {
            if (isPilcrowMarker(child, i)) {
              splits.push({ tbPos: pos, tbNode: node, charIndex: cursor + i });
            }
          }
        }
        cursor += child.nodeSize;
      });
    }
    if (splits.length === 0) return false;
    if (!dispatch) return true;

    const tr = state.tr;
    // Process splits in reverse position order so positions stay valid.
    splits.sort((a, b) => (b.tbPos + b.charIndex) - (a.tbPos + a.charIndex));
    for (const split of splits) {
      const charPos = split.tbPos + 1 + split.charIndex;
      // Delete the pilcrow char and split the textblock at that position.
      tr.delete(charPos, charPos + 1);
      tr.split(charPos);
    }
    dispatch(tr);
    return true;
  };
}

// ---------- Toggle case ----------

type CaseMode = 'lower' | 'upper' | 'title' | 'mixed';

function detectCase(text: string): CaseMode {
  if (text.length === 0) return 'mixed';
  const hasUpper = /[A-Z]/.test(text);
  const hasLower = /[a-z]/.test(text);
  if (!hasUpper && hasLower) return 'lower';
  if (hasUpper && !hasLower) return 'upper';
  // Title Case: every word starts uppercase, rest lowercase.
  const titleRe = /^(?:[A-Z][a-z]*\b\W*)+$/;
  if (titleRe.test(text)) return 'title';
  return 'mixed';
}

function toTitleCase(text: string): string {
  return text.replace(/\b\w[\w']*/g, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase());
}

/**
 * 3-state cycle: lowercase → UPPERCASE → Title Case → lowercase.
 * Mixed-case selections start at lowercase (matches Word's "next
 * stop" heuristic).
 */
export function toggleCase(): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    if (empty) return false;

    const text = state.doc.textBetween(from, to, '', '');
    if (text.length === 0) return false;
    const current = detectCase(text);
    let next: string;
    switch (current) {
      case 'lower':
        next = text.toUpperCase();
        break;
      case 'upper':
        next = toTitleCase(text);
        break;
      case 'title':
        next = text.toLowerCase();
        break;
      case 'mixed':
        next = text.toLowerCase();
        break;
    }
    if (next === text) return false;

    if (!dispatch) return true;

    // Walk text nodes in [from, to] and rewrite each char's case
    // according to the position of that char in the cleaned `next`
    // string. Marks preserved per text node.
    const tr = state.tr;
    let offset = 0;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isText) return true;
      const t = node.text ?? '';
      const nodeStart = pos;
      const nodeEnd = pos + node.nodeSize;
      const sliceFrom = Math.max(nodeStart, from);
      const sliceTo = Math.min(nodeEnd, to);
      const localFrom = sliceFrom - nodeStart;
      const localTo = sliceTo - nodeStart;
      const segLen = localTo - localFrom;
      if (segLen <= 0) return true;
      const replacement = next.slice(offset, offset + segLen);
      offset += segLen;
      const newText = t.slice(0, localFrom) + replacement + t.slice(localTo);
      tr.replaceWith(nodeStart, nodeEnd, schema.text(newText, node.marks));
      return true;
    });

    // Preserve the selection so the user can cycle again without
    // re-selecting. Case transforms preserve string length, so the
    // original from/to positions are still valid in the new doc.
    tr.setSelection(TextSelection.create(tr.doc, from, to));

    dispatch(tr);
    return true;
  };
}

// ---------- Condense with warning ----------

/**
 * "Condense with warning" — selection-only condense limited to a
 * single card. Parallels Create Reference in scope validation:
 *
 *   - Selection must be non-empty.
 *   - Every textblock the selection touches must be a `card_body`.
 *   - All touched paragraphs must share the same parent `card`.
 *
 * Behavior: merges the touched paragraphs into a single `card_body`
 * (Branch A — no paragraph integrity, no pilcrows) and wraps the
 * merged paragraph with two new `card_body` markers — the full
 * pause and resume text supplied by the caller. For the built-in
 * delimiter options this is the classic
 * `<open>PARAGRAPH INTEGRITY PAUSES<close>` pairing; for the
 * `'custom'` option the caller supplies whatever literal strings
 * the user typed.
 *
 * No-op on empty selection, non-card-body content, multiple cards,
 * or when no card_body is actually touched. Also no-ops with a
 * console warn when either marker is empty (a half-filled custom
 * setting).
 */
export function condenseWithWarning(
  getMarkers: () => { pause: string; resume: string },
): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    if (empty) return false;

    let parentCardPos: number | null = null;
    const paragraphs: { node: PMNode; pos: number }[] = [];
    let invalid = false;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (invalid) return false;
      if (!node.isTextblock) return true;
      if (node.type.name !== 'card_body') {
        invalid = true;
        return false;
      }
      const $start = state.doc.resolve(pos + 1);
      if ($start.depth < 2) {
        invalid = true;
        return false;
      }
      const cardDepth = $start.depth - 1;
      const card = $start.node(cardDepth);
      const cardPos = $start.before(cardDepth);
      if (card.type.name !== 'card') {
        invalid = true;
        return false;
      }
      if (parentCardPos === null) {
        parentCardPos = cardPos;
      } else if (cardPos !== parentCardPos) {
        invalid = true;
        return false;
      }
      paragraphs.push({ node, pos });
      return false;
    });
    if (invalid || paragraphs.length === 0) return false;
    // Don't emit broken markers if the user picked Custom but left
    // a half-filled setting. No-op + console warn.
    const { pause, resume } = getMarkers();
    if (!pause || !resume) {
      console.warn(
        'condenseWithWarning: pause / resume marker is empty — skipping',
      );
      return false;
    }
    if (!dispatch) return true;

    const cardBodyType = schema.nodes['card_body']!;

    const pausePara = cardBodyType.create(null, schema.text(pause));
    const resumePara = cardBodyType.create(null, schema.text(resume));
    const mergedPara =
      paragraphs.length === 1
        ? cleanedTextblock(paragraphs[0]!.node)
        : mergeRun(paragraphs.map((p) => p.node), false, cardBodyType);

    const first = paragraphs[0]!;
    const last = paragraphs[paragraphs.length - 1]!;
    const tr = state.tr;
    tr.replaceWith(
      first.pos,
      last.pos + last.node.nodeSize,
      Fragment.fromArray([pausePara, mergedPara, resumePara]),
    );
    dispatch(tr);
    return true;
  };
}
