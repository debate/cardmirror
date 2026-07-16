// @vitest-environment jsdom
/**
 * haku.cards clipboard HTML → CardMirror structure. Fixtures mirror the
 * production copy builders (decompiled buildCardCopyHtml, verified
 * 2026-07-15): classless, entirely inline-styled — Calibri wrapper div,
 * 13pt bold <h4> tag, cite <p> with a bold-13pt lead span, body runs as
 * pt-sized spans with literal <u>, highlight group spans carrying
 * background + mso-highlight + background-color + color:#1b1b1c +
 * box-decoration-break:clone, 26/22pt h1/h2 case headings. This is the
 * shared pipeline's pure visual-rules path (no class dictionary).
 */
import { describe, expect, it } from 'vitest';
import { type Node as PMNode } from 'prosemirror-model';
import { convertHakuHtml } from '../../src/import/html-paste.js';

const CAL = `font-family:Calibri, Candara, Segoe, 'Segoe UI', Optima, Arial, sans-serif`;

/** A full haku search-copy card, traditional palette, highlighted. */
const HAKU_CARD = `<div style="${CAL}"><h4 style="margin:0 0 2px 0;font-weight:700;font-size:13pt;line-height:108%;">Warming causes extinction</h4><p style="font-weight:400;font-size:11pt;line-height:110%;margin:0 0 3px 0;"><span style="font-weight:700;font-size:13pt;line-height:108%;">Smith ’23</span><span> (Jane, Professor of Things, Journal of Stuff)</span></p><p style="font-weight:400;font-size:11.00pt;line-height:172%;margin:0 0 3px 0"><span style="font-size:8.00pt;">Feedback loops in the arctic </span><span style="font-weight:400;font-style:normal;background:yellow;mso-highlight:yellow;background-color:#FF0;color:#1b1b1c;font-size:12.00pt;line-height:172%;padding-top:0.055em;padding-bottom:0.055em;padding-left:0.055em;padding-right:0.055em;box-decoration-break:clone;-webkit-box-decoration-break:clone"><span style="font-size:12.00pt;"><u>cause extinction</u></span></span><span style="font-size:8.00pt;"> according to every model</span></p></div>`;

function blocksOf(doc: PMNode): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  doc.descendants((n) => {
    if (n.isTextblock) {
      out.push([n.type.name, n.textContent]);
      return false;
    }
    return true;
  });
  return out;
}

function marksAt(doc: PMNode, sub: string): Map<string, Record<string, unknown>> {
  let found: Map<string, Record<string, unknown>> | null = null;
  doc.descendants((n) => {
    if (found) return false;
    if (n.isText && n.text?.includes(sub)) {
      found = new Map(n.marks.map((m) => [m.type.name, m.attrs as Record<string, unknown>]));
      return false;
    }
    return true;
  });
  return found ?? new Map();
}

describe('convertHakuHtml', () => {
  it('a search-copy card converts to card { tag, cite_paragraph, card_body }', () => {
    const doc = convertHakuHtml(HAKU_CARD)!;
    expect(doc).not.toBeNull();
    const types: string[] = [];
    doc.forEach((n) => types.push(n.type.name));
    expect(types).toEqual(['card']);
    expect(blocksOf(doc)).toEqual([
      ['tag', 'Warming causes extinction'],
      ['cite_paragraph', 'Smith ’23 (Jane, Professor of Things, Journal of Stuff)'],
      [
        'card_body',
        'Feedback loops in the arctic cause extinction according to every model',
      ],
    ]);
  });

  it('the bold-13pt cite lead becomes cite_mark; the rest of the cite stays plain', () => {
    const doc = convertHakuHtml(HAKU_CARD)!;
    expect([...marksAt(doc, 'Smith ’23').keys()]).toEqual(['cite_mark']);
    expect(marksAt(doc, 'Professor of Things').size).toBe(0);
  });

  it('kept text: underline + yellow highlight; baseline 12pt size destroyed; no font_color from the tool contrast stamp', () => {
    const doc = convertHakuHtml(HAKU_CARD)!;
    const kept = marksAt(doc, 'cause extinction');
    expect(kept.has('underline_mark')).toBe(true); // <u> promoted in body
    expect(kept.get('highlight')?.['color']).toBe('yellow');
    // The 12.00pt on kept text is the card's kept baseline — haku noise,
    // not a user choice — so it must not survive as a font_size mark.
    expect(kept.has('font_size')).toBe(false);
    expect(kept.has('font_color')).toBe(false); // color:#1b1b1c is haku's, not the user's
  });

  it('shrunk 8pt runs carry font_size 16 half-points and nothing else', () => {
    const doc = convertHakuHtml(HAKU_CARD)!;
    const shrunk = marksAt(doc, 'Feedback loops in the arctic');
    expect(shrunk.get('font_size')?.['halfPoints']).toBe(16);
    expect(shrunk.has('highlight')).toBe(false);
  });

  it('new-palette hex highlights map to named colors', () => {
    const html = `<div style="${CAL}"><h4 style="font-weight:700;font-size:13pt;">Tag</h4><p style="font-size:11pt;"><span style="background:#ffeb70;box-decoration-break:clone"><u>sunny</u></span> <span style="background:#b8f277;box-decoration-break:clone"><u>leafy</u></span> <span style="background:#88c9ff;box-decoration-break:clone"><u>chilly</u></span></p></div>`;
    const doc = convertHakuHtml(html)!;
    expect(marksAt(doc, 'sunny').get('highlight')?.['color']).toBe('yellow');
    expect(marksAt(doc, 'leafy').get('highlight')?.['color']).toBe('green');
    expect(marksAt(doc, 'chilly').get('highlight')?.['color']).toBe('cyan');
  });

  it('boxed spans (inline windowtext border) become emphasis_mark', () => {
    const html = `<div style="${CAL}"><h4 style="font-weight:700;font-size:13pt;">Tag</h4><p style="font-size:11pt;"><span style="border:solid windowtext 1.0pt;padding:0 .1em">boxed phrase</span> rest</p></div>`;
    const doc = convertHakuHtml(html)!;
    expect(marksAt(doc, 'boxed phrase').has('emphasis_mark')).toBe(true);
  });

  it('case exports: 26pt h1 → pocket, 22pt h2 → hat', () => {
    const html = `<div style="${CAL}"><h1 style="font-weight:700;font-size:26pt;">Case Neg</h1><h2 style="font-weight:700;font-size:22pt;">Framing</h2><h4 style="font-weight:700;font-size:13pt;">First tag</h4><p style="font-size:11pt;">body</p></div>`;
    const doc = convertHakuHtml(html)!;
    const types: string[] = [];
    doc.forEach((n) => types.push(n.type.name));
    expect(types).toEqual(['pocket', 'hat', 'card']);
  });

  it('bold+underline becomes emphasis when it is the minority of underlined text', () => {
    const html = `<div style="${CAL}"><h4 style="font-weight:700;font-size:13pt;">Tag</h4><p style="font-size:11pt;"><u>plain kept text that runs long</u> then <b><u>the emphasized bit</u></b> and <u>more plain kept</u></p></div>`;
    const doc = convertHakuHtml(html)!;
    const emph = marksAt(doc, 'the emphasized bit');
    expect(emph.has('emphasis_mark')).toBe(true);
    expect(emph.has('bold')).toBe(false);
    expect(emph.has('underline_mark')).toBe(false);
    expect(marksAt(doc, 'plain kept text').has('underline_mark')).toBe(true);
  });

  it('legacy files (exactly 100% of underlining bold) keep plain underline, bold dropped', () => {
    const html = `<div style="${CAL}"><h4 style="font-weight:700;font-size:13pt;">Tag</h4><p style="font-size:11pt;"><b><u>every kept run</u></b> filler <b><u>is bold underlined</u></b></p></div>`;
    const doc = convertHakuHtml(html)!;
    for (const text of ['every kept run', 'is bold underlined']) {
      const m = marksAt(doc, text);
      expect(m.has('underline_mark')).toBe(true);
      expect(m.has('emphasis_mark')).toBe(false);
      expect(m.has('bold')).toBe(false);
    }
  });

  it('bold inside a highlight (haku wraps highlights in <u>) becomes emphasis + highlight', () => {
    const html = `<div style="${CAL}"><h4 style="font-weight:700;font-size:13pt;">Tag</h4><p style="font-size:11pt;"><u>plain kept context here</u> <span style="background:yellow;mso-highlight:yellow;box-decoration-break:clone"><b><u>hot take</u></b></span></p></div>`;
    const doc = convertHakuHtml(html)!;
    const m = marksAt(doc, 'hot take');
    expect(m.has('emphasis_mark')).toBe(true);
    expect(m.get('highlight')?.['color']).toBe('yellow');
    expect(m.has('bold')).toBe(false);
  });

  it('font sizes: baseline kept size and unread ≥10pt sizes destroyed; <10pt shrink and above-baseline kept sizes survive', () => {
    const html = `<div style="${CAL}"><h4 style="font-weight:700;font-size:13pt;">Tag</h4><p style="font-size:12pt;"><span style="font-size:12.00pt;"><u>the kept baseline text of this card runs long</u></span><span style="font-size:12.00pt;"> unread at twelve </span><span style="font-size:16.00pt;"><u>BLOWN UP</u></span><span style="font-size:8.00pt;"> shrunk bit </span><span style="font-size:9.50pt;"> nine and a half </span><span style="font-size:10.00pt;"> exactly ten </span></p></div>`;
    const doc = convertHakuHtml(html)!;
    expect(marksAt(doc, 'kept baseline text').has('font_size')).toBe(false); // baseline → destroyed
    expect(marksAt(doc, 'unread at twelve').has('font_size')).toBe(false); // ≥10, not kept → destroyed
    expect(marksAt(doc, 'BLOWN UP').get('font_size')?.['halfPoints']).toBe(32); // kept, above baseline → survives
    expect(marksAt(doc, 'shrunk bit').get('font_size')?.['halfPoints']).toBe(16); // <10 → survives
    expect(marksAt(doc, 'nine and a half').get('font_size')?.['halfPoints']).toBe(19); // <10 → survives
    expect(marksAt(doc, 'exactly ten').has('font_size')).toBe(false); // 10 is not "smaller than 10"
  });

  it('formatting gaps are fixed before paste: punctuation splits in underlining bridge', () => {
    // haku strips trailing punctuation out of <u> runs on copy, so
    // "warming, causes" arrives as two underline runs with a bare ", "
    // between them. The converted doc must come out already bridged.
    const html = `<div style="${CAL}"><h4 style="font-weight:700;font-size:13pt;">Tag</h4><p style="font-size:11pt;"><u>global warming</u>, <u>causes extinction</u> and <u>more</u></p></div>`;
    const doc = convertHakuHtml(html)!;
    // Bridged runs merge into one underlined text node spanning the comma.
    expect(marksAt(doc, 'warming, causes').has('underline_mark')).toBe(true);
    // An unformatted interior WORD is not a gap — " and " stays plain.
    expect(marksAt(doc, 'and').has('underline_mark')).toBe(false);
  });

  it('gap fixing bridges emphasis between adjacent emphasized fragments', () => {
    const html = `<div style="${CAL}"><h4 style="font-weight:700;font-size:13pt;">Tag</h4><p style="font-size:11pt;"><u>plain kept context runs long here</u> then <b><u>act</u></b> <b><u>now</u></b></p></div>`;
    const doc = convertHakuHtml(html)!;
    // The space between the two emphasized words carries emphasis, so
    // the three nodes merge into a single emphasized "act now".
    const m = marksAt(doc, 'act now');
    expect(m.has('emphasis_mark')).toBe(true);
    expect(m.has('bold')).toBe(false);
  });

  it('source-file breadcrumb paragraphs import as body text (documented quirk)', () => {
    const html = `<div style="${CAL}"><h4 style="font-weight:700;font-size:13pt;">Tag</h4><p style="font-size:11pt;"><span style="font-weight:700;font-size:13pt;">Cite ’22</span></p><div style="margin:0 0 3px 0;"><p style="margin:0 0 1px 0;font-weight:400;font-size:11pt;line-height:110%;">Impacts</p></div><p style="font-size:11pt;">real body</p></div>`;
    const doc = convertHakuHtml(html)!;
    expect(blocksOf(doc)).toEqual([
      ['tag', 'Tag'],
      ['cite_paragraph', 'Cite ’22'],
      ['card_body', 'Impacts'],
      ['card_body', 'real body'],
    ]);
  });
});
