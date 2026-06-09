/**
 * Tests for the AI explainer's context builder + @AI mention
 * detection + Clod activity selection.
 */

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  buildExplainContext,
  formatExplainPrompt,
  hasAiMention,
} from '../../src/editor/ai/explain-context.js';
import {
  activitiesForNow,
  currentClodPeriod,
  getCurrentHoliday,
  pickRandomActivity,
  CLOD_ACTIVITIES_BY_TIME,
  CLOD_HOLIDAY_ACTIVITIES,
  DEFAULT_CLOD_TIME_PERIODS,
} from '../../src/editor/ai/clod.js';

// ---- Doc builders ----------------------------------------------

function paragraph(text: string) {
  return schema.nodes['paragraph']!.create(null, text ? schema.text(text) : []);
}
function tag(text: string) {
  return schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(text));
}
function analytic(text: string) {
  return schema.nodes['analytic']!.create({ id: newHeadingId() }, schema.text(text));
}
function cardBody(text: string) {
  return schema.nodes['card_body']!.create(null, schema.text(text));
}
function citeParagraph(text: string) {
  return schema.nodes['cite_paragraph']!.create(null, schema.text(text));
}
function card(...children: any[]) {
  return schema.nodes['card']!.createChecked(null, children);
}
function analyticUnit(...children: any[]) {
  return schema.nodes['analytic_unit']!.createChecked(null, children);
}
function makeDoc(...children: any[]) {
  return schema.nodes['doc']!.createChecked(null, children);
}

function selectionAt(doc: any, from: number, to: number): EditorState {
  const state = EditorState.create({ doc });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
}

// ---- Tests ------------------------------------------------------

describe('buildExplainContext', () => {
  it('returns null on an empty selection', () => {
    const doc = makeDoc(paragraph('hello'));
    const state = EditorState.create({ doc });
    expect(buildExplainContext(state)).toBeNull();
  });

  it('on a doc-level paragraph selection returns selection-only context', () => {
    const doc = makeDoc(paragraph('the quick brown fox'));
    const state = selectionAt(doc, 1, 20);
    const ctx = buildExplainContext(state);
    expect(ctx).not.toBeNull();
    expect(ctx!.selection).toBe('the quick brown fox');
    expect(ctx!.tag).toBeNull();
    expect(ctx!.analytic).toBeNull();
    expect(ctx!.cites).toEqual([]);
  });

  it('inside a card includes the tag and all cite_paragraphs', () => {
    const doc = makeDoc(
      card(
        tag('Restraint is good'),
        citeParagraph('Smith 2024'),
        cardBody('argument body text'),
        citeParagraph('Jones 2023'),
      ),
    );
    // Walk to find the card_body's text. Card opens at 0, tag at 1.
    let from = 0, to = 0;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'argument body text') {
        from = p + 4; to = p + 10; // "ment b"
      }
    });
    const state = selectionAt(doc, from, to);
    const ctx = buildExplainContext(state);
    expect(ctx).not.toBeNull();
    expect(ctx!.selection.length).toBeGreaterThan(0);
    expect(ctx!.tag).toBe('Restraint is good');
    expect(ctx!.cites).toEqual(['Smith 2024', 'Jones 2023']);
  });

  it('captures every undertag from the containing card', () => {
    const undertag = (t: string) =>
      schema.nodes['undertag']!.create(null, schema.text(t));
    const doc = makeDoc(
      card(
        tag('My Tag'),
        undertag('first undertag'),
        undertag('second undertag'),
        cardBody('body text'),
      ),
    );
    let from = 0, to = 0;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'body text') { from = p + 1; to = p + 5; }
    });
    const state = selectionAt(doc, from, to);
    const ctx = buildExplainContext(state);
    expect(ctx!.undertags).toEqual(['first undertag', 'second undertag']);
  });

  it('inside an analytic_unit returns the analytic in the analytic slot', () => {
    const doc = makeDoc(
      analyticUnit(
        analytic('My analytic header'),
        cardBody('body text here'),
      ),
    );
    let from = 0, to = 0;
    doc.descendants((n, p) => {
      if (n.isText && n.text === 'body text here') { from = p + 1; to = p + 5; }
    });
    const state = selectionAt(doc, from, to);
    const ctx = buildExplainContext(state);
    expect(ctx!.analytic).toBe('My analytic header');
    expect(ctx!.tag).toBeNull();
  });
});

describe('formatExplainPrompt', () => {
  it('omits the surrounding-context block when nothing is provided', () => {
    const out = formatExplainPrompt('what does this mean?', {
      selection: 'some text',
      paragraphs: [],
      tag: null,
      analytic: null,
      undertags: [],
      cites: [],
      images: [],
    });
    expect(out).toContain('Question: what does this mean?');
    expect(out).toContain('Selected text:');
    expect(out).toContain('some text');
    expect(out).not.toContain('Surrounding context');
    expect(out).not.toContain('Source paragraph');
  });

  it('includes tag / analytic / cite lines when present', () => {
    const out = formatExplainPrompt('why does this matter?', {
      selection: 'XXX',
      paragraphs: [],
      tag: 'My Tag',
      analytic: 'My Analytic',
      undertags: ['Underly bit'],
      cites: ['Cite A', 'Cite B'],
      images: [],
    });
    expect(out).toContain('Tag: My Tag');
    expect(out).toContain('Analytic: My Analytic');
    expect(out).toContain('Undertag: Underly bit');
    expect(out).toContain('Cite: Cite A');
    expect(out).toContain('Cite: Cite B');
  });

  it('includes the source paragraph block when paragraphs are supplied', () => {
    const out = formatExplainPrompt('q', {
      selection: 'half',
      paragraphs: ['half a sentence inside a longer paragraph'],
      tag: null,
      analytic: null,
      undertags: [],
      cites: [],
      images: [],
    });
    expect(out).toContain('Source paragraph(s):');
    expect(out).toContain('half a sentence inside a longer paragraph');
  });
});

describe('buildExplainContext — paragraphs touched by selection', () => {
  it('captures the full paragraph even when only a fragment is selected', () => {
    const doc = makeDoc(paragraph('The quick brown fox jumps over the lazy dog'));
    const state = selectionAt(doc, 5, 14);
    const ctx = buildExplainContext(state);
    expect(ctx!.paragraphs).toEqual(['The quick brown fox jumps over the lazy dog']);
  });

  it('captures multiple paragraphs when the selection crosses boundaries', () => {
    const doc = makeDoc(
      paragraph('first paragraph'),
      paragraph('second paragraph'),
    );
    // First-paragraph end: 1 + 15 + 1 = 17. Second-paragraph start: 18.
    const state = selectionAt(doc, 10, 25);
    const ctx = buildExplainContext(state);
    expect(ctx!.paragraphs).toEqual(['first paragraph', 'second paragraph']);
  });
});

describe('hasAiMention', () => {
  it('matches @AI bounded by whitespace', () => {
    expect(hasAiMention('hey @AI can you weigh in')).toBe(true);
    expect(hasAiMention('@AI')).toBe(true);
    expect(hasAiMention('what does @ai think?')).toBe(true); // case-insensitive
  });

  it('does not match substrings inside words', () => {
    expect(hasAiMention('email@AI.example.com')).toBe(false);
    expect(hasAiMention('@AIRPLANE')).toBe(false);
    expect(hasAiMention('@AIs')).toBe(false);
  });

  it('returns false on empty / no-mention text', () => {
    expect(hasAiMention('')).toBe(false);
    expect(hasAiMention('plain reply')).toBe(false);
  });
});

describe('cite-creator response parsing', () => {
  it('parses a clean delimited-block reply', async () => {
    const { parseCiteResponse } = await import('../../src/editor/ai/cite-creator.js');
    const text = [
      '[[CITE]]',
      'Michael Townsend 25, ..., "Edgy Investors Waiting...," Schwab, 01/16/2025, https://x',
      '[[TOKENS]]',
      'Townsend 25',
      '[[END]]',
    ].join('\n');
    const out = parseCiteResponse(text);
    expect(out.cite).toContain('Townsend 25');
    expect(out.cite).toContain('"Edgy Investors Waiting...,"');
    expect(out.tokens).toEqual(['Townsend 25']);
  });

  it('handles quotes inside the cite without any escaping required', async () => {
    const { parseCiteResponse } = await import('../../src/editor/ai/cite-creator.js');
    // The exact failure mode the user reported with the Hayward
    // cite — title with literal quotes that would have broken JSON.
    const text = [
      '[[CITE]]',
      'Keith Hayward & Matthijs Maas 21, Hayward is Faculty of Law at University of Copenhagen; Maas is Senior Research Fellow, "Artificial intelligence and crime: A primer for criminologists," Volume 17, Issue 2, p. 209-233',
      '[[TOKENS]]',
      'Hayward & ',
      'Maas 21',
      '[[END]]',
    ].join('\n');
    const out = parseCiteResponse(text);
    expect(out.cite).toContain('"Artificial intelligence and crime: A primer for criminologists,"');
    expect(out.tokens).toEqual(['Hayward & ', 'Maas 21']);
  });

  it('tolerates the optional [[END]] marker being absent', async () => {
    const { parseCiteResponse } = await import('../../src/editor/ai/cite-creator.js');
    const text = '[[CITE]]\nSmith 24, ...\n[[TOKENS]]\nSmith 24\n';
    const out = parseCiteResponse(text);
    expect(out.cite).toBe('Smith 24, ...');
    expect(out.tokens).toEqual(['Smith 24']);
  });

  it('tolerates prose / fences before and after the block', async () => {
    const { parseCiteResponse } = await import('../../src/editor/ai/cite-creator.js');
    const text = 'Here is the cite:\n```\n[[CITE]]\nSmith 24\n[[TOKENS]]\nSmith 24\n[[END]]\n```\n';
    const out = parseCiteResponse(text);
    expect(out.cite).toBe('Smith 24');
    expect(out.tokens).toEqual(['Smith 24']);
  });

  it('collapses a wrapped (multi-line) cite into a single line', async () => {
    const { parseCiteResponse } = await import('../../src/editor/ai/cite-creator.js');
    const text = '[[CITE]]\nSmith 24, "Title,"\nJournal, 1/2/24\n[[TOKENS]]\nSmith 24\n[[END]]';
    const out = parseCiteResponse(text);
    expect(out.cite).toBe('Smith 24, "Title," Journal, 1/2/24');
    expect(out.cite).not.toContain('\n');
  });

  it('collapses runs of internal whitespace so tokens still match', async () => {
    const { parseCiteResponse } = await import('../../src/editor/ai/cite-creator.js');
    const text = '[[CITE]]\nSmith   24,  "Title,"   Source\n[[TOKENS]]\nSmith 24\n[[END]]';
    const out = parseCiteResponse(text);
    expect(out.cite).toBe('Smith 24, "Title," Source');
    expect(out.cite.indexOf(out.tokens[0]!)).toBeGreaterThanOrEqual(0);
  });

  it('strips invisible / control characters from cite and tokens', async () => {
    const { parseCiteResponse } = await import('../../src/editor/ai/cite-creator.js');
    // Zero-width space inside the author block, soft hyphen + BOM elsewhere
    // (the kind of junk that rides along in PDF-pasted source text). They
    // must not survive into the cite — they desync the rendered length from
    // the string used for cite-mark / paragraph-split positions.
    const zwsp = '​', shy = '­', bom = '﻿';
    const text = `[[CITE]]\nSmith${zwsp} 24, "Ti${shy}tle," Source${bom}\n[[TOKENS]]\nSmith${zwsp} 24\n[[END]]`;
    const out = parseCiteResponse(text);
    expect(out.cite).toBe('Smith 24, "Title," Source');
    expect(out.tokens).toEqual(['Smith 24']);
    // No invisible chars survive.
    expect(/[​­﻿]/.test(out.cite)).toBe(false);
    expect(out.cite.indexOf(out.tokens[0]!)).toBe(0);
  });

  it('preserves the two-author first token trailing space after sanitizing', async () => {
    const { parseCiteResponse } = await import('../../src/editor/ai/cite-creator.js');
    const text = '[[CITE]]\nWeiss & Bresnahan 3/26, "T," S\n[[TOKENS]]\nWeiss & \nBresnahan 3/26\n[[END]]';
    const out = parseCiteResponse(text);
    expect(out.tokens).toEqual(['Weiss & ', 'Bresnahan 3/26']);
    // Both tokens are verbatim substrings of the cite (contiguous marks).
    expect(out.cite.indexOf('Weiss & ')).toBe(0);
    expect(out.cite.indexOf('Bresnahan 3/26')).toBe('Weiss & '.length);
  });

  it('throws when the [[CITE]] marker is missing', async () => {
    const { parseCiteResponse } = await import('../../src/editor/ai/cite-creator.js');
    expect(() => parseCiteResponse('Smith 24')).toThrow(/markers/i);
  });

  it('throws when the cite section is empty', async () => {
    const { parseCiteResponse } = await import('../../src/editor/ai/cite-creator.js');
    expect(() => parseCiteResponse('[[CITE]]\n\n[[TOKENS]]\nSmith 24\n[[END]]')).toThrow(/empty/i);
  });

  it('substitutes {DATE} placeholder for today', async () => {
    const { resolveCitePrompt } = await import('../../src/editor/ai/cite-creator.js');
    const out = resolveCitePrompt('today is {DATE}', new Date(2026, 0, 5));
    expect(out).toBe('today is 1-5-2026');
  });
});

describe('clod time-period selection', () => {
  it('places 7am in "morning" under defaults', () => {
    const at = new Date(2026, 4, 13, 7, 0, 0);
    expect(currentClodPeriod(DEFAULT_CLOD_TIME_PERIODS, at)).toBe('morning');
  });

  it('places 3pm in "day"', () => {
    const at = new Date(2026, 4, 13, 15, 0, 0);
    expect(currentClodPeriod(DEFAULT_CLOD_TIME_PERIODS, at)).toBe('day');
  });

  it('handles the night period that crosses midnight', () => {
    const at = new Date(2026, 4, 13, 2, 0, 0);
    expect(currentClodPeriod(DEFAULT_CLOD_TIME_PERIODS, at)).toBe('night');
    const lateNight = new Date(2026, 4, 13, 23, 30, 0);
    expect(currentClodPeriod(DEFAULT_CLOD_TIME_PERIODS, lateNight)).toBe('night');
  });
});

describe('clod activity pool selection', () => {
  it('returns the day pool on a normal mid-day time', () => {
    const at = new Date(2026, 5, 15, 14, 0, 0); // June 15 (no holiday)
    const pool = activitiesForNow({ now: at });
    expect(pool).toEqual(CLOD_ACTIVITIES_BY_TIME.day);
  });

  it('substitutes a holiday pool on its calendar day (replacing the day pool)', () => {
    const halloween = new Date(2026, 9, 31, 13, 0, 0); // Oct 31, 1pm
    expect(getCurrentHoliday(halloween)).toBe('halloween');
    const pool = activitiesForNow({ now: halloween });
    expect(pool).toEqual(CLOD_HOLIDAY_ACTIVITIES.halloween);
  });

  it('uses custom override when non-empty for the current period', () => {
    const at = new Date(2026, 5, 15, 14, 0, 0);
    const pool = activitiesForNow({
      now: at,
      customByTime: { day: ['my custom activity'] },
    });
    expect(pool).toEqual(['my custom activity']);
  });

  it('falls back to defaults when a custom override is empty', () => {
    const at = new Date(2026, 5, 15, 14, 0, 0);
    const pool = activitiesForNow({
      now: at,
      customByTime: { day: [] },
    });
    expect(pool).toEqual(CLOD_ACTIVITIES_BY_TIME.day);
  });

  it('pickRandomActivity returns one of the pool entries', () => {
    const pool = ['a', 'b', 'c'];
    for (let i = 0; i < 10; i++) {
      expect(pool).toContain(pickRandomActivity(pool));
    }
  });

  it('pickRandomActivity returns a sensible fallback when pool is empty', () => {
    expect(pickRandomActivity([])).toBe('Clod is thinking…');
  });
});

// ---- buildCiteTransaction --------------------------------------

describe('buildCiteTransaction (cite-is-its-own-paragraph)', () => {
  // Doc shape used by these tests: one card whose body holds
  // raw citation info BEFORE the user invokes the cite creator,
  // with a second body following that should stay separate.
  function findText(
    doc: import('prosemirror-model').Node,
    text: string,
  ): { start: number; end: number } {
    let r = { start: -1, end: -1 };
    doc.descendants((n, p) => {
      if (r.start !== -1) return false;
      if (n.isText && n.text === text) {
        r = { start: p, end: p + n.nodeSize };
        return false;
      }
      return true;
    });
    if (r.start < 0) throw new Error(`text "${text}" not in doc`);
    return r;
  }

  async function loadBuilder() {
    const mod = await import('../../src/editor/ai/cite-creator.js');
    return mod.buildCiteTransaction;
  }

  it('selection that ends mid-paragraph: trailing text goes to a NEW textblock after the cite', async () => {
    const buildCiteTransaction = await loadBuilder();
    const doc = makeDoc(
      card(
        tag('TAG'),
        cardBody('raw cite info HERE then trailing text'),
      ),
    );
    const { start } = findText(doc, 'raw cite info HERE then trailing text');
    // Select "raw cite info HERE" (positions 0..18 within the text node).
    const from = start;
    const to = start + 'raw cite info HERE'.length;
    const state = selectionAt(doc, from, to);
    const tr = buildCiteTransaction(state, from, to, {
      cite: 'Author 25, "Title," Source, https://example.com/',
      tokens: ['Author 25'],
    });
    expect(tr).not.toBeNull();
    const next = state.apply(tr!);
    // The card_body should be split: cite in its own body, trailing
    // text in a separate body.
    const card2 = next.doc.firstChild!;
    const types: string[] = [];
    card2.forEach((c) => types.push(c.type.name));
    expect(types).toEqual(['tag', 'card_body', 'card_body']);
    expect(card2.child(1).textContent).toBe('Author 25, "Title," Source, https://example.com/');
    expect(card2.child(2).textContent).toBe(' then trailing text');
  });

  it('selection starts mid-paragraph: pre-cite text goes to a NEW textblock before the cite', async () => {
    const buildCiteTransaction = await loadBuilder();
    const doc = makeDoc(
      card(
        tag('TAG'),
        cardBody('keep this. raw cite info'),
      ),
    );
    const { start } = findText(doc, 'keep this. raw cite info');
    const from = start + 'keep this. '.length;
    const to = start + 'keep this. raw cite info'.length;
    const state = selectionAt(doc, from, to);
    const tr = buildCiteTransaction(state, from, to, {
      cite: 'Doe 24, "X," Y',
      tokens: ['Doe 24'],
    });
    expect(tr).not.toBeNull();
    const next = state.apply(tr!);
    const c = next.doc.firstChild!;
    const types: string[] = [];
    c.forEach((ch) => types.push(ch.type.name));
    expect(types).toEqual(['tag', 'card_body', 'card_body']);
    expect(c.child(1).textContent).toBe('keep this. ');
    expect(c.child(2).textContent).toBe('Doe 24, "X," Y');
  });

  it('selection covers exactly one whole body: no extra splits, body becomes the cite', async () => {
    const buildCiteTransaction = await loadBuilder();
    const doc = makeDoc(
      card(
        tag('TAG'),
        cardBody('raw info'),
        cardBody('keep me'),
      ),
    );
    const { start } = findText(doc, 'raw info');
    const from = start;
    const to = start + 'raw info'.length;
    const state = selectionAt(doc, from, to);
    const tr = buildCiteTransaction(state, from, to, {
      cite: 'Smith 25, "Article," Source',
      tokens: ['Smith 25'],
    });
    expect(tr).not.toBeNull();
    const next = state.apply(tr!);
    const c = next.doc.firstChild!;
    const types: string[] = [];
    c.forEach((ch) => types.push(ch.type.name));
    // Still two card_bodies, no spurious splits.
    expect(types).toEqual(['tag', 'card_body', 'card_body']);
    expect(c.child(1).textContent).toBe('Smith 25, "Article," Source');
    expect(c.child(2).textContent).toBe('keep me');
  });

  it('selection crosses a paragraph break: cite gets its own body, trailing tail goes to a new body', async () => {
    const buildCiteTransaction = await loadBuilder();
    // User's selection starts mid-body 1 ("info ") and ends
    // mid-body 2 ("rest"). After `tr.insertText` PM collapses
    // the two bodies into one because the paragraph break sat
    // inside the deleted range. The post-cite cleanup should
    // re-split so the trailing "rest of body 2" stands alone.
    const doc = makeDoc(
      card(
        tag('TAG'),
        cardBody('info raw'),
        cardBody('foo rest of body 2'),
      ),
    );
    const { start: b1Start } = findText(doc, 'info raw');
    const { start: b2Start } = findText(doc, 'foo rest of body 2');
    const from = b1Start + 'info '.length;
    const to = b2Start + 'foo '.length;
    const state = selectionAt(doc, from, to);
    const tr = buildCiteTransaction(state, from, to, {
      cite: 'Lee 25, "T," P',
      tokens: ['Lee 25'],
    });
    expect(tr).not.toBeNull();
    const next = state.apply(tr!);
    const c = next.doc.firstChild!;
    const types: string[] = [];
    c.forEach((ch) => types.push(ch.type.name));
    expect(types).toEqual(['tag', 'card_body', 'card_body', 'card_body']);
    expect(c.child(1).textContent).toBe('info ');
    expect(c.child(2).textContent).toBe('Lee 25, "T," P');
    expect(c.child(3).textContent).toBe('rest of body 2');
  });

  it('cite_mark is applied to the leading-author token after the split', async () => {
    const buildCiteTransaction = await loadBuilder();
    const doc = makeDoc(card(tag('TAG'), cardBody('raw info more after')));
    const { start } = findText(doc, 'raw info more after');
    const from = start;
    const to = start + 'raw info'.length;
    const state = selectionAt(doc, from, to);
    const tr = buildCiteTransaction(state, from, to, {
      cite: 'Author 25, "Title," Source',
      tokens: ['Author 25'],
    });
    expect(tr).not.toBeNull();
    const next = state.apply(tr!);
    // Find the "Author 25" substring and confirm it carries cite_mark.
    let marked = false;
    next.doc.descendants((n) => {
      if (n.isText && (n.text ?? '').startsWith('Author 25')) {
        marked = n.marks.some((m) => m.type.name === 'cite_mark');
      }
    });
    expect(marked).toBe(true);
  });
});
