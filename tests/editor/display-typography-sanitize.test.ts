/**
 * DisplayTypography sanitize boundary (via SettingsStore.replaceAll,
 * the same `sanitize({ ...DEFAULTS, ...raw })` path as load): the box
 * thickness fields clamp to (0, 12] pt at quarter-pt precision and
 * fall back to their defaults on garbage. pocketBoxSize added
 * 2026-07-16 (default 2.25pt = the 3px the CSS hardcoded before it
 * was a setting).
 */
import { describe, expect, it } from 'vitest';
import { SettingsStore } from '../../src/editor/settings.js';

function typographyAfterImport(dt: Record<string, unknown>): {
  pocketBox: boolean;
  pocketBoxSize: number;
  emphasisBoxSize: number;
  underlineSize: number;
} {
  const s = new SettingsStore();
  s.replaceAll({ displayTypography: dt });
  return s.get('displayTypography');
}

describe('displayTypography box-size sanitize', () => {
  it('missing pocketBoxSize falls back to the 2.25pt default (old hardcoded look)', () => {
    expect(typographyAfterImport({}).pocketBoxSize).toBe(2.25);
  });

  it('valid sizes round to quarter-pt precision', () => {
    expect(typographyAfterImport({ pocketBoxSize: 4 }).pocketBoxSize).toBe(4);
    expect(typographyAfterImport({ pocketBoxSize: 3.13 }).pocketBoxSize).toBe(3.25);
    expect(typographyAfterImport({ emphasisBoxSize: 2.6 }).emphasisBoxSize).toBe(2.5);
  });

  it('garbage falls back to defaults (zero, negative, huge, NaN)', () => {
    expect(typographyAfterImport({ pocketBoxSize: 0 }).pocketBoxSize).toBe(2.25);
    expect(typographyAfterImport({ pocketBoxSize: -3 }).pocketBoxSize).toBe(2.25);
    expect(typographyAfterImport({ pocketBoxSize: 99 }).pocketBoxSize).toBe(2.25);
    expect(typographyAfterImport({ pocketBoxSize: 'wide' }).pocketBoxSize).toBe(2.25);
  });

  it('pocketBox flag: default true when missing; false round-trips', () => {
    expect(typographyAfterImport({}).pocketBox).toBe(true);
    expect(typographyAfterImport({ pocketBox: false }).pocketBox).toBe(false);
    expect(typographyAfterImport({ pocketBox: 1 }).pocketBox).toBe(true); // coerced
  });

  it('underlineSize: 0 is a VALID value (auto), not garbage', () => {
    // Unlike the box sizes, whose 0 falls back to a default — 0 is the
    // "font's automatic thickness" sentinel and the shipped default.
    expect(typographyAfterImport({}).underlineSize).toBe(0);
    expect(typographyAfterImport({ underlineSize: 0 }).underlineSize).toBe(0);
    expect(typographyAfterImport({ underlineSize: 1.5 }).underlineSize).toBe(1.5);
    expect(typographyAfterImport({ underlineSize: 2.6 }).underlineSize).toBe(2.5);
  });

  it('underlineSize garbage falls back to auto (negative, huge, NaN)', () => {
    expect(typographyAfterImport({ underlineSize: -1 }).underlineSize).toBe(0);
    expect(typographyAfterImport({ underlineSize: 99 }).underlineSize).toBe(0);
    expect(typographyAfterImport({ underlineSize: 'thick' }).underlineSize).toBe(0);
  });
});
