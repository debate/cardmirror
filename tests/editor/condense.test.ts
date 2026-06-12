/**
 * Condense / Uncondense / Toggle Case — Verbatim parity tests.
 *
 * Covers the F3 family: Branch C (paragraph integrity), Branch A
 * (merge no pilcrows), Branch B (merge with pilcrows), respectHeadings
 * true / false, no-selection in-card, Uncondense, and toggleCase.
 */

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  condenseBranchC,
  condenseMerge,
  uncondense,
  toggleCase,
  makePilcrowText,
  PILCROW_CHAR,
  PILCROW_HALF_POINTS,
} from '../../src/editor/condense.js';

// ---- Builders ----

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
  return schema.nodes['cite_paragraph']!.create(
    null,
    schema.text(text, [schema.marks['cite_mark']!.create()]),
  );
}
function undertagOf(text: string) {
  return schema.nodes['undertag']!.create(null, schema.text(text));
}
function card(...children: import('prosemirror-model').Node[]) {
  return schema.nodes['card']!.createChecked(null, children);
}
function makeDoc(children: import('prosemirror-model').Node[]) {
  return schema.nodes['doc']!.createChecked(null, children);
}

function apply(state: EditorState, cmd: Command): EditorState | null {
  let next: EditorState | null = null;
  const ok = cmd(state, (tr) => { next = state.apply(tr); });
  return ok ? next : null;
}

function setCursorIn(
  doc: import('prosemirror-model').Node,
  find: (node: import('prosemirror-model').Node) => boolean,
  offsetInside = 0,
): EditorState {
  let pos = -1;
  doc.descendants((node, p) => {
    if (pos !== -1) return false;
    if (find(node)) { pos = p + 1 + offsetInside; return false; }
    return true;
  });
  if (pos < 0) throw new Error('cursor target not found');
  const state = EditorState.create({ doc });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}

function setSelectionRange(
  doc: import('prosemirror-model').Node,
  fromText: string,
  fromOffset: number,
  toText: string,
  toOffset: number,
): EditorState {
  let from = -1;
  let to = -1;
  doc.descendants((n, p) => {
    if (!n.isText) return;
    if (from === -1 && (n.text ?? '').includes(fromText)) {
      from = p + (n.text ?? '').indexOf(fromText) + fromOffset;
    }
    if ((n.text ?? '').includes(toText)) {
      to = p + (n.text ?? '').indexOf(toText) + toOffset;
    }
  });
  if (from < 0 || to < 0) throw new Error(`positions not found: from='${fromText}' to='${toText}'`);
  const state = EditorState.create({ doc });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
}

// ---- Branch C: paragraph integrity ----

describe('condenseBranchC — paragraph integrity preserved', () => {
  it('collapses multiple spaces within a paragraph', () => {
    const doc = makeDoc([paragraph('hello    world')]);
    const state = setCursorIn(doc, (n) => n.type.name === 'paragraph');
    const next = apply(state, condenseBranchC());
    // Cursor at doc-level no-op? scope is "current card or analytic_unit".
    // For a doc-level paragraph, no enclosing container → no-op.
    expect(next).toBeNull();
  });

  it('with selection, collapses spaces in selected paragraph', () => {
    const doc = makeDoc([paragraph('hello    world')]);
    const state = setSelectionRange(doc, 'hello', 0, 'world', 5);
    const next = apply(state, condenseBranchC());
    expect(next).not.toBeNull();
    expect(next!.doc.firstChild!.textContent).toBe('hello world');
  });

  it('converts tabs and NBSPs to single spaces', () => {
    const doc = makeDoc([paragraph('a\tb c   d')]);
    const state = setSelectionRange(doc, 'a', 0, 'd', 1);
    const next = apply(state, condenseBranchC());
    expect(next!.doc.firstChild!.textContent).toBe('a b c d');
  });

  it('strips leading spaces but preserves trailing', () => {
    const doc = makeDoc([paragraph('   hello ')]);
    const state = setSelectionRange(doc, 'hello', -3, 'hello', 6);
    const next = apply(state, condenseBranchC());
    expect(next!.doc.firstChild!.textContent).toBe('hello ');
  });

  it('cursor inside a card cleans every textblock in the card', () => {
    const doc = makeDoc([
      card(
        tag('the    tag'),
        citePara('Smith    2024'),
        cardBody('body    text'),
      ),
    ]);
    const state = setCursorIn(doc, (n) => n.type.name === 'card_body');
    const next = apply(state, condenseBranchC());
    expect(next).not.toBeNull();
    const c = next!.doc.firstChild!;
    expect(c.child(0).textContent).toBe('the tag');
    expect(c.child(1).textContent).toBe('Smith 2024');
    expect(c.child(2).textContent).toBe('body text');
  });

  it('removes empty card_body paragraphs between content paragraphs', () => {
    // Mirror Verbatim's ^p^p collapse: tag, body, EMPTY body, body
    // becomes tag, body, body. (Empty middle card_body removed.)
    const doc = makeDoc([
      card(tag('Tag'), cardBody('first'), cardBody(''), cardBody('second')),
    ]);
    const state = setCursorIn(doc, (n) => n.type.name === 'tag');
    const next = apply(state, condenseBranchC());
    expect(next).not.toBeNull();
    const c = next!.doc.firstChild!;
    const names: string[] = [];
    c.forEach((ch) => names.push(ch.type.name));
    expect(names).toEqual(['tag', 'card_body', 'card_body']);
    expect(c.child(1).textContent).toBe('first');
    expect(c.child(2).textContent).toBe('second');
  });

  it('removes whitespace-only card_body paragraphs (treated as empty)', () => {
    const doc = makeDoc([
      card(tag('Tag'), cardBody('first'), cardBody('   '), cardBody('second')),
    ]);
    const state = setCursorIn(doc, (n) => n.type.name === 'tag');
    const next = apply(state, condenseBranchC());
    expect(next).not.toBeNull();
    const c = next!.doc.firstChild!;
    expect(c.childCount).toBe(3); // tag + 2 bodies
    expect(c.child(1).textContent).toBe('first');
    expect(c.child(2).textContent).toBe('second');
  });

  it('does NOT remove empty tag / cite_paragraph / undertag (structural placeholders)', () => {
    // Tag and structural body slots stay even when empty — they're
    // intentional placeholders, and removing an empty tag would
    // dissolve the card.
    const doc = makeDoc([
      card(
        tag(''),
        schema.nodes['cite_paragraph']!.create(null, []),
        schema.nodes['undertag']!.create(null, []),
        cardBody('body'),
      ),
    ]);
    const state = setCursorIn(doc, (n) => n.type.name === 'card_body');
    const next = apply(state, condenseBranchC());
    // No structural removal; just possibly content clean. Structure same.
    if (next) {
      const c = next.doc.firstChild!;
      const names: string[] = [];
      c.forEach((ch) => names.push(ch.type.name));
      expect(names).toEqual(['tag', 'cite_paragraph', 'undertag', 'card_body']);
    }
  });

  it('preserves marks across cleaned ranges', () => {
    const boldNode = schema.text('bold  word', [schema.marks['bold']!.create()]);
    const p = schema.nodes['paragraph']!.create(null, [
      schema.text('plain  '),
      boldNode,
    ]);
    const doc = makeDoc([p]);
    const state = setSelectionRange(doc, 'plain', 0, 'word', 4);
    const next = apply(state, condenseBranchC());
    // After cleanup: "plain " + "bold word"
    expect(next!.doc.firstChild!.textContent).toBe('plain bold word');
    // Bold mark preserved on the bold portion.
    let foundBold = false;
    next!.doc.descendants((n) => {
      if (n.isText && (n.text ?? '').includes('bold')) {
        if (n.marks.some((m) => m.type.name === 'bold')) foundBold = true;
      }
    });
    expect(foundBold).toBe(true);
  });
});

// ---- No-selection in-card: Branch A / B ----

describe('condenseMerge — no selection, cursor in card', () => {
  it('Branch A: merges consecutive card_body runs, preserves tag/cite/undertag', () => {
    const doc = makeDoc([
      card(
        tag('Tag'),
        citePara('Source 2024'),
        cardBody('first body'),
        cardBody('second body'),
        undertagOf('a note'),
        cardBody('third body'),
      ),
    ]);
    const state = setCursorIn(doc, (n) => n.type.name === 'card_body');
    const next = apply(state, condenseMerge({ withPilcrows: false, headingMode: 'respect' }));
    expect(next).not.toBeNull();
    const c = next!.doc.firstChild!;
    // Expected: [Tag, Cite, mergedBody1+2, undertag, body3]
    const names: string[] = [];
    c.forEach((ch) => names.push(ch.type.name));
    expect(names).toEqual(['tag', 'cite_paragraph', 'card_body', 'undertag', 'card_body']);
    expect(c.child(2).textContent).toBe('first body second body');
    expect(c.child(4).textContent).toBe('third body');
  });

  it('Branch B: uses a ¶ run with the non-inclusive pilcrow_marker mark', () => {
    const doc = makeDoc([
      card(tag('Tag'), cardBody('a'), cardBody('b')),
    ]);
    const state = setCursorIn(doc, (n) => n.type.name === 'card_body');
    const next = apply(state, condenseMerge({ withPilcrows: true, headingMode: 'respect' }));
    const merged = next!.doc.firstChild!.child(1);
    expect(merged.textContent).toBe(`a${PILCROW_CHAR}b`);
    // The ¶ run carries pilcrow_marker (non-inclusive) so adjacent
    // typing isn't affected by the 6-pt rendering. No font_size mark.
    let foundMarker = false;
    let foundFontSize = false;
    merged.forEach((c) => {
      if (c.isText && c.text === PILCROW_CHAR) {
        if (c.marks.some((m) => m.type.name === 'pilcrow_marker')) foundMarker = true;
        if (c.marks.some((m) => m.type.name === 'font_size')) foundFontSize = true;
      }
    });
    expect(foundMarker).toBe(true);
    expect(foundFontSize).toBe(false);
  });

  it('PILCROW_HALF_POINTS sanity', () => {
    // Round-trip OOXML still uses 6pt = halfPoints 12 (the exporter
    // writes this value for pilcrow_marker; importer recognizes it).
    expect(PILCROW_HALF_POINTS).toBe(12);
  });

  it('does not merge if there are no consecutive collapsible runs', () => {
    const doc = makeDoc([
      card(tag('Tag'), citePara('Cite'), cardBody('only body')),
    ]);
    const state = setCursorIn(doc, (n) => n.type.name === 'card_body');
    // Single card_body → no merging needed.
    const next = apply(state, condenseMerge({ withPilcrows: false, headingMode: 'respect' }));
    // Either no-op or just whitespace cleanup; in this case structure unchanged.
    if (next) {
      const c = next.doc.firstChild!;
      expect(c.childCount).toBe(3);
    }
  });

  it('cursor at doc-level: no-op', () => {
    const doc = makeDoc([paragraph('hello world')]);
    const state = setCursorIn(doc, (n) => n.type.name === 'paragraph');
    const next = apply(state, condenseMerge({ withPilcrows: false, headingMode: 'respect' }));
    expect(next).toBeNull();
  });
});

// ---- Selection-based, headingMode = 'respect' ----

describe("condenseMerge — selection, headingMode: 'respect'", () => {
  it('merges consecutive doc-level paragraphs into one', () => {
    const doc = makeDoc([
      paragraph('first'),
      paragraph('second'),
      paragraph('third'),
    ]);
    const state = setSelectionRange(doc, 'first', 0, 'third', 5);
    const next = apply(state, condenseMerge({ withPilcrows: false, headingMode: 'respect' }));
    expect(next).not.toBeNull();
    expect(next!.doc.childCount).toBe(1);
    expect(next!.doc.firstChild!.type.name).toBe('paragraph');
    expect(next!.doc.firstChild!.textContent).toBe('first second third');
  });

  it('preserves a tag in the middle of a selected run', () => {
    const doc = makeDoc([
      card(tag('Tag'), cardBody('one'), cardBody('two')),
    ]);
    const state = setSelectionRange(doc, 'Tag', 0, 'two', 3);
    const next = apply(state, condenseMerge({ withPilcrows: false, headingMode: 'respect' }));
    const c = next!.doc.firstChild!;
    const names: string[] = [];
    c.forEach((ch) => names.push(ch.type.name));
    expect(names).toEqual(['tag', 'card_body']);
    expect(c.child(0).textContent).toBe('Tag');
    expect(c.child(1).textContent).toBe('one two');
  });
});

// ---- Selection-based, headingMode = 'demolish' ----

describe("condenseMerge — selection, headingMode: 'demolish'", () => {
  it("user's example: selection mid-Body-A → mid-Body-B absorbs Card B into Card A", () => {
    const doc = makeDoc([
      card(tag('TagA'), citePara('CiteA'), cardBody('BodyAtextA')),
      card(tag('TagB'), citePara('CiteB'), cardBody('BodyBtextB')),
    ]);
    const state = setSelectionRange(doc, 'BodyAtextA', 5, 'BodyBtextB', 5);
    const next = apply(state, condenseMerge({ withPilcrows: false, headingMode: 'demolish' }));
    expect(next).not.toBeNull();
    // Result should be one card with [TagA, CiteA, merged-blob...].
    // The cite-classifier plugin (not present in test) would normally
    // re-classify the merged card_body as cite_paragraph since it
    // contains a cite_mark from CiteB; here we just verify structural
    // assumptions about the demolish path.
    const out = next!.doc;
    // Doc should not contain the original TagB anywhere as its own paragraph.
    let foundTagBAsTag = false;
    out.descendants((n) => {
      if (n.type.name === 'tag' && n.textContent === 'TagB') foundTagBAsTag = true;
    });
    expect(foundTagBAsTag).toBe(false);
  });

  it('merge target type = type of first touched paragraph', () => {
    const doc = makeDoc([
      paragraph('first'),
      card(tag('Tag'), cardBody('body')),
    ]);
    const state = setSelectionRange(doc, 'first', 0, 'body', 4);
    const next = apply(state, condenseMerge({ withPilcrows: false, headingMode: 'demolish' }));
    expect(next).not.toBeNull();
    // First touched = the doc-level paragraph; merged textblock has type paragraph.
    // (The card's tag and body get folded in as text.)
    const out = next!.doc;
    expect(out.firstChild!.type.name).toBe('paragraph');
  });

  it('preserves the first heading id when merging into a heading (nav stays linked)', () => {
    const pocket = schema.nodes['pocket']!.create({ id: 'pkt-keep' }, schema.text('Heading'));
    const doc = makeDoc([pocket, paragraph('after')]);
    const state = setSelectionRange(doc, 'Heading', 0, 'after', 5);
    const next = apply(state, condenseMerge({ withPilcrows: false, headingMode: 'demolish' }));
    expect(next).not.toBeNull();
    const merged = next!.doc.firstChild!;
    expect(merged.type.name).toBe('pocket');
    // The id used to be dropped (create(null, …)) → nav couldn't find the
    // merged heading. It must carry over from the first source.
    expect(merged.attrs['id']).toBe('pkt-keep');
  });
});

// ---- Selection-based, headingMode = 'strict' ----

describe("condenseMerge — selection, headingMode: 'strict'", () => {
  it('no-ops if the selection touches a tag', () => {
    const doc = makeDoc([
      card(tag('Tag'), cardBody('one'), cardBody('two')),
    ]);
    const state = setSelectionRange(doc, 'Tag', 0, 'two', 3);
    const next = apply(state, condenseMerge({ withPilcrows: false, headingMode: 'strict' }));
    expect(next).toBeNull();
  });

  it('no-ops if the selection touches a cite_paragraph', () => {
    const doc = makeDoc([
      card(tag('T'), citePara('Cite'), cardBody('body')),
    ]);
    const state = setSelectionRange(doc, 'Cite', 0, 'body', 4);
    const next = apply(state, condenseMerge({ withPilcrows: false, headingMode: 'strict' }));
    expect(next).toBeNull();
  });

  it('no-ops if the selection touches an undertag', () => {
    const doc = makeDoc([
      card(tag('T'), cardBody('one'), undertagOf('note'), cardBody('two')),
    ]);
    const state = setSelectionRange(doc, 'one', 0, 'two', 3);
    const next = apply(state, condenseMerge({ withPilcrows: false, headingMode: 'strict' }));
    expect(next).toBeNull();
  });

  it('merges body-only selections (behaves like respect when no structural elements touched)', () => {
    const doc = makeDoc([
      card(tag('Tag'), cardBody('one'), cardBody('two'), cardBody('three')),
    ]);
    const state = setSelectionRange(doc, 'one', 0, 'three', 5);
    const next = apply(state, condenseMerge({ withPilcrows: false, headingMode: 'strict' }));
    expect(next).not.toBeNull();
    const c = next!.doc.firstChild!;
    const names: string[] = [];
    c.forEach((ch) => names.push(ch.type.name));
    expect(names).toEqual(['tag', 'card_body']);
    expect(c.child(1).textContent).toBe('one two three');
  });

  it('merges doc-level paragraph runs (no structural span)', () => {
    const doc = makeDoc([paragraph('one'), paragraph('two')]);
    const state = setSelectionRange(doc, 'one', 0, 'two', 3);
    const next = apply(state, condenseMerge({ withPilcrows: false, headingMode: 'strict' }));
    expect(next).not.toBeNull();
    expect(next!.doc.childCount).toBe(1);
    expect(next!.doc.firstChild!.textContent).toBe('one two');
  });
});

// ---- Uncondense ----

describe('uncondense', () => {
  it('skips an invalid split (pilcrow in a tag) instead of throwing', () => {
    // A pilcrow can end up in a tag (a demolish merge, or pasting condensed
    // body into a tag). Splitting there would make two tags in one card —
    // schema-invalid, so tr.split used to throw and crash the editor.
    const tag = schema.nodes['tag']!.create({ id: 'tg' }, [
      schema.text('Heading '),
      makePilcrowText(),
      schema.text('tail'),
    ]);
    const doc = makeDoc([card(tag, cardBody('body'))]);
    const state = setSelectionRange(doc, 'Heading', 0, 'Heading', 0); // cursor in the tag
    let result: EditorState | null = null;
    expect(() => {
      result = apply(state, uncondense());
    }).not.toThrow();
    // Degrades to delete-marker-only: marker gone, card still has one tag.
    const out = result!.doc;
    let tagCount = 0;
    let hasPilcrow = false;
    out.descendants((n) => {
      if (n.type.name === 'tag') tagCount += 1;
      if (n.isText && (n.text ?? '').includes(PILCROW_CHAR)) hasPilcrow = true;
    });
    expect(tagCount).toBe(1);
    expect(hasPilcrow).toBe(false);
  });

  it('splits a paragraph at every 6-pt ¶ marker (new pilcrow_marker format)', () => {
    const pilcrowText = schema.text(PILCROW_CHAR, [
      schema.marks['pilcrow_marker']!.create(),
    ]);
    const merged = schema.nodes['card_body']!.create(null, [
      schema.text('one'),
      pilcrowText,
      schema.text('two'),
      pilcrowText,
      schema.text('three'),
    ]);
    const doc = makeDoc([card(tag('Tag'), merged)]);
    const state = setCursorIn(doc, (n) => n.type.name === 'card_body');
    const next = apply(state, uncondense());
    expect(next).not.toBeNull();
    const c = next!.doc.firstChild!;
    const names: string[] = [];
    c.forEach((ch) => names.push(ch.type.name));
    expect(names.length).toBe(4); // tag + 3 splits
    expect(c.child(1).textContent).toBe('one');
    expect(c.child(2).textContent).toBe('two');
    expect(c.child(3).textContent).toBe('three');
  });

  it('also recognizes the legacy font_size:12 + ¶ encoding (back-compat)', () => {
    const legacyPilcrow = schema.text(PILCROW_CHAR, [
      schema.marks['font_size']!.create({ halfPoints: PILCROW_HALF_POINTS }),
    ]);
    const merged = schema.nodes['card_body']!.create(null, [
      schema.text('one'),
      legacyPilcrow,
      schema.text('two'),
    ]);
    const doc = makeDoc([card(tag('Tag'), merged)]);
    const state = setCursorIn(doc, (n) => n.type.name === 'card_body');
    const next = apply(state, uncondense());
    expect(next).not.toBeNull();
    const c = next!.doc.firstChild!;
    expect(c.childCount).toBe(3);
    expect(c.child(1).textContent).toBe('one');
    expect(c.child(2).textContent).toBe('two');
  });

  it('leaves regular ¶ characters (non-6pt) alone', () => {
    // Plain ¶ at normal font size — not a marker.
    const merged = schema.nodes['card_body']!.create(null, [
      schema.text(`a${PILCROW_CHAR}b`),
    ]);
    const doc = makeDoc([card(tag('Tag'), merged)]);
    const state = setCursorIn(doc, (n) => n.type.name === 'card_body');
    const next = apply(state, uncondense());
    expect(next).toBeNull();
  });
});

// ---- Toggle case ----

describe('toggleCase', () => {
  function caseStateOf(doc: import('prosemirror-model').Node, search: string): string {
    let found = '';
    doc.descendants((n) => {
      if (n.isText && (n.text ?? '').includes(search)) found = n.text ?? '';
    });
    return found;
  }

  it('cycles lowercase → UPPERCASE', () => {
    const doc = makeDoc([paragraph('hello world')]);
    const state = setSelectionRange(doc, 'hello', 0, 'world', 5);
    const next = apply(state, toggleCase());
    expect(caseStateOf(next!.doc, 'HELLO')).toBe('HELLO WORLD');
  });

  it('cycles UPPERCASE → Title Case', () => {
    const doc = makeDoc([paragraph('HELLO WORLD')]);
    const state = setSelectionRange(doc, 'HELLO', 0, 'WORLD', 5);
    const next = apply(state, toggleCase());
    expect(caseStateOf(next!.doc, 'Hello')).toBe('Hello World');
  });

  it('cycles Title Case → lowercase', () => {
    const doc = makeDoc([paragraph('Hello World')]);
    const state = setSelectionRange(doc, 'Hello', 0, 'World', 5);
    const next = apply(state, toggleCase());
    expect(caseStateOf(next!.doc, 'hello')).toBe('hello world');
  });

  it('mixed case starts at lowercase', () => {
    const doc = makeDoc([paragraph('HeLLo WoRLd')]);
    const state = setSelectionRange(doc, 'HeLLo', 0, 'WoRLd', 5);
    const next = apply(state, toggleCase());
    expect(caseStateOf(next!.doc, 'hello')).toBe('hello world');
  });

  it('no-op on empty selection', () => {
    const doc = makeDoc([paragraph('hello')]);
    const state = setCursorIn(doc, (n) => n.type.name === 'paragraph');
    const next = apply(state, toggleCase());
    expect(next).toBeNull();
  });

  it('preserves the selection so the user can cycle again', () => {
    const doc = makeDoc([paragraph('hello world')]);
    const state = setSelectionRange(doc, 'hello', 0, 'world', 5);
    const { from: origFrom, to: origTo } = state.selection;
    const next = apply(state, toggleCase());
    expect(next).not.toBeNull();
    expect(next!.selection.empty).toBe(false);
    expect(next!.selection.from).toBe(origFrom);
    expect(next!.selection.to).toBe(origTo);
    // And cycling again from the preserved selection advances the
    // case — proving the selection truly stayed on the rewritten text.
    const after = apply(next!, toggleCase());
    expect(caseStateOf(after!.doc, 'Hello')).toBe('Hello World');
  });

  it('handles length-growing case maps without eating characters (ß→SS)', () => {
    const doc = makeDoc([paragraph('die straße nach berlin bleibt offen')]);
    const state = setSelectionRange(doc, 'die', 0, 'offen', 5);
    const next = apply(state, toggleCase());
    // The trailing "N" used to be eaten because ß→SS shifts the slice.
    expect(caseStateOf(next!.doc, 'DIE')).toBe('DIE STRASSE NACH BERLIN BLEIBT OFFEN');
    // Selection still wraps the whole (now longer) run.
    expect(next!.selection.empty).toBe(false);
    expect(next!.doc.textBetween(next!.selection.from, next!.selection.to, '', '')).toBe(
      'DIE STRASSE NACH BERLIN BLEIBT OFFEN',
    );
  });

  it('title-cases a word split across a mark boundary as one word', () => {
    // "HELLO" as two text nodes ("HEL" + bold "LO") — title case must
    // carry word state across the seam, capitalizing only the first
    // letter (→ "Hel"+"lo"), not restarting and producing "Hel"+"Lo".
    const p = schema.nodes['paragraph']!.create(null, [
      schema.text('HEL'),
      schema.text('LO', [schema.marks['bold']!.create()]),
    ]);
    const doc = makeDoc([p]);
    const state = setSelectionRange(doc, 'HEL', 0, 'LO', 2);
    const next = apply(state, toggleCase()); // UPPER → Title
    expect(caseStateOf(next!.doc, 'Hel')).toBe('Hel');
    expect(caseStateOf(next!.doc, 'lo')).toBe('lo');
  });
});
