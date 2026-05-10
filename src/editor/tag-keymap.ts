/**
 * Tag boundary editing commands (ARCHITECTURE.md §14.3).
 *
 * Five keymap commands that override Backspace, Delete, and Enter
 * inside a `tag` or `analytic`:
 *
 *  1. Backspace at start of tag → permit only if previous paragraph
 *     is blank (whitespace-only); delete the blank. Otherwise prohibit.
 *  2. Delete at end of tag → permit only if next paragraph is also a
 *     tag; merge them. Otherwise prohibit.
 *  3. Enter in middle of tag → split: a new card with the pre-cursor
 *     tag is inserted before; the original card retains the post-
 *     cursor text plus its existing cite/body/undertags.
 *  4. Enter at end of tag → create a new card_body in the current
 *     card and move the cursor into it. (Overrides Word's default
 *     "next paragraph is a Cite.")
 *  5. Enter at start of tag → handled by the same mid-split path; the
 *     pre-cursor content is empty, so the new card has an empty tag
 *     and the cursor stays at the original tag's start.
 *
 * Same rules apply to `analytic` (in `analytic_unit`, or in a card's
 * cite slot — though we only override when the analytic is the root
 * of an analytic_unit).
 *
 * Pocket / Hat / Block use ProseMirror's default behavior — no
 * overrides needed.
 */

import { TextSelection, type Command } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../schema/index.js';
import { newHeadingId } from '../schema/ids.js';

const HEAD_NODE_TYPES = new Set(['tag', 'analytic']);
const CARD_NODE_TYPES = new Set(['card', 'analytic_unit']);

/**
 * Resolved-position context for a cursor inside a tag/analytic that
 * is the head of a card/analytic_unit.
 */
interface TagContext {
  /** The tag or analytic node. */
  head: PMNode;
  /** The card or analytic_unit node. */
  container: PMNode;
  /** Depth of the head node in the doc. */
  headDepth: number;
  /** Cursor offset inside the head. */
  cursorOffset: number;
  /** Document position right before the head. */
  headFrom: number;
  /** Document position right after the head. */
  headTo: number;
  /** Document position right before the container. */
  containerFrom: number;
  /** Document position right after the container. */
  containerTo: number;
}

function getTagContext(state: import('prosemirror-state').EditorState): TagContext | null {
  if (!state.selection.empty) return null;
  const $from = state.selection.$from;
  const head = $from.parent;
  if (!HEAD_NODE_TYPES.has(head.type.name)) return null;
  const headDepth = $from.depth;
  if (headDepth < 1) return null;
  const container = $from.node(headDepth - 1);
  if (!CARD_NODE_TYPES.has(container.type.name)) return null;
  // The head must be the FIRST child of the container (its required
  // anchor). An analytic in a card's cite slot doesn't qualify.
  if (container.firstChild !== head) return null;
  return {
    head,
    container,
    headDepth,
    cursorOffset: $from.parentOffset,
    headFrom: $from.before(headDepth),
    headTo: $from.after(headDepth),
    containerFrom: $from.before(headDepth - 1),
    containerTo: $from.after(headDepth - 1),
  };
}

function isBlank(node: PMNode): boolean {
  return node.textContent.replace(/\s+/g, '') === '';
}

/**
 * Identify the "previous paragraph in document order" relative to the
 * card/analytic_unit at containerFrom. Walks back across container
 * boundaries: if the previous doc-level sibling is itself a card or
 * analytic_unit, returns that container's last child.
 */
interface PrevParagraph {
  node: PMNode;
  from: number;
  to: number;
  /** True if removing this paragraph would orphan its container's
   *  required anchor (it's the only tag/analytic in a card-like
   *  parent). Caller may want to delete the parent instead. */
  isContainerHead: boolean;
}

function findPrevParagraph(
  doc: PMNode,
  containerFrom: number,
): PrevParagraph | null {
  if (containerFrom <= 0) return null;
  const $beforeContainer = doc.resolve(containerFrom);
  const prev = $beforeContainer.nodeBefore;
  if (!prev) return null;

  if (CARD_NODE_TYPES.has(prev.type.name)) {
    const lastChild = prev.lastChild;
    if (!lastChild) return null;
    const containerOfLastChildFrom = containerFrom - prev.nodeSize;
    let offset = 1; // skip the container's open token
    for (let i = 0; i < prev.childCount - 1; i++) {
      offset += prev.child(i).nodeSize;
    }
    const lastChildFrom = containerOfLastChildFrom + offset;
    return {
      node: lastChild,
      from: lastChildFrom,
      to: lastChildFrom + lastChild.nodeSize,
      isContainerHead: HEAD_NODE_TYPES.has(lastChild.type.name) && prev.childCount === 1,
    };
  }

  // Plain doc-level sibling (paragraph, heading, etc.).
  return {
    node: prev,
    from: containerFrom - prev.nodeSize,
    to: containerFrom,
    isContainerHead: false,
  };
}

/**
 * Identify the "next paragraph in document order" after the
 * container at containerTo. Same boundary-crossing logic as
 * findPrevParagraph but in the forward direction.
 */
interface NextParagraph {
  node: PMNode;
  from: number;
  to: number;
  /** True when the next paragraph is itself the head of the
   *  *following* container (i.e., a tag/analytic that anchors the
   *  next card-like structure). */
  isContainerHead: boolean;
}

function findNextParagraph(
  doc: PMNode,
  containerTo: number,
): NextParagraph | null {
  if (containerTo >= doc.content.size) return null;
  const $afterContainer = doc.resolve(containerTo);
  const next = $afterContainer.nodeAfter;
  if (!next) return null;

  if (CARD_NODE_TYPES.has(next.type.name)) {
    const firstChild = next.firstChild;
    if (!firstChild) return null;
    const firstChildFrom = containerTo + 1; // past the container's open token
    return {
      node: firstChild,
      from: firstChildFrom,
      to: firstChildFrom + firstChild.nodeSize,
      isContainerHead: HEAD_NODE_TYPES.has(firstChild.type.name),
    };
  }

  return {
    node: next,
    from: containerTo,
    to: containerTo + next.nodeSize,
    isContainerHead: false,
  };
}

/**
 * Backspace at the start of a tag/analytic. Permitted only when the
 * preceding paragraph is blank; deletes the blank paragraph (and the
 * containing card if removing the paragraph would orphan it).
 * Otherwise swallows the event so default Backspace doesn't fire.
 */
export const backspaceAtTagStart: Command = (state, dispatch) => {
  const ctx = getTagContext(state);
  if (!ctx) return false;
  if (ctx.cursorOffset !== 0) return false;

  const prev = findPrevParagraph(state.doc, ctx.containerFrom);
  if (!prev) return false; // no previous paragraph — let default handle (no-op typically)

  if (!isBlank(prev.node)) {
    // Prohibit the merge. Swallow so default Backspace can't run.
    return true;
  }

  if (!dispatch) return true;

  let tr = state.tr;
  if (prev.isContainerHead) {
    // The blank paragraph is the only tag of a preceding card —
    // delete the whole card so we don't leave an orphan.
    const $beforeContainer = state.doc.resolve(ctx.containerFrom);
    const prevContainer = $beforeContainer.nodeBefore!;
    const prevContainerFrom = ctx.containerFrom - prevContainer.nodeSize;
    tr = tr.delete(prevContainerFrom, ctx.containerFrom);
  } else {
    tr = tr.delete(prev.from, prev.to);
  }
  // Cursor stays in the original tag (which has shifted toward doc start).
  // ProseMirror's default mapping handles this for selection.
  dispatch(tr.scrollIntoView());
  return true;
};

/**
 * Forward Delete at the end of a tag/analytic. Permitted only when
 * the next paragraph is also a tag/analytic; merges the two heads
 * into one (deletes the boundary plus the second container's wrapper,
 * folding its content into the current). Otherwise swallows the
 * event.
 */
export const deleteAtTagEnd: Command = (state, dispatch) => {
  const ctx = getTagContext(state);
  if (!ctx) return false;
  if (ctx.cursorOffset !== ctx.head.content.size) return false;

  // The head must be the LAST child of its container; if there's a
  // sibling after it (undertag / cite / body), forward-delete would
  // pull that sibling in — which is never another tag — so prohibit.
  if (ctx.container.lastChild !== ctx.head) {
    return true;
  }

  const next = findNextParagraph(state.doc, ctx.containerTo);
  if (!next) return false;

  // Permit only when next paragraph is a tag/analytic. Otherwise
  // prohibit (swallow event).
  if (!next.isContainerHead) {
    return true;
  }

  if (!dispatch) return true;

  // Merge: append the next head's text content to the current head,
  // then delete the next container entirely. The resulting card
  // retains the current container's content.
  const nextContainerFrom = ctx.containerTo;
  const $afterContainer = state.doc.resolve(nextContainerFrom);
  const nextContainer = $afterContainer.nodeAfter!;
  const nextContainerTo = nextContainerFrom + nextContainer.nodeSize;

  let tr = state.tr;
  // Insert the next head's inline content at the end of the current head.
  tr = tr.replaceWith(
    ctx.headTo - 1, // position just inside the head's close (end of head content)
    ctx.headTo - 1,
    next.node.content,
  );
  // Delete the entire next container (mapped through the insert above).
  const mappedNextFrom = tr.mapping.map(nextContainerFrom);
  const mappedNextTo = tr.mapping.map(nextContainerTo);
  tr = tr.delete(mappedNextFrom, mappedNextTo);
  // Selection: cursor stays at the merge point (end of the original
  // head's pre-merge content).
  const cursor = ctx.headTo - 1;
  tr = tr.setSelection(TextSelection.create(tr.doc, cursor));
  dispatch(tr.scrollIntoView());
  return true;
};

/**
 * Enter inside a tag/analytic when the cursor is NOT at the end.
 * Splits: a new card with the pre-cursor head content is inserted
 * before the current card; the current head keeps the post-cursor
 * content; existing cite/body/undertags stay with the (post-cursor)
 * current card. The cursor remains at the original head's start
 * (which is now the post-cursor continuation).
 */
export const enterMidTag: Command = (state, dispatch) => {
  const ctx = getTagContext(state);
  if (!ctx) return false;
  if (ctx.cursorOffset === ctx.head.content.size) return false; // end-of-tag handled separately

  if (!dispatch) return true;

  const headType = ctx.head.type;
  const containerType = ctx.container.type;

  const preContent = ctx.head.content.cut(0, ctx.cursorOffset);
  const postContent = ctx.head.content.cut(ctx.cursorOffset);

  // New card: container with just a head holding pre-cursor content
  // and a fresh heading id.
  const newHead = headType.createChecked(
    { id: newHeadingId() },
    preContent,
  );
  const newContainer = containerType.createChecked(null, [newHead]);

  let tr = state.tr;
  // Replace original head's inline content with post-cursor content.
  tr = tr.replaceWith(
    ctx.headFrom + 1, // start of original head content
    ctx.headTo - 1,   // end of original head content
    postContent,
  );
  // Insert the new container before the current container (positions
  // remain stable because the replaceWith above didn't grow the doc
  // before containerFrom).
  const insertPos = tr.mapping.map(ctx.containerFrom);
  tr = tr.insert(insertPos, newContainer);
  // Cursor: start of the (post-cursor) original head, which has now
  // shifted forward by the new container's size.
  const newHeadStart = tr.mapping.map(ctx.headFrom + 1);
  tr = tr.setSelection(TextSelection.create(tr.doc, newHeadStart));
  dispatch(tr.scrollIntoView());
  return true;
};

/**
 * Enter at the end of a tag/analytic. Creates a new card_body inside
 * the current container and moves the cursor into it.
 *
 * The card_body is appended at the end of the container's existing
 * content. For a freshly-typed card with no other content yet, the
 * new card_body lands immediately after the head (typical workflow).
 * For a card that already has cite/body, the new card_body lands at
 * the end of the body sequence — less ideal placement-wise, but
 * keeps the schema valid.
 */
export const enterAtTagEnd: Command = (state, dispatch) => {
  const ctx = getTagContext(state);
  if (!ctx) return false;
  if (ctx.cursorOffset !== ctx.head.content.size) return false;

  if (!dispatch) return true;

  const cardBodyType = schema.nodes['card_body']!;
  const empty = cardBodyType.createAndFill();
  if (!empty) return false;

  let tr = state.tr;
  // Insert at the end of the container's content (just before its close).
  const insertPos = ctx.containerTo - 1;
  tr = tr.insert(insertPos, empty);
  // Cursor: inside the new card_body (one step past its open).
  const newBodyStart = insertPos + 1;
  tr = tr.setSelection(TextSelection.create(tr.doc, newBodyStart));
  dispatch(tr.scrollIntoView());
  return true;
};
