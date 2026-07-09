// @vitest-environment jsdom
/**
 * The intra-doc window end-to-end in a real EditorView: it projects the source
 * section read-only, RE-RENDERS live when the source is edited (via the plugin's
 * decoration → NodeView.update), and Unlink/Delete behave.
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection, NodeSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { type Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { createSelfRefNode, isSelfRef } from '../../src/editor/self-transclusion.js';
import { selfRefNodeViews } from '../../src/editor/self-transclusion-nodeview.js';
import { makeSelfRefPlugin } from '../../src/editor/self-transclusion-plugin.js';
import {
  unlinkSelfRef,
  deleteSelfRef,
  insertSelfRef,
  jumpToSelfRefSource,
} from '../../src/editor/self-transclusion-commands.js';

const block = (text: string, id: string): PMNode => schema.nodes['block']!.create({ id }, schema.text(text));
function card(tag: string, body: string, id = newHeadingId()): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}

const SRC = 'src';
function makeView(): EditorView {
  const doc = schema.nodes['doc']!.create(null, [
    block('Source', SRC),
    card('A', 'alpha'),
    block('Elsewhere', 'oth'),
    createSelfRefNode(schema, SRC, '↳ Source'),
  ]);
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new EditorView(el, {
    state: EditorState.create({ doc, plugins: [makeSelfRefPlugin()] }),
    nodeViews: selfRefNodeViews,
  });
}

/** The projection renders inside a shadow root on `.pmd-self-ref-body` (so it's
 *  selection-opaque); read through it. Falls back to light DOM if no shadow. */
function projRoot(view: EditorView): ParentNode | null {
  const body = view.dom.querySelector('.pmd-self-ref-body') as HTMLElement | null;
  if (!body) return null;
  return (body.shadowRoot as ParentNode | null) ?? body;
}
function windowText(view: EditorView): string {
  return (projRoot(view) as unknown as { textContent?: string } | null)?.textContent ?? '';
}
function selfRefPos(view: EditorView): number {
  let pos = -1;
  view.state.doc.forEach((n, off) => {
    if (pos < 0 && isSelfRef(n)) pos = off;
  });
  return pos;
}
/** End of the first card_body's text (a spot inside the source section). */
function endOfSourceCard(view: EditorView): number {
  let end = -1;
  view.state.doc.descendants((n, pos) => {
    if (end < 0 && n.type.name === 'card_body') end = pos + 1 + n.content.size;
    return end < 0;
  });
  return end;
}

describe('self_ref window — live projection', () => {
  it('projects the source section read-only', () => {
    const view = makeView();
    expect(windowText(view)).toContain('alpha');
    const body = view.dom.querySelector('.pmd-self-ref-body') as HTMLElement;
    expect(body.getAttribute('contenteditable')).toBe('false'); // not editable through the window
    view.destroy();
  });

  it('re-renders when the source is edited', () => {
    const view = makeView();
    expect(windowText(view)).toContain('alpha');
    // Append " EDIT" to the end of the source card's body.
    const at = endOfSourceCard(view);
    view.dispatch(view.state.tr.insertText(' EDIT', at));
    expect(windowText(view)).toContain('alpha EDIT');
    view.destroy();
  });

  it('reflects a card added to the source section', () => {
    const view = makeView();
    // Insert a new card right before the "Elsewhere" block (end of Source section).
    let othPos = -1;
    view.state.doc.forEach((n, off) => {
      if (n.attrs?.['id'] === 'oth') othPos = off;
    });
    view.dispatch(view.state.tr.insert(othPos, card('B', 'bravo')));
    expect(windowText(view)).toContain('alpha');
    expect(windowText(view)).toContain('bravo');
    view.destroy();
  });

  it('shows a notice when the source heading is gone', () => {
    const view = makeView();
    // Delete the Source block heading (and only it).
    view.dispatch(view.state.tr.delete(0, block('Source', SRC).nodeSize));
    expect(windowText(view).toLowerCase()).toContain('not found');
    view.destroy();
  });

  it('the projection carries NO data-id (no duplicate ids vs the source)', () => {
    const view = makeView();
    // The window renders real card DOM, but its data-id attrs are stripped so
    // [data-id="X"] scroll lookups target the real source, not this copy.
    expect(projRoot(view)!.querySelectorAll('[data-id]').length).toBe(0);
    // The real source card still has its data-id.
    expect(view.dom.querySelectorAll('[data-id]').length).toBeGreaterThan(0);
    view.destroy();
  });

  it('Go to source jumps to the real source heading, not the window', () => {
    const view = makeView();
    // Park the cursor away from the source first.
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
    jumpToSelfRefSource(view, SRC);
    // Selection landed inside the real "Source" block (at its start), which sits
    // before the window in the doc.
    const srcPos = 0; // "Source" block is the first node
    expect(view.state.selection.from).toBeLessThan(selfRefPos(view));
    expect(view.state.selection.from).toBeGreaterThanOrEqual(srcPos);
    expect(view.state.doc.resolve(view.state.selection.from).parent.textContent).toBe('Source');
    view.destroy();
  });
});

describe('self_ref window — actions', () => {
  it('Unlink freezes the current projection into real editable cards', () => {
    const view = makeView();
    unlinkSelfRef(view, selfRefPos(view));
    // No more self_ref; the source content now exists as a real card after Elsewhere.
    expect(selfRefPos(view)).toBe(-1);
    const bodies: string[] = [];
    view.state.doc.descendants((n) => {
      if (n.type.name === 'card_body') bodies.push(n.textContent);
      return true;
    });
    // Source's own 'alpha' + the unlinked copy 'alpha'.
    expect(bodies.filter((b) => b === 'alpha')).toHaveLength(2);
    view.destroy();
  });

  it('Delete removes the window', () => {
    const view = makeView();
    deleteSelfRef(view, selfRefPos(view));
    expect(selfRefPos(view)).toBe(-1);
    // The source section is untouched.
    let alpha = 0;
    view.state.doc.descendants((n) => {
      if (n.type.name === 'card_body' && n.textContent === 'alpha') alpha++;
      return true;
    });
    expect(alpha).toBe(1);
    view.destroy();
  });

  it('insertSelfRef drops a live window at the cursor', () => {
    // A doc with a source section but no window yet.
    const doc = schema.nodes['doc']!.create(null, [
      block('Source', SRC),
      card('A', 'alpha'),
      block('Here', 'here'),
    ]);
    const el = document.createElement('div');
    document.body.appendChild(el);
    const view = new EditorView(el, {
      state: EditorState.create({ doc, plugins: [makeSelfRefPlugin()] }),
      nodeViews: selfRefNodeViews,
    });
    // Cursor at the end (inside/after "Here"), then insert a window onto Source.
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
    expect(insertSelfRef(view, SRC)).toBe(true);
    expect(selfRefPos(view)).toBeGreaterThanOrEqual(0);
    expect(windowText(view)).toContain('alpha');
    view.destroy();
  });
});

describe('self_ref window — a spanning selection highlights the view (send-to-speech)', () => {
  // A doc where the view sits BETWEEN two cards, so a TextSelection can span it.
  function mid(): EditorView {
    const doc = schema.nodes['doc']!.create(null, [
      block('Source', SRC),
      card('S', 'src-body'),
      block('Mid', 'mid'),
      card('Above', 'above'),
      createSelfRefNode(schema, SRC, '↳ Source'),
      card('Below', 'below'),
    ]);
    const el = document.createElement('div');
    document.body.appendChild(el);
    return new EditorView(el, {
      state: EditorState.create({ doc, plugins: [makeSelfRefPlugin()] }),
      nodeViews: selfRefNodeViews,
    });
  }
  const viewDom = (v: EditorView) => v.dom.querySelector('.pmd-self-ref') as HTMLElement;

  it('adds the in-selection class when a TextSelection spans the view', () => {
    const view = mid();
    const sp = selfRefPos(view);
    const node = view.state.doc.nodeAt(sp)!;
    // Empty selection → not marked.
    expect(viewDom(view).classList.contains('pmd-self-ref-in-selection')).toBe(false);
    // Span from a card above to a card below (crossing the view).
    view.dispatch(
      view.state.tr.setSelection(TextSelection.between(view.state.doc.resolve(sp - 4), view.state.doc.resolve(sp + node.nodeSize + 4))),
    );
    // The PM selection actually covers the view…
    expect(view.state.selection.from).toBeLessThanOrEqual(sp);
    expect(view.state.selection.to).toBeGreaterThanOrEqual(sp + node.nodeSize);
    // …and the view is marked selected for CSS.
    expect(viewDom(view).classList.contains('pmd-self-ref-in-selection')).toBe(true);
    view.destroy();
  });

  it('does NOT rebuild the projection DOM on a selection-only change (no drag disruption)', () => {
    const view = mid();
    const firstCard = projRoot(view)!.querySelector('.pmd-card') as HTMLElement;
    expect(firstCard).toBeTruthy();
    const sp = selfRefPos(view);
    const node = view.state.doc.nodeAt(sp)!;
    view.dispatch(
      view.state.tr.setSelection(TextSelection.between(view.state.doc.resolve(sp - 4), view.state.doc.resolve(sp + node.nodeSize + 4))),
    );
    // Same DOM element — the render guard skipped the rebuild (the projection is
    // unchanged), so a live drag-selection over the view isn't collapsed.
    expect(projRoot(view)!.querySelector('.pmd-card')).toBe(firstCard);
    view.destroy();
  });
});


describe('self_ref window — click selects the whole node (but stays span-selectable)', () => {
  function clickOn(view: EditorView, mods: Partial<MouseEvent> = {}): unknown {
    const pos = selfRefPos(view);
    const node = view.state.doc.nodeAt(pos)!;
    const event = { shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, button: 0, ...mods } as MouseEvent;
    return view.someProp('handleClickOn', (fn) => fn(view, pos + 1, node, pos, event, true));
  }

  it('a plain click node-selects the whole live view', () => {
    const view = makeView();
    expect(clickOn(view)).toBe(true);
    const sel = view.state.selection;
    expect(sel instanceof NodeSelection && isSelfRef(sel.node)).toBe(true);
    expect(sel.from).toBe(selfRefPos(view));
    view.destroy();
  });

  it('a SHIFT-click is left to native handling (so a selection can extend to span the view)', () => {
    const view = makeView();
    // Park a text selection first, then shift-click the view.
    view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)));
    expect(clickOn(view, { shiftKey: true })).not.toBe(true);
    // The plugin didn't force a node-selection.
    expect(view.state.selection instanceof NodeSelection).toBe(false);
    view.destroy();
  });

  it('ignores clicks that are not on a live view', () => {
    const view = makeView();
    const cardNode = view.state.doc.child(1); // the "A" card, not a self_ref
    const handled = view.someProp('handleClickOn', (fn) =>
      fn(view, 3, cardNode, view.state.doc.child(0).nodeSize, { button: 0 } as MouseEvent, true),
    );
    expect(handled).not.toBe(true);
    view.destroy();
  });
});
