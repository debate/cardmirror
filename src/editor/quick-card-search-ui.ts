/**
 * Quick Cards — search palette (with the prefix system).
 *
 * A floating command-palette-style bar (see
 * `reference-docs/SPEC-quick-cards.md` §6): opens centered over the
 * target editor pane, results rendered ABOVE the bar, instant focus,
 * a one-shot blue pulse that fades.
 *
 * Prefix system (a small first slice of the eventual full set —
 * search-everything / transclude / quick cards / dropzone / index):
 *   - `q ` → search quick cards only
 *   - `d ` → search the dropzone only
 *   - `c ` → search ribbon commands only
 *   - `s ` → search settings (top-level tabs + individual settings);
 *            selecting one opens that tab and scrolls to the setting
 *   - `f ` → search `.cmir` files under the configured root. Enter
 *            opens a file; Tab dives INTO the selected file (clearing
 *            the bar) to search its objects (blocks / tags / cites);
 *            Esc from there returns to the file list with the prior
 *            query restored. Selecting an object inserts it.
 *   - no prefix → search EVERYTHING, but show nothing until the user
 *     types a query
 * With a prefix present, an empty query browses that source.
 *
 * Insertion reuses `insertSpeechSlice`, which snaps a block-level insert to
 * the nearest top-level boundary so it never splits the card the caret is in.
 *
 * Also exports `openQuickCardTagPicker` — the ribbon Tag Picker
 * dropdown — which edits the same global active-tags filter.
 */

import type { EditorView } from 'prosemirror-view';
import { Slice, type Node as PMNode } from 'prosemirror-model';
import { undo, redo } from 'prosemirror-history';
import { icon } from './icons';
import { schema } from '../schema/index.js';
import {
  settings,
  SETTING_METADATA,
  toggleableSettingMetas,
  toggleCommandName,
  settingSearchName,
  cyclableSettings,
  cycleCommandName,
  nextCycleValue,
  currentCycleLabel,
  CYCLABLE_SETTINGS,
  type Settings,
  type SettingsCategory,
} from './settings.js';
import { runSettingToggle, runSettingCycle } from './setting-commands.js';
import { CATEGORY_TABS, visibleCategoryTabs, type SettingsTarget } from './settings-categories.js';
import { appVersion } from './install-info.js';
import { getHost, getElectronHost, isWindowsHost } from './host/index.js';
import { showToast } from './toast.js';
import {
  insertZoneAtSelection,
  replaceZoneAtPos,
  buildLiveZoneAttrs,
  buildZoneErrorMessage,
} from './transclusion-actions.js';
import type { TransclusionAttrs } from './transclusion.js';
import { AUTOFILL_IGNORE_ATTRS } from './autofill-ignore.js';
import { insertSpeechSlice } from './speech-doc-send.js';
import { quickCardsStore, distinctTags, normalizeTag } from './quick-cards-store.js';
import { dropzoneStore } from './dropzone-store.js';
import { searchQuickCards } from './quick-cards-match.js';
import { parseNative } from '../native/index.js';
import { fromDocx } from '../import/index.js';
import { ensureHeadingAnchor } from '../anchor-docx.js';
import {
  extractFile,
  searchFiles,
  searchFileObjects,
  baseName,
  dirName,
  fileFormat,
  stripFileExt,
  FILE_OBJECT_KIND_BADGES,
  type FileEntry,
  type FileObject,
  type FileObjectKind,
  type OutlineEntry,
} from './file-search.js';
import { toggleManualPin, recordUsage, effectivePins } from './pins-store.js';
import { listRecents } from './recents-store.js';
import { scheduleIdle } from './idle-scheduler.js';

/** Warm cache of parsed pinned files — module-level so it survives the
 *  palette opening/closing within a session (only cleared on reload).
 *  Keyed by path; `mtimeMs` is the freshness key, `enabledSig` lets a
 *  change to the searchable-object set re-extract from the cached doc
 *  without re-parsing. */
interface WarmEntry {
  mtimeMs: number;
  enabledSig: string;
  doc: PMNode;
  objects: FileObject[];
  outline: OutlineEntry[];
}
const warmCache = new Map<string, WarmEntry>();
import {
  RIBBON_COMMAND_LABELS,
  RIBBON_COMMAND_ALIASES,
  DEFAULT_RIBBON_KEYS,
  formatKeyForDisplay,
  type RibbonCommandId,
} from './ribbon-commands.js';
import { availableRibbonCommandIds } from './ribbon-availability.js';

// ── Warm-cache machinery (module-level, shared by the open palette and
//    the proactive idle pre-warm) ────────────────────────────────────

/** True while a warm pass is parsing files — a single global guard so
 *  the proactive pre-warm and an open palette never double-parse. */
let warmingFiles = false;

/** Paths to keep warm: manual pins always, plus the auto set
 *  (recents ∪ frequents) when the auto-pin setting is on. */
function effectivePinPaths(): Set<string> {
  const recentPaths = listRecents()
    .map((r) => r.handle)
    .filter((h): h is string => typeof h === 'string' && h.length > 0);
  return effectivePins(recentPaths, settings.get('pinAutoEnabled'));
}

function enabledSet(): Set<FileObjectKind> {
  return new Set(settings.get('fileSearchObjectTypes') as FileObjectKind[]);
}

function enabledSig(): string {
  return (settings.get('fileSearchObjectTypes') as string[]).slice().sort().join(',');
}

/** Filter the file list to the formats the user wants surfaced (the
 *  `fileSearchFormats` setting; 'both' shows everything). Applied at search
 *  time off the cached list, so toggling the setting needs no re-scan. */
function filterFilesByFormatSetting(files: FileEntry[]): FileEntry[] {
  const pref = settings.get('fileSearchFormats');
  return pref === 'both' ? files : files.filter((f) => fileFormat(f.path) === pref);
}

/** Drop warm entries for files that are no longer pinned. */
function pruneWarm(pins: Set<string>): void {
  for (const key of [...warmCache.keys()]) {
    if (!pins.has(key)) warmCache.delete(key);
  }
}

/** Resolve on the next idle slot (setTimeout fallback). The renderer
 *  defers idle callbacks until the user pauses, so waiting on one before
 *  each file parse keeps the work off active keystrokes. */
function idleYield(timeout = 500): Promise<void> {
  return new Promise((resolve) => scheduleIdle(() => resolve(), timeout));
}

/** Parse a listed file's bytes into a schema doc — `.docx` through the
 *  importer, `.cmir` through the native reader. The in-file object search
 *  (the Tab dive + the background warm pass) is otherwise format-agnostic:
 *  everything downstream (`extractFile`, the outline, slice-on-insert) works
 *  off the parsed doc, which is the same schema for both formats. */
async function parseFileDoc(
  bytes: Uint8Array,
  format: 'cmir' | 'docx',
): Promise<PMNode> {
  if (format === 'docx') return fromDocx(bytes);
  return parseNative(bytes).doc;
}

/** Parse the pinned/recent files that aren't warm yet (or are stale by
 *  mtime), one at a time, yielding to idle before each parse so it never
 *  blocks a keystroke. Prunes rotated-out pins first.
 *  Cheap on repeat passes — already-fresh files are skipped. `keepGoing`
 *  lets a caller bail early (e.g. the palette closed). */
async function runWarmPass(
  electron: NonNullable<ReturnType<typeof getElectronHost>>,
  fileList: FileEntry[],
  keepGoing: () => boolean,
): Promise<void> {
  if (warmingFiles) return;
  warmingFiles = true;
  try {
    const pins = effectivePinPaths();
    pruneWarm(pins);
    const byPath = new Map(fileList.map((f) => [f.path, f]));
    for (const path of pins) {
      if (!keepGoing()) break;
      const entry = byPath.get(path);
      if (!entry) continue; // not under the search root → unknown mtime
      const warm = warmCache.get(path);
      if (warm && warm.mtimeMs === entry.mtimeMs) continue; // already fresh
      try {
        const file = await electron.readFileAtPath(path);
        if (!file) continue;
        await idleYield();
        if (!keepGoing()) break;
        const doc = await parseFileDoc(file.bytes, file.format);
        const { objects, outline } = extractFile(doc, enabledSet());
        warmCache.set(path, { mtimeMs: entry.mtimeMs, enabledSig: enabledSig(), doc, objects, outline });
      } catch {
        /* unreadable / not a valid .cmir — skip */
      }
    }
  } finally {
    warmingFiles = false;
  }
}

/** Map a main-process file listing to FileEntry rows. */
function toFileEntries(
  list: ReadonlyArray<{ path: string; relPath: string; mtimeMs: number }>,
): FileEntry[] {
  return list.map((it) => ({
    path: it.path,
    relPath: it.relPath,
    name: stripFileExt(baseName(it.relPath)),
    mtimeMs: it.mtimeMs,
  }));
}

/** Merge per-folder listings into one, de-duplicated by absolute path — so a
 *  file that lives under two overlapping search folders is searched once. */
function mergeFileLists(lists: Iterable<FileEntry[]>): FileEntry[] {
  const byPath = new Map<string, FileEntry>();
  for (const list of lists) {
    for (const f of list) if (!byPath.has(f.path)) byPath.set(f.path, f);
  }
  return [...byPath.values()];
}

/** Pre-warm pinned/recent files during idle, before the palette is ever
 *  opened, so the first search's file parse is already cached and
 *  never lands on a keystroke. No-op off Electron or with no search
 *  folders; best-effort (the palette warms on open as a fallback).
 *  Called once at boot. */
export function prewarmQuickCardFiles(): void {
  const electron = getElectronHost();
  if (!electron) return;
  const roots = settings.get('fileSearchRoots');
  if (!roots.length) return;
  // Layer 1 — the file LIST. Kick the per-root scan off in main immediately,
  // not on renderer-idle: `listCmirFiles` is only async IPC (the recursive walk
  // / disk-index load runs in the main process), so it doesn't compete with the
  // renderer's launch render. Starting at t≈0, rather than up to ~2s later when
  // the renderer first goes idle, keeps the index ready even when the command
  // bar opens a second after launch.
  const lists = Promise.all(
    roots.map((r) => electron.listCmirFiles(r).then(toFileEntries).catch(() => [] as FileEntry[])),
  );
  // Layer 2 — the pin CONTENT parse is renderer CPU, so keep it on idle so it
  // never janks the launch frame; it just consumes the already-in-flight lists.
  scheduleIdle(() => {
    void (async () => {
      try {
        await runWarmPass(electron, mergeFileLists(await lists), () => true);
      } catch {
        /* ignore */
      }
    })();
  }, 2000);
}

export interface QuickCardSearchOptions {
  view: EditorView | null;
  paneEl: HTMLElement | null;
  /** Trigger a ribbon command by id (the palette's command source). */
  runCommand: (id: RibbonCommandId) => void;
  /** Open a `.cmir` file by absolute path (the file source's Enter). */
  openFilePath: (path: string, name: string) => void;
  /** When true, selecting a header inside a file inserts a live zone
   *  (transclusion) instead of a copy. Desktop-only entry point. */
  transcludeMode?: boolean;
  /** The transcluding document's own on-disk path, needed to compute a
   *  portable `source_ref`. Only used in transclude mode. */
  docPath?: string | null;
  /** "Re-pick source" for an existing zone: choosing a header re-targets that
   *  zone in place (located by identity, so a stale position is safe) rather
   *  than inserting a new one. */
  rePickTarget?: { pos: number; identity: string };
}

/** A unified palette row — a quick card, dropzone item, command,
 *  settings shortcut, a file, or an object within a file. */
interface PaletteResult {
  source:
    | 'quickcard'
    | 'dropzone'
    | 'command'
    | 'settingtoggle'
    | 'settingcycle'
    | 'settings'
    | 'file'
    | 'fileobject';
  name: string;
  /** Right-aligned secondary text: card tags / command keybinding /
   *  the settings tab / the file's subfolder / a cite's owning tag. */
  meta: string;
  matchedName: boolean;
  snippet: string | null;
  /** Insert payload (quickcard / dropzone / fileobject). */
  sliceJson?: unknown;
  /** Command to run (command source). */
  commandId?: RibbonCommandId;
  /** Boolean setting to flip in place (settingtoggle source). */
  toggleSettingKey?: keyof Settings;
  /** Enum/mode setting to advance to its next value (settingcycle source). */
  cycleSettingKey?: keyof Settings;
  /** Settings deep-link (settings source). */
  settingsTarget?: SettingsTarget;
  /** Absolute path to open (file source). */
  filePath?: string;
  /** File's mtime — the warm-cache freshness key (file source). */
  fileMtimeMs?: number;
  /** Whether this file is pinned (file source) — drives ★ + sort. */
  pinned?: boolean;
  /** Object kind, for the badge (fileobject source). */
  fileObjectKind?: FileObjectKind;
  /** Doc range to slice from the dived-into file on insert (fileobject
   *  source) — lazy, so no slice is built until you actually insert. */
  fileRange?: { from: number; to: number };
  /** Outline depth (1-4) for indentation in the nav-pane-style browse. */
  indentLevel?: number;
  /** Index into `inFile.outline` (outline browse rows only) — the key
   *  for collapse toggling. */
  outlineIndex?: number;
  /** Outline row has descendants and so can be collapsed/expanded. */
  collapsible?: boolean;
  /** Outline row is currently collapsed (children hidden). */
  collapsed?: boolean;
}

type Prefix = 'q' | 'd' | 'c' | 's' | 'f' | null;

function activeTagSet(): Set<string> {
  return new Set(settings.get('quickCardActiveTags').map(normalizeTag));
}

/** Split a leading single-letter prefix (`q `/`d `/`c `/`s `) off the query. */
function parsePrefix(raw: string): { prefix: Prefix; query: string } {
  const m = raw.match(/^([a-zA-Z])\s+(.*)$/);
  if (m) {
    const p = m[1]!.toLowerCase();
    if (p === 'q' || p === 'd' || p === 'c' || p === 's' || p === 'f')
      return { prefix: p, query: m[2]! };
  }
  return { prefix: null, query: raw };
}

function searchQuickCardSource(query: string): PaletteResult[] {
  return searchQuickCards(quickCardsStore.list(), query, activeTagSet()).map((r) => ({
    source: 'quickcard' as const,
    name: r.card.name,
    meta: r.card.tags.join(', '),
    matchedName: r.matchedName,
    snippet: r.snippet,
    sliceJson: r.card.contentJson,
  }));
}

function searchDropzoneSource(query: string): PaletteResult[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const items = dropzoneStore.list();
  const matched =
    tokens.length === 0
      ? [...items]
      : items.filter((it) => tokens.every((t) => it.label.toLowerCase().includes(t)));
  return matched
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((it) => ({
      source: 'dropzone' as const,
      name: it.label,
      meta: '',
      matchedName: true,
      snippet: null,
      sliceJson: it.sliceJson,
    }));
}

/** The current display keybinding for a command (first binding), or ''. */
function commandKeyDisplay(id: RibbonCommandId): string {
  const spec = settings.get('ribbonKeyOverrides')[id] ?? DEFAULT_RIBBON_KEYS[id];
  const first = Array.isArray(spec) ? spec[0] : spec;
  return first ? formatKeyForDisplay(first) : '';
}

/** Word-equivalence groups for command search: if a command's label contains
 *  any word in a group, queries phrased with the OTHER words in that group also
 *  match it (e.g. "Repair OCR/PDF Text" via "fix" / "restore"; "Remove
 *  Hyperlinks" via "delete"; "Delete Row" via "remove"). Command-search only;
 *  add a group to extend. */
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['fix', 'repair', 'restore'],
  ['delete', 'remove'],
];

/** Command source — any ribbon command (everything bindable), matched
 *  on its label, aliases, and synonyms; Enter runs it. */
function searchCommandSource(query: string): PaletteResult[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  // Searchable text = label + any aliases, so a query phrased like an
  // alias still matches. Ranking still prefers the label: an alias-only
  // hit (not in the label) sorts after label hits via the Infinity below.
  // Expand each label by the other words in any synonym group it touches (see
  // SYNONYM_GROUPS), so a query phrased with an equivalent word still matches.
  const haystack = (id: RibbonCommandId): string => {
    const aliases = RIBBON_COMMAND_ALIASES[id];
    const label = RIBBON_COMMAND_LABELS[id].toLowerCase();
    const synonyms: string[] = [];
    for (const group of SYNONYM_GROUPS) {
      if (group.some((w) => label.includes(w))) {
        for (const w of group) if (!label.includes(w)) synonyms.push(w);
      }
    }
    const extra = [...(aliases ?? []), ...synonyms];
    return extra.length ? `${label} ${extra.join(' ')}` : label;
  };
  const available = availableRibbonCommandIds();
  const matched =
    tokens.length === 0
      ? available
      : available.filter((id) => {
          const hay = haystack(id);
          return tokens.every((t) => hay.includes(t));
        });
  const t0 = tokens[0];
  // First-token position within the *label* (not aliases) for ranking;
  // a label miss yields -1, which we treat as last so label hits win.
  const rank = (id: RibbonCommandId): number => {
    if (!t0) return 0;
    const i = RIBBON_COMMAND_LABELS[id].toLowerCase().indexOf(t0);
    return i === -1 ? Infinity : i;
  };
  matched.sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    return RIBBON_COMMAND_LABELS[a].toLowerCase().localeCompare(RIBBON_COMMAND_LABELS[b].toLowerCase());
  });
  return matched.map((id) => ({
    source: 'command' as const,
    name: RIBBON_COMMAND_LABELS[id],
    meta: commandKeyDisplay(id),
    matchedName: true,
    snippet: null,
    commandId: id,
  }));
}

/** Setting-toggle source — a "Toggle <label>" command for every boolean
 *  (`kind: 'toggle'`) setting, derived from SETTING_METADATA so the list
 *  tracks the registry with zero upkeep (see `toggleableSettingMetas`).
 *  Selecting one flips the value in place (no dialog). Searchable both under
 *  the `c` (commands) prefix and in everything-search, so "toggle x" surfaces
 *  it the way the user reaches for it; an empty query lists them all (parity
 *  with the command source's browse-all behavior). */
function searchSettingToggleSource(query: string): PaletteResult[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const metas = toggleableSettingMetas({
    hostKind: getHost().kind,
    isWindows: isWindowsHost(),
    get: (k) => settings.get(k),
  });
  // Haystack: "toggle <label> <section> <aliases> on off enable disable". The
  // leading "toggle" makes a bare `toggle` query list them all (discovery);
  // the section lets a query like "create reference bold" match a prefixed
  // command; the ORIGINAL (unstripped) label keeps "enable …" queries working;
  // the on/off/enable/disable words match however the user phrases the intent.
  const haystack = (m: (typeof metas)[number]): string => {
    const parts = ['toggle', m.label.toLowerCase(), 'on off enable disable'];
    if (m.section) parts.push(m.section.toLowerCase());
    if (m.aliases && m.aliases.length) parts.push(m.aliases.join(' '));
    return parts.join(' ');
  };
  const matched =
    tokens.length === 0 ? metas : metas.filter((m) => tokens.every((t) => haystack(m).includes(t)));
  // Rank by first-token position within the LABEL (a match only via
  // "toggle"/synonyms sorts last), then alphabetically — same scheme as the
  // command source.
  const t0 = tokens[0];
  const rank = (m: (typeof metas)[number]): number => {
    if (!t0) return 0;
    const i = m.label.toLowerCase().indexOf(t0);
    return i === -1 ? Infinity : i;
  };
  const sorted = [...matched].sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    return a.label.localeCompare(b.label);
  });
  return sorted.map((m) => {
    const on = settings.get(m.key) === true;
    return {
      source: 'settingtoggle' as const,
      name: toggleCommandName(m),
      // Current state so the user knows what selecting it will do.
      meta: `${categoryLabel(m.category)} · ${on ? 'On' : 'Off'}`,
      matchedName: true,
      snippet: null,
      toggleSettingKey: m.key,
    };
  });
}

/** Setting-cycle source — a "Cycle <label>" command for each enum/mode
 *  setting in the curated CYCLABLE_SETTINGS table. Selecting one advances to
 *  the next value (wrapping). Same search surfaces and gating as the toggle
 *  source. */
function searchSettingCycleSource(query: string): PaletteResult[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const entries = cyclableSettings({
    hostKind: getHost().kind,
    isWindows: isWindowsHost(),
    get: (k) => settings.get(k),
  });
  // Haystack: "cycle <label> <section> <value labels> <aliases>" — the value
  // names let a query like "cycle icons classic" match; the leading "cycle"
  // lists them all on a bare `cycle` query.
  const haystack = (e: (typeof entries)[number]): string => {
    const parts = ['cycle', e.meta.label.toLowerCase(), e.setting.values.map((v) => v.label).join(' ').toLowerCase()];
    if (e.meta.section) parts.push(e.meta.section.toLowerCase());
    if (e.meta.aliases && e.meta.aliases.length) parts.push(e.meta.aliases.join(' '));
    return parts.join(' ');
  };
  const matched =
    tokens.length === 0
      ? entries
      : entries.filter((e) => tokens.every((t) => haystack(e).includes(t)));
  const t0 = tokens[0];
  const rank = (e: (typeof entries)[number]): number => {
    if (!t0) return 0;
    const i = e.meta.label.toLowerCase().indexOf(t0);
    return i === -1 ? Infinity : i;
  };
  const sorted = [...matched].sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    return a.meta.label.localeCompare(b.meta.label);
  });
  return sorted.map((e) => ({
    source: 'settingcycle' as const,
    name: cycleCommandName(e.meta),
    // Current value + where a cycle lands next, so the row is self-explaining.
    meta: `${categoryLabel(e.meta.category)} · ${currentCycleLabel(
      e.setting,
      settings.get(e.setting.key),
    )} → ${nextCycleValue(e.setting, settings.get(e.setting.key)).label}`,
    matchedName: true,
    snippet: null,
    cycleSettingKey: e.setting.key,
  }));
}

/** Whether the dropzone is on — gates its `d` prefix, hint, and
 *  inclusion in everything-search (mirrors the pill's visibility). */
const dropzoneOn = (): boolean => settings.get('showDropzonePill');

const categoryLabel = (id: SettingsCategory): string =>
  CATEGORY_TABS.find((c) => c.id === id)?.label ?? '';

/** Settings source — top-level tabs AND individual settings, matched on
 *  label. Selecting a tab opens it; selecting a setting opens its tab
 *  and scrolls to the row. Electron-only settings are hidden off
 *  Electron so the palette never offers a row that won't render. */
function searchSettingsSource(query: string): PaletteResult[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const match = (label: string): boolean =>
    tokens.length === 0 || tokens.every((t) => label.toLowerCase().includes(t));

  // Top-level tabs first (host-visible only, so the desktop-only Card Sharing
  // tab isn't offered on web).
  const results: PaletteResult[] = visibleCategoryTabs().filter(({ label }) => match(label)).map(
    ({ id, label }) => ({
      source: 'settings' as const,
      name: label,
      meta: 'Section',
      matchedName: true,
      snippet: null,
      settingsTarget: { category: id },
    }),
  );

  // "Version / About this install" — surfaces the running app version and,
  // on Enter, deep-links to the About section (Settings → General). Matched
  // the way a user looks for it: "version", "about", "about this install".
  const q = tokens.join(' ');
  const aboutKeys = ['version', 'about this install', 'about', 'release'];
  if (q.length > 0 && aboutKeys.some((k) => k.startsWith(q) || q.startsWith(k))) {
    results.unshift({
      source: 'settings',
      name: `CardMirror ${appVersion}`,
      meta: 'About this install',
      matchedName: true,
      snippet: null,
      settingsTarget: { category: 'general', anchor: 'about-this-install' },
    });
  }

  // Keyboard macros — the macros editor lives inside the keybindings
  // editor (Settings → Shortcuts) rather than as its own SETTING_METADATA
  // row, so it has no auto-generated palette entry. Surface it explicitly,
  // deep-linking to the macros section. Matched on how a user looks for it.
  const macroKeys = ['keyboard macros', 'keyboard macro', 'macro', 'macros', 'snippet', 'text expansion'];
  if (q.length > 0 && macroKeys.some((k) => k.startsWith(q) || q.startsWith(k))) {
    results.unshift({
      source: 'settings',
      name: 'Keyboard macros',
      meta: categoryLabel('shortcuts'),
      matchedName: true,
      snippet: null,
      settingsTarget: { category: 'shortcuts', anchor: 'keyboard-macros' },
    });
  }

  // Then individual settings, ranked by where the first token hits.
  // A setting matches on its label OR any alias (aliases let queries
  // like "dark mode" surface the "Theme" row); ranking still keys on
  // the label so alias-only hits sort after label hits.
  const hostKind = getHost().kind;
  const settingHaystack = (m: (typeof SETTING_METADATA)[number]): string => {
    // Section too, so a context-free row (e.g. "Bold heading") is findable by
    // its section ("create reference bold") — matching how it's now displayed.
    const parts = [m.label.toLowerCase()];
    if (m.section) parts.push(m.section.toLowerCase());
    if (m.aliases && m.aliases.length) parts.push(m.aliases.join(' '));
    return parts.join(' ');
  };
  const matchSetting = (m: (typeof SETTING_METADATA)[number]): boolean => {
    const hay = settingHaystack(m);
    return tokens.length === 0 || tokens.every((t) => hay.includes(t));
  };
  const items = SETTING_METADATA.filter(
    (m) =>
      !m.searchHidden &&
      (!m.electronOnly || hostKind === 'electron') &&
      (!m.windowsOnly || isWindowsHost()) &&
      (!m.webOnly || hostKind === 'browser') &&
      matchSetting(m),
  );
  const t0 = tokens[0];
  const rank = (label: string): number => {
    if (!t0) return 0;
    const i = label.toLowerCase().indexOf(t0);
    return i === -1 ? Infinity : i;
  };
  items.sort((a, b) => {
    const d = rank(a.label) - rank(b.label);
    if (d !== 0) return d;
    return a.label.localeCompare(b.label);
  });
  for (const m of items) {
    results.push({
      source: 'settings',
      // Prefix context-free sections (e.g. "Create Reference: Bold heading")
      // so the row reads clearly out of the dialog — same context the
      // Toggle/Cycle commands use.
      name: settingSearchName(m),
      meta: categoryLabel(m.category),
      matchedName: true,
      snippet: null,
      settingsTarget: { category: m.category, settingKey: m.key },
    });
  }
  return results;
}

function fileResult(f: FileEntry, pinned: boolean): PaletteResult {
  return {
    source: 'file',
    name: f.name,
    meta: dirName(f.relPath),
    matchedName: true,
    snippet: null,
    filePath: f.path,
    fileMtimeMs: f.mtimeMs,
    pinned,
  };
}

function fileObjectResult(o: FileObject): PaletteResult {
  return {
    source: 'fileobject',
    name: o.label,
    // Tags show their card's cite (so a cite-match reads clearly and
    // tags carry their citation like the nav pane); cites show their
    // owning tag; everything else has no secondary text.
    meta: o.cite ?? o.detail,
    matchedName: true,
    snippet: null,
    fileRange: { from: o.from, to: o.to },
    fileObjectKind: o.kind,
  };
}

/** Results rendered per page: the initial window, and how many more each
 *  "show more" click (or arrowing past the end) adds. Searches rank the
 *  FULL list; this only bounds how much DOM is built at once. */
const RESULT_PAGE_SIZE = 100;

/** Short left-aligned badge for a result row. */
function badgeText(r: PaletteResult): string {
  switch (r.source) {
    case 'quickcard':
      return 'QC';
    case 'dropzone':
      return 'DZ';
    case 'command':
      return 'CMD';
    case 'settingtoggle':
      return 'TOG';
    case 'settingcycle':
      return 'CYC';
    case 'settings':
      return 'SET';
    case 'file':
      // Badge the file's format so .cmir and .docx results are distinct.
      return fileFormat(r.filePath ?? r.name).toUpperCase();
    case 'fileobject':
      return r.fileObjectKind ? FILE_OBJECT_KIND_BADGES[r.fileObjectKind] : 'OBJ';
  }
}

/** Stable identity of a result, used to restore the selected row across
 *  a re-render (e.g. a live file-index refresh) so the cursor doesn't
 *  bounce back to the top. */
function resultKey(r: PaletteResult): string {
  const id = r.filePath ?? r.commandId ?? r.name;
  return `${r.source}:${id}`;
}

/** Sources whose Enter inserts a slice (and so support Alt+Enter "at end"). */
function isInsertSource(source: PaletteResult['source']): boolean {
  return source === 'quickcard' || source === 'dropzone' || source === 'fileobject';
}

/** Verb for the Enter hint, given the selected result's source. */
function enterVerb(source: PaletteResult['source']): string {
  switch (source) {
    case 'command':
      return 'run';
    case 'settingtoggle':
      return 'toggle';
    case 'settingcycle':
      return 'cycle';
    case 'settings':
      return 'open';
    case 'file':
      return 'open';
    default:
      return 'insert';
  }
}

const SEARCH_PLACEHOLDER = 'Search…';

class QuickCardSearchUI {
  private root: HTMLDivElement | null = null;
  private input!: HTMLInputElement;
  private resultsEl!: HTMLDivElement;
  private tagFilterEl!: HTMLDivElement;
  private hintsEl!: HTMLDivElement;
  private unsubscribe: (() => void) | null = null;
  private view: EditorView | null = null;
  private paneEl: HTMLElement | null = null;
  private runCommand: (id: RibbonCommandId) => void = () => {};
  private openFilePath: (path: string, name: string) => void = () => {};
  private transcludeMode = false;
  private docPath: string | null = null;
  /** When set, choosing a header RE-TARGETS this existing zone (Re-pick source)
   *  instead of inserting a new one. Located by identity at replace time. */
  private rePickTarget: { pos: number; identity: string } | null = null;

  private results: PaletteResult[] = [];
  /** Full ranked list for the current query; `results` holds the rendered
   *  window (its first `visibleCount` entries). Kept so "show more" can
   *  extend the window without re-running the search. */
  private fullResults: PaletteResult[] = [];
  private visibleCount = RESULT_PAGE_SIZE;
  private selected = 0;
  /** Row elements as last built by `renderResults`, index-aligned with
   *  `results` — lets selection moves swap the active class in place
   *  instead of rebuilding the list. */
  private rowEls: HTMLElement[] = [];
  private emptyText = '';

  // ── File-search state (the `f` prefix) ──────────────────────────────
  /** Recursive `.cmir` listing (merged + de-duplicated across every search
   *  folder), cached for one palette session. */
  private fileList: FileEntry[] | null = null;
  /** Per-folder listings keyed by search root, so a per-root index-update can
   *  be merged in incrementally; `fileList` is the merged, de-duplicated view. */
  private rootLists: Map<string, FileEntry[]> = new Map();
  private fileListLoading = false;
  /** Monotonic guard so a stale async (list / read) result from a
   *  prior query or a closed palette is ignored. */
  private asyncToken = 0;
  /** Set while diving into a file (Tab). Overrides prefix parsing: an
   *  empty query browses `outline` (nav-pane style), a non-empty query
   *  searches `objects`; Esc restores `savedQuery`. The parsed `doc` is
   *  kept so inserts slice lazily (no per-object slice held up front). */
  private inFile: {
    path: string;
    name: string;
    doc: PMNode;
    objects: FileObject[];
    outline: OutlineEntry[];
    /** Indices into `outline` whose children are collapsed (hidden). */
    collapsedIdx: Set<number>;
    savedQuery: string;
  } | null = null;
  /** Unsubscribe from main's live `.cmir` index-refresh broadcasts
   *  (Electron only); set on open, cleared on close. */
  private fileIndexUnsub: (() => void) | null = null;

  open(opts: QuickCardSearchOptions): void {
    // Re-triggering the open hotkey while open toggles it closed.
    if (this.root) {
      this.close();
      return;
    }
    this.view = opts.view;
    this.paneEl = opts.paneEl;
    this.runCommand = opts.runCommand;
    this.openFilePath = opts.openFilePath;
    this.rePickTarget = opts.rePickTarget ?? null;
    this.transcludeMode = (opts.transcludeMode ?? false) || this.rePickTarget != null;
    this.docPath = opts.docPath ?? null;
    this.fileList = null;
    this.rootLists = new Map();
    this.fileListLoading = false;
    this.inFile = null;

    const root = document.createElement('div');
    root.className = 'pmd-qcs';
    root.innerHTML = `
      <div class="pmd-qcs-results" role="listbox"></div>
      <div class="pmd-qcs-tagfilter" hidden></div>
      <input class="pmd-qcs-input" type="text" spellcheck="false" ${AUTOFILL_IGNORE_ATTRS}
             placeholder="${SEARCH_PLACEHOLDER}" aria-label="Search" />
      <div class="pmd-qcs-hints"></div>`;
    this.root = root;
    this.resultsEl = root.querySelector('.pmd-qcs-results')!;
    this.tagFilterEl = root.querySelector('.pmd-qcs-tagfilter')!;
    this.input = root.querySelector('.pmd-qcs-input')!;
    this.hintsEl = root.querySelector('.pmd-qcs-hints')!;

    document.body.appendChild(root);
    this.reposition();
    this.input.focus();

    root.classList.add('pmd-qcs-pulse');
    root.addEventListener('animationend', () => root.classList.remove('pmd-qcs-pulse'), {
      once: true,
    });

    this.input.addEventListener('input', () => this.runSearch());
    this.input.addEventListener('keydown', this.onInputKey);
    document.addEventListener('keydown', this.onDocKey);
    document.addEventListener('pointerdown', this.onDocPointerDown, true);
    window.addEventListener('resize', this.onResize);
    this.unsubscribe = quickCardsStore.subscribe(() => this.runSearch());

    // Listen for main's background index revalidation so the open palette
    // refreshes live instead of waiting for the next open.
    const electronHost = getElectronHost();
    this.fileIndexUnsub = electronHost
      ? electronHost.onCmirFileIndexUpdated((p) => this.onFileIndexUpdated(p))
      : null;

    this.runSearch();
  }

  /** Center over the target pane and clamp the width to fit it, so the
   *  bar shrinks elegantly in narrow / multi-pane windows. Re-run on
   *  resize since panes reflow with the window. */
  private reposition(): void {
    if (!this.root) return;
    const rect = this.paneEl?.getBoundingClientRect();
    const available = rect && rect.width > 0 ? rect.width : window.innerWidth;
    const centerX = rect && rect.width > 0 ? rect.left + rect.width / 2 : window.innerWidth / 2;
    this.root.style.left = `${Math.round(centerX)}px`;
    this.root.style.width = `${Math.round(Math.max(240, Math.min(540, available - 24)))}px`;
  }

  private onResize = (): void => this.reposition();

  close(): void {
    if (!this.root) return;
    document.removeEventListener('keydown', this.onDocKey);
    document.removeEventListener('pointerdown', this.onDocPointerDown, true);
    window.removeEventListener('resize', this.onResize);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.fileIndexUnsub?.();
    this.fileIndexUnsub = null;
    this.asyncToken++; // invalidate any in-flight list / read
    this.fileList = null;
    this.rootLists.clear();
    this.inFile = null;
    this.root.remove();
    this.root = null;
    this.view?.focus();
  }

  isOpen(): boolean {
    return !!this.root;
  }

  private onDocPointerDown = (e: PointerEvent): void => {
    if (this.root && !this.root.contains(e.target as Node)) this.close();
  };

  /** Document-level Escape fallback. `onInputKey` only fires while the search
   *  box has focus, but Escape should still step back out of a file / close the
   *  palette when the user has clicked into the results and the box lost focus. */
  private onDocKey = (e: KeyboardEvent): void => {
    if (!this.root || e.key !== 'Escape') return;
    // The input's own handler already owns Escape while it's focused — skipping
    // here avoids double-handling (which would step back AND then close).
    if (e.target === this.input) return;
    e.preventDefault();
    this.escapeOut();
  };

  /** Escape behavior, shared by the input keydown and the document fallback:
   *  step back out of a dived-into file to the results, else close. */
  private escapeOut(): void {
    if (this.inFile) this.exitInFile();
    else this.close();
  }

  private onInputKey = (e: KeyboardEvent): void => {
    // While diving in a file, route undo/redo to the editor so a just-
    // inserted block can be taken back without leaving the bar (matches
    // the editor's own Mod-z / Mod-Shift-z / Mod-y bindings). Focus stays
    // in the input — view.dispatch doesn't steal it.
    if (this.inFile && this.view && (e.metaKey || e.ctrlKey)) {
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo(this.view.state, this.view.dispatch);
        return;
      }
      if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        redo(this.view.state, this.view.dispatch);
        return;
      }
    }
    // Alt+P pins / unpins the selected file (keeps it warm).
    if (e.altKey && e.key.toLowerCase() === 'p') {
      const sel = this.results[this.selected];
      if (sel?.source === 'file' && sel.filePath) {
        e.preventDefault();
        this.togglePinPath(sel.filePath);
        return;
      }
    }
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        this.escapeOut();
        break;
      case 'ArrowDown':
        e.preventDefault();
        this.move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.move(-1);
        break;
      case 'Enter':
        e.preventDefault();
        // Stop the Enter from bubbling to `document`: activating a
        // command can synchronously open a modal (e.g. New Speech
        // Document → promptForText) that registers a document keydown
        // listener, which would otherwise catch this very Enter and
        // instantly dismiss itself.
        e.stopPropagation();
        this.activateSelected(e.altKey, e.metaKey || e.ctrlKey);
        break;
      case 'Tab':
        e.preventDefault();
        // In-file mode: Tab is a no-op (already searching within a file).
        if (this.inFile) break;
        // A selected file (file prefix OR everything search) → dive in to
        // search its objects. Works for both .cmir and .docx (the dive
        // parses either format into the same schema).
        if (this.results[this.selected]?.source === 'file') {
          void this.enterInFile();
          break;
        }
        // Otherwise: the quick-card tag filter.
        this.openTagFilter();
        break;
    }
  };

  // ── Search + results ──────────────────────────────────────────────

  private runSearch(): void {
    // In-file mode overrides prefix parsing — the raw query searches
    // the dived-into file's objects.
    if (this.inFile) {
      const query = this.input.value;
      if (query.trim() === '') {
        // Empty query → the file's outline (nav-pane-style hierarchy):
        // indented by level, collapsible, shown in full.
        // Cites never appear here — they aren't headings — so the
        // overview isn't doubled; they surface once you type a query.
        this.results = this.buildOutlineResults();
        // Outline browse stays deliberately un-paginated; keep the full
        // list in sync so no "show more" row appears.
        this.fullResults = this.results;
        this.emptyText = 'No headings in this file.';
        this.selected = 0;
        this.renderResults();
        return;
      }
      this.results = searchFileObjects(this.inFile.objects, query).map(fileObjectResult);
      this.emptyText = this.inFile.objects.length
        ? 'No matching objects in this file.'
        : 'No searchable objects in this file.';
      this.finishSearch();
      return;
    }
    const { prefix, query } = parsePrefix(this.input.value);
    if (prefix === 'f') {
      this.runFileSearch(query);
      return;
    }
    if (prefix === 'q') {
      this.results = searchQuickCardSource(query);
      this.emptyText = quickCardsStore.list().length
        ? 'No matching quick cards.'
        : 'No quick cards yet.';
    } else if (prefix === 'd') {
      if (!dropzoneOn()) {
        this.results = [];
        this.emptyText = 'The dropzone is off — turn it on in Settings → Appearance.';
      } else {
        this.results = searchDropzoneSource(query);
        this.emptyText = dropzoneStore.list().length
          ? 'No matching dropzone items.'
          : 'The dropzone is empty.';
      }
    } else if (prefix === 'c') {
      // Commands include the auto-generated setting toggles + cycles, so the
      // `c` prefix covers "Toggle/Cycle <setting>" the way the user searches
      // for commands.
      this.results = [
        ...searchCommandSource(query),
        ...searchSettingToggleSource(query),
        ...searchSettingCycleSource(query),
      ];
      this.emptyText = 'No matching commands.';
    } else if (prefix === 's') {
      // The settings filter shows the deep-link rows (open the dialog) AND
      // the in-place Toggle/Cycle actions, so a setting can be changed from
      // here without leaving the bar.
      this.results = [
        ...searchSettingsSource(query),
        ...searchSettingToggleSource(query),
        ...searchSettingCycleSource(query),
      ];
      this.emptyText = 'No matching settings.';
    } else if (query.trim() === '') {
      // No prefix, nothing typed — don't preview anything. The `d
      // dropzone` hint only shows when the dropzone is on.
      this.results = [];
      this.emptyText = `Type to search everything · c commands${
        dropzoneOn() ? ' · d dropzone' : ''
      } · f files · q cards · s settings`;
    } else {
      // No prefix — search everything. Files (by filename) join the
      // other sources; the recursive `.cmir` scan is kicked off lazily
      // and cached, so the first everything-search after opening may
      // show non-file results first and fold files in once the scan
      // finishes (loadFileList re-runs the search on completion). The
      // dropzone is included only when it's on.
      this.ensureFileList();
      const filePins = this.fileList ? this.manualPinPaths() : null;
      this.results = [
        ...searchQuickCardSource(query),
        ...(dropzoneOn() ? searchDropzoneSource(query) : []),
        ...searchCommandSource(query),
        ...searchSettingToggleSource(query),
        ...searchSettingCycleSource(query),
        ...searchSettingsSource(query),
        ...(this.fileList && filePins
          ? searchFiles(filterFilesByFormatSetting(this.fileList), query).map((f) =>
              fileResult(f, filePins.has(f.path)),
            )
          : []),
      ];
      this.emptyText = 'No matches.';
    }
    this.finishSearch();
  }

  /** Clamp to the first page, reset selection, render — the shared tail
   *  of every search. */
  private finishSearch(): void {
    this.fullResults = this.results;
    this.visibleCount = RESULT_PAGE_SIZE;
    this.results = this.fullResults.slice(0, this.visibleCount);
    this.selected = 0;
    this.renderResults();
  }

  /** Extend the rendered window by one page (the "show more" row, or
   *  arrowing past the last rendered result). Selection is preserved —
   *  the rebuilt rows re-read `this.selected`. */
  private showMore(): void {
    this.visibleCount += RESULT_PAGE_SIZE;
    this.results = this.fullResults.slice(0, this.visibleCount);
    this.renderResults();
  }

  // ── File search (`f` prefix) ──────────────────────────────────────

  private runFileSearch(query: string): void {
    const electron = getElectronHost();
    if (!electron) {
      this.results = [];
      this.emptyText = 'File search needs the desktop app.';
      this.finishSearch();
      return;
    }
    const roots = settings.get('fileSearchRoots');
    if (!roots.length) {
      this.results = [];
      this.emptyText = 'Add a file-search folder in Settings → General.';
      this.finishSearch();
      return;
    }
    if (this.fileList === null) {
      if (!this.fileListLoading) this.loadFileList(roots, electron);
      this.results = [];
      this.emptyText = 'Searching files…';
      this.finishSearch();
      return;
    }
    // ★ + top-sort reflect MANUAL pins (the user-controlled feature);
    // auto pins (recents/frequents) are warmed silently, not surfaced.
    const pins = this.manualPinPaths();
    const matched = searchFiles(filterFilesByFormatSetting(this.fileList), query);
    const ordered = [
      ...matched.filter((f) => pins.has(f.path)),
      ...matched.filter((f) => !pins.has(f.path)),
    ];
    this.results = ordered.map((f) => fileResult(f, pins.has(f.path)));
    this.emptyText = this.fileList.length
      ? 'No matching files.'
      : 'No files in the search folder.';
    this.finishSearch();
  }

  /** Manually-pinned paths (★ + top-sort). `autoEnabled: false` makes
   *  `effectivePins` return just the manual set. */
  private manualPinPaths(): Set<string> {
    return effectivePins([], false);
  }

  /** Background pass while the palette is open: delegate to the shared
   *  warm pass (which yields to idle before each parse), bailing if the
   *  palette closes mid-flight. */
  private async warmPins(): Promise<void> {
    const electron = getElectronHost();
    if (!electron || !this.fileList) return;
    await runWarmPass(electron, this.fileList, () => !!this.root);
  }

  /** Toggle a file's manual pin, keeping it selected and re-warming. */
  private togglePinPath(path: string): void {
    toggleManualPin(path);
    this.runSearch(); // re-sort + refresh ★
    const at = this.results.findIndex((r) => r.filePath === path);
    if (at >= 0) this.setSelected(at);
    void this.warmPins();
  }

  /** Kick off the (cached, once-per-session) file scan if it hasn't run
   *  yet — used by the no-prefix everything search, which folds files in
   *  once the scan completes. No-op without an Electron host + a root. */
  private ensureFileList(): void {
    if (this.fileList !== null || this.fileListLoading) return;
    const electron = getElectronHost();
    const roots = settings.get('fileSearchRoots');
    if (!electron || !roots.length) return;
    this.loadFileList(roots, electron);
  }

  /** Recursively list openable files under every search folder once per
   *  session, merged + de-duplicated by path; on completion re-run the search
   *  (if still open + still in file mode). A folder that fails to list resolves
   *  to empty rather than failing the whole load. */
  private loadFileList(roots: string[], electron: NonNullable<ReturnType<typeof getElectronHost>>): void {
    this.fileListLoading = true;
    const token = ++this.asyncToken;
    void Promise.all(
      roots.map((r) =>
        electron
          .listCmirFiles(r)
          .then((list) => [r, toFileEntries(list)] as const)
          .catch(() => [r, [] as FileEntry[]] as const),
      ),
    )
      .then((perRoot) => {
        if (token !== this.asyncToken || !this.root) return;
        this.rootLists = new Map(perRoot);
        this.fileList = mergeFileLists(this.rootLists.values());
        this.fileListLoading = false;
        if (!this.inFile) this.runSearch();
        void this.warmPins(); // pre-warm pinned files in the background
      })
      .catch(() => {
        if (token !== this.asyncToken || !this.root) return;
        this.rootLists = new Map();
        this.fileList = [];
        this.fileListLoading = false;
        if (!this.inFile) this.runSearch();
      });
  }

  /** Live index refresh pushed from main's background revalidation. Swaps
   *  in the fresh listing WITHOUT disturbing the in-progress search: the
   *  query text is the source of truth (untouched), the selected row is
   *  preserved by identity, and in-file mode is left alone — the fresh
   *  list is just staged for when the user Escs back to the file list.
   *
   *  No `asyncToken` bump here: an index refresh must never abort an
   *  in-flight `enterInFile` read. There's also no race with a pending
   *  `loadFileList` — main returns the cached listing before it starts
   *  the walk that produces this event, so the load always resolves
   *  first. */
  private onFileIndexUpdated(payload: {
    root: string;
    entries: Array<{ path: string; relPath: string; mtimeMs: number; size: number }>;
  }): void {
    if (!this.root) return; // closed — the next open reloads from main
    if (!settings.get('fileSearchRoots').includes(payload.root)) return; // not one of our roots
    this.rootLists.set(payload.root, toFileEntries(payload.entries));
    this.fileList = mergeFileLists(this.rootLists.values());
    this.fileListLoading = false;
    void this.warmPins(); // re-warm pins against the new mtimes
    // In-file mode shows a file's objects, not the listing — leave the
    // visible results untouched; the swap above is ready for when the
    // user returns to the file list.
    if (this.inFile) return;
    // Only the file (`f`) and non-empty everything views read `fileList`;
    // for other prefixes a re-run would needlessly churn the results.
    const { prefix, query } = parsePrefix(this.input.value);
    const fileVisible = prefix === 'f' || (prefix === null && query.trim() !== '');
    if (!fileVisible) return;
    const sel = this.results[this.selected];
    const prevKey = sel ? resultKey(sel) : null;
    this.runSearch();
    this.restoreSelection(prevKey);
  }

  /** Re-point the selection at the row matching `key` after a re-render,
   *  so a background refresh doesn't bounce the cursor to the top. */
  private restoreSelection(key: string | null): void {
    if (!key) return;
    const at = this.results.findIndex((r) => resultKey(r) === key);
    if (at > 0) this.setSelected(at);
  }

  /** Tab from a selected file → enter in-file mode with the bar cleared.
   *  Uses the warm cache when the file is pinned + fresh (instant); else
   *  reads + parses, warming it if it's pinned. Records usage either way. */
  private async enterInFile(): Promise<void> {
    const sel = this.results[this.selected];
    if (!sel || sel.source !== 'file' || !sel.filePath) return;
    const electron = getElectronHost();
    if (!electron) return;
    const path = sel.filePath;
    const name = sel.name;
    const mtimeMs = sel.fileMtimeMs ?? 0;
    const savedQuery = this.input.value;
    recordUsage(path);

    // Warm hit — no read/parse. Re-extract from the cached doc only if
    // the searchable-object set changed since it was warmed.
    const warm = warmCache.get(path);
    if (warm && warm.mtimeMs === mtimeMs) {
      if (warm.enabledSig !== enabledSig()) {
        const re = extractFile(warm.doc, enabledSet());
        warm.objects = re.objects;
        warm.outline = re.outline;
        warm.enabledSig = enabledSig();
      }
      this.mountInFile(path, name, warm.doc, warm.objects, warm.outline, savedQuery);
      return;
    }

    // Cold — read + parse + extract.
    this.results = [];
    this.emptyText = `Opening "${name}"…`;
    this.finishSearch();
    const token = ++this.asyncToken;
    let doc: PMNode;
    let objects: FileObject[];
    let outline: OutlineEntry[];
    try {
      const file = await electron.readFileAtPath(path);
      if (!file) throw new Error('read failed');
      doc = await parseFileDoc(file.bytes, file.format);
      ({ objects, outline } = extractFile(doc, enabledSet()));
    } catch {
      if (token !== this.asyncToken || !this.root) return;
      showToast(`Couldn't read "${name}".`);
      this.runSearch(); // stay in file mode
      return;
    }
    if (token !== this.asyncToken || !this.root) return;
    // Keep it warm if this file is pinned.
    if (mtimeMs && effectivePinPaths().has(path)) {
      warmCache.set(path, { mtimeMs, enabledSig: enabledSig(), doc, objects, outline });
      pruneWarm(effectivePinPaths());
    }
    this.mountInFile(path, name, doc, objects, outline, savedQuery);
  }

  /** Enter in-file mode with an already-extracted file: seed the
   *  collapsed set from the default depth, clear the bar, render. */
  private mountInFile(
    path: string,
    name: string,
    doc: PMNode,
    objects: FileObject[],
    outline: OutlineEntry[],
    savedQuery: string,
  ): void {
    // Headings at or deeper than the default depth start collapsed
    // (depth 3 → blocks closed), mirroring the nav pane's default depth.
    const depth = settings.get('fileSearchOutlineDepth');
    const collapsedIdx = new Set<number>();
    outline.forEach((e, i) => {
      if (e.level >= depth) collapsedIdx.add(i);
    });
    this.inFile = { path, name, doc, objects, outline, collapsedIdx, savedQuery };
    this.input.value = '';
    this.input.placeholder = `Search in ${name}…`;
    this.runSearch();
  }

  /** Visible outline rows for the browse — walks `outline` honoring the
   *  collapsed set (a collapsed heading hides everything under it until
   *  the next equal-or-shallower heading). Each row carries its outline
   *  index + collapsible / collapsed flags for the chevron + toggle. */
  private buildOutlineResults(): PaletteResult[] {
    if (!this.inFile) return [];
    const { outline, collapsedIdx } = this.inFile;
    const out: PaletteResult[] = [];
    let hideBelow = Infinity; // hide entries with level > hideBelow
    outline.forEach((e, i) => {
      if (e.level <= hideBelow) hideBelow = Infinity; // left the collapsed subtree
      if (hideBelow !== Infinity) return; // still hidden
      const next = outline[i + 1];
      const collapsible = e.level <= 3 && !!next && next.level > e.level;
      const collapsed = collapsedIdx.has(i);
      out.push({
        source: 'fileobject',
        name: e.label || '(untitled)',
        meta: '',
        matchedName: true,
        snippet: null,
        fileRange: { from: e.from, to: e.to },
        fileObjectKind: e.kind,
        indentLevel: e.level,
        outlineIndex: i,
        collapsible,
        collapsed,
      });
      if (collapsible && collapsed) hideBelow = e.level;
    });
    return out;
  }

  /** Toggle a heading's collapsed state (right-click / chevron), keeping
   *  the toggled row selected. */
  private toggleOutlineCollapse(outlineIndex: number): void {
    if (!this.inFile) return;
    const set = this.inFile.collapsedIdx;
    if (set.has(outlineIndex)) set.delete(outlineIndex);
    else set.add(outlineIndex);
    this.results = this.buildOutlineResults();
    this.fullResults = this.results;
    const at = this.results.findIndex((r) => r.outlineIndex === outlineIndex);
    this.selected = at >= 0 ? at : Math.min(this.selected, this.results.length - 1);
    this.renderResults();
  }

  /** Esc from in-file mode → back to the file list, restoring the query. */
  private exitInFile(): void {
    if (!this.inFile) return;
    const { savedQuery } = this.inFile;
    this.inFile = null;
    this.input.placeholder = SEARCH_PLACEHOLDER;
    this.input.value = savedQuery;
    this.runSearch();
    // Re-focus the box — Escape may have come from the results with the box
    // unfocused, and the user expects to land back in a usable search.
    this.input.focus();
  }

  private move(delta: number): void {
    if (this.results.length === 0) return;
    const next = this.selected + delta;
    // Arrowing past the last rendered row reveals the next page instead
    // of wrapping, when there is one — the keyboard path to "show more".
    if (next >= this.results.length && this.fullResults.length > this.results.length) {
      this.showMore();
      this.setSelected(Math.min(next, this.results.length - 1));
      return;
    }
    this.setSelected((next + this.results.length) % this.results.length);
  }

  /** Bottom hint strip — reflects what Enter / Alt+Enter / Tab / Esc
   *  actually do given the current mode and the selected result. */
  private renderHints(): void {
    const sel = this.results[this.selected];
    const inFile = !!this.inFile;
    const segs: string[] = [];

    if (this.results.length > 0) segs.push('↑↓ navigate');
    if (sel) {
      segs.push(`↵ ${enterVerb(sel.source)}`);
      // Alt+Enter (insert at end of doc) only applies to inserts.
      if (isInsertSource(sel.source)) segs.push('⌥↵ at end');
      // In-file: any header can be transcluded (live zone) instead of copied.
      if (inFile && sel.source === 'fileobject' && !this.transcludeMode) {
        segs.push('⌘↵ transclude');
      }
    }
    // Tab: dive into a selected file, else open the tag filter — and
    // nothing while already inside a file.
    if (!inFile) {
      segs.push(sel?.source === 'file' ? '⇥ search inside' : '⇥ tags');
    }
    if (sel?.source === 'file') segs.push(sel.pinned ? 'alt+p unpin' : 'alt+p pin');
    // Outline browse (in-file, empty query) → mention collapse.
    if (inFile && this.input.value.trim() === '' && this.results.some((r) => r.collapsible)) {
      segs.push('right-click: expand/collapse');
    }
    segs.push(inFile ? 'esc back to files' : 'esc close');

    this.hintsEl.replaceChildren(
      ...segs.map((s) => {
        const span = document.createElement('span');
        span.textContent = s;
        return span;
      }),
    );
  }

  private renderResults(): void {
    this.renderHints();
    this.resultsEl.innerHTML = '';
    this.rowEls = [];
    if (this.results.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pmd-qcs-empty';
      empty.textContent = this.emptyText;
      this.resultsEl.appendChild(empty);
      return;
    }
    this.results.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'pmd-qcs-row';
      row.setAttribute('role', 'option');
      if (i === this.selected) {
        row.classList.add('pmd-qcs-row-active');
        row.setAttribute('aria-selected', 'true');
      }
      // Outline browse: indent by heading depth for a nav-pane look.
      if (r.indentLevel) {
        row.style.paddingLeft = `${0.5 + (r.indentLevel - 1) * 1}rem`;
      }
      const top = document.createElement('div');
      top.className = 'pmd-qcs-row-top';
      // Outline rows get a collapse chevron (collapsible) or a spacer
      // (to keep labels aligned). Right-click the row also toggles.
      if (r.indentLevel !== undefined) {
        const twisty = document.createElement('span');
        twisty.className = 'pmd-qcs-twisty';
        if (r.collapsible) {
          twisty.classList.add('pmd-qcs-twisty-btn');
          twisty.appendChild(icon(r.collapsed ? 'chevron-right' : 'chevron-down'));
          twisty.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (r.outlineIndex !== undefined) this.toggleOutlineCollapse(r.outlineIndex);
          });
        }
        top.appendChild(twisty);
        row.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          if (r.collapsible && r.outlineIndex !== undefined) {
            this.toggleOutlineCollapse(r.outlineIndex);
          }
        });
      }
      const badge = document.createElement('span');
      badge.className = `pmd-qcs-row-badge pmd-qcs-badge-${r.source}`;
      badge.textContent = badgeText(r);
      top.appendChild(badge);
      const name = document.createElement('span');
      name.className = 'pmd-qcs-row-name';
      name.textContent = r.name;
      top.appendChild(name);
      let meta: HTMLSpanElement | null = null;
      if (r.meta) {
        meta = document.createElement('span');
        meta.className = 'pmd-qcs-row-tags';
        meta.textContent = r.meta;
        top.appendChild(meta);
      }
      // Tooltip with the full name / directory, but only when the
      // ellipsis actually cut something off. Checked lazily on hover
      // — layout isn't final while rows are being built, and this
      // stays correct across palette resizes.
      row.addEventListener('mouseenter', () => {
        for (const el of meta ? [name, meta] : [name]) {
          if (el.scrollWidth > el.clientWidth) el.title = el.textContent ?? '';
          else el.removeAttribute('title');
        }
      });
      // Pin star on file rows — filled when pinned, faint otherwise.
      // Click the star to toggle the pin.
      if (r.source === 'file' && r.filePath) {
        const path = r.filePath;
        const star = document.createElement('span');
        star.className = r.pinned ? 'pmd-qcs-star pmd-qcs-star-on' : 'pmd-qcs-star';
        star.textContent = '★';
        star.title = r.pinned ? 'Unpin' : 'Pin (keep warm)';
        star.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.togglePinPath(path);
        });
        top.appendChild(star);
        // Right-click dives into the file — same as Tab. Pinning has its own
        // star, so the context menu is free for the more useful action.
        row.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          this.selected = i;
          void this.enterInFile();
        });
      }
      row.appendChild(top);
      if (!r.matchedName && r.snippet) {
        const snip = document.createElement('div');
        snip.className = 'pmd-qcs-row-snippet';
        snip.textContent = r.snippet;
        row.appendChild(snip);
      }
      row.addEventListener('mousemove', () => {
        if (this.selected !== i) this.setSelected(i);
      });
      row.addEventListener('click', (e) => {
        this.selected = i;
        this.activateSelected(false, e.metaKey || e.ctrlKey);
      });
      this.resultsEl.appendChild(row);
      this.rowEls.push(row);
    });
    // Overflow indicator + expander. A div (not a button) so clicking it
    // can't steal focus from the search input, which owns the keyboard.
    if (this.fullResults.length > this.results.length) {
      const more = document.createElement('div');
      more.className = 'pmd-qcs-more';
      more.setAttribute('role', 'button');
      more.textContent = `Showing ${this.results.length} of ${this.fullResults.length} — show more`;
      more.addEventListener('click', () => this.showMore());
      this.resultsEl.appendChild(more);
    }
    this.resultsEl.querySelector('.pmd-qcs-row-active')?.scrollIntoView({ block: 'nearest' });
  }

  /** Move the active-row highlight without rebuilding the list.
   *  Selection changes (hover, arrow keys) only need the active class
   *  swapped between two rows plus a hints refresh — a full rebuild
   *  here is O(rows) per event (and outline browse is uncapped).
   *  `renderResults` remains the path for changes to `results` itself. */
  private setSelected(i: number): void {
    const prev = this.rowEls[this.selected];
    if (prev) {
      prev.classList.remove('pmd-qcs-row-active');
      prev.removeAttribute('aria-selected');
    }
    this.selected = i;
    const next = this.rowEls[i];
    if (next) {
      next.classList.add('pmd-qcs-row-active');
      next.setAttribute('aria-selected', 'true');
      next.scrollIntoView({ block: 'nearest' });
    }
    this.renderHints();
  }

  // ── Insert ────────────────────────────────────────────────────────

  private activateSelected(atEnd: boolean, transclude = false): void {
    const result = this.results[this.selected];
    if (!result) return;
    // Commands: close the palette, then run the command (it acts on the
    // editor with focus restored). atEnd is irrelevant for commands.
    if (result.source === 'command') {
      const id = result.commandId!;
      this.close();
      this.runCommand(id);
      return;
    }
    // Setting toggle: flip the boolean in place and confirm with a toast.
    // The settings subscriber propagates the change to the live view / other
    // windows, so there's nothing else to wire here.
    if (result.source === 'settingtoggle') {
      this.close();
      runSettingToggle(result.toggleSettingKey!);
      return;
    }
    // Setting cycle: advance the enum/mode setting to its next value.
    if (result.source === 'settingcycle') {
      this.close();
      runSettingCycle(result.cycleSettingKey!);
      return;
    }
    // Settings: close the palette, then open the dialog to the tab and
    // scroll to the setting. atEnd is irrelevant. settings-ui is
    // lazy-loaded (see index.ts) — first open fetches its chunk.
    if (result.source === 'settings') {
      const target = result.settingsTarget;
      this.close();
      void import('./settings-ui.js').then((m) => m.openSettings(target));
      return;
    }
    // File: close the palette, then open the document. atEnd irrelevant.
    if (result.source === 'file') {
      const path = result.filePath;
      const name = result.name;
      if (path) recordUsage(path); // counts toward "frequents"
      this.close();
      if (path) this.openFilePath(path, name);
      return;
    }
    // Everything else (quickcard / dropzone / fileobject) inserts a slice.
    const view = this.view;
    if (!view || !view.editable) {
      showToast('No editable document to insert into.');
      return;
    }
    // Transclude a selected header into a live zone instead of a copy — either
    // per-pick via Mod+Enter / Mod+click while browsing normally, or by default
    // when the palette was opened in transclude mode. Keeps the palette open so
    // several can be grabbed in a row.
    if (
      (transclude || this.transcludeMode) &&
      result.source === 'fileobject' &&
      result.fileRange &&
      this.inFile
    ) {
      void this.insertLiveZoneFromFileObject(result);
      return;
    }
    let slice: Slice;
    try {
      if (result.source === 'fileobject' && result.fileRange && this.inFile) {
        // Slice lazily from the kept parsed doc (no per-object slice held).
        slice = this.inFile.doc.slice(result.fileRange.from, result.fileRange.to);
      } else {
        slice = Slice.fromJSON(schema, result.sliceJson as Parameters<typeof Slice.fromJSON>[1]);
      }
    } catch {
      showToast('That item is corrupted and can’t be inserted.');
      return;
    }
    // Inserting a within-file object keeps the palette open and the file
    // loaded so several blocks can be grabbed in a row (the file's slices
    // are already in memory — no re-parse). Everything else closes.
    //
    // The mid-text guard is a native `window.confirm`, so it can't
    // trigger the outside-click close. The disruption to guard against is
    // focus: insertSpeechSlice's deferred insert ends with a
    // `speechView.focus()`, so we re-claim the bar via `afterInsert`
    // (which also runs only on a real insert — no toast on cancel).
    const keepOpen = !!this.inFile && result.source === 'fileobject';
    if (!keepOpen) this.close();
    const name = result.name;
    insertSpeechSlice(
      view,
      slice,
      atEnd,
      keepOpen
        ? () => {
            showToast(`Inserted "${name}".`);
            this.input.focus();
          }
        : undefined,
    );
    // insertSpeechSlice's deferred dispatch ends by focusing the editor view;
    // pull focus back to the bar so a keep-open insert leaves you ready to
    // search again.
    if (keepOpen) this.input.focus();
  }

  /** Build and insert a live zone from a selected header inside the dived-into
   *  file. Snapshots the section now (the file is already parsed), computes a
   *  portable source ref, and guards against direct self-embedding. */
  private async insertLiveZoneFromFileObject(result: PaletteResult): Promise<void> {
    const view = this.view;
    if (!view || !this.inFile || !result.fileRange) return;
    const inFile = this.inFile;
    const headingNode = inFile.doc.nodeAt(result.fileRange.from);
    const headingId =
      headingNode && typeof headingNode.attrs['id'] === 'string' ? headingNode.attrs['id'] : '';
    const roots = (settings.get('fileSearchRoots') as string[] | undefined) ?? [];
    const outcome = buildLiveZoneAttrs(
      schema,
      inFile.doc,
      headingId,
      inFile.name,
      this.docPath,
      inFile.path,
      roots,
    );
    if (!outcome.ok || !outcome.attrs) {
      showToast(buildZoneErrorMessage(outcome.reason));
      return;
    }
    // A `.docx` source can only refresh if the heading carries a stable
    // `pmd-heading` bookmark. If it doesn't, offer to add one (a tiny bookmark,
    // nothing else changes); if that can't happen, refuse rather than create a
    // zone that could never refresh. `.cmir` sources already carry stable ids.
    if (inFile.path.toLowerCase().endsWith('.docx')) {
      const ready = await this.ensureDocxSourceAnchor(
        result.fileRange.from,
        headingId,
        headingNode?.textContent ?? '',
        outcome.attrs,
        roots,
      );
      if (!ready) return; // messaged inside
      // The palette may have closed while we awaited the read/confirm/write.
      if (!this.root || this.view !== view) return;
    }
    if (this.rePickTarget != null) {
      // Re-pick source: re-target the existing zone in place (one-shot → close).
      const ok = replaceZoneAtPos(
        view,
        this.rePickTarget.pos,
        this.rePickTarget.identity,
        outcome.attrs,
        outcome.content,
      );
      showToast(ok ? `Re-linked live zone "${outcome.headingLabel}".` : 'That live zone is no longer here.');
      this.close();
      return;
    }
    insertZoneAtSelection(view, outcome.attrs, outcome.content);
    showToast(`Inserted live zone "${outcome.headingLabel}".`);
    this.input.focus();
  }

  /** Ensure a `.docx` source's picked heading carries a `pmd-heading` bookmark
   *  so the live zone can refresh from it. Reads the file, re-derives the
   *  heading's source-paragraph index (a provenance re-parse — node positions
   *  are stable across parses even though a raw Word file's heading ids aren't),
   *  injects a single bookmark in-memory, and — only when a write is actually
   *  needed — confirms before writing it back atomically. Returns true when the
   *  file is anchored (safe to create the zone); false, with a toast, when it
   *  can't be, so we never create a zone that could never refresh. */
  private async ensureDocxSourceAnchor(
    headingPos: number,
    headingId: string,
    expectedText: string,
    attrs: TransclusionAttrs,
    roots: string[],
  ): Promise<boolean> {
    const electron = getElectronHost();
    if (!electron || !this.docPath) {
      showToast('Live zones from Word files need the desktop app.');
      return false;
    }
    const sourceAbs = attrs.source_abs ?? '';
    const file = await electron.readCmirFile(
      this.docPath,
      attrs.source_ref,
      attrs.source_ref_base,
      roots,
      sourceAbs,
    );
    if (!file) {
      showToast('Couldn’t read the source file to prepare it for live updates.');
      return false;
    }
    // Re-parse WITH provenance and find the picked heading at the same position
    // (structure is identical across parses); look up its source-paragraph index.
    const prov = new Map<string, number>();
    let freshDoc: PMNode;
    try {
      freshDoc = await fromDocx(file.bytes, prov);
    } catch {
      showToast('Couldn’t read the Word source file.');
      return false;
    }
    const freshHeading = freshDoc.nodeAt(headingPos);
    const freshId =
      freshHeading && typeof freshHeading.attrs['id'] === 'string' ? freshHeading.attrs['id'] : '';
    const srcPara = freshId ? prov.get(freshId) : undefined;
    if (srcPara == null) {
      showToast('This Word heading can’t be tracked for live updates — save the source as .cmir.');
      return false;
    }
    const anchor = await ensureHeadingAnchor(file.bytes, srcPara, headingId, expectedText);
    if (!anchor.ok) {
      showToast('This Word file can’t be prepared as a live source — save it as .cmir.');
      return false;
    }
    if (!anchor.added) return true; // already anchored — nothing to write.
    // A new bookmark must be written back — get explicit consent first, since
    // this modifies a file the user may share.
    const consented =
      typeof window !== 'undefined' &&
      window.confirm(
        `Add a live-update anchor to “${this.inFile?.name ?? 'this Word file'}”?\n\n` +
          'This writes a small bookmark to the Word file so this section can be ' +
          'refreshed later. Nothing else in the file changes.',
      );
    if (!consented) {
      showToast('Live zone not created — the Word file was left unchanged.');
      return false;
    }
    const written = await electron.writeSourceAnchor(
      this.docPath,
      attrs.source_ref,
      attrs.source_ref_base,
      roots,
      sourceAbs,
      anchor.bytes,
    );
    if (!written.ok) {
      showToast('Couldn’t write to the Word file (it may be read-only or open in Word).');
      return false;
    }
    return true;
  }

  // ── Inline tag filter (Tab) ───────────────────────────────────────

  private openTagFilter(): void {
    renderTagPicker(
      this.tagFilterEl,
      () => this.runSearch(),
      () => {
        this.tagFilterEl.hidden = true;
        this.input.focus();
      },
    );
    this.tagFilterEl.hidden = false;
    this.tagFilterEl.querySelector<HTMLInputElement>('.pmd-qctags-filter')?.focus();
  }
}

export const quickCardSearchUI = new QuickCardSearchUI();

// ── Shared tag-picker (inline + ribbon dropdown) ─────────────────────

/** Render a keyboard-navigable, type-to-filter tag list into `host`,
 *  editing the global `quickCardActiveTags`. Auto-selects the best
 *  (top) match; ↑/↓ move, Enter toggles, Esc calls `onDismiss` (Tab
 *  is swallowed, not a dismiss). `onChange` fires after any toggle. */
function renderTagPicker(host: HTMLElement, onChange: () => void, onDismiss: () => void): void {
  host.innerHTML = '';
  const all = distinctTags(quickCardsStore.list());
  let shown: string[] = all;
  let selected = 0;

  const filter = document.createElement('input');
  filter.type = 'text';
  filter.className = 'pmd-qctags-filter';
  filter.placeholder = 'Filter tags…';
  filter.spellcheck = false;
  filter.autocomplete = 'off';
  host.appendChild(filter);

  const list = document.createElement('div');
  list.className = 'pmd-qctags-list';
  host.appendChild(list);

  const computeShown = (): void => {
    const q = normalizeTag(filter.value);
    shown = all
      .filter((t) => (q ? normalizeTag(t).includes(q) : true))
      .sort((a, b) => {
        if (!q) return 0;
        const d = normalizeTag(a).indexOf(q) - normalizeTag(b).indexOf(q);
        return d !== 0 ? d : a.toLowerCase().localeCompare(b.toLowerCase());
      });
    selected = 0;
  };

  const rowEls: HTMLElement[] = [];
  const renderList = (): void => {
    const active = activeTagSet();
    list.innerHTML = '';
    rowEls.length = 0;
    if (all.length === 0) {
      const none = document.createElement('div');
      none.className = 'pmd-qctags-empty';
      none.textContent = 'No tags yet.';
      list.appendChild(none);
      return;
    }
    shown.forEach((tag, i) => {
      const row = document.createElement('label');
      row.className = 'pmd-qctags-row';
      if (i === selected) row.classList.add('pmd-qctags-row-active');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.tabIndex = -1;
      cb.checked = active.has(normalizeTag(tag));
      cb.addEventListener('change', () => toggle(tag));
      const span = document.createElement('span');
      span.textContent = tag;
      row.append(cb, span);
      row.addEventListener('mousemove', () => {
        if (selected !== i) setSelected(i);
      });
      list.appendChild(row);
      rowEls.push(row);
    });
    list.querySelector('.pmd-qctags-row-active')?.scrollIntoView({ block: 'nearest' });
  };

  // In-place active-row swap for selection moves (hover / arrows) —
  // full renderList rebuilds are reserved for content changes
  // (filter text, checkbox toggles).
  const setSelected = (i: number): void => {
    rowEls[selected]?.classList.remove('pmd-qctags-row-active');
    selected = i;
    const next = rowEls[i];
    if (next) {
      next.classList.add('pmd-qctags-row-active');
      next.scrollIntoView({ block: 'nearest' });
    }
  };

  const toggle = (tag: string): void => {
    const next = new Set(settings.get('quickCardActiveTags').map(normalizeTag));
    const n = normalizeTag(tag);
    if (next.has(n)) next.delete(n);
    else next.add(n);
    settings.set('quickCardActiveTags', [...next]);
    onChange();
    renderList();
  };

  filter.addEventListener('input', () => {
    computeShown();
    renderList();
  });
  filter.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        onDismiss();
        break;
      case 'Tab':
        // Only Escape dismisses ("Tab in, Esc out", consistent with file
        // search); preventDefault so focus can't escape the picker.
        e.preventDefault();
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (shown.length) setSelected((selected + 1) % shown.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (shown.length) setSelected((selected - 1 + shown.length) % shown.length);
        break;
      case 'Enter':
        e.preventDefault();
        if (shown[selected]) toggle(shown[selected]!);
        break;
    }
  });

  const footer = document.createElement('div');
  footer.className = 'pmd-qctags-footer';
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'pmd-qctags-clear';
  clear.textContent = 'Clear filter';
  clear.addEventListener('click', () => {
    settings.set('quickCardActiveTags', []);
    onChange();
    renderList();
  });
  footer.appendChild(clear);
  host.appendChild(footer);

  computeShown();
  renderList();
}

/** Ribbon Tag Picker dropdown — a standalone popover anchored under
 *  the 🏷️ button, editing the same global active-tags filter. */
export function openQuickCardTagPicker(anchorEl: HTMLElement): void {
  const existing = document.querySelector('.pmd-qctags-popover');
  if (existing) {
    existing.remove();
    return;
  }
  const pop = document.createElement('div');
  pop.className = 'pmd-qctags-popover';
  document.body.appendChild(pop);
  const rect = anchorEl.getBoundingClientRect();
  pop.style.left = `${Math.round(rect.left)}px`;
  pop.style.top = `${Math.round(rect.bottom + 4)}px`;

  const close = (): void => {
    pop.remove();
    document.removeEventListener('pointerdown', onDown, true);
  };
  const onDown = (e: PointerEvent): void => {
    if (!pop.contains(e.target as Node) && e.target !== anchorEl) close();
  };
  document.addEventListener('pointerdown', onDown, true);
  renderTagPicker(pop, () => {}, close);
  pop.querySelector<HTMLInputElement>('.pmd-qctags-filter')?.focus();
}
