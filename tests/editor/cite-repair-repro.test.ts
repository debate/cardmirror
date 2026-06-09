import { describe, it, expect } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { buildCiteTransaction } from '../../src/editor/ai/cite-creator.js';

function para(text: string) { return schema.nodes['paragraph']!.create(null, text ? schema.text(text) : []); }
function cardBody(text: string) { return schema.nodes['card_body']!.create(null, text ? schema.text(text) : []); }
function tag(text: string) { return schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(text)); }
function card(...c: any[]) { return schema.nodes['card']!.createChecked(null, c); }
function makeDoc(...c: any[]) { return schema.nodes['doc']!.createChecked(null, c); }

function markedRuns(doc: any): string[] {
  const out: string[] = [];
  doc.descendants((n: any) => { if (n.isText && n.marks.some((m: any) => m.type.name === 'cite_mark')) out.push(n.text!); return true; });
  return out;
}
function blockTexts(doc: any): string[] {
  const out: string[] = [];
  doc.descendants((n: any) => { if (n.isTextblock) out.push(n.textContent); return true; });
  return out;
}

describe('cite repair: whole-document (from=0) selection', () => {
  // Mirrors test document.cmir: messy multi-paragraph source selected with a
  // whole-doc selection whose `from` is 0 (before the first paragraph — not a
  // valid inline position). The cite lands at position 1; trusting the raw
  // `from = 0` used to shift every position one left, so the trailing token
  // lost its last char AND the cite's last char got shunted to its own line.
  const BLOCKS = [
    "I'm Claire Cary, a food photographer, recipe developer and blogger based in Boston, MA. Eat With Clarity was born out of my love for food, health, photography, ...",
    'Savory Quinoa Breakfast Bowl', '', 'By', '', 'Claire Cary', '', '5 from 9 votes', 'May 8, 2024',
  ];
  const cite =
    'Claire Cary 24, food photographer, recipe developer, and blogger based in Boston, MA, founder of Eat With Clarity, "Savory Quinoa Breakfast Bowl," Eat With Clarity, 05/08/2024';
  const tokens = ['Cary 24'];

  it('marks the full token and keeps the cite intact (no last-char shunt)', () => {
    const doc = makeDoc(...BLOCKS.map(para));
    const state = EditorState.create({ doc });
    const tr = buildCiteTransaction(state, 0, doc.content.size, { cite, tokens })!;
    const next = state.apply(tr);
    // Full token marked — not "ary 24," (shifted right) nor " Cary 2" (left).
    expect(markedRuns(next.doc)).toEqual(['Cary 24']);
    // The cite lands intact in a single block — its last char ("4") is NOT
    // shunted onto its own line.
    expect(blockTexts(next.doc)).toContain(cite);
  });

  it('handles a whole-doc selection that starts with a card', () => {
    const doc = makeDoc(card(tag('RAW TAG'), cardBody('raw body text')), para('keep'));
    const tr = buildCiteTransaction(state(doc), 0, doc.content.size, { cite: 'Doe 25, "T," S', tokens: ['Doe 25'] })!;
    const next = state(doc).apply(tr);
    expect(markedRuns(next.doc)).toEqual(['Doe 25']);
    expect(blockTexts(next.doc)).toContain('Doe 25, "T," S');
  });

  it('still works for an ordinary in-block selection (from > 0)', () => {
    const doc = makeDoc(card(tag('TAG'), cardBody('raw info more'), cardBody('KEEP')));
    let from = -1; doc.descendants((n: any, p: number) => { if (n.isText && n.text === 'raw info more' && from < 0) from = p; return true; });
    const tr = buildCiteTransaction(state(doc), from, from + 'raw info'.length, { cite: 'Author 25, "T," S', tokens: ['Author 25'] })!;
    const next = state(doc).apply(tr);
    expect(markedRuns(next.doc)).toEqual(['Author 25']);
    expect(blockTexts(next.doc)).toContain('Author 25, "T," S');
  });
});

function state(doc: any): EditorState { return EditorState.create({ doc }); }
