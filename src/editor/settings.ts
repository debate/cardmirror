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
import type { RibbonCommandId } from './ribbon-commands.js';
import { getHost } from './host/index.js';

/** Dynamic description for the `multiDocWorkspace` (three-pane
 *  workspace) toggle. The OFF state behaves differently on Electron
 *  vs the web edition, so we surface that difference at the point
 *  the user reads the setting. */
function workspaceLayoutDescription(): string {
  const kind = getHost().kind;
  const offBehavior =
    kind === 'electron'
      ? 'each open document gets its own native window. Opening a new file (or making a new document) spawns a new window — recommended when you have screen space and a good window manager.'
      : 'one document at a time in this browser tab. The web edition can\'t spawn its own windows, so to work with multiple documents in this mode, open additional browser tabs and load a doc in each — or turn this setting ON to use three panes inside this tab.';
  return (
    `OFF (default): ${offBehavior} ON: a single window with three side-by-side panes inside it, for working multi-doc with limited screen real estate. Comments are unavailable while ON. Toggling reloads the editor; open documents are restored in the new layout.`
  );
}

const STORAGE_KEY = 'pmd-settings';

/** Keys whose values are per-window/per-session: never written to
 *  localStorage, never synced via storage events, and reset to
 *  defaults on reload. Read mode is the canonical case — Verbatim
 *  exits read mode on document close, and we already treat it as
 *  per-pane in multi-doc mode; making it per-window matches that
 *  intent for the multi-window case. Autosave joins it for the
 *  same reason: a workflow toggle the user wants to control per
 *  doc, not a global preference. */
const TRANSIENT_SETTING_KEYS = new Set<string>([
  'readMode',
  // `autosaveEnabled` stays transient as a SETTING (per-window, never
  // in `pmd-settings`), but the choice is remembered PER FILE in
  // `autosave-prefs-store.ts` so reopening a doc restores its toggle.
  'autosaveEnabled',
  // Nav-pane visibility — the user might want the outline open in
  // one window (a doc they're navigating heavily) and hidden in
  // another (a doc they're reading). Per-window matches that
  // intent; on the web edition there's only one tab so it's
  // effectively a session preference.
  'navPaneVisible',
]);

/** Secret credentials — never written to a settings export, and
 *  preserved (not overwritten) on import. */
const SECRET_SETTING_KEYS = new Set<string>([
  'anthropicApiKey',
  'googleTranslateApiKey',
  'myMemoryEmail',
]);

/** Reader profile for read-time estimates: name + words-per-minute. */
export interface ReaderConfig {
  name: string;
  wpm: number;
}

/** A paired machine you can send cards to. `code` is that machine's
 *  shareable pairing code (its relay address); `name` is your local
 *  nickname for it, used to disambiguate in the send picker and to label
 *  received cards. */
export interface PairingPartner {
  code: string;
  name: string;
}

/** A named set of partners (e.g. a coach's "Smith/Jones" partnership).
 *  Sending to a group fans the card out to every member. `memberCodes`
 *  references `PairingPartner.code` values. */
export interface PairingGroup {
  id: string;
  label: string;
  memberCodes: string[];
}

/** Receive-pill flash behavior when a card arrives. `once` = one green
 *  pulse; `off` = none; `repeat` = pulse then re-pulse every 10s until
 *  you open the receive pill and see the new card(s). */
export type PairingReceiveFlash = 'once' | 'off' | 'repeat';
const PAIRING_RECEIVE_FLASHES: PairingReceiveFlash[] = ['once', 'off', 'repeat'];

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
 * Per-style paragraph spacing — the blank space BEFORE and AFTER a
 * paragraph (its top/bottom margin), in points. A display setting like
 * line spacing: it overrides how the editor renders, independent of the
 * doc's own spacing. Keys are `<style>Before` / `<style>After`. Defaults
 * match the spacing the editor shipped with (the old hard-coded margins).
 */
export const PARAGRAPH_SPACING_KEYS = [
  'bodyBefore', 'bodyAfter',
  'citeBefore', 'citeAfter',
  'tagBefore', 'tagAfter',
  'analyticBefore', 'analyticAfter',
  'pocketBefore', 'pocketAfter',
  'hatBefore', 'hatAfter',
  'blockBefore', 'blockAfter',
  'undertagBefore', 'undertagAfter',
] as const;
export type ParagraphSpacingKey = (typeof PARAGRAPH_SPACING_KEYS)[number];
export type DisplayParagraphSpacing = Record<ParagraphSpacingKey, number>;

const DEFAULT_PARAGRAPH_SPACING: DisplayParagraphSpacing = {
  bodyBefore: 0, bodyAfter: 0,
  citeBefore: 0, citeAfter: 0,
  tagBefore: 9, tagAfter: 3,
  analyticBefore: 9, analyticAfter: 3,
  pocketBefore: 18, pocketAfter: 9,
  hatBefore: 15, hatAfter: 6,
  blockBefore: 12, blockAfter: 6,
  undertagBefore: 0, undertagAfter: 0,
};
export { DEFAULT_PARAGRAPH_SPACING };

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

export const DEFAULT_DISPLAY_COLORS: DisplayColors = {
  analytic: '#1F3864',
  undertag: '#385623',
};

export const DISPLAY_COLOR_KEYS: (keyof DisplayColors)[] = ['analytic', 'undertag'];

/** A user-defined keyboard macro: pressing `key` types `text` at the
 *  cursor. `id` is a stable local handle for the editor UI. */
export interface KeyboardMacro {
  id: string;
  /** ProseMirror-keymap key string, e.g. `Mod-Shift-q` (same format as
   *  `ribbonKeyOverrides`). Empty = not yet bound. */
  key: string;
  /** Literal text inserted at the cursor when the key fires. */
  text: string;
}

/** Schema for all editor settings. Add new fields here with sensible defaults. */
export interface Settings {
  /** Width of the navigation pane in pixels. */
  navWidth: number;
  /** Default depth shown in the navigation pane (1–4). */
  navMaxLevel: number;
  /** When true (default), `New document` mounts the CardMirror
   *  welcome / onboarding doc. When false, it mounts a blank
   *  doc — a single empty paragraph. The starter is the same one
   *  every fresh window opens with, so this also governs the
   *  initial content of newly spawned windows. */
  showOnboardingStarter: boolean;
  /** Desktop-only. When set, "New Speech Document" saves into this
   *  directory by default (instead of leaving the doc unsaved until
   *  the user picks a location). Empty string means "no default —
   *  keep the current behavior of waiting for an explicit Save."
   *  Stored as an absolute path. */
  defaultSpeechDocFolder: string;
  /** Format that "New Speech Document" creates the doc in. `docx`
   *  is the Verbatim-compatible default. `cmir` is CardMirror's
   *  native format — the only format that supports autosave (the
   *  background save path skips .docx because `toDocx` is too
   *  expensive to run on a debounce). */
  defaultSpeechDocFormat: 'cmir' | 'docx';
  /** Format the Save-As dialog defaults to for a doc that doesn't
   *  yet have an on-disk handle (new doc, first save). Existing
   *  on-disk files always Save As in their current format — the
   *  handle wins over this default. */
  defaultSaveFormat: 'cmir' | 'docx';
  /** When on (default), saving via the Save-As dialog's Send Doc /
   *  Read Doc presets prepends `SEND_` / `READ_` to the file name
   *  (e.g. `SEND_1AC.docx`). The As-Is preset and the Save Custom
   *  button are never prefixed. Off saves presets under the exact
   *  name shown in the box. */
  prefixPresetSaveFilenames: boolean;
  /** Where Save Send Doc writes. `sameFolder` (default) drops the
   *  send doc beside the source file; `fixedFolder` always writes into
   *  `sendDocFolder`. Either way, an unresolvable destination (a
   *  never-saved doc in same-folder mode, or an unset fixed folder)
   *  falls the command back to the Save-As dialog. */
  sendDocDestination: 'sameFolder' | 'fixedFolder';
  /** Destination folder for Save Send Doc when `sendDocDestination`
   *  is `fixedFolder`. Empty falls the command back to the OS save
   *  dialog. */
  sendDocFolder: string;
  /** When on, the highlight marks in the doc render in the colors
   *  defined by `overrideHighlightSlots` rather than their stored
   *  colors. Display-only — does NOT mutate the doc, so saving
   *  back to `.cmir` / `.docx` preserves the original per-mark
   *  colors. Useful when cards from many sources have
   *  inconsistent highlight conventions and the user wants a
   *  visually-unified read. */
  overrideHighlightColor: boolean;
  /** 1–3 hex/rgba colors used to remap highlights at display
   *  time. If length 1: every highlight renders as that color.
   *  If length > 1: the most-common source highlight color gets
   *  slot 0, the second-most-common gets slot 1, and everything
   *  else gets the LAST slot (so "third" slot doubles as the
   *  catch-all when length is 3). Frequency ranking is computed
   *  per-doc by the highlight-frequency plugin. */
  overrideHighlightSlots: string[];
  /** Same idea, applied to `shading` marks (the protected
   *  highlight variant Verbatim uses for "remove highlighting"-
   *  resistant emphasis). Default-on color matches the
   *  protected-grey convention. */
  overrideShadingColor: boolean;
  /** 1–3 hex/rgba colors mirroring `overrideHighlightSlots` for
   *  shading marks. */
  overrideShadingSlots: string[];
  /** Theme. `'light'` and `'dark'` force the corresponding
   *  palette. `'system'` (default) follows the OS-level
   *  `prefers-color-scheme` and tracks live changes. Setting
   *  resolves to the `data-theme` attribute on the document
   *  root; CSS rules at `:root[data-theme="dark"]` (in style.css)
   *  swap the `--pmd-c-*` token values. */
  theme: 'light' | 'dark' | 'system';
  /** Whether the active theme applies to the editor document
   *  area too. Default OFF: the chrome (ribbon, nav, status bar)
   *  follows the theme, but the document itself keeps a light /
   *  paper-like surface — the configuration most people want
   *  when running dark mode. Turn on to make the document area
   *  follow the chrome theme as well. */
  themeAppliesToDocument: boolean;
  /** Icon style for the app chrome (ribbon buttons, banners,
   *  dialog glyphs). `'modern'` (default) uses the Untitled UI
   *  line-icon set, painted in `currentColor` via CSS masks;
   *  `'classic'` falls back to the original emoji/text glyphs.
   *  Resolves to the `data-icons` attribute on the document
   *  root, consumed by `icons.css`. */
  iconSet: 'modern' | 'classic';
  /** Show a pill in the center of the ribbon displaying the
   *  active doc's filename. Off by default — the OS title bar
   *  carries this info on most platforms. Useful when the
   *  title bar is hidden, unstyled, or non-existent (tiling
   *  window managers without decorations, frameless windows,
   *  embedded web edition). Single-doc only; multi-pane shows
   *  per-pane chips regardless of this setting. */
  showDocNameChip: boolean;
  /** Whether to check for updates on app launch (desktop only).
   *  Off by default in this initial release to keep boot
   *  conservative — opt in via Settings → General → "About this
   *  install." When enabled, the first window of an app session
   *  triggers a silent update check at boot; if a new version is
   *  available, a modal pops with a link to the release page.
   *  Subsequent windows in the same session skip the check.
   *  Manual checks via Help → Check for Updates… or the button
   *  in the About this install panel always work regardless. No
   *  effect on the web edition (no update mechanism). */
  checkForUpdatesOnLaunch: boolean;
  /** Width of the comments column in CSS pixels. User-resizable via
   *  the drag handle on the column's left edge. Clamped to
   *  `COMMENTS_WIDTH_MIN` … `COMMENTS_WIDTH_MAX` (240–560) — below
   *  240 threads get cramped, above 560 the column eats too much
   *  editor space. Default 320 matches the column's original fixed
   *  width before the handle existed. */
  commentsColumnWidth: number;
  /** UI motion preference. `'auto'` (default) follows the OS
   *  `prefers-reduced-motion` media query and gives the user the
   *  motion-reduction state their system advertises. `'on'` always
   *  reduces motion (animations and transitions become instant);
   *  `'off'` always plays full motion even if the OS asked for
   *  reduced. Resolved into a `data-motion` attribute on the
   *  document root; CSS rules in `style.css` consume it. */
  reduceMotion: 'auto' | 'on' | 'off';
  /** Accessibility: when true, the text cursor doesn't blink — the
   *  native blinking caret is hidden and a steady custom caret is drawn
   *  in its place. */
  disableCursorBlink: boolean;
  /** Windows/Verbatim Flow: when true, the persistent PowerShell host
   *  that talks to Excel is started at app launch, so the first Send to
   *  Flow is fast instead of paying the cold start. */
  flowHostOnLaunch: boolean;
  /** Per-token UI color overrides. Keyed by CSS-variable name
   *  WITHOUT the `--` prefix (e.g. `"pmd-c-accent"`); values are
   *  CSS color strings the user picked in the accessibility
   *  panel. Applied as inline styles on documentElement so they
   *  win over the :root defaults AND over any future preset
   *  (high-contrast, colorblind, dark) that sets the variable
   *  via a body class. Empty by default. */
  customColorOverrides: Record<string, string>;
  /** Whether the navigation pane (outline) is visible in THIS
   *  window. Default on. Toggled via the ribbon's nav-pane
   *  button or the left-edge pull-tab that appears when the pane
   *  is hidden. Transient: not persisted to disk, not propagated
   *  to other windows — each window starts with the pane visible
   *  and the user can hide it independently. */
  navPaneVisible: boolean;
  /** Whether the nav pane styles entries by heading level / type
   *  (default on). When on: top-level headings render bold, lower
   *  levels in lighter weight / size, analytic entries in the
   *  analytic-blue accent. When off: every entry renders in the
   *  same weight, size, and color — only indentation conveys
   *  hierarchy. Display-only; doesn't touch the underlying doc.
   *  Symmetric in single-doc and multi-pane layouts. */
  formatNavPaneByType: boolean;
  /** Built-in countdown timer settings. (Panel visibility lives
   *  in `timer-state.ts`, not here — shared via BroadcastChannel
   *  so toggling the timer on in one window opens it in every
   *  other open window too. Settings here are configuration, not
   *  per-window UI state.) */
  /** Currently-active timer profile. All three profiles are
   *  user-customizable (see `timerProfiles`); there's no
   *  separate "custom" — edits go straight to the active
   *  profile's saved slot. */
  timerProfile: 'highSchool' | 'college' | 'pomodoro';
  /** Per-profile saved durations. Picking a profile loads its
   *  speech-preset triple + prep total into the live settings
   *  (`timerSpeechPresets` / `timerPrepMinutes`); editing a
   *  value updates BOTH the live setting AND the active
   *  profile's saved slot here. Defaults match each profile's
   *  conventional values: High school 3/5/8 + 8 prep, College
   *  3/6/9 + 10 prep, Pomodoro 25/15/5 + 0 prep. */
  timerProfiles: Record<'highSchool' | 'college' | 'pomodoro', {
    speechPresets: number[];
    prepMinutes: number;
  }>;
  /** The active profile's speech-preset triple, lifted to the
   *  top level so the timer state + UI read it from one
   *  predictable spot instead of indexing into
   *  `timerProfiles[timerProfile]`. */
  timerSpeechPresets: number[];
  /** Per-side prep total in minutes. Reset refills both prep
   *  clocks to this value. */
  timerPrepMinutes: number;
  /** When the speech timer's remaining time crosses one of the
   *  configured `timerFlashSeconds`, the display flashes red.
   *  Off → no flashing regardless of remaining. */
  timerFlashEnabled: boolean;
  /** Remaining-time thresholds (in seconds) at which the display
   *  flashes red when `timerFlashEnabled` is on. Default 5/3/1. */
  timerFlashSeconds: number[];
  /** Compact layout: drops the 9/6/3 preset column and stacks
   *  Reset under Start/Pause. */
  timerCompact: boolean;
  /** How to label the Aff / Neg prep buttons:
   *    'text'  → "A: 10:00" / "N: 10:00", no special color
   *    'color' → "10:00" / "10:00", blue + red border
   *    'both'  → "A: 10:00" / "N: 10:00", blue + red (default)
   *  Color-blind users can pick 'text'; minimalist users can pick
   *  'color' to drop the redundant A:/N: prefix. */
  timerPrepLabel: 'text' | 'color' | 'both';
  /** When read mode is toggled (either direction), scroll the
   *  editor to the very top of the doc and place the cursor at
   *  the start. Default off — toggling read mode keeps the
   *  viewport / cursor where they were. */
  jumpToDocTopOnReadModeToggle: boolean;
  /** Whether the find bar's "results list" expansion panel (the
   *  scrollable box of matches-in-context below the bar) starts
   *  open on the next find session. Mirrors the user's last
   *  toggle of the chevron button — defaults false so the bar
   *  opens compact unless the user expanded it last. */
  findResultsExpanded: boolean;
  /** Whether the find bar pre-fills its input with the user's
   *  last search query when reopened. When off, the bar opens
   *  empty (or with the current selection, if any, as the seed).
   *  When on (default), a non-empty selection still wins over the
   *  remembered query — matches Word's behavior. */
  findRememberLastQuery: boolean;
  /** The user's last find-bar query — empty string when none has
   *  been entered yet. Persisted only when `findRememberLastQuery`
   *  is on; capped to a sane length so the settings blob doesn't
   *  grow unbounded if a user pastes massive strings. */
  findLastQuery: string;
  /** Priority order for the categorized find sort (Ctrl-F). Each
   *  match falls into one of four categories — `heading` (pocket /
   *  hat / block), `tag`, `cite`, `other` — and the find bar's
   *  Next steps through matches in this order, with cursor-as-top
   *  proximity within each category. Must be a permutation of the
   *  four category names. Alt-F ignores this setting (proximity
   *  only). */
  findCategoryOrder: ('heading' | 'tag' | 'analytic' | 'undertag' | 'cite' | 'other')[];
  /** Whether "New Speech Document" seeds the doc with a Pocket
   *  heading carrying the speech's name. On (default) matches
   *  Verbatim's `NewSpeech`. Off creates a fully blank doc — one
   *  empty paragraph — for users who'd rather title their speeches
   *  inline. */
  includeSpeechDocPocket: boolean;
  /** Whether to show the cite preview on hover in the nav pane. */
  showCitePreview: boolean;
  /** Show a red dot on the ribbon's Manage Flashcards button when one or
   *  more flashcards are due for review today. On by default. */
  flashcardDueDot: boolean;
  /** Spellcheck the editor (custom viewport-scoped checker — see
   *  `viewport-spellcheck.ts`). Underlines misspellings in the visible
   *  document, including text in opened files (not just what you type);
   *  right-click a flagged word for suggestions, Add to Dictionary, or
   *  Ignore. Off by default because debate evidence (author names,
   *  jargon) produces many false positives. */
  editorSpellcheck: boolean;
  /** Microphone for voice control (MediaDeviceInfo.deviceId).
   *  Empty string = system default. Desktop only. */
  voiceInputDeviceId: string;
  /** Idle seconds before the voice session auto-sleeps. 0 disables. */
  voiceAutoSleepSeconds: number;
  /** Glyph the bare spoken word "dash" inserts during dictation.
   *  Explicit names (hyphen, m dash, …) always bypass this. */
  voiceDashStyle:
    | 'em' | 'em-spaced' | 'en' | 'en-spaced' | 'hyphen' | 'hyphen-spaced'
    | 'double' | 'double-spaced' | 'triple' | 'triple-spaced';
  /** Dictation decode model: shipped standard, or the opt-in large
   *  download (better general-English accuracy; ~5 GB RAM). */
  voiceDictationModel: 'standard' | 'large';
  /** Whether autosave is on. When true, doc-changing edits schedule
   *  a background write-back to the file's existing on-disk
   *  location, debounced by ~5s of idle. Only fires for `.cmir`
   *  documents (native format serialization is cheap); `.docx`
   *  files are skipped because `toDocx` is expensive enough that
   *  per-keystroke autosaves would visibly stutter the editor. */
  autosaveEnabled: boolean;
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
  /** Chrome (page) zoom for the whole window, as a percentage
   *  (50–200, step 10). Wired to Chromium's `webFrame.setZoom-
   *  Factor` on Electron, which reflows the page exactly the
   *  way the browser's built-in Ctrl-+ chord does — chrome AND
   *  doc content both scale uniformly. Stacks multiplicatively
   *  with `zoomPct`: if the doc looks too big at a higher
   *  chromeScalePct, dial `zoomPct` down to compensate. No-op
   *  on the web edition (use the browser's own page-zoom). */
  chromeScalePct: number;
  /** Zoom the editor with a trackpad pinch or Ctrl+mouse-wheel. Off by
   *  default. Both gestures arrive as the same event (Chromium delivers a
   *  trackpad pinch as a `wheel` with `ctrlKey`), so this one toggle
   *  governs both. Adjusts `zoomPct` (the document zoom), in 10% steps,
   *  and suppresses Chromium's own native page-zoom on the gesture. */
  gestureZoom: boolean;
  /**
   * Readers used for read-time estimates. The full list shows up in the
   * Word Count Selection function (Ctrl+F11). The first two readers are
   * also displayed in the bottom status bar live.
   */
  readers: ReaderConfig[];
  /**
   * When on, the status-bar read-time / word counter updates live as
   * you change the selection (showing the selection's read time). Off
   * by default: the counter then always reflects the whole doc, and a
   * selection's read time is available on demand via the Word Count
   * button. Live updates re-count on every selection change, which is
   * O(selection) work per drag tick — opt-in so users on very large
   * docs don't pay it.
   */
  liveSelectionWordCount: boolean;
  /**
   * Per-style font sizes (in points). See DisplaySizes for details.
   * Each field becomes a CSS custom property on `#editor`.
   */
  displaySizes: DisplaySizes;
  /** Per-style paragraph spacing (top/bottom margins) in points. A
   *  display override applied via CSS variables, like line spacing. */
  displayParagraphSpacing: DisplayParagraphSpacing;
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
   * What to show in ribbon tooltips. Four modes:
   *   - `none`      — no tooltips on any ribbon button.
   *   - `tooltip`   — label only (e.g., "Apply Tag Style"). Dropdown
   *                   menu items get NO tooltip (the menu item label
   *                   already states what it does).
   *   - `shortcut`  — only the current keyboard shortcut (e.g., "F7").
   *                   Buttons / items without a shortcut get no tooltip.
   *   - `both`      — label + shortcut (e.g., "Apply Tag Style (F7)").
   *                   Dropdown items still show shortcut-only because
   *                   their label is already in the menu.
   */
  ribbonTooltipMode: 'none' | 'tooltip' | 'shortcut' | 'both';
  /** Whether the cross-window dropzone pill (the floating shelf in
   *  the editor's bottom-left corner) is visible. The shelf state still
   *  works when off (Ctrl+\` sends, content is reachable from the
   *  next window opened); the pill is just hidden from the chrome. */
  showDropzonePill: boolean;
  /** Whether the Quick Cards ribbon cluster (the 2×2 stack: command bar, tag
   *  picker, manage, add) is shown in the chrome. Off by default. Quick cards
   *  still work when hidden — the store and commands stay live, and the command
   *  bar still opens via its keyboard shortcut. */
  showQuickCardButtons: boolean;
  /** Folders for the command-palette file search (the `f` prefix). Each is
   *  searched recursively for `.cmir`/`.docx` files on demand; folders that
   *  overlap are fine — a file found under more than one is searched once.
   *  Empty list disables file search. Electron only. */
  fileSearchRoots: string[];
  /** Which file formats appear in the command-palette file search:
   *  'both' (default), 'cmir' only, or 'docx' only. */
  fileSearchFormats: 'both' | 'cmir' | 'docx';
  /** Which structural objects appear when searching within a file
   *  (`f` → Tab). Subset of pocket/hat/block/tag/cite/analytic;
   *  defaults to block/tag/cite. Stored as kind strings. */
  fileSearchObjectTypes: string[];
  /** How deep the file-search outline browse is expanded by default
   *  (1 Pocket … 4 Tag) — headings at this level or deeper start
   *  collapsed, so depth 3 (default) shows blocks with their tags
   *  collapsed. Mirrors the nav pane's `navMaxLevel`. */
  fileSearchOutlineDepth: number;
  /** Whether file search auto-pins recent + frequently-used files
   *  (keeping them warm for instant dives). Default on; turn off to
   *  warm only files pinned by hand (for memory-sensitive users). */
  pinAutoEnabled: boolean;
  /**
   * User-interface font family. Applied as `--pmd-ui-font` on
   * documentElement; flows into every UI surface (ribbon, dialogs,
   * nav pane, comments column, etc.). Empty string keeps the
   * stylesheet's system-UI default — distinct from `bodyFont`,
   * which is the editor-content font.
   */
  uiFont: string;
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
  /** When on, the Extract Undertag command wraps the excerpt it pulls
   *  into a new undertag in double quotes. Off by default. */
  extractUndertagInQuotes: boolean;
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
  /** Which gaps the formatting-gap bridge treats as bridgeable: 'both'
   *  (whitespace and punctuation) or 'whitespace' (whitespace only). Feeds both
   *  the auto-bridge and the manual Fix Formatting Gaps command. */
  formattingGapClass: FormattingGapClass;
  /** When on (default), applying a formatting mark auto-bridges the gaps at the
   *  edges of what changed to an adjacent same-formatted word. Off disables only
   *  the auto-bridge — the manual Fix Formatting Gaps command still runs. */
  autoBridgeFormattingGaps: boolean;
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
  /** When true, "Create Reference" (Card menu) emits its body text
   *  in Gray-50% (#808080) instead of black. Heading line stays
   *  black either way. */
  forReferenceUseGray50: boolean;
  /** When true, Shrink (Mod-8) treats bracketed "Omitted" spans AND
   *  the `[PARAGRAPH INTEGRITY PAUSES/RESUMES]` markers emitted by
   *  "Condense with warning" specially: their existing size is
   *  excluded from the cycle decision, and after the size pass they're
   *  restored to Normal so they remain visible in the shrunken output.
   *  When off, both are shrunk along with the surrounding text. */
  shrinkRestoresOmissionsToNormal: boolean;
  /**
   * Delimiter family for "Condense with warning". One of the six
   * bracket pairs (which produce `<open>PARAGRAPH INTEGRITY
   * PAUSES<close>` / `…RESUMES<close>`) or `'custom'` (which uses
   * the user-typed marker strings below in place of the entire
   * marker text). Default `[` matches the most common convention in
   * user docs.
   */
  condenseWarningDelimiter: CondenseWarningDelimiter;
  /** When `condenseWarningDelimiter` is `'custom'`, this string is
   *  inserted verbatim as the pause-marker paragraph (replacing the
   *  entire `[PARAGRAPH INTEGRITY PAUSES]` text). Empty string
   *  disables the command (it no-ops with a console warn). */
  condenseWarningCustomPauseMarker: string;
  /** Companion to `condenseWarningCustomPauseMarker` — inserted as
   *  the resume-marker paragraph. */
  condenseWarningCustomResumeMarker: string;
  /**
   * User-supplied strings (or regexes) that Shrink should treat as
   * protected — same pipeline as the built-in bracketed-Omitted
   * patterns and the PARAGRAPH INTEGRITY PAUSES/RESUMES markers. The
   * whole list is gated by `shrinkRestoresOmissionsToNormal`. Each
   * entry: a string and an `isRegex` flag. When false, the string is
   * regex-escaped and matched case-insensitively. When true, it's
   * compiled as a regex source verbatim (still with `gi` flags).
   * Invalid regex sources are silently dropped at compile time.
   */
  shrinkCustomProtections: ShrinkProtection[];
  /**
   * User-supplied overrides for ribbon-command key bindings. Each
   * entry maps a `RibbonCommandId` to its custom key spec — either a
   * single key string (e.g. `'F8'`, `'Mod-Shift-7'`) or an array for
   * multi-binding commands (e.g. `['F9', 'Mod-u']`). An empty string
   * or empty array means "explicitly unbound" (the command exists in
   * the menu / ribbon but has no key). Commands not present in this
   * map fall back to `DEFAULT_RIBBON_KEYS`.
   */
  ribbonKeyOverrides: Partial<Record<RibbonCommandId, string | string[]>>;
  /** User-defined "press a key → type this text" macros. */
  keyboardMacros: KeyboardMacro[];
  /** Display name attached to new comments authored locally. */
  commentAuthor: string;
  /** Initials attached to new comments authored locally (Word shows
   *  these in the margin badge). Auto-derived from `commentAuthor`
   *  if left empty. */
  commentAuthorInitials: string;
  /** Whether the right-side comments column is currently visible.
   *  Toggled by the comments-show-hide ribbon button; persisted so
   *  the editor remembers the last state. */
  commentsVisible: boolean;
  /** Anthropic API key for AI features. Empty until the user sets
   *  one. Stored locally; never sent anywhere except direct calls
   *  to the Anthropic API. */
  anthropicApiKey: string;
  /** Optional override for the Claude model id used by every AI feature.
   *  Empty (or malformed) falls back to the app's built-in default; a
   *  well-formed id is sent as-is. Lets a user move to a newer model
   *  without updating the whole app when the default is retired. */
  aiModelOverride: string;
  /** Master switch for AI features (the explainer comment shortcut,
   *  @AI mentions inside comments, etc.). When false, no UI for
   *  AI shows up and no API calls happen even if a key is set. */
  aiFeaturesEnabled: boolean;
  /** Friendlier "Clod" persona for the AI in-flight indicator —
   *  while the model is composing a reply, the placeholder cycles
   *  through time-of-day Clod activities ("Clod is making toast…").
   *  Off by default; the easter-egg configurator (shift+right-click
   *  on the toggle in Settings) opens a dialog to customize the
   *  activity pools per time period. */
  clodEnabled: boolean;
  /** Per-time-period activity override pools. Empty arrays fall
   *  back to the built-in lists in `src/editor/ai/clod.ts`. */
  clodActivitiesByTime: {
    morning: string[];
    day: string[];
    evening: string[];
    night: string[];
  };
  /** Hour boundaries (0-23) for each Clod time period. Periods may
   *  cross midnight (start > end), which is normal for "night". */
  clodTimePeriods: {
    morning: { start: number; end: number };
    day: { start: number; end: number };
    evening: { start: number; end: number };
    night: { start: number; end: number };
  };
  /** Display name for the AI persona — drives the comment author
   *  name (when Clod mode is on), the in-flight activity text
   *  (substituted into the built-in "Clod is …" templates), and the
   *  AI button tooltip. Default: "Clod". */
  aiPersonaName: string;
  /** Pronoun set used to template the built-in Clod activities.
   *  `'custom'` reads from `aiPersonaCustomPronouns`. */
  aiPersonaPronouns: 'he' | 'she' | 'they' | 'it' | 'custom';
  /** Used only when `aiPersonaPronouns === 'custom'`. */
  aiPersonaCustomPronouns: {
    subject: string;
    object: string;
    possessive: string;
    reflexive: string;
  };
  /** System prompt for the AI cite creator. Editable via the
   *  Settings dialog's "Edit prompt" modal — long enough that a
   *  full textarea makes more sense than an inline input. Empty
   *  string falls back to `DEFAULT_AI_CITE_PROMPT`. */
  aiCitePrompt: string;
  /** Translator backend. `'auto'` uses Anthropic when AI features are
   *  ready, otherwise MyMemory. `'mymemory'` (no key, works with AI off),
   *  `'anthropic'` (needs AI features), `'google'` (needs an API key). */
  translationProvider: 'auto' | 'mymemory' | 'anthropic' | 'google';
  /** Target language for translation (ISO 639-1). Default `'en'`. */
  translationTargetLang: string;
  /** Source language for translation (ISO 639-1), or `'auto'` to detect.
   *  MyMemory needs a concrete source, so on `'auto'` we detect locally
   *  (tinyld) first; Anthropic / Google detect server-side. */
  translationSourceLang: string;
  /** Optional email for MyMemory — raises its free daily char limit. */
  myMemoryEmail: string;
  /** Google Cloud Translation API key (only used by the `'google'`
   *  backend). Stored locally; sent only to translation.googleapis.com. */
  googleTranslateApiKey: string;
  /** When on, the Translator prepends a `[TRANSLATION BY <attribution>]`
   *  marker line (wrapped in the "Condense with warning" delimiter) to the
   *  clipboard output — the attribution is the model for Anthropic,
   *  MYMEMORY for MyMemory, or GOOGLE TRANSLATE for Google. */
  prependTranslationMarker: boolean;
  /** Master switch for the multi-doc workspace shell — three slots,
   *  each holding a stack of 0+ docs. Toggling this requires a
   *  page reload to (re)build the editor shell. Comments are
   *  unavailable while this is on. See SPEC-multi-pane.md. */
  multiDocWorkspace: boolean;
  /** Which UI shell the web edition uses on this device. `'auto'`
   *  picks the mobile shell on coarse-pointer screens narrower than
   *  1024px (resolved once per load — rotating mid-session doesn't
   *  thrash the shell); `'mobile'` / `'desktop'` force it. The
   *  mobile shell is view-first: no on-screen keyboard, reading +
   *  outline navigation + crude structural moves. See
   *  SPEC-mobile-view.md. */
  mobileLayout: 'auto' | 'mobile' | 'desktop';
  /** When `multiDocWorkspace` is on and three slots are populated:
   *  `compact` shows all three panes side by side; `wide` widens
   *  each pane and lets the user paged-scroll between them
   *  (2 full + edge of 3rd visible). With 1 or 2 active slots the
   *  two modes render identically. */
  multiDocLayoutMode: 'compact' | 'wide';
  /** Quick Cards: tags currently active in the search-palette filter
   *  (edited by the Tag Picker). Empty = no filter (all cards in
   *  scope); non-empty scopes search to cards with >=1 active tag.
   *  Untagged cards are always in scope. Stored normalized
   *  (lowercased). Global + persisted. */
  quickCardActiveTags: string[];
  /** Master switch for the experimental AI card-cutter. Hidden and
   *  OFF by default; flipped on only via the console command
   *  `window.__cardcutter('on')`. When on, the card-cutter ribbon
   *  commands + shortcuts activate and the Card Cutter settings tab
   *  appears (with a Disable button that flips this back off). The
   *  cutting logic itself lives in the separately-versioned
   *  @cardmirror/card-cutter package, loaded dev-only. */
  cardCutterEnabled: boolean;
  /** Card-cutter: absolute path to the engine bundle to load (packaged
   *  builds only). Empty = use CARDCUTTER_ENGINE env or the default
   *  userData/plugins/cardcutter.global.js location. */
  cardCutterEnginePath: string;
  /** Card-cutter: emphasis style — a persistent AUTHOR fingerprint
   *  (not inferred from the file). `voice` = emphasis is the content
   *  tier inside highlights; `independent` = emphasis marks rhetorical
   *  hammers regardless of the spoken cut; `minimal` = sparse. */
  cardCutterEmphasisStyle: 'voice' | 'independent' | 'minimal';
  /** Card-cutter: default highlighted-read length, in seconds at the
   *  user's reader WPM. The budget knob; ~12s ≈ 64 words @ 350 wpm. */
  cardCutterReadTimeSec: number;
  /** Card-cutter: acronym letter-splitting (off by default — real but
   *  inconsistent in human cuts and the highest garble risk). */
  cardCutterAcronymSplitting: 'off' | 'conservative' | 'aggressive';
  /** Card-cutter: word-internal morphology shaving ("regs", "Dems";
   *  off by default — useful but riskiest). */
  cardCutterMorphologyShaving: boolean;
  /** Card-cutter: when the model may pose a clarifying question. */
  cardCutterClarifyingQuestions: 'when-ambiguous' | 'always' | 'never';
  /** Pairing: master switch for cross-machine card sharing (the send /
   *  receive pills + the background poller). Off by default. Desktop only
   *  for v1. */
  pairingEnabled: boolean;
  /** Pairing: how often (seconds) this machine polls the relay for
   *  incoming cards. Clamped to [5, 3600]; default 30. */
  pairingPollSeconds: number;
  /** Pairing: this machine's own shareable code — its relay address.
   *  Generated once (lazily on first enable) and shown in settings with
   *  Copy / Regenerate. Share it with a partner so they can send to you. */
  pairingOwnCode: string;
  /** Pairing: optional human name this machine stamps on outgoing cards,
   *  so a partner who hasn't nicknamed you yet still sees a readable
   *  sender. Empty falls back to the short code on the receiver. */
  pairingDisplayName: string;
  /** Pairing: machines you can send to (their code + your nickname). */
  pairingPartners: PairingPartner[];
  /** Pairing: named groups of partners for one-drop fan-out sends. */
  pairingGroups: PairingGroup[];
  /** Pairing: the single starred send target — a partner (by code) or a group
   *  (by id) — that the "Send to Starred" shortcut sends to. null when nothing is
   *  starred. Sanitize clears it if it no longer points at a live recipient. */
  pairingStarred: { kind: 'partner' | 'group'; ref: string } | null;
  /** Pairing: how the receive pill flashes when a card arrives. */
  pairingReceiveFlash: PairingReceiveFlash;
  /** Clean: style names the .docx style cleaner must never prune, remove, or
   *  reassign away from (their basedOn/linked dependencies are kept too).
   *  Managed from the Clean utility's protected-styles panel. */
  cleanProtectedStyles: string[];
}

/** Open-delimiter options for "Condense with warning" markers. The
 *  six built-ins use mirror-pair closers via `condenseWarningCloseFor`;
 *  `'custom'` reads the close string from `condenseWarningCustomClose`. */
export type CondenseWarningDelimiter =
  | '[' | '[[' | '<' | '<<' | '{' | '{{' | 'custom';
const CONDENSE_WARNING_DELIMITERS: CondenseWarningDelimiter[] = [
  '[', '[[', '<', '<<', '{', '{{', 'custom',
];

/** Return the mirror close for a built-in open. Throws on 'custom'
 *  (callers should branch on the enum first and read the user-typed
 *  close string from settings instead). */
export function condenseWarningCloseFor(d: CondenseWarningDelimiter): string {
  switch (d) {
    case '[': return ']';
    case '[[': return ']]';
    case '<': return '>';
    case '<<': return '>>';
    case '{': return '}';
    case '{{': return '}}';
    case 'custom':
      throw new Error("condenseWarningCloseFor: 'custom' has no mirror — read from settings");
  }
}

/** User-supplied shrink protection rule. `pattern` is treated as a
 *  literal string by default (escaped, matched case-insensitively
 *  with `i` flag, like the built-in omission patterns) or as a raw
 *  regex source when `isRegex` is true. Invalid regex sources are
 *  silently dropped at compile time. */
export interface ShrinkProtection {
  pattern: string;
  isRegex: boolean;
}

export type HeadingMode = 'strict' | 'respect' | 'demolish';
const HEADING_MODES: HeadingMode[] = ['strict', 'respect', 'demolish'];

/** Which gaps the formatting-gap bridge treats as bridgeable. */
export type FormattingGapClass = 'both' | 'whitespace';
const FORMATTING_GAP_CLASSES: FormattingGapClass[] = ['both', 'whitespace'];

export type FormattingPanelMode = 'labels' | 'shortcuts' | 'both' | 'hidden';
const FORMATTING_PANEL_MODES: FormattingPanelMode[] = ['labels', 'shortcuts', 'both', 'hidden'];

export const VOICE_DASH_STYLES: ReadonlyArray<Settings['voiceDashStyle']> = [
  'em', 'em-spaced', 'en', 'en-spaced', 'hyphen', 'hyphen-spaced',
  'double', 'double-spaced', 'triple', 'triple-spaced',
];

const DEFAULTS: Settings = {
  navWidth: 300,
  navMaxLevel: 3,
  showOnboardingStarter: true,
  defaultSpeechDocFolder: '',
  defaultSpeechDocFormat: 'docx',
  defaultSaveFormat: 'docx',
  prefixPresetSaveFilenames: true,
  sendDocDestination: 'sameFolder',
  sendDocFolder: '',
  theme: 'system',
  themeAppliesToDocument: false,
  iconSet: 'modern',
  showDocNameChip: false,
  checkForUpdatesOnLaunch: false,
  commentsColumnWidth: 320,
  reduceMotion: 'auto',
  disableCursorBlink: false,
  flowHostOnLaunch: false,
  overrideHighlightColor: false,
  overrideHighlightSlots: ['#ffff00'],
  overrideShadingColor: false,
  overrideShadingSlots: ['#d2d2d2'],
  customColorOverrides: {},
  navPaneVisible: true,
  formatNavPaneByType: true,
  timerProfile: 'college',
  timerProfiles: {
    highSchool: { speechPresets: [3, 5, 8], prepMinutes: 8 },
    college: { speechPresets: [3, 6, 9], prepMinutes: 10 },
    pomodoro: { speechPresets: [25, 15, 5], prepMinutes: 0 },
  },
  timerSpeechPresets: [3, 6, 9],
  timerPrepMinutes: 10,
  timerFlashEnabled: true,
  timerFlashSeconds: [5, 3, 1],
  timerCompact: false,
  timerPrepLabel: 'both',
  jumpToDocTopOnReadModeToggle: false,
  findResultsExpanded: false,
  findRememberLastQuery: false,
  findLastQuery: '',
  findCategoryOrder: ['heading', 'tag', 'analytic', 'undertag', 'cite', 'other'],
  includeSpeechDocPocket: true,
  showCitePreview: true,
  flashcardDueDot: true,
  editorSpellcheck: false,
  voiceInputDeviceId: '',
  voiceAutoSleepSeconds: 60,
  voiceDashStyle: 'em',
  voiceDictationModel: 'standard',
  // Default OFF — autosave is meaningful only when the user has
  // saved at least once (so we have a handle) AND the doc is in
  // .cmir format. We let the user opt in via the ribbon toggle
  // rather than silently saving in the background.
  autosaveEnabled: false,
  readMode: false,
  hideEmphasisBordersInReadMode: false,
  zoomPct: 100,
  chromeScalePct: 100,
  gestureZoom: false,
  readers: [
    { name: 'Reader 1', wpm: 200 },
    { name: 'Reader 2', wpm: 250 },
  ],
  liveSelectionWordCount: false,
  displaySizes: { ...DEFAULT_DISPLAY_SIZES },
  displayParagraphSpacing: { ...DEFAULT_PARAGRAPH_SPACING },
  displayTypography: { ...DEFAULT_DISPLAY_TYPOGRAPHY },
  displayColors: { ...DEFAULT_DISPLAY_COLORS },
  bodyFont: 'Times New Roman',
  uiFont: '',
  ribbonTooltipMode: 'both',
  showDropzonePill: false,
  showQuickCardButtons: false,
  fileSearchRoots: [],
  fileSearchFormats: 'both',
  fileSearchObjectTypes: ['block', 'tag'],
  fileSearchOutlineDepth: 3,
  pinAutoEnabled: true,
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
  extractUndertagInQuotes: false,
  headingMode: 'respect',
  condenseOnPaste: false,
  formattingGapClass: 'both',
  autoBridgeFormattingGaps: true,
  clearFormattingOnNamedStyleToggleOff: true,
  forReferenceUseGray50: false,
  shrinkRestoresOmissionsToNormal: false,
  condenseWarningDelimiter: '[',
  condenseWarningCustomPauseMarker: '',
  condenseWarningCustomResumeMarker: '',
  shrinkCustomProtections: [],
  ribbonKeyOverrides: {},
  keyboardMacros: [],
  commentAuthor: 'You',
  commentAuthorInitials: '',
  commentsVisible: false,
  anthropicApiKey: '',
  aiModelOverride: '',
  aiFeaturesEnabled: false,
  clodEnabled: false,
  clodActivitiesByTime: { morning: [], day: [], evening: [], night: [] },
  clodTimePeriods: {
    morning: { start: 5, end: 9 },
    day: { start: 9, end: 20 },
    evening: { start: 20, end: 23 },
    night: { start: 23, end: 5 },
  },
  aiPersonaName: 'Clod',
  aiPersonaPronouns: 'he',
  aiPersonaCustomPronouns: {
    subject: 'they',
    object: 'them',
    possessive: 'their',
    reflexive: 'themself',
  },
  aiCitePrompt: '',
  translationProvider: 'auto',
  translationTargetLang: 'en',
  translationSourceLang: 'auto',
  myMemoryEmail: '',
  googleTranslateApiKey: '',
  prependTranslationMarker: true,
  multiDocWorkspace: false,
  mobileLayout: 'auto',
  multiDocLayoutMode: 'compact',
  quickCardActiveTags: [],
  cardCutterEnabled: false,
  cardCutterEnginePath: '',
  cardCutterEmphasisStyle: 'voice',
  cardCutterReadTimeSec: 12,
  cardCutterAcronymSplitting: 'off',
  cardCutterMorphologyShaving: false,
  cardCutterClarifyingQuestions: 'when-ambiguous',
  pairingEnabled: false,
  pairingPollSeconds: 30,
  pairingOwnCode: '',
  pairingDisplayName: '',
  pairingPartners: [],
  pairingGroups: [],
  pairingStarred: null,
  pairingReceiveFlash: 'once',
  cleanProtectedStyles: [],
};

/** Public read-only view of the built-in defaults — handy for any UI
 *  that wants a "Restore defaults" button. */
export const SETTINGS_DEFAULTS: Readonly<Settings> = DEFAULTS;

/**
 * Tabs in the settings dialog. Each setting carries a `category`
 * and is rendered under the matching tab. Order here is the tab
 * order in the dialog.
 */
export type SettingsCategory =
  | 'general'
  | 'appearance'
  | 'accessibility'
  | 'editing'
  | 'shortcuts'
  | 'comments-ai'
  | 'pairing';

/**
 * Human-readable metadata for each setting, used by the settings UI.
 * Add new entries when introducing new settings.
 */
export interface SettingMeta {
  key: keyof Settings;
  label: string;
  description?: string;
  /** Optional dynamic description that takes precedence over
   *  `description` at render time. Used by entries whose copy needs
   *  to vary by host capability (e.g. the workspace-layout entry,
   *  which describes window-spawning differently on Electron vs
   *  web). */
  descriptionFn?: () => string;
  /** Settings UI hint: how should this be rendered? */
  kind:
    | 'toggle'
    | 'number'
    | 'level'
    | 'readers'
    | 'displaySizes'
    | 'paragraphSpacing'
    | 'displayTypography'
    | 'displayColors'
    | 'bodyFont'
    | 'uiFont'
    | 'ribbonTooltipMode'
    | 'lineHeights'
    | 'formattingPanelMode'
    | 'headingMode'
    | 'condenseWarningDelimiter'
    | 'shrinkCustomProtections'
    | 'keybindings'
    | 'text'
    | 'folder'
    | 'folderList'
    | 'fileSearchFormats'
    | 'fileSearchObjectTypes'
    | 'fileSearchOutlineDepth'
    | 'speechDocFormat'
    | 'saveFormat'
    | 'formattingGapClass'
    | 'sendDocDestination'
    | 'findCategoryOrder'
    | 'color'
    | 'colorSlots'
    | 'colorOverrides'
    | 'theme'
    | 'iconSet'
    | 'reduceMotion'
    | 'timerProfile'
    | 'timerProfileDurations'
    | 'timerPrepLabel'
    | 'password'
    | 'voiceInputDevice'
    | 'voiceDashStyle'
    | 'voiceDictationModel'
    | 'clod'
    | 'clodCustomize'
    | 'aiCitePrompt'
    | 'translationConfig'
    | 'multiDocLayoutMode'
    | 'mobileLayout'
    | 'cardCutterEmphasisStyle'
    | 'cardCutterAcronymSplitting'
    | 'cardCutterClarifyingQuestions'
    | 'cardCutterEnginePath'
    | 'cardCutterDisable'
    | 'pairingOwnCode'
    | 'pairingPartners'
    | 'pairingGroups'
    | 'pairingReceiveFlash';
  /** Which tab this setting lives under in the settings dialog. */
  category: SettingsCategory;
  /** When set, this row is greyed out and its controls disabled
   *  unless the named boolean setting evaluates to true. Used for
   *  e.g. greying out the multi-doc layout picker when multi-doc is
   *  off, or AI-key rows when AI features are disabled. */
  dependsOn?: keyof Settings;
  /** When true, this setting is only relevant on Electron-style
   *  hosts (real file paths, native dialogs). The settings UI
   *  hides the row entirely on the web edition. */
  electronOnly?: boolean;
  /** When true, this setting is only relevant on the Windows desktop
   *  (the Verbatim Flow COM bridge). Hidden everywhere else. */
  windowsOnly?: boolean;
  /** When true, this setting is only relevant on the web edition
   *  (browser host). The settings UI hides the row on Electron. */
  webOnly?: boolean;
  /** When true, the row also appears in the MOBILE settings page.
   *  Explicit opt-in (default false) so editing- and desktop-shaped
   *  settings can never leak onto phones by omission. The desktop
   *  dialog ignores this flag. */
  mobile?: boolean;
  /** When true, the command palette's settings search never lists
   *  this row — for niche bootstrapping settings (e.g. the mobile
   *  layout choice) that would be noise next to real commands. The
   *  settings dialog still shows it. */
  searchHidden?: boolean;
  /** When set, the row only renders while this boolean setting is on.
   *  Used to hide the console-gated card-cutter rows until enabled. */
  revealWhen?: keyof Settings;
  /** Extra search terms for the command palette. The label often
   *  uses one name for a thing the user might search by another
   *  ("Theme" vs "dark mode", "Line spacing" vs "line height"); these
   *  let those queries surface the row. Match-only — never displayed.
   *  Keep them lowercase. */
  aliases?: readonly string[];
}

export const SETTING_METADATA: SettingMeta[] = [
  // ─── General ────────────────────────────────────────────────────
  {
    key: 'readers',
    label: 'Readers for read-time estimates',
    description:
      'Each reader has a name and a words-per-minute rate. The first two are displayed live in the bottom bar; all show up in the Word Count Selection dialog.',
    kind: 'readers',
    category: 'general',
    mobile: true,
  },
  {
    key: 'liveSelectionWordCount',
    label: 'Live word count for the current selection',
    description:
      "Off by default. When on, the bottom bar's word count / read time updates the moment you change the selection, showing the selection's read time. Off keeps the bar on the whole-doc count — use the Word Count button (Σ) for a selection's read time on demand. Live updates re-count on every selection change, so leave this off on very large documents if you notice drag lag.",
    kind: 'toggle',
    category: 'general',
  },
  {
    key: 'voiceInputDeviceId',
    label: 'Voice control microphone',
    description:
      'Which microphone the voice session (Ctrl-Shift-V) listens to. "System default" follows the OS setting. Device names appear after the first voice session grants microphone access. Desktop only.',
    kind: 'voiceInputDevice',
    category: 'accessibility',
  },
  {
    key: 'voiceAutoSleepSeconds',
    label: 'Voice auto-sleep (seconds)',
    description:
      'How long the voice session can sit idle before it parks itself asleep, so a forgotten mic doesn\'t eat a conversation. The status pill dims during the last ten seconds. Say "voice wake" to resume. 0 disables auto-sleep.',
    kind: 'number',
    category: 'accessibility',
  },
  {
    key: 'voiceDashStyle',
    label: 'Spoken "dash" inserts',
    description:
      'The glyph dictated by the bare word "dash". Explicit names always work regardless of this setting: "hyphen", "n dash", "m dash", "double dash", "triple dash", each optionally followed by "spaced".',
    kind: 'voiceDashStyle',
    category: 'accessibility',
  },
  {
    key: 'voiceDictationModel',
    label: 'Dictation accuracy model',
    description:
      'The standard model ships with CardMirror and handles commands and dictation. The large model (a one-time 1.8 GB download, ~5 GB of memory while voice is on) roughly halves dictation word errors on general English — it does not affect commands, targeting, paint, or debate jargon. Takes effect the next time voice starts.',
    kind: 'voiceDictationModel',
    category: 'accessibility',
  },
  {
    key: 'multiDocWorkspace',
    label: 'Three-pane workspace',
    descriptionFn: workspaceLayoutDescription,
    kind: 'toggle',
    category: 'general',
    aliases: ['split view', 'split screen', 'multi pane', 'multi-doc'],
  },
  {
    key: 'multiDocLayoutMode',
    label: 'Multi-doc layout',
    description:
      'When three docs are open, choose compact (all three visible at once, narrow) or wide-scroll (two full panes + edge of third; click the peek to snap). With 1 or 2 docs open, both modes render identically.',
    kind: 'multiDocLayoutMode',
    category: 'general',
    dependsOn: 'multiDocWorkspace',
  },
  {
    key: 'mobileLayout',
    label: 'Layout on this device',
    description:
      'Which layout the web edition uses here. Auto picks the view-first mobile layout on windows narrower than 768px, and up to 1024px on touch screens; Mobile / Desktop force one. Changing this reloads the page.',
    kind: 'mobileLayout',
    category: 'general',
    webOnly: true,
    mobile: true,
    searchHidden: true,
  },
  {
    key: 'showOnboardingStarter',
    label: 'Onboarding doc for new documents',
    description:
      'When on (default), New Document opens the CardMirror welcome doc — the same starter you get the first time you launch. When off, New opens a blank doc with a single empty paragraph. Affects every freshly created doc, including newly spawned windows.',
    kind: 'toggle',
    category: 'general',
  },
  {
    key: 'flowHostOnLaunch',
    label: 'Keep a Verbatim Flow connection warm',
    description:
      'Start the background connection to Excel when CardMirror launches, so your first Send to Flow is fast instead of waiting a second or two for it to spin up. Leave off to start it on demand the first time you use a Flow command (every send after that is fast either way). You can also start it any time with the "Start Flow Connection" command.',
    kind: 'toggle',
    category: 'general',
    windowsOnly: true,
    aliases: ['flow', 'verbatim flow', 'powershell', 'warm', 'prewarm', 'excel'],
  },
  {
    key: 'defaultSpeechDocFolder',
    label: 'Default folder for new speech documents',
    description:
      'When set, "New Speech Document" saves the new doc into this folder by default. Leave empty (the default) to keep the current behavior of leaving the doc unsaved until you explicitly Save / Save As.',
    kind: 'folder',
    category: 'general',
    electronOnly: true,
  },
  {
    key: 'fileSearchRoots',
    label: 'File search folders',
    description:
      'Folders for the command-palette file search (type "f " in the search bar). Each is scanned recursively for .cmir and .docx files. Add as many as you like — overlapping folders are fine; a file found under more than one is searched only once. Leave the list empty to disable file search.',
    kind: 'folderList',
    category: 'general',
    electronOnly: true,
  },
  {
    key: 'fileSearchFormats',
    label: 'File search: file formats to list',
    description:
      'Which document formats appear in the file search results — both .cmir and .docx, or just one. Each result shows its format on its badge.',
    kind: 'fileSearchFormats',
    category: 'general',
    electronOnly: true,
  },
  {
    key: 'fileSearchObjectTypes',
    label: 'File search: objects to find within a file',
    description:
      'After picking a file in the search palette (Tab), which structural objects show up as you search inside it. Inserting one drops the matching card (tag/cite), block section (block/hat/pocket), or analytic unit into your document. Tags are always findable by their citation, so Cite (standalone cite rows) is off by default — turn it on to also list cites on their own.',
    kind: 'fileSearchObjectTypes',
    category: 'general',
    electronOnly: true,
  },
  {
    key: 'fileSearchOutlineDepth',
    label: 'File search: default outline depth',
    description:
      "How far the outline is expanded when you first dive into a file (before typing). Pocket shows only top-level headings; Tag expands everything. Default Block. Right-click any pocket / hat / block in the outline to expand or collapse it.",
    kind: 'fileSearchOutlineDepth',
    category: 'general',
    electronOnly: true,
  },
  {
    key: 'pinAutoEnabled',
    label: 'File search: auto-pin recent & frequent files',
    description:
      "On by default. Keeps your recent and frequently-used .cmir files 'warm' (parsed and held in memory) so diving into them from the search palette is instant. Turn off if you're sensitive to memory use — then only files you pin by hand (★ / Alt+P) are kept warm.",
    kind: 'toggle',
    category: 'general',
    electronOnly: true,
  },
  {
    key: 'defaultSpeechDocFormat',
    label: 'Default format for new speech documents',
    description:
      'Docx is the Verbatim-compatible default — best when you\'re sharing speech docs with teammates who use Verbatim. Picking .cmir enables autosave on the new doc (autosave only fires for .cmir files; the Docx serializer is too expensive to run on a debounce).',
    kind: 'speechDocFormat',
    category: 'general',
  },
  {
    key: 'defaultSaveFormat',
    label: 'Default file format for new documents',
    description:
      'Sets the format the Save-As dialog defaults to for a doc you haven\'t saved before. .docx is the default — Word- and Verbatim-compatible. Pick .cmir to make every new doc save in CardMirror\'s native format (lossless, and the only format that supports autosave). Doesn\'t affect existing files on disk — those always re-save in whatever format they were opened from.',
    kind: 'saveFormat',
    category: 'general',
    mobile: true,
  },
  {
    key: 'prefixPresetSaveFilenames',
    label: 'Prefix preset saves with SEND_ / READ_',
    description:
      'When on (default), the Save As dialog\'s Send Doc and Read Doc presets prepend SEND_ and READ_ to the file name (e.g. SEND_1AC.docx). The As-Is preset and the Save Custom button are never prefixed. Turn off to save presets under the exact name shown in the box.',
    kind: 'toggle',
    category: 'general',
  },
  {
    key: 'sendDocDestination',
    label: 'Send Doc destination',
    description:
      'Where the Save Send Doc command (and its shortcut) writes — a send doc is the document with comments, analytics, and undertags stripped, the same content the Save As dialog\'s Send Doc preset produces. "Same folder as the document" drops it beside the source file; "Fixed folder" always writes into the folder below. Either way, a doc you haven\'t saved yet (same-folder mode) or an unset fixed folder falls back to the normal Save As dialog. The send doc is written in your default new-document format, and prefixed SEND_ when that option is on.',
    kind: 'sendDocDestination',
    category: 'general',
    electronOnly: true,
  },
  {
    key: 'sendDocFolder',
    label: 'Send Doc folder',
    description:
      'Destination folder for Save Send Doc when the destination above is set to "Fixed folder". Leave empty to fall back to the Save As dialog.',
    kind: 'folder',
    category: 'general',
    electronOnly: true,
  },
  {
    key: 'includeSpeechDocPocket',
    label: 'Seed new speech docs with a Pocket heading',
    description:
      'When on (default), New Speech Document opens with a Pocket carrying the speech\'s name (e.g. "Speech 1NC 5-15 9-30AM") at the top. Turn off to start with a fully blank doc — one empty paragraph.',
    kind: 'toggle',
    category: 'general',
  },
  {
    key: 'showCitePreview',
    label: 'Cite preview on hover',
    description:
      'Show the cite-formatted text from a card on the right side of its nav-pane entry when you hover.',
    kind: 'toggle',
    category: 'general',
    aliases: ['hover preview'],
  },
  {
    key: 'flashcardDueDot',
    label: 'Flashcards-due dot',
    description:
      "Show a red dot on the ribbon's Manage Flashcards button when one or more flashcards are due for review today. On by default; turn off if you'd rather not be nudged.",
    kind: 'toggle',
    category: 'general',
    aliases: ['flashcard due', 'review reminder', 'due indicator', 'red dot'],
  },
  {
    key: 'editorSpellcheck',
    label: 'Editor spellcheck',
    description:
      "Underline misspellings in the visible part of the document — including text in files you've opened, not just words you're typing. Right-click a flagged word for suggestions, Add to Dictionary, or Ignore. Off by default: debate evidence (author names, jargon, citations) generates a lot of false-positive squiggles.",
    kind: 'toggle',
    category: 'general',
  },
  {
    key: 'gestureZoom',
    label: 'Pinch / Ctrl+Scroll to zoom',
    description:
      'Zoom the document with a trackpad pinch or Ctrl + mouse-wheel (in 10% steps, same as the zoom buttons and Ctrl-= / Ctrl-- chords). Off by default; enable for pinch / Ctrl-scroll zooming.',
    kind: 'toggle',
    category: 'general',
    aliases: ['gesture zoom', 'pinch zoom', 'ctrl scroll', 'wheel zoom', 'trackpad zoom'],
  },
  {
    key: 'jumpToDocTopOnReadModeToggle',
    label: 'Jump to doc top when read mode toggles',
    description:
      'When on, toggling read mode (in either direction) scrolls to the top of the doc and places the cursor at the start. Off by default — the viewport stays where it was.',
    kind: 'toggle',
    category: 'general',
  },
  {
    key: 'findRememberLastQuery',
    label: 'Find: remember the last search query',
    description:
      "When on, reopening the find bar (Ctrl-F / Ctrl-H / Alt-F) pre-fills the input with whatever you last searched for. Off by default — the bar opens empty so each search is a clean slate.",
    kind: 'toggle',
    category: 'general',
  },
  {
    key: 'findCategoryOrder',
    label: 'Find: category priority order',
    description:
      'Ctrl-F groups search results by which kind of paragraph they appear in, and Next steps through groups in this order. Within each group, the first match is whichever is closest to your cursor (the cursor counts as the top — matches AFTER it come first, then matches before, like wrap-around). Reorder via the up / down buttons. Alt-F ignores this and goes purely by proximity.',
    kind: 'findCategoryOrder',
    category: 'general',
  },

  // ─── Appearance ─────────────────────────────────────────────────
  {
    key: 'theme',
    label: 'Theme',
    description:
      "Light, dark, or follow the operating system's preference. System mode tracks OS-level changes live.",
    kind: 'theme',
    category: 'appearance',
    mobile: true,
    aliases: ['light mode', 'dark mode', 'toggle theme', 'system theme', 'color scheme'],
  },
  {
    key: 'themeAppliesToDocument',
    label: 'Apply theme to the document area',
    description:
      "Off by default: when the theme is dark (or system-resolved dark), only the chrome — ribbon, nav, status bar — goes dark. The document area stays light, so cards still read like paper. Turn on to make the document itself follow the theme.",
    kind: 'toggle',
    category: 'appearance',
    aliases: ['dark document', 'dark paper', 'dark mode document'],
  },
  {
    key: 'iconSet',
    label: 'Icon style',
    description:
      "Modern (default) draws the toolbar, banner, and dialog icons from the Untitled UI line-icon set, tinted to match the theme. Classic reverts to the original emoji / text glyphs. Affects the app chrome only — the document is untouched.",
    kind: 'iconSet',
    category: 'appearance',
  },
  {
    key: 'showDocNameChip',
    label: 'Show doc name in ribbon',
    description:
      "Off by default. When on, the active document's filename appears as a pill in the center of the ribbon — useful when the OS title bar is hidden, unstyled, or non-existent (tiling window managers, frameless windows, web embeds). Hidden in multi-pane mode because each per-pane chip already shows its slot's filename.",
    kind: 'toggle',
    category: 'appearance',
  },
  {
    key: 'formatNavPaneByType',
    label: 'Format nav pane entries by type',
    description:
      "On by default. When on, top-level headings render bold, lower levels in lighter weight and size, and analytic entries in the analytic-blue accent. Turn off for a uniform list where only indentation conveys hierarchy.",
    kind: 'toggle',
    category: 'appearance',
  },
  {
    key: 'displaySizes',
    label: 'Style font sizes (pt)',
    description:
      "Render size for each named style. Doesn't change the underlying doc — only how it looks here.",
    kind: 'displaySizes',
    category: 'appearance',
    mobile: true,
  },
  {
    key: 'displayTypography',
    label: 'Style typography',
    kind: 'displayTypography',
    category: 'appearance',
    mobile: true,
  },
  {
    key: 'bodyFont',
    label: 'Body font',
    description:
      'Font family for body text.',
    kind: 'bodyFont',
    category: 'appearance',
    aliases: ['document font', 'card font', 'editor font'],
  },
  {
    key: 'lineHeight',
    label: 'Line spacing',
    description:
      'Line-spacing multiplier per paragraph type (unitless × font-size).',
    kind: 'lineHeights',
    category: 'appearance',
    aliases: ['line height'],
  },
  {
    key: 'displayParagraphSpacing',
    label: 'Paragraph spacing',
    description:
      'Blank space before and after each paragraph type, in points (the paragraph’s top/bottom margin — distinct from line spacing, which is the gap between lines).',
    kind: 'paragraphSpacing',
    category: 'appearance',
    aliases: ['space before', 'space after', 'paragraph margin', 'before spacing', 'after spacing'],
  },
  {
    key: 'displayColors',
    label: 'Style colors',
    description:
      'Pick the color used for Analytic and Undertag text. The same colors appear under Accessibility → Color overrides (Document text) — editing either place changes both. In dark mode they stay on these colors as long as the theme isn’t applied to the document; when it is, the document switches to a lighter built-in blue/green for contrast.',
    kind: 'displayColors',
    category: 'appearance',
  },
  {
    key: 'timerProfile',
    label: 'Timer profile',
    description:
      "Picks which set of durations the timer is currently running on. Each profile remembers its own customizations, so changing values below saves to the active profile (no separate 'custom' option). Defaults: High school = 3/5/8 + 8 min prep, College = 3/6/9 + 10 min prep, Pomodoro = 25/15/5 + 0 prep.",
    kind: 'timerProfile',
    category: 'appearance',
  },
  {
    key: 'timerProfiles',
    label: 'Timer durations',
    description:
      "Edit the active profile's three preset durations (in minutes, biggest first — these become the top-right 9 / 6 / 3 buttons on the panel) and the per-side prep total. Changes save into the currently-selected profile only.",
    kind: 'timerProfileDurations',
    category: 'appearance',
  },
  {
    key: 'timerPrepLabel',
    label: 'Prep button label style',
    description:
      "How the Aff / Neg prep buttons identify which side they belong to. 'Text' uses A: / N: prefixes with no special color. 'Color' uses blue / red without the prefix. 'Both' (default) uses prefix and color together.",
    kind: 'timerPrepLabel',
    category: 'appearance',
  },
  {
    key: 'timerCompact',
    label: 'Compact timer layout',
    description:
      "Drops the 9 / 6 / 3 speech-preset buttons and tucks Reset under Start / Pause. Useful when the ribbon is tight.",
    kind: 'toggle',
    category: 'appearance',
  },
  {
    key: 'timerFlashEnabled',
    label: 'Flash timer when countdown is low',
    description:
      "Flash the speech-timer display red when remaining time crosses one of the configured thresholds (5 / 3 / 1 seconds by default).",
    kind: 'toggle',
    category: 'appearance',
  },
  {
    key: 'reduceMotion',
    label: 'Reduce motion',
    description:
      "Disable UI animations and transitions (drag-pickup vacuum, popover slides, etc.). 'System' follows your OS preference; 'On' always reduces motion; 'Off' overrides the OS and plays full motion.",
    kind: 'reduceMotion',
    category: 'accessibility',
    mobile: true,
    aliases: ['animations', 'disable animations'],
  },
  {
    key: 'disableCursorBlink',
    label: 'Steady text cursor (no blinking)',
    description:
      'Stop the text cursor from blinking — the caret stays solid (in the usual cursor color) instead of flashing on and off while you type.',
    kind: 'toggle',
    category: 'accessibility',
    aliases: ['caret', 'cursor blink', 'blinking cursor', 'non-blinking'],
  },
  {
    key: 'overrideHighlightColor',
    label: 'Override highlight color in display',
    description:
      "When on, highlights in the doc render in the override colors below regardless of what's stored on the mark. Display-only — the doc itself is untouched, so re-saving preserves the original per-mark colors. Useful when cards from many sources have inconsistent highlight conventions and you want a unified read.",
    kind: 'toggle',
    category: 'accessibility',
  },
  {
    key: 'overrideHighlightSlots',
    label: 'Highlight override colors',
    description:
      "Up to 3 ordered colors. With one slot, every highlight renders in that color. With two or three, the most-common highlight color in the doc gets slot 1, the second-most-common gets slot 2, and everything else gets the last slot. The ranking re-computes automatically as the doc changes.",
    kind: 'colorSlots',
    category: 'accessibility',
    dependsOn: 'overrideHighlightColor',
  },
  {
    key: 'overrideShadingColor',
    label: 'Override shading color in display',
    description:
      "Same idea, applied to shading marks (Verbatim's protected-grey emphasis variant). Doc data is untouched.",
    kind: 'toggle',
    category: 'accessibility',
  },
  {
    key: 'overrideShadingSlots',
    label: 'Shading override colors',
    kind: 'colorSlots',
    category: 'accessibility',
    dependsOn: 'overrideShadingColor',
  },
  {
    key: 'customColorOverrides',
    label: 'Color overrides',
    description:
      "Override any color in the interface. Explicit overrides here always win over the defaults and over future accessibility presets (high-contrast, dark mode, colorblind-friendly, etc.) — pick a color to override it; reset a row to fall back to whichever preset is active.",
    kind: 'colorOverrides',
    category: 'accessibility',
  },
  {
    key: 'uiFont',
    label: 'Interface font',
    description:
      'Font family for the user interface — ribbon, dialogs, navigation pane, comments column, etc. Distinct from the body font (the editor content font). "System default" uses the platform\'s native UI font stack.',
    kind: 'uiFont',
    category: 'accessibility',
    aliases: ['ui font', 'app font'],
  },
  {
    key: 'ribbonTooltipMode',
    label: 'Ribbon tooltips',
    description:
      'What hovering a ribbon button reveals. "Both" shows the action label and its current keyboard shortcut. "Label only" hides the shortcut. "Shortcut only" hides the label and is recommended for users who already know what each button does but still want a key reminder. "None" disables ribbon tooltips entirely. Dropdown menu items (Doc / Card / Table menus, etc.) always show shortcut-only — the menu label already says what the action does.',
    kind: 'ribbonTooltipMode',
    category: 'appearance',
  },
  {
    key: 'formattingPanelMode',
    label: 'Formatting panel',
    description:
      'How the Pocket / Hat / Block / Tag / Analytic buttons in the ribbon are displayed. "Labels" shows the style name, "Shortcuts" shows the keyboard binding, "Both" shows name · shortcut, "Hidden" removes the panel.',
    kind: 'formattingPanelMode',
    category: 'appearance',
  },
  {
    key: 'formattingPanelPreview',
    label: 'Preview styles in formatting panel',
    description:
      'When on, formatting-panel buttons preview the visual treatment of the style they apply.',
    kind: 'toggle',
    category: 'appearance',
  },
  {
    key: 'showCharacterStyles',
    label: 'Show character styles',
    description:
      'Show the cite / underline / emphasis character-style buttons in the ribbon. When off, just that sub-panel is hidden; the rest of the formatting panel stays visible.',
    kind: 'toggle',
    category: 'appearance',
  },

  // ─── Editing ────────────────────────────────────────────────────
  {
    key: 'paragraphIntegrity',
    label: 'F3 condense: preserve paragraph integrity',
    description:
      'When on, F3 only removes intra-paragraph whitespace — paragraphs stay separate. When off, F3 merges consecutive collapsible paragraphs.',
    kind: 'toggle',
    category: 'editing',
  },
  {
    key: 'usePilcrows',
    label: 'F3 condense: use pilcrow markers',
    description:
      'When paragraph integrity is off and this is on, F3 inserts a 6-pt ¶ at each original paragraph boundary in the merged result, so that the split can be reversed via Ctrl/Cmd+Alt+Shift+F3 (Uncondense).',
    kind: 'toggle',
    category: 'editing',
  },
  {
    key: 'extractUndertagInQuotes',
    label: 'Extract Undertag: wrap in quotes',
    description:
      'When on, the Extract Undertag command (Card menu → Excerpt) wraps the excerpt it pulls into the new undertag in double quotes. Off by default — the text is inserted as-is.',
    kind: 'toggle',
    category: 'editing',
    aliases: ['extract undertag'],
  },
  {
    key: 'condenseOnPaste',
    label: 'Condense after Paste Text (F2)',
    description:
      'When on, text that you paste will be condensed using your default "condense" settings.',
    kind: 'toggle',
    category: 'editing',
  },

  {
    key: 'autoBridgeFormattingGaps',
    label: 'Bridge formatting across gaps automatically',
    description:
      'When on, applying highlight / underline / etc. next to an already-formatted word extends it across the small gap between them. Off disables this automatic bridging; the manual "Fix Formatting Gaps" command still works.',
    kind: 'toggle',
    category: 'editing',
  },
  {
    key: 'formattingGapClass',
    label: 'Bridge formatting across',
    description:
      'Which gaps between two formatted words get bridged — both the automatic bridge and the manual "Fix Formatting Gaps" command.',
    kind: 'formattingGapClass',
    category: 'editing',
  },

  {
    key: 'headingMode',
    label: 'Condense: heading handling',
    description:
      'How selection-based condense without paragraph integrity treats structural elements (headings, cites, undertags) inside the selection. "Strict" blocks attempts to condense that include structural elements. "Respect" (default) keeps structural paragraphs unmerged and merges everything else in the selection. "Demolish" merges everything in the selection.',
    kind: 'headingMode',
    category: 'editing',
  },
  {
    key: 'condenseWarningDelimiter',
    label: 'Condense with warning: marker delimiter',
    description:
      'Which bracket style wraps the PARAGRAPH INTEGRITY PAUSES / RESUMES markers added by "Condense with warning" (Card menu).',
    kind: 'condenseWarningDelimiter',
    category: 'editing',
  },
  {
    key: 'shrinkRestoresOmissionsToNormal',
    label: 'Shrink keeps protected text at Normal size',
    description:
      'When on, Shrink (Mod-8) leaves bracketed "Omitted" spans, the PARAGRAPH INTEGRITY PAUSES/RESUMES markers from "Condense with warning", and any custom protections (below) at Normal size so they stay visible in the shrunken output. When off, all of these are shrunk along with the rest of the text.',
    kind: 'toggle',
    category: 'editing',
  },
  {
    key: 'shrinkCustomProtections',
    label: 'Custom shrink protections',
    description:
      'Strings (or regex sources, if the box is checked) that Shrink should leave at Normal size whenever protection is on. Literal entries are matched case-insensitively after escaping; regex entries are compiled with `gi` flags. Invalid regex entries are skipped.',
    kind: 'shrinkCustomProtections',
    category: 'editing',
  },
  {
    key: 'clearFormattingOnNamedStyleToggleOff',
    label: 'F9 toggle-off also clears direct formatting',
    description:
      'When on, pressing F9 to toggle underlining off also strips direct formatting in the range. When off, only the underline style mark is removed; direct formatting applied to the underlined text is preserved.',
    kind: 'toggle',
    category: 'editing',
  },
  {
    key: 'forReferenceUseGray50',
    label: 'Create Reference uses Gray-50% text',
    description:
      'When on, the body text of a "Create Reference" excerpt is rendered in Gray-50% (#808080) instead of black. The heading line stays black either way.',
    kind: 'toggle',
    category: 'editing',
  },
  {
    key: 'showDropzonePill',
    label: 'Show dropzone shelf',
    description:
      "When on, the cross-window dropzone pill sits in the editor's bottom-left corner (the editor nearest the nav pane in multi-pane layouts). Turning it off hides the pill from the chrome; the shelf state and the Send to Dropzone shortcut still work — items pile up in the store and can be retrieved from any window that has the pill visible.",
    kind: 'toggle',
    category: 'editing',
  },
  {
    key: 'showQuickCardButtons',
    label: 'Show quick card buttons',
    description:
      'When on, the Quick Cards cluster — the command bar, tag picker, manage, and add buttons — appears in the ribbon. Off by default. Turning it off hides all four; quick cards still work, and the command bar still opens with its keyboard shortcut.',
    kind: 'toggle',
    category: 'editing',
  },
  {
    key: 'translationProvider',
    label: 'Translation',
    description:
      'Translate the selected text and copy the result to the clipboard (the document is left unchanged). Pick a backend, the source and target languages, and any keys below.',
    kind: 'translationConfig',
    category: 'editing',
    aliases: ['translate', 'translator', 'language', 'mymemory', 'google translate', 'deepl'],
  },
  {
    key: 'prependTranslationMarker',
    label: 'Prepend a “translation by” marker',
    description:
      'When on, the Translator puts a marker line — e.g. [TRANSLATION BY OPUS 4.8], [TRANSLATION BY MYMEMORY], or [TRANSLATION BY GOOGLE TRANSLATE] — above the translated text on the clipboard. It uses the same delimiter as “Condense with warning” above, and (when “Shrink keeps protected text at Normal size” is on) all of these markers are protected from Shrink. On by default.',
    kind: 'toggle',
    category: 'editing',
    aliases: ['translation marker', 'translation by', 'attribution'],
  },

  // ─── Keyboard shortcuts ─────────────────────────────────────────
  {
    key: 'ribbonKeyOverrides',
    label: 'Keyboard shortcuts',
    description:
      'Rebind any ribbon / menu command to your own keys. Click + on a row to add a binding; click × on a chip to remove one; click ↺ to restore that row\'s defaults.',
    kind: 'keybindings',
    category: 'shortcuts',
  },

  // ─── Comments & AI ──────────────────────────────────────────────
  {
    key: 'commentAuthor',
    label: 'Comment author name',
    description: 'Display name attached to comments you create. Stored locally.',
    kind: 'text',
    category: 'comments-ai',
  },
  {
    key: 'commentAuthorInitials',
    label: 'Comment author initials',
    description: 'Short badge shown on your comments. Auto-derived from the name if left empty.',
    kind: 'text',
    category: 'comments-ai',
  },
  {
    key: 'aiFeaturesEnabled',
    label: 'Enable AI features',
    description:
      'Master switch for AI-powered comment features (in-comment "Explain" prompts, @AI mentions). Requires an Anthropic API key below.',
    kind: 'toggle',
    category: 'comments-ai',
    mobile: true,
  },
  {
    key: 'anthropicApiKey',
    label: 'Anthropic API key',
    description:
      'Used only when AI features are enabled. Stored locally in browser settings; sent only to api.anthropic.com.',
    kind: 'password',
    category: 'comments-ai',
    mobile: true,
    dependsOn: 'aiFeaturesEnabled',
  },
  {
    key: 'aiModelOverride',
    label: 'AI model (advanced)',
    description:
      'Optional. The Claude model id used by all AI features (e.g. claude-opus-4-8). Leave blank to use the version built into this release. Set a newer id here if the built-in model has been retired and you’d rather not update the whole app. A malformed entry is ignored and the default is used.',
    kind: 'text',
    category: 'comments-ai',
    mobile: true,
    dependsOn: 'aiFeaturesEnabled',
    aliases: ['model', 'claude model', 'model override', 'opus', 'sonnet', 'haiku'],
  },
  {
    key: 'clodEnabled',
    label: 'Enable Clod mode',
    description:
      'When the AI is composing a reply, the in-flight placeholder cycles through time-of-day Clod activities ("Clod is making toast…") instead of plain "Thinking…".',
    kind: 'clod',
    category: 'comments-ai',
    dependsOn: 'aiFeaturesEnabled',
    mobile: true,
  },
  {
    key: 'clodActivitiesByTime',
    label: 'Customize Clod',
    description:
      'Set the name and pronouns for Clod, write your own activity phrases for each time of day, and adjust when those periods begin. Opens a full editor.',
    kind: 'clodCustomize',
    category: 'comments-ai',
    dependsOn: 'aiFeaturesEnabled',
    aliases: ['clod', 'persona', 'clod activities', 'pronouns', 'clod name'],
  },
  {
    key: 'aiCitePrompt',
    label: 'AI cite-creator prompt',
    description:
      'System prompt the cite-creator hands to the model. Click "Edit prompt" to open a full-size editor. Leave blank to use the built-in default.',
    kind: 'aiCitePrompt',
    category: 'comments-ai',
    dependsOn: 'aiFeaturesEnabled',
  },
  // ─── Card Cutter (experimental; console-gated, hidden until on) ──
  {
    key: 'cardCutterReadTimeSec',
    label: 'Default read length (seconds)',
    description:
      'How long the highlighted read should take by default, at your reader words-per-minute. Roughly 12 seconds is a typical card. Individual cuts can override this.',
    kind: 'number',
    category: 'comments-ai',
    searchHidden: true,
    revealWhen: 'cardCutterEnabled',
  },
  {
    key: 'cardCutterEmphasisStyle',
    label: 'Emphasis style',
    description:
      "Voice: emphasis marks the spoken content words inside highlights. Independent: emphasis marks rhetorically powerful phrases whether or not they're in the read. Minimal: sparse emphasis. This is your own preference and sticks across files.",
    kind: 'cardCutterEmphasisStyle',
    category: 'comments-ai',
    searchHidden: true,
    revealWhen: 'cardCutterEnabled',
  },
  {
    key: 'cardCutterClarifyingQuestions',
    label: 'Clarifying questions',
    description:
      'When the cutter may pause to ask how you want a card cut (e.g. establish vs. supplement). When-ambiguous lets the model decide; Always forces a prompt; Never skips them.',
    kind: 'cardCutterClarifyingQuestions',
    category: 'comments-ai',
    searchHidden: true,
    revealWhen: 'cardCutterEnabled',
  },
  {
    key: 'cardCutterAcronymSplitting',
    label: 'Acronym letter-splitting',
    description:
      'Highlight just the initial letters of a spelled-out term so the read produces the acronym (e.g. "Department of Defense" read as "DoD"). Off by default — error-prone when machine-generated.',
    kind: 'cardCutterAcronymSplitting',
    category: 'comments-ai',
    searchHidden: true,
    revealWhen: 'cardCutterEnabled',
  },
  {
    key: 'cardCutterMorphologyShaving',
    label: 'Word-shaving for spoken shorthand',
    description:
      'Allow highlighting part of a word to produce spoken shorthand ("regulations" read as "regs", "Democrats" as "Dems"). Off by default — useful but the riskiest transform.',
    kind: 'toggle',
    category: 'comments-ai',
    searchHidden: true,
    revealWhen: 'cardCutterEnabled',
  },
  {
    key: 'cardCutterEnginePath',
    label: 'Engine file',
    description:
      'Path to the card-cutter engine bundle this build loads (packaged installs only — the engine is never shipped with the app). Leave empty to use the CARDCUTTER_ENGINE environment variable, or the default plugins location in the app data folder. Reload after changing.',
    kind: 'cardCutterEnginePath',
    category: 'comments-ai',
    electronOnly: true,
    searchHidden: true,
    revealWhen: 'cardCutterEnabled',
  },
  {
    key: 'cardCutterEnabled',
    label: 'Disable the card cutter',
    description:
      'Turns the experimental card cutter back off, hides its ribbon commands and shortcuts, and removes this settings tab. Re-enable with the console command.',
    kind: 'cardCutterDisable',
    category: 'comments-ai',
    searchHidden: true,
    revealWhen: 'cardCutterEnabled',
  },
  {
    key: 'pairingEnabled',
    label: 'Enable card sharing',
    description:
      'Turn on cross-machine card sharing. Adds a Send and a Receive pill next to the dropzone: drag a card onto Send to push it to a recipient, and cards others send you land in Receive. Your machine polls for incoming cards while this is on. Desktop only.',
    kind: 'toggle',
    category: 'pairing',
    electronOnly: true,
    aliases: ['share', 'send card', 'recipient', 'to', 'pairing'],
  },
  {
    key: 'pairingOwnCode',
    label: 'Your pairing code',
    description:
      "This machine's code. Share it with anyone you want to be able to send you cards. Anyone with this code (and the app) can send to you; regenerate it to cut off old shares.",
    kind: 'pairingOwnCode',
    category: 'pairing',
    electronOnly: true,
    dependsOn: 'pairingEnabled',
  },
  {
    key: 'pairingDisplayName',
    label: 'Your display name',
    description:
      "Optional name stamped on cards you send, so someone who hasn't named you yet still sees who it's from. Leave empty to send just your code.",
    kind: 'text',
    category: 'pairing',
    electronOnly: true,
    dependsOn: 'pairingEnabled',
  },
  {
    key: 'pairingPartners',
    label: 'Recipients',
    description:
      'Machines you can send to. Add one by pasting the code it shared with you and giving it a name (shown in the To list when sending, and on cards you receive from it).',
    kind: 'pairingPartners',
    category: 'pairing',
    electronOnly: true,
    dependsOn: 'pairingEnabled',
  },
  {
    key: 'pairingGroups',
    label: 'Groups',
    description:
      'Named sets of recipients for one-drop sends — e.g. a "Smith/Jones" team. Dropping a card on a group sends it to every member.',
    kind: 'pairingGroups',
    category: 'pairing',
    electronOnly: true,
    dependsOn: 'pairingEnabled',
  },
  {
    key: 'pairingPollSeconds',
    label: 'Check for new cards every (seconds)',
    description:
      'How often this machine polls for incoming cards. Lower is snappier but chattier; default 30. Clamped to 5–3600.',
    kind: 'number',
    category: 'pairing',
    electronOnly: true,
    dependsOn: 'pairingEnabled',
  },
  {
    key: 'pairingReceiveFlash',
    label: 'Flash the Receive pill on a new card',
    description:
      'Flash the Receive pill green when a card arrives. "Flash once" pulses a single time; "Keep flashing" re-pulses every 10 seconds until you open the Receive pill and see the new card(s); "Off" never flashes.',
    kind: 'pairingReceiveFlash',
    category: 'pairing',
    electronOnly: true,
    dependsOn: 'pairingEnabled',
  },
];

/** Origin info handed to settings subscribers. `remote` is true when
 *  the change arrived from ANOTHER window via the cross-window storage
 *  event, rather than a `set()` in this window. Subscribers that drive
 *  window-level side effects — notably the `multiDocWorkspace` mode
 *  switch, which closes the other windows and reloads — must act on
 *  LOCAL changes only; otherwise every window runs the switch at once
 *  and they close each other, leaving nothing open. */
export interface SettingsChangeMeta {
  remote: boolean;
}
type Listener = (s: Readonly<Settings>, meta: SettingsChangeMeta) => void;

export class SettingsStore {
  private values: Settings;
  private listeners: Set<Listener> = new Set();

  constructor() {
    this.values = this.load();
    // Cross-window propagation. The browser `storage` event fires on
    // every window that shares the origin EXCEPT the one that wrote
    // the change — so this won't infinite-loop. Electron's
    // BrowserWindows follow the same Web standard, which means
    // settings changes in any window flow to all other live windows
    // without explicit IPC. We reload the full snapshot rather than
    // patching by key: localStorage holds the whole settings object
    // under one key, so the simplest correct behavior is "reapply
    // what's now on disk."
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (event) => {
        if (event.storageArea !== localStorage) return;
        if (event.key !== STORAGE_KEY && event.key !== null) return;
        const incoming = this.load();
        // Transient keys (e.g., read mode) stay window-local: don't
        // let another window's persisted state override what THIS
        // window has chosen. The originating window persists only
        // the non-transient keys, but a fresh load() would still
        // hydrate transients from DEFAULTS — which would erase
        // this window's current value if we didn't pin it.
        for (const key of TRANSIENT_SETTING_KEYS) {
          (incoming as unknown as Record<string, unknown>)[key] = (
            this.values as unknown as Record<string, unknown>
          )[key];
        }
        this.values = incoming;
        this.notify(true);
      });
    }
  }

  get<K extends keyof Settings>(key: K): Settings[K] {
    return this.values[key];
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    if (this.values[key] === value) return;
    this.values[key] = value;
    if (!TRANSIENT_SETTING_KEYS.has(key as string)) this.persist();
    this.notify();
  }

  all(): Readonly<Settings> {
    return { ...this.values };
  }

  /** Snapshot for export: every persisted setting EXCEPT transient
   *  (per-window) keys and the secret credentials (API keys / the
   *  MyMemory email), which are never exported. */
  exportObject(): Record<string, unknown> {
    const out: Record<string, unknown> = { ...this.values };
    for (const key of SECRET_SETTING_KEYS) delete out[key];
    for (const key of TRANSIENT_SETTING_KEYS) delete out[key];
    return out;
  }

  /** Overwrite ALL settings from an imported (untrusted) object. Runs
   *  through `sanitize({ ...DEFAULTS, ...raw })` — the same boundary as
   *  load — so it tolerates schema drift: fields added since the export
   *  fall back to defaults, fields removed since are dropped, and bad
   *  values are coerced/clamped. The secret credentials (never exported)
   *  and transient per-window values are preserved, not wiped. */
  replaceAll(raw: unknown): void {
    const parsed = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const preserved: Record<string, unknown> = {};
    for (const key of SECRET_SETTING_KEYS) {
      preserved[key] = (this.values as unknown as Record<string, unknown>)[key];
    }
    for (const key of TRANSIENT_SETTING_KEYS) {
      preserved[key] = (this.values as unknown as Record<string, unknown>)[key];
    }
    this.values = sanitize({ ...DEFAULTS, ...parsed, ...preserved } as Settings);
    this.persist();
    this.notify();
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
          // Strip transient keys before merging — they're per-
          // session/per-window. If an earlier version of the app
          // happened to persist `readMode`, we don't want this
          // window to boot into it.
          for (const key of TRANSIENT_SETTING_KEYS) {
            delete (parsed as Record<string, unknown>)[key];
          }
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
      // Strip transient keys before serializing so they neither
      // survive a reload nor (more importantly) trigger a storage
      // event with a stale read-mode flag for other windows.
      const toStore: Record<string, unknown> = { ...this.values };
      for (const key of TRANSIENT_SETTING_KEYS) delete toStore[key];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
    } catch {
      /* localStorage full / disabled — ignore */
    }
  }

  private notify(remote = false): void {
    const snapshot = { ...this.values };
    const meta: SettingsChangeMeta = { remote };
    for (const listener of this.listeners) listener(snapshot, meta);
  }
}

function sanitize(s: Settings): Settings {
  return {
    navWidth: clamp(s.navWidth, 150, 800),
    navMaxLevel: clamp(Math.round(s.navMaxLevel), 1, 4),
    // Default-on: preserve `false` only when explicitly set so the
    // onboarding shows up for new installs and survives upgrades
    // from before this setting existed.
    showOnboardingStarter: s.showOnboardingStarter === false ? false : true,
    defaultSpeechDocFolder:
      typeof s.defaultSpeechDocFolder === 'string'
        ? s.defaultSpeechDocFolder
        : '',
    defaultSpeechDocFormat:
      s.defaultSpeechDocFormat === 'cmir' ? 'cmir' : 'docx',
    defaultSaveFormat:
      s.defaultSaveFormat === 'cmir' ? 'cmir' : 'docx',
    // Default-on: only an explicit `false` disables the preset
    // filename prefixes (survives upgrades from before this existed).
    prefixPresetSaveFilenames: s.prefixPresetSaveFilenames === false ? false : true,
    sendDocDestination:
      s.sendDocDestination === 'fixedFolder' ? 'fixedFolder' : 'sameFolder',
    sendDocFolder: typeof s.sendDocFolder === 'string' ? s.sendDocFolder : '',
    theme:
      s.theme === 'light' || s.theme === 'dark' ? s.theme : 'system',
    themeAppliesToDocument: !!s.themeAppliesToDocument,
    // Default-on (modern): only an explicit `'classic'` reverts to the
    // original emoji/text glyphs (survives upgrades from before this existed).
    iconSet: s.iconSet === 'classic' ? 'classic' : 'modern',
    showDocNameChip: !!s.showDocNameChip,
    checkForUpdatesOnLaunch: !!s.checkForUpdatesOnLaunch,
    commentsColumnWidth:
      typeof s.commentsColumnWidth === 'number' && Number.isFinite(s.commentsColumnWidth)
        ? Math.max(240, Math.min(560, s.commentsColumnWidth))
        : 320,
    reduceMotion:
      s.reduceMotion === 'on' || s.reduceMotion === 'off' ? s.reduceMotion : 'auto',
    disableCursorBlink: s.disableCursorBlink === true,
    flowHostOnLaunch: s.flowHostOnLaunch === true,
    overrideHighlightColor: !!s.overrideHighlightColor,
    overrideHighlightSlots: sanitizeColorSlots(
      s.overrideHighlightSlots,
      (s as { overrideHighlightColorValue?: unknown }).overrideHighlightColorValue,
      '#ffff00',
    ),
    overrideShadingColor: !!s.overrideShadingColor,
    overrideShadingSlots: sanitizeColorSlots(
      s.overrideShadingSlots,
      (s as { overrideShadingColorValue?: unknown }).overrideShadingColorValue,
      '#d2d2d2',
    ),
    customColorOverrides: sanitizeCustomColorOverrides(s.customColorOverrides),
    // navPaneVisible defaults to TRUE when missing — the user
    // opens to an outline-visible window unless they've already
    // dismissed it during the session (transient — see
    // TRANSIENT_SETTING_KEYS).
    navPaneVisible: s.navPaneVisible === false ? false : true,
    // formatNavPaneByType defaults to TRUE — current behavior.
    formatNavPaneByType: s.formatNavPaneByType === false ? false : true,
    timerProfile:
      s.timerProfile === 'highSchool' || s.timerProfile === 'pomodoro'
        ? s.timerProfile
        : 'college',
    timerProfiles: sanitizeTimerProfiles(s.timerProfiles),
    timerSpeechPresets: sanitizeNumberTriple(s.timerSpeechPresets, [3, 6, 9]),
    timerPrepMinutes:
      typeof s.timerPrepMinutes === 'number' && s.timerPrepMinutes > 0 && s.timerPrepMinutes <= 99
        ? Math.floor(s.timerPrepMinutes)
        : 10,
    timerFlashEnabled: s.timerFlashEnabled === false ? false : true,
    timerFlashSeconds: sanitizeFlashSeconds(s.timerFlashSeconds),
    timerCompact: !!s.timerCompact,
    timerPrepLabel:
      s.timerPrepLabel === 'text' || s.timerPrepLabel === 'color'
        ? s.timerPrepLabel
        : 'both',
    jumpToDocTopOnReadModeToggle: !!s.jumpToDocTopOnReadModeToggle,
    findResultsExpanded: !!s.findResultsExpanded,
    findRememberLastQuery:
      s.findRememberLastQuery === true ? true : false,
    findLastQuery:
      typeof s.findLastQuery === 'string'
        ? s.findLastQuery.slice(0, 1024)
        : '',
    findCategoryOrder: sanitizeFindCategoryOrder(s.findCategoryOrder),
    includeSpeechDocPocket:
      s.includeSpeechDocPocket === false ? false : true,
    showCitePreview: !!s.showCitePreview,
    flashcardDueDot: s.flashcardDueDot === false ? false : true,
    editorSpellcheck: !!s.editorSpellcheck,
    voiceInputDeviceId: typeof s.voiceInputDeviceId === 'string' ? s.voiceInputDeviceId : '',
    voiceAutoSleepSeconds:
      typeof s.voiceAutoSleepSeconds === 'number' && s.voiceAutoSleepSeconds >= 0
        ? Math.round(s.voiceAutoSleepSeconds)
        : 60,
    voiceDashStyle: VOICE_DASH_STYLES.includes(s.voiceDashStyle as Settings['voiceDashStyle'])
      ? (s.voiceDashStyle as Settings['voiceDashStyle'])
      : 'em',
    voiceDictationModel: s.voiceDictationModel === 'large' ? 'large' : 'standard',
    autosaveEnabled: !!s.autosaveEnabled,
    readMode: !!s.readMode,
    hideEmphasisBordersInReadMode: !!s.hideEmphasisBordersInReadMode,
    zoomPct: clamp(Math.round(s.zoomPct / 10) * 10, 50, 200),
    chromeScalePct: clamp(Math.round(s.chromeScalePct / 10) * 10, 50, 200),
    gestureZoom: !!s.gestureZoom,
    readers: sanitizeReaders(s.readers),
    liveSelectionWordCount: s.liveSelectionWordCount === true,
    displaySizes: sanitizeDisplaySizes(s.displaySizes),
    displayParagraphSpacing: sanitizeParagraphSpacing(s.displayParagraphSpacing),
    displayTypography: sanitizeDisplayTypography(s.displayTypography),
    displayColors: sanitizeDisplayColors(s.displayColors, s.customColorOverrides),
    bodyFont: sanitizeBodyFont(s.bodyFont),
    uiFont: sanitizeUiFont(s.uiFont),
    ribbonTooltipMode: sanitizeRibbonTooltipMode(s.ribbonTooltipMode),
    showDropzonePill: s.showDropzonePill === true,
    showQuickCardButtons: s.showQuickCardButtons === true,
    // Accept the new list; migrate the old single `fileSearchRoot` string when
    // the list is absent (settings saved before multi-folder search).
    fileSearchRoots: sanitizeFileSearchRoots(s),
    fileSearchFormats:
      s.fileSearchFormats === 'cmir'
        ? 'cmir'
        : s.fileSearchFormats === 'docx'
          ? 'docx'
          : 'both',
    fileSearchObjectTypes: sanitizeFileObjectTypes(s.fileSearchObjectTypes),
    fileSearchOutlineDepth: Number.isFinite(s.fileSearchOutlineDepth)
      ? clamp(Math.round(s.fileSearchOutlineDepth), 1, 4)
      : 3,
    pinAutoEnabled: s.pinAutoEnabled === false ? false : true,
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
    extractUndertagInQuotes: !!s.extractUndertagInQuotes,
    headingMode: HEADING_MODES.includes(s.headingMode as HeadingMode)
      ? (s.headingMode as HeadingMode)
      : DEFAULTS.headingMode,
    condenseOnPaste:
      s.condenseOnPaste === undefined
        ? DEFAULTS.condenseOnPaste
        : !!s.condenseOnPaste,
    formattingGapClass: FORMATTING_GAP_CLASSES.includes(
      s.formattingGapClass as FormattingGapClass,
    )
      ? (s.formattingGapClass as FormattingGapClass)
      : DEFAULTS.formattingGapClass,
    autoBridgeFormattingGaps:
      s.autoBridgeFormattingGaps === undefined
        ? DEFAULTS.autoBridgeFormattingGaps
        : !!s.autoBridgeFormattingGaps,
    clearFormattingOnNamedStyleToggleOff:
      s.clearFormattingOnNamedStyleToggleOff === undefined
        ? DEFAULTS.clearFormattingOnNamedStyleToggleOff
        : !!s.clearFormattingOnNamedStyleToggleOff,
    forReferenceUseGray50:
      s.forReferenceUseGray50 === undefined
        ? DEFAULTS.forReferenceUseGray50
        : !!s.forReferenceUseGray50,
    shrinkRestoresOmissionsToNormal:
      s.shrinkRestoresOmissionsToNormal === undefined
        ? DEFAULTS.shrinkRestoresOmissionsToNormal
        : !!s.shrinkRestoresOmissionsToNormal,
    condenseWarningDelimiter: CONDENSE_WARNING_DELIMITERS.includes(
      s.condenseWarningDelimiter as CondenseWarningDelimiter,
    )
      ? (s.condenseWarningDelimiter as CondenseWarningDelimiter)
      : DEFAULTS.condenseWarningDelimiter,
    condenseWarningCustomPauseMarker:
      typeof s.condenseWarningCustomPauseMarker === 'string'
        ? s.condenseWarningCustomPauseMarker
        : DEFAULTS.condenseWarningCustomPauseMarker,
    condenseWarningCustomResumeMarker:
      typeof s.condenseWarningCustomResumeMarker === 'string'
        ? s.condenseWarningCustomResumeMarker
        : DEFAULTS.condenseWarningCustomResumeMarker,
    shrinkCustomProtections: sanitizeShrinkProtections(s.shrinkCustomProtections),
    ribbonKeyOverrides: sanitizeRibbonKeyOverrides(s.ribbonKeyOverrides),
    keyboardMacros: sanitizeKeyboardMacros(s.keyboardMacros),
    commentAuthor:
      typeof s.commentAuthor === 'string' && s.commentAuthor.length > 0
        ? s.commentAuthor
        : DEFAULTS.commentAuthor,
    commentAuthorInitials:
      typeof s.commentAuthorInitials === 'string'
        ? s.commentAuthorInitials
        : DEFAULTS.commentAuthorInitials,
    commentsVisible: !!s.commentsVisible,
    anthropicApiKey:
      typeof s.anthropicApiKey === 'string'
        ? s.anthropicApiKey
        : DEFAULTS.anthropicApiKey,
    aiModelOverride: typeof s.aiModelOverride === 'string' ? s.aiModelOverride.trim() : '',
    aiFeaturesEnabled: !!s.aiFeaturesEnabled,
    clodEnabled: !!s.clodEnabled,
    clodActivitiesByTime: sanitizeClodActivitiesByTime(s.clodActivitiesByTime),
    clodTimePeriods: sanitizeClodTimePeriods(s.clodTimePeriods),
    aiPersonaName:
      typeof s.aiPersonaName === 'string' && s.aiPersonaName.trim()
        ? s.aiPersonaName.trim()
        : DEFAULTS.aiPersonaName,
    aiPersonaPronouns: ['he', 'she', 'they', 'it', 'custom'].includes(s.aiPersonaPronouns as string)
      ? (s.aiPersonaPronouns as Settings['aiPersonaPronouns'])
      : DEFAULTS.aiPersonaPronouns,
    aiPersonaCustomPronouns: sanitizeCustomPronouns(s.aiPersonaCustomPronouns),
    aiCitePrompt:
      typeof s.aiCitePrompt === 'string' ? s.aiCitePrompt : DEFAULTS.aiCitePrompt,
    translationProvider: (['auto', 'mymemory', 'anthropic', 'google'] as const).includes(
      s.translationProvider as Settings['translationProvider'],
    )
      ? (s.translationProvider as Settings['translationProvider'])
      : DEFAULTS.translationProvider,
    translationTargetLang:
      typeof s.translationTargetLang === 'string' && s.translationTargetLang.trim()
        ? s.translationTargetLang.trim().toLowerCase()
        : DEFAULTS.translationTargetLang,
    translationSourceLang:
      typeof s.translationSourceLang === 'string' && s.translationSourceLang.trim()
        ? s.translationSourceLang.trim().toLowerCase()
        : DEFAULTS.translationSourceLang,
    myMemoryEmail: typeof s.myMemoryEmail === 'string' ? s.myMemoryEmail.trim() : '',
    googleTranslateApiKey:
      typeof s.googleTranslateApiKey === 'string' ? s.googleTranslateApiKey.trim() : '',
    prependTranslationMarker: s.prependTranslationMarker === false ? false : true,
    multiDocWorkspace: !!s.multiDocWorkspace,
    mobileLayout:
      s.mobileLayout === 'mobile' || s.mobileLayout === 'desktop'
        ? s.mobileLayout
        : DEFAULTS.mobileLayout,
    multiDocLayoutMode:
      s.multiDocLayoutMode === 'wide' || s.multiDocLayoutMode === 'compact'
        ? s.multiDocLayoutMode
        : DEFAULTS.multiDocLayoutMode,
    quickCardActiveTags: Array.isArray(s.quickCardActiveTags)
      ? s.quickCardActiveTags.filter((t): t is string => typeof t === 'string')
      : [],
    cardCutterEnabled: s.cardCutterEnabled === true,
    cardCutterEnginePath:
      typeof s.cardCutterEnginePath === 'string' ? s.cardCutterEnginePath : '',
    cardCutterEmphasisStyle:
      s.cardCutterEmphasisStyle === 'independent' || s.cardCutterEmphasisStyle === 'minimal'
        ? s.cardCutterEmphasisStyle
        : 'voice',
    cardCutterReadTimeSec:
      typeof s.cardCutterReadTimeSec === 'number' && s.cardCutterReadTimeSec > 0
        ? Math.min(120, Math.max(3, Math.round(s.cardCutterReadTimeSec)))
        : DEFAULTS.cardCutterReadTimeSec,
    cardCutterAcronymSplitting:
      s.cardCutterAcronymSplitting === 'conservative' || s.cardCutterAcronymSplitting === 'aggressive'
        ? s.cardCutterAcronymSplitting
        : 'off',
    cardCutterMorphologyShaving: s.cardCutterMorphologyShaving === true,
    cardCutterClarifyingQuestions:
      s.cardCutterClarifyingQuestions === 'always' || s.cardCutterClarifyingQuestions === 'never'
        ? s.cardCutterClarifyingQuestions
        : 'when-ambiguous',
    pairingEnabled: s.pairingEnabled === true,
    pairingPollSeconds: Number.isFinite(Number(s.pairingPollSeconds))
      ? clamp(Math.round(Number(s.pairingPollSeconds)), 5, 3600)
      : 30,
    pairingOwnCode: typeof s.pairingOwnCode === 'string' ? s.pairingOwnCode.trim() : '',
    pairingDisplayName:
      typeof s.pairingDisplayName === 'string' ? s.pairingDisplayName.trim().slice(0, 80) : '',
    pairingPartners: sanitizePairingPartners(s.pairingPartners),
    pairingGroups: sanitizePairingGroups(s.pairingGroups, s.pairingPartners),
    pairingStarred: sanitizePairingStarred(s.pairingStarred, s.pairingPartners, s.pairingGroups),
    pairingReceiveFlash: PAIRING_RECEIVE_FLASHES.includes(s.pairingReceiveFlash)
      ? s.pairingReceiveFlash
      : 'once',
    cleanProtectedStyles: Array.isArray(s.cleanProtectedStyles)
      ? Array.from(
          new Set(
            s.cleanProtectedStyles
              .filter((x): x is string => typeof x === 'string')
              .map((x) => x.trim())
              .filter((x) => x.length > 0),
          ),
        )
      : [],
  };
}

/** Coerce the file-search folders, migrating the pre-multi-folder single
 *  `fileSearchRoot` string. Trims, drops empties, de-duplicates. */
function sanitizeFileSearchRoots(s: Settings): string[] {
  const raw = s as { fileSearchRoots?: unknown; fileSearchRoot?: unknown };
  const list = Array.isArray(raw.fileSearchRoots)
    ? raw.fileSearchRoots
    : typeof raw.fileSearchRoot === 'string' && raw.fileSearchRoot
      ? [raw.fileSearchRoot]
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const t = item.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** Accept a hex color string (`#rrggbb`, case-insensitive); fall
 *  back to `defaultValue` otherwise. Used by the highlight /
 *  shading display-override settings. */
function sanitizeHexColor(raw: unknown, defaultValue: string): string {
  if (typeof raw !== 'string') return defaultValue;
  const trimmed = raw.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  return defaultValue;
}

/** Validate + clamp the 1–3-color slots arrays used by the
 *  highlight / shading display overrides. Accepts hex or
 *  rgba/rgb strings. Migrates from the previous single-color
 *  field (`overrideHighlightColorValue` / `overrideShadingColorValue`)
 *  when the new array is absent. Always returns at least one
 *  entry — `defaultValue` if everything else is missing. */
function sanitizeColorSlots(
  raw: unknown,
  legacy: unknown,
  defaultValue: string,
): string[] {
  const isColor = (v: unknown): v is string =>
    typeof v === 'string' &&
    (
      /^#[0-9a-fA-F]{6}$/.test(v.trim()) ||
      /^rgba?\(/.test(v.trim())
    );
  if (Array.isArray(raw)) {
    const out: string[] = [];
    for (const v of raw) {
      if (isColor(v)) out.push(v.trim());
      if (out.length >= 3) break;
    }
    if (out.length > 0) return out;
  }
  // Migration: pre-multi-slot installs had a single color stored
  // in `overrideHighlightColorValue` / `overrideShadingColorValue`.
  // Copy it into slot 0 if present.
  if (isColor(legacy)) return [legacy.trim()];
  return [defaultValue];
}

/** Filter a Record<string, string> against the registered list of
 *  customizable color tokens. Keeps entries whose key matches a
 *  known token AND whose value parses as a CSS color (we accept
 *  any non-empty string here; CSS will reject malformed values
 *  silently when applied). Used to scrub the persisted
 *  `customColorOverrides` blob. */
function sanitizeCustomColorOverrides(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const known = new Set(CUSTOMIZABLE_COLOR_TOKENS.map((t) => t.name));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(k)) continue;
    // Document-text colors are backed by displayColors now; their
    // legacy values migrate there (see sanitizeDisplayColors) and must
    // not linger here, or applyCustomColorOverrides would re-clobber
    // the displayColors write.
    if (k in DISPLAY_COLOR_TOKEN_TO_KEY) continue;
    if (typeof v !== 'string' || v.trim() === '') continue;
    out[k] = v.trim();
  }
  return out;
}

/** Manifest of color tokens the user can override via the
 *  accessibility panel. Keys are CSS-variable names without the
 *  `--` prefix; labels are human-readable; groups cluster the UI
 *  into sections. Defaults come from the cascade at runtime
 *  (`getComputedStyle`) so the manifest stays in sync with
 *  style.css without duplicating values here.
 *
 *  To add a new override, append an entry; to remove one, just
 *  delete the entry (existing user overrides for that token will
 *  be dropped by `sanitizeCustomColorOverrides` on next load). */
export interface CustomizableColorToken {
  name: string;
  label: string;
  group: string;
}
export const CUSTOMIZABLE_COLOR_TOKENS: readonly CustomizableColorToken[] = [
  // Surface
  { group: 'Surface', name: 'pmd-c-bg', label: 'Background (page / panels / buttons)' },
  { group: 'Surface', name: 'pmd-c-bg-soft', label: 'Off-white row background' },
  { group: 'Surface', name: 'pmd-c-surface', label: 'Chrome surface (ribbon / status bar)' },
  { group: 'Surface', name: 'pmd-c-surface-soft', label: 'Soft surface (nav header)' },
  { group: 'Surface', name: 'pmd-c-surface-alt', label: 'Alt surface (editor viewport / code)' },
  { group: 'Surface', name: 'pmd-c-overlay', label: 'Modal scrim' },

  // Borders
  { group: 'Borders', name: 'pmd-c-border', label: 'Button border' },
  { group: 'Borders', name: 'pmd-c-border-soft', label: 'Chrome border (ribbon, nav)' },
  { group: 'Borders', name: 'pmd-c-divider', label: 'Divider' },
  { group: 'Borders', name: 'pmd-c-divider-faint', label: 'Faint divider' },

  // Text
  { group: 'Text', name: 'pmd-c-text', label: 'Body text' },
  { group: 'Text', name: 'pmd-c-text-strong', label: 'Strong text (max contrast)' },
  { group: 'Text', name: 'pmd-c-text-secondary', label: 'Secondary text' },
  { group: 'Text', name: 'pmd-c-text-muted', label: 'Muted text' },
  { group: 'Text', name: 'pmd-c-text-faint', label: 'Faint text' },
  { group: 'Text', name: 'pmd-c-text-on-accent', label: 'Text on accent surface' },

  // Hover / press
  { group: 'Interaction', name: 'pmd-c-hover', label: 'Hover background' },
  { group: 'Interaction', name: 'pmd-c-hover-strong', label: 'Selected / pressed background' },

  // Accent
  { group: 'Accent', name: 'pmd-c-accent', label: 'Accent (primary)' },
  { group: 'Accent', name: 'pmd-c-accent-hover', label: 'Accent hover' },
  { group: 'Accent', name: 'pmd-c-accent-soft', label: 'Accent tint' },
  { group: 'Accent', name: 'pmd-c-focus', label: 'Focus ring' },

  // Status
  { group: 'Status', name: 'pmd-c-success', label: 'Success' },
  { group: 'Status', name: 'pmd-c-warning', label: 'Warning' },
  { group: 'Status', name: 'pmd-c-error', label: 'Error' },
  { group: 'Status', name: 'pmd-c-danger', label: 'Danger (close)' },

  // Drop / drag
  { group: 'Drag affordances', name: 'pmd-c-drop', label: 'Drop indicator' },
  { group: 'Drag affordances', name: 'pmd-c-drop-soft', label: 'Drop indicator (soft)' },
  { group: 'Drag affordances', name: 'pmd-c-drop-mid', label: 'Drop indicator (mid)' },

  // Speech-doc
  { group: 'Speech doc', name: 'pmd-c-speech-bg', label: 'Speech-doc band background' },
  { group: 'Speech doc', name: 'pmd-c-speech-border', label: 'Speech-doc band border' },
  { group: 'Speech doc', name: 'pmd-c-speech-text', label: 'Speech-doc band text' },

  // Editor decorations
  { group: 'Editor', name: 'pmd-c-card-hover', label: 'Card hover indicator' },
  { group: 'Editor', name: 'pmd-c-emphasis-box', label: 'Emphasis box border' },
  { group: 'Editor', name: 'pmd-c-highlight-default', label: 'New-highlight default color' },

  // Per-style document colors. These are reachable here too, but
  // they're BACKED BY `displayColors` (Appearance → Style colors),
  // not `customColorOverrides` — see DISPLAY_COLOR_TOKEN_TO_KEY. The
  // Accessibility rows for them read / write displayColors so the two
  // pickers stay linked to one value.
  { group: 'Document text', name: 'pmd-color-analytic', label: 'Analytic text' },
  { group: 'Document text', name: 'pmd-color-undertag', label: 'Undertag text' },
];

/** The CUSTOMIZABLE_COLOR_TOKENS whose value lives in `displayColors`
 *  (Appearance → Style colors) instead of `customColorOverrides`.
 *  Maps the CSS-var token name (no `--`) to its DisplayColors key.
 *  `applyDisplayColors` writes the user's pick to `--pmd-user-color-*`;
 *  style.css layers the theme on top (light/dark/apply-to-doc) and
 *  resolves `--pmd-color-*` from it. Both the Appearance and the
 *  Accessibility pickers read / write displayColors, so they're one
 *  linked value. */
export const DISPLAY_COLOR_TOKEN_TO_KEY: Readonly<Record<string, keyof DisplayColors>> = {
  'pmd-color-analytic': 'analytic',
  'pmd-color-undertag': 'undertag',
};

/** Token names actually managed by `customColorOverrides` — every
 *  CUSTOMIZABLE_COLOR_TOKENS name EXCEPT the displayColors-backed ones.
 *  Passed to `applyCustomColorOverrides` so it never `removeProperty`s
 *  the document-text vars (which would wipe the displayColors write,
 *  the original "Appearance picker has no effect" bug). */
export const CUSTOM_OVERRIDE_TOKEN_NAMES: readonly string[] = CUSTOMIZABLE_COLOR_TOKENS
  .filter((t) => !(t.name in DISPLAY_COLOR_TOKEN_TO_KEY))
  .map((t) => t.name);

/** Validate a 3-tuple of positive integer minutes for the
 *  timer's speech presets. Fills missing / invalid entries with
 *  the fallback. */
function sanitizeNumberTriple(raw: unknown, fallback: number[]): number[] {
  const out = [...fallback];
  if (!Array.isArray(raw)) return out;
  for (let i = 0; i < 3; i++) {
    const v = raw[i];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 99) {
      out[i] = Math.floor(v);
    }
  }
  return out;
}

/** Validate the per-profile saved-config map. Each profile id
 *  gets a `{ speechPresets, prepMinutes }` object back; missing
 *  / malformed slots fall back to the profile's conventional
 *  defaults. */
function sanitizeTimerProfiles(
  raw: unknown,
): Settings['timerProfiles'] {
  const defaults: Settings['timerProfiles'] = {
    highSchool: { speechPresets: [3, 5, 8], prepMinutes: 8 },
    college: { speechPresets: [3, 6, 9], prepMinutes: 10 },
    pomodoro: { speechPresets: [25, 15, 5], prepMinutes: 0 },
  };
  if (!raw || typeof raw !== 'object') return defaults;
  const src = raw as Record<string, unknown>;
  const out: Settings['timerProfiles'] = {
    highSchool: defaults.highSchool,
    college: defaults.college,
    pomodoro: defaults.pomodoro,
  };
  for (const id of ['highSchool', 'college', 'pomodoro'] as const) {
    const entry = src[id];
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    out[id] = {
      speechPresets: sanitizeNumberTriple(e['speechPresets'], defaults[id].speechPresets),
      prepMinutes:
        typeof e['prepMinutes'] === 'number' &&
        e['prepMinutes'] >= 0 &&
        e['prepMinutes'] <= 99
          ? Math.floor(e['prepMinutes'])
          : defaults[id].prepMinutes,
    };
  }
  return out;
}

/** Validate a list of flash-threshold seconds. Filters to positive
 *  integers ≤ 3600 (1 hour); falls back to [5, 3, 1] if empty. */
function sanitizeFlashSeconds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [5, 3, 1];
  const cleaned = raw
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 3600)
    .map((v) => Math.floor(v));
  return cleaned.length > 0 ? cleaned : [5, 3, 1];
}

function sanitizeFindCategoryOrder(
  raw: unknown,
): Settings['findCategoryOrder'] {
  // `valid` is also the canonical order — used to place any missing category.
  const valid: Settings['findCategoryOrder'] = [
    'heading',
    'tag',
    'analytic',
    'undertag',
    'cite',
    'other',
  ];
  if (!Array.isArray(raw)) return valid.slice();
  const seen = new Set<string>();
  const out: Settings['findCategoryOrder'] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    if (!valid.includes(v as Settings['findCategoryOrder'][number])) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v as Settings['findCategoryOrder'][number]);
  }
  // Insert any categories missing from `raw` at their CANONICAL position (right
  // after their predecessor in `valid`) rather than at the end — so a legacy save
  // that predates a newly-added category (e.g. `analytic`) places it where the
  // default would (analytic next to tag), not dumped last.
  for (let i = 0; i < valid.length; i++) {
    const c = valid[i]!;
    if (seen.has(c)) continue;
    let insertAt = out.length;
    for (let j = i - 1; j >= 0; j--) {
      const predIdx = out.indexOf(valid[j]!);
      if (predIdx >= 0) {
        insertAt = predIdx + 1;
        break;
      }
    }
    out.splice(insertAt, 0, c);
    seen.add(c);
  }
  return out;
}

function sanitizeCustomPronouns(raw: unknown): Settings['aiPersonaCustomPronouns'] {
  const out = { ...DEFAULTS.aiPersonaCustomPronouns };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Partial<Settings['aiPersonaCustomPronouns']>;
  for (const k of ['subject', 'object', 'possessive', 'reflexive'] as const) {
    const v = r[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

function sanitizeClodActivitiesByTime(raw: unknown): Settings['clodActivitiesByTime'] {
  const out = {
    morning: [] as string[],
    day: [] as string[],
    evening: [] as string[],
    night: [] as string[],
  };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Partial<Record<keyof typeof out, unknown>>;
  for (const k of ['morning', 'day', 'evening', 'night'] as const) {
    const v = r[k];
    if (Array.isArray(v)) {
      out[k] = v.filter((x): x is string => typeof x === 'string' && x.length > 0);
    }
  }
  return out;
}

function sanitizeClodTimePeriods(raw: unknown): Settings['clodTimePeriods'] {
  const out = { ...DEFAULTS.clodTimePeriods };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Partial<Record<keyof typeof out, unknown>>;
  for (const k of ['morning', 'day', 'evening', 'night'] as const) {
    const v = r[k];
    if (!v || typeof v !== 'object') continue;
    const obj = v as { start?: unknown; end?: unknown };
    const start = Number(obj.start);
    const end = Number(obj.end);
    if (
      Number.isInteger(start) && start >= 0 && start <= 23 &&
      Number.isInteger(end) && end >= 0 && end <= 23
    ) {
      out[k] = { start, end };
    }
  }
  return out;
}

/** Keep only recognized object-kind strings; default to block/tag/cite
 *  when the value is missing/garbage (but allow an explicit empty set). */
function sanitizeFileObjectTypes(raw: unknown): string[] {
  const known = ['pocket', 'hat', 'block', 'tag', 'cite', 'analytic'];
  if (!Array.isArray(raw)) return ['block', 'tag'];
  return [...new Set(raw.filter((x): x is string => typeof x === 'string' && known.includes(x)))];
}

function sanitizeShrinkProtections(raw: unknown): ShrinkProtection[] {
  if (!Array.isArray(raw)) return [];
  const out: ShrinkProtection[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const pattern = (r as ShrinkProtection).pattern;
    if (typeof pattern !== 'string') continue;
    out.push({ pattern, isRegex: !!(r as ShrinkProtection).isRegex });
  }
  return out;
}

/** Keep only string / string[] entries, coercing arrays to plain arrays
 *  of strings. Unknown keys pass through — we don't import the
 *  ribbon-command ID list here (it would create an import cycle), so
 *  any obsolete IDs from a future schema change will simply have no
 *  effect at lookup time. */
function sanitizeRibbonKeyOverrides(
  raw: unknown,
): Partial<Record<RibbonCommandId, string | string[]>> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Partial<Record<string, string | string[]>> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') {
      out[k] = v;
    } else if (Array.isArray(v)) {
      const cleaned = v.filter((x): x is string => typeof x === 'string');
      out[k] = cleaned;
    }
  }
  return out as Partial<Record<RibbonCommandId, string | string[]>>;
}

/** Keep only well-formed `{ id, key, text }` macro entries. */
function sanitizeKeyboardMacros(raw: unknown): KeyboardMacro[] {
  if (!Array.isArray(raw)) return [];
  const out: KeyboardMacro[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const m = r as Partial<KeyboardMacro>;
    if (typeof m.id !== 'string') continue;
    out.push({
      id: m.id,
      key: typeof m.key === 'string' ? m.key : '',
      text: typeof m.text === 'string' ? m.text : '',
    });
  }
  return out;
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

function sanitizeUiFont(raw: unknown): string {
  // uiFont is `''` by default (= use the stylesheet's system-UI
  // default). Any other value must be a single family name; same
  // quote / comma stripping as `sanitizeBodyFont`.
  if (typeof raw !== 'string') return DEFAULTS.uiFont;
  return raw.replace(/["',]/g, '').trim();
}

function sanitizeRibbonTooltipMode(
  raw: unknown,
): 'none' | 'tooltip' | 'shortcut' | 'both' {
  if (raw === 'none' || raw === 'tooltip' || raw === 'shortcut' || raw === 'both') {
    return raw;
  }
  return DEFAULTS.ribbonTooltipMode;
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

function sanitizeDisplayColors(raw: unknown, rawOverrides?: unknown): DisplayColors {
  const out = { ...DEFAULT_DISPLAY_COLORS };
  const r =
    raw && typeof raw === 'object'
      ? (raw as Partial<Record<keyof DisplayColors, unknown>>)
      : {};
  for (const key of DISPLAY_COLOR_KEYS) {
    out[key] = sanitizeColor(r[key], DEFAULT_DISPLAY_COLORS[key]);
  }
  // Migration: older builds let the Accessibility "Color overrides"
  // panel set pmd-color-analytic / pmd-color-undertag via
  // customColorOverrides, which — applied last — is what actually
  // rendered. Fold any such value into displayColors so the now-linked
  // pickers reflect the color the user was really seeing. The legacy
  // override wins over the displayColors entry (which never rendered).
  // `sanitizeCustomColorOverrides` then drops these tokens from the
  // overrides blob, so there's no double source going forward.
  if (rawOverrides && typeof rawOverrides === 'object') {
    const ov = rawOverrides as Record<string, unknown>;
    for (const [token, key] of Object.entries(DISPLAY_COLOR_TOKEN_TO_KEY)) {
      if (Object.prototype.hasOwnProperty.call(ov, token)) {
        out[key] = sanitizeColor(ov[token], out[key]);
      }
    }
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

function sanitizeParagraphSpacing(raw: unknown): DisplayParagraphSpacing {
  const out = { ...DEFAULT_PARAGRAPH_SPACING };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Partial<Record<ParagraphSpacingKey, unknown>>;
  for (const key of PARAGRAPH_SPACING_KEYS) {
    const v = Number(r[key]);
    // 0–96 pt, half-point precision (negative margins are never wanted).
    if (Number.isFinite(v) && v >= 0 && v <= 96) {
      out[key] = Math.round(v * 2) / 2;
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

/** Coerce a stored partner list: drop non-objects and fully-empty rows
 *  (no code AND no name), dedupe by code. A row with a name but no code
 *  yet is kept so the editor can hold a partner mid-add (you typed the
 *  nickname before pasting the code); downstream send/group logic ignores
 *  partners whose code is still empty. */
function sanitizePairingPartners(raw: unknown): PairingPartner[] {
  if (!Array.isArray(raw)) return [];
  const out: PairingPartner[] = [];
  const seen = new Set<string>();
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const code = String((p as PairingPartner).code ?? '').trim();
    const name = String((p as PairingPartner).name ?? '').trim().slice(0, 80);
    if (!code && !name) continue;
    if (code && seen.has(code)) continue;
    if (code) seen.add(code);
    out.push({ code, name });
  }
  return out;
}

/** Coerce a stored group list: require a label, dedupe ids, and drop any
 *  member code that is not (any longer) a known partner. */
function sanitizePairingGroups(rawGroups: unknown, rawPartners: unknown): PairingGroup[] {
  if (!Array.isArray(rawGroups)) return [];
  const validCodes = new Set(
    sanitizePairingPartners(rawPartners)
      .map((p) => p.code)
      .filter(Boolean),
  );
  const out: PairingGroup[] = [];
  const seenIds = new Set<string>();
  for (const g of rawGroups) {
    if (!g || typeof g !== 'object') continue;
    const label = String((g as PairingGroup).label ?? '').trim().slice(0, 80);
    if (!label) continue;
    let id = String((g as PairingGroup).id ?? '').trim();
    if (!id || seenIds.has(id)) id = `grp-${Math.random().toString(36).slice(2, 10)}`;
    const rawMembers = (g as PairingGroup).memberCodes;
    const memberCodes = Array.isArray(rawMembers)
      ? Array.from(
          new Set(rawMembers.map((c) => String(c).trim()).filter((c) => validCodes.has(c))),
        )
      : [];
    seenIds.add(id);
    out.push({ id, label, memberCodes });
  }
  return out;
}

/** Coerce the starred send target: keep it only if it still points at a live
 *  recipient (by code) or group (by id); otherwise clear it. */
function sanitizePairingStarred(
  raw: unknown,
  rawPartners: unknown,
  rawGroups: unknown,
): { kind: 'partner' | 'group'; ref: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const kind = (raw as { kind?: unknown }).kind;
  const ref = String((raw as { ref?: unknown }).ref ?? '').trim();
  if (!ref) return null;
  if (kind === 'partner') {
    const live = new Set(
      sanitizePairingPartners(rawPartners)
        .map((p) => p.code)
        .filter(Boolean),
    );
    return live.has(ref) ? { kind: 'partner', ref } : null;
  }
  if (kind === 'group') {
    const live = new Set(sanitizePairingGroups(rawGroups, rawPartners).map((g) => g.id));
    return live.has(ref) ? { kind: 'group', ref } : null;
  }
  return null;
}

/** Singleton store. */
export const settings = new SettingsStore();
