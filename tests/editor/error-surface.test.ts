// @vitest-environment jsdom
/**
 * Global error surfacing (error-surface.ts) — the backstop added after the
 * 2026-07-12 field bug where Save/Save As/autosave all failed with literally
 * nothing on screen. Uncaught errors and unhandled rejections must produce a
 * toast (throttled) and never themselves throw; isFileGoneError must classify
 * exactly the renamed/moved/deleted-location failures that Save As can fix.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { installGlobalErrorSurface, isFileGoneError } from '../../src/editor/error-surface.js';

describe('isFileGoneError', () => {
  it('classifies Electron ENOENT (raw and IPC-wrapped) as file-gone', () => {
    expect(isFileGoneError(new Error("ENOENT: no such file or directory, open 'C:\\x.cmir'"))).toBe(
      true,
    );
    // The renderer sees main-process errors wrapped by Electron's IPC layer.
    expect(
      isFileGoneError(
        new Error(
          "Error invoking remote method 'host:save-existing': Error: ENOENT: no such file or directory",
        ),
      ),
    ).toBe(true);
  });

  it('classifies the web FS Access NotFoundError as file-gone', () => {
    const err = new DOMException('file gone', 'NotFoundError');
    expect(isFileGoneError(err)).toBe(true);
  });

  it('rejects errors Save As cannot fix, and non-Errors', () => {
    expect(isFileGoneError(new Error('EACCES: permission denied'))).toBe(false);
    expect(isFileGoneError(new DOMException('denied', 'NotAllowedError'))).toBe(false);
    expect(isFileGoneError('ENOENT-ish string')).toBe(false);
    expect(isFileGoneError(null)).toBe(false);
  });
});

describe('installGlobalErrorSurface', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  // Install ONCE for the whole file — installing per test would stack
  // duplicate listeners and double-count every dispatched event.
  beforeAll(() => {
    installGlobalErrorSurface();
  });
  // Strictly increasing base time per test: the throttle's module-level
  // timestamp persists across tests, and fresh fake timers would otherwise
  // restart the clock BEHIND it, throttling every later test's first toast.
  let base = 1_000_000_000;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    base += 100_000;
    vi.setSystemTime(base);
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
    vi.useRealTimers();
    document.querySelectorAll('.pmd-toast').forEach((t) => t.remove());
  });

  const toasts = (): string[] =>
    [...document.querySelectorAll('.pmd-toast')].map((t) => t.textContent ?? '');

  it('an uncaught error produces a console record and a toast with the message', () => {
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('boom in handler') }));
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(toasts().some((t) => t.includes('boom in handler'))).toBe(true);
  });

  it('throttles toasts (console still gets every event), then re-arms', () => {
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('first') }));
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('second') }));
    expect(toasts().length).toBe(1);
    expect(consoleSpy).toHaveBeenCalledTimes(2);
    // Past the throttle window a new failure surfaces again.
    vi.advanceTimersByTime(11_000);
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('third') }));
    expect(toasts().some((t) => t.includes('third'))).toBe(true);
  });

  it('an unhandled rejection event is surfaced without throwing', () => {
    // jsdom has no PromiseRejectionEvent constructor; the handler must cope
    // with whatever event object arrives (reads .reason, possibly undefined).
    expect(() => window.dispatchEvent(new Event('unhandledrejection'))).not.toThrow();
    expect(consoleSpy).toHaveBeenCalledTimes(1);
  });
});
