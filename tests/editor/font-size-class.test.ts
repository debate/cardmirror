import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { schema } from '../../src/schema/index.js';
import {
  computeMinHalfPoints,
  fontSizeClassPlugin,
} from '../../src/editor/font-size-class-plugin.js';
import { DecorationSet } from 'prosemirror-view';

const HP_4PT = 8;
const HP_8PT = 16;
const HP_11PT = 22;
const HP_13PT = 26;

function fontSize(hp: number) {
  return schema.marks['font_size']!.create({ halfPoints: hp });
}

function bodyPara(...children: ReturnType<typeof schema.text>[]) {
  return schema.nodes['card_body']!.create(null, children);
}

describe('font-size-class plugin (computeMinHalfPoints)', () => {
  it('uniform 4pt paragraph → min is 8 (4pt half-points)', () => {
    const p = bodyPara(schema.text('all small', [fontSize(HP_4PT)]));
    expect(computeMinHalfPoints(p)).toBe(HP_4PT);
  });

  it('paragraph with no font_size marks → caps at default 22 (11pt)', () => {
    const p = bodyPara(schema.text('default sized'));
    expect(computeMinHalfPoints(p)).toBe(HP_11PT);
  });

  it('mixed 4pt + 11pt (untagged) paragraph → min is 8', () => {
    const p = bodyPara(
      schema.text('small ', [fontSize(HP_4PT)]),
      schema.text('then default'),
    );
    expect(computeMinHalfPoints(p)).toBe(HP_4PT);
  });

  it('mixed 4pt + 11pt (explicitly tagged) paragraph → min is 8', () => {
    const p = bodyPara(
      schema.text('small ', [fontSize(HP_4PT)]),
      schema.text('larger', [fontSize(HP_11PT)]),
    );
    expect(computeMinHalfPoints(p)).toBe(HP_4PT);
  });

  it('uniformly larger-than-default (13pt) → caps at default 22', () => {
    // The function caps at DEFAULT_HALF_POINTS — only sizes smaller
    // than default cause a decoration to be emitted. Larger uniform
    // text gets no class, so reporting 22 here is the correct contract.
    const p = bodyPara(schema.text('big', [fontSize(HP_13PT)]));
    expect(computeMinHalfPoints(p)).toBe(HP_11PT);
  });

  it('empty paragraph → default 22', () => {
    const p = schema.nodes['card_body']!.create(null, []);
    expect(computeMinHalfPoints(p)).toBe(HP_11PT);
  });

  it('paragraph with multiple small sizes picks the smallest', () => {
    const p = bodyPara(
      schema.text('eight ', [fontSize(HP_8PT)]),
      schema.text('four ', [fontSize(HP_4PT)]),
      schema.text('eight again', [fontSize(HP_8PT)]),
    );
    expect(computeMinHalfPoints(p)).toBe(HP_4PT);
  });
});

// ---- Mixed-bare-text shrink suppression ----

function tag(t: string) {
  return schema.nodes['tag']!.create({ id: 'x' }, schema.text(t));
}
function card(...children: import('prosemirror-model').Node[]) {
  return schema.nodes['card']!.createChecked(null, children);
}
function makeDoc(children: import('prosemirror-model').Node[]) {
  return schema.nodes['doc']!.createChecked(null, children);
}

function decorationsForBodyPara(
  para: import('prosemirror-model').Node,
): { class?: string; style?: string }[] {
  // Mount in a minimal doc and read the plugin's decoration set.
  const doc = makeDoc([card(tag('T'), para)]);
  const state = EditorState.create({ doc, plugins: [fontSizeClassPlugin] });
  const set = fontSizeClassPlugin.getState(state) as DecorationSet;
  let result: { class?: string; style?: string }[] = [];
  set.find().forEach((d) => {
    const spec = (d as unknown as { type: { attrs: { class?: string; style?: string } } }).type.attrs;
    result.push(spec);
  });
  return result;
}

describe('font-size-class plugin — line-height-only shrink', () => {
  it('applies pmd-fs-shrunk with line-height (no font-size) when ALL text is small', () => {
    const p = bodyPara(
      schema.text('all 8pt body', [fontSize(HP_8PT)]),
    );
    const decos = decorationsForBodyPara(p);
    const shrunk = decos.find((d) => d.class === 'pmd-fs-shrunk');
    expect(shrunk).toBeDefined();
    // Ramp at 8pt: rampFrac = 0.4. The CSS calc ties the multiplier
    // to var(--pmd-line-height) so the body knob scales the upper
    // end of the curve.
    expect(shrunk!.style).toContain(
      'line-height: calc(8pt * (1 + 0.4 * (var(--pmd-line-height) - 1)))',
    );
    // Critical: we DO NOT cascade-shrink the paragraph's font-size.
    expect(shrunk!.style).not.toMatch(/font-size/);
  });

  it('shrinks paragraph AND emits inline line-height decoration for EVERY text run', () => {
    // Paragraph decoration sets the shrunken strut for empty lines;
    // every text run gets an inline `max(var(--pmd-line-height), 1.2)`
    // so each run's effective line-height is at least 1.2 × its own
    // font-size — preventing 8pt-only lines from drawing into adjacent
    // lines when the body knob is small (CSS line-height absolute
    // shorter than the font's natural ascender+descender extent).
    const p = bodyPara(
      schema.text('plain bare text '),
      schema.text('shrunk piece', [fontSize(HP_8PT)]),
    );
    const decos = decorationsForBodyPara(p);
    const shrunk = decos.find((d) => d.class === 'pmd-fs-shrunk');
    expect(shrunk).toBeDefined();
    expect(shrunk!.style).toContain(
      'line-height: calc(8pt * (1 + 0.4 * (var(--pmd-line-height) - 1)))',
    );
    // Inline decorations: one per text run.
    const inlineRuns = decos.filter(
      (d) => d.style === 'line-height: max(var(--pmd-line-height), 1.2)',
    );
    expect(inlineRuns).toHaveLength(2);
  });

  it('emits inline line-height decoration for font_size-marked text too', () => {
    // Uniform 8pt-marked paragraph: paragraph decoration + one inline
    // decoration for the single text run (no longer skipped just
    // because it carries a font_size mark).
    const p = bodyPara(
      schema.text('all 8pt', [fontSize(HP_8PT)]),
    );
    const decos = decorationsForBodyPara(p);
    expect(decos.find((d) => d.class === 'pmd-fs-shrunk')).toBeDefined();
    expect(
      decos.find((d) => d.style === 'line-height: max(var(--pmd-line-height), 1.2)'),
    ).toBeDefined();
  });

  it('emits inline line-height decoration for named-style marks too (e.g., cite_mark)', () => {
    // Same as bare runs — named-style spans (.pmd-cite, etc.) are
    // covered by the same uniform inline decoration.
    const citeMark = schema.marks['cite_mark']!.create();
    const p = bodyPara(
      schema.text('cite ', [citeMark]),
      schema.text('then 8pt', [fontSize(HP_8PT)]),
    );
    const decos = decorationsForBodyPara(p);
    expect(decos.find((d) => d.class === 'pmd-fs-shrunk')).toBeDefined();
    expect(
      decos.find((d) => d.style === 'line-height: max(var(--pmd-line-height), 1.2)'),
    ).toBeDefined();
  });

  it('does NOT apply pmd-fs-shrunk for a fully-bare default-size paragraph (no marks)', () => {
    const p = bodyPara(schema.text('Lorem ipsum'));
    const decos = decorationsForBodyPara(p);
    expect(decos.find((d) => d.class === 'pmd-fs-shrunk')).toBeUndefined();
  });

  it('picks the SMALLEST font_size mark for the line-height value', () => {
    const p = bodyPara(
      schema.text('eight ', [fontSize(HP_8PT)]),
      schema.text('four', [fontSize(HP_4PT)]),
    );
    const decos = decorationsForBodyPara(p);
    const shrunk = decos.find((d) => d.class === 'pmd-fs-shrunk');
    expect(shrunk).toBeDefined();
    // 4pt is below the ramp floor → multiplier clamps to 1.0 →
    // line-height is 4pt absolute (no body-knob involvement).
    expect(shrunk!.style).toContain('line-height: 4pt');
  });

  it('recomputes after a mark-only transaction (font_size strip drops pmd-fs-shrunk)', () => {
    // Mark steps produce identity position maps. The decoration-range
    // helper has to walk `tr.steps` directly to notice them — without
    // that, the plugin's `apply` would silently skip the affected
    // paragraph and the pmd-fs-shrunk class would stick around forever.
    const p = bodyPara(
      schema.text('eight ', [fontSize(HP_8PT)]),
      schema.text('eight again', [fontSize(HP_8PT)]),
    );
    const doc = makeDoc([card(tag('T'), p)]);
    let state = EditorState.create({ doc, plugins: [fontSizeClassPlugin] });
    const initialSet = fontSizeClassPlugin.getState(state) as DecorationSet;
    expect(initialSet.find().some((d) => {
      const attrs = (d as unknown as { type: { attrs: { class?: string } } }).type.attrs;
      return attrs.class === 'pmd-fs-shrunk';
    })).toBe(true);

    // Strip the font_size mark across the paragraph's content range.
    // The plugin's apply must pick this up via the step-based walk.
    let paraFrom = -1;
    let paraTo = -1;
    state.doc.descendants((n, p2) => {
      if (n.type.name === 'card_body') {
        paraFrom = p2 + 1;
        paraTo = p2 + n.nodeSize - 1;
      }
      return true;
    });
    const tr = state.tr.removeMark(paraFrom, paraTo, schema.marks['font_size']!);
    state = state.apply(tr);

    const afterSet = fontSizeClassPlugin.getState(state) as DecorationSet;
    expect(afterSet.find().some((d) => {
      const attrs = (d as unknown as { type: { attrs: { class?: string } } }).type.attrs;
      return attrs.class === 'pmd-fs-shrunk';
    })).toBe(false);
  });
});
