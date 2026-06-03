# CardMirror User Manual

CardMirror is an editor for competitive debate evidence. It reads and
writes the same Microsoft Word `.docx` files as
[Verbatim](https://paperlessdebate.com) — same Pocket / Hat / Block / Tag
structure, same F-key shortcuts, same send-to-speech workflow — but it's
a standalone app, so you don't need Word, macros, or an add-in. It runs
on Windows, macOS, and Linux, and in any modern browser.

This manual covers the whole editor. If you already know Verbatim, most
of it will feel familiar; skip to **[New in CardMirror](#new-in-cardmirror)**
for the parts that aren't.

> Throughout this manual, **Mod** means the platform's main modifier key:
> **Ctrl** on Windows and Linux, **⌘ Cmd** on macOS. Every keyboard
> shortcut shown is the default — all of them are rebindable in
> **Settings → Keyboard shortcuts**.

---

## Contents

1. [Getting started](#1-getting-started)
2. [Organizing your files](#2-organizing-your-files)
3. [Cutting and formatting cards](#3-cutting-and-formatting-cards)
4. [Editing structure](#4-editing-structure)
5. [Finding things](#5-finding-things)
6. [Quick Cards](#6-quick-cards)
7. [The multi-doc workspace](#7-the-multi-doc-workspace)
8. [Reading and delivering a speech](#8-reading-and-delivering-a-speech)
9. [Comments and notes](#9-comments-and-notes)
10. [Learn: spaced-repetition flashcards](#10-learn-spaced-repetition-flashcards)
11. [AI features](#11-ai-features)
12. [Saving and file formats](#12-saving-and-file-formats)
13. [Settings reference](#13-settings-reference)
14. [Appearance and accessibility](#14-appearance-and-accessibility)
15. [Keyboard shortcuts](#15-keyboard-shortcuts)
16. [What's not here yet](#16-whats-not-here-yet)
17. [Glossary](#17-glossary)

<a id="new-in-cardmirror"></a>
### New in CardMirror

These are the things CardMirror does that Verbatim can't. Each gets full
coverage in the section linked.

- **[A real multi-doc workspace](#7-the-multi-doc-workspace)** — three
  editable panes side by side, each with its own outline and history, and
  drag-copy between them.
- **[Read mode that locks the keyboard](#8-reading-and-delivering-a-speech)**
  — a non-destructive reading view at the podium that stray keystrokes
  can't edit.
- **[Spaced-repetition flashcards](#10-learn-spaced-repetition-flashcards)**
  — study your own evidence; cards live on your machine and never travel
  with a shared file.
- **[AI features](#11-ai-features)** — format a cite, ask a question about
  a selection, or generate alt text and tables from an image.
- **[Private notes](#9-comments-and-notes)** — a personal annotation that,
  like flashcards, stays out of the file you share unless you opt in.
- **[Cross-window Quick Cards](#6-quick-cards)** — a tagged snippet
  library with a search palette, available from any window.
- **[Drag-to-reorder everywhere](#4-editing-structure)** — pick up a card
  or a whole heading and drop it, in the outline or on the page, with
  drop targets that refuse invalid moves.
- **[Themes and accessibility](#14-appearance-and-accessibility)** — dark
  mode, dyslexia-friendly fonts, and per-style color overrides that never
  touch the file.
- **[A command palette](#5-finding-things)** that searches your files,
  your Quick Cards, and your settings from one box.

---

## 1. Getting started

### Installing CardMirror

Download the desktop app for your operating system from the
[Releases page](https://github.com/ant981228/cardmirror/releases), or try
the [live web preview](https://ant981228.github.io/cardmirror/) in a
browser. Full install instructions — including the one-time "unsigned
app" prompts on Windows and macOS — are in the project README.

CardMirror is alpha software. Save often and keep a Verbatim copy of
anything important until it has more miles on it.

### Desktop vs. web

You can run CardMirror two ways:

- **Desktop app** (recommended for tournaments). Fully offline, reads and
  writes files directly on your disk, supports autosave and crash
  recovery, and can search your file library.
- **Web preview** (good for trying it out, or working from a Chromebook
  or locked-down school machine). Same editor, but limited by the
  browser: no background file search, one window at a time, and pasting
  plain text needs an extra step (see [Paste Text](#paste-text-f2)).

Features that work in only one edition are marked **(desktop only)** or
**(web only)** throughout.

### First launch and the welcome guide

The first time you open CardMirror — and every time you press **New
Document** — you get an interactive welcome guide built out of real
Pockets, Hats, cards, and analytics. It's a live document: type in it,
press the shortcuts, and try things as you read. When you're done, turn
it off in **Settings → General → "Onboarding doc for new documents"** and
new documents will open blank instead.

### A two-minute tour of the ribbon

The ribbon across the top is grouped into panels, left to right:

- **File** — open, new, save, and the per-file autosave toggle.
- **Structural styles** — Pocket, Hat, Block, Tag, Analytic, Undertag.
- **Cite / Underline / Emphasis / Clear** — the inline marks.
- **Colors** — highlight, background, and font color, each a split button
  with a swatch picker.
- **Format** — tables, image insert, super/subscript, strikethrough,
  font size.
- **Doc / Card** menus — bulk operations on the document or a card.
- **View** — read mode, the navigation pane, and the comments column.
- **Comments cluster** — add a comment, a note, or a flashcard (and Ask
  AI, if AI is on).
- **Right side** — the keyboard-shortcut reference (📖), settings (⚙),
  and Home (🏠).

Toggle buttons light up to show the current state — including the **style
buttons**, which highlight to show what styles the text at your cursor
already carries (Cite / Underline / Emphasis, and Pocket / Hat / Block /
Tag / Analytic / Undertag).

The **status bar** at the bottom shows the word count and read-time
estimate (click it for details) and the zoom controls.

---

## 2. Organizing your files

Good structure is the foundation of everything else. As in Verbatim, you
build a file out of nested headings and cards, and the **navigation pane**
on the left gives you an outline you can fold, jump around, and reorder.

### Heading levels

CardMirror uses Verbatim's four heading levels, each on a function key:

| Level | Style | Shortcut | Use it for |
|-------|-------|----------|------------|
| 1 | **Pocket** | F4 | A top-level argument or file ("Politics DA") |
| 2 | **Hat** | F5 | A major grouping inside a pocket |
| 3 | **Block** | F6 | A set of related cards on one point |
| 4 | **Tag** | F7 | The claim line on a single card |

Put the cursor in a paragraph and press the key to convert it. As in
Verbatim, let the content dictate the structure — a short file might use
only Blocks and Tags. CardMirror is happy with files that skip levels or
start partway down; you don't have to start with a Pocket.

A single document can hold several "files" in a row, separated by blank
top-level headings — the same convention Verbatim uses for, say, a DA
shipped with its companion CP.

### Cards, analytics, and undertags

- A **card** is a Tag plus the evidence beneath it: the cite line and the
  body text. Tag (F7) creates one.
- An **analytic** (**Mod-F7**) is standalone analysis — a claim with no
  card behind it. It behaves like a card structurally: the lines beneath
  it belong to it.
- An **undertag** (**Mod-F8**) is a short annotation on a tag — a
  qualifier or sub-claim.

Loose, unstyled paragraphs are first-class: they can sit anywhere, which
is what makes bridge text and scratch regions just work. A paragraph
typed right after a card is pulled into it as body text; start a new
heading to break out.

### The navigation pane

Toggle it from the **Nav Pane** button in the ribbon's View group. It
mirrors Word's Navigation Pane, but does more:

- **Jump** — click any entry to scroll to it.
- **Fold** — double-click an entry to collapse or expand its subtree
  (this only changes the outline view, not the document).
- **Level filter** — the **1 · 2 · 3 · 4** buttons at the top set how
  deep the outline shows. Click **2** to see only Pockets and Hats; **4**
  to see everything down through Tags.
- **Multi-select** — Ctrl-click adds an entry to the selection,
  Shift-click selects a contiguous range.
- **Reorder** — drag an entry (or a multi-selection) up or down. It
  carries the whole heading and its contents and drops it wherever the
  structure allows. Hold **Ctrl** (or **Alt** on macOS) while dragging to
  **copy** instead of move.

---

## 3. Cutting and formatting cards

### How commands choose what to act on

Like Verbatim, most formatting commands follow a priority order to decide
what to operate on:

1. **If you have text selected, the command acts on the selection.**
2. **If nothing is selected, it falls back to the smallest structure your
   cursor is in** — the enclosing card or analytic, or the heading section
   you're sitting in, whatever level that is. **Condense** (F3) and
   **Shrink** (Mod-8) work this way.

Two wrinkles on the no-selection case:

- Some commands skip the scoped fallback and act on the **whole
  document** — the bulk cleanup commands like **Standardize Highlighting**
  and **Select Similar Formatting**.
- A few inline-mark commands fall back to the **word at the cursor**
  (**Underline**, **Emphasis**) or simply **do nothing** (**Cite**,
  **Highlight**), since those are text you normally select on purpose.

CardMirror extends this selection-awareness to more commands than
Verbatim does, but the model should feel familiar. The per-command notes
below say which fallback applies where it matters.

### The core formatting keys

| Function | Shortcut | What it does |
|----------|----------|--------------|
| **Cite** | F8 | Applies the Cite style — meant for just the author last name and date, not the whole line. Skips heading text in a mixed selection. |
| **Underline** | F9 / Mod-U | Toggles underline. With nothing selected, it underlines the word at the cursor. Press again to remove. |
| **Emphasis** | F10 | Applies the Emphasis style (a box, by default). Apply-only; use Clear or Underline to swap it off. |
| **Highlight** | F11 | Toggles the active highlight color. Press again to remove. |
| **Clear** | F12 | Strips direct formatting back to plain text (leaves highlighting — toggle that off separately). |
| **Bold / Italic** | Mod-B / Mod-I | Standard direct formatting. |

Super/subscript and strikethrough live in the **Format** menu (super and
subscript also have shortcuts: **Mod-Shift-=** and **Mod-=**).

<a id="paste-text-f2"></a>
### Paste Text (F2)

Use **F2** instead of Ctrl/Cmd-V when pasting card text from a webpage or
PDF — it strips the source's styles, which otherwise bloat your file and
clutter the outline. On desktop, F2 pastes immediately. **(Web only:)**
browsers won't let an app read the clipboard on a keypress, so in the web
edition F2 *arms* plain paste — the status bar shows a pill, and your next
Ctrl/Cmd-V pastes as plain text. If **Condense on paste** is on
(Settings → Editing), the pasted text is condensed as it lands.

### Condense, pilcrows, and case

The F3 family collapses card text the way Verbatim's does:

| Function | Shortcut | What it does |
|----------|----------|--------------|
| **Condense** | F3 | Collapses whitespace and merges paragraphs using your current paragraph-integrity and pilcrow settings. |
| **Condense without integrity** | Alt-F3 | Forces a merge to a single paragraph, no integrity markers. |
| **Condense with pilcrows** | Mod-Alt-F3 | Merges but marks the original breaks with small ¶ pilcrows. |
| **Uncondense** | Mod-Alt-Shift-F3 | Restores the original paragraph breaks from pilcrows. |
| **Toggle case** | Shift-F3 | Cycles the selection: lowercase → UPPERCASE → Title Case. |

**Paragraph integrity** is a toggle (in the ribbon's doc-ops controls and
in Settings). With it on, condense keeps your paragraph breaks (as
pilcrows, or as real breaks if pilcrows are off) instead of flattening
everything to one block. As in Verbatim, when you cut a PDF that breaks
every line, turn integrity off for that article so you don't get a
pilcrow on every line, then turn it back on.

The **headingMode** setting controls how a condense that spans headings
behaves — `respect` (the default; leaves headings separate, merges only
body runs), `strict` (refuses to touch a selection that includes
structure), or `demolish` (flattens everything touched).

### Shrink (Mod-8)

**Shrink** cycles the non-underlined text in the current card or
analytic through progressively smaller sizes and back to normal, so a
card reads compactly at the podium. By default it leaves **omission
notes** — bracketed text like `[Table Omitted]` or `<Figure Omitted>` —
at full size; you can turn that protection off in Settings.

### Citations

- **Cite (F8)** applies the cite character style to the author and date,
  as above.
- **Copy Previous Cite (Alt-F8)** pulls the cite from the previous card
  into the current one — handy when cutting a long article.
- **Format Cite from selection (Mod-Shift-X)** uses AI to turn a pasted
  citation or URL into a properly styled cite (see
  [AI features](#11-ai-features)).
- **Create Reference** copies a formatted reference for the current
  document to your clipboard.

### Colors: highlight, background, and font color

Each of the three color controls is a **split button**: the main button
applies the active color, and the small arrow opens a 16-swatch picker
(the top-left swatch removes the color). The picker remembers your last
color per control.

- **Highlight (F11)** — toggles the active highlight on the selection.
  Supports all 15 Word highlight colors.
- **Background / shading (Mod-F11)** — a separate background color that
  can coexist with a highlight; takes any color.
- **Font color** — applies a text color; the "Automatic" swatch removes
  it.

**Paintbrush mode** (the way Word's highlighter works): click a main
color button with *nothing* selected to arm it. The cursor changes, and
every drag-select you make applies that color until you press **Esc** or
click the button again.

The **acronym variants** mark just the first letter of each word in the
selection: **Alt-F10** (emphasis) and **Alt-F11** (highlight) — for
marking the source letters of an acronym, like **U**nited **S**tates.

For cleanup, the Card/Doc menus include **Standardize Highlighting** (and
background) to convert every color in scope to your active one, and
converters between highlight and background.

**Tip:** right-click any structural-style or character-style button to
select *every* instance of that style in the document — then apply a
color to all of them at once.

### Tables and images

- **Insert Table** (Format menu) drops in a table; further menu items add
  or delete rows and columns and merge or split cells. Tables round-trip
  to Word with their borders and shading intact.
- **Insert Image** (Format menu) inserts an image from a file; you can
  also paste one from the clipboard. Right-click an image to **edit its
  alt text** (or have AI write it) and to **generate a table from the
  image** (see [AI features](#11-ai-features)). Alt text round-trips to
  Word.

### Document and card cleanup

The **Doc** and **Card** ribbon menus hold document- and card-level
operations. From the **Doc** menu: **Convert Analytics to Tags**,
**Convert Cited Analytics to Tags** (the same, but only for analytics
that actually carry a cite — bare analytics stay analytics), **Fix
Formatting Gaps**, and **Remove Hyperlinks**. **Select Similar
Formatting** selects everything that matches the cursor's styles.

From the **Card** menu's Excerpt section, **Extract Undertag** takes your
selection inside a card and drops it as a new undertag beneath the tag
(below any existing undertags), leaving the original text in place — handy
for pulling a key phrase up into an undertag. A Settings → Editing toggle,
**"Extract Undertag: wrap in quotes"** (off by default), controls whether
the excerpt is quoted.

Verbatim's other bulk cleanup macros (AutoNumberTags, ReformatAllCites,
ConvertToDefaultStyles, and the rest) aren't in CardMirror.

---

## 4. Editing structure

CardMirror follows Word's keyboard and mouse conventions for moving
around and selecting text, and — because it knows what a card *is* —
editing around a card's edges behaves predictably instead of letting you
create half-formed structures.

### Moving the cursor

Alongside the usual arrow keys, CardMirror has Word-style jumps. Use
**Ctrl** on Windows/Linux or **Alt/Option** on macOS — both work
everywhere:

- **Ctrl/Alt-Left / -Right** — jump to the start of the previous / next
  word, crossing into the neighboring paragraph at a line's edge.
- **Ctrl/Alt-Up / -Down** — jump by paragraph. Up lands at the start of
  the current paragraph first, then the previous one; Down goes straight
  to the next paragraph.
- **PageUp / PageDown** — jump by heading, to the previous / next
  structural marker (Pocket, Hat, Block, Tag, Analytic), skipping over
  body text — a quick way to move through a file by its outline.

Hold **Shift** with any of these to **extend the selection** instead of
just moving the cursor, exactly as in Word. So **Shift-Ctrl/Alt-Right**
selects to the end of the next word, **Shift-Ctrl/Alt-Down** selects to
the next paragraph, and **Shift-PageDown** selects to the next heading.
The selection grows or shrinks from a fixed anchor as you keep going.

### Selecting text with the mouse

Mouse selection mirrors Word too:

- **Double-click** selects a word; keep dragging and the selection extends
  word by word (the word you started on stays fully selected even if you
  drag back the other way).
- **Triple-click** selects the whole paragraph; dragging then extends a
  paragraph at a time.
- **Click and drag** selects by character — but once you drag past the
  first word it snaps up to selecting whole words (and back to characters
  if you drag back inside that first word), again matching Word.
- **Shift-click** extends the current selection to where you click, using
  whatever unit you last selected by: Shift-click after a double-click
  extends by word, after a triple-click by paragraph.

### Converting blocks

Pressing a structural key (F4–F7, Mod-F7, Mod-F8) converts the current
block:

- On a plain paragraph or heading, it changes the style in place; **Tag**
  and **Analytic** wrap the block into a new card or analytic.
- On a card's **tag**, a heading key (F4–F6) dissolves the card and lifts
  its body out; **Mod-F7** swaps the card to an analytic.
- Inside a card's **body**, a heading key splits the card at that line.
- With **several paragraphs selected**, the style applies to all of them
  at once.

Pressing the same heading key again clears indentation while keeping the
style — the way to reset an over-indented line.

### Editing at card boundaries

When your cursor is in a tag (or analytic), a few keys behave
deliberately rather than the way they would in Word:

- **Backspace at the start of a tag** removes a blank line above it;
  otherwise it does nothing (it won't merge body text up into the
  heading).
- **Delete at the end of a tag** merges with the next tag if there is
  one; otherwise nothing.
- **Enter** at the end of a tag starts a card body; in the middle splits
  the card; at the start inserts an empty card above.

Empty tags and stray blank lines clean themselves up as you delete around
them.

### Indenting

**Tab** and **Shift-Tab** indent and outdent the current block (or
selection) by one step. Indentation is visual only — it doesn't change a
heading's outline level. (Inside a table, Tab moves between cells.)

### Drag-and-drop

Two ways to move things, both schema-aware (drop targets that would
create an invalid structure don't light up, and bad drops are refused):

- **From the navigation pane** — drag any heading (or multi-selection) to
  reorder; Ctrl/Alt-drag to copy.
- **From the page** — hold **Mod-Shift-Alt** and drag a card or analytic
  directly. The cursor switches to a grab cursor and the card's boundary
  highlights as you go.

In the [multi-doc workspace](#7-the-multi-doc-workspace), dragging across
panes copies the content into the other document.

---

## 5. Finding things

### Find and Find/Replace

- **Find (Mod-F)** opens the find bar.
- **Find and Replace (Mod-H)** adds a replace field.
- **Find without category grouping (Alt-F)** orders matches by position
  rather than grouping them by structural type.

### The Search Everything palette (Mod-Shift-Space)

A single floating box that searches across everything CardMirror knows
about — your Quick Cards, the dropzone, every command, every setting, and
your files — and acts on what you pick. It opens centered over the active
pane with results listed above the bar; **↑/↓** move the selection,
**Enter** activates it, and **Esc** closes.

By default it searches **everything at once**: with nothing typed it just
shows a hint, and as you type it blends matches from all the sources
below. To narrow to one source, start your query with its **one-letter
prefix** followed by a space. With a prefix and no query, you *browse*
that whole source.

| Prefix | Searches | Enter |
|--------|----------|-------|
| *(none)* | Everything — cards, commands, settings, files by name, and the dropzone (if on) | Acts on the selected row |
| **`q`** | Your **Quick Cards** (honoring your active tag filter) | Inserts the card at your cursor |
| **`d`** | The **dropzone** (only when it's turned on) | Inserts the item at your cursor |
| **`c`** | Ribbon **commands** — each row shows its current shortcut | Runs the command |
| **`s`** | **Settings** — both the section tabs and individual settings | Opens that tab and scrolls to the setting |
| **`f`** | Your **`.cmir` files** by filename *(desktop only)* | Opens the file |

Searching **version** (or "about this install") shows the running app
version, and Enter jumps to the About this install section of Settings.

**Inserting evidence.** Quick-card, dropzone, and in-file results drop in
at your cursor (the same insertion the send-to-speech and Quick Card
buttons use). If your cursor is in the middle of a paragraph, CardMirror
asks you to confirm first — you can turn that prompt off in Settings.

**Diving into a file (`f`, desktop only).** Press **Tab** on a selected
file to dive *into* it without leaving the palette. With the query empty
you get the file's outline — indented by level and collapsible, like the
navigation pane — and as you type you search that file's blocks, tags,
cites, and analytics. **Enter** inserts the chosen object straight into
your current document; **Esc** returns you to the file list with your
search restored. Undo (**Mod-Z**) works while you're diving, so you can
take an insert back without closing the palette.

**Pinning and speed.** Press **Alt-P** to pin or unpin the selected file
(★). Pinned files sort to the top and stay parsed for instant search;
your pinned and recent files are warmed in the background, and the file
list refreshes itself as files change on disk.

**Quick Card tags.** With a quick-card result selected, **Tab** opens the
tag filter (the same active-tag filter the ribbon's Tag Picker controls),
so you can narrow cards by topic.

This palette is the in-editor seed of full corpus search: it already
reaches files that aren't open, but a persistent, library-wide *content*
index is still [planned](#16-whats-not-here-yet) — for now, searching
*inside* a file happens one file at a time, when you dive in.

---

## 6. Quick Cards

Quick Cards are a personal library of reusable snippets — a stock card, a
standard overview, an analytic you paste constantly. Unlike Verbatim's
shortcut-word system, CardMirror's are tagged and searchable, and they're
available from **any window**.

- **Add** — select content and choose **Add** in the Quick Cards group
  (or run *Add Quick Card*). Give it a name and tags.
- **Search and insert** — open the palette with **Mod-Shift-Space** and
  the **`q`** prefix (or the **Search** button), filter by tag, and
  insert the match at your cursor.
- **Manage** — the Manage button opens the full list to rename, retag, or
  delete.

---

## 7. The multi-doc workspace

Verbatim shows you one document at a time. CardMirror can show **three
editable panes side by side**, which makes assembling a speech,
comparing files, and cutting against a block practical without juggling
windows.

### Turning it on

Enable **Settings → General → Multi-doc workspace** and reload. With one
or two documents open it looks like a normal editor; the layout fills in
as you open more.

### Working with slots

- Each of the three slots is independent: its own outline section, its own
  footer word count (with its own **Σ** Word Count button), and its own
  document history.
- **Mod-1 / Mod-2 / Mod-3** focus a slot; **Mod-Shift-1/2/3** move the
  active document into a slot.
- Each slot keeps a **back/forward history** of the documents you've
  opened in it, so hopping to a related file and back returns you exactly
  where you were.
- **Expand** a slot to full width with **Mod-Shift-F**, and restore it
  the same way.

### Layouts

When all three slots are full, two layouts are available (pick in
Settings → General): **Compact** shows all three side by side, and
**Wide-scroll** shows two at a comfortable width with the edge of the
third peeking — click the peek to snap to it.

### Moving content between panes

Drag a card, or a heading from a pane's outline, into another pane to
**copy** it there (the source keeps its copy). This is the same gesture
as [send-to-speech](#8-reading-and-delivering-a-speech).

---

## 8. Reading and delivering a speech

### Read mode

Click the **eye** in the ribbon (or bind a key to *Toggle Read Mode*) to
enter read mode — CardMirror's version of Verbatim's invisibility, with
two improvements:

- It hides everything that isn't read aloud: only **Tags, Cites,
  Analytics, and highlighted text** stay visible. Loose paragraphs,
  undertags, and un-highlighted body text disappear.
- It **locks the keyboard**, so a stray key or trackpad twitch at the
  podium can't edit your file. The one editing action it allows is
  dropping a **reading-position marker** — visible colored text like
  "Marked 7:32" at your cursor, matching Verbatim's red-text convention —
  for when you stop mid-card.

Press the eye again or **Esc** to exit. In the
[multi-doc workspace](#7-the-multi-doc-workspace), read mode is
per-pane, so one slot can be a reading surface while another stays
editable.

### Read-time estimates

The status bar shows live read-time estimates — how long the visible
(read-aloud) content would take to deliver. Configure your readers in
**Settings → General → "Readers for read-time estimates"**: each reader
is a name plus a words-per-minute rate, and you can list as many as you
like. The **first two** readers appear live in the status bar; the
numbers update as you highlight and trim.

Click the word count (the **Σ** button / Word Count) for the full
breakdown — that dialog shows the read time for **every** reader on your
list, not just the two in the bar, and the word count and read time for
the current selection.

By default the status bar always reflects the **whole document**. Turn on
**Settings → General → "Live selection word count"** to have the bar
switch to the **selection's** word count and read time the moment you
select text — handy for checking how long a block will take before you
send it. It's off by default because re-counting on every selection
change can lag on very large files; with it off, use the **Σ** button to
get a selection's read time on demand.

### Send-to-speech and the dropzone

Assemble a speech document by sending cards into it:

1. **Mark a speech doc.** Open the document you'll read from and mark it
   as the active speech (in the Speech group, or *Mark Active as Speech*).
2. **Send cards.** From a source file, press **`` ` ``** (backtick) to
   send the current card or selection to the speech doc at your cursor,
   or **Alt-`` ` ``** to append it at the end. You can also drag a card or
   heading across panes.
3. **Read.** Switch the speech doc to read mode; everything that isn't
   read aloud (loose paragraphs, undertags, un-highlighted text) drops
   away, leaving what you'll deliver.

The **dropzone** is a holding shelf: press **Mod-`` ` ``** to send a card
there and pull it back later — useful for parking evidence while you
rearrange.

### Saving a send doc

When it's time to share a speech with the judge or opponent, use the
**Send Doc** options described under
[Saving and file formats](#12-saving-and-file-formats) — a clean copy
with comments, analytics, and undertags stripped — either through Save As
or in one keystroke with **Save Send Doc (Mod-Alt-S)**.

---

## 9. Comments and notes

Toggle the **comments column** on the right with the Comments button. It
holds four kinds of entity, each pinned beside the text it refers to:

| Entity | Travels in the shared file? | What it's for |
|--------|-----------------------------|----------------|
| **Comment** | Yes (standard Word comment) | Feedback others should see |
| **AI note** | No, unless you opt in | Answers from Ask AI |
| **Private note** | No, unless you opt in | Your own annotations |
| **Flashcard** | No, never | Study material (see [Learn](#10-learn-spaced-repetition-flashcards)) |

- **Add a comment** to a selection from the comments cluster; comments
  are threads — others can reply.
- **Add a note (Mod-Shift-N)** for a private annotation. Notes are green
  throughout — chip, in-text highlight, card accent — and behave like
  comments (a root message plus replies) but stay on your machine.
- **Edit in place** — every comment, reply, and note has a pencil button;
  Enter saves, Esc cancels.
- Click a note's or comment's colored text to jump to its card.

**Privacy.** Private notes, AI notes, and flashcards live in your local
layer and **do not** get written into the `.docx`/`.cmir` you share — so
your study material and private thoughts don't leak to opponents. If you
*want* to include them (say, sharing notes with a partner), the **Save As**
dialog has opt-in checkboxes (off by default) to write private notes
and/or AI comments into the saved file as real Word comments. Flashcards
never travel.

A comment or note whose anchor text was edited away by someone else moves
to an **Unanchored** section at the bottom of the column, with a
**Re-ground** button: select text and re-attach it.

---

## 10. Learn: spaced-repetition flashcards

CardMirror can turn your evidence into spaced-repetition flashcards, so
you can actually remember your files. This has no Verbatim equivalent.

The cards live **only on your machine** and never travel with a shared
file — your study material stays yours. (The design and the research
behind it are written up in the project's ARCHITECTURE doc.)

### Making a card

Select some text and run **Create Flashcard** (in the comments cluster).
You can make two kinds:

- **Question and answer** — write a question and its answer.
- **Cloze deletion** — hide a word or phrase in the selected sentence;
  reviewing asks you to recall the hidden part.

The card is **anchored** to the text you selected, and shows up in the
comments column beside it.

### Reviewing

The **Home screen's Learn section** shows what's due and runs your
reviews. In a session, you see the front of each card, reveal the answer,
and grade yourself **remembered** or **forgotten**. Remembered cards move
out along an expanding schedule; a forgotten card is shown again later in
the **same session** before you finish — a retry step that measurably
improves recall.

You can review everything due, or scope a session to a single file or
deck.

### Managing cards

**Manage Flashcards** lists your cards grouped by file, where you can
edit, suspend, or delete them. If a card's anchor text changes or its
file moves, the card becomes **unanchored** — it keeps its schedule, and
you can **re-ground** it by selecting text again, or link it to a
different file.

### AI-assisted cards

With [AI features](#11-ai-features) on, CardMirror can draft cards for you
from selected evidence — a starting point you edit, not a finished card.

---

## 11. AI features

A handful of features call out to Anthropic's Claude. They're **off by
default** and require a key.

### Setup

1. Get an API key from
   [console.anthropic.com](https://console.anthropic.com/) (a small
   amount of credit; there's no free API tier).
2. Open **Settings → Comments & AI**, turn **AI features** on, and paste
   your key into the **Anthropic API key** field.

Your key is stored locally and sent directly to Anthropic when you
trigger a feature — it doesn't pass through any third-party server. With
AI off, every AI control is hidden, and AI features gray out cleanly when
you're offline.

### What AI can do

| Feature | How to run it | What it does |
|---------|---------------|--------------|
| **Format Cite** | Mod-Shift-X on a selection | Turns a pasted citation or URL into a properly styled cite, with the cite mark on the author and date. |
| **Ask AI about selection** | Mod-Shift-Q on a selection | Asks Claude a question about the selected text (with the surrounding card as context); the answer lands as an AI note. Type **@AI** in a note thread to ask a follow-up. |
| **Generate alt text** | Right-click an image | Writes an alt-text description and inserts it under the image; offers to keep or regenerate if the image already has alt text. |
| **Generate table from image** | Right-click an image | Extracts a real, editable table from a picture of one. |
| **Draft a flashcard** | From Create Flashcard | Drafts a question/answer or cloze from the selection. |

You can set the author name AI notes are attributed under, and customize
the cite-formatting prompt, in Settings → Comments & AI.

**Clod mode.** A bit of fun, off by default (Settings → Comments & AI →
**Enable Clod mode**). While the AI is composing a reply, the
"Thinking…" placeholder is replaced by a friendlier persona — "Clod" —
who cycles through time-of-day activities like "Clod is making toast…" or
"Clod is reading by candlelight…". The persona's name, pronouns, and
activity lists are all customizable.

---

## 12. Saving and file formats

### Two formats

- **`.cmir`** — CardMirror's native format. Lossless, and required for
  autosave and crash recovery. Use it for your working files.
- **`.docx`** — Word/Verbatim format. Use it to share. CardMirror writes
  docx that's indistinguishable from Verbatim's own output; some
  CardMirror-only extras (private notes, AI notes, flashcards) are left
  out unless you opt in.

### Saving

- **Save (Mod-S)** / **Save As… (Mod-Shift-S)**.
- **Autosave** is a per-file toggle in the ribbon; it remembers its
  setting per document across close and reopen, and applies to `.cmir`
  files. **(Desktop only.)**

### Save As presets

The Save As dialog offers presets so you can produce the right kind of
copy:

- **As-is** — a full copy.
- **Send Doc** — a clean reading copy with comments, analytics, and
  undertags stripped, for the judge or opponent (optionally with a
  `SEND_` filename prefix).
- Checkboxes (off by default) let you include **private notes** and **AI
  comments** in the saved file.

**Save Send Doc (Mod-Alt-S)** does the Send Doc export in one keystroke,
no dialog. Two Settings → General options control where it goes (the
source file's folder, or a fixed folder you pick).

### Crash recovery

**(Desktop only.)** CardMirror journals your work as you go, so if it's
killed mid-edit it offers to recover the unsaved document the next time
you launch.

### Updates

**(Desktop only.)** **Help → Check for Updates…** checks manually.
Auto-check on launch is off by default — turn it on in Settings → General.
Linux users who installed via the AUR update with `yay -Syu`.

---

## 13. Settings reference

Open settings with the **gear** icon. Settings are grouped into tabs.

### General

Workflow and document behavior: the **multi-doc workspace** toggle and
layout; **readers** for read-time estimates; **live selection word
count**; the **onboarding doc for new documents** toggle; **file search
root** and which object types it lists; default **new-document format**;
**Send Doc** destination and folder; **dropzone** visibility; **check for
updates on launch**; **condense on paste**.

### Appearance

How things look: **theme** (light / dark / system); **icon set** (modern
line icons or classic glyphs); per-style **display colors**; fonts and
sizes; line heights; the formatting-panel display mode (labels /
shortcuts / both) and style previews; tooltip behavior; timer display.

### Editing

Editing behavior: **paragraph integrity** and **pilcrows** for condense;
**heading mode** for selection condense; **shrink** omission protection;
undertag extraction; paste behavior; Quick Card options.

### Keyboard shortcuts

Rebind any command. Search the command, click its binding, and press the
new keys. A few window-level shortcuts (like Mod-W) are handled by the OS
and can't be overridden.

### Comments & AI

**AI features** master toggle; **Anthropic API key**; the **comment
author** name; the AI cite-formatting prompt; AI behavior options.

### Accessibility

Reduce motion; **color overrides** for highlight, shading, and document
text; UI and body **font** choices (including dyslexia-friendly fonts);
and the other accessibility presets described next.

---

## 14. Appearance and accessibility

Everything visual in CardMirror is customizable, and — importantly — your
display choices **never change the file**. The way you like to see Tags is
separate from how Tags look for everyone else (to change that for
everyone, apply direct formatting in the document itself).

- **Themes.** Light, dark, or follow the system. *Cycle Theme* rotates
  through them.
- **Icon sets.** Modern line icons (default) or classic emoji/text
  glyphs.
- **Per-style colors.** Set the color of Analytics, Undertags, and other
  styles for your own viewing.
- **Accessibility overrides.** Remap highlight and shading colors,
  override document text color, and pick dyslexia-friendly body fonts
  (Atkinson Hyperlegible, Lexend, OpenDyslexic, and others). CardMirror
  also forces readable contrast on highlighted and shaded text
  automatically.
- **Zoom.** **Mod-=** / **Mod--** zoom the document; the status bar shows
  the level (click to reset). **(Desktop only:)** **Mod-Alt-=** /
  **Mod-Alt--** scale the whole interface, not just the document.

---

## 15. Keyboard shortcuts

All defaults; rebind any of them in **Settings → Keyboard shortcuts**.
**Mod** = Ctrl (Windows/Linux) or ⌘ (macOS).

### Structure and formatting
| Shortcut | Action |
|----------|--------|
| F4 / F5 / F6 / F7 | Pocket / Hat / Block / Tag |
| Mod-F7 / Mod-F8 | Analytic / Undertag |
| F8 | Cite |
| F9 / Mod-U | Underline |
| F10 / Alt-F10 | Emphasis / Emphasize acronym |
| F11 / Alt-F11 | Highlight / Highlight acronym |
| Mod-F11 | Background color |
| Mod-B / Mod-I | Bold / Italic |
| Mod-Shift-= / Mod-= | Superscript / Subscript |
| F12 | Clear formatting |
| F2 | Paste Text |
| F3 / Alt-F3 / Mod-Alt-F3 | Condense / no integrity / with pilcrows |
| Mod-Alt-Shift-F3 | Uncondense |
| Shift-F3 | Toggle case |
| Mod-8 | Shrink |
| Alt-F8 | Copy previous cite |
| Tab / Shift-Tab | Indent / Outdent |

### Moving and selecting
On macOS, use **Alt/Option** in place of **Ctrl**. Add **Shift** to any of
these to extend the selection.
| Shortcut | Action |
|----------|--------|
| Ctrl-Left / Ctrl-Right | Previous / next word |
| Ctrl-Up / Ctrl-Down | Previous / next paragraph |
| PageUp / PageDown | Previous / next heading |

### Find, files, and Quick Cards
| Shortcut | Action |
|----------|--------|
| Mod-F / Mod-H | Find / Find and Replace |
| Alt-F | Find without grouping |
| Mod-Shift-Space | Search Everything palette (files `f`, Quick Cards `q`) |

### Speech, comments, and AI
| Shortcut | Action |
|----------|--------|
| `` ` `` / Alt-`` ` `` | Send to speech at cursor / at end |
| Mod-`` ` `` | Send to dropzone |
| Mod-Shift-N | Add note to selection |
| Mod-Shift-Q | Ask AI about selection |
| Mod-Shift-X | Format cite from selection |

### Files and view
| Shortcut | Action |
|----------|--------|
| Mod-S / Mod-Shift-S | Save / Save As |
| Mod-Alt-S | Save Send Doc |
| Mod-= / Mod-- | Zoom in / out |
| Mod-Alt-= / Mod-Alt-- / Mod-Alt-0 | Interface scale up / down / reset (desktop) |

### Multi-doc workspace
| Shortcut | Action |
|----------|--------|
| Mod-1 / Mod-2 / Mod-3 | Focus slot 1 / 2 / 3 |
| Mod-Shift-1/2/3 | Move active doc to slot |
| Mod-Shift-F | Expand / restore the focused slot |
| Mod-W | Close the focused document or window |

The full, current list is always in the app: press **📖** in the ribbon.

---

## 16. What's not here yet

CardMirror is in active development. Planned, but not built yet:

- **Verbatim Flow integration** — the Excel-based flowing tool.
- **Library-wide search** — a persistent index of your whole evidence
  corpus. For now, the [Search Everything palette](#5-finding-things)
  searches files by name and lets you dive into one at a time.
- **Transclusion** — live references to a card that lives in another file.
- **Real-time collaboration.**
- **Numbered and bulleted lists**, and per-style display spacing.
- **Robust screen-reader support and more accessibility presets** —
  fuller keyboard/ARIA semantics, plus high-contrast and colorblind
  palettes on top of the customization already shipped.

Deliberately out of scope (CardMirror drops these on import and never
writes them): page/section layout, footnotes, and Word's internal
revision metadata.

### Notes for Verbatim users

- Several of Verbatim's bulk cleanup macros — AutoNumberTags,
  DeNumberTags, ReformatAllCites, FixFakeTags, ConvertToDefaultStyles, and
  similar — aren't in CardMirror, and aren't currently planned. The
  cleanup commands that are here: Convert Analytics to Tags, Fix
  Formatting Gaps, Remove Hyperlinks, and Select Similar Formatting.
- **OCR**, **caselist** upload, **Tabroom** integration, and **vTub**
  don't exist in CardMirror yet.
- CardMirror is pageless (like Word's Web Layout); it round-trips page
  breaks but doesn't show page boundaries while editing.

---

## 17. Glossary

- **Pocket / Hat / Block / Tag** — the four heading levels (Word Heading
  1–4).
- **Card** — a Tag plus its cite and body text.
- **Analytic** — standalone analysis with no card behind it.
- **Undertag** — a short annotation on a tag.
- **Cite mark** — the character style on an author's name and date.
- **Condense** — collapse a card's paragraphs into a tight block.
- **Pilcrow** — the small ¶ that marks an original paragraph break in a
  condensed card.
- **Shrink** — cycle a card's un-underlined text through smaller sizes.
- **Read mode** — a non-destructive reading view that hides non-read-aloud
  content and locks editing.
- **Read-aloud content** — Tags, Cites, Analytics, and highlighted text:
  what read mode keeps and read-time counts.
- **Send-to-speech** — sending a card into your speech document.
- **Dropzone** — a holding shelf for cards you've set aside.
- **Send Doc** — a clean copy for sharing, with comments, analytics, and
  undertags stripped.
- **Quick Card** — a tagged, reusable snippet in your personal library.
- **Flashcard** — a spaced-repetition study card anchored to evidence,
  stored only on your machine.
- **Anchor / unanchored / re-ground** — how a flashcard or note attaches
  to a span of text; an anchor that can't be found is unanchored until you
  re-ground it.
- **`.cmir` / `.docx`** — CardMirror's native format / the Word format
  for sharing.
- **Mod** — Ctrl on Windows/Linux, ⌘ on macOS.
