# Detailed Changelog

In-depth release notes for CardMirror. Each entry covers the
behavior, rationale, and (where useful) the implementation context
behind a change. For a shorter, jargon-free summary of what's new
in each release, see `CHANGELOG.md`.

## Unreleased

- **Ribbon resizer reserves a column-gap-sized buffer before the
  overflow trigger fires.** `initRibbonResizer` in `index.ts`
  previously used `scrollWidth > clientWidth + 1` as its overflow
  predicate, hiding a panel only after the ribbon's content had
  literally exceeded its available width. The visible artifact:
  just before the next panel hid, the rightmost panel button
  collided with the right-pinned timer button (no visible gap).
  Now an `overflowBuffer` is measured from a sample panel's
  computed `column-gap` (cite-panel / formatting-panel / color-
  panel — all use 3-4px gaps; fallback 4) and subtracted from
  `clientWidth` in the predicate, so a panel is hidden one gap-
  width before the actual overflow point. The un-hide branch
  uses the same predicate, so the trigger is symmetric — panels
  also wait one extra gap of growing room before reappearing,
  preventing flicker right at the threshold.

- **Layer 3 trailing-space trim no longer eats a whitespace-only
  selection.** The `trimRangesForFormatting` in
  `ribbon-commands.ts` used to shave one trailing space from
  every range whose last char was a space, regardless of what
  else was in the range. For an explicitly-selected single space
  (or any whitespace-only run), the shave produced an empty
  range and F9 / F10 / F11 / cite / underline / shading all
  no-op'd silently — there was no way to format a deliberately-
  selected trailing space.

  New rule (the spec calls it Rule 3): trim the trailing space
  iff `[from, to - 1]` contains at least one non-space text
  character. Monotonic — when there's word content, exactly one
  trailing space is always shaved; when the range is whitespace
  only, nothing is shaved. New `hasNonSpaceChar(doc, from, to)`
  helper walks text leaves between the positions and short-
  circuits on the first non-space char (per `classifyChar` from
  `word-break.ts`). Considered Rule 2 ("trim iff the char at
  `to - 2` isn't a space"), which lets the user deliberately
  format multi-trailing-space tails after a word — rejected for
  the surprising toggle (adding one more trailing space to your
  selection flips whether the others get formatted). Rule 3 is
  predictable; the rare multi-trailing-space case can be worked
  around by selecting one char past the spaces or by selecting
  just the spaces.

- **AI cite creator now guarantees the cite stands alone in its
  own paragraph.** Refactor of `applyCiteToSelection` in
  `ai/cite-creator.ts` into a (testable) `buildCiteTransaction`
  helper. The existing pipeline still runs first — `tr.insertText`
  to replace the selection, `tr.removeMark` to strip inherited
  boundary marks, per-token `tr.addMark` to apply `cite_mark` to
  the leading "Lastname Date" pieces. After that, two new
  defensive splits: if the surrounding textblock has inline
  content AFTER the cite end (the common bug case — selection
  spanned a paragraph break and the trailing text from the last
  selected paragraph is now joined onto the cite), `tr.split(end)`
  to break out the tail. Symmetric `tr.split(start)` when there's
  pre-cite content in the same textblock. The after-split runs
  first so the start position doesn't need remapping. Both
  wrapped in try/catch — schema-illegal splits (e.g., a second
  tag inside one card) fall back to the inline-cite shape rather
  than crashing. `applyCiteToSelection` now just calls the
  builder and dispatches.

- **Highlight Acronym (Alt+F11) added; Emphasize Acronym
  rebound from Ctrl+F10 to Alt+F10.** New
  `highlightAcronym(activeColor)` in `ribbon-commands.ts`
  mirrors `emphasizeAcronym`'s per-word-first-letter walk: for
  each textblock the selection touches, build a word-class map
  (`isWordChar` from `word-break.ts`), expand the selection
  range to whole-word boundaries, then emit the start position
  of each word inside that expanded range. The selection-expand
  rule and word definition are identical to Emphasize Acronym
  (so `U.S.A.` is three words per the spec, and the command
  marks `U`, `S`, `A` individually).

  Two deliberate deviations from Emphasize Acronym, parallel to
  the differences between `applyHighlight` and `applyEmphasis`:
  (1) no `NAMED_STYLE_SKIP_BLOCKS` gate — highlight is allowed
  in structural textblocks (tags, analytics, pockets, hat,
  block, undertag), matching the F11 toggle's reach; (2) no
  `stripDirectFormattingOnApply` — highlight is additive and
  shouldn't change the marked character's other formatting. The
  apply uses `tr.removeMark(...highlight) + tr.addMark(...
  highlight.create({color}))` per first-letter slot so a new
  active color wins over any existing highlight on those slots
  (parallel to `applyHighlight`'s apply-branch behavior).

  Bindings: `Mod-F10` → `Alt-F10` for Emphasize Acronym, plus
  new `Alt-F11` → Highlight Acronym in `DEFAULT_RIBBON_KEYS`.
  Both stay rebindable via Settings → Keybindings. The Ctrl-F10
  rebinding choice keeps Mod-F10 (which on Win/Linux is
  Ctrl-F10) available for future use; symmetric to Mod-F11
  (Ctrl-F11, Apply Shading) and F11 (Apply Highlight) already
  occupying the highlight column. `ribbon-groups.ts` lists
  Highlight Acronym next to Apply Highlight in the Character
  Styles group so the settings UI surfaces it near its
  conceptual sibling.

- **Viewport-rockets-to-doc-end on paste / F7 fixed by
  changing the absorb-plugin from a wholesale doc replace to
  per-region surgical edits.** Two community reports surfaced
  the same underlying bug: (1) Cumdog: pasting multi-line text
  with an F7-styled tag somewhere above sends the cursor to the
  very end of the doc; (2) Buntin: pressing F7 on a paragraph
  that has any doc-level paragraphs below it does the same.
  Both reduce to the same root cause — the card-body
  absorption rule (an `appendTransaction` plugin that absorbs
  doc-level paragraphs / cite_paragraphs / undertags after a
  card or analytic_unit) was doing the rewrite in a single
  `tr.replaceWith(0, doc.content.size, rebuilt)`. PM's default
  selection mapping treats the deleted range as fully replaced
  and pushes the cursor (with association-right) to the END of
  the inserted content, which for the absorb tr is the end of
  the last absorbed orphan-now-card-body.

  The new shape: walk the doc to find each contiguous
  absorption region (a `card` / `analytic_unit` followed by
  one or more absorbable doc-level siblings), then for each
  region, in a single transaction, perform two surgical steps
  right-to-left so position arithmetic stays valid: (a)
  `tr.insert(cardContentEnd, absorbedBodiesFragment)` to put
  the new bodies inside the card just before its closing
  boundary, and (b) `tr.delete(orphansStart + insertedSize,
  orphansEnd + insertedSize)` to remove the originals from doc
  level. The cursor (typically NOT inside the moved orphans —
  it's in the absorbing card's tag, or somewhere unrelated)
  stays exactly where it was. The existing
  `absorbedDocChildren` helper is retained for tests that
  probe absorb behavior directly. New `findAbsorbRegions`
  function returns the per-region `{ absorbingPos,
  absorbingNodeSize, orphansStart, orphansEnd, bodiesContent }`
  shape that the new appendTransaction consumes.

- **Phantom-empty-tag card on multi-paragraph paste fixed by
  pre-fitting the slice in the paste handler.** Pasting two or
  more paragraphs into a `card_body` that has sibling
  `card_body`s used to bubble PM's slice fit up to the card
  level: the original card split into two cards with the
  second one carrying an empty `tag` and the original
  trailing card_bodies absorbed into it. Root cause: PM's
  `replace`-with-slice fitting can't insert a multi-paragraph
  slice into a `card_body` (whose content rule is `inline*`)
  without splitting, so it lifts the split up until the slice
  fits as siblings — which at the card level requires opening
  a new card, which requires a tag (= empty placeholder tag).

  New `tryPasteAsCardBodies(state, slice)` in
  `paste-plugin.ts` runs after the existing head-detection
  branch in `handlePaste`. When the slice is 2+ top-level
  paragraphs and the cursor's parent is a `card_body` inside
  a `card` or `analytic_unit`, it converts each paragraph into
  a `card_body` of the same content (preserving inline marks)
  and dispatches the replace with the new slice. The cursor's
  containing card now naturally accepts multiple `card_body`s
  as siblings, so the split stays inside the card.
  `openStart` / `openEnd` carry through from the original
  slice so the first body still joins inline with the
  pre-cursor text and the last body still joins inline with
  the post-cursor text — same UX as a single-paragraph paste,
  just with the multi-line break preserved at the card_body
  boundary. Falls through to PM's default for single-paragraph
  slices, slices with non-paragraph top-level children
  (carries / wholesale-card pastes go through the existing
  head-detection branch), and cursors outside the card_body
  context.

- **Copy Last Cite at offset 0 of a paragraph now inserts the
  cite BEFORE that paragraph instead of after.** Community
  report (Cumdog): in a multi-paragraph card with a tag but no
  cite, putting the cursor at the start of the card and
  pressing the Copy Last Cite hotkey lands the cite at the
  start of the SECOND body, not between the tag and the first
  body. Cursor at the END of the tag worked correctly. Root
  cause was in `computeCitePasteLocation` in
  `ribbon-commands.ts`: outside the empty-paragraph branch the
  code always returned `$from.after(paraDepth)` — the position
  AFTER the cursor's containing paragraph. For a cursor at
  offset 0 of the first body, "after the first body" is
  visually where the second body begins, which is where the
  cite ended up.

  Added a new branch: when the cursor sits at `parentOffset
  === 0` of a `REPLACE_IF_EMPTY` paragraph (`card_body`,
  `cite_paragraph`, `undertag`, `paragraph`) that has content,
  return `$from.before(paraDepth)` — the position BEFORE the
  paragraph — so the cite lands at the visual cursor position
  (above that paragraph in the parent's child list). Cursor
  mid-paragraph and end-of-paragraph still fall through to the
  existing `$from.after(paraDepth)` branch. The empty-paragraph
  branch (replace-the-paragraph-with-the-cite) is unchanged
  and still runs first.

- **Ctrl+Up / Ctrl+Down with an active selection no longer
  carries the caret into the adjacent paragraph.** The plain
  (no-Shift) variants now collapse the selection by snapping to
  the start (Up) or end (Down) of the paragraph that contains
  the corresponding selection edge (`$from` for Up, `$to` for
  Down), instead of computing the destination from
  `selection.$head`. Previously, with a selection where the
  head was at the bottom edge, Ctrl+Down ran
  `destNextParaStart` and moved to the NEXT paragraph's start;
  symmetric for Ctrl+Up with head at the top edge running
  `destPrevParaStart`. New `verticalCommandPair` in
  `word-selection-keymap.ts` mirrors the existing
  `horizontalCommandPair` (which handled the Ctrl+Left/Right
  collapse case): when `selection.empty` is false and Shift is
  not held, the move command snaps to the paragraph edge of
  the relevant selection corner and stops. Shift-extend
  variants (`Ctrl-Shift-ArrowUp / -ArrowDown`) keep the
  existing extend semantics by passing through to the base
  command pair.

  Down-side asymmetry: after `Ctrl-Shift-ArrowDown`,
  `selection.$to` lands at `parentOffset === 0` of the
  paragraph BELOW the last visually-selected paragraph
  (`destNextParaStart` walks to the next paragraph's START,
  not the current one's end). A naïve `$to.end()` snap there
  would carry the cursor to the end of a paragraph the user
  never saw as part of the selection. When the down-side
  corner is at `parentOffset === 0`, the fix falls back to
  `prevTextblock(doc, corner.start()).end` — the end of the
  last *visibly* selected paragraph. The symmetric Up case
  doesn't arise via `Ctrl-Shift-ArrowUp` because
  `destPrevParaStart` lands inside the upper textblock (at its
  content-start, not past it), so `selection.$from` is always
  inside the visual selection.

- **Ctrl+Left / Ctrl+Right with a selection now snap to the
  word edge of the corner, not just collapse.** Refines the
  earlier "collapse to selection.from / .to" behavior of
  `horizontalCommandPair` so it matches `verticalCommandPair`'s
  paragraph-edge snap, one notch finer. With a non-empty
  selection and Shift NOT held: take the corner (`$from` for
  Ctrl+Left, `$to` for Ctrl+Right); if the corner is INSIDE a
  word/punct run (left and right flanking chars are the same
  word/punct class), snap to that run's edge via the same
  `prevUnitStart` / `nextUnitStart` iterator the no-selection
  variants use (including the spec's trailing-space absorption
  on the right side); otherwise collapse to the corner. The
  "otherwise" branch is the analog of `verticalCommandPair`'s
  `$to.parentOffset === 0` fallback — when the corner already
  sits at a unit boundary (textblock edge, adjacent to
  space/tab, or at a word↔punct transition), end-of-prev-unit
  and start-of-next-unit are the same position, so the snap is
  a no-op and we just collapse.

  Concrete: select "The" inside "Therefore" → Ctrl+Right lands
  the cursor at the end of "Therefore" (with trailing-space
  absorption if the word has one). After a Ctrl+Shift+Right
  that absorbed past a word's trailing space (head at start of
  the next word), plain Ctrl+Right just collapses there — does
  NOT push further into the next word, matching the analogous
  Ctrl+Shift+Down → Ctrl+Down behavior. Helper
  `isInsideWordOrPunctUnit(map, offset)` does the boundary
  check.

## 0.1.0-alpha.4 — 2026-05-22

- **Layer 2 (keyboard navigation keymap) from the Word-selection
  spec.** New `src/editor/word-selection-keymap.ts` adds bindings
  that override the browser's regex-style word iteration:

  - `Ctrl-ArrowLeft / Ctrl-ArrowRight` (`Alt-` variants for Mac)
    → start of previous / next unit. Walks the textblock's
    per-position class map using `classifyChar` from
    `word-break.ts`, so `don't` is one unit, `U.S.A.` is three.
    Cross-textblock: at offset 0 jumps to the start of the
    previous textblock's LAST unit; at offset == content.size
    jumps to the next textblock's first unit start.
  - `Ctrl-ArrowUp / Ctrl-ArrowDown` (`Alt-` variants on Mac) →
    start of current / next paragraph. Asymmetric: Ctrl+Up has
    an intermediate stop at the current paragraph's start
    (matching Word); Ctrl+Down skips straight to the next
    paragraph with no equivalent stop at the current
    paragraph's end.
  - `PageUp / PageDown` → previous / next heading marker. Same
    shape as Ctrl+Up/Down but using `collectHeadings`'s set
    (pocket / hat / block / tag / analytic from
    `headings.ts:TYPE_TO_LEVEL`). PageUp is asymmetric the same
    way Ctrl+Up is — first stop at the current heading's
    start, then the previous heading on a subsequent press.
  - `Shift-` variants of every move command extend the
    selection (anchor pinned, head moves) so the keymap
    naturally pairs with the mouse state machine.

  The keymap sits ABOVE `baseKeymap` in the plugin list so its
  Ctrl+Arrow / PageUp/Down bindings take precedence. `Home`,
  `End`, `Ctrl+Home`, `Ctrl+End` are deliberately left on the
  browser default — visual-line and doc start/end already match
  the spec.

- **Layer 2 (mouse-selection state machine) from the Word-
  selection spec.** New `src/editor/word-selection-plugin.ts`
  implements the click + drag + shift+click contract:

  - **Single click.** Anchor = a point (the click position).
    Granularity = character, dynamic. Dragging within the
    click's enclosing unit (W0) keeps character granularity
    and the selection is exactly `point..activeEnd`. Dragging
    PAST W0's boundary upgrades to word granularity and pulls
    the rest of W0 into the selection (anchor unit becomes W0
    in full); subsequent extension proceeds by full units.
    Reversing back inside W0 downgrades to character granularity
    and snaps back to `point..activeEnd`.
  - **Double click.** Anchor = the Layer 1 query unit (with
    trailing-space absorption). Granularity = word, fixed.
    Drag extends by bare units (only the initiating click
    absorbs trailing space; subsequent units do NOT). The
    anchor unit stays fully selected even when the drag
    reverses direction.
  - **Shift+click.** Same operation as drag: moves the active
    end under the current anchor + granularity. After a
    double-click, shift+click extends by word. After a single
    click, follows the dynamic single-click rule. Shift+
    double-click and shift+triple-click are no-ops per spec.
  - **Triple click.** Anchor = the containing textblock range,
    granularity = paragraph (fixed). Drag extends one whole
    paragraph at a time; the anchor paragraph stays fully
    selected when the drag reverses. Shift+click after a
    triple-click extends paragraph-by-paragraph — same
    mechanism as the drag.

  The earlier `triple-click-drag-plugin.ts` has been removed —
  its drag-extension logic is folded into the unified state
  machine, and dispatches now carry the
  `pmd:word-selection-plugin` meta so the `apply` hook doesn't
  treat them as external selection changes (which would have
  invalidated the freshly-set paragraph anchor before the next
  shift+click could read it).

  The plugin tracks a module-level `currentAnchor` so shift+
  click after a gesture remembers granularity. An external
  selection-changing transaction (typing, arrow keys,
  programmatic dispatch) marks the anchor stale via a
  `selectionSet`-watching `apply` hook; the next shift+click
  rebuilds a fresh point anchor from PM's
  `selection.anchor`. Dispatches set a
  `pmd:word-selection-plugin` meta on each transaction so we
  can tell ours apart from external ones.

  Atom inline-nodes (images) skip the plugin so PM's default
  NodeSelection still fires on image clicks. `event.preventDefault()`
  on mousedown blocks the browser's default focus transfer in
  the no-op-selection case (single-click at an existing caret
  spot); `view.focus()` is called explicitly to compensate.

- **Layer 1 (word-break iterator) + Layer 3 (formatting trim)
  from the Word-selection spec.** Spec lives at
  `~/Downloads/word-selection-behavior.md`; this commit lands
  the first two of three layers (Layer 2 — custom mouse +
  keyboard selection gestures — comes later).

  New `src/editor/word-break.ts` is the single source of truth
  for what counts as a word. Three-class scheme: word-character
  (letters, digits, `'` U+0027, `'` U+2019), space (U+0020 +
  Unicode whitespace, excluding tab), tab (atomic, never
  groups), punctuation (everything else, including `'` U+2018,
  `_`, `-`, em / en dashes, `.`, `,`, `:`, `;`, `…`). Four base
  units (word, punctuation, space, tab) with asymmetric
  trailing-space absorption: querying a word OR punctuation
  unit extends to include any immediately-following space unit,
  but querying a space unit does NOT reach backward. Tab never
  absorbs. Implementation uses Unicode-aware character classes
  (`\p{L}\p{N}`) so non-ASCII letters and digits are word
  characters; surrogate pairs fall through whichever class
  their first code unit suggests.

  Both pre-existing word-iterators have been replaced:
  `wordRangeAtCursor` in `ribbon-commands.ts` (used by the F7
  Emphasis, F8 Cite, F10 Emphasize Acronym word-expansion
  fallback) and `isWordChar` in `find-replace-plugin.ts` (used
  by the whole-word Find toggle) both call into the new
  iterator. Behavioral consequences: whole-word Find treats `_`
  as a boundary now (`\w`-style regex matched it as a word
  char), F10 Emphasize Acronym on "U.S.C.P." emphasizes
  U / S / C / P instead of just the leading U, and so on.

  Layer 3 lands as a `trimRangesForFormatting(doc, ranges)`
  helper in `ribbon-commands.ts` and a
  `getOperatingRangesForFormatting(state)` wrapper around the
  similar-selection-plugin's `getOperatingRanges` — every
  formatting command's call-site swapped to the wrapper.
  Commands that bypass `getOperatingRanges` (the non-shadow
  branches in `adjustFontSize` / `setFontSize` / `runUniColor`
  / `highlightToShading` / `shadingToHighlight` / strip-mark in
  `color-panel.ts`) trim inline against `sel.from / sel.to`.
  `shadowAwareToggleMark` was previously falling through to
  PM's `toggleMark` on the non-shadow path; it now unifies
  through the trimmed-ranges path so the keyboard Ctrl+B /
  Ctrl+I / Ctrl+U bindings get the trim too.

- **Duplicate-open guard on the file-open path.** The workspace
  doesn't currently support having multiple copies of the same
  doc open — opening a duplicate would create a second
  `DocRecord` with its own undo history, journal, and dirty
  state, which is a confusing UX. The two entry points now
  check before loading:

  - Single-pane (`runOpenFlow`): compares `opened.handle`
    against `currentDocHandle`.
  - Multi-pane shell (`onFileOpen` ribbon path +
    `openFileIntoSlot` per-slot button): a new
    `findOpenRecordByHandle` walks every slot's stack. On
    match, the existing copy is brought to its slot's visible
    record and the slot is focused, so the user lands on the
    doc they "tried to open."

  Handle equality goes through a new
  `isSameOpenHandle(a, b)` helper in `host/index.ts` — string
  comparison on Electron paths, `FileSystemFileHandle
  .isSameEntry()` on the browser. Never-saved docs (handle
  null) aren't deduped — we have no identity to compare yet.

  Cross-window duplicates are also covered on Electron via a
  main-process path map (`Map<canonical-path, windowId>`).
  Three new IPC handlers in `apps/desktop/src/main.ts`:

  - `host:open-path-check(path)` is the read-only pre-load
    probe. If another window owns the path, main focuses that
    window (restoring it if minimized) and returns
    `{ takenByOther: true }` so the caller can toast + abort.
  - `host:open-path-register(path)` claims a path for the
    caller window once a doc has finished mounting.
  - `host:open-path-release(path)` drops the claim on
    unmount / Save-As to a new path.

  Window-close auto-cleanup runs in the existing `browser-
  window-created → closed` listener so a force-quit can't
  leave stale entries blocking re-opens. The `host:spawn-
  window` handler also claims the new window's path
  atomically at spawn time so a concurrent open from a third
  window can't sneak in between spawn and the new window's
  mount. Renderers wire through a centralized
  `setCurrentDocHandle` helper (single-pane) /
  `syncDocPathClaim` helper (multi-pane shell) — each is
  called at every handle-assignment site (open, recovery,
  spawn-target initial mount, Save-As, close) so the
  registration map stays in sync. Browser host has no
  multi-window concept and no-ops these methods.

- **Comments column ported to multi-pane as a shell-row
  sibling.** Previously the column was hidden whenever
  `multiDocWorkspace` was on and the Add Comment / Ask AI ribbon
  commands refused to run. The shell now adopts the shared
  `#comments-column` as a sibling of `.pmd-multi-row` —
  `.pmd-multi-shell` is `flex-direction: row` so the multi-row
  takes `flex: 1` and the column takes its persisted width via
  `--pmd-comments-width`. Visually it reads as a narrow fourth
  slot that shrinks the three doc panes equally instead of
  cutting into the focused pane only.

  Threads follow focus: `focusSlot` calls
  `commentsColumn.render()` so cards rebuild against the newly
  active view (the column's `getView` already returns
  `setActiveView`'s tracked view). Because the column lives
  outside every pane's scroll container, scrolling the focused
  doc would otherwise leave cards stranded at the wrong Y —
  `attachFocusedScrollSync` installs a rAF-throttled scroll
  listener on the focused `.pmd-pane-body` that calls
  `CommentsColumn.relayoutCards()`. The listener tears down and
  re-installs on every focus change; `handleSlotEmptied`
  detaches it when the last doc closes.

  Per-record `dispatchTransaction` now calls
  `notifyCommentsForActiveTransaction` (a new helper exported
  from `editor/index.ts`); it short-circuits unless the
  transaction belongs to the active view, so background-stack
  edits in non-focused panes don't paint over the focused doc's
  column. `buildDocRecord` now accepts an optional `threads`
  array and dispatches `loadThreads` after `record` is
  initialized (a `dispatchTransaction` closing over `record`
  meant earlier dispatch placement hit a TDZ);
  `loadOpenedIntoSlot` (docx + cmir) and `onRecoveredDoc` pass
  threads through so docs land in multi-pane with their
  comments already in plugin state.

  Layout-pinning cleanups carried over from the single-pane
  fix: `desiredTop` no longer clamps at 0 — a heading scrolled
  above the editor's top gives a negative diff in multi-pane
  (column is decoupled from the scroll container), and cards
  should slide off the top symmetrically with the bottom rather
  than pile against `top: 0`. `actualTop` packing math
  similarly allows negative values. Single-pane is unaffected
  because column and editor share a scroll container — the
  diff stays positive in that mode.

- **AI-comment identification moved from `kind: 'ai'` to a
  round-trip-safe shape: fixed `'AI'` initials + a `(AI)` suffix
  on the author name.** The `kind` field doesn't survive a docx
  round-trip — Word has no concept of AI vs human, so when a doc
  is saved as docx and re-imported, every comment comes back as
  `kind: 'human'`. AI comments lost their purple-badge styling
  in the process. New AI comments now carry the AI marker in
  fields that DO round-trip: `initials: 'AI'` (regardless of
  persona) and an author name like `Clod (AI)` (or just `'AI'`
  when no custom persona is set — no double-suffix). A new
  `isAiComment(comment)` helper recognizes either signal and
  drives the existing `.pmd-comment-ai` purple styling path.
  The helper also honors legacy `kind: 'ai'` so comments saved
  before this change keep their styling. New AI comments are
  written with `kind: 'human'`. The small inline "AI" tag that
  used to sit next to the author name has been removed —
  redundant with the `(AI)` suffix that's now baked into the
  name. CSS class `.pmd-comment-kind-tag` deleted.

- **Multi-pane workspace shortcuts moved into the ribbon
  registry; all rebindable via Settings → Keybindings.** Eight
  new `RibbonCommandId`s with defaults matching what shipped
  earlier in this Unreleased cycle:

  - `focusSlot1` / `focusSlot2` / `focusSlot3` → `Mod-1/2/3`
  - `sendDocToSlot1` / `sendDocToSlot2` / `sendDocToSlot3` →
    `Mod-Shift-1/2/3`
  - `toggleSlotExpand` → `Mod-Shift-f`
  - `closeDocOrWindow` → `Mod-w`

  Each gets a label, default-key entry, group placement (new
  "Multi-pane workspace" section in `ribbon-groups.ts`), a
  no-op `Command` case in `commandFor` (the keymap matcher
  doesn't need to do anything — these are view-less actions),
  and an entry in `VIEWLESS_RIBBON_COMMANDS`. The global
  window keydown handler in `editor/index.ts` dispatches them
  via `runViewlessRibbon`, which now calls into a small new
  `runMultiPane` helper that dynamic-imports the shell module
  and invokes one of three new exports:

  - `focusSlotByIndex(idx)`
  - `sendVisibleToSlotByIndex(idx)`
  - `toggleFocusedSlotExpand()`

  These are thin wrappers around new `MultiPaneShell` methods
  (`focusSlotByIndex`, `sendVisibleToSlotByIndex`,
  `toggleFocusedSlotExpand`). `closeDocOrWindow` uses the
  existing `tryCloseVisibleInFocusedSlot` + fallback to
  `handleUserCloseRequest`.

  Two standalone `window` keydown listeners removed
  (`onSlotShortcutKey` and `onExpandToggleKey`) — the work
  flows through the global ribbon-keymap path now. The
  Electron menu's `CmdOrCtrl+W` accelerator stays hardcoded
  as a discoverability cue; if the user rebinds
  `closeDocOrWindow`, both paths fire the same action.

  Ribbon keymap matcher (`ribbonKeyStringFor`) now normalizes
  digit keys via `e.code` (e.g., `Digit1` → `1`) so
  `Mod-Shift-1` matches even though Shift+1 produces
  `e.key === '!'` on US keyboards (and layout-specific shifted
  digits elsewhere). Without the fix, the new `sendDocToSlotN`
  bindings wouldn't fire from the global handler. Letters and
  symbol keys still use `e.key`.

  The Ctrl+Tab doc-cycling overlay is the lone exception —
  its hold-and-press semantics (modifier held, Tab pressed
  repeatedly, modifier released to commit) don't fit the
  discrete-press ribbon-command model. The
  `onDocCycleKey` / `onDocCycleKeyUp` listeners stay on
  `window` with hardcoded `Tab` matching.

- **Multi-pane: Ctrl+Tab / Ctrl+Shift+Tab cycle docs within the
  focused slot.** New `Slot.cycleVisible(delta)` advances the
  visible doc index in a slot's stack with wrap-around. Wired
  via a new `onDocCycleKey` window keydown listener (mounted
  alongside the existing `onSlotShortcutKey` for Mod-N slot
  focus). Routes through the existing `showRecord` so the
  shared-chrome / focusSlot dance fires the same way as a
  click on the stack-dropdown menu would.

  Desktop (Electron) accepts plain Mod+Tab — Electron windows
  have no native tabs to cycle, so the keydown passes through
  to the renderer's JS unmodified. Web reserves the plain
  Mod+Tab chord for the browser's own tab cycling, so the
  renderer never sees the keydown there. The handler also
  accepts Mod+Alt+Tab as the web-edition fallback (and on
  desktop, which makes Mod+Alt+Tab a universal alias).
  Shift toggles direction.

- **Multi-pane: Ctrl+Shift+1 / 2 / 3 send the focused slot's
  visible doc to slot N.** Mirror of the Mod-N slot-focus
  chord. New `Slot.releaseVisible()` is closeVisible without
  the view destroy / journal drop: detaches the visible
  record's DOM, removes it from the stack, mounts the next
  visible doc (or empties the slot), and returns the released
  `DocRecord` so the shell can re-push it into the target
  slot's stack. The view stays live across the move, so the
  doc keeps its cursor, selection, undo history, autosave
  state, and any other view-attached state.

  Extended `onSlotShortcutKey` to differentiate the Mod-only
  chord (focus) from the Mod-Shift chord (send-to). The
  digit-match uses `e.code === 'Digit1'/'Digit2'/'Digit3'`
  rather than `e.key === '1'/'2'/'3'` because Shift-modified
  digits render as `!`/`@`/`#` (or layout-specific characters)
  in `e.key`; `e.code` is the physical-key identifier and
  works for both shifted and unshifted chords.

  Expand-mode edges handled via the existing notification
  callbacks: source emptying in expand mode drops expand
  mode; target receiving a doc while a different slot is
  expanded keeps the doc hidden until expand mode exits.

- **Exported .docx is Verbatim-recognized on open.** Verbatim's
  per-doc ribbon-visibility callback
  (`Ribbon.GetRibbonVisibility`, registered on every `<group>`
  in Debate.dotm's `customUI14.xml`) decides activation by
  reading `ActiveDocument.AttachedTemplate.Name`. To make our
  exports activate the Debate ribbon without the user clicking
  Verbatimize first, `Docx.empty()` in `src/ooxml/docx.ts` now
  emits:

  - `word/settings.xml` containing
    `<w:attachedTemplate r:id="rId1"/>`.
  - `word/_rels/settings.xml.rels` containing the rel with
    `Type=".../attachedTemplate"`,
    `Target="file:///Debate.dotm"`,
    `TargetMode="External"`.
  - The matching `<Override>` for the settings part in
    `[Content_Types].xml`.
  - A `<Relationship>` linking `document.xml` →
    `settings.xml` in `word/_rels/document.xml.rels` (added in
    `exporter.ts`'s `buildRelsXml`, claiming `rId2`; dynamic
    rels now start at `rId3`).

  Methodology: extracted Debate.dotm and the VBA strings dump
  pointed at `AttachedTemplate` + `InstallCheckTemplateName` as
  the recognition predicate. First experiment (the docVar
  hypothesis — setting `VerbatimVersion` in `<w:docVars>` to
  various values) was falsified — none of v2 / v3 / v4 / v5
  activated the ribbon. Second experiment
  (`<w:attachedTemplate>` with the rel in `document.xml.rels`)
  also failed; the diff against a doc that the Verbatimize
  macro itself produced showed the rel belongs in
  `settings.xml.rels`, not `document.xml.rels`. Third
  experiment landed it:

  - v8 (`Target="Debate.dotm"`, bare filename): failed.
  - v9 (full Windows path the Verbatimize macro wrote on the
    author's machine): worked on two different Windows
    installs, even though the path was hardcoded to the
    original user's folder — confirming Word doesn't validate
    the stored path file-system-exists, just reads the
    basename of the URI.
  - v10 / v11 / v12 (URI shapes with no / fake-Unix /
    fake-Windows path components): all three worked on
    Windows. v10 / v11 also worked on Mac Verbatim (a separate
    Mac Word notification-daemon hang was diagnosed via the
    crash report's call stack and confirmed unrelated).

  Picked v10 (`file:///Debate.dotm`) as the shippable Target —
  shortest URI that activates recognition; Word doesn't care
  whether the path is reachable.

  Round-trip safety: today's exporter doesn't preserve the
  input docx's `word/settings.xml`; `toDocx` always starts
  from `Docx.empty()`. So no merge logic is needed — every
  export ships with the recognition surface, whether the
  source was fresh or imported. Users who don't have Verbatim
  installed see no impact: the stored attached-template
  Target is unresolvable to them, Word falls back to
  Normal.dotm, no prompt, no UI shift.

  The experiment script
  (`reference-docs/experiment-verbatimize.mjs`, gitignored)
  stays around as a local diagnostic if Verbatim's
  recognition mechanism ever shifts in a future release.

- **Emphasize Acronym (Mod-F10).** New ribbon command for
  marking the source letters of an acronym. Algorithm:
  1. Bail if the selection is empty.
  2. For each textblock that overlaps the selection (skipping
     structural blocks via the existing `NAMED_STYLE_SKIP_BLOCKS`
     set — emphasis_mark is body-only), find the leftmost and
     rightmost non-whitespace character indices within the
     selection's clip range. If neither exists (selection is
     entirely whitespace), skip the block.
  3. Expand leftward and rightward through non-whitespace to
     reach whole-word boundaries (same word definition as
     `wordRangeAtCursor` — maximal run of non-whitespace within
     the textblock, inline leaves break words, mark boundaries
     don't).
  4. Walk the expanded range and emit a 1-character mark range
     for every word-start position (WS-to-non-WS transitions
     plus the initial position if non-WS).
  5. Apply `emphasis_mark` to each range plus the same direct-
     formatting strip `applyEmphasis` uses.

  Wired the standard ribbon-command surface — type union,
  registry array, label ("Emphasize Acronym"), default key
  (`Mod-F10` → "Ctrl+F10" on Win/Linux, "⌘F10" on Mac),
  dispatcher case, and `ribbon-groups.ts` placement next to
  `applyEmphasis` in the Character styles group so both the
  cheat sheet and the keybindings editor inherit the
  grouping.

- **Keybindings editor grouped by thematic section.** Lifted
  the `GROUPS` taxonomy out of `reference-ui.ts` into a new
  shared `ribbon-groups.ts` module as `RIBBON_GROUPS`. The
  drift-guard assertion (every `RibbonCommandId` lands in
  exactly one group, no duplicates, no orphans) moved with it
  and now protects BOTH surfaces — adding a new command
  without categorizing it throws at module load.

  Settings → Keybindings used to call
  `[...RIBBON_COMMAND_IDS].sort((a, b) => labelA.localeCompare(labelB))`
  and render every row in one alphabetical flat list (~70
  rows). Now iterates `RIBBON_GROUPS` instead: each group
  becomes a `<section>` with an uppercase muted `<h3>` heading
  + that group's commands in the order the group defines them
  (matching the cheat sheet's ergonomic clustering, not raw
  alphabetical). Group headings are `position: sticky; top:
  0` inside the scrollable list so users keep their place as
  they scroll through long sections like "Table" (10 rows).

  Single source of truth: editing `ribbon-groups.ts` updates
  both the cheat sheet and the rebinding editor. No more
  "remembered to update both" failure mode for future
  command additions.

- **Round-trip: hyperlink rel Targets are XML-attribute-escaped.**
  `exporter.ts`'s `buildRelsXml` was interpolating `rel.target`
  raw into the `Target="..."` attribute of each hyperlink
  `<Relationship>`. URLs containing `&` (the standard
  query-string parameter separator — extremely common in cite
  links) ended up as raw `&` in the XML, which is malformed.
  Word's loader uses a recovery-mode parser that pulls the
  document body through anyway, but flags the file as
  corrupted on open. User-reported symptom: round-trip of a
  doc with many cite hyperlinks opened on another machine as
  "we found a problem with some content" and images failed to
  display (likely because the rels XML failure cascaded into
  the relationship resolver giving up partway).

  Fix: pipe `rel.target` through the existing `escAttr` helper
  (`src/ooxml/xml.ts`) for both the hyperlink and image rel
  emission paths. `escAttr` escapes `&`, `<`, `>`, and `"` —
  the four chars that can break an attribute value. Image
  Targets are internally generated and currently safe, but
  symmetry / defense in depth justifies the escape there too
  (a future media filename with a special char would have the
  same problem).

  Detected via diff of a doc round-tripped through CardMirror
  against the same doc untouched: both opened in Word, but the
  round-tripped one reported corrupted on open. `xmllint
  --noout document.xml.rels` returned `EntityRef: expecting
  ';'` errors at exactly the unescaped `&` positions.

- **Plain-paste no longer splits cards on a trailing newline.**
  Long-standing user-reported bug ("skipping around on paste"
  / "viewport shoots to the bottom") had a narrow trigger:
  copy-and-plain-paste of text containing a line break into a
  tag (or other single-line block). A common real-world
  occurrence is triple-clicking an article title in the
  browser; most browsers grab a trailing `\n` alongside the
  visible text.

  `buildPlainTextSlice("Article Title\n")` produced a
  two-paragraph slice (`Slice([paragraph("Article Title"),
  paragraph("")], 1, 1)`). When `replaceSelection`'d into a
  `tag` (which our schema constrains to a single textblock
  inside a `card`), PM split the surrounding card at the
  paragraph boundary to accommodate the multi-paragraph
  slice — the existing tag/cite ended up separated with a
  floating card-boundary separator at the newline position,
  and the post-paste `scrollIntoView()` landed at the new
  doc-end (since the structural mutation moved the cursor
  to the synthesized split point's end-of-doc cascade).

  Fix: new `normalizeClipboardTextForPaste(text, parentTypeName)`
  helper in `paste-plugin.ts`. In single-line contexts
  (`tag`, `cite_paragraph`, `undertag`, `analytic`) it
  collapses whitespace runs (`\s+`) to single spaces and
  trims edges before the text reaches `buildPlainTextSlice`.
  In multi-paragraph contexts (`card_body`, `paragraph`, etc.)
  it returns the text unchanged so intentional paragraph
  splits in the clipboard still produce multi-paragraph
  slices.

  Wired into both plain-paste entry points: the browser
  `handlePaste` handler (when `plainPasteArmed` is set, e.g.
  F2 in the web edition) and the Electron-host
  `applyPlainPasteFromText` function (called from the
  desktop menu's "Paste as plain text" / native F2 mapping).

- **Nav pane: highlight follows the editor caret.** Previously
  the `.pmd-nav-item-selected` blue highlight was driven purely
  by click events on the nav-pane (`selectSingle` / shift-click
  range / ctrl-click toggle); editor caret movements didn't
  update it. New `NavigationPanel.setCaretHeading(pos)` finds
  the heading whose section contains the caret (= largest
  `entry.pos <= pos` from the rendered `liEntries`) and calls
  `selectSingle` on it. Wired from `index.ts`'s
  `dispatchTransaction`, gated on `prevState.selection.from !==
  next.selection.from` so doc-only transactions away from the
  cursor don't pay the find-heading walk.

  Caret-tracking always produces a single selection — explicit
  multi-select via Ctrl/Shift-click still works for drag-and-
  drop and similar workflows, but collapses on the next caret
  movement. Matches the user mental model that the nav-pane
  reflects "where the cursor is."

  Doesn't auto-scroll the nav pane to bring the highlight into
  view — explicit decision; auto-scrolling on every cursor move
  would dominate the user's scroll behavior on long docs. Worth
  revisiting if it turns out users want it for outline-following
  workflows.

  Edge cases:
  - Caret before the first heading → `clearSelection()`, no
    highlight.
  - Caret inside a heading whose nav entry is hidden under a
    collapsed parent → the closest ancestor in `liEntries` gets
    highlighted (we iterate only rendered items).
  - Position drift between a doc edit and the next debounced
    `update()` (~200ms): the highlight may briefly point at a
    stale neighbor. Acceptable for a visual indicator.

- **Comments column: user-draggable width with resize handle.**
  Mirror of the nav-pane resize-handle pattern. New
  `commentsColumnWidth` setting (default 320, range 240–560)
  persists the width across sessions. CSS custom property
  `--pmd-comments-width` drives `.pmd-comments-column { width }`;
  the resize handle on the column's LEFT edge (the
  `right`-anchored opposite of the nav-pane's right-edge
  handle) updates the custom property during drag. Mouseup
  writes the final value to `settings`.

  Range chosen by squint: 240 px is the threshold below which
  thread cards start feeling cramped; 560 px is where the
  column starts eating too much of the editor width on a
  laptop. Same clamp in the settings sanitizer + the JS drag
  handler so persisted out-of-range values get pulled back in.

  The handle's bg is transparent at rest; tints on hover
  (`--pmd-c-accent-soft`) and during drag. Mirrors the
  nav-pane handle exactly — col-resize cursor on hover is the
  discovery cue, no permanent visible affordance. (An earlier
  iteration added a grip-dot indicator; removed when the user
  preferred the cleaner pattern of the nav-pane.)

- **Comments column: resize handle survives render() wipes.**
  Initial implementation appended the handle as a direct child
  of `#comments-column`. The column's `render()` method (fired
  from `dispatchTransaction` on every keystroke that affects
  comments state) does `this.root.innerHTML = ''` to rebuild
  threads from scratch, which wiped the handle along with
  everything else. User reported "can't see the resize handle"
  after typing — exactly the post-wipe state.

  Fix: introduce an inner `.pmd-comments-content` wrapper
  inside the column. `render()` now wipes that inner wrapper
  rather than the column root. The resize handle stays as a
  sibling of the wrapper (installed in the constructor BEFORE
  the wrapper, so DOM order is handle-then-content). Sticky
  positioning context for any column children remains the
  column itself (via `position: relative`); the inner wrapper
  is `height: 100%; width: 100%` so containment doesn't shift.

- **Comments column: full-scroll-extent layout via inner grid
  wrapper.** Same family of post-path-A regression as the
  multi-doc top-shift and recovery-sidebar offset that landed
  in alpha.3. With `#app` migrated to `position: fixed` +
  `overflow-y: auto` (the bounded scroller), the inner flex
  layout's cross-axis was viewport-bounded — items stretched
  to viewport, not to content height. The comments column's
  background only rendered at the top of the page and didn't
  cover the full scroll strip.

  Two-stage fix:
  1. `<div class="pmd-editor-row">` wrapper added inside `#app`
     in `index.html`, holding `#editor` + `#comments-column`.
     The flex / grid layout lives on this inner wrapper rather
     than `#app` itself.
  2. The wrapper uses `display: grid; grid-template-columns:
     1fr auto`. Initial attempt was flex with `min-height:
     100%`, but flex's cross-size determination floors at
     `min-height` and doesn't grow with overflowing items
     (measured: wrapper box 807px while `#editor.scrollHeight`
     was 5971px). Grid track sizing is content-based and
     handles this case cleanly — items end up content-tall
     (≈ 5982px on a long doc), the column's background covers
     the full scroll strip.

  Short / empty document case (separate issue surfaced in
  testing): with `grid-auto-rows: max-content`, an empty doc
  produced a short track and the column rendered as a small
  strip at the top of the visible area with empty space below.
  Fixed by NOT setting an explicit `grid-template-rows`
  initially, then trying `minmax(100%, max-content)` (collapsed
  to 100% per CSS Grid spec's "treat percentages as auto when
  the container's size depends on its tracks" rule, regressing
  the long-doc fix). Final shape: no explicit `grid-template-
  rows`; track auto-sizes. Combined with `min-height: 100%` on
  the wrapper, this gives items max(viewport, content) cross-
  size in both cases.

  Hidden in multi-doc layout via
  `body.pmd-multi-doc .pmd-editor-row { display: none }` —
  multi-pane's per-pane shell sits as a sibling of the wrapper
  and uses its own internal layout.

- **Comments column: bottom-left collapse/expand toggle removed.**
  The `.pmd-comments-toggle-active` button (▾/▴ circle pinned
  with `position: sticky; bottom: 0.5rem`) is gone. Removed:
  the `renderToggle` method, its call site in `render()`, the
  "skip click on toggle" branch in the sticky-dismiss handler,
  the `lastActiveThreadId` field + assignments (only the
  toggle button used it for "re-expand most recent thread"),
  and the three CSS rules for the button.

  Active-comment collapse still works — the sticky-dismiss
  global mousedown handler still dismisses when the user
  clicks outside the active card. The lost affordance is the
  "explicitly re-expand the most recently active thread"
  button-click; users now click the card they want to re-open.

## 0.1.0-alpha.3 — 2026-05-21

- **Auto-update check on launch (opt-in).** New setting
  `checkForUpdatesOnLaunch`, off by default in this release.
  When on, the first window of an app session triggers a silent
  update check during boot (gated on `host.isFirstWindow()`,
  same pattern as the doc-recovery UI — subsequent windows in
  the same session skip the check). If `update-available` fires,
  the same modal the manual Help → Check for Updates path uses
  pops up with "Open release page" + "Close" buttons; the
  "Open release page" button calls `shell.openExternal` to deep-
  link to `https://github.com/ant981228/cardmirror/releases/tag/v$VERSION`
  in the user's default browser. Errors and "you're current"
  outcomes stay silent on this path — the wishlist explicitly
  flagged that surfacing them every launch would be obnoxious
  for users who happen to be offline at boot.

  Implementation:
  - Renderer-driven trigger: a new
    `host:trigger-auto-update-check` IPC handler in `main.ts`
    calls a shared `runUpdateCheck(opts)` function with
    `{ alertOnLatest: false, alertOnError: false }`. The same
    function backs the manual Help-menu path with
    `{ alertOnLatest: true, alertOnError: true }`.
  - Shared `showUpdateAvailableDialog(info)` helper holds the
    modal definition, so the available-update dialog is
    byte-identical between manual and auto-launch paths.
  - Single `updateCheckInFlight` guard prevents the manual and
    auto paths from racing if they happen to overlap (e.g.,
    user clicks Help menu before the boot check completes).
  - `startAutoUpdate` no longer calls `checkForUpdates()`
    itself — the renderer owns the at-launch trigger now,
    gated on the setting + `isFirstWindow()`. The persistent
    `update-downloaded` handler stays in `startAutoUpdate` so
    the "Update ready, restart now?" dialog still fires when
    the background download completes (regardless of whether
    the trigger came from manual, auto-launch, or the Settings-
    panel button).
  - Setting toggle lives in `buildInstallInfoSection` (Settings
    → General → "About this install") via a plain checkbox
    above the existing Check-for-updates / Open-crash-dumps
    action buttons. Electron-only (web edition has no update
    mechanism).

- **Manual update check: three-dialog feedback.** The Help →
  Check for Updates click handler in `apps/desktop/src/main.ts`
  used to register only an `update-not-available` handler;
  `update-available` and `error` paths were silent (auto-update
  proceeded in the background, errors went to `console.warn`).
  Replaced the inline click handler with a `runManualUpdateCheck()`
  function that registers `.once` handlers for all three events
  plus a `catch` on the `checkForUpdates()` promise, with a
  mutual-cleanup pattern so exactly one dialog fires per check.
  Dialogs:
  - **Not available**: "You're on the latest version." + version.
  - **Available**: "Update available: vX.Y.Z." With buttons
    "Open release page" (deep-links to the tag's release page via
    `shell.openExternal`) and "Close." The download still proceeds
    in the background via the persistent `startAutoUpdate`
    handlers, which will show the existing "Update ready,
    restart now?" dialog when finished.
  - **Error**: "Couldn't check for updates: <message>" with the
    Releases URL as a manual-download fallback.
  Re-entrancy guard (`manualCheckInFlight`) prevents rapid double-
  clicks from registering duplicate handler sets. Auto-check
  errors on launch still go to `console.warn` per the wishlist —
  popping a dialog on every offline boot would be obnoxious.

- **`getFocusedWindow()` null guard via `dialogParentWindow()`.**
  Both the manual update-check dialogs above and the existing
  startAutoUpdate `update-downloaded` handler look up the dialog
  parent via `BrowserWindow.getFocusedWindow()`. If the user
  alt-tabs away between clicking "Check for Updates" and the
  response arriving, that returns `null` and the previous code
  silently early-returned, dropping the dialog on the floor.
  Centralized the lookup in `dialogParentWindow()` which falls
  back to `BrowserWindow.getAllWindows()[0]` — worst case the
  dialog attaches to "some" CardMirror window instead of the
  focused one, which is far better than the dialog never
  appearing.

- **About panel surfaces Chromium and Electron versions.**
  `src/editor/install-info.ts` parses `Chrome/X.Y.Z` and
  `Electron/A.B.C` out of `navigator.userAgent` and lists them
  as their own labelled rows above the full UA string. The
  underlying versions were already discoverable by reading the
  UA, but separate rows make "is the user actually running the
  version they think they are?" a one-line check during bug
  triage. Web edition shows Chromium but no Electron row.

  Context for this: a user-reported "Linux build shows version
  0.1.0-alpha.1 on alpha.2 install" bug whose code-path
  investigation came back clean — `pkg.version` is Vite-inlined
  from the root `package.json` at build time, the alpha.2 tag's
  `package.json` was `0.1.0-alpha.2`, the AppImage filename
  itself is `cardmirror-0.1.0-alpha.2.AppImage`. The most plausible
  explanation is the user had an earlier alpha.1 AppImage still
  installed (AppImages don't auto-update). Adding the separate
  version rows is the defensive measure that makes future
  version-mismatch confusion easier to diagnose.

- **Release workflow: two-stage to avoid the matrix-race.**
  alpha.2's release produced two separate drafts because the
  three OS matrix jobs concurrently saw "no release for this tag"
  and each created its own — Mac + Windows assets ended up on
  one draft and Linux's on another, requiring manual
  reconciliation. New `prepare-release` job runs first on a
  single Ubuntu runner, idempotently creates a draft release via
  `gh release create $TAG --draft --title $TAG --generate-notes`
  (no-op if a release for the tag already exists), and the
  `build` matrix job `needs: prepare-release` so it never starts
  until the draft is in place. electron-builder's GitHub
  provider then finds the existing draft and uploads to it
  instead of racing to create one.

- **Single-doc scroll container migrated from `body` to `#app`.**
  Diagnosis: a multi-trace investigation (Mac Electron, Mac Chrome,
  Linux Chrome, with and without `--enable-skia-graphite`) plus a
  layer-tree audit on macOS pinned single-doc's continuous heavy
  `UpdateLayer` cost during scrolling to the document being the
  rootScroller. The DevTools Layers panel showed `#document` at
  2206 × 558272 px, ~4.9 GB nominal memory, compositing reason
  *"Is the document.rootScroller. Is a scrollable overflow element
  using accelerated scrolling."* Every scroll position change
  triggered a recomposition of that giant layer. Trace-data
  signature: 10 big (>100 ms) `UpdateLayer` events spread across
  a 13 s scroll session in single-doc vs. zero in multi-pane
  (which already used the bounded `.pmd-pane-body` scroller).

  Fix: scope a new `body:not(.pmd-multi-doc) #app` rule that pins
  `#app` to the chrome-clipped viewport rectangle via
  `position: fixed` (top/left/right/bottom set from the existing
  `--ribbon-height` / `--nav-width` / `--status-bar-height`
  tokens) and gives it `overflow-y: auto` + `overscroll-behavior:
  contain`. The editor + comments column scroll *inside* `#app`;
  `body` stops being the rootScroller; the composited scrollable
  layer is bounded by `#app`'s viewport-sized box instead of the
  doc-content height. Multi-doc layout is untouched — it has its
  own `body.pmd-multi-doc #app` rule that already pins height and
  manages overflow via per-pane `.pmd-pane-body` scrollers.

  Companion changes:
  - `body.pmd-speech-banner-visible:not(.pmd-multi-doc) #app` now
    adjusts `top:` instead of `margin-top:` (multi-doc never
    surfaces the banner, so this is single-doc-only).
  - The dark-chrome-light-document background paint extends to
    `#app` (was `.pmd-pane-editor` + `.pmd-pane-body` previously) —
    container backgrounds in `overflow: auto` cover the full
    scrollable extent at every scroll position, so any gap below
    the editor's content extent now reads as light rather than
    dark.
  - `index.ts` reset path: `appEl.scrollTop = 0` replaces
    `window.scrollTo(0, 0)` in the doc-open scroll-to-top sequence.
  - `precise-scroll.ts` `desiredTop` now reads from the nearest
    scrolling-overflow ancestor's `getBoundingClientRect()` instead
    of `window.innerHeight`. Falls back to viewport bounds when
    no scroller is found (tests, detached nodes). This keeps the
    convergence math working across single-doc (`#app`), multi-pane
    (`.pmd-pane-body`), and any future container.

  Verified end-to-end: typecheck + 683 tests pass. Most scroll-
  path call sites needed no changes — `tr.scrollIntoView()` (the
  PM Transaction method) walks up from the selection's DOM to
  find the nearest scrolling ancestor; element-level `scrollIntoView`
  does the same; `drag-editor-surface.ts`'s host-relative math
  was already 0 in single-doc and stays so.

  Standalone, this fix narrowed but didn't close the macOS gap
  (see Electron bump entry below for the second half of the
  story).

- **Electron bumped from 33 (Chromium 130) to 42 (Chromium 148).**
  Second half of the macOS scroll-perf fix. The path A
  architectural change above eliminated the doc-as-rootScroller
  giant layer in single-doc, but the residual gap to the same
  content rendered in the user's installed Chrome 148 remained —
  measured most acutely as click-jump tail latency
  (electron-multi p99 frame interval 974ms vs chrome-multi 343ms
  on identical content + hardware) and per-event `UpdateLayer`
  cost magnitude (electron-single avg 472ms vs chrome-single
  78ms). Trace data attributed the gap to Chromium 130's
  compositor pipeline being more tightly coupled to main-thread
  work than 148's — Chrome did similar total work per scroll but
  produced frames smoothly through it, while Electron 130
  blocked frame production on the heavy work.

  GPU-feature-status diff between the two builds on the same Mac
  landed cleanly on one line:
  `skia_graphite: disabled_off` (Electron 33) vs `Enabled`
  (Chrome 148). Skia Graphite is the newer Dawn-on-Metal Skia
  backend that ships the relevant compositor decoupling. The
  `--enable-skia-graphite` switch we added to `main.ts` engaged
  the feature in Electron 33 (verified by re-running the GPU diff
  post-switch) but the M130 iteration of Graphite is two cycles
  pre-default-on; engaging the flag helped substantially but
  didn't reach Chrome 148's behavior. The actual cure was
  upgrading to a Chromium build that ships the mature Graphite
  implementation.

  Electron 42's bundled Chromium is `148.0.7778.96`, effectively
  matching the user's installed Chrome 148.0.7778.168 — maximum
  apples-to-apples perf parity. Bumps:
  - `electron`: `^33.2.0` → `^42.2.0` (9 major version jump)
  - `electron-builder`: `^25.1.8` → `^26.8.1`
  - `electron-updater`: `^6.3.9` → `^6.8.3`
  - `electronVersion` in build config: `33.2.0` → `42.2.0`

  Migration was uneventful: full `rm -rf node_modules
  package-lock.json && npm install`, `npm run build:main` clean
  against Electron 42 types (no main-process API breakages
  caught by tsc against the 9-major delta), renderer typecheck +
  683 vitest tests still pass. End-user verification on the Mac
  confirmed the perf gap closed — scrolling, typing, and
  nav-pane click latency now feel parity with the in-browser
  experience.

  The `--enable-skia-graphite` switch we added during the
  investigation is now a no-op on Electron 42 (Graphite is
  default-on for Apple in Chromium 148) but stays in place as
  belt-and-suspenders. The "Copy GPU Info" menu item that was
  added as a temporary diagnostic stays as a permanent
  bug-report aid — one click, zero runtime cost.

- **Keyboard Shortcuts cheat sheet caught up with the keybindings
  registry.** The `GROUPS` array in `src/editor/reference-ui.ts`
  was hand-maintained and had drifted behind the registry — alpha.2
  added twenty-some new bindable commands (the twelve previously
  click-only ribbon actions plus `zoomIn` / `zoomOut` / `zoomReset` /
  `chromeScaleUp` / `chromeScaleDown` / `chromeScaleReset` /
  `togglePaintbrushHighlight` / `togglePaintbrushShading` /
  `openFind` / `openFindReplace` / `openFindByProximity` /
  `toggleNavPane`) and none of them appeared in the cheat sheet.
  Two changes:

  1. **Expanded GROUPS to cover every `RIBBON_COMMAND_ID`.** Added
     three new categories — `Color pickers & menus`, `Find`,
     `Zoom & scale` — and slotted the missing commands into
     existing categories (`save` and `toggleAutosave` into File,
     `insertImage` into Editing utilities, paintbrush toggles into
     Highlight tools, the picker openers into the new Color pickers
     & menus group, etc.).
  2. **Module-init drift guard** asserts every `RIBBON_COMMAND_ID`
     appears in exactly one group. Throws on load if anyone adds a
     new command to the registry and forgets the cheat-sheet
     update, or accidentally lists the same command in two groups.
     Error message names the missing / duplicated / extra ids so
     the fix is obvious from the stack trace.

  Verified end-to-end via CDP: 86 rows across 17 groups (was 14
  groups and a smaller subset before; the previous version was
  missing ~26 commands). Module init returned `ok` rather than
  throwing, confirming the assertion accepts the current registry.
  Unbound commands continue to display `—` (we briefly shipped
  `(no shortcut)` instead; reverted at user request because it was
  too noisy with ~46 unbound commands).

- **New setting: Format nav pane entries by type** (Settings →
  Appearance, default on). Wishlist follow-up to the dark-mode
  nav-pane flatten-to-white tweak: some users find the per-level
  font weight cascade (700 → 600 → 500 → normal) and the analytic-
  blue label accent noisy and prefer a uniform list keyed only on
  indentation. Implementation:
  - New `formatNavPaneByType: boolean` field on `Settings`,
    default `true`, sanitized in `loadSettings` so missing-or-
    truthy is treated as on and explicit-`false` as off.
  - `SETTING_METADATA` entry under category `appearance` next to
    `showDocNameChip`, so it lands in Settings → Appearance with
    the other nav / chrome toggles.
  - `applyFormatNavPaneByType(on)` in `index.ts` toggles
    `html.pmd-nav-flat` (class present when the toggle is OFF;
    parallels `pmd-doc-name-chip-on` / `pmd-nav-hidden`). Called
    at module init and from the settings subscriber so live
    toggling works.
  - CSS rules in `style.css` near the existing per-level rules:
    when `html.pmd-nav-flat` is set, `.pmd-nav-level-{1,2,3,4}`
    collapse to `font-weight: normal`, `font-size: 0.85rem`,
    `color: var(--pmd-c-text)`, and
    `.pmd-nav-type-analytic .pmd-nav-label` inherits instead of
    forcing the analytic-blue accent. Padding-left rules are
    untouched — indentation is the surviving hierarchy cue.
  - The dark-mode nav-pane-flatten-to-white rule still wins
    inside dark mode because it carries the higher-specificity
    `:root[data-theme="dark"] :is(.pmd-nav-panel, .pmd-multi-nav)`
    chain — both rules want uniform color anyway, so the cascade
    interaction is by design.
  Verified end-to-end via CDP on the 1NC v. Dartmouth doc: with
  `pmd-nav-flat` set, level-1 / 2 / 3 entries all report
  `font-weight: 400`, `font-size: 13.6px`; default state has 700 /
  600 / 500.

- **Scroll chaining from the nav pane no longer bleeds into the
  editor.** With the pointer over the nav pane, scrolling past its
  top or bottom limit would propagate the leftover wheel delta to
  the body's scroll container (single-doc) or the multi-pane row.
  Once the browser picked the editor as the gesture's scroll
  target, reversing direction kept scrolling the editor until the
  user paused fully and started a new gesture. Fix: add
  `overscroll-behavior: contain` on the two `overflow-y: auto`
  containers that own the nav and pane scrolls — `.pmd-nav-list`
  and `.pmd-pane-body` (multi-pane). `contain` cuts the scroll
  chain at the element's boundary, which also kills the "sticky
  target" follow-up because the chain never starts. Single-doc
  editor scrolls on the body / html, which has no ancestor scroll
  container to chain into, so no symmetric change needed there.
  Verified: `getComputedStyle(.pmd-nav-list).overscrollBehaviorY ===
  "contain"` post-fix.

- **Dark mode: end-to-end readability guarantee on imported docs.**
  Reported against the Health Care Topic Area Paper and 1NC v.
  Dartmouth CG docxs: with Settings → Appearance → Theme: Dark
  and "Apply theme to the document area" enabled, large swaths
  of body text were invisible (literal black on dark), shading-
  background text was invisible (themed white on yellow shading
  from Verbatim's `HighlightToBackgroundColor` macro), and
  hyperlinks were either browser-default `#0000EE` blue or
  Word's `#0563C1` — neither readable on `#1a1a1a`. Four
  coordinated changes in `src/schema/marks.ts` and
  `src/editor/style.css`:

  1. **`font_color="000000"` skip-inline-style.** The
     `000000` sentinel emits only `data-color="000000"` (no
     `style="color: #000000"`). The run inherits the
     surrounding text color: near-black via `--pmd-c-text` in
     light mode, `#e6e6e6` in dark mode, whatever the user
     picked in the per-token-override panel.

  2. **`colorBand(hex)` helper + `data-color-band` /
     `data-shading-band` attributes.** New exported helper
     classifies a 6-hex RGB into `dark` (perceived luminance
     `(0.299r + 0.587g + 0.114b) / 255 < 0.4`) or `light`.
     `font_color` and `shading` `toDOM` each emit a band
     attribute on the rendered span. Threshold tuned so the
     common Word sentinels — `000000` (lum 0), `0563C1`
     hyperlink blue (~0.32), dark grays / reds — land in
     `dark`, and mid-gray (`888888` ~0.53) onward stays
     `light` (user-intentional choices preserved).

  3. **Shading mandates contrast like highlight does.** CSS:
     `.ProseMirror [data-shading-band="light"] { color: #000; }`
     and the dark counterpart. Mirrors the per-named-color
     rules on `.pmd-highlight` for arbitrary hex shading.
     Always-on (not dark-mode-gated) because shading is doc
     data and needs contrast in any theme.

  4. **`--pmd-c-link` token + dark-band override + container
     scoping.** Light mode `#0563C1` (matches Word); dark
     mode `#7AB0FF` (bright sky blue, ~0.71 luminance).
     `.ProseMirror a` uses the token with `!important` so it
     beats the canonical Word-blue `font_color` marks Word
     stamps onto hyperlink runs. In dark mode + apply-to-doc,
     `[data-color-band="dark"]` falls back to `--pmd-c-text`
     via `!important`, catching dark-band font_color marks
     anywhere in the doc. Three higher-specificity rules
     reverse the override inside `.pmd-highlight`,
     `[data-shading-band]`, and `<a>` so those containers'
     mandated colors win (otherwise the override would make
     yellow-shaded text white-on-yellow, etc.).

  Round-trip unchanged: exporter reads `attrs.color`,
  importer / `parseDOM` read `data-color` / `data-shading`,
  neither touches inline style or `data-*-band`.

  Verified end-to-end via CDP on the 1NC v. Dartmouth doc:
  108/108 shading runs compute high-contrast (`color: #000` on
  the yellow shading), all 503 highlight runs compute
  high-contrast per their named highlight, 9/16 link runs
  render in sky blue and 7 render black because they sit
  inside `.pmd-highlight` spans where black-on-yellow contrast
  takes priority over link visibility (acceptable — the
  highlight rule already preserves readability and the link
  is still clickable). Six new test cases in
  `tests/schema/schema.test.ts` lock the contracts: the
  `000000` style skip, the `data-color-band` luminance buckets
  (`000000`/`0563C1`/`FF0000` → `dark`; `888888`/`FFFFFF`/
  `FFFF00` → `light`), and the shading band attribute on
  `toDOM`.

- **Underline color matches text color inside highlights and
  shading.** Follow-up to the dark-mode-readability work above.
  `.pmd-underline` / `.pmd-emphasis` are outer to highlight /
  shading in the mark stack (underline_mark at schema position 117,
  highlight at 311, shading at 271 — earlier-defined marks render
  outermost in the DOM). The text-decoration line is painted by the
  outermost element, and its `text-decoration-color` defaults to
  that element's `color` — which in dark mode is the themed light
  body text. So an underlined-highlighted run renders as black text
  on yellow (correct), with a white underline cutting through it
  (wrong). Added two `:has()` rule sets in `style.css` that set
  `text-decoration-color` on `.pmd-underline` / `.pmd-emphasis` (and
  `.pmd-cite` under the `citeUnderlined` flag) when they contain a
  highlight or shading band: black for light-band containers
  (yellow / green / cyan / magenta / red / lightGray highlight,
  `data-shading-band="light"`), white for dark-band containers
  (blue / darkBlue / darkCyan / darkGreen / darkMagenta / darkRed
  / darkYellow / darkGray / black highlight, `data-shading-band="dark"`).
  Verified on 1NC v. Dartmouth: 232 underline-inside-highlight/shading
  spans now paint `rgb(0, 0, 0)` underlines (correct against the
  yellow backgrounds in that doc); plain underlines outside any
  band still paint with themed body color so they read as light on
  the dark surface.

- **Native form controls render in dark mode.** The body-font
  dropdown in Settings → Appearance was painting its `<select>`
  with `var(--pmd-c-bg)` (dark in dark mode) but had no explicit
  text `color`, and the dropdown popup was being drawn by the
  browser in its OS-default light style — black option text on
  white in a UI surrounded by dark chrome. Two fixes: (1) set
  `color: var(--pmd-c-text)` on `.pmd-body-font-select` so the
  collapsed value is readable; (2) declare `color-scheme: dark`
  on `:root[data-theme="dark"]` so the browser draws every
  native form control (popup option lists, scrollbars, native
  date/color pickers, etc.) in its dark variant. Not gated on
  apply-to-document — native form controls only appear in chrome
  surfaces, never inside the ProseMirror editor, so the
  doc-area-stays-light mode doesn't need a light counterpart.
  Verified: `getComputedStyle(html).colorScheme === "dark"` and
  the select reports `color: rgb(230, 230, 230)` /
  `background: rgb(26, 26, 26)` in dark mode.

- **Sky-blue hyperlink color is now gated on apply-to-document.**
  Follow-up to the readability-guarantee work: the dark-mode
  `--pmd-c-link: #7AB0FF` override was set at `:root[data-theme=
  "dark"]` scope and so applied to the editor whenever the theme
  was dark — including when "Apply theme to the document area" was
  OFF and the document was rendering as light paper. Word's
  canonical hyperlink blue (`#0563C1`) is the right color against
  a white doc, so the sky-blue override leaked the wrong palette.
  Fix: add `--pmd-c-link: #0563C1` to the existing
  `:root[data-theme="dark"]:not([data-theme-doc="dark"]) :is(#editor,
  .pmd-pane-editor)` rule that already re-declares the other light-
  mode tokens for the editor scope when apply-to-doc is off. The
  chrome scope keeps `#7AB0FF` in dark mode (no chrome surface
  actually uses the token, but the symmetry is correct). Verified
  via CDP: dark + off → editor link computes `rgb(5, 99, 193)`;
  dark + on → editor link computes `rgb(122, 176, 255)`.

- **"Dark chrome, light document" mode actually paints the document
  area white, across the full scroll, in both single-doc and
  multi-pane.** The CSS rule that scopes light-mode-token
  redeclarations inside `:is(#editor, .pmd-pane-editor)` under
  `:root[data-theme="dark"]:not([data-theme-doc="dark"])` redefined
  `--pmd-c-bg: #fff` at the editor scope, but nothing in that rule
  applied the token to the editor's own paint — `#editor` /
  `.pmd-pane-editor` carry no `background` declaration of their own,
  so they inherited body's `background: var(--pmd-c-bg)` which
  resolves to `#1a1a1a` in dark mode. The editor read as black-on-
  dark even though the user explicitly opted OUT of "Apply theme to
  the document area." Two coordinated paints land the fix:

  1. **`background: var(--pmd-c-bg)` on `:is(#editor, .pmd-pane-editor)`**
     within the same scoped rule, so the scoped `--pmd-c-bg: #fff`
     actually applies to the editor's box. This covers single-doc
     entirely — `body` is its scroller, `#editor` sits inside the
     flex layout, and `#editor`'s painted box extends with the
     content.

  2. **`background: #fff` on `.pmd-pane-body`** in the same scoped
     rule. Multi-pane's per-pane editor surface (`.pmd-pane-editor`)
     is sized `height: 100%` of its parent `.pmd-pane-body` — which
     is the `overflow-y: auto` scroller bounded to the pane's
     viewport. So `.pmd-pane-editor`'s painted white box only
     covered the visible viewport portion; ProseMirror content
     overflows past that box and the dark `.pmd-pane-body` showed
     through under the overflowed content as the user scrolled.
     Painting `.pmd-pane-body` itself covers the full scrollable
     extent (container backgrounds in `overflow: auto` paint behind
     the visible viewport at every scroll position).

  The body / ribbon / nav / status-bar chrome around the editor
  stays dark because their backgrounds resolve `--pmd-c-bg` from
  the root scope (`#1a1a1a`) — the redeclare only escapes into the
  editor scope. Per-token Accessibility-panel overrides of
  `--pmd-c-bg` still win for single-doc because the `#editor`
  paint uses the token, not a literal hex.

- **Nav pane reads in solid white in dark mode.** The per-level grey
  cascade (level-4 → `--pmd-c-text-muted`, level-1/2/3 → inherited
  body text) and the analytic-blue label (`--pmd-color-analytic`)
  rendered as inconsistent dim entries against the dark chrome
  surface, and the "No headings." empty-state message disappeared
  into the background at `--pmd-c-text-faint` (#7a7a7a in dark
  mode). Added a dark-mode-scoped block that sets `color:
  var(--pmd-c-text-strong)` on the nav-panel container, the empty
  state, the level-4 entries, and the analytic label / hover —
  covering both single-doc (`.pmd-nav-panel`) and multi-pane
  (`.pmd-multi-nav`) layouts. Light mode is unchanged. The
  in-flight wishlist item "Setting: disable nav-pane formatting"
  will let users opt out of the per-type formatting in light mode
  too when shipped; this fix is the dark-mode-specific tactical
  flatten.

- **Web-edition Open button: selection no longer silently dropped.**
  Clicking the 📂 button on the web edition would open the OS
  file picker, let the user pick a file, then do nothing. `Ctrl-O`
  worked on the same page. Root cause: `BrowserHost.openOnce` had
  a focus-event-plus-200ms-setTimeout heuristic to detect
  cancellation — when the dialog closed and the window regained
  focus, the timer fired 200ms later and checked `input.files`.
  If the browser hadn't populated `input.files` by then (which
  varies with the previously-focused element — the button vs.
  editor — and with OS dialog implementation), the timer
  resolved the promise to `null`, then the actual `change` event
  fired but ran into `settled=true` and dropped on the floor.
  Keyboard `Mod-O` happened to win the race; mouse-button click
  reliably lost it on Chrome 148+ on Linux and on Zen (Firefox
  fork). Fix: replace the focus-and-timeout polling with the
  native `cancel` event (Chrome 113+, Firefox 91+, Safari 16.4+),
  which fires only when the user actually dismisses the picker
  without picking. No race. The byte-identical code in alpha.1
  was already buggy; nothing changed in this file between
  releases — what likely shifted was timing pressure elsewhere
  on the page (timer UI mount, dark-mode boot, find-replace
  decorations) that pushed the focus event past the
  `input.files` population threshold often enough that the
  symptom started manifesting reliably.

## 0.1.0-alpha.2 — 2026-05-20

- **Nav-pane navigation: dramatically faster on big docs.**
  Clicking a heading in the nav pane used to pay a full-doc
  layout pass on every click — about 2 seconds on a 2000-card
  debate file, paid regardless of whether the destination was
  already on screen. The scroll algorithm now does an optimistic
  `scrollIntoView` against whatever layout state already exists,
  then iteratively refines (up to 10 frames) when cv:auto's
  placeholder heights caused the first try to land imprecisely.
  Result: clicks where the target heading is already visible
  cost a few ms; clicks into fresh regions of the doc pay only
  what cv:auto would have charged anyway for materializing the
  destination, instead of re-laying-out the entire doc each
  time. The per-keystroke editing-perf win from cv:auto is
  preserved end-to-end (we no longer flip it off at all).
- **Chrome scale — Mod-Alt-= / Mod-Alt-- / Mod-Alt-0.** Three
  new keybindable commands (`chromeScaleUp` / `chromeScaleDown`
  / `chromeScaleReset`) that scale the whole window — chrome
  AND doc content together — the same way the browser's built-
  in Ctrl-+ chord does. On Electron this drives Chromium's
  `webFrame.setZoomFactor`, so layout reflows at the new
  factor rather than just resizing pixels. Helpful on high-DPI
  displays where the chrome reads too small, or low-DPI where
  it crowds the editor. No-op on the web edition (use the
  browser's own page-zoom). No ribbon button — keyboard-only
  (the chord is shown in Settings → Keybindings and can be
  rebound). The editor's existing `Mod--` / `Mod-=` zoom stays
  separate, so you can dial doc content size up or down on top
  of the page-zoom factor.
- **Bug fix — Nav-pane drag drop-back precision.** When you grab
  a heading in the nav pane, the pane inserts thin drop-indicator
  bars between every entry to show valid drop slots. The cursor
  still followed the pickup pill, but the pile-of-indicators
  above the source heading pushed the source's slot down out from
  under the cursor — so releasing without moving (a "drop it back
  where it came from" gesture) landed the heading in a sibling
  slot instead. The source `<li>` now anchors at its original
  screen-Y for the duration of the drag, so a no-move release
  reliably drops back into the original slot. Other entries
  still shift down by the full indicator stack, so the nav pane
  still visibly expands at drag-start (the affordance you'd
  expect).
- **Bug fix — Multi-pane → single-window switch was losing open
  docs.** Toggling from the three-pane workspace back to one-doc-
  per-window only restored the active pane; the others were
  silently dropped. Root cause was a journal-write race: two IPC
  writes to the same crash-recovery file could land at once,
  producing a valid-JSON-then-garbage file that the post-reload
  reader threw out as corrupt. Writes are now serialized per uid
  and committed via an atomic rename, so journals stay valid even
  under concurrent edit-debounce + mode-switch traffic.
- **Accessibility — Reduce motion.** Settings → Accessibility →
  Reduce motion: System / On / Off. System (default) follows the
  OS `prefers-reduced-motion` preference. On flattens all
  animations and transitions in the UI (drag-pickup vacuum,
  popover slides, save-flash pulse, smooth scrolls) to effectively
  instant. Off forces full motion even when the OS asks for
  reduced — useful for users on an OS where the setting is
  always-on but they prefer animations in this app.
- **Accessibility — Body-font readability presets.** The Settings
  → Appearance → Body font dropdown now groups options by
  category, with "Recommended for readability" leading. Three
  bundled SIL OFL fonts ship with the app so every install has
  a readability-tuned choice regardless of what's on the host OS:
  **Atkinson Hyperlegible** (Braille Institute; designed for low
  vision, disambiguated letter pairs), **Lexend** (Font Bureau;
  the readability-tuned sans-serif with the strongest positive
  reading-speed evidence among "dyslexia fonts"), and
  **OpenDyslexic** (weighted-bottom shapes; preferred by some
  dyslexic readers — independent studies have NOT shown
  reading-speed improvements vs. Arial, but the option is
  popular). The British Dyslexia Association's 2023 endorsed
  system sans-serifs (Verdana, Tahoma, Comic Sans MS) follow
  when installed; remaining groups are "Microsoft Office
  defaults", "Apple defaults", "Open-source / cross-platform",
  and "Generic". Groups whose fonts aren't available are hidden.
- **"Open with CardMirror" actually opens the file on desktop.**
  `.docx` and `.cmir` are now registered file associations in the
  electron-builder config, so the installers wire up CardMirror
  as a right-click "Open with…" target (and as the default-app
  candidate for both extensions). The main process gained a
  single-instance lock plus open-file / second-instance / argv
  handling so double-clicking a registered file in Finder /
  Explorer / a file manager opens that file in CardMirror —
  spawning a new window when the app is already running, or
  launching directly into the file if the app wasn't open. Web
  edition unchanged.
- **Built-in countdown timer.** Native replacement for Verbatim's
  bundled timer. New ⏱ button in the right side of the ribbon
  (next to ⚙) toggles a timer panel into the ribbon's left edge.
  The panel has a big speech-timer display, Start/Pause, three
  speech-duration presets (default 9/6/3 minutes), Aff and Neg
  prep clocks (default 10 minutes each, blue and red), and a
  Reset column that re-fills the prep balances. Click a preset
  to load it (paused — hit ▶ to start). Click Aff or Neg to make
  that side's prep clock the active countdown. Type into the big
  display while paused to set a custom duration. Prep balances
  persist across closes; speech timer doesn't. Cross-window
  sync via BroadcastChannel — open the timer in two windows
  AND the visibility toggle in lockstep too: arming the panel
  in one window opens it in every CardMirror window. New
  Settings → Appearance entries:
  **Timer profile** (High school 3/5/8 + 8 min prep, College
  3/6/9 + 10 min prep, Pomodoro 25/15/5). Each profile's
  three preset durations and prep length are independently
  editable in Settings — pick a profile, then dial the four
  numbers to whatever your league actually uses. Switching
  profiles refills the prep clocks to that profile's total.
  **Compact timer layout** (drops the preset buttons, tucks
  Reset under Start). **Flash timer when countdown is low**
  (flashes the display red as remaining drops below 5 / 3 / 1
  seconds; the flash thresholds are editable too). **Prep
  side label** (Both / Text / Color) — controls how the Aff /
  Neg sides are labeled, with a color-only mode for a quieter
  panel.
- **"About this install" block at the bottom of Settings →
  General.** A read-only diagnostic section below a divider
  showing app version, host (Desktop / Web), operating system,
  and the full user-agent string — easy to copy-paste into a bug
  report. On desktop, two action buttons live underneath:
  **Check for updates** (mirrors Help → Check for Updates…,
  toast surfaces the result) and **Open crash dumps folder**
  (mirrors the Help-menu item) so both actions are now reachable
  from Settings.
- **Every ribbon action is now bindable.** Twelve previously
  click-only ribbon actions are now registered commands in the
  keybinding registry, available in Settings → Keybindings. None
  ship with a default binding — they're all already reachable via
  the ribbon, so a default chord would just be noise. The new
  bindable commands: increase / decrease font size by 1 pt,
  apply font color, open settings, toggle paragraph integrity,
  open each color picker dropdown (highlight / shading / font
  color), open the font-size picker, and open the doc / card /
  table tools menus.
- **Active doc filename in a ribbon pill (opt-in).** New Settings
  → Appearance → "Show doc name in ribbon" toggle (default off).
  When on, the active doc's filename appears as a pill centered in
  the ribbon between the comments toggle and the settings button.
  Useful on platforms / layouts where the OS title bar isn't
  visible: tiling window managers without decorations,
  hidden-title-bar themes, web edition embedded in another page,
  etc. Long filenames ellipsis-truncate with the full name in the
  tooltip. The chip hides when there's no filename yet
  (untitled / fresh doc before Save-As), in multi-pane mode (each
  per-pane chip already shows the slot's doc), and falls out of
  the ribbon's progressive-hide cascade between paragraph styles
  and the format-menu cluster when the ribbon runs out of room.
- **Multi-pane window title summarizes all open slots.** The OS
  window title in multi-pane mode used to show just the focused
  doc's filename. It now shows every non-empty slot's filename
  joined by `·` — e.g. "Foo · Bar — CardMirror" — so the title
  bar conveys the whole workspace at a glance rather than
  changing with every focus shift. Single-doc mode unchanged.
- **Fixed: Copy Last Cite now finds cite_mark text you just
  applied.** Adding the cite mark to a word in a body paragraph
  is supposed to promote that paragraph to a `cite_paragraph`
  (the cite classifier plugin does this automatically). But the
  classifier was gated on a "did the doc change?" range that
  excluded mark-only transactions — `AddMarkStep` doesn't shift
  any positions, so its step-map was empty and the classifier
  bailed early. Result: the paragraph stayed a regular
  `paragraph`, and Copy Last Cite fell through to whatever older
  `cite_paragraph` it could find further up the doc. The same
  silent-skip affected the named-style normalizer (it would
  miss underline/cite/emphasis conflicts created via mark-add
  transactions). Both now see mark-only transactions.
- **F8 / Apply Cite Style now expands to the word at the cursor**
  when there's no selection — matching the behavior F10 / Apply
  Emphasis Style already had. Previously pressing F8 with the
  cursor in a word silently did nothing; users had to double-click
  to select the word first.
- **Fixed: Underline / Emphasis font-size settings were dead.**
  Settings → Styles → font size for the Underline and Emphasis
  styles did write a CSS variable, but no CSS rule consumed it, so
  the change was silently dropped. The marks now pick up
  `--pmd-size-underline` / `--pmd-size-emphasis` and behave like the
  other per-style size knobs.
- **Image alt text is now editable and round-trips through Word.**
  Three changes that ship together:
  - Right-clicking an image shows a new **Edit alt text…** menu item
    (above the AI options, always enabled). Opens a multi-line dialog
    pre-filled with the current alt text; saving writes the new value
    back to the image node and survives docx export.
  - The OOXML importer now reads `wp:docPr@descr` (with `pic:cNvPr@descr`
    as a fallback for older producers) into `image.attrs.alt`. Previously
    the importer dropped alt text on the floor; exporting was the only
    half of the round-trip that worked.
  - The AI alt-text generator now updates `image.attrs.alt` as well as
    inserting the visible `[ALT TEXT: …]` bracket. If the image already
    has alt text on its attribute, the AI command pops a dialog
    showing the existing alt text and offers **Keep current** (copy it
    to a bracket below the image, no API call) or **Regenerate with
    AI** (overwrite both the attribute and the bracket).
- **Dark mode.** Settings → Appearance → Theme: Light / Dark /
  System (default). System mode tracks the OS-level
  `prefers-color-scheme` and switches live when the user changes
  their system appearance. Sibling toggle, **Apply theme to the
  document area**, defaults off — the chrome (ribbon, nav, status
  bar, settings panels) follows the dark theme but the document
  itself stays light / paper-like. Flip on for full dark. User
  per-token color overrides win over either theme via inline
  style on `<html>`.
- **Accessibility settings section** (new tab, far right of the
  Settings dialog).
  - Highlight + shading display overrides moved here from
    Appearance. Replaced the single-color picker with **1–3
    ordered slots** that map to source colors by usage
    frequency. Slot 1 → most-common color in the doc, slot 2 →
    second-most-common, last slot = catch-all for everything
    else. Frequency ranking is incremental + debounced, and
    inactive when only one slot is set, so big docs don't pay
    perf cost unless they're using the multi-color feature.
  - **Per-token color overrides** panel: every UI color in the
    interface (background, borders, accent, hover, status, find
    decorations, table chrome, etc.) is overridable with a
    color picker + alpha slider. Reset-per-row + reset-all
    affordances. Overrides win over the active theme and any
    future preset (high-contrast, colorblind-friendly, etc.).
- **Cursor-position color readout** on the status bar. Visible
  only when an override is on. Shows the ACTUAL stored colors on
  the run at the cursor ("Hl: Yellow · Sh: Protected Grey") so
  you don't lose awareness of what's encoded in the doc while
  the override hides it from view.
- New setting: **default file format for new docs**. Pick `.docx`
  (default — Word- / Verbatim-compatible) or `.cmir` (CardMirror's
  native format, enables autosave); the Save-As dialog defaults to
  that format for any doc that doesn't yet have an on-disk handle.
  Existing files on disk still re-save in whatever format they were
  opened from.
- New setting: **jump to doc top when read mode toggles**. Off by
  default (today's stay-put behavior). When on, toggling read mode
  in either direction scrolls to the top of the doc and places the
  cursor at the start.
- Zoom in / out / reset and the highlight / shading paint-mode
  toggles are now registered ribbon commands, so users can bind
  them to keys via Settings → Keybindings. Default bindings:
  `Mod-=` for zoom in, `Mod--` for zoom out; `zoomReset` and the
  paintbrush toggles ship unbound (`Mod-0` is a browser-level
  reset that Chromium won't always let the page intercept, so the
  status-bar reset button remains the discoverable affordance).
- Keyboard-shortcut command labels (Settings → Keybindings) now
  use consistent title casing across the board.
- **Find and Replace** (Ctrl-F / Ctrl-H / Alt-F). Floating bar in
  the upper-right with case-sensitive and whole-word toggles,
  next / prev navigation, a match count, Replace, and Replace
  All. Every match is highlighted in light yellow; the
  currently-active one gets a stronger orange band. Escape
  closes and restores editor focus.

  Result ordering:
  - **Ctrl-F** (categorized): hits in headings come first, then
    tags, then cites, then everything else. Within each group,
    the closest match to your cursor ranks first (cursor counts
    as the top — matches after wrap around to matches before).
    The category priority is reorderable in Settings → General.
  - **Alt-F** (proximity-only): ignores categories — just orders
    by proximity to the cursor.
  - **Ctrl-H** opens the find+replace bar with the same
    categorized ordering as Ctrl-F.

  Surfaces beyond the floating bar:
  - **Expandable results panel** below the bar — toggles open
    via a chevron, lists every match with surrounding context,
    and clicking an entry jumps to it. Open/closed state
    persists per session via `findResultsExpanded`.
  - **Nav-pane integration** — outline entries whose subtree
    contains a match get a small accent decoration, so you can
    see at a glance which sections of the doc match the current
    query without scrolling through results.
  - **Scope** — search can be restricted to a range (e.g. the
    current selection) instead of the whole doc. Toggling the
    scope chip clears it.
- Re-pressing a heading shortcut (F4 / F5 / F6 / F7 / Mod-F7 /
  Mod-F8) on a paragraph that already has that heading style now
  strips the paragraph's indentation while keeping the heading
  style and all other formatting intact, instead of being a
  no-op.
- Opening a doc now starts both the editor and the nav pane
  scrolled to the top, instead of inheriting the previous doc's
  scroll position.
- A "New document" window spawned while CardMirror is already
  running no longer offers to "recover" the docs you have open
  in other windows. Only the first window of an app session
  surfaces the startup-recovery sidebar.
- The navigation pane can now be hidden. Three ways to toggle:
  the new ☰ button in the View tools section of the ribbon, the
  × close button in the top-right of the nav pane itself, and a
  small pull-tab pinned to the left edge of the viewport (only
  visible when the nav pane is hidden). State is per-window; in
  multi-doc mode the toggle applies to all panes' nav at once.
- The word-count selection button (Σ) moved off the ribbon to
  the left edge of the status bar, next to the live read-aloud
  word counter — same family of question, fewer ribbon buttons.
- Zoom-strip controls (zoom in/out/reset + word-count) are
  slightly smaller and stay centered on the bar.
- Triple-click + drag now extends the selection paragraph-by-
  paragraph (instead of switching back to character-level on the
  first move). Matches Word and most browsers' contenteditable
  default.
- Right-clicking a link now opens a context menu (Open Link /
  Copy Link Address / Edit Link… / Remove Link). Open routes
  through the OS default browser via `shell.openExternal` on
  desktop; Edit reuses the in-app text prompt; Remove strips the
  link mark while preserving the text. Non-link right-clicks
  pass through to the browser / image context menu as before.
- Paint mode (highlight / shading paintbrush) now shows an I-beam
  precision cursor with a small swatch of the active color, so
  you can target characters precisely AND see which color the
  next paint will apply. Picking a new color while paint mode is
  armed updates the cursor live.
- Text selection inside the editor is now translucent (~30%
  alpha) instead of fully opaque, so the underlying highlight,
  shading, and other colors show through. Side effect: you can
  now tell at a glance whether selected text is currently
  highlighted (F11) — the highlight color shows through the
  selection overlay instead of being hidden by it.
- Clicking an image now shows a visible selected state — a 2px
  accent outline so it's obvious the click registered before
  pressing Delete / Copy. Unsupported-format placeholder spans
  also get a subtle background tint when selected.
- The caret no longer hides behind the fixed ribbon (top) or
  status bar (bottom) after Enter / arrow / new-heading actions.
  The browser's auto-scroll-into-view now reserves space for both
  fixed bars via `scroll-padding`.
- Legacy Verbatim character-style ids are now recognized on import
  — pre-modern distributions used `StyleBoldUnderline` for the
  underline mark and `StyleStyleBold12pt` for the cite mark. Files
  from those distributions (e.g. 2013-14 era debate evidence) now
  import with their underlining and cites intact instead of
  silently losing them. Export still normalizes to the current
  styleIds, so re-saving an old file cleans up the rStyle output.
- The AI alt-text generator now ships surrounding context with the
  image — the enclosing card's tag and cite, plus the paragraphs
  immediately before and after the image — so descriptions reflect
  what the image is *doing* in the argument instead of generic
  "a chart with bars" captions.
- Shift-F3 (cycle case) now keeps the selection after each press,
  so the user can re-press to advance to the next case state
  (lower → UPPER → Title → lower) without re-selecting.
- Speech-doc designation now uses the same warm-gold accent in both
  single-window multi-window mode (the banner under the ribbon) and
  single-window multi-pane mode (the per-pane chip), so the "this
  is the speech doc" affordance reads the same regardless of window
  topology.
- The window can now shrink to any size — the previous 800×600
  Electron floor is gone, so the status bar (zoom strip) stays
  on-screen on small / tiled / split-screen layouts. Ribbon
  panels hide progressively when there's literally no room left.
  The cascade is 11 steps, least-essential first: character
  styles → structural styles → doc-name chip → format menu →
  table / image / sub / sup / strike cluster → font-size step
  buttons → highlight + shading + font color panel → comments
  toggle + add-comment → file-ops buttons (Open / New / Save /
  Autosave) → read-mode + nav-pane toggle → settings gear +
  keyboard-shortcut button. The timer toggle (⏱) stays outside
  the cascade so it's always reachable mid-round. The hide/show
  is measurement-driven (not media-query breakpoints), so it
  adapts to chrome scale, OS font size, and which panels are
  even visible to begin with.
- Ribbon cleanup: the plain-paste toggle (`T`) is hidden on desktop
  (F2 reads the clipboard directly there — no armed state to show),
  and the autosave toggle (⏱) is hidden on the web edition
  (autosave requires an on-disk file handle, which the browser
  can't provide).

## 0.1.0-alpha.1 — 2026-05-16

First downloadable preview of CardMirror. **This is an alpha.**
Expect bugs, missing features, and occasional breakage. Don't use
it for tournament-day work yet; keep a Verbatim copy of anything
important.

What works:

- Open and save Microsoft Word `.docx` files. Round-trips against
  Verbatim-format docs.
- Native `.cmir` format for lossless save / restore (no Word
  conversion costs, autosave-eligible).
- Verbatim-parity editing model: Pocket / Hat / Block / Tag /
  Analytic / Undertag styles, F-key shortcuts, condense /
  uncondense / case-toggle, emphasis / underline / highlight,
  shrink, send-to-speech, paste-as-plain.
- Multi-doc workspace — pick between a three-pane single-window
  layout or one window per doc.
- Send-to-speech across windows in multi-window mode.
- Per-doc read mode and autosave.
- Crash-recovery journal — unsaved drafts come back on next
  launch.
- Word-style left navigation pane: outline view, multi-select,
  drag-reorder.

Not in this release (planned):

- Full-text and schema-aware search across open docs / the
  evidence library on disk.
- Transclusion (live-linked content from a source doc).
- Cross-window drag-and-drop. (Cross-pane drag within multi-pane
  mode works.)

Operational:

- **Crash dumps** are collected locally to disk only — never
  uploaded anywhere. If CardMirror crashes and you want to send
  a report, open *Help → Open Crash Dumps Folder* and attach
  the minidump to a GitHub issue.
- **Auto-update**: on launch, CardMirror checks GitHub Releases
  for a newer version and downloads it in the background. When
  one's ready, a dialog asks whether to restart now or install
  on next quit. *Help → Check for Updates…* triggers the same
  check on demand.

Platforms:

- **macOS** — `.dmg` for Intel (x64) and Apple Silicon (arm64).
- **Windows** — NSIS installer (`.exe`) for x64.
- **Linux** — `.AppImage` (distribution-agnostic) and `.pacman`
  (Arch-native; install with `sudo pacman -U file.pacman`) for
  x64.

Known gaps:

- Desktop builds are unsigned. First-launch warnings on
  Windows (SmartScreen) and macOS (Gatekeeper) require a
  right-click → Open. See README.
