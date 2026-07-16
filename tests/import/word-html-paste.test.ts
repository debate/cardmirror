// @vitest-environment jsdom
/**
 * Word clipboard HTML → CardMirror structure (smart paste conversion).
 * The converter classifies Word's clipboard HTML into the docx
 * importer's ParaInfo[] intermediate and reuses assembleDoc, so these
 * tests assert the same invariants the .docx import path guarantees:
 * tag-rooted card grouping, cite-mark-driven cite_paragraph slotting,
 * named-style mark mapping (including legacy ids), visual fallbacks,
 * numbering reconstruction from mso-list, and the "no structure found →
 * null" fall-through gate.
 */
import { describe, expect, it } from 'vitest';
import { type Node as PMNode } from 'prosemirror-model';
import { convertWordHtml } from '../../src/import/html-paste.js';

/** Wrap body content in a Word-shaped clipboard document. */
function wordDoc(body: string, extraCss = ''): string {
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta name=Generator content="Microsoft Word 15"><style><!--
p.MsoNormal, li.MsoNormal, div.MsoNormal {mso-style-name:Normal; font-size:11.0pt;}
span.Style13ptBold {mso-style-name:"Style 13 pt Bold\\,Cite"; font-weight:bold; font-size:13.0pt;}
span.StyleUnderline {mso-style-name:"Style Underline\\,Underline"; text-decoration:underline;}
span.StyleBoldUnderline {mso-style-name:"Style Bold Underline"; text-decoration:underline; font-weight:bold;}
p.Undertag, li.Undertag, div.Undertag {mso-style-name:Undertag; font-style:italic;}
p.Analytic, li.Analytic, div.Analytic {mso-style-name:Analytic;}
${extraCss}
--></style></head><body>${body}</body></html>`;
}

/** [nodeTypeName, text] pairs for the doc's textblocks, in order. */
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

/** Mark names present on the first text node whose text includes `sub`. */
function marksAt(doc: PMNode, sub: string): string[] {
  let found: string[] | null = null;
  doc.descendants((n) => {
    if (found) return false;
    if (n.isText && n.text?.includes(sub)) {
      found = n.marks.map((m) => m.type.name).sort();
      return false;
    }
    return true;
  });
  return found ?? [];
}

function topLevelTypes(doc: PMNode): string[] {
  const out: string[] = [];
  doc.forEach((n) => out.push(n.type.name));
  return out;
}

describe('convertWordHtml — structure', () => {
  it('classed Verbatim copy → card with tag / cite_paragraph / card_body', () => {
    const doc = convertWordHtml(
      wordDoc(
        `<h4>Warming causes extinction</h4>
         <p class=MsoNormal><span class=Style13ptBold>Smith ’23</span> — Jane Smith, Professor of Things</p>
         <p class=MsoNormal>Feedback loops <span class=StyleUnderline>accelerate collapse</span> beyond repair.</p>`,
      ),
    )!;
    expect(doc).not.toBeNull();
    expect(topLevelTypes(doc)).toEqual(['card']);
    expect(blocksOf(doc)).toEqual([
      ['tag', 'Warming causes extinction'],
      ['cite_paragraph', 'Smith ’23 — Jane Smith, Professor of Things'],
      ['card_body', 'Feedback loops accelerate collapse beyond repair.'],
    ]);
    expect(marksAt(doc, 'Smith ’23')).toEqual(['cite_mark']);
    expect(marksAt(doc, 'accelerate collapse')).toEqual(['underline_mark']);
  });

  it('h1/h2/h3 map to pocket/hat/block', () => {
    const doc = convertWordHtml(
      wordDoc(`<h1>Case Neg</h1><h2>Framing</h2><h3>1NC — Warming</h3><p class=MsoNormal>loose text</p>`),
    )!;
    expect(topLevelTypes(doc)).toEqual(['pocket', 'hat', 'block', 'paragraph']);
  });

  it('Analytic class starts an analytic_unit that absorbs following bodies', () => {
    const doc = convertWordHtml(
      wordDoc(
        `<p class=Analytic>Extend the impact debate</p>
         <p class=MsoNormal>They dropped the warrant.</p>`,
      ),
    )!;
    expect(topLevelTypes(doc)).toEqual(['analytic_unit']);
    expect(blocksOf(doc)).toEqual([
      ['analytic', 'Extend the impact debate'],
      ['card_body', 'They dropped the warrant.'],
    ]);
  });

  it('Undertag class nests under the tag inside the card', () => {
    const doc = convertWordHtml(
      wordDoc(
        `<h4>Tag line</h4>
         <p class=Undertag>An undertag note</p>
         <p class=MsoNormal>body text</p>`,
      ),
    )!;
    expect(blocksOf(doc)).toEqual([
      ['tag', 'Tag line'],
      ['undertag', 'An undertag note'],
      ['card_body', 'body text'],
    ]);
  });

  it('bare <u> in body text is promoted to the named underline style (docx parity)', () => {
    const doc = convertWordHtml(
      wordDoc(`<h4>Tag</h4><p class=MsoNormal>text with <u>direct underline</u> here</p>`),
    )!;
    expect(marksAt(doc, 'direct underline')).toEqual(['underline_mark']);
  });

  it('no debate structure → null (falls through to the default paste)', () => {
    expect(
      convertWordHtml(
        wordDoc(`<p class=MsoNormal>Just a plain paragraph.</p><p class=MsoNormal>Another one with <b>bold</b>.</p>`),
      ),
    ).toBeNull();
  });
});

describe('convertWordHtml — marks and runs', () => {
  it('legacy StyleBoldUnderline maps to underline_mark', () => {
    const doc = convertWordHtml(
      wordDoc(`<h4>Tag</h4><p class=MsoNormal>a <span class=StyleBoldUnderline>legacy underlined</span> run</p>`),
    )!;
    expect(marksAt(doc, 'legacy underlined')).toEqual(['underline_mark']);
  });

  it('direct-formatted cite (bold 13pt lead run) becomes a cite_paragraph', () => {
    const doc = convertWordHtml(
      wordDoc(
        `<h4>Tag</h4>
         <p class=MsoNormal><span style='font-weight:bold;font-size:13.0pt'>Jones ’24</span><span> (staff writer, The Paper)</span></p>
         <p class=MsoNormal>body follows</p>`,
      ),
    )!;
    expect(blocksOf(doc)).toEqual([
      ['tag', 'Tag'],
      ['cite_paragraph', 'Jones ’24 (staff writer, The Paper)'],
      ['card_body', 'body follows'],
    ]);
    expect(marksAt(doc, 'Jones ’24')).toEqual(['cite_mark']);
  });

  it('an incidental bold-13pt run mid-paragraph does NOT reclassify the paragraph as cite', () => {
    const doc = convertWordHtml(
      wordDoc(
        `<h4>Tag</h4>
         <p class=MsoNormal>leading plain text <span style='font-weight:bold;font-size:13.0pt'>loud aside</span> more text</p>`,
      ),
    )!;
    expect(blocksOf(doc)[1]![0]).toBe('card_body');
  });

  it('highlights map to OOXML named colors (mso-highlight and background spellings)', () => {
    const doc = convertWordHtml(
      wordDoc(
        `<h4>Tag</h4>
         <p class=MsoNormal><span style='background:yellow;mso-highlight:yellow'>sunny</span> and <span style='background:lime'>leafy</span></p>`,
      ),
    )!;
    const sunny = marksAt(doc, 'sunny');
    expect(sunny).toContain('highlight');
    const leafy = marksAt(doc, 'leafy');
    expect(leafy).toContain('highlight');
    let colors: string[] = [];
    doc.descendants((n) => {
      if (n.isText) {
        for (const m of n.marks) if (m.type.name === 'highlight') colors.push(String(m.attrs['color']));
      }
      return true;
    });
    expect(colors).toEqual(['yellow', 'green']);
  });

  it('arbitrary hex backgrounds become shading (protected-highlight convention)', () => {
    const doc = convertWordHtml(
      wordDoc(`<h4>Tag</h4><p class=MsoNormal><span style='background:#D2D2D2'>protected</span></p>`),
    )!;
    expect(marksAt(doc, 'protected')).toContain('shading');
  });

  it('small font sizes import as font_size marks (shrunk text)', () => {
    const doc = convertWordHtml(
      wordDoc(`<h4>Tag</h4><p class=MsoNormal><span style='font-size:8.0pt'>shrunk run</span> normal</p>`),
    )!;
    let halfPoints: number | null = null;
    doc.descendants((n) => {
      if (n.isText && n.text?.includes('shrunk')) {
        const m = n.marks.find((mm) => mm.type.name === 'font_size');
        halfPoints = m ? Number(m.attrs['halfPoints']) : null;
      }
      return true;
    });
    expect(halfPoints).toBe(16);
  });

  it('haku conventions do NOT apply to Word pastes: bold+underline and 12pt sizes import verbatim', () => {
    const doc = convertWordHtml(
      wordDoc(
        `<h4>Tag</h4><p class=MsoNormal><b><u>bold underlined</u></b> and <span style='font-size:12.0pt'><u>sized kept text</u></span></p>`,
      ),
    )!;
    const bu = marksAt(doc, 'bold underlined');
    expect(bu).toContain('bold');
    expect(bu).toContain('underline_mark');
    expect(bu).not.toContain('emphasis_mark');
    expect(marksAt(doc, 'sized kept text')).toContain('font_size');
  });

  it('gap fixing does NOT run on Word pastes: punctuation splits import verbatim', () => {
    const doc = convertWordHtml(
      wordDoc(`<h4>Tag</h4><p class=MsoNormal><u>global warming</u>, <u>causes extinction</u></p>`),
    )!;
    expect(marksAt(doc, ',')).toEqual([]); // the gap stays exactly as copied
  });

  it('strips XML-illegal control characters at entry', () => {
    const doc = convertWordHtml(
      wordDoc(`<h4>Tag</h4><p class=MsoNormal>groupseparator</p>`),
    )!;
    expect(blocksOf(doc)[1]![1]).toBe('groupseparator');
  });
});

describe('convertWordHtml — numbering and noise', () => {
  it('mso-list numbering reconstructs numRole; the fake glyph span is dropped', () => {
    const doc = convertWordHtml(
      wordDoc(
        `<h4 style='mso-list:l0 level1 lfo1'><span style='mso-list:Ignore'>1.<span> </span></span>First numbered tag</h4>
         <p class=MsoNormal>body one</p>
         <h4 style='mso-list:l0 level1 lfo1'><span style='mso-list:Ignore'>2.<span> </span></span>Second numbered tag</h4>
         <p class=MsoNormal>body two</p>`,
      ),
    )!;
    const roles: string[] = [];
    doc.forEach((n) => {
      if (n.type.name === 'card') roles.push(String(n.attrs['numRole']));
    });
    expect(roles).toEqual(['number', 'number']);
    // The literal "1." glyphs must not survive as text.
    expect(blocksOf(doc).map(([, t]) => t)).toEqual([
      'First numbered tag',
      'body one',
      'Second numbered tag',
      'body two',
    ]);
  });

  it('edge spacer paragraphs are trimmed; <o:p> noise is ignored', () => {
    const doc = convertWordHtml(
      wordDoc(
        `<p class=MsoNormal><o:p>&nbsp;</o:p></p>
         <h4>Tag<o:p></o:p></h4>
         <p class=MsoNormal>body</p>
         <p class=MsoNormal><o:p>&nbsp;</o:p></p>`,
      ),
    )!;
    expect(blocksOf(doc)).toEqual([
      ['tag', 'Tag'],
      ['card_body', 'body'],
    ]);
  });
});
