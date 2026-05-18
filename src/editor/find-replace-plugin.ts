/**
 * Find / Replace — search across the doc's plain text, highlight every
 * hit with a yellow band decoration, and let the caller step through
 * matches, replace the current one, or replace all.
 *
 * State the plugin owns:
 *   - `query`, `caseSensitive`, `wholeWord` — the active search
 *     parameters. Empty query == "search inactive" == no matches.
 *   - `matches` — doc-position ranges of every hit in the current
 *     doc.
 *   - `currentIndex` — index into `matches` of the "active" match
 *     (the one navigation lands on, the one Replace acts on). -1
 *     when no matches.
 *
 * Meta actions (set via `tr.setMeta(findReplaceKey, {...})`):
 *   - `{ type: 'setQuery', query, caseSensitive, wholeWord }` — set
 *     the search parameters and rescan. `currentIndex` resets to 0
 *     when there are matches, -1 otherwise.
 *   - `{ type: 'navigate', dir: 1 | -1 }` — bump `currentIndex` in
 *     the given direction, wrapping around the ends.
 *   - `{ type: 'setCurrentIndex', index }` — set the active index
 *     explicitly (used by Replace after a replacement is dispatched
 *     so the next match becomes active without a separate navigate).
 *   - `{ type: 'clear' }` — reset to inactive state.
 *
 * Doc changes (transactions where `tr.docChanged`) trigger a rescan
 * iff the query is non-empty. `currentIndex` is clamped to the new
 * `matches.length` so the active hit never points past the end.
 *
 * Replace logic lives in the `runReplace` / `runReplaceAll` Commands
 * exported below — the plugin only owns query state and decorations;
 * the actual text edit is a separate transaction the caller dispatches.
 */

import {
  Plugin,
  PluginKey,
  TextSelection,
  type Command,
  type EditorState,
} from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

export interface FindMatch {
  from: number;
  to: number;
}

export interface FindReplaceState {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  matches: FindMatch[];
  currentIndex: number;
}

type Meta =
  | { type: 'setQuery'; query: string; caseSensitive: boolean; wholeWord: boolean }
  | { type: 'navigate'; dir: 1 | -1 }
  | { type: 'setCurrentIndex'; index: number }
  | { type: 'clear' };

export const findReplaceKey = new PluginKey<FindReplaceState>('find-replace');

/** Word-boundary check used by the whole-word toggle. We treat any
 *  ASCII alphanumeric or `_` as a "word" character (matches `\w` in
 *  the standard regex flavor); everything else is a boundary. */
function isWordChar(ch: string): boolean {
  if (ch.length === 0) return false;
  const c = ch.charCodeAt(0);
  return (
    (c >= 0x30 && c <= 0x39) || // 0-9
    (c >= 0x41 && c <= 0x5a) || // A-Z
    (c >= 0x61 && c <= 0x7a) || // a-z
    c === 0x5f                  // _
  );
}

/** Scan the doc for every hit of `query`. Walks the plain
 *  `textBetween` representation of each textblock — matches that
 *  span textblock boundaries are intentionally not supported (Word
 *  + VS Code behave the same way for paragraph-spanning text). */
function findMatches(
  state: EditorState,
  query: string,
  caseSensitive: boolean,
  wholeWord: boolean,
): FindMatch[] {
  if (!query) return [];
  const out: FindMatch[] = [];
  const needleNorm = caseSensitive ? query : query.toLowerCase();
  state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const text = node.textContent;
    if (!text) return false;
    const hay = caseSensitive ? text : text.toLowerCase();
    let searchFrom = 0;
    while (searchFrom <= hay.length - needleNorm.length) {
      const idx = hay.indexOf(needleNorm, searchFrom);
      if (idx < 0) break;
      if (wholeWord) {
        const before = idx > 0 ? text[idx - 1]! : '';
        const after =
          idx + needleNorm.length < text.length
            ? text[idx + needleNorm.length]!
            : '';
        if (isWordChar(before) || isWordChar(after)) {
          searchFrom = idx + 1;
          continue;
        }
      }
      // `pos` is the position of the textblock node itself; `pos + 1`
      // is the start of its inline content. `idx` is a character
      // offset inside `textContent` — which for plain text-only
      // textblocks equals the inline character offset.
      out.push({ from: pos + 1 + idx, to: pos + 1 + idx + needleNorm.length });
      searchFrom = idx + needleNorm.length;
    }
    // Don't descend into the textblock's inline content — we already
    // consumed its `textContent`.
    return false;
  });
  return out;
}

/** Recompute matches for the new doc when the query is non-empty.
 *  `currentIndex` is preserved if the current match still exists in
 *  the new match set (matched by from-position); otherwise it's
 *  clamped to the nearest valid index, or -1 if there are no
 *  matches. */
function rescanAfterDocChange(
  state: EditorState,
  prev: FindReplaceState,
): FindReplaceState {
  if (!prev.query) {
    return { ...prev, matches: [], currentIndex: -1 };
  }
  const matches = findMatches(state, prev.query, prev.caseSensitive, prev.wholeWord);
  if (matches.length === 0) return { ...prev, matches, currentIndex: -1 };
  // Try to keep the active index pointing at "the same match" by
  // looking up the previous match's from-position in the new list.
  let nextIndex = 0;
  if (prev.currentIndex >= 0 && prev.matches[prev.currentIndex]) {
    const prevFrom = prev.matches[prev.currentIndex]!.from;
    const found = matches.findIndex((m) => m.from === prevFrom);
    nextIndex = found >= 0 ? found : Math.min(prev.currentIndex, matches.length - 1);
  }
  return { ...prev, matches, currentIndex: nextIndex };
}

export function findReplacePlugin(): Plugin<FindReplaceState> {
  return new Plugin<FindReplaceState>({
    key: findReplaceKey,
    state: {
      init: (): FindReplaceState => ({
        query: '',
        caseSensitive: false,
        wholeWord: false,
        matches: [],
        currentIndex: -1,
      }),
      apply(tr, prev, _oldState, newState): FindReplaceState {
        const meta = tr.getMeta(findReplaceKey) as Meta | undefined;
        if (meta?.type === 'clear') {
          return {
            query: '',
            caseSensitive: prev.caseSensitive,
            wholeWord: prev.wholeWord,
            matches: [],
            currentIndex: -1,
          };
        }
        if (meta?.type === 'setQuery') {
          const matches = findMatches(
            newState,
            meta.query,
            meta.caseSensitive,
            meta.wholeWord,
          );
          return {
            query: meta.query,
            caseSensitive: meta.caseSensitive,
            wholeWord: meta.wholeWord,
            matches,
            currentIndex: matches.length > 0 ? 0 : -1,
          };
        }
        // Doc-change rescan runs BEFORE the rest of the meta dispatch
        // so navigate / setCurrentIndex operate on the up-to-date
        // match list. Without this, a transaction that both changes
        // the doc AND sets a meta (e.g., `runReplace`) would leave
        // `matches` stale.
        let next = prev;
        if (tr.docChanged && next.query) {
          next = rescanAfterDocChange(newState, next);
        }
        if (meta?.type === 'navigate') {
          if (next.matches.length === 0) return next;
          const n = next.matches.length;
          const cur = next.currentIndex < 0 ? 0 : next.currentIndex;
          const newIdx = (cur + meta.dir + n) % n;
          return { ...next, currentIndex: newIdx };
        }
        if (meta?.type === 'setCurrentIndex') {
          if (next.matches.length === 0) return next;
          const clamped = Math.max(
            0,
            Math.min(meta.index, next.matches.length - 1),
          );
          return { ...next, currentIndex: clamped };
        }
        return next;
      },
    },
    props: {
      decorations(state) {
        const s = findReplaceKey.getState(state);
        if (!s || s.matches.length === 0) return null;
        const decos: Decoration[] = [];
        for (let i = 0; i < s.matches.length; i++) {
          const m = s.matches[i]!;
          const className =
            i === s.currentIndex
              ? 'pmd-find-match pmd-find-match-current'
              : 'pmd-find-match';
          decos.push(Decoration.inline(m.from, m.to, { class: className }));
        }
        return DecorationSet.create(state.doc, decos);
      },
    },
  });
}

/** Replace the currently-active match with `replacement` and advance
 *  to the next match (so a "find → replace → find → replace" cadence
 *  works without re-pressing the navigate button between every
 *  pair). Returns false when there's no active match to replace. */
export function runReplace(replacement: string): Command {
  return (state, dispatch) => {
    const s = findReplaceKey.getState(state);
    if (!s) return false;
    if (s.currentIndex < 0 || !s.matches[s.currentIndex]) return false;
    if (!dispatch) return true;
    const match = s.matches[s.currentIndex]!;
    const tr = state.tr;
    if (replacement) {
      tr.insertText(replacement, match.from, match.to);
    } else {
      tr.delete(match.from, match.to);
    }
    // Hold the current index so the rescan-after-doc-change handler's
    // "match still at this from-position?" check picks the NEXT match
    // (the one just past the replaced range) as the new active hit.
    // Without this, replacement → currentIndex would jump back to 0.
    tr.setMeta(findReplaceKey, {
      type: 'setCurrentIndex',
      index: s.currentIndex,
    });
    dispatch(tr);
    return true;
  };
}

/** Replace every match in one pass. Iterates from the last match to
 *  the first so earlier replacements don't shift later positions. */
export function runReplaceAll(replacement: string): Command {
  return (state, dispatch) => {
    const s = findReplaceKey.getState(state);
    if (!s || s.matches.length === 0) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    for (let i = s.matches.length - 1; i >= 0; i--) {
      const m = s.matches[i]!;
      if (replacement) {
        tr.insertText(replacement, m.from, m.to);
      } else {
        tr.delete(m.from, m.to);
      }
    }
    dispatch(tr);
    return true;
  };
}

/** Move the editor selection (and viewport) to the currently-active
 *  match. Called by the UI on every navigate / open-bar action so
 *  the user can see what's about to be replaced.
 *
 *  Selection update happens via a transaction (so subsequent
 *  Replace knows which run is active). The actual scroll is an
 *  explicit DOM `scrollIntoView` on the element containing the
 *  match — PM's `tr.scrollIntoView()` only scrolls when the
 *  editor's view has focus, which it doesn't while the user is
 *  driving the floating find bar. The DOM-level call works
 *  regardless of focus and picks up the closest scrolling
 *  ancestor (window in single-doc, the pane container in
 *  multi-doc) automatically. */
export function scrollToCurrentMatch(view: import('prosemirror-view').EditorView): void {
  const s = findReplaceKey.getState(view.state);
  if (!s || s.currentIndex < 0 || !s.matches[s.currentIndex]) return;
  const m = s.matches[s.currentIndex]!;
  const tr = view.state.tr.setSelection(
    TextSelection.create(view.state.doc, m.from, m.to),
  );
  view.dispatch(tr);
  try {
    const domAtPos = view.domAtPos(m.from);
    let target: Element | null = domAtPos.node as Element | null;
    if (target && target.nodeType === Node.TEXT_NODE) {
      target = (target as unknown as Text).parentElement;
    }
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
  } catch {
    // domAtPos can throw if the position isn't materialized yet
    // (content-visibility: auto cards). Fall back to PM's path —
    // if the editor is focused, this scrolls; if not, the user
    // can navigate again once the placeholder materializes.
    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.create(view.state.doc, m.from, m.to))
        .scrollIntoView(),
    );
  }
}
