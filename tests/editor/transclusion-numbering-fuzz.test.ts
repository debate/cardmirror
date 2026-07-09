// @vitest-environment jsdom
/**
 * New-features fuzz (single view, NO co-editing).
 *
 * Hammers the live-view / linked-copy / numbering features in isolation with
 * seeded random operations — insert / edit / detach / unlink / delete / re-point
 * (cycle-prone) transclusions, and random numbering roles / restarts — and after
 * every op asserts the invariants that would catch a real bug:
 *   - the doc stays SCHEMA-VALID;
 *   - the derive/render functions are TOTAL (computeNumbering, in-doc divergence,
 *     and self-ref projection resolution never throw — including on cycles);
 *   - the plugins (empty-zone reaper, self-ref re-render, numbering) survive every
 *     state (a plugin crash re-throws out of the op and fails the seed).
 * At each seed's end it also checks the "leaving the doc" flatten (no live view
 * survives, still valid) and that a native `.cmir` round-trip preserves the
 * numbering skeleton + transclusion counts.
 *
 * A second property stresses the docx numbering round-trip across random
 * card/block skeletons: the RENDERED numbers must survive export → import.
 */

import { describe, it, expect } from 'vitest';
import { EditorState, type Plugin } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { type Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  createSelfRefNode,
  isSelfRef,
  resolveSelfProjection,
  flattenSelfRefs,
} from '../../src/editor/self-transclusion.js';
import { isTransclusionNode, createTransclusionNode, detachSlice } from '../../src/editor/transclusion.js';
import { buildInDocCopyAttrs } from '../../src/editor/transclusion-actions.js';
import { transclusionEmptyZoneReaper, transclusionSelectionGuard } from '../../src/editor/transclusion-selection-guard.js';
import { makeSelfRefPlugin } from '../../src/editor/self-transclusion-plugin.js';
import { cardNumberingPlugin } from '../../src/editor/numbering-plugin.js';
import { computeNumbering, type NumRole } from '../../src/editor/numbering.js';
import { inDocDivergence } from '../../src/editor/transclusion-divergence.js';
import { serializeNative, parseNative } from '../../src/native/index.js';
import { toDocx } from '../../src/export/index.js';
import { fromDocx } from '../../src/import/index.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const WORDS = ['impact', 'link', 'turns', 'warrant', 'solvency', 'uniqueness'];
const ROLES: NumRole[] = ['none', 'number', 'sub'];
const pick = <T>(rnd: () => number, xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;

// Density caps. Resolution is memoized (see resolveSelfProjection), so repeated
// references no longer re-walk — but a genuinely BRANCHING reference graph still
// MATERIALIZES exponential content (inlining is inherently O(output)). Real docs
// never approach that; cap density to keep the fuzz doc bounded.
const MAX_VIEWS = 15;
const MAX_COPIES = 15;

function card(tag: string, body: string, role: NumRole = 'none', restart = false): PMNode {
  return schema.nodes['card']!.createChecked({ numRole: role, numRestart: restart }, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
function block(text: string, id: string): PMNode {
  return schema.nodes['block']!.create({ id }, schema.text(text));
}
function para(text: string): PMNode {
  return schema.nodes['paragraph']!.create(null, schema.text(text));
}
function doc(...kids: PMNode[]): PMNode {
  return schema.nodes['doc']!.create(null, kids);
}

function seedDoc(): PMNode {
  return doc(
    block('Alpha section', 'alpha'),
    card('A1', 'A1 body evidence to churn.'),
    card('A2', 'A2 body evidence to churn.'),
    block('Beta section', 'beta'),
    card('B1', 'B1 body evidence to churn.'),
    para('A loose resolved paragraph to edit.'),
  );
}

function headingIds(d: PMNode): string[] {
  const ids: string[] = [];
  d.descendants((n) => {
    const t = n.type.name;
    if ((t === 'block' || t === 'tag' || t === 'pocket' || t === 'hat' || t === 'analytic') &&
      typeof n.attrs['id'] === 'string' && n.attrs['id']) ids.push(n.attrs['id'] as string);
    return true;
  });
  return ids;
}
function blockIds(d: PMNode): string[] {
  const ids: string[] = [];
  d.descendants((n) => {
    if (n.type.name === 'block' && typeof n.attrs['id'] === 'string' && n.attrs['id']) ids.push(n.attrs['id'] as string);
    return true;
  });
  return ids;
}
/** Doc-level insert positions + the slot just inside each zone (nesting). */
function insertPositions(d: PMNode): number[] {
  const out = [0];
  let acc = 0;
  d.forEach((n) => {
    acc += n.nodeSize;
    out.push(acc);
  });
  d.descendants((n, pos) => {
    if (isTransclusionNode(n)) out.push(pos + 1); // inside a copy → nested transclusion
    return true;
  });
  return out;
}
function nodePositions(d: PMNode, pred: (n: PMNode) => boolean): number[] {
  const out: number[] = [];
  d.descendants((n, pos) => {
    if (pred(n)) {
      out.push(pos);
      return false;
    }
    return true;
  });
  return out;
}
function bodyPositionsInZones(d: PMNode): number[] {
  const out: number[] = [];
  const walk = (node: PMNode, base: number, inZone: boolean): void => {
    node.forEach((child, offset) => {
      const pos = base + offset;
      if (child.type.name === 'card_body' && inZone) out.push(pos + 1);
      if (child.content.size) walk(child, pos + 1, inZone || isTransclusionNode(child));
    });
  };
  walk(d, 0, false);
  return out;
}
function textblocks(d: PMNode): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  d.descendants((node, pos) => {
    if (node.isTextblock) {
      out.push({ start: pos + 1, end: pos + 1 + node.content.size });
      return false;
    }
    return true;
  });
  return out;
}
function countBy(d: PMNode, pred: (n: PMNode) => boolean): number {
  let c = 0;
  d.descendants((n) => {
    if (pred(n)) c++;
    return true;
  });
  return c;
}
/** Rendered number labels in document order (transclusion-aware). */
function labelSeq(d: PMNode): string[] {
  const map = computeNumbering(d).cards;
  const out: string[] = [];
  d.descendants((n, pos) => {
    const t = n.type.name;
    if (t === 'card' || t === 'analytic_unit') {
      out.push(map.get(pos)?.text ?? '·');
      return false;
    }
    if (t === 'transclusion_ref') return true;
    if (t === 'pocket' || t === 'hat' || t === 'block' || t === 'self_ref') return false;
    return true;
  });
  return out;
}

function op(rnd: () => number, view: EditorView): void {
  const d = view.state.doc;
  const roll = rnd();
  try {
    if (roll < 0.16) {
      const bs = textblocks(d);
      if (!bs.length) return;
      const b = pick(rnd, bs);
      const at = b.start + Math.floor(rnd() * Math.max(1, b.end - b.start));
      if (rnd() < 0.6) view.dispatch(view.state.tr.insertText(` ${pick(rnd, WORDS)}`, at));
      else {
        const to = Math.min(b.end, at + 1 + Math.floor(rnd() * 6));
        if (to > at) view.dispatch(view.state.tr.delete(at, to));
      }
    } else if (roll < 0.28) {
      const ids = blockIds(d);
      if (!ids.length || countBy(d, isSelfRef) >= MAX_VIEWS) return;
      view.dispatch(view.state.tr.insert(pick(rnd, insertPositions(d)), createSelfRefNode(schema, pick(rnd, ids), '↳ src')));
    } else if (roll < 0.4) {
      const ids = blockIds(d);
      if (!ids.length || countBy(d, isTransclusionNode) >= MAX_COPIES) return;
      const o = buildInDocCopyAttrs(d, pick(rnd, ids));
      if (!o.ok || !o.attrs) return;
      view.dispatch(view.state.tr.insert(pick(rnd, insertPositions(d)), createTransclusionNode(schema, o.attrs, o.content)));
    } else if (roll < 0.48) {
      const bodies = bodyPositionsInZones(d);
      if (!bodies.length) return;
      view.dispatch(view.state.tr.insertText(` ${pick(rnd, WORDS)}`, pick(rnd, bodies)));
    } else if (roll < 0.56) {
      const zs = nodePositions(d, isTransclusionNode);
      if (!zs.length) return;
      const at = pick(rnd, zs);
      const node = d.nodeAt(at)!;
      view.dispatch(view.state.tr.replaceRange(at, at + node.nodeSize, detachSlice(node)));
    } else if (roll < 0.63) {
      const ss = nodePositions(d, isSelfRef);
      if (!ss.length) return;
      const at = pick(rnd, ss);
      const proj = resolveSelfProjection(d, String(d.nodeAt(at)!.attrs['source_heading_id'] ?? ''));
      // Freeze to cards (mirror unlink): drop the atom, splice the projection.
      view.dispatch(view.state.tr.replaceWith(at, at + 1, proj.content));
    } else if (roll < 0.69) {
      const ns = nodePositions(d, (n) => isTransclusionNode(n) || isSelfRef(n));
      if (!ns.length) return;
      const at = pick(rnd, ns);
      const node = d.nodeAt(at)!;
      view.dispatch(view.state.tr.delete(at, at + node.nodeSize));
    } else if (roll < 0.79) {
      // Re-point a live view to a random heading — may create a CYCLE.
      const ss = nodePositions(d, isSelfRef);
      const ids = headingIds(d);
      if (!ss.length || !ids.length) return;
      view.dispatch(view.state.tr.setNodeAttribute(pick(rnd, ss), 'source_heading_id', pick(rnd, ids)));
    } else if (roll < 0.93) {
      // Random numbering skeleton edit on a card / analytic_unit / block.
      const targets = nodePositions(d, (n) => n.type.name === 'card' || n.type.name === 'analytic_unit' || n.type.name === 'block');
      if (!targets.length) return;
      const at = pick(rnd, targets);
      const node = d.nodeAt(at)!;
      if (node.type.name === 'block') {
        view.dispatch(view.state.tr.setNodeAttribute(at, 'numRestart', !node.attrs['numRestart']));
      } else if (rnd() < 0.6) {
        view.dispatch(view.state.tr.setNodeAttribute(at, 'numRole', pick(rnd, ROLES)));
      } else {
        view.dispatch(view.state.tr.setNodeAttribute(at, 'numRestart', !node.attrs['numRestart']));
      }
    } else {
      view.dispatch(view.state.tr.insert(d.content.size, card(`Fuzz ${Math.floor(rnd() * 999)}`, 'body', pick(rnd, ROLES))));
    }
  } catch (e) {
    // Position/slice races throw RangeError and are expected; a stack overflow
    // (a runaway cycle) is ALSO a RangeError but a real bug — re-throw it, along
    // with any non-RangeError (a plugin/logic crash).
    if (e instanceof RangeError && !/call stack/i.test(String((e as Error).message))) return;
    throw e;
  }
}

function assertRenderTotal(d: PMNode, label: string): void {
  expect(() => d.check(), `${label}: schema`).not.toThrow();
  expect(() => computeNumbering(d), `${label}: computeNumbering`).not.toThrow();
  expect(() => inDocDivergence(d), `${label}: inDocDivergence`).not.toThrow();
  d.descendants((n) => {
    if (isSelfRef(n)) {
      expect(
        () => resolveSelfProjection(d, String(n.attrs['source_heading_id'] ?? '')),
        `${label}: resolveSelfProjection`,
      ).not.toThrow();
    }
    return true;
  });
}

function makeView(): EditorView {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const plugins: Plugin[] = [
    transclusionSelectionGuard,
    transclusionEmptyZoneReaper,
    makeSelfRefPlugin(),
    cardNumberingPlugin,
  ];
  return new EditorView(el, { state: EditorState.create({ doc: seedDoc(), plugins }) });
}

describe('new-features fuzz — transclusion + numbering (single view)', () => {
  it('stays valid + render-total across 20 seeds', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rnd = mulberry32(seed);
      const view = makeView();
      for (let i = 0; i < 35; i++) {
        op(rnd, view);
        assertRenderTotal(view.state.doc, `seed ${seed} op ${i}`);
      }
      const d = view.state.doc;

      // Leaving the doc: flatten materializes every live view to plain cards.
      const flat = flattenSelfRefs(d, newHeadingId);
      expect(() => flat.check(), `seed ${seed} flatten valid`).not.toThrow();
      expect(countBy(flat, isSelfRef), `seed ${seed} flatten removes live views`).toBe(0);

      // Native .cmir round-trip. The load path normalizes (flattens nested
      // copies, drops empty ones — schema/migrate.ts), so it isn't the identity;
      // the correct invariants are that it's VALID, that live views (atoms, never
      // touched by that migration) survive, that it's render-total, and that the
      // normalization CONVERGES (a second round-trip is a no-op).
      const rt = parseNative(serializeNative(d)).doc;
      expect(() => rt.check(), `seed ${seed} .cmir valid`).not.toThrow();
      expect(countBy(rt, isSelfRef), `seed ${seed} .cmir live views survive`).toBe(countBy(d, isSelfRef));
      assertRenderTotal(rt, `seed ${seed} .cmir`);
      const rt2 = parseNative(serializeNative(rt)).doc;
      expect(rt2.eq(rt), `seed ${seed} .cmir round-trip idempotent`).toBe(true);

      view.destroy();
    }
  });

  it('numbering survives a .docx round-trip across 30 random skeletons', async () => {
    for (let seed = 1; seed <= 30; seed++) {
      const rnd = mulberry32(seed * 7 + 3);
      const kids: PMNode[] = [];
      const n = 4 + Math.floor(rnd() * 10);
      for (let i = 0; i < n; i++) {
        const r = rnd();
        if (r < 0.2) kids.push(block(`Block ${i}`, `blk-${i}`));
        else if (r < 0.28) kids.push(para(`Loose ${i}`));
        else {
          const role = pick(rnd, ROLES);
          kids.push(card(`Card ${i}`, `body ${i}`, role, rnd() < 0.2));
        }
      }
      // Randomly flip some blocks to "continue".
      const d0 = doc(...kids);
      const withBlocks = doc(
        ...kids.map((k) =>
          k.type.name === 'block' && rnd() < 0.4
            ? schema.nodes['block']!.create({ ...k.attrs, numRestart: false }, k.content)
            : k,
        ),
      );
      void d0;
      const before = labelSeq(withBlocks);
      const rt = await fromDocx(await toDocx(withBlocks));
      expect(labelSeq(rt), `docx seed ${seed} numbers preserved`).toEqual(before);
    }
  });
});
