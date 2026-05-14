/**
 * Navigation panel — outline view of headings.
 *
 * Renders a tree of pocket / hat / block / tag / analytic entries
 * indented by outline level. Click an entry to jump to and select
 * the heading in the editor.
 *
 * v0 affordances (this file): tree rendering, click-to-jump, hover
 * highlight. Out of scope for this iteration: collapse/expand, drag-
 * reorder, promote/demote, delete-subtree, grab — per
 * ARCHITECTURE.md §8 these are real features that need design input.
 */

import type { EditorView } from 'prosemirror-view';
import { type Node as PMNode, DOMSerializer } from 'prosemirror-model';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import { settings } from './settings.js';
import { dragController, type DragItem, type DragSurface } from './drag-controller.js';
import {
  collectHeadings,
  computeHeadingRange,
  TYPE_LABEL,
  type HeadingEntry,
} from './headings.js';

const NAV_WIDTH_MIN = 150;
const NAV_WIDTH_MAX = 800;

/**
 * Whether the user is holding the platform's "copy" modifier during
 * a drag. File-manager convention: Ctrl on Windows/Linux, Option (Alt)
 * on macOS. Treating both as equivalent is harmless — neither has a
 * conflicting drag semantic on its non-native platform.
 */
function isCopyModifier(
  e: { ctrlKey: boolean; altKey: boolean },
): boolean {
  return e.ctrlKey || e.altKey;
}

function applyNavWidthCss(px: number): void {
  const clamped = Math.max(NAV_WIDTH_MIN, Math.min(NAV_WIDTH_MAX, px));
  document.documentElement.style.setProperty('--nav-width', `${clamped}px`);
}

export class NavigationPanel {
  private root: HTMLElement;
  private view: EditorView | null = null;
  private listEl: HTMLOListElement;
  private emptyEl: HTMLElement;
  private currentDoc: PMNode | null = null;
  /** Set of heading IDs whose subtrees are collapsed. Derived from
   *  maxLevel on attach; ad-hoc chevron clicks update during a session.
   *  Not persisted (heading IDs are doc-specific). */
  private collapsed: Set<string> = new Set();
  private levelButtons: HTMLButtonElement[] = [];
  private unsubscribeSettings: (() => void) | null = null;
  private unsubscribeDrag: (() => void) | null = null;
  private unregisterSurface: (() => void) | null = null;

  // ---- Selection state (multi-select) ----
  private selectedIds: Set<string> = new Set();
  private selectionAnchorId: string | null = null;
  /** Outline level of currently selected entries; selection is
   *  level-locked (so tags + analytics — both level 4 — can be
   *  selected together, but a tag + a block cannot). */
  private selectionLevel: number | null = null;
  /** When the user plain-clicks on an entry that's part of a multi-
   *  selection, defer the "replace selection with just this entry"
   *  action to pointerup-without-drag (so the drag uses the multi).
   */
  private deferredClickFinalize: HeadingEntry | null = null;
  /** Modifier state captured at pointerdown — drives whether
   *  pointerup-without-drag does a jumpTo (plain click) or just
   *  finalizes selection (Ctrl/Shift click). */
  private pointerDownModifier: 'none' | 'shift' | 'meta' = 'none';

  // ---- Drag-and-drop state ----
  private liEntries: Map<HTMLLIElement, HeadingEntry> = new Map();
  private dragStartX = 0;
  private dragStartY = 0;
  private dragStartLi: HTMLLIElement | null = null;
  private dragStartEntry: HeadingEntry | null = null;
  private dragHandlersAttached = false;
  private pickupPill: HTMLElement | null = null;
  private dropIndicators: HTMLElement[] = [];
  /** Heading IDs we expanded automatically during the active drag.
   *  Restored on drag-off / cancel. */
  private autoExpanded: Set<string> = new Set();
  private autoExpandTimer: ReturnType<typeof setTimeout> | null = null;
  private autoExpandTarget: string | null = null;
  /** Per-id pending re-collapse timers — armed when the pointer
   *  leaves an auto-expanded entry's subtree, cleared if it returns
   *  before the timer fires. Mirrors the auto-expand 400ms hover. */
  private pendingRestoreTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private boundOnDragMove = (e: PointerEvent) => this.onDragMove(e);
  private boundOnDragUp = (e: PointerEvent) => this.onDragUp(e);
  private boundOnDragKey = (e: KeyboardEvent) => this.onDragKey(e);
  private boundOnDragKeyUp = (e: KeyboardEvent) => this.onDragKey(e);

  /** When set (multi-pane sections), the outline-level filter is
   *  per-instance instead of shared via the `navMaxLevel` setting. */
  private localMaxLevel: number | null = null;
  /** Heading IDs seen at the last render. Used by
   *  `applyMaxLevelToNewHeadings` (called after cross-view drops in
   *  multi-pane mode) to identify headings that were dropped /
   *  pasted in since the previous render and need to be auto-
   *  collapsed to the current `maxLevel`. Existing user-expanded
   *  parents stay expanded. */
  private lastSeenIds: Set<string> = new Set();
  private get maxLevel(): number {
    if (this.localMaxLevel != null) return this.localMaxLevel;
    return settings.get('navMaxLevel');
  }

  constructor(parent: HTMLElement, opts?: { localMaxLevel?: boolean; initialMaxLevel?: number }) {
    if (opts?.localMaxLevel) {
      this.localMaxLevel = opts.initialMaxLevel ?? settings.get('navMaxLevel');
    }
    this.root = document.createElement('aside');
    this.root.className = 'pmd-nav-panel';

    const header = document.createElement('header');

    const levelGroup = document.createElement('div');
    levelGroup.className = 'pmd-nav-level-group';
    levelGroup.title = 'Show heading levels — click N to show levels 1 through N';
    for (let lvl = 1; lvl <= 4; lvl++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pmd-nav-level-btn';
      btn.dataset['level'] = String(lvl);
      btn.textContent = String(lvl);
      btn.title = `Show heading 1${lvl > 1 ? `–${lvl}` : ''}`;
      btn.addEventListener('click', () => this.setMaxLevel(lvl));
      this.levelButtons.push(btn);
      levelGroup.appendChild(btn);
    }
    header.appendChild(levelGroup);

    this.root.appendChild(header);
    this.updateLevelButtonsActive();

    this.listEl = document.createElement('ol');
    this.listEl.className = 'pmd-nav-list';
    this.root.appendChild(this.listEl);

    this.emptyEl = document.createElement('p');
    this.emptyEl.className = 'pmd-nav-empty';
    this.emptyEl.textContent = 'No headings.';
    this.root.appendChild(this.emptyEl);

    applyNavWidthCss(settings.get('navWidth'));
    this.installResizeHandle();

    // Re-render when relevant settings change.
    this.unsubscribeSettings = settings.subscribe((s) => {
      applyNavWidthCss(s.navWidth);
      this.updateLevelButtonsActive();
      if (this.currentDoc) this.render(this.currentDoc);
    });

    parent.appendChild(this.root);
  }

  /**
   * Add a draggable resize handle on the right edge. Width is stored in
   * the `--nav-width` CSS custom property so both the panel and #app's
   * left margin update in lockstep. Persisted in localStorage.
   */
  private installResizeHandle(): void {
    const handle = document.createElement('div');
    handle.className = 'pmd-nav-resize-handle';
    handle.setAttribute('aria-label', 'Resize outline panel');
    handle.setAttribute('role', 'separator');
    this.root.appendChild(handle);

    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      const delta = e.clientX - startX;
      applyNavWidthCss(startWidth + delta);
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('pmd-nav-resize-active');
      this.root.classList.remove('pmd-nav-resizing');
      const w = getComputedStyle(this.root).width;
      const pixels = parseInt(w, 10);
      if (Number.isFinite(pixels)) {
        settings.set('navWidth', pixels);
      }
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      startX = e.clientX;
      startWidth = this.root.getBoundingClientRect().width;
      document.body.classList.add('pmd-nav-resize-active');
      this.root.classList.add('pmd-nav-resizing');
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }

  attach(view: EditorView): void {
    this.view = view;
    this.currentDoc = view.state.doc;
    // On every attach (fresh mount or new doc loaded), establish the
    // initial collapse state from maxLevel. This guarantees the default
    // view is the one promised by maxLevel — heading IDs are doc-specific
    // so any persisted collapsed state from another doc wouldn't apply
    // anyway.
    this.applyMaxLevelToCollapseState();
    this.render(this.currentDoc);

    // Register as a drop-target surface and subscribe to drag events
    // so we render indicators regardless of which surface initiated
    // the drag (nav-pane drag → both surfaces show indicators;
    // editor pickup-mode drag → both surfaces show indicators too).
    if (this.unregisterSurface) this.unregisterSurface();
    if (this.unsubscribeDrag) this.unsubscribeDrag();
    this.unregisterSurface = dragController.registerSurface(this.dragSurfaceImpl);
    this.unsubscribeDrag = dragController.subscribe((event) => {
      if (event === 'begin') {
        const session = dragController.getSession();
        if (session) this.renderDropIndicators(session.items[0]!.level);
      } else if (event === 'end') {
        this.removeDropIndicators();
      } else if (event === 'move') {

        // Run auto-expand / auto-restore / auto-scroll on every
        // controller move event, so editor-sourced drags get the same
        // hover-driven nav-pane behavior as nav-sourced drags. The
        // nav-source path also triggers this (its setPointer fires
        // 'move'), but the duplicate work is idempotent.
        if (!dragController.isActive()) return;
        const { x, y } = dragController.getPointer();
        const hovered = this.entryUnderPointer(x, y);
        this.maybeAutoExpand(hovered);
        this.maybeRestoreAutoExpanded(hovered);
        this.maybeAutoScroll(y);
        // Keep the pickup pill's copy badge in sync with the
        // controller's copy-mode flag. The flag is updated by drag-
        // source pointer/key handlers; this is how the badge picks up
        // a key-only toggle (Ctrl held without pointer movement).
        this.syncPickupPillCopyBadge();
      }
    });
  }

  /** Surface implementation handed to the drag controller. */
  private dragSurfaceImpl: DragSurface = {
    hitTest: (clientX, clientY) => this.hitTestDropIndicators(clientX, clientY),
    highlight: (el) => this.highlightDropIndicator(el),
  };

  private hitTestDropIndicators(
    clientX: number,
    clientY: number,
  ): { el: HTMLElement; insertPos: number; dy: number; view?: EditorView } | null {
    const session = dragController.getSession();
    if (!session) return null;
    const myView = this.view ?? undefined;

    // Horizontal gate: pointer must be inside the nav panel column.
    // (Use the panel root rather than each indicator's rect so a
    // pointer past the bottom indicator — where the indicator might
    // be very narrow — still registers.)
    const rootRect = this.root.getBoundingClientRect();
    if (clientX < rootRect.left - 8 || clientX > rootRect.right + 8) return null;

    type Cand = { el: HTMLElement; insertPos: number; centerY: number; dy: number };
    const valid: Cand[] = [];
    // For same-view drops, skip indicators that fall inside the
    // dragged source range (would be a no-op). For cross-view drops
    // every indicator is a valid landing point — the source ranges
    // refer to a different doc.
    const sameDoc = session.view === this.view;
    for (const indicator of this.dropIndicators) {
      const insertPos = parseInt(indicator.dataset['insertPos'] ?? '-1', 10);
      if (sameDoc) {
        const onSelf = session.items.some(
          (it) => insertPos > it.from && insertPos < it.to,
        );
        if (onSelf) continue;
      }
      const rect = indicator.getBoundingClientRect();
      const centerY = (rect.top + rect.bottom) / 2;
      valid.push({ el: indicator, insertPos, centerY, dy: Math.abs(clientY - centerY) });
    }
    if (valid.length === 0) return null;

    // Preferred: closest indicator within a 24px band.
    let best: Cand | null = null;
    for (const v of valid) {
      if (v.dy > 24) continue;
      if (!best || v.dy < best.dy) best = v;
    }
    if (best) return { el: best.el, insertPos: best.insertPos, dy: best.dy, view: myView };

    // Fall-through: pointer is above the topmost or below the
    // bottommost indicator. Snap to that extreme so dragging into
    // the empty space at the top or bottom of the panel still lands
    // a target.
    let topMost = valid[0]!;
    let bottomMost = valid[0]!;
    for (const v of valid) {
      if (v.centerY < topMost.centerY) topMost = v;
      if (v.centerY > bottomMost.centerY) bottomMost = v;
    }
    if (clientY > bottomMost.centerY) {
      return { el: bottomMost.el, insertPos: bottomMost.insertPos, dy: bottomMost.dy, view: myView };
    }
    if (clientY < topMost.centerY) {
      return { el: topMost.el, insertPos: topMost.insertPos, dy: topMost.dy, view: myView };
    }
    return null;
  }

  private highlightDropIndicator(el: HTMLElement | null): void {
    for (const indicator of this.dropIndicators) {
      indicator.classList.toggle(
        'pmd-nav-drop-indicator-active',
        indicator === el,
      );
    }
  }

  /** Re-render given a new doc. Cheap to call on every transaction. */
  update(doc: PMNode): void {
    this.currentDoc = doc;
    this.render(doc);
  }

  /** Sync the collapsed set to a maxLevel: every parent at level ≥ N
   *  is collapsed, every shallower parent is expanded.
   *
   *  When called with no argument, uses the current setting. When called
   *  with an explicit level, uses that — needed by `setMaxLevel`, which
   *  must update collapsed state for the new level *before* the settings
   *  store change fires the render-on-subscribe.
   */
  private applyMaxLevelToCollapseState(level?: number): void {
    if (!this.currentDoc) return;
    const maxLevel = level ?? this.maxLevel;
    const entries = collectHeadings(this.currentDoc);
    this.collapsed = new Set();
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (entry.id == null) continue;
      const next = entries[i + 1];
      const hasChildren = next != null && next.level > entry.level;
      if (!hasChildren) continue;
      if (entry.level >= maxLevel) {
        this.collapsed.add(entry.id);
      }
    }
  }

  /**
   * Apply the current `maxLevel` collapse rule to headings whose IDs
   * weren't present at the last render. Used by the multi-pane shell
   * after a cross-view drop: dropped content gets fresh heading IDs
   * via `rewriteHeadingIds`, so the diff identifies exactly the new
   * entries. Existing user-expanded parents are preserved.
   *
   * Also triggers a synchronous re-render and updates the latest doc
   * snapshot — call after a transaction has applied.
   */
  applyMaxLevelToNewHeadings(): void {
    const view = this.view;
    if (!view) return;
    const doc = view.state.doc;
    this.currentDoc = doc;
    const maxLevel = this.maxLevel;
    const entries = collectHeadings(doc);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (entry.id == null) continue;
      if (this.lastSeenIds.has(entry.id)) continue; // not new
      const next = entries[i + 1];
      const hasChildren = next != null && next.level > entry.level;
      if (!hasChildren) continue;
      if (entry.level >= maxLevel) {
        this.collapsed.add(entry.id);
      }
    }
    this.render(doc);
  }

  private render(doc: PMNode): void {
    const entries = collectHeadings(doc);

    // Refresh the `lastSeenIds` set so `applyMaxLevelToNewHeadings`
    // (called by the multi-pane shell after cross-view drops) can
    // diff future renders against it.
    const seen = new Set<string>();
    for (const entry of entries) {
      if (entry.id != null) seen.add(entry.id);
    }
    this.lastSeenIds = seen;

    // Clear and re-build. For doc sizes we care about (max ~600 headings
    // in the example corpus) this is fine; if profiling shows it's hot,
    // diff against the previous render.
    this.listEl.innerHTML = '';
    this.liEntries.clear();

    if (entries.length === 0) {
      this.listEl.style.display = 'none';
      this.emptyEl.style.display = '';
      return;
    }

    this.emptyEl.style.display = 'none';
    this.listEl.style.display = '';

    // Skip-tracking: when we encounter a collapsed heading, we hide
    // every following entry whose level is deeper than it, until we
    // hit one at the same or shallower level.
    let skipBelowLevel: number | null = null;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;

      if (skipBelowLevel != null) {
        if (entry.level > skipBelowLevel) continue;
        skipBelowLevel = null;
      }

      const next = entries[i + 1];
      const hasChildren = next != null && next.level > entry.level;
      const collapsed = entry.id != null && this.collapsed.has(entry.id);

      const li = document.createElement('li');
      li.className = `pmd-nav-item pmd-nav-level-${entry.level} pmd-nav-type-${entry.type}`;
      li.title = TYPE_LABEL[entry.type] ?? entry.type;
      if (entry.id) li.dataset['id'] = entry.id;
      li.dataset['pos'] = String(entry.pos);
      if (entry.id != null && this.selectedIds.has(entry.id)) {
        li.classList.add('pmd-nav-item-selected');
      }

      const chevron = document.createElement('span');
      chevron.className = 'pmd-nav-chevron';
      if (hasChildren) {
        chevron.textContent = collapsed ? '▶' : '▼';
        chevron.classList.add('pmd-nav-chevron-active');
        chevron.addEventListener('click', (e) => {
          e.stopPropagation();
          this.toggleCollapsed(entry);
        });
      } else {
        // Leaf — keep a placeholder for indent alignment.
        chevron.classList.add('pmd-nav-chevron-leaf');
      }
      li.appendChild(chevron);

      const label = document.createElement('span');
      label.className = 'pmd-nav-label';
      label.textContent = entry.text;
      li.appendChild(label);

      if (entry.cite && settings.get('showCitePreview')) {
        const citePreview = document.createElement('span');
        citePreview.className = 'pmd-nav-cite-preview';
        citePreview.textContent = entry.cite;
        citePreview.title = entry.cite;
        li.appendChild(citePreview);
      }

      // Pointer-based handler: distinguishes click (jump-to) from
      // drag (move heading). dblclick still fires natively from the
      // browser on two consecutive low-movement pointerdown/up cycles.
      li.addEventListener('pointerdown', (e) => this.onLiPointerDown(e, entry, li));
      li.addEventListener('dblclick', () => {
        if (hasChildren) this.toggleCollapsed(entry);
      });
      li.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.openContextMenu(e.clientX, e.clientY, entry);
      });

      this.liEntries.set(li, entry);
      this.listEl.appendChild(li);

      if (hasChildren && collapsed) {
        skipBelowLevel = entry.level;
      }
    }
  }

  private toggleCollapsed(entry: HeadingEntry): void {
    if (entry.id == null) return;
    if (this.collapsed.has(entry.id)) {
      this.collapsed.delete(entry.id);
    } else {
      this.collapsed.add(entry.id);
    }
    if (this.currentDoc) this.render(this.currentDoc);
  }

  // ---------------------------------------------- Drag-and-drop ----

  private onLiPointerDown(
    e: PointerEvent,
    entry: HeadingEntry,
    li: HTMLLIElement,
  ): void {
    if (e.button !== 0) return; // primary button only
    // Ignore clicks that originated on the chevron — it has its own
    // handler and shouldn't initiate a drag.
    const target = e.target as HTMLElement;
    if (target.closest('.pmd-nav-chevron')) return;

    // Capture modifier state so pointerup-without-drag knows whether
    // it's a plain click (jumpTo) or a Ctrl/Shift click (selection-only).
    this.pointerDownModifier = e.shiftKey
      ? 'shift'
      : e.metaKey || e.ctrlKey
        ? 'meta'
        : 'none';

    // Apply the selection update for Shift/Ctrl right away.
    // Plain clicks defer the "replace selection with this entry" if
    // the entry is part of a multi-selection — drag should use the
    // existing multi, but a plain click without drag should single-
    // select.
    this.deferredClickFinalize = null;
    if (this.pointerDownModifier === 'shift') {
      this.handleShiftClick(entry);
    } else if (this.pointerDownModifier === 'meta') {
      this.handleCtrlClick(entry);
    } else {
      // plain
      if (
        entry.id != null &&
        this.selectedIds.has(entry.id) &&
        this.selectedIds.size > 1
      ) {
        this.deferredClickFinalize = entry;
      } else {
        this.selectSingle(entry);
      }
    }

    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
    this.dragStartLi = li;
    this.dragStartEntry = entry;

    if (!this.dragHandlersAttached) {
      document.addEventListener('pointermove', this.boundOnDragMove);
      document.addEventListener('pointerup', this.boundOnDragUp);
      document.addEventListener('keydown', this.boundOnDragKey);
      // keyup so the copy-modifier indicator clears the moment the
      // user releases Ctrl/Option mid-drag without moving the pointer.
      document.addEventListener('keyup', this.boundOnDragKeyUp);
      this.dragHandlersAttached = true;
    }
  }

  // ---- Selection helpers ----

  private selectSingle(entry: HeadingEntry): void {
    if (entry.id == null) {
      this.clearSelection();
      return;
    }
    const wasSize = this.selectedIds.size;
    const onlyMember = wasSize === 1 && this.selectedIds.has(entry.id);
    this.selectedIds = new Set([entry.id]);
    this.selectionAnchorId = entry.id;
    this.selectionLevel = entry.level;
    if (!onlyMember) this.applySelectionClasses();
  }

  private clearSelection(): void {
    if (this.selectedIds.size === 0 && this.selectionAnchorId === null) return;
    this.selectedIds.clear();
    this.selectionAnchorId = null;
    this.selectionLevel = null;
    this.applySelectionClasses();
  }

  private handleShiftClick(entry: HeadingEntry): void {
    if (entry.id == null) return;
    if (!this.currentDoc) {
      this.selectSingle(entry);
      return;
    }
    if (!this.selectionAnchorId || this.selectionLevel == null) {
      this.selectSingle(entry);
      return;
    }
    const all = collectHeadings(this.currentDoc);
    const aIdx = all.findIndex((e) => e.id === this.selectionAnchorId);
    const bIdx = all.findIndex((e) => e.id === entry.id);
    if (aIdx < 0 || bIdx < 0) {
      this.selectSingle(entry);
      return;
    }
    const lo = Math.min(aIdx, bIdx);
    const hi = Math.max(aIdx, bIdx);
    const next = new Set<string>();
    // Filter the range to the anchor's outline level. Mixed-level
    // ranges quietly resolve to the level-consistent subset (e.g. a
    // shift-click range over a hat keeps just the cards on either
    // side, dropping the hat). Same level = OK regardless of type:
    // a tag and an analytic at level 4 group together.
    for (let i = lo; i <= hi; i++) {
      const e = all[i]!;
      if (e.id != null && e.level === this.selectionLevel) next.add(e.id);
    }
    this.selectedIds = next;
    // Anchor stays where it was so subsequent shift-clicks keep
    // ranging from the same starting point.
    this.applySelectionClasses();
  }

  private handleCtrlClick(entry: HeadingEntry): void {
    if (entry.id == null) return;
    // Empty selection or level mismatch → replace with just this entry.
    if (
      this.selectedIds.size === 0 ||
      (this.selectionLevel !== null && this.selectionLevel !== entry.level)
    ) {
      this.selectSingle(entry);
      return;
    }
    // Toggle entry in/out.
    if (this.selectedIds.has(entry.id)) {
      this.selectedIds.delete(entry.id);
      if (this.selectedIds.size === 0) {
        this.selectionAnchorId = null;
        this.selectionLevel = null;
      } else if (this.selectionAnchorId === entry.id) {
        // Anchor was the deselected entry; pick another to be the new
        // anchor (the next remaining one).
        this.selectionAnchorId = this.selectedIds.values().next().value ?? null;
      }
    } else {
      this.selectedIds.add(entry.id);
      this.selectionAnchorId = entry.id;
      this.selectionLevel = entry.level;
    }
    this.applySelectionClasses();
  }

  private applySelectionClasses(): void {
    for (const [li, entry] of this.liEntries) {
      const selected = entry.id != null && this.selectedIds.has(entry.id);
      li.classList.toggle('pmd-nav-item-selected', selected);
    }
  }

  private onDragMove(e: PointerEvent): void {
    if (!this.dragStartEntry) return;

    if (!dragController.isActive()) {
      const dx = e.clientX - this.dragStartX;
      const dy = e.clientY - this.dragStartY;
      // 5px threshold — below this, count as a click, not a drag.
      if (dx * dx + dy * dy < 25) return;
      // Read mode disables drag (but lets clicks still navigate).
      if (settings.get('readMode')) return;
      this.startDrag();
    }

    if (!dragController.isActive()) return;

    dragController.setPointer(e.clientX, e.clientY);
    dragController.setCopyMode(isCopyModifier(e));
    this.updatePickupPill(e.clientX, e.clientY);
    dragController.dispatchHit(e.clientX, e.clientY);

    const hovered = this.entryUnderPointer(e.clientX, e.clientY);
    this.maybeAutoExpand(hovered);
    this.maybeRestoreAutoExpanded(hovered);
    this.maybeAutoScroll(e.clientY);
  }

  private onDragUp(e: PointerEvent): void {
    let committed = false;
    if (dragController.isActive()) {
      // Read the modifier off the pointerup event so the user's final
      // intent at release time is what matters (Ctrl/Option held →
      // copy; otherwise → move).
      committed = dragController.commit({ copy: isCopyModifier(e) });
    } else if (this.dragStartEntry) {
      // No drag occurred. Finalize the click action:
      // - Plain click on a multi-selected entry (deferred): single-select
      //   it, then jump to it.
      // - Plain click otherwise: jump to the entry (selection already
      //   updated at pointerdown).
      // - Ctrl/Shift click: selection was already updated; don't navigate.
      if (this.pointerDownModifier === 'none') {
        if (this.deferredClickFinalize) {
          this.selectSingle(this.deferredClickFinalize);
        }
        this.jumpTo(this.dragStartEntry);
      }
    }
    this.deferredClickFinalize = null;
    this.pointerDownModifier = 'none';
    this.cleanupDrag(committed);
  }

  private onDragKey(e: KeyboardEvent): void {
    if (e.key === 'Escape' && dragController.isActive()) {
      e.preventDefault();
      dragController.cancel();
      this.cleanupDrag(false);
      return;
    }
    // Any other key event (down or up) while dragging: refresh the
    // copy-mode flag so the pickup pill reflects whether Ctrl/Option
    // is currently held. KeyboardEvent's ctrlKey/altKey reflect the
    // post-event state, which is what we want for both directions.
    if (dragController.isActive()) {
      dragController.setCopyMode(isCopyModifier(e));
    }
  }

  private startDrag(): void {
    const startEntry = this.dragStartEntry;
    if (!startEntry || !this.view) return;

    // Decide which entries to drag: the multi-selection (if the drag
    // origin is part of one) or just the start entry.
    let entriesToDrag: HeadingEntry[];
    if (
      startEntry.id != null &&
      this.selectedIds.has(startEntry.id) &&
      this.selectedIds.size > 1 &&
      this.currentDoc
    ) {
      // Multi-drag: walk all entries in document order and keep the
      // selected ones. This preserves their original relative order
      // in the source-items list.
      const all = collectHeadings(this.currentDoc);
      entriesToDrag = all.filter(
        (e) => e.id != null && this.selectedIds.has(e.id),
      );
    } else {
      entriesToDrag = [startEntry];
    }

    const items: DragItem[] = [];
    for (const e of entriesToDrag) {
      const range = this.computeHeadingRange(e);
      if (!range) continue;
      items.push({
        from: range.from,
        to: range.to,
        id: e.id,
        type: e.type,
        level: e.level,
        label: e.text,
      });
    }
    if (items.length === 0) return;

    // Pickup pill is created BEFORE begin so the visual lands as soon
    // as the drag fires. Drop indicators on both surfaces are
    // rendered by their respective subscriptions reacting to the
    // controller's 'begin' event.
    this.createPickupPill(items);
    dragController.begin({ view: this.view, items });

    // Mark all dragged source <li>s.
    const idsBeingDragged = new Set(
      items.map((it) => it.id).filter((id): id is string => id != null),
    );
    for (const [li, entry] of this.liEntries) {
      if (entry.id != null && idsBeingDragged.has(entry.id)) {
        li.classList.add('pmd-nav-item-dragging');
      }
    }
  }

  private cleanupDrag(committed: boolean): void {
    let needsRerender = false;

    // On cancel: restore any remaining auto-expanded entries (the
    // primary restore happens during drag-off in maybeRestoreAuto-
    // Expanded; this is a safety net plus the cancel-revert path).
    // On commit: leave them as-is. If an auto-expanded entry is still
    // in the set at commit time, the user dropped inside its subtree
    // and so they should stay expanded.
    if (!committed && this.autoExpanded.size > 0) {
      for (const id of this.autoExpanded) {
        this.collapsed.add(id);
      }
      needsRerender = true;
    }
    this.autoExpanded.clear();
    this.cancelAllPendingRestore();

    // Drop indicators are cleaned up by the surface subscriptions
    // reacting to the 'end' event; we just clean up our pickup pill.
    this.removePickupPill();
    // Clear dragging class from every <li> that had it (multi-drag
    // can mark several at once).
    this.listEl
      .querySelectorAll('.pmd-nav-item-dragging')
      .forEach((el) => el.classList.remove('pmd-nav-item-dragging'));
    this.cancelAutoExpand();

    if (this.dragHandlersAttached) {
      document.removeEventListener('pointermove', this.boundOnDragMove);
      document.removeEventListener('pointerup', this.boundOnDragUp);
      document.removeEventListener('keydown', this.boundOnDragKey);
      document.removeEventListener('keyup', this.boundOnDragKeyUp);
      this.dragHandlersAttached = false;
    }
    this.dragStartLi = null;
    this.dragStartEntry = null;

    // After a successful drop the underlying doc has changed —
    // force-refresh now instead of waiting for the debounced heavy-
    // update tick (which would leave the nav out of sync for ~200ms).
    const newDoc = this.view ? this.view.state.doc : this.currentDoc;
    if (newDoc && newDoc !== this.currentDoc) {
      this.currentDoc = newDoc;
      needsRerender = true;
    }

    // Important: only re-render if something actually changed. A
    // plain click (no drag, no doc change) shouldn't tear down and
    // rebuild the <li> elements — that destroys the browser's
    // dblclick detection between the two clicks of a double-click.
    if (needsRerender && this.currentDoc) {
      this.render(this.currentDoc);
    }
  }

  private entryUnderPointer(x: number, y: number): HeadingEntry | null {
    const target = document.elementFromPoint(x, y);
    if (!target) return null;
    const li = (target as Element).closest?.('.pmd-nav-item') as HTMLLIElement | null;
    if (!li) return null;
    return this.liEntries.get(li) ?? null;
  }

  private renderDropIndicators(draggedLevel: number): void {
    this.removeDropIndicators();
    if (!this.view) return;
    const doc = this.view.state.doc;

    const items = Array.from(this.listEl.children).filter(
      (el): el is HTMLLIElement => el instanceof HTMLLIElement,
    );

    for (const li of items) {
      const entry = this.liEntries.get(li);
      if (!entry) continue;
      // Per the §14 design rule: drop slots exist only between siblings
      // of level <= dragged level. Skip deeper entries.
      if (entry.level > draggedLevel) continue;

      const range = this.computeHeadingRange(entry);
      if (!range) continue;

      const indicator = document.createElement('div');
      indicator.className = 'pmd-nav-drop-indicator';
      indicator.dataset['insertPos'] = String(range.from);
      this.listEl.insertBefore(indicator, li);
      this.dropIndicators.push(indicator);
    }

    // End-of-doc slot: always valid.
    const endIndicator = document.createElement('div');
    endIndicator.className = 'pmd-nav-drop-indicator';
    endIndicator.dataset['insertPos'] = String(doc.content.size);
    this.listEl.appendChild(endIndicator);
    this.dropIndicators.push(endIndicator);
  }

  private removeDropIndicators(): void {
    for (const el of this.dropIndicators) el.remove();
    this.dropIndicators = [];
  }

  private maybeAutoExpand(hoveredEntry: HeadingEntry | null): void {
    const session = dragController.getSession();
    if (!session || session.items.length === 0) return;
    const draggedLevel = session.items[0]!.level;

    if (!hoveredEntry || !hoveredEntry.id) {
      this.cancelAutoExpand();
      return;
    }
    // Only auto-expand collapsed entries that are SHALLOWER than the
    // dragged level — the user is drilling into a parent to find a
    // drop target inside.
    if (hoveredEntry.level >= draggedLevel) {
      this.cancelAutoExpand();
      return;
    }
    if (!this.collapsed.has(hoveredEntry.id)) {
      this.cancelAutoExpand();
      return;
    }

    if (this.autoExpandTarget === hoveredEntry.id) return; // already pending

    this.cancelAutoExpand();
    this.autoExpandTarget = hoveredEntry.id;
    this.autoExpandTimer = setTimeout(() => {
      this.autoExpandTimer = null;
      if (this.autoExpandTarget !== hoveredEntry.id) return;
      if (!this.collapsed.has(hoveredEntry.id!)) return;
      this.collapsed.delete(hoveredEntry.id!);
      this.autoExpanded.add(hoveredEntry.id!);
      if (this.currentDoc) {
        this.render(this.currentDoc);
        this.renderDropIndicators(draggedLevel);
      }
    }, 400);
  }

  /**
   * Maintain per-id pending re-collapse timers for auto-expanded
   * entries the pointer has left. An entry is "left" when the
   * pointer's current entry is some other entry outside that entry's
   * outline subtree. While outside, a 400ms timer counts down; if the
   * pointer comes back into the subtree before the timer fires, the
   * timer is cancelled — no flicker for quick passes through
   * neighboring areas. If the pointer is over a non-entry slot (e.g.
   * a drop indicator) or off the nav entirely, neither schedule nor
   * cancel — leave the existing pending state alone.
   */
  private maybeRestoreAutoExpanded(currentEntry: HeadingEntry | null): void {
    if (this.autoExpanded.size === 0) return;
    if (!this.currentDoc) return;
    if (!currentEntry) return;

    const allEntries = collectHeadings(this.currentDoc);

    for (const expandedId of this.autoExpanded) {
      const expandedIdx = allEntries.findIndex((e) => e.id === expandedId);
      if (expandedIdx < 0) {
        // Entry no longer exists (doc edited under us). Restore now.
        this.cancelPendingRestore(expandedId);
        this.executeRestore(expandedId);
        continue;
      }
      const expandedEntry = allEntries[expandedIdx]!;
      let inside = currentEntry.id === expandedId;
      if (!inside) {
        for (let i = expandedIdx + 1; i < allEntries.length; i++) {
          const e = allEntries[i]!;
          if (e.level <= expandedEntry.level) break;
          if (e.id === currentEntry.id) {
            inside = true;
            break;
          }
        }
      }
      if (inside) {
        this.cancelPendingRestore(expandedId);
      } else {
        this.schedulePendingRestore(expandedId);
      }
    }
  }

  private schedulePendingRestore(id: string): void {
    if (this.pendingRestoreTimers.has(id)) return; // already pending
    const timer = setTimeout(() => {
      this.pendingRestoreTimers.delete(id);
      this.executeRestore(id);
    }, 400);
    this.pendingRestoreTimers.set(id, timer);
  }

  private cancelPendingRestore(id: string): void {
    const timer = this.pendingRestoreTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.pendingRestoreTimers.delete(id);
    }
  }

  private cancelAllPendingRestore(): void {
    for (const timer of this.pendingRestoreTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingRestoreTimers.clear();
  }

  /** Re-collapse a single auto-expanded entry. Safe to call when the
   *  entry isn't actually in autoExpanded anymore (no-op). */
  private executeRestore(id: string): void {
    if (!this.autoExpanded.has(id)) return;
    this.autoExpanded.delete(id);
    this.collapsed.add(id);
    if (this.currentDoc) {
      this.render(this.currentDoc);
      const session = dragController.getSession();
      if (session) this.renderDropIndicators(session.items[0]!.level);
    }
  }

  private cancelAutoExpand(): void {
    if (this.autoExpandTimer) {
      clearTimeout(this.autoExpandTimer);
      this.autoExpandTimer = null;
    }
    this.autoExpandTarget = null;
  }

  private maybeAutoScroll(clientY: number): void {
    // Auto-scroll the nav list when the pointer is near its top/
    // bottom edges.
    const navRect = this.listEl.getBoundingClientRect();
    const margin = 30;
    if (clientY < navRect.top + margin) {
      this.listEl.scrollBy({ top: -10, behavior: 'auto' });
    } else if (clientY > navRect.bottom - margin) {
      this.listEl.scrollBy({ top: 10, behavior: 'auto' });
    }
    // Also auto-scroll the editor pane when the pointer is near its
    // edges — the user can drag from the nav into a portion of the
    // doc that isn't visible yet.
    const editorEl = document.getElementById('editor');
    if (!editorEl) return;
    const editorRect = editorEl.getBoundingClientRect();
    const inEditorX = clientY >= editorRect.top && clientY <= editorRect.bottom;
    if (!inEditorX) return;
    if (clientY < editorRect.top + margin) {
      editorEl.scrollBy({ top: -10, behavior: 'auto' });
    } else if (clientY > editorRect.bottom - margin) {
      editorEl.scrollBy({ top: 10, behavior: 'auto' });
    }
  }

  private createPickupPill(items: DragItem[]): void {
    this.removePickupPill();
    const pill = document.createElement('div');
    pill.className = 'pmd-nav-pickup-pill';
    // Wrap the text in an inner span so text-overflow / ellipsis can
    // clip JUST the text. The copy-mode `+` badge attaches to the
    // pill itself via `::after` and overflows past its bounds — if
    // the clip lived on the pill, the badge would get cropped too.
    const text = document.createElement('span');
    text.className = 'pmd-nav-pickup-pill-text';
    if (items.length === 1) {
      const label = items[0]!.label.trim() || `(empty ${items[0]!.type})`;
      text.textContent = label.length > 40 ? label.slice(0, 38) + '…' : label;
    } else {
      // Use a uniform-type label when all items share a type; fall
      // back to a generic count when types are mixed (e.g. a level-4
      // selection mixing tags and analytics).
      const allSameType = items.every((i) => i.type === items[0]!.type);
      if (allSameType) {
        const t = items[0]!.type;
        const typeLabel = TYPE_LABEL[t] ?? t;
        text.textContent = `${items.length} ${typeLabel}s`;
      } else {
        text.textContent = `${items.length} headings`;
      }
    }
    pill.appendChild(text);
    document.body.appendChild(pill);
    this.pickupPill = pill;
  }

  private updatePickupPill(x: number, y: number): void {
    if (!this.pickupPill) return;
    this.pickupPill.style.left = `${x + 12}px`;
    this.pickupPill.style.top = `${y + 12}px`;
    this.syncPickupPillCopyBadge();
  }

  private syncPickupPillCopyBadge(): void {
    if (!this.pickupPill) return;
    this.pickupPill.classList.toggle(
      'pmd-nav-pickup-pill-copy',
      dragController.isCopyMode(),
    );
  }

  private removePickupPill(): void {
    if (this.pickupPill) {
      this.pickupPill.remove();
      this.pickupPill = null;
    }
  }

  /**
   * Click handler for the level buttons. Behaves like Word's "Show
   * Heading N" — collapses every heading at level ≥ N (and expands
   * every heading at level < N). Acts as a bulk reset; the user can
   * still selectively expand/collapse individual entries via the
   * chevrons afterwards.
   */
  private setMaxLevel(level: number): void {
    if (level < 1 || level > 4) return;
    const isAlreadyAtLevel = level === this.maxLevel;
    // Order matters: update the collapsed state for the NEW level before
    // writing to the settings store. The settings subscriber fires
    // synchronously and triggers render — so collapsed needs to be
    // up-to-date before that render happens.
    this.applyMaxLevelToCollapseState(level);
    if (this.localMaxLevel != null) {
      // Multi-pane: per-instance max level. Update locally; the
      // settings subscriber doesn't drive us (each pane's filter
      // is independent).
      this.localMaxLevel = level;
      this.updateLevelButtonsActive();
      if (this.currentDoc) this.render(this.currentDoc);
      return;
    }
    if (isAlreadyAtLevel) {
      // Settings.set short-circuits when the value is unchanged, so no
      // subscriber would fire and the freshly-reset collapse state
      // wouldn't reach the UI. Render directly. This is also the path
      // that lets clicking the active level button "reset" any manual
      // chevron expansions/collapses.
      if (this.currentDoc) this.render(this.currentDoc);
    } else {
      settings.set('navMaxLevel', level);
    }
  }

  private updateLevelButtonsActive(): void {
    for (const btn of this.levelButtons) {
      const lvl = parseInt(btn.dataset['level'] ?? '0', 10);
      btn.classList.toggle('pmd-nav-level-btn-active', lvl === this.maxLevel);
    }
  }

  // ---------------------------------------------- Context menu ----

  private openContextMenu(x: number, y: number, entry: HeadingEntry): void {
    closeAnyOpenContextMenu();

    const menu = document.createElement('div');
    menu.className = 'pmd-nav-context-menu';

    const items: ContextMenuItem[] = [
      {
        kind: 'item',
        label: 'Select heading and contents',
        action: () => this.selectHeadingAndContents(entry),
      },
      {
        kind: 'item',
        label: 'Copy heading and contents',
        action: () => { void this.copyHeadingAndContents(entry); },
      },
      {
        kind: 'item',
        label: 'Delete heading and contents',
        action: () => this.deleteHeadingAndContents(entry),
      },
      { kind: 'separator' },
      ...[1, 2, 3, 4].map((lvl): ContextMenuItem => ({
        kind: 'item',
        label: `Show heading level ${lvl}`,
        checked: lvl === this.maxLevel,
        action: () => this.setMaxLevel(lvl),
      })),
    ];

    for (const item of items) {
      if (item.kind === 'separator') {
        const sep = document.createElement('div');
        sep.className = 'pmd-nav-context-separator';
        menu.appendChild(sep);
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pmd-nav-context-item';
      if (item.checked) btn.classList.add('pmd-nav-context-item-checked');
      btn.textContent = item.label;
      btn.addEventListener('click', () => {
        item.action();
        closeAnyOpenContextMenu();
      });
      menu.appendChild(btn);
    }

    document.body.appendChild(menu);

    // Position the menu, clamping to viewport.
    const rect = menu.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 4;
    const maxY = window.innerHeight - rect.height - 4;
    menu.style.left = `${Math.min(x, Math.max(0, maxX))}px`;
    menu.style.top = `${Math.min(y, Math.max(0, maxY))}px`;

    openContextMenuEl = menu;
    setTimeout(() => {
      window.addEventListener('mousedown', maybeCloseContextMenu, { capture: true });
      window.addEventListener('keydown', maybeCloseContextMenu, { capture: true });
    });
  }

  /**
   * Compute the doc range covering a heading and everything "below" it
   * in the outline. Returns null if it can't be resolved.
   *
   * - Tag (always inside a card) → the parent card.
   * - Analytic inside an analytic_unit → the unit.
   * - Analytic inside a card (cite-position) → the card.
   * - Pocket / Hat / Block → from the heading to just before the next
   *   equal-or-shallower heading (or end of doc).
   */
  private computeHeadingRange(
    entry: HeadingEntry,
  ): { from: number; to: number; useNodeSelection: boolean } | null {
    if (!this.view) return null;
    return computeHeadingRange(this.view.state.doc, entry);
  }

  private selectHeadingAndContents(entry: HeadingEntry): void {
    if (!this.view) return;
    const range = this.computeHeadingRange(entry);
    if (!range) return;
    const doc = this.view.state.doc;
    const tr = this.view.state.tr;
    tr.setSelection(
      range.useNodeSelection
        ? NodeSelection.create(doc, range.from)
        : TextSelection.create(doc, range.from, range.to),
    );
    tr.scrollIntoView();
    this.view.dispatch(tr);
    this.view.focus();
  }

  /** Delete the heading and its outline subtree. Undo via Cmd+Z. */
  private deleteHeadingAndContents(entry: HeadingEntry): void {
    if (!this.view) return;
    const range = this.computeHeadingRange(entry);
    if (!range) return;
    const tr = this.view.state.tr.delete(range.from, range.to);
    this.view.dispatch(tr);
  }

  /**
   * Copy the heading + subtree to the clipboard as both HTML and plain
   * text. Doesn't move focus or change the selection.
   */
  private async copyHeadingAndContents(entry: HeadingEntry): Promise<void> {
    if (!this.view) return;
    const range = this.computeHeadingRange(entry);
    if (!range) return;
    const slice = this.view.state.doc.slice(range.from, range.to);

    const serializer = DOMSerializer.fromSchema(this.view.state.schema);
    const tmp = document.createElement('div');
    tmp.appendChild(serializer.serializeFragment(slice.content));
    const html = tmp.innerHTML;
    const text = slice.content.textBetween(0, slice.content.size, '\n', '\n');

    try {
      if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': new Blob([html], { type: 'text/html' }),
            'text/plain': new Blob([text], { type: 'text/plain' }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(text);
      }
    } catch (err) {
      console.error('copy heading failed:', err);
    }
  }

  /**
   * Scroll the corresponding heading element into view *without* moving
   * the cursor or focusing the editor. Headings carry a `data-id` attr
   * (per their toDOM); we look that up in the rendered DOM and scroll
   * to it.
   */
  private jumpTo(entry: HeadingEntry): void {
    if (!this.view) return;

    // Place the cursor at the start of the heading's content. entry.pos
    // is the position right before the heading node; +1 steps inside
    // its content. Wrap in try/catch in case the doc has shifted out
    // from under the entry (e.g., after rapid edits).
    try {
      const tr = this.view.state.tr.setSelection(
        TextSelection.create(this.view.state.doc, entry.pos + 1),
      );
      this.view.dispatch(tr);
      this.view.focus();
    } catch {
      // Fall through to scroll-only behavior if the position is stale.
    }

    if (entry.id) {
      const target = this.view.dom.querySelector<HTMLElement>(`[data-id="${cssEscape(entry.id)}"]`);
      if (target) {
        target.scrollIntoView({ behavior: 'auto', block: 'start' });
        return;
      }
    }

    // Fallback: resolve the doc position and scroll the editor's
    // closest containing element into view.
    const domAtPos = this.view.domAtPos(entry.pos);
    let el: Node | null = domAtPos.node;
    while (el && el.nodeType !== Node.ELEMENT_NODE) el = el.parentNode;
    if (el && (el as Element).scrollIntoView) {
      (el as Element).scrollIntoView({ behavior: 'auto', block: 'start' });
    }
  }
}

// ---------------------------------------------- Context menu plumbing

interface ContextMenuItemBase {
  kind: 'item';
  label: string;
  action: () => void;
  checked?: boolean;
}
interface ContextMenuSeparator { kind: 'separator' }
type ContextMenuItem = ContextMenuItemBase | ContextMenuSeparator;

let openContextMenuEl: HTMLElement | null = null;

function closeAnyOpenContextMenu(): void {
  if (openContextMenuEl) {
    openContextMenuEl.remove();
    openContextMenuEl = null;
    window.removeEventListener('mousedown', maybeCloseContextMenu, { capture: true });
    window.removeEventListener('keydown', maybeCloseContextMenu, { capture: true });
  }
}

function maybeCloseContextMenu(e: MouseEvent | KeyboardEvent): void {
  if (e instanceof KeyboardEvent) {
    if (e.key === 'Escape') closeAnyOpenContextMenu();
    return;
  }
  if (!openContextMenuEl) return;
  if (!openContextMenuEl.contains(e.target as Node)) {
    closeAnyOpenContextMenu();
  }
}

/** Minimal CSS.escape polyfill for jsdom-style environments. */
function cssEscape(s: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(s);
  }
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

