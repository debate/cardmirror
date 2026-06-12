/**
 * Editor spellcheck (viewport-scoped).
 *
 * The mechanism behind the `editorSpellcheck` setting: a custom checker
 * that flags misspellings in the *visible* part of the document — so,
 * unlike the browser's built-in checker, it catches words in opened /
 * imported text, not just words you're actively typing. It stays cheap
 * on huge debate docs by only ever scanning the screenful that's on
 * screen, re-checked after scroll/edit settles. The cost tracks
 * words-on-screen, not document size.
 *
 * Dictionary: nspell (Hunspell-in-JS) over the en `.aff`/`.dic`,
 * dynamically imported so the ~550KB dictionary is a separate async
 * chunk loaded only the first time spellcheck is switched on.
 */
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { settings } from './settings.js';
import { showToast } from './toast.js';

const key = new PluginKey<DecorationSet>('viewportSpellcheck');

/** Words the user added to their personal dictionary — persisted and
 *  global, applied to nspell so they're also dropped from suggestions. */
const USER_DICT_KEY = 'pmd-user-dictionary';
const userDict: Set<string> = loadUserDict();
/** Words the user chose to ignore this session — suppressed but not
 *  "learned" (not persisted, not added to nspell). */
const ignored = new Set<string>();

function loadUserDict(): Set<string> {
  try {
    const raw = localStorage.getItem(USER_DICT_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr.filter((x): x is string => typeof x === 'string'));
    }
  } catch {
    /* ignore corrupt store */
  }
  return new Set();
}
function persistUserDict(): void {
  try {
    localStorage.setItem(USER_DICT_KEY, JSON.stringify([...userDict]));
  } catch {
    /* localStorage full / disabled */
  }
}

/** Memoized lookups — debate text repeats words heavily, so a cache
 *  makes the second+ occurrence of every word free. */
const verdictCache = new Map<string, boolean>();
function isCorrect(w: string): boolean {
  if (ignored.has(w)) return true;
  let v = verdictCache.get(w);
  if (v === undefined) {
    v = spell!.correct(w);
    verdictCache.set(w, v);
  }
  return v;
}

/** Lazily-built nspell instance, shared across views. */
interface Speller {
  correct(w: string): boolean;
  suggest(w: string): string[];
  add(w: string): unknown;
}
let spell: Speller | null = null;
let building = false;
async function ensureSpell(onReady: () => void): Promise<void> {
  if (spell || building) return;
  building = true;
  try {
    const [{ default: nspell }, aff, dic] = await Promise.all([
      import('nspell'),
      import('./dict/en.aff?raw'),
      import('./dict/en.dic?raw'),
    ]);
    const s = nspell(aff.default, dic.default);
    for (const w of userDict) s.add(w); // teach it the user's words
    spell = s;
  } finally {
    building = false;
  }
  onReady();
}

// Latin words incl. internal apostrophes (don't / O'Brien).
const WORD_RE = /[A-Za-z][A-Za-z']*/g;

/** Doc range currently on screen, found via hit-testing the viewport
 *  top/bottom — O(log n), independent of doc size. */
function visibleRange(view: EditorView): { from: number; to: number } {
  const rect = (view.dom as HTMLElement).getBoundingClientRect();
  const left = rect.left + Math.min(40, Math.max(2, rect.width / 2));
  const size = view.state.doc.content.size;
  const topHit = view.posAtCoords({ left, top: 2 });
  const botHit = view.posAtCoords({ left, top: window.innerHeight - 2 });
  let from = topHit ? topHit.pos : 0;
  let to = botHit ? botHit.pos : size;
  if (from > to) [from, to] = [to, from];
  return { from: Math.max(0, from - 40), to: Math.min(size, to + 40) };
}

function computeDecos(view: EditorView): DecorationSet {
  if (!spell) return DecorationSet.empty;
  const { from, to } = visibleRange(view);
  const decos: Decoration[] = [];
  view.state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText || !node.text) return;
    const text = node.text;
    WORD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WORD_RE.exec(text)) !== null) {
      // Trim a trailing possessive apostrophe ("dogs'", "James'") so the
      // base word is what gets checked — and underlined — not the
      // apostrophe-suffixed form the dictionary never contains.
      const w = m[0].replace(/'+$/, '');
      if (w.length < 3) continue; // skip a/an/etc.
      if (w === w.toUpperCase()) continue; // skip ACRONYMS / ALLCAPS
      if (isCorrect(w)) continue;
      const start = pos + m.index;
      decos.push(
        Decoration.inline(start, start + w.length, { class: 'pmd-misspelled' }),
      );
    }
  });
  return DecorationSet.create(view.state.doc, decos);
}

export function viewportSpellcheckPlugin(): Plugin {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, old) {
        const meta = tr.getMeta(key);
        if (meta !== undefined) return meta as DecorationSet;
        return old.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return key.getState(state);
      },
      handleDOMEvents: {
        // Right-click on a flagged word → suggestions + dictionary
        // actions. Falls through (returns false) for clicks that aren't
        // on a misspelling, so links/images/default menus still win.
        contextmenu(view, event) {
          if (!spell || !settings.get('editorSpellcheck')) return false;
          const set = key.getState(view.state);
          if (!set) return false;
          const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
          if (!coords) return false;
          const pos = coords.pos;
          const hit = set
            .find(Math.max(0, pos - 1), pos + 1)
            .find((d) => d.from <= pos && pos <= d.to);
          if (!hit) return false;
          const word = view.state.doc.textBetween(hit.from, hit.to);
          if (!word) return false;
          event.preventDefault();
          showSpellMenu(event.clientX, event.clientY, view, hit.from, hit.to, word);
          return true;
        },
      },
    },
    view(view) {
      let timer = 0;
      let lastEnabled = settings.get('editorSpellcheck');
      const setDecos = (set: DecorationSet): void => {
        view.dispatch(view.state.tr.setMeta(key, set).setMeta('addToHistory', false));
      };
      const recompute = (): void => {
        // Gated on the same `editorSpellcheck` setting as the built-in
        // checker. When off, clear any squiggles and do no work (and
        // don't build the dictionary).
        if (!settings.get('editorSpellcheck')) {
          const cur = key.getState(view.state);
          if (cur && cur.find().length > 0) setDecos(DecorationSet.empty);
          return;
        }
        void ensureSpell(schedule); // builds lazily on first enabled check
        setDecos(computeDecos(view));
      };
      // Trailing debounce: re-check only after scrolling/typing settles,
      // so a fast scroll does ONE check at the end instead of one per
      // frame. ~120ms feels instant once you stop.
      const schedule = (): void => {
        if (timer) clearTimeout(timer);
        timer = window.setTimeout(() => {
          timer = 0;
          recompute();
        }, 120);
      };
      // Scroll container: the pane body in multi-pane, else `#app` in
      // single-doc, else the window. Recompute when it scrolls.
      const scroller: HTMLElement | Window =
        (view.dom.closest('.pmd-pane-body') as HTMLElement | null) ??
        document.getElementById('app') ??
        window;
      scroller.addEventListener('scroll', schedule, { passive: true });
      window.addEventListener('resize', schedule, { passive: true });
      // React to the spellcheck toggle flipping (clear when off, check
      // when on) without reacting to every unrelated settings change.
      const unsub = settings.subscribe((s) => {
        if (s.editorSpellcheck !== lastEnabled) {
          lastEnabled = s.editorSpellcheck;
          schedule();
        }
      });
      schedule();
      return {
        update(_v, prev) {
          if (!prev.doc.eq(view.state.doc)) schedule();
        },
        destroy() {
          scroller.removeEventListener('scroll', schedule);
          window.removeEventListener('resize', schedule);
          unsub();
          if (timer) clearTimeout(timer);
        },
      };
    },
  });
}

// ─── Right-click menu: suggestions + dictionary / ignore ─────────────

/** Re-run the visible-range check and push fresh decorations. Used
 *  after a dictionary / ignore change (which doesn't touch the doc, so
 *  the normal edit-driven recompute wouldn't fire). */
function recheck(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(key, computeDecos(view)).setMeta('addToHistory', false));
}

function replaceWord(view: EditorView, from: number, to: number, replacement: string): void {
  view.dispatch(view.state.tr.insertText(replacement, from, to));
  view.focus();
}

function addToDictionary(view: EditorView, word: string): void {
  userDict.add(word);
  persistUserDict();
  spell?.add(word);
  verdictCache.delete(word);
  recheck(view);
  showToast(`Added “${word}” to dictionary.`);
}

function ignoreWord(view: EditorView, word: string): void {
  ignored.add(word);
  recheck(view);
}

interface SpellMenuItem {
  label: string;
  separatorBefore?: boolean;
  disabled?: boolean;
  action?: () => void;
}

let openSpellMenuEl: HTMLElement | null = null;

function showSpellMenu(
  x: number,
  y: number,
  view: EditorView,
  from: number,
  to: number,
  word: string,
): void {
  closeSpellMenu();

  const suggestions = (spell?.suggest(word) ?? []).slice(0, 7);
  const items: SpellMenuItem[] = [];
  if (suggestions.length === 0) {
    items.push({ label: 'No suggestions', disabled: true });
  } else {
    for (const s of suggestions) {
      items.push({ label: s, action: () => replaceWord(view, from, to, s) });
    }
  }
  items.push({
    label: 'Add to Dictionary',
    separatorBefore: true,
    action: () => addToDictionary(view, word),
  });
  items.push({ label: 'Ignore', action: () => ignoreWord(view, word) });

  const menu = document.createElement('div');
  menu.className = 'pmd-nav-context-menu';
  for (const item of items) {
    if (item.separatorBefore) {
      const sep = document.createElement('div');
      sep.className = 'pmd-nav-context-separator';
      menu.appendChild(sep);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-nav-context-item';
    btn.textContent = item.label;
    if (item.disabled) {
      btn.disabled = true;
      btn.classList.add('pmd-nav-context-item-disabled');
    }
    btn.addEventListener('click', () => {
      if (item.disabled || !item.action) return;
      closeSpellMenu();
      item.action();
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 4;
  const maxY = window.innerHeight - rect.height - 4;
  menu.style.left = `${Math.min(x, Math.max(0, maxX))}px`;
  menu.style.top = `${Math.min(y, Math.max(0, maxY))}px`;

  openSpellMenuEl = menu;
  setTimeout(() => {
    window.addEventListener('mousedown', maybeCloseSpellMenu, { capture: true });
    window.addEventListener('keydown', maybeCloseSpellMenu, { capture: true });
  });
}

function closeSpellMenu(): void {
  if (!openSpellMenuEl) return;
  openSpellMenuEl.remove();
  openSpellMenuEl = null;
  window.removeEventListener('mousedown', maybeCloseSpellMenu, { capture: true });
  window.removeEventListener('keydown', maybeCloseSpellMenu, { capture: true });
}

function maybeCloseSpellMenu(e: MouseEvent | KeyboardEvent): void {
  if (e instanceof KeyboardEvent) {
    if (e.key === 'Escape') closeSpellMenu();
    return;
  }
  if (openSpellMenuEl && !openSpellMenuEl.contains(e.target as Node)) closeSpellMenu();
}
