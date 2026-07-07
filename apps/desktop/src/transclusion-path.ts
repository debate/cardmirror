/**
 * Path safety for transclusion refresh (desktop).
 *
 * Given the transcluding document's own absolute path and a RELATIVE source
 * ref, resolve the ref against the doc's directory and HARD-SCOPE the result to
 * the configured library roots (or the doc's own folder), rejecting any `..`
 * escape. The ref can travel inside a document authored by someone else, so
 * this is a real security boundary — see TRANSCLUSION_PLAN.md §3.2.
 *
 * Pure (only `node:path`), so it's unit-tested in
 * tests/desktop/transclusion-path.test.ts and reused by the `host:read-cmir-file`
 * handler in main.ts.
 */
import * as path from 'node:path';

/** True if `target` is `base` itself or sits inside it (no `..` escape). */
export function isWithin(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
  );
}

export type SourceRefBase = 'doc' | 'root';

/**
 * Resolve a `.cmir` ref to the ordered list of safe absolute candidate paths.
 *
 * - base 'doc': resolve against the doc's directory; allow it inside any library
 *   root or the doc's own folder (one candidate).
 * - base 'root': resolve against EACH configured library root and keep the ones
 *   that stay inside their own root — the ref is root-relative, so it lands on
 *   the shared folder regardless of its absolute prefix on this machine. Order
 *   follows the roots list; the caller reads the first that exists.
 *
 * A candidate must be a `.cmir` and pass containment; anything else is dropped,
 * so a hostile ref can't escape the safe roots (TRANSCLUSION_PLAN.md §3.2).
 */
export function resolveCmirCandidates(
  docPath: string,
  sourceRef: string,
  base: SourceRefBase,
  roots: readonly string[],
  sourceAbs?: string,
): string[] {
  if (!docPath || !sourceRef) return [];
  const cleanRoots = roots.filter((r) => typeof r === 'string' && r !== '');
  const out: string[] = [];
  const consider = (abs: string, allowed: string[]): void => {
    // Live zones can transclude from a `.cmir` OR a `.docx` source (both are
    // pickable in the file search); the renderer parses each format on read.
    const ext = path.extname(abs).toLowerCase();
    if (ext !== '.cmir' && ext !== '.docx') return;
    if (allowed.some((b) => isWithin(b, abs))) out.push(abs);
  };
  // Tier 0: the exact absolute path the ref was created against, if it still
  // stays inside an allowed root or the doc's own folder. Tried first (the
  // caller checks existence), so a local copy vs. the shared original — and a
  // same-machine refresh — resolve to the definitively-intended file. Silently
  // absent on another teammate's machine, where resolution falls back below.
  if (sourceAbs && path.isAbsolute(sourceAbs)) {
    consider(sourceAbs, [...cleanRoots, path.dirname(docPath)]);
  }
  if (base === 'root') {
    // Tie-break when the same relative path exists under more than one root:
    // prefer the root that also contains the transcluding doc (teammates share
    // that library/Dropbox folder), most-specific first, so a mirrored second
    // root can't shadow the intended file. Remaining roots keep their list order.
    const containsDoc = (r: string): boolean => isWithin(r, docPath);
    const ordered = [
      ...cleanRoots.filter(containsDoc).sort((a, b) => b.length - a.length),
      ...cleanRoots.filter((r) => !containsDoc(r)),
    ];
    for (const root of ordered) {
      let abs: string;
      try {
        abs = path.resolve(root, sourceRef);
      } catch {
        continue;
      }
      consider(abs, [root]);
    }
  } else {
    let abs: string;
    try {
      abs = path.resolve(path.dirname(docPath), sourceRef);
    } catch {
      return out;
    }
    consider(abs, [...cleanRoots, path.dirname(docPath)]);
  }
  return [...new Set(out)];
}

/** Single doc-relative resolution — first (only) candidate for base 'doc'. */
export function resolveCmirRef(
  docPath: string,
  sourceRef: string,
  roots: readonly string[],
): string | null {
  return resolveCmirCandidates(docPath, sourceRef, 'doc', roots)[0] ?? null;
}
