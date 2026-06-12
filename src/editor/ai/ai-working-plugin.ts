/**
 * AI-working highlight plugin.
 *
 * While an AI operation runs, the part of the document it's working on is
 * boxed in purple, mirroring the blue pickup box shown while dragging a
 * card out of the editor (`.pmd-editor-pickup-highlight`) but in the
 * "Thinking…" pill's accent — so it's obvious WHAT the AI is working on
 * even after the text selection clears. The box matches the operation's
 * SCOPE:
 *   - `container` — outline the enclosing card/unit (card cutting, where
 *     the whole card is the unit of work).
 *   - `selection` — mark exactly the range the user selected (cite
 *     repair, text/formatting repair, an image), so the box isn't
 *     misleadingly expanded to the whole card.
 *
 * View-only decoration: never a mark, never serialized. At most one is
 * active; `setAiWorking(view, range, scope)` sets it, `…(view, null)`
 * clears it.
 */

import { Plugin, PluginKey } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';

interface Range {
  from: number;
  to: number;
}
export type AiWorkingScope = 'container' | 'selection';

// undefined meta → map through the edit; null → clear; payload → set.
type Meta = { range: Range; scope: AiWorkingScope } | null;

const aiWorkingKey = new PluginKey<DecorationSet>('ai-working');

// Same containers the drag-pickup recognizes: the card/unit is the
// preferred target; the structural wrappers are a fallback.
const UNIT_TYPES = new Set(['card', 'analytic_unit']);
const WRAPPER_TYPES = new Set(['pocket', 'hat', 'block']);

/** The enclosing container node's [before, after] range for `from`,
 *  preferring the innermost card/unit, else a structural wrapper. */
function containerRange(doc: PMNode, range: Range): Range | null {
  const inside = Math.min(Math.max(range.from + 1, 0), doc.content.size);
  const $p = doc.resolve(inside);
  for (const types of [UNIT_TYPES, WRAPPER_TYPES]) {
    for (let d = $p.depth; d >= 1; d--) {
      if (types.has($p.node(d).type.name)) {
        return { from: $p.before(d), to: $p.after(d) };
      }
    }
  }
  return null;
}

function nodeOrInline(doc: PMNode, range: Range): Decoration | null {
  if (range.to <= range.from) return null;
  // A range that exactly wraps one non-text node (e.g. an image) → box
  // the node; anything else (a text selection) → tint just that text.
  try {
    const after = doc.resolve(range.from).nodeAfter;
    if (after && !after.isText && range.to === range.from + after.nodeSize) {
      return Decoration.node(range.from, range.to, { class: 'pmd-ai-working' });
    }
  } catch {
    /* fall through to inline */
  }
  return Decoration.inline(range.from, range.to, { class: 'pmd-ai-working-inline' });
}

function decorate(doc: PMNode, range: Range, scope: AiWorkingScope): DecorationSet {
  if (scope === 'container') {
    const box = containerRange(doc, range);
    if (box) {
      return DecorationSet.create(doc, [
        Decoration.node(box.from, box.to, { class: 'pmd-ai-working' }),
      ]);
    }
    // No enclosing container — fall back to marking the range itself.
  }
  const deco = nodeOrInline(doc, range);
  return deco ? DecorationSet.create(doc, [deco]) : DecorationSet.empty;
}

export const aiWorkingPlugin = new Plugin<DecorationSet>({
  key: aiWorkingKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set) {
      const meta = tr.getMeta(aiWorkingKey) as Meta | undefined;
      if (meta === undefined) return set.map(tr.mapping, tr.doc);
      if (meta === null) return DecorationSet.empty;
      return decorate(tr.doc, meta.range, meta.scope);
    },
  },
  props: {
    decorations(state) {
      return aiWorkingKey.getState(state);
    },
  },
});

/** Mark the part of the document the AI is working on (or clear with
 *  null). `scope` chooses the container box vs. just the selected range. */
export function setAiWorking(
  view: EditorView,
  range: Range | null,
  scope: AiWorkingScope = 'container',
): void {
  try {
    view.dispatch(view.state.tr.setMeta(aiWorkingKey, range ? { range, scope } : null));
  } catch {
    // View torn down — nothing to set.
  }
}
