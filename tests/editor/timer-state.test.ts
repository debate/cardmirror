/**
 * Editing the timer display in a prep mode writes that side's saved balance, so
 * the edit persists across mode switches (only Reset zeroes prep). Covers
 * `setActiveRemainingMs` — the state half of editable prep time.
 */
import { describe, it, expect } from 'vitest';
import {
  resetTimer,
  selectMode,
  setActiveRemainingMs,
  getTimerState,
  getPrepRemainingMs,
  getVisibleRemainingMs,
  loadSpeechPreset,
  pauseTimer,
  reconcileTimerPopout,
  setTimerPoppedOut,
  setTimerVisible,
  shownPrepSide,
  startTimer,
  togglePrepShownSide,
} from '../../src/editor/timer-state.js';

const MIN = 60 * 1000;

describe('setActiveRemainingMs', () => {
  it('edits the active prep side, and the edit sticks across mode switches', () => {
    resetTimer(10 * MIN); // mode 'speech', both prep balances at 10:00
    selectMode('affPrep');
    setActiveRemainingMs(7 * MIN); // fix the aff prep clock down to 7:00
    expect(getPrepRemainingMs(getTimerState(), 'aff')).toBe(7 * MIN);
    // Load a speech preset and come back WITHOUT resetting — the edit persists.
    loadSpeechPreset(6);
    selectMode('affPrep');
    expect(getPrepRemainingMs(getTimerState(), 'aff')).toBe(7 * MIN);
    // The other side is untouched.
    expect(getPrepRemainingMs(getTimerState(), 'neg')).toBe(10 * MIN);
  });

  it('edits the neg prep side independently', () => {
    resetTimer(8 * MIN);
    selectMode('negPrep');
    setActiveRemainingMs(2 * MIN);
    expect(getPrepRemainingMs(getTimerState(), 'neg')).toBe(2 * MIN);
    expect(getPrepRemainingMs(getTimerState(), 'aff')).toBe(8 * MIN);
  });

  it('in speech mode it sets the speech clock', () => {
    resetTimer(10 * MIN); // mode 'speech'
    setActiveRemainingMs(3 * MIN);
    expect(getVisibleRemainingMs(getTimerState())).toBe(3 * MIN);
  });
});

/**
 * Pop-out flag semantics: popping out implies visible (no
 * hidden-but-floating state), hiding retracts the pop-out (never
 * both, never neither-with-float), and boot reconciliation clears a
 * stale flag ONLY when no pop-out window actually exists — a
 * mode-switch reload with the float alive must keep the flag, or the
 * in-app panel would resurrect next to the float.
 */
describe('timer pop-out state', () => {
  it('popping out forces visible on', () => {
    setTimerVisible(false);
    setTimerPoppedOut(true);
    expect(getTimerState().poppedOut).toBe(true);
    expect(getTimerState().visible).toBe(true);
  });

  it('hiding the timer also retracts the pop-out', () => {
    setTimerPoppedOut(true);
    setTimerVisible(false);
    expect(getTimerState().visible).toBe(false);
    expect(getTimerState().poppedOut).toBe(false);
  });

  it('popping back in keeps the timer visible', () => {
    setTimerVisible(true);
    setTimerPoppedOut(true);
    setTimerPoppedOut(false);
    expect(getTimerState().poppedOut).toBe(false);
    expect(getTimerState().visible).toBe(true);
  });

  it('popping out does not pause a running clock', () => {
    resetTimer(10 * MIN);
    loadSpeechPreset(6);
    startTimer();
    setTimerPoppedOut(true);
    expect(getTimerState().running).toBe(true);
    pauseTimer();
    setTimerPoppedOut(false);
  });

  it('reconciliation clears a stale flag when no pop-out window exists', () => {
    setTimerPoppedOut(true);
    reconcileTimerPopout(false);
    expect(getTimerState().poppedOut).toBe(false);
  });

  it('reconciliation keeps the flag while the pop-out window is alive (mode-switch reload)', () => {
    setTimerPoppedOut(true);
    reconcileTimerPopout(true);
    expect(getTimerState().poppedOut).toBe(true);
    setTimerPoppedOut(false);
  });

  it('reconciliation never sets the flag on its own', () => {
    setTimerPoppedOut(false);
    reconcileTimerPopout(true);
    expect(getTimerState().poppedOut).toBe(false);
  });
});

/**
 * Compact panel's single-prep display side: an active prep mode
 * always wins; otherwise the sticky preference, updated by explicit
 * side choices anywhere. The switch is a pure display flip in
 * speech mode but a real mode switch (with pause) while a prep is
 * selected — a switch that only changed a hidden preference would
 * read as broken.
 */
describe('shownPrepSide / togglePrepShownSide', () => {
  it('follows the active prep mode', () => {
    resetTimer(10 * MIN);
    selectMode('negPrep');
    expect(shownPrepSide(getTimerState())).toBe('neg');
    expect(getTimerState().prepShownSide).toBe('neg'); // sticky side updated too
  });

  it('falls back to the sticky side in speech mode', () => {
    resetTimer(10 * MIN);
    selectMode('affPrep');
    loadSpeechPreset(6); // back to speech
    expect(getTimerState().mode).toBe('speech');
    expect(shownPrepSide(getTimerState())).toBe('aff');
  });

  it('toggling in speech mode flips the display side only', () => {
    resetTimer(10 * MIN); // speech, sticky side aff
    togglePrepShownSide();
    expect(getTimerState().mode).toBe('speech');
    expect(shownPrepSide(getTimerState())).toBe('neg');
  });

  it('toggling while a prep runs pauses and switches to the other side', () => {
    resetTimer(10 * MIN);
    selectMode('affPrep');
    startTimer();
    togglePrepShownSide();
    const s = getTimerState();
    expect(s.running).toBe(false);
    expect(s.mode).toBe('negPrep');
    expect(shownPrepSide(s)).toBe('neg');
    // Aff's balance survived the pause snapshot (still ≈ 10:00).
    expect(getPrepRemainingMs(s, 'aff')).toBeGreaterThan(9 * MIN);
  });
});
