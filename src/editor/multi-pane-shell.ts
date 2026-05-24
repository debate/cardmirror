/**
 * Multi-pane workspace shell.
 *
 * Mounted at boot when `settings.get('multiDocWorkspace')` is true.
 * Owns three slots (`slot1` / `slot2` / `slot3`), each holding a stack
 * of 0+ documents. Renders a per-slot pane with a small title chip,
 * the live ProseMirror EditorView, and a footer (word count + Open
 * file button). The nav pane is split into one section per active
 * slot. The shared ribbon, status bar, and Save / Save As route
 * through the focused pane via `setActiveView` in `editor/index.ts`.
 *
 * Comments: a single shared `#comments-column` sits to the right of
 * the multi-row like a narrow fourth slot. The threads shown follow
 * focus, and cards relayout against `view.coordsAtPos` on every
 * focused-pane scroll tick (the column doesn't share a scroll
 * container with any pane).
 *
 * Layout cells:
 *   - 1 active slot  → full width
 *   - 2 active slots → 50/50
 *   - 3 active slots → compact (thirds) OR wide-scroll (paged)
 *
 * Cross-pane drag = copy (handled in `drag-controller.ts`'s commit
 * branch for cross-view drops). Drag from doc → another doc's nav
 * section works the same way: the destination nav section's surface
 * declares its view, the controller treats it as cross-view.
 */

import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../schema/index.js';
import { fromDocxFull, parseNative, serializeNative, NATIVE_FILE_EXTENSION } from '../index.js';
import { settings } from './settings.js';
import { getHost, getElectronHost, isSameOpenHandle, type OpenedFile } from './host/index.js';
import { getCommentsState, loadThreads, type Thread } from './comments-plugin.js';

type DocFormat = 'cmir' | 'docx';

/** Decide which on-disk format a file is, given its filename.
 *  Returns null for filenames with neither a `.cmir` nor `.docx`
 *  extension (the caller can fall back to format detection by
 *  content sniffing, or just default to docx). */
function formatFromFilename(name: string): DocFormat | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.cmir')) return 'cmir';
  if (lower.endsWith('.docx')) return 'docx';
  return null;
}
import { NavigationPanel } from './nav-panel.js';
import { EditorDragSurface } from './drag-editor-surface.js';
import { dragController, rewriteHeadingIds } from './drag-controller.js';
import { countReadAloudWords, formatReadTime, formatNumber } from './word-count.js';
import { scheduleIdle, cancelIdle, type IdleHandle } from './idle-scheduler.js';
import { getSpeechDocResolver } from './speech-doc-registry.js';
import { sendToSpeech as runSendToSpeech } from './speech-doc-send.js';
import { promptForText } from './text-prompt.js';
import { showToast } from './toast.js';
import {
  buildEditorPlugins,
  enableMultiDocMode,
  setActiveView,
  getActiveView,
  applyReadModeToTarget,
  setReadModeStateResolver,
  setAutosaveStateResolver,
  setActiveNavPanelResolver,
  attachClickBelowToEnd,
  confirmCloseUnsaved,
  runSaveFlow,
  runSaveAsFlow,
  refreshWindowTitle,
  commentsColumn,
  getCommentsColumnEl,
  notifyCommentsForActiveTransaction,
} from './index.js';

type SlotId = 'slot1' | 'slot2' | 'slot3';
const SLOT_IDS: SlotId[] = ['slot1', 'slot2', 'slot3'];

let nextDocUid = 1;
function newDocUid(): string {
  return `doc-${nextDocUid++}`;
}

/** Sync the cross-window open-path claim when a record's handle
 *  changes. Releases `prev`'s claim (if any) and registers
 *  `next`'s claim (if any) with the main process. No-op outside
 *  Electron (browser has no cross-window concept). Called from
 *  the record lifecycle: mount (null → handle), Save-As (old →
 *  new), close (handle → null). Best-effort fire-and-forget —
 *  main also cleans up automatically when a window closes, so a
 *  missed release won't permanently block re-opening. */
function syncDocPathClaim(prev: unknown, next: unknown): void {
  if (prev === next) return;
  const electron = getElectronHost();
  if (!electron) return;
  if (typeof prev === 'string' && prev) void electron.openPathRelease(prev);
  if (typeof next === 'string' && next) void electron.openPathRegister(next);
}

/** Push a pane's current filename to main so the Select-Speech-Doc
 *  modal can label it. No-op on web. */
function pushPaneDocInfo(uid: string, filename: string | null): void {
  const electron = getElectronHost();
  if (!electron) return;
  void electron.docInfoUpdate(uid, filename);
}

/** Debounce window for per-DocRecord journal writes. */
const RECORD_JOURNAL_DELAY_MS = 3000;

/** Re-arm the journal-write timer for `record` after a doc edit.
 *  No-op when the host doesn't support journaling. */
function scheduleJournalForRecord(record: DocRecord): void {
  const host = getHost();
  if (!host.journalsSupported) return;
  if (record.journalTimer !== null) window.clearTimeout(record.journalTimer);
  record.journalTimer = window.setTimeout(() => {
    record.journalTimer = null;
    void runJournalForRecord(record);
  }, RECORD_JOURNAL_DELAY_MS);
}

/** Actually serialize + write `record`'s current doc as a journal
 *  entry under its uid. Best-effort — logs failures, doesn't
 *  surface them to the user. */
async function runJournalForRecord(record: DocRecord): Promise<void> {
  const host = getHost();
  if (!host.journalsSupported) return;
  try {
    const state = record.view.state;
    const bytes = serializeNative(state.doc, {
      threads: Array.from(getCommentsState(state).threads.values()),
    });
    await host.writeJournal({
      uid: record.uid,
      filename: record.filename,
      handle: typeof record.handle === 'string' ? record.handle : null,
      format: record.format,
      savedAt: new Date().toISOString(),
      bytes,
    });
  } catch (err) {
    console.warn('Journal write failed:', err);
  }
}

/** Delete the journal entry for `record`. Called on successful
 *  save and on explicit close. */
async function clearJournalForRecord(record: DocRecord): Promise<void> {
  const host = getHost();
  if (!host.journalsSupported) return;
  try {
    await host.deleteJournal(record.uid);
  } catch (err) {
    console.warn('Journal delete failed:', err);
  }
}

/** Debounce delay before an autosave attempt fires after the user
 *  pauses editing. Matches the single-doc constant in editor/index.ts. */
const AUTOSAVE_DELAY_MS = 5000;

/** Per-DocRecord autosave attempt. Like the single-doc
 *  `runAutosaveAttempt`, but bound to `record` instead of the
 *  module-level focused view — so edits in pane A flush to A's
 *  file even when focus has since moved to B. Same gates: opt-in
 *  per-record, .cmir + saved-once only, supportsInPlaceSave host. */
async function runAutosaveForRecord(record: DocRecord): Promise<void> {
  if (!record.autosaveEnabled) return;
  if (record.format !== 'cmir') return;
  if (typeof record.handle !== 'string' || !record.handle) return;
  const host = getHost();
  if (!host.supportsInPlaceSave) return;
  try {
    const state = record.view.state;
    const threads = Array.from(getCommentsState(state).threads.values());
    const bytes = serializeNative(state.doc, threads.length ? { threads } : undefined);
    await host.saveExisting(record.handle, bytes);
    record.dirty = false;
    // Successful save → drop the journal. Mirrors the single-doc
    // post-save journal cleanup so a re-crash doesn't surface a
    // recovery offer for a doc that's already on disk.
    try {
      await host.deleteJournal(record.uid);
    } catch {
      /* best-effort */
    }
  } catch (err) {
    console.warn('Autosave (record) failed:', err);
  }
}

/** (Re-)arm the per-record autosave debounce. No-op when autosave
 *  is off for the record. Cheap to fire unconditionally; the
 *  inner check short-circuits before scheduling. */
function scheduleAutosaveForRecord(record: DocRecord): void {
  if (!record.autosaveEnabled) return;
  if (record.autosaveTimer !== null) window.clearTimeout(record.autosaveTimer);
  record.autosaveTimer = window.setTimeout(() => {
    record.autosaveTimer = null;
    void runAutosaveForRecord(record);
  }, AUTOSAVE_DELAY_MS);
}

/**
 * One loaded document inside a slot's stack. Owns a live EditorView
 * (so swapping back to this record in the stack restores selection /
 * scroll / history without a re-mount), the per-doc nav surface, and
 * the per-doc editor drag surface.
 */
interface DocRecord {
  uid: string;
  filename: string;
  /** Opaque host handle (Electron: absolute path; browser: a
   *  FileSystemFileHandle when one is available). `null` when the
   *  doc has never been saved or was opened in a context that
   *  doesn't expose handles. The Save command uses this to write
   *  silently in place; Save-As updates it. */
  handle: unknown | null;
  /** Which on-disk format this doc lives in. Driven by the
   *  filename extension on open / save. `null` for brand-new docs
   *  that haven't been saved yet (Save will fall through to Save-
   *  As, which prompts for a format). */
  format: 'cmir' | 'docx' | null;
  view: EditorView;
  /** Root element holding `view.dom`. Mounted into / detached from
   *  the slot's body when this record becomes / stops being visible. */
  editorEl: HTMLElement;
  navPanel: NavigationPanel;
  /** Root element holding `navPanel`'s output. Mounted into / detached
   *  from the slot's nav section when visibility changes. */
  navEl: HTMLElement;
  dragSurface: EditorDragSurface;
  /** Debounce handle for per-pane "heavy" work (nav re-render +
   *  word-count walk). Both are O(doc-size) operations that PM
   *  fires transactions for several times per keystroke (composite
   *  edits, selection sync, etc.). Single-doc debounces the same
   *  work via `scheduleHeavyUpdate`; we match its 200ms cadence so
   *  per-keystroke editing of a large doc stays responsive.
   *
   *  Also matters for the nav specifically: rebuilding the heading
   *  list replaces every `<li>` element, which would invalidate a
   *  dblclick in progress unless the rebuild waits for a typing
   *  pause. */
  heavyUpdateTimer: IdleHandle | null;
  /** Debounce timer for the crash-recovery journal write. Re-armed
   *  by every doc-changing transaction; fires `~3s` later with a
   *  cmir snapshot of this record's current doc. */
  journalTimer: number | null;
  /** Per-doc read-mode state. Multi-doc treats read mode as a
   *  property of an individual open doc — the ribbon toggle flips
   *  this for the focused pane only, leaving other panes untouched. */
  readMode: boolean;
  /** Per-doc autosave state. Same per-doc story as `readMode`: the
   *  ribbon toggle flips this for the focused pane only. When true
   *  AND the record is saved-as-.cmir, edits debounce into a
   *  per-record `saveExisting` call after `AUTOSAVE_DELAY_MS`. */
  autosaveEnabled: boolean;
  /** Debounce timer for the per-record autosave write. */
  autosaveTimer: number | null;
  /** True when this record has unsaved changes — set on any
   *  doc-changing transaction, cleared on a successful save
   *  (manual or autosave). Drives the per-pane close-confirm
   *  prompt: a clean pane closes without prompting. */
  dirty: boolean;
}

/**
 * Doc-switcher overlay — the Alt+Tab-style list that appears while
 * the user holds Ctrl+Tab in multi-pane mode. Lists every doc in
 * the focused slot's stack top-to-bottom (no thumbnails, just
 * filenames). Each Tab press while the overlay is open advances
 * the highlighted candidate; Ctrl release commits the highlight as
 * the slot's visible doc; Escape cancels without committing.
 *
 * Snapshots the slot's stack at `open` time so the candidate index
 * doesn't get scrambled if the slot's stack mutates during the
 * cycle (rare but defensive — autosave / async file ops can land
 * in the middle of a Ctrl-hold).
 */
class DocSwitcherOverlay {
  private overlayEl: HTMLElement;
  private listEl: HTMLElement;
  /** Active slot at open() time. Stays bound for the cycle. */
  private slot: Slot | null = null;
  /** Snapshot of the slot's stack at open time, in display order. */
  private candidates: DocRecord[] = [];
  /** Index into `candidates` that's currently highlighted. */
  private index = 0;

  constructor() {
    this.overlayEl = document.createElement('div');
    this.overlayEl.className = 'pmd-doc-switcher';
    this.overlayEl.hidden = true;
    this.listEl = document.createElement('ol');
    this.listEl.className = 'pmd-doc-switcher-list';
    this.overlayEl.appendChild(this.listEl);
    document.body.appendChild(this.overlayEl);
  }

  isOpen(): boolean {
    return !this.overlayEl.hidden;
  }

  /** Open the overlay for the given slot, advancing the highlight
   *  by `direction` from the slot's current visible doc. Mirrors
   *  the OS Alt+Tab pattern where the first chord press already
   *  shows a candidate (typically the next doc, not the current
   *  one). The overlay positions itself centered over the slot's
   *  pane (not the whole viewport) so users can tell at a glance
   *  which slot they're cycling through. */
  open(slot: Slot, direction: 1 | -1): void {
    this.slot = slot;
    this.candidates = [...slot.stack];
    const start = slot.visibleIndex < 0 ? 0 : slot.visibleIndex;
    const len = this.candidates.length;
    this.index = (start + direction + len) % len;
    this.positionOverSlot(slot);
    this.render();
    this.overlayEl.hidden = false;
  }

  /** Place the overlay so its center matches the slot's pane
   *  center. Read live each open() so layout changes (window
   *  resize, expand-mode toggle, etc.) since the last cycle
   *  don't strand the overlay over the wrong region. */
  private positionOverSlot(slot: Slot): void {
    const rect = slot.paneEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    this.overlayEl.style.left = `${Math.round(cx)}px`;
    this.overlayEl.style.top = `${Math.round(cy)}px`;
  }

  /** Step the highlight by `delta` (+1 or -1) with wrap-around. */
  advance(delta: 1 | -1): void {
    if (!this.isOpen()) return;
    const len = this.candidates.length;
    if (len < 2) return;
    this.index = (this.index + delta + len) % len;
    this.render();
  }

  /** Make the highlighted candidate the slot's visible doc, then
   *  close the overlay. Re-focuses the slot's view so typing
   *  resumes in the doc. */
  commit(): void {
    if (!this.isOpen() || !this.slot) {
      this.reset();
      return;
    }
    const target = this.candidates[this.index];
    if (target) {
      this.slot.showRecord(target);
      this.slot.visible?.view.focus();
    }
    this.reset();
  }

  /** Close the overlay without committing. */
  cancel(): void {
    if (!this.isOpen()) return;
    this.reset();
  }

  private reset(): void {
    this.overlayEl.hidden = true;
    this.slot = null;
    this.candidates = [];
    this.index = 0;
  }

  private render(): void {
    this.listEl.innerHTML = '';
    for (let i = 0; i < this.candidates.length; i++) {
      const rec = this.candidates[i]!;
      const item = document.createElement('li');
      item.className = 'pmd-doc-switcher-item';
      if (i === this.index) item.classList.add('pmd-doc-switcher-item-active');
      const name = document.createElement('span');
      name.className = 'pmd-doc-switcher-item-name';
      name.textContent = rec.filename || '(untitled)';
      item.appendChild(name);
      if (rec.dirty) {
        const mark = document.createElement('span');
        mark.className = 'pmd-doc-switcher-item-dirty';
        mark.textContent = '●';
        mark.title = 'Unsaved changes';
        item.appendChild(mark);
      }
      this.listEl.appendChild(item);
    }
  }
}

class Slot {
  readonly id: SlotId;
  /** Top-level pane element (chip + editor + footer). Hidden when
   *  the stack is empty. */
  readonly paneEl: HTMLElement;
  /** Title chip text container. */
  private chipNameEl: HTMLElement;
  /** Title chip stack dropdown trigger (shown when stack has 2+). */
  private chipStackBtn: HTMLButtonElement;
  /** Title chip expand / restore toggle — fills this pane to the
   *  full editor + nav-rail surface while the others stay loaded
   *  but hidden, and back. */
  private chipExpandBtn: HTMLButtonElement;
  /** Title chip × close button. */
  private chipCloseBtn: HTMLButtonElement;
  /** Editor body — DocRecord.editorEl mounts here. */
  private bodyEl: HTMLElement;
  /** Footer word count. */
  private wcEl: HTMLElement;
  /** Nav section (in the multi-nav rail). Hidden when stack is empty. */
  readonly navSectionEl: HTMLElement;
  /** Nav body — DocRecord.navEl mounts here. */
  private navBodyEl: HTMLElement;
  /** Last width we wrote into `--pmd-card-intrinsic-width`. Skips
   *  no-op writes on repeated sync calls (e.g. multiple events
   *  firing in one frame for the same final width). */
  private lastIntrinsicWidth = -1;

  /** Live stack. Index 0 = bottom (least recently active);
   *  `visibleIndex` is the doc currently shown. */
  stack: DocRecord[] = [];
  visibleIndex = -1;

  /** Owning shell for routing focus / re-render events. */
  shell: MultiPaneShell;

  constructor(id: SlotId, shell: MultiPaneShell) {
    this.id = id;
    this.shell = shell;
    this.paneEl = document.createElement('div');
    this.paneEl.className = 'pmd-pane';
    this.paneEl.dataset['slot'] = id;
    this.paneEl.hidden = true;
    // Click anywhere in the pane → focus it (route shared ribbon /
    // chrome through this slot's visible doc).
    this.paneEl.addEventListener('mousedown', () => this.shell.focusSlot(this));

    // Title chip.
    const chip = document.createElement('div');
    chip.className = 'pmd-pane-chip';
    this.chipStackBtn = document.createElement('button');
    this.chipStackBtn.type = 'button';
    this.chipStackBtn.className = 'pmd-pane-chip-stack';
    this.chipStackBtn.title = 'Switch document in this slot';
    this.chipStackBtn.textContent = '▾';
    this.chipStackBtn.hidden = true;
    this.chipStackBtn.addEventListener('mousedown', (e) => e.preventDefault());
    this.chipStackBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openStackDropdown();
    });
    chip.appendChild(this.chipStackBtn);
    this.chipNameEl = document.createElement('span');
    this.chipNameEl.className = 'pmd-pane-chip-name';
    chip.appendChild(this.chipNameEl);
    // Slot-number badge — small fixed glyph immediately left of
    // the expand button. Helps users identify which slot they're
    // looking at when only some slots are occupied (a single doc
    // in slot 2 with slots 1 and 3 empty looks the same as a
    // single doc in slot 1, otherwise).
    const slotBadge = document.createElement('span');
    slotBadge.className = 'pmd-pane-chip-slot-num';
    slotBadge.textContent = id.replace('slot', '');
    slotBadge.title = `Slot ${id.replace('slot', '')}`;
    chip.appendChild(slotBadge);
    this.chipExpandBtn = document.createElement('button');
    this.chipExpandBtn.type = 'button';
    this.chipExpandBtn.className = 'pmd-pane-chip-expand';
    this.chipExpandBtn.title = 'Expand this pane to fill the workspace (Ctrl+Shift+F)';
    this.chipExpandBtn.textContent = '⛶';
    this.chipExpandBtn.setAttribute('aria-pressed', 'false');
    this.chipExpandBtn.addEventListener('mousedown', (e) => e.preventDefault());
    this.chipExpandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.shell.toggleExpanded(this);
    });
    chip.appendChild(this.chipExpandBtn);
    this.chipCloseBtn = document.createElement('button');
    this.chipCloseBtn.type = 'button';
    this.chipCloseBtn.className = 'pmd-pane-chip-close';
    this.chipCloseBtn.title = 'Close this document';
    this.chipCloseBtn.textContent = '×';
    this.chipCloseBtn.addEventListener('mousedown', (e) => e.preventDefault());
    this.chipCloseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.closeVisible();
    });
    chip.appendChild(this.chipCloseBtn);
    this.paneEl.appendChild(chip);

    // Editor body container.
    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'pmd-pane-body';
    this.paneEl.appendChild(this.bodyEl);

    // Footer (word count + open file button).
    const footer = document.createElement('div');
    footer.className = 'pmd-pane-footer';
    this.wcEl = document.createElement('span');
    this.wcEl.className = 'pmd-pane-wc';
    this.wcEl.textContent = '—';
    footer.appendChild(this.wcEl);
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'pmd-pane-open';
    openBtn.title = 'Open a file into this slot';
    openBtn.textContent = '+ Open file';
    openBtn.addEventListener('mousedown', (e) => e.preventDefault());
    openBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.shell.openFileIntoSlot(this.id);
    });
    footer.appendChild(openBtn);
    this.paneEl.appendChild(footer);

    // Nav section (lives in the multi-nav rail at left of window).
    this.navSectionEl = document.createElement('section');
    this.navSectionEl.className = 'pmd-multi-nav-section';
    this.navSectionEl.dataset['slot'] = id;
    this.navSectionEl.hidden = true;
    // Clicking anywhere in the nav section focuses this slot —
    // same affordance as clicking the pane itself. Without this,
    // clicking a heading would scroll the doc into view but the
    // chrome (font-size chip, read-mode button, etc.) would
    // continue routing through whatever pane was previously
    // focused, which feels broken when the user is navigating
    // via the nav pane.
    this.navSectionEl.addEventListener('mousedown', () => this.shell.focusSlot(this));
    this.navBodyEl = document.createElement('div');
    this.navBodyEl.className = 'pmd-multi-nav-body';
    this.navSectionEl.appendChild(this.navBodyEl);
  }

  /** Sync the chip's expand button to the shell's current expand
   *  state. Driven by `MultiPaneShell.applyExpandedState`. */
  setExpandButtonPressed(pressed: boolean): void {
    this.chipExpandBtn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    this.chipExpandBtn.title = pressed
      ? 'Restore the multi-pane layout'
      : 'Expand this pane to fill the workspace';
  }

  /** Read the visible ProseMirror element's content-area width and
   *  write it into `--pmd-card-intrinsic-width` on the pane root.
   *  Cards inside use this variable as the fallback for
   *  `contain-intrinsic-width` (paired with the `auto` keyword) so
   *  off-screen-never-rendered cards in a narrow multi-pane slot
   *  size close to the real card width rather than a fixed 600px.
   *
   *  Measuring the PM root (not `bodyEl`) is deliberate — bodyEl's
   *  `offsetWidth` includes scrollbar gutter AND doesn't subtract
   *  the editor's inner padding, so it overshoots a card's actual
   *  width by enough to be visible at the doc edge. PM root's
   *  `clientWidth` is scrollbar-independent and we subtract its
   *  computed padding to land exactly on the content box where
   *  cards lay out.
   *
   *  Called explicitly on (a) push, (b) shell window resize, (c)
   *  layout-mode change, (d) active-count change. Deliberately NOT
   *  driven by ResizeObserver — the variable write triggers a
   *  layout pass on every card, and ResizeObserver-driven updates
   *  produced a hard feedback loop where the pane body's measured
   *  width kept growing each iteration after the user clicked into
   *  the editor. Explicit triggers can't re-fire from our own
   *  mutations. */
  syncCardIntrinsicWidth(): void {
    if (this.paneEl.hidden) return;
    const rec = this.visible;
    if (!rec) return;
    const pmEl = rec.view.dom as HTMLElement;
    const cs = getComputedStyle(pmEl);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    const width = Math.round(pmEl.clientWidth - padL - padR);
    if (width <= 0) return;
    if (width === this.lastIntrinsicWidth) return;
    this.lastIntrinsicWidth = width;
    this.paneEl.style.setProperty('--pmd-card-intrinsic-width', `${width}px`);
  }

  /** Public read access to the editor-body element — the shell
   *  uses this to attach a scroll-sync listener for the
   *  comments-column relayout. Stays a private field structurally;
   *  this getter is the only sanctioned read path. */
  get bodyElement(): HTMLElement {
    return this.bodyEl;
  }

  /** The currently-visible doc record (or null when stack is empty). */
  get visible(): DocRecord | null {
    if (this.visibleIndex < 0 || this.visibleIndex >= this.stack.length) return null;
    return this.stack[this.visibleIndex]!;
  }

  /** Adopt a freshly-built DocRecord into this slot's stack. New doc
   *  becomes the visible one; previously-visible (if any) drops into
   *  the stack but its EditorView stays live (memory-resident). */
  push(record: DocRecord): void {
    // Detach the OLD visible record first — `detachVisible` reads
    // `this.visible`, which derives from `visibleIndex`, so it has
    // to run before we push the new record and shift the index.
    // Without this the old record's `editorEl` stayed in `bodyEl`
    // and `mountVisible` below appended the new one alongside it,
    // so both docs rendered on top of each other until the stack
    // switcher forced a re-mount.
    this.detachVisible();
    this.stack.push(record);
    this.visibleIndex = this.stack.length - 1;
    this.mountVisible();
    // Visibility is owned by the shell: when expand mode is active,
    // a newly-populated non-expanded slot stays hidden until the
    // user restores the multi-pane layout. The shell's
    // notifySlotPopulated does the right thing either way.
    this.shell.notifySlotPopulated(this);
    this.shell.focusSlot(this);
  }

  /** Switch the visible doc to the given record. */
  showRecord(record: DocRecord): void {
    const idx = this.stack.indexOf(record);
    if (idx < 0) return;
    if (idx === this.visibleIndex) return;
    this.detachVisible();
    this.visibleIndex = idx;
    this.mountVisible();
    this.shell.focusSlot(this);
  }

  /** Cycle the visible doc within this slot's stack by `delta`
   *  (+1 = next, -1 = previous, wraps around at the ends). No-op
   *  when the stack has 0 or 1 docs. Used by Ctrl+Tab / Ctrl+Shift-
   *  Tab in the focused slot. Routes through `showRecord` so the
   *  shared chrome / focus dance fires the same way as a click on
   *  the stack-dropdown menu would. */
  cycleVisible(delta: 1 | -1): void {
    if (this.stack.length < 2) return;
    if (this.visibleIndex < 0) return;
    const len = this.stack.length;
    const next = (this.visibleIndex + delta + len) % len;
    this.showRecord(this.stack[next]!);
  }

  /** Detach the visible record from this slot WITHOUT destroying
   *  its view — used by send-to-slot to hand the record to another
   *  slot. Mirrors `closeVisible` minus the destroy / journal-drop
   *  steps (the doc keeps living; only its host slot changes).
   *  Returns the released record, or null if nothing was visible. */
  releaseVisible(): DocRecord | null {
    const idx = this.visibleIndex;
    if (idx < 0) return null;
    const record = this.stack[idx]!;
    this.detachVisible();
    this.stack.splice(idx, 1);
    if (this.stack.length === 0) {
      this.visibleIndex = -1;
      this.paneEl.hidden = true;
      this.navSectionEl.hidden = true;
      this.shell.notifySlotEmptied(this);
      this.shell.refreshLayout();
      this.shell.handleSlotEmptied(this);
      return record;
    }
    this.visibleIndex = Math.min(idx, this.stack.length - 1);
    this.mountVisible();
    return record;
  }

  /** Close the currently-visible doc. Reveals the next stack member
   *  (or empties the slot). Prompts for save / discard / cancel if
   *  the doc has unsaved changes; clean docs close immediately. */
  async closeVisible(): Promise<void> {
    const idx = this.visibleIndex;
    if (idx < 0) return;
    const closing = this.stack[idx]!;
    if (closing.dirty) {
      // Focus this pane so the save commands (which route via
      // `activeFile()`) target THIS doc, not whichever pane
      // happened to be focused before the user clicked X.
      this.shell.focusSlot(this);
      const choice = await confirmCloseUnsaved();
      if (choice === 'cancel') return;
      if (choice === 'save') {
        const ok = await runSaveFlow();
        if (!ok) return;
      } else if (choice === 'saveAs') {
        const ok = await runSaveAsFlow();
        if (!ok) return;
      }
      // discard: fall through; existing journal-clear path runs.
    }
    this.detachVisible();
    if (closing.heavyUpdateTimer !== null) {
      cancelIdle(closing.heavyUpdateTimer);
      closing.heavyUpdateTimer = null;
    }
    if (closing.journalTimer !== null) {
      window.clearTimeout(closing.journalTimer);
      closing.journalTimer = null;
    }
    if (closing.autosaveTimer !== null) {
      window.clearTimeout(closing.autosaveTimer);
      closing.autosaveTimer = null;
    }
    // Explicit close → drop the journal. Recovery is for crashes,
    // not "I changed my mind." If the user wanted to keep this
    // doc, they should have saved.
    void clearJournalForRecord(closing);
    // Clear speech-doc designation if the closing doc was it —
    // matches Verbatim's `AutoClose` which clears
    // `Globals.ActiveSpeechDoc` when the speech doc is closed.
    const speechResolver = getSpeechDocResolver();
    if (speechResolver.isSpeechByUid(closing.uid)) {
      speechResolver.setSpeechByUid(null);
    }
    speechResolver.unregisterView(closing.uid);
    // Release the cross-window path claim before destroying the
    // view — re-opening this file in any window should succeed.
    syncDocPathClaim(closing.handle, null);
    closing.view.destroy();
    closing.dragSurface.detach();
    this.stack.splice(idx, 1);
    if (this.stack.length === 0) {
      this.visibleIndex = -1;
      this.paneEl.hidden = true;
      this.navSectionEl.hidden = true;
      // If this empty slot was the expanded one, exit expand mode —
      // no doc to expand any more.
      this.shell.notifySlotEmptied(this);
      this.shell.refreshLayout();
      // If this slot was focused, hand focus to the next active slot.
      this.shell.handleSlotEmptied(this);
      return;
    }
    // Show the next-newest doc (the one that was second-from-top).
    this.visibleIndex = Math.min(idx, this.stack.length - 1);
    this.mountVisible();
    this.shell.focusSlot(this);
  }

  /** Detach the currently-mounted record's DOM (without destroying
   *  its view — the view stays live for fast swap-back). */
  private detachVisible(): void {
    const rec = this.visible;
    if (!rec) return;
    if (rec.editorEl.parentElement === this.bodyEl) {
      this.bodyEl.removeChild(rec.editorEl);
    }
    if (rec.navEl.parentElement === this.navBodyEl) {
      this.navBodyEl.removeChild(rec.navEl);
    }
    // Closing the last doc in a slot needs to drop that filename
    // out of the all-slots OS window title. mountVisible refreshes
    // when a new doc replaces the old one, but detachVisible
    // covers the close-with-no-replacement case.
    refreshWindowTitle();
  }

  /** Mount the currently-visible record's editor + nav DOM into the
   *  slot's body / nav section. Updates the chip + word count. */
  private mountVisible(): void {
    const rec = this.visible;
    if (!rec) return;
    this.bodyEl.appendChild(rec.editorEl);
    this.navBodyEl.appendChild(rec.navEl);
    this.chipNameEl.textContent = rec.filename;
    this.refreshChip();
    this.refreshWordCount();
    // Speech-chip class lives on the pane element and reflects
    // the currently-visible record vs the speech-doc registry;
    // swapping records via the stack switcher needs to refresh.
    this.shell.refreshSpeechChips();
    // The OS window title summarizes every open slot's filename in
    // multi-pane mode — refresh it on every mount so opening a new
    // doc in a non-focused slot still updates the title bar.
    refreshWindowTitle();
  }

  /** Update the chip's stack-dropdown trigger visibility based on
   *  current stack depth. */
  refreshChip(): void {
    const multi = this.stack.length > 1;
    this.chipStackBtn.hidden = !multi;
    this.chipStackBtn.textContent = multi ? `▾ ${this.stack.length}` : '▾';
  }

  /** Re-render the chip's filename label from the visible record.
   *  Called after Save-As updates `record.filename` so the chip
   *  reflects the user's chosen name. */
  refreshChipFilename(): void {
    const rec = this.visible;
    if (!rec) return;
    this.chipNameEl.textContent = rec.filename;
  }

  /** Recompute and display the visible doc's word count + read times
   *  for the first two configured readers. */
  refreshWordCount(): void {
    const rec = this.visible;
    if (!rec) {
      this.wcEl.textContent = '—';
      return;
    }
    const sel = rec.view.state.selection;
    const hasSel = !sel.empty;
    const words = hasSel
      ? countReadAloudWords(rec.view.state.doc, sel.from, sel.to)
      : countReadAloudWords(rec.view.state.doc);
    const readers = settings.get('readers').slice(0, 2);
    const head = hasSel
      ? `Sel: ${formatNumber(words)}`
      : formatNumber(words);
    const parts = [head];
    for (const r of readers) {
      parts.push(`${r.name}: ${formatReadTime(words, r.wpm)}`);
    }
    this.wcEl.textContent = parts.join(' · ');
  }

  /** Open a small dropdown over the chip listing every doc in this
   *  slot's stack. Each entry switches the visible doc; each carries
   *  a × icon that closes that entry. */
  private openStackDropdown(): void {
    closeOpenStackDropdown();
    const dropdown = document.createElement('div');
    dropdown.className = 'pmd-pane-chip-dropdown';
    for (const rec of this.stack) {
      const row = document.createElement('div');
      row.className = 'pmd-pane-chip-dropdown-row';
      if (rec === this.visible) row.classList.add('pmd-active');
      const name = document.createElement('span');
      name.className = 'pmd-pane-chip-dropdown-name';
      name.textContent = rec.filename;
      name.addEventListener('click', () => {
        closeOpenStackDropdown();
        this.showRecord(rec);
      });
      row.appendChild(name);
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'pmd-pane-chip-dropdown-close';
      close.textContent = '×';
      close.title = 'Close this document';
      close.addEventListener('mousedown', (e) => e.preventDefault());
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        closeOpenStackDropdown();
        void this.closeRecord(rec);
      });
      row.appendChild(close);
      dropdown.appendChild(row);
    }
    document.body.appendChild(dropdown);
    const rect = this.chipStackBtn.getBoundingClientRect();
    dropdown.style.position = 'absolute';
    dropdown.style.top = `${rect.bottom + window.scrollY + 2}px`;
    dropdown.style.left = `${rect.left + window.scrollX}px`;
    openStackDropdownEl = dropdown;
    const onDoc = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && dropdown.contains(t)) return;
      closeOpenStackDropdown();
      document.removeEventListener('pointerdown', onDoc);
    };
    setTimeout(() => document.addEventListener('pointerdown', onDoc), 0);
  }

  /** Close a specific record (not necessarily the visible one).
   *  Prompts if the record has unsaved changes. */
  async closeRecord(rec: DocRecord): Promise<void> {
    const idx = this.stack.indexOf(rec);
    if (idx < 0) return;
    if (idx === this.visibleIndex) {
      await this.closeVisible();
      return;
    }
    if (rec.dirty) {
      // Surface the doc so the user can see what they're being
      // asked about, AND so save commands route to it.
      this.showRecord(rec);
      this.shell.focusSlot(this);
      await this.closeVisible();
      return;
    }
    if (rec.heavyUpdateTimer !== null) {
      cancelIdle(rec.heavyUpdateTimer);
      rec.heavyUpdateTimer = null;
    }
    if (rec.autosaveTimer !== null) {
      window.clearTimeout(rec.autosaveTimer);
      rec.autosaveTimer = null;
    }
    // Clear speech-doc designation if the closing record was it.
    const speechResolver = getSpeechDocResolver();
    if (speechResolver.isSpeechByUid(rec.uid)) {
      speechResolver.setSpeechByUid(null);
    }
    speechResolver.unregisterView(rec.uid);
    syncDocPathClaim(rec.handle, null);
    rec.view.destroy();
    rec.dragSurface.detach();
    this.stack.splice(idx, 1);
    if (idx < this.visibleIndex) this.visibleIndex--;
    this.refreshChip();
  }
}

let openStackDropdownEl: HTMLElement | null = null;
function closeOpenStackDropdown(): void {
  if (!openStackDropdownEl) return;
  openStackDropdownEl.remove();
  openStackDropdownEl = null;
}

class MultiPaneShell {
  private slots: Record<SlotId, Slot>;
  private shellEl: HTMLElement;
  private navRailEl: HTMLElement;
  private rowEl: HTMLElement;
  private focusedSlot: Slot | null = null;
  /** Active scroll listener for the comments-column relayout —
   *  bound to the focused pane's `.pmd-pane-body`. Single
   *  outstanding listener; focus changes tear down the old one
   *  before installing the new. Null when no pane is focused. */
  private focusedScrollSync: {
    body: HTMLElement;
    handler: () => void;
    rafId: number | null;
  } | null = null;
  private layoutMode: 'compact' | 'wide';
  /** When non-null, the named slot is "expanded" — visible on its
   *  own with every other pane + nav-section hidden, regardless of
   *  whether those slots have docs loaded. Click the chip's expand
   *  button again to restore the normal multi-pane layout. */
  private expandedSlot: Slot | null = null;
  private unsubscribeSettings: (() => void) | null = null;
  /** Doc-switcher overlay — the Alt+Tab-style list that opens
   *  when the user presses Ctrl+Tab while the focused slot has
   *  2+ docs. Created lazily in the constructor below. */
  private docSwitcher!: DocSwitcherOverlay;

  constructor() {
    this.layoutMode = settings.get('multiDocLayoutMode');
    // Build the shell DOM and mount it into #app, alongside the
    // (now-hidden) single-doc surfaces.
    const app = document.getElementById('app')!;
    this.shellEl = document.createElement('div');
    this.shellEl.id = 'multi-pane-shell';
    this.shellEl.className = 'pmd-multi-shell';
    this.shellEl.dataset['layout'] = this.layoutMode;
    app.appendChild(this.shellEl);

    // Nav rail sits at the window's left edge, OUTSIDE the existing
    // #nav-panel (which is hidden in multi-doc mode). Use absolute
    // positioning via CSS to align it with the window edge.
    this.navRailEl = document.createElement('aside');
    this.navRailEl.className = 'pmd-multi-nav';
    document.body.appendChild(this.navRailEl);

    // Pane row (the three editor panes).
    this.rowEl = document.createElement('div');
    this.rowEl.className = 'pmd-multi-row';
    this.rowEl.dataset['layout'] = this.layoutMode;
    this.shellEl.appendChild(this.rowEl);

    // Adopt the shared `#comments-column` as a sibling of the
    // multi-row so the multi-shell becomes
    // `[panes-row | comments-column]`. Visually the column reads
    // like a narrow fourth slot that shrinks the three doc panes
    // equally. Its visibility follows the same `commentsVisible`
    // setting as single-pane (it's hidden via the `hidden` attr
    // when the user toggles it off). Cards re-layout against the
    // focused pane's scroll via `attachFocusedScrollSync`, since
    // the column doesn't share a scroll container with any pane.
    const commentsEl = getCommentsColumnEl();
    if (commentsEl) {
      this.shellEl.appendChild(commentsEl);
      commentsEl.hidden = !settings.get('commentsVisible');
    }

    this.slots = {
      slot1: new Slot('slot1', this),
      slot2: new Slot('slot2', this),
      slot3: new Slot('slot3', this),
    };
    for (const id of SLOT_IDS) {
      this.rowEl.appendChild(this.slots[id].paneEl);
      this.navRailEl.appendChild(this.slots[id].navSectionEl);
    }

    this.unsubscribeSettings = settings.subscribe((s) => {
      if (s.multiDocLayoutMode !== this.layoutMode) {
        this.layoutMode = s.multiDocLayoutMode;
        this.shellEl.dataset['layout'] = this.layoutMode;
        this.rowEl.dataset['layout'] = this.layoutMode;
        // Layout mode swap → pane widths change → re-sync card
        // intrinsic widths so skipped cards aren't sized for the
        // OLD layout's pane width.
        this.scheduleSyncAllCardIntrinsicWidths();
      }
      // Pane word counts depend on reader settings.
      for (const id of SLOT_IDS) this.slots[id].refreshWordCount();
      // Editor spellcheck toggle — apply to every record's view in
      // every slot's stack, including hidden stack members (their
      // editorEl is detached but the attribute still sticks for
      // when they swap into view).
      const spellcheck = s.editorSpellcheck ? 'true' : 'false';
      for (const id of SLOT_IDS) {
        for (const rec of this.slots[id].stack) {
          rec.view.dom.setAttribute('spellcheck', spellcheck);
        }
      }
      // Read-mode is per-pane in multi-doc — flipped via the
      // ribbon command's `toggleReadMode` hook below — so we
      // deliberately ignore changes to the global
      // `settings.readMode` here. Otherwise toggling read mode in
      // one pane would force every other open doc into the same
      // state.
      // The `pmd-rm-no-emphasis-borders` flag IS settings-driven
      // (it's a display preference, not per-doc), so when it
      // changes we re-stamp the class on every currently-read-
      // mode'd pane to match.
      const hideEmphasisBorders = s.hideEmphasisBordersInReadMode;
      for (const id of SLOT_IDS) {
        for (const rec of this.slots[id].stack) {
          if (rec.readMode) {
            rec.editorEl.classList.toggle(
              'pmd-rm-no-emphasis-borders',
              hideEmphasisBorders,
            );
          }
        }
      }
      // Nav drag changes available pane width — re-sync.
      this.scheduleSyncAllCardIntrinsicWidths();
    });

    // Tell the single-doc index.ts how to query "what should the
    // read-mode button show?" — in multi-doc that's the focused
    // pane's per-doc state, not the global setting.
    setReadModeStateResolver(() => this.focusedSlot?.visible?.readMode ?? false);
    // Same story for the autosave button — per-pane in multi-doc.
    setAutosaveStateResolver(() => this.focusedSlot?.visible?.autosaveEnabled ?? false);
    // Find-bar nav highlights land on the focused pane's own nav
    // panel; other panes don't share the find-bar's state.
    setActiveNavPanelResolver(() => this.focusedSlot?.visible?.navPanel ?? null);

    // Keep the speech chip / button state in sync with the
    // registry — the registry fires on every set/clear, including
    // ones the shell itself initiated.
    getSpeechDocResolver().subscribe(() => this.refreshSpeechChips());

    // Window resize is the other event that legitimately changes
    // pane widths. Deliberately NOT a ResizeObserver — see the doc
    // comment on Slot.syncCardIntrinsicWidth for why.
    window.addEventListener('resize', this.onWindowResize);

    // Build the doc-switcher overlay element (Alt+Tab-style list)
    // and stash a reference. The overlay is hidden until
    // `onDocCycleKey` opens it, then survives across Ctrl-Tab
    // chord presses for the duration of the user's Ctrl hold.
    this.docSwitcher = new DocSwitcherOverlay();

    // Mod-Tab / Mod-Shift-Tab cycle the visible doc within the
    // focused slot via the doc-switcher overlay (Alt+Tab-style
    // hold-and-press). Listener stays on `window` instead of
    // going through the ribbon-keymap path the other multi-pane
    // shortcuts use, because the overlay needs to track the
    // modifier hold and respond on keyup — which the discrete
    // single-press ribbon path cant model. The other multi-pane
    // shortcuts (slot focus, send-to-slot, expand toggle, smart
    // close) all go through the ribbon registry and are
    // user-rebindable in Settings → Keybindings.
    window.addEventListener("keydown", this.onDocCycleKey);
    window.addEventListener("keyup", this.onDocCycleKeyUp);

    // Drag-hover focus + post-drop collapse:
    //
    //   - On 'move': the controller's hoverTarget tells us which
    //     view the drop will land in. When the user hovers over
    //     a pane (even before releasing), focus that pane so the
    //     ribbon / chrome retarget. Stash the source/target views
    //     too so we can detect cross-view drops on 'end'.
    //   - On 'end': if this was a cross-view drop, apply the
    //     destination pane's outline-level filter to the freshly-
    //     dropped headings (which got fresh IDs via
    //     rewriteHeadingIds). Existing user expansions stay.
    let lastSourceView: EditorView | null = null;
    let lastTargetView: EditorView | null = null;
    dragController.subscribe((event) => {
      if (event === 'begin') {
        const session = dragController.getSession();
        lastSourceView = session?.view ?? null;
        lastTargetView = null;
      } else if (event === 'move') {
        const target = dragController.getHoverTarget();
        if (target) {
          lastTargetView = target.view;
          const slot = this.findSlotByView(target.view);
          if (slot && this.focusedSlot !== slot) this.focusSlot(slot);
        }
      } else if (event === 'end') {
        if (
          lastSourceView &&
          lastTargetView &&
          lastSourceView !== lastTargetView
        ) {
          const targetSlot = this.findSlotByView(lastTargetView);
          if (targetSlot?.visible) {
            // Flush the pane's debounced nav update so this runs
            // against the post-drop doc and the new IDs are visible.
            const rec = targetSlot.visible;
            if (rec.heavyUpdateTimer !== null) {
              cancelIdle(rec.heavyUpdateTimer);
              rec.heavyUpdateTimer = null;
            }
            rec.navPanel.applyMaxLevelToNewHeadings();
          }
        }
        lastSourceView = null;
        lastTargetView = null;
      }
    });

    // First active slot gets focus by default once a doc lands.
  }

  private findSlotByView(view: EditorView): Slot | null {
    for (const id of SLOT_IDS) {
      if (this.slots[id].visible?.view === view) return this.slots[id];
    }
    return null;
  }

  /** Walk every slot's stack — visible AND background — to find
   *  the record that owns the given view. Used by send-to-speech
   *  so it can re-mount the speech record in its slot if a
   *  different record from the same stack is currently visible
   *  (otherwise the dispatch lands in a detached editor, focus
   *  doesn't transfer, and Ctrl-Z reaches the source pane's
   *  empty history instead of the speech doc's). */
  private findRecordForView(view: EditorView): { slot: Slot; record: DocRecord } | null {
    for (const id of SLOT_IDS) {
      const slot = this.slots[id];
      for (const rec of slot.stack) {
        if (rec.view === view) return { slot, record: rec };
      }
    }
    return null;
  }

  /** Refresh the data-attribute count on the row, used by CSS to
   *  size each pane based on how many slots are active. */
  refreshLayout(): void {
    // When a slot is expanded, the layout collapses to "one active
    // pane" regardless of how many other slots have docs loaded —
    // those panes are hidden but kept around so the user can pop
    // back to the normal layout with the same docs intact.
    const active = this.expandedSlot
      ? 1
      : SLOT_IDS.filter((id) => this.slots[id].stack.length > 0).length;
    this.rowEl.dataset['active'] = String(active);
    this.navRailEl.dataset['active'] = String(active);
    // Active-count change → pane widths change → re-sync.
    this.scheduleSyncAllCardIntrinsicWidths();
  }

  /** Toggle expand mode on `slot`. If the same slot is already
   *  expanded, this restores the normal layout. If a different slot
   *  is expanded, the expansion moves to the new slot. */
  toggleExpanded(slot: Slot): void {
    if (this.expandedSlot === slot) this.setExpandedSlot(null);
    else this.setExpandedSlot(slot);
  }

  /** Set (or clear) the expanded slot and re-apply hidden states
   *  and CSS hooks on every pane + nav section. */
  private setExpandedSlot(slot: Slot | null): void {
    // A slot with an empty stack has nothing to show — refuse the
    // request rather than expanding to a blank pane.
    if (slot && slot.stack.length === 0) return;
    this.expandedSlot = slot;
    this.applyExpandedState();
  }

  /** Reconcile per-slot pane / nav-section visibility with the
   *  current expand state. When `expandedSlot` is set, only that
   *  slot's pane + nav section are shown; otherwise visibility
   *  reverts to "has a doc loaded → shown". Also keeps every
   *  chip's expand-button aria-pressed flag in sync, and writes a
   *  `data-expanded` attribute on the row + nav rail so CSS can
   *  hook on it. Refreshes the layout count afterwards. */
  private applyExpandedState(): void {
    const expanded = this.expandedSlot;
    for (const id of SLOT_IDS) {
      const slot = this.slots[id];
      const show = expanded
        ? slot === expanded
        : slot.stack.length > 0;
      slot.paneEl.hidden = !show;
      slot.navSectionEl.hidden = !show;
      slot.setExpandButtonPressed(slot === expanded);
    }
    if (expanded) {
      this.rowEl.dataset['expanded'] = expanded.id;
      this.navRailEl.dataset['expanded'] = expanded.id;
    } else {
      delete this.rowEl.dataset['expanded'];
      delete this.navRailEl.dataset['expanded'];
    }
    this.refreshLayout();
    if (expanded) this.focusSlot(expanded);
  }

  /** Pending rAF id for the next card-intrinsic-width batch. */
  private syncIntrinsicRaf: number | null = null;

  /** Coalesce multiple sync triggers landing in the same tick into a
   *  single rAF read, so we measure once after layout settles rather
   *  than mid-flight. The cache check inside `syncCardIntrinsicWidth`
   *  is doing the no-op short-circuit; this just avoids stacking
   *  redundant rAFs. */
  scheduleSyncAllCardIntrinsicWidths(): void {
    if (this.syncIntrinsicRaf !== null) return;
    this.syncIntrinsicRaf = requestAnimationFrame(() => {
      this.syncIntrinsicRaf = null;
      for (const id of SLOT_IDS) this.slots[id].syncCardIntrinsicWidth();
    });
  }

  private onWindowResize = (): void => {
    this.scheduleSyncAllCardIntrinsicWidths();
  };

  /** Ctrl-Tab / Ctrl-Shift-Tab → open the doc-switcher overlay for
   *  the focused slot. While Ctrl is held, each Tab advances the
   *  highlighted candidate by one (Shift+Tab reverses); releasing
   *  Ctrl commits the highlighted doc as visible. Escape cancels
   *  without committing. Mirrors the Windows Alt+Tab interaction
   *  pattern.
   *
   *  Also accepts Ctrl-Alt-Tab as a fallback for the web edition
   *  (where the browser reserves plain Ctrl-Tab for tab cycling
   *  and the renderer never sees the keydown). Electron windows
   *  have no tabs to cycle, so plain Ctrl-Tab passes through to
   *  the renderer — both bindings work on desktop. */
  private onDocCycleKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented) return;
    if (e.key !== 'Tab') return;
    const hasMod = e.ctrlKey || e.metaKey;
    if (!hasMod) return;
    const slot = this.focusedSlot;
    if (!slot || slot.stack.length < 2) return;
    e.preventDefault();
    const direction = e.shiftKey ? -1 : 1;
    if (this.docSwitcher.isOpen()) {
      this.docSwitcher.advance(direction);
    } else {
      this.docSwitcher.open(slot, direction);
    }
  };

  /** Companion to `onDocCycleKey` — when Ctrl (or Meta) is released
   *  while the doc-switcher overlay is open, commit the highlighted
   *  candidate (= make it the slot's visible doc) and close the
   *  overlay. We listen on `keyup` for `Control` / `Meta` so the
   *  commit fires the instant the user releases the modifier,
   *  matching the OS Alt+Tab feel. */
  private onDocCycleKeyUp = (e: KeyboardEvent): void => {
    if (!this.docSwitcher.isOpen()) return;
    if (e.key === 'Control' || e.key === 'Meta') {
      e.preventDefault();
      this.docSwitcher.commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.docSwitcher.cancel();
    }
  };

  /** Focus the slot at `idx` (0/1/2). Used by the `focusSlotN`
   *  ribbon commands. If a slot is currently expanded, this moves
   *  the expansion to the target (matching the legacy window
   *  listener's behavior). */
  focusSlotByIndex(idx: 0 | 1 | 2): void {
    const slot = this.slots[SLOT_IDS[idx]!];
    if (slot.stack.length === 0) return;
    if (this.expandedSlot && this.expandedSlot !== slot) {
      this.setExpandedSlot(slot);
    } else {
      this.focusSlot(slot);
    }
    slot.visible?.view.focus();
  }

  /** Send the focused slot's visible doc to the slot at `idx`
   *  (0/1/2). Used by the `sendDocToSlotN` ribbon commands. */
  sendVisibleToSlotByIndex(idx: 0 | 1 | 2): void {
    const targetSlot = this.slots[SLOT_IDS[idx]!];
    if (!this.focusedSlot || this.focusedSlot === targetSlot) return;
    const record = this.focusedSlot.releaseVisible();
    if (!record) return;
    targetSlot.push(record);
    targetSlot.visible?.view.focus();
  }

  /** Toggle expand-mode on the focused slot. Used by the
   *  `toggleSlotExpand` ribbon command. */
  toggleFocusedSlotExpand(): void {
    if (!this.focusedSlot) return;
    this.toggleExpanded(this.focusedSlot);
  }

  /** Smart-close gesture: if the focused slot has a visible doc,
   *  close it (prompting for unsaved-changes confirmation via
   *  the same `closeVisible` flow the chip-X button uses). Returns
   *  true to signal the caller that the gesture was consumed.
   *  Returns false when the focused slot is empty (or none is
   *  focused) — the caller should fall through to its
   *  window-close default. */
  async tryCloseFocusedVisible(): Promise<boolean> {
    const slot = this.focusedSlot;
    if (!slot || slot.visible === null) return false;
    await slot.closeVisible();
    return true;
  }

  /** Mark `slot` as focused. The shared ribbon / chrome will route
   *  through its visible doc's EditorView. In wide-scroll layout
   *  with three active panes, also scroll the focused pane into
   *  view IF it's not already fully visible — clicking the peeking
   *  third doc brings it into view, but clicking the middle (fully
   *  visible) doc leaves the scroll position alone. */
  focusSlot(slot: Slot): void {
    const wasSame = this.focusedSlot === slot && getActiveView() === slot.visible?.view;
    if (this.focusedSlot && this.focusedSlot !== slot) {
      this.focusedSlot.paneEl.classList.remove('pmd-pane-focused');
    }
    this.focusedSlot = slot;
    slot.paneEl.classList.add('pmd-pane-focused');
    if (!wasSame) {
      setActiveView(slot.visible?.view ?? null);
    }
    // The shared comments column lives at the shell-row level, not
    // inside any single pane — so re-render its cards against this
    // doc, and re-point the scroll listener so cards relayout as
    // the focused pane scrolls.
    commentsColumn?.render();
    this.attachFocusedScrollSync(slot);
    const activeCount = SLOT_IDS.filter((id) => this.slots[id].stack.length > 0).length;
    if (this.layoutMode === 'wide' && activeCount === 3) {
      // Compare the pane's box against the row's viewport. If any
      // part of the pane is clipped (off-screen), scroll it into
      // view. The `scroll-snap-type` on the row aligns the landing
      // position to a snap point; if the pane is already fully
      // inside the viewport (e.g., the middle pane), skip the
      // scroll so the user doesn't see an unwanted snap.
      const rowRect = this.rowEl.getBoundingClientRect();
      const paneRect = slot.paneEl.getBoundingClientRect();
      const fullyVisible =
        paneRect.left >= rowRect.left - 0.5 &&
        paneRect.right <= rowRect.right + 0.5;
      if (!fullyVisible) {
        // `behavior: 'auto'` overrides the row's
        // `scroll-behavior: smooth`. Smooth scroll would otherwise
        // get paused mid-animation by ProseMirror's own pointerdown
        // handling on the same tick (focus + cursor placement +
        // implicit focused-element scroll-into-view), which made
        // the user have to hold the mouse button down to see the
        // transition finish. Instant snap with `scroll-snap-type`
        // still keeps the landing position aligned.
        //
        // The rAF defer also helps — PM's handlers run on the
        // current tick; we run on the next so the scroll target
        // doesn't get clobbered before it takes effect.
        const target = slot.paneEl;
        requestAnimationFrame(() => {
          target.scrollIntoView({ inline: 'start', block: 'nearest', behavior: 'auto' });
        });
      }
    }
  }

  /** Re-point the focused-pane scroll listener at `slot`. The
   *  shared comments column sits OUTSIDE every pane's scroll
   *  container in multi-pane, so when the focused editor scrolls,
   *  cards have to reposition to keep aligned with their anchored
   *  ranges. rAF-throttled so a fast scroll doesn't queue
   *  redundant relayouts; old listener is detached before the
   *  new one attaches. */
  private attachFocusedScrollSync(slot: Slot): void {
    this.detachFocusedScrollSync();
    const column = commentsColumn;
    if (!column) return;
    const body = slot.bodyElement;
    const state: { rafId: number | null } = { rafId: null };
    const handler = (): void => {
      if (state.rafId !== null) return;
      state.rafId = requestAnimationFrame(() => {
        state.rafId = null;
        column.relayoutCards();
      });
    };
    body.addEventListener('scroll', handler, { passive: true });
    this.focusedScrollSync = { body, handler, rafId: state.rafId };
  }

  /** Detach the scroll-sync listener (e.g. when focus transitions
   *  to no pane). Idempotent — no-op when no listener is bound. */
  private detachFocusedScrollSync(): void {
    if (!this.focusedScrollSync) return;
    this.focusedScrollSync.body.removeEventListener(
      'scroll',
      this.focusedScrollSync.handler,
    );
    if (this.focusedScrollSync.rafId !== null) {
      cancelAnimationFrame(this.focusedScrollSync.rafId);
    }
    this.focusedScrollSync = null;
  }

  /** Flip the read-mode state of the focused pane's visible doc.
   *  Called by the ribbon's `toggleReadMode` command (the global
   *  command dispatches into the shell via `enableMultiDocMode`'s
   *  `toggleReadMode` hook). No-op if no pane is focused. */
  toggleFocusedReadMode(): void {
    const rec = this.focusedSlot?.visible;
    if (!rec) return;
    rec.readMode = !rec.readMode;
    applyReadModeToTarget(
      rec.editorEl,
      rec.view,
      rec.readMode,
      settings.get('hideEmphasisBordersInReadMode'),
    );
    // setActiveView is the path that drives `refreshReadModeBtn`,
    // so we route through it to keep the ribbon button in sync.
    setActiveView(rec.view);
  }

  /** Flip the autosave state of the focused pane's visible doc.
   *  Per-pane just like read mode — toggling on one pane leaves
   *  other open docs untouched. Routes through `setActiveView` so
   *  the ribbon's autosave button re-reads the resolver. */
  toggleFocusedAutosave(): void {
    const rec = this.focusedSlot?.visible;
    if (!rec) return;
    rec.autosaveEnabled = !rec.autosaveEnabled;
    if (!rec.autosaveEnabled && rec.autosaveTimer !== null) {
      window.clearTimeout(rec.autosaveTimer);
      rec.autosaveTimer = null;
    }
    setActiveView(rec.view);
  }

  /** Clear the focused pane's `dirty` flag. Called from single-doc
   *  save flows after a successful save so the per-pane close-X
   *  prompt knows the doc no longer has unsaved changes. */
  markFocusedSaved(): void {
    const rec = this.focusedSlot?.visible;
    if (!rec) return;
    rec.dirty = false;
  }

  /** The filename currently shown in the focused pane's chip, or
   *  null when no pane is focused. Used by Save-As to prefill
   *  with the active doc's name. */
  getFocusedFilename(): string | null {
    return this.focusedSlot?.visible?.filename ?? null;
  }

  /** Return the focused doc's filename + on-disk handle + format,
   *  for the Save / Save-As flow. Returns null when no pane is
   *  focused or the slot has no visible record. */
  getFocusedFile(): { filename: string; handle: unknown | null; format: DocFormat | null } | null {
    const rec = this.focusedSlot?.visible;
    if (!rec) return null;
    return { filename: rec.filename, handle: rec.handle, format: rec.format };
  }

  /** Filenames in every slot, in slot order. Empty slots map to
   *  `null` so callers can preserve positional context if they
   *  want (or filter the nulls out). Used by the OS window-title
   *  syncer to summarize the whole multi-pane workspace at once. */
  getAllFilenames(): (string | null)[] {
    return SLOT_IDS.map((id) => this.slots[id].visible?.filename ?? null);
  }

  /** Replace the focused pane's filename with `name` and refresh
   *  the chip. */
  setFocusedFilename(name: string): void {
    const slot = this.focusedSlot;
    if (!slot) return;
    const rec = slot.visible;
    if (!rec) return;
    rec.filename = name;
    slot.refreshChipFilename();
    pushPaneDocInfo(rec.uid, rec.filename);
  }

  /** Update the focused pane's filename + handle + format together —
   *  called from the editor's Save-As flow once the save commits.
   *  Keeps the chip label, the in-place-save handle, and the format
   *  in sync as the user renames or migrates formats. */
  setFocusedFile(file: { filename: string; handle: unknown | null; format: DocFormat | null }): void {
    const slot = this.focusedSlot;
    if (!slot) return;
    const rec = slot.visible;
    if (!rec) return;
    rec.filename = file.filename;
    // Save-As may have moved this doc to a new on-disk location;
    // re-sync the cross-window path claim so the new path is
    // owned by us and the old one is released.
    syncDocPathClaim(rec.handle, file.handle);
    rec.handle = file.handle;
    rec.format = file.format;
    slot.refreshChipFilename();
    pushPaneDocInfo(rec.uid, rec.filename);
  }

  /** Clear the journal entry for the focused pane's visible doc.
   *  Called from the editor's save flow after a successful save —
   *  the on-disk file is now the latest version, the journal is
   *  redundant. */
  async clearFocusedJournal(): Promise<void> {
    const rec = this.focusedSlot?.visible;
    if (!rec) return;
    await clearJournalForRecord(rec);
  }

  /** Journal every DocRecord across every slot's stack. Called by
   *  the mode-switch flow before reloading so the post-reload
   *  startup-recovery can rebuild the workspace in the new layout.
   *  Cancels each record's pending debounced timer first so the
   *  explicit write we're about to fire isn't shadowed by a
   *  redundant timer-driven write a few hundred ms later. */
  async journalAll(): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const id of SLOT_IDS) {
      for (const rec of this.slots[id].stack) {
        if (rec.journalTimer !== null) {
          window.clearTimeout(rec.journalTimer);
          rec.journalTimer = null;
        }
        tasks.push(runJournalForRecord(rec));
      }
    }
    await Promise.all(tasks);
  }

  /** Load a recovered doc into the workspace. Picks the first
   *  empty slot; if all three slots have docs already, stacks the
   *  recovered doc into the focused (or first) slot. Reuses the
   *  journal's uid so the recovered doc continues to crash-recover
   *  under the same slot. */
  async onRecoveredDoc(entry: {
    uid: string;
    filename: string;
    handle: string | null;
    format: DocFormat | null;
    doc: PMNode;
    threads: import('./comments-plugin.js').Thread[];
  }): Promise<void> {
    // Pick the first empty slot; otherwise fall back to the
    // currently-focused slot or slot1.
    let target: SlotId = 'slot1';
    for (const id of SLOT_IDS) {
      if (this.slots[id].stack.length === 0) {
        target = id;
        break;
      }
      if (id === SLOT_IDS[SLOT_IDS.length - 1]) {
        target = this.focusedSlot?.id ?? 'slot1';
      }
    }
    const slot = this.slots[target];
    const record = buildDocRecord(entry.filename, entry.doc, slot, {
      handle: entry.handle,
      format: entry.format,
      uid: entry.uid,
      threads: entry.threads,
    });
    // Recovery restores content that wasn't successfully saved on
    // the previous session, so the doc is dirty by definition.
    // Close-X prompts will fire until the user explicitly saves.
    record.dirty = true;
    slot.push(record);
  }

  /** A slot's stack just became empty. If it was the expanded
   *  slot, drop expand mode — no doc to expand any more. */
  notifySlotEmptied(slot: Slot): void {
    if (this.expandedSlot === slot) this.setExpandedSlot(null);
  }

  /** A slot's stack just got a fresh doc. If we're in expand mode
   *  and a *different* slot is expanded, keep this newcomer hidden
   *  for now (the user can pop back to multi-pane to see it). If
   *  the populated slot is the expanded one (or if expand mode is
   *  off), show it. */
  notifySlotPopulated(slot: Slot): void {
    if (this.expandedSlot && this.expandedSlot !== slot) {
      slot.paneEl.hidden = true;
      slot.navSectionEl.hidden = true;
    } else {
      slot.paneEl.hidden = false;
      slot.navSectionEl.hidden = false;
    }
    this.refreshLayout();
  }

  /** Handle a slot becoming empty — if it had focus, transfer to
   *  the next active slot (or clear focus). */
  handleSlotEmptied(slot: Slot): void {
    if (this.focusedSlot !== slot) return;
    this.focusedSlot = null;
    for (const id of SLOT_IDS) {
      if (this.slots[id].stack.length > 0) {
        this.focusSlot(this.slots[id]);
        return;
      }
    }
    setActiveView(null);
    // No focused doc left — tear down the scroll listener so the
    // closed pane's body doesn't keep ferrying events, and render
    // the column once more so it shows the no-view state (empty).
    this.detachFocusedScrollSync();
    commentsColumn?.render();
  }

  /** Ask the host for a file and load it straight into the named
   *  slot — no slot picker, since the user explicitly clicked that
   *  slot's Open button. */
  async openFileIntoSlot(target: SlotId): Promise<void> {
    let opened: OpenedFile | null;
    try {
      opened = await getHost().openFile();
    } catch (err) {
      console.error('Open failed:', err);
      alert(`Failed to open: ${err instanceof Error ? err.message : err}`);
      return;
    }
    if (!opened) return;
    // Cross-window duplicate-open guard (Electron). Runs BEFORE
    // the within-window check so a duplicate held by another
    // window jumps focus there rather than landing on this
    // window's existing copy if any.
    if (typeof opened.handle === 'string' && opened.handle) {
      const electron = getElectronHost();
      if (electron) {
        const { takenByOther } = await electron.openPathCheck(opened.handle);
        if (takenByOther) {
          showToast(`"${opened.name}" is already open in another window.`);
          return;
        }
      }
    }
    if (await this.surfaceDuplicateIfOpen(opened)) return;
    await this.loadOpenedIntoSlot(opened, target);
  }

  /** Called from the ribbon's Open button via `enableMultiDocMode`'s
   *  `onFileOpen` callback. The shell shows the inline slot picker
   *  before loading, since the user didn't pre-choose a destination. */
  async onFileOpen(opened: OpenedFile): Promise<void> {
    if (await this.surfaceDuplicateIfOpen(opened)) return;
    const choice = await this.promptForSlot(opened.name);
    if (!choice) return;
    await this.loadOpenedIntoSlot(opened, choice);
  }

  /** Duplicate-open guard: if `opened` is already loaded in the
   *  workspace, focus + show the existing copy, toast the user,
   *  and return true so the caller can short-circuit. The shell
   *  doesn't currently support having multiple copies of the same
   *  doc open. */
  private async surfaceDuplicateIfOpen(opened: OpenedFile): Promise<boolean> {
    const existing = await this.findOpenRecordByHandle(opened.handle ?? null);
    if (!existing) return false;
    existing.slot.showRecord(existing.record);
    this.focusSlot(existing.slot);
    showToast(`"${opened.name}" is already open.`);
    return true;
  }

  /** Show the inline "Send to slot…" picker; resolves with the
   *  chosen slot, or null if the user cancels. */
  private promptForSlot(filename: string): Promise<SlotId | null> {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'pmd-route-overlay';
      const dialog = document.createElement('div');
      dialog.className = 'pmd-route-dialog';
      const header = document.createElement('div');
      header.className = 'pmd-route-header';
      header.textContent = `Open ${filename} into…`;
      dialog.appendChild(header);
      const row = document.createElement('div');
      row.className = 'pmd-route-buttons';
      for (const id of SLOT_IDS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pmd-route-btn';
        const slot = this.slots[id];
        const stackLabel =
          slot.stack.length === 0
            ? '(empty)'
            : `${slot.visible?.filename ?? ''}${slot.stack.length > 1 ? ` (+${slot.stack.length - 1})` : ''}`;
        btn.innerHTML = `<strong>${id.replace('slot', 'Slot ')}</strong><br><span>${stackLabel}</span>`;
        btn.addEventListener('click', () => {
          overlay.remove();
          resolve(id);
        });
        row.appendChild(btn);
      }
      dialog.appendChild(row);
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'pmd-route-cancel';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => {
        overlay.remove();
        resolve(null);
      });
      dialog.appendChild(cancel);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
      // Esc cancels; 1 / 2 / 3 pick the corresponding slot. Skips
      // chords with modifiers so e.g. Ctrl+1 keeps its slot-focus
      // meaning even if a picker is open.
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          document.removeEventListener('keydown', onKey);
          overlay.remove();
          resolve(null);
          return;
        }
        if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
        let idx = -1;
        if (e.key === '1') idx = 0;
        else if (e.key === '2') idx = 1;
        else if (e.key === '3') idx = 2;
        if (idx >= 0) {
          e.preventDefault();
          document.removeEventListener('keydown', onKey);
          overlay.remove();
          resolve(SLOT_IDS[idx]!);
        }
      };
      document.addEventListener('keydown', onKey);
    });
  }

  /** Parse + import + mount the host-provided OpenedFile into the
   *  given slot. Detects format from the filename extension and
   *  routes to the right parser. */
  private async loadOpenedIntoSlot(opened: OpenedFile, target: SlotId): Promise<void> {
    // Duplicate-open guard runs in the entry points
    // (`onFileOpen` + `openFileIntoSlot`) BEFORE the slot picker
    // shows, so we don't pester the user with a slot prompt for a
    // doc they already have open.
    const format = formatFromFilename(opened.name) ?? 'docx';
    let doc: PMNode;
    let threads: Thread[];
    if (format === 'cmir') {
      ({ doc, threads } = parseNative(opened.bytes));
    } else {
      ({ doc, threads } = await fromDocxFull(opened.bytes));
    }
    const slot = this.slots[target];
    const record = buildDocRecord(opened.name, doc, slot, {
      handle: opened.handle ?? null,
      format,
      threads,
    });
    slot.push(record);
  }

  /** Look for an already-open DocRecord whose on-disk handle
   *  matches `handle`. Used by the duplicate-open guard. Returns
   *  the slot + record so the caller can re-focus the existing
   *  copy. Null when `handle` is null (never-saved doc) or no
   *  match — never-saved docs aren't deduped (we have no identity
   *  for them yet). */
  private async findOpenRecordByHandle(
    handle: unknown,
  ): Promise<{ slot: Slot; record: DocRecord } | null> {
    if (handle == null) return null;
    for (const id of SLOT_IDS) {
      const slot = this.slots[id];
      for (const record of slot.stack) {
        if (await isSameOpenHandle(record.handle, handle)) {
          return { slot, record };
        }
      }
    }
    return null;
  }

  /** Create an empty doc; prompt for slot. Used by the ribbon's
   *  "New doc" button. */
  async createNewDoc(): Promise<void> {
    const target = await this.promptForSlot('Untitled');
    if (!target) return;
    const doc = makeBlankDoc();
    const slot = this.slots[target];
    const record = buildDocRecord('Untitled', doc, slot, {
      handle: null,
      format: null,
    });
    slot.push(record);
  }

  /** Create a new speech document and mark it as the active speech
   *  doc. Verbatim parallels: `Paperless.NewSpeech` prompts for a
   *  round name ("1NC", "2AC vs Hogwarts", etc.); we do the same
   *  via a simple `prompt()` plus the standard slot picker. The
   *  fresh doc auto-registers as the speech doc — that's the
   *  whole point of `NewSpeech` (vs the generic `New doc`). */
  async createNewSpeechDocument(): Promise<void> {
    // Electron disables window.prompt(); route through the in-
    // renderer modal so the desktop edition works too.
    const roundName = await promptForText({
      message: 'Which speech? (e.g. 1NC, 2AC Round 3 vs Hogwarts)',
      placeholder: '1NC',
      okLabel: 'Create',
    });
    if (!roundName) return;
    const trimmed = roundName;
    const target = await this.promptForSlot(`Speech ${trimmed}`);
    if (!target) return;
    const format = settings.get('defaultSpeechDocFormat');
    const filename = formatSpeechFilename(trimmed, format);
    const includePocket = settings.get('includeSpeechDocPocket');
    // With pocket: Pocket heading carrying the filename (sans
    // extension) + trailing paragraph — Verbatim parity, the F4
    // row reads e.g. "Speech 2AC 5-15 12-30AM". Without: a fully
    // blank doc (one paragraph) for users who'd rather title
    // inline.
    const doc = includePocket
      ? makeSpeechBlankDoc(filename.replace(/\.(cmir|docx)$/i, ''))
      : makeBlankDoc();
    const slot = this.slots[target];
    // Format follows the user's `defaultSpeechDocFormat` setting —
    // `.docx` (Verbatim parity) by default, `.cmir` for autosave-
    // eligible speech docs. The user can still Save As to flip
    // format later.
    const record = buildDocRecord(filename, doc, slot, {
      handle: null,
      format,
    });
    slot.push(record);
    // `slot.push` focused the new view. Cursor placement:
    //   - With pocket: drop into the trailing paragraph so the
    //     first ` press inserts BELOW the pocket rather than
    //     inside it. Position math: pocket node occupies
    //     [0, pocket.nodeSize); paragraph cursor lives at
    //     pocket.nodeSize + 1.
    //   - Without pocket: position 1 (inside the only paragraph)
    //     is the natural cursor spot.
    const cursorPos = includePocket ? doc.firstChild!.nodeSize + 1 : 1;
    const tr = record.view.state.tr.setSelection(
      TextSelection.create(record.view.state.doc, cursorPos),
    );
    record.view.dispatch(tr);
    record.view.focus();
    // Mark as the speech doc. The registry hook fires the
    // resolver subscription, which refreshes chrome (the 📌
    // button's aria-pressed + the slot's chip).
    getSpeechDocResolver().setSpeech(record.view);
    this.refreshSpeechChips();
  }

  /** Toggle the focused pane's speech-doc designation. If the
   *  focused doc IS already the speech doc, clear the designation.
   *  Otherwise mark it (replacing any previous). No-op if no pane
   *  is focused. */
  markFocusedAsSpeech(): void {
    const rec = this.focusedSlot?.visible;
    if (!rec) return;
    const resolver = getSpeechDocResolver();
    const next = resolver.getSpeechView() === rec.view ? null : rec.view;
    resolver.setSpeech(next);
    this.refreshSpeechChips();
  }

  /** Send the focused pane's selection (or its enclosing heading-
   *  and-content range if the selection is empty) into the speech
   *  doc. `atEnd` controls the insertion point — true → after the
   *  doc-end, false → at the speech doc's current cursor. Verbatim:
   *  `Paperless.SendToSpeech PasteAtEnd:=true|false`. */
  sendToSpeech(atEnd: boolean): void {
    const sourceRec = this.focusedSlot?.visible;
    if (!sourceRec) return;
    const resolver = getSpeechDocResolver();
    const speechUid = resolver.getSpeechUid();
    // Locate the speech doc's slot + record so we can show it
    // BEFORE dispatching — the view might be BACKGROUND in its
    // slot's stack (user swapped to another record); dispatching
    // on a detached view leaves the changes invisible AND
    // uncatchable by Ctrl-Z because focus never transfers off the
    // source pane.
    const speechView = speechUid ? resolver.viewForUid(speechUid) : null;
    const located = speechView ? this.findRecordForView(speechView) : null;
    if (located && located.slot.visible?.view !== located.record.view) {
      located.slot.showRecord(located.record);
    }
    runSendToSpeech(sourceRec.view, atEnd, () => {
      // Post-insert: focus the destination slot and cancel its
      // debounced heavy-update timer so the new headings show up
      // in the nav immediately. Nav-collapse-for-new-headings is
      // handled by the resolver's onSliceLanded hook (registered
      // in `buildDocRecord`), so it fires the same way for cross-
      // window receives.
      if (!located) return;
      this.focusSlot(located.slot);
      if (located.record.heavyUpdateTimer !== null) {
        cancelIdle(located.record.heavyUpdateTimer);
        located.record.heavyUpdateTimer = null;
      }
    });
  }

  /** Sync the visual speech indicator on every slot's chip with
   *  the registry's current state. Called whenever the speech
   *  designation changes or a slot's visible doc changes. */
  refreshSpeechChips(): void {
    const speechView = getSpeechDocResolver().getSpeechView();
    for (const id of SLOT_IDS) {
      const slot = this.slots[id];
      const isSpeech = !!speechView && slot.visible?.view === speechView;
      slot.paneEl.classList.toggle('pmd-pane-speech', isSpeech);
    }
  }
}

/** Format a Verbatim-style speech filename: "Speech <round> M-D
 *  H-MMam/pm.<ext>". Extension follows the `defaultSpeechDocFormat`
 *  setting — `.docx` (Verbatim parity) or `.cmir` (autosave-
 *  eligible). */
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

/** Minimal valid doc — one empty paragraph. Used by `createNewDoc`
 *  so the freshly-routed slot has something to put a cursor into. */
function makeBlankDoc(): PMNode {
  return schema.nodes['doc']!.createChecked(null, [
    schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text('Untitled')),
    schema.nodes['paragraph']!.create(null),
  ]);
}

/** Speech-doc variant of `makeBlankDoc`. Same Pocket + trailing
 *  paragraph shape, but the Pocket carries the user-supplied
 *  speech name instead of "Untitled" so the F4 row at the top of
 *  the doc reads as a useful label ("1NC Round 3 vs Hogwarts"). */
function makeSpeechBlankDoc(title: string): PMNode {
  return schema.nodes['doc']!.createChecked(null, [
    schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text(title)),
    schema.nodes['paragraph']!.create(null),
  ]);
}

/** Single shell instance — multi-pane is a binary mode, so one is
 *  enough. */
let shell: MultiPaneShell | null = null;

/** Whether multi-pane mode is currently active. Single-doc mode
 *  returns false. */
export function isMultiPaneActive(): boolean {
  return shell !== null;
}

/** Focus the slot at `idx` (0/1/2). No-op in single-doc mode, or
 *  when the target slot has no docs loaded. Used by the
 *  `focusSlotN` ribbon commands. */
export function focusSlotByIndex(idx: 0 | 1 | 2): void {
  if (!shell) return;
  shell.focusSlotByIndex(idx);
}

/** Send the focused slot's visible doc to the slot at `idx`
 *  (0/1/2). No-op when no slot is focused, when the focused slot
 *  has no visible doc, or when the target is the focused slot
 *  itself. Used by the `sendDocToSlotN` ribbon commands. */
export function sendVisibleToSlotByIndex(idx: 0 | 1 | 2): void {
  if (!shell) return;
  shell.sendVisibleToSlotByIndex(idx);
}

/** Toggle expand-mode on the focused slot. No-op when no slot is
 *  focused. Used by the `toggleSlotExpand` ribbon command. */
export function toggleFocusedSlotExpand(): void {
  if (!shell) return;
  shell.toggleFocusedSlotExpand();
}

/** If the multi-pane shell is active AND the focused slot has a
 *  visible doc, close that doc (prompting for unsaved changes if
 *  needed). Returns true if it consumed the gesture, false if it
 *  did nothing (caller should fall through to its window-close
 *  default — used by the desktop Ctrl+W handler so a blank
 *  multi-pane window still closes on the second Ctrl+W press). */
export async function tryCloseVisibleInFocusedSlot(): Promise<boolean> {
  if (!shell) return false;
  return shell.tryCloseFocusedVisible();
}

/** Build a fresh DocRecord — wraps the per-doc PM state, nav panel,
 *  editor drag surface, and DOM containers needed for slot mounting. */
function buildDocRecord(
  filename: string,
  doc: PMNode,
  slot: Slot,
  opts: {
    handle: unknown | null;
    format: DocFormat | null;
    uid?: string;
    /** Threads from the parser (docx / cmir / crash-recovery
     *  journal). Dispatched into the comments plugin AFTER
     *  `record` is initialized — `dispatchTransaction` closes
     *  over `record`, so a load-threads dispatch earlier in this
     *  function would hit a temporal-dead-zone error. */
    threads?: Thread[];
  },
): DocRecord {
  const editorEl = document.createElement('div');
  editorEl.className = 'pmd-pane-editor';
  const navEl = document.createElement('div');
  navEl.className = 'pmd-pane-nav-host';

  const state = EditorState.create({
    doc,
    schema,
    plugins: buildEditorPlugins(),
  });

  // Per-pane EditorView. dispatchTransaction keeps the slot's word
  // count / chip / chrome in sync; if this pane is currently focused,
  // we also nudge the shared chrome (font-size chip etc.) via
  // `setActiveView` so the ribbon stays in sync as the cursor / doc
  // changes.
  const view: EditorView = new EditorView(editorEl, {
    state,
    // Browser spellcheck — driven by the `editorSpellcheck` setting,
    // off by default. The MultiPaneShell's settings subscriber pushes
    // runtime toggles onto every record's `view.dom` so the user
    // can flip it across all open panes without a reload.
    attributes: { spellcheck: settings.get('editorSpellcheck') ? 'true' : 'false' },
    dispatchTransaction(tx) {
      const prevState = view.state;
      const next = view.state.apply(tx);
      view.updateState(next);
      // Re-arm the autosave + journal debounces on doc-changing
      // transactions. Autosave is per-record now (each DocRecord
      // owns its own enabled flag + timer), so we schedule the
      // record's own save instead of the single-doc global path.
      // No-ops when autosave is off for this record. Also flip
      // the dirty flag so the pane's close-X knows there are
      // unsaved changes to prompt about.
      if (tx.docChanged) {
        record.dirty = true;
        scheduleAutosaveForRecord(record);
        scheduleJournalForRecord(record);
      }
      // Keep the shared comments column in sync — same updates the
      // single-doc dispatchTransaction makes, but only when this
      // view is the active one (the helper short-circuits
      // otherwise). Background-stack edits in non-focused panes
      // don't paint over the focused doc's column.
      notifyCommentsForActiveTransaction(view, prevState, next, tx.docChanged);
      // Debounce both O(doc-size) updates into a single timer:
      //   - navPanel.update walks the doc for headings (and
      //     rebuilds every `<li>`, which would invalidate any
      //     dblclick in progress if it ran per keystroke)
      //   - slot.refreshWordCount walks every text node for the
      //     read-aloud count
      // Running these on every transaction makes typing in large
      // docs O(N) per keystroke. The 200ms timer matches the
      // single-doc `scheduleHeavyUpdate` cadence.
      if (record.heavyUpdateTimer !== null) {
        cancelIdle(record.heavyUpdateTimer);
      }
      record.heavyUpdateTimer = scheduleIdle(() => {
        record.heavyUpdateTimer = null;
        record.navPanel.update(view.state.doc);
        slot.refreshWordCount();
      }, 200);
      // Cheap O(1) chrome refresh — keeps the font-size chip in
      // sync as the cursor moves. `setActiveView`'s call to
      // `refreshWordCount` short-circuits in multi-doc mode
      // because the shared status-bar counter is hidden anyway.
      if (getActiveView() === view) {
        setActiveView(view);
      }
    },
  });

  // Per-pane nav panel with an INDEPENDENT outline-level filter
  // (`localMaxLevel`). Each section's 1/2/3/4 buttons act locally.
  const navPanel = new NavigationPanel(navEl, { localMaxLevel: true });
  navPanel.attach(view);

  const dragSurface = new EditorDragSurface();
  dragSurface.attach(view, editorEl);
  // Click below all content → drop the cursor at the doc's end +
  // focus. Matches the single-doc behavior; closes the "I can't
  // tap into an empty doc unless I aim at its tiny rendered line"
  // gap for per-pane editors too.
  attachClickBelowToEnd(editorEl, () => view);

  const record: DocRecord = {
    uid: opts.uid ?? newDocUid(),
    filename,
    handle: opts.handle,
    format: opts.format,
    view,
    editorEl,
    navPanel,
    navEl,
    dragSurface,
    heavyUpdateTimer: null,
    journalTimer: null,
    // New docs always start with read mode OFF. The user toggles
    // it per-pane via the ribbon command after opening.
    readMode: false,
    // Autosave is per-pane in multi-doc — same intent as read mode.
    // Off by default; the user opts in per-doc via the ribbon
    // toggle once the doc has been saved as .cmir.
    autosaveEnabled: false,
    autosaveTimer: null,
    // Fresh doc: clean. Flipped on first doc-changing transaction;
    // cleared on a successful save (per-record autosave OR the
    // single-doc save flow firing through the focused-saved hook).
    dirty: false,
  };
  // Publish (uid, view) so the speech-doc resolver can resolve uids
  // back to live views and (on Electron) so main learns which
  // window owns this uid. The `onSliceLanded` hook fires on the
  // destination side whenever a speech-doc slice arrives (same-
  // window OR cross-window) — refreshes nav-panel collapse state
  // for newly arrived headings using the local `maxLevel` rule.
  getSpeechDocResolver().registerView(record.uid, record.view, {
    onSliceLanded: () => record.navPanel.applyMaxLevelToNewHeadings(),
  });
  // Seed main's per-uid filename map for this record so the
  // Select-Speech-Doc modal can label it immediately. Subsequent
  // filename changes (setFocusedFilename / setFocusedFile) push
  // their own updates.
  pushPaneDocInfo(record.uid, record.filename);

  // Hydrate comments plugin state from the parser's threads. MUST
  // run AFTER `record` is initialized — `dispatchTransaction`
  // closes over `record`, so dispatching earlier hits a TDZ. The
  // `loadThreads` transaction is `addToHistory: false` so it
  // stays out of the undo stack. Without this, the
  // `comment_range` marks render their inline highlight but the
  // comments column has no thread data to show.
  if (opts.threads && opts.threads.length > 0) {
    view.dispatch(loadThreads(view.state, opts.threads));
  }

  // Register this window's claim on the file path (Electron only)
  // so the cross-window duplicate-open guard can find it. Main's
  // spawn-window handler already claims for the new window's id
  // when a spawn carries a payload.handle, so this re-register is
  // an idempotent no-op for spawn-target initial mounts.
  syncDocPathClaim(null, record.handle);

  return record;
}

/** Boot-time entry point — called from editor/index.ts when the
 *  multi-doc setting is on. Installs the multi-pane shell and the
 *  file-routing hook into the shared ribbon. */
export function mountMultiPaneShell(): void {
  if (shell) return;
  shell = new MultiPaneShell();
  enableMultiDocMode({
    onFileOpen: (file) => shell!.onFileOpen(file),
    onNewDoc: () => shell!.createNewDoc(),
    toggleReadMode: () => shell!.toggleFocusedReadMode(),
    toggleAutosave: () => shell!.toggleFocusedAutosave(),
    notifyFocusedSaved: () => shell!.markFocusedSaved(),
    newSpeechDocument: () => { void shell!.createNewSpeechDocument(); },
    markActiveAsSpeech: () => shell!.markFocusedAsSpeech(),
    sendToSpeechAtCursor: () => shell!.sendToSpeech(false),
    sendToSpeechAtEnd: () => shell!.sendToSpeech(true),
    getFocusedFilename: () => shell!.getFocusedFilename(),
    setFocusedFilename: (name) => shell!.setFocusedFilename(name),
    getFocusedFile: () => shell!.getFocusedFile(),
    setFocusedFile: (f) => shell!.setFocusedFile(f),
    getAllFilenames: () => shell!.getAllFilenames(),
    clearFocusedJournal: () => shell!.clearFocusedJournal(),
    onRecoveredDoc: (entry) => shell!.onRecoveredDoc(entry),
    journalAll: () => shell!.journalAll(),
  });
}
