import { describe, expect, it } from 'vitest';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { absorbedDocChildren } from '../../src/editor/absorb-plugin.js';

function makeCard(): ReturnType<typeof schema.nodes['card']['create']> {
  return schema.nodes['card']!.create(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('A tag')),
  ]);
}

function makeAnalyticUnit(): ReturnType<typeof schema.nodes['analytic_unit']['create']> {
  return schema.nodes['analytic_unit']!.create(null, [
    schema.nodes['analytic']!.create({ id: newHeadingId() }, schema.text('An analytic')),
  ]);
}

function makeBlock(text: string): ReturnType<typeof schema.nodes['block']['create']> {
  return schema.nodes['block']!.create({ id: newHeadingId() }, schema.text(text));
}

function para(text: string): ReturnType<typeof schema.nodes['paragraph']['create']> {
  return schema.nodes['paragraph']!.create(null, schema.text(text));
}

describe('paragraph absorption (ARCHITECTURE.md §14.3)', () => {
  it('absorbs a paragraph after a card into a card_body', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [makeCard(), para('absorbed text')]);
    const result = absorbedDocChildren(doc);
    expect(result).not.toBeNull();
    expect(result!.childCount).toBe(1);
    const card = result!.child(0);
    expect(card.type.name).toBe('card');
    expect(card.lastChild!.type.name).toBe('card_body');
    expect(card.lastChild!.textContent).toBe('absorbed text');
  });

  it('absorbs multiple paragraphs after a card', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      makeCard(),
      para('first'),
      para('second'),
    ]);
    const result = absorbedDocChildren(doc);
    expect(result).not.toBeNull();
    expect(result!.childCount).toBe(1);
    const card = result!.child(0);
    expect(card.childCount).toBe(3); // tag + 2 absorbed card_bodies
    expect(card.child(1).type.name).toBe('card_body');
    expect(card.child(1).textContent).toBe('first');
    expect(card.child(2).type.name).toBe('card_body');
    expect(card.child(2).textContent).toBe('second');
  });

  it('absorbs a paragraph after an analytic_unit', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      makeAnalyticUnit(),
      para('analytic body'),
    ]);
    const result = absorbedDocChildren(doc);
    expect(result).not.toBeNull();
    const unit = result!.child(0);
    expect(unit.type.name).toBe('analytic_unit');
    expect(unit.lastChild!.type.name).toBe('card_body');
    expect(unit.lastChild!.textContent).toBe('analytic body');
  });

  it('leaves a paragraph between a heading and a card unchanged', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      makeBlock('Block heading'),
      para('legitimate bridge text'),
      makeCard(),
    ]);
    const result = absorbedDocChildren(doc);
    expect(result).toBeNull(); // no modifications
  });

  it('leaves a paragraph at doc start unchanged', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      para('preface text'),
      makeBlock('Block'),
    ]);
    const result = absorbedDocChildren(doc);
    expect(result).toBeNull();
  });

  it('a heading after a card breaks the absorption zone', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      makeCard(),
      makeBlock('A new section'),
      para('this paragraph belongs to the new block, not the card'),
    ]);
    const result = absorbedDocChildren(doc);
    expect(result).toBeNull();
  });

  it('multiple cards each absorb their own following paragraphs', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      makeCard(),
      para('belongs to first card'),
      makeCard(),
      para('belongs to second card'),
    ]);
    const result = absorbedDocChildren(doc);
    expect(result).not.toBeNull();
    expect(result!.childCount).toBe(2);
    expect(result!.child(0).lastChild!.textContent).toBe('belongs to first card');
    expect(result!.child(1).lastChild!.textContent).toBe('belongs to second card');
  });

  it('preserves inline marks when absorbing', () => {
    const styledPara = schema.nodes['paragraph']!.create(null, [
      schema.text('plain '),
      schema.text('underlined', [schema.marks['underline_mark']!.create()]),
    ]);
    const doc = schema.nodes['doc']!.createChecked(null, [makeCard(), styledPara]);
    const result = absorbedDocChildren(doc);
    expect(result).not.toBeNull();
    const card = result!.child(0);
    const cardBody = card.lastChild!;
    expect(cardBody.type.name).toBe('card_body');
    expect(cardBody.childCount).toBe(2);
    const underlinedRun = cardBody.child(1);
    expect(underlinedRun.text).toBe('underlined');
    expect(underlinedRun.marks[0]!.type.name).toBe('underline_mark');
  });

  it('returns null on docs that already comply (no-op)', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      makeBlock('Block'),
      makeCard(),
      makeBlock('Another block'),
    ]);
    expect(absorbedDocChildren(doc)).toBeNull();
  });

  it('absorbs a free-floating cite_paragraph after a card as a cite_paragraph', () => {
    const cite = schema.nodes['cite_paragraph']!.create(
      null,
      schema.text('Stein 24', [schema.marks['cite_mark']!.create()]),
    );
    const doc = schema.nodes['doc']!.createChecked(null, [makeCard(), cite]);
    const result = absorbedDocChildren(doc);
    expect(result).not.toBeNull();
    expect(result!.childCount).toBe(1);
    const card = result!.child(0);
    expect(card.lastChild!.type.name).toBe('cite_paragraph');
    expect(card.lastChild!.textContent).toBe('Stein 24');
  });

  it('absorbs a mix of cite_paragraph and paragraph after a card, preserving types', () => {
    const cite = schema.nodes['cite_paragraph']!.create(
      null,
      schema.text('Author 24', [schema.marks['cite_mark']!.create()]),
    );
    const doc = schema.nodes['doc']!.createChecked(null, [
      makeCard(),
      cite,
      para('body text'),
    ]);
    const result = absorbedDocChildren(doc);
    expect(result).not.toBeNull();
    const card = result!.child(0);
    const types: string[] = [];
    card.forEach((c) => types.push(c.type.name));
    expect(types).toEqual(['tag', 'cite_paragraph', 'card_body']);
  });

  it('absorbs a free-floating cite_paragraph after an analytic_unit as a cite_paragraph', () => {
    const cite = schema.nodes['cite_paragraph']!.create(
      null,
      schema.text('Stein 24', [schema.marks['cite_mark']!.create()]),
    );
    const doc = schema.nodes['doc']!.createChecked(null, [makeAnalyticUnit(), cite]);
    const result = absorbedDocChildren(doc);
    expect(result).not.toBeNull();
    expect(result!.childCount).toBe(1);
    const unit = result!.child(0);
    expect(unit.type.name).toBe('analytic_unit');
    expect(unit.lastChild!.type.name).toBe('cite_paragraph');
  });

  it('absorbs a free-floating undertag after a card as an undertag', () => {
    const undertag = schema.nodes['undertag']!.create(null, schema.text('sub note'));
    const doc = schema.nodes['doc']!.createChecked(null, [makeCard(), undertag]);
    const result = absorbedDocChildren(doc);
    expect(result).not.toBeNull();
    expect(result!.childCount).toBe(1);
    const card = result!.child(0);
    expect(card.lastChild!.type.name).toBe('undertag');
    expect(card.lastChild!.textContent).toBe('sub note');
  });

  it('undertag does NOT break the absorption zone — paragraphs after it still absorb', () => {
    const undertag = schema.nodes['undertag']!.create(null, schema.text('sub'));
    const doc = schema.nodes['doc']!.createChecked(null, [
      makeCard(),
      undertag,
      para('trailing body'),
    ]);
    const result = absorbedDocChildren(doc);
    expect(result).not.toBeNull();
    expect(result!.childCount).toBe(1);
    const card = result!.child(0);
    const types: string[] = [];
    card.forEach((c) => types.push(c.type.name));
    expect(types).toEqual(['tag', 'undertag', 'card_body']);
    expect(card.child(2).textContent).toBe('trailing body');
  });

  it('absorbs a free-floating undertag after an analytic_unit', () => {
    const undertag = schema.nodes['undertag']!.create(null, schema.text('sub note'));
    const doc = schema.nodes['doc']!.createChecked(null, [makeAnalyticUnit(), undertag]);
    const result = absorbedDocChildren(doc);
    expect(result).not.toBeNull();
    expect(result!.childCount).toBe(1);
    const unit = result!.child(0);
    expect(unit.lastChild!.type.name).toBe('undertag');
  });
});
