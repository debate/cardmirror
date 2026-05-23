/**
 * Probe tests for the "Copy Last Cite into the wrong slot when
 * cursor is at start of tag" bug.
 *
 * User report (Discord): a multi-paragraph card with a tag but no
 * cite; cursor at the BEGINNING of the card; pressing Alt+F8
 * (copy previous cite) inserts the cite at the start of the
 * SECOND paragraph of the card. With the cursor at the END of
 * the tag the cite lands in the right place (between tag and
 * first card_body).
 */

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection, Selection } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { copyPreviousCite } from '../../src/editor/ribbon-commands.js';

// Doc builders.
function paragraph(text: string) {
  return text
    ? schema.nodes['paragraph']!.create(null, schema.text(text))
    : schema.nodes['paragraph']!.create(null, []);
}
function tag(text: string, id = newHeadingId()) {
  return schema.nodes['tag']!.create({ id }, text ? schema.text(text) : []);
}
function cardBody(text: string) {
  return text
    ? schema.nodes['card_body']!.create(null, schema.text(text))
    : schema.nodes['card_body']!.create(null, []);
}
function citePara(text: string) {
  return schema.nodes['cite_paragraph']!.create(null, schema.text(text));
}
function makeDoc(children: import('prosemirror-model').Node[]) {
  return schema.nodes['doc']!.createChecked(null, children);
}
function cardWith(...children: import('prosemirror-model').Node[]) {
  return schema.nodes['card']!.createChecked(null, children);
}

function structure(doc: import('prosemirror-model').Node): string[] {
  const out: string[] = [];
  doc.forEach((child) => {
    if (child.type.name === 'card' || child.type.name === 'analytic_unit') {
      const inner: string[] = [];
      child.forEach((g) => inner.push(`${g.type.name}("${g.textContent}")`));
      out.push(`${child.type.name}[${inner.join(', ')}]`);
    } else {
      out.push(`${child.type.name}("${child.textContent}")`);
    }
  });
  return out;
}

/** Build a doc with a "previous" cite-bearing card (so the
 *  command has something to copy) and the target card. */
function buildDocAndSelect(cursorSpec: {
  // What to pass to TextSelection.create as the position.
  targetText?: string;
  offsetInText?: number;
  position?: number;
}) {
  const doc = makeDoc([
    // Source card carrying a cite_paragraph to be copied.
    cardWith(
      tag('SRC TAG'),
      citePara('Source Author 2025, "The Source," Publisher.'),
      cardBody('source body'),
    ),
    // Target card — multi-paragraph card with tag but NO cite.
    cardWith(
      tag('DEST TAG'),
      cardBody('first paragraph'),
      cardBody('second paragraph'),
    ),
  ]);
  let pos: number;
  if (cursorSpec.position !== undefined) {
    pos = cursorSpec.position;
  } else {
    let found = -1;
    doc.descendants((node, p) => {
      if (found !== -1) return false;
      if (node.isText && node.text === cursorSpec.targetText) {
        found = p + (cursorSpec.offsetInText ?? 0);
        return false;
      }
      return true;
    });
    if (found < 0) throw new Error('target text not found');
    pos = found;
  }
  const state = EditorState.create({ doc });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}

function runCmd(state: EditorState) {
  let after: EditorState | null = null;
  copyPreviousCite()(state, (tr) => { after = state.apply(tr); });
  if (!after) throw new Error('copyPreviousCite did not dispatch');
  return after;
}

describe('Copy Last Cite — placement when cursor is in the destination tag', () => {
  // ─── Cursor at END of DEST tag (the case the user says works) ───
  it('cursor at END of "DEST TAG" → cite goes between tag and first card_body', () => {
    const state = buildDocAndSelect({ targetText: 'DEST TAG', offsetInText: 8 });
    const after = runCmd(state);
    expect(structure(after.doc)).toMatchInlineSnapshot(`
      [
        "card[tag("SRC TAG"), cite_paragraph("Source Author 2025, "The Source," Publisher."), card_body("source body")]",
        "card[tag("DEST TAG"), cite_paragraph("Source Author 2025, "The Source," Publisher."), card_body("first paragraph"), card_body("second paragraph")]",
      ]
    `);
  });

  // ─── Cursor at START of DEST tag (the user's bug) ───
  it('cursor at START of "DEST TAG" (offset 0 in tag text) → cite goes where?', () => {
    const state = buildDocAndSelect({ targetText: 'DEST TAG', offsetInText: 0 });
    const after = runCmd(state);
    expect(structure(after.doc)).toMatchInlineSnapshot(`
      [
        "card[tag("SRC TAG"), cite_paragraph("Source Author 2025, "The Source," Publisher."), card_body("source body")]",
        "card[tag("DEST TAG"), cite_paragraph("Source Author 2025, "The Source," Publisher."), card_body("first paragraph"), card_body("second paragraph")]",
      ]
    `);
  });

  // ─── Cursor "before tag" — the card-open boundary position ───
  //
  // This is the position you'd land at if you clicked at the very
  // start of the card (above the tag text). PM resolves this as
  // a position INSIDE the card at offset 0, BEFORE the tag.
  // `parent` is the card, not the tag.
  it('cursor at card-open boundary (parent = card) → cite goes where?', () => {
    // Doc position 0 is BEFORE the source card.
    // Position right after card 1 = source card's end.
    // We want the DEST card's "just inside card-open" position.
    const doc = buildDocAndSelect({ position: 0 }).doc;
    // Compute: source card size, then dest card open boundary.
    const srcCard = doc.firstChild!;
    const destCardOpenInside = srcCard.nodeSize + 1; // just inside dest card-open
    const state = buildDocAndSelect({ position: destCardOpenInside });
    const after = runCmd(state);
    expect(structure(after.doc)).toMatchInlineSnapshot(`
      [
        "card[tag("SRC TAG"), cite_paragraph("Source Author 2025, "The Source," Publisher."), card_body("source body")]",
        "card[tag("DEST TAG"), card_body("first paragraph"), card_body("second paragraph")]",
        "cite_paragraph("Source Author 2025, "The Source," Publisher.")",
      ]
    `);
  });

  // ─── Cursor at START (offset 0) of first card_body — THE BUG ───
  it('cursor at START of first card_body (offset 0) → cite between tag and first body', () => {
    const state = buildDocAndSelect({ targetText: 'first paragraph', offsetInText: 0 });
    const after = runCmd(state);
    expect(structure(after.doc)).toMatchInlineSnapshot(`
      [
        "card[tag("SRC TAG"), cite_paragraph("Source Author 2025, "The Source," Publisher."), card_body("source body")]",
        "card[tag("DEST TAG"), cite_paragraph("Source Author 2025, "The Source," Publisher."), card_body("first paragraph"), card_body("second paragraph")]",
      ]
    `);
  });

  // ─── Cursor MID first card_body — still goes AFTER the body ───
  it('cursor MID first card_body (offset 5) → cite between body 1 and body 2', () => {
    const state = buildDocAndSelect({ targetText: 'first paragraph', offsetInText: 5 });
    const after = runCmd(state);
    expect(structure(after.doc)).toMatchInlineSnapshot(`
      [
        "card[tag("SRC TAG"), cite_paragraph("Source Author 2025, "The Source," Publisher."), card_body("source body")]",
        "card[tag("DEST TAG"), card_body("first paragraph"), cite_paragraph("Source Author 2025, "The Source," Publisher."), card_body("second paragraph")]",
      ]
    `);
  });

  // ─── Cursor at START (offset 0) of SECOND card_body ───
  it('cursor at START of second card_body (offset 0) → cite between body 1 and body 2', () => {
    const state = buildDocAndSelect({ targetText: 'second paragraph', offsetInText: 0 });
    const after = runCmd(state);
    expect(structure(after.doc)).toMatchInlineSnapshot(`
      [
        "card[tag("SRC TAG"), cite_paragraph("Source Author 2025, "The Source," Publisher."), card_body("source body")]",
        "card[tag("DEST TAG"), card_body("first paragraph"), cite_paragraph("Source Author 2025, "The Source," Publisher."), card_body("second paragraph")]",
      ]
    `);
  });

  // ─── Cursor in SECOND card_body of DEST card ───
  it('cursor in second card_body of DEST card → cite goes where?', () => {
    const state = buildDocAndSelect({ targetText: 'second paragraph', offsetInText: 5 });
    const after = runCmd(state);
    expect(structure(after.doc)).toMatchInlineSnapshot(`
      [
        "card[tag("SRC TAG"), cite_paragraph("Source Author 2025, "The Source," Publisher."), card_body("source body")]",
        "card[tag("DEST TAG"), card_body("first paragraph"), card_body("second paragraph"), cite_paragraph("Source Author 2025, "The Source," Publisher.")]",
      ]
    `);
  });
});
