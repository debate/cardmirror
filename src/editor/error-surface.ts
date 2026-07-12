/**
 * Global last-resort error surfacing.
 *
 * The renderer had NO unhandledrejection/error hooks, and fire-and-forget
 * entry points (`void runSaveFlow()` and friends) swallow rejections — so an
 * exception thrown before a flow's own try/catch produced literally nothing
 * on screen. Field bug 2026-07-12: a user's Save, Save As, and autosave all
 * silently did nothing; a screen recording of "click → nothing" was the only
 * evidence the app gave her. These hooks make that class of failure visible:
 * full details to the console (for DevTools screenshots), plus a throttled
 * toast so the user knows something actually went wrong.
 */

import { showToast } from './toast.js';

/** Min gap between error toasts — a rejection storm (e.g., a broken timer
 *  loop) should not bury the UI in toasts; the console gets every event. */
const TOAST_GAP_MS = 10_000;
let lastToastAt = 0;

function surface(kind: string, err: unknown): void {
  console.error(`[cardmirror ${kind}]`, err);
  const now = Date.now();
  if (now - lastToastAt < TOAST_GAP_MS) return;
  lastToastAt = now;
  const msg = (err instanceof Error ? err.message : String(err)).slice(0, 160);
  showToast(`Something went wrong: ${msg} — details in the developer console.`);
}

/** Whether a save failure means the file's on-disk location is GONE —
 *  Electron surfaces a renamed/moved/deleted parent folder as ENOENT
 *  (via the IPC error message); the web FS Access API throws a
 *  NotFoundError DOMException for a handle whose file was removed.
 *  Distinct from "couldn't write" errors (permissions, disk full),
 *  which Save As can't fix any better than Save.
 *
 *  Shape-checked rather than `instanceof Error`: DOMException doesn't
 *  inherit from Error in every runtime (it doesn't in jsdom), and the
 *  NotFoundError case is precisely a DOMException. */
export function isFileGoneError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { name, message } = err as { name?: unknown; message?: unknown };
  return (typeof message === 'string' && message.includes('ENOENT')) || name === 'NotFoundError';
}

export function installGlobalErrorSurface(): void {
  window.addEventListener('unhandledrejection', (e) => {
    surface('unhandled rejection', (e as PromiseRejectionEvent).reason);
  });
  window.addEventListener('error', (e) => {
    // Runtime script errors only — resource load errors don't bubble here.
    surface('uncaught error', (e as ErrorEvent).error ?? (e as ErrorEvent).message);
  });
}
