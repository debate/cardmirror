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
 * Comments are disabled in multi-doc mode (see SPEC-multi-pane.md).
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

import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../schema/index.js';
import { fromDocxFull } from '../index.js';
import { settings } from './settings.js';
import { NavigationPanel } from './nav-panel.js';
import { EditorDragSurface } from './drag-editor-surface.js';
import { dragController } from './drag-controller.js';
import { countReadAloudWords, formatReadTime, formatNumber } from './word-count.js';
import {
  buildEditorPlugins,
  enableMultiDocMode,
  setActiveView,
  getActiveView,
} from './index.js';

type SlotId = 'slot1' | 'slot2' | 'slot3';
const SLOT_IDS: SlotId[] = ['slot1', 'slot2', 'slot3'];

let nextDocUid = 1;
function newDocUid(): string {
  return `doc-${nextDocUid++}`;
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
  view: EditorView;
  /** Root element holding `view.dom`. Mounted into / detached from
   *  the slot's body when this record becomes / stops being visible. */
  editorEl: HTMLElement;
  navPanel: NavigationPanel;
  /** Root element holding `navPanel`'s output. Mounted into / detached
   *  from the slot's nav section when visibility changes. */
  navEl: HTMLElement;
  dragSurface: EditorDragSurface;
  /** Debounce handle for `navPanel.update`. Rebuilding the nav on
   *  every transaction (including selection moves) replaces the
   *  `<li>` elements between two clicks of a dblclick, so the
   *  native `dblclick` event never fires. A 200ms debounce matches
   *  the single-doc `scheduleHeavyUpdate` cadence and keeps the
   *  li alive long enough for dblclick / chevron / drag pickup to
   *  resolve. */
  navUpdateTimer: ReturnType<typeof setTimeout> | null;
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
    this.chipCloseBtn = document.createElement('button');
    this.chipCloseBtn.type = 'button';
    this.chipCloseBtn.className = 'pmd-pane-chip-close';
    this.chipCloseBtn.title = 'Close this document';
    this.chipCloseBtn.textContent = '×';
    this.chipCloseBtn.addEventListener('mousedown', (e) => e.preventDefault());
    this.chipCloseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeVisible();
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
      this.shell.openFileIntoSlot(this.id);
    });
    footer.appendChild(openBtn);
    this.paneEl.appendChild(footer);

    // Nav section (lives in the multi-nav rail at left of window).
    this.navSectionEl = document.createElement('section');
    this.navSectionEl.className = 'pmd-multi-nav-section';
    this.navSectionEl.dataset['slot'] = id;
    this.navSectionEl.hidden = true;
    this.navBodyEl = document.createElement('div');
    this.navBodyEl.className = 'pmd-multi-nav-body';
    this.navSectionEl.appendChild(this.navBodyEl);
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
    this.stack.push(record);
    this.visibleIndex = this.stack.length - 1;
    this.mountVisible();
    this.paneEl.hidden = false;
    this.navSectionEl.hidden = false;
    this.shell.refreshLayout();
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

  /** Close the currently-visible doc. Reveals the next stack member
   *  (or empties the slot). */
  closeVisible(): void {
    const idx = this.visibleIndex;
    if (idx < 0) return;
    const closing = this.stack[idx]!;
    this.detachVisible();
    if (closing.navUpdateTimer !== null) {
      clearTimeout(closing.navUpdateTimer);
      closing.navUpdateTimer = null;
    }
    closing.view.destroy();
    closing.dragSurface.detach();
    this.stack.splice(idx, 1);
    if (this.stack.length === 0) {
      this.visibleIndex = -1;
      this.paneEl.hidden = true;
      this.navSectionEl.hidden = true;
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
  }

  /** Update the chip's stack-dropdown trigger visibility based on
   *  current stack depth. */
  refreshChip(): void {
    const multi = this.stack.length > 1;
    this.chipStackBtn.hidden = !multi;
    this.chipStackBtn.textContent = multi ? `▾ ${this.stack.length}` : '▾';
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
        this.closeRecord(rec);
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

  /** Close a specific record (not necessarily the visible one). */
  closeRecord(rec: DocRecord): void {
    const idx = this.stack.indexOf(rec);
    if (idx < 0) return;
    if (idx === this.visibleIndex) {
      this.closeVisible();
      return;
    }
    if (rec.navUpdateTimer !== null) {
      clearTimeout(rec.navUpdateTimer);
      rec.navUpdateTimer = null;
    }
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
  private layoutMode: 'compact' | 'wide';
  private unsubscribeSettings: (() => void) | null = null;

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
      }
      // Pane word counts depend on reader settings.
      for (const id of SLOT_IDS) this.slots[id].refreshWordCount();
    });

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
            if (rec.navUpdateTimer !== null) {
              clearTimeout(rec.navUpdateTimer);
              rec.navUpdateTimer = null;
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

  /** Refresh the data-attribute count on the row, used by CSS to
   *  size each pane based on how many slots are active. */
  refreshLayout(): void {
    const active = SLOT_IDS.filter((id) => this.slots[id].stack.length > 0).length;
    this.rowEl.dataset['active'] = String(active);
    this.navRailEl.dataset['active'] = String(active);
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
  }

  /** Trigger the OS file picker, routed to a known slot (no prompt
   *  since the user clicked that slot's Open button). */
  openFileIntoSlot(target: SlotId): void {
    pendingRoute = target;
    triggerFilePicker();
  }

  /** Called by the global dropzone change handler (delegated through
   *  `enableMultiDocMode`) when a file is picked. */
  async onFileOpen(file: File): Promise<void> {
    // If the user reached here via an Open-into-this-slot button,
    // skip the inline picker and route to the chosen slot.
    if (pendingRoute) {
      const target = pendingRoute;
      pendingRoute = null;
      await this.loadFileIntoSlot(file, target);
      return;
    }
    // Otherwise show the inline routing picker first.
    const choice = await this.promptForSlot(file.name);
    if (!choice) return;
    await this.loadFileIntoSlot(file, choice);
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
      // Esc cancels.
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          document.removeEventListener('keydown', onKey);
          overlay.remove();
          resolve(null);
        }
      };
      document.addEventListener('keydown', onKey);
    });
  }

  /** Parse + import + mount a file into the given slot. */
  private async loadFileIntoSlot(file: File, target: SlotId): Promise<void> {
    const buf = await file.arrayBuffer();
    const { doc } = await fromDocxFull(new Uint8Array(buf));
    const slot = this.slots[target];
    const record = buildDocRecord(file.name, doc, slot);
    slot.push(record);
  }

  /** Create an empty doc; prompt for slot. Used by the ribbon's
   *  "New doc" button. */
  async createNewDoc(): Promise<void> {
    const target = await this.promptForSlot('Untitled');
    if (!target) return;
    const doc = makeBlankDoc();
    const slot = this.slots[target];
    const record = buildDocRecord('Untitled.docx', doc, slot);
    slot.push(record);
  }
}

/** Minimal valid doc — one empty paragraph. Used by `createNewDoc`
 *  so the freshly-routed slot has something to put a cursor into. */
function makeBlankDoc(): PMNode {
  return schema.nodes['doc']!.createChecked(null, [
    schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text('Untitled')),
    schema.nodes['paragraph']!.create(null),
  ]);
}

/** Single shell instance — multi-pane is a binary mode, so one is
 *  enough. */
let shell: MultiPaneShell | null = null;

/** Track which slot to open into when the next file-pick fires.
 *  Set by the per-pane Open button so it can skip the inline picker. */
let pendingRoute: SlotId | null = null;

/** Trigger the global dropzone's file picker. */
function triggerFilePicker(): void {
  const dropzone = document.getElementById('dropzone') as HTMLInputElement | null;
  if (dropzone) dropzone.click();
}

/** Build a fresh DocRecord — wraps the per-doc PM state, nav panel,
 *  editor drag surface, and DOM containers needed for slot mounting. */
function buildDocRecord(filename: string, doc: PMNode, slot: Slot): DocRecord {
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
    dispatchTransaction(tx) {
      const next = view.state.apply(tx);
      view.updateState(next);
      slot.refreshWordCount();
      // Debounce the nav re-render. Rebuilding it on every
      // transaction (including selection moves) recreates every
      // `<li>` between the two clicks of a dblclick, which the
      // browser then refuses to fire because the element identity
      // changed. 200ms matches the single-doc `scheduleHeavyUpdate`
      // cadence.
      if (record.navUpdateTimer !== null) {
        clearTimeout(record.navUpdateTimer);
      }
      record.navUpdateTimer = setTimeout(() => {
        record.navUpdateTimer = null;
        record.navPanel.update(view.state.doc);
      }, 200);
      // If this pane is the focused one, push state into the shared
      // chrome (so refreshFontSizeDisplay, refreshWordCount in
      // editor/index.ts see the new view state).
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

  const record: DocRecord = {
    uid: newDocUid(),
    filename,
    view,
    editorEl,
    navPanel,
    navEl,
    dragSurface,
    navUpdateTimer: null,
  };
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
  });
}
