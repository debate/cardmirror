/**
 * Heading source-paragraph provenance (`fromDocx(bytes, provenanceOut)`).
 *
 * The `.docx` source-anchor injector locates a heading's paragraph by the
 * `srcPara` index the importer records. These tests prove that index is (a)
 * recorded for every heading kind (pocket via `paragraphToNode`, tag, analytic),
 * (b) correct in the presence of a table — whose cell paragraphs must NOT be
 * counted, matching `collectBlocks` — and (c) consumable by `ensureHeadingAnchor`
 * to re-locate exactly that section.
 */

import { describe, expect, it } from 'vitest';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import { HEADING_TYPE_NAMES } from '../../src/schema/ids.js';
import { fromDocx } from '../../src/import/index.js';
import { toDocx } from '../../src/export/index.js';
import { Docx } from '../../src/ooxml/docx.js';
import { ensureHeadingAnchor } from '../../src/anchor-docx.js';

const cell = (t: string): PMNode =>
  schema.nodes['table_cell']!.create(null, schema.nodes['paragraph']!.create(null, schema.text(t)));

/** doc with a heading of every provenance-recording kind, plus a table between
 *  the first two headings so cell paragraphs stress the "skip tables" rule. */
function sampleDoc(): PMNode {
  return schema.nodes['doc']!.createChecked(null, [
    schema.nodes['pocket']!.create({ id: 'p-1' }, schema.text('H1')),
    schema.nodes['paragraph']!.create(null, schema.text('intro body')),
    schema.nodes['table']!.create(null, [
      schema.nodes['table_row']!.create(null, [cell('cellA'), cell('cellB')]),
    ]),
    schema.nodes['pocket']!.create({ id: 'p-2' }, schema.text('H2')),
    schema.nodes['card']!.create(null, [
      schema.nodes['tag']!.create({ id: 't-3' }, schema.text('H3')),
      schema.nodes['card_body']!.create(null, schema.text('body three')),
    ]),
    schema.nodes['analytic_unit']!.create(null, [
      schema.nodes['analytic']!.create({ id: 'a-4' }, schema.text('H4')),
      schema.nodes['card_body']!.create(null, schema.text('body four')),
    ]),
  ]);
}

async function stripBookmarks(bytes: Uint8Array): Promise<Uint8Array> {
  const docx = await Docx.load(bytes);
  const xml = (await docx.readText('word/document.xml'))!;
  docx.writeText('word/document.xml', xml.replace(/<w:bookmark(Start|End)\b[^>]*\/>/g, ''));
  return docx.toBuffer();
}

/** All (text → {id, type}) headings in a doc. */
function headings(doc: PMNode): Map<string, { id: string; type: string }> {
  const out = new Map<string, { id: string; type: string }>();
  doc.descendants((n) => {
    if (HEADING_TYPE_NAMES.has(n.type.name)) {
      out.set(n.textContent, { id: (n.attrs as { id: string }).id, type: n.type.name });
    }
  });
  return out;
}

describe('heading provenance', () => {
  it('records srcPara for every heading kind, skipping table cells', async () => {
    const raw = await stripBookmarks(await toDocx(sampleDoc()));
    const prov = new Map<string, number>();
    const doc = await fromDocx(raw, prov);
    const byText = headings(doc);

    // Every heading kind is present and has a provenance entry.
    for (const kind of ['H1', 'H2', 'H3', 'H4']) {
      expect(byText.has(kind), `heading ${kind} imported`).toBe(true);
      expect(prov.has(byText.get(kind)!.id), `provenance for ${kind}`).toBe(true);
    }
    expect(byText.get('H3')!.type).toBe('tag');
    expect(byText.get('H4')!.type).toBe('analytic');

    // Body-paragraph order is H1=0, intro=1, [table cells skipped], H2=2, …
    // If the table's two cells were miscounted, H2 would land at 4.
    expect(prov.get(byText.get('H1')!.id)).toBe(0);
    expect(prov.get(byText.get('H2')!.id)).toBe(2);
  });

  it('provenance srcPara re-locates each heading through the injector', async () => {
    const raw = await stripBookmarks(await toDocx(sampleDoc()));
    const prov = new Map<string, number>();
    const doc = await fromDocx(raw, prov);

    for (const [text, { id }] of headings(doc)) {
      const srcPara = prov.get(id)!;
      const newId = `anchored-${text}`;
      // Injector locates paragraph[srcPara]; its text must match the heading
      // (proving importer + injector agree on which paragraph is the Nth).
      const out = await ensureHeadingAnchor(raw, srcPara, newId, text);
      expect(out.ok, `anchor ${text}`).toBe(true);
      if (!out.ok) continue;
      expect(out.added).toBe(true);
      // Re-importing the written file finds THAT heading under the new id.
      const reimported = headings(await fromDocx(out.bytes));
      expect(reimported.get(text)!.id).toBe(newId);
    }
  });
});
