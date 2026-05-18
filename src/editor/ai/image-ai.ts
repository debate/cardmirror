/**
 * AI helpers that take an existing `image` node in the doc and
 * produce a follow-up block beneath it:
 *
 *   - `runGenerateAltText` — sends the image to Claude with a
 *     description prompt; inserts a `[ALT TEXT: …]` paragraph
 *     (in the user's omission-bracket style) right after the
 *     textblock containing the image.
 *   - `runGenerateTable` — sends the image to Claude asking for a
 *     structured JSON description of the table; converts the JSON
 *     into a real PM `table` / `table_row` / `table_cell` tree
 *     (with bold / italic inline marks + colspan / rowspan
 *     merges) and inserts it after the image's textblock.
 *
 * Both are gated on the `aiFeaturesEnabled` setting and the user
 * having an Anthropic API key configured. Errors surface as
 * toasts; the doc is never partially modified — every insertion
 * happens in a single transaction at the end of the API call.
 */

import type { Node as PMNode, Mark } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { schema } from '../../schema/index.js';
import {
  settings,
  condenseWarningCloseFor,
  type CondenseWarningDelimiter,
} from '../settings.js';
import { showToast } from '../toast.js';
import { AnthropicError, callAnthropic, type AnthropicContentBlock } from './anthropic.js';
import { ThinkingTooltip } from './thinking-tooltip.js';

/** Resolve the user-configured omission-bracket pair. Matches the
 *  same delimiter setting `Condense with warning` uses, so a doc
 *  configured for `<<…>>` omissions gets `<<ALT TEXT: …>>`. */
function currentOmissionBrackets(): { open: string; close: string } {
  const delim = settings.get('condenseWarningDelimiter') as CondenseWarningDelimiter;
  if (delim === 'custom') {
    // 'custom' is reserved for paragraph-replacement strings on the
    // warning command. For alt-text we fall back to the most common
    // bracket pair rather than trying to wrap a multi-character
    // marker around inline text.
    return { open: '[', close: ']' };
  }
  return { open: delim, close: condenseWarningCloseFor(delim) };
}

/** Common preflight: AI enabled? Key set? Returns the key or null
 *  (with a toast already shown). */
function preflight(): string | null {
  if (!settings.get('aiFeaturesEnabled')) {
    showToast('AI features are disabled — enable them in Settings.');
    return null;
  }
  const apiKey = settings.get('anthropicApiKey').trim();
  if (!apiKey) {
    showToast('Set an Anthropic API key in Settings to use AI features.');
    return null;
  }
  return apiKey;
}

/** Anthropic's vision endpoint accepts only common raster formats.
 *  SVG / EMF / TIFF / etc. round-trip through our schema but the
 *  API rejects them, so we bail early with a clear message. */
const VISION_SUPPORTED = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

function unsupportedToast(contentType: string): void {
  showToast(`AI vision doesn't support ${contentType}. Try PNG / JPEG / GIF / WebP.`);
}

/** Locate the textblock containing the image (a `paragraph`,
 *  `card_body`, `cite_paragraph`, etc.) so an AI follow-up can be
 *  inserted as a SIBLING of the same type right after it. The
 *  earlier implementation returned a `$pos.after(depth)` position
 *  without considering the parent's schema; when that position
 *  didn't accept the inserted node type, PM's structural fitting
 *  closed-and-reopened ancestors and the insertion drifted to the
 *  bottom of the doc. By inserting a sibling of the SAME type at
 *  the textblock's `after()` position, the node always fits in the
 *  parent and lands where the user expects. */
function findImageContainerInsertion(
  view: EditorView,
  imagePos: number,
): { insertPos: number; sameTypeBlock: PMNode } | null {
  const $pos = view.state.doc.resolve(imagePos);
  if ($pos.depth < 1) return null;
  const containingBlock = $pos.node($pos.depth);
  if (!containingBlock.isTextblock) return null;
  return {
    insertPos: $pos.after($pos.depth),
    sameTypeBlock: containingBlock,
  };
}

/** Anchor for the in-flight tooltip — pinned just below the image's
 *  bottom edge in viewport coords. */
function tooltipAnchorFor(view: EditorView, imagePos: number): {
  left: number; top: number; bottom: number;
} {
  try {
    const coords = view.coordsAtPos(imagePos);
    return { left: coords.left, top: coords.top, bottom: coords.bottom };
  } catch {
    return { left: 16, top: 16, bottom: 32 };
  }
}

// ============================================================
// Alt-text generation
// ============================================================

const ALT_TEXT_SYSTEM_PROMPT = `You write short, plain-English alt text for images embedded in debate evidence documents. Keep the description to ONE sentence, under 25 words, factual, no commentary. Do not start with "An image of" or similar filler. Just describe what's visible.

You may also receive surrounding text from the document (the card's tag, cite, and the paragraphs immediately before and after the image) as context. Use it to decide which features of the image are salient enough to mention — but the alt text describes the IMAGE itself, not the surrounding text. Do not quote or summarize the context in the alt text.`;

interface ImageContext {
  tag: string;
  cite: string;
  paragraphBefore: string;
  paragraphAfter: string;
}

/** Gather the four pieces of surrounding context we ship with the
 *  image: the enclosing card's tag and cite (if any), plus the
 *  textblock siblings immediately before and after the image's
 *  containing textblock. Each piece may be empty — the caller
 *  filters empties out before building the prompt. */
function gatherImageContext(view: EditorView, imagePos: number): ImageContext {
  const ctx: ImageContext = { tag: '', cite: '', paragraphBefore: '', paragraphAfter: '' };
  const doc = view.state.doc;
  const $pos = doc.resolve(imagePos);

  // Locate the textblock containing the image. `resolve(imagePos)`
  // lands at the image's position; depth points at the textblock
  // when the parent is a textblock containing inline content.
  let blockDepth = $pos.depth;
  while (blockDepth > 0 && !$pos.node(blockDepth).isTextblock) blockDepth--;
  if (blockDepth === 0) return ctx;

  // Walk ancestors to find the enclosing `card`, if any.
  for (let d = blockDepth - 1; d >= 0; d--) {
    const node = $pos.node(d);
    if (node.type.name === 'card') {
      node.forEach((child) => {
        if (child.type.name === 'tag' && !ctx.tag) {
          ctx.tag = child.textContent.trim();
        } else if (child.type.name === 'cite_paragraph' && !ctx.cite) {
          ctx.cite = child.textContent.trim();
        }
      });
      break;
    }
  }

  // Sibling textblocks at the same level as the image's textblock.
  const parent = $pos.node(blockDepth - 1);
  const idx = $pos.index(blockDepth - 1);
  const siblingTextAt = (i: number): string => {
    if (i < 0 || i >= parent.childCount) return '';
    const child = parent.child(i);
    if (!child.isTextblock) return '';
    return child.textContent.trim();
  };
  ctx.paragraphBefore = siblingTextAt(idx - 1);
  ctx.paragraphAfter = siblingTextAt(idx + 1);

  return ctx;
}

/** Render the gathered context as a single text block to prepend
 *  to the user message. Returns `''` when nothing useful was
 *  gathered (e.g., a doc-level paragraph with no neighbors). */
function formatImageContextForPrompt(ctx: ImageContext): string {
  const lines: string[] = [];
  if (ctx.tag) lines.push(`Card tag: ${ctx.tag}`);
  if (ctx.cite) lines.push(`Cite: ${ctx.cite}`);
  if (ctx.paragraphBefore) lines.push(`Paragraph before the image: ${ctx.paragraphBefore}`);
  if (ctx.paragraphAfter) lines.push(`Paragraph after the image: ${ctx.paragraphAfter}`);
  if (lines.length === 0) return '';
  return `Context from the surrounding document:\n${lines.join('\n')}`;
}

export function runGenerateAltText(
  view: EditorView,
  imagePos: number,
  imageNode: PMNode,
): void {
  const apiKey = preflight();
  if (!apiKey) return;

  const contentType = String(imageNode.attrs['contentType'] ?? '');
  const data = String(imageNode.attrs['data'] ?? '');
  if (!VISION_SUPPORTED.has(contentType) || !data) {
    unsupportedToast(contentType || 'unknown');
    return;
  }

  const tooltip = new ThinkingTooltip();
  tooltip.show(tooltipAnchorFor(view, imagePos));

  const contextText = formatImageContextForPrompt(gatherImageContext(view, imagePos));

  void (async () => {
    try {
      const userContent: AnthropicContentBlock[] = [];
      if (contextText) userContent.push({ type: 'text', text: contextText });
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: contentType, data },
      });
      userContent.push({ type: 'text', text: 'Write the alt text for this image.' });
      const reply = await callAnthropic({
        apiKey,
        system: ALT_TEXT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      });
      const altText = reply.text.trim().replace(/\s+/g, ' ');
      if (!altText) {
        showToast('AI returned an empty response.');
        return;
      }
      const { open, close } = currentOmissionBrackets();
      const labelText = `${open}ALT TEXT: ${altText}${close}`;
      const target = findImageContainerInsertion(view, imagePos);
      if (!target) {
        showToast('Could not locate insertion point.');
        return;
      }
      // Insert as a SIBLING textblock of the same type as the one
      // containing the image (paragraph, card_body, etc.) so PM's
      // structural fitting doesn't bounce the new node out of the
      // surrounding container.
      const sibling = target.sameTypeBlock.type.create(null, schema.text(labelText));
      const tr = view.state.tr.insert(target.insertPos, sibling);
      view.dispatch(tr.scrollIntoView());
    } catch (err) {
      if (err instanceof AnthropicError) {
        showToast(`Alt text: ${err.message}`);
      } else {
        showToast(`Alt text: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      tooltip.hide();
    }
  })();
}

// ============================================================
// Table-from-image generation
// ============================================================

interface CellSpec {
  text: string;
  bold?: boolean;
  italic?: boolean;
  colspan?: number;
  rowspan?: number;
}

interface RowSpec { cells: CellSpec[] }
interface TableSpec { rows: RowSpec[] }

const TABLE_SYSTEM_PROMPT = `You extract tables from images. Return ONLY valid JSON in this schema:
{
  "rows": [
    {
      "cells": [
        { "text": "string", "bold": false, "italic": false, "colspan": 1, "rowspan": 1 }
      ]
    }
  ]
}

Rules:
- One "rows" entry per visible row.
- One "cells" entry per visible cell. OMIT cells that are spanned over by a merge from a previous cell (they are represented by colspan/rowspan on the merging cell).
- "text" is the visible cell content as a plain string. Use a single space to separate words across line wraps.
- "bold" / "italic" reflect the visible formatting of the WHOLE cell text. Default false. (Mixed runs are uncommon in debate tables — pick the dominant style.)
- "colspan" / "rowspan" are positive integers; default 1.
- Do NOT include keys other than the four above.
- Do NOT include any text outside the JSON.`;

/** Extract a JSON object from a model response that may have extra
 *  prose, code fences, or trailing commentary. Returns null when no
 *  parsable JSON is found. */
function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  // Try direct parse first.
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  // Strip a markdown code fence if present.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1]!); } catch { /* fall through */ }
  }
  // Pull the first {…} balanced span.
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* fall through */ }
  }
  return null;
}

function validateTableSpec(raw: unknown): TableSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const rowsRaw = (raw as { rows?: unknown }).rows;
  if (!Array.isArray(rowsRaw) || rowsRaw.length === 0) return null;
  const rows: RowSpec[] = [];
  for (const r of rowsRaw) {
    if (!r || typeof r !== 'object') return null;
    const cellsRaw = (r as { cells?: unknown }).cells;
    if (!Array.isArray(cellsRaw)) return null;
    const cells: CellSpec[] = [];
    for (const c of cellsRaw) {
      if (!c || typeof c !== 'object') return null;
      const cellObj = c as Record<string, unknown>;
      const text = typeof cellObj['text'] === 'string' ? cellObj['text'] : '';
      const colspan = typeof cellObj['colspan'] === 'number' && cellObj['colspan'] >= 1
        ? Math.floor(cellObj['colspan'] as number) : 1;
      const rowspan = typeof cellObj['rowspan'] === 'number' && cellObj['rowspan'] >= 1
        ? Math.floor(cellObj['rowspan'] as number) : 1;
      cells.push({
        text,
        bold: cellObj['bold'] === true,
        italic: cellObj['italic'] === true,
        colspan,
        rowspan,
      });
    }
    rows.push({ cells });
  }
  return { rows };
}

/** Build a PM `table` node from the validated spec. */
function buildTableNode(spec: TableSpec): PMNode {
  const tableType = schema.nodes['table']!;
  const rowType = schema.nodes['table_row']!;
  const cellType = schema.nodes['table_cell']!;
  const paraType = schema.nodes['paragraph']!;
  const boldMark = schema.marks['bold'];
  const italicMark = schema.marks['italic'];

  const rowNodes: PMNode[] = [];
  for (const row of spec.rows) {
    const cellNodes: PMNode[] = [];
    for (const cell of row.cells) {
      const marks: Mark[] = [];
      if (cell.bold && boldMark) marks.push(boldMark.create());
      if (cell.italic && italicMark) marks.push(italicMark.create());
      // table_cell content is `paragraph+`. Cells always have at
      // least one paragraph; empty cells get a single empty para.
      const paraContent = cell.text
        ? [schema.text(cell.text, marks.length ? marks : null)]
        : [];
      const paragraph = paraType.create(null, paraContent);
      cellNodes.push(cellType.create(
        { colspan: cell.colspan ?? 1, rowspan: cell.rowspan ?? 1 },
        [paragraph],
      ));
    }
    rowNodes.push(rowType.create(null, cellNodes));
  }
  return tableType.create(null, rowNodes);
}

export function runGenerateTable(
  view: EditorView,
  imagePos: number,
  imageNode: PMNode,
): void {
  const apiKey = preflight();
  if (!apiKey) return;

  const contentType = String(imageNode.attrs['contentType'] ?? '');
  const data = String(imageNode.attrs['data'] ?? '');
  if (!VISION_SUPPORTED.has(contentType) || !data) {
    unsupportedToast(contentType || 'unknown');
    return;
  }

  const tooltip = new ThinkingTooltip();
  tooltip.show(tooltipAnchorFor(view, imagePos));

  void (async () => {
    try {
      const reply = await callAnthropic({
        apiKey,
        system: TABLE_SYSTEM_PROMPT,
        // Give the model enough room for a sizable table — every row
        // is JSON overhead. Tables in the typical debate doc are
        // modest but we don't want to clip outputs.
        maxTokens: 4096,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: contentType, data } },
              { type: 'text', text: 'Extract the table from this image.' },
            ],
          },
        ],
      });
      const parsed = extractJsonObject(reply.text);
      const spec = validateTableSpec(parsed);
      if (!spec) {
        showToast('AI response wasn\'t a valid table description.');
        return;
      }
      const tableNode = buildTableNode(spec);
      const target = findImageContainerInsertion(view, imagePos);
      if (!target) {
        showToast('Could not locate insertion point.');
        return;
      }
      const tr = view.state.tr.insert(target.insertPos, tableNode);
      view.dispatch(tr.scrollIntoView());
    } catch (err) {
      if (err instanceof AnthropicError) {
        showToast(`Table: ${err.message}`);
      } else {
        showToast(`Table: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      tooltip.hide();
    }
  })();
}
