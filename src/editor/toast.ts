/**
 * Tiny ephemeral tooltip near the mouse pointer ("Copied!", "Saved!",
 * etc.). Tracks the cursor position via a passive global mousemove
 * listener so callers don't need to thread an event through.
 */

let lastMouseX = 0;
let lastMouseY = 0;
let tracked = false;

function ensureTracking(): void {
  if (tracked) return;
  tracked = true;
  window.addEventListener(
    'mousemove',
    (e) => {
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
    },
    { passive: true },
  );
}

export interface ToastOptions {
  /** Total time the toast stays visible (ms). Default 1000. */
  durationMs?: number;
  /** Fade-out animation length (ms). Default 200. */
  fadeMs?: number;
}

export function showToast(message: string, opts: ToastOptions = {}): void {
  // Guard for non-DOM environments (vitest's Node default). Callers
  // can invoke showToast from any Command without breaking unit tests.
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }
  ensureTracking();
  const durationMs = opts.durationMs ?? 1000;
  const fadeMs = opts.fadeMs ?? 200;

  const toast = document.createElement('div');
  toast.className = 'pmd-toast';
  toast.textContent = message;
  // Offset slightly down/right from the cursor so it doesn't sit
  // under the pointer.
  toast.style.left = `${lastMouseX + 10}px`;
  toast.style.top = `${lastMouseY + 14}px`;
  toast.style.transitionDuration = `${fadeMs}ms`;
  document.body.appendChild(toast);

  // Trigger fade after duration - fade time so the toast finishes
  // dismissing right around the duration mark.
  const visibleMs = Math.max(0, durationMs - fadeMs);
  setTimeout(() => {
    toast.classList.add('pmd-toast-fade');
    setTimeout(() => toast.remove(), fadeMs);
  }, visibleMs);
}
