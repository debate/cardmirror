/**
 * Mobile shell — view-first chrome for phones and tablets on the web
 * edition (SPEC-mobile-view.md). Mounted at boot by editor/index.ts
 * when `resolveMobileLayout` picks mobile; rides the single-doc
 * machinery (same mountView, open/save flows, recovery, home screen)
 * rather than running its own editor.
 *
 * Structure:
 *   app bar     ☰ title ↶ ↷ Aa ⋮
 *   #app        the existing single-doc scroller (PM view inside,
 *               never editable — see mobile-plugin.ts)
 *   mode bar    Read toggle (Move / Repair arrive in later phases)
 *   #status-bar the existing footer, restyled by mobile CSS
 *
 * The outline drawer hosts the SAME NavigationPanel instance the
 * desktop sidebar uses — its mount element (#nav-panel) is relocated
 * into the drawer, so caret tracking, level filters, and
 * click-to-jump keep working unchanged.
 */

import { TextSelection } from 'prosemirror-state';
import { settings } from './settings.js';
import { getActiveView, getNavPanel, runRibbon } from './index.js';
import { readModeAwareUndo, readModeAwareRedo } from './read-mode-plugin.js';
import { mobileDensity } from './mobile-layout.js';
import {
  setMobileMoveMode,
  onMobileUnitTapped,
  setMobileUnitSelection,
} from './mobile-plugin.js';
import {
  moveInsertPos,
  sendToEntryInsertPos,
  unitRangeAtPos,
  executeUnitMove,
  type UnitRange,
} from './structural-move.js';
import { preciseScrollIntoView } from './precise-scroll.js';
import { showToast } from './toast.js';

const ZOOM_MIN = 50;
const ZOOM_MAX = 200;

let mounted = false;
let drawerApi: { open: () => void; close: () => void } | null = null;

export function mountMobileShell(): void {
  if (mounted) return;
  mounted = true;
  document.body.classList.add('pmd-mobile', `pmd-mobile-${mobileDensity(window.innerWidth)}`);

  const appBar = buildAppBar();
  document.body.insertBefore(appBar, document.body.firstChild);
  const { drawer, scrim, openDrawer, closeDrawer } = buildDrawer();
  drawerApi = { open: openDrawer, close: closeDrawer };
  document.body.appendChild(scrim);
  document.body.appendChild(drawer);
  document.body.appendChild(buildModeBar());
  document.body.appendChild(buildMoveSheet());
  onMobileUnitTapped(handleUnitTapped);
  installPinchZoom();
  installEdgeSwipe(openDrawer);

  // ☰ in the app bar drives the drawer.
  appBar.querySelector<HTMLButtonElement>('.pmd-mappbar-drawer')!
    .addEventListener('click', () => {
      if (document.body.classList.contains('pmd-mobile-drawer-open')) closeDrawer();
      else openDrawer();
    });
}

// ─── App bar ───────────────────────────────────────────────────────

function buildAppBar(): HTMLElement {
  const bar = document.createElement('header');
  bar.className = 'pmd-mobile-appbar';

  const drawerBtn = iconButton('☰', 'Outline', 'pmd-mappbar-drawer');
  bar.appendChild(drawerBtn);

  const title = document.createElement('span');
  title.className = 'pmd-mappbar-title';
  bar.appendChild(title);
  syncTitle(title);

  // Undo / redo are permanent app-bar residents (markers, moves and
  // repairs all live in PM history); a no-op tap is harmless, so no
  // enabled-state tracking is needed.
  const undoBtn = iconButton('↶', 'Undo', 'pmd-mappbar-undo');
  undoBtn.addEventListener('click', () => {
    const view = getActiveView();
    if (view) readModeAwareUndo(view.state, view.dispatch.bind(view), view);
  });
  bar.appendChild(undoBtn);
  const redoBtn = iconButton('↷', 'Redo', 'pmd-mappbar-redo');
  redoBtn.addEventListener('click', () => {
    const view = getActiveView();
    if (view) readModeAwareRedo(view.state, view.dispatch.bind(view), view);
  });
  bar.appendChild(redoBtn);

  const displayBtn = iconButton('Aa', 'Display options', 'pmd-mappbar-display');
  displayBtn.addEventListener('click', () => toggleSheet(buildDisplaySheet));
  bar.appendChild(displayBtn);

  const menuBtn = iconButton('⋮', 'Menu', 'pmd-mappbar-menu');
  menuBtn.addEventListener('click', () => toggleSheet(buildOverflowSheet));
  bar.appendChild(menuBtn);

  return bar;
}

/** Mirror the window title (sans app suffix) into the app bar. The
 *  single-doc title flow already maintains document.title on every
 *  open/save/dirty change; observing it avoids new exports. */
function syncTitle(el: HTMLSpanElement): void {
  const apply = (): void => {
    el.textContent = document.title.replace(/\s*[—-]\s*CardMirror\s*$/, '') || 'CardMirror';
  };
  apply();
  const titleEl = document.querySelector('title');
  if (titleEl) {
    new MutationObserver(apply).observe(titleEl, { childList: true });
  }
}

function iconButton(glyph: string, label: string, cls: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `pmd-mappbar-btn ${cls}`;
  btn.textContent = glyph;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  return btn;
}

// ─── Outline drawer ────────────────────────────────────────────────

function buildDrawer(): {
  drawer: HTMLElement;
  scrim: HTMLElement;
  openDrawer: () => void;
  closeDrawer: () => void;
} {
  const drawer = document.createElement('div');
  drawer.className = 'pmd-mobile-drawer';
  const scrim = document.createElement('div');
  scrim.className = 'pmd-mobile-scrim';

  // Adopt the desktop nav mount point wholesale — the NavigationPanel
  // instance inside keeps its EditorView attachment and caret sync.
  const navEl = document.getElementById('nav-panel');
  if (navEl) drawer.appendChild(navEl);
  // The drawer must never be emptied by the desktop "hide nav pane"
  // toggle; visibility is the drawer's own open/closed state.
  settings.set('navPaneVisible', true);

  const openDrawer = (): void => {
    document.body.classList.add('pmd-mobile-drawer-open');
  };
  const closeDrawer = (): void => {
    document.body.classList.remove('pmd-mobile-drawer-open');
    // Dismissing the drawer always cancels a pending "Send to…" —
    // idempotent when none is active.
    destModeActive = false;
    getNavPanel().exitDestinationMode();
  };
  scrim.addEventListener('click', closeDrawer);
  // Jumping somewhere is the end of a navigation — dismiss (overlay
  // densities only; the tablet rail stays put via CSS, where this
  // class toggle has no effect). In destination mode the Send-to
  // callback owns the drawer: an invalid target keeps it open.
  drawer.addEventListener('click', (e) => {
    if (destModeActive) return;
    if ((e.target as HTMLElement).closest('.pmd-nav-item')) {
      window.setTimeout(closeDrawer, 120);
    }
  });
  return { drawer, scrim, openDrawer, closeDrawer };
}

/** Left-edge swipe opens the drawer (phone density). */
function installEdgeSwipe(openDrawer: () => void): void {
  let startX = -1;
  let startY = -1;
  let pointerId = -1;
  window.addEventListener('pointerdown', (e) => {
    if (e.clientX > 24) return;
    startX = e.clientX;
    startY = e.clientY;
    pointerId = e.pointerId;
  });
  window.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const dy = Math.abs(e.clientY - startY);
    if (dx > 36 && dy < 48) {
      pointerId = -1;
      openDrawer();
    }
  });
  window.addEventListener('pointerup', () => {
    pointerId = -1;
  });
}

// ─── Mode bar ──────────────────────────────────────────────────────

function buildModeBar(): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'pmd-mobile-modebar';

  const readBtn = document.createElement('button');
  readBtn.type = 'button';
  readBtn.className = 'pmd-mobile-mode-btn pmd-mobile-mode-read';
  readBtn.textContent = '◉ Read';
  readBtn.title = 'Read mode — highlights and cites only; tap text to drop a reading marker';
  const syncRead = (): void => {
    readBtn.classList.toggle('pmd-mode-active', settings.get('readMode'));
  };
  syncRead();
  settings.subscribe(syncRead);
  readBtn.addEventListener('click', () => {
    // Read and Move are mutually exclusive — both claim the tap.
    if (!settings.get('readMode') && moveMode) setMoveMode(false);
    runRibbon('toggleReadMode');
  });
  bar.appendChild(readBtn);

  moveBtn = document.createElement('button');
  moveBtn.type = 'button';
  moveBtn.className = 'pmd-mobile-mode-btn pmd-mobile-mode-move';
  moveBtn.textContent = '✥ Move';
  moveBtn.title = 'Move mode — tap a card or heading to pick it up';
  moveBtn.addEventListener('click', () => setMoveMode(!moveMode));
  bar.appendChild(moveBtn);

  // Repair mode lands in P4 (SPEC-mobile-view.md).
  return bar;
}

// ─── Move mode ─────────────────────────────────────────────────────

let moveMode = false;
let moveBtn: HTMLButtonElement | null = null;
let moveSheet: HTMLElement | null = null;
let moveSheetLabel: HTMLElement | null = null;
let currentUnit: UnitRange | null = null;
let destModeActive = false;

function setMoveMode(on: boolean): void {
  const view = getActiveView();
  if (!view) return;
  moveMode = on;
  moveBtn?.classList.toggle('pmd-mode-active', on);
  setMobileMoveMode(view, on);
  if (on) {
    // Move needs doc edits; read mode locks them (and owns taps).
    if (settings.get('readMode')) runRibbon('toggleReadMode');
    showToast('Tap a card or heading to pick it up');
  } else {
    currentUnit = null;
    hideMoveSheet();
    cancelDestinationMode();
  }
}

function handleUnitTapped(unit: UnitRange | null): void {
  currentUnit = unit;
  if (!unit) {
    hideMoveSheet();
    return;
  }
  showMoveSheet(unit);
}

function buildMoveSheet(): HTMLElement {
  const sheet = document.createElement('div');
  sheet.className = 'pmd-mobile-movesheet';
  sheet.hidden = true;
  moveSheet = sheet;

  moveSheetLabel = document.createElement('div');
  moveSheetLabel.className = 'pmd-mobile-movesheet-label';
  sheet.appendChild(moveSheetLabel);

  const row = document.createElement('div');
  row.className = 'pmd-mobile-movesheet-actions';
  const action = (
    label: string,
    title: string,
    run: () => void,
    cls = '',
  ): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `pmd-mobile-movesheet-btn ${cls}`;
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('click', run);
    row.appendChild(btn);
    return btn;
  };
  action('▲ Up', 'Move one step up', () => moveStep(-1));
  action('▼ Down', 'Move one step down', () => moveStep(1));
  action('⇪ Send to…', 'Pick a destination in the outline', startSendTo);
  action('⧉ Copy', 'Copy to the clipboard', copyUnit);
  action('⌫ Delete', 'Delete', deleteUnit, 'pmd-movesheet-danger');
  action('✕', 'Put down (stay in Move mode)', () => {
    const view = getActiveView();
    if (view) setMobileUnitSelection(view, null);
    currentUnit = null;
    hideMoveSheet();
  });
  sheet.appendChild(row);
  return sheet;
}

function showMoveSheet(unit: UnitRange): void {
  if (!moveSheet || !moveSheetLabel) return;
  const label = unit.label.trim() || '(untitled)';
  moveSheetLabel.textContent = `${unit.type === 'card' || unit.type === 'analytic_unit' ? 'Card' : unit.type[0]!.toUpperCase() + unit.type.slice(1)} — ${label}`;
  moveSheet.hidden = false;
}

function hideMoveSheet(): void {
  if (moveSheet) moveSheet.hidden = true;
}

/** After a successful move the transaction parks the selection at the
 *  top of the landed content — re-derive the unit there so the
 *  highlight and the sheet follow it. */
function reselectMovedUnit(view: NonNullable<ReturnType<typeof getActiveView>>): void {
  const unit = unitRangeAtPos(view.state.doc, view.state.selection.from);
  currentUnit = unit;
  setMobileUnitSelection(view, unit);
  if (unit) {
    showMoveSheet(unit);
    const dom = view.nodeDOM(unit.from);
    if (dom instanceof HTMLElement) preciseScrollIntoView(view, dom);
  } else {
    hideMoveSheet();
  }
}

function moveStep(dir: -1 | 1): void {
  const view = getActiveView();
  if (!view || !currentUnit) return;
  const insertPos = moveInsertPos(view.state.doc, currentUnit, dir);
  if (insertPos === null) {
    showToast(dir === -1 ? 'Already at the top' : 'Already at the bottom');
    return;
  }
  if (!executeUnitMove(view, currentUnit, insertPos)) {
    showToast("Can't move there");
    return;
  }
  reselectMovedUnit(view);
}

function startSendTo(): void {
  if (!currentUnit) return;
  destModeActive = true;
  getNavPanel().enterDestinationMode((entry) => {
    const view = getActiveView();
    if (!view || !currentUnit) {
      cancelDestinationMode();
      drawerApi?.close();
      return;
    }
    const insertPos = sendToEntryInsertPos(view.state.doc, entry);
    if (insertPos === null) {
      showToast("Can't drop there — pick another heading");
      return; // stay in destination mode
    }
    if (insertPos > currentUnit.from && insertPos < currentUnit.to) {
      showToast("Can't move a section into itself");
      return;
    }
    if (!executeUnitMove(view, currentUnit, insertPos)) {
      showToast("Can't move there");
      return;
    }
    destModeActive = false;
    drawerApi?.close(); // also exits destination mode
    reselectMovedUnit(view);
    showToast('Moved — ↶ to undo');
  });
  drawerApi?.open();
  showToast('Tap a destination in the outline');
}

function cancelDestinationMode(): void {
  destModeActive = false;
  getNavPanel().exitDestinationMode();
}

function copyUnit(): void {
  const view = getActiveView();
  if (!view || !currentUnit) return;
  // Park the caret inside the unit's head; the existing command
  // copies the heading + subtree at the cursor.
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.near(view.state.doc.resolve(currentUnit.from + 1)),
    ),
  );
  runRibbon('copyCurrentHeading');
  showToast('Copied');
}

function deleteUnit(): void {
  const view = getActiveView();
  if (!view || !currentUnit) return;
  const label = currentUnit.label.trim() || 'this';
  if (!window.confirm(`Delete "${label}"?`)) return;
  view.dispatch(view.state.tr.delete(currentUnit.from, currentUnit.to));
  currentUnit = null;
  hideMoveSheet();
  showToast('Deleted — ↶ to undo');
}

// ─── Bottom sheets (display options, overflow menu) ────────────────

let openSheetEl: HTMLElement | null = null;
let openSheetBuilder: (() => HTMLElement) | null = null;

function toggleSheet(builder: () => HTMLElement): void {
  // Tapping the same trigger twice closes; a different trigger swaps.
  const same = openSheetBuilder === builder;
  closeSheet();
  if (same) return;
  const sheet = builder();
  sheet.classList.add('pmd-mobile-sheet');
  document.body.appendChild(sheet);
  openSheetEl = sheet;
  openSheetBuilder = builder;
  const dismiss = (e: PointerEvent): void => {
    if (openSheetEl && !openSheetEl.contains(e.target as Node)) closeSheet();
  };
  // Defer so the opening tap doesn't immediately dismiss.
  window.setTimeout(() => {
    document.addEventListener('pointerdown', dismiss, { once: true });
  }, 0);
}

function closeSheet(): void {
  openSheetEl?.remove();
  openSheetEl = null;
  openSheetBuilder = null;
}

function buildDisplaySheet(): HTMLElement {
  const sheet = document.createElement('div');

  const zoomRow = document.createElement('div');
  zoomRow.className = 'pmd-msheet-row';
  const zoomHead = document.createElement('div');
  zoomHead.className = 'pmd-msheet-rowhead';
  const zoomLabel = document.createElement('span');
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(ZOOM_MIN);
  slider.max = String(ZOOM_MAX);
  slider.step = '5';
  const syncZoom = (): void => {
    slider.value = String(settings.get('zoomPct'));
    zoomLabel.textContent = `Text size — ${slider.value}%`;
  };
  syncZoom();
  slider.addEventListener('input', () => {
    settings.set('zoomPct', Number(slider.value));
    syncZoom();
  });
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'pmd-msheet-reset';
  reset.textContent = 'Reset';
  reset.addEventListener('click', () => {
    settings.set('zoomPct', 100);
    syncZoom();
  });
  zoomHead.appendChild(zoomLabel);
  zoomHead.appendChild(reset);
  zoomRow.appendChild(zoomHead);
  zoomRow.appendChild(slider);
  sheet.appendChild(zoomRow);

  const themeRow = document.createElement('div');
  themeRow.className = 'pmd-msheet-row';
  const themeLabel = document.createElement('span');
  themeLabel.textContent = 'Theme';
  themeRow.appendChild(themeLabel);
  const group = document.createElement('div');
  group.className = 'pmd-msheet-segment';
  for (const t of ['light', 'dark', 'system'] as const) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = t[0]!.toUpperCase() + t.slice(1);
    const sync = (): void => {
      btn.classList.toggle('pmd-mode-active', settings.get('theme') === t);
    };
    sync();
    settings.subscribe(sync);
    btn.addEventListener('click', () => settings.set('theme', t));
    group.appendChild(btn);
  }
  themeRow.appendChild(group);
  sheet.appendChild(themeRow);

  return sheet;
}

function buildOverflowSheet(): HTMLElement {
  const sheet = document.createElement('div');
  const item = (label: string, run: () => void): void => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-msheet-item';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      closeSheet();
      run();
    });
    sheet.appendChild(btn);
  };
  item('Open…', () => runRibbon('openFile'));
  item('New document', () => runRibbon('newDocument'));
  item('Export a copy…', () => runRibbon('saveAs'));
  item('Word count', () => runRibbon('wordCountSelection'));
  item('Settings', () => {
    void import('./mobile-settings-ui.js').then((m) => m.openMobileSettings());
  });
  item('Use desktop layout', () => {
    settings.set('mobileLayout', 'desktop');
    window.location.reload();
  });
  item('Home', () => runRibbon('goHome'));
  return sheet;
}

// ─── Pinch zoom ────────────────────────────────────────────────────

/** Two-finger pinch on the doc scroller drives the SAME content zoom
 *  as the desktop status-bar buttons (`zoomPct` → `--editor-zoom`,
 *  CSS `zoom` on the editor). Live preview writes the CSS variable
 *  directly; the setting commits once at gesture end (clamped, in
 *  5% steps) so cross-tab sync isn't spammed mid-gesture. */
function installPinchZoom(): void {
  const app = document.getElementById('app');
  if (!app) return;
  const pointers = new Map<number, { x: number; y: number }>();
  let startDist = 0;
  let startPct = 100;
  let badgeTimer = 0;

  const badge = document.createElement('div');
  badge.className = 'pmd-mobile-zoom-badge';
  badge.hidden = true;
  document.body.appendChild(badge);

  const dist = (): number => {
    const [a, b] = [...pointers.values()];
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  app.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      startDist = dist();
      startPct = settings.get('zoomPct');
    }
  });
  app.addEventListener(
    'pointermove',
    (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size !== 2 || startDist === 0) return;
      e.preventDefault();
      const pct = clampZoom(startPct * (dist() / startDist));
      document.documentElement.style.setProperty('--editor-zoom', String(pct / 100));
      badge.textContent = `${Math.round(pct)}%`;
      badge.hidden = false;
      window.clearTimeout(badgeTimer);
      badgeTimer = window.setTimeout(() => {
        badge.hidden = true;
      }, 800);
    },
    { passive: false },
  );
  const release = (e: PointerEvent): void => {
    if (!pointers.has(e.pointerId)) return;
    if (pointers.size === 2) {
      // Gesture ends — commit the final value through the settings
      // pipeline (applyZoom re-derives --editor-zoom from it).
      const livePct =
        Number(
          getComputedStyle(document.documentElement).getPropertyValue('--editor-zoom'),
        ) * 100 || startPct;
      settings.set('zoomPct', Math.round(clampZoom(livePct) / 5) * 5);
      startDist = 0;
    }
    pointers.delete(e.pointerId);
  };
  app.addEventListener('pointerup', release);
  app.addEventListener('pointercancel', release);
}

function clampZoom(pct: number): number {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, pct));
}
