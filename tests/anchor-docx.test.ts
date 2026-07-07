/**
 * Surgical heading-anchor injection (`src/anchor-docx.ts`).
 *
 * A `.docx` becomes a refreshable live-zone source only if the transcluded
 * heading carries a `pmd-heading` bookmark. These tests build a real `.docx`
 * via `toDocx`, strip its bookmarks to simulate a raw Word / Verbatim file
 * (fresh ids on every import → un-refreshable), then prove `ensureHeadingAnchor`
 * makes exactly the picked heading re-locatable — additively, idempotently, and
 * fail-safe.
 */

import { describe, expect, it } from 'vitest';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../src/schema/index.js';
import { fromDocx } from '../src/import/index.js';
import { toDocx } from '../src/export/index.js';
import { Docx } from '../src/ooxml/docx.js';
import {
  parseXml,
  findChild,
  children,
  bodyParagraphsInOrder,
  textContent,
} from '../src/ooxml/parse.js';
import { ensureHeadingAnchor } from '../src/anchor-docx.js';

const ALPHA_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const BRAVO_ID = 'bbbbbbbb-1111-2222-3333-444444444444';
const NEW_ID = 'cccccccc-9999-8888-7777-666666666666';

/** doc: pocket "Alpha" · paragraph · pocket "Bravo" · paragraph
 *  → body-paragraph order [Alpha=0, body=1, Bravo=2, body=3]. */
function sampleDoc(): PMNode {
  return schema.nodes['doc']!.createChecked(null, [
    schema.nodes['pocket']!.create({ id: ALPHA_ID }, schema.text('Alpha')),
    schema.nodes['paragraph']!.create(null, schema.text('body under alpha')),
    schema.nodes['pocket']!.create({ id: BRAVO_ID }, schema.text('Bravo')),
    schema.nodes['paragraph']!.create(null, schema.text('body under bravo')),
  ]);
}

/** Remove every Word bookmark from document.xml → the file a raw Verbatim
 *  export would have produced (no stable heading anchors). */
async function stripBookmarks(bytes: Uint8Array): Promise<Uint8Array> {
  const docx = await Docx.load(bytes);
  const xml = (await docx.readText('word/document.xml'))!;
  docx.writeText('word/document.xml', xml.replace(/<w:bookmark(Start|End)\b[^>]*\/>/g, ''));
  return docx.toBuffer();
}

/** id of the pocket whose text is `text` in an imported doc, or null. */
function pocketId(doc: PMNode, text: string): string | null {
  let found: string | null = null;
  doc.descendants((n) => {
    if (n.type.name === 'pocket' && n.textContent === text) {
      found = (n.attrs as { id: string }).id;
      return false;
    }
    return true;
  });
  return found;
}

/** srcPara index of the body paragraph whose text is `text` (mirrors what the
 *  importer's provenance map would report). */
async function srcParaOf(bytes: Uint8Array, text: string): Promise<number> {
  const docx = await Docx.load(bytes);
  const xml = (await docx.readText('word/document.xml'))!;
  const body = findChild(children(findChild(parseXml(xml), 'w:document')!, 'w:document'), 'w:body')!;
  const paras = bodyParagraphsInOrder(children(body, 'w:body'));
  return paras.findIndex((p) => textContent(p).trim() === text);
}

describe('ensureHeadingAnchor', () => {
  it('makes a raw .docx heading re-locatable by injecting one bookmark', async () => {
    const raw = await stripBookmarks(await toDocx(sampleDoc()));
    // Sanity: stripped file has no stable id for Bravo (fresh on import).
    expect(pocketId(await fromDocx(raw), 'Bravo')).not.toBe(BRAVO_ID);

    const srcPara = await srcParaOf(raw, 'Bravo');
    expect(srcPara).toBe(2);
    const out = await ensureHeadingAnchor(raw, srcPara, NEW_ID, 'Bravo');

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.added).toBe(true);
    expect(out.headingId).toBe(NEW_ID);
    // Re-importing the written file re-locates the section under the new id.
    expect(pocketId(await fromDocx(out.bytes), 'Bravo')).toBe(NEW_ID);
  });

  it('is idempotent — an already-anchored paragraph is reused, not rewritten', async () => {
    const withBookmarks = await toDocx(sampleDoc()); // exporter wrote pmd-heading bookmarks
    const srcPara = await srcParaOf(withBookmarks, 'Bravo');
    const out = await ensureHeadingAnchor(withBookmarks, srcPara, NEW_ID, 'Bravo');

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.added).toBe(false); // no write needed
    expect(out.headingId).toBe(BRAVO_ID); // the EXISTING id, not NEW_ID
    expect(out.bytes).toBe(withBookmarks); // same reference — untouched
  });

  it('refuses to anchor when the paragraph text does not match (corruption guard)', async () => {
    const raw = await stripBookmarks(await toDocx(sampleDoc()));
    const srcPara = await srcParaOf(raw, 'Bravo');
    const out = await ensureHeadingAnchor(raw, srcPara, NEW_ID, 'Some Other Heading');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('text-mismatch');
  });

  it('reports paragraph-not-found for an out-of-range srcPara', async () => {
    const raw = await stripBookmarks(await toDocx(sampleDoc()));
    const out = await ensureHeadingAnchor(raw, 999, NEW_ID, 'Bravo');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('paragraph-not-found');
  });

  it('leaves every other paragraph untouched', async () => {
    const raw = await stripBookmarks(await toDocx(sampleDoc()));
    const before = await fromDocx(raw);
    const srcPara = await srcParaOf(raw, 'Bravo');
    const out = await ensureHeadingAnchor(raw, srcPara, NEW_ID, 'Bravo');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const after = await fromDocx(out.bytes);

    // Same structure + text throughout; only Bravo gained a stable anchor.
    // (Alpha stays un-anchored, so it mints a fresh random id on EACH import —
    // not comparable across the two; that its content survives is the point.)
    expect(after.childCount).toBe(before.childCount);
    expect(after.textContent).toBe(before.textContent);
    expect(pocketId(after, 'Alpha')).not.toBeNull();
    expect(pocketId(after, 'Bravo')).toBe(NEW_ID);
  });
});
