/**
 * Tournament pause for automatic update checks (2026-07-16, mirrors
 * ebb's tournament mode): `updateChecksPausedUntil` is an epoch-ms
 * timestamp; 0 = not paused. The renderer's auto-check sites gate on
 * `settings.get('updateChecksPausedUntil') <= Date.now()`; a stale
 * (past) timestamp therefore self-heals as "not paused" without any
 * cleanup pass. Sanitize boundary via SettingsStore.replaceAll — the
 * same path as load.
 */
import { describe, expect, it } from 'vitest';
import { SettingsStore } from '../../src/editor/settings.js';

function pausedUntilAfterImport(v: unknown): number {
  const s = new SettingsStore();
  s.replaceAll({ updateChecksPausedUntil: v });
  return s.get('updateChecksPausedUntil');
}

describe('updateChecksPausedUntil sanitize', () => {
  it('defaults to 0 (not paused)', () => {
    expect(new SettingsStore().get('updateChecksPausedUntil')).toBe(0);
  });

  it('keeps valid future timestamps (floored to integer ms)', () => {
    expect(pausedUntilAfterImport(1789000000123.7)).toBe(1789000000123);
  });

  it('coerces garbage to 0', () => {
    expect(pausedUntilAfterImport('next week')).toBe(0);
    expect(pausedUntilAfterImport(-5)).toBe(0);
    expect(pausedUntilAfterImport(null)).toBe(0);
    expect(pausedUntilAfterImport(undefined)).toBe(0);
  });

  it('past timestamps survive sanitize (gating treats them as unpaused)', () => {
    // Deliberate: the gate is a comparison against now, so stale values
    // are harmless and need no cleanup migration.
    expect(pausedUntilAfterImport(1000)).toBe(1000);
  });
});
