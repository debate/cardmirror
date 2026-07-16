/**
 * Foreign clipboard HTML → CardMirror structure (smart paste conversion).
 *
 * Front-ends for the docx importer's assembly seam: classify Word
 * clipboard HTML (and, sharing the same run machinery, haku.cards
 * HTML) into the importer's `ParaInfo[]` intermediate and hand
 * assembly to `assembleDoc`, so paste and `.docx` import can never
 * disagree about structure. Routing (which converter runs, if any)
 * lives in `editor/paste-dialect.ts`; this module only converts.
 *
 * The conversion must EARN ITS KEEP: `convertWordHtml` returns null
 * when it finds no debate structure at all (no heading, no card, no
 * cite), and the caller falls through to the default paste path — a
 * false-positive dialect match degrades to today's behavior, never to
 * mangled output.
 *
 * Two classification layers, mirroring the importer:
 *   1. NAMES: Word carries its style table in the head `<style>` block
 *      (`span.Style13ptBold {mso-style-name:"Style 13 pt Bold\,Cite"}`)
 *      and references it via classes. Class tokens and mso-style-names
 *      resolve through the same vocabulary as `PSTYLE_TO_NODE` /
 *      `RSTYLE_TO_MARK` (ids, display names, aliases, legacy ids).
 *   2. VISUALS: when names are absent (short mid-paragraph copies,
 *      direct formatting, haku's classless output), classify by the
 *      ecosystem's visual conventions — the same constants the docx
 *      importer's outline-promotion uses (bold 26pt pocket / 22pt hat /
 *      16pt underlined block / 13pt bold tag & cite).
 */

import { type Node as PMNode, type Mark } from 'prosemirror-model';
import { schema } from '../schema/index.js';
import { assembleDoc, type ParaInfo } from './importer.js';
import { normalizeUnderlineMarks } from '../editor/named-style-normalizer-plugin.js';
import { stripXmlIllegal } from '../ooxml/xml.js';

// ─── Style vocabulary ────────────────────────────────────────────────────────

/** Lowercase + strip whitespace, so a display name ("Style 13 pt Bold")
 *  and its styleId ("Style13ptBold") compare equal — same normalization
 *  as `ooxml/styles.ts`. */
function tighten(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '');
}

/** Paragraph-style tokens → schema node type. Verbatim styleIds, their
 *  display names, and their aliases (see CANONICAL_STYLES_XML). */
const PARA_TOKEN_TO_NODE: Record<string, string> = {
  heading1: 'pocket',
  pocket: 'pocket',
  heading2: 'hat',
  hat: 'hat',
  heading3: 'block',
  block: 'block',
  heading4: 'tag',
  tag: 'tag',
  analytic: 'analytic',
  analyticreal: 'analytic',
  undertag: 'undertag',
};

/** Character-style tokens → schema mark name. Mirrors `RSTYLE_TO_MARK`
 *  including the legacy ids/names it documents. */
const CHAR_TOKEN_TO_MARK: Record<string, string> = {
  styleunderline: 'underline_mark',
  underline: 'underline_mark',
  styleboldunderline: 'underline_mark',
  style13ptbold: 'cite_mark',
  cite: 'cite_mark',
  stylestylebold12pt: 'cite_mark',
  'stylestylebold+12pt': 'cite_mark',
  emphasis: 'emphasis_mark',
  undertagchar: 'undertag_mark',
  analyticchar: 'analytic_mark',
};

/** The canonical display size (pt) each heading style renders at. A
 *  run-level font-size equal to its own paragraph's canonical size is
 *  the STYLE talking, not the user — suppressed so heading text doesn't
 *  import wearing a redundant `font_size` mark. */
const CANON_HEADING_PT: Record<string, number> = {
  pocket: 26,
  hat: 22,
  block: 16,
  tag: 13,
  analytic: 13,
  undertag: 12,
};

/** Word/haku highlight color spellings → OOXML named highlight values
 *  (the `highlight` mark's vocabulary). CSS names first (Word's
 *  mso-highlight vocabulary), then the hex spellings Word and haku
 *  emit (traditional + haku's new palette). Unknown hexes become
 *  `shading` instead (Word's own "protected highlight" convention). */
const HIGHLIGHT_NAME_TO_OOXML: Record<string, string> = {
  yellow: 'yellow',
  lime: 'green',
  aqua: 'cyan',
  cyan: 'cyan',
  magenta: 'magenta',
  fuchsia: 'magenta',
  blue: 'blue',
  red: 'red',
  navy: 'darkBlue',
  darkblue: 'darkBlue',
  teal: 'darkCyan',
  darkcyan: 'darkCyan',
  green: 'darkGreen',
  darkgreen: 'darkGreen',
  maroon: 'darkRed',
  darkred: 'darkRed',
  olive: 'darkYellow',
  darkyellow: 'darkYellow',
  gray: 'darkGray',
  grey: 'darkGray',
  darkgray: 'darkGray',
  silver: 'lightGray',
  lightgray: 'lightGray',
  black: 'black',
  '#ffff00': 'yellow',
  '#ff0': 'yellow',
  '#ffeb70': 'yellow',
  '#00ff00': 'green',
  '#0f0': 'green',
  '#b8f277': 'green',
  '#00ffff': 'cyan',
  '#0ff': 'cyan',
  '#03ffff': 'cyan',
  '#88c9ff': 'cyan',
  '#ff00ff': 'magenta',
  '#0000ff': 'blue',
  '#ff0000': 'red',
};

// ─── Head <style> dictionary ─────────────────────────────────────────────────

interface ClassInfo {
  /** mso-style-name value, unescaped ("Style 13 pt Bold,Cite"). */
  msoName: string | null;
  /** Raw declaration text, for visual-property lookups on unknown classes. */
  css: string;
}

/** Parse every `<style>` block into className → info. Word separates
 *  rules per class (`p.X, li.X, div.X {...}` / `span.Y {...}`); we
 *  record each class token found in a selector list against the rule's
 *  declarations. Good enough for Word's machine-generated CSS — this is
 *  a dictionary read, not a CSS engine. */
function parseStyleDict(dom: Document): Map<string, ClassInfo> {
  const dict = new Map<string, ClassInfo>();
  for (const styleEl of Array.from(dom.querySelectorAll('style'))) {
    const cssText = (styleEl.textContent ?? '').replace(/<!--|-->/g, '');
    for (const m of cssText.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = m[1]!;
      const body = m[2]!;
      const msoName = readMsoStyleName(body);
      for (const sel of selectors.split(',')) {
        const cm = /^\s*(?:p|li|div|span|h[1-6])?\.([A-Za-z][\w-]*)\s*$/.exec(sel);
        if (!cm) continue;
        const cls = cm[1]!;
        const prev = dict.get(cls);
        dict.set(cls, {
          msoName: msoName ?? prev?.msoName ?? null,
          css: prev ? `${prev.css};${body}` : body,
        });
      }
    }
  }
  return dict;
}

function readMsoStyleName(css: string): string | null {
  const m = /mso-style-name\s*:\s*("([^"]*)"|[^;"]+)/i.exec(css);
  if (!m) return null;
  const raw = (m[2] ?? m[1] ?? '').trim();
  return raw.replace(/\\/g, '') || null;
}

/** All lookup tokens a class carries: the class name itself, the full
 *  mso-style-name, and each of its comma-separated alias segments. */
function classTokens(cls: string, info: ClassInfo | undefined): string[] {
  const tokens = [tighten(cls)];
  if (info?.msoName) {
    tokens.push(tighten(info.msoName));
    for (const seg of info.msoName.split(',')) tokens.push(tighten(seg));
  }
  return tokens;
}

// ─── Inline run model ────────────────────────────────────────────────────────

/** Accumulated formatting state while walking a block's inline tree.
 *  `bold` is tri-state like OOXML: null = unset, false = an explicit
 *  normal weight blocking an inherited bold. */
interface RunStyle {
  bold: boolean | null;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  sup: boolean;
  sub: boolean;
  charMark: string | null;
  highlight: string | null;
  shading: string | null;
  fontColor: string | null;
  sizePt: number | null;
  href: string | null;
  boxed: boolean;
}

const BASE_RUN: RunStyle = {
  bold: null,
  italic: false,
  underline: false,
  strike: false,
  sup: false,
  sub: false,
  charMark: null,
  highlight: null,
  shading: null,
  fontColor: null,
  sizePt: null,
  href: null,
  boxed: false,
};

interface HtmlRun {
  text: string;
  rs: RunStyle;
}

function parseSizePt(value: string): number | null {
  const m = /([\d.]+)\s*pt/i.exec(value);
  if (!m) return null;
  const n = parseFloat(m[1]!);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Resolve a CSS background value to a highlight/shading classification. */
function classifyBackground(value: string): { highlight?: string; shading?: string } {
  const v = value.trim().toLowerCase();
  if (!v || v === 'transparent' || v === 'none' || v === 'inherit' || v === 'white' || v === '#ffffff' || v === '#fff') {
    return {};
  }
  const named = HIGHLIGHT_NAME_TO_OOXML[v];
  if (named) return { highlight: named };
  const hex = /^#([0-9a-f]{6})$/.exec(v);
  if (hex) return { shading: hex[1]!.toUpperCase() };
  const short = /^#([0-9a-f]{3})$/.exec(v);
  if (short) {
    const [r, g, b] = short[1]!;
    return { shading: `${r}${r}${g}${g}${b}${b}`.toUpperCase() };
  }
  return {};
}

/** Fold one inline element's contribution into a copy of the current
 *  run style. `dict` supplies class CSS for UNKNOWN classes only — a
 *  class that resolves to a named-style mark contributes the mark and
 *  nothing else (its CSS is the style's own display formatting, e.g.
 *  Style13ptBold's bold+13pt, which must not double as direct marks). */
function foldElement(el: Element, rs: RunStyle, dict: Map<string, ClassInfo>): RunStyle {
  const out: RunStyle = { ...rs };
  const tag = el.tagName.toLowerCase();
  if (tag === 'b' || tag === 'strong') out.bold = true;
  if (tag === 'i' || tag === 'em') out.italic = true;
  if (tag === 'u') out.underline = true;
  if (tag === 's' || tag === 'strike' || tag === 'del') out.strike = true;
  if (tag === 'sup') out.sup = true;
  if (tag === 'sub') out.sub = true;
  if (tag === 'a') {
    const href = el.getAttribute('href');
    if (href) out.href = href;
  }

  for (const cls of Array.from(el.classList)) {
    const info = dict.get(cls);
    let mark: string | null = null;
    for (const token of classTokens(cls, info)) {
      mark = CHAR_TOKEN_TO_MARK[token] ?? null;
      if (mark) break;
    }
    if (mark) {
      out.charMark = mark;
    } else if (info) {
      foldCss(info.css, out);
    }
  }

  const style = el.getAttribute('style');
  if (style) foldCss(style, out);
  return out;
}

/** Fold CSS declarations (inline style or an unknown class's rule body)
 *  into a run style. */
function foldCss(css: string, out: RunStyle): void {
  for (const decl of css.split(';')) {
    const idx = decl.indexOf(':');
    if (idx < 0) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const value = decl.slice(idx + 1).trim();
    const v = value.toLowerCase();
    switch (prop) {
      case 'font-weight':
        if (/^(bold|bolder|[5-9]\d\d)$/.test(v)) out.bold = true;
        else if (/^(normal|400|lighter|[1-3]\d\d)$/.test(v)) out.bold = false;
        break;
      case 'font-style':
        if (v.includes('italic') || v.includes('oblique')) out.italic = true;
        break;
      case 'text-decoration':
      case 'text-decoration-line':
        if (v.includes('underline')) out.underline = true;
        if (v.includes('line-through')) out.strike = true;
        if (v === 'none') out.underline = false;
        break;
      case 'font-size': {
        const pt = parseSizePt(v);
        if (pt !== null) out.sizePt = pt;
        break;
      }
      case 'mso-highlight': {
        const named = HIGHLIGHT_NAME_TO_OOXML[v];
        if (named) out.highlight = named;
        break;
      }
      case 'background':
      case 'background-color': {
        const c = classifyBackground(v);
        if (c.highlight) out.highlight = c.highlight;
        else if (c.shading && !out.highlight) out.shading = c.shading;
        break;
      }
      case 'color': {
        const hex = /^#([0-9a-f]{6})$/.exec(v);
        if (hex) out.fontColor = hex[1]!.toUpperCase();
        break;
      }
      case 'vertical-align':
        if (v.includes('super')) out.sup = true;
        else if (v.includes('sub')) out.sub = true;
        break;
      case 'border':
        // A bordered span is the Emphasis box (Word's Emphasis style has
        // a <w:bdr>; haku's "boxed" text is an inline windowtext border).
        if (v.includes('solid')) out.boxed = true;
        break;
    }
  }
}

/** Skip subtrees that are markup noise, not content: Word's fake list
 *  glyphs (`mso-list:Ignore` — the literal "1." text of an auto-number)
 *  and office-namespace elements (`<o:p>`). */
function skipElement(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag.includes(':')) return true;
  const style = el.getAttribute('style') ?? '';
  return /mso-list\s*:\s*ignore/i.test(style);
}

/** Collect the inline runs of one block element. */
function collectRuns(block: Element, dict: Map<string, ClassInfo>): HtmlRun[] {
  const runs: HtmlRun[] = [];
  const walk = (node: globalThis.Node, rs: RunStyle): void => {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      // HTML whitespace semantics: runs of spaces/newlines collapse to
      // one space (Word line-wraps its clipboard source mid-sentence).
      // NBSPs survive. XML-illegal characters are stripped at entry —
      // same definition as the export chokepoint.
      const text = stripXmlIllegal((node.nodeValue ?? '').replace(/[ \t\r\n]+/g, ' '));
      if (text) runs.push({ text, rs });
      return;
    }
    if (node.nodeType !== 1 /* ELEMENT_NODE */) return;
    const el = node as Element;
    if (skipElement(el)) return;
    if (el.tagName.toLowerCase() === 'br') {
      runs.push({ text: ' ', rs });
      return;
    }
    const next = foldElement(el, rs, dict);
    for (const child of Array.from(el.childNodes)) walk(child, next);
  };
  for (const child of Array.from(block.childNodes)) walk(child, BASE_RUN);
  return runs;
}

/** Direct-formatted cites: when a non-heading paragraph LEADS with a
 *  bold 13pt run (the ecosystem's cite convention — haku's cite lead
 *  span, hand-formatted Word cites), every bold-13pt run in the
 *  paragraph becomes a cite_mark instead of bold+font_size. Leading-run
 *  gated so an incidental bold-13pt word mid-body doesn't reclassify
 *  the whole paragraph as a cite. */
function applyCiteVisualRule(runs: HtmlRun[]): void {
  const isCiteish = (rs: RunStyle): boolean =>
    rs.bold === true &&
    rs.charMark === null &&
    rs.sizePt !== null &&
    Math.abs(rs.sizePt - 13) < 0.3;
  const first = runs.find((r) => r.text.trim());
  if (!first || !isCiteish(first.rs)) return;
  for (const r of runs) {
    if (isCiteish(r.rs)) {
      r.rs = { ...r.rs, charMark: 'cite_mark', bold: null, sizePt: null };
    }
  }
}

/** Build PM inline nodes from runs (mirrors `parseRPr`'s mark set). */
function runsToInlines(runs: HtmlRun[], nodeType: string): PMNode[] {
  const canonPt = CANON_HEADING_PT[nodeType];
  const inlines: PMNode[] = [];
  for (const run of runs) {
    const { rs } = run;
    const marks: Mark[] = [];
    if (rs.charMark) marks.push(schema.marks[rs.charMark]!.create());
    if (rs.boxed && !rs.charMark) marks.push(schema.marks['emphasis_mark']!.create());
    if (rs.bold === true) marks.push(schema.marks['bold']!.create());
    if (rs.italic) marks.push(schema.marks['italic']!.create());
    if (rs.underline && rs.charMark !== 'underline_mark') {
      // Direct underline; normalizeUnderlineMarks promotes it to the
      // named style in body-like textblocks, same as the docx path.
      marks.push(schema.marks['underline_direct']!.create());
    }
    if (rs.strike) marks.push(schema.marks['strikethrough']!.create());
    if (rs.sup) marks.push(schema.marks['superscript']!.create());
    else if (rs.sub) marks.push(schema.marks['subscript']!.create());
    if (rs.href) marks.push(schema.marks['link']!.create({ href: rs.href }));
    if (rs.highlight) marks.push(schema.marks['highlight']!.create({ color: rs.highlight }));
    if (rs.shading) marks.push(schema.marks['shading']!.create({ color: rs.shading }));
    // Font color is dropped on highlighted runs: the source's inline
    // color there is the tool's own contrast choice for its highlight
    // rendering (haku stamps color:#1b1b1c on every highlight span),
    // and CardMirror's highlight mark already forces contrast per
    // color band.
    if (rs.fontColor && rs.fontColor !== '000000' && !rs.highlight) {
      marks.push(schema.marks['font_color']!.create({ color: rs.fontColor }));
    }
    if (
      rs.sizePt !== null &&
      Math.abs(rs.sizePt - 11) >= 0.3 && // 11pt = the Normal default; not a user choice
      !(canonPt !== undefined && Math.abs(rs.sizePt - canonPt) < 0.3) &&
      rs.charMark !== 'cite_mark' // cite renders its own 13pt
    ) {
      marks.push(
        schema.marks['font_size']!.create({ halfPoints: Math.round(rs.sizePt * 2) }),
      );
    }
    inlines.push(schema.text(run.text, marks));
  }
  return inlines;
}

// ─── Block classification ────────────────────────────────────────────────────

const H_TAG_TO_NODE: Record<string, string> = {
  h1: 'pocket',
  h2: 'hat',
  h3: 'block',
  h4: 'tag',
};

/** Word auto-numbering: `mso-list:l0 level1 lfo3` on the paragraph. The
 *  lfo (list format override) is the closest HTML analog of the docx
 *  numId instance; level is 1-based where ilvl is 0-based. Feeds the
 *  same `reconstructNumbering` pass the docx importer runs, so numbered
 *  cards keep their numbering skeleton through paste. */
function readMsoList(style: string): { numId: number; ilvl: number } | null {
  const m = /mso-list\s*:\s*l\d+\s+level(\d+)\s+lfo(\d+)/i.exec(style);
  if (!m) return null;
  return { numId: parseInt(m[2]!, 10), ilvl: parseInt(m[1]!, 10) - 1 };
}

function classifyBlock(
  el: Element,
  runs: HtmlRun[],
  dict: Map<string, ClassInfo>,
): string {
  // 1. Named paragraph style via class (mso-style-name aware). Checked
  //    before the h-tag so a custom style based on a heading (Analytic
  //    is basedOn Heading4) classifies by its own name.
  for (const cls of Array.from(el.classList)) {
    for (const token of classTokens(cls, dict.get(cls))) {
      const node = PARA_TOKEN_TO_NODE[token];
      if (node) return node;
      // Mirror fallbackNodeType's rule 2: any paragraph style whose
      // name mentions "analytic" is an analytic.
      if (token.includes('analytic')) return 'analytic';
    }
  }
  // 2. Word emits <h1>–<h4> for the built-in heading styles.
  const byTag = H_TAG_TO_NODE[el.tagName.toLowerCase()];
  if (byTag) return byTag;
  // 3. Outline-level promotion with the docx importer's visual guards
  //    (mso-outline-level is Word's HTML spelling of <w:outlineLvl>+1).
  const style = el.getAttribute('style') ?? '';
  const om = /mso-outline-level\s*:\s*(\d+)/i.exec(style);
  if (om) {
    const level = parseInt(om[1]!, 10);
    const boldAt = (pt: number): boolean =>
      runs.some(
        (r) => r.rs.bold === true && r.rs.sizePt !== null && Math.abs(r.rs.sizePt - pt) < 0.3,
      );
    if (level === 1 && boldAt(26)) return 'pocket';
    if (level === 2 && boldAt(22)) return 'hat';
    if (level === 3 && runs.some((r) => r.rs.bold === true && r.rs.underline && r.rs.sizePt === 16)) {
      return 'block';
    }
    if (level === 4 && runs.some((r) => r.rs.bold === true || r.rs.charMark === 'cite_mark')) {
      return 'tag';
    }
  }
  return 'paragraph';
}

// ─── Block walk + assembly ───────────────────────────────────────────────────

const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'pre', 'blockquote']);

function collectParas(root: Element, dict: Map<string, ClassInfo>): ParaInfo[] {
  const paras: ParaInfo[] = [];
  const visit = (el: Element): void => {
    if (skipElement(el)) return;
    const tag = el.tagName.toLowerCase();
    if (BLOCK_TAGS.has(tag)) {
      const runs = collectRuns(el, dict);
      // Whitespace-only paragraphs (Word's `<p class=MsoNormal><o:p>&nbsp;
      // </o:p></p>` spacers) import as EMPTY paragraphs, docx-parity.
      const meaningful = runs.some((r) => r.text.replace(/ /g, ' ').trim() !== '');
      const nodeType = classifyBlock(el, runs, dict);
      if (nodeType === 'paragraph' || nodeType === 'undertag') {
        applyCiteVisualRule(runs);
      }
      const style = el.getAttribute('style') ?? '';
      const num = readMsoList(style);
      const para: ParaInfo = {
        nodeType,
        inlines: meaningful ? runsToInlines(runs, nodeType) : [],
        headingId: null,
        pStyle: el.classList[0] ?? tag,
        indent: 0,
        spacing: null,
      };
      if (num) {
        para.numId = num.numId;
        para.ilvl = num.ilvl;
      }
      paras.push(para);
      return; // blocks don't nest further for our purposes
    }
    for (const child of Array.from(el.children)) visit(child);
  };
  for (const child of Array.from(root.children)) visit(child);
  return paras;
}

/** Drop leading/trailing EMPTY plain paragraphs — clipboard fragments
 *  routinely carry spacer paragraphs at the edges that would paste as
 *  stray blank lines. Interior empties are kept (docx parity: they are
 *  the document's own vertical spacing). */
function trimEdgeEmpties(paras: ParaInfo[]): ParaInfo[] {
  const isEmptyPara = (p: ParaInfo): boolean =>
    p.nodeType === 'paragraph' &&
    !p.rawNode &&
    p.inlines.every((n) => !n.text || !n.text.replace(/ /g, ' ').trim());
  let start = 0;
  let end = paras.length;
  while (start < end && isEmptyPara(paras[start]!)) start++;
  while (end > start && isEmptyPara(paras[end - 1]!)) end--;
  return paras.slice(start, end);
}

/** The conversion only sticks when it actually found debate structure;
 *  plain prose converts to bare paragraphs and must fall through to the
 *  default paste path instead. */
function hasDebateStructure(doc: PMNode): boolean {
  let found = false;
  doc.descendants((n) => {
    if (found) return false;
    const t = n.type.name;
    if (
      t === 'card' ||
      t === 'analytic_unit' ||
      t === 'pocket' ||
      t === 'hat' ||
      t === 'block' ||
      t === 'cite_paragraph' ||
      t === 'undertag'
    ) {
      found = true;
    }
    return !found;
  });
  return found;
}

function convertViaImporter(html: string): PMNode | null {
  const dom = new DOMParser().parseFromString(html, 'text/html');
  const dict = parseStyleDict(dom);
  const paras = trimEdgeEmpties(collectParas(dom.body, dict));
  if (!paras.length) return null;
  const doc = normalizeUnderlineMarks(assembleDoc(paras));
  return hasDebateStructure(doc) ? doc : null;
}

/**
 * Convert Word clipboard HTML into a CardMirror doc, or null when the
 * HTML contains no recognizable debate structure (caller falls through
 * to the default paste). The caller is responsible for routing — this
 * assumes `detectPasteDialect` already said 'word'.
 */
export function convertWordHtml(html: string): PMNode | null {
  return convertViaImporter(html);
}

/**
 * Convert haku.cards clipboard HTML. haku's copy builders emit
 * classless, entirely inline-styled HTML that deliberately mimics the
 * Verbatim visual conventions (13pt bold `<h4>` tag, bold-13pt cite
 * lead span, `<u>` underlines, mso-highlight spans, small-pt shrunk
 * runs, 26/22pt `h1`/`h2` case headings) — exactly the visual-rules
 * path of the shared pipeline, with the class dictionary a natural
 * no-op. Known quirk, accepted for now: the source-file breadcrumb
 * paragraphs haku includes between cite and body (plain 11pt lines
 * naming the original pocket/hat/block) are indistinguishable from
 * body text and import as card_body paragraphs.
 */
export function convertHakuHtml(html: string): PMNode | null {
  return convertViaImporter(html);
}
