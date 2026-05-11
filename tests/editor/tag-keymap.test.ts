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
  deleteAtContainerEnd,
  enterMidTag,
  enterAtTagEnd,
  enterInHeading,
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

  it('merges with previous tag when both are non-blank', () => {
    const doc = makeDoc([cardTagOnly('First'), cardTagOnly('Second')]);
    const state = stateWithCursor(doc, findTagStart(doc, 1));
    const next = apply(state, backspaceAtTagStart);
    expect(next).not.toBe(null);
    expect(next!.doc.childCount).toBe(1);
    expect(next!.doc.child(0).firstChild!.textContent).toBe('FirstSecond');
  });

  it('merges previous tag-only card with current card body intact', () => {
    const doc = makeDoc([
      cardTagOnly('First'),
      cardTagBody('Second', 'body text'),
    ]);
    const state = stateWithCursor(doc, findTagStart(doc, 1));
    const next = apply(state, backspaceAtTagStart);
    expect(next).not.toBe(null);
    expect(next!.doc.childCount).toBe(1);
    const card = next!.doc.child(0);
    expect(card.firstChild!.textContent).toBe('FirstSecond');
    expect(card.lastChild!.type.name).toBe('card_body');
    expect(card.lastChild!.textContent).toBe('body text');
  });

  it('deletes a preceding card whose only-tag is blank (no merge)', () => {
    // Blank wins over merge: even though the preceding card has only a
    // tag (which would normally trigger a tag-into-tag merge), the
    // tag's content is empty, so we just delete the card. End result
    // is the same as a merge would produce because the blank content
    // contributes nothing, but the *operation* is simpler and matches
    // the user's mental model of "remove the empty thing ahead of me."
    const doc = makeDoc([
      cardTagOnly(''),
      cardTagOnly('Second'),
    ]);
    const state = stateWithCursor(doc, findTagStart(doc, 1));
    const next = apply(state, backspaceAtTagStart);
    expect(next).not.toBe(null);
    expect(next!.doc.childCount).toBe(1);
    expect(next!.doc.child(0).firstChild!.textContent).toBe('Second');
  });

  it('backspace merge places cursor at the merge point', () => {
    const doc = makeDoc([cardTagOnly('First'), cardTagOnly('Second')]);
    const state = stateWithCursor(doc, findTagStart(doc, 1));
    const next = apply(state, backspaceAtTagStart);
    expect(next).not.toBe(null);
    const sel = next!.selection;
    expect(sel.$from.parent.type.name).toBe('tag');
    // Merged tag is "FirstSecond"; cursor at boundary = parentOffset 5.
    expect(sel.$from.parentOffset).toBe(5);
  });

  it('does not apply when the tag is at the very start of the doc', () => {
    const doc = makeDoc([cardTagOnly('First')]);
    const state = stateWithCursor(doc, findTagStart(doc));
    // Returns false (not handled) so default Backspace can fall through.
    let handled = false;
    backspaceAtTagStart(state, () => { handled = true; });
    expect(handled).toBe(false);
  });

  it('deletes an empty tag-only card on Backspace (no body)', () => {
    const doc = makeDoc([
      paragraph('before'),
      cardTagOnly(''),
    ]);
    const state = stateWithCursor(doc, findTagStart(doc));
    const next = apply(state, backspaceAtTagStart);
    expect(next).not.toBe(null);
    expect(next!.doc.childCount).toBe(1);
    expect(next!.doc.child(0).type.name).toBe('paragraph');
  });

  it('empty tag with a body, no prev container: body lifts to doc level', () => {
    const doc = makeDoc([
      cardWith(
        tag(''),
        schema.nodes['card_body']!.create(null, schema.text('body')),
      ),
    ]);
    const state = stateWithCursor(doc, findTagStart(doc));
    const next = apply(state, backspaceAtTagStart);
    expect(next).not.toBe(null);
    // Empty tag and its card wrapper are gone; body lifts to doc level.
    expect(next!.doc.childCount).toBe(1);
    expect(next!.doc.child(0).type.name).toBe('card_body');
    expect(next!.doc.child(0).textContent).toBe('body');
  });

  it('empty tag with a body, prev is a card: body merges into the prev card', () => {
    const doc = makeDoc([
      cardTagBody('PrevTag', 'PrevBody'),
      cardWith(
        tag(''),
        schema.nodes['card_body']!.create(null, schema.text('newBody')),
      ),
    ]);
    const state = stateWithCursor(doc, findTagStart(doc, 1));
    const next = apply(state, backspaceAtTagStart);
    expect(next).not.toBe(null);
    expect(next!.doc.childCount).toBe(1);
    const card = next!.doc.firstChild!;
    const types: string[] = [];
    card.forEach((c) => types.push(c.type.name));
    expect(types).toEqual(['tag', 'card_body', 'card_body']);
    expect(card.child(0).textContent).toBe('PrevTag');
    expect(card.child(1).textContent).toBe('PrevBody');
    expect(card.child(2).textContent).toBe('newBody');
  });

  it('replaces empty tag-only card with paragraph when it is the only doc child', () => {
    const doc = makeDoc([cardTagOnly('')]);
    const state = stateWithCursor(doc, findTagStart(doc));
    const next = apply(state, backspaceAtTagStart);
    expect(next).not.toBe(null);
    // Doc must have a textblock for cursor to land — we replace with
    // an empty paragraph rather than leave the doc with zero children.
    expect(next!.doc.childCount).toBe(1);
    expect(next!.doc.child(0).type.name).toBe('paragraph');
    expect(next!.doc.child(0).content.size).toBe(0);
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

  it('preserves the next card body when merging via forward-delete', () => {
    const doc = makeDoc([
      cardTagOnly('First'),
      cardTagBody('Second', 'body text'),
    ]);
    const state = stateWithCursor(doc, findTagEnd(doc));
    const next = apply(state, deleteAtTagEnd);
    expect(next).not.toBe(null);
    expect(next!.doc.childCount).toBe(1);
    const card = next!.doc.child(0);
    expect(card.firstChild!.textContent).toBe('FirstSecond');
    expect(card.lastChild!.type.name).toBe('card_body');
    expect(card.lastChild!.textContent).toBe('body text');
  });

  it('forward-delete merge places cursor at the merge point', () => {
    const doc = makeDoc([cardTagOnly('First'), cardTagOnly('Second')]);
    const state = stateWithCursor(doc, findTagEnd(doc));
    const next = apply(state, deleteAtTagEnd);
    expect(next).not.toBe(null);
    // The merged tag is "FirstSecond"; cursor should sit between
    // "First" and "Second" — parentOffset === 5.
    const sel = next!.selection;
    expect(sel.$from.parent.type.name).toBe('tag');
    expect(sel.$from.parentOffset).toBe(5);
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

  it('deletes an empty tag-only card on Delete (no body)', () => {
    const doc = makeDoc([
      cardTagOnly(''),
      paragraph('after'),
    ]);
    const state = stateWithCursor(doc, findTagEnd(doc));
    const next = apply(state, deleteAtTagEnd);
    expect(next).not.toBe(null);
    expect(next!.doc.childCount).toBe(1);
    expect(next!.doc.child(0).type.name).toBe('paragraph');
  });

  it('Delete on empty tag with a body, no prev container: body lifts to doc level', () => {
    const doc = makeDoc([
      cardWith(
        tag(''),
        schema.nodes['card_body']!.create(null, schema.text('body')),
      ),
    ]);
    const state = stateWithCursor(doc, findTagEnd(doc));
    const next = apply(state, deleteAtTagEnd);
    expect(next).not.toBe(null);
    expect(next!.doc.childCount).toBe(1);
    expect(next!.doc.child(0).type.name).toBe('card_body');
    expect(next!.doc.child(0).textContent).toBe('body');
  });

  it('Delete on empty tag with a body, prev is a card: body merges into the prev card', () => {
    const doc = makeDoc([
      cardTagBody('PrevTag', 'PrevBody'),
      cardWith(
        tag(''),
        schema.nodes['card_body']!.create(null, schema.text('newBody')),
      ),
    ]);
    const state = stateWithCursor(doc, findTagEnd(doc, 1));
    const next = apply(state, deleteAtTagEnd);
    expect(next).not.toBe(null);
    expect(next!.doc.childCount).toBe(1);
    const card = next!.doc.firstChild!;
    const types: string[] = [];
    card.forEach((c) => types.push(c.type.name));
    expect(types).toEqual(['tag', 'card_body', 'card_body']);
    expect(card.child(2).textContent).toBe('newBody');
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

  it('inserts new body BEFORE existing body, directly below the tag', () => {
    const doc = makeDoc([cardTagBody('Tag', 'existing body')]);
    const state = stateWithCursor(doc, findTagEnd(doc));
    const next = apply(state, enterAtTagEnd);
    expect(next).not.toBe(null);
    const card = next!.doc.child(0);
    expect(card.childCount).toBe(3); // tag + new (empty) body + existing body
    expect(card.child(0).type.name).toBe('tag');
    expect(card.child(1).type.name).toBe('card_body');
    expect(card.child(1).textContent).toBe('');
    expect(card.child(2).type.name).toBe('card_body');
    expect(card.child(2).textContent).toBe('existing body');
  });

  it('inserts new body BEFORE the cite (above any pre-existing content)', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('Tag'),
        schema.nodes['cite_paragraph']!.create(null, schema.text('Author 2024')),
        schema.nodes['card_body']!.create(null, schema.text('body')),
      ]),
    ]);
    const state = stateWithCursor(doc, findTagEnd(doc));
    const next = apply(state, enterAtTagEnd);
    expect(next).not.toBe(null);
    const card = next!.doc.child(0);
    expect(card.childCount).toBe(4);
    expect(card.child(0).type.name).toBe('tag');
    expect(card.child(1).type.name).toBe('card_body');
    expect(card.child(1).textContent).toBe(''); // new empty body, ABOVE cite
    expect(card.child(2).type.name).toBe('cite_paragraph');
    expect(card.child(3).type.name).toBe('card_body');
    expect(card.child(3).textContent).toBe('body');
  });

  it('inserts new body BEFORE undertags too', () => {
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('Tag'),
        schema.nodes['undertag']!.create(null, schema.text('Sub-tag')),
        schema.nodes['card_body']!.create(null, schema.text('body')),
      ]),
    ]);
    const state = stateWithCursor(doc, findTagEnd(doc));
    const next = apply(state, enterAtTagEnd);
    expect(next).not.toBe(null);
    const card = next!.doc.child(0);
    expect(card.childCount).toBe(4);
    expect(card.child(0).type.name).toBe('tag');
    expect(card.child(1).type.name).toBe('card_body');
    expect(card.child(1).textContent).toBe(''); // new empty body, ABOVE undertag
    expect(card.child(2).type.name).toBe('undertag');
    expect(card.child(3).type.name).toBe('card_body');
  });
});

// ----- Enter in Pocket / Hat / Block -----

describe('enterInHeading', () => {
  function hat(text: string) {
    return schema.nodes['hat']!.create({ id: newHeadingId() }, schema.text(text));
  }
  function pocket(text: string) {
    return schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text(text));
  }

  function findHeadingStart(d: ReturnType<typeof makeDoc>, typeName: string, n = 0): number {
    let count = 0;
    let pos = -1;
    d.descendants((node, p) => {
      if (node.type.name === typeName) {
        if (count === n) pos = p + 1;
        count++;
      }
      return true;
    });
    if (pos < 0) throw new Error(`${typeName} #${n} not found`);
    return pos;
  }

  function findHeadingEnd(d: ReturnType<typeof makeDoc>, typeName: string, n = 0): number {
    let count = 0;
    let pos = -1;
    d.descendants((node, p) => {
      if (node.type.name === typeName) {
        if (count === n) pos = p + 1 + node.content.size;
        count++;
      }
      return true;
    });
    if (pos < 0) throw new Error(`${typeName} #${n} not found`);
    return pos;
  }

  it('Enter at end of Hat creates a Normal paragraph after', () => {
    const doc = makeDoc([block('Section'), hat('A hat')]);
    const state = stateWithCursor(doc, findHeadingEnd(doc, 'hat'));
    const next = apply(state, enterInHeading);
    expect(next).not.toBe(null);
    expect(next!.doc.childCount).toBe(3);
    expect(next!.doc.child(2).type.name).toBe('paragraph');
    expect(next!.doc.child(2).textContent).toBe('');
    // Cursor should be inside the new paragraph.
    expect(next!.selection.$from.parent.type.name).toBe('paragraph');
  });

  it('Enter at end of Block creates a Normal paragraph after', () => {
    const doc = makeDoc([block('A block')]);
    const state = stateWithCursor(doc, findHeadingEnd(doc, 'block'));
    const next = apply(state, enterInHeading);
    expect(next).not.toBe(null);
    expect(next!.doc.childCount).toBe(2);
    expect(next!.doc.child(1).type.name).toBe('paragraph');
  });

  it('Enter at end of Pocket creates a Normal paragraph after', () => {
    const doc = makeDoc([pocket('A pocket')]);
    const state = stateWithCursor(doc, findHeadingEnd(doc, 'pocket'));
    const next = apply(state, enterInHeading);
    expect(next).not.toBe(null);
    expect(next!.doc.childCount).toBe(2);
    expect(next!.doc.child(1).type.name).toBe('paragraph');
  });

  it('Enter at start of Hat creates an empty Hat above (same type)', () => {
    const doc = makeDoc([hat('A hat')]);
    const state = stateWithCursor(doc, findHeadingStart(doc, 'hat'));
    const next = apply(state, enterInHeading);
    expect(next).not.toBe(null);
    expect(next!.doc.childCount).toBe(2);
    expect(next!.doc.child(0).type.name).toBe('hat');
    expect(next!.doc.child(0).textContent).toBe('');
    expect(next!.doc.child(1).type.name).toBe('hat');
    expect(next!.doc.child(1).textContent).toBe('A hat');
  });

  it('Enter at start of Block creates an empty Block above (same type)', () => {
    const doc = makeDoc([block('A block')]);
    const state = stateWithCursor(doc, findHeadingStart(doc, 'block'));
    const next = apply(state, enterInHeading);
    expect(next).not.toBe(null);
    expect(next!.doc.childCount).toBe(2);
    expect(next!.doc.child(0).type.name).toBe('block');
    expect(next!.doc.child(0).textContent).toBe('');
    expect(next!.doc.child(1).type.name).toBe('block');
  });

  it('Enter mid-Hat splits into two Hats', () => {
    const doc = makeDoc([hat('AB')]);
    const state = stateWithCursor(doc, findHeadingStart(doc, 'hat') + 1);
    const next = apply(state, enterInHeading);
    expect(next).not.toBe(null);
    expect(next!.doc.childCount).toBe(2);
    expect(next!.doc.child(0).type.name).toBe('hat');
    expect(next!.doc.child(0).textContent).toBe('A');
    expect(next!.doc.child(1).type.name).toBe('hat');
    expect(next!.doc.child(1).textContent).toBe('B');
  });

  it('Enter mid-Hat places cursor at start of post-cursor heading', () => {
    const doc = makeDoc([hat('AB')]);
    const state = stateWithCursor(doc, findHeadingStart(doc, 'hat') + 1);
    const next = apply(state, enterInHeading);
    expect(next).not.toBe(null);
    const sel = next!.selection;
    expect(sel.$from.parent.type.name).toBe('hat');
    expect(sel.$from.parent.textContent).toBe('B');
    expect(sel.$from.parentOffset).toBe(0);
  });

  it('does not apply when cursor is not in a heading', () => {
    const doc = makeDoc([cardTagOnly('Tag')]);
    const state = stateWithCursor(doc, findTagStart(doc));
    expect(apply(state, enterInHeading)).toBe(null);
  });
});

// ----- Regression: splitBlock at start of cite_paragraph -----

describe('splitBlock at start of cite_paragraph (default Enter)', () => {
  it('creates a card_body, NOT an undertag, above the cite', async () => {
    // Bug: prior schema content order put `undertag` first in the
    // alternation, so ProseMirror's defaultBlockAt picked undertag as
    // the type for newly-created paragraphs. The card content
    // expression now puts card_body first.
    const { splitBlock } = await import('prosemirror-commands');
    const doc = makeDoc([
      schema.nodes['card']!.createChecked(null, [
        tag('Tag'),
        schema.nodes['cite_paragraph']!.create(null, schema.text('Cite')),
      ]),
    ]);
    let citeStart = -1;
    doc.descendants((node, pos) => {
      if (node.type.name === 'cite_paragraph' && citeStart < 0) citeStart = pos + 1;
    });
    const state = stateWithCursor(doc, citeStart);
    const next = apply(state, splitBlock);
    expect(next).not.toBe(null);
    const card = next!.doc.child(0);
    expect(card.childCount).toBe(3);
    expect(card.child(0).type.name).toBe('tag');
    expect(card.child(1).type.name).toBe('card_body');
    expect(card.child(2).type.name).toBe('cite_paragraph');
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

// ----- Delete forward at end of last body in a container -----

describe('deleteAtContainerEnd', () => {
  function endOfLastBody(doc: ReturnType<typeof makeDoc>, containerIdx = 0): number {
    let count = 0;
    let pos = -1;
    doc.descendants((n, p) => {
      if (n.type.name === 'card' || n.type.name === 'analytic_unit') {
        if (count === containerIdx) {
          const last = n.lastChild!;
          // last child's start = container start + 1 (open) + sum of prev sizes
          let off = 1;
          for (let i = 0; i < n.childCount - 1; i++) off += n.child(i).nodeSize;
          pos = p + off + 1 + last.content.size;
        }
        count++;
        return false; // don't descend into the container — siblings inside it would confuse indexing
      }
      return true;
    });
    if (pos < 0) throw new Error(`container #${containerIdx} not found`);
    return pos;
  }

  it('absorbs the next card when its tag is blank', () => {
    const doc = makeDoc([
      cardTagBody('Tag1', 'body1'),
      cardWith(
        tag(''),
        schema.nodes['card_body']!.create(null, schema.text('body2')),
      ),
    ]);
    const state = stateWithCursor(doc, endOfLastBody(doc, 0));
    const next = apply(state, deleteAtContainerEnd);
    expect(next).not.toBe(null);
    expect(next!.doc.childCount).toBe(1);
    const card = next!.doc.firstChild!;
    const types: string[] = [];
    card.forEach((c) => types.push(c.type.name));
    expect(types).toEqual(['tag', 'card_body', 'card_body']);
    expect(card.child(0).textContent).toBe('Tag1');
    expect(card.child(1).textContent).toBe('body1');
    expect(card.child(2).textContent).toBe('body2');
  });

  it('no-op when next card has a non-empty tag (prohibits destructive merge)', () => {
    const doc = makeDoc([
      cardTagBody('Tag1', 'body1'),
      cardTagBody('Tag2', 'body2'),
    ]);
    const state = stateWithCursor(doc, endOfLastBody(doc, 0));
    const next = apply(state, deleteAtContainerEnd);
    // Returned true (handled / swallowed) without dispatching → apply returns null.
    expect(next).toBe(null);
    expect(state.doc.childCount).toBe(2);
  });

  it('no-op when next sibling is a heading (prohibits destructive merge)', () => {
    const doc = makeDoc([
      cardTagBody('Tag1', 'body1'),
      block('A block'),
    ]);
    const state = stateWithCursor(doc, endOfLastBody(doc, 0));
    const next = apply(state, deleteAtContainerEnd);
    expect(next).toBe(null);
  });

  it('returns false (lets default handle) when there is no next sibling', () => {
    const doc = makeDoc([cardTagBody('T', 'only body')]);
    const state = stateWithCursor(doc, endOfLastBody(doc, 0));
    const next = apply(state, deleteAtContainerEnd);
    expect(next).toBe(null); // apply() returns null for false too
    // Doc unchanged so far.
    expect(state.doc.childCount).toBe(1);
  });

  it('cross-type: card with blank tag absorbs into prev analytic_unit (with cite_paragraph passthrough)', () => {
    const cite = schema.nodes['cite_paragraph']!.create(
      null,
      schema.text('Author 24', [schema.marks['cite_mark']!.create()]),
    );
    const doc = makeDoc([
      schema.nodes['analytic_unit']!.createChecked(null, [
        schema.nodes['analytic']!.create({ id: newHeadingId() }, schema.text('A')),
        schema.nodes['card_body']!.create(null, schema.text('body')),
      ]),
      schema.nodes['card']!.createChecked(null, [
        tag(''),
        cite,
        schema.nodes['card_body']!.create(null, schema.text('extra')),
      ]),
    ]);
    const state = stateWithCursor(doc, endOfLastBody(doc, 0));
    const next = apply(state, deleteAtContainerEnd);
    expect(next).not.toBe(null);
    expect(next!.doc.childCount).toBe(1);
    const unit = next!.doc.firstChild!;
    expect(unit.type.name).toBe('analytic_unit');
    const types: string[] = [];
    unit.forEach((c) => types.push(c.type.name));
    expect(types).toEqual(['analytic', 'card_body', 'cite_paragraph', 'card_body']);
  });

  it('only fires when cursor is at the end of the LAST child', () => {
    const doc = makeDoc([
      cardWith(
        tag('T'),
        schema.nodes['card_body']!.create(null, schema.text('first')),
        schema.nodes['card_body']!.create(null, schema.text('second')),
      ),
      cardWith(tag(''), schema.nodes['card_body']!.create(null, schema.text('next'))),
    ]);
    // Cursor at end of "first" (which is NOT the last body of card1).
    let pos = -1;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'first') pos = p + n.nodeSize;
      return true;
    });
    const state = stateWithCursor(doc, pos);
    const next = apply(state, deleteAtContainerEnd);
    // Not applicable (not last child) → returns false → apply gets null.
    expect(next).toBe(null);
    expect(state.doc.childCount).toBe(2);
  });
});
