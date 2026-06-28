/**
 * Built-in countdown timer UI.
 *
 * Renders the timer panel (display + buttons), wires click /
 * keyboard handlers to `timer-state.ts` actions, and runs a
 * per-window tick that updates the display labels off the shared
 * state. The panel is mounted into `#timer-panel` in `index.html`;
 * the per-window visibility toggle lives in settings (transient,
 * not persisted).
 *
 * Layout has two modes, switched by `pmd-timer-compact` on the
 * root element:
 *   Expanded → reset | display | (start/9/6/3) | (aff/neg)
 *   Compact  → display | (start/reset stacked) | (aff/neg)
 *
 * Editable display: when paused, clicking the display makes it
 * `contenteditable` in any mode. The user types MM:SS or seconds; on blur or
 * Enter we parse + `setActiveRemainingMs`, which writes the active mode's clock
 * (in a prep mode that adjusts that side's saved balance, not just the speech
 * timer).
 */

import { settings } from './settings.js';
import {
  configurePrepTotal,
  getPrepRemainingMs,
  getTimerState,
  getVisibleRemainingMs,
  loadSpeechPreset,
  pauseTimer,
  resetTimer,
  selectMode,
  setActiveRemainingMs,
  startTimer,
  subscribeTimer,
} from './timer-state.js';

/** Format ms as MM:SS, clamping to 0 and rounding upward to whole
 *  seconds so a running clock doesn't visually flash 0:00 a half-
 *  second before the actual end. */
function formatMs(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

/** Parse user-typed `MM:SS` or `SS` into ms. Returns null if
 *  unparseable. */
function parseTimeInput(s: string): number | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  const colonMatch = trimmed.match(/^(\d+):(\d{1,2})$/);
  if (colonMatch) {
    const m = parseInt(colonMatch[1]!, 10);
    const sec = parseInt(colonMatch[2]!, 10);
    if (sec >= 60) return null;
    return (m * 60 + sec) * 1000;
  }
  const intMatch = trimmed.match(/^\d+$/);
  if (intMatch) return parseInt(trimmed, 10) * 1000;
  return null;
}

let mounted = false;

/** Mount the timer UI into the panel placeholder in index.html.
 *  Idempotent — calling more than once no-ops after the first. */
export function mountTimerUI(): void {
  if (mounted) return;
  const panelEl = document.getElementById('timer-panel');
  if (!panelEl) return;
  mounted = true;
  // Pin to a const so closures defined further down retain the
  // narrowed type (TS doesn't propagate the null-check refinement
  // into later function declarations).
  const panel: HTMLElement = panelEl;

  panel.classList.add('pmd-timer-panel');
  // Flat element list — each element is positioned via CSS grid
  // rules keyed on its id, so compact mode can re-arrange them
  // without restructuring the DOM.
  panel.innerHTML = `
    <button id="timer-reset-btn" class="pmd-timer-reset" type="button"
            title="Reset all timers" aria-label="Reset all timers">↻</button>
    <div id="timer-display" class="pmd-timer-display"
         role="timer" aria-live="off"
         title="Click to edit when paused">0:00</div>
    <button id="timer-start-btn" class="pmd-timer-start" type="button"
            aria-label="Start or pause">▶</button>
    <button id="timer-preset-1-btn" class="pmd-timer-preset" type="button"
            data-preset-index="0"></button>
    <button id="timer-preset-2-btn" class="pmd-timer-preset" type="button"
            data-preset-index="1"></button>
    <button id="timer-preset-3-btn" class="pmd-timer-preset" type="button"
            data-preset-index="2"></button>
    <button id="timer-aff-btn" class="pmd-timer-prep pmd-timer-aff" type="button"
            aria-label="Affirmative prep"><span class="pmd-timer-prep-prefix">A:</span><span class="pmd-timer-prep-time" id="timer-aff-time">10:00</span></button>
    <button id="timer-neg-btn" class="pmd-timer-prep pmd-timer-neg" type="button"
            aria-label="Negative prep"><span class="pmd-timer-prep-prefix">N:</span><span class="pmd-timer-prep-time" id="timer-neg-time">10:00</span></button>
  `;

  const display = document.getElementById('timer-display') as HTMLDivElement;
  const startBtn = document.getElementById('timer-start-btn') as HTMLButtonElement;
  const resetBtn = document.getElementById('timer-reset-btn') as HTMLButtonElement;
  const affBtn = document.getElementById('timer-aff-btn') as HTMLButtonElement;
  const negBtn = document.getElementById('timer-neg-btn') as HTMLButtonElement;
  const affTime = document.getElementById('timer-aff-time') as HTMLSpanElement;
  const negTime = document.getElementById('timer-neg-time') as HTMLSpanElement;
  const presetBtns: HTMLButtonElement[] = [];
  for (let i = 0; i < 3; i++) {
    const b = document.getElementById(`timer-preset-${i + 1}-btn`) as HTMLButtonElement;
    presetBtns.push(b);
  }

  // ─── Click wiring ────────────────────────────────────────────
  startBtn.addEventListener('click', () => {
    const s = getTimerState();
    if (s.running) pauseTimer();
    else startTimer();
  });
  resetBtn.addEventListener('click', () => {
    const prepMs = settings.get('timerPrepMinutes') * 60 * 1000;
    resetTimer(prepMs);
  });
  affBtn.addEventListener('click', () => selectMode('affPrep'));
  negBtn.addEventListener('click', () => selectMode('negPrep'));
  for (const btn of presetBtns) {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset['presetIndex'] ?? '0', 10);
      const presets = settings.get('timerSpeechPresets');
      const minutes = presets[idx] ?? 0;
      loadSpeechPreset(minutes);
    });
  }

  // ─── Editable display ────────────────────────────────────────
  // Click the display while paused → contenteditable, in ANY mode. Blur or
  // Enter parses + commits via setActiveRemainingMs (which writes the active
  // mode's clock — so editing aff/neg prep adjusts that side's saved balance,
  // letting you fix a prep clock you started/stopped a touch late). Escape
  // cancels by re-rendering the current state.
  display.addEventListener('click', () => {
    const s = getTimerState();
    if (s.running) return;
    display.contentEditable = 'true';
    display.focus();
    // Select-all so a quick MM:SS retype replaces the value.
    const range = document.createRange();
    range.selectNodeContents(display);
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
  });
  const commitEdit = (): void => {
    if (display.contentEditable !== 'true') return;
    display.contentEditable = 'false';
    const parsed = parseTimeInput(display.textContent ?? '');
    if (parsed !== null) setActiveRemainingMs(parsed);
    render();
  };
  display.addEventListener('blur', commitEdit);
  display.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      display.contentEditable = 'false';
      render();
    }
  });

  // ─── Render loop ─────────────────────────────────────────────
  // Render whenever state changes (start/pause/preset/reset/mode-
  // switch) and tick once per ~250ms while running so the display
  // updates smoothly. Tick is light — just reads state + updates
  // text content; no state writes per tick.
  let tickTimer: number | null = null;
  function render(): void {
    if (display.contentEditable === 'true') return; // don't clobber user typing
    const s = getTimerState();
    const now = Date.now();
    display.textContent = formatMs(getVisibleRemainingMs(s, now));
    // Surface the mode so CSS can give the big display the same aff/neg
    // color / text treatment as the prep buttons (per `data-prep-label`) when
    // prep time is loaded — a presentational `::before` / color, so the text
    // node stays just the time.
    display.dataset['mode'] = s.mode;
    startBtn.textContent = s.running ? '⏸' : '▶';
    startBtn.setAttribute('aria-pressed', s.running ? 'true' : 'false');
    affTime.textContent = formatMs(getPrepRemainingMs(s, 'aff', now));
    negTime.textContent = formatMs(getPrepRemainingMs(s, 'neg', now));
    affBtn.classList.toggle('pmd-timer-prep-active', s.mode === 'affPrep');
    negBtn.classList.toggle('pmd-timer-prep-active', s.mode === 'negPrep');
    // Update preset labels from settings (changes when the user
    // edits speech presets or switches profile).
    const presets = settings.get('timerSpeechPresets');
    for (let i = 0; i < presetBtns.length; i++) {
      presetBtns[i]!.textContent = String(presets[i] ?? '');
    }
    // Flash-red gating — toggle a class when remaining ms is at or
    // below one of the configured flash thresholds (and timer is
    // running). The CSS rule does the actual flash animation.
    const flashEnabled = settings.get('timerFlashEnabled');
    const flashSeconds = settings.get('timerFlashSeconds');
    const visibleMs = getVisibleRemainingMs(s, now);
    const inFlashWindow =
      flashEnabled &&
      s.running &&
      visibleMs > 0 &&
      flashSeconds.some((sec) => {
        const threshMs = sec * 1000;
        return visibleMs <= threshMs && visibleMs > threshMs - 1000;
      });
    display.classList.toggle('pmd-timer-flash', inFlashWindow);
  }

  function ensureTick(): void {
    if (getTimerState().running && tickTimer === null) {
      tickTimer = window.setInterval(render, 250);
    } else if (!getTimerState().running && tickTimer !== null) {
      window.clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  subscribeTimer(() => {
    // Visibility lives in the timer state, so a cross-window
    // broadcast of `visible` needs to flip `panel.hidden` here.
    // Cheap to re-apply the whole chrome on any state change.
    applyChrome();
    render();
    ensureTick();
  });

  // Compact-mode + visibility wiring — read from settings on mount
  // and resync on every settings change.
  function applyChrome(): void {
    panel.classList.toggle('pmd-timer-compact', settings.get('timerCompact'));
    // CSS rules key on `data-prep-label` to show / hide the
    // A: / N: prefix and the blue / red color treatment.
    panel.setAttribute('data-prep-label', settings.get('timerPrepLabel'));
    // Visibility lives in the shared timer state (not settings)
    // so it broadcasts across windows. The pause-on-hide
    // behavior is handled inside `setTimerVisible` itself.
    panel.hidden = !getTimerState().visible;
  }
  applyChrome();
  settings.subscribe(() => {
    applyChrome();
    // Keep the prep-total cache in state in sync with the setting.
    configurePrepTotal(settings.get('timerPrepMinutes') * 60 * 1000);
    render();
  });

  // Initial render — paint whatever state we booted with.
  render();
  ensureTick();
}
