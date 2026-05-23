# Changelog

User-facing release notes for CardMirror. Brief summaries of what
changes in each release, written for users of the editor. For
in-depth rationale and implementation context behind each entry,
see `DETAILED_CHANGELOG.md`.

## Unreleased

### Fixed

- **Viewport no longer rockets to the doc end after a paste or
  F7 wrap that triggers card-body absorption.** The card-body
  absorption rule (paragraphs and friends after a `card` get
  absorbed into it) was wholesale-rewriting the doc in a single
  `replaceWith(0, content.size, rebuilt)` transaction, and PM's
  default selection mapping for that shape pushed the cursor to
  the END of the rebuilt content. Absorb now does the same
  rewrite as two surgical steps per region (insert the absorbed
  bodies inside the card, then delete the doc-level orphans), so
  PM's mapping leaves the cursor in place. Affects any sequence
  that creates absorbable doc-level paragraphs near the
  cursor — F7 above orphan paragraphs, paste that lifts content
  to doc level, manually-built docs with pre-existing orphans.
- **Pasting multi-line text into the middle of a card_body that
  has sibling card_bodies no longer splits the card.** PM's
  default slice fitting was bubbling the multi-paragraph split
  up to the card level, producing a phantom empty-tag card
  carrying the trailing siblings. The paste handler now
  pre-fits the slice into `card_body` children when the cursor
  is in a card_body context, so the split stays cleanly inside
  the card.
- **Copy Last Cite now lands where the cursor visually is when
  the cursor sits at the start of a paragraph.** Previously, at
  offset 0 of a body / cite / undertag / doc-level paragraph,
  the new cite was inserted AFTER that paragraph — so in a
  multi-paragraph card with no cite, putting the cursor at the
  start of the first body and copying the last cite sent the
  cite to the wrong slot (between body 1 and body 2 instead of
  between the tag and body 1). The command now inserts the cite
  BEFORE the paragraph in that boundary case. Cursor
  mid-paragraph or at the end of a paragraph still inserts
  after, as before.

## 0.1.0-alpha.4 — 2026-05-22

### Added

- **Selection model now follows Word's actual rules instead of
  the browser's regex-style word boundaries.** Affects every
  spot where the editor decides "what counts as a word":
  whole-word Find / Replace, the F7 / F8 / F10 cursor-expansion
  commands, and the keyboard + mouse selection gestures
  described separately below. The rules in brief: letters,
  digits, `'` (U+0027), and `'` (U+2019) are word characters;
  `_`, `.`, `,`, `:`, `;`, `-`, em / en dashes, ellipses, and
  `'` (U+2018) are NOT (they break words). So `user_name` is
  two words, `1,234` is three, `U.S.A.` is three (each letter
  alone), `H2O` is one, `don't` / `we're` are one each.
  Whole-word Find of "don" no longer matches "don" inside
  "don't", and "user" now matches "user" inside "user_name".
  F10 Emphasize Acronym on "U.S.C.P." now emphasizes U, S, C,
  P (instead of just U).
- **Mouse selection now uses Word's selection state machine.**
  Double-click selects a unit (word + trailing space, with the
  spec's class rules — `don't` selects as one word, `U.S.A.` as
  three) and dragging extends word-by-word with the original
  word staying fully selected when the drag reverses. Single-
  click + drag starts character-granularity; pulling past the
  clicked word's boundary upgrades to word granularity (and
  pulls the rest of that word in); pulling back inside
  downgrades to character. Triple-click selects a paragraph;
  dragging extends paragraph-by-paragraph, and shift+click
  after a triple-click extends paragraph-by-paragraph the same
  way (matching triple-click + drag). Shift+click after a
  single or double click extends with whatever granularity was
  set (drag and shift+click are the same operation). Shift+
  double-click and shift+triple-click are no-ops.
- **Keyboard navigation now uses Word's per-unit nav.**
  - `Ctrl+Left` / `Ctrl+Right` (`Alt+Left/Right` on Mac): jump
    to the start of the previous / next unit using the
    spec-compatible word iterator (so `don't` is one unit,
    `U.S.A.` is three, `user_name` is two). Trailing space
    absorbs into the unit it follows, so one `Ctrl+Right` from
    the start of `help to` lands just before `to`, and the
    symmetric `Ctrl+Left` rewinds. With an existing selection
    and no Shift, `Ctrl+Left/Right` collapses to the
    appropriate edge (same as plain Left/Right) instead of
    jumping by a unit — matches Word. Shift-variants extend.
  - `Ctrl+Up` (`Alt+Up`): go to the start of the current
    paragraph; if already there, the previous paragraph (Word's
    asymmetric "stop on current first" behavior).
  - `Ctrl+Down` (`Alt+Down`): go to the start of the next
    paragraph.
  - `PageUp`: same shape as `Ctrl+Up` but at the heading level —
    go to the start of the current heading marker (the most
    recently passed pocket / hat / block / tag / analytic);
    if already there, the previous heading marker. Useful for
    skipping over body content to land on the next structural
    anchor.
  - `PageDown`: go to the start of the next heading marker.
  - All paired with `Shift+` variants that extend the selection
    instead of collapsing.
  - `Home / End` (visual line start / end) and `Ctrl+Home /
    Ctrl+End` (doc start / end) are left on the browser default,
    which already matches the spec.
- **Formatting commands skip the selection's trailing space.**
  When you double-click "word" Word selects "word + space" and
  bolding bolds the word only — that behavior now applies in
  CardMirror across every formatting command (bold, italic,
  underline, cite, emphasis, highlight, shading, font size,
  font color, clear-formatting, and friends). A multi-word
  selection like "the quick fox " loses the trailing space
  from the formatting only — internal spaces stay formatted.
- **Opening a file that's already loaded surfaces the existing
  copy instead of opening a duplicate.** Picking the same file
  from the Open dialog (ribbon or per-slot "+ Open file" button)
  brings the existing copy into focus, shows its slot if it was
  in a stack, and toasts "<filename> is already open." rather
  than spawning a second copy with its own undo history and
  edits. The guard covers cross-window duplicates too: opening a
  file that's already loaded in a DIFFERENT CardMirror window
  focuses that window for you instead of opening another copy.
  Files without an on-disk handle (never-saved docs) aren't
  deduped — they have no identity to compare against yet.
- **Comments work in multi-pane mode.** A single shared comments
  column sits to the right of the three pane slots — visually a
  narrow fourth slot that shrinks the doc slots equally. Threads
  shown follow focus: click, drag, Ctrl+Tab, or Ctrl+1/2/3 — the
  column repaints with the new doc's threads. Add Comment, Ask
  AI, and the comments toggle all work the same as in
  single-pane. Cards re-layout against the focused pane's scroll
  so each card stays aligned with the heading it annotates.
- **Ctrl+1 / 2 / 3 — focus the named multi-pane slot.** No-op
  when the slot is empty. Rebindable in Settings → Keybindings.
- **Ctrl+Shift+1 / 2 / 3 — send the focused slot's visible doc
  to slot 1 / 2 / 3.** Mirrors the Ctrl+1 / 2 / 3 focus chord.
  Source slot collapses to its next-visible doc or empties; the
  moved doc keeps its cursor, selection, undo history, and
  unsaved-edits state. No-op when the focused slot is empty or
  when the target is the source slot itself. Rebindable in
  Settings → Keybindings.
- **Ctrl+Tab / Ctrl+Shift+Tab — cycle docs within the focused
  multi-pane slot** (when the slot holds 2+ docs). Holding
  Ctrl after pressing Ctrl+Tab shows an Alt+Tab-style overlay
  centered over the focused slot's pane, with each doc in the
  stack listed top-to-bottom; each Tab while Ctrl is held
  advances the highlight, releasing Ctrl commits the
  highlighted doc as visible, Escape cancels. List items show
  the filename plus a small blue dot when the doc has unsaved
  changes. Wraps around at both ends. Web users without the
  chord (browsers reserve it for tab cycling): use
  Ctrl+Alt+Tab — same handler accepts both shapes, so it also
  works on desktop. The chord itself is fixed — hold-and-press
  semantics don't fit the discrete-press rebindable-command
  model.
- **Ctrl+Shift+F — toggle expand-mode** on the focused
  multi-pane slot (same behavior as clicking the chip's ⛶
  expand button). Rebindable in Settings → Keybindings.
- **Ctrl+W — close the focused multi-pane doc** (or the entire
  window if no slot is focused / the focused slot is empty).
  Rebindable in Settings → Keybindings.
- **Slot number badge on each multi-pane chip** — a small `1` /
  `2` / `3` glyph immediately left of the expand button.
  Disambiguates which slot a chip belongs to when only some
  slots are occupied.
- **Exported .docx files now open as Verbatim-ready.** When a
  Verbatim user opens a CardMirror-saved .docx in Word, the
  Debate ribbon activates immediately — no need to click the
  Verbatimize button first. Works on both Mac and Windows
  Verbatim installs. Verbatim's own files, manually-Verbatimized
  files, and CardMirror's now-Verbatimized files all read the
  same way for users.
- **Emphasize Acronym (Ctrl+F10).** New ribbon command. Select
  any text (or a partial word — the selection auto-expands to
  whole-word boundaries) and the first letter of every word in
  the range gets the Emphasis style applied. Useful for marking
  the source letters of an acronym: select "United States
  Capitol Police", press Ctrl+F10, and U / S / C / P are
  emphasized. Selection-only — no-op without a selection, and
  no-op if the selection is entirely whitespace.
- **Keybindings editor (Settings → Keybindings) is now grouped
  by category** — same 17-section taxonomy as the Keyboard
  Shortcuts reference modal (File, Speech, Structural styles,
  Character styles, Inline formatting, Condense, Editing
  utilities, Highlight tools, Color pickers & menus, Find, View,
  Zoom & scale, Comments, AI, Select, Cleanup, Table). Each
  group's heading sticks to the top of the scrollable list as
  you scroll. Previously the editor rendered every command as
  one alphabetical flat list.
- **Resizable comments column.** Drag the column's left edge to
  resize it (240 – 560 px). The col-resize cursor appears when
  you hover near the edge. Persists across sessions via the new
  `commentsColumnWidth` setting.
- **Nav-pane highlight follows the editor cursor.** Previously
  the blue highlight only updated when you clicked a nav-pane
  entry. Now it tracks whichever heading's section contains the
  cursor — moving the caret, typing into a new heading, clicking
  in the editor, and find-next all update the highlight.
  Ctrl/Shift-click multi-selection still works but collapses on
  the next caret move (matches "the highlight shows where the
  cursor is").

### Fixed

- **Round-tripped .docx files with hyperlinks no longer open as
  corrupted in Word.** URLs containing `&` (very common in
  query-string-heavy citation links — multiple `&`-separated
  parameters) were being written into the hyperlink Target
  attribute without XML-escaping, producing malformed XML.
  Word recovered the doc body but flagged it as corrupted on
  open, and images attached to that doc could fail to display.
  Now properly escapes `&`, `<`, `>`, `"`, and `'` in all
  hyperlink and image relationship Targets.
- **Plain-paste no longer jumps the viewport to the doc end.**
  Pasting text that contained a line break (the common case:
  triple-clicking an article title in the browser, which grabs
  a trailing newline) into a tag / cite / undertag / analytic
  used to split the surrounding card at the newline boundary
  and scroll-to-bottom. Plain-paste now flattens internal
  whitespace to single spaces (and trims edges) when the target
  is a single-line block; multi-paragraph blocks like card_body
  still preserve intentional paragraph splits from the
  clipboard.
- **Comments column now extends through the full scroll
  height.** Was rendering only at the top of the document and
  cutting off below. Same family of post-path-A regression as
  the multi-doc top-shift and recovery-sidebar offset fixed
  during alpha.3 — `#app` becoming the bounded scroller meant
  the inner flex layout's cross-axis was viewport-bounded,
  leaving the column's box (and background strip) stranded at
  the top.
- **Comments column on short / empty documents no longer looks
  truncated.** Inner layout now sizes to max(viewport, content),
  so the column's background fills the visible area even when
  the doc has nothing in it.

### Changed

- **AI comments are now identified by name and initials, not by
  an invisible flag** — the initials badge always reads `AI`, and
  the author name has `(AI)` appended (e.g. `Clod (AI)` when a
  custom persona name is set). Previously the AI-ness lived on a
  `kind` field that didn't survive a docx round-trip, so AI
  comments lost their purple styling after being saved to Word
  and re-opened. The new identifiers ride along through docx
  naturally. The small "AI" tag that used to appear next to the
  author name is gone — redundant now that `(AI)` is in the
  name itself. Existing AI comments saved before this change
  still display as AI through a legacy back-compat check.

### Removed

- **Bottom-left collapse/expand toggle in the comments column**
  (the small ▾/▴ circle). Active-comment collapse still works
  by clicking outside the sticky card; the "re-expand most
  recent thread" affordance the button provided is gone.

## 0.1.0-alpha.3 — 2026-05-21

### Added

- **Setting: Format nav pane entries by type** (Settings →
  Appearance, on by default). Turn off for a uniform nav-pane
  list where only indentation conveys hierarchy — no bold
  top-level headings, no analytic-blue accent, no per-level
  size shifts. Display-only; the underlying doc is untouched.
- **Setting: Check for updates on launch** (desktop only,
  Settings → General → "About this install"). Off by default —
  opt in if you want the app to check for a new release at boot.
  When enabled, the first window of each app session does a
  silent check; if an update is available, a modal pops with a
  link to the GitHub release page in your default browser.
  Subsequent windows in the same session skip the check (mirrors
  the first-window-only gating used by the doc recovery UI).
  Errors and "you're current" outcomes are silent on the
  auto-launch path — no notification noise when you're offline
  or already up to date. The manual Help → Check for Updates…
  and the Settings panel button still give full feedback for
  every outcome.

### Fixed

- **Help → Check for Updates now reports a result.** Every click
  now resolves to one of three dialogs: "You're on the latest
  version" (with the version number), "Update available" (with a
  button to open the release page on GitHub so you can read what's
  in it; the actual download proceeds in the background), or
  "Couldn't check: <reason>" with the Releases URL as a manual
  fallback. The previous silent-no-feedback behavior is gone.
- **About this install panel** (Settings → General) now lists
  Chromium and Electron versions as separate fields, alongside the
  existing app version + OS + user-agent. Makes "is the user
  running the version they think they are?" a one-line check
  during bug triage instead of a UA-parsing exercise.
- **Release workflow no longer races itself.** alpha.2's release
  produced two separate drafts because three OS matrix jobs
  concurrently saw "no release for this tag" and each created its
  own. A new `prepare-release` job runs first to create the draft,
  then the matrix jobs upload to it. No user-facing change; cleaner
  release ergonomics.
- **macOS scrolling, typing, and nav-pane click latency now
  match the in-browser feel.** alpha.2 on macOS was materially
  slower than the web edition on the same machine. Two
  coordinated fixes close that gap: the editor's scroll
  container migrated from the document itself to an inner
  bounded container (`#app`), which eliminated a doc-height
  composited layer Chromium was re-compositing on every scroll;
  and the bundled Electron version was upgraded from 33
  (Chromium 130) to 42 (Chromium 148), which lands the newer
  Skia Graphite compositor backend and the per-event decoupling
  improvements that make Chrome on macOS feel smooth on the
  same content. Linux and Windows builds also benefit but the
  gap was smaller there to begin with.
- **Keyboard Shortcuts cheat sheet now lists every bindable
  action.** The reference modal was hand-maintained and had
  fallen behind the keybindings registry — twenty-plus
  commands added in alpha.2 (zoom, chrome scale, paintbrush
  toggles, find, font color, the four picker openers, the
  three tools menus, and several others) weren't appearing.
  Now drives off the full registry and won't silently drift
  out of sync again.
- **Scrolling past the nav pane's top or bottom no longer
  scrolls the editor.** The wheel-event chain now stops at the
  nav pane's boundary, which also fixes the follow-up bug where
  reversing scroll direction kept scrolling the editor instead
  of the nav pane.
- **Open button on the web edition no longer silently drops your
  selection.** Clicking the 📂 Open button, picking a file, and
  ending up with nothing loaded — while `Ctrl-O` worked on the
  same page — was a race in the file-picker cancellation
  detection. Fixed by switching to the native `cancel` event.
- **Dark mode now guarantees readable text everywhere.** Three
  related fixes that together make dark-mode-with-apply-to-doc
  actually usable on real Verbatim docs:
  - Runs that Word writes with an explicit "default black" color
    (`w:color="000000"`) used to stay literally black, leaving
    large swaths of body text invisible against the dark
    surface. Now they inherit the themed text color and flip
    light.
  - Shading (Verbatim's "protected highlight" — yellow, grey,
    etc.) now forces text contrast like highlights already did:
    black on light shading, white on dark shading, regardless
    of theme.
  - Hyperlinks use a bright sky blue in dark mode (Word's
    `#0563C1` is too dark to read on a dark background).
  - Beyond those: any text color you (or Word) wrote that's
    too dark to read against the dark surface — Word's
    hyperlink blue, deep grays, dark reds — falls back to the
    themed text color. Turn off "Apply theme to the document
    area" if you'd rather see the original colors.
  - Underlines under highlighted / shaded text now match the
    text color (black on light backgrounds, white on dark),
    instead of staying themed-white and cutting through the
    black text like a faded slash.
  - The nav pane flattens to white in dark mode — the
    per-level greys and analytic-blue cues read as
    inconsistent against the dark chrome.
  - "Dark chrome, light document" mode (dark theme with
    "Apply theme to the document area" OFF — the default)
    now actually paints the document area white, across the
    full scrollable extent in both single-doc and multi-pane.
    Previously the editor surface had no background of its
    own and showed the dark chrome's color through it,
    defeating the whole point of leaving "apply to document"
    off.
  - Native form controls in dark mode now render in their
    dark variant. Previously the body-font dropdown in
    Settings → Appearance painted its select with the dark
    background-color token but left the option text in the
    browser's default near-black, making the font names
    invisible against the dark dropdown.

## 0.1.0-alpha.2 — 2026-05-20

### Added

- **Built-in countdown timer.** Native replacement for Verbatim's
  bundled timer. Toggle with the ⏱ button in the ribbon. Includes
  a big speech-timer display with start / pause, three speech-
  duration presets, Aff and Neg prep clocks, and a reset column.
  Type into the display while paused to set a custom duration.
  State syncs across windows. Configurable in Settings →
  Appearance: profile (High School / College / Pomodoro) with
  per-profile editable durations, compact layout, low-time flash
  with editable thresholds, and prep-side label style (Both /
  Text / Color).
- **Dark mode** (Settings → Appearance → Theme: Light / Dark /
  System). The document area stays light by default; flip
  "Apply theme to the document area" for full dark.
- **Chrome scale chord** (`Mod-Alt-=` / `Mod-Alt--` /
  `Mod-Alt-0`) scales the whole window the way your browser's
  `Ctrl-+` zoom does. Independent of the editor zoom
  (`Mod-=` / `Mod--`), so you can fine-tune content size on top.
  Keyboard-only — rebind in Settings → Keybindings.
- **Open with CardMirror from your file manager.** `.docx` and
  `.cmir` are registered as CardMirror file types at install
  time. Double-clicking a file in Finder / Explorer / your Linux
  file manager opens it in CardMirror — spawning a new window if
  the app's already running.
- **Find and Replace** (Ctrl-F / Ctrl-H / Alt-F). Floating bar
  with case-sensitive and whole-word toggles, next / prev
  navigation, a match count, Replace, and Replace All. Every
  match highlights in light yellow with the active match in a
  stronger orange. Three result orderings: categorized (Ctrl-F:
  headings → tags → cites → body, with the category priority
  reorderable in Settings → General), proximity-only (Alt-F),
  and the same categorized order in replace mode (Ctrl-H). The
  bar's expandable results panel lists every match at a glance.
  The nav pane decorates outline entries whose subtree contains
  a match. Find can be scoped to a selection.
- **Editable image alt text** — right-click an image →
  Edit alt text… opens a dialog. Alt text now round-trips
  through `.docx` import and export (the importer used to drop
  it). The AI alt-text generator also updates the image's alt
  attribute and asks before regenerating existing alt text.
- **Active doc filename in a ribbon pill** (opt-in, Settings →
  Appearance → "Show doc name in ribbon"). Useful where the OS
  title bar isn't visible — tiling window managers, hidden-title
  themes, embedded web edition.
- **Multi-pane window title shows every open slot**, joined by
  `·` — e.g. "Foo · Bar — CardMirror" — instead of just the
  focused doc's name.
- **Show / hide the nav pane.** Three ways to toggle: the ☰
  button in the ribbon, the × in the nav-pane header, or a small
  pull-tab on the left edge of the viewport (visible only when
  the nav pane is hidden). Per-window state.
- **Right-click on a hyperlink** opens a context menu — Open
  Link, Copy Link Address, Edit Link…, Remove Link.
- **About this install in Settings → General** — version, host,
  OS, and full user-agent for bug reports. On desktop, includes
  Check for updates and Open crash dumps folder buttons.
- **Every ribbon action is now keybindable** in Settings →
  Keybindings. Twelve previously click-only actions joined the
  registry: font-size step up / down, apply font color, open
  settings, toggle paragraph integrity, the four color/size
  picker dropdowns, and the doc / card / table tools menus.
- **Zoom and paintbrush toggles are keybindable.** Defaults:
  Mod-= zoom in, Mod-- zoom out. The reset chord and paintbrush
  toggles ship unbound (assign them yourself if you want).

### Accessibility

- **Reduce motion** (Settings → Accessibility). System (follows
  OS preference) / On / Off. Flattens UI animations.
- **Readability-tuned body fonts.** Three SIL-OFL fonts ship
  with CardMirror: **Atkinson Hyperlegible**, **Lexend**, and
  **OpenDyslexic**. Plus the British Dyslexia Association's
  endorsed system sans-serifs (Verdana, Tahoma, Comic Sans MS)
  when installed on your OS. Settings → Appearance → Body font
  groups options by category with the readability options
  leading.
- **Highlight + shading display overrides** with 1–3 ordered
  slots. Slot 1 remaps the most-common color in the doc, slot 2
  the next-most-common, last slot is a catch-all.
- **Per-token color overrides** for every UI color (background,
  borders, accent, hover, etc.) with reset-per-row + reset-all
  controls. Overrides win over the active theme.
- **Cursor-position color readout** in the status bar — when an
  override is active, shows the actual stored colors at the
  cursor so you know what's encoded in the doc even when the
  override is hiding it.

### Changed

- **Nav-pane heading clicks are dramatically faster on big
  docs.** Clicks where the heading is already visible are nearly
  instant. First click into a fresh part of the doc no longer
  adds a multi-second pause on top of the unavoidable rendering
  cost. (Previously every click cost ~2 seconds on a 2000-card
  file.)
- **Re-pressing a heading shortcut** (F4 / F5 / F6 / F7 /
  Mod-F7 / Mod-F8) on a paragraph that already has that style
  strips the paragraph's indentation while keeping the style.
  Was a no-op before.
- **F8 / Apply Cite Style** now expands to the word at the
  cursor when there's no selection — matching F10's behavior.
- **Shift-F3 (cycle case)** keeps the selection across cycles,
  so you can re-press to advance lower → UPPER → Title → lower.
- **Triple-click + drag** extends the selection paragraph-by-
  paragraph (was: collapsed back to character-level on first
  drag move).
- **Text-selection background is translucent** — highlights,
  shading, and other colored backgrounds show through. You can
  now tell at a glance whether selected text is highlighted.
- **Selected images** show a 2 px accent outline so it's
  obvious the click registered.
- **Paint mode cursor** is an I-beam with a small swatch of the
  active paint color in the corner. Picking a different color
  while paint mode is armed updates the cursor live.
- **Caret stays visible** after Enter / arrow keys / new-
  heading actions. The browser's auto-scroll-into-view now
  respects the fixed ribbon and status bar.
- **Window adapts to any size.** The 800×600 floor is gone, so
  the status bar stays visible on small / tiled / split-screen
  layouts. Ribbon panels hide progressively in a deterministic
  order when the ribbon runs out of room; settings,
  keyboard-shortcut, read-mode, and nav-pane buttons hide last.
- **New setting: default file format for new docs** — `.docx`
  (default) or `.cmir`. Affects the Save-As default for any doc
  that doesn't yet have an on-disk handle.
- **New setting: jump to doc top on read-mode toggle**, off by
  default. When on, toggling read mode scrolls to the top and
  places the cursor at the doc's start.
- **Word-count selection button (Σ)** moved off the ribbon to
  the left edge of the status bar, next to the live read-aloud
  word counter.
- **Speech-doc designation** uses the same warm-gold accent in
  both multi-window mode (the banner under the ribbon) and
  multi-pane mode (the per-pane chip).
- **Ribbon cleanup**: the plain-paste toggle (`T`) is hidden on
  desktop where F2 reads the clipboard directly. The autosave
  toggle is hidden on the web edition where autosave can't fire.
- **Keyboard-shortcut command labels** in Settings →
  Keybindings use consistent title casing throughout.

### Fixed

- **Toggling multi-pane → single-window mode no longer silently
  drops open docs.** Some panes' contents were lost on the
  switch back to one-doc-per-window.
- **Picking up a nav-pane heading and releasing without moving
  drops it back where it came from.** Used to land in a sibling
  slot.
- **Copy Last Cite now finds cite-marked text you just
  applied.** Previously, applying the cite style via marking
  text (rather than a paragraph style change) didn't promote
  the paragraph, so Copy Last Cite fell back to an older cite.
- **Underline / Emphasis font-size settings take effect.** The
  per-style size sliders for these two styles were silently
  ignored before.
- **Files from 2013–14-era Verbatim distributions import with
  underline / cite formatting intact.** Those distributions
  used older character-style ids that CardMirror used to skip
  silently.
- **AI alt-text descriptions reflect what the image is doing in
  the argument.** Generations now include the enclosing card's
  tag and cite, plus the paragraphs immediately before and
  after the image, instead of producing generic captions.
- **"New document" while CardMirror is already running no
  longer offers to recover docs from other windows.** Only the
  first window of an app session surfaces the startup-recovery
  sidebar.
- **Opening a doc starts both the editor and nav pane scrolled
  to the top** instead of inheriting the previous doc's scroll
  position.

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
