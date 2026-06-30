# Changelog

User-facing release notes for CardMirror. Brief summaries of what
changes in each release, written for users of the editor. For
in-depth rationale and implementation context behind each entry,
see `DETAILED_CHANGELOG.md`.

## Unreleased

### Added

- **Per-document outlines in the multi-doc workspace.** Each open document's
  outline section in the navigation rail can now be managed on its own. Click
  the **×** on a section (or the outline button in that document's title bar)
  to hide just that document's outline — the document stays open and the other
  outlines are untouched; the title-bar button brings it back. Drag the divider
  between two sections to resize them, and double-click the divider to even them
  out again. Previously the × closed the whole rail and the sections always
  split the rail evenly.

## 0.1.0-beta.4 — 2026-06-29

### Added

- **Screen reader support setting.** Settings → Accessibility → "Screen reader
  support" turns the browser accessibility tree on or off. It's **off by default**
  to avoid a crash (see Fixed below); switch it on if you use a screen reader or
  other assistive technology. The change takes effect after you restart CardMirror,
  and the setting tells you when a restart is still pending.

- **Select multiple separate ranges at once.** Hold **Ctrl** (**Cmd** on Mac)
  and drag to add another range to your selection, or Ctrl/Cmd-click to add a
  word — building a discontinuous selection across non-adjacent spots, like Word.
  You can **copy** the whole set, and run any formatting that already works on a
  Select Similar selection (highlight, underline, emphasis, cite, colors, shrink,
  clear formatting, …) across all the pieces in one go. The set shows in the
  selection color; Escape or a plain click clears it, and any edit ends it.

### Fixed

- **White screen and lost work when an accessibility tool was running.** On some
  machines with a screen reader, Windows Voice Access, or similar assistive
  technology active, CardMirror could crash — the editor turned solid white and
  unsaved work was lost. The cause is a bug in the underlying browser engine
  (Chromium) while it builds accessibility data for heavily-highlighted cards.
  CardMirror now keeps that accessibility data off by default, which avoids the
  crash; re-enable it under Settings → Accessibility if you rely on a screen
  reader.

## 0.1.0-beta.3 — 2026-06-29

### Added

- **Custom dash autoformat.** Settings → Editing → "Custom dash" turns a typed
  `---` into an en or em dash (with or without surrounding spaces) the moment you
  type the third hyphen. Press Backspace right after to revert to the literal
  `---`. Off by default.

- **Custom filename prefixes for preset saves.** Settings → General now lets you
  change the **Send Doc / Read Doc / Marked Doc** filename prefixes (defaults
  `SEND_` / `READ_` / `MARKED_`; leave one empty for no prefix). They apply to
  both the Save As preset buttons and the silent Save Send Doc / Save Marked
  Cards commands, gated on the existing "Prefix preset saves" toggle.

- **Paste and Destructively Condense (desktop).** A command that pastes the
  clipboard's plain text and immediately condenses just what you pasted, merging
  its paragraphs (paragraph integrity off, destructive) — the result of an F2
  paste followed by Alt-F3 over the pasted text. Unbound by default (bind it
  under Settings → Keybindings). Desktop only — the web build can't read the
  clipboard.

- **Save Marked Cards.** Pull out just the cards you've placed a reading marker
  in and save them on their own, in your chosen format. Two ways in: a **"Marked
  Doc"** button in the Save As dialog, and a **Save Marked Cards** command
  (default **Mod-Alt-M**, rebindable) that saves silently to a configurable
  destination — Settings → *Marked Cards destination* (same folder / fixed
  folder), with the `MARKED_` filename prefix and your default format — mirroring
  Save Send Doc. Cards only (analytics and headings are dropped); if nothing is
  marked it does nothing and says so.

- **Smart quotes (optional).** Turn on Settings → Editing → "Smart quotes" and a
  straight `'` or `"` you type curls to the right direction by context — opening
  after a space, dash, bracket, or start of line; closing (and the apostrophe)
  otherwise — so `don't` and `(he said "hi")` come out right. Press Backspace
  immediately after a curl to revert it to the straight character. Off by default.

- **New "Flip Quote Direction" command.** Bindable (unbound by default); with a
  selection it flips every curly quote to its opposite direction (left ↔ right),
  preserving formatting — the manual fix for cases like `'tis` or `'90s` that
  smart quotes (like Word) guess wrong.

- **Edit the timer's prep clocks directly.** When an Aff/Neg prep clock is loaded
  and paused, click the big display to type a new time — handy if you started or
  stopped prep a beat late. The edit saves to that side's prep balance, so it
  sticks when you switch to another clock and back (until you Reset).

- **The timer shows which prep clock is loaded.** The Aff/Neg "differentiate by"
  setting (color / text / both) now also styles the big display when a prep clock
  is showing — so it's clear at a glance that the time is prep, and which side.

- **New "Cycle Timer Preset" command.** Bindable (unbound by default — set it
  under Settings → Keybindings); it cycles the timer profile College → High
  School → Pomodoro, applies that profile's durations, and surfaces the timer.

- **Controls for formatting-gap bridging.** When you format a word next to an
  already-formatted word, the editor bridges the small gap between them so the
  styling is continuous. Two new Editing settings govern this: a toggle to turn
  the automatic bridging on or off (the manual "Fix Formatting Gaps" command is
  unaffected), and a choice of which gaps get bridged — **whitespace and
  punctuation** (default) or **whitespace only**. Bridging also no longer happens
  inside structural paragraphs (tags, analytics, headings, undertags) — only in
  body text — so a selection spanning both bridges in its body paragraphs and
  leaves its structural lines alone.

- **Open a file by dragging it into the window.** Drag a `.docx`, `.cmir`, or
  `.cmir-journal` from your file manager onto any CardMirror window — the editor,
  the navigation pane, or the home screen — to open it, the same as File → Open
  (including the unsaved-changes prompt, and focusing an already-open copy).
  Desktop only; other file types are ignored, and dragging cards around the
  editor is unaffected.

- **Move a card or section up/down in the outline.** New **Move Container Up** /
  **Move Container Down** commands (default **⌘/Ctrl-Alt-↑ / ↓**) grab the
  cursor's smallest enclosing outline item — a card / analytic unit, or a heading
  and its whole section — and move it one spot among same-level items in the
  navigation pane. Cards reorder among cards, blocks among blocks, and so on;
  moving past the edge of a section flows into the adjacent one. Rebindable in
  Settings (listed under Editing utilities).

### Changed

- **The command bar and settings search find more by synonym.** "fix", "repair",
  and "restore" now find each other (e.g. "restore" surfaces the Repair commands),
  as do "delete" and "remove" ("remove" finds the Delete Row / Column / Table
  commands). "add" and "insert" find the same element commands — "add table",
  "add row" / "add column", "add image", or "add received card" surface the
  corresponding Insert command, and vice versa (the create-type commands — Add
  Quick Card, Add Comment, Add Note — are intentionally left out, since they make
  something new rather than placing it). And "timer profile" and "timer preset"
  are interchangeable, each finding the Cycle Timer Preset command and the Timer
  profile setting.

- **Repair Paragraph Integrity: Ctrl-Enter can mark an already-broken paragraph
  for indent.** When the phrase already starts its paragraph, plain Enter still
  does nothing (no break is needed), but Ctrl-Enter now marks that paragraph for
  indent-on-exit — so a card's first body paragraph, which can't be split, can
  still be marked to indent.

- **AI operations now also lock styling and marks in the passage they're working
  on.** While an AI operation runs on a passage, the editor already refused typed
  edits there; it now also refuses style and mark changes (highlight, underline,
  font size, named styles, etc.) to that passage, so the operation's content
  can't shift under it mid-run.

- **Document zoom is now per-editor, not global.** Body-text zoom (the zoom
  buttons, Ctrl-= / Ctrl--, pinch / Ctrl-scroll) now applies only to the editor
  you're in — zoom one document in while another stays zoomed out, including
  independently per pane in the three-pane workspace. It no longer syncs across
  windows or persists; instead, documents open at a configurable default
  (Accessibility → "Default document zoom", 100% by default) and reset to it on
  reload. Chrome scale (Mod-Alt-=) is unchanged and still scales the whole window
  uniformly across windows.

- **Find and Paragraph Integrity match across dashes and ellipses.** Searching
  (or typing a paragraph-start phrase) now treats every kind of dash — hyphen,
  en-dash, em-dash, minus sign, and the rest of Unicode's dash family — as
  interchangeable, and treats an ASCII `...` and the single `…` character as the
  same. This joins the existing curly-vs-straight quote matching, so text pasted
  from Word matches whether you type the fancy character or the plain one. (The
  invisible soft hyphen is left as-is.)

- **Timer durations are capped at 99 minutes** in settings (speech presets and
  prep), up to which any value is allowed.

- **Saving a quick card now captures whole cards and sections.** Add Quick Card
  used to save exactly your raw selection — which could be half a card or a stray
  fragment. It now snaps the selection to the whole cards/sections it covers
  (re-highlighting them so you see what's saved), and you can save with no
  selection at all — it captures the card or section your cursor is in. This
  matches how sending to the dropzone, a starred recipient, or the speech doc
  already works.

- **Deleting a quick card now uses a two-click confirm instead of a popup.** The
  Delete buttons in the Quick Cards manager (both per-card and bulk) arm on the
  first click ("Delete?") and delete on a second click within a few seconds —
  matching the flashcard manager, and replacing a confirmation dialog that didn't
  fire reliably in the desktop app.

- **Quick card buttons are now hidden by default, behind a setting.** The Quick
  Cards ribbon cluster (command bar, tag picker, manage, add) is off by default —
  turn on Settings → Editing → "Show quick card buttons" to show it, mirroring
  the dropzone shelf toggle. Quick cards still work while hidden, and the command
  bar still opens with its keyboard shortcut.

- **Re-pressing a structural style now consistently resets indent, font size, and
  font color.** Pressing a Pocket / Hat / Block / Tag / Analytic / Undertag
  shortcut on text that's already that style resets it toward the style's
  canonical look — clearing the paragraph indent, any direct font-size override,
  and any direct font-color override — while leaving line spacing alone.
  Previously this was inconsistent: tags and analytics didn't clear indent,
  undertags didn't clear font size, and none cleared font color.

### Fixed

- **Nav pane no longer flickers while typing just above a heading.** Typing on
  the bottom-most line directly above a heading used to make the outline's
  highlight briefly jump to the next heading and snap back. The nav pane now
  keeps its cached heading positions in sync with every edit, so the
  active-heading highlight stays put (this also fixes the same brief staleness
  for nav click-to-jump).

- **Silent Send/Marked Doc saves won't overwrite the original document.** The
  Save Send Doc / Save Marked Cards commands now refuse to clobber the source
  file when the export would land on its exact path (e.g. an empty prefix at the
  same folder and format) — in fixed-folder mode as well as same-folder mode —
  falling back to the Save As dialog so you can rename. (More reachable now that
  the prefix is customizable.)

- **The bottom scroll runway now accounts for the send/receive pills.** The
  extra space that lets the last line of a document clear the bottom-left shelf
  was only added when the dropzone pill was showing. With pairing enabled but the
  dropzone pill hidden, the send/receive pills sat in that same band yet the
  runway was missing, so the last line clipped behind them. It now appears
  whenever any tray pill is showing — in both single-pane and multi-pane.

- **Timer duration fields no longer lose focus while typing.** In the timer
  durations settings, the field used to deselect after a single digit, so you
  couldn't type a two-digit value like "10" without it jumping away. It now stays
  focused as you type.

- **Timer prep buttons no longer crowd the label at 10:00.** In the text / both
  prep-label modes, the "A:" / "N:" prefix had too little room next to a 4-digit
  time; the buttons now have a bit more horizontal padding.

- **Open .cmir files on iPhone / iPad (web).** On iOS the file picker greyed out
  `.cmir` / `.cmir-journal` files — the browser can't map their custom extension
  to a recognized type — so you couldn't select them. The web open picker now
  lets you choose any file on iOS (the format is still checked after you pick);
  other browsers keep the type filter.

- **Escape now exits the Repair Paragraph Integrity workflow from anywhere.**
  Escape previously only worked while the workflow's input box was focused — once
  you clicked back into the card there was no obvious way out. It now exits the
  workflow regardless of focus, while still deferring to anything layered on top
  that should close first (a modal dialog, or the command bar).

- **Repair Paragraph Integrity: undo works inside the workflow.** Ctrl/Cmd-Z now
  undoes the most recent action without leaving the workflow — re-merging the
  last paragraph break and/or removing its deferred indent mark. Previously it
  did nothing (the bar's input swallowed it). It won't reach back into edits made
  before the workflow opened, and defers to a modal or the command bar layered on
  top.

- **The navigation pane now follows the cursor in three-pane mode.** Clicking or
  moving the cursor in a document highlights the heading it lands in in the nav
  pane — that already worked in single-pane view, and now works in each pane of
  the multi-pane workspace too (each pane tracks its own cursor), including right
  after a pane opens and after structural edits like moving a card.

- **Ctrl/Cmd+A no longer selects the whole interface.** When CardMirror was
  focused but you hadn't clicked into the document (e.g. just after alt-tabbing
  back), Ctrl/Cmd+A selected the entire GUI. It now selects everything within
  whatever text box you're in — the editor, a settings field — and does nothing
  when focus isn't in a text box, rather than selecting the chrome.

- **Pasting over a selection inside a card no longer breaks the card.** Pasting a
  cite, body, or undertag copied from inside a card on top of selected text in a
  card used to tear the card apart — detaching its tag and leaving a stray
  empty-tag card behind. The paste now replaces the selected text and fits the
  content into the card with its structure intact. Pasting a tag, analytic,
  heading, or whole card over a selection still starts a new card, as before.

- **Analytics no longer sit inside cards.** An analytic that ended up tucked
  inside a card — from an older document, or a Word file where an analytic line
  was placed under a tag — now becomes its own analytic unit (taking the content
  below it with it), exactly as pasting an analytic into a card already does.
  This removes a class of glitches where editing around such an analytic (e.g.
  backspacing at its start) could fold it into the tag or scramble the card.
  Existing files are repaired automatically when opened.

- **Inserting a saved card no longer splits the card you're in.** Clicking a
  card on the dropzone shelf, inserting a quick card, or inserting a card a
  partner sent you used to drop it at the exact cursor — splitting the
  surrounding card and leaving a broken, stray card behind (with a "insert into
  the middle of text?" prompt to warn you). It now
  lands as a clean separate card just above or below the one you're in, the same
  as dragging it there would. The mid-text confirmation prompt — and its "Skip
  mid-text confirm" setting — are gone.

- **Sending to the dropzone, a starred recipient, or the speech doc snaps your
  selection to whole cards and sections.** You could previously send an arbitrary
  selection — half a card, a stray paragraph — which arrived broken on the other
  side. Now the selection is rounded to the whole cards/sections it covers and
  re-highlighted so you see exactly what's sent: a partial card grows to the whole
  card, a card you only grazed is dropped, an intro paragraph comes along (with
  its heading) only if you selected most of it, and a selection with nothing
  structural in it sends nothing. Putting your cursor in a card or heading with no
  selection still sends that whole card/section, as before.

- **Pasting body text together with a heading or card no longer breaks the card.**
  Copying a paragraph along with a following heading (or a whole card) and pasting
  it into the middle of a card used to split the card and leave a broken, stray
  card behind. Now the body text merges into the card, the heading/card starts its
  own section, and the rest of the card you pasted into follows under it — the
  same way pasting a heading on its own already behaved.

- **Tagging content that includes a table now wraps the whole card.** When you
  put a tag on a run of paragraphs (with a cite and a table) to turn it into a
  card, the card used to stop at the table, leaving the table and everything
  after it stranded outside. Tables are now pulled into the card along with the
  rest, so the card covers the whole thing.

- **Dissolving a blank-tag card no longer leaves card-body-styled text loose.**
  In the edge case where a card with an empty tag is removed (Backspace at the
  start of the blank tag) and its body moves out to the document, the body now
  becomes a normal paragraph instead of keeping card-body styling with no card
  around it. (A cite stays a cite — it's a valid loose node.)

- **Repair Paragraph's deferred indents stay inside the card you're working on.**
  The Repair Paragraph workflow's indent-on-exit can now only ever apply inside
  the card it was opened on, never spill into a neighboring card.

- **A card made with the "new card" voice command is now tracked in the nav
  pane.** Such a card used to get a tag with no internal id, making it invisible
  to the navigation pane and the outline level filter until the next save. It now
  gets a real id like every other card.

- **Home screen number shortcuts no longer fire over a dialog or the command
  bar.** The 1–9 shortcuts on the home screen used to trigger even when a dialog
  or the command bar was open on top of it — running the wrong action and eating
  the number you were trying to type. They now stand down whenever a modal is up
  or a text field is focused.

- **Highlighting or underlining part of a ligature no longer decorates the whole
  ligature.** With a ligature font, applying highlight, shading, underline, or
  emphasis to only some characters of a ligature (like the "fi" in "find") used
  to paint the entire joined glyph. The ligature now splits at the formatting
  boundary, so only the marked characters are decorated. (As a result,
  highlighted / underlined text no longer forms ligatures.)

## 0.1.0-beta.2 — 2026-06-25

### Added

- **Rebindable "next / previous document" shortcuts for three-pane mode.** Two
  new commands — *Next Document in Slot* and *Previous Document in Slot* —
  single-press cycle through the documents stacked in the focused pane. They're
  unbound by default; assign keys under Settings → Keyboard shortcuts (the
  existing Ctrl+Tab hold-to-cycle is unchanged).

- **Missing fonts now have bundled open-source stand-ins.** When a document uses
  a font you don't have installed — Calibri, Cambria, Times New Roman, Arial,
  Georgia, Helvetica, Comic Sans MS, Verdana, Tahoma (plus Liberation, DejaVu,
  and Noto) — CardMirror now ships a metric-compatible open-source equivalent
  (Calibri→Carlito, Cambria→Caladea, Times New Roman→Tinos, Arial→Arimo,
  Georgia→Gelasio, and so on), so the text renders the way it should instead of
  falling back to a generic. If you *do* have the real font, you still get it —
  the bundled copy is only a fallback, and your real bold/italic still apply.

- **Open recovery journals (`.cmir-journal`) directly.** File → Open now accepts
  `.cmir-journal` files — it loads the document the journal was protecting, as a
  recovered, *unsaved* copy (so saving won't overwrite the original; use Save As
  to keep it somewhere). Handy for pulling a document out of a recovery journal
  without waiting for the automatic crash-recovery prompt.

### Changed

- **"one" / "two" / "three" find the slot commands in the command bar.** Typing a
  spelled-out number in Search Everything now surfaces that slot's Focus-Slot and
  Send-to-Slot commands.

- **"Check for updates on launch" is now "Check for updates automatically" — and
  it also checks daily.** With it enabled, the desktop app checks for updates at
  launch and once every 24 hours while it's running, staying silent and only
  surfacing a prompt when an update is actually available.

- **Mod-R no longer reloads the desktop app by accident.** A stray Mod-R mid-edit
  used to reload the whole window, which felt like a crash. Reload now lives only
  in the View menu; the Mod-Shift-R force-reload shortcut — far harder to hit by
  accident — still works.

- **The command-bar button's tooltip now reads "Toggle command bar"** (it used to
  say "Search quick cards").

- **Nav-pane headings no longer pop a tooltip on hover.** Each outline row used to
  show a redundant "Pocket" / "Card" / etc. type label when you moused over it;
  it's gone.

### Fixed

- **Severe: pasting between cards could detach a card from its tag and silently
  strip a cite — please update.** Copying a cite, body paragraph, or undertag and
  pasting it into another card could split that card away from its tag: the card
  became impossible to select or drag (only the tag moved), and the gray body rail
  no longer reached the tag. Cards left in this broken state behaved erratically —
  among other things they refused a variety of edits that should have been
  legitimate (for instance, pressing Enter to add a new line could silently do
  nothing). In some cases a pasted cite was also quietly demoted to plain body
  text, losing its cite formatting with no visible warning. And
  pasting card content *outside* a card left behind a stray empty card. All of it
  is fixed — pasted content now lands cleanly at your cursor, keeps its own kind
  (cites stay cites, undertags stay undertags, body stays body), and never breaks
  the card. **This was a severe bug, so anyone still on 0.1.0-beta.1 should update
  to this release.**

- **Toggling three-pane mode no longer drops Word (.docx) documents.** Switching
  in or out of three-pane mode reloads each open document from its recovered
  in-memory content; for a document that came from a `.docx`, that content was
  being handed to the Word importer and rejected ("Can't find end of central
  directory"), so the document vanished on the toggle. Recovery content is always
  kept in CardMirror's own lossless format regardless of a document's saved-as
  type, so loading now detects the format from the content itself rather than
  trusting the saved-as label — a docx document still *saves* back as docx. (The
  same fix lets you open a `.cmir-journal` belonging to a docx-saved document, and
  covers the three-pane slot loader. The crash-recovery prompt was never affected.)

- **The "Layout on this device" setting (web edition) now matches the others.**
  Its Auto / Mobile / Desktop options were showing as a cramped, unstyled stack —
  their CSS classes had never been defined — so they now use the same tidy column
  styling as every other radio setting.

- **Toolbar tooltips are reliable in the desktop app now.** On the Mac desktop
  build the ribbon tooltips were erratic — slow, flickery, or simply not appearing
  — because they relied on the operating system's native tooltip, which Electron
  renders unreliably on macOS (the web build, in a real browser, was always fine).
  They're now drawn by CardMirror itself, so they behave identically and show up
  reliably on both desktop and web. The same fix covers the other hover tooltips
  that had the problem — find & replace, the comments panel, the dropzone, the
  command-bar controls, and the speech-document buttons.

## 0.1.0-beta.1 — 2026-06-24

### Changed

- **Right-click a file in search to dive into it.** In the Search Everything
  palette's file search (the `f` prefix), right-clicking a file now dives
  into it to search its contents — the same as pressing **Tab** — instead of
  pinning it. Pinning still has its own ★ star (and **Alt-P**), so the
  right-click is free for the more useful action.

- **Clod customization is a normal setting now.** The Clod persona editor — its
  name and pronouns, your own activity phrases per time of day, and when those
  time periods begin — used to be hidden behind a secret modifier-click on the
  **Enable Clod mode** toggle. It's now a visible **Customize…** button right
  below that toggle in Settings → Comments & AI.

- **Analytics and undertags get their own categories in Find.** In the
  categorized results list they used to lump in with body text under "Other";
  now they're their own **Analytic** and **Undertag** groups — colored to match
  the editor — ordered right after Tags (analytics, then undertags, then cites).
  Reorder them like the other categories under Settings → Find.

### Fixed

- **Escape leaves a dived-into file even when the search box isn't focused.**
  In the Search Everything palette, after diving into a file, pressing **Esc**
  while scrolling the results (with the box unfocused) now steps back to the
  file list instead of doing nothing — and re-focuses the search box on the
  way back.

- **Bottom pills no longer cover your text in three-pane mode.** In single-pane,
  CardMirror leaves a little space at the end of the document so the dropzone /
  send / receive pills don't sit over the last lines when you scroll to the
  bottom. Three-pane mode never did — the leftmost pane (the one the pills sit
  over) now gets the same runway, while the other panes stay flush.

- **Highlighting no longer turns an underlined gap into emphasis.** When two
  emphasized words are joined by an underlined space (the read-aloud marker),
  highlighting either word used to rewrite that underline to emphasis. Highlight,
  shading, and font-size changes now leave underline / emphasis / cite alone —
  they only tidy their own formatting.

- **Hyphens are no longer swept into formatting gaps.** When you underline,
  emphasize, or cite two words joined by a hyphen (e.g. `well-known`), the hyphen
  between them is now left as-is instead of being pulled into the formatting —
  matching how em-dashes, en-dashes, `=`, and `+` already behave.

- **Docs whose tags are plain "Normal" text now import with their structure.**
  Some Word docs mark tags and headings only with an *outline level* (Word's
  h1–h4), not a heading style — so CardMirror imported them as flat body text and
  the tags didn't show up. The importer now recognizes a Normal paragraph that
  carries an outline level plus the matching heading formatting (e.g. a 13pt-bold
  paragraph at outline level 4 → Tag), mirroring what the style cleaner already
  does. The bold / size / underline checks gate it, so an ordinary non-debate doc
  that merely uses outline levels is unaffected.

- **Find stays fast on large documents with many matches.** Stepping between
  results — next/previous, or clicking a result — used to rebuild every
  highlight, the whole results list, and all the nav-pane markers on each step,
  which crawled once a search had thousands of hits. Now only the active match
  moves per step, so navigation stays quick no matter the match count. Find also
  caps at 10,000 matches (shown as `10000+`) and 500 listed rows ("Showing first
  500 of … — refine to narrow"), and rapid jumps no longer pile up scrolling
  work — so a pathological search can't choke the editor.

- **The command bar's first search is ready sooner after launch.** The search
  palette pre-warms its file index in the background, but that warm only kicked
  off once the app first went idle (up to ~2s after launch) — so opening the bar
  right after launching beat it and the first search hit a cold scan. The
  file-list scan (which runs in the background process) now starts the moment the
  app boots, while the heavier content pre-parse stays deferred so it still never
  janks the launch.

## 0.1.0-alpha.20 — 2026-06-23

### Added

- **Benchmark — measure how fast CardMirror runs on your machine.** A new button
  in Settings → General runs a battery of real in-editor operations on the open
  document — continuous scrolling, jumping between headings, and a full
  card-cutting sequence (type and mark a cite, paste a messy multi-paragraph
  card, condense it clean, then underline / emphasis / highlight and shrink) —
  while sampling frame rate, frame-time percentiles (including a 1%-low that
  captures stutter), and per-operation latency. It shows a scrollable readout
  with a scroll-frame-time graph, footnoted metrics, and an overall score. The
  whole run happens on a snapshot of your document and is fully reverted when you
  close the results, so it never touches your file — and it only runs when the
  document is editable (not in read mode).

- **Keyboard shortcuts to drop in a received card.** Two new rebindable shortcuts
  insert the most-recently-received card (from the **Receive** pill) without
  reaching for the mouse: **Mod-P** places it at the cursor, and **Mod-Alt-P**
  appends it at the end of the document. The card stays in the Receive pill, so
  you can place it again. Rebind them under Settings → Keyboard shortcuts, in the
  **Dropzone / Send and Receive Cards** group.

- **Star a recipient and send to them in one keystroke.** In Settings → Card
  Sharing you can now **star** one recipient or group. A new **Send to Starred**
  command then sends the card under your cursor (or the current selection)
  straight to that starred target — like Send to Dropzone, but to a person. It
  ships without a default key; assign one under Settings → Keyboard shortcuts (in
  the **Dropzone / Send and Receive Cards** group). Starring a target un-stars any
  other, and the star clears itself if you remove that recipient or group.

- **Type "question" to find Ask AI.** The command bar now surfaces **Ask AI About
  Selection** when you search for "question".

- **Clean can save over your originals (with a typed confirmation).** Clean used
  to always write `cleaned_…` copies. A new **"Prepend 'cleaned_' to output
  filenames"** toggle (on by default) lets you turn that off and save with the
  original filenames instead — and when the destination is the originals' own
  folder, that overwrites them in place. Because that's destructive and can't be
  undone, hitting Clean in that mode first pops a warning you must confirm by
  typing "I accept the risk". Prepending, or saving to a different folder, never
  touches your originals and skips the warning.

- **A User Manual link in Settings.** Settings → General now has a link to the
  user manual at the bottom, so it's easy to find (and stays reachable on Windows
  and Linux, where the native menu bar — which used to hold the link — is gone).

### Fixed

- **Alt-key shortcuts work on Windows and Linux.** The native menu bar reserved
  `Alt`+letter for its menus, so an editor command bound to a bare `Alt` chord
  (for example `Alt+A`) did nothing — the menu swallowed it before the editor saw
  it. CardMirror no longer shows a native menu bar on Windows and Linux (every
  menu command's keyboard shortcut still works, and the menu's actions are
  reachable from the app's own UI), so `Alt`-key shortcuts — including ones you
  rebind yourself — now work like the rest. macOS keeps its menu bar.

- **Clean handles a whole messy library without choking.** Cleaning a large
  folder no longer trips over Word lock files (`~$…`), macOS `._…` sidecars, or
  `__MACOSX` folders — those aren't real documents, so they're skipped — nor over
  certain docs that previously errored with an internal "no style named
  Heading…" message. Genuinely corrupt or empty files (e.g. cloud "conflicted
  copy" duplicates) are now reported as **skipped (not a valid .docx)** rather
  than counted as failures, so the summary reflects what actually happened.

- **Paragraph-spacing boxes match the other Appearance number fields.** Their
  inputs were using the browser-default border with left-aligned numbers; they
  now use the same border and right-aligned layout as every other number box in
  settings.

- **Deleting your last note or flashcard clears its anchor highlight.** Deleting
  the last private note, flashcard, or AI thread in a document used to leave the
  blue highlight marking where it was anchored painted on the text until you
  toggled the comments pane off. It now disappears immediately with the
  annotation, like it already did when other annotations remained.

- **Create-flashcard dialog buttons are now a matched pair.** The Cancel button
  in the "create flashcard from selection" dialog was noticeably smaller than
  Create; it now matches the manage screen's New card / Import / Export buttons,
  so the two sit the same size side by side.

- **Send and Receive pills match the dropzone.** The card-sharing **Send** and
  **Receive** pills were a solid gray that stood out next to the dropzone pill;
  they now share the dropzone bar's softer color scheme, so the three read as one
  family.

## 0.1.0-alpha.19 — 2026-06-22

### Added

- **Clean — a .docx style cleaner that cures "stylepox."** A new Home-screen
  utility (desktop) that fixes the junk-style buildup debate files accumulate
  from copy-pasting cards: it removes the redundant/malformed styles bloating the
  file, converts stray direct formatting (manual bold/underline/highlight) back
  into the right styles, restores Verbatim's style names and aliases so macros
  work, and strips hyperlinks. Run it on a single file or a whole folder; leave
  the destination blank to write each `cleaned_…` copy next to its original. A
  progress bar tracks each file, and a gear lets you mark **protected styles**
  Clean must never touch (by name; add them manually or pick from a template
  `.docx`). It's the same idea as the
  ["Curing Stylepox"](https://debate-decoded.ghost.io/leveling-up-your-debate-software-3-curing-stylepox/)
  cleaner, but it runs inside CardMirror, so it's **much faster** (seconds, not
  the overnight runs the worst files used to need) and has **far better handling
  of old files** — it rebuilds the common pre-Verbatim style conventions
  (Tags/Cards/Cites/Block Headings, Author-Date, Debate Underline, …) into the
  modern Verbatim structure, adds the standard styles when a document is missing
  them, and repairs `!!`-marked style names that trip up older cleaners. Coverage
  is broad but not universal — unusual or one-off style schemes may still not be
  fully handled.

- **Many old debate files open with their structure intact.** Opening a
  pre-Verbatim `.docx` that uses the common Tags/Cards/Cites/Block Headings style
  family now reconstructs cards, tags, cites, and headings instead of importing
  it as flat, unstyled text. (Coverage is broad but not universal — unusual or
  one-off style schemes may still come in as plain text.)

### Changed

- **File search can use multiple folders.** Settings → General's "File search
  folder" is now "File search folders" — add as many as you like. Each is
  scanned recursively; overlapping or nested folders are fine, since a file
  found under more than one is searched only once. Your existing folder is
  carried over automatically.

- **Read mode allows safe drag edits.** While reading, you can now drag cards to
  reorder them and drag into / out of the dropzone and the send/receive pills —
  moves the drag handles already validate — while ordinary typing edits stay
  locked to prevent accidents. Clicking a dropzone or received-card item in read
  mode appends it to the **bottom** of the document instead of at the cursor.

- **Card sharing works across CardMirror versions.** Sending a card to a machine
  on a different version no longer fails with a version-mismatch warning —
  cross-version transfers are now accepted by default. (A card can still carry a
  minimum-version requirement, so a future release that changes the card format
  could ask older versions to update first, but by default sharing just works.
  Both machines need this version or newer to get the tolerant behavior.)

### Fixed

- **Windows/Linux: the editor could lock up after a pop-up.** Pressing `` ` `` to
  send to the speech document when none is open — and a few similar cases (e.g.
  image-insert errors) — showed a warning that took keyboard focus; on
  Windows/Linux that focus wasn't returned, so the editor wouldn't accept edits
  until you clicked back into it. Focus is now reclaimed automatically. macOS was
  unaffected.

- **Drag auto-scroll works in more places.** Dragging a card toward the top or
  bottom edge now scrolls the pane under the pointer — including when dragging
  between panes or from the nav panel into the editor — and correctly scrolls
  past a pane's sticky nav header. It also no longer scrolls the document out
  from under you when you drag toward the bottom-left dropzone/send/receive
  pills.

- **More citations survive import.** Files whose cite style is stored under the
  legacy `Cite` name (rather than the modern `Style13ptBold`) now import as
  citations instead of plain text.

## 0.1.0-alpha.18 — 2026-06-21

### Added

- **Cross-machine card sharing (end-to-end encrypted).** Two new pills sit next
  to the dropzone — **Send** and **Receive**. Drag a card onto Send and it
  expands to the machines you've added (plus any groups); drop on one to send it
  there. Cards others send you land in **Receive**, which shows who they're from
  and when, flashes on arrival, and tracks an unread count. Set it up in
  **Settings → Card Sharing**: turn it on, share your code, add recipients by
  their code (name them however you like), and optionally group several
  recipients for one-drop sends. Everything is end-to-end encrypted — the relay
  server only ever sees opaque ciphertext, never your cards, who sent them, or to
  whom — and cards are deleted from the server after 3 hours. Desktop only.

## 0.1.0-alpha.17 — 2026-06-20

### Added

- **Repair Paragraph Integrity workflow.** A focused way to re-introduce
  paragraph breaks into a card whose body collapsed into one run. Run it with
  your cursor in a card (or the card selected) and a small bar opens, with a
  green box around the card it's operating on. Type a phrase that should begin a
  paragraph; every occurrence in the card's body is highlighted in green. When
  exactly one match remains, the bar flashes green with a check — press Enter to
  insert a paragraph break right before that phrase and clear the box for the
  next one. **Ctrl-Enter** does the same but also marks that paragraph to be
  indented (shown with a green bar in the left margin); the indent is applied when
  you exit, to whatever that paragraph has become by then — so further splits
  inside it don't drag the indent across the rest of the card. Esc applies any
  pending indents and exits. The command (*Repair Paragraph Integrity*) ships
  unbound; assign a shortcut in Settings → Keybindings.

### Fixed

- **Find and the paragraph-repair search now match straight and curly quotes
  interchangeably.** Typing a straight `'` or `"` matches Word's smart quotes
  (`‘ ’ “ ”`) in the document, and vice versa — so searching `court's` finds
  `court’s` and `"clear"` finds `“clear”`.

- **Highlighting emphasized text no longer breaks the emphasis at the edges.**
  Toggling highlight (or shading, or a font-size change) over a run of
  emphasized text left underlined gaps where the highlighted span met its
  emphasized neighbors. Filling an emphasized gap with underline is now
  reserved for when you actually apply emphasis or underline; unrelated
  formatting leaves the emphasis intact.

- **Re-emphasizing part of an already-emphasized phrase no longer breaks it.**
  Pressing Emphasis on a word (or words) inside a continuously-emphasized run
  used to underline the gaps at the edges of what you selected. Emphasis now
  fills a gap with underline only where it joins two *separately*-emphasized
  words; a gap that's already emphasized stays emphasized, so a continuous
  phrase stays continuous.

- **Selecting trailing/leading punctuation now formats it.** If you select a
  word together with an adjacent punctuation mark — e.g. `government.` with the
  period, or `(government` with the paren — and apply a style, the punctuation
  now takes the style instead of being treated as part of the gap and left
  unformatted. Spaces still behave as before: selecting `government. ` with the
  trailing space underlines the period but not the space. Punctuation you didn't
  select still bridges normally between two formatted words.

- **Pasting a card, analytic, or heading into a card keeps its structure.**
  Pasting content that leads with a tag, analytic, or a Pocket/Hat/Block heading
  into a card — including dropping a whole copied card at the end of another —
  used to demote the heading into ordinary body text and absorb the content into
  the destination card. Now the pasted structure wins: the destination card
  splits at the cursor and the pasted card/analytic/heading lands intact, with
  its full content, as its own structural block.

### Changed

- **"Fix" and "repair" now match each other in the command bar.** Commands
  whose names contain one of those words — *Repair OCR/PDF Text*, *Repair
  Formatting (AI)*, *Fix Formatting Gaps* — are reachable by searching for
  either word. Typing "fix" surfaces the Repair commands, and "repair"
  surfaces Fix Formatting Gaps.

## 0.1.0-alpha.16 — 2026-06-17

### Added

- **The command bar's file search now finds `.docx` files too.** Searching
  files (the `f ` prefix, or the everything-search) lists both `.cmir` and
  `.docx` documents. Each result's badge shows its format — `CMIR` or `DOCX` —
  and the file name is shown without its extension. `.docx` and `.cmir` behave
  identically: press Enter to open either, or Tab to dive into either and
  search its contents (blocks, tags, cites) and insert from it. A new
  **Settings → General → File search: file formats to list** option restricts
  results to just `.cmir`, just `.docx`, or both (the default).

### Changed

- **Edge gaps between separately-emphasized words now fill with underline.**
  When you emphasize text, the whitespace and punctuation inside your selection
  stay emphasized along with the words — selecting a phrase and emphasizing it
  behaves as you'd expect. Only at the edges, where your emphasized selection
  butts up against an already-emphasized neighbor word, the connecting gap is
  joined with plain underline instead of emphasis. Emphasis already shows as an
  underline, so the join stays visually seamless while the extra emphasis
  styling stays on the words themselves.

- **Smarter recognition of analytics on import.** Files made from other
  templates often label their analytics with a style that isn't the one
  CardMirror writes, so those lines used to come in as plain body text. Import
  now also recognizes them: a style named (or whose id is) "Analytic Real"
  comes in as an analytic, and any paragraph style whose name or id contains
  the word "analytic" is treated as an analytic too.

### Fixed

- **Formatting punctuation directly is now honored.** When you select only
  whitespace and apply a style, the gap cleanup leaves it alone — it assumes
  you meant it. That now also holds for punctuation and for punctuation-plus-
  space selections: if what you selected has no actual word in it, the style
  you apply to it stays put instead of being cleaned away.

- **The outline pane is now resizable in multi-pane mode.** Dragging the
  outline's right edge to set its width already worked with a single document
  open; with two or three documents open side by side the drag handle was
  missing. The shared rail on the left now has its own drag handle, and the
  width it sets is the same one single-pane mode uses, so it carries over
  between the two layouts.

## 0.1.0-alpha.15 — 2026-06-17

### Added

- **Bulk re-apply and replace of structural styles across a "select all of this
  style" selection.** Right-click a structural ribbon button (Tag, Analytic,
  Undertag, or a Pocket/Hat/Block heading) to select every block of that style,
  then left-click a structural button to act on all of them at once:
  - the **same** button scrubs stray direct font sizes off every selected
    block — the quick way to clean up odd sizes that ride in from imported
    `.docx` files (right-click the style, left-click to re-apply);
  - a **different** structural button converts them all — e.g. turn every tag
    into an analytic, or every pocket into a hat. Tag↔analytic conversions keep
    the card/analytic structure and its cites/bodies intact; heading swaps keep
    their ids.

- **Visible paragraph-break cue in selections.** When a selection reaches to
  the very start of the next paragraph — for example after Ctrl-Shift-Down, or
  Shift-Down past the end of a line — a highlighted `¶` now appears at the end
  of the line you're on, showing that the paragraph break itself is part of the
  selection. This makes it clear up front that deleting or typing over the
  selection would merge the two paragraphs, instead of that happening as a
  surprise.

### Fixed

- **Formatting now keeps the spaces between words consistent automatically.**
  Applying or removing underline, highlight, emphasis, cite, shading, or a font
  size now fixes the gaps around what you changed, so a space carries a style
  only when the words on both sides of it do. Two everyday wins: underlining a
  word that sits between two already-underlined words now joins up into one
  continuous underline instead of leaving broken spaces; and turning a style
  off no longer strands it on the spaces next to the word (it used to leave the
  space before and after still underlined or highlighted, dangling between the
  now-plain word and its styled neighbor). Applying any one of these tidies the
  spacing of all the formatting around the edit at once, so it stays consistent.
  It only runs around what you just changed — not the rest of the document — and
  if you deliberately format just a space, that's left as you set it.

- **Cursor no longer jumps to the next paragraph after deleting a selection
  that can't merge.** When a selection includes the paragraph break after it
  but the two paragraphs can't actually join — for example a card's tag and the
  card below it — deleting it (Backspace, Delete, or voice delete) used to leave
  the cursor at the start of the next paragraph. The cursor now stays in the
  paragraph you were editing. The same fix applies to AI Format Cite, which no
  longer leaves the cursor in the following paragraph.

- **Changing the font size of cite / underlined / emphasized text now actually
  resizes the letters.** Increasing or decreasing the size on text in one of
  these styles used to grow the line height and selection highlight but leave
  the glyphs at the style's display size. An explicit per-run size now wins over
  the style's display size (matching the size shown in the toolbar, and Word's
  behavior where a directly-applied size overrides the character style). Text
  with no explicit size still renders at the configured per-style display size.

## 0.1.0-alpha.14 — 2026-06-13

### Changed

- **`.cmir` files are now compressed — about 10× smaller.** CardMirror saves
  its native files gzip-compressed, so a typical card file drops to roughly a
  tenth of its size, with no real change to how fast files open (decompression
  is a tiny fraction of the work opening a file already does). Older
  uncompressed files keep opening normally; they shrink the next time you save
  them.

### Added

- **Bulk compress (Home screen, desktop).** A migration tool that rewrites
  every `.cmir` in a folder and its subfolders in compressed form, in place —
  for shrinking an existing library without re-saving each file by hand. Files
  already compressed are skipped, each file is verified before it's replaced,
  and its modified date is preserved (so your "recent files" ordering is
  untouched). A transitional tool — it'll be retired once libraries have
  migrated.

- **Un-bold words in tags.** Tags (and other headings) are bold by default,
  and you can now turn bold *off* for individual words — select them in a tag
  and press Mod-B (or click Bold). Imported .docx files that have un-bolded
  words in tags now display that correctly, instead of showing everything bold.

- **Lock Highlighting (Card menu → Highlighting).** Converts highlighting to a
  light-gray background in one pass, freeing the highlight layer so you can
  re-highlight. With no selection it locks the whole card the cursor is in;
  with a selection it locks just the selection. (No card under the cursor and
  no selection → nothing happens; it won't lock a whole pocket/hat/block.)
  Unlike Create Reference it works in place, adds no "FOR REFERENCE" heading,
  and never grays the text — the card stays fully editable. Any background you'd
  already applied is left alone. No default shortcut; rebindable, and findable
  in the command bar.

### Fixed

- **macOS voice: capture the microphone correctly.** Voice mode could connect
  to a mic but receive no audio on macOS. The main cause was that the packaged
  app lacked the microphone entitlement and usage permission, so macOS handed
  back a *silent* track even though the mic appeared connected — the app now
  ships the microphone entitlement, declares why it needs the mic, and asks
  macOS for access on first use. Two supporting fixes to the audio path: the
  audio engine is resumed after it starts (it could come up paused), and the
  mic is recorded at its own sample rate and converted to 16 kHz in-app
  instead of forcing a 16 kHz engine.

- **Spell check no longer flags a word whose styling changes mid-word.** When
  part of a word was underlined, highlighted, or otherwise styled differently
  from the rest (e.g. an underline ending partway through), the checker saw it
  as two separate fragments and red-underlined the pieces; it now checks the
  whole word.

## 0.1.0-alpha.13 — 2026-06-12

### Added

- **AI edits no longer collide.** Each AI action (cite creation, text and
  formatting repair, image alt-text and table extraction, and others) now
  reserves the part of the document it's working on for the duration of the
  request. Edits anywhere else — another AI action, or your own typing —
  shift its target along instead of landing the result in the wrong place.
  While an AI action is working on a stretch of text, edits to *that* stretch
  are held and the locked region flashes if you try; the rest of the document
  stays fully editable. Two AI actions on the same text won't run at once —
  the second asks you to try again in a moment. Each running action keeps its
  own purple region box and "Thinking…" pill; when their targets scroll off
  the top or bottom of the editor, the pills line up in a queue along that
  edge instead of stacking on one spot, and advance as each action finishes.

- **Paragraph spacing controls.** Settings → Appearance → Paragraph spacing
  (just under Line spacing) sets the blank space *before* and *after* each
  paragraph type — Body, Cites, Tags, Analytics, Pockets, Hats, Blocks, and
  Undertags — in points, per style, with a reset-to-defaults button. (Line
  spacing is the gap between lines; this is the gap between paragraphs.)

- **"Manage Quick Cards" is now a command.** It's searchable in the command
  bar and rebindable under Settings → Keyboard shortcuts, like the other
  Quick Cards actions.

### Changed

- **The welcome document matches your device.** On the mobile view, the
  onboarding starter now explains the touch interface (the ☰ outline, the
  Read / Move / Repair mode bar) instead of the desktop ribbon and keyboard
  shortcuts.

- **Appearance settings: Body font and Line spacing sit under Style
  typography.** Grouped with the other type controls instead of further
  down the tab.

- **"Show dropzone shelf" moved to the Editing tab** (just above
  Translation), where it sits more naturally than under Appearance.

- **Re-applying a structural style clears that paragraph's manual font
  size.** Pressing the tag, analytic, pocket, hat, or block shortcut on a
  paragraph that's already that type now strips any direct font-size
  overrides, resetting it to the style's size — the same gesture already
  cleared manual indentation.

### Fixed

- **Applying a structural style to a downward selection no longer restyles
  the paragraph below.** Selecting a paragraph with Ctrl-Shift-Down — which
  lands the selection boundary at the very start of the next paragraph — and
  then applying a tag, analytic, or heading style used to convert that next
  paragraph too; it now styles only the paragraph you selected.

- **Line spacing reset now updates the boxes too.** Pressing the line-
  spacing reset restored the actual spacing but left the old numbers in the
  input fields; the fields now refresh to the defaults.

- **Mobile: the outline drawer slides out on top of the mode panels.**
  Opening the outline while the Repair (or Move) panel was up left the
  panel covering the drawer; the drawer now sits above it.

- **Voice control now starts on macOS.** The packaged Mac build bundles an
  older libvosk that lacks the dynamic-grammar function, so starting voice
  failed with "cannot find function 'vosk_recognizer_set_grm'". Voice now
  runs on macOS; live document vocabulary still updates (it rebuilds the
  recognizer when needed).

- **Voice falls back to your default microphone.** If the previously
  selected microphone isn't available on this machine — a device chosen on
  another computer, or one that's been unplugged — voice now uses the
  system default instead of failing with "microphone unavailable / device
  not found."

- **Change Case no longer drops the last letter of some text.** On a
  selection containing a character whose uppercase form is longer than one
  letter (German ß → SS), cycling case ate the final character; it now
  preserves the whole text.

- **Condensing into a heading keeps it tracked in the navigation pane.**
  When a condense that began inside a tag or analytic produced the merged
  heading, that heading came out without a stable id — so until you next
  saved and reopened the file, the nav pane couldn't follow the cursor into
  it (the highlight stuck to the heading above) and you couldn't select or
  collapse it from the pane. The merged heading now keeps the first
  source's id.

- **Find-match highlighting isn't re-rendered on every cursor move.** With
  the find bar open over a large match count, moving the cursor or stepping
  between matches no longer re-allocates the entire highlight overlay.

- **Uncondensing no longer crashes when a ¶ marker is inside a heading.**
  A pilcrow that ended up in a tag (e.g. from a merge) made Uncondense
  throw; it now removes the marker without trying an invalid split.

- **Comments stay readable in Word.** Editor-created comment ids could
  exceed Word's numeric limit (they were seeded from the clock); they're
  now small integers, allocated past any ids already in the document.

- **Possessives are no longer flagged as misspellings.** Words ending in
  an apostrophe ("dogs'", "James'") are checked on their base form.

- **The floating format panel honors your settings.** Its buttons used
  default settings (e.g. the wrong highlight color) instead of your current
  ones.

- **Dragging a card out of the navigation pane auto-scrolls the document.**
  Dragging toward the top or bottom edge now scrolls the doc into view; it
  was scrolling the wrong element and doing nothing.

- **The navigation and spellcheck right-click menus no longer stay open at
  once.** Opening one closes the other.

- **Saving keeps your file's other custom document properties.** Stamping
  the document id (used by the study/Learn layer) used to overwrite the
  file's other custom properties; it now merges, leaving them intact.

- **Tabs and line breaks export correctly to Word.** They were written as
  raw characters Word ignored; they now export as proper tab/break
  elements. (A page break still comes back as a line break — the break
  type isn't tracked yet.)

- **Escape closes one dialog at a time.** With two dialogs stacked (e.g.
  editing a card from the Quick Cards or flashcard manager, or opening the
  AI cite-prompt editor from Settings), Escape used to close both at once;
  it now closes only the topmost.

- **The AI cite-prompt editor's instructions are up to date.** They told you
  the model must return JSON; it actually replies in a delimited block
  format. The note now describes the real format the editor parses (and
  still warns against changing it).

- **Undoing a deletion restores its comments too.** Deleting commented text
  and then undoing used to bring the text back but leave the comment gone;
  the comment now comes back with it.

- **Condensing no longer destroys a table caught in the selection.** A
  demolish-mode condense over a range containing a table used to flatten
  the table into loose paragraphs; it now leaves the document untouched so
  the table survives.

- **Content controls no longer drop their contents on import.** Text inside
  a Word content control (a "structured document tag") was skipped; it now
  imports normally.

## 0.1.0-alpha.12 — 2026-06-12

### Added

- **Faster Verbatim Flow, with a warm connection you can control (Windows
  only).** CardMirror now keeps a single background connection to Excel
  alive instead of starting a new one for every action — so every Send or
  Pull after the first is near-instant instead of pausing a second or
  more. It starts on its own the first time you use a Flow command and
  stays ready; you can also start it up front with the new **Start Flow
  Connection** command, or turn on **"Keep a Verbatim Flow connection
  warm"** in Settings to have it ready the moment CardMirror launches.

- **The Help menu links to the user manual.** Help → User Manual opens
  the full manual.

- **Mobile settings can customize style typography.** The mobile settings
  page now offers the same per-style typography toggles as the desktop —
  cite underline, undertag and emphasis bold/italic, the emphasis box and
  its thickness — not just the per-style font sizes.

### Changed

- **The voice-control shortcut is now rebindable.** Turning voice mode on
  and off (default Ctrl-Shift-V) is a regular command now — searchable in
  the command bar and rebindable under Settings → Keyboard shortcuts.

- **Verbatim Flow commands appear only on Windows.** The integration is
  Windows-only, so its commands no longer show in the command bar, the
  keyboard-shortcuts editor, or the shortcuts reference on macOS and
  Linux.

- **Send Headings to Flow sends only the cite-marked text.** A cite line
  now contributes just its marked citation — the same text the nav pane's
  cite preview shows — instead of the whole bibliographic paragraph.

### Fixed

- **Voice control now starts in the packaged desktop app.** In the
  previous release the recognizer failed to launch on Windows, Linux,
  and macOS, so a voice session ended the instant it began. On macOS
  this currently works on Apple Silicon; Intel Mac support is still
  pending.

- **Canceling the Flow overwrite prompt no longer locks up the keyboard.**
  Dismissing the "there's already text where you're sending" confirmation
  with Cancel used to leave the editor unable to accept keystrokes until
  you clicked it; it now keeps focus.

- **The "AI is working" pill now appears next to an image being edited.**
  When generating alt text or a table from an image, the progress pill
  jumped to the editor's top-left corner instead of sitting by the image.
  It now anchors to the image like the other AI cues, pinning to the
  corner only when the image scrolls out of view.

- **Mobile settings: editors with a long description lay out better.** The
  reader time-estimate editor (and the other per-style editors) now stack
  their controls below the description instead of squeezing them into a
  narrow side column, so the text no longer piles up on a phone screen.

## 0.1.0-alpha.11 — 2026-06-11

### Added

- **A steady (non-blinking) text cursor.** A new accessibility setting
  (Settings → Accessibility → "Steady text cursor") stops the document's
  text cursor from blinking — the caret stays solid in the usual cursor
  color while you type, instead of flashing on and off. Off by default.

- **Send to Verbatim Flow (experimental, Windows only).** A set of
  commands connects CardMirror to Verbatim Flow — the Excel flowing
  template — exactly the way the Verbatim Word add-in does, with no
  changes needed to Flow itself. These are command-palette and
  keyboard-shortcut commands only — they are **not** buttons on the
  ribbon and take up no ribbon space. Find them by searching the command
  bar, or bind your own shortcuts in Settings → Keybindings (none are
  bound by default). With Excel open and a workbook whose name contains
  "Flow": "Send to Flow" drops your selected tags, cites, and text into
  the flow's current column (one cell per line, or all in a single
  cell); "Send Headings to Flow" leaves out card bodies; "Pull from
  Flow" reads the cells you've selected in Excel back into your document;
  and "Create New Flow" opens a fresh flow from the Verbatim template. It
  works only on Windows (it drives Excel over COM); on other platforms
  the commands report that and do nothing. Experimental — expect rough
  edges.

- **A mobile layout for the web edition.** Opening
  CardMirror in a phone or tablet browser — or any browser window
  narrower than 768px (touch screens up to 1024px) — now gets a
  view-first layout built for small screens: a slim top bar (outline
  drawer, undo/redo, display options, menu), the document full-bleed
  below it, and a Read button that turns on read mode — where a tap
  on the text drops or removes a reading marker, so you can read a
  speech doc straight off the phone. Pinch zooms the document (the
  chrome stays put; a Reset button in the display sheet returns to
  100%), the outline slides in from the left edge with entries
  wrapping up to three lines (tablets pin it as a sidebar the ☰
  button collapses and restores),
  and the menu covers Open, Export a copy, word count, and Home —
  which on mobile shows documents only, no Quick Cards or flashcard
  sections. A Settings page sized for touch carries the relevant
  settings — appearance, text sizes, readers, AI key — and "Use
  desktop layout" (or the new "Layout on this device" setting)
  switches back to the full UI any time. Crash-recovery offers
  don't pop up in the mobile layout — unsaved drafts wait for your
  next desktop-layout visit. Editing stays desktop-only:
  the mobile view never opens the on-screen keyboard, and there is no
  drag-from-the-document or dropzone on mobile — on touch, a drag is
  indistinguishable from a scroll. Rearranging is its own mode
  instead: tap **Move**, tap any card or heading to pick it up
  (dashed outline), and an action strip offers one-step **Up** /
  **Down** (sections hop whole sibling sections; cards step over
  neighbors and in/out of sections), **Send to…**, **Copy**, and
  **Delete** — every move is one undo step. Send to… picks the
  destination straight from the outline: tap a row and choose
  **Place above** or **Place below** — the moved section always
  lands beside the destination, never inside it. In the outline
  itself, press and hold a row for a moment to pick it up and drag
  it (a plain swipe still scrolls). The AI repairs work from the
  phone too: tap **Repair**, tap a card to set the scope (repairs
  run one card at a time), and run Repair Text or Repair Formatting
  on its body text (tags and cites stay out of scope), or **Repair Cite** to re-run the AI
  cite formatter on the tapped card's citation (or, for a card with
  no cite paragraph yet, on the first body paragraph under the tag) — with the same
  thinking/Clod progress indicator, fixes, flashes, and single undo
  step as on desktop (and a pointer to Settings if no API key is set
  up on the device; the Clod toggle is in mobile Settings too).


- **Smart Shrink.** Press **Mod-Alt-8** to shrink a card's connective
  text in one step, with per-paragraph depth: paragraphs containing no
  underlining or emphasis at all — the long fully-unread stretches —
  go straight to 5pt, while paragraphs that do carry those marks
  shrink their connective text to the standard 8pt. No cycling:
  running it again changes nothing. Underlined and emphasized text is
  never touched, and the same protections as regular Shrink apply
  (omission markers, integrity warnings, custom rules). Regular Shrink
  (Mod-8) and Regrow (Mod-Shift-8) work on the result as usual.

- **Repair Formatting (AI).** Select body text and press **Mod-Alt-R**
  to normalize it to Verbatim's four-layer scheme — underline as the
  broad pass, emphasis to make some of it stand out, highlighting for
  what's read aloud, shading to set off some of the highlighting. It
  repairs the classic breakdowns of imported cards: bold or italics
  standing in for emphasis, direct underlining instead of the named
  style, bold-underline used for ALL the underlining (no emphasis pass
  — converted to plain underline, not emphasis), and cards whose
  underlining was destroyed by an unsupported style, recoverable only
  from font size (full-size text was the underlined text). Bold and
  italics survive when they're a deliberate extra layer alongside real
  emphasis or reproduce the source's own formatting (book titles,
  foreign terms). The model never touches your text — it only returns
  a mapping from each formatting pattern found to what that pattern
  should be (plus targeted overrides for idiosyncratic fragments), and
  the editor applies it. Works one card at a time, only on body
  paragraphs (never tags, cites, or headings), highlight and shading
  colors preserved, font sizes untouched, one undo step. Requires AI
  features.

- **Voice control (experimental, desktop only).** Press **Ctrl-Shift-V** to start a
  hands-free editing session — recognition runs entirely on your machine
  (no network, ever). Speak commands like `pen highlight` · `take <words
  you can see>` · `mark` · `next card` · `condense` · `go back`, dictate
  with `start typing` … `stop typing` (your words stream in as gray
  preview text while you talk), or enter **paint mode** (`paint`) where
  the words you read aloud are inked with the active pen — the
  voice-native version of working a card. A status pill shows the
  listening state, active pen, what was heard, and your mic level; `voice
  sleep` / `voice wake` park the mic when someone walks up. Every voice
  action is one undo step, and voice undo (`scratch that`) and Ctrl-Z
  always agree. Dictation supports spoken punctuation ("period", "comma",
  "question mark", quotes), a configurable dash word, `literal <words>` for
  dictating command words, and automatic sentence capitalization. The
  session auto-sleeps after sitting idle (configurable; the pill dims as a
  warning), and clicking the pill opens a microphone picker. Voice options
  live under Settings → Accessibility — including an optional large
  dictation model (one-time 1.8 GB download) that roughly halves
  general-English dictation errors. Targeting composes Cursorless-style:
  ordinals count within their natural container (`take second sentence`,
  `go to third card` — third in this block), `mark every tag` inks every
  tag in the block with one undo step, `take head card` / `take tail
  paragraph` select to a scope's edge, and `take from <words> to <words>`
  spans two spoken anchors. When the words you spoke appear more than once
  on screen, numbered badges appear over each match — say `pick two` to
  choose. Speech models ship with the app (installers grow by roughly
  130 MB).

### Changed

- **A revamped "AI is working" indicator.** While an AI action runs —
  formatting a cite, repairing OCR/PDF text or formatting, generating
  image alt text — CardMirror now boxes the exact part of the document
  it's working on in purple and floats a "Thinking…" label at the
  editor's left edge, so you can tell what's happening even after your
  selection clears and even when that spot has scrolled out of view (the
  label pins to the top or bottom edge then). The box hugs just the text
  you selected for selection-based actions like Format Cite.

- **Repair Text applies each pass in one step.** Corrections used to
  land one at a time in an animated walk; they now apply all at once
  with a single orange flash over every replacement, matching Repair
  Formatting. The two passes read as two blinks. Still one undo step.

### Fixed

- **Picking up a card on macOS no longer selects a word.** Holding the
  drag-from-document chord and clicking used to trigger macOS
  word-selection (Option+Shift+click) instead of grabbing the card;
  clicks held under the pickup chord are now fully absorbed.

- **Open can no longer deadlock in the web edition.** If a file
  picker ever closed without delivering a result (some browsers
  don't report a cancelled dialog, and a request made without a
  fresh user gesture can be silently ignored), every later Open —
  shortcut, menu, and home screen alike — waited forever behind it.
  A new Open attempt now supersedes a stuck one instead of queueing
  behind it.

- **Switching between the three-pane workspace and one-window-per-
  document mode now restores exactly the documents you had open.**
  This glitch primarily affected Mac users. Both directions were
  broken: switching out of three-pane closed every pane and
  reopened nothing, and switching into it brought back documents
  from earlier sessions alongside the ones you actually had open.
  The switch now hands off precisely the open set — every open
  document reopens in the new layout, nothing tags along from the
  past, and documents with no unsaved changes come back clean
  instead of asking you to save when you close them.

- **Typing over a Ctrl+Shift+Down selection no longer eats the
  paragraph break.** Selecting a paragraph with Ctrl+Shift+Down
  extends the selection to the start of the next block, so typing
  replaced across the boundary and merged the blocks — worst case,
  selecting a tag that way and typing folded the cite into the tag.
  Typing now replaces only the block's own text, matching
  triple-click. Selections that visibly reach into the next block's
  text still merge as before.

- **Pane word counts update live after Send to Speech in multi-pane.**
  Two stacked causes. The send path's "show the new headings
  immediately" hook cancelled the pending refresh without doing the
  refresh's work — so the speech pane's count froze after every send
  (cross-pane card drops had the same flaw); the hook now flushes the
  nav rebuild and word count on the spot, making the count update
  instantly on send — faster than single-pane's debounce. Separately,
  a document moved between panes (Send Doc to Slot) kept refreshing
  its OLD pane's count; each pane's count now follows the document
  wherever it lives, for edits, sends, and live selection counts
  alike, under every word-count setting.

- **Repair Text now places far more of its fixes on imported cards.**
  The model frequently echoes straight quotes and apostrophes where
  the document has curly ones, and the exact-match placement quietly
  skipped every such fix — on a real card, over half the suggested
  repairs. A fallback matcher now tolerates those echo slips (smart
  quotes/dashes, ligatures like ﬂ, non-breaking spaces, tabs, invisible
  characters, and context that crosses a paragraph break) while
  preserving the document's original punctuation — only the actual
  correction is applied, never the surrounding context. Repair also
  now catches the stray-space-after-hyphen artifact ("neo- Gramscian"
  → "neo-Gramscian", "vis-a- vis" → "vis-a-vis") — keeping the hyphen
  for real compounds, dropping it for words split across a line. Long
  fix lists also no longer fail with a cryptic JSON error: the
  response limit is raised, and genuinely oversized lists ask you to
  repair a smaller region instead.

- **Anthropic translations no longer cut off silently on long
  selections.** The AI translation path capped its output at roughly
  750 words and quietly copied whatever fit — a long card came back
  missing its tail with no warning. The ceiling is now ~40,000
  characters (far beyond any realistic selection), and if a translation
  ever does hit it, the toast says so and the copied text ends with a
  visible `[TRANSLATION INCOMPLETE — OUTPUT LENGTH LIMIT REACHED]`
  marker instead of pretending to be complete.

- **Saving no longer adds italics to undertag text.** Exported files
  mark undertag runs italic so they display correctly in Word; reopening
  such a file turned that display hint into real italic formatting on
  every undertag, every save. Undertags now come back exactly as you
  wrote them.

- **Find/Replace works correctly in paragraphs containing images.**
  Every match after an inline image was shifted one position per
  preceding image — highlights landed slightly off and Replace edited
  the wrong characters, corrupting adjacent text. Matches, highlights,
  result snippets, and replacements now land exactly on the matched
  text.

- **Letter shortcuts now work when focus is outside the editor.**
  Shortcuts like Ctrl+Shift+S did nothing while focus sat on the
  ribbon, nav panel, or other chrome — and with CapsLock on, even
  plain Ctrl+S died everywhere. Letter shortcuts now match regardless
  of Shift or CapsLock casing, wherever focus is.

- **Closing a document now releases its memory.** Each closed pane
  quietly kept its outline panel — and with it a full snapshot of the
  document — alive until the app closed, and the orphaned panel kept
  doing work during drags. Long sessions that open and close many
  files (a tournament day) no longer accumulate that weight.

- **Body paragraphs with leftover cite styling now clean up properly.**
  Imported cuts can carry the cite character style across the whole
  un-underlined text of a card body. That classified the paragraph as
  a cite line, so Shrink refused it — and the obvious cleanup, Select
  Similar Formatting then Clear Formatting, left one styled space per
  matched run behind (the trailing-space trim that undoes double-click
  absorption was wrongly applied to each matched range), which kept
  the paragraph classified as a cite line. Now: Clear Formatting over
  a Select Similar match cleans whole runs including their spaces,
  invisible whitespace-only runs no longer make a paragraph a cite
  line, spaces match Select Similar by formatting alone (size
  ignored), and Shrink tells you when the cursor is in an actual cite
  line instead of silently doing nothing.

- **F7 with text selected inside a tag no longer breaks up the card.**
  Selecting a word in a tag and pressing F7 quietly pushed the card's
  cite and body out as plain paragraphs (the cite lost its formatting;
  condense stopped folding the body). With the cursor in a tag F7
  correctly did nothing — now the selection does nothing too. Same fix
  for Mod-F7 on analytic text and F8 on an undertag.

## 0.1.0-alpha.10 — 2026-06-08

### Added

- **Reading-position marker.** Press **Mod-Shift-D** (rebindable) to drop a
  red `Marked h:mm` note at the cursor — Verbatim's red-text convention for
  finding your place when you stop mid-card. Triggering it again while the
  cursor is on a marker removes it. It works any time, but shines in read
  mode: there the keyboard is otherwise locked, so **Space**, **Enter**, or
  the bound shortcut all drop (or clear) a marker, and **undo/redo** is
  bounded to just the markers you've placed — it won't reach back into edits
  from before you entered read mode. The marker is plain red text, so it
  saves to Word like any other colored run.

- **Repair Text (AI).** Select messy OCR / PDF-extracted text and press
  **Mod-Shift-R** to clean up extraction errors — dropped ligatures
  (`signicant` → significant), `rn`/`m` confusions, mid-word hyphenation
  split across lines (`re-`/`search` → research, rejoining the break),
  run-together words, stray-space and punctuation slips — while leaving the
  actual wording untouched. The model returns only the specific fixes (not
  a rewrite of your text), which are applied in place: you watch each
  correction appear one at a time with an orange highlight, and the whole
  repair is a single undo. Requires AI features.

- **Translate a selection (AI optional).** Select text and press
  **Mod-Shift-T** (rebindable) to translate it and copy the result to the
  clipboard — the document is left untouched. Three backends, picked under
  Settings → Editing → **Translation**: **MyMemory** (free, no key, works
  even with AI features off; optional email raises its daily limit),
  **Anthropic** (used when AI features are on; highest quality), and
  **Google Cloud Translation** (paste an API key). Source language
  auto-detects; the target language defaults to English and is
  configurable. Optionally (on by default) it prepends a
  `[TRANSLATION BY …]` marker line naming the engine (the model for
  Anthropic, MYMEMORY, or GOOGLE TRANSLATE), using the same delimiter as
  "Condense with warning" — and those markers are protected from Shrink.

- **Custom AI model (advanced).** Settings → Comments & AI → **AI model**
  lets you point all AI features at a specific Claude model id (e.g.
  `claude-opus-4-8`). Leave it blank to use the model built into the
  release; set a newer id if the built-in one is ever retired so you don't
  have to update the whole app. If the model is unavailable, CardMirror now
  shows a clear message telling you to update or set a newer model here.

- **Pinch / Ctrl+Scroll to zoom.** You can now zoom the document with a
  trackpad pinch or by holding Ctrl and scrolling the mouse wheel, in the
  same 10% steps as the zoom buttons and Ctrl-= / Ctrl--. Off by default;
  enable it under Settings → General → **Pinch / Ctrl+Scroll to zoom**
  (handy if you don't habitually scroll with Ctrl held).

- **Keyboard macros are now findable in the command bar.** Searching the
  Search Everything palette (Mod-Shift-Space) for "keyboard macros,"
  "macro," or "snippet" now surfaces a result that jumps straight to the
  macros editor under Settings → Keyboard shortcuts.

- **Manage Flashcards button in the ribbon, with a due-today dot.** The
  ribbon's comments cluster now has a **Manage Flashcards** button (next
  to Create Flashcard) that opens the flashcard manager. It shows a small
  **red dot** when one or more cards are due for review today; turn the
  dot off under Settings → General → **Flashcards-due dot**.

- **Comment, note, and ask AI about pictures.** Select an image — or a
  span of text that includes images — and you can now add a comment, add
  a private note, or ask AI about it, just like you can with text. Ask AI
  sends the actual picture(s) to the model (up to five from a selection),
  so you can ask things like "what does this chart show?" Image
  annotations re-anchor by content when the document changes, exactly
  like text annotations, and comments on an image survive saving to Word.

### Fixed

- **AI cite creator: no more chopped-off last character.** When you ran
  cite repair over a whole-document selection (e.g. Select All on a page
  of pasted citation info), the highlight could land one character early
  — missing the last character of the author tag — and the final
  character of the cite could get pushed onto its own line. Both are
  fixed. As a bonus, the cite is now cleaned of stray line breaks, double
  spaces, and invisible junk that often rides along in text pasted from
  PDFs or the web.

- **"Show in context" during review now closes the Manage Flashcards
  screen.** When you open Manage Flashcards, start a review, and use Show
  in context on a card that lives in the document you already have open,
  the manager now closes so you land on the card — it used to stay open
  over the document. (Matches how it already behaves from the Home
  screen.)

- **Dragging a card out of the editor now auto-scrolls.** When you pick
  up a card or heading from the page and drag toward the top or bottom
  edge, the document scrolls so you can drop it past what's currently on
  screen — previously it didn't scroll at all.

- **`@AI` mentions work again in comments and notes.** Typing `@AI` now
  summons the assistant from the **first** message of a comment (not just
  replies), and works in note threads too — both had stopped firing. The
  assistant's name also no longer shows a redundant `(AI)` after it (e.g.
  just "Clod"), matching the rest of the interface.

- **Opening an already-open file from Finder no longer makes a second
  copy.** Double-clicking a file in Finder (or "Open with… CardMirror")
  now jumps to the window that already has it open — the same thing the
  in-app Open dialog has always done.

- **Toggling the three-pane workspace no longer closes all your
  windows.** With more than one window open, flipping the three-pane
  setting now reliably reloads into the new layout with your documents
  intact, instead of occasionally closing every window and reopening
  none.

- **Editor spellcheck actually works now.** It previously did nothing
  even with the setting on. Spellcheck now underlines misspellings in the
  visible part of the document — including text in files you've opened,
  not just words you're currently typing — and works on every platform
  (the old browser checker didn't render on Linux). **Right-click a
  flagged word** for spelling suggestions, **Add to Dictionary** (your
  personal dictionary persists across documents and sessions), or
  **Ignore**. It's still off by default; turn it on under Settings →
  General.

### Changed

- **Italic typing now shows a slanted cursor.** When you turn on italics
  with no selection (Ctrl-I) — or place the cursor inside italic text — the
  caret tilts to match, so it's clear the next thing you type will be
  italic. The cursor returns to upright as soon as typing wouldn't be
  italic.

- **Ctrl-U with no selection now starts underlined typing.** With nothing
  selected, Ctrl-U toggles underline for the text you're about to type
  (matching how Ctrl-I / Ctrl-B work), instead of doing nothing. **F9 is
  unchanged** — it still underlines the whole word at the cursor. (Both
  remain rebindable under Settings → Keyboard shortcuts.)

- **Backspace removes a blank line directly below a tag.** An empty
  paragraph right under a tag or analytic used to swallow Backspace
  (to protect the heading from absorbing body text); now, since there's
  nothing to merge, it just deletes the blank line and puts the cursor at
  the end of the tag. A line with text is still protected.

- **Select Current Heading now has a default shortcut: Alt-A.** The
  command (select the current heading and everything under it) was
  previously unbound; rebind it like any other under Settings → Keyboard
  shortcuts.

- **macOS no longer pretends to auto-update.** CardMirror can detect a
  new version on macOS but can't install it automatically, so the
  "downloading in the background" / "restart to install" prompts no
  longer appear there. The update notice now simply points you to the
  releases page to download the new `.dmg`. Update checking, and full
  auto-update on Windows and Linux, are unchanged.

### Removed

- **The "Text drag-and-drop" setting.** Dragging selected text to move it
  never worked reliably, so the toggle (which was off by default anyway)
  has been removed; the behavior stays off. Selecting, copy/paste, and the
  card / heading pickup-drag are unaffected.

## 0.1.0-alpha.9 — 2026-06-03

### Added

- **A user manual.** A complete guide to the editor — installing, cutting
  and formatting, the workspace, read mode, flashcards, AI, settings, and
  shortcuts — now lives at `MANUAL.md`, written in the plain,
  task-first style of Verbatim's own manual.

- **Notes — a private, threaded annotation.** A fourth kind of comments-bar
  entity, alongside comments, AI notes, and flashcards. Add one with the
  new green **note button** in the comments cluster (its own third column)
  or the bindable **Add Note to Selection** command (default
  **Ctrl/Cmd+Shift+N**). Notes are green throughout — chip, in-text
  highlight, card accent — and behave like comments (a root message plus
  replies) but stay **private**: they live in your local layer and never
  enter the saved file unless you opt in. Click a note's green text to
  focus its card; unanchored notes get a Re-ground action like flashcards.

- **Edit any comment or note in place.** A pencil button on each comment,
  reply, and note turn opens an inline editor (Save / Cancel; Enter saves,
  Esc cancels) so you can fix text after writing it.

- **Opt-in export of private notes and AI comments.** The Save As dialog's
  Custom Save now has two checkboxes (off by default): include private
  notes, and include AI comments. When checked, they're written into the
  saved `.docx` / `.cmir` as real Word-style comments. Leaving them off
  keeps notes and AI threads entirely private, as before.

- **Save Send Doc command + shortcut.** A new bindable command (default
  **Ctrl/Cmd+Alt+S**) that saves a send doc — the document with comments,
  analytics, and undertags stripped, the same content as the Save As
  dialog's Send Doc preset — in one keystroke, no dialog. Two new
  Settings → General options control where it goes: **Send Doc
  destination** (the source file's own folder, or a fixed folder you
  pick) and the **Send Doc folder** for the fixed-folder option. It uses
  your default new-document format and the same `SEND_` prefix as the
  preset. If the document hasn't been saved yet (same-folder mode), the
  fixed folder isn't set, or the name would overwrite the source, it
  falls back to the normal Save As dialog so nothing is lost.

- **Right-click a style button to select every instance of that style.**
  Right-clicking any structural style button (Pocket / Hat / Block / Tag
  / Analytic / Undertag) or character style button (Cite / Underline /
  Emphasis) lights up every instance of that style across the document,
  shown the same way as Select Similar Formatting — so you can then apply
  a format (highlight, font color, etc.) to all of them at once. If you
  have a selection, the search is bounded to it and the region is tinted;
  that scope stays put across further right-clicks and format operations
  until you make a new selection or press Escape. Underline matches only
  the named underline style, not the direct underline that tags and
  analytics use.

- **Ribbon style buttons show what the cursor is on.** When the cursor
  sits on text carrying a character or structural style, the matching
  ribbon button (Cite / Underline / Emphasis, or Pocket / Hat / Block /
  Tag / Analytic / Undertag) lights up in its toggled-on state, the same
  way other toggle buttons do. Underline only lights for the named
  underline style, not the direct underline tags and analytics use.

- **Find the app version from the command bar.** Searching "version" or
  "about this install" in the command bar shows the running version, and
  pressing Enter jumps straight to the About this install section of
  Settings.

- **Convert Cited Analytics to Tags.** A new command in the document
  dropdown's Cleanup section (also bindable to a shortcut, unbound by
  default) that works like Convert Analytics to Tags but only converts
  analytics that actually carry a cite paragraph — bare, citeless
  analytics stay analytics. Bounded to your selection when you have one,
  whole-document otherwise.

- **Extract Undertag.** A new command in the card dropdown's Excerpt
  section (also bindable, unbound by default) that takes your selection
  inside a card and drops it as a new undertag beneath the tag, below any
  existing undertags. The original text stays put. A new Settings →
  Editing toggle, "Extract Undertag: wrap in quotes" (off by default),
  controls whether the excerpt is wrapped in quotes.

- **Word Count Selection button in every multi-pane pane.** The Σ button
  that opens the Word Count Selection summary, previously only in
  single-pane view, now appears in each pane's footer in multi-pane mode.
  Each one counts the document — and selection — in the pane it sits next
  to. The redundant shared button that used to sit in the corner below
  the nav rail is gone in multi-pane mode.

### Changed

- **Autosave remembers its setting per document.** Turning autosave on
  for a saved doc now sticks: close and reopen that file (in either
  single-pane or multi-pane mode) and autosave comes back on, instead of
  resetting to off every time. The choice is remembered per file, so
  other docs are unaffected.

- **Paragraph navigation lands on cleaner spots.** With a selection,
  Ctrl/Alt+Down now collapses to the **start of the next paragraph**
  (just past the break) instead of stopping at the end of the selected
  paragraph first — so the next Down continues to the paragraph after
  that. And Ctrl/Alt+Left at the start of a paragraph now lands at the
  **end of the previous paragraph** (after its last word/punctuation),
  matching how Ctrl/Alt+Right lands at the start of the next one.

- **Select Similar / select-all highlighting is easier to read.** The
  "selection" region and the matched instances now use the find bar's
  colors — a faint blue region band with orange match outlines — instead
  of two near-identical oranges that were hard to tell apart.

- **The welcome guide is shorter, and now covers flashcards.** The
  starter document you get on first launch (and on New Document) has been
  tightened throughout and gained a "Study your evidence" section
  introducing the spaced-repetition flashcards.

### Internal

- **Diagnostic logging for a macOS multi-window issue.** This build
  writes a `cross-window-debug.log` to the app's data folder to help
  track down a Mac-only problem where the duplicate-open guard and the
  three-pane toggle don't always coordinate between windows. It records
  window open/close coordination only — no document content — and will
  be removed once the cause is found.

- **Project documentation streamlined.** The README, ARCHITECTURE, and
  PROJECT docs were cut down and brought up to date — shorter, clearer,
  and accurate about what's shipped versus planned.

### Fixed

- **Live selection word count works in multi-pane mode.** With the
  "live selection word count" setting on, selecting text in a pane now
  immediately updates that pane's footer to the selection's word count
  and read time, the same as single-pane — previously it only refreshed
  after the next edit, so it looked permanently off. With the setting
  off, panes show the whole-doc count regardless of any selection.

- **Dropzone pill no longer briefly overlaps the reader count in
  multi-pane mode.** On a fresh multi-pane boot the floating dropzone
  pill could land on top of a pane's word-count / read-time readout
  until something refreshed the UI (e.g. cycling the theme). It now
  sits above the pane footer from the first paint.

- **AI "Generate table from image" handles large tables.** Big tables
  used to silently fail because the model's JSON got cut off at the token
  limit. The format the model returns is now much more compact and the
  token ceiling is far higher, so large tables come through intact. If a
  reply still comes back malformed (rather than truncated), it's sent to a
  second pass that reformats it instead of just failing; a table that's
  genuinely too big to return in one go now says so clearly.

- **Creating notes, AI comments, and flashcards is fast again on large
  documents.** Adding one of these annotations (and typing a reply) no
  longer re-scans the whole document to re-locate every annotation each
  time — a newly created or re-grounded annotation now uses the position
  you already selected, and the rest are left where they are. On big docs
  this takes note / AI-comment creation from sluggish to instant.

- **Opening Settings and changing a setting are fast again on large
  documents.** Both could take seconds on a big doc. The main offender was
  the Accessibility color panel, which forced a full-document style recalc
  for every one of its ~37 color rows on every settings change (and at
  open); it now reuses a single probe and refreshes only the row whose
  color actually changed — so editing one color touches one row, not all
  of them. A few settings were also re-applied on every change even when
  unrelated (read mode re-walking the doc, the outline panel rebuilding,
  a redundant word-count walk); those now run only when their own input
  changes. The keyboard-shortcuts list also builds a frame after the
  dialog opens rather than blocking it.

## 0.1.0-alpha.8 — 2026-06-01

### Added

- **"Show in context" in flashcard review.** After you reveal a card's
  answer, a third option (button or key **3**) opens the card's source
  document focused on the exact text it was made from. It appears only
  when the card is anchored in a file you have on disk, and it doesn't
  grade the card — it's a quick "show me where this is." Where it lands:
  in the three-pane workspace it opens into a slot of the current window
  (the one already holding it if any, otherwise the first free slot);
  in single-document mode it focuses the doc in place if it's already
  open here, jumps to it if you have it open in another window, or opens
  it in a new window otherwise — leaving the review running unless the
  document opens in this same window.

- **Live word count for the current selection (optional).** A new
  Settings → General toggle, off by default. When on, the bottom bar's
  word count / read time updates the moment you change the selection,
  showing the selection's read time; when off, the bar stays on the
  whole-document count and you get a selection's read time on demand via
  the Word Count button (Σ). Leave it off on very large documents if you
  notice lag while dragging a selection.

### Fixed

- **Clicking AI-comment or flashcard text now focuses its card** in the
  comments pane, the same way clicking commented text focuses its
  comment. Previously only human comments responded to the cursor — AI
  threads and flashcards would only open if you clicked their card in the
  pane directly.

## 0.1.0-alpha.7 — 2026-05-30

### Added

- **"Delete Current Heading" command.** Deletes the structure your
  cursor is in — a card, an analytic, or a heading and everything under
  it (the same thing "Select Current Heading" targets) — removed
  outright, with no empty heading left behind. Unbound by default;
  assign a key in Settings → Keybindings (or run it from the search
  palette — it also answers to "delete card" / "delete heading").

- **Search-Everything now finds settings and commands by their common
  names, not just their exact labels.** Searching "dark mode", "light
  mode", or "toggle theme" surfaces the Theme setting; "toggle
  comments" finds Show / Hide Comments (and vice versa); "clear
  formatting" finds Clear, "paste without formatting" finds Paste Plain
  Text, "line height" finds Line spacing, "sidebar" finds the
  navigation pane toggle, and more. These are search aliases only —
  the displayed names are unchanged.

- **Reset-to-default buttons next to the Analytic / Undertag color
  pickers** (Settings → Appearance → Style colors).

- **"Cycle Theme" command** that steps the theme Light → Dark → System.
  Unbound by default — assign a key in Settings → Keybindings (or run it
  from the search palette; it also answers to "dark mode" / "toggle
  theme").

- **Find a tag by its citation when searching inside a file.** Tab into
  a file from the command bar and type an author/date — the tag whose
  card carries that cite now shows up, the way Ctrl-F can find it. Tags
  also display their cite alongside them in the results. Because tags
  are now findable by cite, standalone "Cite" rows are off by default in
  the file-search object types (re-enable them in Settings if you want
  cites listed on their own).

- **Selecting text auto-scrolls at the edges.** Dragging a selection to
  the top or bottom of the document now scrolls the view so the
  selection keeps extending past the originally visible area — no more
  stopping to scroll by hand. Scrolls continuously while you hold near
  the edge, faster the closer you get.

### Fixed

- **"Open with… CardMirror" now works in three-pane workspace mode.**
  Opening a file from the OS file manager (right-click → Open with) used
  to pop a blank window in multi-pane mode — the file was silently
  dropped. It now routes the file into the slot picker: if a workspace
  window is already open it reuses that window (no new window); if none
  is open it opens one and shows the picker there. Single-pane is
  unchanged (a new window per file). Applies to both `.docx` and `.cmir`.

- **The command bar's file search refreshes while it's open.** Opening
  the palette kicks off a background re-scan of your `.cmir` folder, but
  that fresh listing used to appear only after you closed and reopened
  the bar. It now updates the open palette the moment the re-scan
  finishes — and seamlessly: whatever you're typing, your place in the
  results, and a file you've Tabbed into are all preserved across the
  refresh.

- **"Find: remember the last search query" now actually turns off.** The
  find bar kept the text you'd typed even after closing, so the last
  query reappeared on every open no matter how the setting was set. It
  now opens with the remembered query only when the setting is on, and
  with a clean slate when it's off.

- **The Analytic / Undertag color pickers now actually work, and the
  Appearance and Accessibility copies are linked.** The Appearance
  "Style colors" picker had no visible effect — the Accessibility
  "Color overrides" system silently wiped it on every load. The two are
  now one linked value: set the color in either place and both update.
  Dark-mode behavior follows what you'd expect: your colors stay put
  when dark mode is on but isn't applied to the document; the document
  switches to a lighter built-in blue/green only when you apply the
  theme to the document area (the navigation pane, being chrome, always
  uses the lighter colors in dark mode for contrast). Any color you'd
  previously set through the Accessibility panel is migrated over
  automatically.

- **The home screen's Learn section no longer locks you out of Manage
  when you have no flashcards.** Previously the whole section greyed
  out until your first card existed — but Manage is where you import
  flashcards from a file, so there was no way in. Now only "Review
  all" is greyed out when there's nothing to review; "Manage
  flashcards" stays live so you can import.

## 0.1.0-alpha.6 — 2026-05-30

### Added

- **Integration surface for a future external paste tool (Fast Debate
  Paste).** CardMirror now runs a tiny loopback HTTP server
  (127.0.0.1 only, token-gated, off the network) so a separate, not-
  yet-shipped client app can insert pasted text directly into the
  focused doc — replacing the Return-then-F2 keystroke synthesis
  that bridge currently uses. No user-visible feature today; nothing
  changes until the external app implements its side and ships.
  Discovery file at `{userData}/fast-paste-bridge.json` tells the
  client the per-launch token and port; the server tears it down on
  quit. Routes: `GET /ping` for a health probe, `POST /insert` for
  the insertion itself. Insertions go through a renderer-side
  primitive that builds `card_body` paragraphs (or `paragraph` at
  doc level) directly, so a multi-line insert always stays as body
  paragraphs in the same card — never as a tag.

### Fixed

- **Old docs with id-less tags now self-repair on load.** Tags
  synthesized by the pre-alpha.6 F2 schema-fitter bubble-up were
  saved into `.cmir` files with `id: null` (the schema's default
  — every code path that creates a tag stamps a fresh id, but
  PM's fitter bypassed all of them). The nav-pane highlight skips
  id-less headings, so the cursor sitting in one of those cards
  used to show as being in the *previous* card. Loading a `.cmir`
  now walks the doc and stamps a fresh id on any pocket / hat /
  block / tag / analytic whose id came in null.
- **F2 plain-paste no longer occasionally elevates a pasted line into
  a card tag.** Pasting 3+ lines of plain text into a card body used
  to let PM's schema-fitting bubble the split up to the card itself —
  which produced either content escaping the card to the document
  level (the absorb plugin would clean it up immediately, but with
  visible artifacts during the dance), or in worst cases a card
  split where the second half's mandatory tag got synthesized from
  one of the pasted lines (the "line becomes a heading with extra
  spacing" report). The plain-paste path now uses the same pre-fit
  the rich-paste path has had for a while: the paragraphs in the
  pasted slice are converted to card-body nodes before insertion,
  so the schema accepts them in place and no split bubbles up. As a
  side effect, the cursor lands at the end of the pasted content
  rather than bouncing through the lift-and-reabsorb dance.
- **F12 (Clear to Normal) no longer rockets the cursor to the bottom
  of the doc when it dissolves a tagged card.** Cursor stays in the
  demoted (former-tag) paragraph at the same character offset, and
  when the dissolved card was preceded by another card so the demoted
  paragraph gets re-absorbed into that card, the cursor tracks into
  the absorbed body. Same family as the prior paste / F7 cursor-jump
  fix — that one made the absorb plugin's doc rewrite cursor-safe
  for positions OUTSIDE the absorbed orphan range; this one extends
  the same protection to cursors INSIDE the orphans (and to F12's own
  dissolve replace, which had the same root cause as the original
  absorb-plugin bug).
- **Dropzone pill no longer ends up in the status bar's band on some
  Windows machines.** Before its dynamic positioning pass had a chance
  to land, the pill fell back to a CSS bottom that put it ~8px above
  the viewport bottom — in the same vertical strip as the zoom
  controls and reader read-time readouts. On some Windows boots the
  positioning pass never recovered (target rect came back zero-sized
  at the moment it ran), so the pill stayed there. The CSS fallback
  now already clears the status bar, and the pill stacks above the
  bar if anything ever does push the two together.
- **Paste no longer drops an undeletable "intermediate line" below a
  tag/cite.** Sources that wrap content in layout tables — Google Docs
  published views, news-site article bodies, marketing emails, .docx
  page-frame copies — used to leave their wrapping single-cell `<table>`
  intact on paste. Visible as either an empty, undeletable gap (Backspace
  / Delete would expand to swallow the whole card instead of removing it),
  or as text that looked inset from a real card body with a small extra
  vertical gap above it (the table cell's own padding / borders). Single-
  cell layout tables — and any table whose every row holds exactly one
  cell — now unwrap on paste, lifting their paragraphs out into normal
  body text. Real data tables (any row with two or more cells) pass
  through unchanged.

## 0.1.0-alpha.5 — 2026-05-29

### Added

- **Learn — flashcards & review (early).** Turn evidence into spaced-
  repetition flashcards without leaving the editor.
  - **Create Flashcard** (a button in the ribbon's comments group, the
    command palette, or a bound key): with text selected, anchor a new
    card to it. Pick **Q & A** (a question and an
    answer) or **Cloze** (one sentence with the deletion wrapped in
    `{{double braces}}`). The answer field pre-fills with the selected
    text. Cards are due immediately.
  - **Review** from the Home screen's **Learn** section: a "Review all
    due" card plus a per-file / per-deck breakdown of whatever's due
    today. A session shows one card at a time — Space reveals the
    answer, then **1 = Forgot** / **2 = Remembered** (binary grading).
    A forgotten card comes back later in the same session.
  - **In the document** — open the comments pane and the text a card is
    anchored to is highlighted; the card appears in the column next to
    it, alongside any comments, and clicking it reveals the answer. Edit,
    suspend, or delete a card right there. If an edit (yours or a
    collaborator's) breaks a card's anchor, it drops into an
    **"Unanchored"** section at the bottom of the pane showing the text
    it was attached to, with a **Re-ground** button — select new text and
    click it to re-attach. It won't silently re-attach to an unrelated
    passage that happens to share the same words. A broken anchor never
    affects the card's review schedule.
  - **Manage flashcards** (Home → Learn, or the command palette): browse
    every card grouped by the file it's anchored to — so you can see
    which cards belong to which document — filter by text, edit a card's
    question/answer, suspend/resume it, or delete it. **New card** makes
    a standalone card not tied to any document. Cards shared across files
    (via Save As) are marked, and an "Unanchored" group collects
    standalone cards and any whose text reference is gone. An unanchored
    card has a **link** button: pick a file to attach it to (CardMirror
    quietly tags the file with a hidden id if it doesn't have one), then
    ground it to specific text later from inside that file. **Export** and
    **Import** buttons save all your flashcards to a file / load them
    back: import **adds** cards (it never overwrites or replaces what you
    have), carrying each card's review schedule and its text groundings,
    and tolerates older export files.
  - Flashcards live in a **private, per-user layer on your machine** —
    they are never written into the document and never travel in
    comments, so sharing a `.docx`/`.cmir` never leaks your cards.
    Documents keep a stable hidden id (it survives a round-trip through
    Word) so your cards re-associate with the right file; the id is
    written into the file as soon as you create or link a card (no
    separate save needed). **Save As** forks a copy's cards alongside the
    new file. Works the same in single-document windows and the
    multi-pane workspace.

- **Smoother comments column** — comment (and flashcard) cards now shift
  around each other smoothly when one expands, collapses, or changes
  height, instead of jumping, and stay reliably positioned next to their
  text as you edit. Typing in a reply no longer loses focus on unrelated
  updates.

- **Modern icons** — the toolbar, banners, dialogs, and status bar now
  use a clean line-icon set (Untitled UI) that takes on the active
  theme color, replacing the old mix of emoji and text symbols. New
  under Settings → Appearance → **Icon style**: pick **Modern** (the
  new default) or **Classic** to bring back the original emoji/text
  glyphs. The choice affects the app's chrome only — your documents are
  untouched.

- **Bulk convert** (desktop) — a Home-screen button (under its own
  "Convert" heading, beside Quick Cards) that batch-converts between
  `.docx` and `.cmir`. Choose the direction, an input (a single file or
  a whole folder, recursed through subfolders), and a destination
  folder; then Convert. Output is either loose files (swapped
  extension, mirroring the input's subfolder structure) or a single
  `.zip`, both written into the destination you pick. The chosen input
  and destination paths are shown before you convert. Comments carry
  across the conversion. Esc closes the dialog without also dismissing
  the Home screen behind it.

- **Keyboard macros** — in **Settings → Keyboard shortcuts**, a new
  section below the shortcut list lets you bind a key to **type a snippet
  of text** at the cursor. Click **Set shortcut**, press your keys, type
  the text — done; add as many as you like. Handy for repetitive
  insertions you'd otherwise retype by hand. A macro key takes
  precedence over any command bound to the same key.

- **Export / import settings** — at the bottom of **Settings → General**,
  **Export settings…** saves everything (keyboard shortcuts, macros,
  appearance, and the rest) to a JSON file; **Import settings…** replaces
  your settings from a file. Import is version-tolerant: settings added
  since the export fall back to their defaults and ones removed since are
  dropped, so an old export still loads cleanly. Your Anthropic API key is
  never exported, and importing keeps your current key.

- **Quick Cards** — a persistent, cross-window library of reusable
  rich-text snippets (think Verbatim's quick cards), reached from a
  new 2×2 ribbon cluster (Search / Tag Picker / Manage / Add) between
  the speech-doc buttons and the structural styles.
  - **Add** (button, or bind a key in Settings → Keybindings): with
    text selected, save it as a quick card. The name pre-fills with
    the smallest enclosing heading; you can tag it (Enter or comma
    between tags). A name may repeat only if its tags differ.
  - **Tag Picker** (🏷️): choose which tags are in scope for search —
    handy when, say, several aff files each have a "2AC" card. The
    filter is global and persists.
  - **Manage** (🗂️, or the Home screen): a full-window browser to
    edit a card's name / tags / content (in an embedded editor),
    delete, and import/export as JSON.
  - Quick cards persist across sessions and are shared live across all
    open windows. Inserting into the middle of a paragraph asks for
    confirmation first; disable that via **Settings → Editing →
    "Skip mid-text confirm when inserting quick cards."**

- **Search — a command palette** (**Ctrl/Cmd+Shift+Space**, or the 🔍
  button in the Quick Cards ribbon cluster; press again to close): a
  floating palette over the current document that searches *everything*
  at once — quick cards, the dropzone, commands, settings, and files.
  Type to search across all of them, or scope to one source with a
  prefix — `q ` for quick cards, `d ` for the dropzone, `c ` for
  **commands** (anything bindable to a keyboard shortcut; the result
  shows its current binding, and selecting it runs the command), `s `
  for **settings**, and `f ` for **files** (desktop). Matches on name
  first, then contents; ↑/↓ to move, **Enter** to insert (or run a
  command / open a setting / open a file), **Alt+Enter** to insert at
  the end of the doc, Esc to close. **Tab** jumps to an inline tag
  filter (type to filter, ↑/↓ + Enter to toggle, Esc to return).
  - `s ` **settings** finds both the top-level settings sections
    (General, Appearance, …) and individual settings by name; selecting
    one opens that tab, scrolled to and briefly highlighting the setting.
  - `f ` **files** (desktop) finds `.cmir` files by name under a folder
    you set in Settings → General → "File search folder" (searched
    recursively). Enter opens a file in a new window (or the slot picker
    in multi-pane), leaving your current document untouched; **Tab**
    dives into the highlighted file. With the bar empty you get the
    file's outline (its pocket → hat → block → tag hierarchy, indented
    like the nav pane) to browse — right-click (or click the chevron on)
    any pocket / hat / block to expand or collapse it, and set how deep
    it opens by default via Settings → General → "File search: default
    outline depth" (default Block, the same idea as the nav pane). Start
    typing to search the cards, blocks, and cites inside the file.
    Inserting a match (Enter, like a quick card) keeps the palette open
    and the file loaded, so you can pull several blocks in a row —
    Ctrl/Cmd+Z undoes the last one without leaving the bar; Esc returns
    to the file list with your prior search intact. Which object types
    appear in search is configurable in Settings. The file list is
    cached between searches (and across launches), but there's no content
    index yet, so the first dive into a large file may feel slow.
  - **Pinning / warm files:** to make the files you use most feel
    instant, CardMirror keeps a small set "warm" (parsed and held in
    memory). **Pin a file** with the ★ on its row or **Alt+P** — pinned
    files stay warm and float to the top of `f`. It also auto-warms your
    recent and frequently-used files (the most recent 6 + up to your top
    10 by use); turn that off in Settings → General → "File search:
    auto-pin recent & frequent files" if you'd rather keep only
    hand-pinned files warm. Warming happens quietly in the background —
    at launch and as you work, in the editor's idle moments — so it never
    interrupts typing or stutters when you open the search box. Diving
    into a warm file is instant — no re-parse.

- **Select Current Heading** and **Copy Current Heading** commands.
  Each acts on the card, analytic, or heading (plus its subtree) your
  cursor is in — the same structure Send to Speech / Send to Dropzone
  target. They key off the cursor and **ignore any active selection**. 
  "Select" highlights that structure; "Copy" puts it on the
  clipboard without moving your cursor. Both ship **unbound** — assign
  keys via Settings → Keybindings.

- **Home screen.** Launching CardMirror without a file now opens
  a start screen instead of a blank document: New document, New
  speech document, Open, and a list of recently opened files
  (click to reopen in place). A **Home button** (🏠, in the
  ribbon's top-right button cluster; rebindable via Settings →
  Keybindings) returns to it any time — with a "Back to document"
  link and Esc to dismiss back to what you were editing. On the
  home screen, the number keys trigger the action cards in reading
  order — **1** New, **2** New speech, **3** Open, **4** Manage quick
  cards, **5** Bulk convert, **6** Review all, **7** Manage flashcards
  (each only while its card is shown).
  **Ctrl+W** (single-doc) now closes the current doc back to the
  home screen rather than closing the window (the window's close
  button still quits); confirms unsaved changes first. Available
  in multi-pane mode too — there the Home button's actions route
  through the slot picker instead of loading in-place. Recent
  files persist across restarts. On the web edition, recents show
  but can't be reopened directly (browser file handles aren't
  persistable yet).

- **Grayscale text antialiasing on high-DPI displays** (DPR ≥
  1.5 — Retina, most modern phones, HiDPI Windows / Linux
  scaled past 150%). On those displays the chrome and editor
  text now render with `font-smooth: grayscale` (via
  `-webkit-font-smoothing` and `-moz-osx-font-smoothing`),
  which matches the macOS system default since Mojave and
  produces a thinner, lighter glyph consistent with the rest
  of the OS. Low-DPI displays keep the browser-default
  subpixel rendering, which is crisper at that resolution.
- **Dropzone shelf** — opt-in floating pill in the editor's
  bottom-left corner (Settings → Appearance → "Show dropzone shelf in
  nav pane"; **default off**). When enabled, drag any card or
  heading onto the pill to absorb it into a cross-window shelf;
  click the pill to expand the shelf in place, click an item to
  insert it at the cursor (Alt+click to insert at end of doc),
  or drag an item out to drop it at a specific position in the
  editor / nav pane. **Ctrl+\`** (rebindable as `sendToDropzone`)
  sends the current selection or enclosing card/heading to the
  shelf even when the pill is hidden — items pile up in the
  store and become accessible the moment any window turns the
  pill on. Card items show the same tag + cite preview the nav
  pane uses; pocket / hat / block / analytic items show the
  heading text only. Shared across every CardMirror window in
  the same session; survives the renderer reload that toggling
  multi-pane mode triggers; does NOT persist between app
  restarts. On web, single-window only with `sessionStorage`
  survival.
- **Searchbar on Settings → Keybindings and the Keyboard
  Shortcuts reference modal.** Filters rows live against the
  command label AND its current keybinding text (searching "f7"
  surfaces every command bound to F7; "highlight" surfaces
  every command whose label contains it). Empty group sections
  collapse out of view so the surviving rows always read as a
  single coherent list.
- **Application menu bar overhaul** (desktop app):
  - **File** is now Open / New / Save / Save As / Toggle
    Autosave / Close.
  - **New Speech menu** between File and Edit holds the four
    speech-cluster actions plus a new **Select Speech Doc…**
    entry.
  - **Edit's Redo** is now `Ctrl/Cmd+Y` (was `Shift+Cmd/Ctrl+Z`;
    both still fire redo via the editor's keymap).
  - **View's Zoom In / Out / Reset** now point at the editor's
    `chromeScale*` commands (so the menu accelerators match what
    the keys actually do, instead of triggering Chromium's
    separate page-zoom).
  - **Window menu removed.**
  - **Help** gains Settings and Keyboard Shortcuts entries at
    the top.
  - **Every menu accelerator now tracks your current keybinding.**
    Rebinding a command in Settings → Keybindings updates the
    accelerator label shown next to its menu item — including
    the previously-static File entries.
- **Select Speech Doc** (Speech menu): new modal that lists
  every open document across every CardMirror window, marks the
  current speech doc with a gold accent, and lets you reassign
  or clear the designation. Picking a doc doesn't switch you to
  it; you stay where you are. No default keyboard shortcut —
  rebind via Settings → Keybindings if you want one.
- **Ribbon tooltips are now configurable** in Settings →
  Appearance → "Ribbon tooltips," with four modes:
  - **Label and shortcut** (default) — `Apply Tag Style (F7)`.
  - **Label only** — just the action name.
  - **Shortcut only** — just `F7`; buttons without a shortcut
    show no tooltip.
  - **No tooltips** — disables ribbon tooltips entirely.
  
  The displayed shortcut now tracks user rebinds (Settings →
  Keybindings) for every ribbon button, not just the
  formatting-panel buttons. Dropdown menu items (Doc / Card /
  Table) now also expose the current shortcut on hover —
  shortcut-only on those, since the menu label already says
  what the action does.
- **Interface font is now configurable** in Settings →
  Accessibility → "Interface font." Pick any of the body-font
  picker's familiar groups (readability fonts, Office defaults,
  Apple defaults, etc.) and the choice cascades to every UI
  surface — ribbon, dialogs, navigation pane, comments column,
  status bar, menus, tooltips. Default is the platform's
  system-UI font stack so the chrome blends with other native
  apps; "System default" stays selectable as a sentinel to
  return there. Independent of the editor body font.
- **Highlight Acronym command (Alt+F11).** Counterpart to
  Emphasize Acronym (now Alt+F10): expands the selection to
  whole-word boundaries, then applies the active highlight color
  to the first character of each word. Useful for visually
  popping the source letters of an acronym ("United States
  Capitol Police" → U, S, C, P each carry the active highlight).
  Unlike Emphasize Acronym, this works in structural blocks
  (tags, analytics, pockets) too, since highlight is a runtime
  annotation rather than a body-only named style.

### Changed

- **Find now walks the document top-to-bottom from your cursor.** Both
  Find modes used to rank matches by closeness to the cursor (nearest
  first, in either direction), so stepping through hits jumped around.
  Now they go in document order starting at the cursor and wrapping to
  the top: **Ctrl+F** still groups by category (headings, then tags, then
  cites, then everything else) with each group in document order;
  **Alt+F** ignores categories and runs straight down the document from
  the cursor (its command is now labeled "Find Without Category
  Grouping").

- **Comments, flashcards, and AI notes now share one card design.** Every
  card in the comments pane leads with a small **type chip** — `COMMENT`,
  `Q&A`/`CLOZE`, or `AI` — color-matched to the highlight it sits on
  (gold / blue / purple). Collapsed cards show just the chip and a
  one-line preview; expanding a comment or AI note brings back the round
  author avatars, so the question that *opens* a thread reads apart from
  the replies (an AI note's first question is no longer styled as a reply
  to nothing). The open card now glows in its own color. Delete is an `✕`
  on comments and AI notes and a confirm-press **Delete** on flashcards;
  on an AI note, **Convert to Flashcard** is now a prominent button under
  Reply. The reply box now has a compact **send** button at its right
  edge, and each card shows its date next to the type chip.

- **"Ask AI about selection" notes are now private to you.** AI
  explanations no longer live as comments in the document — they're kept
  in the same per-user, on-your-machine layer as flashcards, so they
  never get written into a `.docx`/`.cmir` you share (sending a file
  no longer leaks your AI Q&A). It works the same as before: select
  text, ask, and follow up in a back-and-forth — but the thread shows
  up as a purple note in the comments pane, under your AI persona's name
  with an **AI** chip (no more `(AI)` tacked onto the name), anchored to
  the text and following it as you edit (dropping into the **Unanchored**
  list with a **Re-ground** button if its text is deleted). Existing AI *comments*
  in older documents are left as-is. (Typing `@AI` inside a regular
  comment still works the usual way, as a comment.) **Ask AI about
  selection** has a ribbon button now (in the comments group, shown only
  while AI features are enabled), alongside Create Flashcard. An active AI
  note also
  has a **Convert to Flashcard** button: it asks the AI for a flashcard
  (a Q&A or a cloze, whichever fits) capturing what you were exploring —
  drawing on your questions and the card's tag to aim at what *you* cared
  about — then opens the create-flashcard editor pre-filled so you can
  tweak or just confirm. The new card is anchored to the same text as the
  AI note.

- **Save As dialog reorganized around presets.** **Name** and
  **Format** sections sit at the top; a **Save** section below
  offers three one-click save buttons — **As-Is** (everything),
  **Send Doc** (excludes analytics, undertags, and comments), and
  **Read Doc** (exports the read-mode view), each with a short
  description beneath it — saving immediately with the name and
  format above. A **Custom Save** block (comments / analytics /
  undertags checkboxes + a **Save Custom** button) remains below for
  hand-picking what to keep; Cancel sits at the bottom. The separate
  read-mode checkbox is gone, folded into the Read Doc preset.
  Saving via the **Send Doc** / **Read Doc** presets prepends
  `SEND_` / `READ_` to the file name (e.g. `SEND_1AC.docx`) by
  default — toggle off via **Settings → General → "Prefix preset
  saves with SEND_ / READ_"**. As-Is and Save Custom are never
  prefixed.

- **Emphasize Acronym moved from Ctrl+F10 to Alt+F10.** Frees
  Ctrl+F10 and makes room for Highlight Acronym on Alt+F11
  next to it. Rebind via Settings → Keybindings if you've been
  using the Ctrl chord.

### Fixed

- **Double-clicking a heading in the navigation pane reliably collapses
  / expands it.** The first click jumps the editor to that section,
  which used to re-render the outline a beat later and swap out the row
  you'd clicked — so the second click of a double often landed on a fresh
  row and the browser never registered the double-click. Double-clicks
  are now detected directly and survive the re-render, so collapsing /
  expanding from the outline works every time.

- **Settings: the selected-tab underline shows on every tab.** The blue
  active-tab line could vanish on tabs the tab strip has to scroll to
  reach (Keyboard, Comments & AI) — a scrolled tab strip was clipping the
  1px the underline overlaps the divider by. It now shows at any window
  width / scroll position.

- **Your selection stays visible when a palette or the find bar opens.**
  Selecting text and then opening the command / search palette (or any
  panel that takes keyboard focus) used to grey out or hide the
  selection, because the editor lost focus. It now stays highlighted, so
  you can see what a command will act on.

- **Pasted sections now work in the navigation pane.** When you copied
  pockets/hats/blocks (and the cards under them) from one document and
  pasted them into another, the pasted headings were inert in the
  destination's outline — you couldn't expand/collapse them (they stayed
  permanently open), couldn't jump to them, and the 1/2/3/4 level buttons
  ignored them. Pasted headings now get fresh internal ids (the copy step
  was dropping them), so they behave like any other heading.

- **After dragging a card to a new spot, the editor jumps to it.**
  Previously the view jumped to a seemingly random place after a
  drag-and-drop (it followed wherever your cursor happened to be before
  the drag, not the moved content), so a successful move often left you
  looking at the wrong part of the document. Now a drop lands you exactly
  where clicking that section's heading in the outline would — its first
  heading pinned to the top of the view — for both moves and copies, in
  single-document windows and across panes.

- **The outline's blue "you are here" highlight now follows big edits.**
  After a structural change like dragging a section to a new spot, the
  navigation pane could highlight the wrong heading (it scanned cached
  positions that hadn't caught up with the move) and stayed wrong until
  you next moved the cursor. It now re-checks once the outline rebuilds,
  so the highlight lands on the heading your cursor is actually in.

- **Large `.docx` files no longer fail to open with "Entity
  expansion limit exceeded".** The XML parser shipped a "billion
  laughs" safety cap that counted every ordinary `&amp;` / `&lt;` /
  `&gt;` / `&quot;` / `&apos;` toward a 1000-per-document budget, so
  big files (multi-tournament affs, large generics) tripped a
  malware-defense limit on perfectly valid content. The cap is
  lifted for import — standard entities are harmless 1:1
  replacements, and the documents we open are trusted local files.
- **Saving a Send Doc / Read Doc no longer renames the document
  you're working on.** Previously, saving via a content-dropping
  preset (or a partial Save Custom) rebound the open document's
  identity to the exported file's name — so the working doc thought
  it was named e.g. `SEND_1AC`, and trying to open that export was
  blocked by the "already open" guard. Now only a full-fidelity save
  (everything included, not read-mode) adopts the saved file as the
  document's name/handle; a derived export writes its own file
  (and shows up in Recent) while the working doc keeps its name,
  unsaved-changes state, and crash-recovery journal.
- **Settings → Keybindings list stays put when you rebind.**
  Capturing a new shortcut (or hitting × on a chip, or ↺ to
  restore defaults) used to rebuild the list and snap the
  panel back to the top — losing the row you were working on.
  The rebuild now preserves the surrounding scroll position.
- **Settings modal tab strip now scrolls with arrows instead
  of overflowing the dialog.** When the dialog is narrow enough
  that the tab labels don't fit, a left and right arrow appear
  on either side of the tab list; clicking either scrolls the
  tabs by about half the visible width. Each arrow disables
  when there's nothing more to scroll in its direction. When
  the tabs fit, the arrows disappear entirely. No native
  scrollbar.
- **Ribbon panel button gaps are now consistent** across every
  multi-button panel. The color panel was 4px and the
  format-menu panel (Table / image / sub / sup / strike) was
  2px while every other panel used 3px; both now use 3px so
  the spacing rhythm reads the same from left to right. Row
  gaps were already a uniform 2px and are unchanged.
- **Formatting panel (Pocket / Hat / Block / Tag / Analytic /
  Undertag) buttons are now equal-width**, so the visual
  rhythm between Pocket → Hat → Analytic stays uniform whether
  style preview is on or off. Previously the columns auto-
  sized to their widest occupant (Block is narrower than
  Analytic, so col 2 ended up tighter than col 3), and with
  style preview off the eye picked that up as asymmetric
  spacing.
- **Timer toggle now sits 3px from the settings / shortcuts
  stack** on the right side of the ribbon (was 5.6px from the
  default `.ribbon-section` flex-gap), matching the intra-
  panel column-gap used everywhere on the left side.
- **Ribbon panels now collapse one panel sooner**, so the
  rightmost visible panel no longer sits flush against the
  right-pinned buttons (timer / settings / reference). The
  progressive-hide overflow check reserves a small buffer —
  matched to the column-gap *inside* a single panel — so the
  spacing between the rightmost panel and the pinned right
  elements reads as the same visual unit as the spacing
  between buttons within a panel.
- **F9 / F10 / F11 (and the other formatting commands) now
  format a deliberately-selected trailing space instead of
  no-op-ing.** The Layer 3 trim that shaves the absorbed
  trailing space off a word selection used to fire even when
  the entire selection was whitespace, turning the operating
  range into empty and causing the command to no-op. The trim
  now skips when the range minus its trailing space has no
  non-space content — so selecting just ` ` (or any all-
  whitespace run) formats the spaces. Selections with word
  content still get exactly one trailing space shaved, same as
  before.
- **AI cite creator always lands the formatted cite in its own
  paragraph.** Previously, if the selection ended mid-paragraph
  or spanned a paragraph break, the formatted cite would inherit
  whatever trailing text was left in the textblock and merge
  with the paragraph after. The cite is now split out cleanly:
  any pre-cite text in the surrounding textblock stays as its
  own paragraph before, any post-cite text stays as its own
  paragraph after, and the cite is alone in the middle.
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
- **Ctrl+Left / Ctrl+Right with an active selection now snap
  to the WORD edge of the selection's relevant corner**, instead
  of just collapsing to the corner. If the corner sits INSIDE a
  word (e.g., you've selected "The" inside "Therefore"), the
  cursor jumps to the end of that word (Ctrl+Right) or the start
  of that word (Ctrl+Left). If the corner is already at a word
  boundary, the keystroke just collapses there with no further
  motion — same as before. Shift-extend variants are unchanged.
- **Ctrl+Up / Ctrl+Down with an active selection no longer
  skips into the adjacent paragraph.** Same idea as the
  Ctrl+Left/Right change above, one notch coarser: snap to the
  start (Up) or end (Down) of the paragraph that's actually
  visually part of the selection. Ctrl+Down in particular knows
  that after Ctrl+Shift+Down the selection's bottom edge sits
  at the very start of the paragraph *below* the visual
  selection (because the extend goes to the next paragraph's
  start, not the current one's end) and snaps to the previous
  paragraph's end accordingly. Shift-extend variants are
  unchanged.

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
