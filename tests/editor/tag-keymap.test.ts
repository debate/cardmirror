/**
 * Tag/analytic boundary editing keymap commands
 * (ARCHITECTURE.md §14.3).
 */

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  backspaceAtTagStart,
  deleteAtTagEnd,
  enterMidTag,
  enterAtTagEnd,
} from '../../src/editor/tag-keymap.js';

// ---- Doc-building helpers ----

function tag(text: string) {
  return schema.nodes['tag']!.create({ id: newHeadingId() }, text ? schema.text(text) : []);
}

function cardWith(...children: ReturnType<typeof tag>[]) {
  return schema.nodes['card']!.createChecked(null, children);
}

function cardTagOnly(text: string) {
  return cardWith(tag(text));
}

function cardTagBody(tagText: string, bodyText: string) {
  return cardWith(
    tag(tagText),
    schema.nodes['card_body']!.create(null, schema.text(bodyText)),
  );
}

function paragraph(text: string) {
  return text
    ? schema.nodes['paragraph']!.create(null, schema.text(text))
    : schema.nodes['paragraph']!.create(null, []);
}

function block(text: string) {
  return schema.nodes['block']!.create({ id: newHeadingId() }, schema.text(text));
}

function makeDoc(children: ReturnType<typeof tag>[]) {
  return schema.nodes['doc']!.createChecked(null, children);
}

// Apply a command to a state. Returns the new state, or null if the
// command wasn't applicable (returned false WITHOUT dispatching).
function apply(state: EditorState, cmd: Command): EditorState | null {
  let next: EditorState | null = null;
  const ok = cmd(state, (tr) => {
    next = state.apply(tr);
  });
  if (!ok) return null;
  return next; // null if the command swallowed the event without dispatching
}

/**
 * Locate the start position of the n-th tag (or analytic) in the doc.
 * The n-th means 0-indexed.
 */
function findTagStart(doc: ReturnType<typeof makeDoc>, n = 0): number {
  let count = 0;
  let pos = -1;
  doc.descendants((node, p) => {
    if (node.type.name === 'tag' || node.type.name === 'analytic') {
      if (count === n) pos = p + 1; // +1 to step inside the head's content
      count++;
    }
    return true;
  });
  if (pos < 0) throw new Error(`tag #${n} not found`);
  return pos;
}

function findTagEnd(doc: ReturnType<typeof makeDoc>, n = 0): number {
  let count = 0;
  let pos = -1;
  doc.descendants((node, p) => {
    if (node.type.name === 'tag' || node.type.name === 'analytic') {
      if (count === n) pos = p + 1 + node.content.size;
      count++;
    }
    return true;
  });
  if (pos < 0) throw new Error(`tag #${n} not found`);
  return pos;
}

function stateWithCursor(doc: ReturnType<typeof makeDoc>, cursor: number): EditorState {
  return EditorState.create({
    doc,
    schema,
    selection: TextSelection.create(doc, cursor),
  });
}

// ----- Backspace at start of tag -----

describe('backspaceAtTagStart', () => {
  it('does not apply when cursor is not at start of tag', () => {
    const doc = makeDoc([cardTagOnly('A tag')]);
    const state = stateWithCursor(doc, findTagStart(doc) + 2);
    expect(apply(state, backspaceAtTagStart)).toBe(null);
  });

  it('does not apply when cursor is in a non-tag node', () => {
    const doc = makeDoc([
      cardWith(tag('Tag'), schema.nodes['card_body']!.create(null, schema.text('body'))),
    ]);
    // Cursor in the card_body
    const state = stateWithCursor(doc, findTagEnd(doc) + 2);
    expect(apply(state, backspaceAtTagStart)).toBe(null);
  });

  it('deletes a blank previous paragraph (whitespace-only) at doc level', () => {
    const doc = makeDoc([
      block('Section'),
      paragraph('   '), // whitespace-only
      cardTagOnly('A tag'),
    ]);
    const state = stateWithCursor(doc, findTagStart(doc));
    const next = apply(state, backspaceAtTagStart);
    expect(next).not.toBe(null);
    // The whitespace paragraph should be gone
    expect(next!.doc.childCount).toBe(2);
    expect(next!.doc.child(0).type.name).toBe('block');
    expect(next!.doc.child(1).type.name).toBe('card');
  });

  it('deletes a blank previous paragraph (empty) at doc level', () => {
    const doc = makeDoc([
      paragraph(''),
      cardTagOnly('A tag'),
    ]);
    const state = stateWithCursor(doc, findTagStart(doc));
    const next = apply(state, backspaceAtTagStart);
    expect(next).not.toBe(null);
    expect(next!.doc.childCount).toBe(1);
    expect(next!.doc.child(0).type.name).toBe('card');
  });

  it('deletes a blank trailing card_body of the previous card', () => {
    const doc = makeDoc([
      cardWith(
        tag('First card'),
        schema.nodes['card_body']!.create(null, schema.text('body')),
        schema.nodes['card_body']!.create(null, []), // blank trailing body
      ),
      cardTagOnly('Second card'),
    ]);
    const state = stateWithCursor(doc, findTagStart(doc, 1));
    const next = apply(state, backspaceAtTagStart);
    expect(next).not.toBe(null);
    // First card should now have only one body
    const firstCard = next!.doc.child(0);
    expect(firstCard.type.name).toBe('card');
    // tag + 1 card_body = 2 children
    expect(firstCard.childCount).toBe(2);
  });

  it('prohibits deletion when previous paragraph is non-blank', () => {
    const doc = makeDoc([
      paragraph('not blank'),
      cardTagOnly('A tag'),
    ]);
    const state = stateWithCursor(doc, findTagStart(doc));
    const next = apply(state, backspaceAtTagStart);
    // Command swallows the event (returns true), but doesn't dispatch.
    expect(next).toBe(null);
  });

  it('prohibits deletion when previous is a non-blank card_body', () => {
    const doc = makeDoc([
      cardTagBody('First', 'long body text'),
      cardTagOnly('Second'),
    ]);
    const state = stateWithCursor(doc, findTagStart(doc, 1));
    const next = apply(state, backspaceAtTagStart);
    expect(next).toBe(null);
  });

  it('removes the entire previous card when its only-tag is blank', () => {
    const doc = makeDoc([
      cardTagOnly(''), // empty tag, only child
      cardTagOnly('Second'),
    ]);
    const state = stateWithCursor(doc, findTagStart(doc, 1));
    const next = apply(state, backspaceAtTagStart);
    expect(next).not.toBe(null);
    expect(next!.doc.childCount).toBe(1);
    expect(next!.doc.child(0).firstChild!.textContent).toBe('Second');
  });

  it('does not apply when the tag is at the very start of the doc', () => {
    const doc = makeDoc([cardTagOnly('First')]);
    const state = stateWithCursor(doc, findTagStart(doc));
    // Returns false (not handled) so default Backspace can fall through.
    let handled = false;
    backspaceAtTagStart(state, () => { handled = true; });
    expect(handled).toBe(false);
  });
});

// ----- Delete at end of tag -----

describe('deleteAtTagEnd', () => {
  it('does not apply when cursor is not at end of tag', () => {
    const doc = makeDoc([cardTagOnly('Tag'), cardTagOnly('Tag2')]);
    const state = stateWithCursor(doc, findTagStart(doc) + 1);
    expect(apply(state, deleteAtTagEnd)).toBe(null);
  });

  it('merges into next when next is a tag-only card', () => {
    const doc = makeDoc([cardTagOnly('First'), cardTagOnly('Second')]);
    const state = stateWithCursor(doc, findTagEnd(doc));
    const next = apply(state, deleteAtTagEnd);
    expect(next).not.toBe(null);
    expect(next!.doc.childCount).toBe(1);
    const merged = next!.doc.child(0);
    expect(merged.type.name).toBe('card');
    expect(merged.firstChild!.textContent).toBe('FirstSecond');
  });

  it('prohibits when next paragraph is a card_body (non-tag)', () => {
    const doc = makeDoc([
      cardTagOnly('First'),
      schema.nodes['paragraph']!.create(null, schema.text('Loose')),
    ]);
    const state = stateWithCursor(doc, findTagEnd(doc));
    expect(apply(state, deleteAtTagEnd)).toBe(null);
  });

  it('prohibits when current card has cite/body (next is not adjacent tag)', () => {
    const doc = makeDoc([
      cardTagBody('First', 'body'),
      cardTagOnly('Second'),
    ]);
    const state = stateWithCursor(doc, findTagEnd(doc));
    // The next paragraph after end-of-tag is the card_body — not a tag.
    expect(apply(state, deleteAtTagEnd)).toBe(null);
  });
});

// ----- Enter mid-tag (split) -----

describe('enterMidTag', () => {
  it('does not apply at end of tag', () => {
    const doc = makeDoc([cardTagOnly('Tag')]);
    const state = stateWithCursor(doc, findTagEnd(doc));
    expect(apply(state, enterMidTag)).toBe(null);
  });

  it('splits a tag-only card mid-content', () => {
    const doc = makeDoc([cardTagOnly('AB')]);
    const state = stateWithCursor(doc, findTagStart(doc) + 1); // between A and B
    const next = apply(state, enterMidTag);
    expect(next).not.toBe(null);
    expect(next!.doc.childCount).toBe(2);
    expect(next!.doc.child(0).firstChild!.textContent).toBe('A');
    expect(next!.doc.child(1).firstChild!.textContent).toBe('B');
  });

  it('split preserves cite/body with the original (post-cursor) card', () => {
    const doc = makeDoc([cardTagBody('AB', 'body text')]);
    const state = stateWithCursor(doc, findTagStart(doc) + 1);
    const next = apply(state, enterMidTag);
    expect(next).not.toBe(null);
    expect(next!.doc.childCount).toBe(2);
    // First card: just the new tag with pre-cursor content
    const firstCard = next!.doc.child(0);
    expect(firstCard.childCount).toBe(1);
    expect(firstCard.firstChild!.textContent).toBe('A');
    // Second card: post-cursor tag + the original body
    const secondCard = next!.doc.child(1);
    expect(secondCard.childCount).toBe(2);
    expect(secondCard.firstChild!.textContent).toBe('B');
    expect(secondCard.lastChild!.textContent).toBe('body text');
  });

  it('split at start (cursor offset 0) creates an empty tag before', () => {
    const doc = makeDoc([cardTagBody('ABC', 'body')]);
    const state = stateWithCursor(doc, findTagStart(doc));
    const next = apply(state, enterMidTag);
    expect(next).not.toBe(null);
    expect(next!.doc.childCount).toBe(2);
    expect(next!.doc.child(0).firstChild!.textContent).toBe('');
    expect(next!.doc.child(1).firstChild!.textContent).toBe('ABC');
    expect(next!.doc.child(1).lastChild!.textContent).toBe('body');
  });

  it('new and original tags have distinct heading IDs', () => {
    const doc = makeDoc([cardTagOnly('AB')]);
    const state = stateWithCursor(doc, findTagStart(doc) + 1);
    const next = apply(state, enterMidTag);
    expect(next).not.toBe(null);
    const id1 = next!.doc.child(0).firstChild!.attrs['id'];
    const id2 = next!.doc.child(1).firstChild!.attrs['id'];
    expect(id1).not.toBe(id2);
    expect(typeof id1).toBe('string');
    expect((id1 as string).length).toBeGreaterThan(0);
    expect(typeof id2).toBe('string');
  });
});

// ----- Enter at end of tag -----

describe('enterAtTagEnd', () => {
  it('does not apply when not at end of tag', () => {
    const doc = makeDoc([cardTagOnly('Tag')]);
    const state = stateWithCursor(doc, findTagStart(doc) + 1);
    expect(apply(state, enterAtTagEnd)).toBe(null);
  });

  it('appends a new card_body and moves cursor into it', () => {
    const doc = makeDoc([cardTagOnly('Tag')]);
    const state = stateWithCursor(doc, findTagEnd(doc));
    const next = apply(state, enterAtTagEnd);
    expect(next).not.toBe(null);
    const card = next!.doc.child(0);
    expect(card.childCount).toBe(2); // tag + card_body
    expect(card.lastChild!.type.name).toBe('card_body');
    expect(card.lastChild!.textContent).toBe('');
    // Cursor should now be inside the card_body
    const sel = next!.selection;
    expect(sel.$from.parent.type.name).toBe('card_body');
  });

  it('appends card_body even when card already has a body', () => {
    const doc = makeDoc([cardTagBody('Tag', 'existing body')]);
    const state = stateWithCursor(doc, findTagEnd(doc));
    const next = apply(state, enterAtTagEnd);
    expect(next).not.toBe(null);
    const card = next!.doc.child(0);
    expect(card.childCount).toBe(3); // tag + existing body + new body
  });
});

// ----- Analytic equivalence -----

describe('analytic boundary edits behave like tag', () => {
  function analyticUnitWith(text: string) {
    return schema.nodes['analytic_unit']!.createChecked(null, [
      schema.nodes['analytic']!.create({ id: newHeadingId() }, schema.text(text)),
    ]);
  }

  it('Backspace at start of analytic deletes blank previous paragraph', () => {
    const doc = makeDoc([paragraph('   '), analyticUnitWith('hello')]);
    const state = stateWithCursor(doc, findTagStart(doc));
    const next = apply(state, backspaceAtTagStart);
    expect(next).not.toBe(null);
    expect(next!.doc.childCount).toBe(1);
  });

  it('Enter mid-analytic splits into two analytic_units', () => {
    const doc = makeDoc([analyticUnitWith('AB')]);
    const state = stateWithCursor(doc, findTagStart(doc) + 1);
    const next = apply(state, enterMidTag);
    expect(next).not.toBe(null);
    expect(next!.doc.childCount).toBe(2);
    expect(next!.doc.child(0).type.name).toBe('analytic_unit');
    expect(next!.doc.child(1).type.name).toBe('analytic_unit');
  });
});
