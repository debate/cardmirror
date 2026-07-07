/**
 * View-operating transclusion actions: refresh, detach, insert. Shared by the
 * NodeView header buttons and the ribbon commands. Refresh is async (it reads
 * the source file); detach and insert are synchronous transactions.
 */
import { NodeSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode, Schema, Fragment } from 'prosemirror-model';
import { newHeadingId } from '../schema/index.js';
import {
  isTransclusionNode,
  isZoneEdited,
  zoneIdentity,
  detachSlice,
  createTransclusionNode,
  extractSection,
  chooseSourceRef,
  prepareZoneContent,
  type TransclusionAttrs,
  type SourceRefBase,
} from './transclusion.js';
import { getViewDocPath } from './transclusion-doc-path.js';
import { resolveTransclusion, type ResolveOutcome } from './transclusion-resolve.js';

/** " › " with explicit code points (space, U+203A, space). */
const CRUMB_SEP = ' › ';

/** Confirm discarding a zone's local edits before a refresh overwrites them.
 *  Returns true only on an explicit OK. When there's no window to prompt in
 *  (headless / tests / any future batch caller), returns FALSE — we refuse
 *  rather than silently discard edits, since this guards real data loss. */
function confirmDiscardEdits(): boolean {
  if (typeof window === 'undefined') return false;
  return window.confirm(
    'Refresh will replace your local edits to this live zone with the current source. Continue?',
  );
}

/** Breadcrumb label: "SourceFile › Heading" (drops the `.cmir` extension). */
export function crumbLabel(sourceName: string, headingLabel: string): string {
  const base = sourceName.replace(/\.cmir$/i, '');
  return base ? `${base}${CRUMB_SEP}${headingLabel}` : headingLabel;
}

export type BuildZoneReason =
  | 'no-heading-id'
  | 'no-section'
  | 'no-doc-path'
  | 'no-portable-ref';

export interface BuildZoneOutcome {
  ok: boolean;
  reason?: BuildZoneReason;
  attrs?: TransclusionAttrs;
  /** The zone's child content (id-rewritten), ready to insert. */
  content?: Fragment;
  headingLabel?: string;
}

/**
 * Build a new live zone (attrs + child content) from an already-parsed source
 * doc + a target heading id. Shared by every creation entry point (the picker's
 * transclude mode and per-header Mod+Enter). Snapshots the section now, rewrites
 * its heading ids to fresh ones, computes a portable source ref, and rejects
 * direct self-embedding. Pure aside from the `last_refreshed` timestamp.
 */
export function buildLiveZoneAttrs(
  schema: Schema,
  sourceDoc: PMNode,
  headingId: string,
  sourceName: string,
  docPath: string | null,
  sourceAbsPath: string,
  roots: readonly string[],
): BuildZoneOutcome {
  if (!headingId) return { ok: false, reason: 'no-heading-id' };
  const section = extractSection(sourceDoc, headingId);
  if (!section) return { ok: false, reason: 'no-section' };
  if (!docPath) return { ok: false, reason: 'no-doc-path' };
  const chosen = chooseSourceRef(docPath, sourceAbsPath, roots);
  if (!chosen) return { ok: false, reason: 'no-portable-ref' };
  const { content, hash } = prepareZoneContent(section.content, newHeadingId);
  const attrs: TransclusionAttrs = {
    source_ref: chosen.ref,
    source_ref_base: chosen.base,
    source_heading_id: headingId,
    source_abs: sourceAbsPath,
    source_content_hash: hash,
    last_refreshed: Date.now(),
    source_label: crumbLabel(sourceName, section.headingLabel),
  };
  // No cycle guard needed: prepareZoneContent flattened any nested zones, so the
  // content is structurally zone-free and can't reference this (or any) zone.
  return { ok: true, attrs, content, headingLabel: section.headingLabel };
}

/** Toast message for a failed live-zone build. */
export function buildZoneErrorMessage(reason: BuildZoneReason | undefined): string {
  switch (reason) {
    case 'no-heading-id':
      return 'That heading has no stable id — open and save the source in CardMirror, then retry.';
    case 'no-section':
      return 'Could not read that section from the source.';
    case 'no-doc-path':
      return 'Save this document first, then insert a live zone.';
    case 'no-portable-ref':
      return 'Couldn’t make a portable link to that file.';
    default:
      return 'Could not insert the live zone.';
  }
}

/** Re-locate a zone after an async gap. If the preferred pos still holds the
 *  same-identity zone, use it. Otherwise the pos went stale (the doc mutated
 *  during the read): only relocate when EXACTLY ONE zone shares this identity.
 *  With duplicate-identity zones we cannot tell which one the user meant, so we
 *  return null and the caller REFUSES — refreshing the wrong zone would silently
 *  discard a different (possibly edited) zone's content. Also null when the zone
 *  vanished (zero matches). */
function findZonePos(doc: PMNode, identity: string, preferredPos: number): number | null {
  const at = doc.nodeAt(preferredPos);
  if (at && isTransclusionNode(at) && zoneIdentity(at) === identity) return preferredPos;
  const matches: number[] = [];
  doc.descendants((n, pos) => {
    if (isTransclusionNode(n) && zoneIdentity(n) === identity) matches.push(pos);
    return true;
  });
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * Refresh the zone at `pos`: read its source, extract the section, and replace
 * the cache. Returns the resolve outcome so the caller can surface failures
 * (the NodeView shows an "unreachable" chip; a command shows a toast). On
 * success the doc is updated in place; on failure nothing changes (the cache
 * keeps rendering). Best-effort — never throws.
 */
export async function refreshZoneAtPos(
  view: EditorView,
  pos: number,
): Promise<ResolveOutcome> {
  const node = view.state.doc.nodeAt(pos);
  if (!node || !isTransclusionNode(node)) return { ok: false, reason: 'heading-missing' };
  const identity = zoneIdentity(node);
  // Fast path: if the clicked zone is already edited, confirm up front so a
  // large source read isn't done only to be discarded on cancel.
  const preEdited = isZoneEdited(node);
  if (preEdited && !confirmDiscardEdits()) return { ok: false, reason: 'cancelled' };

  const docPath = getViewDocPath(view);
  const outcome = await resolveTransclusion(
    docPath,
    String(node.attrs['source_ref'] ?? ''),
    node.attrs['source_ref_base'] === 'root' ? 'root' : 'doc',
    String(node.attrs['source_heading_id'] ?? ''),
    String(node.attrs['source_abs'] ?? ''),
  );
  if (!outcome.ok || !outcome.result) return outcome;

  // Re-locate the target AFTER the await. findZonePos returns null when the pos
  // went stale AND duplicate-identity zones make the target ambiguous — refuse
  // rather than overwrite the wrong (possibly edited) zone.
  const targetPos = findZonePos(view.state.doc, identity, pos);
  if (targetPos === null) {
    return { ok: false, reason: 'ambiguous', sourceName: outcome.sourceName };
  }
  const live = view.state.doc.nodeAt(targetPos);
  if (!live || !isTransclusionNode(live)) {
    return { ok: false, reason: 'ambiguous', sourceName: outcome.sourceName };
  }
  // If we didn't already confirm and the zone became edited DURING the read (the
  // user typed into it in the async window), confirm now — otherwise those
  // just-made edits would be replaced with no prompt.
  if (!preEdited && isZoneEdited(live) && !confirmDiscardEdits()) {
    return { ok: false, reason: 'cancelled' };
  }

  // Replace the whole zone node with a fresh one: new children (nested zones
  // flattened, source ids rewritten), reset content hash + timestamp + label.
  const { content, hash } = prepareZoneContent(outcome.result.content, newHeadingId);
  const newNode = createTransclusionNode(
    view.state.schema,
    {
      source_ref: String(live.attrs['source_ref'] ?? ''),
      source_ref_base: (live.attrs['source_ref_base'] === 'root' ? 'root' : 'doc') as SourceRefBase,
      source_heading_id: String(live.attrs['source_heading_id'] ?? ''),
      source_abs: String(live.attrs['source_abs'] ?? ''),
      source_content_hash: hash,
      last_refreshed: Date.now(),
      source_label: crumbLabel(outcome.sourceName ?? '', outcome.result.headingLabel),
    },
    content,
  );
  const tr = view.state.tr.replaceWith(targetPos, targetPos + live.nodeSize, newNode);
  tr.setMeta('addToHistory', true);
  view.dispatch(tr);
  return outcome;
}

/**
 * Detach the zone at `pos`: replace it with its children as ordinary editable
 * content, breaking the link (edits are kept — the ids are already unique). An
 * empty zone just vanishes. Returns false if there's no zone there.
 */
export function detachZoneAtPos(view: EditorView, pos: number): boolean {
  const node = view.state.doc.nodeAt(pos);
  if (!node || !isTransclusionNode(node)) return false;
  const slice = detachSlice(node);
  const tr = view.state.tr.replaceRange(pos, pos + node.nodeSize, slice);
  view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Insert a new live zone (with its child content) after the top-level block
 * containing the selection, and select it. Returns false if the schema won't
 * allow it (shouldn't happen at the doc root).
 */
export function insertZoneAtSelection(
  view: EditorView,
  attrs: Partial<TransclusionAttrs>,
  content?: Fragment,
): boolean {
  const node = createTransclusionNode(view.state.schema, attrs, content);
  const { $from } = view.state.selection;
  const pos = $from.depth > 0 ? $from.after(1) : $from.pos;
  let tr;
  try {
    tr = view.state.tr.insert(pos, node);
  } catch {
    // Schema wouldn't allow a zone here — honor the documented contract.
    return false;
  }
  try {
    tr = tr.setSelection(NodeSelection.create(tr.doc, pos));
  } catch {
    // Selection placement is best-effort.
  }
  view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Replace the zone at `pos` with a freshly built one — used by "Re-pick source"
 * to re-target a zone (or relink an unlinked/frozen one) in place, preserving
 * its position. Returns false if there's no zone there.
 */
export function replaceZoneAtPos(
  view: EditorView,
  pos: number,
  identity: string,
  attrs: Partial<TransclusionAttrs>,
  content?: Fragment,
): boolean {
  // The picker is a long interaction, so `pos` may have gone stale (a collab
  // peer edit, etc.). Re-locate the ORIGINAL zone by identity — findZonePos
  // refuses (null) if it's ambiguous or gone, so we never re-target the wrong
  // zone. (identity is the zone's pre-re-pick source_ref + heading id.)
  const targetPos = findZonePos(view.state.doc, identity, pos);
  if (targetPos === null) return false;
  const node = view.state.doc.nodeAt(targetPos);
  if (!node || !isTransclusionNode(node)) return false;
  const newNode = createTransclusionNode(view.state.schema, attrs, content);
  const tr = view.state.tr.replaceWith(targetPos, targetPos + node.nodeSize, newNode);
  tr.setMeta('addToHistory', true);
  try {
    view.dispatch(tr.scrollIntoView());
  } catch {
    // The view was torn down (e.g. its pane closed while the picker was open).
    return false;
  }
  return true;
}

/** How to open the picker in "re-pick" mode. Registered by the app wiring
 *  (index.ts) because the picker needs deps the NodeView doesn't carry. */
let rePickOpener: ((view: EditorView, pos: number, identity: string) => void) | null = null;
export function setRePickOpener(fn: (view: EditorView, pos: number, identity: string) => void): void {
  rePickOpener = fn;
}
/** Open the re-pick picker for the zone at `pos`. No-op (false) when there's no
 *  zone there or nothing is registered (e.g. the web build). Captures the zone's
 *  identity now so the eventual replace can re-locate it safely. */
export function rePickZoneAtPos(view: EditorView, pos: number): boolean {
  const node = view.state.doc.nodeAt(pos);
  if (!node || !isTransclusionNode(node) || !rePickOpener) return false;
  rePickOpener(view, pos, zoneIdentity(node));
  return true;
}

/** How to open a zone's linked source file. Registered by the app wiring
 *  (index.ts) — it needs host + file-open plumbing the NodeView doesn't carry. */
let openSourceOpener: ((view: EditorView, pos: number) => void) | null = null;
export function setOpenSourceOpener(fn: (view: EditorView, pos: number) => void): void {
  openSourceOpener = fn;
}
/** Open the linked source file for the zone at `pos`. No-op (false) when nothing
 *  is registered (e.g. the web build). */
export function openZoneSourceAtPos(view: EditorView, pos: number): boolean {
  if (!openSourceOpener) return false;
  openSourceOpener(view, pos);
  return true;
}
