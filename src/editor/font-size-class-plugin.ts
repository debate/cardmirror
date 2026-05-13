/**
 * Font-size class plugin.
 *
 * Tags each body paragraph with `pmd-fs-shrunk` plus an inline
 * `style="line-height: Xpt"` reflecting the *smallest* font-size among
 * its text nodes. The point of the inline style is to drop the
 * paragraph's strut so lines containing only small-font content can
 * pack tightly — Word's per-line line-height behavior for citation
 * blocks. CRITICAL: the paragraph's own `font-size` is NOT touched.
 * "Shrunk" is purely a line-height adjustment, never a font cascade.
 *
 * Why this is needed: `font_size` is a mark, so it renders as inline
 * `<span style="font-size: ...">`. The wrapping `<p>` element keeps
 * the inherited body line-height, and CSS line-boxes always include a
 * hidden "strut" at the block element's own font-size × line-height.
 * Without this plugin, a paragraph whose every span is 4pt still has
 * a ~13.2pt-tall strut (11pt × 1.2), and lines never collapse below
 * that.
 *
 * Why line-height-only (not font-size + line-height): an earlier
 * version of this plugin set both `font-size: <min>pt` AND
 * `line-height: <multiplier>` on the paragraph. That meant any text
 * inside the paragraph WITHOUT an explicit `font_size` mark cascade-
 * shrunk to the small size — visually inconsistent with what the
 * mark inspector reports (the user sees small text but no marks),
 * and a fragile workaround (an inline `font-size: 11pt` decoration
 * over bare ranges) was needed to keep bare body text readable.
 * Setting only line-height (in absolute pt) collapses the strut
 * without touching the font cascade: bare text inside a shrunken
 * paragraph still inherits body 11pt naturally, and per-line height
 * still works because each line's height is the max of its content's
 * own natural extent and the paragraph's strut.
 *
 * Per-line strut behavior with absolute line-height: when the
 * paragraph's `line-height: <minPt × multiplier>pt` is inherited as
 * a length, every inline element on its lines contributes that strut.
 * Each line's height is max(strut, the actual content's natural
 * extent). So:
 *   - small-font-only line: strut wins. Tight.
 *   - 11pt bare line: ~11pt (the content wins).
 *   - 13pt cite line: ~13pt (the content wins).
 *   - mixed line: max content extent.
 * Matches Word's "single" line-spacing across mixed-font runs without
 * a font-size cascade.
 *
 * The multiplier is governed by `shrunkLineHeightMultiplier` — a
 * linear ramp from 1.0 at 6pt to 1.6 at 11pt, clamped outside that
 * range. Smaller fonts pack proportionally tighter (since they're
 * usually fine-print citation material the user is happy to compress).
 *
 * Why named-style cascade is no longer a concern: with paragraph
 * font-size left alone, `.pmd-underline` / `.pmd-emphasis` / etc.
 * inherit body 11pt as before, and `.pmd-cite` keeps its 13pt via
 * its own unconditional CSS rule. No `.pmd-fs-shrunk .pmd-*`
 * font-size pinning is needed.
 *
 * Per-keystroke incremental update: existing decorations get mapped
 * through each transaction; only paragraphs in the touched
 * (top-level-expanded) range are recomputed. This keeps typing latency
 * O(touched-region) instead of O(whole-doc) on large docs.
 */

import { Plugin } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { changedRange, expandToTopLevel } from './decoration-range.js';

const BODY_PARA_TYPES = new Set([
  'card_body',
  'paragraph',
  'cite_paragraph',
  'undertag',
]);

/** OOXML default body size: 11pt = 22 half-points. */
const DEFAULT_HALF_POINTS = 22;

export const fontSizeClassPlugin: Plugin<DecorationSet> = new Plugin<DecorationSet>({
  state: {
    init(_, { doc }) {
      return computeFullSet(doc);
    },
    apply(tr, prev) {
      if (!tr.docChanged) return prev;

      const range = changedRange(tr);
      if (!range) return prev.map(tr.mapping, tr.doc);

      const expanded = expandToTopLevel(tr.doc, range.from, range.to);
      const mapped = prev.map(tr.mapping, tr.doc);
      const stale = mapped.find(expanded.from, expanded.to);
      const fresh = computeDecorationsInRange(tr.doc, expanded.from, expanded.to);
      return mapped.remove(stale).add(tr.doc, fresh);
    },
  },
  props: {
    decorations(state) {
      return fontSizeClassPlugin.getState(state);
    },
  },
});

function computeFullSet(doc: PMNode): DecorationSet {
  return DecorationSet.create(doc, computeDecorationsInRange(doc, 0, doc.content.size));
}

function computeDecorationsInRange(doc: PMNode, from: number, to: number): Decoration[] {
  const decos: Decoration[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!BODY_PARA_TYPES.has(node.type.name)) return;
    const stats = computeFontSizeStats(node);
    if (stats.min >= DEFAULT_HALF_POINTS) return;

    const minPt = stats.min / 2;
    decos.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: 'pmd-fs-shrunk',
        // Absolute pt line-height collapses the paragraph's strut so
        // small-font-only lines can pack tight. The multiplier is a
        // CSS calc() over `var(--pmd-line-height)` — see
        // `shrunkLineHeightCss` for the curve.
        style: `line-height: ${shrunkLineHeightCss(minPt)}`,
      }),
    );

    // Every text run in a shrunken paragraph gets an inline line-height
    // declaration that:
    //   1. Tracks the body knob (`var(--pmd-line-height)`), unitless,
    //      so when applied to an inline element it resolves to
    //      multiplier × that-element's-own-font-size.
    //   2. Is floored at 1.2 — enough to clear Calibri's natural
    //      ascender + descender extent at any font-size, preventing
    //      adjacent small-font lines from drawing over each other.
    //
    // Why this is needed: the paragraph's block-level `line-height:
    // <minPt × ramp>pt` is an absolute length that's inherited as a
    // length by descendants. That value can fall below an inline
    // run's natural rendered extent (e.g., 8.64pt strut vs Calibri
    // 8pt's ~9.5pt natural extent), causing visible overlap. The
    // `max(..., 1.2)` floor here is the safe minimum.
    let offset = 1;
    node.forEach((child) => {
      if (child.isText) {
        const start = pos + offset;
        const end = start + child.nodeSize;
        decos.push(
          Decoration.inline(start, end, {
            style: 'line-height: max(var(--pmd-line-height), 1.2)',
          }),
        );
      }
      offset += child.nodeSize;
    });
  });
  return decos;
}

/**
 * Smallest `font_size` half-points value across all text nodes in
 * `para`, capped at the default 22 (11pt). Text without a `font_size`
 * mark counts as the default. Retained as a public helper for tests
 * and any external consumers.
 */
export function computeMinHalfPoints(para: PMNode): number {
  return computeFontSizeStats(para).min;
}


/**
 * CSS `line-height` value for a shrunken paragraph as a function of
 * the paragraph's smallest font_size in pt. Two anchors:
 *
 *   minPt ≥ 11pt → body knob (`var(--pmd-line-height)`) × minPt.
 *                  Plugin doesn't fire here in practice (the >=
 *                  threshold guard above), so this branch only
 *                  matters if the threshold is ever loosened.
 *   minPt = 6pt  → 1.0 × minPt = 6pt absolute. Fully tight.
 *   minPt ≤ 6pt  → 1.0 × minPt. Fully tight, clamped.
 *
 * Between 6pt and 11pt the multiplier ramps linearly from 1.0 at
 * 6pt up to the body knob at 11pt — so changing `--pmd-line-height`
 * proportionally scales the looser end of the ramp without lifting
 * the very-small-font floor off 1.0. Bumping body to 1.6 makes 8pt
 * shrunken paragraphs 8pt × 1.24 = 9.92pt; bumping it to 2.0 makes
 * them 8pt × 1.4 = 11.2pt; etc. 6pt-and-below stays at 6pt regardless.
 *
 * Returned as a CSS expression so the browser re-evaluates whenever
 * `--pmd-line-height` changes — no need to recompute decorations
 * when the user nudges the body knob.
 */
export function shrunkLineHeightCss(minPt: number): string {
  if (minPt <= 6) return `${minPt}pt`;
  if (minPt >= 11) return `calc(${minPt}pt * var(--pmd-line-height))`;
  // ramp fraction: 0 at 6pt → 1 at 11pt.
  const rampFrac = +((minPt - 6) / 5).toFixed(4);
  return `calc(${minPt}pt * (1 + ${rampFrac} * (var(--pmd-line-height) - 1)))`;
}

interface FontSizeStats {
  min: number;
  max: number;
  /** True if any text node has no `font_size` mark (i.e., its size
   *  comes from CSS / paragraph defaults rather than direct formatting). */
  hasBare: boolean;
}

function computeFontSizeStats(para: PMNode): FontSizeStats {
  let min = DEFAULT_HALF_POINTS;
  let max = DEFAULT_HALF_POINTS;
  let hasBare = false;
  para.descendants((child) => {
    if (!child.isText || !child.text) return;
    const fontSizeMark = child.marks.find((m) => m.type.name === 'font_size');
    if (!fontSizeMark) {
      hasBare = true;
      return;
    }
    const hp = Number(fontSizeMark.attrs['halfPoints'] ?? DEFAULT_HALF_POINTS);
    if (hp < min) min = hp;
    if (hp > max) max = hp;
  });
  return { min, max, hasBare };
}
