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

  it('kept text: underline + yellow highlight + 12pt size; no font_color from the tool contrast stamp', () => {
    const doc = convertHakuHtml(HAKU_CARD)!;
    const kept = marksAt(doc, 'cause extinction');
    expect(kept.has('underline_mark')).toBe(true); // <u> promoted in body
    expect(kept.get('highlight')?.['color']).toBe('yellow');
    expect(kept.get('font_size')?.['halfPoints']).toBe(24);
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
