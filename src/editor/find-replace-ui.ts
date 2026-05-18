/**
 * Find / Replace floating bar.
 *
 * Sits in the upper-right of the editor surface. Two modes:
 *   - 'find' (Ctrl-F): just the find input + navigation + close.
 *   - 'replace' (Ctrl-H): adds the replace input + Replace + Replace All.
 *
 * Drives the editor's `findReplacePlugin` via transaction metas:
 *   - User types in the find input → debounced `setQuery` meta.
 *   - Toggle case-sensitive / whole-word → re-sends `setQuery` with the
 *     updated flags.
 *   - Next / Prev buttons (or Enter / Shift-Enter in the find input)
 *     → `navigate` meta, followed by `scrollToCurrentMatch`.
 *   - Replace / Replace All buttons → `runReplace` / `runReplaceAll`
 *     commands.
 *
 * The bar manages its own DOM lifecycle — created on first open,
 * hidden via `display: none` after that. Closing restores focus to
 * the editor.
 */

import type { EditorView } from 'prosemirror-view';
import {
  findReplaceKey,
  runReplace,
  runReplaceAll,
  scrollToCurrentMatch,
  type FindReplaceState,
} from './find-replace-plugin.js';

type Mode = 'find' | 'replace';

export class FindReplaceBar {
  private root: HTMLElement;
  private findInput: HTMLInputElement;
  private replaceInput: HTMLInputElement;
  private replaceRow: HTMLElement;
  private caseSensitiveCheckbox: HTMLInputElement;
  private wholeWordCheckbox: HTMLInputElement;
  private countLabel: HTMLElement;
  private prevBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;
  private replaceBtn: HTMLButtonElement;
  private replaceAllBtn: HTMLButtonElement;
  private closeBtn: HTMLButtonElement;
  private getView: () => EditorView | null;
  private mode: Mode = 'find';
  private setQueryTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeView: (() => void) | null = null;

  constructor(getView: () => EditorView | null) {
    this.getView = getView;
    this.root = document.createElement('div');
    this.root.className = 'pmd-find-bar';
    this.root.hidden = true;

    // Row 1: find input + toggles + count + nav + close.
    const findRow = document.createElement('div');
    findRow.className = 'pmd-find-row';

    this.findInput = document.createElement('input');
    this.findInput.type = 'text';
    this.findInput.placeholder = 'Find';
    this.findInput.className = 'pmd-find-input';
    findRow.appendChild(this.findInput);

    this.caseSensitiveCheckbox = this.buildToggle(
      findRow,
      'pmd-find-case',
      'Aa',
      'Match case',
    );
    this.wholeWordCheckbox = this.buildToggle(
      findRow,
      'pmd-find-word',
      'W',
      'Whole word',
    );

    this.countLabel = document.createElement('span');
    this.countLabel.className = 'pmd-find-count';
    this.countLabel.textContent = '0 of 0';
    findRow.appendChild(this.countLabel);

    this.prevBtn = this.buildIconButton(findRow, '‹', 'Previous match');
    this.nextBtn = this.buildIconButton(findRow, '›', 'Next match');
    this.closeBtn = this.buildIconButton(findRow, '×', 'Close find');
    this.closeBtn.classList.add('pmd-find-close');

    this.root.appendChild(findRow);

    // Row 2: replace input + Replace + Replace All.
    this.replaceRow = document.createElement('div');
    this.replaceRow.className = 'pmd-find-replace-row';
    this.replaceInput = document.createElement('input');
    this.replaceInput.type = 'text';
    this.replaceInput.placeholder = 'Replace';
    this.replaceInput.className = 'pmd-find-input pmd-find-replace-input';
    this.replaceRow.appendChild(this.replaceInput);
    this.replaceBtn = document.createElement('button');
    this.replaceBtn.type = 'button';
    this.replaceBtn.className = 'pmd-find-action';
    this.replaceBtn.textContent = 'Replace';
    this.replaceBtn.title = 'Replace current match';
    this.replaceRow.appendChild(this.replaceBtn);
    this.replaceAllBtn = document.createElement('button');
    this.replaceAllBtn.type = 'button';
    this.replaceAllBtn.className = 'pmd-find-action';
    this.replaceAllBtn.textContent = 'Replace All';
    this.replaceAllBtn.title = 'Replace every match';
    this.replaceRow.appendChild(this.replaceAllBtn);
    this.root.appendChild(this.replaceRow);

    document.body.appendChild(this.root);

    this.wireEvents();
  }

  private buildToggle(
    parent: HTMLElement,
    className: string,
    label: string,
    title: string,
  ): HTMLInputElement {
    const wrap = document.createElement('label');
    wrap.className = `pmd-find-toggle ${className}`;
    wrap.title = title;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    wrap.appendChild(cb);
    const txt = document.createElement('span');
    txt.textContent = label;
    wrap.appendChild(txt);
    parent.appendChild(wrap);
    return cb;
  }

  private buildIconButton(
    parent: HTMLElement,
    label: string,
    title: string,
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-find-icon-btn';
    btn.textContent = label;
    btn.title = title;
    parent.appendChild(btn);
    return btn;
  }

  private wireEvents(): void {
    this.findInput.addEventListener('input', () => this.scheduleSetQuery());
    this.caseSensitiveCheckbox.addEventListener('change', () => this.applyQueryNow());
    this.wholeWordCheckbox.addEventListener('change', () => this.applyQueryNow());

    this.findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.navigate(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
    this.replaceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.doReplace();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });

    this.prevBtn.addEventListener('click', () => this.navigate(-1));
    this.nextBtn.addEventListener('click', () => this.navigate(1));
    this.closeBtn.addEventListener('click', () => this.close());
    this.replaceBtn.addEventListener('click', () => this.doReplace());
    this.replaceAllBtn.addEventListener('click', () => this.doReplaceAll());
  }

  open(mode: Mode): void {
    this.mode = mode;
    this.root.hidden = false;
    this.replaceRow.hidden = mode === 'find';

    // Seed the input with the current selection (if non-empty + within
    // a single textblock), matching the Word / VS Code pattern.
    const view = this.getView();
    if (view && this.findInput.value === '') {
      const sel = view.state.selection;
      if (!sel.empty) {
        const sample = view.state.doc.textBetween(sel.from, sel.to, '', '');
        if (sample && !sample.includes('\n')) {
          this.findInput.value = sample;
        }
      }
    }

    this.findInput.focus();
    this.findInput.select();
    this.applyQueryNow();
    this.subscribeToStateChanges();
    this.syncCount();
  }

  close(): void {
    if (this.root.hidden) return;
    this.root.hidden = true;
    const view = this.getView();
    if (view) {
      view.dispatch(view.state.tr.setMeta(findReplaceKey, { type: 'clear' }));
      view.focus();
    }
    this.unsubscribeFromStateChanges();
  }

  isOpen(): boolean {
    return !this.root.hidden;
  }

  /** Re-run `setQuery` against the live editor with whatever's in
   *  the find input + toggles. Used both for the debounced
   *  text-input path and the immediate toggle-change path. */
  private applyQueryNow(): void {
    if (this.setQueryTimer !== null) {
      clearTimeout(this.setQueryTimer);
      this.setQueryTimer = null;
    }
    const view = this.getView();
    if (!view) return;
    const query = this.findInput.value;
    view.dispatch(
      view.state.tr.setMeta(findReplaceKey, {
        type: 'setQuery',
        query,
        caseSensitive: this.caseSensitiveCheckbox.checked,
        wholeWord: this.wholeWordCheckbox.checked,
      }),
    );
    scrollToCurrentMatch(view);
    this.syncCount();
  }

  private scheduleSetQuery(): void {
    if (this.setQueryTimer !== null) clearTimeout(this.setQueryTimer);
    // Length-scaled debounce. Short queries match a huge number of
    // runs on a big doc (each match also costs a decoration), so
    // we wait longer for the user to commit. Once the query is
    // specific enough (4+ chars) the match count drops to something
    // tractable and we fire close to immediately.
    //
    // Empty input clears synchronously — no work to do.
    const q = this.findInput.value;
    if (q.length === 0) {
      this.applyQueryNow();
      return;
    }
    const delay =
      q.length === 1 ? 400 :
      q.length === 2 ? 250 :
      q.length === 3 ? 150 :
                       60;
    this.setQueryTimer = setTimeout(() => {
      this.setQueryTimer = null;
      this.applyQueryNow();
    }, delay);
  }

  private navigate(dir: 1 | -1): void {
    const view = this.getView();
    if (!view) return;
    view.dispatch(
      view.state.tr.setMeta(findReplaceKey, { type: 'navigate', dir }),
    );
    scrollToCurrentMatch(view);
    this.syncCount();
  }

  private doReplace(): void {
    const view = this.getView();
    if (!view) return;
    const cmd = runReplace(this.replaceInput.value);
    cmd(view.state, view.dispatch.bind(view));
    scrollToCurrentMatch(view);
    this.syncCount();
  }

  private doReplaceAll(): void {
    const view = this.getView();
    if (!view) return;
    const cmd = runReplaceAll(this.replaceInput.value);
    cmd(view.state, view.dispatch.bind(view));
    this.syncCount();
  }

  private getState(): FindReplaceState | null {
    const view = this.getView();
    if (!view) return null;
    return findReplaceKey.getState(view.state) ?? null;
  }

  /** Listen for editor state changes so the count label stays in
   *  sync as the user types into the doc (matches re-scan on every
   *  doc-changing transaction). Cheap — we just re-read the
   *  plugin's state and update one text node. */
  private subscribeToStateChanges(): void {
    if (this.unsubscribeView) this.unsubscribeView();
    const view = this.getView();
    if (!view) return;
    const dom = view.dom;
    const handler = () => this.syncCount();
    // PM doesn't expose a "state-changed" event on the view, but
    // input + focus events fire after dispatch in practice. Pair
    // with a microtask after each user-driven dispatch from inside
    // the bar. This handler covers the case of edits inside the
    // editor while the bar is open.
    dom.addEventListener('input', handler);
    dom.addEventListener('keyup', handler);
    this.unsubscribeView = () => {
      dom.removeEventListener('input', handler);
      dom.removeEventListener('keyup', handler);
    };
  }

  private unsubscribeFromStateChanges(): void {
    if (this.unsubscribeView) {
      this.unsubscribeView();
      this.unsubscribeView = null;
    }
  }

  private syncCount(): void {
    const s = this.getState();
    if (!s || s.matches.length === 0) {
      this.countLabel.textContent = s && s.query ? 'No matches' : '0 of 0';
      this.prevBtn.disabled = true;
      this.nextBtn.disabled = true;
      this.replaceBtn.disabled = true;
      this.replaceAllBtn.disabled = s ? !s.query : true;
      return;
    }
    const cur = s.currentIndex < 0 ? 0 : s.currentIndex + 1;
    this.countLabel.textContent = `${cur} of ${s.matches.length}`;
    this.prevBtn.disabled = false;
    this.nextBtn.disabled = false;
    this.replaceBtn.disabled = false;
    this.replaceAllBtn.disabled = false;
  }
}
