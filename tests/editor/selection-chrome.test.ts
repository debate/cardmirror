/**
 * Fused selection-chrome walk (selection-chrome.ts, perf audit A-01) — the
 * one-pass computation must agree with the three naive per-question
 * references it replaced, on randomized docs and selections:
 *   font   ≡ the old effectiveFontSizeForDisplay range branch
 *   marks  ≡ doc.rangeHasMark per mark type
 *   units  ≡ the old inScopeCardUnits range branch
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { computeSelectionChrome } from '../../src/editor/selection-chrome.js';

const n = schema.nodes;
const m = schema.marks;
const MARK_NAMES = ['cite_mark', 'underline_mark', 'emphasis_mark'] as const;

/** Injected size resolver — pure stand-in for index.ts's settings-reading
 *  ptForRun, with the same precedence (font_size > named style > parent). */
function testPtForRun(text: PMNode, parent: PMNode): { pt: number; direct: boolean } {
  const fs = text.marks.find((mk) => mk.type.name === 'font_size');
  if (fs) return { pt: Number(fs.attrs['halfPoints'] ?? 22) / 2, direct: true };
  for (const mk of text.marks) {
    if (mk.type.name === 'cite_mark') return { pt: 9, direct: false };
    if (mk.type.name === 'underline_mark') return { pt: 10, direct: false };
    if (mk.type.name === 'emphasis_mark') return { pt: 11, direct: false };
  }
  return { pt: parent.type.name === 'tag' ? 13 : 12, direct: false };
}

// ---- naive references (the pre-fusion per-question implementations) ----
function refFont(state: EditorState): { pt: number | null; direct: boolean } {
  const sel = state.selection;
  const found = new Set<number>();
  let allDirect = true;
  let anyRun = false;
  state.doc.nodesBetween(sel.from, sel.to, (node, _pos, parent) => {
    if (!node.isText || !parent) return true;
    const r = testPtForRun(node, parent);
    found.add(r.pt);
    if (!r.direct) allDirect = false;
    anyRun = true;
    return true;
  });
  if (!anyRun) return { pt: null, direct: false };
  if (found.size === 1) return { pt: [...found][0]!, direct: allDirect };
  return { pt: null, direct: false };
}
function refMarks(state: EditorState): Record<string, boolean> {
  const sel = state.selection;
  const out: Record<string, boolean> = {};
  for (const name of MARK_NAMES) {
    out[name] = state.doc.rangeHasMark(sel.from, sel.to, schema.marks[name]!);
  }
  return out;
}
function refUnits(state: EditorState): { pos: number; name: string }[] {
  const sel = state.selection;
  const units: { pos: number; name: string }[] = [];
  state.doc.nodesBetween(sel.from, sel.to, (node, pos) => {
    if (node.type.name === 'card' || node.type.name === 'analytic_unit') {
      units.push({ pos, name: node.type.name });
      return false; // the old walk didn't descend into cards
    }
    return true;
  });
  return units;
}

// ---- randomized doc/selection generation (seeded) ----
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
function randRuns(rng: () => number, base: string): PMNode[] {
  const runs: PMNode[] = [];
  const count = 1 + Math.floor(rng() * 5);
  for (let i = 0; i < count; i++) {
    const marks = [];
    const r = rng();
    if (r < 0.2) marks.push(m['font_size']!.create({ halfPoints: 20 + 2 * Math.floor(rng() * 6) }));
    else if (r < 0.35) marks.push(m['cite_mark']!.create());
    else if (r < 0.5) marks.push(m['underline_mark']!.create());
    else if (r < 0.6) marks.push(m['emphasis_mark']!.create());
    runs.push(schema.text(`${base} run ${i} `, marks));
  }
  return runs;
}
function randDoc(rng: () => number): PMNode {
  const kids: PMNode[] = [];
  const count = 4 + Math.floor(rng() * 12);
  for (let i = 0; i < count; i++) {
    const r = rng();
    if (r < 0.15) kids.push(n['block']!.create({ id: newHeadingId() }, schema.text(`B${i}`)));
    else if (r < 0.7)
      kids.push(
        n['card']!.create(null, [
          n['tag']!.create({ id: newHeadingId() }, randRuns(rng, `t${i}`)),
          n['card_body']!.create(null, randRuns(rng, `b${i}`)),
        ]),
      );
    else if (r < 0.85)
      kids.push(
        n['analytic_unit']!.create(null, [
          n['analytic']!.create({ id: newHeadingId() }, randRuns(rng, `a${i}`)),
          n['card_body']!.create(null, randRuns(rng, `ab${i}`)),
        ]),
      );
    else kids.push(n['paragraph']!.create(null, randRuns(rng, `p${i}`)));
  }
  return n['doc']!.createChecked(null, kids);
}

describe('computeSelectionChrome ≡ naive references', () => {
  it('font, marks, and units agree on 60 random docs x 8 selections each', () => {
    const rng = makeRng(0xdecaf);
    for (let d = 0; d < 60; d++) {
      const doc = randDoc(rng);
      for (let sIdx = 0; sIdx < 8; sIdx++) {
        const a = 1 + Math.floor(rng() * (doc.content.size - 2));
        const b = 1 + Math.floor(rng() * (doc.content.size - 2));
        const state = EditorState.create({
          doc,
          selection: TextSelection.between(doc.resolve(Math.min(a, b)), doc.resolve(Math.max(a, b))),
        });
        if (state.selection.empty) continue;
        const chrome = computeSelectionChrome(state, MARK_NAMES, testPtForRun);
        const label = `doc ${d} sel ${state.selection.from}-${state.selection.to}`;
        expect(chrome.font, `${label} font`).toEqual(refFont(state));
        expect(chrome.markActive, `${label} marks`).toEqual(refMarks(state));
        expect(
          chrome.units.map((u) => ({ pos: u.pos, name: u.node.type.name })),
          `${label} units`,
        ).toEqual(refUnits(state));
      }
    }
  });

  it('a selection with no text runs reports null font and no marks', () => {
    // Selection spanning only a node boundary region between two cards can
    // contain structure but no text: emulate with a doc whose selected gap
    // holds an empty paragraph.
    const doc = n['doc']!.createChecked(null, [
      n['paragraph']!.create(null, schema.text('aa')),
      n['paragraph']!.create(),
      n['paragraph']!.create(null, schema.text('bb')),
    ]);
    // Select just inside the empty paragraph's block boundaries.
    const from = 4; // after first para
    const state = EditorState.create({
      doc,
      selection: TextSelection.between(doc.resolve(from), doc.resolve(from + 2)),
    });
    const chrome = computeSelectionChrome(state, MARK_NAMES, testPtForRun);
    expect(chrome.font).toEqual(refFont(state));
    expect(chrome.markActive).toEqual(refMarks(state));
  });
});
