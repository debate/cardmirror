/**
 * Transclusion core logic (editable child-content model) — extraction, content
 * hashing + edit detection, id-rewrite, portable paths, detach, schema
 * round-trip. Pure (no DOM / no Electron).
 */
import { describe, expect, it } from 'vitest';
import { Fragment, Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import {
  extractSection,
  contentHash,
  isZoneEdited,
  prepareZoneContent,
  hashFragmentJSON,
  relativeSourceRef,
  createTransclusionNode,
  detachSlice,
  directZoneIdentities,
  zoneIdentity,
  TRANSCLUSION_NODE,
} from '../../src/editor/transclusion.js';

function heading(type: string, text: string, id: string): PMNode {
  return schema.nodes[type]!.create({ id }, text ? schema.text(text) : undefined);
}
function body(text: string): PMNode {
  return schema.nodes['card_body']!.create(null, text ? schema.text(text) : undefined);
}
function card(tagText: string, tagId: string, bodyText = 'evidence'): PMNode {
  return schema.nodes['card']!.createChecked(null, [heading('tag', tagText, tagId), body(bodyText)]);
}
function doc(children: PMNode[]): PMNode {
  return schema.nodes['doc']!.createChecked(null, children);
}
/** Fresh-id generator for tests (deterministic). */
function mkIds(prefix = 'fresh'): () => string {
  let n = 0;
  return () => `${prefix}-${n++}`;
}

const idP = 'id-pocket';
const idB1 = 'id-block-1';
const idB2 = 'id-block-2';
const idT1 = 'id-tag-1';
const idT2 = 'id-tag-2';
const idT3 = 'id-tag-3';
function fixture(): PMNode {
  return doc([
    heading('pocket', 'P', idP),
    heading('block', 'B1', idB1),
    card('T1', idT1),
    card('T2', idT2),
    heading('block', 'B2', idB2),
    card('T3', idT3),
  ]);
}

describe('extractSection — opaque zones (no truncation)', () => {
  it('a section containing a live zone is not truncated by the zone’s child headings', () => {
    // A zone targeting a hat holds hat/block-level children; the boundary walk
    // must treat the zone as an opaque unit and NOT stop inside it, or the zone
    // and everything after it is silently lost.
    const zone = createTransclusionNode(
      schema,
      { source_ref: 'S.cmir', source_ref_base: 'doc', source_heading_id: 'zh' },
      Fragment.fromArray([heading('hat', 'ZoneHat', 'zh-child'), card('ZoneCard', 'zc')]),
    );
    const src = doc([
      heading('block', 'B1', 'b1'),
      zone,
      card('AfterZone', 'after'),
      heading('block', 'B2', 'b2'),
      card('T3', 't3'),
    ]);
    const json = JSON.stringify(extractSection(src, 'b1')!.content.toJSON());
    expect(json).toContain('ZoneHat'); // the zone is kept whole, not truncated
    expect(json).toContain('AfterZone'); // content after the zone survives
    expect(json).not.toContain('"B2"'); // still stops at the next equal-level block
    expect(json).not.toContain('"T3"');
  });
});

describe('extractSection — the resolution rule (returns child content)', () => {
  it('block target: contents below the header, header excluded, stops at next equal level', () => {
    const frag = extractSection(fixture(), idB1)!.content;
    expect(frag.childCount).toBe(2);
    expect(frag.child(0).type.name).toBe('card');
    const json = JSON.stringify(frag.toJSON());
    expect(json).not.toContain('"B1"');
    expect(json).not.toContain('"B2"');
    expect(json).not.toContain('"T3"');
    expect(json).toContain('"T1"');
    expect(json).toContain('"T2"');
  });

  it('tag target: the whole card, tagline included', () => {
    const frag = extractSection(fixture(), idT1)!.content;
    expect(frag.childCount).toBe(1);
    expect(frag.child(0).type.name).toBe('card');
    expect(JSON.stringify(frag.toJSON())).toContain('"T1"');
  });

  it('pocket target: everything under it, to end of doc when no next pocket', () => {
    const s = JSON.stringify(extractSection(fixture(), idP)!.content.toJSON());
    expect(s).toContain('"B1"');
    expect(s).toContain('"B2"');
    expect(s).not.toContain('"P"');
  });

  it('missing / empty heading id → null', () => {
    expect(extractSection(fixture(), 'nope')).toBeNull();
    expect(extractSection(fixture(), '')).toBeNull();
  });

  it('empty section → empty content fragment (not a crash)', () => {
    const res = extractSection(doc([heading('block', 'Empty', 'id-empty')]), 'id-empty');
    expect(res!.content.size).toBe(0);
  });
});

describe('contentHash + isZoneEdited', () => {
  it('a freshly built zone (hash == content) is not edited', () => {
    const { content, hash } = prepareZoneContent(extractSection(fixture(), idB1)!.content, mkIds());
    const zone = createTransclusionNode(schema, { source_content_hash: hash }, content);
    expect(isZoneEdited(zone)).toBe(false);
  });
  it('a zone whose content differs from its stored hash is edited', () => {
    const { content } = prepareZoneContent(extractSection(fixture(), idB1)!.content, mkIds());
    const zone = createTransclusionNode(schema, { source_content_hash: 'stale' }, content);
    expect(isZoneEdited(zone)).toBe(true);
  });
  it('empty content hashes to the empty sentinel', () => {
    expect(contentHash(Fragment.empty)).toBe('empty');
  });
});

describe('prepareZoneContent — id rewrite + hash', () => {
  it('rewrites the source heading ids to fresh ones', () => {
    const { content } = prepareZoneContent(extractSection(fixture(), idB1)!.content, mkIds('fresh'));
    const s = JSON.stringify(content.toJSON());
    expect(s).not.toContain(idT1);
    expect(s).not.toContain(idT2);
    expect(s).toContain('fresh-0');
    expect(s).toContain('fresh-1');
  });
  it('the returned hash matches the rewritten content', () => {
    const { content, hash } = prepareZoneContent(extractSection(fixture(), idB1)!.content, mkIds());
    expect(hash).toBe(contentHash(content));
  });
});

describe('hashFragmentJSON — stable + key-order insensitive', () => {
  it('same content → same hash; different → different', () => {
    const a = contentHash(extractSection(fixture(), idB1)!.content);
    const b = contentHash(extractSection(fixture(), idB1)!.content);
    const c = contentHash(extractSection(fixture(), idB2)!.content);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
  it('insensitive to object key order', () => {
    expect(hashFragmentJSON([{ a: 1, b: 2 }])).toBe(hashFragmentJSON([{ b: 2, a: 1 }]));
  });
});

describe('relativeSourceRef — doc-relative fallback', () => {
  it('sibling / same / nested / windows / cross-drive', () => {
    expect(relativeSourceRef('/a/b/Doc.cmir', '/a/c/Src.cmir')).toBe('../c/Src.cmir');
    expect(relativeSourceRef('/a/b/Doc.cmir', '/a/b/Src.cmir')).toBe('Src.cmir');
    expect(relativeSourceRef('/a/Doc.cmir', '/a/b/c/Src.cmir')).toBe('b/c/Src.cmir');
    expect(relativeSourceRef('C:\\x\\Doc.cmir', 'C:\\x\\Imp\\Src.cmir')).toBe('Imp/Src.cmir');
    expect(relativeSourceRef('C:\\a\\Doc.cmir', 'D:\\a\\Src.cmir')).toBeNull();
  });
});

describe('schema round-trip through .cmir JSON', () => {
  it('a doc with a live zone survives toJSON → fromJSON with attrs + children intact', () => {
    const { content, hash } = prepareZoneContent(extractSection(fixture(), idB1)!.content, mkIds());
    const zone = createTransclusionNode(
      schema,
      {
        source_ref: 'Impacts/Src.cmir',
        source_ref_base: 'root',
        source_heading_id: idB1,
        source_content_hash: hash,
        last_refreshed: 1720000000000,
        source_label: 'Src › B1',
      },
      content,
    );
    const round = schema.nodeFromJSON(doc([heading('block', 'Mine', 'id-mine'), zone]).toJSON());
    let found: PMNode | null = null;
    round.descendants((n) => {
      if (n.type.name === TRANSCLUSION_NODE) found = n;
      return true;
    });
    const f = found! as PMNode;
    expect(f.attrs['source_ref']).toBe('Impacts/Src.cmir');
    expect(f.attrs['source_ref_base']).toBe('root');
    expect(f.attrs['source_content_hash']).toBe(hash);
    expect(f.attrs['last_refreshed']).toBe(1720000000000);
    expect(f.childCount).toBe(2);
    expect(f.child(0).type.name).toBe('card');
    expect(isZoneEdited(f)).toBe(false);
  });
});

describe('detachSlice — unwrap children', () => {
  it('yields the zone children (ids already unique)', () => {
    const { content, hash } = prepareZoneContent(extractSection(fixture(), idB1)!.content, mkIds('u'));
    const zone = createTransclusionNode(schema, { source_content_hash: hash }, content);
    const slice = detachSlice(zone);
    expect(slice.content.childCount).toBe(2);
    expect(slice.content.child(0).type.name).toBe('card');
  });
  it('empty zone → empty slice', () => {
    const zone = createTransclusionNode(schema, {}, Fragment.empty);
    expect(detachSlice(zone).content.size).toBe(0);
  });
});

describe('cycle identity helpers', () => {
  it('zoneIdentity encodes source_ref + heading id; distinct pairs differ', () => {
    const a1 = createTransclusionNode(schema, { source_ref: 'a.cmir', source_heading_id: 'h1' });
    const a2 = createTransclusionNode(schema, { source_ref: 'a.cmir', source_heading_id: 'h1' });
    const b = createTransclusionNode(schema, { source_ref: 'a.cmir', source_heading_id: 'h2' });
    expect(zoneIdentity(a1)).toBe(zoneIdentity(a2));
    expect(zoneIdentity(a1)).not.toBe(zoneIdentity(b));
    expect(zoneIdentity(a1).includes('a.cmir')).toBe(true);
  });
  it('directZoneIdentities finds top-level zones in a fragment', () => {
    const z1 = createTransclusionNode(schema, { source_ref: 'a.cmir', source_heading_id: 'h1' });
    const z2 = createTransclusionNode(schema, { source_ref: 'b.cmir', source_heading_id: 'h2' });
    const ids = directZoneIdentities(Fragment.fromArray([z1, body('x'), z2]));
    expect(ids.has(zoneIdentity(z1))).toBe(true);
    expect(ids.has(zoneIdentity(z2))).toBe(true);
    expect(ids.size).toBe(2);
  });
});
