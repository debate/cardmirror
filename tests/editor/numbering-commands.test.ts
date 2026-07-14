/**
 * Auto-numbering input commands (NUMBERING_PLAN.md §4). Whole-selection toggles:
 * a role command turns the in-scope card set ON if any lacks the role, else OFF;
 * number/sub are mutually exclusive; restart flips the cursor's block or card.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EditorState, TextSelection, type Command } from 'prosemirror-state';
import { type Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  toggleNumberRole,
  toggleSubRole,
  toggleNumRestart,
  registerNavNumberingScope,
} from '../../src/editor/numbering-commands.js';

function card(tag: string): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text('body')),
  ]);
}
function block(text: string): PMNode {
  return schema.nodes['block']!.create({ id: newHeadingId() }, schema.text(text));
}
function stateWith(children: PMNode[]): EditorState {
  return EditorState.create({ doc: schema.nodes['doc']!.create(null, children) });
}
/** A position inside the given text node's content. */
function posInText(doc: PMNode, text: string): number {
  let p = -1;
  doc.descendants((n, pos) => {
    if (p < 0 && n.isText && n.text === text) p = pos + 1;
    return p < 0;
  });
  if (p < 0) throw new Error(`text not found: ${text}`);
  return p;
}
function run(state: EditorState, cmd: Command): EditorState {
  let next = state;
  const ok = cmd(state, (tr) => {
    next = state.apply(tr);
  });
  if (!ok) throw new Error('command returned false');
  return next;
}
/** numRole of each card/analytic in document order. */
function roles(doc: PMNode): string[] {
  const out: string[] = [];
  doc.forEach((n) => {
    if (n.type.name === 'card' || n.type.name === 'analytic_unit') out.push(n.attrs['numRole']);
  });
  return out;
}

describe('toggleNumberRole / toggleSubRole — single card at the cursor', () => {
  it('toggles number on then off', () => {
    let s = stateWith([card('A')]);
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, posInText(s.doc, 'A'))));
    s = run(s, toggleNumberRole);
    expect(roles(s.doc)).toEqual(['number']);
    s = run(s, toggleNumberRole);
    expect(roles(s.doc)).toEqual(['none']);
  });

  it('number and sub are mutually exclusive (sub replaces number)', () => {
    let s = stateWith([card('A')]);
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, posInText(s.doc, 'A'))));
    s = run(s, toggleNumberRole);
    expect(roles(s.doc)).toEqual(['number']);
    s = run(s, toggleSubRole); // not all are 'sub' → set to 'sub'
    expect(roles(s.doc)).toEqual(['sub']);
  });
});

describe('toggleNumberRole — whole-selection set (§4)', () => {
  it('a mixed selection normalizes all to the role, then clears all on the second run', () => {
    let s = stateWith([card('A'), card('B'), card('C')]);
    // Pre-set the middle card to 'number' so the selection is mixed.
    let bCardPos = -1;
    s.doc.forEach((n, off, i) => {
      if (i === 1) bCardPos = off;
    });
    s = s.apply(s.tr.setNodeAttribute(bCardPos, 'numRole', 'number'));
    // Select across all three cards.
    const from = posInText(s.doc, 'A');
    const to = posInText(s.doc, 'C');
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, from, to)));
    expect(roles(s.doc)).toEqual(['none', 'number', 'none']); // mixed

    s = run(s, toggleNumberRole); // any not 'number' → set all
    expect(roles(s.doc)).toEqual(['number', 'number', 'number']);

    s = run(s, toggleNumberRole); // all 'number' → clear all
    expect(roles(s.doc)).toEqual(['none', 'none', 'none']);
  });
});

describe('toggleNumRestart — flips the cursor unit', () => {
  it('a card defaults to no restart; toggling turns it on', () => {
    let s = stateWith([card('A')]);
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, posInText(s.doc, 'A'))));
    expect(s.doc.child(0).attrs['numRestart']).toBe(false);
    s = run(s, toggleNumRestart);
    expect(s.doc.child(0).attrs['numRestart']).toBe(true);
  });

  it('a block defaults to restart; toggling makes it continue', () => {
    let s = stateWith([block('One'), card('A')]);
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, posInText(s.doc, 'One'))));
    expect(s.doc.child(0).attrs['numRestart']).toBe(true);
    s = run(s, toggleNumRestart);
    expect(s.doc.child(0).attrs['numRestart']).toBe(false);
  });
});

describe('nav-pane selection scope (registerNavNumberingScope)', () => {
  // Reset so no case leaks a provider into its neighbors (module-global).
  afterEach(() => registerNavNumberingScope(() => null));

  /** Positions of the i-th top-level children (all cards here). */
  function childPositions(doc: PMNode, ...indices: number[]): number[] {
    const at: number[] = [];
    doc.forEach((_n, off, i) => {
      if (indices.includes(i)) at.push(off);
    });
    return at;
  }

  it('a nav multi-selection scopes the toggle to THOSE cards, not the caret card', () => {
    let s = stateWith([card('A'), card('B'), card('C')]);
    // Caret sits in C; the nav selection covers A and B.
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, posInText(s.doc, 'C'))));
    const navPositions = childPositions(s.doc, 0, 1);
    registerNavNumberingScope(() => ({ kind: 'cards', positions: navPositions }));
    s = run(s, toggleNumberRole);
    expect(roles(s.doc)).toEqual(['number', 'number', 'none']);
  });

  it('whole-set semantics apply to the nav scope: all-on toggles all off', () => {
    let s = stateWith([card('A'), card('B')]);
    for (const pos of childPositions(s.doc, 0, 1)) {
      s = s.apply(s.tr.setNodeAttribute(pos, 'numRole', 'sub'));
    }
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, posInText(s.doc, 'A'))));
    registerNavNumberingScope(() => ({ kind: 'cards', positions: childPositions(s.doc, 0, 1) }));
    s = run(s, toggleSubRole);
    expect(roles(s.doc)).toEqual(['none', 'none']);
  });

  it('stale positions that no longer resolve to a card drop out; all-stale falls back to the caret', () => {
    let s = stateWith([card('A'), card('B')]);
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, posInText(s.doc, 'B'))));
    // A position pointing INSIDE a card (its tag) is not a card unit.
    registerNavNumberingScope(() => ({ kind: 'cards', positions: [childPositions(s.doc, 0)[0]! + 1] }));
    s = run(s, toggleNumberRole);
    expect(roles(s.doc)).toEqual(['none', 'number']); // caret card, not tag-pos garbage
  });

  it('a null / empty provider leaves the editor-selection scope untouched', () => {
    let s = stateWith([card('A'), card('B')]);
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, posInText(s.doc, 'A'))));
    registerNavNumberingScope(() => null);
    s = run(s, toggleNumberRole);
    expect(roles(s.doc)).toEqual(['number', 'none']);
  });
});

describe('toggleNumRestart — multi-unit scope (normalize to non-default)', () => {
  afterEach(() => registerNavNumberingScope(() => null));

  /** Positions of the i-th top-level children. */
  function childPositions(doc: PMNode, ...indices: number[]): number[] {
    const at: number[] = [];
    doc.forEach((_n, off, i) => {
      if (indices.includes(i)) at.push(off);
    });
    return at;
  }
  /** numRestart of each top-level block, in order. */
  function blockRestarts(doc: PMNode): boolean[] {
    const out: boolean[] = [];
    doc.forEach((n) => {
      if (n.type.name === 'block') out.push(n.attrs['numRestart']);
    });
    return out;
  }

  it('nav blocks scope: a mixed set normalizes ALL blocks to continue, then restores restart', () => {
    // The field scenario: arguments split across blocks, wanting one
    // consecutive count — select the blocks, press once.
    let s = stateWith([block('One'), card('A'), block('Two'), card('B'), block('Three'), card('C')]);
    // Pre-flag the middle block "continue" so the set is mixed.
    s = s.apply(s.tr.setNodeAttribute(childPositions(s.doc, 2)[0]!, 'numRestart', false));
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, posInText(s.doc, 'A'))));
    registerNavNumberingScope(() => ({ kind: 'blocks', positions: childPositions(s.doc, 0, 2, 4) }));
    expect(blockRestarts(s.doc)).toEqual([true, false, true]); // mixed

    s = run(s, toggleNumRestart); // → all continue (non-default)
    expect(blockRestarts(s.doc)).toEqual([false, false, false]);

    s = run(s, toggleNumRestart); // all flagged → restore restart
    expect(blockRestarts(s.doc)).toEqual([true, true, true]);
  });

  it('nav cards scope: normalizes all cards to restart-here, then clears', () => {
    let s = stateWith([card('A'), card('B')]);
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, posInText(s.doc, 'A'))));
    registerNavNumberingScope(() => ({ kind: 'cards', positions: childPositions(s.doc, 0, 1) }));
    s = run(s, toggleNumRestart);
    expect(s.doc.child(0).attrs['numRestart']).toBe(true);
    expect(s.doc.child(1).attrs['numRestart']).toBe(true);
    s = run(s, toggleNumRestart);
    expect(s.doc.child(0).attrs['numRestart']).toBe(false);
    expect(s.doc.child(1).attrs['numRestart']).toBe(false);
  });

  it('editor range spanning blocks acts on the BLOCKS only (cards untouched)', () => {
    let s = stateWith([block('One'), card('A'), block('Two'), card('B')]);
    s = s.apply(
      s.tr.setSelection(TextSelection.create(s.doc, posInText(s.doc, 'One'), posInText(s.doc, 'B'))),
    );
    s = run(s, toggleNumRestart);
    expect(blockRestarts(s.doc)).toEqual([false, false]); // blocks → continue
    // Cards' restart flags untouched — flipping them to "restart here"
    // because the selection crossed a block would be catastrophic.
    s.doc.forEach((n) => {
      if (n.type.name === 'card') expect(n.attrs['numRestart']).toBe(false);
    });
  });

  it('editor range with only cards flags them all restart-here', () => {
    let s = stateWith([card('A'), card('B')]);
    s = s.apply(
      s.tr.setSelection(TextSelection.create(s.doc, posInText(s.doc, 'A'), posInText(s.doc, 'B'))),
    );
    s = run(s, toggleNumRestart);
    expect(s.doc.child(0).attrs['numRestart']).toBe(true);
    expect(s.doc.child(1).attrs['numRestart']).toBe(true);
  });
});
