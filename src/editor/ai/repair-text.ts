/**
 * AI Repair Text — mirror of the "Card Formatting Tools" Repair Text tool,
 * redesigned to emit a LIST OF FIXES rather than the whole corrected text.
 *
 * Why diffs, not whole text: repair is a minimal-intervention task (fix OCR
 * / PDF extraction artifacts, change nothing else). Round-tripping the full
 * selection maximizes the chance the model silently rewords something and
 * wastes output tokens on text that's 99% unchanged. Instead the model
 * returns `{ fixes: [{ find, replace }] }`, each `find` a verbatim
 * substring of the selection; we locate each in the doc and apply it in
 * place. The model literally cannot touch anything it doesn't name.
 *
 * Locating: we flatten the selection to text with `\n` between blocks (so
 * the model doesn't read paragraph boundaries as run-together words) plus a
 * char→PM-position map. A `find` that spans a block boundary maps to a doc
 * range crossing it; `insertText` over that range joins the blocks — which
 * is exactly right for hyphenation split across lines ("re-\nsearch").
 */

import type { EditorView } from 'prosemirror-view';
import { Selection } from 'prosemirror-state';
import type { EditorState, Transaction } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { settings } from '../settings.js';
import { callAnthropic, AnthropicError } from './anthropic.js';
import { showToast } from '../toast.js';
import { ThinkingTooltip } from './thinking-tooltip.js';
import {
  withRepairFlash,
  setRepairFlashes,
  clearRepairFlashes,
} from '../repair-highlight-plugin.js';

export const DEFAULT_REPAIR_PROMPT = `You are a specialized text repair tool. Your task is to identify and fix common OCR and PDF text-extraction errors while preserving the original meaning and content exactly.

Focus exclusively on these types of errors:
1. Character substitutions and ligature issues (e.g., "fl" appearing as "ff", "fi" appearing as a missing-glyph box)
2. Number/letter confusions (e.g., "0" for "O", "l" for "1", "rn" for "m"). Note that some numbers should be preserved because they are footnotes.
3. Random line breaks or hyphenation (e.g., "re-\\nsearch" should be "research")
4. A stray space after (or before) a hyphen inside a word — VERY common in PDF extraction. Two sub-cases:
   - If the word is a genuinely hyphenated compound or prefixed term, KEEP the hyphen and remove only the stray space (e.g., "neo- Gramscian" should be "neo-Gramscian"; "vis-a- vis" should be "vis-a-vis"; "self- determination" should be "self-determination").
   - If it is an ordinary word that was split across a line, remove the hyphen AND the space (e.g., "re- search" should be "research").
5. Extra or missing spaces (e.g., "thisis" should be "this is")
6. Common punctuation errors (e.g., missing periods, commas appearing as periods)
7. Other typical OCR errors that are clearly unintentional

EXTREMELY IMPORTANT GUIDELINES:
- Make NO substantive changes to the text's meaning or content.
- NEVER add, remove, or modify actual content; NEVER rewrite for clarity or style.
- NEVER correct grammar, spelling, or word choice unless it is clearly an OCR error.
- If there is ANY uncertainty about a potential error, leave the text as is.
- A line break (shown as a newline in the input) is a real paragraph boundary. Do NOT merge across one unless it is a hyphenation artifact (a word split with a trailing hyphen).

BE EXHAUSTIVE. Scan the WHOLE input from the very first character to the very last — do not stop early or skim once you've found several errors. Pay special attention to spots that are easy to overlook:
- the FIRST word of every paragraph / sentence, including Capitalized words (errors there are easy to miss);
- the last paragraph and the final lines of the text;
- repeated errors — list EACH occurrence separately, even if you already fixed the same word elsewhere.
Re-read the text once more before you finish to catch anything you skipped.

Respond with ONLY a JSON object of exactly this shape — no prose, no code fences:

{"fixes": [{"find": "<text>", "replace": "<text>"}]}

Rules for the list:
- "find" MUST be copied VERBATIM from the input I give you — character for character, including any newlines (write them as actual \\n in the JSON string).
- Include enough surrounding context in "find" that it occurs only once (or, if a fix repeats, list it once per occurrence in reading order).
- "replace" is "find" with ONLY the OCR/PDF error corrected; everything else in it stays identical.
- List the fixes in the order they appear in the text.
- If there are no errors, return {"fixes": []}.`;

export interface RepairFix {
  find: string;
  replace: string;
}

/** Parse the model's JSON reply into a list of fixes. Tolerates code
 *  fences / surrounding prose by extracting the outermost `{...}`. Drops
 *  malformed entries; throws only when no JSON object is present. */
export function parseRepairResponse(text: string): RepairFix[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('Repair response had no JSON object.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error(`Repair response was not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const rawFixes = (parsed as { fixes?: unknown })?.fixes;
  if (!Array.isArray(rawFixes)) return [];
  const out: RepairFix[] = [];
  for (const f of rawFixes) {
    if (
      f &&
      typeof (f as RepairFix).find === 'string' &&
      typeof (f as RepairFix).replace === 'string' &&
      (f as RepairFix).find.length > 0 &&
      (f as RepairFix).find !== (f as RepairFix).replace
    ) {
      out.push({ find: (f as RepairFix).find, replace: (f as RepairFix).replace });
    }
  }
  return out;
}

interface FlatSelection {
  text: string;
  /** `pos[i]` = the PM position immediately before flat char `i`. */
  pos: number[];
}

/** Flatten `[from, to)` to text with `\n` between blocks (so the model
 *  reads paragraph boundaries, not run-together words) and a char→position
 *  map. Images are skipped (repair is text-only). Exported for testing. */
export function flattenSelection(doc: PMNode, from: number, to: number): FlatSelection {
  let text = '';
  const pos: number[] = [];
  let lastParent: PMNode | null = null;
  let prevTextEnd = from;
  doc.nodesBetween(from, to, (node, p, parent) => {
    if (!node.isText) return true;
    const t = node.text ?? '';
    const s = Math.max(from, p);
    const e = Math.min(to, p + t.length);
    if (e <= s) return false;
    if (lastParent !== null && parent !== lastParent && text.length > 0) {
      // Block boundary → newline, anchored at the end of the previous block.
      text += '\n';
      pos.push(prevTextEnd);
    }
    for (let i = s; i < e; i++) {
      text += t[i - p];
      pos.push(i);
    }
    prevTextEnd = e;
    lastParent = parent;
    return false;
  });
  return { text, pos };
}

/** Right edge (PM position) of the flat char at `idx-1`. */
function endPos(flat: FlatSelection, idx: number): number {
  if (idx < flat.pos.length) return flat.pos[idx]!;
  return (flat.pos[flat.pos.length - 1] ?? 0) + 1;
}

export interface LocatedFix {
  from: number;
  to: number;
  replace: string;
}

/** Fold the characters the model routinely fails to echo verbatim,
 *  keeping a map from each folded char back to its raw index (a
 *  multi-char fold like a ligature maps every output char to the same
 *  raw index). Curly quotes/dashes -> ASCII, ligatures expanded, NBSP /
 *  tab / newline -> space, soft hyphen and zero-width characters
 *  dropped. The pilcrow glyph is deliberately NOT folded: it is
 *  meaningful condensed-card content, and a folded match spanning one
 *  would silently delete it. */
function foldWithMap(s: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    let out: string;
    if (ch === '‘' || ch === '’' || ch === '‚') out = "'";
    else if (ch === '“' || ch === '”' || ch === '„') out = '"';
    else if (ch === '—' || ch === '–' || ch === '‒') out = '-';
    else if (ch === '\u00A0' || ch === '\t' || ch === '\n') out = ' ';
    else if (ch === 'ﬀ') out = 'ff';
    else if (ch === 'ﬁ') out = 'fi';
    else if (ch === 'ﬂ') out = 'fl';
    else if (ch === 'ﬃ') out = 'ffi';
    else if (ch === 'ﬄ') out = 'ffl';
    else if (ch === '\u00AD' || ch === '\u200B' || ch === '\u200C' || ch === '\u200D' || ch === '\uFEFF') out = '';
    else out = ch;
    norm += out;
    for (let k = 0; k < out.length; k++) map.push(i);
  }
  return { norm, map };
}

/** Fallback placement when the verbatim search misses: match in folded
 *  space, then apply ONLY the differing middle of find->replace -- the
 *  actual correction. The agreeing prefix/suffix are never edited, so
 *  the document keeps its punctuation and ligatures there, and the
 *  CONTEXT may even span a block boundary (models often write a space
 *  where the doc has a newline). Rejected only when the edit itself
 *  would cross a block boundary -- joining or splitting blocks from a
 *  non-verbatim match is too risky. */
function locateNormalized(
  flat: FlatSelection,
  hay: { norm: string; map: number[] },
  fix: RepairFix,
  cursorFlat: number,
): (LocatedFix & { cursorFlat: number }) | null {
  const nf = foldWithMap(fix.find);
  const nr = foldWithMap(fix.replace);
  if (!nf.norm) return null;
  // First occurrence at/after the flat cursor, falling back to the first
  // occurrence anywhere (mirrors the verbatim search's ordering rules).
  let idx = -1;
  for (let i = hay.norm.indexOf(nf.norm); i >= 0; i = hay.norm.indexOf(nf.norm, i + 1)) {
    if (hay.map[i]! >= cursorFlat) { idx = i; break; }
    if (idx < 0) idx = i; // remember the global-first as fallback
  }
  if (idx < 0) return null;
  const flatEnd = hay.map[idx + nf.norm.length - 1]! + 1;

  // Agreeing prefix/suffix between folded find and folded replace.
  let p = 0;
  while (p < nf.norm.length && p < nr.norm.length && nf.norm[p] === nr.norm[p]) p++;
  let s = 0;
  while (
    s < nf.norm.length - p &&
    s < nr.norm.length - p &&
    nf.norm[nf.norm.length - 1 - s] === nr.norm[nr.norm.length - 1 - s]
  ) s++;
  // Don't split a multi-char fold (ligature) at either boundary -- back
  // the boundary off until it sits between whole raw characters.
  while (
    p > 0 &&
    ((p < nf.norm.length && hay.map[idx + p - 1] === hay.map[idx + p]) ||
      (p < nr.norm.length && nr.map[p - 1] === nr.map[p]))
  ) p--;
  while (
    s > 0 &&
    ((s < nf.norm.length &&
      hay.map[idx + nf.norm.length - s - 1] === hay.map[idx + nf.norm.length - s]) ||
      (s < nr.norm.length && nr.map[nr.norm.length - s - 1] === nr.map[nr.norm.length - s]))
  ) s--;

  // The edit region (flat space): everything between the agreeing ends.
  const midStartFlat = p > 0 ? hay.map[idx + p - 1]! + 1 : hay.map[idx]!;
  const midEndFlat = s > 0 ? hay.map[idx + nf.norm.length - s]! : flatEnd;
  if (midStartFlat > midEndFlat) return null; // degenerate alignment
  if (flat.text.slice(midStartFlat, midEndFlat).includes('\n')) return null;

  const midStartRaw = p < nr.norm.length ? nr.map[p]! : fix.replace.length;
  const midEndRaw = s > 0 ? nr.map[nr.norm.length - s]! : fix.replace.length;
  const replace = fix.replace.slice(midStartRaw, midEndRaw);
  if (!replace && midStartFlat === midEndFlat) return null; // no-op after folding

  return {
    from: flat.pos[midStartFlat] ?? endPos(flat, midStartFlat),
    to: endPos(flat, midEndFlat),
    replace,
    cursorFlat: flatEnd,
  };
}

/** Locate each fix in the flattened selection, sequentially (search
 *  forward from the previous match, falling back to a global search), and
 *  map it to a non-overlapping doc range. A verbatim miss retries in
 *  folded space (smart quotes/dashes/invisibles — the things models
 *  fail to echo verbatim; live-confirmed 2026-06-10 as the dominant
 *  "could not place" cause on imported cards). Returns the located
 *  edits plus the count that couldn't be placed. Exported for testing. */
export function locateFixes(
  flat: FlatSelection,
  fixes: readonly RepairFix[],
): { located: LocatedFix[]; skipped: number; notFound: RepairFix[]; overlapped: RepairFix[] } {
  const matched: (LocatedFix & { fix: RepairFix })[] = [];
  const notFound: RepairFix[] = [];
  let hay: { norm: string; map: number[] } | null = null;
  let cursor = 0;
  for (const fix of fixes) {
    let idx = flat.text.indexOf(fix.find, cursor);
    if (idx < 0) idx = flat.text.indexOf(fix.find); // out-of-order fallback
    if (idx < 0) {
      hay ??= foldWithMap(flat.text);
      const alt = locateNormalized(flat, hay, fix, cursor);
      if (alt) {
        cursor = alt.cursorFlat;
        matched.push({ from: alt.from, to: alt.to, replace: alt.replace, fix });
      } else {
        notFound.push(fix);
      }
      continue;
    }
    const from = flat.pos[idx]!;
    const to = endPos(flat, idx + fix.find.length);
    cursor = idx + fix.find.length;
    matched.push({ from, to, replace: fix.replace, fix });
  }
  // Drop overlaps (keep earlier), then order high→low for safe application.
  matched.sort((a, b) => a.from - b.from);
  const located: LocatedFix[] = [];
  const overlapped: RepairFix[] = [];
  let lastTo = -1;
  for (const m of matched) {
    if (m.from < lastTo) {
      overlapped.push(m.fix);
      continue;
    }
    located.push({ from: m.from, to: m.to, replace: m.replace });
    lastTo = m.to;
  }
  return { located, skipped: notFound.length + overlapped.length, notFound, overlapped };
}

/** Build the transaction applying located fixes. Applies high→low so each
 *  edit's positions stay valid; `insertText` across a block boundary joins
 *  the blocks (the hyphenation case). Returns the tr and the fixes' final
 *  ranges (for a later highlight animation). Exported for testing. */
export function buildRepairTransaction(
  state: EditorState,
  located: readonly LocatedFix[],
): { tr: Transaction; ranges: { from: number; to: number }[] } {
  const tr = state.tr;
  // Apply high→low using ORIGINAL positions (non-overlapping, so lower
  // edits are unaffected by higher ones). A middle-only edit can be a
  // pure deletion — insertText('') would throw on the empty text node.
  for (let i = located.length - 1; i >= 0; i--) {
    const l = located[i]!;
    if (l.replace) tr.insertText(l.replace, l.from, l.to);
    else if (l.to > l.from) tr.delete(l.from, l.to);
  }
  // Map each original start through the completed mapping to find where the
  // replacement landed; its end is start + replace length.
  const ranges = located.map((l) => {
    const from = tr.mapping.map(l.from, 1);
    return { from, to: from + l.replace.length };
  });
  return { tr, ranges };
}

// --------------------------- command ----------------------------

/** Milliseconds between successive replacements in the animated apply —
 *  the "watch it repair" cadence. */
const STEP_MS = 110;
/** How long a flash lingers after the last edit before the layer clears
 *  (matches the CSS keyframe length). */
const FLASH_MS = 1400;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** True when motion should be suppressed (user setting or OS preference).
 *  The animated apply collapses to an instant batch + static highlight. */
function reducedMotion(): boolean {
  if (typeof document === 'undefined') return false;
  const m = document.documentElement.getAttribute('data-motion');
  if (m === 'reduce') return true;
  if (m === 'normal') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Fold the variants the model routinely fails to echo verbatim:
 *  smart quotes/dashes → ASCII, NBSP → space, and the invisible-ish
 *  glyphs (pilcrow, soft hyphen, zero-width chars) dropped. Used by the
 *  skip diagnostic to classify WHY a find missed. */
export function normalizeForDiagnosis(s: string): string {
  return s
    .replace(/[‘’‚]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[—–‒]/g, '--')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u00B6\u00AD\u200B\u200C\u200D\uFEFF]/g, '');
}

/** Console diagnosis for unplaced fixes — classifies each miss so live
 *  failures on real documents are attributable: 'normalization' (a
 *  smart-quote/dash/pilcrow echo problem — a tolerant locator would
 *  have placed it) vs 'no-match' (the model invented or mangled text). */
function logUnplaced(flat: FlatSelection, notFound: RepairFix[], overlapped: RepairFix[]): void {
  if (notFound.length === 0 && overlapped.length === 0) return;
  const normHay = normalizeForDiagnosis(flat.text);
  for (const f of notFound) {
    const kind = normHay.includes(normalizeForDiagnosis(f.find)) ? 'normalization' : 'no-match';
    console.warn(`[repair] could not place (${kind}): find=${JSON.stringify(f.find)}`);
  }
  for (const f of overlapped) {
    console.warn(`[repair] could not place (overlapped): find=${JSON.stringify(f.find)}`);
  }
}

/** Ask the model for fixes over `[from, to)` and locate them. No edits. */
async function fetchFixes(
  view: EditorView,
  apiKey: string,
  from: number,
  to: number,
): Promise<{ fixesReturned: number; located: LocatedFix[]; skipped: number }> {
  const flat = flattenSelection(view.state.doc, from, to);
  if (!flat.text.trim()) return { fixesReturned: 0, located: [], skipped: 0 };
  const reply = await callAnthropic({
    apiKey,
    system: DEFAULT_REPAIR_PROMPT,
    messages: [{ role: 'user', content: flat.text }],
    // A long OCR'd card can legitimately need dozens of fixes, each
    // carrying context — 4096 used to cut the JSON off mid-array
    // (parse error). Output tokens only bill as generated.
    maxTokens: 16000,
    temperature: 0,
  });
  if (reply.stopReason === 'max_tokens') {
    console.warn('[repair] model reply hit the output token cap — fix list truncated');
    throw new Error(
      'The fix list was too long for one pass — select a smaller region and repair it in parts.',
    );
  }
  const fixes = parseRepairResponse(reply.text);
  const { located, skipped, notFound, overlapped } = locateFixes(flat, fixes);
  console.warn(
    `[repair] pass: ${fixes.length} fixes returned, ${located.length} placed, ${skipped} skipped`,
  );
  logUnplaced(flat, notFound, overlapped);
  return { fixesReturned: fixes.length, located, skipped };
}

/** Show the tooltip beside a document position (no-op-safe). */
function showTooltipAt(view: EditorView, tip: ThinkingTooltip, pos: number): void {
  try {
    const c = view.coordsAtPos(pos);
    tip.show({ left: c.left, top: c.top, bottom: c.bottom });
  } catch {
    tip.show({ left: 16, top: 16, bottom: 32 });
  }
}

/** Apply a pass's located fixes, ONE transaction at a time. When animating,
 *  each replacement lands with a brief delay, flashes orange, and scrolls
 *  into view. Every edit is kept OFF the undo history
 *  (`addToHistory: false`) — the whole operation is recorded as a single
 *  undo item later, in `collapseToSingleUndo`. Remaining fixes and the
 *  tracked selection bounds are remapped after each edit. Returns the
 *  selection bounds mapped through all edits. */
async function applyPass(
  view: EditorView,
  located: readonly LocatedFix[],
  selFrom: number,
  selTo: number,
  animate: boolean,
): Promise<{ selFrom: number; selTo: number }> {
  const queue = located.map((l) => ({ ...l }));
  let f = selFrom;
  let t = selTo;
  for (let i = 0; i < queue.length; i++) {
    const fix = queue[i]!;
    if (!fix.replace && fix.to <= fix.from) continue; // nothing to do
    // A middle-only edit can be a pure deletion — insertText('') would
    // throw on the empty text node.
    let tr = fix.replace
      ? view.state.tr.insertText(fix.replace, fix.from, fix.to)
      : view.state.tr.delete(fix.from, fix.to);
    if (animate) tr = withRepairFlash(tr, { from: fix.from, to: fix.from + fix.replace.length });
    tr = tr.setMeta('addToHistory', false);
    view.dispatch(animate ? tr.scrollIntoView() : tr);
    for (let j = i + 1; j < queue.length; j++) {
      queue[j] = {
        from: tr.mapping.map(queue[j]!.from, -1),
        to: tr.mapping.map(queue[j]!.to, 1),
        replace: queue[j]!.replace,
      };
    }
    f = tr.mapping.map(f, -1);
    t = tr.mapping.map(t, 1);
    if (animate && i < queue.length - 1) await delay(STEP_MS);
  }
  return { selFrom: f, selTo: t };
}

/** Collapse the off-history edits made since `startDoc` into a SINGLE undo
 *  item, so one Ctrl-Z rolls back the whole repair (both passes). Reverts
 *  the doc to `startDoc` and re-applies the corrected content in two
 *  synchronous dispatches — the intermediate state never paints, so there's
 *  no flicker. The revert is off-history; the re-apply is the one recorded
 *  change. Returns the repaired region in the final doc. */
function collapseToSingleUndo(
  view: EditorView,
  startDoc: PMNode,
  origSelFrom: number,
  origSelTo: number,
): { from: number; to: number } {
  const endContent = view.state.doc.content; // corrected (immutable fragment)
  const startContent = startDoc.content;
  view.dispatch(
    view.state.tr.replaceWith(0, view.state.doc.content.size, startContent).setMeta('addToHistory', false),
  );
  const trApply = view.state.tr.replaceWith(0, view.state.doc.content.size, endContent);
  const caret = Math.min(origSelFrom, trApply.doc.content.size);
  try {
    trApply.setSelection(Selection.near(trApply.doc.resolve(caret)));
  } catch {
    // Leave the default mapped selection.
  }
  view.dispatch(trApply);
  const netDelta = endContent.size - startContent.size;
  return { from: origSelFrom, to: Math.min(origSelTo + netDelta, view.state.doc.content.size) };
}

/** Entry point — fires on the `repairText` ribbon command. Runs up to two
 *  passes (the model occasionally skips a token on a single read; a second
 *  pass over the result catches it), applying each pass's fixes one at a
 *  time so the corrections animate in, then collapsing the whole thing into
 *  a single undo step. The second pass is skipped when the first found
 *  nothing (clean text). */
export function runRepairText(view: EditorView): void {
  if (!settings.get('aiFeaturesEnabled')) {
    showToast('AI features are disabled — enable them in Settings.');
    return;
  }
  const apiKey = settings.get('anthropicApiKey').trim();
  if (!apiKey) {
    showToast('Set an Anthropic API key in Settings to use AI features.');
    return;
  }
  const sel = view.state.selection;
  if (sel.empty) {
    showToast('Select the text to repair first.');
    return;
  }
  const flat = flattenSelection(view.state.doc, sel.from, sel.to);
  if (!flat.text.trim()) {
    showToast('Selection has no text to repair.');
    return;
  }

  const startDoc = view.state.doc;
  const origSelFrom = sel.from;
  const origSelTo = sel.to;
  let selFrom = origSelFrom;
  let selTo = origSelTo;
  const animate = !reducedMotion();
  // One tooltip, anchored where it spawns (the selection start) and left
  // there for the whole operation — it does NOT chase the highlights.
  const tooltip = new ThinkingTooltip();
  showTooltipAt(view, tooltip, selFrom);

  void (async () => {
    let applied = 0;
    try {
      // PASS 1.
      const p1 = await fetchFixes(view, apiKey, selFrom, selTo);
      let skipped = p1.skipped;
      if (p1.located.length) {
        const r = await applyPass(view, p1.located, selFrom, selTo, animate);
        selFrom = r.selFrom;
        selTo = r.selTo;
        applied += p1.located.length;
      }

      // PASS 2 — only when pass 1 found errors (catches single-read misses).
      if (p1.fixesReturned > 0) {
        const p2 = await fetchFixes(view, apiKey, selFrom, selTo);
        skipped += p2.skipped;
        if (p2.located.length) {
          const r = await applyPass(view, p2.located, selFrom, selTo, animate);
          selFrom = r.selFrom;
          selTo = r.selTo;
          applied += p2.located.length;
        }
      }

      tooltip.hide();

      if (applied === 0) {
        showToast(p1.fixesReturned === 0 ? 'No OCR errors found.' : 'Could not place any of the suggested fixes.');
        return;
      }

      // Let the walk's flashes finish, then fold every edit into one undo.
      if (animate) await delay(STEP_MS + 200);
      clearRepairFlashes(view);
      const region = collapseToSingleUndo(view, startDoc, origSelFrom, origSelTo);
      if (!animate) {
        // No walk happened — confirm the repair with one static highlight.
        setRepairFlashes(view, [region]);
        setTimeout(() => clearRepairFlashes(view), FLASH_MS + 200);
      }

      showToast(
        `Repaired ${applied} ${applied === 1 ? 'spot' : 'spots'}` +
          (skipped > 0 ? ` (${skipped} couldn't be placed)` : '') + '.',
      );
    } catch (e) {
      tooltip.hide();
      // Make whatever landed undoable in one step before surfacing the error.
      if (applied > 0) {
        clearRepairFlashes(view);
        try {
          collapseToSingleUndo(view, startDoc, origSelFrom, origSelTo);
        } catch {
          // Best effort.
        }
      }
      // Mirror the failure to the console (forwarded to the dev log) —
      // the toast is transient and otherwise leaves no trace to debug.
      console.warn(`[repair] error: ${e instanceof Error ? e.message : String(e)}`);
      if (e instanceof AnthropicError) showToast(`Repair: ${e.message}`);
      else showToast(`Repair: ${e instanceof Error ? e.message : String(e)}`);
    }
  })();
}
