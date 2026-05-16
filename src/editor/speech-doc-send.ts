/**
 * Send-to-speech routing.
 *
 * Compute the slice to send from the source view, then either insert
 * it into the speech doc's view directly (when the speech doc lives
 * in THIS renderer) or serialize it and route via the host bridge to
 * whichever window owns the speech doc (Electron multi-window).
 *
 * The local insert flow is the same code path the multi-pane shell
 * used to embed inline; it's extracted here so the single-doc multi-
 * window path can reuse it, and so the receive-side handler can
 * apply incoming slices through the exact same logic that an
 * in-window send would.
 */

import type { EditorView } from 'prosemirror-view';
import { TextSelection } from 'prosemirror-state';
import { Slice } from 'prosemirror-model';
import { closeHistory } from 'prosemirror-history';
import { schema } from '../schema/index.js';
import { rewriteHeadingIds } from './drag-controller.js';
import { getSpeechDocResolver } from './speech-doc-registry.js';
import { getElectronHost } from './host/index.js';

/** Optional hook fired after a successful local insert. Multi-pane
 *  uses it to focus the destination slot and cancel its debounced
 *  heavy-update timer; single-doc has nothing to do here. */
export type AfterInsertHook = (speechView: EditorView) => void;

/** Compute the slice to send from `sourceView`. Returns the user's
 *  selection if any, otherwise the enclosing card / heading range.
 *  Returns `null` if the cursor isn't inside a structure that has
 *  natural send semantics (e.g., empty doc). */
export function resolveSendSlice(view: EditorView): Slice | null {
  const state = view.state;
  const sel = state.selection;
  if (!sel.empty) {
    return state.doc.slice(sel.from, sel.to);
  }
  const $pos = sel.$from;
  const doc = state.doc;
  for (let depth = $pos.depth; depth >= 0; depth--) {
    const node = $pos.node(depth);
    const t = node.type.name;
    if (t === 'card' || t === 'analytic_unit') {
      const from = $pos.before(depth);
      return doc.slice(from, from + node.nodeSize);
    }
    if (t === 'pocket' || t === 'hat' || t === 'block') {
      // Heading + everything until the next equal-or-shallower
      // heading. Same semantics computeHeadingRange uses.
      const from = $pos.before(depth);
      const headingLevel = t === 'pocket' ? 1 : t === 'hat' ? 2 : 3;
      let to = doc.content.size;
      doc.nodesBetween(from + node.nodeSize, doc.content.size, (n, p) => {
        if (to !== doc.content.size) return false;
        const nt = n.type.name;
        const nLevel =
          nt === 'pocket' ? 1
          : nt === 'hat' ? 2
          : nt === 'block' ? 3
          : null;
        if (nLevel !== null && nLevel <= headingLevel) {
          to = p;
          return false;
        }
        return true;
      });
      return doc.slice(from, to);
    }
  }
  return null;
}

/** Insert a slice into the speech view at-cursor or at-end. Handles
 *  blank-line replace, mid-text confirmation, history-boundary
 *  isolation (closeHistory + addToHistory meta), trailing paragraph
 *  after the slice, scrollIntoView, focus, and heading-ID rewriting.
 *
 *  Wrapped in `setTimeout(..., 0)` so the dispatch happens off the
 *  source pane's keydown handler — dispatching cross-view inside the
 *  keymap chain was breaking Ctrl-Z (best guess: PM's history logic
 *  was treating the cross-view dispatch as an appended/non-event
 *  because of the surrounding keydown context). */
export function insertSpeechSlice(
  speechView: EditorView,
  slice: Slice,
  atEnd: boolean,
  afterInsert?: AfterInsertHook,
): void {
  const state = speechView.state;

  // Compute insertion range. Two refinements over a naive
  // `tr.insert(pos, content)`:
  //   1. At-end picks the literal end-of-doc.
  //   2. If the cursor (or doc tail in at-end mode) sits in an
  //      empty top-level textblock, we REPLACE that block — otherwise
  //      the placeholder paragraph that makeBlankDoc seeds the
  //      speech doc with would leave a stray empty line above
  //      every sent card.
  let midText = false;
  if (atEnd) {
    const lastChild = state.doc.lastChild;
    if (!(lastChild && lastChild.isTextblock && lastChild.content.size === 0)) {
      // No blank line to absorb — we insert at the literal end.
    }
  } else {
    const $from = state.selection.$from;
    const isEmpty = state.selection.empty;
    const inBlankLine =
      isEmpty &&
      $from.depth >= 1 &&
      $from.parent.isTextblock &&
      $from.parent.content.size === 0;
    // Mid-text means strictly BETWEEN characters in a non-empty
    // textblock. Cursor at the start of a block (parentOffset === 0)
    // inserts before that block; cursor at the end (parentOffset ===
    // parent.content.size) inserts after — both are clean splits
    // and don't need the user-facing confirmation.
    const inMidOfText =
      isEmpty &&
      $from.parent.isTextblock &&
      $from.parentOffset > 0 &&
      $from.parentOffset < $from.parent.content.size;
    if (!inBlankLine && inMidOfText) midText = true;
  }

  if (midText) {
    const ok = window.confirm(
      'Sending to the middle of text in the speech doc. Are you sure?',
    );
    if (!ok) {
      // `window.confirm` steals OS-level focus from the editor's
      // contenteditable — after dismissal the speech doc renders
      // a grey (unfocused) selection until something else grabs
      // focus. Explicitly re-focusing the view fixes that.
      speechView.focus();
      return;
    }
  }

  setTimeout(() => {
    const liveState = speechView.state;
    let liveFrom: number;
    let liveTo: number;
    if (atEnd) {
      const lastChild = liveState.doc.lastChild;
      if (lastChild && lastChild.isTextblock && lastChild.content.size === 0) {
        liveTo = liveState.doc.content.size;
        liveFrom = liveTo - lastChild.nodeSize;
      } else {
        liveFrom = liveState.doc.content.size;
        liveTo = liveFrom;
      }
    } else {
      const $from = liveState.selection.$from;
      const isEmpty = liveState.selection.empty;
      const inBlank =
        isEmpty &&
        $from.depth >= 1 &&
        $from.parent.isTextblock &&
        $from.parent.content.size === 0;
      // If the cursor sits at the very start / end of a non-empty
      // textblock, insert at that block's TOP-LEVEL boundary
      // instead of at the cursor position. Otherwise PM has to
      // split the surrounding block to fit a block-level slice,
      // which produces an empty heading sibling above (start case)
      // or below (end case) — matches the bug "the lines added
      // above and below are the same heading level as my cursor's
      // block." Inserting at the doc-level boundary cleanly drops
      // the slice as a sibling without disturbing the cursor's
      // block's structure.
      const atStartOfBlock =
        isEmpty &&
        $from.depth >= 1 &&
        $from.parent.isTextblock &&
        $from.parent.content.size > 0 &&
        $from.parentOffset === 0;
      const atEndOfBlock =
        isEmpty &&
        $from.depth >= 1 &&
        $from.parent.isTextblock &&
        $from.parent.content.size > 0 &&
        $from.parentOffset === $from.parent.content.size;
      if (inBlank) {
        liveFrom = $from.before($from.depth);
        liveTo = $from.after($from.depth);
      } else if (atStartOfBlock) {
        liveFrom = liveTo = $from.before(1);
      } else if (atEndOfBlock) {
        liveFrom = liveTo = $from.after(1);
      } else {
        liveFrom = liveState.selection.from;
        liveTo = liveState.selection.from;
      }
    }
    const rewritten = rewriteHeadingIds(slice);
    let tr = liveState.tr;
    tr.replaceRange(liveFrom, liveTo, rewritten);
    const sliceEndPos = tr.mapping.map(liveTo);
    const trailer = schema.nodes['paragraph']!.create();
    tr.insert(sliceEndPos, trailer);
    tr.setSelection(TextSelection.create(tr.doc, sliceEndPos + 1));
    tr = closeHistory(tr);
    tr.setMeta('addToHistory', true);

    speechView.dispatch(tr.scrollIntoView());
    speechView.focus();
    // Fire destination-side hook (e.g., nav-panel collapse refresh)
    // BEFORE the sender's afterInsert so the dest's nav is in its
    // final state when the sender (in same-window cases) does any
    // focus-followup work.
    const resolver = getSpeechDocResolver();
    const destUid = resolver.uidForView(speechView);
    if (destUid) resolver.notifySliceLanded(destUid);
    afterInsert?.(speechView);
  }, 0);
}

/** Main entry point. Reads the speech-doc resolver, computes the
 *  slice, and routes — either dispatching locally if the speech doc
 *  lives in this renderer, or serializing + IPCing via the host
 *  bridge if the speech doc lives in another window. */
export function sendToSpeech(
  sourceView: EditorView,
  atEnd: boolean,
  afterInsert?: AfterInsertHook,
): void {
  const resolver = getSpeechDocResolver();
  const speechUid = resolver.getSpeechUid();
  if (!speechUid) {
    window.alert(
      'No speech document yet. Use "New speech document" to create one or "Mark active doc as speech" to designate an existing pane.',
    );
    return;
  }
  const slice = resolveSendSlice(sourceView);
  if (!slice) return;

  const localView = resolver.viewForUid(speechUid);
  if (localView) {
    // Same-window path. No-op if the user is sending FROM the speech
    // doc itself — Verbatim inserts a `~ Marked HH:MM ~` card-marker
    // there which we agreed to skip until the schema gains a
    // font_color mark.
    if (sourceView === localView) return;
    insertSpeechSlice(localView, slice, atEnd, afterInsert);
    return;
  }

  // Speech doc lives in another window. Serialize and route via main.
  const electron = getElectronHost();
  if (!electron) {
    // Shouldn't happen — a uid that resolves to no view AND no
    // Electron host means an orphaned cross-window designation in a
    // non-Electron context, which is impossible by construction.
    // Log + bail.
    console.warn(
      'sendToSpeech: speech uid is set but neither a local view nor an Electron host can resolve it.',
    );
    return;
  }
  const sliceJson = slice.toJSON();
  void electron.speechSendSlice({ sliceJson, atEnd }).then((result) => {
    if (result.delivered) return;
    if (result.reason === 'speech-window-gone') {
      // Stale designation — main already cleared it. The local
      // resolver will pick up the change via the `speech:changed`
      // broadcast. Surface a brief notice so the user understands
      // why nothing landed.
      window.alert("The speech document's window has closed.");
    } else if (result.reason === 'same-window') {
      // Shouldn't trigger in practice — we check locally above —
      // but main has the same guard. Silent.
    } else if (result.reason === 'no-speech-doc') {
      // Race: speech designation was cleared between our resolver
      // read and main's dispatch. Local broadcast will resync.
    } else {
      console.warn('Cross-window send-to-speech failed:', result.reason);
    }
  });
}

/** Install the receive-side handler. Listens for incoming slices
 *  from main, resolves the target uid to a local view, and applies
 *  the slice via `insertSpeechSlice`. Called once at boot from
 *  whichever editor surface is alive (single-doc and multi-pane both
 *  install it; the resolver's view map filters incoming slices to
 *  whichever doc actually lives in this renderer). */
export function installIncomingSpeechSliceHandler(): void {
  const electron = getElectronHost();
  if (!electron) return;
  electron.onIncomingSpeechSlice(({ uid, sliceJson, atEnd }) => {
    const resolver = getSpeechDocResolver();
    const view = resolver.viewForUid(uid);
    if (!view) {
      console.warn('Incoming speech slice for unregistered uid', uid);
      return;
    }
    let slice: Slice;
    try {
      slice = Slice.fromJSON(
        schema,
        sliceJson as Parameters<typeof Slice.fromJSON>[1],
      );
    } catch (err) {
      console.error('Failed to deserialize incoming speech slice:', err);
      return;
    }
    insertSpeechSlice(view, slice, atEnd);
  });
}
