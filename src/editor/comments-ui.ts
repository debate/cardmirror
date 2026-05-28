/**
 * Comments side-column UI.
 *
 * Owns the right-side panel that shows comment threads as cards.
 * Subscribes to the comments plugin state (and to the live PM doc
 * for thread→range lookups) and rebuilds the panel on change.
 *
 * Per-thread card shape:
 *   - Header: author + initials badge + date.
 *   - Body: comment text (rendered as plain `<p>` per newline).
 *   - Replies (rendered the same way, indented).
 *   - Reply textarea + submit button.
 *   - "Delete thread" button on the root comment's header.
 *
 * Clicking the card scrolls the editor to the marked range and
 * keeps the card visually highlighted.
 */

import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../schema/index.js';
import { settings } from './settings.js';
import { callAnthropic, AnthropicError } from './ai/anthropic.js';
import {
  buildExplainContext,
  formatExplainPrompt,
  EXPLAIN_SYSTEM_PROMPT,
  hasAiMention,
} from './ai/explain-context.js';
import {
  activitiesForNow,
  pickRandomActivity,
  personalizeActivity,
  PRONOUN_PRESETS,
  type AiPersona,
} from './ai/clod.js';
import { makeActivityStage, cycleActivityText } from './ai/activity-cycler.js';
import { showToast } from './toast.js';
import { scheduleIdle, cancelIdle, type IdleHandle } from './idle-scheduler.js';
import { setIcon } from './icons';
import { preciseScrollIntoView } from './precise-scroll.js';
import { learnStore, localToday } from './learn-store-host.js';
import { resolveDescriptor, buildDescriptor } from './learn-anchor.js';
import { openCardEditor } from './learn-create-ui.js';
import { isDue } from './learn-scheduler.js';
import {
  setFlashcardRangesTr,
  setActiveAnnotationRangeTr,
  flashcardRangeMap,
  flashcardDropCount,
  type FlashcardRange,
} from './learn-highlight-plugin.js';
import type { CardAnchor } from './learn-store.js';

/** Synthetic column-card id prefix for a flashcard, distinguishing it
 *  from a (numeric) comment thread id in the shared cardEls map / the
 *  `lastRanges` positioning map. */
const FC_PREFIX = 'fc:';

/** Resolve the configured AI persona (name + pronouns) from
 *  settings. Centralized here so every consumer (invokeAi,
 *  in-flight placeholder, button tooltip) reads the same thing. */
export function getAiPersona(): AiPersona {
  const name = settings.get('aiPersonaName') || 'Clod';
  const choice = settings.get('aiPersonaPronouns');
  if (choice === 'custom') {
    return { name, pronouns: settings.get('aiPersonaCustomPronouns') };
  }
  return { name, pronouns: PRONOUN_PRESETS[choice] ?? PRONOUN_PRESETS.he };
}

/** Cycle the Clod-activity placeholder text every this many
 *  milliseconds while an AI request is in flight. ~4 seconds reads
 *  naturally — long enough to actually read a line, short enough to
 *  make progress feel alive. */
const ACTIVITY_TICK_MS = 4000;

/** Min/max width (CSS px) the comments column can be resized to.
 *  Below 240 threads get cramped; above 560 the column eats too
 *  much editor space. Matches the clamp in `settings.ts`'s
 *  sanitizer so persisted values from outside the range get pulled
 *  back in. */
const COMMENTS_WIDTH_MIN = 240;
const COMMENTS_WIDTH_MAX = 560;

/** Apply a (clamped) comments column width by setting the
 *  `--pmd-comments-width` custom property on the document element.
 *  CSS picks it up via `width: var(--pmd-comments-width, 320px)` on
 *  `.pmd-comments-column`. Mirror of `applyNavWidthCss` in
 *  `nav-panel.ts`. Called on boot (from `index.ts`) to apply the
 *  persisted setting and during the resize drag. */
export function applyCommentsWidthCss(px: number): void {
  const clamped = Math.max(COMMENTS_WIDTH_MIN, Math.min(COMMENTS_WIDTH_MAX, px));
  document.documentElement.style.setProperty('--pmd-comments-width', `${clamped}px`);
}
import {
  commentsKey,
  getCommentsState,
  newCommentId,
  addThreadMeta,
  addReplyMeta,
  editCommentTextMeta,
  deleteThreadMeta,
  deleteCommentMeta,
  setCommentsVisibleMeta,
  type Comment,
  type Thread,
} from './comments-plugin.js';

/** Suffix appended to an AI comment's author name. Combined with
 *  fixed `'AI'` initials, gives us a round-trip-safe way to identify
 *  AI comments after docx export (which drops the `kind` flag). See
 *  `isAiComment`. */
const AI_NAME_SUFFIX = ' (AI)';

/** Recognize an AI comment from fields that survive docx round-trip
 *  (Word has no concept of AI vs human, so the schema's `kind`
 *  field is dropped on docx export and restored as `'human'` on
 *  re-import). New AI comments carry `initials: 'AI'` and an
 *  author name ending with `(AI)` — either signal is sufficient.
 *  `kind === 'ai'` is kept as a legacy back-compat fallback so
 *  comments saved before this switch (and round-tripped via
 *  `.cmir`, which preserves `kind`) still display as AI. */
function isAiComment(comment: { author: string; initials: string; kind?: Comment['kind'] }): boolean {
  if (comment.initials.trim().toUpperCase() === 'AI') return true;
  if (comment.author.trim().endsWith('(AI)')) return true;
  return comment.kind === 'ai';
}

/** Build the author name we write into a freshly-minted AI comment.
 *  When Clod is enabled, suffix the persona name with `(AI)` so the
 *  AI-ness is identifiable from the name field alone after a docx
 *  round-trip. When Clod is off, the name is already `'AI'` — no
 *  suffix needed, and `'AI (AI)'` would look silly. */
function aiAuthorName(): string {
  const useClod = settings.get('clodEnabled');
  if (!useClod) return 'AI';
  const persona = getAiPersona();
  const base = persona.name.trim() || 'AI';
  if (base.endsWith('(AI)')) return base; // defensive: don't double-suffix
  if (base === 'AI') return base;
  return `${base}${AI_NAME_SUFFIX}`;
}

export class CommentsColumn {
  private readonly root: HTMLElement;
  /** Inner container that holds the threads + empty-state + toggle.
   *  Lives inside `root` so the resize handle (also a child of
   *  `root`, but a sibling of this) can survive the `innerHTML = ''`
   *  wipes that `render()` does on every redraw. */
  private readonly content: HTMLElement;
  private getView: () => EditorView | null;
  /** When a thread's textarea was last focused, we'd otherwise blow
   *  it away on every re-render. Track which thread is currently
   *  being typed-in so we re-focus + restore the text on rebuild. */
  private activeReplyThreadId: string | null = null;
  private activeReplyText = '';
  private suppressBlurReset = false;
  /** Threads whose first submission should auto-invoke the AI
   *  explainer. Set by `addAiThreadFromSelection`; cleared the
   *  moment the first submission fires the request. */
  private pendingAiFirst: Set<string> = new Set();
  /** Threads with an in-flight AI request. UI renders a transient
   *  "thinking…" placeholder while present. */
  private aiInFlight: Set<string> = new Set();
  /** Per-thread cached context built at the moment the AI thread
   *  was created. The doc may shift before the AI request fires
   *  (user types elsewhere); the cached context preserves what the
   *  selection meant when the thread was opened. */
  private aiContextByThread: Map<string, ReturnType<typeof buildExplainContext>> = new Map();
  /** Interval handle for the Clod-activity text-cycling tick.
   *  Null when no AI request is pending or Clod mode is off. */
  private activityTimer: number | null = null;
  /** Thread the user is currently focused on — clicked on the card
   *  or has the editor cursor inside its commented range. The
   *  active card is the only one rendered in expanded form, and the
   *  layout anchors it at its preferred Y, displacing neighbors
   *  outward to make room. Null means no card is currently active. */
  private activeThreadId: string | null = null;
  /** Records HOW the active thread got there:
   *   - `'click'`: user clicked the card. Sticky — only dismissed
   *     by clicking elsewhere, opening a different card, or hitting
   *     the toggle button. Cursor moves don't change it.
   *   - `'cursor'`: cursor is inside the comment_range. Follows
   *     cursor — when the cursor leaves the range the thread
   *     collapses.
   *   - `null`: nothing active. */
  private activeBy: 'click' | 'cursor' | null = null;
  /** Global mousedown listener installed while a thread is
   *  sticky-active. Dismisses sticky when the user clicks somewhere
   *  not inside the active card. */
  private stickyDismissHandler: ((e: MouseEvent) => void) | null = null;
  /** Persistent card elements keyed by thread id (or `fc:<cardId>` for
   *  flashcards). Reused across renders so reconcile only re-populates a
   *  card whose content changed — keeping the active reply textarea's
   *  focus/value intact. The column is a plain flow list (Model 1), so
   *  there's no absolute positioning to maintain. */
  private cardEls = new Map<string, HTMLElement>();
  /** Last-rendered content signature per card, so render() skips
   *  re-populating a card whose content + active state are unchanged. */
  private cardSigs = new Map<string, string>();
  /** Latest thread→range map, kept so a card's once-bound click handler
   *  can look up its current range (for scroll-to-text), and so cards
   *  order top-to-bottom by document position. Keyed by comment threadId
   *  and by `fc:<cardId>` for flashcards. */
  private lastRanges: Map<string, { from: number; to: number }> = new Map();
  /** The "Unanchored (n)" footer element (flashcards whose anchor didn't
   *  resolve), appended at the end of the list. Null when none. */
  private unanchoredEl: HTMLElement | null = null;
  /** `${from}:${to}` of the last active-annotation range dispatched to
   *  the highlight plugin (or '' for none), so render only re-dispatches
   *  the doc emphasis when the active selection actually changes. */
  private lastActiveRangeKey = '';
  /** Last-seen flashcard `dropCount` from the highlight plugin. When it
   *  advances (a card was moved/deleted, collapsing its range), render
   *  re-resolves from the stored descriptors to re-ground it. */
  private lastDropCount = 0;
  /** Whether the Unanchored section is collapsed (persists across
   *  renders within a session). */
  private unanchoredCollapsed = false;

  /** Resolve the focused doc's annotation id (single-doc global or the
   *  focused multi-pane record). Flashcards for this id are resolved +
   *  rendered when the column is open. */
  private getDocId: () => string;
  /** Permanent subscription to the learn store (set in the constructor)
   *  so a card created / edited / deleted / re-grounded anywhere
   *  re-resolves + re-renders. `refreshFlashcardAnchors` no-ops while
   *  the column is hidden, so the subscription is cheap when closed. */
  private learnUnsub: (() => void) | null = null;

  constructor(root: HTMLElement, getView: () => EditorView | null, getDocId: () => string = () => '') {
    this.root = root;
    this.getView = getView;
    this.getDocId = getDocId;
    // Inner content container — render() rebuilds children INSIDE
    // this. Order matters: install the resize handle BEFORE the
    // content container so the handle stays in DOM order as a
    // sibling that render() never touches. Without this indirection
    // render()'s `innerHTML = ''` on the root wipes the handle on
    // every doc keystroke (since render() fires from
    // dispatchTransaction).
    applyCommentsWidthCss(settings.get('commentsColumnWidth'));
    settings.subscribe((s) => {
      applyCommentsWidthCss(s.commentsColumnWidth);
    });
    this.installResizeHandle();
    this.content = document.createElement('div');
    this.content.className = 'pmd-comments-content';
    this.root.appendChild(this.content);
    // Permanent subscription: re-resolve + re-render whenever a card is
    // created / edited / deleted / re-grounded anywhere. Must NOT be
    // gated on `setVisible` — on boot the column is shown by setting
    // `hidden` directly (in mountView), so setVisible may never run.
    // `refreshFlashcardAnchors` no-ops while the column is hidden.
    this.learnUnsub = learnStore.subscribe(() => this.refreshFlashcardAnchors());
  }

  /** Add a drag handle on the column's LEFT edge so users can
   *  resize it. Mirrors the nav-pane's right-edge handle. Width
   *  is driven by the `--pmd-comments-width` custom property
   *  (set on `:root` so any future selector that references it
   *  resolves consistently), and persisted via the
   *  `commentsColumnWidth` setting. Drag clamps to
   *  COMMENTS_WIDTH_MIN…COMMENTS_WIDTH_MAX; further clamping in
   *  the settings sanitizer defends against persisted values
   *  outside the range from older builds. */
  private installResizeHandle(): void {
    const handle = document.createElement('div');
    handle.className = 'pmd-comments-resize-handle';
    handle.setAttribute('aria-label', 'Resize comments column');
    handle.setAttribute('role', 'separator');
    this.root.appendChild(handle);

    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    const onMove = (e: MouseEvent): void => {
      if (!dragging) return;
      // Dragging LEFT (decreasing clientX) GROWS the column,
      // because the handle sits on the column's left edge and
      // moving it left makes the column wider. Inverse of the
      // nav-pane handle on the right.
      const delta = startX - e.clientX;
      applyCommentsWidthCss(startWidth + delta);
    };

    const onUp = (): void => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('pmd-comments-resize-active');
      this.root.classList.remove('pmd-comments-resizing');
      const w = getComputedStyle(this.root).width;
      const pixels = parseInt(w, 10);
      if (Number.isFinite(pixels)) {
        settings.set('commentsColumnWidth', pixels);
      }
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      startX = e.clientX;
      startWidth = this.root.getBoundingClientRect().width;
      document.body.classList.add('pmd-comments-resize-active');
      this.root.classList.add('pmd-comments-resizing');
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }

  /** Switch which thread is "active" — the expanded one whose card
   *  anchors at its preferred Y position. The `by` flavor matters:
   *   - `'cursor'` calls (from the editor's cursor-tracking) leave
   *     a click-sticky active alone. A cursor-set active deactivates
   *     when the cursor leaves the range.
   *   - `'click'` calls (from clicking a card) take over and install
   *     a global mousedown dismiss listener.
   *  Idempotent for same id + same flavor so callers can fire freely. */
  setActiveThread(id: string | null, by: 'click' | 'cursor' = 'cursor'): void {
    if (this.activeBy === 'click' && by === 'cursor') {
      // Sticky owns the active state — cursor changes don't touch
      // it. (Cursor moving back INTO the sticky thread's range is
      // already a no-op; cursor moving away is suppressed here so
      // the click stays expanded until something else dismisses.)
      return;
    }
    if (this.activeThreadId === id && this.activeBy === (id ? by : null)) return;
    this.activeThreadId = id;
    this.activeBy = id ? by : null;
    this.refreshStickyDismissListener();
    // Cursor-driven calls come from the editor's `dispatchTransaction`
    // (every keystroke, every cursor move). Debounce the render so
    // typing in a long doc isn't paying an O(doc) `collectRanges`
    // walk per keystroke. Click-driven calls come from a user
    // clicking a thread card; render immediately for snappy feedback.
    if (by === 'cursor') this.scheduleRender();
    else this.render();
  }

  /** Manual dismiss path — used by the global mousedown listener
   *  when the user clicks somewhere outside a sticky-active card,
   *  and by the toggle button. Clears the active state and then
   *  re-evaluates cursor position so a cursor-in-range still wins. */
  private dismissActive(): void {
    this.activeThreadId = null;
    this.activeBy = null;
    this.refreshStickyDismissListener();
    this.render();
  }

  /** Install / remove the document-level mousedown listener that
   *  dismisses a sticky-active card when the user clicks outside
   *  it. Only attached while the active flavor is `'click'`. */
  private refreshStickyDismissListener(): void {
    const needed = this.activeBy === 'click' && this.activeThreadId !== null;
    if (needed && !this.stickyDismissHandler) {
      const handler = (e: MouseEvent): void => {
        const target = e.target as HTMLElement | null;
        if (!target) return;
        // Click inside the active card — keep sticky.
        if (target.closest(`[data-thread-id="${cssEscape(this.activeThreadId!)}"]`)) return;
        // Click inside the column on a DIFFERENT card — the card's
        // own handler will call setActiveThread('click') and we'll
        // refresh the listener for the new active card.
        if (target.closest('.pmd-comment-thread')) return;
        this.dismissActive();
      };
      // Defer one frame so the activating click itself doesn't fire
      // this handler synchronously and immediately cancel sticky.
      requestAnimationFrame(() => {
        if (this.activeBy !== 'click') return;
        document.addEventListener('mousedown', handler, true);
        this.stickyDismissHandler = handler;
      });
    } else if (!needed && this.stickyDismissHandler) {
      document.removeEventListener('mousedown', this.stickyDismissHandler, true);
      this.stickyDismissHandler = null;
    }
  }

  /** Show/hide the entire column. The toggle button in the ribbon
   *  calls this; we also dispatch a `setCommentsVisibleMeta` so
   *  the plugin state reflects the same value (useful for any
   *  consumer that wants to render based on it). */
  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
    const view = this.getView();
    if (view) {
      view.dispatch(view.state.tr.setMeta(commentsKey, setCommentsVisibleMeta(visible)));
    }
    settings.set('commentsVisible', visible);
    if (visible) {
      // Resolve this doc's flashcards on show. (The constructor's
      // permanent store subscription keeps them current thereafter.)
      this.refreshFlashcardAnchors();
    } else {
      // Drop the highlights + active emphasis when the column closes
      // (resolved fresh on the next open).
      const v = this.getView();
      if (v) {
        v.dispatch(setFlashcardRangesTr(v.state, []));
        v.dispatch(setActiveAnnotationRangeTr(v.state, null));
      }
      this.lastActiveRangeKey = '';
    }
  }

  /** Resolve every flashcard anchored to the focused doc against the
   *  live document and hand the resolved ranges to the highlight
   *  plugin. Cards whose descriptor doesn't resolve (a foreign edit
   *  broke them, or they were explicitly unanchored) simply aren't in
   *  the resolved set — the column surfaces them in its Unanchored
   *  list. Idempotent; safe to call on open, doc load, and store change. */
  refreshFlashcardAnchors(): void {
    const view = this.getView();
    if (!view) return;
    if (this.root.hidden) return;
    const docId = this.getDocId();
    const resolved: FlashcardRange[] = [];
    if (docId) {
      for (const a of learnStore.anchorsForDoc(docId)) {
        if (!a.anchor) continue; // explicitly unanchored
        const r = resolveDescriptor(view.state.doc, a.anchor);
        if (r) resolved.push({ cardId: a.cardId, from: r.from, to: r.to });
      }
    }
    view.dispatch(setFlashcardRangesTr(view.state, resolved));
    // Baseline the drop counter to the just-resolved state so render's
    // re-resolve trigger only fires on drops that happen AFTER this.
    this.lastDropCount = flashcardDropCount(view.state);
    // The range-set transaction is doc-neutral, so it doesn't trip the
    // editor's render trigger — render explicitly so the flashcard
    // cards (which read the new resolved ranges) appear/update.
    this.render();
  }

  /** Re-render the column from the current plugin state + doc.
   *  Two phases: build the cards into the DOM (positions are still
   *  default at this point), then `layoutCards` measures each card's
   *  natural height and assigns a `top` aligned with the start of
   *  its anchored range. */
  /** Idle-callback handle for `scheduleRender`. */
  private renderTimer: IdleHandle | null = null;

  /** Debounced variant of `render()` — used by callers driven by
   *  `dispatchTransaction` (cursor moves, doc edits) so the O(doc)
   *  `collectRanges` walk inside render doesn't fire on every
   *  keystroke. Dispatched via `requestIdleCallback` (with a 200ms
   *  timeout cap and a `setTimeout` fallback) so it only runs when
   *  the browser has frame budget to spare — no mid-pause spike
   *  when the user briefly stops typing. Direct user actions
   *  (toggle, add comment, click a card) call `render` immediately
   *  for snappy feedback. */
  scheduleRender(): void {
    if (this.renderTimer !== null) cancelIdle(this.renderTimer);
    this.renderTimer = scheduleIdle(() => {
      this.renderTimer = null;
      this.render();
    }, 200);
  }

  render(): void {
    // Cancel any pending scheduled render — a direct render() call
    // supersedes it and we don't want a stale follow-up.
    if (this.renderTimer !== null) {
      cancelIdle(this.renderTimer);
      this.renderTimer = null;
    }
    const view = this.getView();
    if (!view) {
      this.clearAllCards();
      this.content.innerHTML = '';
      this.root.classList.remove('pmd-comments-empty-state');
      this.root.style.minHeight = '';
      return;
    }
    // Bail when the column is hidden. render() fires from
    // `dispatchTransaction` on every doc-changing keystroke; if the
    // user has the comments toggle off, there's nothing visible to
    // paint and the O(doc) `collectRanges` walk below (plus all the
    // DOM construction) is wasted work. The toggle handler in
    // `editor/index.ts` calls `render()` explicitly when the column
    // is shown, so the column repopulates from the current state at
    // that moment with no lost data.
    if (this.root.hidden) return;
    const state = getCommentsState(view.state);

    // Flashcards anchored to the focused doc. Cheap store/plugin reads
    // (resolved ranges are already edit-tracked by the highlight
    // plugin), done before the empty-bail so a doc with only flashcards
    // still renders.
    const docId = this.getDocId();
    const fcAnchors = docId ? learnStore.anchorsForDoc(docId) : [];
    const fcRangeMap = flashcardRangeMap(view.state);
    const anchoredFc = fcAnchors.filter((a) => fcRangeMap.has(a.cardId));
    const unanchoredFc = fcAnchors.filter((a) => !fcRangeMap.has(a.cardId));

    if (state.threads.size === 0 && fcAnchors.length === 0) {
      // Empty early-bail BEFORE the O(doc) `collectRanges` walk: this
      // render fires from `dispatchTransaction` on every doc-changing
      // keystroke, so docs with no comments AND no flashcards would
      // otherwise pay a full-doc walk per keystroke.
      this.clearAllCards();
      this.content.innerHTML = '';
      this.unanchoredEl = null;
      this.root.classList.add('pmd-comments-empty-state');
      const empty = document.createElement('div');
      empty.className = 'pmd-comments-empty';
      empty.textContent = 'No comments yet.';
      this.content.appendChild(empty);
      this.root.style.minHeight = '';
      return;
    }
    this.root.classList.remove('pmd-comments-empty-state');

    // If a flashcard range collapsed under an edit (a card *move* —
    // which position-mapping can't follow — or a delete), re-resolve
    // from the stored descriptors: the text usually still exists
    // (relocated), so the card re-grounds rather than going unanchored.
    // refreshFlashcardAnchors re-renders, so bail out of this pass.
    if (flashcardDropCount(view.state) !== this.lastDropCount) {
      this.refreshFlashcardAnchors();
      return;
    }

    // Drop any leftover empty-state placeholder before reconciling.
    const placeholder = this.content.querySelector('.pmd-comments-empty');
    if (placeholder) placeholder.remove();
    const ranges = collectRanges(view.state.doc);
    // Merge resolved flashcard ranges (synthetic `fc:` ids) so the list
    // orders flashcards by their text position and click-to-scroll works.
    for (const a of anchoredFc) {
      const r = fcRangeMap.get(a.cardId);
      if (r) ranges.set(FC_PREFIX + a.cardId, r);
    }
    this.lastRanges = ranges;

    // Build the ordered list of cards (comments + anchored flashcards),
    // top-to-bottom by document position; cards with no position (orphan
    // comments) sink to the end.
    interface Item {
      id: string;
      kind: 'comment' | 'flashcard';
      cardId: string;
      sortKey: number;
    }
    const items: Item[] = [];
    for (const id of state.threads.keys()) {
      const r = ranges.get(id);
      items.push({ id, kind: 'comment', cardId: '', sortKey: r ? r.from : Number.MAX_SAFE_INTEGER });
    }
    for (const a of anchoredFc) {
      const r = fcRangeMap.get(a.cardId);
      items.push({
        id: FC_PREFIX + a.cardId,
        kind: 'flashcard',
        cardId: a.cardId,
        sortKey: r ? r.from : Number.MAX_SAFE_INTEGER,
      });
    }
    items.sort((x, y) => x.sortKey - y.sortKey);

    // Reconcile persistent card elements (preserves the active reply
    // textarea's focus/value; only re-populates when content changed),
    // then append in document order — a plain flow list (Model 1). The
    // column scrolls internally, so a card expanding never moves the doc.
    const wantedIds = new Set(items.map((it) => it.id));
    for (const [id, el] of this.cardEls) {
      if (!wantedIds.has(id)) {
        el.remove();
        this.cardEls.delete(id);
        this.cardSigs.delete(id);
      }
    }
    for (const it of items) {
      const isActive = this.activeThreadId === it.id;
      const el = this.ensureCardEl(it.id);
      // Defensive: the flow list never sets an inline `top`, but a card
      // element that survived a hot-reload from the old positioned layout
      // could carry a stale one (which `position: relative` would honor,
      // shifting the card out of order). Clear it.
      if (el.style.top) el.style.top = '';
      if (it.kind === 'comment') {
        const thread = state.threads.get(it.id)!;
        const sig = 'c' + this.threadSignature(thread, isActive);
        if (this.cardSigs.get(it.id) !== sig) {
          this.populateThread(el, thread, isActive);
          this.cardSigs.set(it.id, sig);
        }
      } else {
        const sig = 'f' + this.flashcardSignature(it.cardId, isActive);
        if (this.cardSigs.get(it.id) !== sig) {
          this.populateFlashcard(el, it.cardId, isActive);
          this.cardSigs.set(it.id, sig);
        }
      }
      this.content.appendChild(el); // flow order
    }
    // Unanchored flashcards → collapsible footer at the end of the list.
    this.renderUnanchoredSection(unanchoredFc);

    // Keep the active card visible within the self-scrolling column.
    // `block:'nearest'` is a no-op when it's already in view, so this
    // doesn't fight manual scrolling.
    if (this.activeThreadId) {
      this.cardEls.get(this.activeThreadId)?.scrollIntoView({ block: 'nearest' });
    }

    // Emphasize the active annotation's range in the document (so the
    // selected comment/flashcard is visible in the text too). Only
    // re-dispatch when it changed — the tr is doc-neutral.
    const activeRange = this.activeThreadId ? (this.lastRanges.get(this.activeThreadId) ?? null) : null;
    const key = activeRange ? `${activeRange.from}:${activeRange.to}` : '';
    if (key !== this.lastActiveRangeKey) {
      this.lastActiveRangeKey = key;
      view.dispatch(setActiveAnnotationRangeTr(view.state, activeRange));
    }
  }

  /** Retained as a no-op for the multi-pane shell, which calls it on
   *  pane scroll. Model 1 is a flow list — nothing to reposition on
   *  scroll (the column scrolls its own content). */
  relayoutCards(): void {
    /* intentionally empty */
  }

  /** Get or create the persistent card element for a thread. The
   *  click handler is attached once; it reads the thread's *current*
   *  range from `lastRanges` at click time (ranges move as the doc is
   *  edited, but the element — and its handler — persist). */
  private ensureCardEl(threadId: string): HTMLElement {
    const existing = this.cardEls.get(threadId);
    if (existing) return existing;
    const card = document.createElement('article');
    card.className = 'pmd-comment-thread';
    card.dataset['threadId'] = threadId;
    // Click → make this thread active (expand it, anchor it to its
    // range). Sticky until the user clicks elsewhere / opens another
    // card / hits the toggle. Clicks inside an editable bubble through.
    card.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      if (target && target.closest('textarea, input, button')) return;
      // Clicking the already-active card collapses it — and crucially
      // does NOT re-scroll. (Previously it re-fired scrollToRange, which
      // jumped the doc to the card's text on every click of an open
      // card.) Only a fresh activation scrolls to the anchored text.
      if (this.activeThreadId === threadId) {
        this.dismissActive();
        return;
      }
      this.setActiveThread(threadId, 'click');
      const r = this.lastRanges.get(threadId);
      if (r) this.scrollToRange(r);
    });
    this.cardEls.set(threadId, card);
    return card;
  }

  /** (Re)fill a card's inner content for the current thread state.
   *  Replaces children in place — the element persists so its `top`
   *  keeps animating and the ResizeObserver stays attached. */
  private populateThread(card: HTMLElement, thread: Thread, isActive: boolean): void {
    card.replaceChildren();
    card.classList.toggle('pmd-comment-thread-active', isActive);

    // A freshly-created thread starts as a single empty-text root —
    // render it as a primary "add comment" input so the user can type
    // their first message; first submit edits the root in place.
    const root = thread.comments[0];
    const isEmptyRoot = thread.comments.length === 1 && root && root.text === '';
    if (isEmptyRoot && root) {
      card.appendChild(this.renderRootHeader(thread, root));
      card.appendChild(this.renderPrimaryInput(thread, root));
      return;
    }
    if (!isActive) {
      // Collapsed preview: badge + author + short body excerpt.
      card.appendChild(this.renderThreadPreview(thread));
      return;
    }
    for (const c of thread.comments) {
      card.appendChild(this.renderComment(thread, c, c.id === thread.id));
    }
    if (this.aiInFlight.has(thread.id)) {
      card.appendChild(this.renderAiThinkingPlaceholder());
    }
    card.appendChild(this.renderReplyForm(thread));
  }

  /** Signature gating re-population: changes only when a rebuild is
   *  actually needed (active toggle, comment add/edit/remove, AI
   *  in-flight flip). Excludes range (position-only → relayout) and
   *  reply text (transient — preserved across unrelated renders).
   *  An empty root renders the same whether active or not, so its
   *  signature ignores active to avoid recreating the input (and
   *  losing focus) on a stray cursor move. */
  private threadSignature(thread: Thread, isActive: boolean): string {
    const root = thread.comments[0];
    const isEmptyRoot = thread.comments.length === 1 && root && root.text === '';
    return JSON.stringify({
      a: isEmptyRoot ? 'empty' : isActive,
      ai: this.aiInFlight.has(thread.id),
      c: thread.comments.map((c) => [c.id, c.text, c.author, c.initials]),
    });
  }

  /** Drop all persistent card elements (view gone / empty state). */
  private clearAllCards(): void {
    this.cardEls.clear();
    this.cardSigs.clear();
    this.lastRanges = new Map();
    this.lastActiveRangeKey = '';
    this.lastDropCount = 0;
    if (this.unanchoredEl) {
      this.unanchoredEl.remove();
      this.unanchoredEl = null;
    }
  }

  /** Signature gating a flashcard card's re-population: card content +
   *  schedule state + active. (Range is position-only → relayout.) */
  private flashcardSignature(cardId: string, isActive: boolean): string {
    const def = learnStore.getCard(cardId);
    const sched = learnStore.getSchedule(cardId);
    return JSON.stringify({
      a: isActive,
      t: def?.type,
      f: def?.front,
      b: def?.back,
      s: sched?.state,
      d: sched?.dueOn,
    });
  }

  /** Status chip for a card's schedule — "New" / "Due" / "Due <date>" /
   *  "Suspended" — mirroring the manage GUI's wording. */
  private flashcardChip(cardId: string): { text: string; cls: string } {
    const s = learnStore.getSchedule(cardId);
    if (!s) return { text: '', cls: '' };
    if (s.state === 'suspended') return { text: 'Suspended', cls: 'is-suspended' };
    if (s.state === 'new') return { text: 'New', cls: '' };
    return isDue(s, localToday()) ? { text: 'Due', cls: 'is-due' } : { text: `Due ${s.dueOn}`, cls: '' };
  }

  /** Fill a flashcard card. Collapsed shows the front; active also
   *  reveals the back (Q&A). The element persists across renders so it
   *  reflows with the comment cards. */
  private populateFlashcard(card: HTMLElement, cardId: string, isActive: boolean): void {
    card.replaceChildren();
    card.classList.add('pmd-flashcard-card');
    card.classList.toggle('pmd-comment-thread-active', isActive);
    const def = learnStore.getCard(cardId);
    if (!def) return; // card vanished (deleted elsewhere) — next render drops it

    const header = document.createElement('header');
    header.className = 'pmd-flashcard-card-header';
    const badge = document.createElement('span');
    badge.className = 'pmd-flashcard-card-badge';
    badge.textContent = def.type === 'cloze' ? 'Cloze' : 'Q&A';
    header.appendChild(badge);
    const chip = this.flashcardChip(cardId);
    if (chip.text) {
      const chipEl = document.createElement('span');
      chipEl.className = `pmd-flashcard-card-chip ${chip.cls}`;
      chipEl.textContent = chip.text;
      header.appendChild(chipEl);
    }
    card.appendChild(header);

    const front = document.createElement('div');
    front.className = 'pmd-flashcard-card-front';
    front.textContent = def.front;
    card.appendChild(front);
    if (isActive && def.type === 'qa' && def.back) {
      const back = document.createElement('div');
      back.className = 'pmd-flashcard-card-back';
      back.textContent = def.back;
      card.appendChild(back);
    }
    if (isActive) card.appendChild(this.buildFlashcardActions(cardId));
  }

  /** Render / update the collapsible "Unanchored (n)" section pinned at
   *  the bottom of the pane (flashcards whose anchor didn't resolve —
   *  a foreign edit broke them, or they're linked to the file but not
   *  yet grounded to text). Positioned by `layoutCards`. */
  private renderUnanchoredSection(unanchored: CardAnchor[]): void {
    if (unanchored.length === 0) {
      if (this.unanchoredEl) {
        this.unanchoredEl.remove();
        this.unanchoredEl = null;
      }
      return;
    }
    let el = this.unanchoredEl;
    if (!el) {
      el = document.createElement('div');
      el.className = 'pmd-comments-unanchored';
      this.unanchoredEl = el;
    }
    el.replaceChildren();
    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'pmd-comments-unanchored-header';
    header.textContent = `${this.unanchoredCollapsed ? '▸' : '▾'} Unanchored (${unanchored.length})`;
    header.addEventListener('click', () => {
      this.unanchoredCollapsed = !this.unanchoredCollapsed;
      // Re-render just this section + reflow (collapse changes height).
      const v = this.getView();
      if (!v) return;
      const anchors = learnStore.anchorsForDoc(this.getDocId());
      const map = flashcardRangeMap(v.state);
      this.renderUnanchoredSection(anchors.filter((a) => !map.has(a.cardId)));
      this.relayoutCards();
    });
    el.appendChild(header);
    if (!this.unanchoredCollapsed) {
      for (const a of unanchored) {
        el.appendChild(this.renderUnanchoredRow(a));
      }
    }
    this.content.appendChild(el);
  }

  private renderUnanchoredRow(anchor: CardAnchor): HTMLElement {
    const row = document.createElement('div');
    row.className = 'pmd-comments-unanchored-row';
    const def = learnStore.getCard(anchor.cardId);
    const front = document.createElement('div');
    front.className = 'pmd-comments-unanchored-front';
    const body = (def?.front ?? '').replace(/\s+/g, ' ').trim();
    front.textContent = body.length > 80 ? `${body.slice(0, 80).trimEnd()}…` : body || '(empty card)';
    row.appendChild(front);
    const was = document.createElement('div');
    was.className = 'pmd-comments-unanchored-was';
    if (anchor.anchor && anchor.anchor.quote) {
      const q = anchor.anchor.quote.replace(/\s+/g, ' ').trim();
      was.textContent = `was attached to: “${q.length > 70 ? q.slice(0, 70).trimEnd() + '…' : q}”`;
    } else {
      was.textContent = 'not yet grounded to text';
    }
    row.appendChild(was);
    row.appendChild(this.buildFlashcardActions(anchor.cardId, { reground: true }));
    return row;
  }

  /** Re-ground an unanchored card to the current editor selection
   *  (SPEC §4.3). The store change re-resolves it into an anchored
   *  card on the next refresh. */
  private regroundCard(cardId: string): void {
    const view = this.getView();
    if (!view) return;
    const sel = view.state.selection;
    if (sel.empty) {
      showToast('Select text in the document, then click Re-ground.');
      return;
    }
    const descriptor = buildDescriptor(view.state.doc, sel.from, sel.to);
    learnStore.setAnchor(cardId, this.getDocId(), descriptor);
    showToast('Flashcard re-grounded.');
  }

  /** Shared action row for a flashcard — Edit, Suspend/Resume, Delete
   *  (two-click), plus an optional Re-ground (unanchored rows). Used by
   *  the active card and the Unanchored list; mutations flow through the
   *  store → subscription → re-resolve + re-render. */
  private buildFlashcardActions(cardId: string, opts: { reground?: boolean } = {}): HTMLElement {
    const actions = document.createElement('div');
    actions.className = 'pmd-flashcard-card-actions';
    const mk = (label: string, onClick: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pmd-flashcard-card-action';
      b.textContent = label;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick();
      });
      return b;
    };
    if (opts.reground) actions.appendChild(mk('Re-ground', () => this.regroundCard(cardId)));
    actions.appendChild(
      mk('Edit', () => {
        const def = learnStore.getCard(cardId);
        if (!def) return;
        void (async () => {
          const next = await openCardEditor({
            initial: { type: def.type, front: def.front, back: def.back },
          });
          if (next) {
            learnStore.upsertCard(
              { id: cardId, type: next.type, front: next.front, back: next.back },
              localToday(),
            );
          }
        })();
      }),
    );
    const suspended = learnStore.getSchedule(cardId)?.state === 'suspended';
    actions.appendChild(mk(suspended ? 'Resume' : 'Suspend', () => learnStore.setSuspended(cardId, !suspended)));
    // Two-click delete (no native confirm in Electron).
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'pmd-flashcard-card-action pmd-flashcard-card-delete';
    del.textContent = 'Delete';
    let armed = false;
    let timer: number | null = null;
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!armed) {
        armed = true;
        del.textContent = 'Delete?';
        del.classList.add('is-armed');
        timer = window.setTimeout(() => {
          armed = false;
          del.textContent = 'Delete';
          del.classList.remove('is-armed');
        }, 3000);
        return;
      }
      if (timer !== null) window.clearTimeout(timer);
      learnStore.deleteCard(cardId);
    });
    actions.appendChild(del);
    return actions;
  }

  /** One-line preview used when a thread is collapsed. Shows the
   *  root comment's author badge, name, and a truncated body
   *  excerpt — enough that the user can identify the thread at a
   *  glance without it crowding the column. */
  private renderThreadPreview(thread: Thread): HTMLElement {
    const block = document.createElement('div');
    block.className = 'pmd-comment-preview';
    const root = thread.comments[0]!;
    // Existing `.pmd-comment-ai .pmd-comment-initials` rule paints
    // the badge purple when this class is on the parent block.
    if (isAiComment(root)) block.classList.add('pmd-comment-ai');
    const badge = document.createElement('span');
    badge.className = 'pmd-comment-initials';
    fillBadge(badge, root.author, root.initials);
    block.appendChild(badge);
    const text = document.createElement('span');
    text.className = 'pmd-comment-preview-text';
    const body = root.text.replace(/\s+/g, ' ').trim();
    const excerpt = body.length > 80 ? `${body.slice(0, 80).trimEnd()}…` : body;
    text.textContent = excerpt || '(empty)';
    block.appendChild(text);
    if (thread.comments.length > 1) {
      const count = document.createElement('span');
      count.className = 'pmd-comment-preview-count';
      count.textContent = `${thread.comments.length}`;
      block.appendChild(count);
    }
    return block;
  }

  private renderAiThinkingPlaceholder(): HTMLElement {
    const block = document.createElement('div');
    block.className = 'pmd-comment-reply pmd-comment-ai pmd-comment-ai-thinking';
    const header = document.createElement('header');
    header.className = 'pmd-comment-header';
    const badge = document.createElement('span');
    badge.className = 'pmd-comment-initials';
    // Match what the real AI comment will carry — fixed 'AI'
    // initials + author with the `(AI)` suffix — so the placeholder
    // doesn't visually jump when the response arrives.
    badge.textContent = 'AI';
    header.appendChild(badge);
    const name = document.createElement('span');
    name.className = 'pmd-comment-author';
    name.textContent = aiAuthorName();
    header.appendChild(name);
    block.appendChild(header);
    const body = document.createElement('div');
    body.className = 'pmd-comment-body';
    // Wrap the activity text in a paragraph for layout parity with
    // a real comment body. The stage element provides its own
    // fixed-height clipping so the slide-in/out animation has room
    // to play without pushing surrounding content around.
    const line = document.createElement('p');
    line.className = 'pmd-comment-ai-thinking-dots';
    const stage = makeActivityStage(this.inFlightActivityText());
    // The comments column already constrains the placeholder's
    // width; opt out of the activity-cycler's auto-width so
    // long activity strings wrap inside the column instead of
    // making the stage push past it.
    stage.classList.add('pmd-activity-stage-fixed-width');
    line.appendChild(stage);
    body.appendChild(line);
    block.appendChild(body);
    // Tag with `data-activity-target` so the activity-cycling tick
    // can find this stage without re-rendering the whole column.
    stage.dataset['activityTarget'] = '1';
    return block;
  }

  private inFlightActivityText(): string {
    if (!settings.get('clodEnabled')) return 'Thinking…';
    const pool = activitiesForNow({
      customByTime: settings.get('clodActivitiesByTime'),
      ranges: settings.get('clodTimePeriods'),
    });
    const raw = pickRandomActivity(pool);
    return personalizeActivity(raw, getAiPersona());
  }

  /** Tick the in-flight placeholders' text to fresh Clod activities
   *  every few seconds while at least one AI request is pending. */
  private startActivityTicker(): void {
    if (this.activityTimer !== null) return;
    const tick = (): void => {
      if (this.aiInFlight.size === 0 || !settings.get('clodEnabled')) {
        this.stopActivityTicker();
        return;
      }
      const stages = this.root.querySelectorAll<HTMLElement>('[data-activity-target]');
      for (const stage of stages) {
        cycleActivityText(stage, this.inFlightActivityText());
      }
    };
    this.activityTimer = window.setInterval(tick, ACTIVITY_TICK_MS);
  }

  private stopActivityTicker(): void {
    if (this.activityTimer !== null) {
      window.clearInterval(this.activityTimer);
      this.activityTimer = null;
    }
  }

  /** Header-only render for the empty-root state: shows author
   *  badge + delete button without the empty body block, so the
   *  thread doesn't render a blank comment card before the user
   *  has typed anything. */
  private renderRootHeader(thread: Thread, root: Comment): HTMLElement {
    const block = document.createElement('div');
    block.className = 'pmd-comment-root pmd-comment-pending';
    const header = document.createElement('header');
    header.className = 'pmd-comment-header';
    const badge = document.createElement('span');
    badge.className = 'pmd-comment-initials';
    fillBadge(badge, root.author, root.initials);
    header.appendChild(badge);
    const name = document.createElement('span');
    name.className = 'pmd-comment-author';
    name.textContent = root.author || 'Unknown';
    header.appendChild(name);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'pmd-comment-delete';
    del.title = 'Cancel';
    setIcon(del, 'close');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      this.deleteThread(thread.id);
    });
    header.appendChild(del);
    block.appendChild(header);
    return block;
  }

  private renderPrimaryInput(thread: Thread, root: Comment): HTMLElement {
    const isAi = this.pendingAiFirst.has(thread.id);
    const placeholder = isAi ? 'Ask a question' : 'Add a comment…';
    const submitLabel = isAi ? 'Ask' : 'Comment';
    const form = this.buildInputForm(thread, placeholder, (text) => {
      this.commitRootText(thread.id, root.id, text);
    }, submitLabel);
    return form;
  }

  private renderReplyForm(thread: Thread): HTMLElement {
    return this.buildInputForm(thread, 'Reply…', (text) => {
      this.submitReply(thread.id, text);
    }, 'Reply');
  }

  private buildInputForm(
    thread: Thread,
    placeholder: string,
    onSubmit: (text: string) => void,
    submitLabel: string,
  ): HTMLFormElement {
    const form = document.createElement('form');
    form.className = 'pmd-comment-reply-form';

    const ta = document.createElement('textarea');
    ta.className = 'pmd-comment-reply-input';
    ta.rows = 2;
    ta.placeholder = placeholder;
    if (this.activeReplyThreadId === thread.id) ta.value = this.activeReplyText;
    ta.addEventListener('focus', () => {
      this.activeReplyThreadId = thread.id;
      this.activeReplyText = ta.value;
    });
    ta.addEventListener('input', () => {
      if (this.activeReplyThreadId === thread.id) this.activeReplyText = ta.value;
    });
    ta.addEventListener('blur', () => {
      if (this.suppressBlurReset) return;
      this.activeReplyThreadId = null;
      this.activeReplyText = '';
    });
    // Enter submits, Shift-Enter inserts a newline.
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    form.appendChild(ta);

    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'pmd-comment-reply-submit';
    submitBtn.textContent = submitLabel;
    form.appendChild(submitBtn);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text) return;
      onSubmit(text);
    });
    return form;
  }

  private commitRootText(threadId: string, commentId: string, text: string): void {
    const view = this.getView();
    if (!view) return;
    this.suppressBlurReset = true;
    this.activeReplyThreadId = null;
    this.activeReplyText = '';
    view.dispatch(
      view.state.tr.setMeta(commentsKey, editCommentTextMeta(threadId, commentId, text)),
    );
    this.suppressBlurReset = false;
    view.focus();

    // AI auto-invoke flow: a thread created via the "Ask AI"
    // button carries a pending flag. The user's first text submit
    // becomes the root comment; we fire the request and append
    // the model's reply as a kind:'ai' comment in the same thread.
    // `invokeAi` reads the thread state for itself so we don't
    // need to pass the just-committed text through.
    if (this.pendingAiFirst.has(threadId)) {
      this.pendingAiFirst.delete(threadId);
      this.invokeAi(threadId);
    }
  }

  private renderComment(thread: Thread, comment: Comment, isRoot: boolean): HTMLElement {
    const block = document.createElement('div');
    block.className = isRoot ? 'pmd-comment-root' : 'pmd-comment-reply';
    // Purple-badge styling is driven by `isAiComment` now (initials
    // + name-suffix detection), not by the `kind` field which
    // doesn't round-trip through docx. The inline "AI" tag that
    // used to sit next to the author name is gone — redundant
    // with the `(AI)` suffix that's now baked into the name.
    if (isAiComment(comment)) block.classList.add('pmd-comment-ai');

    const header = document.createElement('header');
    header.className = 'pmd-comment-header';
    const badge = document.createElement('span');
    badge.className = 'pmd-comment-initials';
    fillBadge(badge, comment.author, comment.initials);
    header.appendChild(badge);
    const name = document.createElement('span');
    name.className = 'pmd-comment-author';
    name.textContent = comment.author || 'Unknown';
    header.appendChild(name);
    if (comment.date) {
      const date = document.createElement('span');
      date.className = 'pmd-comment-date';
      date.textContent = formatDate(comment.date);
      header.appendChild(date);
    }
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'pmd-comment-delete';
    del.title = isRoot ? 'Delete thread' : 'Delete reply';
    setIcon(del, 'close');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isRoot) this.deleteThread(thread.id);
      else this.deleteComment(thread.id, comment.id);
    });
    header.appendChild(del);
    block.appendChild(header);

    const body = document.createElement('div');
    body.className = 'pmd-comment-body';
    for (const line of comment.text.split('\n')) {
      const p = document.createElement('p');
      p.textContent = line;
      body.appendChild(p);
    }
    block.appendChild(body);
    return block;
  }

  private submitReply(threadId: string, text: string): void {
    const view = this.getView();
    if (!view) return;
    const comment: Comment = {
      id: newCommentId(),
      author: settings.get('commentAuthor'),
      // Store only the user's explicit setting — derivation happens
      // at render time so the badge can fall back to a silhouette
      // when there's no good initials to compute.
      initials: settings.get('commentAuthorInitials').trim(),
      date: new Date().toISOString(),
      text,
      kind: 'human',
      parentId: threadId,
    };
    this.suppressBlurReset = true;
    this.activeReplyThreadId = null;
    this.activeReplyText = '';
    view.dispatch(view.state.tr.setMeta(commentsKey, addReplyMeta(threadId, comment)));
    this.suppressBlurReset = false;
    view.focus();

    // AI re-invocation rules:
    //   - If the thread already contains an AI comment (an AI
    //     conversation in progress), every human reply re-invokes
    //     the model with the full thread as message history.
    //   - Otherwise, only an explicit `@AI` mention re-invokes
    //     (turns a non-AI thread into one).
    if (!settings.get('aiFeaturesEnabled')) return;
    const updatedThread = getCommentsState(view.state).threads.get(threadId);
    if (!updatedThread) return;
    const hasAiHistory = updatedThread.comments.some((c) => isAiComment(c));
    if (hasAiHistory || hasAiMention(text)) {
      this.invokeAi(threadId);
    }
  }

  /** Run the AI explainer against `threadId`. Builds the message
   *  list from the thread's full comment history (human turns →
   *  `user`, AI turns → `assistant`), with the first user message
   *  wrapped in the context-rich explainer prompt. The context is
   *  cached at thread creation; if none is cached (e.g. an `@AI`
   *  mention in a regular `+` thread, or a follow-up much later),
   *  we rebuild from the thread's current comment_range position. */
  private invokeAi(threadId: string): void {
    const view = this.getView();
    if (!view) return;
    if (!settings.get('aiFeaturesEnabled')) {
      showToast('AI features are disabled — enable them in Settings.');
      return;
    }
    const apiKey = settings.get('anthropicApiKey').trim();
    if (!apiKey) {
      showToast('Set an Anthropic API key in Settings to use AI features.');
      return;
    }
    const thread = getCommentsState(view.state).threads.get(threadId);
    if (!thread) return;

    let ctx = this.aiContextByThread.get(threadId) ?? null;
    if (!ctx) ctx = this.contextFromCurrentRange(threadId);
    if (!ctx) {
      showToast('Could not build context for AI request.');
      return;
    }
    const promptCtx = ctx;
    // Re-cache so subsequent multi-turn requests can reuse it
    // without rebuilding (and so we know what context the AI saw
    // originally even if the doc has shifted).
    this.aiContextByThread.set(threadId, promptCtx);

    // Build the multi-turn message list. First user turn carries
    // the formatted prompt with the surrounding context; later
    // turns are plain. Skip empty bodies defensively (e.g. an
    // empty-root thread that was opened then closed).
    const messages = thread.comments.flatMap((c, i): { role: 'user' | 'assistant'; content: string }[] => {
      if (!c.text.trim()) return [];
      if (isAiComment(c)) {
        return [{ role: 'assistant', content: c.text }];
      }
      const isFirstUserTurn = !thread.comments.slice(0, i).some((p) => !isAiComment(p) && p.text.trim());
      const content = isFirstUserTurn ? formatExplainPrompt(c.text, promptCtx) : c.text;
      return [{ role: 'user', content }];
    });
    if (messages.length === 0) return;

    // Identity for the AI comment: fixed `'AI'` initials and an
    // author name that either is `'AI'` (no persona) or ends with
    // `(AI)` (persona enabled). Both signals survive docx
    // round-trip; `isAiComment` keys off either to apply purple
    // styling on re-import. The old `kind: 'ai'` flag is no
    // longer used as the AI marker (it's stripped by Word) — new
    // AI comments are written with `kind: 'human'`.
    const aiAuthor = aiAuthorName();
    const aiInitials = 'AI';

    this.aiInFlight.add(threadId);
    // Force the AI thread to be the active (expanded) one for the
    // duration of the request. Without this, the textarea-blur
    // path on submit could shuffle active state and the user
    // would lose sight of the Thinking… placeholder and the
    // arriving AI reply.
    this.activeThreadId = threadId;
    this.activeBy = 'click';
    this.refreshStickyDismissListener();
    this.render();
    this.startActivityTicker();

    void (async () => {
      try {
        const reply = await callAnthropic({
          apiKey,
          system: EXPLAIN_SYSTEM_PROMPT,
          messages,
        });
        const aiComment: Comment = {
          id: newCommentId(),
          author: aiAuthor,
          initials: aiInitials,
          date: new Date().toISOString(),
          text: reply.text.trim(),
          // Always `'human'` on new comments — AI-ness is encoded in
          // `author` + `initials` so it survives docx round-trip.
          kind: 'human',
          parentId: threadId,
        };
        const v2 = this.getView();
        if (!v2) return;
        v2.dispatch(v2.state.tr.setMeta(commentsKey, addReplyMeta(threadId, aiComment)));
      } catch (e) {
        if (e instanceof AnthropicError) {
          showToast(`AI: ${e.message}`);
        } else {
          showToast(`AI error: ${e instanceof Error ? e.message : String(e)}`);
        }
      } finally {
        this.aiInFlight.delete(threadId);
        // Keep aiContextByThread so future follow-ups (multi-turn)
        // reuse the original surrounding context.
        if (this.aiInFlight.size === 0) this.stopActivityTicker();
        this.render();
      }
    })();
  }

  /** Rebuild an `ExplainContext` from the thread's CURRENT range
   *  in the doc. Used when an AI invocation happens on a thread
   *  whose original context wasn't cached (e.g. an `@AI` mention
   *  in a user-created thread). Returns null when the mark is no
   *  longer in the doc. */
  private contextFromCurrentRange(threadId: string): ReturnType<typeof buildExplainContext> {
    const view = this.getView();
    if (!view) return null;
    const ranges = collectRanges(view.state.doc);
    const range = ranges.get(threadId);
    if (!range) return null;
    const TextSelection = (view.state.selection.constructor as unknown) as {
      create: (doc: PMNode, from: number, to: number) => never;
    };
    const synth = view.state.apply(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, range.from, range.to)),
    );
    return buildExplainContext(synth);
  }

  private deleteThread(threadId: string): void {
    const view = this.getView();
    if (!view) return;
    // Strip the comment_range mark from the doc, then drop the
    // thread from plugin state. (The plugin's GC would also clean
    // it up, but doing both in one transaction keeps the undo
    // history coherent.)
    const tr = view.state.tr;
    const commentType = schema.marks['comment_range'];
    if (commentType) {
      view.state.doc.descendants((node, pos) => {
        if (!node.isText) return;
        for (const mark of node.marks) {
          if (mark.type.name === 'comment_range' && mark.attrs['threadId'] === threadId) {
            tr.removeMark(pos, pos + node.nodeSize, commentType);
            return;
          }
        }
      });
    }
    tr.setMeta(commentsKey, deleteThreadMeta(threadId));
    view.dispatch(tr);
  }

  private deleteComment(threadId: string, commentId: string): void {
    const view = this.getView();
    if (!view) return;
    view.dispatch(view.state.tr.setMeta(commentsKey, deleteCommentMeta(threadId, commentId)));
  }

  private scrollToRange(range: { from: number; to: number }): void {
    const view = this.getView();
    if (!view) return;
    // Move the editor cursor to the start of the range (drives the
    // cursor → active-thread tracking in `editor/index.ts`).
    const TextSelection = (view.state.selection.constructor as unknown) as {
      create: (doc: PMNode, from: number, to?: number) => never;
    };
    try {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, range.from)));
    } catch {
      // Cursor placement may fail if the position isn't inside an
      // inline-content block — skip the caret move, still scroll below.
    }
    // Jump the EDITOR to the anchored text — same mechanism as the nav
    // pane's reliable "jump to heading" (`preciseScrollIntoView`): an
    // instant scroll that re-measures + converges, so it doesn't
    // undershoot when content-visibility:auto cards realize their real
    // height mid-scroll (the cause of the "smooth but inaccurate" drift).
    try {
      const at = view.domAtPos(range.from);
      let node: Node | null = at.node ?? null;
      while (node && node.nodeType !== Node.ELEMENT_NODE) node = node.parentNode;
      if (node instanceof HTMLElement) preciseScrollIntoView(view, node, 'center');
    } catch {
      // Position detached / not yet laid out — ignore.
    }
  }

  /** Apply a comment_range mark to the current selection, build an
   *  empty thread, and mark it so the user's first submission
   *  auto-invokes the AI explainer. Returns the new thread id (or
   *  null when the selection was empty / AI was disabled).
   *
   *  Also caches the explainer context at this moment — so if the
   *  doc shifts before the user submits, the AI still sees what
   *  the original selection meant. */
  addAiThreadFromSelection(view: EditorView): string | null {
    if (!settings.get('aiFeaturesEnabled')) {
      showToast('AI features are disabled — enable them in Settings.');
      return null;
    }
    const { state } = view;
    const sel = state.selection;
    if (sel.empty) return null;
    const commentType = schema.marks['comment_range'];
    if (!commentType) return null;

    const ctx = buildExplainContext(state);
    if (!ctx) return null;

    const threadId = newCommentId();
    const root: Comment = {
      id: threadId,
      author: settings.get('commentAuthor'),
      initials: settings.get('commentAuthorInitials').trim(),
      date: new Date().toISOString(),
      text: '',
      kind: 'human',
      parentId: null,
    };
    const thread: Thread = { id: threadId, comments: [root] };

    this.pendingAiFirst.add(threadId);
    this.aiContextByThread.set(threadId, ctx);

    const tr = state.tr;
    tr.addMark(sel.from, sel.to, commentType.create({ threadId }));
    tr.setMeta(commentsKey, addThreadMeta(thread));
    view.dispatch(tr);
    return threadId;
  }

  /** Focus the brand-new thread's reply input so the user can
   *  start typing their first comment immediately after the
   *  "add comment" action runs. */
  focusReplyForThread(threadId: string): void {
    this.activeReplyThreadId = threadId;
    this.activeReplyText = '';
    // Defer to next frame so the DOM has been re-rendered.
    requestAnimationFrame(() => {
      const card = this.root.querySelector(
        `[data-thread-id="${cssEscape(threadId)}"]`,
      );
      if (!card) return;
      const ta = card.querySelector<HTMLTextAreaElement>('textarea.pmd-comment-reply-input');
      if (ta) ta.focus();
    });
  }
}

// ----------------------- helpers --------------------------------

function collectRanges(doc: PMNode): Map<string, { from: number; to: number }> {
  // Lowest position wins (= first occurrence in doc order). Multiple
  // segments of the same thread get merged into a single range
  // spanning their min/max positions, so a multi-paragraph comment
  // still scroll-anchors to its first segment.
  const out = new Map<string, { from: number; to: number }>();
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (const mark of node.marks) {
      if (mark.type.name !== 'comment_range') continue;
      const id = String(mark.attrs['threadId'] ?? '');
      if (!id) continue;
      const r = out.get(id);
      if (r) {
        r.from = Math.min(r.from, pos);
        r.to = Math.max(r.to, pos + node.nodeSize);
      } else {
        out.set(id, { from: pos, to: pos + node.nodeSize });
      }
    }
  });
  return out;
}

/** Decide what to render in the avatar circle. Returns a short
 *  initials string when we have something better than slicing two
 *  letters off a single-word name (which produces "Yo" for "You"
 *  and similarly silly results). Returns null when the caller
 *  should render a generic silhouette icon instead. */
function badgeText(authorName: string, explicitInitials: string): string | null {
  const explicit = explicitInitials.trim();
  if (explicit) return explicit.slice(0, 3).toUpperCase();
  const parts = authorName.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return ((parts[0]?.[0] ?? '') + (parts[parts.length - 1]?.[0] ?? '')).toUpperCase();
  }
  // Single-word or empty author name — no good initials to derive.
  return null;
}

/** Build a small head-and-shoulders silhouette SVG. Sized to fit
 *  inside the 1.4rem badge circle without specific width/height —
 *  inherits via 100%/100% so the badge's existing dimensions
 *  apply. */
function buildSilhouetteSvg(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('width', '60%');
  svg.setAttribute('height', '60%');
  svg.setAttribute('aria-hidden', 'true');
  const head = document.createElementNS(ns, 'circle');
  head.setAttribute('cx', '12');
  head.setAttribute('cy', '8');
  head.setAttribute('r', '4');
  const body = document.createElementNS(ns, 'path');
  body.setAttribute('d', 'M4 22c0-4.4 3.6-8 8-8s8 3.6 8 8H4z');
  svg.appendChild(head);
  svg.appendChild(body);
  return svg;
}

/** Populate a badge element with either initials text or a silhouette
 *  icon. Always clears `el` first so re-renders don't accumulate
 *  stale children. */
function fillBadge(el: HTMLElement, authorName: string, storedInitials: string): void {
  el.replaceChildren();
  const text = badgeText(authorName, storedInitials);
  if (text) {
    el.textContent = text;
  } else {
    el.appendChild(buildSilhouetteSvg());
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // Short local-time format — matches Word's compact comment date.
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function cssEscape(s: string): string {
  // Minimal CSS escape for our slug-shaped thread ids; sufficient
  // since allocated ids are stringified integers.
  return s.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

// ----------------------- commands --------------------------------

/** Apply a comment_range mark to the current selection and add the
 *  thread to plugin state. Returns the new thread's id (so the
 *  caller can scroll the side column to the new card). No-op when
 *  the selection is empty or already entirely commented. */
export function addCommentToSelection(view: EditorView): string | null {
  const { state } = view;
  const sel = state.selection;
  if (sel.empty) return null;
  const commentType = schema.marks['comment_range'];
  if (!commentType) return null;

  const threadId = newCommentId();
  const commentId = threadId; // root comment id == thread id
  const root: Comment = {
    id: commentId,
    author: settings.get('commentAuthor'),
    initials: settings.get('commentAuthorInitials').trim(),
    date: new Date().toISOString(),
    text: '',
    kind: 'human',
    parentId: null,
  };
  const thread: Thread = { id: threadId, comments: [root] };

  const tr = state.tr;
  tr.addMark(sel.from, sel.to, commentType.create({ threadId }));
  tr.setMeta(commentsKey, addThreadMeta(thread));
  view.dispatch(tr);
  return threadId;
}
