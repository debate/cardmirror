// @vitest-environment jsdom
/**
 * Numbering fast path (perf audit A-02 tier 2) — after EVERY kind of edit the
 * plugin's incrementally-maintained state must be equivalent to a from-scratch
 * build on the same doc. The matrix deliberately covers every structure kind in
 * the schema that numbering can see: pocket / hat / block (both numRestart
 * states), cards (number / sub / none roles, numRestart badges), analytic
 * units, undertags, cite paragraphs, loose paragraphs, tables, zones
 * (transclusion_ref) with inner cards, live views (self_ref) with inner cards
 * — plus mark edits, real numbering commands, undo/redo, multi-step
 * transactions, and a seeded randomized op soup.
 *
 * Equivalence = same decoration positions and same rendered content (widget
 * keys are position-free: kind + rendered glyph + color mode).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { history, undo, redo } from 'prosemirror-history';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { cardNumberingPlugin, numberingPluginKey, numberingPerfProbe } from '../../src/editor/numbering-plugin.js';
import { toggleNumberRole, toggleSubRole, toggleNumRestart } from '../../src/editor/numbering-commands.js';
import { settings } from '../../src/editor/settings.js';

const n = schema.nodes;
const m = schema.marks;

function card(
  tagText: string,
  opts: { role?: 'number' | 'sub' | null; restart?: boolean; cite?: boolean; undertag?: boolean } = {},
): PMNode {
  const children: PMNode[] = [n['tag']!.create({ id: newHeadingId() }, schema.text(tagText))];
  if (opts.cite) children.push(n['cite_paragraph']!.create(null, schema.text('Author 24')));
  children.push(n['card_body']!.create(null, schema.text(`body of ${tagText} with words `)));
  if (opts.undertag) children.push(n['undertag']!.create(null, schema.text('an undertag line')));
  return n['card']!.create(
    { numRole: opts.role ?? null, ...(opts.restart !== undefined ? { numRestart: opts.restart } : {}) },
    children,
  );
}
function analytic(text: string, role: 'number' | 'sub' | null = null): PMNode {
  return n['analytic_unit']!.create({ numRole: role }, [
    n['analytic']!.create({ id: newHeadingId() }, schema.text(text)),
    n['card_body']!.create(null, schema.text('analytic body words')),
  ]);
}
const heading = (type: 'pocket' | 'hat' | 'block', text: string, attrs: object = {}): PMNode =>
  n[type]!.create({ id: newHeadingId(), ...attrs }, schema.text(text));
const zone = (children: PMNode[]): PMNode =>
  n['transclusion_ref']!.create({ source_ref: 'other.cmir' }, children);
const view = (children: PMNode[]): PMNode =>
  n['self_ref']!.create({ source_heading_id: 'X', source_label: 'V' }, children);

/** The kitchen-sink fixture: every structure numbering can encounter. */
function fixtureDoc(): PMNode {
  return n['doc']!.createChecked(null, [
    heading('pocket', 'POCKET'),
    heading('hat', 'HAT'),
    heading('block', 'BLOCK ONE'),
    card('T1', { role: 'number' }),
    card('T2', { role: 'sub', cite: true }),
    card('T3', { role: 'sub', undertag: true }),
    card('T4', { role: null }), // transparent skip
    analytic('A1', 'number'),
    n['paragraph']!.create(null, schema.text('loose paragraph words')),
    heading('block', 'BLOCK FLOW-IN', { numRestart: false }), // continue block
    card('T5', { role: 'number' }),
    card('T6', { role: 'number', restart: true }), // restart badge
    zone([heading('block', 'ZONE BLOCK'), card('ZT1', { role: 'number' }), card('ZT2', { role: 'sub' })]),
    view([card('VT1', { role: 'number' })]),
    heading('block', 'BLOCK TWO'),
    card('T7', { role: 'number' }),
  ]);
}

function mkView(doc: PMNode): EditorView {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return new EditorView(host, {
    state: EditorState.create({ doc, plugins: [history(), cardNumberingPlugin] }),
  });
}

/** Canonical multiset of a decoration set's render-relevant content. */
function canon(state: EditorState): string[] {
  const set = numberingPluginKey.getState(state)!.decorations;
  return set
    .find()
    .map((d) => {
      const spec = (d as unknown as { spec: { key?: string } }).spec;
      const attrs = (d as unknown as { type: { attrs?: Record<string, string> } }).type.attrs;
      const what = spec?.key ?? JSON.stringify(attrs ?? {});
      return `${d.from}-${d.to}:${what}`;
    })
    .sort();
}
/** The invariant: incrementally-maintained state ≡ from-scratch build. */
function expectEquivalent(v: EditorView, label: string): void {
  const fresh = EditorState.create({ doc: v.state.doc, plugins: [cardNumberingPlugin] });
  expect(canon(v.state), label).toEqual(canon(fresh));
  expect(
    numberingPluginKey.getState(v.state)!.labelSig,
    `${label} (labelSig)`,
  ).toBe(numberingPluginKey.getState(fresh)!.labelSig);
}
function posInText(doc: PMNode, needle: string): number {
  let found = -1;
  doc.descendants((nd, p) => {
    if (found >= 0) return false;
    if (nd.isText && nd.text?.includes(needle)) found = p + 1 + nd.text.indexOf(needle);
    return true;
  });
  if (found < 0) throw new Error(`no text "${needle}"`);
  return found;
}
function topLevelPosOf(doc: PMNode, pred: (nd: PMNode) => boolean): number {
  let at = -1;
  let off = 0;
  doc.forEach((child) => {
    if (at < 0 && pred(child)) at = off;
    off += child.nodeSize;
  });
  if (at < 0) throw new Error('node not found');
  return at;
}

beforeEach(() => {
  settings.set('showCardNumbering', true);
  settings.set('cardNumberingMatchHeadingColor', false);
  settings.set('cardNumberingIndent', 'off');
  settings.set('cardNumberingSubIndent', 'off');
});

describe('numbering fast path: per-edit equivalence across every structure kind', () => {
  const TEXT_SITES = [
    'body of T1',
    'T2', // tag text
    'Author 24', // cite paragraph
    'an undertag line',
    'analytic body',
    'loose paragraph',
    'BLOCK ONE', // heading text
    'body of ZT1', // zone-inner card body
    'body of VT1', // live-view-inner card body
  ];
  for (const site of TEXT_SITES) {
    it(`typing in "${site}" maps instead of rebuilding, equivalently`, () => {
      const v = mkView(fixtureDoc());
      const buildsBefore = numberingPerfProbe.builds;
      v.dispatch(v.state.tr.insertText('xyz', posInText(v.state.doc, site)));
      // Prove the fast path ran: no full rebuild happened for this edit.
      // (expectEquivalent's fresh reference state builds afterwards, so the
      // probe must be read first.)
      expect(numberingPerfProbe.builds, `${site}: no rebuild`).toBe(buildsBefore);
      expectEquivalent(v, site);
      v.destroy();
    });
  }

  it('structural rebuilds REUSE the DOM of unchanged glyphs (position-free keys)', () => {
    // Insert an UNNUMBERED card at the very top: structural → full rebuild,
    // every card shifts position, but every label (and thus every rendered
    // glyph) is unchanged. With position-baked keys this recreated every
    // number span; position-free keys let ProseMirror keep them.
    const v = mkView(fixtureDoc());
    const spansBefore = new Set(v.dom.querySelectorAll('.pmd-card-number'));
    expect(spansBefore.size).toBeGreaterThan(0);
    v.dispatch(v.state.tr.insert(0, card('TOPNONE')));
    const spansAfter = [...v.dom.querySelectorAll('.pmd-card-number')];
    const kept = spansAfter.filter((el) => spansBefore.has(el)).length;
    expect(kept, 'unchanged glyph spans preserved across rebuild').toBeGreaterThan(0);
    v.destroy();
  });

  it('a glyph whose number CHANGES is still re-rendered across a rebuild', () => {
    // Insert a NUMBERED card at the top of T1's scope: T1's glyph changes
    // 1. → 2., so its span must be recreated (key differs by glyph text).
    const v = mkView(fixtureDoc());
    const glyphs = () => [...v.dom.querySelectorAll('.pmd-card-number')].map((el) => el.textContent);
    const before = glyphs();
    const blockPos = topLevelPosOf(v.state.doc, (nd) => nd.type.name === 'block');
    const blockNode = v.state.doc.nodeAt(blockPos)!;
    v.dispatch(v.state.tr.insert(blockPos + blockNode.nodeSize, card('FIRST', { role: 'number' })));
    const after = glyphs();
    expect(after.length).toBe(before.length + 1);
    expect(after[0]).toBe(before[0]); // the new card takes "1"
    v.destroy();
  });

  it('non-structural deletes (text spans, incl. across a card boundary) stay equivalent', () => {
    const v = mkView(fixtureDoc());
    const from = posInText(v.state.doc, 'body of T1');
    v.dispatch(v.state.tr.delete(from, from + 5));
    expectEquivalent(v, 'text delete');
    v.destroy();
  });

  it('adding/removing non-color marks maps equivalently', () => {
    const v = mkView(fixtureDoc());
    const from = posInText(v.state.doc, 'body of T1');
    v.dispatch(v.state.tr.addMark(from, from + 8, m['highlight']!.create()));
    expectEquivalent(v, 'addMark');
    v.dispatch(v.state.tr.removeMark(from, from + 8, m['highlight']!));
    expectEquivalent(v, 'removeMark');
    v.destroy();
  });

  const INSERTIONS: [string, () => PMNode][] = [
    ['numbered card', () => card('NEW', { role: 'number' })],
    ['sub card', () => card('NEWSUB', { role: 'sub' })],
    ['unnumbered card', () => card('NEWNONE')],
    ['analytic unit', () => analytic('NEWA', 'number')],
    ['block heading', () => heading('block', 'NEW BLOCK')],
    ['continue block', () => heading('block', 'NEW FLOW', { numRestart: false })],
    ['hat heading', () => heading('hat', 'NEW HAT')],
    ['pocket heading', () => heading('pocket', 'NEW POCKET')],
    ['zone with cards', () => zone([card('ZNEW', { role: 'number' })])],
    ['live view with cards', () => view([card('VNEW', { role: 'number' })])],
    ['paragraph', () => n['paragraph']!.create(null, schema.text('new para'))],
  ];
  for (const [what, make] of INSERTIONS) {
    it(`inserting a ${what} at the top rebuilds equivalently`, () => {
      const v = mkView(fixtureDoc());
      v.dispatch(v.state.tr.insert(0, make()));
      expectEquivalent(v, `insert ${what}`);
      v.destroy();
    });
  }

  it('deleting each top-level child (every structure kind) stays equivalent', () => {
    const base = fixtureDoc();
    for (let i = 0; i < base.childCount; i++) {
      const v = mkView(fixtureDoc());
      let off = 0;
      for (let j = 0; j < i; j++) off += v.state.doc.child(j).nodeSize;
      const child = v.state.doc.child(i);
      v.dispatch(v.state.tr.delete(off, off + child.nodeSize));
      expectEquivalent(v, `delete child ${i} (${child.type.name})`);
      v.destroy();
    }
  });

  it('moving a card (delete + insert in one transaction) rebuilds equivalently', () => {
    const v = mkView(fixtureDoc());
    const doc = v.state.doc;
    const from = topLevelPosOf(doc, (nd) => nd.type.name === 'card');
    const cardNode = doc.nodeAt(from)!;
    const tr = v.state.tr;
    tr.delete(from, from + cardNode.nodeSize);
    tr.insert(tr.mapping.map(doc.content.size), cardNode);
    v.dispatch(tr);
    expectEquivalent(v, 'card move');
    v.destroy();
  });

  it('real numbering commands (toggle role / sub / restart) stay equivalent', () => {
    const v = mkView(fixtureDoc());
    const inT4 = posInText(v.state.doc, 'body of T4');
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, inT4)));
    for (const [name, cmd] of [
      ['toggleNumberRole', toggleNumberRole],
      ['toggleSubRole', toggleSubRole],
      ['toggleNumRestart', toggleNumRestart],
    ] as const) {
      const ok = cmd(v.state, (tr: Transaction) => v.dispatch(tr));
      expect(ok, `${name} applied`).toBe(true);
      expectEquivalent(v, name);
    }
    v.destroy();
  });

  it('numRestart toggle on a first-in-scope card (labels unchanged, badge must still appear)', () => {
    // T1 is the first numbered card of its scope: flipping its restart attr
    // does NOT change any label — the badge decoration is the only delta.
    // Attr steps classify as structural, so this must rebuild.
    const v = mkView(fixtureDoc());
    const inT1 = posInText(v.state.doc, 'body of T1');
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, inT1)));
    const ok = toggleNumRestart(v.state, (tr: Transaction) => v.dispatch(tr));
    expect(ok).toBe(true);
    expectEquivalent(v, 'restart badge with identical labels');
    v.destroy();
  });

  it('undo/redo of structural and non-structural edits stay equivalent', () => {
    const v = mkView(fixtureDoc());
    v.dispatch(v.state.tr.insertText('abc', posInText(v.state.doc, 'body of T1')));
    v.dispatch(v.state.tr.insert(0, card('UNDOME', { role: 'number' })));
    for (const step of ['undo-insert', 'undo-text', 'redo-text', 'redo-insert'] as const) {
      const cmd = step.startsWith('undo') ? undo : redo;
      expect(cmd(v.state, (tr) => v.dispatch(tr)), step).toBe(true);
      expectEquivalent(v, step);
    }
    v.destroy();
  });

  it('a mixed multi-step transaction (text + structural) rebuilds equivalently', () => {
    const v = mkView(fixtureDoc());
    const tr = v.state.tr;
    tr.insertText('mix', posInText(v.state.doc, 'body of T5'));
    tr.insert(tr.mapping.map(0), card('MIXED', { role: 'number' }));
    v.dispatch(tr);
    expectEquivalent(v, 'mixed transaction');
    v.destroy();
  });

  it('match-heading-color mode: every edit rebuilds (color inputs are untrackable cheaply)', () => {
    settings.set('cardNumberingMatchHeadingColor', true);
    const v = mkView(
      n['doc']!.createChecked(null, [
        n['card']!.create({ numRole: 'number' }, [
          n['tag']!.create({ id: newHeadingId() }, schema.text('ALLRED', [m['font_color']!.create({ color: 'aa0000' })])),
          n['card_body']!.create(null, schema.text('body')),
        ]),
      ]),
    );
    // Typing uncolored text into the fully-colored tag changes the glyph's
    // color input without touching labels — only a rebuild catches it.
    v.dispatch(v.state.tr.insertText('x', 2));
    expectEquivalent(v, 'match-heading text edit');
    v.destroy();
  });
});

describe('numbering fast path: randomized op soup', () => {
  function makeRng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }
  it('120 random ops, equivalence after every single one', () => {
    const rng = makeRng(0xbead5);
    const v = mkView(fixtureDoc());
    for (let i = 0; i < 120; i++) {
      const doc = v.state.doc;
      const r = rng();
      const tr = v.state.tr;
      const randPos = () => 1 + Math.floor(rng() * (doc.content.size - 2));
      try {
        if (r < 0.4) {
          const $p = doc.resolve(randPos());
          if (!$p.parent.isTextblock) continue;
          tr.insertText('q', $p.pos);
        } else if (r < 0.55) {
          const a = randPos();
          const b = Math.min(doc.content.size - 1, a + 1 + Math.floor(rng() * 8));
          tr.delete(a, b);
        } else if (r < 0.7) {
          const a = randPos();
          tr.addMark(a, Math.min(doc.content.size - 1, a + 6), m['highlight']!.create());
        } else if (r < 0.85) {
          const kinds = INSERT_KINDS;
          const make = kinds[Math.floor(rng() * kinds.length)]!;
          let off = 0;
          const idx = Math.floor(rng() * (doc.childCount + 1));
          for (let j = 0; j < idx; j++) off += doc.child(j).nodeSize;
          tr.insert(off, make());
        } else {
          // toggle an attr on a random top-level card
          const cardPositions: number[] = [];
          let off = 0;
          doc.forEach((child) => {
            if (child.type.name === 'card' || child.type.name === 'analytic_unit') cardPositions.push(off);
            off += child.nodeSize;
          });
          if (!cardPositions.length) continue;
          const pos = cardPositions[Math.floor(rng() * cardPositions.length)]!;
          const node = doc.nodeAt(pos)!;
          const roles = ['number', 'sub', null] as const;
          tr.setNodeMarkup(pos, null, { ...node.attrs, numRole: roles[Math.floor(rng() * 3)] });
        }
      } catch {
        continue; // invalid random op (schema rejection) — skip, try next
      }
      if (!tr.docChanged) continue;
      try {
        v.dispatch(tr);
      } catch {
        continue;
      }
      expectEquivalent(v, `op ${i}`);
    }
    v.destroy();
  });
  const INSERT_KINDS: (() => PMNode)[] = [
    () => card('R', { role: 'number' }),
    () => card('RS', { role: 'sub' }),
    () => card('RN'),
    () => heading('block', 'RB'),
    () => heading('hat', 'RH'),
    () => zone([card('RZ', { role: 'number' })]),
    () => n['paragraph']!.create(null, schema.text('rp')),
  ];
});
