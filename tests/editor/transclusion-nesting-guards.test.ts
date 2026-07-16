// @vitest-environment jsdom
/**
 * "No stacked rails" guards for live views + linked copies, plus the paste/copy
 * edit-baseline fix:
 *  - a copied/pasted UNEDITED linked copy stays UNEDITED (the id rewrite must
 *    re-baseline its id-dependent content hash, or it reads as edited);
 *  - a live view's projection shows a nested linked copy FLAT (no inner rail);
 *  - creating a live view with the caret inside a linked copy shunts it OUT;
 *  - pasting a linked copy INTO a live zone flattens (never nests).
 */
import { describe, it, expect } from 'vitest';
import { Fragment, Slice, type Node as PMNode } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  createTransclusionNode,
  contentHash,
  isZoneEdited,
  isTransclusionNode,
} from '../../src/editor/transclusion.js';
import { freshHeadingIds, rewriteHeadingIds } from '../../src/editor/drag-controller.js';
import {
  createSelfRefNode,
  isSelfRef,
  resolveSelfProjection,
  fragmentHasSelfRef,
} from '../../src/editor/self-transclusion.js';
import { insertSelfRef } from '../../src/editor/self-transclusion-commands.js';
import { buildInDocCopyAttrs } from '../../src/editor/transclusion-actions.js';
import { inDocDivergence } from '../../src/editor/transclusion-divergence.js';
import { buildPastePlugin } from '../../src/editor/paste-plugin.js';
import { rememberLinkedCopy, clearLinkedCopy } from '../../src/editor/clipboard-link-cache.js';

const block = (t: string, id: string): PMNode => schema.nodes['block']!.create({ id }, schema.text(t));
function card(tag: string, body: string): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
/** A linked copy (in-doc) whose baseline matches its content → UNEDITED. */
function uneditedCopy(children: PMNode[]): PMNode {
  const content = Fragment.fromArray(children);
  return createTransclusionNode(
    schema,
    { source_ref: ' self', source_ref_base: 'doc', source_heading_id: 'H', source_content_hash: contentHash(content) },
    content,
  );
}
function firstZone(frag: Fragment): PMNode | null {
  let z: PMNode | null = null;
  frag.descendants((n) => {
    if (!z && isTransclusionNode(n)) z = n;
    return !z;
  });
  return z;
}
function cardIds(node: PMNode): string[] {
  const ids: string[] = [];
  node.descendants((n) => {
    if (n.type.name === 'tag' && typeof n.attrs['id'] === 'string') ids.push(n.attrs['id']);
    return true;
  });
  return ids;
}

describe('issue 4 — a copied/pasted UNEDITED linked copy is not shown as edited', () => {
  it('freshHeadingIds re-baselines an unedited zone (ids change, edited=false)', () => {
    const original = uneditedCopy([card('A', 'a'), card('B', 'b')]);
    expect(isZoneEdited(original)).toBe(false);
    const slice = new Slice(Fragment.fromArray([original]), 0, 0);

    const out = freshHeadingIds(slice);
    const pasted = firstZone(out.content)!;
    // The internal card ids were genuinely rewritten (no collision with the source)…
    expect(cardIds(pasted)).not.toEqual(cardIds(original));
    // …yet the copy still reads as UNEDITED (the baseline hash was re-stamped).
    expect(isZoneEdited(pasted)).toBe(false);
  });

  it('rewriteHeadingIds (drag-copy path) also re-baselines', () => {
    const original = uneditedCopy([card('A', 'a')]);
    const out = rewriteHeadingIds(new Slice(Fragment.fromArray([original]), 0, 0));
    expect(isZoneEdited(firstZone(out.content)!)).toBe(false);
  });

  it('an EDITED zone stays edited through the id rewrite', () => {
    const content = Fragment.fromArray([card('A', 'a')]);
    const edited = createTransclusionNode(
      schema,
      { source_ref: ' self', source_ref_base: 'doc', source_heading_id: 'H', source_content_hash: 'STALE-baseline' },
      content,
    );
    expect(isZoneEdited(edited)).toBe(true);
    const out = freshHeadingIds(new Slice(Fragment.fromArray([edited]), 0, 0));
    expect(isZoneEdited(firstZone(out.content)!)).toBe(true);
  });
});

describe('issue 3d — a live view projects a nested linked copy FLAT (no inner rail)', () => {
  it('resolveSelfProjection inlines a transclusion_ref inside the mirrored section', () => {
    const doc = schema.nodes['doc']!.create(null, [
      block('Src', 'S'),
      card('Plain', 'plain-ev'),
      uneditedCopy([card('Copied', 'copied-ev')]),
      block('End', 'E'),
    ]);
    const proj = resolveSelfProjection(doc, 'S');
    // The projected content carries the copy's cards but NOT the copy's rail.
    expect(isTransclusionNode(firstZone(proj.content))).toBe(false);
    expect(firstZone(proj.content)).toBeNull();
    const text = proj.content.textBetween(0, proj.content.size, ' ');
    expect(text).toContain('plain-ev');
    expect(text).toContain('copied-ev');
  });
});

// ---- View-based guards ----

function mount(doc: PMNode): EditorView {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new EditorView(el, { state: EditorState.create({ doc, plugins: [buildPastePlugin({
    condenseOnPaste: () => false,
    paragraphIntegrity: () => false,
    usePilcrows: () => false,
    smartPasteConversion: () => false,
    headingMode: () => 'strict',
  })] }) });
}
function zonePosIn(doc: PMNode): number {
  let p = -1;
  doc.descendants((n, pos) => {
    if (p < 0 && isTransclusionNode(n)) p = pos;
    return p < 0;
  });
  return p;
}

describe('issue 3a — creating a live view inside a linked copy shunts it out', () => {
  it('lands the self_ref AFTER the zone at top level, never inside it', () => {
    const doc = schema.nodes['doc']!.create(null, [
      block('Target', 'T'),
      card('TargetCard', 'tc'),
      uneditedCopy([card('Inside', 'inside-ev')]),
    ]);
    const view = mount(doc);
    // Put the caret inside the linked copy.
    const zPos = zonePosIn(view.state.doc);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, zPos + 3)));

    expect(insertSelfRef(view, 'T')).toBe(true);
    // Exactly one self_ref, and it is a TOP-LEVEL child (its parent is the doc),
    // sitting after the zone — not nested in it.
    let selfDepth = -1;
    let selfInsideZone = false;
    view.state.doc.descendants((n, pos) => {
      if (isSelfRef(n)) {
        selfDepth = view.state.doc.resolve(pos).depth;
        selfInsideZone = view.state.doc.resolve(pos).node(1)?.type.name === 'transclusion_ref';
      }
      return true;
    });
    expect(selfDepth).toBe(0); // top level
    expect(selfInsideZone).toBe(false);
    view.destroy();
  });
});

describe('case 5 — a linked copy of a section holding a live view materializes it flat', () => {
  // Other (source of the live view) · Src (the section being copied, holds a live
  // view of Other) · Dest (where the copy lands).
  function docWithViewInSection(): PMNode {
    return schema.nodes['doc']!.create(null, [
      block('Other', 'O'),
      card('OtherCard', 'o-ev'),
      block('Src', 'S'),
      card('SrcCard', 's-ev'),
      createSelfRefNode(schema, 'O', '↳ Other'),
      block('Dest', 'D'),
      card('DestCard', 'd-ev'),
    ]);
  }

  it('buildInDocCopyAttrs flattens the embedded live view to plain cards', () => {
    const doc = docWithViewInSection();
    const outcome = buildInDocCopyAttrs(doc, 'S');
    expect(outcome.ok).toBe(true);
    const content = outcome.content!;
    // No live view survives in the copy — no rail-in-rail.
    expect(fragmentHasSelfRef(content)).toBe(false);
    const text = content.textBetween(0, content.size, ' ');
    expect(text).toContain('s-ev'); // the section's own card
    expect(text).toContain('o-ev'); // the live view's projected card, now inlined flat
  });

  it('the freshly-created copy does NOT read as edited or diverged', () => {
    const doc = docWithViewInSection();
    const outcome = buildInDocCopyAttrs(doc, 'S');
    const copy = createTransclusionNode(schema, outcome.attrs!, outcome.content!);
    // Put the copy in Dest's section (not Src's) so extracting Src is unchanged.
    const full = schema.nodes['doc']!.create(null, [...docWithViewInSection().content.content, copy]);

    expect(isZoneEdited(copy)).toBe(false);
    // Divergence recomputes Src's shape the SAME way (live view → cards); the
    // baseline and the fresh read hash identically, so it's not flagged.
    const { all, diverged } = inDocDivergence(full);
    expect(all.size).toBe(1);
    expect(diverged.size).toBe(0);
  });
});

describe('issue 3b — pasting a linked copy INTO a live zone flattens (no nesting)', () => {
  it('caret inside a zone flattens the pasted copy; caret at top level keeps the link', () => {
    clearLinkedCopy();
    const doc = schema.nodes['doc']!.create(null, [
      block('Home', 'H'),
      uneditedCopy([card('Z', 'z-ev')]),
      block('Tail', 'Tl'),
    ]);
    const view = mount(doc);
    const plugin = view.state.plugins.find((p) => p.props?.transformPasted)!;
    const transformPasted = plugin.props.transformPasted!;

    // A copied linked copy on the clipboard (a same-doc copy remembered the link).
    const copied = new Slice(Fragment.fromArray([uneditedCopy([card('Z', 'z-ev')])]), 0, 0);
    rememberLinkedCopy(copied, view, copied);

    // Caret INSIDE the existing zone → paste must flatten (no rail-in-rail).
    const zPos = zonePosIn(view.state.doc);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, zPos + 3)));
    const inZone = transformPasted.call(plugin, copied, view, false) as Slice;
    expect(isTransclusionNode(firstZone(inZone.content))).toBe(false);

    // Caret at TOP LEVEL → the link is preserved (the same-doc keep-link feature).
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    const topLevel = transformPasted.call(plugin, copied, view, false) as Slice;
    expect(isTransclusionNode(firstZone(topLevel.content))).toBe(true);
    view.destroy();
    clearLinkedCopy();
  });
});
