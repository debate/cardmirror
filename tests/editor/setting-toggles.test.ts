/**
 * Command-bar setting toggles. The palette generates a "Toggle <label>"
 * command for every boolean (`kind: 'toggle'`) setting via
 * `toggleableSettingMetas`, so the list tracks the registry automatically.
 * These lock in the derivation: what's included, host/dependency gating, and
 * that every toggle setting is actually a boolean (so a flip is well-defined).
 */

import { describe, it, expect } from 'vitest';
import {
  SettingsStore,
  SETTING_METADATA,
  toggleableSettingMetas,
  type Settings,
} from '../../src/editor/settings.js';

const mkEnv = (over: { hostKind?: string; isWindows?: boolean; store?: SettingsStore } = {}) => {
  const store = over.store ?? new SettingsStore();
  return {
    hostKind: over.hostKind ?? 'electron',
    isWindows: over.isWindows ?? false,
    get: (k: keyof Settings) => store.get(k),
  };
};

describe('toggleableSettingMetas', () => {
  it('every kind:"toggle" setting is a real boolean (flip is well-defined)', () => {
    const store = new SettingsStore();
    for (const m of SETTING_METADATA.filter((x) => x.kind === 'toggle')) {
      expect(typeof store.get(m.key), `${String(m.key)} default`).toBe('boolean');
    }
  });

  it('returns only toggle settings and excludes search-hidden ones', () => {
    const metas = toggleableSettingMetas(mkEnv());
    expect(metas.length).toBeGreaterThan(30);
    expect(metas.every((m) => m.kind === 'toggle')).toBe(true);
    const keys = metas.map((m) => String(m.key));
    expect(keys).toContain('smartQuotes');
    expect(keys).toContain('editorSpellcheck');
    // kind:'toggle' but searchHidden — must not become a command.
    expect(keys).not.toContain('cardCutterMorphologyShaving');
  });

  it('honors host gating (electronOnly / windowsOnly / webOnly)', () => {
    const el = toggleableSettingMetas(mkEnv({ hostKind: 'electron', isWindows: false })).map((m) =>
      String(m.key),
    );
    const web = toggleableSettingMetas(mkEnv({ hostKind: 'browser' })).map((m) => String(m.key));
    const win = toggleableSettingMetas(mkEnv({ hostKind: 'electron', isWindows: true })).map((m) =>
      String(m.key),
    );
    expect(el).toContain('pairingEnabled'); // electronOnly → present on electron
    expect(web).not.toContain('pairingEnabled'); // hidden on web
    expect(el).not.toContain('flowHostOnLaunch'); // windowsOnly → hidden off Windows
    expect(win).toContain('flowHostOnLaunch'); // present on Windows
  });

  it('hides a dependsOn toggle while its parent is off, shows it when on', () => {
    const store = new SettingsStore();
    store.set('createReferenceIncludeHeading', false);
    expect(
      toggleableSettingMetas(mkEnv({ store })).map((m) => String(m.key)),
    ).not.toContain('createReferenceHeadingBold');

    store.set('createReferenceIncludeHeading', true);
    expect(
      toggleableSettingMetas(mkEnv({ store })).map((m) => String(m.key)),
    ).toContain('createReferenceHeadingBold');
  });
});
