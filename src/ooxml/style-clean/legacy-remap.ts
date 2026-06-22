/**
 * Legacy debate-style remapping for the .docx style cleaner.
 *
 * Pre-Verbatim debate files (and files merged from them) style their content
 * with an older vocabulary — Tags / Cards / Cites / Block Headings / Nothing,
 * Author-Date / Debate Underline — that the Verbatim cleaner doesn't recognize.
 * Left alone, the cleaner removes those unknown styles and the content collapses
 * to Normal. This pass reassigns the legacy styles to the canonical Verbatim
 * styles BEFORE the formatting→style conversion runs, so the rest of the cleaner
 * sees a Verbatim-shaped document.
 *
 * It only acts on documents that actually USE an unambiguously-legacy style — so
 * a modern doc that merely *carries* legacy definitions (e.g. a merged file like
 * AFF-Space) is untouched — and it matches each paragraph/run by name, so a
 * partially-migrated ("mixed") document keeps its already-Verbatim content and
 * only the legacy parts are converted.
 *
 * Heading levels:
 *   - Mixed doc (Verbatim styles already present): trust each legacy heading's
 *     own outline level → the canonical heading at that level (outline 0 → H1,
 *     1 → H2, 2 → H3, 3 → H4). Verbatim's own Heading 1–4 are outline 0–3, so
 *     real Verbatim headings map to themselves (the pass is idempotent on them).
 *   - Pure pre-Verbatim doc: no canonical reference, so infer the depth — the
 *     deepest heading level above tags → Heading 3, growing up (H2, H1).
 *   - Tags are Heading 4 in both modes, no matter their outline level.
 */

import { CANONICAL_STYLES_XML } from '../styles.js';
import { OoxmlDoc } from './ooxml-doc.js';

type LegacyRole = 'tag' | 'heading' | 'cite' | 'body' | 'char-cite' | 'char-underline';

/** Legacy style names → role (matched on the UI name, case-insensitively). */
const LEGACY_ROLES: Record<string, LegacyRole> = {
  // Tags → always Heading 4.
  tags: 'tag',
  tag: 'tag',
  'debate tag': 'tag',
  'heading 4': 'tag',
  // Organizational headings → level chosen per mode.
  'block headings': 'heading',
  'block heading': 'heading',
  'block title': 'heading',
  'hidden block header': 'heading',
  'heading 1': 'heading',
  'heading 2': 'heading',
  'heading 3': 'heading',
  // Citation paragraph → Normal (the cite itself is the char-cite on its runs).
  cites: 'cite',
  cite: 'cite',
  'debate cite main': 'cite',
  'debate secondary cite': 'cite',
  normalcite: 'cite',
  // Body text → Normal.
  cards: 'body',
  card: 'body',
  'card text': 'body',
  'card (indented)': 'body',
  nothing: 'body',
  'normal text': 'body',
  'evidence text': 'body',
  // Character styles.
  'author-date': 'char-cite',
  'debate underline': 'char-underline',
  'debate highlighted': 'char-underline',
  underline: 'char-underline',
  'dotted underline': 'char-underline',
};

/** Names also used by modern Verbatim (Word's built-in headings). Their presence
 *  alone does NOT mark a document as legacy — the gate needs an unambiguous
 *  marker — but once it has tripped they are remapped along with the rest. */
const AMBIGUOUS = new Set(['heading 1', 'heading 2', 'heading 3', 'heading 4']);

export interface RemapOptions {
  /** True when the document already has the Verbatim styles (a "mixed" doc):
   *  trust each legacy heading's outline level directly. False for a pure
   *  pre-Verbatim doc: infer the hierarchy depth adaptively. */
  mixedMode: boolean;
  /** Style names (lowercased) the user protected — never remapped. */
  protectedNamesLower?: Set<string>;
}

interface LegacyInfo {
  role: LegacyRole;
  ambiguous: boolean;
  /** The style's effective outline level (basedOn-resolved), or -1 if none. */
  outline: number;
}

/** Reassign legacy debate styles to canonical Verbatim styles, in place.
 *  Returns true if it remapped anything; a no-op (false) unless the document
 *  actually uses an unambiguously-legacy style. */
export function remapLegacyStyles(doc: OoxmlDoc, opts: RemapOptions): boolean {
  const protectedNames = opts.protectedNamesLower ?? new Set<string>();

  // 1. Index DEFINED legacy styles by id. (Cheap O(styles) screen — most modern
  //    docs define none, so we bail before touching content.)
  const legacyById = new Map<string, LegacyInfo>();
  for (const style of doc.styles.all()) {
    const name = style.name;
    if (name === null) continue;
    const lc = name.toLowerCase();
    const role = LEGACY_ROLES[lc];
    if (!role || protectedNames.has(lc)) continue;
    const sid = style.styleId;
    if (sid === null) continue;
    legacyById.set(sid, {
      role,
      ambiguous: AMBIGUOUS.has(lc),
      outline: doc.styles.effectiveStyleFormat(sid).outlineLevel ?? -1,
    });
  }
  if (legacyById.size === 0) return false;

  // 2. Scan usage: the gate is "an unambiguous legacy style is actually USED"
  //    (so a doc that merely defines them is left alone), and collect the
  //    heading-role outline levels present for the adaptive map.
  let tripped = false;
  const headingLevels = new Set<number>();
  for (const paragraph of doc.paragraphs) {
    const pInfo = legacyById.get(paragraph.style.styleId ?? '');
    if (pInfo) {
      if (!pInfo.ambiguous) tripped = true;
      if (pInfo.role === 'heading') headingLevels.add(paragraph.effectiveOutlineLevel() ?? -1);
    }
    for (const run of paragraph.runs) {
      const rInfo = legacyById.get(run.style.styleId ?? '');
      if (rInfo && !rInfo.ambiguous) tripped = true;
    }
  }
  if (!tripped) return false;

  // 3. Ensure the canonical targets exist (a mixed doc may lack some headings).
  doc.injectMissingStyles(CANONICAL_STYLES_XML);

  // 4. Heading outline level → canonical style id.
  const headingFor = buildHeadingMap(headingLevels, opts.mixedMode);

  // 5. Apply.
  for (const paragraph of doc.paragraphs) {
    const pInfo = legacyById.get(paragraph.style.styleId ?? '');
    if (pInfo) {
      if (pInfo.role === 'tag') {
        paragraph.style = doc.styles.get('Heading4');
      } else if (pInfo.role === 'heading') {
        paragraph.style = doc.styles.get(headingFor(paragraph.effectiveOutlineLevel() ?? -1));
      } else if (pInfo.role === 'cite' || pInfo.role === 'body') {
        paragraph.style = doc.styles.get('Normal');
      }
    }
    for (const run of paragraph.runs) {
      const rInfo = legacyById.get(run.style.styleId ?? '');
      if (!rInfo) continue;
      if (rInfo.role === 'char-cite') run.style = doc.styles.get('Style13ptBold');
      else if (rInfo.role === 'char-underline') run.style = doc.styles.get('StyleUnderline');
    }
  }
  return true;
}

/** Build the legacy-heading-outline-level → canonical-style-id function. */
function buildHeadingMap(levels: Set<number>, mixedMode: boolean): (level: number) => string {
  if (mixedMode) {
    // Trust the level: outline 0 → Heading 1 … 3 → Heading 4 (clamp 1..5).
    return (level) => `Heading${Math.min(Math.max(level + 1, 1), 5)}`;
  }
  // Adaptive: deepest level above tags → Heading 3, growing up to Heading 1.
  const sorted = [...levels].sort((a, b) => b - a); // deepest (largest outline) first
  const targets = ['Heading3', 'Heading2', 'Heading1'];
  const map = new Map<number, string>();
  sorted.forEach((level, i) => map.set(level, targets[Math.min(i, targets.length - 1)]!));
  return (level) => map.get(level) ?? 'Heading1';
}
