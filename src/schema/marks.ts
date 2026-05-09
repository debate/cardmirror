/**
 * ProseMirror mark specs.
 *
 * Two families of marks:
 *
 * 1. Named-style emphasis marks — round-trip to a Word character style:
 *    - cite_mark   ↔ rStyle "Style13ptBold" (Cite)
 *    - underline_mark ↔ rStyle "StyleUnderline" + direct <w:u w:val="single"/>
 *      (dual representation per NOTES-verbatim.md §5 gotcha #1)
 *    - emphasis_mark ↔ rStyle "Emphasis"
 *    - undertag_mark ↔ rStyle "UndertagChar"
 *    - analytic_mark ↔ rStyle "AnalyticChar"
 *
 * 2. Direct-formatting marks — round-trip to OOXML run properties:
 *    - bold      ↔ <w:b/>
 *    - italic    ↔ <w:i/> + <w:iCs/>
 *    - link      ↔ <w:hyperlink>...</w:hyperlink>  (URL in attrs)
 *    - highlight ↔ <w:highlight w:val="..."/>      (named color)
 *    - font_color ↔ <w:color w:val="..."/>         (RGB hex)
 *    - font_size ↔ <w:sz w:val="..."/>             (half-points)
 *    - shading   ↔ <w:shd w:fill="..."/>           (RGB hex; protected highlight)
 */

import type { MarkSpec } from 'prosemirror-model';

/** No-attribute named-style mark template. */
function namedStyleMark(): MarkSpec {
  return {
    inclusive: true,
  };
}

export const marks: { [name: string]: MarkSpec } = {
  // -------- Named-style emphasis marks --------

  cite_mark: {
    ...namedStyleMark(),
    parseDOM: [{ tag: 'span.pmd-cite' }],
    toDOM: () => ['span', { class: 'pmd-cite' }, 0],
  },

  underline_mark: {
    ...namedStyleMark(),
    parseDOM: [{ tag: 'span.pmd-underline' }],
    toDOM: () => ['span', { class: 'pmd-underline' }, 0],
  },

  emphasis_mark: {
    ...namedStyleMark(),
    parseDOM: [{ tag: 'span.pmd-emphasis' }],
    toDOM: () => ['span', { class: 'pmd-emphasis' }, 0],
  },

  undertag_mark: {
    ...namedStyleMark(),
    parseDOM: [{ tag: 'span.pmd-undertag-mark' }],
    toDOM: () => ['span', { class: 'pmd-undertag-mark' }, 0],
  },

  analytic_mark: {
    ...namedStyleMark(),
    parseDOM: [{ tag: 'span.pmd-analytic-mark' }],
    toDOM: () => ['span', { class: 'pmd-analytic-mark' }, 0],
  },

  // -------- Direct-formatting marks --------

  bold: {
    inclusive: true,
    parseDOM: [
      { tag: 'b' },
      { tag: 'strong' },
      { style: 'font-weight', getAttrs: (v) => /^(bold|[5-9]\d{2})/.test(String(v)) && null },
    ],
    toDOM: () => ['strong', 0],
  },

  italic: {
    inclusive: true,
    parseDOM: [
      { tag: 'i' },
      { tag: 'em' },
      { style: 'font-style=italic' },
    ],
    toDOM: () => ['em', 0],
  },

  link: {
    inclusive: false,
    attrs: {
      href: {
        default: '',
        validate: (v: unknown) => typeof v === 'string',
      },
    },
    parseDOM: [
      {
        tag: 'a[href]',
        getAttrs: (dom: HTMLElement) => ({
          href: dom.getAttribute('href') ?? '',
        }),
      },
    ],
    toDOM: (mark) => [
      'a',
      { href: String(mark.attrs['href'] ?? '') },
      0,
    ],
  },

  highlight: {
    inclusive: true,
    attrs: {
      // OOXML highlight values: "yellow", "green", "cyan", "magenta", "blue",
      // "red", "darkBlue", "darkCyan", "darkGreen", "darkMagenta", "darkRed",
      // "darkYellow", "darkGray", "lightGray", "black", "none"
      color: {
        default: 'yellow',
        validate: (v: unknown) => typeof v === 'string',
      },
    },
    parseDOM: [
      { tag: 'mark', getAttrs: () => ({ color: 'yellow' }) },
      {
        tag: 'span.pmd-highlight',
        getAttrs: (dom: HTMLElement) => ({
          color: dom.dataset['highlight'] ?? 'yellow',
        }),
      },
    ],
    // Render as <span class="pmd-highlight"> rather than <mark>. Class-
    // based targeting is more robust than the bare `mark` element
    // selector — ProseMirror's view layer can normalize element names
    // in ways that defeat element-typed CSS rules in some cases.
    toDOM: (mark) => [
      'span',
      {
        class: 'pmd-highlight',
        'data-highlight': String(mark.attrs['color'] ?? 'yellow'),
      },
      0,
    ],
  },

  font_color: {
    inclusive: true,
    attrs: {
      // Hex string, no leading "#" (OOXML convention): "555555", "1F3864", etc.
      color: {
        default: '000000',
        validate: (v: unknown) =>
          typeof v === 'string' && /^[0-9a-fA-F]{6}$/.test(v),
      },
    },
    parseDOM: [
      {
        tag: 'span[data-color]',
        getAttrs: (dom: HTMLElement) => ({
          color: dom.getAttribute('data-color') ?? '000000',
        }),
      },
    ],
    toDOM: (mark) => [
      'span',
      {
        style: `color: #${String(mark.attrs['color'] ?? '000000')}`,
        'data-color': String(mark.attrs['color'] ?? '000000'),
      },
      0,
    ],
  },

  font_size: {
    inclusive: true,
    attrs: {
      // Half-points (OOXML convention): 22 = 11pt, 24 = 12pt, 26 = 13pt, etc.
      halfPoints: {
        default: 22,
        validate: (v: unknown) =>
          typeof v === 'number' && Number.isInteger(v) && v > 0,
      },
    },
    parseDOM: [
      {
        tag: 'span[data-half-points]',
        getAttrs: (dom: HTMLElement) => {
          const v = dom.getAttribute('data-half-points');
          const n = v ? parseInt(v, 10) : 22;
          return { halfPoints: Number.isFinite(n) ? n : 22 };
        },
      },
    ],
    toDOM: (mark) => {
      const hp = Number(mark.attrs['halfPoints'] ?? 22);
      return [
        'span',
        {
          style: `font-size: ${hp / 2}pt`,
          'data-half-points': String(hp),
        },
        0,
      ];
    },
  },

  shading: {
    inclusive: true,
    attrs: {
      // Hex RGB, no leading "#"
      color: {
        default: 'D2D2D2',
        validate: (v: unknown) =>
          typeof v === 'string' && /^[0-9a-fA-F]{6}$/.test(v),
      },
    },
    parseDOM: [
      {
        tag: 'span[data-shading]',
        getAttrs: (dom: HTMLElement) => ({
          color: dom.getAttribute('data-shading') ?? 'D2D2D2',
        }),
      },
    ],
    toDOM: (mark) => [
      'span',
      {
        style: `background-color: #${String(mark.attrs['color'] ?? 'D2D2D2')}`,
        'data-shading': String(mark.attrs['color'] ?? 'D2D2D2'),
      },
      0,
    ],
  },
};
