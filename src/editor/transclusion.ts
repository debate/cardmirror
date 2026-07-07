/**
 * Transclusion "live zones" — core logic (see TRANSCLUSION_PLAN.md).
 *
 * A live zone (`transclusion_ref` node) renders the contents under a heading
 * in another CardMirror file. This module is the PURE, view-independent core:
 * extracting a section from a source doc, hashing it, building the node,
 * detaching it back to plain content, computing the doc-relative source path,
 * and the cycle-identity helpers. The NodeView (transclusion-nodeview.ts) and
 * the commands/IPC glue (transclusion-commands.ts) build on this.
 *
 * Nothing here touches the DOM or Electron, so it is fully unit-testable.
 */
import { Fragment, Slice } from 'prosemirror-model';
import type { Node as PMNode, Schema } from 'prosemirror-model';
import { NodeSelection } from 'prosemirror-state';
import type { Selection } from 'prosemirror-state';
import {
  collectHeadings,
  computeHeadingRange,
  TYPE_LABEL,
} from './headings.js';

export const TRANSCLUSION_NODE = 'transclusion_ref';

/** Hard cap on how deep nested live zones render before we stop and show a
 *  placeholder. Snapshots are finite so this is a perf/pathology backstop,
 *  not a correctness guard — see TRANSCLUSION_PLAN.md §7. */
export const MAX_NEST_DEPTH = 8;

export type SourceRefBase = 'doc' | 'root';

export interface TransclusionAttrs {
  source_ref: string;
  source_ref_base: SourceRefBase;
  source_heading_id: string;
  /** Absolute path the ref was created against — a machine-local resolve
   *  tie-breaker (see the node spec). '' when unknown. */
  source_abs: string;
  /** Hash of the children as last pulled from source (edit detection). */
  source_content_hash: string;
  last_refreshed: number;
  source_label: string;
}

export interface ExtractResult {
  /** The transcluded content as a Fragment, with the source's original heading
   *  ids (the caller rewrites them to fresh ids before inserting). Empty when
   *  the section has no content under the heading. */
  content: Fragment;
  /** The target heading's own text (for the breadcrumb). */
  headingLabel: string;
  /** Schema type of the target heading (pocket/hat/block/tag/analytic). */
  headingType: string;
}

export function isTransclusionNode(node: PMNode | null | undefined): boolean {
  return !!node && node.type.name === TRANSCLUSION_NODE;
}

/**
 * Extract the transcludable content under `headingId` from a source doc.
 *
 * - pocket / hat / block → the contents BELOW the header (the header line
 *   itself excluded), down to the next heading of equal-or-higher level.
 * - tag / analytic → the whole card / analytic_unit (tagline included).
 *
 * Returns null if the heading id isn't present in the doc.
 */
export function extractSection(doc: PMNode, headingId: string): ExtractResult | null {
  if (!headingId) return null;
  const entry = collectHeadings(doc, { skipCite: true }).find((h) => h.id === headingId);
  if (!entry) return null;
  const range = computeHeadingRange(doc, entry);
  if (!range) return null;

  let from = range.from;
  if (entry.type !== 'tag' && entry.type !== 'analytic') {
    // pocket/hat/block: drop the header line, keep everything under it.
    const node = doc.nodeAt(entry.pos);
    if (!node) return null;
    from = entry.pos + node.nodeSize;
  }
  const to = range.to;
  if (to < from) return null;

  return {
    content: doc.slice(from, to).content,
    headingLabel: entry.text.trim() || TYPE_LABEL[entry.type] || entry.type,
    headingType: entry.type,
  };
}

/** Hash of a fragment's content — the value stored in `source_content_hash`
 *  and compared against for edit detection. Empty → the 'empty' sentinel. */
export function contentHash(content: Fragment): string {
  return hashFragmentJSON(content.size ? content.toJSON() : null);
}

/** Whether the zone's children differ from what refresh last pulled — i.e. the
 *  user has locally contextualised it (edited a tag, its highlighting, …). */
export function isZoneEdited(node: PMNode): boolean {
  if (node.type.name !== TRANSCLUSION_NODE) return false;
  return contentHash(node.content) !== String(node.attrs['source_content_hash'] ?? '');
}

/**
 * Prepare an extracted section to become a zone's children: rewrite heading ids
 * to fresh ones (so two zones of the same source, or the source itself opened
 * alongside, never collide ids), and hash the result for `source_content_hash`.
 */
export function prepareZoneContent(
  content: Fragment,
  freshId: () => string,
): { content: Fragment; hash: string } {
  const rewritten = rewriteHeadingIdsInFragment(content, freshId);
  return { content: rewritten, hash: contentHash(rewritten) };
}

/** Build a `transclusion_ref` node from attrs + child content. */
export function createTransclusionNode(
  schema: Schema,
  attrs: Partial<TransclusionAttrs>,
  content?: Fragment,
): PMNode {
  const type = schema.nodes[TRANSCLUSION_NODE];
  if (!type) throw new Error('transclusion_ref not registered in schema');
  return type.create(
    {
      source_ref: attrs.source_ref ?? '',
      source_ref_base: attrs.source_ref_base ?? 'doc',
      source_heading_id: attrs.source_heading_id ?? '',
      source_abs: attrs.source_abs ?? '',
      source_content_hash: attrs.source_content_hash ?? '',
      last_refreshed: attrs.last_refreshed ?? 0,
      source_label: attrs.source_label ?? '',
    },
    content,
  );
}

/** The stable identity of a zone's target — `source_ref` + heading id.
 *  Used to detect cycles across nested-zone rendering. */
export const ZONE_ID_SEP = '\u0000';
export function zoneIdentity(node: PMNode): string {
  // NUL separator: it can never appear in a path or a UUID, unlike a space
  // (real Dropbox paths contain spaces, e.g. "Debate Files").
  return `${String(node.attrs['source_ref'] ?? '')}${ZONE_ID_SEP}${String(node.attrs['source_heading_id'] ?? '')}`;
}

/**
 * The content a Detach should leave behind: the zone's cached fragment as a
 * Slice, ready to replace the node. The children already carry unique
 * (rewritten) ids from insert/refresh, so no further rewrite is needed.
 * Returns an empty Slice for an empty zone (which then just vanishes).
 */
export function detachSlice(node: PMNode): Slice {
  if (node.content.size === 0) return Slice.empty;
  return new Slice(node.content, 0, 0);
}

/** Rewrite every heading id in a fragment to a fresh UUID (deep). Mirrors the
 *  drag-copy id-rewrite so a materialized/detached section can't collide ids
 *  with its source. */
export function rewriteHeadingIdsInFragment(
  frag: Fragment,
  freshId: () => string,
): Fragment {
  const mapped: PMNode[] = [];
  frag.forEach((child) => mapped.push(rewriteHeadingIdsInNode(child, freshId)));
  return Fragment.fromArray(mapped);
}

function rewriteHeadingIdsInNode(node: PMNode, freshId: () => string): PMNode {
  const hasId = typeof node.attrs['id'] === 'string' && node.attrs['id'];
  const newContent = node.content.size
    ? rewriteHeadingIdsInFragment(node.content, freshId)
    : node.content;
  if (hasId) {
    return node.type.create({ ...node.attrs, id: freshId() }, newContent, node.marks);
  }
  if (newContent !== node.content) {
    return node.type.create(node.attrs, newContent, node.marks);
  }
  return node;
}

/** All zone identities that appear as DIRECT children of a fragment. Zones
 *  only ever appear at the top level of a section (the schema forbids them
 *  inside cards), so a shallow scan is complete. Used for the picker's
 *  direct-cycle check. */
export function directZoneIdentities(frag: Fragment): Set<string> {
  const out = new Set<string>();
  frag.forEach((child) => {
    if (child.type.name === TRANSCLUSION_NODE) out.add(zoneIdentity(child));
  });
  return out;
}

/** Every zone identity anywhere inside a fragment, at ANY depth (a zone's
 *  cached children can themselves contain zones). Used to reject TRANSITIVE /
 *  edit-introduced cycles at create/refresh time — a section that transitively
 *  transcludes the very zone being built would otherwise keep re-nesting its
 *  own snapshot deeper on every refresh, with no backstop (MAX_NEST_DEPTH was
 *  never enforced). See TRANSCLUSION_PLAN.md §7. */
export function deepZoneIdentities(frag: Fragment): Set<string> {
  const out = new Set<string>();
  const walk = (node: PMNode): void => {
    if (node.type.name === TRANSCLUSION_NODE) out.add(zoneIdentity(node));
    node.content.forEach(walk);
  };
  frag.forEach(walk);
  return out;
}

/** Cheap presence check — is there any zone anywhere in this fragment? Lets the
 *  clipboard hooks skip the rebuild for the common no-zone copy/paste. */
export function fragmentHasZone(frag: Fragment): boolean {
  let found = false;
  const walk = (n: PMNode): void => {
    if (found) return;
    if (n.type.name === TRANSCLUSION_NODE) {
      found = true;
      return;
    }
    n.content.forEach(walk);
  };
  frag.forEach(walk);
  return found;
}

/** Rebuild a fragment, applying `fn` to every zone node at any depth (children
 *  are mapped first, so a fn that rewrites attrs sees already-mapped content). */
function mapZones(frag: Fragment, fn: (node: PMNode) => PMNode): Fragment {
  const out: PMNode[] = [];
  frag.forEach((child) => {
    const mappedContent = child.content.size ? mapZones(child.content, fn) : child.content;
    let node = mappedContent === child.content ? child : child.type.create(child.attrs, mappedContent, child.marks);
    if (node.type.name === TRANSCLUSION_NODE) node = fn(node);
    out.push(node);
  });
  return Fragment.fromArray(out);
}

/** Clipboard COPY: stamp every zone with the document it was copied from, so a
 *  later paste can distinguish a same-doc paste from a cross-doc one. Transient
 *  — paste clears it again. */
export function stampZoneOrigins(frag: Fragment, originDocPath: string): Fragment {
  return mapZones(frag, (node) =>
    node.type.create({ ...node.attrs, source_origin: originDocPath }, node.content, node.marks),
  );
}

/**
 * Clipboard PASTE. A zone whose stamped origin is THIS document keeps its live
 * link (its doc-relative `source_ref` is still valid). A zone from ANOTHER
 * document can't trust that ref here, so it's UNWRAPPED to its cached cards as
 * ordinary content — i.e. a cross-doc paste behaves like a normal card paste,
 * with no lingering link. The transient origin stamp is always cleared.
 */
export function resolvePastedZones(frag: Fragment, destDocPath: string | null): Fragment {
  const out: PMNode[] = [];
  frag.forEach((child) => {
    // Recurse first, so nested zones are resolved before their parent.
    const mapped = child.content.size ? resolvePastedZones(child.content, destDocPath) : child.content;
    const node = mapped === child.content ? child : child.type.create(child.attrs, mapped, child.marks);
    if (node.type.name !== TRANSCLUSION_NODE) {
      out.push(node);
      return;
    }
    const origin = String(node.attrs['source_origin'] ?? '');
    const sameDoc = origin !== '' && destDocPath != null && origin === destDocPath;
    if (sameDoc) {
      out.push(node.type.create({ ...node.attrs, source_origin: '' }, node.content, node.marks));
    } else {
      // Cross-doc (or unknown origin) → drop the link, splice the cached cards in.
      node.content.forEach((c) => out.push(c));
    }
  });
  return Fragment.fromArray(out);
}

/** If the current selection is a NodeSelection over a live zone, return it. */
export function selectedTransclusion(
  selection: Selection,
): { node: PMNode; pos: number } | null {
  if (selection instanceof NodeSelection && isTransclusionNode(selection.node)) {
    return { node: selection.node, pos: selection.from };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hashing — a stable, cross-machine content hash of the cached fragment.
// ---------------------------------------------------------------------------

/** Deterministic hash of a `cached_content` value. Two machines that extract
 *  byte-identical source sections produce the same hash, so staleness is a
 *  cheap compare. `null`/empty hashes to a fixed sentinel. */
export function hashFragmentJSON(json: unknown): string {
  if (json == null) return 'empty';
  return cyrb53(stableStringify(json)).toString(36);
}

/** JSON.stringify with object keys sorted recursively, so attr-key insertion
 *  order can't perturb the hash across machines. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** cyrb53 — a fast, well-distributed 53-bit string hash (public domain). */
function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// ---------------------------------------------------------------------------
// Doc-relative path — store source refs relative to the transcluding doc so
// they survive different absolute roots across machines (TRANSCLUSION_PLAN §3).
// ---------------------------------------------------------------------------

/** Split a file path into segments, tolerating both `/` and `\` separators
 *  and a leading drive letter, so it works for Dropbox paths on any OS. */
function splitPath(p: string): { drive: string; segs: string[]; absolute: boolean } {
  let s = p.replace(/\\/g, '/');
  let drive = '';
  const driveMatch = s.match(/^([a-zA-Z]:)\//);
  if (driveMatch) {
    drive = driveMatch[1]!.toUpperCase();
    s = s.slice(driveMatch[1]!.length);
  }
  const absolute = s.startsWith('/') || drive !== '';
  const segs = s.split('/').filter((seg) => seg !== '' && seg !== '.');
  return { drive, segs, absolute };
}

/**
 * Compute the path to `toFile` relative to the DIRECTORY of `fromFile`, using
 * forward slashes. Returns null if the two live on different drives (no
 * relative path exists) — the caller then can't make a portable ref.
 *
 *   relativeSourceRef('/a/b/Doc.cmir', '/a/c/Src.cmir') === '../c/Src.cmir'
 */
export function relativeSourceRef(fromFile: string, toFile: string): string | null {
  const from = splitPath(fromFile);
  const to = splitPath(toFile);
  if (from.drive !== to.drive) return null;
  // Directory of fromFile = its segments minus the filename.
  const fromDir = from.segs.slice(0, -1);
  const toSegs = to.segs;
  let common = 0;
  while (
    common < fromDir.length &&
    common < toSegs.length &&
    fromDir[common] === toSegs[common]
  ) {
    common++;
  }
  const up = fromDir.length - common;
  const rel = [...Array(up).fill('..'), ...toSegs.slice(common)];
  return rel.length ? rel.join('/') : '.';
}

/** True if `target` is inside directory `base` (or is `base` itself). Pure
 *  string form of the desktop `isWithin`; used at insert time in the renderer. */
export function isWithinPure(base: string, target: string): boolean {
  const b = splitPath(base);
  const t = splitPath(target);
  if (b.drive !== t.drive) return false;
  if (t.segs.length < b.segs.length) return false;
  for (let i = 0; i < b.segs.length; i++) {
    if (b.segs[i] !== t.segs[i]) return false;
  }
  return true;
}

/** Path of `target` relative to directory `base` (forward slashes), or null if
 *  `target` isn't inside `base`. */
export function rootRelative(base: string, target: string): string | null {
  if (!isWithinPure(base, target)) return null;
  const b = splitPath(base);
  const t = splitPath(target);
  const rel = t.segs.slice(b.segs.length);
  return rel.length ? rel.join('/') : '.';
}

/**
 * Choose how to store a source ref (user's shared-Dropbox insight): prefer
 * **root-relative** when the transcluding doc AND the source both live under the
 * same configured library root — that ref survives the doc being moved around
 * inside the shared folder, and every teammate has the folder configured. Fall
 * back to **doc-relative** otherwise. Returns null if no portable ref exists
 * (e.g. different Windows drives with no shared root).
 */
export function chooseSourceRef(
  docPath: string,
  sourceAbs: string,
  roots: readonly string[],
): { ref: string; base: SourceRefBase } | null {
  for (const root of roots) {
    if (!root) continue;
    if (isWithinPure(root, docPath) && isWithinPure(root, sourceAbs)) {
      const ref = rootRelative(root, sourceAbs);
      if (ref && ref !== '.') return { ref, base: 'root' };
    }
  }
  const rel = relativeSourceRef(docPath, sourceAbs);
  return rel ? { ref: rel, base: 'doc' } : null;
}
