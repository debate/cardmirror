/**
 * Ribbon "color panel" — three split buttons (Highlight / Background
 * / Font Color) with swatch-picker dropdowns and Word-style paintbrush
 * mode.
 *
 * Each control:
 *   - Main button: if selection is non-empty, applies the active color
 *     to it. If selection is empty, toggles a sticky paintbrush mode
 *     for that mark — subsequent drag-selects in the editor get the
 *     active color automatically until Escape or the button is clicked
 *     again. Behaviour mirrors Word's highlighter pen.
 *   - Arrow button: opens a 16-swatch picker. Top-left swatch is always
 *     the strip/automatic option (No highlight / No background /
 *     Automatic). Picking a swatch updates the persisted color and
 *     applies it to the current selection in one click.
 *
 * Active color persists via `settings.lastHighlightColor` /
 * `lastShadingColor` / `lastFontColor`; the bar under each main
 * button reflects the live value.
 */

import type { EditorView } from 'prosemirror-view';
import { TextSelection, type Command, type Transaction } from 'prosemirror-state';
import { settings } from './settings.js';
import {
  WORD_HIGHLIGHT_COLORS,
  highlightRgbFor,
} from './color-palette.js';
import {
  applyHighlight,
  applyShading,
  setHighlightColor,
  setShadingColor,
  setFontColor,
  primaryKeyFor,
  formatKeyForDisplay,
} from './ribbon-commands.js';
import { schema } from '../schema/index.js';

type ViewRef = { view: EditorView | null };
export type PaintbrushMode = 'highlight' | 'shading' | 'fontcolor';

export interface ColorPanelHandle {
  /** Toggle paint mode for the given target — turns it on if off,
   *  off if already on, or switches modes if a different one was on.
   *  Used by the keybinding-driven ribbon commands so users can arm
   *  the paintbrush without clicking the ribbon button. */
  togglePaintbrush(mode: PaintbrushMode): void;
}

interface ColorControlSetup {
  mainBtnId: string;
  arrowBtnId: string;
  pickerLabel: string;
  paintbrushMode: PaintbrushMode;
  /** Command issued when main button is clicked with a non-empty selection. */
  onMainClick: () => Command;
  /** Command applied per drag-select while paintbrush mode is active. */
  paintbrushApply: () => Command;
  /** Builds the swatch grid; calls `pick(value)` when a swatch is clicked. */
  buildPicker: (pick: (value: string | null) => void) => HTMLElement;
  /** Update the live indicator bar (and the font-color glyph) to reflect the active color. */
  updateIndicator: () => void;
}

export function wireColorPanel(viewRef: ViewRef): ColorPanelHandle {
  let activePaintbrush: PaintbrushMode | null = null;

  const controls: ColorControlSetup[] = [
    buildHighlightControl(),
    buildShadingControl(),
    buildFontColorControl(),
  ];

  // Platform-aware tooltips for the F-key-bound main buttons. Font
  // color has no hotkey so it keeps its plain label.
  for (const [btnId, label, cmdId] of [
    ['highlight-btn', 'Highlight', 'applyHighlight'],
    ['shading-btn', 'Background color', 'applyShading'],
  ] as const) {
    const btn = document.getElementById(btnId);
    if (!btn) continue;
    const key = formatKeyForDisplay(
      primaryKeyFor(cmdId as Parameters<typeof primaryKeyFor>[0]),
    );
    btn.setAttribute('title', key ? `${label} (${key})` : label);
  }

  function syncPaintbrushUI(): void {
    const view = viewRef.view;
    const editorEl = view?.dom as HTMLElement | undefined;
    if (editorEl) {
      editorEl.classList.remove(
        'pmd-paintbrush-highlight',
        'pmd-paintbrush-shading',
        'pmd-paintbrush-fontcolor',
      );
    }
    for (const id of ['highlight-btn', 'shading-btn', 'fontcolor-btn']) {
      document.getElementById(id)?.classList.remove('pmd-paintbrush-active');
    }
    if (activePaintbrush) {
      editorEl?.classList.add(`pmd-paintbrush-${activePaintbrush}`);
      document.getElementById(`${activePaintbrush}-btn`)?.classList.add('pmd-paintbrush-active');
    }
  }

  function setPaintbrush(mode: PaintbrushMode | null): void {
    activePaintbrush = mode;
    syncPaintbrushUI();
  }

  for (const c of controls) {
    const mainBtn = document.getElementById(c.mainBtnId) as HTMLButtonElement | null;
    const arrowBtn = document.getElementById(c.arrowBtnId) as HTMLButtonElement | null;
    if (!mainBtn || !arrowBtn) continue;

    // Don't steal focus — the command operates on the live editor selection.
    const preventBlur = (e: Event) => e.preventDefault();
    mainBtn.addEventListener('mousedown', preventBlur);
    arrowBtn.addEventListener('mousedown', preventBlur);

    mainBtn.addEventListener('click', () => {
      const view = viewRef.view;
      if (!view) return;
      const sel = view.state.selection;
      if (sel.empty) {
        // Toggle / switch paintbrush.
        setPaintbrush(activePaintbrush === c.paintbrushMode ? null : c.paintbrushMode);
        return;
      }
      // Selection present — apply directly via the matching command.
      const cmd = c.onMainClick();
      cmd(view.state, view.dispatch.bind(view));
      view.focus();
    });

    arrowBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openPicker(arrowBtn, c, viewRef);
    });

    c.updateIndicator();
  }

  // Sticky paintbrush — apply the active mark to every drag-selected
  // range while a paintbrush mode is on. Listen for mouseup *inside*
  // the editor so click-mouseup on ribbon buttons doesn't accidentally
  // re-apply the last selection. After applying, collapse the
  // selection to the end of the painted range so the user can see
  // what they just painted (Word's "lift the brush" UX).
  document.addEventListener('mouseup', (e) => {
    if (!activePaintbrush) return;
    const view = viewRef.view;
    if (!view) return;
    if (!view.dom.contains(e.target as Node)) return;
    const sel = view.state.selection;
    if (sel.empty) return;
    const cmd = controls.find((c) => c.paintbrushMode === activePaintbrush)?.paintbrushApply();
    if (!cmd) return;
    applyAndCollapseSelection(view, cmd);
  });

  // Escape clears paintbrush mode (Word convention).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && activePaintbrush) {
      setPaintbrush(null);
      e.preventDefault();
    }
  });

  settings.subscribe(() => {
    for (const c of controls) c.updateIndicator();
  });

  return {
    togglePaintbrush: (mode: PaintbrushMode) => {
      setPaintbrush(activePaintbrush === mode ? null : mode);
    },
  };
}

function buildHighlightControl(): ColorControlSetup {
  return {
    mainBtnId: 'highlight-btn',
    arrowBtnId: 'highlight-picker-btn',
    pickerLabel: 'Highlight color',
    paintbrushMode: 'highlight',
    onMainClick: () => applyHighlight(() => settings.get('lastHighlightColor')),
    // Paintbrush uses the toggle (applyHighlight, not setHighlightColor)
    // so re-painting a uniformly-highlighted range strips it.
    paintbrushApply: () => applyHighlight(() => settings.get('lastHighlightColor')),
    buildPicker: (pick) => {
      const grid = document.createElement('div');
      grid.className = 'pmd-color-picker-grid';
      // Top-left: "No highlight" strip swatch.
      grid.appendChild(buildStripSwatch('No highlight', () => pick(null)));
      for (const c of WORD_HIGHLIGHT_COLORS) {
        grid.appendChild(buildColorSwatch(c.rgb, c.label, () => pick(c.name)));
      }
      return grid;
    },
    updateIndicator: () => {
      const bar = document.getElementById('highlight-bar');
      if (!bar) return;
      const name = settings.get('lastHighlightColor');
      const rgb = highlightRgbFor(name) ?? 'FFFF00';
      bar.style.background = `#${rgb}`;
    },
  };
}

function buildShadingControl(): ColorControlSetup {
  return {
    mainBtnId: 'shading-btn',
    arrowBtnId: 'shading-picker-btn',
    pickerLabel: 'Background color',
    paintbrushMode: 'shading',
    onMainClick: () => applyShading(() => settings.get('lastShadingColor')),
    // Toggle, mirroring highlight paintbrush — re-painting an already-
    // shaded range strips the mark.
    paintbrushApply: () => applyShading(() => settings.get('lastShadingColor')),
    buildPicker: (pick) => {
      const grid = document.createElement('div');
      grid.className = 'pmd-color-picker-grid';
      // Top-left: "No background color" strip swatch.
      grid.appendChild(buildStripSwatch('No background color', () => pick(null)));
      for (const c of WORD_HIGHLIGHT_COLORS) {
        grid.appendChild(buildColorSwatch(c.rgb, c.label, () => pick(c.rgb)));
      }
      return grid;
    },
    updateIndicator: () => {
      const bar = document.getElementById('shading-bar');
      if (!bar) return;
      bar.style.background = `#${settings.get('lastShadingColor')}`;
    },
  };
}

function buildFontColorControl(): ColorControlSetup {
  return {
    mainBtnId: 'fontcolor-btn',
    arrowBtnId: 'fontcolor-picker-btn',
    pickerLabel: 'Font color',
    paintbrushMode: 'fontcolor',
    onMainClick: () => setFontColor(settings.get('lastFontColor')),
    paintbrushApply: () => setFontColor(settings.get('lastFontColor')),
    buildPicker: (pick) => {
      const grid = document.createElement('div');
      grid.className = 'pmd-color-picker-grid';
      // Top-left: "Automatic" — strip the font_color mark entirely.
      grid.appendChild(buildStripSwatch('Automatic', () => pick(null)));
      for (const c of WORD_HIGHLIGHT_COLORS) {
        grid.appendChild(buildColorSwatch(c.rgb, c.label, () => pick(c.rgb)));
      }
      return grid;
    },
    updateIndicator: () => {
      const bar = document.getElementById('fontcolor-bar');
      const glyph = document.getElementById('fontcolor-glyph');
      const v = settings.get('lastFontColor');
      const display = v ?? '000000';
      if (bar) bar.style.background = `#${display}`;
      if (glyph) glyph.style.color = `#${display}`;
    },
  };
}

function buildColorSwatch(rgb: string, label: string, onPick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pmd-color-swatch';
  btn.style.background = `#${rgb}`;
  btn.title = label;
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', onPick);
  return btn;
}

function buildStripSwatch(label: string, onPick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pmd-color-swatch pmd-swatch-none';
  btn.title = label;
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', onPick);
  return btn;
}

let openPickerEl: HTMLElement | null = null;
let openPickerDismiss: (() => void) | null = null;

function openPicker(
  anchor: HTMLElement,
  setup: ColorControlSetup,
  viewRef: ViewRef,
): void {
  if (openPickerEl) {
    const wasSame = openPickerEl.dataset['controlId'] === setup.arrowBtnId;
    closeOpenPicker();
    if (wasSame) return; // toggle closed
  }

  const picker = document.createElement('div');
  picker.className = 'pmd-color-picker';
  picker.dataset['controlId'] = setup.arrowBtnId;

  const handlePick = (value: string | null) => {
    const view = viewRef.view;
    if (!view) {
      closeOpenPicker();
      return;
    }

    if (setup.mainBtnId === 'highlight-btn') {
      if (value === null) {
        // "No highlight": strip across the selection. One-shot — does
        // not persist as the active color (lastHighlightColor stays put).
        stripMarkInSelection(view, 'highlight');
      } else {
        settings.set('lastHighlightColor', value);
        setHighlightColor(value)(view.state, view.dispatch.bind(view));
      }
    } else if (setup.mainBtnId === 'shading-btn') {
      if (value === null) {
        stripMarkInSelection(view, 'shading');
      } else {
        settings.set('lastShadingColor', value);
        setShadingColor(value)(view.state, view.dispatch.bind(view));
      }
    } else if (setup.mainBtnId === 'fontcolor-btn') {
      // Automatic = null persists; font color paintbrush then strips.
      settings.set('lastFontColor', value);
      setFontColor(value)(view.state, view.dispatch.bind(view));
    }

    view.focus();
    closeOpenPicker();
  };

  picker.appendChild(setup.buildPicker(handlePick));

  const label = document.createElement('div');
  label.className = 'pmd-color-picker-label';
  label.textContent = setup.pickerLabel;
  picker.appendChild(label);

  document.body.appendChild(picker);

  // Position below the anchor (shifted slightly left so the 4-column
  // grid isn't clipped by the narrow arrow button).
  const rect = anchor.getBoundingClientRect();
  picker.style.top = `${rect.bottom + 2}px`;
  picker.style.left = `${rect.left - 60}px`;

  const onDocPointerDown = (e: PointerEvent) => {
    if (!openPickerEl) return;
    const target = e.target as Node | null;
    if (target && openPickerEl.contains(target)) return;
    closeOpenPicker();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeOpenPicker();
  };
  document.addEventListener('pointerdown', onDocPointerDown);
  document.addEventListener('keydown', onKey);

  anchor.setAttribute('aria-expanded', 'true');

  openPickerEl = picker;
  openPickerDismiss = () => {
    document.removeEventListener('pointerdown', onDocPointerDown);
    document.removeEventListener('keydown', onKey);
    anchor.setAttribute('aria-expanded', 'false');
    picker.remove();
  };
}

function closeOpenPicker(): void {
  if (openPickerDismiss) openPickerDismiss();
  openPickerEl = null;
  openPickerDismiss = null;
}

/** One-shot strip of a named mark across the current selection. */
function stripMarkInSelection(view: EditorView, markName: 'highlight' | 'shading'): void {
  const sel = view.state.selection;
  if (sel.empty) return;
  const type = schema.marks[markName];
  if (!type) return;
  const tr = view.state.tr.removeMark(sel.from, sel.to, type);
  view.dispatch(tr);
}

/**
 * Run a paintbrush command and collapse the resulting selection to a
 * cursor at the end of the painted range. The "lift the brush" UX —
 * after mouseup, the selection disappears so the user can see what
 * they just painted without the selection highlight obscuring it.
 *
 * Captures the command's transaction (via a dispatch interceptor)
 * instead of dispatching twice, so undo treats the apply + collapse
 * as a single operation.
 */
function applyAndCollapseSelection(view: EditorView, cmd: Command): void {
  let captured: Transaction | null = null;
  const ok = cmd(view.state, (t) => { captured = t; });
  if (!ok || captured === null) return;
  const tr: Transaction = captured;
  tr.setSelection(TextSelection.create(tr.doc, tr.selection.to));
  view.dispatch(tr);
}
