/**
 * Minimal browser editor — v0.
 *
 * Mounts a ProseMirror EditorView with our schema. Lets the user drop a
 * .docx, see it rendered, and export it back. This exists as a visual
 * sanity check while we build the foundation; full editor UX (read mode,
 * navigation panel, send-to-speech, drag-and-drop, etc.) is later work.
 */

import { EditorState, type Plugin } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { history, undo, redo } from 'prosemirror-history';
import { baseKeymap } from 'prosemirror-commands';
import { Node as PMNode, type Mark } from 'prosemirror-model';
import { schema, newHeadingId } from '../schema/index.js';
import { fromDocxFull, toDocx } from '../index.js';
import { transformForExport } from '../export/transform-for-export.js';
import type { Thread } from './comments-plugin.js';
import { NavigationPanel } from './nav-panel.js';
import { openSettings } from './settings-ui.js';
import { openReference } from './reference-ui.js';
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
import { tableEditing, columnResizing } from 'prosemirror-tables';
import { buildPastePlugin, togglePlainPaste } from './paste-plugin.js';
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

const editorEl = document.getElementById('editor')!;
const navEl = document.getElementById('nav-panel')!;
const dropzone = document.getElementById('dropzone') as HTMLInputElement;
const openBtn = document.getElementById('open-btn') as HTMLButtonElement;
const newBtn = document.getElementById('new-btn') as HTMLButtonElement | null;
const exportBtn = document.getElementById('export-btn') as HTMLButtonElement;
const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement;
const referenceBtn = document.getElementById('reference-btn') as HTMLButtonElement | null;
const readModeBtn = document.getElementById('read-mode-btn') as HTMLButtonElement;
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
let currentDoc: PMNode = makeStarterDoc();

/** Multi-doc workspace gate. When true, the multi-pane shell has
 *  taken over the main shell — it manages its own EditorViews and
 *  pushes the focused pane's view into the module-level `view`
 *  variable below via `setActiveView`. The single-doc dropzone and
 *  mountView path become no-ops. */
let multiDocActive = false;
/** When the multi-pane shell is active, this delegates file-open
 *  routing to its prompt-for-slot flow. */
let multiDocOnFileOpen: ((file: File) => Promise<void> | void) | null = null;
/** When the multi-pane shell is active, this delegates the
 *  "New doc" ribbon button to the shell's slot-routing flow. */
let multiDocOnNewDoc: (() => Promise<void> | void) | null = null;

/** Multi-pane shell hooks. Called by `multi-pane-shell.ts` at boot
 *  to install the override that redirects the single-doc dropzone
 *  + mountView paths into per-pane routing. */
export function enableMultiDocMode(opts: {
  onFileOpen: (file: File) => Promise<void> | void;
  onNewDoc?: () => Promise<void> | void;
}): void {
  multiDocActive = true;
  multiDocOnFileOpen = opts.onFileOpen;
  multiDocOnNewDoc = opts.onNewDoc ?? null;
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
  // word-count display, paragraph integrity indicator, etc.).
  refreshFontSizeDisplay();
  refreshWordCount();
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
    settings.set('readMode', !settings.get('readMode'));
  },
  openShortcutsReference: () => openReference(),
  toggleCommentsVisible: () => {
    if (!commentsColumn || !commentsColumnEl) return;
    const next = commentsColumnEl.hidden;
    commentsColumn.setVisible(next);
    commentsToggleBtn?.setAttribute('aria-pressed', next ? 'true' : 'false');
    commentsColumn.render();
  },
  addCommentToSelection: () => {
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
};

openBtn.addEventListener('click', () => dropzone.click());
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
  const choice = await confirmNewDocOverwrite();
  if (choice === 'cancel') return;
  if (choice === 'save') {
    const saved = await runSaveAsFlow();
    if (!saved) return;
  }
  mountView(makeStarterDoc());
  currentDocFilename = null;
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

if (referenceBtn) {
  referenceBtn.addEventListener('click', () => runRibbon('openShortcutsReference'));
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
  if (!view) return;
  const cmd = getRibbonCommand(cmdId, ribbonContext);
  cmd(view.state, view.dispatch.bind(view), view);
});

// Wire the color panel (split buttons + swatch pickers). Pass a ref
// object so the panel reads the live view through `view.view` even
// when the EditorView gets re-mounted (e.g. on docx import).
wireColorPanel({ get view() { return view; } });

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

// Plain Paste toggle — clicking flips the paste-plugin's armed flag,
// same as pressing F2. The plugin's `onArmedChange` callback mirrors
// the new state back into `aria-pressed` (via updatePlainPasteIndicator).
if (plainPasteToggleBtn) {
  plainPasteToggleBtn.addEventListener('mousedown', (e) => e.preventDefault());
  plainPasteToggleBtn.addEventListener('click', () => {
    if (!view) return;
    togglePlainPaste()(view.state, view.dispatch.bind(view));
  });
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

function applyReadMode(on: boolean): void {
  editorEl.classList.toggle('pmd-read-mode', on);
  editorEl.classList.toggle(
    'pmd-rm-no-emphasis-borders',
    on && settings.get('hideEmphasisBordersInReadMode'),
  );
  readModeBtn.classList.toggle('pmd-active', on);
  if (view) {
    view.setProps({ editable: () => !on });
    // Force the read-mode plugin to (re)compute decorations. With the
    // optimization that skips decoration work while read mode is off,
    // toggling on/off needs an explicit trigger since the plugin
    // otherwise only reacts to doc changes.
    view.dispatch(view.state.tr.setMeta(PMD_READ_MODE_TOGGLE, true));
  }
}

const navPanel = new NavigationPanel(navEl);

function makeStarterDoc(): PMNode {
  return schema.nodes['doc']!.createChecked(null, [
    schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text('prosemirror-debate playground')),
    schema.nodes['paragraph']!.create(null, [
      schema.text('Drop a .docx in the input above to load it. The schema renders here as the canonical Verbatim layout (Pocket = box, Hat = centered double underline, Block = centered single underline, Tag = inline-bold).'),
    ]),
    schema.nodes['hat']!.create({ id: newHeadingId() }, schema.text('Example structures')),
    schema.nodes['block']!.create({ id: newHeadingId() }, schema.text('A block containing a card and an analytic')),
    schema.nodes['paragraph']!.create(null, schema.text('Loose paragraphs are first-class — they can sit between a heading and the cards beneath it. Paragraphs typed after a card auto-absorb as card_body; insert a heading to bound a region of loose text.')),
    schema.nodes['card']!.create(null, [
      schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Climate action delays catastrophic — IPCC')),
      // Undertags belong to the tag — they sit inside the card, not after it.
      schema.nodes['undertag']!.create(null, schema.text('Sub-tag note that explains the tag.')),
      schema.nodes['cite_paragraph']!.create(null, [
        schema.text('IPCC AR6 ', [schema.marks['cite_mark']!.create()]),
        schema.text('2023, '),
        schema.text('Synthesis Report', [schema.marks['italic']!.create()]),
        schema.text(', '),
        schema.text('https://ipcc.ch', [schema.marks['link']!.create({ href: 'https://www.ipcc.ch' })]),
      ]),
      schema.nodes['card_body']!.create(null, [
        schema.text('Plain context. '),
        schema.text('Underlined evidence claim ', [schema.marks['underline_mark']!.create()]),
        schema.text('plus highlighted ', [
          schema.marks['underline_mark']!.create(),
          schema.marks['highlight']!.create({ color: 'yellow' }),
        ]),
        schema.text('and emphasized.', [
          schema.marks['emphasis_mark']!.create(),
          schema.marks['highlight']!.create({ color: 'yellow' }),
        ]),
      ]),
    ]),
    schema.nodes['analytic_unit']!.create(null, [
      schema.nodes['analytic']!.create(
        { id: newHeadingId() },
        schema.text('A standalone analytic between cards.'),
      ),
      schema.nodes['card_body']!.create(null, [
        schema.text('Body paragraphs after the analytic are absorbed into the unit, so the whole thing drags as one. Hover to see the gray bar — same boundary indicator as cards.'),
      ]),
    ]),
  ]);
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
 *  its name. Set on import, untouched by export. */
let currentDocFilename: string | null = null;

dropzone.addEventListener('change', async () => {
  const file = dropzone.files?.[0];
  if (!file) return;
  // Multi-doc mode delegates routing to the multi-pane shell (which
  // shows the "Send to slot 1/2/3" inline picker before loading).
  if (multiDocActive && multiDocOnFileOpen) {
    try {
      await multiDocOnFileOpen(file);
    } catch (err) {
      console.error('Multi-doc open failed:', err);
      alert(`Failed to open: ${err instanceof Error ? err.message : err}`);
    } finally {
      // Reset the file input so picking the same filename twice still
      // fires `change` the second time.
      dropzone.value = '';
    }
    return;
  }
  const buf = await file.arrayBuffer();
  try {
    const { doc, threads } = await fromDocxFull(new Uint8Array(buf));
    mountView(doc, threads);
    currentDocFilename = file.name;
    console.log(`Loaded ${file.name}: ${countSummary(doc)}`);
  } catch (err) {
    console.error('Failed to load docx:', err);
    alert(`Failed to load: ${err instanceof Error ? err.message : err}`);
  }
});

/** Default Save-As filename: the imported file's name, or untitled. */
function defaultSaveFilename(): string {
  if (currentDocFilename) {
    // If the imported name already ends in .docx, keep it. Otherwise
    // append it so the browser doesn't ambiguously type the file.
    return currentDocFilename.toLowerCase().endsWith('.docx')
      ? currentDocFilename
      : `${currentDocFilename}.docx`;
  }
  return 'untitled.docx';
}

/**
 * Run the Save As flow. Returns `true` when the user committed to a
 * save (and the bytes hit disk / downloaded), `false` when they
 * cancelled the dialog or the OS file picker — including the case
 * where the user cancelled mid-stream. Extracted so the New-doc
 * confirmation flow can reuse it.
 */
async function runSaveAsFlow(): Promise<boolean> {
  const choice = await openSaveAs(defaultSaveFilename());
  if (!choice) return false;
  try {
    // In multi-doc mode the focused pane drives Save — read its
    // doc directly so we always export the right one regardless
    // of when `currentDoc` was last synced.
    const docToExport = view ? view.state.doc : currentDoc;
    const exportDocNode = transformForExport(docToExport, {
      includeComments: choice.includeComments,
      includeAnalytics: choice.includeAnalytics,
      includeUndertags: choice.includeUndertags,
      readMode: choice.readMode,
    });
    // Flush any pending comments GC before reading thread state.
    // GC moved from the per-transaction `appendTransaction` to the
    // 200ms idle debounce — so it's possible the user hits Save
    // mid-burst with orphan threads still tracked. Run it sync now
    // so the export only emits threads with surviving marks.
    if (view) gcOrphanThreads(view);
    // Pull threads from the comments plugin when the Save-As
    // dialog said to include them; otherwise the exporter strips
    // brackets and skips the parts entirely.
    const threads = choice.includeComments && view
      ? Array.from(getCommentsState(view.state).threads.values())
      : undefined;
    const bytes = await toDocx(exportDocNode, threads ? { threads } : undefined);
    // Copy into a regular ArrayBuffer for Blob's BlobPart contract.
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    const blob = new Blob([ab], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    // Preferred path: File System Access API (`showSaveFilePicker`).
    // Gives the user a native save dialog with our chosen name pre-
    // filled, and writes straight to disk. Chromium-based browsers
    // (Chrome / Edge / Opera / Zen). Other browsers fall back to a
    // synthesized download link with the chosen name verbatim.
    const showSaveFilePicker = (window as unknown as {
      showSaveFilePicker?: (opts: {
        suggestedName?: string;
        types?: { description: string; accept: Record<string, string[]> }[];
      }) => Promise<{
        createWritable(): Promise<{
          write(data: Blob | ArrayBuffer | Uint8Array): Promise<void>;
          close(): Promise<void>;
        }>;
        name?: string;
      }>;
    }).showSaveFilePicker;

    if (typeof showSaveFilePicker === 'function') {
      let handle;
      try {
        handle = await showSaveFilePicker({
          suggestedName: choice.filename,
          types: [
            {
              description: 'Word document',
              accept: {
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
              },
            },
          ],
        });
      } catch (e) {
        // AbortError = user cancelled the OS dialog. Quietly bail.
        if (e instanceof DOMException && e.name === 'AbortError') return false;
        throw e;
      }
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      // Remember the user's chosen name as the new default — so a
      // second Save As prefills the renamed file.
      if (handle.name) currentDocFilename = handle.name;
      return true;
    }

    // Fallback: synthesize a download link with the chosen name.
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = choice.filename;
    a.click();
    URL.revokeObjectURL(url);
    currentDocFilename = choice.filename;
    return true;
  } catch (err) {
    console.error('Save failed:', err);
    alert(`Save failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

exportBtn.addEventListener('click', () => {
  void runSaveAsFlow();
});

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
if (settings.get('multiDocWorkspace')) {
  void import('./multi-pane-shell.js').then((m) => m.mountMultiPaneShell());
} else {
  mountView(currentDoc);
}
