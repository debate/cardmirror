/**
 * Structural units + crude move stepping (mobile Move mode; shared
 * with desktop). The doc is flat at the top level, so heading
 * "subtrees" are runs of following nodes — these tests pin the
 * one-step semantics: swap whole sibling subtrees, hop loose
 * neighbors, enter/exit sections across bare heading lines.
 */

import { describe, it, expect } from 'vitest';
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  unitRangeAtPos,
  moveInsertPos,
  sendToEntryInsertPos,
  executeUnitMove,
} from '../../src/editor/structural-move.js';
import { collectHeadings } from '../../src/editor/headings.js';

function heading(type: 'pocket' | 'hat' | 'block', text: string): PMNode {
  return schema.nodes[type]!.create({ id: newHeadingId() }, schema.text(text));
}
function card(tagText: string, bodyText = 'body'): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tagText)),
    schema.nodes['card_body']!.create(null, schema.text(bodyText)),
  ]);
}
function para(text: string): PMNode {
  return schema.nodes['paragraph']!.create(null, schema.text(text));
}
function makeDoc(...children: PMNode[]): PMNode {
  return schema.nodes['doc']!.createChecked(null, children);
}

/** Top-level child positions by index. */
function childPos(doc: PMNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i)!.nodeSize;
  return pos;
}

/** Tag texts of all cards in document order. */
function cardOrder(doc: PMNode): string[] {
  const out: string[] = [];
  doc.descendants((n) => {
    if (n.type.name === 'tag') out.push(n.textContent);
    return true;
  });
  return out;
}

describe('unitRangeAtPos', () => {
  it('resolves a card from inside its body', () => {
    const doc = makeDoc(heading('block', 'B1'), card('T1'), card('T2'));
    const c1 = childPos(doc, 1);
    const unit = unitRangeAtPos(doc, c1 + 3);
    expect(unit).toMatchObject({ from: c1, level: 4, type: 'card', label: 'T1' });
  });

  it('resolves a heading subtree from the heading line', () => {
    const doc = makeDoc(
      heading('hat', 'H1'),
      heading('block', 'B1'),
      card('T1'),
      heading('block', 'B2'),
      card('T2'),
      heading('hat', 'H2'),
    );
    const b1 = childPos(doc, 1);
    const unit = unitRangeAtPos(doc, b1 + 1);
    // B1's subtree ends where B2 begins.
    expect(unit).toMatchObject({ from: b1, to: childPos(doc, 3), level: 3, type: 'block' });
    const h1 = unitRangeAtPos(doc, 1);
    // H1's subtree spans through B2's card, ends at H2.
    expect(h1).toMatchObject({ from: 0, to: childPos(doc, 5), level: 2 });
  });
});

describe('moveInsertPos', () => {
  it('card swaps over its previous sibling card', () => {
    const doc = makeDoc(heading('block', 'B1'), card('T1'), card('T2'));
    const unit = unitRangeAtPos(doc, childPos(doc, 2) + 3)!;
    expect(moveInsertPos(doc, unit, -1)).toBe(childPos(doc, 1));
  });

  it('first card in a section exits above the heading line', () => {
    const doc = makeDoc(heading('block', 'B1'), card('T1'));
    const unit = unitRangeAtPos(doc, childPos(doc, 1) + 3)!;
    expect(moveInsertPos(doc, unit, -1)).toBe(0);
  });

  it('card moving down enters the next section after its heading line', () => {
    const doc = makeDoc(heading('block', 'B1'), card('T1'), heading('block', 'B2'), card('T2'));
    const unit = unitRangeAtPos(doc, childPos(doc, 1) + 3)!;
    const b2 = childPos(doc, 2);
    expect(moveInsertPos(doc, unit, 1)).toBe(b2 + doc.child(2)!.nodeSize);
  });

  it('heading unit swaps over a whole previous sibling subtree', () => {
    const doc = makeDoc(
      heading('block', 'B1'),
      card('T1'),
      card('T2'),
      heading('block', 'B2'),
      card('T3'),
    );
    const b2 = childPos(doc, 3);
    const unit = unitRangeAtPos(doc, b2 + 1)!;
    // B1's subtree (B1+T1+T2) ends exactly at B2 — swap over all of it.
    expect(moveInsertPos(doc, unit, -1)).toBe(0);
  });

  it('heading unit moving down hops a same-level sibling subtree whole', () => {
    const doc = makeDoc(
      heading('block', 'B1'),
      card('T1'),
      heading('block', 'B2'),
      card('T2'),
      card('T3'),
    );
    const unit = unitRangeAtPos(doc, 1)!;
    expect(moveInsertPos(doc, unit, 1)).toBe(doc.content.size);
  });

  it('no-ops at document edges', () => {
    const doc = makeDoc(heading('block', 'B1'), card('T1'));
    const blockUnit = unitRangeAtPos(doc, 1)!;
    expect(moveInsertPos(doc, blockUnit, -1)).toBeNull();
    expect(moveInsertPos(doc, blockUnit, 1)).toBeNull();
  });

  it('hops a loose paragraph whole, both directions', () => {
    const doc = makeDoc(card('T1'), para('loose'), card('T2'));
    const t1 = unitRangeAtPos(doc, 3)!;
    const paraEnd = childPos(doc, 1) + doc.child(1)!.nodeSize;
    expect(moveInsertPos(doc, t1, 1)).toBe(paraEnd);
    const t2 = unitRangeAtPos(doc, childPos(doc, 2) + 3)!;
    expect(moveInsertPos(doc, t2, -1)).toBe(childPos(doc, 1));
  });
});

describe('sendToEntryInsertPos', () => {
  it('heading target → right after the heading line; tag target → after the card', () => {
    const doc = makeDoc(heading('block', 'B1'), card('T1'), card('T2'));
    const entries = collectHeadings(doc);
    const block = entries.find((e) => e.type === 'block')!;
    expect(sendToEntryInsertPos(doc, block)).toBe(block.pos + doc.child(0)!.nodeSize);
    const t1 = entries.find((e) => e.text === 'T1')!;
    expect(sendToEntryInsertPos(doc, t1)).toBe(childPos(doc, 2));
  });
});

describe('executeUnitMove', () => {
  /** Minimal fake view — no DOM in this test environment (same
   *  pattern as the type-over-boundary tests). */
  function makeView(doc: PMNode): EditorView {
    let state = EditorState.create({ doc });
    return {
      get state() {
        return state;
      },
      dispatch(tr: import('prosemirror-state').Transaction) {
        state = state.apply(tr);
      },
    } as unknown as EditorView;
  }

  it('moves a card up in one undoable step', () => {
    const doc = makeDoc(heading('block', 'B1'), card('T1'), card('T2'));
    const view = makeView(doc);
    const unit = unitRangeAtPos(view.state.doc, childPos(doc, 2) + 3)!;
    const insertPos = moveInsertPos(view.state.doc, unit, -1)!;
    expect(executeUnitMove(view, unit, insertPos)).toBe(true);
    expect(cardOrder(view.state.doc)).toEqual(['T2', 'T1']);
  });

  it('rejects a no-op target', () => {
    const doc = makeDoc(heading('block', 'B1'), card('T1'));
    const view = makeView(doc);
    const unit = unitRangeAtPos(view.state.doc, childPos(doc, 1) + 3)!;
    expect(executeUnitMove(view, unit, unit.from)).toBe(false);
  });
});
