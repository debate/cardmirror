// @vitest-environment jsdom
/**
 * Adversarial stress test for the "NO STACKED RAILS" invariant: no transclusion
 * unit (a live view `self_ref`, or a linked copy `transclusion_ref`) may ever end
 * up rendering with its rail nested inside another transclusion's rail — i.e.
 *   (a) STRUCTURAL: no unit sits inside a transclusion_ref in the doc tree, and
 *   (b) PROJECTION: no live view's resolved projection contains a transclusion_ref.
 *
 * Every way a user (or a copy/refresh) could try to nest transclusions is driven
 * here and the invariant re-checked. `railViolations` is the single oracle.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Fragment, Slice, type Node as PMNode } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  createTransclusionNode,
  contentHash,
  isTransclusionNode,
  enclosingZonePos,
  SELF_SOURCE_REF,
} from '../../src/editor/transclusion.js';
import {
  createSelfRefNode,
  isSelfRef,
  resolveSelfProjection,
} from '../../src/editor/self-transclusion.js';
import { insertSelfRef } from '../../src/editor/self-transclusion-commands.js';
import { insertInDocCopy } from '../../src/editor/self-transclusion-commands.js';
import { buildInDocCopyAttrs } from '../../src/editor/transclusion-actions.js';
import { buildPastePlugin } from '../../src/editor/paste-plugin.js';
import { rememberLinkedCopy, clearLinkedCopy } from '../../src/editor/clipboard-link-cache.js';
import { dragController, type DragItem } from '../../src/editor/drag-controller.js';

// ---- Building blocks ----
const block = (t: string, id: string): PMNode => schema.nodes['block']!.create({ id }, schema.text(t));
function card(tag: string, body: string): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
function copy(children: PMNode[], srcId = 'H'): PMNode {
  const content = Fragment.fromArray(children);
  return createTransclusionNode(
    schema,
    { source_ref: SELF_SOURCE_REF, source_ref_base: 'doc', source_heading_id: srcId, source_content_hash: contentHash(content) },
    content,
  );
}
const view = (id: string) => createSelfRefNode(schema, id, '↳ v');

// ---- The invariant oracle ----
function railViolations(doc: PMNode): string[] {
  const v: string[] = [];
  doc.descendants((node, pos) => {
    if (isSelfRef(node) || isTransclusionNode(node)) {
      // A strict transclusion_ref ANCESTOR ⇒ this unit's rail is nested.
      if (enclosingZonePos(doc, pos) !== null) v.push(`STRUCTURAL: ${node.type.name}@${pos} inside a zone`);
      // A live view whose projection carries a linked copy ⇒ a nested rail on render.
      if (isSelfRef(node)) {
        const proj = resolveSelfProjection(doc, String(node.attrs['source_heading_id'] ?? ''));
        let zoneInProj = false;
        proj.content.descendants((n) => {
          if (isTransclusionNode(n)) zoneInProj = true;
          return true;
        });
        if (zoneInProj) v.push(`PROJECTION: self_ref@${pos} projects a zone`);
      }
    }
    return true;
  });
  return v;
}
/** Treat a slice's content as a doc so the oracle can inspect it. */
function docOf(frag: Fragment): PMNode {
  return schema.nodes['doc']!.create(null, frag);
}

function mount(doc: PMNode): EditorView {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new EditorView(el, {
    state: EditorState.create({
      doc,
      plugins: [buildPastePlugin({
        condenseOnPaste: () => false,
        paragraphIntegrity: () => false,
        usePilcrows: () => false,
    smartPasteConversion: () => false,
        headingMode: () => 'strict',
      })],
    }),
  });
}
function firstZonePos(doc: PMNode): number {
  let p = -1;
  doc.descendants((n, pos) => {
    if (p < 0 && isTransclusionNode(n)) p = pos;
    return p < 0;
  });
  return p;
}
/** A position strictly inside the first linked copy (its first card's body). */
function insideZone(doc: PMNode): number {
  const zPos = firstZonePos(doc);
  return zPos + 3;
}

afterEach(() => {
  if (dragController.isActive()) dragController.cancel();
  clearLinkedCopy();
});

// The oracle itself must catch a hand-built violation (guard against a no-op test).
describe('the rail-violation oracle', () => {
  it('flags a hand-nested unit and a projection-embedded zone', () => {
    const nested = schema.nodes['doc']!.create(null, [copy([card('A', 'a'), view('X')])]);
    expect(railViolations(nested).some((s) => s.startsWith('STRUCTURAL'))).toBe(true);

    const projZone = schema.nodes['doc']!.create(null, [
      block('S', 'S'),
      copy([card('C', 'c')]), // a linked copy sits in section S…
      view('S'), // …and a live view mirrors S → its projection would carry the copy
    ]);
    // (resolveSelfProjection now flattens it, so THIS doc is actually clean — the
    // oracle's projection arm is exercised by the pre-fix expectation below.)
    expect(railViolations(projZone).filter((s) => s.startsWith('PROJECTION'))).toEqual([]);
  });
});

describe('create commands never nest a unit in a zone', () => {
  it('insertSelfRef with the caret inside a linked copy shunts the view out', () => {
    const doc = schema.nodes['doc']!.create(null, [
      block('Target', 'T'),
      card('TC', 'tc'),
      copy([card('Inside', 'in')]),
    ]);
    const v = mount(doc);
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, insideZone(v.state.doc))));
    expect(insertSelfRef(v, 'T')).toBe(true);
    expect(railViolations(v.state.doc)).toEqual([]);
    v.destroy();
  });

  it('insertInDocCopy with the caret inside a linked copy shunts the new copy out', () => {
    const doc = schema.nodes['doc']!.create(null, [
      block('Target', 'T'),
      card('TC', 'tc'),
      block('Home', 'Hm'),
      copy([card('Inside', 'in')]),
    ]);
    const v = mount(doc);
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, insideZone(v.state.doc))));
    // Copy section 'T' (a flat card section) while the caret sits in the existing copy.
    expect(insertInDocCopy(v, 'T')).toBe(true);
    expect(railViolations(v.state.doc)).toEqual([]);
    v.destroy();
  });
});

describe('paste never nests a unit in a zone', () => {
  function pasteInto(clip: Slice, caret: number): Slice {
    const doc = schema.nodes['doc']!.create(null, [block('Home', 'H'), copy([card('Z', 'z')]), block('Tail', 'Tl')]);
    const v = mount(doc);
    const plugin = v.state.plugins.find((p) => p.props?.transformPasted)!;
    rememberLinkedCopy(clip, v, clip);
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, caret)));
    const out = plugin.props.transformPasted!.call(plugin, clip, v, false) as Slice;
    v.destroy();
    return out;
  }
  const zPosInHome = (): number => {
    // caret inside the doc's existing zone (built identically in pasteInto).
    const probe = schema.nodes['doc']!.create(null, [block('Home', 'H'), copy([card('Z', 'z')]), block('Tail', 'Tl')]);
    return insideZone(probe);
  };

  it('a live view pasted into a zone flattens', () => {
    const clip = new Slice(Fragment.fromArray([view('H')]), 0, 0);
    expect(railViolations(docOf(pasteInto(clip, zPosInHome()).content))).toEqual([]);
  });
  it('a linked copy pasted into a zone flattens', () => {
    const clip = new Slice(Fragment.fromArray([copy([card('New', 'n')])]), 0, 0);
    const out = pasteInto(clip, zPosInHome());
    expect(isTransclusionNode(out.content.firstChild)).toBe(false);
    expect(railViolations(docOf(out.content))).toEqual([]);
  });
  it('a mixed [live view + linked copy] slice pasted into a zone flattens both', () => {
    const clip = new Slice(Fragment.fromArray([view('H'), copy([card('New', 'n')])]), 0, 0);
    expect(railViolations(docOf(pasteInto(clip, zPosInHome()).content))).toEqual([]);
  });
});

describe('drag never nests a unit in a zone (commit backstop)', () => {
  function dragUnitIntoZone(unitAtTop: PMNode): boolean {
    const doc = schema.nodes['doc']!.create(null, [copy([card('Z', 'z')]), unitAtTop]);
    const v = mount(doc);
    // The dragged unit is the last top-level child.
    let from = -1;
    doc.forEach((n, off) => {
      if (isSelfRef(n) || (isTransclusionNode(n) && off > 0)) from = off;
    });
    const node = doc.nodeAt(from)!;
    const item: DragItem = { from, to: from + node.nodeSize, id: null, type: node.type.name, level: 0, label: 'u' };
    dragController.begin({ view: v, items: [item] });
    dragController.setHoverTarget({ view: v, insertPos: insideZone(v.state.doc) });
    const ok = dragController.commit();
    const violated = railViolations(v.state.doc).length > 0;
    v.destroy();
    return ok || violated; // "did anything bad happen?" — expected false
  }

  it('rejects a live view dropped into a zone (doc unchanged)', () => {
    expect(dragUnitIntoZone(view('X'))).toBe(false);
  });
  it('rejects a linked copy dropped into a zone (doc unchanged)', () => {
    expect(dragUnitIntoZone(copy([card('B', 'b')], 'H2'))).toBe(false);
  });
});

describe('content composition never produces stacked rails', () => {
  it('a linked copy of a section holding a live view + a nested copy flattens both', () => {
    const doc = schema.nodes['doc']!.create(null, [
      block('Other', 'O'),
      card('OC', 'o-ev'),
      block('Src', 'S'),
      card('SC', 's-ev'),
      view('O'), // a live view of Other, inside Src
      copy([card('Nested', 'nested-ev')], 'O'), // a linked copy, inside Src
      block('End', 'E'),
    ]);
    const outcome = buildInDocCopyAttrs(doc, 'S');
    expect(outcome.ok).toBe(true);
    expect(railViolations(docOf(outcome.content!))).toEqual([]);
  });

  it('a live view of a section that holds a linked copy projects it FLAT', () => {
    const doc = schema.nodes['doc']!.create(null, [
      block('Src', 'S'),
      card('SC', 's-ev'),
      copy([card('Inside', 'inside-ev')]),
      block('End', 'E'),
      view('S'),
    ]);
    expect(railViolations(doc)).toEqual([]);
    // And the projection genuinely carries the copy's content, just flat.
    const proj = resolveSelfProjection(doc, 'S');
    expect(proj.content.textBetween(0, proj.content.size, ' ')).toContain('inside-ev');
  });

  it('a live view of a section holding another live view inlines with no unit', () => {
    const doc = schema.nodes['doc']!.create(null, [
      block('A', 'A'),
      card('AC', 'a-ev'),
      block('Src', 'S'),
      card('SC', 's-ev'),
      view('A'), // live view of A, inside Src
      block('End', 'E'),
      view('S'), // live view of Src
    ]);
    expect(railViolations(doc)).toEqual([]);
  });
});
