/**
 * Verbatim ribbon structural-style hotkeys (F4–F7).
 */

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  setHeading,
  setTag,
  setAnalytic,
  buildRibbonKeymap,
  DEFAULT_RIBBON_KEYS,
  RIBBON_COMMAND_IDS,
} from '../../src/editor/ribbon-commands.js';

// ---- Doc builders ----

function paragraph(text: string) {
  return text
    ? schema.nodes['paragraph']!.create(null, schema.text(text))
    : schema.nodes['paragraph']!.create(null, []);
}

function pocket(text: string, id = newHeadingId()) {
  return schema.nodes['pocket']!.create({ id }, schema.text(text));
}

function hat(text: string, id = newHeadingId()) {
  return schema.nodes['hat']!.create({ id }, schema.text(text));
}

function block(text: string, id = newHeadingId()) {
  return schema.nodes['block']!.create({ id }, schema.text(text));
}

function tag(text: string, id = newHeadingId()) {
  return schema.nodes['tag']!.create({ id }, text ? schema.text(text) : []);
}

function cardWith(...children: ReturnType<typeof tag>[]) {
  return schema.nodes['card']!.createChecked(null, children);
}

function cardBody(text: string) {
  return schema.nodes['card_body']!.create(null, schema.text(text));
}

function citePara(text: string) {
  return schema.nodes['cite_paragraph']!.create(null, schema.text(text));
}

function undertag(text: string) {
  return schema.nodes['undertag']!.create(null, schema.text(text));
}

function analytic(text: string, id = newHeadingId()) {
  return schema.nodes['analytic']!.create({ id }, schema.text(text));
}

function analyticUnit(...children: ReturnType<typeof analytic>[]) {
  return schema.nodes['analytic_unit']!.createChecked(null, children);
}

function makeDoc(children: ReturnType<typeof tag>[]) {
  return schema.nodes['doc']!.createChecked(null, children);
}

function apply(state: EditorState, cmd: Command): EditorState | null {
  let next: EditorState | null = null;
  const ok = cmd(state, (tr) => { next = state.apply(tr); });
  return ok ? next : null;
}

function cursorIn(doc: ReturnType<typeof makeDoc>, findFn: (node: import('prosemirror-model').Node) => boolean, offsetInside = 0): EditorState {
  let pos = -1;
  doc.descendants((node, p) => {
    if (pos !== -1) return false;
    if (findFn(node)) {
      pos = p + 1 + offsetInside;
      return false;
    }
    return true;
  });
  if (pos < 0) throw new Error('cursor target not found');
  const state = EditorState.create({ doc });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}

// ---- Tests ----

describe('setHeading (F4/F5/F6)', () => {
  it('converts a doc-level paragraph to pocket', () => {
    const doc = makeDoc([paragraph('hello')]);
    const state = cursorIn(doc, (n) => n.type.name === 'paragraph');
    const next = apply(state, setHeading('pocket'));
    expect(next).not.toBeNull();
    expect(next!.doc.firstChild!.type.name).toBe('pocket');
    expect(next!.doc.firstChild!.textContent).toBe('hello');
    expect(typeof next!.doc.firstChild!.attrs['id']).toBe('string');
  });

  it('changes a pocket to a hat while preserving id', () => {
    const doc = makeDoc([pocket('hello', 'fixed-id')]);
    const state = cursorIn(doc, (n) => n.type.name === 'pocket');
    const next = apply(state, setHeading('hat'));
    expect(next!.doc.firstChild!.type.name).toBe('hat');
    expect(next!.doc.firstChild!.attrs['id']).toBe('fixed-id');
  });

  it('accepts a no-op when target type matches current', () => {
    const doc = makeDoc([pocket('hello', 'same-id')]);
    const state = cursorIn(doc, (n) => n.type.name === 'pocket');
    const next = apply(state, setHeading('pocket'));
    // Command returns true but doesn't dispatch (or dispatches a no-op).
    expect(next === null || next.doc.eq(doc)).toBe(true);
  });

  it('dissolves a card-with-only-tag to a single pocket', () => {
    const doc = makeDoc([cardWith(tag('hello', 'tag-id'))]);
    const state = cursorIn(doc, (n) => n.type.name === 'tag');
    const next = apply(state, setHeading('pocket'));
    expect(next).not.toBeNull();
    expect(next!.doc.childCount).toBe(1);
    expect(next!.doc.firstChild!.type.name).toBe('pocket');
    expect(next!.doc.firstChild!.attrs['id']).toBe('tag-id');
    expect(next!.doc.firstChild!.textContent).toBe('hello');
  });

  it('dissolves a card with body and cite — body and cite become loose paragraphs', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('TheTag', 'tag-id'),
        citePara('Source 2024'),
        cardBody('Body text.'),
      ]),
    ]);
    const state = cursorIn(doc, (n) => n.type.name === 'tag');
    const next = apply(state, setHeading('block'));
    expect(next).not.toBeNull();
    const children = next!.doc.content.content;
    expect(children.map((c) => c.type.name)).toEqual(['block', 'paragraph', 'paragraph']);
    expect(children[0]!.textContent).toBe('TheTag');
    expect(children[1]!.textContent).toBe('Source 2024');
    expect(children[2]!.textContent).toBe('Body text.');
    expect(children[0]!.attrs['id']).toBe('tag-id');
  });

  it('preserves undertag when dissolving a card', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('TheTag'),
        undertag('sub note'),
        cardBody('body'),
      ]),
    ]);
    const state = cursorIn(doc, (n) => n.type.name === 'tag');
    const next = apply(state, setHeading('hat'));
    expect(next).not.toBeNull();
    const types = next!.doc.content.content.map((c) => c.type.name);
    expect(types).toEqual(['hat', 'undertag', 'paragraph']);
  });

  it('dissolves an analytic_unit on an analytic cursor', () => {
    const doc = makeDoc([
      analyticUnit(analytic('Alpha', 'analytic-id')),
    ]);
    const state = cursorIn(doc, (n) => n.type.name === 'analytic');
    const next = apply(state, setHeading('pocket'));
    expect(next).not.toBeNull();
    expect(next!.doc.childCount).toBe(1);
    expect(next!.doc.firstChild!.type.name).toBe('pocket');
    expect(next!.doc.firstChild!.attrs['id']).toBe('analytic-id');
  });

});

describe('setTag (F7)', () => {
  it('wraps a doc-level paragraph as a card+tag', () => {
    const doc = makeDoc([paragraph('claim')]);
    const state = cursorIn(doc, (n) => n.type.name === 'paragraph');
    const next = apply(state, setTag());
    expect(next).not.toBeNull();
    expect(next!.doc.childCount).toBe(1);
    expect(next!.doc.firstChild!.type.name).toBe('card');
    expect(next!.doc.firstChild!.firstChild!.type.name).toBe('tag');
    expect(next!.doc.firstChild!.firstChild!.textContent).toBe('claim');
  });

  it('wraps a pocket as a card+tag preserving id', () => {
    const doc = makeDoc([pocket('claim', 'orig-id')]);
    const state = cursorIn(doc, (n) => n.type.name === 'pocket');
    const next = apply(state, setTag());
    expect(next).not.toBeNull();
    const tagNode = next!.doc.firstChild!.firstChild!;
    expect(tagNode.type.name).toBe('tag');
    expect(tagNode.attrs['id']).toBe('orig-id');
    expect(tagNode.textContent).toBe('claim');
  });

  it('accepts a no-op when cursor is already in a tag', () => {
    const doc = makeDoc([cardWith(tag('x'))]);
    const state = cursorIn(doc, (n) => n.type.name === 'tag');
    const next = apply(state, setTag());
    expect(next === null || next.doc.eq(doc)).toBe(true);
  });

  it('converts analytic_unit to card; analytic to tag; preserves children', () => {
    const doc = makeDoc([
      schema.nodes['analytic_unit']!.createChecked(null, [
        analytic('claim', 'a-id'),
        cardBody('body'),
        undertag('sub'),
      ]),
    ]);
    const state = cursorIn(doc, (n) => n.type.name === 'analytic');
    const next = apply(state, setTag());
    expect(next).not.toBeNull();
    const card = next!.doc.firstChild!;
    expect(card.type.name).toBe('card');
    const childTypes: string[] = [];
    card.forEach((c) => childTypes.push(c.type.name));
    expect(childTypes).toEqual(['tag', 'card_body', 'undertag']);
    expect(card.firstChild!.attrs['id']).toBe('a-id');
    expect(card.firstChild!.textContent).toBe('claim');
  });

  it('places the cursor inside the new tag at the same offset', () => {
    const doc = makeDoc([paragraph('hello world')]);
    const state = cursorIn(doc, (n) => n.type.name === 'paragraph', 6);
    const next = apply(state, setTag());
    expect(next).not.toBeNull();
    const sel = next!.selection;
    expect(sel.$from.parent.type.name).toBe('tag');
    expect(sel.$from.parentOffset).toBe(6);
  });
});

// ---- Card-body splits ----

function findNthCardBody(doc: ReturnType<typeof makeDoc>, n: number): number {
  let count = 0;
  let pos = -1;
  doc.descendants((node, p) => {
    if (pos !== -1) return false;
    if (node.type.name === 'card_body') {
      if (count === n) pos = p + 1;
      count++;
    }
    return true;
  });
  if (pos < 0) throw new Error(`card_body #${n} not found`);
  return pos;
}

function cursorAtCardBody(doc: ReturnType<typeof makeDoc>, n: number): EditorState {
  const pos = findNthCardBody(doc, n);
  const state = EditorState.create({ doc });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}

describe('setHeading on a card_body — splits the card', () => {
  it('cursor in middle body: leaves [tag, prefix] in card; body becomes heading; following bodies become loose paragraphs', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('TheTag'),
        cardBody('body1'),
        cardBody('body2'),
        cardBody('body3'),
      ]),
    ]);
    const state = cursorAtCardBody(doc, 1); // body2
    const next = apply(state, setHeading('pocket'));
    expect(next).not.toBeNull();
    const types = next!.doc.content.content.map((c) => c.type.name);
    expect(types).toEqual(['card', 'pocket', 'paragraph']);
    const card = next!.doc.firstChild!;
    const cardChildren: string[] = [];
    card.forEach((c) => cardChildren.push(c.textContent));
    expect(cardChildren).toEqual(['TheTag', 'body1']);
    expect(next!.doc.content.content[1]!.textContent).toBe('body2');
    expect(next!.doc.content.content[2]!.textContent).toBe('body3');
  });

  it('cursor in first body: card keeps just the tag', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('TheTag'),
        cardBody('body1'),
        cardBody('body2'),
      ]),
    ]);
    const state = cursorAtCardBody(doc, 0);
    const next = apply(state, setHeading('block'));
    expect(next).not.toBeNull();
    const card = next!.doc.firstChild!;
    expect(card.childCount).toBe(1);
    expect(card.firstChild!.type.name).toBe('tag');
    const types = next!.doc.content.content.map((c) => c.type.name);
    expect(types).toEqual(['card', 'block', 'paragraph']);
  });

  it('cursor in last body: no trailing paragraphs', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('TheTag'),
        cardBody('body1'),
        cardBody('body2'),
      ]),
    ]);
    const state = cursorAtCardBody(doc, 1);
    const next = apply(state, setHeading('hat'));
    const types = next!.doc.content.content.map((c) => c.type.name);
    expect(types).toEqual(['card', 'hat']);
  });

  it('preserves cite_paragraph and undertag before the cursor body', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('TheTag'),
        undertag('sub'),
        citePara('cite'),
        cardBody('body1'),
        cardBody('body2'),
      ]),
    ]);
    const state = cursorAtCardBody(doc, 1); // body2
    const next = apply(state, setHeading('pocket'));
    const card = next!.doc.firstChild!;
    const cardTypes: string[] = [];
    card.forEach((c) => cardTypes.push(c.type.name));
    expect(cardTypes).toEqual(['tag', 'undertag', 'cite_paragraph', 'card_body']);
  });

  it('works inside an analytic_unit (same split semantics)', () => {
    const doc = makeDoc([
      schema.nodes['analytic_unit']!.createChecked(null, [
        analytic('A'),
        cardBody('body1'),
        cardBody('body2'),
      ]),
    ]);
    const state = cursorAtCardBody(doc, 1);
    const next = apply(state, setHeading('block'));
    const types = next!.doc.content.content.map((c) => c.type.name);
    expect(types).toEqual(['analytic_unit', 'block']);
    const unit = next!.doc.firstChild!;
    const unitTypes: string[] = [];
    unit.forEach((c) => unitTypes.push(c.type.name));
    expect(unitTypes).toEqual(['analytic', 'card_body']);
  });

  it('places the cursor inside the new heading at the same offset', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [tag('t'), cardBody('hello world')]),
    ]);
    const pos = findNthCardBody(doc, 0) + 6; // offset 6 inside "hello world"
    const state = EditorState.create({ doc }).apply(
      EditorState.create({ doc }).tr.setSelection(
        TextSelection.create(EditorState.create({ doc }).doc, pos),
      ),
    );
    const next = apply(state, setHeading('pocket'));
    const sel = next!.selection;
    expect(sel.$from.parent.type.name).toBe('pocket');
    expect(sel.$from.parentOffset).toBe(6);
  });
});

describe('setTag on a card_body — splits into two cards', () => {
  it('cursor in middle body: original keeps prefix; new card holds cursor body + suffix', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('First'),
        cardBody('b1'),
        cardBody('b2'),
        cardBody('b3'),
      ]),
    ]);
    const state = cursorAtCardBody(doc, 1);
    const next = apply(state, setTag());
    expect(next).not.toBeNull();
    expect(next!.doc.childCount).toBe(2);
    const c0 = next!.doc.content.content[0]!;
    const c1 = next!.doc.content.content[1]!;
    expect(c0.type.name).toBe('card');
    expect(c1.type.name).toBe('card');
    const c0Types: string[] = [];
    c0.forEach((c) => c0Types.push(c.type.name));
    expect(c0Types).toEqual(['tag', 'card_body']);
    expect(c0.firstChild!.textContent).toBe('First');
    const c1Types: string[] = [];
    c1.forEach((c) => c1Types.push(c.type.name));
    expect(c1Types).toEqual(['tag', 'card_body']);
    expect(c1.firstChild!.textContent).toBe('b2');
    expect(c1.child(1).textContent).toBe('b3');
  });

  it('cursor in last body: new card has just a tag', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [tag('First'), cardBody('b1')]),
    ]);
    const state = cursorAtCardBody(doc, 0);
    const next = apply(state, setTag());
    expect(next!.doc.childCount).toBe(2);
    const c1 = next!.doc.content.content[1]!;
    expect(c1.childCount).toBe(1);
    expect(c1.firstChild!.type.name).toBe('tag');
    expect(c1.firstChild!.textContent).toBe('b1');
  });

  it('preserves cite_paragraph and undertag before the cursor body', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('First'),
        undertag('sub'),
        citePara('cite'),
        cardBody('b1'),
        cardBody('b2'),
      ]),
    ]);
    const state = cursorAtCardBody(doc, 1);
    const next = apply(state, setTag());
    const c0 = next!.doc.content.content[0]!;
    const c0Types: string[] = [];
    c0.forEach((c) => c0Types.push(c.type.name));
    expect(c0Types).toEqual(['tag', 'undertag', 'cite_paragraph', 'card_body']);
  });

  it('inside analytic_unit: original stays as analytic_unit; new card holds split content', () => {
    const doc = makeDoc([
      schema.nodes['analytic_unit']!.createChecked(null, [
        analytic('A'),
        cardBody('b1'),
        cardBody('b2'),
      ]),
    ]);
    const state = cursorAtCardBody(doc, 1);
    const next = apply(state, setTag());
    const types = next!.doc.content.content.map((c) => c.type.name);
    expect(types).toEqual(['analytic_unit', 'card']);
    const newCard = next!.doc.content.content[1]!;
    expect(newCard.firstChild!.type.name).toBe('tag');
    expect(newCard.firstChild!.textContent).toBe('b2');
  });

  it('places the cursor inside the new tag at the same offset', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [tag('t'), cardBody('hello world')]),
    ]);
    const baseState = EditorState.create({ doc });
    const pos = findNthCardBody(doc, 0) + 6;
    const state = baseState.apply(baseState.tr.setSelection(TextSelection.create(baseState.doc, pos)));
    const next = apply(state, setTag());
    const sel = next!.selection;
    expect(sel.$from.parent.type.name).toBe('tag');
    expect(sel.$from.parentOffset).toBe(6);
  });
});

// ---- setAnalytic (Mod-F7) ----

describe('setAnalytic (Mod-F7)', () => {
  it('wraps a doc-level paragraph as analytic_unit + analytic', () => {
    const doc = makeDoc([paragraph('claim')]);
    const state = cursorIn(doc, (n) => n.type.name === 'paragraph');
    const next = apply(state, setAnalytic());
    expect(next).not.toBeNull();
    expect(next!.doc.firstChild!.type.name).toBe('analytic_unit');
    expect(next!.doc.firstChild!.firstChild!.type.name).toBe('analytic');
    expect(next!.doc.firstChild!.firstChild!.textContent).toBe('claim');
  });

  it('wraps a pocket as analytic_unit preserving id', () => {
    const doc = makeDoc([pocket('claim', 'orig-id')]);
    const state = cursorIn(doc, (n) => n.type.name === 'pocket');
    const next = apply(state, setAnalytic());
    const analyticNode = next!.doc.firstChild!.firstChild!;
    expect(analyticNode.type.name).toBe('analytic');
    expect(analyticNode.attrs['id']).toBe('orig-id');
  });

  it('no-op accept when cursor is already in an analytic anchor', () => {
    const doc = makeDoc([analyticUnit(analytic('a'))]);
    const state = cursorIn(doc, (n) => n.type.name === 'analytic');
    const next = apply(state, setAnalytic());
    expect(next === null || next.doc.eq(doc)).toBe(true);
  });

  it('converts card → analytic_unit when cursor is in the tag', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('claim', 'tag-id'),
        cardBody('body'),
        undertag('sub'),
      ]),
    ]);
    const state = cursorIn(doc, (n) => n.type.name === 'tag');
    const next = apply(state, setAnalytic());
    expect(next).not.toBeNull();
    const unit = next!.doc.firstChild!;
    expect(unit.type.name).toBe('analytic_unit');
    expect(unit.firstChild!.type.name).toBe('analytic');
    expect(unit.firstChild!.attrs['id']).toBe('tag-id');
    const types: string[] = [];
    unit.forEach((c) => types.push(c.type.name));
    expect(types).toEqual(['analytic', 'card_body', 'undertag']);
  });

  it('folds cite_paragraph into card_body when converting card → analytic_unit', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('claim'),
        citePara('Source'),
        cardBody('body'),
      ]),
    ]);
    const state = cursorIn(doc, (n) => n.type.name === 'tag');
    const next = apply(state, setAnalytic());
    const unit = next!.doc.firstChild!;
    const types: string[] = [];
    const texts: string[] = [];
    unit.forEach((c) => { types.push(c.type.name); texts.push(c.textContent); });
    expect(types).toEqual(['analytic', 'card_body', 'card_body']);
    expect(texts).toEqual(['claim', 'Source', 'body']);
  });

  it('splits a card at a card_body into card prefix + analytic_unit', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('First'),
        cardBody('b1'),
        cardBody('b2'),
        cardBody('b3'),
      ]),
    ]);
    const state = cursorAtCardBody(doc, 1);
    const next = apply(state, setAnalytic());
    expect(next!.doc.childCount).toBe(2);
    const types = next!.doc.content.content.map((c) => c.type.name);
    expect(types).toEqual(['card', 'analytic_unit']);
    const unit = next!.doc.content.content[1]!;
    expect(unit.firstChild!.type.name).toBe('analytic');
    expect(unit.firstChild!.textContent).toBe('b2');
    const unitTypes: string[] = [];
    unit.forEach((c) => unitTypes.push(c.type.name));
    expect(unitTypes).toEqual(['analytic', 'card_body']);
    expect(unit.child(1).textContent).toBe('b3');
  });

  it('places the cursor inside the new analytic at the same offset', () => {
    const doc = makeDoc([paragraph('hello world')]);
    const state = cursorIn(doc, (n) => n.type.name === 'paragraph', 6);
    const next = apply(state, setAnalytic());
    const sel = next!.selection;
    expect(sel.$from.parent.type.name).toBe('analytic');
    expect(sel.$from.parentOffset).toBe(6);
  });
});

// ---- Keymap binding registry ----

describe('buildRibbonKeymap', () => {
  it('produces the default bindings when called with no overrides', () => {
    const km = buildRibbonKeymap();
    for (const id of RIBBON_COMMAND_IDS) {
      const key = DEFAULT_RIBBON_KEYS[id];
      expect(km[key]).toBeTypeOf('function');
    }
  });

  it('replaces a key when an override is provided', () => {
    const km = buildRibbonKeymap({ setPocket: 'Mod-1' });
    expect(km['Mod-1']).toBeTypeOf('function');
    expect(km['F4']).toBeUndefined();
    expect(km['F5']).toBeTypeOf('function');
  });

  it('unbinds a command when the override is an empty string', () => {
    const km = buildRibbonKeymap({ setTag: '' });
    expect(km['F7']).toBeUndefined();
    expect(km['F4']).toBeTypeOf('function');
  });
});

// ---- Selection-spanning application ----

function selectionAcross(
  doc: ReturnType<typeof makeDoc>,
  findFrom: (n: import('prosemirror-model').Node) => boolean,
  findTo: (n: import('prosemirror-model').Node) => boolean,
): EditorState {
  let from = -1;
  let to = -1;
  doc.descendants((node, p) => {
    if (from === -1 && findFrom(node)) from = p + 1;
    if (findTo(node)) to = p + node.nodeSize - 1;
    return true;
  });
  if (from < 0 || to < 0) throw new Error('selection anchors not found');
  const base = EditorState.create({ doc });
  return base.apply(base.tr.setSelection(TextSelection.create(base.doc, from, to)));
}

describe('setHeading on a multi-paragraph selection', () => {
  it('converts every touched doc-level paragraph to the target heading', () => {
    const doc = makeDoc([paragraph('a'), paragraph('b'), paragraph('c')]);
    // Selection from a to b (leaves c alone).
    const state = selectionAcross(doc, (n) => n.textContent === 'a', (n) => n.textContent === 'b');
    const next = apply(state, setHeading('pocket'));
    expect(next).not.toBeNull();
    const types = next!.doc.content.content.map((c) => c.type.name);
    expect(types).toEqual(['pocket', 'pocket', 'paragraph']);
  });

  it('dissolves a card when the selection includes the tag and a body', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('T'),
        cardBody('b1'),
        cardBody('b2'),
      ]),
    ]);
    const state = selectionAcross(doc, (n) => n.type.name === 'tag', (n) => n.textContent === 'b1');
    const next = apply(state, setHeading('pocket'));
    expect(next).not.toBeNull();
    const types = next!.doc.content.content.map((c) => c.type.name);
    expect(types).toEqual(['pocket', 'pocket', 'paragraph']);
    expect(next!.doc.content.content[0]!.textContent).toBe('T');
    expect(next!.doc.content.content[1]!.textContent).toBe('b1');
    expect(next!.doc.content.content[2]!.textContent).toBe('b2');
  });

  it('splits a card when the selection only spans bodies', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('T'),
        cardBody('b1'),
        cardBody('b2'),
        cardBody('b3'),
      ]),
    ]);
    const state = selectionAcross(doc, (n) => n.textContent === 'b1', (n) => n.textContent === 'b2');
    const next = apply(state, setHeading('pocket'));
    const types = next!.doc.content.content.map((c) => c.type.name);
    expect(types).toEqual(['card', 'pocket', 'pocket', 'paragraph']);
    const card = next!.doc.firstChild!;
    expect(card.childCount).toBe(1);
    expect(card.firstChild!.type.name).toBe('tag');
  });

  it('spans two cards: first card splits, second card dissolves (its tag is touched)', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [tag('T1'), cardBody('a1'), cardBody('a2')]),
      schema.nodes['card']!.createChecked(null, [tag('T2'), cardBody('b1'), cardBody('b2')]),
    ]);
    // Selection from a2 to T2.
    const state = selectionAcross(doc, (n) => n.textContent === 'a2', (n) => n.textContent === 'T2');
    const next = apply(state, setHeading('pocket'));
    const types = next!.doc.content.content.map((c) => c.type.name);
    // card1[T1,a1] | pocket(a2) | pocket(T2) | paragraph(b1) | paragraph(b2)
    expect(types).toEqual(['card', 'pocket', 'pocket', 'paragraph', 'paragraph']);
    const c0 = next!.doc.content.content[0]!;
    const c0Types: string[] = [];
    c0.forEach((c) => c0Types.push(c.type.name));
    expect(c0Types).toEqual(['tag', 'card_body']);
    expect(c0.firstChild!.textContent).toBe('T1');
    expect(next!.doc.content.content[1]!.textContent).toBe('a2');
    expect(next!.doc.content.content[2]!.textContent).toBe('T2');
    expect(next!.doc.content.content[3]!.textContent).toBe('b1');
    expect(next!.doc.content.content[4]!.textContent).toBe('b2');
  });

  it('keeps undertag inside container when only later children are touched', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('T'),
        undertag('sub'),
        cardBody('b1'),
        cardBody('b2'),
      ]),
    ]);
    const state = selectionAcross(doc, (n) => n.textContent === 'b1', (n) => n.textContent === 'b1');
    const next = apply(state, setHeading('hat'));
    const card = next!.doc.firstChild!;
    const cardTypes: string[] = [];
    card.forEach((c) => cardTypes.push(c.type.name));
    expect(cardTypes).toEqual(['tag', 'undertag']);
    const docTypes = next!.doc.content.content.map((c) => c.type.name);
    expect(docTypes).toEqual(['card', 'hat', 'paragraph']);
  });
});

describe('setTag/setAnalytic on a multi-paragraph selection', () => {
  it('setTag wraps each touched paragraph into its own card', () => {
    const doc = makeDoc([paragraph('a'), paragraph('b'), paragraph('c')]);
    const state = selectionAcross(doc, (n) => n.textContent === 'a', (n) => n.textContent === 'b');
    const next = apply(state, setTag());
    const types = next!.doc.content.content.map((c) => c.type.name);
    expect(types).toEqual(['card', 'card', 'paragraph']);
    expect(next!.doc.content.content[0]!.firstChild!.textContent).toBe('a');
    expect(next!.doc.content.content[1]!.firstChild!.textContent).toBe('b');
  });

  it('setAnalytic wraps each touched paragraph into its own analytic_unit', () => {
    const doc = makeDoc([paragraph('a'), paragraph('b')]);
    const state = selectionAcross(doc, (n) => n.textContent === 'a', (n) => n.textContent === 'b');
    const next = apply(state, setAnalytic());
    const types = next!.doc.content.content.map((c) => c.type.name);
    expect(types).toEqual(['analytic_unit', 'analytic_unit']);
    expect(next!.doc.content.content[0]!.firstChild!.type.name).toBe('analytic');
    expect(next!.doc.content.content[0]!.firstChild!.textContent).toBe('a');
  });
});
