// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { DOMSerializer, DOMParser as PMDOMParser, type Node as PMNode } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { buildPastePlugin } from '../../src/editor/paste-plugin.js';
import { freshHeadingIds, rewriteHeadingIds } from '../../src/editor/drag-controller.js';

/** A throwaway editor view — `transformPasted` reads `view.state` (selection) to
 *  decide whether a paste lands inside a live zone. */
function makeView(): EditorView {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const doc = schema.nodes['doc']!.createChecked(null, [schema.nodes['block']!.create({ id: newHeadingId() }, schema.text('Home'))]);
  return new EditorView(el, { state: EditorState.create({ doc }) });
}

function pocket(t: string) {
  return schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text(t));
}
function block(t: string) {
  return schema.nodes['block']!.create({ id: newHeadingId() }, schema.text(t));
}
function cardWith(t: string) {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(t)),
  ]);
}

/** Round-trip a fragment through copy (toDOM → HTML) and paste-parse
 *  (HTML → schema), the way PM's clipboard does. The parse drops
 *  `data-id`, so heading ids come back null. */
function copyPasteParse(...nodes: PMNode[]) {
  const doc = schema.nodes['doc']!.createChecked(null, nodes);
  const div = document.createElement('div');
  div.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(doc.content));
  return PMDOMParser.fromSchema(schema).parseSlice(div);
}

function idsByType(node: PMNode) {
  const out: Array<{ type: string; id: unknown }> = [];
  node.descendants((n) => {
    if (['pocket', 'hat', 'block', 'tag', 'analytic'].includes(n.type.name)) {
      out.push({ type: n.type.name, id: n.attrs['id'] });
    }
    return true;
  });
  return out;
}

/** Collect heading ids across a whole slice (wrap in a doc so the
 *  top-level heading nodes themselves are visited, not just descendants). */
function sliceIds(content: PMNode['content']) {
  return idsByType(schema.nodes['doc']!.createChecked(null, content));
}

const ctx = {
  condenseOnPaste: () => false,
  paragraphIntegrity: () => false,
  usePilcrows: () => false,
  smartPasteConversion: () => false,
  headingMode: () => 'strict' as const,
};

describe('paste heading ids', () => {
  it('clipboard parse drops ids to null (the bug precondition)', () => {
    const slice = copyPasteParse(pocket('P'), block('B'), cardWith('C'));
    for (const { id } of sliceIds(slice.content)) expect(id).toBeNull();
  });

  it('transformPasted stamps every pasted heading with a fresh non-null id', () => {
    const plugin = buildPastePlugin(ctx);
    const slice = plugin.props.transformPasted!.call(
      plugin,
      copyPasteParse(pocket('P'), block('B'), cardWith('C')),
      makeView(),
      false,
    );

    const entries = sliceIds(slice.content);
    expect(entries.map((e) => e.type)).toEqual(['pocket', 'block', 'tag']);
    for (const { id } of entries) {
      expect(typeof id).toBe('string');
      expect(id).not.toBe('');
    }
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length); // all unique
  });

  it('freshHeadingIds fills null ids; rewriteHeadingIds leaves them null', () => {
    const slice = copyPasteParse(pocket('P'));
    expect(slice.content.firstChild!.attrs['id']).toBeNull();
    // rewriteHeadingIds only touches existing non-null ids → still null.
    expect(rewriteHeadingIds(slice).content.firstChild!.attrs['id']).toBeNull();
    // freshHeadingIds fills it.
    expect(typeof freshHeadingIds(slice).content.firstChild!.attrs['id']).toBe('string');
  });

  it('freshHeadingIds preserves slice open depths and content', () => {
    const slice = copyPasteParse(pocket('Title'), cardWith('Card'));
    const fresh = freshHeadingIds(slice);
    expect(fresh.openStart).toBe(slice.openStart);
    expect(fresh.openEnd).toBe(slice.openEnd);
    expect(fresh.content.firstChild!.textContent).toBe('Title');
  });
});
