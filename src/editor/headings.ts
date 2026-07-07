/**
 * Shared outline / heading utilities.
 *
 * Used by the navigation panel for rendering the outline tree, and by
 * the drag-and-drop subsystem (nav surface and editor surface) for
 * computing source ranges and drop slots.
 */

import type { Node as PMNode } from 'prosemirror-model';

export interface HeadingEntry {
  /** Schema node type name. */
  type: string;
  /** Heading text content (can be empty). */
  text: string;
  /** Document position of the heading-anchored node — for tag and
   *  in-card analytic this is the head's pos, not the wrapping
   *  card's pos. Use computeHeadingRange to get the wrapping range. */
  pos: number;
  /** Outline level (1 = Pocket, 2 = Hat, 3 = Block, 4 = Tag/Analytic). */
  level: number;
  /** Stable schema id (for keying / drag tracking / scroll target). */
  id: string | null;
  /** Cite-formatted text from the same card (only for tag entries). */
  cite: string | null;
}

export const TYPE_TO_LEVEL: Record<string, number> = {
  pocket: 1,
  hat: 2,
  block: 3,
  tag: 4,
  analytic: 4,
};

export const TYPE_LABEL: Record<string, string> = {
  pocket: 'Pocket',
  hat: 'Hat',
  block: 'Block',
  tag: 'Tag',
  analytic: 'Analytic',
};

/**
 * Walk the doc and produce a flat list of heading entries in document
 * order. Heading-anchored nodes (pocket/hat/block/tag/analytic) get
 * an entry; other content does not.
 *
 * `opts.skipCite` skips the per-tag `collectCiteText` walk, which is
 * the bulk of this function's cost on long docs (it descends every
 * card to find cite-marked text runs). The nav-pane shows cite text
 * next to each tag entry and so needs it; the drop-indicator path
 * doesn't read `entry.cite` at all, so it passes `skipCite: true` to
 * cut drag-start latency.
 */
export function collectHeadings(
  doc: PMNode,
  opts: { skipCite?: boolean } = {},
): HeadingEntry[] {
  const skipCite = opts.skipCite === true;
  const out: HeadingEntry[] = [];
  doc.descendants((node, pos) => {
    const type = node.type.name;
    if (type in TYPE_TO_LEVEL) {
      const level = TYPE_TO_LEVEL[type]!;
      let cite: string | null = null;
      if (!skipCite && type === 'tag') {
        const $pos = doc.resolve(pos);
        const card = $pos.parent;
        if (card.type.name === 'card') {
          cite = collectCiteText(card);
        }
      }
      out.push({
        type,
        text: node.textContent,
        pos,
        level,
        id: typeof node.attrs['id'] === 'string' && node.attrs['id'] ? node.attrs['id'] : null,
        cite: cite && cite.trim() !== '' ? cite.trim() : null,
      });
    }
    return true;
  });
  return out;
}

/**
 * Compute the doc range that should move as a unit when dragging this
 * entry — and the kind of selection that targets that range.
 *
 *  - Tag (always inside a card)        → the parent card.
 *  - Analytic inside an analytic_unit  → the unit.
 *  - Analytic inside a card            → the card (cite-position alt).
 *  - Pocket / Hat / Block              → from the heading to just
 *                                        before the next equal-or-
 *                                        shallower heading (or end of
 *                                        doc).
 *
 * Returns null if anything resolves unexpectedly.
 */
export function computeHeadingRange(
  doc: PMNode,
  entry: HeadingEntry,
): { from: number; to: number; useNodeSelection: boolean } | null {
  const $pos = doc.resolve(entry.pos);
  const node = doc.nodeAt(entry.pos);
  if (!node) return null;

  const parentName = $pos.parent.type.name;
  if (entry.type === 'tag') {
    const from = $pos.before();
    const card = doc.nodeAt(from);
    if (!card) return null;
    return { from, to: from + card.nodeSize, useNodeSelection: true };
  }
  if (entry.type === 'analytic' && (parentName === 'analytic_unit' || parentName === 'card')) {
    const from = $pos.before();
    const wrapper = doc.nodeAt(from);
    if (!wrapper) return null;
    return { from, to: from + wrapper.nodeSize, useNodeSelection: true };
  }
  // Pocket / Hat / Block: span heading → next equal-or-shallower.
  const from = entry.pos;
  let to = doc.content.size;
  const targetLevel = entry.level;
  doc.nodesBetween(entry.pos + node.nodeSize, doc.content.size, (n, pos) => {
    if (to !== doc.content.size) return false;
    const t = n.type.name;
    // A live zone is an opaque unit: don't descend into it, or its transcluded
    // child headings (a pocket/hat zone holds hat/block headings) would be
    // mistaken for this section's boundary and truncate it mid-zone.
    if (t === 'transclusion_ref') return false;
    if (t in TYPE_TO_LEVEL && TYPE_TO_LEVEL[t]! <= targetLevel) {
      to = pos;
      return false;
    }
    return true;
  });
  return { from, to, useNodeSelection: false };
}

/**
 * Cheap variant of `computeHeadingRange` that only returns the
 * insertion position (`range.from`). Drop-indicator rendering — both
 * the nav-pane and the editor surface — places indicators at each
 * heading's start position and never needs the heading's full end.
 * The full `computeHeadingRange` does a `nodesBetween(...)` forward
 * walk to find the next equal-or-shallower heading, which is O(doc)
 * per pocket / hat / block — running it for every entry in a long
 * doc adds up to a noticeable beat at drag start.
 */
export function headingInsertPos(doc: PMNode, entry: HeadingEntry): number | null {
  if (entry.type === 'tag' || entry.type === 'analytic') {
    // Inside a card (or analytic_unit) — drop slot is the wrapping
    // node's position, one step up from the heading.
    const $pos = doc.resolve(entry.pos);
    return $pos.before();
  }
  // Pocket / Hat / Block: the heading IS the boundary.
  return entry.pos;
}

/**
 * Concatenate the text of all runs carrying cite_mark. Whitespace-only
 * unmarked runs sitting between two cite-marked runs are kept too, so
 * "Stein 23" (where the user cited "Stein" and "23" but not the space
 * between them) renders as "Stein 23" in the preview, not "Stein23".
 * Non-whitespace unmarked text breaks the bridge.
 *
 * Exported so other surfaces (e.g., the "Create Reference" command)
 * can produce the exact same cite string the nav pane shows.
 */
export function collectCiteText(node: PMNode): string {
  type Run = { text: string; isCite: boolean };
  const runs: Run[] = [];
  node.descendants((descendant) => {
    if (!descendant.isText) return;
    runs.push({
      text: descendant.text ?? '',
      isCite: descendant.marks.some((m) => m.type.name === 'cite_mark'),
    });
  });

  const out: string[] = [];
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i]!;
    if (r.isCite) {
      out.push(r.text);
      continue;
    }
    if (out.length === 0) continue;
    if (!/^\s+$/.test(r.text)) continue;
    // Bridge only if a cite run comes later — avoids trailing whitespace.
    let hasLaterCite = false;
    for (let j = i + 1; j < runs.length; j++) {
      if (runs[j]!.isCite) { hasLaterCite = true; break; }
    }
    if (hasLaterCite) out.push(r.text);
  }
  return fixAmpersandSpacing(out.join(''));
}

function fixAmpersandSpacing(s: string): string {
  return s.replace(/(^|\s)&(\S)/g, '$1& $2');
}
