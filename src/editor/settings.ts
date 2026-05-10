/**
 * Editor settings — typed user preferences with localStorage persistence
 * and pub/sub for change notifications.
 *
 * Per ARCHITECTURE.md §5 the bigger "display config" (per-node typography,
 * accessibility presets, etc.) is a separate substantial feature. This
 * module is the simpler feature-toggle / numeric-pref store. Display
 * config can layer on later as its own module without colliding.
 */

const STORAGE_KEY = 'pmd-settings';

/** Reader profile for read-time estimates: name + words-per-minute. */
export interface ReaderConfig {
  name: string;
  wpm: number;
}

/**
 * Per-style font sizes (in points). Mirrors Verbatim's Styles tab so
 * users can adjust how each named style renders without touching the
 * underlying doc — the §5 three-layer rendering model in action. Each
 * field becomes a CSS custom property on `#editor` (e.g. `--pmd-size-
 * cite: 13pt`); CSS rules consume the variables.
 *
 * Defaults match Verbatim's defaults for parity with current docs:
 *   pocket=26, hat=22, block=16, tag=13, analytic=13, cite=13,
 *   underline=11, emphasis=11, undertag=12, normal=11.
 */
export interface DisplaySizes {
  normal: number;
  pocket: number;
  hat: number;
  block: number;
  tag: number;
  analytic: number;
  cite: number;
  underline: number;
  emphasis: number;
  undertag: number;
}

export const DISPLAY_SIZE_KEYS: (keyof DisplaySizes)[] = [
  'normal', 'pocket', 'hat', 'block', 'tag',
  'analytic', 'cite', 'underline', 'emphasis', 'undertag',
];

const DEFAULT_DISPLAY_SIZES: DisplaySizes = {
  normal: 11,
  pocket: 26,
  hat: 22,
  block: 16,
  tag: 13,
  analytic: 13,
  cite: 13,
  underline: 11,
  emphasis: 11,
  undertag: 12,
};

/**
 * Per-style typography flags. Mirrors the boolean side of Verbatim's
 * Styles tab — whether each named style is bold, italic, underlined,
 * boxed, plus the box thickness. Each flag becomes a class toggle on
 * `#editor` (e.g. `pmd-emphasis-bold`); CSS rules predicated on the
 * class enable the typography. Default values match Verbatim's
 * defaults, except `emphasisBox` (defaulting to true here to match the
 * existing always-on box rendering).
 */
export interface DisplayTypography {
  citeUnderlined: boolean;
  underlineBold: boolean;
  emphasisBold: boolean;
  emphasisItalic: boolean;
  emphasisBox: boolean;
  emphasisBoxSize: number; // pt
}

const DEFAULT_DISPLAY_TYPOGRAPHY: DisplayTypography = {
  citeUnderlined: false,
  underlineBold: false,
  emphasisBold: true,
  emphasisItalic: false,
  emphasisBox: true,
  emphasisBoxSize: 1,
};

/** Schema for all editor settings. Add new fields here with sensible defaults. */
export interface Settings {
  /** Width of the navigation pane in pixels. */
  navWidth: number;
  /** Default depth shown in the navigation pane (1–4). */
  navMaxLevel: number;
  /** Whether to show the cite preview on hover in the nav pane. */
  showCitePreview: boolean;
  /** Whether read mode is currently active (dims non-read-aloud content,
   *  blocks editing). Persisted across sessions because some users may
   *  want it to be the default state. */
  readMode: boolean;
  /** When true, strip ALL emphasis-mark borders in read mode (not just
   *  the ones around hidden text). Some users prefer the cleanest look
   *  in read mode regardless of what's emphasized. */
  hideEmphasisBordersInReadMode: boolean;
  /** Editor zoom level as a percentage (50–200, step 10). */
  zoomPct: number;
  /**
   * Readers used for read-time estimates. The full list shows up in the
   * Word Count Selection function (Ctrl+F11). The first two readers are
   * also displayed in the bottom status bar live.
   */
  readers: ReaderConfig[];
  /**
   * Per-style font sizes (in points). See DisplaySizes for details.
   * Each field becomes a CSS custom property on `#editor`.
   */
  displaySizes: DisplaySizes;
  /**
   * Per-style typography flags (bold/italic/underlined/box). See
   * DisplayTypography. Each becomes a class toggle on `#editor`.
   */
  displayTypography: DisplayTypography;
  /**
   * Body font family. Mirrors Verbatim's NormalFont. Applied as a CSS
   * custom property on `#editor`; rendered with sans-serif fallback.
   */
  bodyFont: string;
  /**
   * Global line-height multiplier (unitless). Mirrors Verbatim's
   * Spacing setting (Wide=1.4ish, Narrow=1.15ish). Range 1.0–2.0.
   */
  lineHeight: number;
}

const DEFAULTS: Settings = {
  navWidth: 300,
  navMaxLevel: 3,
  showCitePreview: true,
  readMode: false,
  hideEmphasisBordersInReadMode: false,
  zoomPct: 100,
  readers: [
    { name: 'Reader 1', wpm: 200 },
    { name: 'Reader 2', wpm: 250 },
  ],
  displaySizes: { ...DEFAULT_DISPLAY_SIZES },
  displayTypography: { ...DEFAULT_DISPLAY_TYPOGRAPHY },
  bodyFont: 'Calibri',
  lineHeight: 1.4,
};

/**
 * Human-readable metadata for each setting, used by the settings UI.
 * Add new entries when introducing new settings.
 */
export interface SettingMeta {
  key: keyof Settings;
  label: string;
  description?: string;
  /** Settings UI hint: how should this be rendered? */
  kind:
    | 'toggle'
    | 'number'
    | 'level'
    | 'readers'
    | 'displaySizes'
    | 'displayTypography'
    | 'bodyFont'
    | 'lineHeight';
}

export const SETTING_METADATA: SettingMeta[] = [
  {
    key: 'showCitePreview',
    label: 'Cite preview on hover',
    description:
      'Show the cite-formatted text from a card on the right side of its nav-pane entry when you hover. Some users find this useful; others find it busy.',
    kind: 'toggle',
  },
  {
    key: 'hideEmphasisBordersInReadMode',
    label: 'Hide all emphasis borders in read mode',
    description:
      'By default, emphasis borders are removed only when the emphasized text is hidden (so empty boxes don’t appear next to highlighted content). Turn this on to strip every emphasis border in read mode, including around highlighted text.',
    kind: 'toggle',
  },
  {
    key: 'readers',
    label: 'Readers for read-time estimates',
    description:
      'Each reader has a name and a words-per-minute rate. The first two are displayed live in the bottom bar; all show up in the Word Count Selection dialog. Add as many as you need.',
    kind: 'readers',
  },
  {
    key: 'displaySizes',
    label: 'Style font sizes (pt)',
    description:
      "Render size for each named style. Doesn't change the underlying doc — only how it looks here. Verbatim's defaults: Pocket 26, Hat 22, Block 16, Tag 13, Cite 13, Underline 11, Emphasis 11.",
    kind: 'displaySizes',
  },
  {
    key: 'displayTypography',
    label: 'Style typography',
    description:
      'Bold / italic / underline / box decorations for the named styles, plus the box thickness for Emphasis. Mirrors Verbatim\'s Styles tab toggles.',
    kind: 'displayTypography',
  },
  {
    key: 'bodyFont',
    label: 'Body font',
    description:
      "Font family for body text. Pick the font your team's docs use — Calibri matches Verbatim's default.",
    kind: 'bodyFont',
  },
  // Note: `lineHeight` is wired through (defaults to 1.4, applied to
  // #editor via --pmd-line-height) but isn't exposed in the settings
  // UI — the configurable version had a known interaction bug. Once
  // that's fixed, add a `kind: 'lineHeight'` metadata entry here to
  // surface it.
];

type Listener = (s: Readonly<Settings>) => void;

export class SettingsStore {
  private values: Settings;
  private listeners: Set<Listener> = new Set();

  constructor() {
    this.values = this.load();
  }

  get<K extends keyof Settings>(key: K): Settings[K] {
    return this.values[key];
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    if (this.values[key] === value) return;
    this.values[key] = value;
    this.persist();
    this.notify();
  }

  all(): Readonly<Settings> {
    return { ...this.values };
  }

  /** Subscribe to any settings change. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private load(): Settings {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          return sanitize({ ...DEFAULTS, ...parsed });
        }
      }
      // Migrate legacy individual keys, if any.
      const legacy: Partial<Settings> = {};
      const navWidth = localStorage.getItem('pmd-nav-width');
      if (navWidth != null) {
        const n = parseInt(navWidth, 10);
        if (Number.isFinite(n)) legacy.navWidth = n;
      }
      const navMaxLevel = localStorage.getItem('pmd-nav-max-level');
      if (navMaxLevel != null) {
        const n = parseInt(navMaxLevel, 10);
        if (Number.isFinite(n)) legacy.navMaxLevel = n;
      }
      return sanitize({ ...DEFAULTS, ...legacy });
    } catch {
      return { ...DEFAULTS };
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.values));
    } catch {
      /* localStorage full / disabled — ignore */
    }
  }

  private notify(): void {
    const snapshot = { ...this.values };
    for (const listener of this.listeners) listener(snapshot);
  }
}

function sanitize(s: Settings): Settings {
  return {
    navWidth: clamp(s.navWidth, 150, 800),
    navMaxLevel: clamp(Math.round(s.navMaxLevel), 1, 4),
    showCitePreview: !!s.showCitePreview,
    readMode: !!s.readMode,
    hideEmphasisBordersInReadMode: !!s.hideEmphasisBordersInReadMode,
    zoomPct: clamp(Math.round(s.zoomPct / 10) * 10, 50, 200),
    readers: sanitizeReaders(s.readers),
    displaySizes: sanitizeDisplaySizes(s.displaySizes),
    displayTypography: sanitizeDisplayTypography(s.displayTypography),
    bodyFont: sanitizeBodyFont(s.bodyFont),
    lineHeight: clamp(
      Number.isFinite(s.lineHeight) ? Math.round(s.lineHeight * 20) / 20 : 1.4,
      1.0,
      2.0,
    ),
  };
}

function sanitizeBodyFont(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULTS.bodyFont;
  // Strip any quotes or commas — bodyFont must be a single font-family
  // name. A previous iteration accepted free-form input, so a stale
  // persisted value might contain `"Calibri", sans-serif` or similar.
  const cleaned = raw.replace(/["',]/g, '').trim();
  return cleaned || DEFAULTS.bodyFont;
}

function sanitizeDisplayTypography(raw: unknown): DisplayTypography {
  const out = { ...DEFAULT_DISPLAY_TYPOGRAPHY };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Partial<Record<keyof DisplayTypography, unknown>>;
  out.citeUnderlined = !!r.citeUnderlined;
  out.underlineBold = !!r.underlineBold;
  out.emphasisBold = r.emphasisBold === undefined
    ? DEFAULT_DISPLAY_TYPOGRAPHY.emphasisBold : !!r.emphasisBold;
  out.emphasisItalic = !!r.emphasisItalic;
  out.emphasisBox = r.emphasisBox === undefined
    ? DEFAULT_DISPLAY_TYPOGRAPHY.emphasisBox : !!r.emphasisBox;
  const bs = Number(r.emphasisBoxSize);
  if (Number.isFinite(bs) && bs > 0 && bs <= 12) {
    out.emphasisBoxSize = Math.round(bs * 4) / 4; // quarter-pt precision
  }
  return out;
}

function sanitizeDisplaySizes(raw: unknown): DisplaySizes {
  const out = { ...DEFAULT_DISPLAY_SIZES };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Partial<Record<keyof DisplaySizes, unknown>>;
  for (const key of DISPLAY_SIZE_KEYS) {
    const v = Number(r[key]);
    if (Number.isFinite(v) && v >= 1 && v <= 144) {
      out[key] = Math.round(v * 2) / 2; // half-point precision
    }
  }
  return out;
}

function sanitizeReaders(raw: unknown): ReaderConfig[] {
  if (!Array.isArray(raw)) return [...DEFAULTS.readers];
  const out: ReaderConfig[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const name = String((r as ReaderConfig).name ?? '').trim();
    const wpm = Number((r as ReaderConfig).wpm);
    if (!name || !Number.isFinite(wpm) || wpm <= 0) continue;
    out.push({ name, wpm: Math.round(wpm) });
  }
  return out.length > 0 ? out : [...DEFAULTS.readers];
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/** Singleton store. */
export const settings = new SettingsStore();
