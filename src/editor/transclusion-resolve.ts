/**
 * Transclusion refresh resolver (renderer, desktop-only).
 *
 * Reads a source `.cmir` by its doc-relative ref (via the Electron host, which
 * enforces the path-safety boundary), parses it, and extracts the section under
 * the target heading id. Everything here is best-effort: any failure returns a
 * reason and the caller keeps rendering from cache (TRANSCLUSION_PLAN.md §3.1).
 * On web there is no filesystem, so this always reports `not-desktop`.
 */
import { getElectronHost } from './host/index.js';
import { parseNative } from '../index.js';
import { settings } from './settings.js';
import {
  extractSection,
  type ExtractResult,
  type SourceRefBase,
} from './transclusion.js';

export type ResolveReason =
  | 'not-desktop'
  | 'no-doc-path'
  | 'no-source-ref'
  | 'source-unreadable'
  | 'parse-failed'
  | 'heading-missing'
  | 'cancelled'
  /** The zone couldn't be uniquely re-located after the async read (it moved and
   *  there are duplicate-identity zones) — refuse rather than risk the wrong one. */
  | 'ambiguous'
  /** Refreshing would transitively transclude this very zone — a cycle. */
  | 'cycle';

export interface ResolveOutcome {
  ok: boolean;
  reason?: ResolveReason;
  result?: ExtractResult;
  /** Basename of the resolved source file, when we got that far. */
  sourceName?: string;
}

/** Whether creating/refreshing live zones is possible in this build (desktop
 *  only — the cache still renders everywhere). */
export function transclusionSupported(): boolean {
  return getElectronHost() !== null;
}

/** User-facing message for a failed refresh (all reasons keep the cache). */
export function refreshFailMessage(reason: ResolveReason | undefined): string {
  switch (reason) {
    case 'not-desktop':
      return 'Live zones refresh on the desktop app.';
    case 'no-doc-path':
      return 'Save this document first, then refresh the live zone.';
    case 'source-unreadable':
      return 'Source file not found — showing the last cached content.';
    case 'parse-failed':
      return 'Source file could not be read — showing cached content.';
    case 'heading-missing':
      return 'That heading is gone from the source — showing cached content.';
    case 'ambiguous':
      return 'The document changed while refreshing — try again.';
    case 'cycle':
      return 'That section now transcludes this zone — keeping cached content.';
    case 'cancelled':
      return '';
    default:
      return 'Could not refresh the live zone — showing cached content.';
  }
}

export async function resolveTransclusion(
  docPath: string | null,
  sourceRef: string,
  base: SourceRefBase,
  headingId: string,
  sourceAbs = '',
): Promise<ResolveOutcome> {
  const electron = getElectronHost();
  if (!electron) return { ok: false, reason: 'not-desktop' };
  if (!docPath) return { ok: false, reason: 'no-doc-path' };
  if (!sourceRef) return { ok: false, reason: 'no-source-ref' };

  const roots = (settings.get('fileSearchRoots') as string[] | undefined) ?? [];
  let file: { bytes: Uint8Array; name: string } | null;
  try {
    file = await electron.readCmirFile(docPath, sourceRef, base, roots, sourceAbs);
  } catch {
    file = null;
  }
  if (!file) return { ok: false, reason: 'source-unreadable' };

  let doc;
  try {
    doc = parseNative(file.bytes).doc;
  } catch {
    return { ok: false, reason: 'parse-failed', sourceName: file.name };
  }

  const result = extractSection(doc, headingId);
  if (!result) return { ok: false, reason: 'heading-missing', sourceName: file.name };
  return { ok: true, result, sourceName: file.name };
}
