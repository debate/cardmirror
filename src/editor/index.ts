/**
 * Minimal browser editor — v0.
 *
 * Mounts a ProseMirror EditorView with our schema. Lets the user drop a
 * .docx, see it rendered, and export it back. This exists as a visual
 * sanity check while we build the foundation; full editor UX (read mode,
 * navigation panel, send-to-speech, drag-and-drop, etc.) is later work.
 */

import { EditorState, Plugin, Selection, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { history, undo, redo } from 'prosemirror-history';
import { baseKeymap } from 'prosemirror-commands';
import { Node as PMNode, type Mark } from 'prosemirror-model';
import { schema, newHeadingId } from '../schema/index.js';
import { fromDocxFull, toDocx, serializeNative, parseNative } from '../index.js';
import { transformForExport } from '../export/transform-for-export.js';
import type { Thread } from './comments-plugin.js';
import { NavigationPanel } from './nav-panel.js';
import { openSettings } from './settings-ui.js';
import { openReference } from './reference-ui.js';
import {
  getSpeechDocResolver,
  installElectronSpeechDocResolver,
} from './speech-doc-registry.js';
import {
  sendToSpeech as runSendToSpeech,
  installIncomingSpeechSliceHandler,
} from './speech-doc-send.js';
import { promptForText } from './text-prompt.js';
import { openDocMenu } from './doc-menu-ui.js';
import { createReference } from './create-reference.js';
import { showToast } from './toast.js';
import {
  settings,
  condenseWarningCloseFor,
  DISPLAY_SIZE_KEYS,
  DISPLAY_COLOR_KEYS,
  type DisplaySizes,
  type DisplayTypography,
  type DisplayColors,
  type FormattingPanelMode,
} from './settings.js';
import { openSaveAs } from './save-as-ui.js';
import { commentsPlugin, commentsKey, loadThreads, getCommentsState, gcOrphanThreads } from './comments-plugin.js';
import { scheduleIdle, cancelIdle, type IdleHandle } from './idle-scheduler.js';
import { CommentsColumn, addCommentToSelection } from './comments-ui.js';
import { runAiCreateCite } from './ai/cite-creator.js';
import { readModePlugin, PMD_READ_MODE_TOGGLE } from './read-mode-plugin.js';
import { absorbPlugin } from './absorb-plugin.js';
import { citeClassifierPlugin } from './cite-classifier-plugin.js';
import { namedStyleNormalizerPlugin } from './named-style-normalizer-plugin.js';
import { fontSizeClassPlugin } from './font-size-class-plugin.js';
import { buildSimilarSelectionPlugin } from './similar-selection-plugin.js';
import { findReplacePlugin } from './find-replace-plugin.js';
import { FindReplaceBar } from './find-replace-ui.js';
import { tableEditing, columnResizing } from 'prosemirror-tables';
import { buildPastePlugin } from './paste-plugin.js';
import { buildImageNodeFromBlob, insertImageNode } from './image-insert.js';
import { imageContextMenuPlugin } from './image-context-menu-plugin.js';
import { editorDragSurface } from './drag-editor-surface.js';
import {
  backspaceAtTagStart,
  backspaceAtFirstBodyStart,
  deleteAtTagEnd,
  deleteAtContainerEnd,
  enterMidTag,
  enterAtTagEnd,
  enterInHeading,
} from './tag-keymap.js';
import { indentParagraph, outdentParagraph } from './indent-keymap.js';
import {
  buildRibbonKeymap,
  getRibbonCommand,
  formatKeyForDisplay,
  primaryKeyFor,
  ribbonKeyStringFor,
  ribbonCommandForKey,
  setFontSize,
  adjustFontSize,
  compileShrinkProtections,
  RIBBON_COMMAND_LABELS,
  type StructuralRibbonCommandId,
  type RibbonContext,
  type RibbonCommandId,
} from './ribbon-commands.js';
import { openWordCount } from './word-count-ui.js';
import { wireColorPanel } from './color-panel.js';
import { countReadAloudWords, formatReadTime, formatNumber } from './word-count.js';
import { getHost, getElectronHost, type OpenedFile, type JournalEntry } from './host/index.js';

// Tag the body with the host kind so CSS can gate platform-specific
// chrome (e.g. the plain-paste toggle button only appears in the
// browser edition; the autosave button only appears on desktop).
document.body.classList.add('pmd-host-' + getHost().kind);

const editorEl = document.getElementById('editor')!;

/** Mousedown handler: when the user clicks below the rendered
 *  content of `view.dom` but still inside the editor wrapper, drop
 *  the cursor at the doc's end and focus the view. PM's built-in
 *  click handling only fires for clicks that land inside the
 *  contenteditable surface; on a near-empty doc (a single empty
 *  paragraph) `view.dom`'s rendered height is ~20px, so clicks in
 *  the editor's empty whitespace below it do nothing — the user
 *  has to aim at the tiny rendered paragraph. This handler closes
 *  that gap. Wired once per editor surface (single-doc + each
 *  multi-pane DocRecord). Restrict to clicks OUTSIDE `view.dom`
 *  AND vertically below its bottom so we never hijack a click PM
 *  would handle naturally. */
export function attachClickBelowToEnd(
  wrapperEl: HTMLElement,
  getView: () => EditorView | null,
): void {
  wrapperEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const v = getView();
    if (!v) return;
    if (e.target instanceof Node && v.dom.contains(e.target)) return;
    const rect = v.dom.getBoundingClientRect();
    if (e.clientY <= rect.bottom) return;
    e.preventDefault();
    const tr = v.state.tr.setSelection(Selection.atEnd(v.state.doc));
    v.dispatch(tr.scrollIntoView());
    v.focus();
  });
}
// Wire it for the single-doc editor surface. Multi-pane wires its
// own per-record surface in `buildDocRecord`.
attachClickBelowToEnd(editorEl, () => view);
const navEl = document.getElementById('nav-panel')!;
const openBtn = document.getElementById('open-btn') as HTMLButtonElement;
const newBtn = document.getElementById('new-btn') as HTMLButtonElement | null;
const exportBtn = document.getElementById('export-btn') as HTMLButtonElement;
const autosaveBtn = document.getElementById('autosave-btn') as HTMLButtonElement | null;
const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement;
const referenceBtn = document.getElementById('reference-btn') as HTMLButtonElement | null;
const readModeBtn = document.getElementById('read-mode-btn') as HTMLButtonElement;
const insertImageBtn = document.getElementById('insert-image-btn') as HTMLButtonElement | null;
// Speech-doc buttons. Only visible in multi-doc mode (CSS-gated on
// `body.pmd-multi-doc`); the click handlers below route into the
// shell's ctx implementations, which are no-ops in single-doc.
const speechNewBtn = document.getElementById('speech-new-btn') as HTMLButtonElement | null;
const speechMarkBtn = document.getElementById('speech-mark-btn') as HTMLButtonElement | null;
const speechSendCursorBtn = document.getElementById('speech-send-cursor-btn') as HTMLButtonElement | null;
const speechSendEndBtn = document.getElementById('speech-send-end-btn') as HTMLButtonElement | null;
/** Resolver for "what value should the read-mode ribbon button
 *  show as pressed?". Single-doc mode reads `settings.readMode`;
 *  multi-doc swaps in a resolver that asks the focused pane's
 *  per-DocRecord state via `setReadModeStateResolver`.
 *  Declared up here (not next to `setReadModeStateResolver`)
 *  because `applyReadMode` runs at module-init time before the
 *  bottom-of-file declarations execute — a TDZ access otherwise. */
let readModeStateForActive: () => boolean = () => settings.get('readMode');

/** Resolver for "is autosave on for the doc the ribbon should
 *  reflect?". Single-doc reads the (transient) `settings.autosaveEnabled`
 *  value; multi-doc swaps in a resolver that asks the focused
 *  pane's per-DocRecord state via `setAutosaveStateResolver`. */
let autosaveStateForActive: () => boolean = () => settings.get('autosaveEnabled');

// Install the Electron-aware speech-doc resolver before any
// subscribers attach. On the browser this is a no-op; on Electron
// it swaps in the main-process-mirroring resolver so doc
// registrations and speech-set calls flow through IPC.
installElectronSpeechDocResolver(getHost());

/** Sync the speech-mark button's aria-pressed with whether the
 *  currently-active view IS the speech doc. Called from
 *  `setActiveView` (focus change) and from the speech-doc
 *  registry subscription installed below. Also drives the
 *  multi-window speech-doc banner (the prominent "🎤 This is the
 *  speech document" strip below the ribbon). */
function refreshSpeechMarkBtn(): void {
  const resolver = getSpeechDocResolver();
  const isSpeechDoc =
    !!view && resolver.getSpeechUid() === currentDocUid;
  if (speechMarkBtn) {
    speechMarkBtn.setAttribute('aria-pressed', isSpeechDoc ? 'true' : 'false');
  }
  // Banner is only meaningful when this window IS the speech doc.
  // Multi-pane mode hides it via CSS (it uses per-pane chips); the
  // body class toggle here just controls the multi-window case.
  const banner = document.getElementById('speech-doc-banner');
  if (banner) banner.hidden = !isSpeechDoc;
  document.body.classList.toggle('pmd-speech-banner-visible', isSpeechDoc);
}

/** Single-doc mark-as-speech toggle. Routes through the resolver,
 *  which (on Electron) propagates the change to main and broadcasts
 *  to every window. */
function toggleMarkSingleDocAsSpeech(): void {
  const resolver = getSpeechDocResolver();
  if (resolver.isSpeechByUid(currentDocUid)) {
    resolver.setSpeechByUid(null);
  } else {
    resolver.setSpeechByUid(currentDocUid);
  }
}

/** Single-doc send-to-speech. Just hands off to the shared helper,
 *  which decides whether to insert locally (speech doc is in THIS
 *  renderer) or route via main (speech doc is in another window). */
function runSingleDocSendToSpeech(sourceView: EditorView, atEnd: boolean): void {
  runSendToSpeech(sourceView, atEnd);
}

/** Single-doc new-speech-document. Verbatim's `NewSpeech` prompts
 *  for a round name ("1NC", "2AC vs Hogwarts") and builds a fresh
 *  speech doc titled accordingly. In multi-window mode we spawn a
 *  new window pre-loaded with that doc and ask the spawned window
 *  to self-mark as the speech doc once it mounts. If the
 *  `defaultSpeechDocFolder` setting is set, we save the doc into
 *  that folder before spawning so the new window opens with a
 *  real handle (subsequent ⌘S writes silently in place); when
 *  unset, the new window opens unsaved and the user picks a save
 *  location later via Save As. */
async function runNewSpeechDocumentSingleDoc(): Promise<void> {
  const host = getHost();
  if (!host.canSpawnWindow) {
    window.alert(
      'New Speech Document requires the desktop edition (multi-window).',
    );
    return;
  }
  // Electron disables window.prompt(); use an in-renderer modal
  // instead. Trims the result for us and returns null on cancel.
  const roundName = await promptForText({
    message: 'Which speech? (e.g. 1NC, 2AC Round 3 vs Hogwarts)',
    placeholder: '1NC',
    okLabel: 'Create',
  });
  if (roundName == null) return;
  if (!roundName) return;
  const trimmed = roundName;

  const format = settings.get('defaultSpeechDocFormat');
  const filename = formatSpeechFilename(trimmed, format);
  // Pocket heading is the filename minus its extension when the
  // user has opted in; otherwise start fully blank. Off case lets
  // users title their speeches inline rather than via the chip.
  const docNode = settings.get('includeSpeechDocPocket')
    ? makeSpeechBlankDoc(filename.replace(/\.(cmir|docx)$/i, ''))
    : makeBlankNewDoc();

  let docBytes: Uint8Array;
  try {
    docBytes =
      format === 'cmir' ? serializeNative(docNode) : await toDocx(docNode);
  } catch (err) {
    console.error('Speech-doc serialization failed:', err);
    alert(
      `Couldn't create speech document: ${err instanceof Error ? err.message : err}`,
    );
    return;
  }

  // Optional auto-save into the user's configured speech-doc
  // folder. Skipped silently when the setting is empty (matches
  // the user's intent that no folder = no automatic save).
  let handle: string | null = null;
  const defaultFolder = settings.get('defaultSpeechDocFolder').trim();
  if (defaultFolder) {
    const targetPath = joinSpeechDocPath(defaultFolder, filename);
    try {
      await host.saveExisting(targetPath, docBytes);
      handle = targetPath;
    } catch (err) {
      console.warn('Auto-save of new speech doc to default folder failed:', err);
      // Continue without a handle; the user can Save As later.
    }
  }

  const uid = newSessionDocUid();
  try {
    await host.spawnWindow({
      filename,
      bytes: docBytes,
      handle,
      format,
      uid,
      markAsSpeech: true,
    });
  } catch (err) {
    console.error('Failed to spawn new speech window:', err);
    alert(
      `Failed to open new speech window: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** Format a Verbatim-style speech filename: "Speech <round> M-D
 *  H-MMam/pm.<ext>". Extension comes from the configured
 *  `defaultSpeechDocFormat` setting — `.docx` (Verbatim parity) or
 *  `.cmir` (autosave-eligible). */
function formatSpeechFilename(round: string, format: 'cmir' | 'docx'): string {
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  let hour = now.getHours();
  const minute = now.getMinutes();
  const ampm = hour < 12 ? 'AM' : 'PM';
  if (hour === 0) hour = 12;
  else if (hour > 12) hour -= 12;
  const m = String(minute).padStart(2, '0');
  return `Speech ${round} ${month}-${day} ${hour}-${m}${ampm}.${format}`;
}

/** Speech-doc starter: a Pocket heading carrying the user-supplied
 *  title plus a trailing empty paragraph for the cursor to land in.
 *  Same shape as multi-pane's `makeSpeechBlankDoc`. */
function makeSpeechBlankDoc(title: string): PMNode {
  return schema.nodes['doc']!.createChecked(null, [
    schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text(title)),
    schema.nodes['paragraph']!.create(null),
  ]);
}

/** Concatenate a folder path with a filename, handling trailing
 *  separators on the folder. Forward slash works on every platform
 *  Electron supports (Windows accepts both `/` and `\` in fs paths). */
function joinSpeechDocPath(folder: string, filename: string): string {
  const trimmedFolder = folder.replace(/[/\\]+$/, '');
  return `${trimmedFolder}/${filename}`;
}
// Subscribe to the speech-doc registry so the button stays in sync
// when the designation changes outside of a focus event (e.g., the
// shell marks a fresh `newSpeech` doc as soon as it lands, or main
// broadcasts a speech change made in another window).
getSpeechDocResolver().subscribe(() => refreshSpeechMarkBtn());
const wordCountBtn = document.getElementById('word-count-btn') as HTMLButtonElement;
const commentsToggleBtn = document.getElementById('comments-toggle-btn') as HTMLButtonElement | null;
const commentsAddBtn = document.getElementById('comments-add-btn') as HTMLButtonElement | null;
const commentsColumnEl = document.getElementById('comments-column') as HTMLElement | null;
const wordCountText = document.getElementById('word-count-text')!;
const plainPasteToggleBtn = document.getElementById('plain-paste-toggle-btn') as HTMLButtonElement | null;
const fontSizeInput = document.getElementById('font-size-input') as HTMLInputElement | null;
const fontSizePickerBtn = document.getElementById('font-size-picker-btn') as HTMLButtonElement | null;
const fontSizeControlEl = fontSizeInput?.parentElement as HTMLDivElement | null;
const fontSizeUpBtn = document.getElementById('font-size-up-btn') as HTMLButtonElement | null;
const fontSizeDownBtn = document.getElementById('font-size-down-btn') as HTMLButtonElement | null;

function updatePlainPasteIndicator(armed: boolean): void {
  if (!plainPasteToggleBtn) return;
  plainPasteToggleBtn.setAttribute('aria-pressed', armed ? 'true' : 'false');
}
const zoomOutBtn = document.getElementById('zoom-out-btn') as HTMLButtonElement;
const zoomInBtn = document.getElementById('zoom-in-btn') as HTMLButtonElement;
const zoomResetBtn = document.getElementById('zoom-reset-btn') as HTMLButtonElement;
const zoomPct = document.getElementById('zoom-pct')!;

// Module-level state. Declared before the settings subscriber registers
// so that `applyReadMode` can read `view` without a temporal-dead-zone
// ReferenceError on initial call.
let view: EditorView | null = null;
let currentDoc: PMNode = makeNewDocBody();

/** Multi-doc workspace gate. When true, the multi-pane shell has
 *  taken over the main shell — it manages its own EditorViews and
 *  pushes the focused pane's view into the module-level `view`
 *  variable below via `setActiveView`. The single-doc open / mount
 *  paths delegate to the shell instead. */
let multiDocActive = false;
/** When the multi-pane shell is active, this delegates file-open
 *  routing to its prompt-for-slot flow. */
let multiDocOnFileOpen: ((opened: OpenedFile) => Promise<void> | void) | null = null;
/** When the multi-pane shell is active, this delegates the
 *  "New doc" ribbon button to the shell's slot-routing flow. */
let multiDocOnNewDoc: (() => Promise<void> | void) | null = null;
/** When the multi-pane shell is active, this delegates the
 *  read-mode ribbon button to the shell's per-pane toggle. */
let multiDocToggleReadMode: (() => void) | null = null;
let multiDocToggleAutosave: (() => void) | null = null;
/** Assigned by `wireColorPanel(...)` further below. Referenced by the
 *  `togglePaintbrushHighlight` / `togglePaintbrushShading` ribbon
 *  commands so users can arm the paintbrush via a keybinding. */
let colorPanel: import('./color-panel.js').ColorPanelHandle | null = null;
/** Created lazily on the first Ctrl-F / Ctrl-H press. Reads the
 *  active view via the `getView` getter so the bar follows the
 *  currently-focused pane in multi-doc mode. */
let findReplaceBar: FindReplaceBar | null = null;
function ensureFindReplaceBar(): FindReplaceBar {
  if (!findReplaceBar) {
    findReplaceBar = new FindReplaceBar(() => view);
  }
  return findReplaceBar;
}
/** Speech-doc command hooks. Installed by the multi-pane shell; in
 *  single-doc mode these stay null and the commands no-op (no
 *  second doc to send TO, and a single doc doesn't gain anything
 *  from a per-doc speech designation). */
let multiDocNewSpeechDocument: (() => void) | null = null;
let multiDocMarkActiveAsSpeech: (() => void) | null = null;
let multiDocSendToSpeechAtCursor: (() => void) | null = null;
let multiDocSendToSpeechAtEnd: (() => void) | null = null;
/** Filename plumbing for Save-As. In single-doc mode the module's
 *  `currentDocFilename` is the source of truth; in multi-doc each
 *  pane owns its own filename, so the shell installs these hooks
 *  to let Save-As read the focused pane's name and propagate the
 *  user's rename back into the chip. */
let multiDocGetFocusedFilename: (() => string | null) | null = null;
let multiDocSetFocusedFilename: ((name: string) => void) | null = null;

/** Full focused-file plumbing for the Save / Save-As flow — reads
 *  the filename plus the on-disk handle and on-disk format. */
let multiDocGetFocusedFile:
  | (() => { filename: string; handle: unknown | null; format: 'cmir' | 'docx' | null } | null)
  | null = null;
let multiDocSetFocusedFile:
  | ((file: { filename: string; handle: unknown | null; format: 'cmir' | 'docx' | null }) => void)
  | null = null;
/** Crash-recovery hook: clear the focused pane's journal after a
 *  successful save in multi-doc mode. The shell knows the
 *  DocRecord's uid; the editor only knows it has a focused doc. */
let multiDocClearFocusedJournal: (() => Promise<void>) | null = null;
let multiDocNotifyFocusedSaved: (() => void) | null = null;
/** Mode-switch hook: journal every open DocRecord across every
 *  slot's stack so the auto-recover-on-reload flow can rebuild
 *  the workspace in the new layout. */
let multiDocJournalAll: (() => Promise<void>) | null = null;
/** Crash-recovery hook: load a recovered journal entry into the
 *  multi-pane workspace. The shell picks a slot (first empty, or
 *  prompts the user) and pushes a DocRecord built from the
 *  recovered doc + threads + handle + format. */
let multiDocOnRecoveredDoc:
  | ((entry: {
      uid: string;
      filename: string;
      handle: string | null;
      format: 'cmir' | 'docx' | null;
      doc: import('prosemirror-model').Node;
      threads: Thread[];
    }) => Promise<void>)
  | null = null;

/** Multi-pane shell hooks. Called by `multi-pane-shell.ts` at boot
 *  to install the overrides that redirect the single-doc open /
 *  mountView paths into per-pane routing. */
export function enableMultiDocMode(opts: {
  onFileOpen: (opened: OpenedFile) => Promise<void> | void;
  onNewDoc?: () => Promise<void> | void;
  toggleReadMode?: () => void;
  toggleAutosave?: () => void;
  newSpeechDocument?: () => void;
  markActiveAsSpeech?: () => void;
  sendToSpeechAtCursor?: () => void;
  sendToSpeechAtEnd?: () => void;
  getFocusedFilename?: () => string | null;
  setFocusedFilename?: (name: string) => void;
  getFocusedFile?: () => { filename: string; handle: unknown | null; format: 'cmir' | 'docx' | null } | null;
  setFocusedFile?: (file: { filename: string; handle: unknown | null; format: 'cmir' | 'docx' | null }) => void;
  clearFocusedJournal?: () => Promise<void>;
  /** Called from single-doc save flows after a successful save so
   *  the multi-pane shell can clear the focused DocRecord's dirty
   *  flag (used by the per-pane close-confirm prompt). */
  notifyFocusedSaved?: () => void;
  onRecoveredDoc?: (entry: {
    uid: string;
    filename: string;
    handle: string | null;
    format: 'cmir' | 'docx' | null;
    doc: import('prosemirror-model').Node;
    threads: Thread[];
  }) => Promise<void>;
  journalAll?: () => Promise<void>;
}): void {
  multiDocActive = true;
  multiDocOnFileOpen = opts.onFileOpen;
  multiDocOnNewDoc = opts.onNewDoc ?? null;
  multiDocToggleReadMode = opts.toggleReadMode ?? null;
  multiDocToggleAutosave = opts.toggleAutosave ?? null;
  multiDocNewSpeechDocument = opts.newSpeechDocument ?? null;
  multiDocMarkActiveAsSpeech = opts.markActiveAsSpeech ?? null;
  multiDocSendToSpeechAtCursor = opts.sendToSpeechAtCursor ?? null;
  multiDocSendToSpeechAtEnd = opts.sendToSpeechAtEnd ?? null;
  multiDocGetFocusedFilename = opts.getFocusedFilename ?? null;
  multiDocSetFocusedFilename = opts.setFocusedFilename ?? null;
  multiDocGetFocusedFile = opts.getFocusedFile ?? null;
  multiDocSetFocusedFile = opts.setFocusedFile ?? null;
  multiDocClearFocusedJournal = opts.clearFocusedJournal ?? null;
  multiDocNotifyFocusedSaved = opts.notifyFocusedSaved ?? null;
  multiDocOnRecoveredDoc = opts.onRecoveredDoc ?? null;
  multiDocJournalAll = opts.journalAll ?? null;
  // Hide the single-doc surfaces. The multi-pane shell mounts its
  // own DOM into #app, alongside #editor + #comments-column which
  // we hide here.
  editorEl.hidden = true;
  if (commentsColumnEl) commentsColumnEl.hidden = true;
  // Hide the single-pane comments toggle/add buttons — comments are
  // unavailable in multi-doc mode.
  if (commentsToggleBtn) commentsToggleBtn.style.display = 'none';
  if (commentsAddBtn) commentsAddBtn.style.display = 'none';
  // Hide the global single-pane nav panel; the multi-pane shell
  // renders its own per-section nav.
  navEl.hidden = true;
  document.body.classList.add('pmd-multi-doc');
  // The shared exportBtn is enabled by the multi-pane shell once
  // any pane has a view focused — for safety, enable it here too.
  exportBtn.disabled = false;
}

/** Used by the multi-pane shell: route the shared ribbon /
 *  chrome through the currently-focused pane's view. */
export function setActiveView(v: EditorView | null): void {
  view = v;
  if (v) {
    currentDoc = v.state.doc;
  }
  // Re-sync the chrome that depends on `view` (font-size chip,
  // word-count display, paragraph integrity indicator,
  // read-mode toggle pressed-state, speech-mark button, etc.).
  refreshFontSizeDisplay();
  refreshWordCount();
  refreshReadModeBtn();
  refreshSpeechMarkBtn();
  refreshAutosaveBtn();
  updateWindowTitle();
}

/** Read-only accessor for the active view — exposed so other
 *  modules (multi-pane shell) can register listeners that need it. */
export function getActiveView(): EditorView | null {
  return view;
}

// Live context for ribbon commands that read settings at keypress
// time — active highlight / shading color for F11 / Mod-F11; condense
// behavior flags for F3 / Alt-F3 / Mod-Alt-F3.
const ribbonContext: RibbonContext = {
  highlightColor: () => settings.get('lastHighlightColor'),
  shadingColor: () => settings.get('lastShadingColor'),
  paragraphIntegrity: () => settings.get('paragraphIntegrity'),
  usePilcrows: () => settings.get('usePilcrows'),
  headingMode: () => settings.get('headingMode'),
  condenseOnPaste: () => settings.get('condenseOnPaste'),
  clearFormattingOnNamedStyleToggleOff: () =>
    settings.get('clearFormattingOnNamedStyleToggleOff'),
  effectivePtForNode: (node, parent) => effectivePtForNode(node, parent),
  normalPt: () => settings.get('displaySizes').normal,
  shrinkRestoresOmissionsToNormal: () =>
    settings.get('shrinkRestoresOmissionsToNormal'),
  shrinkProtectionPatterns: () =>
    compileShrinkProtections(
      settings.get('shrinkCustomProtections'),
      // When the user has picked Custom, feed the literal pause /
      // resume marker strings into the protection list so the
      // markers we emit are also auto-protected from shrink. The
      // six built-in delimiter shapes are already covered by the
      // static base.
      settings.get('condenseWarningDelimiter') === 'custom'
        ? settings.get('condenseWarningCustomPauseMarker')
        : '',
      settings.get('condenseWarningDelimiter') === 'custom'
        ? settings.get('condenseWarningCustomResumeMarker')
        : '',
    ),
  condenseWarningMarkers: () => {
    const d = settings.get('condenseWarningDelimiter');
    if (d === 'custom') {
      return {
        pause: settings.get('condenseWarningCustomPauseMarker'),
        resume: settings.get('condenseWarningCustomResumeMarker'),
      };
    }
    const close = condenseWarningCloseFor(d);
    return {
      pause: `${d}PARAGRAPH INTEGRITY PAUSES${close}`,
      resume: `${d}PARAGRAPH INTEGRITY RESUMES${close}`,
    };
  },
  runCreateReference: () => {
    if (!view) return;
    void createReference(
      view.state,
      effectivePtForNode,
      settings.get('forReferenceUseGray50'),
    ).then((ok) => {
      if (ok) showToast('Copied!');
    });
  },
  openWordCountDialog: () => {
    if (view) openWordCount(view);
  },
  toggleReadMode: () => {
    if (multiDocActive && multiDocToggleReadMode) {
      // Per-pane in multi-doc mode: flip the focused pane's
      // state and apply it locally without touching the global
      // setting (so the other panes keep theirs).
      multiDocToggleReadMode();
    } else {
      settings.set('readMode', !settings.get('readMode'));
    }
    if (settings.get('jumpToDocTopOnReadModeToggle') && view) {
      const tr = view.state.tr.setSelection(Selection.atStart(view.state.doc));
      view.dispatch(tr.scrollIntoView());
    }
  },
  openShortcutsReference: () => openReference(),
  toggleCommentsVisible: () => {
    // Comments are disabled in multi-doc mode; if the user has
    // rebound this command to a key, refuse rather than re-show the
    // hidden column on top of the multi-pane layout.
    if (multiDocActive) return;
    if (!commentsColumn || !commentsColumnEl) return;
    const next = commentsColumnEl.hidden;
    commentsColumn.setVisible(next);
    commentsToggleBtn?.setAttribute('aria-pressed', next ? 'true' : 'false');
    commentsColumn.render();
  },
  addCommentToSelection: () => {
    // Comments are disabled in multi-doc mode (the column is hidden
    // and the toggle/add ribbon buttons are removed). The keyboard
    // shortcut still routes here, so refuse rather than silently
    // creating a thread the user can't see.
    if (multiDocActive) return;
    if (!view || !commentsColumn) return;
    const newId = addCommentToSelection(view);
    if (!newId) return;
    if (commentsColumnEl?.hidden) {
      commentsColumn.setVisible(true);
      commentsToggleBtn?.setAttribute('aria-pressed', 'true');
    }
    commentsColumn.render();
    commentsColumn.focusReplyForThread(newId);
  },
  aiAskAboutSelection: () => {
    // Same gating as `addCommentToSelection` — AI-ask materializes
    // a comment thread, which has nowhere to live in multi-doc mode.
    if (multiDocActive) return;
    if (!view || !commentsColumn) return;
    const newId = commentsColumn.addAiThreadFromSelection(view);
    if (!newId) return;
    if (commentsColumnEl?.hidden) {
      commentsColumn.setVisible(true);
      commentsToggleBtn?.setAttribute('aria-pressed', 'true');
    }
    commentsColumn.render();
    commentsColumn.focusReplyForThread(newId);
  },
  aiCreateCite: () => {
    if (!view) return;
    runAiCreateCite(view);
  },
  newDocument: () => {
    void onNewDocClicked();
  },
  openFile: () => {
    void runOpenFlow();
  },
  save: () => {
    void runSaveFlow();
  },
  saveAs: () => {
    void runSaveAsFlow();
  },
  toggleAutosave: () => {
    if (multiDocActive && multiDocToggleAutosave) {
      multiDocToggleAutosave();
      return;
    }
    settings.set('autosaveEnabled', !settings.get('autosaveEnabled'));
  },
  newSpeechDocument: () => {
    if (multiDocNewSpeechDocument) {
      multiDocNewSpeechDocument();
      return;
    }
    void runNewSpeechDocumentSingleDoc();
  },
  markActiveAsSpeech: () => {
    if (multiDocMarkActiveAsSpeech) {
      multiDocMarkActiveAsSpeech();
      return;
    }
    toggleMarkSingleDocAsSpeech();
  },
  sendToSpeechAtCursor: () => {
    if (multiDocSendToSpeechAtCursor) {
      multiDocSendToSpeechAtCursor();
      return;
    }
    if (view) runSingleDocSendToSpeech(view, false);
  },
  sendToSpeechAtEnd: () => {
    if (multiDocSendToSpeechAtEnd) {
      multiDocSendToSpeechAtEnd();
      return;
    }
    if (view) runSingleDocSendToSpeech(view, true);
  },
  insertImage: () => {
    if (!view) return;
    openImagePicker(view);
  },
  zoomIn: () => setZoom(settings.get('zoomPct') + 10),
  zoomOut: () => setZoom(settings.get('zoomPct') - 10),
  zoomReset: () => setZoom(100),
  togglePaintbrushHighlight: () => {
    if (!view) return;
    colorPanel?.togglePaintbrush('highlight');
  },
  togglePaintbrushShading: () => {
    if (!view) return;
    colorPanel?.togglePaintbrush('shading');
  },
  openFind: () => {
    if (!view) return;
    ensureFindReplaceBar().open('find');
  },
  openFindReplace: () => {
    if (!view) return;
    ensureFindReplaceBar().open('replace');
  },
};

openBtn.addEventListener('click', () => {
  void runOpenFlow();
});
if (newBtn) {
  newBtn.addEventListener('click', () => {
    void onNewDocClicked();
  });
}


/**
 * Handle the ribbon "New document" button.
 *
 *   - Multi-doc: route through the multi-pane shell's slot picker
 *     (the new doc is added to a stack alongside whatever else is
 *     open; no "current doc" to overwrite).
 *   - Single-doc: replacing the current view is destructive, so
 *     ask first. Three-button confirm: Save → run Save As, on
 *     success swap to a fresh doc; Don't save → swap immediately;
 *     Cancel → bail. Esc / overlay click also cancel.
 */
async function onNewDocClicked(): Promise<void> {
  if (multiDocActive && multiDocOnNewDoc) {
    void multiDocOnNewDoc();
    return;
  }
  // Multi-window mode (single-doc + Electron): New always spawns a
  // new window. The current window stays put — including when it's
  // still showing the pristine starter, because the user clicking
  // New is an unambiguous request for a fresh doc to work in, not
  // a request to overwrite. No prompt: nothing in the current
  // window is at risk of being lost.
  const host = getHost();
  if (host.canSpawnWindow) {
    try {
      await host.spawnWindow(null);
    } catch (err) {
      console.error('Spawn window failed:', err);
      alert(`Failed to open new window: ${err instanceof Error ? err.message : err}`);
    }
    return;
  }
  // Web edition: no other window to open into, so New replaces
  // what's here. Only prompt to save if there are actual edits to
  // lose — the pristine starter is disposable.
  if (!isPristineStarter) {
    const choice = await confirmNewDocOverwrite();
    if (choice === 'cancel') return;
    if (choice === 'save') {
      const saved = await runSaveAsFlow();
      if (!saved) return;
    }
  }
  // Drop the old session's journal before swapping in a new doc —
  // the user's choice (or the pristine-starter shortcut) above is
  // the authoritative signal that they're done with the previous
  // content. New doc gets a fresh uid so future journals key
  // against the new session.
  void clearCurrentJournal();
  mountView(makeNewDocBody());
  currentDocFilename = null;
  currentDocHandle = null;
  currentDocFormat = null;
  currentDocUid = newSessionDocUid();
  markCurrentDocClean();
  syncSingleDocSpeechRegistration();
  // The fresh doc is conceptually still pristine, but the user
  // just demonstrated they're done with whatever was here before.
  // Treat as non-pristine so subsequent Opens spawn.
  markNonPristineStarter();
  updateWindowTitle();
}

/** Three-button overlay used by the single-doc "New document" flow.
 *  Returns the user's choice; resolves with `'cancel'` on Esc or
 *  the explicit Cancel button. */
function confirmNewDocOverwrite(): Promise<'save' | 'discard' | 'cancel'> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'pmd-route-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'pmd-route-dialog';

    const header = document.createElement('div');
    header.className = 'pmd-route-header';
    header.textContent = 'Save your current document before creating a new one?';
    dialog.appendChild(header);

    const buttons = document.createElement('div');
    buttons.className = 'pmd-route-buttons';

    const cleanup = (): void => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    };

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'pmd-route-btn';
    saveBtn.innerHTML = '<strong>Save</strong><br><span>Save the current doc, then start fresh.</span>';
    saveBtn.addEventListener('click', () => { cleanup(); resolve('save'); });
    buttons.appendChild(saveBtn);

    const discardBtn = document.createElement('button');
    discardBtn.type = 'button';
    discardBtn.className = 'pmd-route-btn';
    discardBtn.innerHTML = "<strong>Don't save</strong><br><span>Discard changes and start fresh.</span>";
    discardBtn.addEventListener('click', () => { cleanup(); resolve('discard'); });
    buttons.appendChild(discardBtn);

    dialog.appendChild(buttons);

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'pmd-route-cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => { cleanup(); resolve('cancel'); });
    dialog.appendChild(cancel);

    overlay.appendChild(dialog);
    // Click outside the dialog box → cancel.
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { cleanup(); resolve('cancel'); }
    });
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { cleanup(); resolve('cancel'); }
    };
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
  });
}
settingsBtn.addEventListener('click', () => openSettings());
/**
 * Tiny adapter to invoke a `RibbonCommandId` against the active view
 * with the live context. Used by every menu item and ribbon button so
 * a single user-defined keybinding fires the exact same code path
 * as clicking the UI — and so binding/unbinding a command never leaves
 * the UI orphaned.
 */
function runRibbon(id: RibbonCommandId): void {
  if (!view) return;
  getRibbonCommand(id, ribbonContext)(view.state, view.dispatch.bind(view), view);
}

/**
 * Open the OS file picker (single image) and insert the chosen
 * file at `targetView`'s current cursor. Same code path the paste-
 * plugin uses for clipboard image paste, just sourced from a
 * `<input type="file">` instead of `event.clipboardData`. The
 * input element is detached after use; we don't try to reuse a
 * static one because that complicates the "pick the same file
 * twice" case.
 */
function openImagePicker(targetView: EditorView): void {
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/*';
  picker.style.display = 'none';
  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    picker.remove();
    if (!file) return;
    void (async () => {
      const node = await buildImageNodeFromBlob(file);
      if (!node) {
        window.alert(`Couldn't read "${file.name}" as an image.`);
        return;
      }
      const inserted = insertImageNode(targetView, node);
      if (!inserted) {
        window.alert(
          'The cursor isn\'t in a position that accepts inline content. Click into a card body, paragraph, or heading first.',
        );
      }
    })();
  });
  document.body.appendChild(picker);
  picker.click();
}

if (referenceBtn) {
  // Call `openReference` directly (like `settingsBtn` → `openSettings`)
  // rather than dispatching through `runRibbon`, which early-bails
  // when `view` is null. The shortcuts dialog has no view
  // dependency, so it should still open in multi-doc mode when no
  // pane currently has a doc.
  referenceBtn.addEventListener('click', () => openReference());
}

if (insertImageBtn) {
  insertImageBtn.addEventListener('mousedown', (e) => e.preventDefault());
  insertImageBtn.addEventListener('click', () => runRibbon('insertImage'));
}

const docMenuBtn = document.getElementById('doc-menu-btn') as HTMLButtonElement | null;
if (docMenuBtn) {
  docMenuBtn.addEventListener('mousedown', (e) => e.preventDefault());
  docMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Sections alphabetical by title — Cleanup, Highlighting, Select.
    // Each entry that touches body text is selection-sensitive
    // (selection if non-empty, doc-wide otherwise).
    openDocMenu(docMenuBtn, view, [
      {
        title: 'Cleanup',
        items: [
          {
            label: 'Convert Analytics to Tags',
            run: () => runRibbon('convertAnalyticsToTags'),
          },
          {
            label: 'Fix Formatting Gaps',
            run: () => runRibbon('fixFormattingGaps'),
          },
          {
            label: 'Remove Hyperlinks',
            run: () => runRibbon('removeHyperlinks'),
          },
        ],
      },
      {
        title: 'Highlighting',
        items: [
          {
            label: 'Standardize Highlighting',
            run: () => runRibbon('standardizeHighlight'),
          },
          {
            label: 'Standardize Background Color',
            run: () => runRibbon('standardizeShading'),
          },
        ],
      },
      {
        title: 'Select',
        items: [
          {
            label: 'Select Similar Formatting',
            run: () => runRibbon('selectSimilar'),
          },
        ],
      },
    ]);
  });
}

// Table dropdown — same openDocMenu shape as Doc / Card, lives in
// the new normal-formatting panel. Sections alphabetical by title.
const tableMenuBtn = document.getElementById('table-menu-btn') as HTMLButtonElement | null;
if (tableMenuBtn) {
  tableMenuBtn.addEventListener('mousedown', (e) => e.preventDefault());
  tableMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openDocMenu(tableMenuBtn, view, [
      {
        title: 'Table',
        items: [
          { label: 'Insert Table (3×3)', run: () => runRibbon('insertTable') },
          { label: 'Insert Row Above', run: () => runRibbon('addRowBefore') },
          { label: 'Insert Row Below', run: () => runRibbon('addRowAfter') },
          { label: 'Insert Column Left', run: () => runRibbon('addColumnBefore') },
          { label: 'Insert Column Right', run: () => runRibbon('addColumnAfter') },
          { label: 'Delete Row', run: () => runRibbon('deleteTableRow') },
          { label: 'Delete Column', run: () => runRibbon('deleteTableColumn') },
          { label: 'Merge Cells', run: () => runRibbon('mergeTableCells') },
          { label: 'Split Cell', run: () => runRibbon('splitTableCell') },
          { label: 'Delete Table', run: () => runRibbon('deleteTable') },
        ],
      },
    ]);
  });
}

// Inline formatting toggles — same runRibbon dispatch as Mod-B/Mod-I,
// so a binding override or future shadow-selection change applies
// uniformly. Press state isn't reflected on these buttons yet (parity
// with bold/italic in the cite panel, which also don't show pressed
// state — defer until we have a generic mark-state plugin).
const superscriptBtn = document.getElementById('superscript-btn') as HTMLButtonElement | null;
if (superscriptBtn) {
  superscriptBtn.addEventListener('mousedown', (e) => e.preventDefault());
  superscriptBtn.addEventListener('click', () => runRibbon('toggleSuperscript'));
}
const subscriptBtn = document.getElementById('subscript-btn') as HTMLButtonElement | null;
if (subscriptBtn) {
  subscriptBtn.addEventListener('mousedown', (e) => e.preventDefault());
  subscriptBtn.addEventListener('click', () => runRibbon('toggleSubscript'));
}
const strikethroughBtn = document.getElementById('strikethrough-btn') as HTMLButtonElement | null;
if (strikethroughBtn) {
  strikethroughBtn.addEventListener('mousedown', (e) => e.preventDefault());
  strikethroughBtn.addEventListener('click', () => runRibbon('toggleStrikethrough'));
}

const cardMenuBtn = document.getElementById('card-menu-btn') as HTMLButtonElement | null;
if (cardMenuBtn) {
  cardMenuBtn.addEventListener('mousedown', (e) => e.preventDefault());
  cardMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Sections are kept alphabetical by title — Condense, Excerpt,
    // Highlighting. All items route through `getRibbonCommand` so a
    // user-bound key fires the same code path as clicking the menu.
    openDocMenu(cardMenuBtn, view, [
      {
        title: 'Condense',
        items: [
          { label: 'Condense', run: () => runRibbon('condenseDefault') },
          {
            label: 'Condense without paragraph integrity',
            run: () => runRibbon('condenseNoIntegrity'),
          },
          {
            label: 'Condense with pilcrows',
            run: () => runRibbon('condenseNoIntegrityWithPilcrows'),
          },
          {
            label: 'Condense with warning',
            run: () => runRibbon('condenseWithWarning'),
          },
          { label: 'Uncondense', run: () => runRibbon('uncondense') },
        ],
      },
      {
        title: 'Excerpt',
        items: [
          {
            label: 'Create Reference',
            run: () => runRibbon('createReference'),
          },
        ],
      },
      {
        title: 'Highlighting',
        items: [
          {
            label: 'Highlight to Background',
            run: () => runRibbon('highlightToShading'),
          },
          {
            label: 'Background to Highlight',
            run: () => runRibbon('shadingToHighlight'),
          },
        ],
      },
    ]);
  });
}
readModeBtn.addEventListener('click', () => runRibbon('toggleReadMode'));
wordCountBtn.addEventListener('click', () => runRibbon('wordCountSelection'));

// Speech-doc buttons — multi-doc only (CSS hides them in
// single-doc). All four route into the shell's ctx hooks. The new-
// speech button uses ribbonContext directly because it works
// without a view; the other three guard on `view` to match the
// keymap dispatch path.
if (speechNewBtn) {
  speechNewBtn.addEventListener('mousedown', (e) => e.preventDefault());
  speechNewBtn.addEventListener('click', () => ribbonContext.newSpeechDocument());
}
if (speechMarkBtn) {
  speechMarkBtn.addEventListener('mousedown', (e) => e.preventDefault());
  speechMarkBtn.addEventListener('click', () => runRibbon('markActiveAsSpeech'));
}
if (speechSendCursorBtn) {
  speechSendCursorBtn.addEventListener('mousedown', (e) => e.preventDefault());
  speechSendCursorBtn.addEventListener('click', () => runRibbon('sendToSpeechAtCursor'));
}
if (speechSendEndBtn) {
  speechSendEndBtn.addEventListener('mousedown', (e) => e.preventDefault());
  speechSendEndBtn.addEventListener('click', () => runRibbon('sendToSpeechAtEnd'));
}

// Comments column. The CommentsColumn instance owns the side-panel
// DOM; we re-render it via `view.dispatchTransaction` overrides
// further down so doc edits, plugin meta, and selection changes all
// keep the panel in sync. setVisible flips the `hidden` attr +
// stores the setting + dispatches a `set-visible` meta to the plugin.
const commentsColumn = commentsColumnEl
  ? new CommentsColumn(commentsColumnEl, () => view ?? null)
  : null;
if (commentsToggleBtn && commentsColumn) {
  commentsToggleBtn.addEventListener('click', () => {
    const next = commentsColumnEl?.hidden ?? true;
    commentsColumn.setVisible(next);
    commentsToggleBtn.setAttribute('aria-pressed', next ? 'true' : 'false');
    commentsColumn.render();
  });
}
if (commentsAddBtn && commentsColumn) {
  commentsAddBtn.addEventListener('mousedown', (e) => e.preventDefault());
  commentsAddBtn.addEventListener('click', () => {
    if (!view) return;
    const newId = addCommentToSelection(view);
    if (!newId) return;
    // Auto-reveal the column so the user can see and fill in the
    // new thread right away.
    if (commentsColumnEl?.hidden) {
      commentsColumn.setVisible(true);
      commentsToggleBtn?.setAttribute('aria-pressed', 'true');
    }
    commentsColumn.render();
    commentsColumn.focusReplyForThread(newId);
  });
}
// The "Ask AI about selection" affordance lives only on the
// keyboard now (Mod-Shift-Q by default, rebindable in the
// keybinding editor). The button used to be next to + in the
// comments panel but the user prefers the panel clean.

/** Find the threadId of a comment_range mark at the current cursor
 *  position. Returns null when the cursor isn't inside or touching
 *  one. Robust to the non-inclusive boundary cases: we check the
 *  inherited marks at $from / $to, plus the marks of the text node
 *  immediately before / after the cursor — so a cursor parked at
 *  the very start of a marked range still resolves to that thread. */
function threadIdAtCursor(state: EditorState): string | null {
  const sel = state.selection;
  const harvest = (markSources: readonly (readonly Mark[])[]): string | null => {
    for (const marks of markSources) {
      for (const m of marks) {
        if (m.type.name === 'comment_range') {
          const id = String(m.attrs['threadId'] ?? '');
          if (id) return id;
        }
      }
    }
    return null;
  };
  return harvest([
    sel.$from.marks(),
    sel.$to.marks(),
    sel.$from.nodeAfter?.marks ?? [],
    sel.$to.nodeBefore?.marks ?? [],
  ]);
}

// Zoom controls.
zoomOutBtn.addEventListener('click', () => setZoom(settings.get('zoomPct') - 10));
zoomInBtn.addEventListener('click', () => setZoom(settings.get('zoomPct') + 10));
zoomResetBtn.addEventListener('click', () => setZoom(100));

// Formatting panel — Verbatim-style ribbon buttons that dispatch the
// same commands as the F4–F7 / Mod-F7 keymap. Display mode and visual
// preview are both driven by settings (formattingPanelMode and
// formattingPanelPreview).
type FormattingPanelId =
  | StructuralRibbonCommandId
  | 'applyCite'
  | 'applyUnderline'
  | 'applyEmphasis'
  | 'clearToNormal';
const FORMATTING_PANEL_BUTTONS: Record<FormattingPanelId, string> = {
  setPocket: 'style-pocket-btn',
  setHat: 'style-hat-btn',
  setBlock: 'style-block-btn',
  setTag: 'style-tag-btn',
  setAnalytic: 'style-analytic-btn',
  setUndertag: 'style-undertag-btn',
  applyCite: 'cite-btn',
  applyUnderline: 'underline-btn',
  applyEmphasis: 'emphasis-btn',
  clearToNormal: 'normal-btn',
};
const FORMATTING_PANEL_SHORT_LABEL: Record<FormattingPanelId, string> = {
  setPocket: 'Pocket',
  setHat: 'Hat',
  setBlock: 'Block',
  setTag: 'Tag',
  setAnalytic: 'Analytic',
  setUndertag: 'Undertag',
  applyCite: 'Cite',
  applyUnderline: 'Underline',
  applyEmphasis: 'Emphasis',
  clearToNormal: 'Clear',
};
const formattingPanelEl = document.getElementById('formatting-panel') as HTMLElement | null;
const citePanelEl = document.getElementById('cite-panel') as HTMLElement | null;
const paragraphIntegrityBtn = document.getElementById('paragraph-integrity-btn') as HTMLButtonElement | null;
const formattingPanelBtnRefs: { id: FormattingPanelId; btn: HTMLButtonElement }[] = [];
for (const [id, btnId] of Object.entries(FORMATTING_PANEL_BUTTONS) as [FormattingPanelId, string][]) {
  const btn = document.getElementById(btnId) as HTMLButtonElement | null;
  if (!btn) continue;
  const label = RIBBON_COMMAND_LABELS[id];
  btn.setAttribute('aria-label', label);
  btn.addEventListener('mousedown', (e) => {
    // Don't steal focus from the editor — the command needs to act on
    // the paragraph that holds the live cursor.
    e.preventDefault();
  });
  btn.addEventListener('click', () => {
    if (!view) return;
    const cmd = getRibbonCommand(id);
    cmd(view.state, view.dispatch.bind(view));
    view.focus();
  });
  formattingPanelBtnRefs.push({ id, btn });
}

function applyFormattingPanel(
  mode: FormattingPanelMode,
  preview: boolean,
  showCharacterStyles: boolean,
): void {
  if (!formattingPanelEl) return;
  // "Hide" mode scopes to the F4–F12 button array only: the
  // structural-style sub-panel + the cite-panel sub-panel. The
  // color panel (font color / size / highlight / shading) and the
  // doc-ops panel (paragraph integrity toggle) are unaffected —
  // they don't host F-key bindings and have their own visibility
  // controls.
  formattingPanelEl.classList.toggle('hidden', mode === 'hidden');
  formattingPanelEl.classList.toggle('style-preview', preview);
  if (citePanelEl) {
    // Cite panel hidden when the whole formatting panel is hidden,
    // OR when the "Show character styles" setting is off.
    citePanelEl.classList.toggle('hidden', mode === 'hidden' || !showCharacterStyles);
    citePanelEl.classList.toggle('style-preview', preview);
  }
  for (const { id, btn } of formattingPanelBtnRefs) {
    const keyDisplay = formatKeyForDisplay(
      primaryKeyFor(id, settings.get('ribbonKeyOverrides')),
    );
    const shortLabel = FORMATTING_PANEL_SHORT_LABEL[id];
    const fullLabel = RIBBON_COMMAND_LABELS[id];
    // ' · ' matches the separator used in the status-bar read-time
    // display, so the visual rhythm is consistent across the chrome.
    btn.textContent =
      mode === 'shortcuts'
        ? (keyDisplay || shortLabel)
        : mode === 'both' && keyDisplay
        ? `${shortLabel} · ${keyDisplay}`
        : shortLabel;
    btn.title = keyDisplay ? `${fullLabel} (${keyDisplay})` : fullLabel;
  }
}

function setZoom(pct: number): void {
  const clamped = Math.max(50, Math.min(200, Math.round(pct / 10) * 10));
  settings.set('zoomPct', clamped);
}

function applyZoom(pct: number): void {
  document.documentElement.style.setProperty('--editor-zoom', String(pct / 100));
  zoomPct.textContent = `${pct}%`;
  zoomResetBtn.disabled = pct === 100;
}

/**
 * Push displaySizes into CSS custom properties on `#editor`. CSS rules
 * for each named style use `font-size: var(--pmd-size-<name>)`, so
 * updating these variables retypes the whole editor.
 */
function applyDisplaySizes(sizes: DisplaySizes): void {
  // Set on documentElement so the multi-pane shell's editors (which
  // aren't descendants of #editor) inherit the same custom props.
  // The single-doc #editor still inherits from documentElement, so
  // single-doc behavior is unchanged.
  for (const key of DISPLAY_SIZE_KEYS) {
    document.documentElement.style.setProperty(`--pmd-size-${key}`, `${sizes[key]}pt`);
    editorEl.style.setProperty(`--pmd-size-${key}`, `${sizes[key]}pt`);
  }
}

/**
 * Push typography flags onto `#editor` as classes (predicated CSS) and
 * as a CSS custom property for the box thickness. Each boolean either
 * adds or removes a class; CSS rules selector-gated on those classes
 * apply the corresponding decoration.
 */
function applyDisplayTypography(t: DisplayTypography): void {
  editorEl.classList.toggle('pmd-cite-underlined', t.citeUnderlined);
  editorEl.classList.toggle('pmd-underline-bold', t.underlineBold);
  editorEl.classList.toggle('pmd-emphasis-bold', t.emphasisBold);
  editorEl.classList.toggle('pmd-emphasis-italic', t.emphasisItalic);
  editorEl.classList.toggle('pmd-emphasis-box', t.emphasisBox);
  editorEl.classList.toggle('pmd-undertag-italic', t.undertagItalic);
  editorEl.classList.toggle('pmd-undertag-bold', t.undertagBold);
  editorEl.style.setProperty('--pmd-emphasis-box-size', `${t.emphasisBoxSize}pt`);
  document.documentElement.style.setProperty('--pmd-emphasis-box-size', `${t.emphasisBoxSize}pt`);
  // Mirror the undertag/cite/emphasis flags to documentElement so the
  // ribbon's formatting-panel preview (which lives outside #editor)
  // can react to the same settings.
  document.documentElement.classList.toggle('pmd-undertag-italic', t.undertagItalic);
  document.documentElement.classList.toggle('pmd-undertag-bold', t.undertagBold);
  document.documentElement.classList.toggle('pmd-cite-underlined', t.citeUnderlined);
  document.documentElement.classList.toggle('pmd-underline-bold', t.underlineBold);
  document.documentElement.classList.toggle('pmd-emphasis-bold', t.emphasisBold);
  document.documentElement.classList.toggle('pmd-emphasis-italic', t.emphasisItalic);
  document.documentElement.classList.toggle('pmd-emphasis-box', t.emphasisBox);
  document.documentElement.style.setProperty('--pmd-emphasis-box-size', `${t.emphasisBoxSize}pt`);
}

/**
 * Push displayColors into CSS custom properties on the document root
 * so both the editor and the nav pane (which lives outside #editor)
 * inherit the same values. CSS rules consume `var(--pmd-color-*)`.
 */
function applyDisplayColors(c: DisplayColors): void {
  for (const key of DISPLAY_COLOR_KEYS) {
    document.documentElement.style.setProperty(`--pmd-color-${key}`, c[key]);
  }
}

/** CSS generic font categories — always available, picked by the
 *  browser per system. Don't quote these; quotes would turn them into
 *  literal font names that don't exist. */
const GENERIC_FONT_KEYWORDS = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
]);

function applyBodyFont(font: string): void {
  // Set font-family as an inline style directly. Quoted form for named
  // fonts (handles spaces and avoids ambiguity with CSS keywords);
  // unquoted form for generic categories. Inline style on #editor wins
  // over the stylesheet rule and inherits to all descendants.
  const head = GENERIC_FONT_KEYWORDS.has(font) ? font : `"${font}"`;
  const value = `${head}, 'Helvetica Neue', sans-serif`;
  editorEl.style.fontFamily = value;
  // Mirror to a CSS custom property on documentElement so the multi-
  // pane shell's editor surfaces (not descendants of #editor) can pick
  // up the body font via `font-family: var(--pmd-body-font)`.
  document.documentElement.style.setProperty('--pmd-body-font', value);
}

function applyLineHeight(_multiplier: number): void {
  // The runtime override now sets each of the six per-paragraph-type
  // line-height variables from its corresponding setting, so every
  // knob in the Settings dialog flows through to the editor surface.
  // Set on BOTH #editor (single-doc) and documentElement (so the
  // multi-pane shell's editors inherit them).
  const s = settings.all();
  const pairs: [string, string][] = [
    ['--pmd-line-height', String(s.lineHeight)],
    ['--pmd-line-height-cite', String(s.lineHeightCite)],
    ['--pmd-line-height-tag', String(s.lineHeightTag)],
    ['--pmd-line-height-analytic', String(s.lineHeightAnalytic)],
    ['--pmd-line-height-heading', String(s.lineHeightHeading)],
    ['--pmd-line-height-undertag', String(s.lineHeightUndertag)],
  ];
  for (const [k, v] of pairs) {
    editorEl.style.setProperty(k, v);
    document.documentElement.style.setProperty(k, v);
  }
}

// Track the last applied ribbon-key override map so the settings
// subscriber can detect changes by reference and reconfigure the
// view's plugin stack only when bindings actually moved. We start
// with whatever the store has at boot — first subscriber call won't
// see a diff and won't reconfigure (the freshly-built view already
// has the current bindings baked in).
let lastRibbonOverrides = settings.get('ribbonKeyOverrides');

// Apply read-mode visual state and editing lockdown whenever the
// setting changes (and once now to handle the persisted value).
settings.subscribe((s) => {
  applyReadMode(s.readMode);
  applyZoom(s.zoomPct);
  applyDisplaySizes(s.displaySizes);
  applyDisplayTypography(s.displayTypography);
  applyDisplayColors(s.displayColors);
  applyBodyFont(s.bodyFont);
  applyLineHeight(s.lineHeight);
  applyFormattingPanel(s.formattingPanelMode, s.formattingPanelPreview, s.showCharacterStyles);
  syncParagraphIntegrityBtn();
  refreshWordCount();
  refreshFontSizeDisplay();
  if (s.ribbonKeyOverrides !== lastRibbonOverrides) {
    lastRibbonOverrides = s.ribbonKeyOverrides;
    if (view) {
      view.updateState(
        view.state.reconfigure({ plugins: buildEditorPlugins() }),
      );
    }
  }
  // Editor spellcheck toggle — push the new value directly onto
  // `view.dom`. PM's `attributes` prop only re-applies on state
  // updates, but settings changes shouldn't require a state update
  // to take effect.
  if (view) {
    view.dom.setAttribute('spellcheck', s.editorSpellcheck ? 'true' : 'false');
  }
  // Nav-rail drag, zoom, display-size changes — anything that can
  // move the editor's available width — re-sync the card-intrinsic
  // CSS variable so skipped (content-visibility) cards stay the
  // right width.
  notifyEditorLayoutChanged();
});
applyReadMode(settings.get('readMode'));
applyZoom(settings.get('zoomPct'));
applyDisplaySizes(settings.get('displaySizes'));
applyDisplayTypography(settings.get('displayTypography'));
applyDisplayColors(settings.get('displayColors'));
applyBodyFont(settings.get('bodyFont'));
applyLineHeight(settings.get('lineHeight'));
applyFormattingPanel(
  settings.get('formattingPanelMode'),
  settings.get('formattingPanelPreview'),
  settings.get('showCharacterStyles'),
);

// Claim browser shortcuts for every ribbon binding. F3 (Find), F5
// (Reload), F7 (Caret Browse), F11 (Fullscreen), Mod-U (View Source),
// and others normally trigger browser UI. We listen in the BUBBLE
// phase (no `{ capture: true }`) so the editor's PM keymap on
// `view.dom` gets first crack at the event — PM bails out via
// `eventBelongsToView` if `event.defaultPrevented` is already set,
// so a capture-phase preventDefault would silently disable our own
// keymap. By the time this handler fires:
//   - If PM matched a binding it already called preventDefault, and
//     we skip (avoids double-firing the command).
//   - If PM didn't match (binding absent OR editor unfocused), we
//     preventDefault to block the browser's built-in action and, if
//     the editor exists, dispatch the matching ribbon command
//     manually.
// We look up the key string against the ribbon registry up-front and
// only preventDefault when it's actually bound — so plain typing,
// Mod-Z, and other PM/browser defaults that we don't claim pass
// through untouched.
// Some keys are un-preventable in some browsers (F11 in Firefox; F5 /
// F12 in some Chromium builds) — those are an OS/browser issue our
// future Electron build will sidestep entirely.
window.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return;
  // Cheap early bail for typing: no modifier and not an F-key means
  // it can't be one of ours.
  if (!e.ctrlKey && !e.metaKey && !e.altKey && !/^F\d+$/.test(e.key)) return;
  const keyString = ribbonKeyStringFor(e);
  const cmdId = ribbonCommandForKey(
    keyString,
    settings.get('ribbonKeyOverrides'),
  );
  if (!cmdId) return;
  e.preventDefault();
  // File-level commands (newDocument / openFile / saveAs) and the
  // shortcuts-dialog opener don't need a live view — invoke the
  // ctx side effect directly so the shortcut works even when no
  // pane has a doc open. Other commands still require a view
  // because they read state / dispatch transactions.
  if (VIEWLESS_RIBBON_COMMANDS.has(cmdId)) {
    runViewlessRibbon(cmdId);
    return;
  }
  if (!view) return;
  const cmd = getRibbonCommand(cmdId, ribbonContext);
  cmd(view.state, view.dispatch.bind(view), view);
});

/** Ribbon commands whose side effect doesn't read the doc / dispatch
 *  a transaction. Listed here so the global keydown handler can
 *  invoke them without a live view — single-doc startup is
 *  view-ful by the time this fires, but multi-doc with no panes
 *  open hits this path. */
const VIEWLESS_RIBBON_COMMANDS = new Set<RibbonCommandId>([
  'newDocument',
  'openFile',
  'saveAs',
  'openShortcutsReference',
  // `newSpeechDocument` creates a fresh doc and routes it through a
  // slot — no source view required. The other three speech
  // commands DO need an active doc (a source for send, or the
  // focused doc for mark) so they stay gated on `view`.
  'newSpeechDocument',
  // Zoom modifies a persisted setting + a CSS variable on
  // documentElement — no doc dispatch required, so it works even
  // when multi-doc has zero panes open.
  'zoomIn',
  'zoomOut',
  'zoomReset',
]);

function runViewlessRibbon(id: RibbonCommandId): void {
  switch (id) {
    case 'newDocument': ribbonContext.newDocument(); return;
    case 'openFile': ribbonContext.openFile(); return;
    case 'save': ribbonContext.save(); return;
    case 'saveAs': ribbonContext.saveAs(); return;
    case 'toggleAutosave': ribbonContext.toggleAutosave(); return;
    case 'openShortcutsReference': ribbonContext.openShortcutsReference(); return;
    case 'newSpeechDocument': ribbonContext.newSpeechDocument(); return;
    case 'zoomIn': ribbonContext.zoomIn(); return;
    case 'zoomOut': ribbonContext.zoomOut(); return;
    case 'zoomReset': ribbonContext.zoomReset(); return;
  }
}

// Wire the color panel (split buttons + swatch pickers). Pass a ref
// object so the panel reads the live view through `view.view` even
// when the EditorView gets re-mounted (e.g. on docx import).
colorPanel = wireColorPanel({ get view() { return view; } });

// Paragraph Integrity toggle — clicking flips the setting; the
// settings subscriber below mirrors the live value into the
// aria-pressed attribute so the CSS reflects state.
if (paragraphIntegrityBtn) {
  paragraphIntegrityBtn.addEventListener('mousedown', (e) => e.preventDefault());
  paragraphIntegrityBtn.addEventListener('click', () => {
    settings.set('paragraphIntegrity', !settings.get('paragraphIntegrity'));
  });
}
function syncParagraphIntegrityBtn(): void {
  if (!paragraphIntegrityBtn) return;
  const on = settings.get('paragraphIntegrity');
  paragraphIntegrityBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
}
syncParagraphIntegrityBtn();

// Plain Paste button — routes through `runRibbon('pasteAsText')` so
// it follows the same host-aware path the F2 keymap uses. Browser:
// flips the paste-plugin's armed flag (aria-pressed mirrors that
// state via `onArmedChange`); Electron: fires an immediate plain
// paste from the system clipboard.
if (plainPasteToggleBtn) {
  plainPasteToggleBtn.addEventListener('mousedown', (e) => e.preventDefault());
  plainPasteToggleBtn.addEventListener('click', () => runRibbon('pasteAsText'));
  if (getHost().kind === 'electron') {
    plainPasteToggleBtn.title = 'Paste plain text (F2)';
  }
}

// ---- Font-size input + dropdown ----

const FONT_SIZE_PRESETS = [4, 6, 8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 22, 24, 26, 28, 32, 36, 48, 72];

function commitFontSizeInput(): void {
  if (!fontSizeInput || !view) return;
  const raw = fontSizeInput.value.trim();
  if (raw === '' || raw === '—') {
    // No-op revert: re-sync from current cursor state.
    refreshFontSizeDisplay();
    return;
  }
  const pt = parseFloat(raw);
  if (!Number.isFinite(pt) || pt <= 0) {
    refreshFontSizeDisplay();
    return;
  }
  // Clamp to OOXML's sane range (1–409pt; 818 half-points is Word's cap).
  const clamped = Math.max(1, Math.min(409, pt));
  setFontSize(clamped)(view.state, view.dispatch.bind(view));
  view.focus();
}

if (fontSizeInput) {
  fontSizeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitFontSizeInput();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      refreshFontSizeDisplay();
      fontSizeInput.blur();
    }
  });
  fontSizeInput.addEventListener('blur', () => {
    commitFontSizeInput();
  });
  // Focus highlights the current value so typing replaces it.
  fontSizeInput.addEventListener('focus', () => {
    fontSizeInput.select();
  });
}

let openFontSizePickerEl: HTMLElement | null = null;
function closeFontSizePicker(): void {
  if (!openFontSizePickerEl) return;
  openFontSizePickerEl.remove();
  openFontSizePickerEl = null;
  fontSizePickerBtn?.setAttribute('aria-expanded', 'false');
}

function openFontSizePicker(): void {
  if (!fontSizePickerBtn) return;
  if (openFontSizePickerEl) {
    closeFontSizePicker();
    return;
  }
  const picker = document.createElement('div');
  picker.className = 'pmd-font-size-picker';
  for (const pt of FONT_SIZE_PRESETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = String(pt);
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      if (view) setFontSize(pt)(view.state, view.dispatch.bind(view));
      closeFontSizePicker();
      view?.focus();
    });
    picker.appendChild(btn);
  }
  document.body.appendChild(picker);
  const rect = fontSizePickerBtn.getBoundingClientRect();
  picker.style.top = `${rect.bottom + 2}px`;
  picker.style.left = `${rect.right - picker.offsetWidth}px`;
  openFontSizePickerEl = picker;
  fontSizePickerBtn.setAttribute('aria-expanded', 'true');

  const onDocPointerDown = (e: PointerEvent) => {
    if (!openFontSizePickerEl) return;
    const t = e.target as Node | null;
    if (t && (openFontSizePickerEl.contains(t) || fontSizePickerBtn.contains(t))) return;
    closeFontSizePicker();
    document.removeEventListener('pointerdown', onDocPointerDown);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeFontSizePicker();
      document.removeEventListener('pointerdown', onDocPointerDown);
      document.removeEventListener('keydown', onKey);
    }
  };
  document.addEventListener('pointerdown', onDocPointerDown);
  document.addEventListener('keydown', onKey);
}

if (fontSizePickerBtn) {
  fontSizePickerBtn.addEventListener('mousedown', (e) => e.preventDefault());
  fontSizePickerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openFontSizePicker();
  });
}

for (const [btn, delta] of [
  [fontSizeUpBtn, 1],
  [fontSizeDownBtn, -1],
] as const) {
  if (!btn) continue;
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => {
    if (!view) return;
    adjustFontSize(delta, effectivePtForNode)(view.state, view.dispatch.bind(view));
    view.focus();
  });
}

function refreshFontSizeDisplay(): void {
  if (!fontSizeInput || !fontSizeControlEl) return;
  // Don't clobber the user's in-progress edit — only sync the input
  // value when it isn't focused.
  if (document.activeElement === fontSizeInput) return;
  if (!view) {
    fontSizeInput.value = '—';
    fontSizeControlEl.classList.remove('pmd-font-size-direct');
    return;
  }
  const info = effectiveFontSizeForDisplay(view.state);
  fontSizeInput.value = info.pt == null ? '—' : formatPt(info.pt);
  // Red when every contributing run derives its size from an explicit
  // `font_size` mark; black when bare or driven by a named-style mark.
  fontSizeControlEl.classList.toggle(
    'pmd-font-size-direct',
    info.pt != null && info.direct,
  );
}

function formatPt(pt: number): string {
  // Drop the trailing ".0" for whole numbers; otherwise show one decimal.
  return Number.isInteger(pt) ? `${pt}` : pt.toFixed(1);
}

interface FontSizeInfo {
  /** Effective size in pt, or `null` when the selection spans mixed sizes. */
  pt: number | null;
  /** True iff every contributing run derives its size from an explicit
   *  `font_size` mark. False when any run is bare or named-style-derived. */
  direct: boolean;
}

/**
 * Effective font-size (in pt) for a paragraph that has no run-level
 * size cues. Reads from the live `displaySizes` setting so all
 * downstream consumers reflect user-customized per-style sizes.
 */
function paragraphDefaultPt(parentName: string): number {
  const sizes = settings.get('displaySizes');
  switch (parentName) {
    case 'pocket': return sizes.pocket;
    case 'hat': return sizes.hat;
    case 'block': return sizes.block;
    case 'tag': return sizes.tag;
    case 'analytic': return sizes.analytic;
    case 'undertag': return sizes.undertag;
    default: return sizes.normal;
  }
}

/**
 * Effective font-size for a single text run, with the same precedence
 * the chip / increment buttons / display logic all use:
 *   1. `font_size` mark on the run → that value (and `direct: true`).
 *   2. Named-style mark on the run (cite_mark, underline_mark, etc.)
 *      → the corresponding per-style size from displaySizes.
 *   3. Otherwise → the parent paragraph's natural size.
 */
function ptForRun(text: PMNode, parent: PMNode): { pt: number; direct: boolean } {
  const fs = text.marks.find((m) => m.type.name === 'font_size');
  if (fs) {
    return { pt: Number(fs.attrs['halfPoints'] ?? 22) / 2, direct: true };
  }
  const sizes = settings.get('displaySizes');
  for (const m of text.marks) {
    switch (m.type.name) {
      case 'cite_mark': return { pt: sizes.cite, direct: false };
      case 'underline_mark': return { pt: sizes.underline, direct: false };
      case 'emphasis_mark': return { pt: sizes.emphasis, direct: false };
      case 'undertag_mark': return { pt: sizes.undertag, direct: false };
      case 'analytic_mark': return { pt: sizes.analytic, direct: false };
    }
  }
  return { pt: paragraphDefaultPt(parent.type.name), direct: false };
}

/**
 * Resolver used by `adjustFontSize` to pick a per-run starting size
 * when the run has no explicit `font_size` mark. `node === null`
 * means "no adjacent text" — fall through to the parent default.
 */
export function effectivePtForNode(node: PMNode | null, parent: PMNode): number {
  if (node && node.isText) return ptForRun(node, parent).pt;
  return paragraphDefaultPt(parent.type.name);
}

function effectiveFontSizeForDisplay(state: EditorState): FontSizeInfo {
  const sel = state.selection;
  if (sel.empty) {
    const $pos = sel.$from;
    const parent = $pos.parent;
    if (!parent.isTextblock) return { pt: null, direct: false };
    // PM's effective marks at the cursor: storedMarks (if set) override
    // the marks at the cursor position. Otherwise `$pos.marks()`
    // resolves correctly for both the mid-run case (returns the
    // containing text node's marks) and the boundary case (returns the
    // left-neighbor's marks, matching the "next typed char extends
    // left" semantics). The earlier `parent.child(idx-1)` lookup
    // confused these two cases — for a cursor sitting INSIDE an 11pt
    // run that followed an 8pt run, it returned the 8pt run as the
    // "before" node, so the chip reported 8pt even though the cursor
    // wasn't there.
    const marks = state.storedMarks ?? $pos.marks();
    const fs = marks.find((m) => m.type.name === 'font_size');
    if (fs) return { pt: Number(fs.attrs['halfPoints'] ?? 22) / 2, direct: true };
    const sizes = settings.get('displaySizes');
    for (const m of marks) {
      switch (m.type.name) {
        case 'cite_mark': return { pt: sizes.cite, direct: false };
        case 'underline_mark': return { pt: sizes.underline, direct: false };
        case 'emphasis_mark': return { pt: sizes.emphasis, direct: false };
        case 'undertag_mark': return { pt: sizes.undertag, direct: false };
        case 'analytic_mark': return { pt: sizes.analytic, direct: false };
      }
    }
    return { pt: paragraphDefaultPt(parent.type.name), direct: false };
  }

  // Non-empty: collect (size, direct) per text run. Uniform size → show
  // it; "direct" flag is the AND across runs (red only when every run
  // is directly formatted).
  const found = new Set<number>();
  let allDirect = true;
  let anyRun = false;
  state.doc.nodesBetween(sel.from, sel.to, (node, _pos, parent) => {
    if (!node.isText || !parent) return true;
    const r = ptForRun(node, parent);
    found.add(r.pt);
    if (!r.direct) allDirect = false;
    anyRun = true;
    return true;
  });
  if (!anyRun) return { pt: null, direct: false };
  if (found.size === 1) return { pt: [...found][0]!, direct: allDirect };
  return { pt: null, direct: false };
}

function refreshWordCount(): void {
  // In multi-doc mode the shared status-bar word counter is hidden
  // (each pane shows its own in its footer). Skip the O(doc-size)
  // walk entirely — it's pure waste; the result lands in an
  // element that's `display: none`.
  if (multiDocActive) return;
  if (!view) {
    wordCountText.textContent = '—';
    return;
  }
  const sel = view.state.selection;
  const hasSelection = !sel.empty;
  const words = hasSelection
    ? countReadAloudWords(view.state.doc, sel.from, sel.to)
    : countReadAloudWords(view.state.doc);

  const readers = settings.get('readers').slice(0, 2);
  const head = hasSelection
    ? `Selection: ${formatNumber(words)}`
    : formatNumber(words);
  const parts = [head];
  for (const r of readers) {
    parts.push(`${r.name}: ${formatReadTime(words, r.wpm)}`);
  }
  wordCountText.textContent = parts.join(' · ');
}

/**
 * Single-doc read-mode application. Read mode is conceptually
 * per-doc — in multi-doc mode each pane owns its own read-mode
 * state via the shell — and the single-doc surface just happens
 * to have exactly one doc, so the `settings.readMode` setting
 * drives this one editor's read-mode flag.
 */
function applyReadMode(on: boolean): void {
  editorEl.classList.toggle('pmd-read-mode', on);
  editorEl.classList.toggle(
    'pmd-rm-no-emphasis-borders',
    on && settings.get('hideEmphasisBordersInReadMode'),
  );
  if (!multiDocActive) refreshReadModeBtn();
  if (view) {
    view.setProps({ editable: () => !on });
    // Send the new state to the read-mode plugin so it (re)builds
    // its text-hiding decoration set. The meta value IS the
    // desired on/off state — the plugin stores it as its own
    // local state rather than re-reading the global setting,
    // which made per-pane read mode in multi-doc work.
    view.dispatch(view.state.tr.setMeta(PMD_READ_MODE_TOGGLE, on));
  }
}

/**
 * Apply read-mode visuals + editability + plugin re-render to a
 * SPECIFIC editor surface — same logic as `applyReadMode` above,
 * just parameterised on the host element and view so the multi-pane
 * shell can call it per pane without going through the
 * `settings.readMode` global.
 */
export function applyReadModeToTarget(
  hostEl: HTMLElement,
  targetView: EditorView,
  on: boolean,
  hideEmphasisBorders: boolean,
): void {
  hostEl.classList.toggle('pmd-read-mode', on);
  hostEl.classList.toggle('pmd-rm-no-emphasis-borders', on && hideEmphasisBorders);
  targetView.setProps({ editable: () => !on });
  targetView.dispatch(targetView.state.tr.setMeta(PMD_READ_MODE_TOGGLE, on));
}

/**
 * Replace the resolver used by `refreshReadModeBtn`. In single-doc
 * the default (read `settings.readMode`) is fine; the multi-pane
 * shell calls this at boot to install a focused-pane resolver.
 */
export function setReadModeStateResolver(resolver: () => boolean): void {
  readModeStateForActive = resolver;
  // Resolver change implies the source-of-truth changed (e.g., the
  // multi-pane shell just installed its focused-pane resolver) —
  // refresh the button so it reflects the new answer.
  refreshReadModeBtn();
}

/**
 * Replace the resolver used by `refreshAutosaveBtn`. Mirrors
 * `setReadModeStateResolver` — single-doc reads the (transient)
 * setting; multi-pane installs a focused-DocRecord resolver so the
 * autosave toggle reflects per-pane state. */
export function setAutosaveStateResolver(resolver: () => boolean): void {
  autosaveStateForActive = resolver;
  refreshAutosaveBtn();
}

function refreshReadModeBtn(): void {
  readModeBtn.classList.toggle('pmd-active', readModeStateForActive());
}

const navPanel = new NavigationPanel(navEl);

function makeStarterDoc(): PMNode {
  const n = schema.nodes;
  const m = schema.marks;
  // Shorthand factories. Marks-on-text uses ProseMirror's array-of-
  // marks form; nodes get an `id` only where the schema requires
  // one for stable heading IDs (per ARCHITECTURE.md §4).
  const t = (text: string, marks?: ReturnType<(typeof m)[string]['create']>[]) =>
    marks && marks.length ? schema.text(text, marks) : schema.text(text);
  const para = (...children: PMNode[]) => n['paragraph']!.create(null, children);
  const paraText = (text: string) => n['paragraph']!.create(null, schema.text(text));
  /** Indented body paragraph (0.5" = 720 dxa). Used for the F-key
   *  shortcut list so it visually reads as a sub-block under the
   *  surrounding prose. */
  const paraIndented = (text: string) =>
    n['paragraph']!.create({ indent: 720 }, schema.text(text));
  /** Empty paragraph spacer — gives a blank line between content
   *  blocks so the onboarding doc reads less wall-of-text. */
  const blank = () => n['paragraph']!.create(null);

  return n['doc']!.createChecked(null, [
    n['pocket']!.create({ id: newHeadingId() }, schema.text('Welcome to CardMirror')),
    paraText(
      'This is the live web preview of CardMirror — a ProseMirror-based editor that round-trips Microsoft Word .docx files against Verbatim and Advanced Verbatim. The boxed heading above is a Pocket: Verbatim\'s name for a top-level argument section. The structures below are interactive — type, edit, and try the keyboard shortcuts as you read.',
    ),
    blank(),
    paraText(
      'One bit of vocabulary first: this guide writes "Mod" for the platform\'s primary modifier key — Ctrl on Windows and Linux, ⌘ Cmd on macOS. So "Mod-Shift-S" means Ctrl-Shift-S or ⌘-Shift-S depending on what you\'re running.',
    ),
    blank(),

    // Section 1: Try it
    n['hat']!.create({ id: newHeadingId() }, schema.text('1. Try it with your own files')),
    paraText(
      'Click the 📂 folder icon in the ribbon to open one of your real Verbatim files. The editor renders styles, marks, and structure with full fidelity, and Save As (💾 in the ribbon, or Mod-Shift-S) round-trips back to a Verbatim-native .docx.',
    ),
    blank(),
    paraText(
      'Heads up: this is the alpha web preview. Edits live only in this tab — there\'s no autosave yet, so use Save As before you close the page if you want to keep what you\'ve done. Don\'t use this for important work.',
    ),
    blank(),

    // Section 2: Structural styles
    n['hat']!.create({ id: newHeadingId() }, schema.text('2. Structural styles')),
    paraText(
      'CardMirror uses the same four-level hierarchy as Verbatim — Pocket → Hat → Block → Tag — plus body paragraphs, Analytics, and Undertags. Each lives behind a function key (defaults; all rebindable in Settings → Keyboard shortcuts):',
    ),
    blank(),
    paraIndented('F4 = Pocket'),
    paraIndented('F5 = Hat'),
    paraIndented('F6 = Block'),
    paraIndented('F7 = Tag'),
    paraIndented('Mod-F7 = Analytic'),
    paraIndented('Mod-F8 = Undertag'),
    blank(),
    paraText(
      'Click a paragraph and press the matching key to convert it. Multi-paragraph selections convert every touched paragraph in one go. F12 clears formatting back to plain body text.',
    ),
    blank(),

    n['block']!.create({ id: newHeadingId() }, schema.text('Blocks group related cards under a Hat')),
    paraText(
      'Loose paragraphs like this one are first-class — they can sit between any structures. Paragraphs typed right after a card auto-absorb into it as card body; type a heading to break out.',
    ),

    n['card']!.create(null, [
      n['tag']!.create({ id: newHeadingId() }, schema.text('Cards are the unit of evidence — Tag goes on top')),
      n['undertag']!.create(null, schema.text('Undertags (Mod-F8) annotate the tag — qualifiers or sub-claims.')),
      n['cite_paragraph']!.create(null, [
        t('John '),
        t('Smith 24', [m['cite_mark']!.create()]),
        t(', Professor of Climate Science at Yale University, "Title of the Source," '),
        t('Publication Name', [m['italic']!.create()]),
        t(', 9/23/2024, '),
        t('https://example.com', [m['link']!.create({ href: 'https://example.com' })]),
      ]),
      n['card_body']!.create(null, [
        t('A card\'s body holds the evidence text. The standard emphasis marks: '),
        t('F9 underlines selected text', [m['underline_mark']!.create()]),
        t(', '),
        t('F10 emphasizes it', [m['emphasis_mark']!.create()]),
        t(', and '),
        t('F11 highlights it', [m['highlight']!.create({ color: 'yellow' })]),
        t(' (cycle colors in the ribbon swatch picker). F9 and F11 are toggles — press once to apply, again to remove. F10 is apply-only (it strips any underline / highlight in the range as it goes); to remove emphasis, select the run and use F12 Clear or F9 Underline to swap it back. Mod-8 cycles the whole card through Verbatim\'s shrink sizes (11pt → 8 → 7 → 6 → 5 → 4 → back to normal) for tournament use. "Smith 24" in the Cite paragraph above carries the F8 cite mark.',
        ),
      ]),
    ]),
    blank(),

    n['analytic_unit']!.create(null, [
      n['analytic']!.create(
        { id: newHeadingId() },
        schema.text('Analytics (Mod-F7) hold standalone analysis — claims without a card behind them.'),
      ),
      n['card_body']!.create(
        null,
        schema.text(
          'Like a card, an analytic_unit absorbs the paragraphs below it as one structural block. Hover over it and the gray boundary bar appears on the left — same indicator cards get.',
        ),
      ),
    ]),
    blank(),

    // Section 3: Moving things around
    n['hat']!.create({ id: newHeadingId() }, schema.text('3. Moving things around')),
    paraText(
      'The nav pane on the left shows your doc\'s outline. Click any entry to jump to it. Double-click an entry to collapse or expand its sub-tree in the nav (Pocket folds away its Hats and so on); the editor content is unchanged, just the outline view. The row of numbered buttons at the top of the nav pane (1 · 2 · 3 · 4) sets the deepest heading level shown — click "2" to see only Pockets and Hats, "4" to see everything down through Tags.',
    ),
    blank(),
    paraText(
      'Ctrl-click adds a nav entry to the current selection; Shift-click selects a contiguous range. To reorder, just drag a nav entry (or your multi-selection) up or down — that picks up the whole heading and its contents (Pocket and everything under it, Hat and its blocks, etc.) and drops them somewhere schema-legal. Hold Ctrl (or Alt on macOS) while dragging to copy instead of move.',
    ),
    blank(),
    paraText(
      'To pick up a card or analytic directly from the editor surface (not the nav pane), hold Mod + Shift + Alt and click-and-drag it. While the modifier is held the cursor switches to a grab cursor and hovering a card highlights its boundary. Drag-and-drop is schema-aware throughout: drop targets that would produce an invalid structure don\'t light up, and invalid drops are refused.',
    ),
    blank(),

    // Section 4: Read mode
    n['hat']!.create({ id: newHeadingId() }, schema.text('4. Read mode')),
    paraText(
      'When it\'s time to read at the podium, click 👁️ in the ribbon to enter Read mode. Non-read-aloud content (loose paragraphs, undertags, plain text without highlights) hides; only Tags, Cites, Analytics, and highlighted body text stay visible. Keyboard input is locked down so stray keystrokes can\'t edit the doc. Click 👁️ again or Esc to exit.',
    ),
    blank(),
    paraText(
      'At the bottom of the window the status bar shows live read-time estimates for your two top-of-list readers — how long the visible (read-aloud) content of the current doc would take each of them to deliver. The numbers update as you edit, highlight, and trim. Tune each reader\'s name and words-per-minute rate in ⚙ → General → "Readers for read-time estimates"; the first two readers in the list are the ones that surface in the status bar.',
    ),
    blank(),

    // Section 5: Multi-doc workspace
    n['hat']!.create({ id: newHeadingId() }, schema.text('5. Multi-doc workspace')),
    paraText(
      'Open ⚙ → General → Multi-doc workspace and reload the page to switch into the three-slot side-by-side layout. Each slot is independent: it has its own ribbon focus, its own nav-pane section, its own word-count strip in the footer, and its own doc stack (back / forward / close-and-restore history). Mod-1, Mod-2, and Mod-3 focus the corresponding slot from the keyboard.',
    ),
    blank(),
    paraText(
      'Two layouts apply when all three slots are filled: Compact (all three visible side by side, narrow) and Wide-scroll (two full panes plus the edge of a third; click the peek to snap). Pick which one in ⚙ → General → Multi-doc layout. With only one or two docs open the modes look identical.',
    ),
    blank(),
    paraText(
      'To get content from one slot to another, drag a card or a nav-pane heading across — cross-pane drops always copy (the source pane keeps its content). Comments are disabled while multi-doc is on, so the comments column and the comment / AI-ask shortcuts go inert until you switch back.',
    ),
    blank(),

    // Section 6: Settings
    n['hat']!.create({ id: newHeadingId() }, schema.text('6. Customize everything')),
    paraText(
      'Click the ⚙ icon in the ribbon to open Settings. Click 📖 to open the keyboard-shortcut reference any time.',
    ),
    blank(),
    paraText(
      'Done with the tour? Turn off ⚙ → General → "Onboarding doc for new documents" and future New Document presses (plus any newly spawned windows) will open blank instead of landing on this guide.',
    ),
    blank(),
    paraText(
      'When you\'re ready, open a real .docx with the 📂 icon — or just start editing this one. Welcome aboard!',
    ),
  ]);
}

/** Build a doc with no content beyond a single empty paragraph.
 *  Used when the user has turned the onboarding starter off — new
 *  docs and newly spawned windows mount this instead of the
 *  welcome guide. */
function makeBlankNewDoc(): PMNode {
  return schema.nodes['doc']!.createChecked(null, [
    schema.nodes['paragraph']!.create(),
  ]);
}

/** Pick between the onboarding starter and a blank doc based on
 *  the `showOnboardingStarter` setting. Single entry point for
 *  "what does a fresh doc look like?" so the initial mount and the
 *  New flow stay in lockstep. */
function makeNewDocBody(): PMNode {
  return settings.get('showOnboardingStarter')
    ? makeStarterDoc()
    : makeBlankNewDoc();
}

/**
 * Build the editor's plugin list. Extracted so that `mountView` and
 * the live keybinding-override subscriber both produce the same set —
 * the only delta when overrides change is the ribbon keymap plugin,
 * but PM doesn't let you splice a single plugin, so the whole list is
 * rebuilt and the view is `reconfigure`d in place.
 *
 * Exported so the multi-pane shell can build per-pane EditorViews
 * using the exact same plugin stack as the single-doc shell.
 */
export function buildEditorPlugins(): Plugin[] {
  return [
    history(),
    keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo }),
    // Tag/analytic boundary editing rules (ARCHITECTURE.md §14.3).
    // These run before baseKeymap so they get first crack at
    // Backspace / Delete / Enter when the cursor is in a tag.
    keymap({
      Backspace: (state, dispatch, view) =>
        backspaceAtTagStart(state, dispatch, view) ||
        backspaceAtFirstBodyStart(state, dispatch, view),
      Delete: (state, dispatch, view) =>
        deleteAtTagEnd(state, dispatch, view) ||
        deleteAtContainerEnd(state, dispatch, view),
      Enter: (state, dispatch, view) =>
        enterAtTagEnd(state, dispatch, view) ||
        enterMidTag(state, dispatch, view) ||
        enterInHeading(state, dispatch, view),
    }),
    // Ribbon commands — structural style hotkeys (F4–F7 / Mod-F7)
    // plus inline mark toggles (Mod-B / Mod-I) and the color-aware
    // toggles (F11 / Mod-F11). User overrides come from settings; the
    // `ribbonKeyOverrides` subscriber below reconfigures the state
    // when they change so new bindings take effect without a reload.
    keymap(
      buildRibbonKeymap(settings.get('ribbonKeyOverrides'), ribbonContext),
    ),
    keymap(baseKeymap),
    readModePlugin,
    commentsPlugin,
    absorbPlugin,
    citeClassifierPlugin,
    namedStyleNormalizerPlugin,
    fontSizeClassPlugin,
    buildSimilarSelectionPlugin(effectivePtForNode),
    findReplacePlugin(),
    tableEditing(),
    columnResizing(),
    // Tab / Shift-Tab indent — registered AFTER tableEditing so it
    // never fires while the cursor is inside a cell (cell Tab nav
    // takes precedence). Outside tables, Tab on a paragraph-spanning
    // selection indents; on a collapsed cursor inserts '\t'.
    keymap({ Tab: indentParagraph, 'Shift-Tab': outdentParagraph }),
    buildPastePlugin({
      condenseOnPaste: () => settings.get('condenseOnPaste'),
      paragraphIntegrity: () => settings.get('paragraphIntegrity'),
      usePilcrows: () => settings.get('usePilcrows'),
      headingMode: () => settings.get('headingMode'),
      onArmedChange: (armed) => updatePlainPasteIndicator(armed),
    }),
    imageContextMenuPlugin,
    // When `enableTextDragDrop` is off, swallow the browser's
    // `dragstart` on the editor's contenteditable so the user
    // can't initiate a text-move drag from a selection. Doesn't
    // affect the card / heading pickup-modifier drag — that
    // system uses pointerdown directly and `preventDefault`s,
    // so `dragstart` never fires for those gestures anyway.
    new Plugin({
      props: {
        handleDOMEvents: {
          dragstart: (_view, event) => {
            if (settings.get('enableTextDragDrop')) return false;
            event.preventDefault();
            return true;
          },
        },
      },
    }),
  ];
}

function mountView(doc: PMNode, threads: Thread[] = []): void {
  if (view) {
    editorDragSurface.detach();
    view.destroy();
  }
  const state = EditorState.create({
    doc,
    schema,
    plugins: buildEditorPlugins(),
  });
  view = new EditorView(editorEl, {
    state,
    editable: () => !settings.get('readMode'),
    // Browser spellcheck on a large contenteditable is a visible
    // per-keystroke cost (dictionary tokenization + underline
    // overlay). Off by default via the `editorSpellcheck` setting;
    // a settings subscriber below pushes runtime toggles into
    // `view.dom.setAttribute` so the user can flip it without a
    // reload.
    attributes: { spellcheck: settings.get('editorSpellcheck') ? 'true' : 'false' },
    dispatchTransaction(tx) {
      if (!view) return;
      const prevState = view.state;
      const prevCommentsState = commentsKey.getState(prevState);
      const next = view.state.apply(tx);
      view.updateState(next);
      if (tx.docChanged) {
        currentDoc = next.doc;
        markNonPristineStarter();
        markCurrentDocDirty();
        // Re-arm the autosave debounce. No-ops when the setting
        // is off, so the call is cheap to fire unconditionally.
        notifyEditForAutosave();
      }
      // Cheap; runs on every transaction (selection moves included)
      // so the readout always reflects the cursor's current run.
      refreshFontSizeDisplay();
      // Doc-walking work (nav rebuild, word count, comments column
      // refresh, comments-plugin orphan GC) is all O(doc) and the
      // dominant per-keystroke cost on big docs. Debounce so it only
      // fires once the user pauses typing for 200ms.
      if (tx.docChanged) needsCommentsGC = true;
      scheduleHeavyUpdate();
      // Comments column refresh on doc / plugin-state change is
      // debounced via the column's own scheduleRender (matches the
      // 200ms heavy-update cadence).
      if (commentsColumn && (tx.docChanged || commentsKey.getState(next) !== prevCommentsState)) {
        commentsColumn.scheduleRender();
      }
      // Cursor → active-thread tracking. `threadIdAtCursor` reads
      // the cursor's marks (O(1)); `setActiveThread` with the default
      // 'cursor' flavor schedules a debounced render instead of
      // running one synchronously.
      if (commentsColumn && (prevState.selection !== next.selection || tx.docChanged)) {
        const id = threadIdAtCursor(next);
        commentsColumn.setActiveThread(id);
      }
    },
  });
  // Hydrate comments plugin state from the import. A separate
  // transaction (with addToHistory: false inside `loadThreads`)
  // keeps load out of the undo stack.
  if (threads.length > 0) {
    view.dispatch(loadThreads(view.state, threads));
  }
  currentDoc = doc;
  navPanel.attach(view);
  // Sync visible state with the persisted setting on every mount.
  const startVisible = settings.get('commentsVisible');
  if (commentsColumnEl) commentsColumnEl.hidden = !startVisible;
  if (commentsToggleBtn) {
    commentsToggleBtn.setAttribute('aria-pressed', startVisible ? 'true' : 'false');
  }
  if (commentsColumn) commentsColumn.render();
  // Editor drop surface — renders drop indicators in the editor when
  // a nav-pane drag is active, and exposes a hit-test the nav drag
  // handler queries during pointermove. (Phase 3a.)
  editorDragSurface.attach(view, editorEl);
  // Publish editor width as `--pmd-card-intrinsic-width` so cards
  // and heading containers (which have `content-visibility: auto`)
  // can use it as their intrinsic-width when skipped off-screen.
  // Window-resize + explicit triggers (nav drag fires through the
  // settings subscriber). Deliberately NOT a ResizeObserver — see
  // the doc comment on `syncCardIntrinsicWidth` for why.
  setupCardIntrinsicWidthSync();
  exportBtn.disabled = false;
  // Initial paint: do the heavy update synchronously so the user sees
  // the right thing immediately on doc load.
  navPanel.update(doc);
  refreshWordCount();
  refreshFontSizeDisplay();
  // Push the current `settings.readMode` value through the full
  // apply path now that `view` exists — `applyReadMode` ran at
  // module init time before this view was constructed (so its
  // `view.setProps` / plugin dispatch were skipped) and the
  // plugin's local state defaults to OFF. Re-applying here lands
  // both the editable flag AND the plugin's text-hiding
  // decoration set in their correct on/off state for the
  // persisted setting.
  applyReadMode(settings.get('readMode'));
  // Reset scroll on both the nav pane and the page so a
  // freshly-mounted doc starts at the top — single-doc's editor
  // scrolls the page itself (not its own container), so window
  // scroll is the right knob. Without this, opening one doc and
  // then another lands you at whatever scroll position the
  // previous doc was last in.
  navPanel.scrollToTop();
  window.scrollTo(0, 0);
}

/** Publish `#editor`'s current width as `--pmd-card-intrinsic-width`
 *  so cards and heading containers (which use
 *  `content-visibility: auto`) render their skipped-placeholder box
 *  at the editor's real width rather than a fixed pixel fallback.
 *
 *  Driven by explicit triggers — initial mount, window resize, and
 *  the settings subscriber (which fires on nav-rail drags via the
 *  `navWidth` setting). NOT a ResizeObserver: the variable write
 *  triggers a layout pass on every card, and observer-driven
 *  updates produced a hard feedback loop where the editor's
 *  measured width crept up each iteration after the user clicked
 *  into the editor. Explicit triggers can't re-fire from our own
 *  mutations. */
let lastCardIntrinsicWidth = -1;
let cardIntrinsicWidthRaf: number | null = null;
let cardIntrinsicWidthInstalled = false;

function syncCardIntrinsicWidth(): void {
  if (!editorEl || editorEl.hidden) return;
  // Measure the actual ProseMirror element's content area (clientWidth
  // minus its computed horizontal padding) when the view is mounted —
  // that's the box cards lay out into, so it's the right value for the
  // `contain-intrinsic-width` fallback. `editorEl.offsetWidth` would
  // include scrollbar gutter and ignore PM's inner padding, which
  // overshoots a card's actual width.
  let width = 0;
  if (view) {
    const pmEl = view.dom as HTMLElement;
    const cs = getComputedStyle(pmEl);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    width = Math.round(pmEl.clientWidth - padL - padR);
  } else {
    width = Math.round(editorEl.clientWidth);
  }
  if (width <= 0) return;
  if (width === lastCardIntrinsicWidth) return;
  lastCardIntrinsicWidth = width;
  editorEl.style.setProperty('--pmd-card-intrinsic-width', `${width}px`);
}

/** Coalesce sync triggers landing in the same tick into a single
 *  rAF read, so we measure once after layout settles. */
function scheduleSyncCardIntrinsicWidth(): void {
  if (cardIntrinsicWidthRaf !== null) return;
  cardIntrinsicWidthRaf = requestAnimationFrame(() => {
    cardIntrinsicWidthRaf = null;
    syncCardIntrinsicWidth();
  });
}

function setupCardIntrinsicWidthSync(): void {
  if (cardIntrinsicWidthInstalled) {
    scheduleSyncCardIntrinsicWidth();
    return;
  }
  cardIntrinsicWidthInstalled = true;
  window.addEventListener('resize', scheduleSyncCardIntrinsicWidth);
  scheduleSyncCardIntrinsicWidth();
}

/** Exposed for the global settings subscriber — fires on nav drag
 *  (navWidth change), zoom change, etc. that move the editor's
 *  available width without raising a window resize event. */
export function notifyEditorLayoutChanged(): void {
  if (!cardIntrinsicWidthInstalled) return;
  scheduleSyncCardIntrinsicWidth();
}

let pendingHeavyUpdate: IdleHandle | null = null;
const HEAVY_UPDATE_DELAY_MS = 200;

/** Set when a doc-changing transaction has fired since the last
 *  `scheduleHeavyUpdate` flush. Drives the comments-plugin orphan
 *  GC walk — that O(doc) walk used to run in `appendTransaction`
 *  every keystroke; now it runs once per idle period and only when
 *  the doc actually moved. */
let needsCommentsGC = false;

function scheduleHeavyUpdate(): void {
  if (pendingHeavyUpdate !== null) cancelIdle(pendingHeavyUpdate);
  // Schedule via requestIdleCallback (setTimeout fallback) so the
  // nav / word-count / GC burst runs only when the browser has frame
  // budget to spare. Previously this fired after a fixed 200ms
  // setTimeout — for short docs that produced a visible spike every
  // pause-and-resume since the timer fired regardless of whether
  // the browser was busy. Idle-callback dispatch eliminates the
  // collision with paint frames.
  pendingHeavyUpdate = scheduleIdle(() => {
    pendingHeavyUpdate = null;
    if (!view) return;
    navPanel.update(view.state.doc);
    refreshWordCount();
    if (needsCommentsGC) {
      needsCommentsGC = false;
      gcOrphanThreads(view);
    }
  }, HEAVY_UPDATE_DELAY_MS);
}

/** Remembers the file the user imported, so Save As can default to
 *  its name. Set on import, updated on Save / Save-As. */
let currentDocFilename: string | null = null;
/** Opaque host handle for the current single-doc file. Set on
 *  open (when the host hands one out) and on Save-As (when the user
 *  commits to a location). The "Save" command writes to this handle
 *  silently; absent → Save falls through to Save-As. */
let currentDocHandle: unknown | null = null;
/** On-disk format of the current single-doc file. Drives whether
 *  "Save" routes through `toDocx` or `serializeNative`. `null` for
 *  brand-new docs that have never been saved. */
let currentDocFormat: 'cmir' | 'docx' | null = null;
/** Stable identifier for the active single-doc session. Keys the
 *  crash-recovery journal entry so a doc that's been edited but
 *  not saved is still recoverable after a hard kill. Regenerated
 *  whenever a fresh doc replaces the current one (New, Open,
 *  recovery from a different journal). */
let currentDocUid: string = newSessionDocUid();

/** True while this window is still showing the untouched
 *  onboarding starter doc. False after any user action that makes
 *  the doc "real" — edit, Open, New, Save, recovery. In windows
 *  mode (single-doc + Electron), Open and New replace the doc
 *  in-place when this is true (so first launch doesn't strand a
 *  redundant starter window) and spawn fresh windows when this
 *  is false. Multi-pane mode ignores the flag. */
let isPristineStarter = true;

/** Mark the current window as having had a substantive user
 *  action (edit / Open / New / Save / Recover). Once non-pristine,
 *  subsequent Opens / News spawn new windows on hosts that
 *  support it. */
function markNonPristineStarter(): void {
  isPristineStarter = false;
}

/** Whether the single-doc view has unsaved changes — true on any
 *  doc-changing edit, cleared on a successful save (manual or
 *  autosave) and on every doc swap (Open, New, mount-from-spawn,
 *  recovery). Drives the close-confirm prompt: a clean window
 *  closes without prompting. */
let currentDocDirty = false;
function markCurrentDocDirty(): void {
  currentDocDirty = true;
}
function markCurrentDocClean(): void {
  currentDocDirty = false;
}

/** Generate a fresh session-scoped doc UID. Used by the single-doc
 *  edit path; multi-doc DocRecords have their own newDocUid pool.
 *  Keeping the namespaces separate avoids accidental collisions
 *  even though both keys are local-scope. */
function newSessionDocUid(): string {
  return `single-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

/** Tracks the uid currently registered with the speech-doc resolver
 *  on behalf of this renderer's single view. `null` when no doc is
 *  mounted yet. Used by `syncSingleDocSpeechRegistration` to know
 *  what to unregister before re-registering. */
let registeredSingleDocUid: string | null = null;

/** Reconcile the speech-doc resolver with the current `view` +
 *  `currentDocUid`. Call after any `mountView(...)` followed by a
 *  `currentDocUid = ...` reassignment. Idempotent: registering the
 *  same uid/view pair is a no-op; switching uids unregisters the
 *  old before registering the new. In Electron mode this also
 *  drives the main-process registry via IPC. The `onSliceLanded`
 *  hook fires when an incoming speech-doc slice lands in this
 *  view — refreshes nav-panel collapse state for newly arrived
 *  headings using the configured `maxLevel`. */
function syncSingleDocSpeechRegistration(): void {
  if (!view) return;
  const resolver = getSpeechDocResolver();
  if (
    registeredSingleDocUid !== null &&
    registeredSingleDocUid !== currentDocUid
  ) {
    resolver.unregisterView(registeredSingleDocUid);
  }
  resolver.registerView(currentDocUid, view, {
    onSliceLanded: () => navPanel.applyMaxLevelToNewHeadings(),
  });
  registeredSingleDocUid = currentDocUid;
}

/** Filename-to-format inference. Used when opening files and when
 *  defaulting the Save-As dialog's format radio. */
function formatFromFilename(name: string | null | undefined): 'cmir' | 'docx' | null {
  if (!name) return null;
  const lower = name.toLowerCase();
  if (lower.endsWith('.cmir')) return 'cmir';
  if (lower.endsWith('.docx')) return 'docx';
  return null;
}

/** Combined open-file filter — accepts both formats by default so
 *  the user can pick either. The native option is listed first so
 *  it's the default filter selection (most apps default to "all
 *  recognized" or the first filter; users can swap to "Word only"
 *  if they want to narrow). */
const OPEN_FILE_FILTERS = [
  { name: 'CardMirror or Word documents', extensions: ['cmir', 'docx'] },
  { name: 'CardMirror native (.cmir)', extensions: ['cmir'] },
  { name: 'Microsoft Word (.docx)', extensions: ['docx'] },
];

/** Save-As filter — only the chosen format's extension. Built per
 *  save call so the dialog drops to a single option matching the
 *  format radio the user picked. */
function saveFiltersForFormat(format: 'cmir' | 'docx'): { name: string; extensions: string[] }[] {
  if (format === 'cmir') {
    return [{ name: 'CardMirror native (.cmir)', extensions: ['cmir'] }];
  }
  return [{ name: 'Microsoft Word (.docx)', extensions: ['docx'] }];
}

/** The "open a doc" flow. Asks the host for a file, detects format
 *  from the extension, and routes: multi-doc mode hands off to the
 *  multi-pane shell (which shows the "send to slot N" picker);
 *  single-doc mode mounts it as the current view. */
async function runOpenFlow(): Promise<void> {
  let opened: OpenedFile | null;
  try {
    opened = await getHost().openFile({ filters: OPEN_FILE_FILTERS });
  } catch (err) {
    console.error('Open failed:', err);
    alert(`Failed to open: ${err instanceof Error ? err.message : err}`);
    return;
  }
  if (!opened) return;
  if (multiDocActive && multiDocOnFileOpen) {
    try {
      await multiDocOnFileOpen(opened);
    } catch (err) {
      console.error('Multi-doc open failed:', err);
      alert(`Failed to open: ${err instanceof Error ? err.message : err}`);
    }
    return;
  }
  const format = formatFromFilename(opened.name) ?? 'docx';
  // Windows mode (single-doc + Electron + we have a non-pristine
  // doc in the current window): spawn a new window for the
  // opened file instead of replacing what's here.
  const host = getHost();
  if (host.canSpawnWindow && !isPristineStarter) {
    try {
      await host.spawnWindow({
        filename: opened.name,
        bytes: opened.bytes,
        handle: typeof opened.handle === 'string' ? opened.handle : null,
        format,
        uid: null,
      });
    } catch (err) {
      console.error('Spawn window failed:', err);
      alert(`Failed to open in new window: ${err instanceof Error ? err.message : err}`);
    }
    return;
  }
  try {
    let docNode: PMNode;
    let docThreads: Thread[] | undefined;
    if (format === 'cmir') {
      const parsed = parseNative(opened.bytes);
      docNode = parsed.doc;
      docThreads = parsed.threads.length > 0 ? parsed.threads : undefined;
    } else {
      const result = await fromDocxFull(opened.bytes);
      docNode = result.doc;
      docThreads = result.threads;
    }
    // Opening replaces the current doc; clear its journal and
    // mint a fresh uid for the new session.
    void clearCurrentJournal();
    mountView(docNode, docThreads);
    currentDocFilename = opened.name;
    currentDocHandle = opened.handle ?? null;
    currentDocFormat = format;
    currentDocUid = newSessionDocUid();
    markCurrentDocClean();
    syncSingleDocSpeechRegistration();
    markNonPristineStarter();
    updateWindowTitle();
    console.log(`Loaded ${opened.name}: ${countSummary(docNode)}`);
  } catch (err) {
    console.error('Failed to load doc:', err);
    alert(`Failed to load: ${err instanceof Error ? err.message : err}`);
  }
}

/** Strip the known extensions off a filename so the Save-As dialog
 *  can re-attach the right one based on the chosen format. */
function basenameWithoutExt(name: string): string {
  for (const ext of ['.cmir', '.docx']) {
    if (name.toLowerCase().endsWith(ext)) return name.slice(0, -ext.length);
  }
  return name;
}

/** Read the active file's filename + handle + format. In multi-doc
 *  mode this is the focused pane's record; in single-doc it's the
 *  module-level `currentDoc*` values. */
function activeFile(): { filename: string | null; handle: unknown | null; format: 'cmir' | 'docx' | null } {
  if (multiDocActive && multiDocGetFocusedFile) {
    const f = multiDocGetFocusedFile();
    if (f) return { filename: f.filename, handle: f.handle, format: f.format };
  }
  return { filename: currentDocFilename, handle: currentDocHandle, format: currentDocFormat };
}

/** Apply a save result back into the active file's record — chip
 *  label, in-place-save handle, and format all update together. */
function commitSaveResult(filename: string, handle: unknown | null, format: 'cmir' | 'docx'): void {
  if (multiDocActive && multiDocSetFocusedFile) {
    multiDocSetFocusedFile({ filename, handle, format });
  } else {
    currentDocFilename = filename;
    currentDocHandle = handle;
    currentDocFormat = format;
  }
  updateWindowTitle();
  // Format/handle may have changed (e.g., Save-As from unsaved →
  // .cmir-with-handle), which flips the autosave button between
  // inert and effective states.
  refreshAutosaveBtn();
}

/** Sync `document.title` with the active filename so Electron's
 *  native title bar reflects which doc is open. Cheap; called on
 *  open / save / multi-doc focus change. */
function updateWindowTitle(): void {
  const f = activeFile();
  document.title = f.filename ? `${f.filename} — CardMirror` : 'CardMirror';
}

/** Serialize the active doc into bytes in the given format. Shared
 *  by the Save and Save-As flows. The `opts` arg controls export-
 *  time filtering (read mode, drop analytics / undertags / comments). */
async function serializeForSave(
  format: 'cmir' | 'docx',
  opts: {
    includeComments: boolean;
    includeAnalytics: boolean;
    includeUndertags: boolean;
    readMode: boolean;
  },
): Promise<Uint8Array> {
  const docToExport = view ? view.state.doc : currentDoc;
  const exportDocNode = transformForExport(docToExport, {
    includeComments: opts.includeComments,
    includeAnalytics: opts.includeAnalytics,
    includeUndertags: opts.includeUndertags,
    readMode: opts.readMode,
  });
  if (view) gcOrphanThreads(view);
  const threads = opts.includeComments && view
    ? Array.from(getCommentsState(view.state).threads.values())
    : undefined;
  if (format === 'cmir') {
    return serializeNative(exportDocNode, threads ? { threads } : undefined);
  }
  return toDocx(exportDocNode, threads ? { threads } : undefined);
}

/**
 * Run the Save As flow. Returns `true` when the user committed to a
 * save (and the bytes hit disk / downloaded), `false` when they
 * cancelled the dialog or the OS file picker.
 */
export async function runSaveAsFlow(): Promise<boolean> {
  const file = activeFile();
  const suggestedName = basenameWithoutExt(file.filename ?? 'untitled');
  // Existing on-disk handle wins (preserves the file's current
  // format on Save As); otherwise honor the user's preferred
  // default for new docs.
  const defaultFormat: 'cmir' | 'docx' = file.format ?? settings.get('defaultSaveFormat');
  const choice = await openSaveAs({
    initialFilename: suggestedName,
    defaultFormat,
  });
  if (!choice) return false;
  try {
    const bytes = await serializeForSave(choice.format, {
      includeComments: choice.includeComments,
      includeAnalytics: choice.includeAnalytics,
      includeUndertags: choice.includeUndertags,
      readMode: choice.readMode,
    });
    const result = await getHost().saveAs(choice.filename, bytes, {
      filters: saveFiltersForFormat(choice.format),
    });
    if (!result) return false;
    commitSaveResult(result.name, result.handle ?? null, choice.format);
    flashSaveSuccess();
    markNonPristineStarter();
    markCurrentDocClean();
    multiDocNotifyFocusedSaved?.();
    // Successful save — the on-disk file IS the latest version, the
    // journal is redundant. Best-effort delete.
    void clearJournalForActiveDoc();
    return true;
  } catch (err) {
    console.error('Save failed:', err);
    alert(`Save failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/**
 * Run the "silent" Save flow — writes back to the existing on-disk
 * file in its existing format, no dialog. Falls through to Save-As
 * when we have no handle (brand-new doc, host without in-place save
 * support, etc.). Returns the same boolean as Save-As.
 */
export async function runSaveFlow(): Promise<boolean> {
  const file = activeFile();
  if (!file.handle || !file.format || !getHost().supportsInPlaceSave) {
    return runSaveAsFlow();
  }
  try {
    const bytes = await serializeForSave(file.format, {
      // Silent saves preserve everything by default — the
      // user-facing toggles only fire from the Save-As dialog.
      includeComments: true,
      includeAnalytics: true,
      includeUndertags: true,
      readMode: false,
    });
    await getHost().saveExisting(file.handle, bytes);
    flashSaveSuccess();
    markNonPristineStarter();
    markCurrentDocClean();
    multiDocNotifyFocusedSaved?.();
    void clearJournalForActiveDoc();
    return true;
  } catch (err) {
    console.error('Save failed:', err);
    alert(`Save failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

// Floppy = Save (was Save As). The Save command falls through to
// the Save-As dialog automatically when no handle exists or the
// host can't do silent in-place saves, so the first save of a new
// doc still prompts the user for a location and format.
exportBtn.addEventListener('click', () => {
  void runSaveFlow();
});

// ─── Save visual feedback ──────────────────────────────────────────
// On every successful save (manual or autosave) we briefly swap the
// save button's glyph for a check mark, and do the same for the
// autosave toggle when it's on. Subtle reassurance that the bytes
// actually hit disk; doesn't block anything.

const FLASH_DURATION_MS = 1400;
/** Per-element pending revert timers. Re-entrant — a save that
 *  fires while a previous flash is still on screen extends the
 *  flash rather than restoring the original glyph mid-animation. */
const flashTimers = new WeakMap<HTMLElement, number>();

function flashSavedGlyph(el: HTMLElement): void {
  const existing = flashTimers.get(el);
  if (existing !== undefined) {
    window.clearTimeout(existing);
  } else {
    el.dataset['flashOrig'] = el.textContent ?? '';
  }
  el.textContent = '✓';
  el.classList.add('pmd-save-flash');
  const id = window.setTimeout(() => {
    flashTimers.delete(el);
    el.textContent = el.dataset['flashOrig'] ?? '';
    delete el.dataset['flashOrig'];
    el.classList.remove('pmd-save-flash');
  }, FLASH_DURATION_MS);
  flashTimers.set(el, id);
}

/** Flash the save button (always) and the autosave button (when
 *  on). Both manual saves and autosaves call this. Reads via
 *  `autosaveStateForActive` so multi-pane's per-DocRecord flag is
 *  consulted in addition to the single-doc transient setting. */
function flashSaveSuccess(): void {
  flashSavedGlyph(exportBtn);
  if (autosaveBtn && autosaveStateForActive()) {
    flashSavedGlyph(autosaveBtn);
  }
}

// ─── Autosave + crash-recovery journal ────────────────────────────
// Autosave: debounced ~5s after the last doc-changing edit. Only
// fires for `.cmir` files with an existing on-disk handle and a host
// that supports in-place saves. `.docx` is skipped because `toDocx`
// is expensive enough that per-edit autosaves would visibly stutter
// the editor on large debate files.
//
// Journaling: debounced ~3s after the last doc-changing edit.
// Always fires (regardless of autosave) when the host supports it.
// Writes a recoverable cmir snapshot under the doc's UID; cleared
// on successful save / explicit close. Drives the recovery modal
// on startup.

const AUTOSAVE_DELAY_MS = 5000;
const JOURNAL_DELAY_MS = 3000;
let autosaveTimer: number | null = null;
let journalTimer: number | null = null;

/** Called from every view's `dispatchTransaction` when `tx.docChanged`
 *  is true. Re-arms both the autosave debounce (when the setting is
 *  on) and the journal debounce (always, when supported). Cheap to
 *  fire unconditionally — each branch no-ops when its trigger
 *  condition isn't met. */
export function notifyEditForAutosave(): void {
  scheduleJournalWrite();
  if (!settings.get('autosaveEnabled')) return;
  if (autosaveTimer !== null) window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    autosaveTimer = null;
    void runAutosaveAttempt();
  }, AUTOSAVE_DELAY_MS);
}

/** Schedule a debounced journal write for the SINGLE-DOC session.
 *  Multi-doc records run their own per-pane journal scheduling
 *  through the shell, since each DocRecord has its own uid +
 *  filename + handle. */
function scheduleJournalWrite(): void {
  if (!getHost().journalsSupported) return;
  if (multiDocActive) return;
  if (journalTimer !== null) window.clearTimeout(journalTimer);
  journalTimer = window.setTimeout(() => {
    journalTimer = null;
    void runJournalWrite();
  }, JOURNAL_DELAY_MS);
}

async function runJournalWrite(): Promise<void> {
  if (!view) return;
  const host = getHost();
  if (!host.journalsSupported) return;
  try {
    const bytes = serializeNative(view.state.doc, {
      threads: Array.from(getCommentsState(view.state).threads.values()),
    });
    await host.writeJournal({
      uid: currentDocUid,
      filename: currentDocFilename ?? 'Untitled',
      handle:
        typeof currentDocHandle === 'string' ? currentDocHandle : null,
      format: currentDocFormat,
      savedAt: new Date().toISOString(),
      bytes,
    });
  } catch (err) {
    console.warn('Journal write failed:', err);
  }
}

/** Clear the journal for the current single-doc session — called
 *  after a successful save and on New / Open (which replace the
 *  doc). Best-effort; logs failures silently. */
async function clearCurrentJournal(): Promise<void> {
  const host = getHost();
  if (!host.journalsSupported) return;
  try {
    await host.deleteJournal(currentDocUid);
  } catch (err) {
    console.warn('Journal delete failed:', err);
  }
}

/** Clear the journal for whatever doc is "active" — focused
 *  DocRecord in multi-doc, or the single-doc currentDocUid. The
 *  shell exposes the right uid through `multiDocClearFocusedJournal`. */
async function clearJournalForActiveDoc(): Promise<void> {
  if (multiDocActive && multiDocClearFocusedJournal) {
    await multiDocClearFocusedJournal();
    return;
  }
  await clearCurrentJournal();
}

async function runAutosaveAttempt(): Promise<void> {
  if (!settings.get('autosaveEnabled')) return;
  const file = activeFile();
  // Autosave only saves `.cmir` files. The toDocx path is too
  // expensive for background firing; users keep manual control
  // over when docx files hit disk.
  if (file.format !== 'cmir' || !file.handle) return;
  if (!getHost().supportsInPlaceSave) return;
  try {
    const bytes = await serializeForSave('cmir', {
      includeComments: true,
      includeAnalytics: true,
      includeUndertags: true,
      readMode: false,
    });
    await getHost().saveExisting(file.handle, bytes);
    flashSaveSuccess();
    markCurrentDocClean();
    void clearJournalForActiveDoc();
  } catch (err) {
    // Autosave failures are noisy if we alert(); the user will
    // notice manual saves failing if anything's actually broken.
    console.warn('Autosave failed:', err);
  }
}

// ─── Autosave button wiring ────────────────────────────────────────

/** Update the autosave button's pressed state + tooltip based on
 *  the current setting and the active file's format. The button
 *  stays pressed regardless of whether autosave is actually firing
 *  (the user's preference is sovereign), but the tooltip clarifies
 *  when autosave is on but inert (docx file, brand-new doc, etc.). */
function refreshAutosaveBtn(): void {
  if (!autosaveBtn) return;
  const on = autosaveStateForActive();
  autosaveBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  if (!on) {
    autosaveBtn.title = 'Autosave is off — click to turn on';
    autosaveBtn.dataset['autosaveEffective'] = 'false';
    return;
  }
  const file = activeFile();
  const effective = file.format === 'cmir' && !!file.handle;
  autosaveBtn.dataset['autosaveEffective'] = effective ? 'true' : 'false';
  if (effective) {
    autosaveBtn.title = 'Autosave is on — saves to .cmir every few seconds after edits';
  } else if (file.format === 'docx') {
    autosaveBtn.title =
      'Autosave is on, but only fires for .cmir files (this doc is .docx). ' +
      'Save As to .cmir to enable.';
  } else {
    autosaveBtn.title =
      'Autosave is on, but this doc has not been saved yet. Save once to enable.';
  }
}

if (autosaveBtn) {
  autosaveBtn.addEventListener('mousedown', (e) => e.preventDefault());
  autosaveBtn.addEventListener('click', () => {
    if (multiDocActive && multiDocToggleAutosave) {
      multiDocToggleAutosave();
      return;
    }
    settings.set('autosaveEnabled', !settings.get('autosaveEnabled'));
  });
  // Initial state + live updates as the setting / focused doc changes.
  refreshAutosaveBtn();
  settings.subscribe(() => refreshAutosaveBtn());
}

// ─── Native menu wiring (Electron only) ────────────────────────────
// When running inside the Electron shell, the menu bar's File items
// fire IPC messages that we route through the same ribbon-command
// handlers as keyboard shortcuts and ribbon buttons. Single point of
// truth: ribbonContext.
{
  const electronHost = getElectronHost();
  if (electronHost) {
    electronHost.onMenuCommand((command) => {
      switch (command) {
        case 'newDocument':
          ribbonContext.newDocument();
          break;
        case 'openFile':
          ribbonContext.openFile();
          break;
        case 'save':
          ribbonContext.save();
          break;
        case 'saveAs':
          ribbonContext.saveAs();
          break;
      }
    });
    // Mode-switch coordination: another window is about to reload
    // into the new workspace mode and is asking us to journal our
    // current doc and close. The journal write is best-effort; we
    // close regardless so the originating window's
    // `journalAndCloseOtherWindows` promise resolves promptly.
    electronHost.onPleaseCloseForModeSwitch(() => {
      void (async (): Promise<void> => {
        try {
          await runJournalWrite();
        } catch (err) {
          console.warn('Mode-switch journaling failed:', err);
        }
        await electronHost.closeSelf();
      })();
    });
    // User clicked the OS close button. If the doc is clean,
    // close immediately. If dirty, prompt for save / save-as /
    // cancel / discard.
    electronHost.onCloseRequest(() => {
      void handleUserCloseRequest();
    });
  }
}

/** Renderer-side handler for `host:close-request` (the user
 *  clicked the window's close button). Clean docs close
 *  immediately; dirty docs surface a 4-option prompt and act on
 *  the user's choice. Cancel leaves the window open. */
async function handleUserCloseRequest(): Promise<void> {
  const electronHost = getElectronHost();
  if (!electronHost) return;
  if (!currentDocDirty) {
    await electronHost.closeSelf();
    return;
  }
  const choice = await confirmCloseUnsaved();
  switch (choice) {
    case 'save': {
      const ok = await runSaveFlow();
      if (ok) await electronHost.closeSelf();
      return;
    }
    case 'saveAs': {
      const ok = await runSaveAsFlow();
      if (ok) await electronHost.closeSelf();
      return;
    }
    case 'discard': {
      // User wants the work gone. Drop the journal so it doesn't
      // surface as a recovery option on the next launch, then
      // close.
      await clearCurrentJournal().catch(() => {
        /* best-effort */
      });
      await electronHost.closeSelf();
      return;
    }
    case 'cancel':
      // Window stays open.
      return;
  }
}

/** Four-button overlay for "user wants to close a dirty doc."
 *  Same DOM shape as `confirmNewDocOverwrite` but with separate
 *  Save and Save-As actions (in-place save vs pick-location) plus
 *  an explicit Discard. Esc / overlay-click cancel. Exported for
 *  multi-pane's per-pane close handler. */
export function confirmCloseUnsaved(): Promise<'save' | 'saveAs' | 'discard' | 'cancel'> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'pmd-route-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'pmd-route-dialog';

    const header = document.createElement('div');
    header.className = 'pmd-route-header';
    header.textContent = 'You have unsaved changes. Save before closing?';
    dialog.appendChild(header);

    const buttons = document.createElement('div');
    buttons.className = 'pmd-route-buttons';

    const cleanup = (): void => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    };

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'pmd-route-btn';
    saveBtn.innerHTML =
      '<strong>Save</strong><br><span>Write to the existing file, then close.</span>';
    saveBtn.addEventListener('click', () => {
      cleanup();
      resolve('save');
    });
    buttons.appendChild(saveBtn);

    const saveAsBtn = document.createElement('button');
    saveAsBtn.type = 'button';
    saveAsBtn.className = 'pmd-route-btn';
    saveAsBtn.innerHTML =
      '<strong>Save As…</strong><br><span>Pick a location, then close.</span>';
    saveAsBtn.addEventListener('click', () => {
      cleanup();
      resolve('saveAs');
    });
    buttons.appendChild(saveAsBtn);

    const discardBtn = document.createElement('button');
    discardBtn.type = 'button';
    discardBtn.className = 'pmd-route-btn';
    discardBtn.innerHTML =
      "<strong>Don't save</strong><br><span>Discard changes and close. Recovery journal is dropped.</span>";
    discardBtn.addEventListener('click', () => {
      cleanup();
      resolve('discard');
    });
    buttons.appendChild(discardBtn);

    dialog.appendChild(buttons);

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'pmd-route-cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
      cleanup();
      resolve('cancel');
    });
    dialog.appendChild(cancel);

    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        cleanup();
        resolve('cancel');
      }
    });
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        cleanup();
        resolve('cancel');
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
  });
}

function countSummary(doc: PMNode): string {
  const counts: Record<string, number> = {};
  doc.descendants((node) => {
    counts[node.type.name] = (counts[node.type.name] ?? 0) + 1;
  });
  return Object.entries(counts)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
}

// Boot: if multi-doc workspace is enabled, hand off to the multi-pane
// shell. Otherwise mount the starter doc in the single-doc shell.
// Crash recovery runs after the editor is up (so the recovery modal
// has somewhere to mount over).
const BOOT_MULTI_DOC_WORKSPACE = settings.get('multiDocWorkspace');
// Multi-window mode = single-doc + a host that can spawn windows
// (Electron). Gates the speech-stack ribbon cluster's visibility
// via CSS (single-doc-without-spawn has nothing to send TO).
if (!BOOT_MULTI_DOC_WORKSPACE && getHost().canSpawnWindow) {
  document.body.classList.add('pmd-multi-window');
}
// Install the cross-window send-to-speech receiver. No-op when not
// on Electron; safe to install in both single-doc and (will-be)
// multi-pane paths since the resolver filters by uid.
installIncomingSpeechSliceHandler();
if (BOOT_MULTI_DOC_WORKSPACE) {
  void import('./multi-pane-shell.js').then(async (m) => {
    m.mountMultiPaneShell();
    await runStartupRecovery();
  });
} else {
  void initSingleDocBoot();
}

/** Single-doc boot. On hosts that support window spawning, check
 *  for a pending initial-doc payload first (this window may have
 *  been spawned by another window's Open / New click). If yes,
 *  mount the payload and skip the recovery sidebar (spawned
 *  windows aren't the right place to surface unrelated journal
 *  drafts — that belongs to the first window of the session).
 *  If no payload, mount the starter and run normal recovery. */
async function initSingleDocBoot(): Promise<void> {
  const host = getHost();
  if (host.canSpawnWindow) {
    let payload: Awaited<ReturnType<typeof host.getInitialDoc>>;
    try {
      payload = await host.getInitialDoc();
    } catch (err) {
      console.warn('getInitialDoc failed:', err);
      payload = null;
    }
    if (payload) {
      await mountFromSpawnPayload(payload);
      return;
    }
  }
  // No spawn payload — either this is the first window of an app
  // session or it's a blank window spawned later (e.g., the user
  // clicked "New document" while two other windows were already
  // open). Mount the starter doc in either case, but ONLY surface
  // the recovery sidebar on the first window: spawned-blank
  // windows would otherwise offer to recover the docs the user
  // already has open in OTHER windows of the same session, which
  // is both confusing and useless.
  mountView(currentDoc);
  syncSingleDocSpeechRegistration();
  let isFirst = true;
  try {
    isFirst = await getHost().isFirstWindow();
  } catch (err) {
    console.warn('isFirstWindow failed; defaulting to true:', err);
  }
  if (isFirst) await runStartupRecovery();
}

/** Mount a SpawnWindowPayload into this freshly-spawned window.
 *  Parses the bytes (cmir → parseNative, docx → fromDocxFull),
 *  mounts the result, and sets the doc-state module vars. */
async function mountFromSpawnPayload(
  payload: Awaited<ReturnType<ReturnType<typeof getHost>['getInitialDoc']>>,
): Promise<void> {
  if (!payload) return;
  try {
    let docNode: PMNode;
    let docThreads: Thread[] | undefined;
    const format = payload.format ?? formatFromFilename(payload.filename) ?? 'docx';
    if (format === 'cmir') {
      const parsed = parseNative(payload.bytes);
      docNode = parsed.doc;
      docThreads = parsed.threads.length > 0 ? parsed.threads : undefined;
    } else {
      const result = await fromDocxFull(payload.bytes);
      docNode = result.doc;
      docThreads = result.threads;
    }
    mountView(docNode, docThreads);
    currentDocFilename = payload.filename;
    currentDocHandle = payload.handle;
    currentDocFormat = format;
    currentDocUid = payload.uid ?? newSessionDocUid();
    // Newly spawned window starts clean — even though it has
    // pre-loaded content from the originating window, it hasn't
    // been edited in THIS window's session.
    markCurrentDocClean();
    syncSingleDocSpeechRegistration();
    if (payload.markAsSpeech) {
      // New Speech Document flow: the spawning window built the
      // doc + flagged us as the destination, so we self-mark now
      // that our view is registered with the resolver. Main will
      // broadcast `speech:changed` to every window, including the
      // originator, so the per-window banner + ribbon button
      // reflect the new state.
      getSpeechDocResolver().setSpeechByUid(currentDocUid);
      // Position the cursor inside the empty paragraph below the
      // Pocket header (when the speech doc was created WITH a
      // header) so the user can start typing / receiving sends
      // immediately. Without a header — `includeSpeechDocPocket`
      // off — the doc is just one paragraph and the default
      // selection lands inside it, no adjustment needed.
      if (view && docNode.firstChild?.type.name === 'pocket' && docNode.childCount > 1) {
        const pocketSize = docNode.firstChild.nodeSize;
        const cursorPos = pocketSize + 1;
        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.create(view.state.doc, cursorPos),
          ),
        );
      }
    }
    markNonPristineStarter();
    updateWindowTitle();
    console.log(`Spawned with ${payload.filename}: ${countSummary(docNode)}`);
  } catch (err) {
    console.error('Failed to mount spawned doc:', err);
    alert(`Failed to load: ${err instanceof Error ? err.message : err}`);
    // Fall back to the starter so the window isn't broken.
    mountView(currentDoc);
  }
}

// ─── Mode-switch handler ──────────────────────────────────────────
// When the user toggles `multiDocWorkspace`, prompt to reload. On
// confirm: journal every open doc with a "mode-switch" marker,
// reload the page, and let the startup-recovery flow silently
// reopen them in the new layout. On cancel: revert the setting.
let modeSwitchInFlight = false;
settings.subscribe((s) => {
  if (modeSwitchInFlight) return;
  if (s.multiDocWorkspace === BOOT_MULTI_DOC_WORKSPACE) return;
  void handleModeSwitch(s.multiDocWorkspace);
});

const MODE_SWITCH_MARKER_KEY = 'cardmirror:mode-switch-recovery';

async function handleModeSwitch(newValue: boolean): Promise<void> {
  modeSwitchInFlight = true;
  const message = newValue
    ? 'Switch to three-pane workspace?\n\nAny other open CardMirror windows will close, and every open document will reopen as a pane in this window.'
    : 'Switch to one-document-per-window mode?\n\nThe editor will reload and your open documents will each reopen in their own window.';
  if (!window.confirm(message)) {
    // Revert. The `modeSwitchInFlight` guard prevents the
    // subscriber from re-running and looping.
    settings.set('multiDocWorkspace', BOOT_MULTI_DOC_WORKSPACE);
    modeSwitchInFlight = false;
    return;
  }
  try {
    // If we're on Electron and other windows are open, have each
    // of them journal their current doc and close before we
    // reload. The post-reload recovery picks up every journal and
    // restores the docs in the new layout.
    const electronHost = getElectronHost();
    if (electronHost) {
      await electronHost.journalAndCloseOtherWindows();
    }
    await journalAllForModeSwitch();
    sessionStorage.setItem(MODE_SWITCH_MARKER_KEY, '1');
  } catch (err) {
    console.error('Mode-switch journaling failed:', err);
    alert(
      `Couldn't save open documents before switching modes: ${err instanceof Error ? err.message : err}\n\nReverting.`,
    );
    settings.set('multiDocWorkspace', BOOT_MULTI_DOC_WORKSPACE);
    modeSwitchInFlight = false;
    return;
  }
  window.location.reload();
}

/** Journal every currently-open doc so the post-reload recovery
 *  flow can restore them in the new layout. */
async function journalAllForModeSwitch(): Promise<void> {
  if (multiDocActive && multiDocJournalAll) {
    await multiDocJournalAll();
    return;
  }
  // Single-doc: write one journal for the current view.
  await runJournalWrite();
}

/** Startup recovery — read any unsaved journals from the previous
 *  session and surface the recovery sidebar if there are any. The
 *  sidebar lets the user open each draft into the editor for
 *  inspection before deciding whether to keep it (save) or
 *  discard it. Drafts left undecided when the sidebar closes
 *  remain in the journal store for the next launch. */
async function runStartupRecovery(): Promise<void> {
  const host = getHost();
  if (!host.journalsSupported) return;
  let entries: JournalEntry[];
  try {
    entries = await host.readJournals();
  } catch (err) {
    console.warn('Failed to read recovery journals:', err);
    return;
  }
  if (entries.length === 0) return;
  // Mode-switch reload: the user toggled `multiDocWorkspace` and we
  // journaled everything before reloading. Now auto-open all
  // entries silently in the new layout — no recovery sidebar.
  if (sessionStorage.getItem(MODE_SWITCH_MARKER_KEY) === '1') {
    sessionStorage.removeItem(MODE_SWITCH_MARKER_KEY);
    await autoRecoverAll(entries);
    return;
  }
  const { openRecoverySidebar } = await import('./recovery-ui.js');
  await openRecoverySidebar(entries, {
    onSave: async (entry) => {
      return saveRecoveryEntry(entry);
    },
    onOpen: async (entry) => {
      // Multi-doc opens into a slot; single-doc replaces the
      // current view.
      if (multiDocActive && multiDocOnRecoveredDoc) {
        try {
          const parsed = parseNative(entry.bytes);
          await multiDocOnRecoveredDoc({
            uid: entry.uid,
            filename: entry.filename,
            handle: entry.handle,
            format: entry.format,
            doc: parsed.doc,
            threads: parsed.threads,
          });
        } catch (err) {
          console.warn(`Failed to parse recovery journal for ${entry.uid}:`, err);
        }
        return;
      }
      await applyRecovery(entry);
    },
    onDiscard: async (entry) => {
      try {
        await host.deleteJournal(entry.uid);
      } catch (err) {
        console.warn('Failed to discard journal:', err);
      }
    },
  });
}

/** Persist a recovery journal entry to disk without opening it in
 *  the editor. Used by the recovery sidebar's Save action so the
 *  user can finalize a draft directly from the sidebar.
 *
 *  In-place when `entry.handle` exists and we can save silently;
 *  otherwise opens the same Save-As modal the regular save path
 *  uses, defaulting to the entry's original filename / format.
 *  Deletes the journal entry on success so it doesn't reappear in
 *  the recovery list next launch. Returns whether the user
 *  committed to a save. */
async function saveRecoveryEntry(entry: JournalEntry): Promise<boolean> {
  const host = getHost();
  // In-place save when we have a handle and the host supports
  // silent writes — re-serialize the journal's cmir bytes through
  // PM to either cmir-out (cheap) or docx-out (toDocx).
  if (entry.handle && entry.format && host.supportsInPlaceSave) {
    try {
      const bytes = await reserializeJournalAs(entry, entry.format);
      if (typeof entry.handle !== 'string') return false;
      await host.saveExisting(entry.handle, bytes);
      await host.deleteJournal(entry.uid).catch(() => {
        /* best-effort */
      });
      return true;
    } catch (err) {
      console.error('Recovery save failed:', err);
      alert(`Save failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }
  // No handle, or host can't save in place — open the Save-As
  // modal pre-filled with the entry's name + format. Anything the
  // user picks here writes a fresh file.
  const choice = await openSaveAs({
    initialFilename: entry.filename || 'Untitled',
    defaultFormat: entry.format ?? 'cmir',
  });
  if (!choice) return false;
  try {
    const bytes = await reserializeJournalAs(entry, choice.format);
    const filters =
      choice.format === 'cmir'
        ? [{ name: 'CardMirror native (.cmir)', extensions: ['cmir'] }]
        : [{ name: 'Microsoft Word (.docx)', extensions: ['docx'] }];
    const result = await host.saveAs(choice.filename, bytes, { filters });
    if (!result) return false;
    await host.deleteJournal(entry.uid).catch(() => {
      /* best-effort */
    });
    return true;
  } catch (err) {
    console.error('Recovery Save As failed:', err);
    alert(`Save As failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/** Convert a journal entry's stored cmir bytes into the requested
 *  on-disk format. cmir → cmir is a passthrough (the journal
 *  already stores cmir); cmir → docx parses the journal and runs
 *  the export pipeline. */
async function reserializeJournalAs(
  entry: JournalEntry,
  format: 'cmir' | 'docx',
): Promise<Uint8Array> {
  if (format === 'cmir') {
    // Defensive copy — entry.bytes may be a Buffer post-IPC.
    return entry.bytes instanceof Uint8Array
      ? entry.bytes
      : new Uint8Array(entry.bytes as ArrayBufferLike);
  }
  const parsed = parseNative(entry.bytes);
  const exportDoc = transformForExport(parsed.doc, {
    includeComments: true,
    includeAnalytics: true,
    includeUndertags: true,
    readMode: false,
  });
  return toDocx(
    exportDoc,
    parsed.threads.length > 0 ? { threads: parsed.threads } : undefined,
  );
}

/** Silently open every journal entry as part of a mode-switch
 *  reload — the user already confirmed; no sidebar, no per-entry
 *  decisions. Multi-doc routes each through the shell's slot
 *  router; single-doc on Electron mounts the most-recently-saved
 *  entry here and spawns a new window for each remaining entry
 *  (so a mode switch from panes → windows actually distributes
 *  the open docs across windows). Single-doc on the web edition
 *  mounts the most recent and leaves the rest as journals (they'll
 *  show up in the recovery sidebar on the next non-mode-switch
 *  launch). */
async function autoRecoverAll(entries: JournalEntry[]): Promise<void> {
  if (multiDocActive && multiDocOnRecoveredDoc) {
    for (const entry of entries) {
      try {
        const parsed = parseNative(entry.bytes);
        await multiDocOnRecoveredDoc({
          uid: entry.uid,
          filename: entry.filename,
          handle: entry.handle,
          format: entry.format,
          doc: parsed.doc,
          threads: parsed.threads,
        });
      } catch (err) {
        console.warn(`Failed to auto-recover ${entry.uid}:`, err);
      }
    }
    return;
  }
  // Single-doc: most-recent goes into THIS window; rest spawn new
  // windows on hosts that support it, else linger as journals.
  const sorted = [...entries].sort((a, b) =>
    (b.savedAt ?? '').localeCompare(a.savedAt ?? ''),
  );
  const winner = sorted[0];
  if (!winner) return;
  await applyRecovery(winner);
  const host = getHost();
  if (!host.canSpawnWindow) return;
  for (const entry of sorted.slice(1)) {
    try {
      await host.spawnWindow({
        filename: entry.filename,
        bytes: entry.bytes,
        handle: entry.handle,
        format: entry.format,
        // Reuse the original uid so the spawned window's
        // journal continues to track the same logical doc.
        uid: entry.uid,
      });
    } catch (err) {
      console.warn(`Failed to spawn window for recovered ${entry.uid}:`, err);
    }
  }
}

/** Load a recovered journal entry into the single-doc editor (the
 *  recovered doc replaces the current one). Multi-doc routing
 *  happens inline in `runStartupRecovery` via the shell hook. */
async function applyRecovery(entry: JournalEntry): Promise<void> {
  let parsed: ReturnType<typeof parseNative>;
  try {
    parsed = parseNative(entry.bytes);
  } catch (err) {
    console.warn(`Failed to parse recovery journal for ${entry.uid}:`, err);
    return;
  }
  mountView(parsed.doc, parsed.threads.length > 0 ? parsed.threads : undefined);
  currentDocFilename = entry.filename;
  currentDocHandle = entry.handle;
  currentDocFormat = entry.format;
  // Reuse the original uid so a re-crash overwrites the same
  // journal slot (rather than accumulating new ones).
  currentDocUid = entry.uid;
  // Recovery restores content that wasn't successfully saved on the
  // previous session, so the doc is dirty by definition.
  markCurrentDocDirty();
  syncSingleDocSpeechRegistration();
  markNonPristineStarter();
  updateWindowTitle();
}
