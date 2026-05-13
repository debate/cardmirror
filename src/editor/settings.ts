/**
 * Editor settings — typed user preferences with localStorage persistence
 * and pub/sub for change notifications.
 *
 * Per ARCHITECTURE.md §5 the bigger "display config" (per-node typography,
 * accessibility presets, etc.) is a separate substantial feature. This
 * module is the simpler feature-toggle / numeric-pref store. Display
 * config can layer on later as its own module without colliding.
 */

import { isWordHighlightName, isHex6 } from './color-palette.js';

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
  undertagItalic: boolean;
  undertagBold: boolean;
}

const DEFAULT_DISPLAY_TYPOGRAPHY: DisplayTypography = {
  citeUnderlined: false,
  underlineBold: false,
  emphasisBold: true,
  emphasisItalic: false,
  emphasisBox: true,
  emphasisBoxSize: 1,
  undertagItalic: true,
  undertagBold: false,
};

/**
 * Per-style display colors (hex strings, e.g. `"#1F3864"`). Per
 * ARCHITECTURE.md §18 every user-visible color should be reachable
 * through display config — analytic and undertag are the first two
 * surfaced as direct controls. Each becomes a CSS custom property on
 * `:root` (e.g. `--pmd-color-analytic`). Both the editor and the nav
 * pane consume those variables.
 */
export interface DisplayColors {
  analytic: string;
  undertag: string;
}

const DEFAULT_DISPLAY_COLORS: DisplayColors = {
  analytic: '#1F3864',
  undertag: '#385623',
};

export const DISPLAY_COLOR_KEYS: (keyof DisplayColors)[] = ['analytic', 'undertag'];

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
   * Per-style display colors. See DisplayColors. Each becomes a CSS
   * custom property on `:root`.
   */
  displayColors: DisplayColors;
  /**
   * Body font family. Mirrors Verbatim's NormalFont. Applied as a CSS
   * custom property on `#editor`; rendered with sans-serif fallback.
   */
  bodyFont: string;
  /**
   * Per-paragraph-type line-height multipliers. Each maps to a CSS
   * variable on `#editor` (--pmd-line-height, --pmd-line-height-cite,
   * etc.). `lineHeight` is the body knob — it also scales shrunken-
   * paragraph line-heights via the font-size-class plugin's ramp.
   * Each is unitless; range 1.0–2.0.
   */
  lineHeight: number;
  lineHeightCite: number;
  lineHeightTag: number;
  lineHeightAnalytic: number;
  lineHeightHeading: number;
  lineHeightUndertag: number;
  /**
   * Display mode for the ribbon's formatting panel (Pocket / Hat /
   * Block / Tag / Analytic buttons). 'labels' shows the style name on
   * each button, 'shortcuts' shows the keyboard binding, 'hidden'
   * removes the panel entirely.
   */
  formattingPanelMode: FormattingPanelMode;
  /**
   * When true, the formatting-panel buttons preview the visual
   * treatment of the style they apply (Pocket boxed, Hat double-
   * underlined, Tag bold, etc.). When false, buttons are rendered as
   * plain text. Has no effect when formattingPanelMode is 'hidden'.
   */
  formattingPanelPreview: boolean;
  /**
   * When true (default), the cite/underline/emphasis "character
   * styles" sub-panel is shown in the ribbon. When false, just that
   * sub-panel is hidden (the rest of the formatting panel, color
   * controls, etc. stay visible). Independent of formattingPanelMode:
   * setting the mode to "Hidden" hides everything regardless.
   */
  showCharacterStyles: boolean;
  /**
   * Last highlight color picked from the ribbon dropdown. One of the
   * 15 Word named highlight colors (`yellow`, `green`, `darkRed`, …).
   * Used as the active color when F11 toggles highlight on; persisted
   * so the editor remembers each user's preferred color.
   */
  lastHighlightColor: string;
  /**
   * Last shading color picked from the ribbon dropdown. 6-char hex
   * (no leading `#`). Default is Verbatim's D2D2D2 protected-highlight
   * grey. Used as the active color when Ctrl-F11 toggles shading on.
   */
  lastShadingColor: string;
  /**
   * Last font color picked from the ribbon dropdown. 6-char hex
   * (no leading `#`), or null for "Automatic" (no font_color mark).
   * When null, the Automatic option in the dropdown is the active
   * selection; applying font color removes the mark entirely instead
   * of writing a black explicitly.
   */
  lastFontColor: string | null;
  /**
   * Condense settings — drive the behavior of the default condense
   * hotkey (F3) and modify selection-based condense semantics. See
   * ARCHITECTURE.md §15 condense for the full rule table.
   *
   * `paragraphIntegrity`:
   *   - true  → F3 keeps paragraphs separate (Branch C); only intra-
   *             paragraph whitespace is cleaned.
   *   - false → F3 merges collapsible paragraph runs (Branch A or B
   *             depending on `usePilcrows`).
   *   Toggled from the ribbon (paragraph-integrity button) and the
   *   settings panel.
   *
   * `usePilcrows`:
   *   - false → merging joins paragraphs with spaces (Branch A).
   *   - true  → merging inserts a 6-pt ¶ at each original boundary
   *             (Branch B), so paragraph splits are recoverable via
   *             Uncondense. Only consulted when `paragraphIntegrity`
   *             is false (no boundaries to mark otherwise).
   *
   * `headingMode`:
   *   - 'strict'   → selection-based condense **no-ops** if the
   *                  selection touches any structural element
   *                  (heading / cite_paragraph / undertag). Safest
   *                  mode — won't accidentally cross a structural
   *                  boundary. Body-only selections behave like
   *                  'respect'.
   *   - 'respect'  → selection keeps headings + cite_paragraphs +
   *                  undertags as their own paragraphs; only
   *                  consecutive runs of card_body / doc-level
   *                  paragraph merge.
   *   - 'demolish' → selection demolishes everything in its range;
   *                  the collapsed textblock's type = type of the
   *                  first touched paragraph; cards / analytic_units
   *                  whose head was touched dissolve and orphan body
   *                  slots absorb into the receiving container.
   */
  paragraphIntegrity: boolean;
  usePilcrows: boolean;
  headingMode: HeadingMode;
  /**
   * When true, F2 (Paste Text) runs the default condense pass on the
   * card after pasting. Mirrors Verbatim's `CondenseOnPaste` flag —
   * off by default; useful for users who almost always paste a long
   * blob of text that needs to be tightened up. The condense it runs
   * is the same one F3 invokes (respects `paragraphIntegrity` /
   * `usePilcrows` / `headingMode`).
   */
  condenseOnPaste: boolean;
  /**
   * When true, removing a named-style mark (F8 Emphasis / F9 Underline /
   * F10 Cite) via the apply key ALSO strips direct formatting (font
   * size / color / family, bold, italic, strikethrough, highlight,
   * shading, direct underline) from the same range. Mirrors Verbatim's
   * "press F9 twice to clear formatting" workflow. When off, toggling
   * the named-style off leaves any direct formatting the user manually
   * added intact.
   *
   * Always applies on the apply direction (adding the named-style mark
   * strips direct formatting unconditionally — the user can manually
   * re-apply direct formatting after).
   */
  clearFormattingOnNamedStyleToggleOff: boolean;
}

export type HeadingMode = 'strict' | 'respect' | 'demolish';
const HEADING_MODES: HeadingMode[] = ['strict', 'respect', 'demolish'];

export type FormattingPanelMode = 'labels' | 'shortcuts' | 'both' | 'hidden';
const FORMATTING_PANEL_MODES: FormattingPanelMode[] = ['labels', 'shortcuts', 'both', 'hidden'];

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
  displayColors: { ...DEFAULT_DISPLAY_COLORS },
  bodyFont: 'Calibri',
  lineHeight: 1.3,
  lineHeightCite: 1.2,
  lineHeightTag: 1.2,
  lineHeightAnalytic: 1.2,
  lineHeightHeading: 1.2,
  lineHeightUndertag: 1.2,
  formattingPanelMode: 'labels',
  formattingPanelPreview: true,
  showCharacterStyles: true,
  lastHighlightColor: 'yellow',
  lastShadingColor: 'C0C0C0',
  lastFontColor: null,
  paragraphIntegrity: true,
  usePilcrows: true,
  headingMode: 'respect',
  condenseOnPaste: false,
  clearFormattingOnNamedStyleToggleOff: true,
};

/** Public read-only view of the built-in defaults — handy for any UI
 *  that wants a "Restore defaults" button. */
export const SETTINGS_DEFAULTS: Readonly<Settings> = DEFAULTS;

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
    | 'displayColors'
    | 'bodyFont'
    | 'lineHeights'
    | 'formattingPanelMode'
    | 'headingMode';
}

export const SETTING_METADATA: SettingMeta[] = [
  {
    key: 'showCitePreview',
    label: 'Cite preview on hover',
    description:
      'Show the cite-formatted text from a card on the right side of its nav-pane entry when you hover.',
    kind: 'toggle',
  },
  {
    key: 'readers',
    label: 'Readers for read-time estimates',
    description:
      'Each reader has a name and a words-per-minute rate. The first two are displayed live in the bottom bar; all show up in the Word Count Selection dialog.',
    kind: 'readers',
  },
  {
    key: 'displaySizes',
    label: 'Style font sizes (pt)',
    description:
      "Render size for each named style. Doesn't change the underlying doc — only how it looks here.",
    kind: 'displaySizes',
  },
  {
    key: 'displayTypography',
    label: 'Style typography',
    kind: 'displayTypography',
  },
  {
    key: 'displayColors',
    label: 'Style colors',
    description:
      'Pick the color used for Analytic and Undertag text.',
    kind: 'displayColors',
  },
  {
    key: 'bodyFont',
    label: 'Body font',
    description:
      'Font family for body text.',
    kind: 'bodyFont',
  },
  {
    key: 'formattingPanelMode',
    label: 'Formatting panel',
    description:
      'How the Pocket / Hat / Block / Tag / Analytic buttons in the ribbon are displayed. "Labels" shows the style name, "Shortcuts" shows the keyboard binding, "Both" shows name · shortcut, "Hidden" removes the panel.',
    kind: 'formattingPanelMode',
  },
  {
    key: 'formattingPanelPreview',
    label: 'Preview styles in formatting panel',
    description:
      'When on, formatting-panel buttons preview the visual treatment of the style they apply.',
    kind: 'toggle',
  },
  {
    key: 'showCharacterStyles',
    label: 'Show character styles',
    description:
      'Show the cite / underline / emphasis character-style buttons in the ribbon. When off, just that sub-panel is hidden; the rest of the formatting panel stays visible.',
    kind: 'toggle',
  },
  {
    key: 'paragraphIntegrity',
    label: 'F3 condense: preserve paragraph integrity',
    description:
      'When on, F3 only removes intra-paragraph whitespace — paragraphs stay separate. When off, F3 merges consecutive collapsible paragraphs.',
    kind: 'toggle',
  },
  {
    key: 'usePilcrows',
    label: 'F3 condense: use pilcrow markers',
    description:
      'When paragraph integrity is off and this is on, F3 inserts a 6-pt ¶ at each original paragraph boundary in the merged result, so that the split can be reversed via Ctrl/Cmd+Alt+Shift+F3 (Uncondense).',
    kind: 'toggle',
  },
  {
    key: 'condenseOnPaste',
    label: 'Condense after Paste Text (F2)',
    description:
      'When on, text that you paste will be condensed using your default "condense" settings.',
    kind: 'toggle',
  },
  {
    key: 'headingMode',
    label: 'Condense: heading handling',
    description:
      'How selection-based condense without paragraph integrity treats structural elements (headings, cites, undertags) inside the selection. "Strict" blocks attempts to condense that include structural elements. "Respect" (default) keeps structural paragraphs unmerged and merges everything else in the selection. "Demolish" merges everything in the selection.',
    kind: 'headingMode',
  },
  {
    key: 'clearFormattingOnNamedStyleToggleOff',
    label: 'F9 toggle-off also clears direct formatting',
    description:
      'When on, pressing F9 to toggle underlining off also strips direct formatting in the range. When off, only the underline style mark is removed; direct formatting applied to the underlined text is preserved.',
    kind: 'toggle',
  },
  {
    key: 'lineHeight',
    label: 'Line spacing',
    description:
      'Line-spacing multiplier per paragraph type (unitless × font-size).',
    kind: 'lineHeights',
  },
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
    displayColors: sanitizeDisplayColors(s.displayColors),
    bodyFont: sanitizeBodyFont(s.bodyFont),
    lineHeight: sanitizeLineHeight(s.lineHeight, DEFAULTS.lineHeight),
    lineHeightCite: sanitizeLineHeight(s.lineHeightCite, DEFAULTS.lineHeightCite),
    lineHeightTag: sanitizeLineHeight(s.lineHeightTag, DEFAULTS.lineHeightTag),
    lineHeightAnalytic: sanitizeLineHeight(s.lineHeightAnalytic, DEFAULTS.lineHeightAnalytic),
    lineHeightHeading: sanitizeLineHeight(s.lineHeightHeading, DEFAULTS.lineHeightHeading),
    lineHeightUndertag: sanitizeLineHeight(s.lineHeightUndertag, DEFAULTS.lineHeightUndertag),
    formattingPanelMode: FORMATTING_PANEL_MODES.includes(s.formattingPanelMode as FormattingPanelMode)
      ? (s.formattingPanelMode as FormattingPanelMode)
      : DEFAULTS.formattingPanelMode,
    formattingPanelPreview:
      s.formattingPanelPreview === undefined
        ? DEFAULTS.formattingPanelPreview
        : !!s.formattingPanelPreview,
    showCharacterStyles:
      s.showCharacterStyles === undefined
        ? DEFAULTS.showCharacterStyles
        : !!s.showCharacterStyles,
    lastHighlightColor: isWordHighlightName(String(s.lastHighlightColor ?? ''))
      ? String(s.lastHighlightColor)
      : DEFAULTS.lastHighlightColor,
    lastShadingColor: isHex6(s.lastShadingColor)
      ? String(s.lastShadingColor).toUpperCase()
      : DEFAULTS.lastShadingColor,
    lastFontColor:
      s.lastFontColor === null || s.lastFontColor === undefined
        ? DEFAULTS.lastFontColor
        : isHex6(s.lastFontColor)
        ? String(s.lastFontColor).toUpperCase()
        : DEFAULTS.lastFontColor,
    paragraphIntegrity:
      s.paragraphIntegrity === undefined
        ? DEFAULTS.paragraphIntegrity
        : !!s.paragraphIntegrity,
    usePilcrows:
      s.usePilcrows === undefined
        ? DEFAULTS.usePilcrows
        : !!s.usePilcrows,
    headingMode: HEADING_MODES.includes(s.headingMode as HeadingMode)
      ? (s.headingMode as HeadingMode)
      : DEFAULTS.headingMode,
    condenseOnPaste:
      s.condenseOnPaste === undefined
        ? DEFAULTS.condenseOnPaste
        : !!s.condenseOnPaste,
    clearFormattingOnNamedStyleToggleOff:
      s.clearFormattingOnNamedStyleToggleOff === undefined
        ? DEFAULTS.clearFormattingOnNamedStyleToggleOff
        : !!s.clearFormattingOnNamedStyleToggleOff,
  };
}

function sanitizeLineHeight(raw: unknown, fallback: number): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  // Round to 0.05 steps; clamp to [1.0, 2.0] — the input UI uses the
  // same step / range.
  return clamp(Math.round(n * 20) / 20, 1.0, 2.0);
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
  out.undertagItalic = r.undertagItalic === undefined
    ? DEFAULT_DISPLAY_TYPOGRAPHY.undertagItalic : !!r.undertagItalic;
  out.undertagBold = r.undertagBold === undefined
    ? DEFAULT_DISPLAY_TYPOGRAPHY.undertagBold : !!r.undertagBold;
  const bs = Number(r.emphasisBoxSize);
  if (Number.isFinite(bs) && bs > 0 && bs <= 12) {
    out.emphasisBoxSize = Math.round(bs * 4) / 4; // quarter-pt precision
  }
  return out;
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function sanitizeColor(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  // Accept #abc and #abcdef; normalize to 6-digit lowercase.
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const r = trimmed[1]!;
    const g = trimmed[2]!;
    const b = trimmed[3]!;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  if (HEX_COLOR_RE.test(trimmed)) return trimmed.toLowerCase();
  return fallback;
}

function sanitizeDisplayColors(raw: unknown): DisplayColors {
  const out = { ...DEFAULT_DISPLAY_COLORS };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Partial<Record<keyof DisplayColors, unknown>>;
  for (const key of DISPLAY_COLOR_KEYS) {
    out[key] = sanitizeColor(r[key], DEFAULT_DISPLAY_COLORS[key]);
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
