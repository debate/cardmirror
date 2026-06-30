// @vitest-environment jsdom

/**
 * Discontinuous selection — the data path the Ctrl/Cmd add-to-selection
 * interaction drives. `setManualShadowSelection` populates the shadow-selection
 * plugin's match ranges (merged, empty dropped) and collapses the cursor inside
 * the first, so `getOperatingRanges` returns those ranges with `fromShadow:true`
 * — which is exactly what the ~15 format commands (and the copy handler) consume.
 * The mouse/clipboard plumbing itself is exercised by hand in the dev build.
 */

import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  buildSimilarSelectionPlugin,
  setManualShadowSelection,
  setShadowPending,
  getOperatingRanges,
  similarSelectionKey,
} from '../../src/editor/similar-selection-plugin.js';

/** Doc-position where the first card_body's inline content starts. */
function bodyStart(doc: PMNode): number {
  let start = -1;
  doc.descendants((n, pos) => {
    if (start < 0 && n.type.name === 'card_body') start = pos + 1;
  });
  return start;
}

function makeView(): EditorView {
  const doc = schema.nodes['doc']!.create(null, [
    schema.nodes['card']!.create(null, [
      schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Tag')),
      schema.nodes['card_body']!.create(null, schema.text('alpha beta gamma delta')),
    ]),
  ]);
  const container = document.createElement('div');
  document.body.appendChild(container);
  return new EditorView(container, {
    state: EditorState.create({ doc, plugins: [buildSimilarSelectionPlugin()] }),
  });
}

describe('discontinuous (manual shadow) selection', () => {
  it('sets two non-adjacent ranges and exposes them via getOperatingRanges', () => {
    const view = makeView();
    const s = bodyStart(view.state.doc);
    // "alpha" and "gamma" — two non-adjacent words.
    setManualShadowSelection(view, [
      { from: s, to: s + 5 },
      { from: s + 11, to: s + 16 },
    ]);

    const ps = similarSelectionKey.getState(view.state)!;
    expect(ps.matches).toEqual([
      { from: s, to: s + 5 },
      { from: s + 11, to: s + 16 },
    ]);
    // Cursor collapsed inside the first match, so the shadow drives ops.
    expect(view.state.selection.empty).toBe(true);

    const op = getOperatingRanges(view.state);
    expect(op.fromShadow).toBe(true);
    expect(op.ranges).toEqual([
      { from: s, to: s + 5 },
      { from: s + 11, to: s + 16 },
    ]);
    view.destroy();
  });

  it('merges overlapping ranges and drops empty ones (so re-adding a word is idempotent)', () => {
    const view = makeView();
    const s = bodyStart(view.state.doc);
    setManualShadowSelection(view, [
      { from: s, to: s + 5 },
      { from: s + 3, to: s + 8 }, // overlaps the first → merge to [s, s+8]
      { from: s + 12, to: s + 12 }, // empty → dropped
    ]);
    const ps = similarSelectionKey.getState(view.state)!;
    expect(ps.matches).toEqual([{ from: s, to: s + 8 }]);
    view.destroy();
  });

  it('marks the manual selection with the selection look', () => {
    const view = makeView();
    const s = bodyStart(view.state.doc);
    setManualShadowSelection(view, [{ from: s, to: s + 5 }]);
    expect(similarSelectionKey.getState(view.state)!.style).toBe('selection');
    view.destroy();
  });

  it('setShadowPending shows a drag preview WITHOUT dismissing the existing ranges', () => {
    const view = makeView();
    const s = bodyStart(view.state.doc);
    setManualShadowSelection(view, [{ from: s, to: s + 5 }]);
    // Mid-drag preview elsewhere — the existing match must survive (the flicker fix).
    setShadowPending(view, { from: s + 11, to: s + 16 });
    const mid = similarSelectionKey.getState(view.state)!;
    expect(mid.matches).toEqual([{ from: s, to: s + 5 }]);
    expect(mid.pending).toEqual({ from: s + 11, to: s + 16 });
    // Release folds the pending in and clears it.
    setManualShadowSelection(view, [
      { from: s, to: s + 5 },
      { from: s + 11, to: s + 16 },
    ]);
    const after = similarSelectionKey.getState(view.state)!;
    expect(after.matches.length).toBe(2);
    expect(after.pending == null).toBe(true);
    view.destroy();
  });

  it('clears the shadow when given nothing selectable', () => {
    const view = makeView();
    const s = bodyStart(view.state.doc);
    setManualShadowSelection(view, [{ from: s, to: s + 5 }]);
    expect(similarSelectionKey.getState(view.state)!.matches.length).toBe(1);
    setManualShadowSelection(view, [{ from: s + 2, to: s + 2 }]); // all empty
    expect(similarSelectionKey.getState(view.state)!.matches.length).toBe(0);
    view.destroy();
  });
});
