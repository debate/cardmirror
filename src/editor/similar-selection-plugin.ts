/**
 * Similar-selection plugin — a "shadow selection" the user can light
 * up via the Select Similar commands. Holds:
 *
 *   - `matches`: doc-position ranges that share the fingerprint of
 *     the run the cursor was on when the command ran. Rendered with
 *     `.pmd-similar-match` (dashed outline).
 *   - `scope`: an outer range (used by the scoped flow) the matching
 *     is restricted to. Rendered with `.pmd-similar-scope` (faint
 *     background tint).
 *   - `mode`: `'idle'` or `'awaiting-cursor'`. The scoped flow enters
 *     `awaiting-cursor` after the scope is set; the next collapsed-
 *     selection transaction inside the scope triggers matching.
 *
 * The fingerprint is (parent textblock type name, full mark set of
 * the text node the cursor is on). A run matches iff parent block
 * type is identical AND the mark sets are equal (same Mark types,
 * same attrs). A plain run with no marks matches only other plain
 * runs of the same parent type — so cursor-on-card_body-with-no-
 * direct-formatting selects all such body runs, not every card_body
 * in the doc.
 *
 * Dismissal: any doc change clears everything. Selection-change
 * clears unless the new collapsed cursor lands inside a match (which
 * is what happens after the command's own dispatch, so it doesn't
 * dissipate itself). Escape clears via `handleKeyDown`.
 *
 * No format command consumes the shadow selection yet — first cut
 * is pure decoration. See DECISIONS for the deferred work.
 */

import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Command,
} from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as PMNode, Mark } from 'prosemirror-model';
import { showToast } from './toast.js';

export interface RangePair {
  from: number;
  to: number;
}

export interface SimilarSelectionState {
  matches: RangePair[];
  scope: RangePair | null;
  mode: 'idle' | 'awaiting-cursor';
}

const META_KEY = 'pmd-similar-selection';

/** Transaction meta flag a format command can set when it's applying
 *  marks ACROSS the shadow selection. The plugin's apply respects
 *  this flag: a doc-changing transaction with the flag preserves the
 *  shadow state (so the user can chain bold → italic → font color
 *  without the matches dissipating); without it, doc edits dismiss
 *  the shadow as usual. */
export const META_OPERATING_ON_SHADOW = 'pmd-shadow-op';

type Meta =
  | { type: 'setMatches'; matches: RangePair[] }
  | { type: 'setScope'; scope: RangePair }
  | { type: 'clear' };

export const similarSelectionKey = new PluginKey<SimilarSelectionState>(
  'similar-selection',
);

/**
 * Build the plugin. The factory takes the chip's effective-pt
 * resolver so the matching the plugin does internally (scoped
 * flow's `awaiting-cursor` → trigger transition) uses the same
 * size logic the standalone commands use. Defaulting the param to
 * a "raw font_size mark only" resolver keeps simple test cases
 * easy to construct.
 */
export function buildSimilarSelectionPlugin(
  effectivePt: EffectivePtResolver = defaultEffectivePt,
): Plugin<SimilarSelectionState> {
  return new Plugin<SimilarSelectionState>({
    key: similarSelectionKey,
    state: {
      init: () => ({ matches: [], scope: null, mode: 'idle' }),
      apply(tr, prev): SimilarSelectionState {
        const meta = tr.getMeta(META_KEY) as Meta | undefined;

        if (meta?.type === 'clear') {
          return { matches: [], scope: null, mode: 'idle' };
        }
        if (meta?.type === 'setScope') {
          return { matches: [], scope: meta.scope, mode: 'awaiting-cursor' };
        }
        if (meta?.type === 'setMatches') {
          return { matches: meta.matches, scope: null, mode: 'idle' };
        }

        // Any doc edit dissipates the shadow selection — UNLESS the
        // transaction is a format command operating ON the shadow,
        // marked with `META_OPERATING_ON_SHADOW`. That lets the user
        // chain bold → italic → font color etc. without losing the
        // match highlighting between each.
        if (tr.docChanged && !tr.getMeta(META_OPERATING_ON_SHADOW)) {
          if (prev.matches.length > 0 || prev.scope) {
            return { matches: [], scope: null, mode: 'idle' };
          }
          return prev;
        }

        if (tr.selectionSet) {
          // Scoped flow: the next collapsed-cursor inside the scope
          // triggers matching. A cursor outside cancels.
          if (prev.mode === 'awaiting-cursor' && prev.scope) {
            const sel = tr.selection;
            if (sel.empty) {
              const pos = sel.from;
              if (pos < prev.scope.from || pos > prev.scope.to) {
                return { matches: [], scope: null, mode: 'idle' };
              }
              const matches = computeSimilarMatches(
                tr.doc,
                pos,
                prev.scope,
                effectivePt,
              );
              return { matches, scope: prev.scope, mode: 'idle' };
            }
            // User may still be reshaping their scope-internal selection.
            return prev;
          }

          // Matches were active and selection moved: clear unless the
          // new cursor landed inside an existing match. (The command's
          // own setMatches tr is handled above via meta and won't reach
          // this branch.)
          if (prev.matches.length > 0) {
            const sel = tr.selection;
            const insideMatch =
              sel.empty &&
              prev.matches.some((m) => sel.from >= m.from && sel.from <= m.to);
            if (!insideMatch) {
              return { matches: [], scope: null, mode: 'idle' };
            }
          }
        }

        return prev;
      },
    },
    props: {
      decorations(state) {
        const ps = similarSelectionKey.getState(state);
        if (!ps) return null;
        const decs: Decoration[] = [];
        if (ps.scope) {
          decs.push(
            Decoration.inline(ps.scope.from, ps.scope.to, {
              class: 'pmd-similar-scope',
            }),
          );
        }
        for (const m of ps.matches) {
          decs.push(
            Decoration.inline(m.from, m.to, { class: 'pmd-similar-match' }),
          );
        }
        if (decs.length === 0) return null;
        return DecorationSet.create(state.doc, decs);
      },
      handleKeyDown(view, e) {
        if (e.key !== 'Escape') return false;
        const ps = similarSelectionKey.getState(view.state);
        if (!ps) return false;
        if (
          ps.matches.length === 0 &&
          !ps.scope &&
          ps.mode === 'idle'
        ) {
          return false;
        }
        view.dispatch(view.state.tr.setMeta(META_KEY, { type: 'clear' }));
        return true;
      },
    },
  });
}

/** Naive fallback: reads `font_size` marks; falls through to 11. */
function defaultEffectivePt(node: PMNode | null, _parent: PMNode): number {
  if (!node || !node.isText) return 11;
  const fs = node.marks.find((m) => m.type.name === 'font_size');
  if (fs) return Number(fs.attrs['halfPoints'] ?? 22) / 2;
  return 11;
}

/** Resolver for a run's effective font-size in pt. Same shape as
 *  `RibbonContext.effectivePtForNode` — the real editor passes the
 *  chip resolver here so two runs with the *same visual* size match
 *  even when one has an explicit `font_size` mark and the other
 *  inherits from its named-style or paragraph default. */
export type EffectivePtResolver = (
  node: PMNode | null,
  parent: PMNode,
) => number;

/** Marks of the text node "at" `pos`, the parent block type, AND the
 *  chip-resolved effective font-size. Preference order for the node:
 *  the run immediately before the cursor (Word's typing-continues-
 *  previous-run convention), then the run after. Returns null when
 *  there's no surrounding text. */
function fingerprintAt(
  doc: PMNode,
  pos: number,
  effectivePt: EffectivePtResolver,
): {
  parentTypeName: string;
  marks: readonly Mark[];
  effectivePt: number;
} | null {
  const $pos = doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.isTextblock) return null;
  const before = $pos.nodeBefore;
  const after = $pos.nodeAfter;
  const node =
    before && before.isText
      ? before
      : after && after.isText
      ? after
      : null;
  if (!node) return null;
  return {
    parentTypeName: parent.type.name,
    // Drop `font_size` from the comparable mark set — the effective
    // pt below covers it. Otherwise an explicit `font_size: 22` run
    // wouldn't match a bare run inheriting 11 from its named style
    // even when both display at 11 in the chip.
    marks: stripFontSize(node.marks),
    effectivePt: effectivePt(node, parent),
  };
}

function stripFontSize(marks: readonly Mark[]): readonly Mark[] {
  if (marks.length === 0) return marks;
  let any = false;
  for (const m of marks) {
    if (m.type.name === 'font_size') {
      any = true;
      break;
    }
  }
  if (!any) return marks;
  return marks.filter((m) => m.type.name !== 'font_size');
}

function marksEqual(a: readonly Mark[], b: readonly Mark[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!a[i]!.eq(b[i]!)) return false;
  }
  return true;
}

/** Walk `doc` (or just the `scope` range, if given) and return every
 *  text-node range whose fingerprint matches the one at `cursorPos`.
 *  The `effectivePt` resolver should be the chip's — so two runs with
 *  the same visible font-size match even when one has an explicit
 *  `font_size` mark and the other doesn't. */
export function computeSimilarMatches(
  doc: PMNode,
  cursorPos: number,
  scope: RangePair | null,
  effectivePt: EffectivePtResolver,
): RangePair[] {
  const fp = fingerprintAt(doc, cursorPos, effectivePt);
  if (!fp) return [];
  const from = scope?.from ?? 0;
  const to = scope?.to ?? doc.content.size;
  const out: RangePair[] = [];
  doc.nodesBetween(from, to, (node, pos, parent) => {
    if (!node.isText) return true;
    if (!parent || parent.type.name !== fp.parentTypeName) return true;
    if (!marksEqual(stripFontSize(node.marks), fp.marks)) return true;
    if (effectivePt(node, parent) !== fp.effectivePt) return true;
    const start = Math.max(from, pos);
    const end = Math.min(to, pos + node.nodeSize);
    if (start < end) out.push({ from: start, to: end });
    return true;
  });
  return out;
}

/**
 * Unified Select Similar Formatting (Doc menu). Branches on the PM
 * selection state:
 *
 *   - **No selection (collapsed cursor):** unscoped flow. Compute
 *     matches across the whole doc using the cursor's fingerprint
 *     and light them up.
 *   - **Non-empty selection:** scoped flow. The selection becomes
 *     the scope; the PM selection is then collapsed (so the scope
 *     tint isn't hidden under the browser's selection highlight),
 *     the plugin enters `awaiting-cursor` mode, and a toast nudges
 *     the user to click inside the scope to pick a sample. The
 *     next collapsed-cursor transaction inside the scope triggers
 *     matching (handled in the plugin's apply); a cursor outside
 *     cancels.
 *   - **Re-invocation while in `awaiting-cursor` mode:** toggle
 *     off — clear the scope, return to idle. Matches the Escape
 *     semantic so the binding doubles as a cancel.
 */
export function selectSimilar(effectivePt: EffectivePtResolver): Command {
  return (state, dispatch) => {
    const ps = similarSelectionKey.getState(state);

    // Toggle-off when already waiting for a click inside the scope.
    if (ps?.mode === 'awaiting-cursor') {
      if (!dispatch) return true;
      dispatch(state.tr.setMeta(META_KEY, { type: 'clear' } as Meta));
      return true;
    }

    const { from, to, empty } = state.selection;

    if (empty) {
      // Unscoped: match doc-wide using the cursor's fingerprint.
      const matches = computeSimilarMatches(
        state.doc,
        from,
        null,
        effectivePt,
      );
      if (matches.length === 0) return false;
      if (!dispatch) return true;
      dispatch(
        state.tr.setMeta(META_KEY, { type: 'setMatches', matches } as Meta),
      );
      return true;
    }

    // Scoped: set the selection range as scope, COLLAPSE the PM
    // selection at its leading edge (so the orange tint isn't
    // hidden under the browser's selection highlight), and nudge
    // the user with a toast.
    if (!dispatch) return true;
    const tr = state.tr
      .setMeta(META_KEY, { type: 'setScope', scope: { from, to } } as Meta)
      .setSelection(TextSelection.create(state.doc, from));
    dispatch(tr);
    showToast('Click in the highlighted area to select similar.');
    return true;
  };
}

/** Programmatically clear the shadow selection. Exposed so the
 *  keybinding editor / menu can offer a "Clear similar selection"
 *  action if desired later. */
export function clearSimilarSelection(): Command {
  return (state, dispatch) => {
    const ps = similarSelectionKey.getState(state);
    if (!ps) return false;
    if (ps.matches.length === 0 && !ps.scope && ps.mode === 'idle') {
      return false;
    }
    if (!dispatch) return true;
    dispatch(state.tr.setMeta(META_KEY, { type: 'clear' } as Meta));
    return true;
  };
}

/** Snapshot accessor for tests / UI introspection. */
export function getSimilarSelectionState(
  state: EditorState,
): SimilarSelectionState {
  return (
    similarSelectionKey.getState(state) ?? {
      matches: [],
      scope: null,
      mode: 'idle',
    }
  );
}

/**
 * What text ranges should a format command actually operate on?
 *
 *   - If the PM selection is non-empty → that selection range. The
 *     user's explicit selection wins.
 *   - Else if the shadow selection has matches → those match ranges
 *     (`fromShadow: true`). Format commands should also set
 *     `META_OPERATING_ON_SHADOW` on their tr so the plugin keeps
 *     the matches alive for chained edits.
 *   - Otherwise → no ranges. The caller can decide whether to
 *     no-op or fall back to other behavior (e.g., commands that
 *     act on the cursor's current run regardless of selection).
 */
export function getOperatingRanges(
  state: EditorState,
): { ranges: RangePair[]; fromShadow: boolean } {
  const sel = state.selection;
  if (!sel.empty) {
    return { ranges: [{ from: sel.from, to: sel.to }], fromShadow: false };
  }
  const ps = similarSelectionKey.getState(state);
  if (ps && ps.matches.length > 0) {
    return { ranges: ps.matches.map((r) => ({ ...r })), fromShadow: true };
  }
  return { ranges: [], fromShadow: false };
}
