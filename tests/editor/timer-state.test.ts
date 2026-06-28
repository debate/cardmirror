/**
 * Editing the timer display in a prep mode writes that side's saved balance, so
 * the edit persists across mode switches (only Reset zeroes prep). Covers
 * `setActiveRemainingMs` — the state half of the editable-prep-time change.
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
