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
12. [Send to Verbatim Flow](#12-send-to-verbatim-flow)
13. [Voice control](#13-voice-control)
14. [Saving and file formats](#14-saving-and-file-formats)
15. [Settings reference](#15-settings-reference)
16. [Appearance and accessibility](#16-appearance-and-accessibility)
17. [Keyboard shortcuts](#17-keyboard-shortcuts)
18. [What's not here yet](#18-whats-not-here-yet)
19. [Glossary](#19-glossary)

## 1. Getting started

### Installing CardMirror

Download the desktop app for your operating system from the
[Releases page](https://github.com/ant981228/cardmirror/releases), or try
the [live web preview](https://ant981228.github.io/cardmirror/) in a
browser. Full install instructions — including the one-time "unsigned
app" prompts on Windows and macOS — are in the project README.

CardMirror is beta software. Save often and keep a Verbatim copy of
anything important until it has more miles on it.

### Desktop vs. web

You can run CardMirror two ways:

- **Desktop app** (recommended for tournaments). Fully offline, reads and
  writes files directly on your disk, supports autosave and crash
  recovery, and can search your file library.
- **Web edition** (good for trying it out, or working from a Chromebook
  or locked-down school machine). The same editor in a browser — and on
  Chromium browsers you can **install it as an app** for most of the
  desktop experience.

**Installing the web edition as an app (Chrome / Edge / ChromeOS).** Open
it and click the **Install** button in the address bar to run CardMirror in
its own window — offline, and updating itself when you relaunch. On a
Chromebook, this is the best way to run it. Installed, the web app covers
most of the desktop experience; what follows is only what still differs.

A few capabilities still need the **desktop app**: the background
**[file-library search](#the-search-everything-palette-mod-shift-space)**,
**folder-wide** bulk operations (the web app runs Clean / Convert /
Compress one file at a time instead),
**[Send to Verbatim Flow](#12-send-to-verbatim-flow)**,
**[voice control](#13-voice-control)**, and
**[card sharing](#card-sharing-send-and-receive-pills)**. And saving in
place needs a Chromium browser — in **Firefox and Safari** the editor runs
but **[Save](#saving)** downloads a copy instead.

Features that work in only one edition are marked **(desktop only)** or
**(web only)** throughout, so you'll find the specifics in each relevant
section as you read.

**The web edition has a mobile layout.** Open CardMirror in a phone or
tablet browser — or any browser window narrower than about 768px — and
it switches to a view-first **mobile layout**: a slim top bar, the
document full-bleed, a **Read** button for read mode (tap the page to
drop or remove a reading marker), pinch-zoom, an outline drawer, and a
touch-sized Settings page. **Use desktop layout** switches back to the
full editor.

### First launch and the welcome guide

The first time you open CardMirror — and every time you press **New
Document** — you get an interactive welcome guide built out of real
Pockets, Hats, cards, and analytics. It's a live document: type in it,
press the shortcuts, and try things as you read. When you're done, turn
it off in **Settings → Files → "Onboarding doc for new documents"** and
new documents will open blank instead.

### A two-minute tour of the ribbon

The ribbon across the top is grouped into panels, left to right:

- **File** — open, new, save, and the autosave toggle.
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

<a id="new-in-cardmirror"></a>
### New in CardMirror

If you're coming from stock Verbatim, these are the new features. Each is
covered in full in the section linked.

- **[Built-in Analytic and Undertag styles](#cards-analytics-and-undertags)**
  — both ship as first-class structural styles with their own shortcuts and
  structure-aware handling (read mode, send-to-speech, Extract Undertag).
  Verbatim doesn't ship them; you'd have to roll your own Word styles, which
  it wouldn't treat as structure.
- **[Highlight and background color as independent tracks](#colors-highlight-background-and-font-color)**
  — highlight and background color (or shading) are separate, coexisting
  colors, each with its own apply / standardize / convert functions that
  leave the other untouched.
- **[Acronym variants](#colors-highlight-background-and-font-color)** —
  emphasize or highlight just the source letters of an acronym (the **U**
  and **S** in United States) in one keystroke.
- **[Shrink protections and Condense with warning](#shrink-mod-8)** —
  Shrink can keep omission notes, warning markers, and your own custom
  strings at normal size while everything else shrinks.
- **[Repair paragraph integrity](#repair-paragraph-integrity-workflow)** —
  rebuild a card's paragraph breaks one at a time when a PDF or a paste
  collapsed them into a single run.
- **[Create Reference](#citations)** — copy a formatted reference for the
  current document to the clipboard, built in.
- **[Extract Undertag](#document-and-card-cleanup)** — pull a phrase out of
  a card into a new undertag beneath the tag, leaving the original in place.
- **[Editing at card boundaries](#editing-at-card-boundaries)** — deliberate
  behavior for what backspace, delete, and merging do at the edges of a
  card, tag, or analytic, so the structure stays intact.
- **[Structure-aware Find](#5-finding-things)** — find results group by
  structural type by default (with a flag to order by position instead).
- **[A command palette](#5-finding-things)** that searches your files,
  your Quick Cards, the dropzone, and your settings from one box.
- **[Cross-window Quick Cards](#6-quick-cards)** — a tagged snippet
  library with a search palette, available from any window.
- **[Drag-to-reorder everywhere](#4-editing-structure)** — pick up a card
  or a whole heading and drop it, in the outline or on the page, with
  drop targets that refuse invalid moves.
- **[A real multi-doc workspace](#7-the-multi-doc-workspace)** — three
  editable panes side by side, each with its own outline and history, and
  drag-copy between them.
- **[Read mode that locks the keyboard](#8-reading-and-delivering-a-speech)**
  — a non-destructive reading view at the podium that stray keystrokes
  can't edit, with a reading-position marker for stopping mid-card.
- **[Read-time word counts](#read-time-estimates)** — the status bar shows
  how long the visible (or selected) text takes to read, per reader, not
  just a raw word count.
- **[Send-to-speech with a dropzone](#send-to-speech-and-the-dropzone)** —
  send cards and headings into a speech doc, with a holding shelf for
  staging evidence before you place it.
- **[Card sharing](#card-sharing-send-and-receive-pills)** — send cards to
  other people's machines, end-to-end encrypted, with Send and Receive pills
  beside the dropzone. *(Desktop only.)*
- **[Spaced-repetition flashcards](#10-learn-spaced-repetition-flashcards)**
  — study your own evidence; cards live on your machine and never travel
  with a shared file.
- **[Private notes](#9-comments-and-notes)** — a personal annotation that,
  like flashcards, stays out of the file you share unless you opt in.
- **[AI features](#11-ai-features)** — format a cite, repair OCR/PDF
  extraction errors, ask a question about a selection, or generate alt text
  and tables from an image.
- **[Translate a selection](#11-ai-features)** — to the clipboard, with a
  keyless backend that works even without AI features set up.
- **[Display customizations and accessibility](#16-appearance-and-accessibility)**
  — themes, dyslexia-friendly fonts, per-style colors, and color overrides
  that change how styles look on your screen without altering the document
  or its style definitions.

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

- A **card** is a Tag plus the evidence beneath it: the cite and the
  body text. Tag (F7) creates a card.
- An **analytic** (**Mod-F7**) is standalone analysis — a claim with no
  card behind it. It behaves like a card structurally: the lines beneath
  it belong to it.
- An **undertag** (**Mod-F8**) is a short annotation on a tag — a
  qualifier or sub-claim.

Loose, unstyled paragraphs can sit outside of a card, but will be absorbed
into the card if they are directly beneath a tag.

### The navigation pane

Toggle it from the **Nav Pane** button in the ribbon's View group. It
mirrors Word's Navigation Pane, but does more:

- **Jump** — click any entry to scroll to it.
- **Fold** — double-click an entry to collapse or expand its subtree
  (this only changes the outline view, not the document).
- **Level filter** — the **1 · 2 · 3 · 4** buttons at the top set how
  deep the outline shows. Click **2** to see only Pockets and Hats; **4**
  to see everything down through Tags.
- **Multi-select** — Mod-click adds an entry to the selection,
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
  (**Underline**, **Emphasis**, **Cite**) or simply **do nothing**
  (**Highlight**), since that's text you normally select on purpose.

CardMirror extends this selection-awareness to more commands than
Verbatim does, but the model should feel familiar. The per-command notes
below say which fallback applies where it matters.

### The core formatting keys

| Function | Shortcut | What it does |
|----------|----------|--------------|
| **Cite** | F8 | Applies the Cite style — meant for just the author last name and date, not the whole line. With nothing selected, it applies to the word at the cursor. Skips heading text in a mixed selection. |
| **Underline** | F9 / Mod-U | Toggles underline on the selection (press again to remove). With **nothing selected** the two differ: **F9** underlines the word at the cursor; **Mod-U** instead turns on underline for the text you're about to type (like Mod-I for italics). |
| **Emphasis** | F10 | Applies the Emphasis style (a box, by default). Apply-only; use Clear or Underline to swap it off. |
| **Highlight** | F11 | Toggles the active highlight color. Press again to remove. |
| **Clear** | F12 | Strips direct formatting back to plain text (leaves highlighting — toggle that off separately). |
| **Bold / Italic** | Mod-B / Mod-I | Standard direct formatting. With nothing selected, toggles it for the text you're about to type; while italic typing is on, the cursor tilts to match. Tags and headings are bold by default, so **Bold inside a tag un-bolds** the selected words (press it again to restore) — and .docx files with un-bolded words in tags now show that correctly. |

Super/subscript and strikethrough live in the **Format** menu (super and
subscript also have shortcuts: **Mod-Shift-=** and **Mod-=**).

<a id="paste-text-f2"></a>
### Paste Text (F2)

Use **F2** instead of Ctrl/Cmd-V when pasting card text from a webpage or
PDF — it strips the source's styles, which otherwise bloat your file and
clutter the outline. On the desktop app and in Chromium browsers (Chrome /
Edge / ChromeOS) F2 pastes immediately — the web edition reads the
clipboard directly, asking once for clipboard permission and then
remembering it. **(Web only:)** where the browser won't grant clipboard
access — including Firefox and Safari — F2 falls back to *arming* plain
paste: the status bar shows a pill, and your next Ctrl/Cmd-V pastes as
plain text. If **Condense on paste** is on (Settings → Editing), the
pasted text is condensed as it lands.

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

The **Heading Mode** setting controls how a condense that spans headings
behaves — `respect` (the default; leaves headings separate, merges only
body runs), `strict` (refuses to touch a selection that includes
structure), or `demolish` (flattens everything touched).

**Paste and Destructively Condense** (desktop; unbound by default — assign a
key in Settings → Keybindings) rolls two steps into one: it pastes the
clipboard's plain text and immediately runs a destructive condense (Alt-F3)
over just what you pasted, merging its paragraphs into a single block. It's the
quick way to drop in a quote you want condensed on arrival. Desktop only, since
the web edition can't read the clipboard on a keypress.

### Smart quotes, dashes, and quote flipping

CardMirror ships a few opt-in typing aids. The two autoformatters are off by
default and reversible with a single **Backspace** right after they fire:

- **Smart quotes** (Settings → Editing → "Smart quotes") curl a straight `'` or
  `"` to the right direction as you type — opening after a space, dash, bracket,
  or the start of a line; closing (and the apostrophe) otherwise — so `don't`
  and `(he said "hi")` come out right.

- **Custom dash** (Settings → Editing → "Custom dash") turns a typed `---` into
  an en or em dash, with or without surrounding spaces (your choice), the moment
  you type the third hyphen.

- **Flip Quote Direction** (a command, unbound by default) flips every curly
  quote in your selection to its opposite direction, keeping the formatting.
  It's the manual fix for the cases smart quotes — like Word — guess wrong, such
  as a leading apostrophe in `'tis` or `'90s` that should curl the other way.

### Shrink (Mod-8)

**Shrink** cycles the non-underlined text in the current card or
analytic through progressively smaller sizes and back to normal, so a
card reads compactly at the podium. By default it leaves **omission
notes** — bracketed text like `[Table Omitted]` or `<Figure Omitted>` —
at full size; you can turn that protection off in Settings.

### Smart Shrink (Mod-Alt-8)

**Smart Shrink** shrinks a card's connective text in one pass, working
paragraph by paragraph: a paragraph with no underlining or emphasis at all
— the long, fully-unread stretches — drops to **5pt**, while a paragraph
that carries marks shrinks only its connective text to the standard
**8pt**. Unlike Shrink, it doesn't cycle: running it again changes nothing.
It honors the same protections as Shrink (omission markers, integrity
warnings, your custom rules), and regular **Shrink (Mod-8)** and **Regrow
(Mod-Shift-8)** still work on the result.

### Citations

- **Cite (F8)** applies the cite character style to the author and date,
  as above.
- **Copy Previous Cite (Alt-F8)** pulls the cite from the previous card
  into the current one — handy when cutting a long article.
- **Format Cite from selection (Mod-Shift-X)** uses AI to turn a pasted
  citation or URL into a properly styled cite (see
  [AI features](#11-ai-features)).
- **Create Reference** copies the selected card text to your clipboard as
  a "for reference" excerpt: a `<<CITE FOR REFERENCE>>` heading line,
  body text reduced by 3pt, and highlights converted to a quiet grey
  background. Every step is customizable under **Settings → Editing →
  Create Reference** — skip the heading or reshape it (bracket style,
  whether the cite appears, or a fully custom label with `%Cite%` marking
  where the cite goes), keep the original text size (or change how much
  it shrinks), choose what highlights become (grey background, a
  background in the same color, kept, or removed), and the Gray-50% body
  text option.
- **Lock Highlighting** converts highlighting to a light-gray background
  color in place, freeing the highlight layer so you can re-highlight from
  scratch. With nothing selected it locks the whole card your cursor is in;
  with a selection it locks just the selection. (With no selection and no
  card under the cursor it does nothing — it won't lock an entire
  pocket/hat/block.) Unlike Create Reference it edits the card directly,
  adds no heading, and does not turn the text gray — the card stays fully
  editable. (Any background color you'd already applied is left as-is.)

### Colors: highlight, background, and font color

CardMirror directly supports both **highlighting** and **background
color**. Highlighting and background color appear the same but operations
affecting one don't affect the other, allowing you to perform bulk edits on
your document that leave some things unaffected. (If you'd like to tell
them apart at a glance, **Settings → Appearance → Distinguish background
color from highlighting** adds a subtle display-only cue.) As an example, you might
want to recut an opponent's card and keep their highlighting, but in a
different color from the color you'd normally read; you can do this by
turning their highlighting into background color so it isn't affected by
"standardize highlighting" in the future.

Each of the three color controls is a **split button**: the main button
applies the active color, and the small arrow opens a 16-swatch picker.
The picker remembers your last color per control. The top-left swatch
selects **no color** (No highlight / No background / Automatic) — and
"no color" is a real pen, not just a one-off eraser: it stays active
(the indicator bar under the button turns white), and the main button,
paintbrush mode, and F11 / Mod-F11 then *strip* the mark wherever you
paint, until you pick a color again.

- **Highlight (F11)** — toggles the active highlight on the selection.
  Supports all 15 Word highlight colors.
- **Background color (Mod-F11)** — a separate background color that
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
An underline variant (*Underline Acronym*) is keybindable, unbound by
default. And for phrases whose shorthand isn't first letters, teach
them your own under **Settings → Editing → Acronym marking**: type the
phrase, click the letters to mark — pick the w, m, and d of "weapons of
mass destruction" and all three commands mark exactly those letters,
reading "WMD" instead of the default "womd". Applies whenever the
selection is exactly that phrase (case-insensitive).

For cleanup, the Card/Doc menus include **Standardize Highlighting** (and
background) to convert every color in scope to your active one (with the
"no color" pen active, they remove every highlight or background in
scope), and converters between highlight and background.

Each standardize command also has a **(with Exception)** variant in the
Doc menu that works the same way but leaves one color of your choice
completely untouched — pick the protected colors under **Settings →
Editing → Standardize exceptions**. The menu label always shows the
current exception (e.g. "Standardize Highlighting (except Yellow)");
both exceptions default to yellow. With the "no color" pen active, the
variants strip everything *except* your exception color. Both are
keybindable (unbound by default).

**Tip:** right-click any structural-style or character-style button to
select *every* instance of that style in the document — then apply a
color to all of them at once.

### Tables and images

- **Insert Table** (Format menu) drops in a table; further menu items add
  or delete rows and columns and merge or split cells. Tables round-trip
  to Word with their borders and background colors intact.
- **Insert Image** (Format menu) inserts an image from a file; you can
  also paste one from the clipboard. Right-click an image to **edit its
  alt text** (or have AI write it) and to **generate a table from the
  image** (see [AI features](#11-ai-features)). Alt text round-trips to
  Word.

### Footnotes and endnotes

Word footnotes and endnotes survive the round trip: opening a `.docx`
keeps every note, and saving writes them back so a Word user sees them
exactly where they were. In the editor each note is a small superscript
number (footnotes count 1, 2, 3…; endnotes i, ii, iii…) — **click it to
read the note** in a popover, links included. The popover's **Edit**
button lets you correct a note as plain text (formatting inside the
note is dropped when you save an edit). Notes travel with their text:
cut, copy, and send a card and its footnotes go along.

To create a new footnote, use the **Insert Footnote** command — unbound
by default; assign a key under Settings → Keyboard. It drops a marker
at the cursor and opens the note editor right away, so the flow is:
invoke, type the note, Save. To remove one, click the marker and hit
**Delete** in the popover — or just Backspace over the marker in the
text.

### Document and card cleanup

The **Doc** and **Card** ribbon menus hold document- and card-level
operations. From the **Doc** menu: **Convert Analytics to Tags**,
**Convert Cited Analytics to Tags** (the same, but only for analytics
that actually carry a cite — bare analytics stay analytics), **Fix
Formatting Gaps**, and **Remove Hyperlinks**. **Select Similar
Formatting** selects everything that matches the cursor's styles.

When you apply formatting to a word right next to an already-formatted word,
CardMirror automatically bridges the small gap between them so the styling reads
as continuous. Two Settings → Editing controls govern this: a toggle to turn the
automatic bridging on or off (the manual **Fix Formatting Gaps** command above is
unaffected), and a choice of which gaps it bridges — **whitespace and
punctuation** (the default) or **whitespace only**. Bridging happens only in body
text, never inside structural lines (tags, analytics, headings, undertags) — so a
selection spanning both bridges its body paragraphs and leaves its structure
alone.

From the **Card** menu's Excerpt section, **Extract Undertag** takes your
selection inside a card and drops it as a new undertag beneath the tag
(below any existing undertags), leaving the original text in place — handy
for pulling a key phrase up into an undertag. A Settings → Editing toggle,
**"Extract Undertag: wrap in quotes"** (off by default), controls whether
the excerpt is quoted.

Verbatim's other bulk cleanup macros (AutoNumberTags, ReformatAllCites,
ConvertToDefaultStyles, and the rest) aren't in CardMirror.

### Repair paragraph integrity

When a card's body has collapsed into one run — a PDF that lost its breaks,
or text pasted as a single block — **Repair Paragraph Integrity** rebuilds
the paragraphs one break at a time. Put your cursor in the card (or select
it) and run the command; a small bar opens and a green box outlines the card
it's working on.

Type a phrase that should *begin* a paragraph. As you type, every occurrence
of it in the card's body is highlighted in green. Once you've typed enough
that exactly **one** occurrence matches, the bar flashes green and shows a
check — press **Enter** to drop a paragraph break right before that phrase.
The box clears so you can type the next paragraph's opening phrase, and so on.

Press **Ctrl-Enter** instead of Enter to break *and* mark that paragraph to be
**indented** — it gets a green bar in the left margin. The indent isn't applied
right away; it lands when you exit, on whatever that paragraph has become by
then. So if you later split it again, only the final paragraph (up to the next
break) is indented, not the rest of the card. Press **Esc** to apply any
pending indents and leave the workflow.

It only searches the card's body (not the tag), so you can't accidentally
break a heading. The command ships without a default shortcut — assign one in
Settings → Keybindings.

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

Pressing the same heading key again clears indentation **and any manual
font-size override** while keeping the style — the way to reset an
over-indented or hand-resized line back to the style's defaults. (Tags,
analytics, pockets, hats, and blocks reset the font size; undertags clear
only indentation.)

### Editing at card boundaries

When your cursor is in a tag (or analytic), a few keys behave
deliberately rather than the way they would in Word:

- **Backspace at the start of a tag** removes a blank line above it;
  otherwise it does nothing (it won't merge body text up into the
  heading).
- **Backspace on an empty line directly below a tag** deletes that blank
  line. A line *with* text is left alone, so you can't accidentally merge
  body text into the heading.
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

### Moving cards and sections

To reorder by keyboard, put your cursor in a card or section and press
**Mod-Alt-↑** or **Mod-Alt-↓** — the **Move Container Up** / **Move Container
Down** commands. CardMirror grabs the smallest outline item enclosing your
cursor — a card or analytic unit, or a heading together with its whole section —
and slides it one spot among its same-level neighbors in the navigation pane.
Cards reorder among cards, blocks among blocks, and so on; nudging past the edge
of a section carries the item into the adjacent one. Both commands are rebindable
under Settings → Keybindings (listed with the Editing utilities).

### Spellcheck

Off by default — debate evidence (author names, jargon, citations) trips a
lot of false positives. Turn it on under **Settings → General → Editor
spellcheck**. Misspellings get a red underline. **Right-click** a flagged
word for spelling suggestions, **Add to Dictionary** (your personal
dictionary persists across documents and sessions), or **Ignore** (for this
session).

Leaving spellcheck on slightly degrades editor performance, so if you
notice typing or scrolling feeling less responsive on a large file, turning
it off may help.

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

By default it searches **everything at once**: as you type it blends matches
from all the sources below. To narrow to one source, start your query with
its **one-letter prefix** followed by a space. With a prefix and no query,
you *browse* that whole source.

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

Results show 100 at a time. When there are more, the last row says so —
click **show more** (or just keep arrowing down past the end) to reveal
the next hundred. When a result's name or folder path is too long to fit
the row, hovering it shows the full text in a tooltip.

**Inserting evidence.** Quick-card, dropzone, and in-file results drop in
at your cursor (the same insertion the send-to-speech and Quick Card
buttons use). If your cursor is in the middle of a paragraph, CardMirror
asks you to confirm first — you can turn that prompt off in Settings.

**Diving into a file (`f`, desktop only).** Press **Tab** on a selected file
— or right-click any file — to dive *into* it without leaving the palette.
With the query empty you get the file's outline — indented by level and
collapsible, like the navigation pane — and as you type you search that
file's blocks, tags, cites, and analytics. **Enter** inserts the chosen
object straight into your current document; **Esc** returns you to the file
list with your search restored. Undo (**Mod-Z**) works while you're diving,
so you can take an insert back without closing the palette.

**Pinning and speed.** Press **Alt-P** to pin or unpin the selected file
(★). Pinned files sort to the top and stay parsed for instant search;
your pinned and recent files are warmed in the background, and the file
list refreshes itself as files change on disk.

**Quick Card tags.** With a quick-card result selected, **Tab** opens the
tag filter (the same active-tag filter the ribbon's Tag Picker controls),
so you can narrow cards by topic.

---

## 6. Quick Cards

Quick Cards are a personal library of reusable snippets — a stock card, a
standard overview, an analytic you paste constantly. Unlike Verbatim's
shortcut-word system, CardMirror's are tagged and searchable, and they're
available from **any window**.

- **Add** — select content and choose **Add** in the Quick Cards group
  (or run *Add Quick Card*). Give it a name and tags.
- **Search and insert** — open the palette with **Mod-Shift-Space** and
  the **`q`** prefix (or the **Search** ribbon button), filter by tag, and
  insert the match at your cursor.
- **Manage** — the Manage button opens the full list to rename, retag, or
  delete.

---

## 7. The multi-doc workspace

Verbatim shows you one document at a time. CardMirror can show **three
editable panes side by side**, which makes assembling a speech,
comparing files, and working on something while keeping something up for
reference against a block practical without juggling windows.

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
- **Expand** a slot to full width with **Mod-Shift-F**, and restore it
  the same way.
- When you have more than one document in a slot, jump between them using
  the drop-down in the document's title bar or by using **Ctrl-Tab**.

### Per-document outlines

The navigation rail stacks one outline section per open document. Each is
independent:

- **Close one outline** — click the **×** at the top of a section (or the
  outline button in that document's title bar) to hide just that
  document's outline. The document stays open; the other outlines are
  untouched. Click the title-bar outline button again to bring it back.
  When every open document's outline is closed, the rail collapses and the
  panes reclaim the space.
- **Resize** — drag the divider between two sections to give one outline
  more height and the other less; double-click the divider to even them
  back out.

### Layouts

When all three slots are full, two layouts are available (pick in
Settings → General): **Compact** shows all three side by side, and
**Wide-scroll** shows two at a comfortable width with the edge of the
third peeking — click the peek or its nav pane, or use the focus shortcuts,
to snap to it.

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
  podium can't edit your file.

Only two editing actions are allowed in read mode. First, you can drop a
**reading-position marker** — red text like "Marked 7:32" at your cursor
(Verbatim's red-text convention), for when you stop mid-card. In read mode
it's deliberately effortless: **Space, Enter, or Mod-Shift-D** all drop one;
triggering it again on a marker removes it. (Red text stays visible in read
mode, so the marker shows.)

You can also drop a marker while editing — **Mod-Shift-D** works any time
(Space and Enter only stand in for it inside read mode).

Second, you can perform **click-and drag** actions - move headers around in
the document, add received cards to your document, or grab cards from the
Dropzone.

Press the eye again to exit. In the
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

### The speech and prep timer

The ribbon's **timer** button shows or hides a compact timer panel for running
speeches and prep in a round. Left to right it holds **Reset** (↻, which resets
every clock), the big **time display**, **Start / Pause** (▶), three **speech
preset** buttons, and the **Aff** and **Neg** prep clocks.

- **Speech timer.** Click a preset to load that length — the presets come from
  the active timer profile (College, High School, or Pomodoro) — then Start /
  Pause to run it down. It can flash red near the end (Settings → Appearance →
  "Flash timer when countdown is low").

- **Prep clocks.** Click **Aff** or **Neg** to run that side's prep; each keeps
  its own remaining balance and only counts down while it's the running clock, so
  you can switch sides freely. When a prep clock is loaded, the big display takes
  on that side's styling — the **Prep button label style** setting (text `A:` /
  `N:`, color, or both) now also marks the display, so it's clear at a glance that
  the time shown is prep, and whose.

- **Edit a clock.** While a clock is **paused**, click the big display to type a
  new time — handy if you started or stopped a beat late. For a prep clock the
  edit is saved to that side's prep balance, so it sticks when you switch clocks
  and back (until you Reset).

- **Switching profiles.** The **Cycle Timer Preset** command (unbound by default
  — assign a key under Settings → Keybindings) cycles the profile College → High
  School → Pomodoro, applies that profile's durations, and pops the timer into
  view. You can also set the profile and edit each profile's speech durations and
  per-side prep total under Settings → General; the compact layout lives under
  Settings → Appearance.

- **Keyboard transport.** Eight more unbound commands drive the timer from the
  keyboard (assign keys under Settings → Keyboard): **Timer: Show / Hide
  Panel**, **Timer: Start / Pause**, **Timer: Start Speech Preset 1–3** (loads
  that preset *and* starts it counting), **Timer: Start Aff Prep** / **Start
  Neg Prep** (switches to that side's clock and starts it), and **Timer:
  Reset**. Apart from Show / Hide, they only fire while the timer panel is
  visible, and — like the buttons — a press in one window drives the clocks in
  every window.

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
there and pull it back later — useful for parking common evidence temporarily.

### Saving a send doc

When it's time to share a speech with the judge or opponent, use the
**Send Doc** options described under
[Saving and file formats](#14-saving-and-file-formats) — a clean copy
with comments, analytics, and undertags stripped — either through Save As
or in one keystroke with **Save Send Doc (Mod-Alt-S)**.

### Saving marked cards

To hand over only the cards you actually read, place a reading marker in each
one and use **Save Marked Cards** — it pulls just those cards out and saves them
on their own, in your default format. Two ways in: a **Marked Doc** button in the
Save As dialog, and a **Save Marked Cards** command (default **Mod-Alt-M**,
rebindable) that saves silently to a destination you choose under Settings →
*Marked Cards destination* (the source file's folder, or a fixed folder), using
the `MARKED_` filename prefix and your default format — mirroring Save Send Doc.
It keeps cards only (analytics and headings are dropped); if nothing is marked,
it does nothing and tells you so.

### Card sharing (Send and Receive pills)

*Desktop only.* Card sharing sends cards to other people's machines over the
network. Two pills sit to the right of the dropzone — **Send** and **Receive**.

**Turn it on.** In **Settings → Card Sharing**, switch it on. Your machine gets
a **code**, shown there — share it with anyone you want to be able to send you
cards. To send to someone, add them under **Recipients**: paste the code they
gave you and give them a name. You can also bundle several recipients into a
**group** (say, a partnership) to send to all of them at once. The **↑ / ↓**
arrows on each recipient and group row reorder the lists — the Send pill shows
groups and recipients in exactly this order, so put the ones you use most on
top.

**Send a card.** Drag a card — from the document or the dropzone — onto the
**Send** pill. It expands to show your recipients and groups; drop on one to
send. Dropping on a group fans the card out to every member.

**Send to a starred target with one keystroke.** Click the **star** on any
recipient or group in **Settings → Card Sharing** to make it your starred target
(only one can be starred — starring another moves it). The **Send to Starred**
command then sends the card under your cursor (or the current selection) straight
to that target, without opening the Send pill — just like Send to Dropzone, but
to a person. It ships without a default key; assign one under Settings → Keyboard
shortcuts (look in the "Dropzone / Send and Receive Cards" group). If nothing is
starred, the command does nothing.

**Receive cards.** Cards others send you land in the **Receive** pill, which
flashes when one arrives and shows how many you haven't read. Open it to see
each card with who sent it and when; from there a received card behaves just
like a dropzone item — drag it into your document, or click to insert. Two
keyboard shortcuts drop in the **most recently received** card without opening
the pill: **Mod-P** inserts it at the cursor, and **Mod-Alt-P** appends it at the
end of the document. (Inserting leaves the card in the pill, so you can place it
again; both shortcuts are rebindable in Settings → Keyboard shortcuts.)

**Delivery.** New cards arrive **instantly**: your machine keeps a light
push connection open to the relay, and every reconnect (including waking
from sleep) runs a quick catch-up so nothing sent while you were offline is
missed — cards wait on the relay for up to three hours. Against an older
relay without push support, the app falls back to checking on the
**Fallback poll** interval in settings.

**Privacy.** Cards are end-to-end encrypted: only you and the recipient can
read them. The relay server that passes them along sees only scrambled data —
never the card, who it's from, or who it's going to — and it forgets every card
after three hours. Sharing is off until you turn it on.

**Run your own relay.** The relay server ships with CardMirror — the
`relay/` folder of the repo holds a standalone deployment (one
`docker compose up`; see its README). To use your own server, set
**Custom relay URL** (e.g. `https://relay.example.com/relay`) and
**Custom relay token** (the `RELAY_TOKEN` you configured on it) in
Settings → Card Sharing. Everyone sharing cards with each other must
point at the same relay. Leave both empty to use the official relay.

---

## 9. Comments and notes

Toggle the **comments column** on the right with the Comments button. It
holds four kinds of entity, each pinned beside the text it refers to:

Keeping the comments column open slightly degrades editor performance
(its cards reposition as you scroll and edit). If a large file feels
sluggish, hiding it may help.

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
- **Annotate a picture, too.** Comments, notes, and Ask AI all work on a
  selected image — or on a span of text that includes images, not just
  plain text. They re-anchor by content when the document changes, the
  same as text annotations, and a comment on an image is preserved when
  you save to Word.

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

Open **Manage Flashcards** from its button in the ribbon's comments
cluster (next to Create Flashcard). It lists your cards grouped by file,
where you can edit, suspend, or delete them. If a card's anchor text
changes or its file moves, the card becomes **unanchored** — it keeps its
schedule, and you can **re-ground** it by selecting text again, or link
it to a different file.

The button shows a small **red dot** when one or more cards are due for
review today — a nudge to start a session. If you'd rather not be nudged,
turn it off under Settings → Appearance → **Flashcards-due dot**.

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
| **Repair Text** | Mod-Shift-R on a selection | Fixes OCR / PDF extraction errors (dropped ligatures, `rn`/`m`, mid-word hyphenation, run-together words) without changing the wording. Corrections apply in place, one at a time with a highlight; the whole repair is a single undo. |
| **Repair Formatting** | Mod-Alt-R on a selection | Normalizes an imported card's formatting to Verbatim's four-layer scheme (underline / emphasis / highlighting / background color) — fixing bold or italics standing in for emphasis, direct underlining, bold-underline, and underlining lost to an unsupported style. It never changes your text. |
| **Translate** | Mod-Shift-T on a selection | Translates the selection and copies it to the clipboard, leaving your document unchanged. Uses Anthropic when AI is on; otherwise falls back to a free, keyless backend, so it works even with AI off. |
| **Ask AI about selection** | Mod-Shift-Q on a selection | Asks Claude a question about the selection — including any images in it (up to five pictures are sent to the model), with the surrounding card as context; the answer lands as an AI note. Works on a selected image on its own, too ("what does this chart show?"). Or type **@AI** in any comment or note — including its first message — to summon the AI right there; once a thread has an AI reply, further replies continue the conversation. |
| **Generate alt text** | Right-click an image | Writes an alt-text description and inserts it under the image; offers to keep or regenerate if the image already has alt text. |
| **Generate table from image** | Right-click an image | Extracts a real, editable table from a picture of one. |
| **Draft a flashcard** | From Create Flashcard | Drafts a question/answer or cloze from the selection. |

You can set the author name AI notes are attributed under, customize
the cite-formatting prompt, and point AI at a specific Claude model
(**AI model (advanced)** — leave blank to use the model built into your
release) in Settings → Comments & AI. If a model is ever retired, AI
features show a message telling you to update CardMirror or set a newer
model id there.

You can keep working while an AI action runs, and you can run more than one
at once — they don't trip over each other. Each action reserves the stretch
of text it's working on: edits you make elsewhere (or another AI action's
edits) move its target along so the result still lands in the right place.
While an action is working on a stretch, that stretch is locked — typing
into it does nothing and the locked text flashes — but the rest of the
document stays editable. Starting a second action on text another action is
already working on just asks you to try again in a moment.

### Repair Text

Select text pulled from a PDF or OCR and press **Mod-Shift-R** to clean up
extraction artifacts — dropped ligatures (`signicant` → significant),
`rn`/`m` mix-ups, words split across a line with a hyphen (`re-` / `search`
→ research, rejoining the break), run-together words, and stray
spaces/punctuation. It's deliberately conservative: it only touches clear
extraction errors and never rewrites your wording. The AI returns just the
specific fixes (not a rewrite), which apply directly in your document —
each correction appears one at a time with a brief highlight, and the
entire repair undoes in a single step. Requires AI features.

### Repair Formatting

Select body text and press **Mod-Alt-R** to normalize a card's formatting
to Verbatim's four-layer scheme: **underline** for the broad pass,
**emphasis** for what stands out within it, **highlighting** for what's
read aloud, and **background color** to set off some of that highlighting.
It fixes
the classic ways an imported card breaks down — bold or italics standing
in for emphasis, direct underlining used instead of the named underline
style, bold-underline used for all underlining, and underlining destroyed
by an unsupported style (recoverable from the font size). Bold and italics
are left alone where they're a deliberate extra layer or reproduce the
source (book titles, foreign terms).

The model **never touches your text**: it returns a mapping from each
formatting pattern to what that pattern should become, and the editor
applies it. It works on one card at a time, on body paragraphs only —
never tags, cites, or headings — leaves your colors and font sizes
untouched, and is a single undo. Requires AI features.

### Translate

Select text and press **Mod-Shift-T** to translate it and copy the result
to the clipboard (your document isn't changed — paste the translation
where you want it). Configure it under Settings → Editing → **Translation**:

- **Backend** — **MyMemory** (free, needs no key, and works even with AI
  features off; add your email to raise its daily limit), **Anthropic**
  (used when AI features are on; highest quality), or **Google Cloud
  Translation** (paste a Google API key). The default, *Automatic*, uses
  Anthropic when AI is on and MyMemory otherwise.
- **Languages** — the source auto-detects; the target defaults to English
  and is configurable.
- **Marker** — by default a `[TRANSLATION BY …]` line is placed above the
  translation on the clipboard, naming the engine (the model for
  Anthropic, MYMEMORY, or GOOGLE TRANSLATE). It uses the same delimiter as
  "Condense with warning" and is protected from Shrink. Turn it off in the
  same settings group.

A note on Anthropic translation: the prompt directs the model to preserve
the original meaning above all, but its output isn't deterministic —
re-running can reword slightly. Keep that in mind in leagues or circuits
where translated evidence needs a paper trail or reproducibility.

### Clod mode

A bit of fun, off by default (Settings → Comments & AI → **Enable Clod
mode**). While the AI is composing a reply, the
"Thinking…" placeholder is replaced by a friendlier persona — "Clod" —
who cycles through time-of-day activities like "Clod is making toast…" or
"Clod is reading by candlelight…". The persona's name, pronouns, and
activity lists are all customizable.

---

## 12. Send to Verbatim Flow

**(Windows only. Experimental.)** With Excel open and a workbook whose name
contains "Flow", CardMirror can push your work straight into Verbatim
Flow. Commands send the selected tags, cites, or text into Flow's current
column, pull the selected Flow cells back into your document, or open a new
Flow from the Verbatim template. They drive Excel directly and need no
changes to Verbatim Flow itself.

The **Send Headings to Flow** variants send only the heading-level labels
— and from a cite line, only the marked citation (the same short cite the
navigation pane previews), not the whole bibliographic paragraph.

**Keeping the connection warm.** The first time you use a Flow command in a
session, CardMirror opens a background connection to Excel and keeps it
open, so every send and pull after that is near-instant instead of pausing
a second or more to reconnect. If you'd rather not wait on that first send
mid-round, warm the connection ahead of time with the **Start Flow
Connection** command, or turn on **"Keep a Verbatim Flow connection warm"**
under Settings to open it automatically the moment CardMirror launches. The
connection closes when you quit.

These commands aren't on the ribbon and have no default shortcuts — find
them in the command palette, or bind keys to them under **Settings →
Keyboard shortcuts**. They appear only on Windows.

---

## 13. Voice control

**(Desktop only. Experimental.)** Press **Ctrl-Shift-V** to start a
hands-free editing session and work a card by voice — read text aloud to
ink it, dictate tags and cites, and move around the document without
touching the keyboard. Recognition runs **entirely on your own machine** —
no audio ever leaves it, with or without a network connection.

The speech model is a **one-time ~130 MB download** rather than part of
the installer, so the app itself stays small for the many people who never
use voice. The first time you turn voice on, CardMirror asks to download it
and notifies you when it's ready (you can keep working meanwhile — it does
not start listening on its own). If you'll be somewhere without a
connection, download it ahead of time under **Settings → Accessibility →
Dictation accuracy model**.

This is early, experimental software; expect rough edges, particularly
pertaining to the voice recognition model, and keep the keyboard within
reach. On macOS, voice requires Apple Silicon.

### Starting a session

**Ctrl-Shift-V** turns the microphone on. A **status pill** appears
showing whether CardMirror is listening, the current **mode** as a
labeled badge (command / dictation / paint / asleep — always visible, so
you never have to read the mode from the dot's color alone), the active
**pen**, what it last heard, and a live mic level. Click the pill to
choose which microphone to use. To park the mic without ending the session, say **`voice sleep`**; say
**`voice wake`** to start listening again. The mic also **auto-sleeps**
after a stretch of silence (configurable) so a forgotten session doesn't
keep transcribing the room — the pill dims as a warning before it does.

### Commands

Every command starts with a spoken verb. A few you'll use constantly:

- **`pen highlight`** (or `pen underline`, `pen emphasis`, `pen cite`) sets
  the active pen — the mark that `mark` and paint apply. The pen sticks
  until you change it.
- **`take <words you can see>`** selects exactly those words on screen;
  **`mark`** then applies the pen, or **`mark <words>`** does both at once.
- **`next card`** / **`go back`** move you around; **`condense`** and
  **`shrink`** run the usual card commands.

When words you speak appear more than once on screen, numbered badges pop
up over each match — say **`pick two`** to choose.

### Paint mode

Say **`paint`** and then simply **read the card aloud**: the words you read
are inked with the active pen as you go, the voice-native way to highlight
or underline a card. Switch pens mid-pass (`pen highlight`), skip ahead
without marking, and say **`stop paint`** when you're done.

### Dictation

Say **`start typing`** to dictate at the cursor and **`stop typing`** to
stop; while you talk, words stream in as gray preview text before they
land. Dictation understands spoken punctuation (`period`, `comma`,
`question mark`, quotes), a configurable **dash** word, and capitalizes
sentences for you. To dictate a word that's also a command, prefix it with
**`literal`** (so `literal stop typing` types the words instead of
exiting).

### Precise targeting

Targeting composes, so you can be specific without reaching for the mouse:

- **Ordinals count inside their natural container.** `take second
  sentence` is the second sentence of this paragraph; `go to third card`
  is the third card in this block.
- **`mark every tag`** marks every tag in the block in a single step.
- **`take head card`** / **`take tail paragraph`** select to a scope's
  start or end.
- **`take from <words> to <words>`** spans two spoken anchors.

### Undo

Every voice action is a single undo step, and voice undo (**`scratch
that`**) and **Ctrl-Z** always agree — so you can take back a voice action
with the keyboard, or vice versa, and never lose your place.

### Options

Voice settings live under **Settings → Accessibility**. They include an
optional **large dictation model** — a one-time 1.8 GB download that uses
around 5 GB of memory while it's on and roughly halves general-English
dictation errors (it doesn't change command recognition).

---

## 14. Saving and file formats

### Opening files

Open a working file with **File → Open**, or from the Home screen's recents. On
desktop you can also **drag a `.docx`, `.cmir`, or `.cmir-journal`** from your
file manager onto any CardMirror window — the editor, the navigation pane, or the
home screen — to open it, exactly like File → Open (including the unsaved-changes
prompt, and focusing a copy that's already open). Other file types are ignored,
and dragging cards around inside the editor is unaffected.

### Two formats

- **`.cmir`** — CardMirror's native format. Lossless, and required for
  autosave and crash recovery. Use it for your working files. Files are
  saved compressed (roughly 10× smaller than before) and open just as fast;
  older uncompressed files still open and shrink the next time you save them.
  To shrink existing files, use **Bulk compress** on the Home screen — on
  desktop it compresses every `.cmir` in a folder in place, skipping ones
  already done; the web edition does one file at a time. *(A temporary
  migration helper.)*
- **`.docx`** — Word/Verbatim format. Use it to share. CardMirror writes
  docx that's indistinguishable from Verbatim's own output; some
  CardMirror-only extras (private notes, AI notes, flashcards) are left
  out unless you opt in.

### Cleaning .docx styles ("stylepox")

As cards get copied between documents, junk styles
hitchhike along — files end up with hundreds or thousands of redundant,
malformed styles that bloat the file, slow Word to a crawl, can break
Verbatim's macros, and eventually hit Word's hard cap of 4,085 styles.
**Clean**, on the Home screen, cures this. For each document it:

- removes the junk styles, keeping only the standard Verbatim set;
- converts stray direct formatting (manual bold / underline / highlight) back
  into the right styles;
- restores Verbatim's style names and aliases so macros work; and
- strips hyperlinks and other invisible cruft.

**On the web**, Clean does one file at a time: pick a `.docx` and it saves a
`cleaned_` copy (a spinner runs while it works, then you choose where to save).
The rest of this section — cleaning a whole folder, the destination and filename
options, and the protected-styles list — is **desktop only**.

Point it at a single file or a whole folder (it recurses) and a destination —
or leave the destination blank to write each cleaned copy next to its original.
A progress bar tracks the current file.

By default Clean prepends **`cleaned_`** to every output filename, so it always
writes new files and never touches your originals. Turn off **"Prepend
'cleaned_' to output filenames"** to save with the original names instead. If you
do that *and* the destination is the originals' own folder, Clean **overwrites
them in place** — which can't be undone and can occasionally destroy some
formatting, so it makes you confirm by typing "I accept the risk" before it runs.
Prepending, or saving to a different folder, leaves your originals untouched.

The **gear** opens **Protected styles** — a list of styles Clean must never
remove or reassign (matched by name, case-insensitively; their dependencies
are kept too). Add them by name, or upload a template `.docx` and pick from
its styles.

This is the same idea as the **"Curing Stylepox"** cleaner described on
[Debate Decoded](https://debate-decoded.ghost.io/leveling-up-your-debate-software-3-curing-stylepox/),
but it runs entirely inside CardMirror. It's **much faster** and has **much
better handling of old files**. It recognizes the common pre-Verbatim style
conventions
(`Tags` / `Cards` / `Cites` / `Block Headings`, `Author-Date`, `Debate
Underline`, …) and rebuilds them into the modern Verbatim structure, injects
the standard styles when a document is missing them, and repairs `!!`-marked
style names that older cleaners choke on — so it handles **many** old files
cleanly, though not every one (unusual or one-off style schemes may still not
be fully understood). The same applies when you simply **open** an old `.docx`
in CardMirror: for files it recognizes, it reconstructs the cards, tags, cites,
and headings instead of importing flat text.

### Saving

- **Save (Mod-S)** / **Save As… (Mod-Shift-S)**.
- **Autosave** is a toggle in the ribbon that applies to `.cmir`
  files. The button shows whether autosave is actually protecting the
  current doc: a **solid filled** button means it's saving; a **hollow
  button with a dashed outline** means it's on but not firing (the doc
  is `.docx`, or hasn't been saved once yet) — hover over it for the reason.
  **(Desktop only.)**

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
no dialog. Two Settings → Files options control where it goes (the
source file's folder, or a fixed folder you pick).

The filename prefixes for the preset saves — **Send Doc**, **Read Doc**, and
**Marked Doc** (defaults `SEND_`, `READ_`, `MARKED_`) — are configurable under
Settings → Files; change any of them, or leave one empty for no prefix. They
apply to both the Save As preset buttons and the one-keystroke Save Send Doc /
[Save Marked Cards](#saving-marked-cards) commands, gated on the existing
"Prefix preset saves" toggle.

### Crash recovery

**(Desktop only.)** CardMirror journals your work as you go, so if it's
killed mid-edit it offers to recover the unsaved document the next time
you launch.

### Updates

**(Desktop only.)** **Help → Check for Updates…** checks manually.
Auto-check on launch is off by default — turn it on in Settings → General.
Linux users who installed via the AUR update with `yay -Syu`.

**On macOS, automatic updating doesn't work** — CardMirror can tell you a
new version is available, but it can't install it for you. Download the
latest `.dmg` from the releases page and replace the app manually each
time.

---

## 15. Settings reference

Open settings with the **gear** icon. Settings are grouped into tabs.

Some rows only exist on one platform — marked *(desktop)*, *(web)*, or
*(Windows)* below — and don't appear elsewhere.

### General

Workflow and editor behavior. Bold lines below mirror the section
headers shown inside each tab.

**Workspace**

- **Three-pane workspace** — switch between one document per window and a
  single window with three panes
  (see [The multi-doc workspace](#7-the-multi-doc-workspace)).
- **Multi-doc layout** — with three docs open, show all three at once
  (compact) or two-and-a-bit with click-to-snap (wide). No effect with
  one or two docs.
- **Layout on this device** *(web)* — which layout the web edition uses:
  Auto picks the view-first mobile layout on narrow or touch screens;
  Mobile / Desktop force one. Changing this reloads the page.

**Editor behavior**

- **Editor spellcheck** — underline misspellings in the visible document,
  including text in files you've opened (not just what you're typing).
  Right-click a flagged word for suggestions, Add to Dictionary, or
  Ignore. Off by default — debate evidence (author names, jargon) trips a
  lot of false positives.
- **Pinch / Ctrl+Scroll to zoom** — zoom the document with a trackpad
  pinch or Ctrl + mouse-wheel, in the same 10% steps as the zoom buttons
  and Mod-= / Mod--. Off by default; enable it if you'd rather zoom by
  gesture.
- **Jump to doc top when read mode toggles** — when on, toggling read
  mode scrolls to the top and puts the cursor at the start.

**Word counts**

- **Readers for read-time estimates** — each reader is a name and a
  words-per-minute rate. The first two show live in the status bar; all
  appear in the Word Count dialog
  (see [Read-time estimates](#read-time-estimates)).
- **Live word count for the current selection** — off by default. When
  on, the status bar's count and read time follow your selection as you
  change it; leave it off on very large docs if you notice drag lag.

**Find**

- **Find: remember the last search query** — when on, the find bar
  reopens pre-filled with your last search.
- **Find: category priority order** — the order Ctrl-F steps through
  result groups (heading / tag / cite / other); Alt-F ignores it and goes
  purely by proximity (see [Find and Find/Replace](#find-and-findreplace)).

**Timer**

- **Timer profile** — which duration set the timer runs: High school,
  College, or Pomodoro. Each remembers its own edits.
- **Timer durations** — the active profile's three speech presets (the
  9 / 6 / 3 buttons) and per-side prep total.

**Integrations**

- **Keep a Verbatim Flow connection warm** *(Windows)* — start the
  background Excel connection when CardMirror launches so your first
  Send to Flow is fast; leave off to start it on demand
  (see [Send to Verbatim Flow](#12-send-to-verbatim-flow)).

### Files

Where new documents go, how the save presets name their files, and what
file search scans.

**New documents**

- **Onboarding doc for new documents** — when on, New Document opens the
  welcome doc; off opens a single blank paragraph.
- **Default folder for new speech documents** *(desktop)* — where New
  Speech Document saves by default. Empty leaves the doc unsaved until
  you Save.
- **Default format for new speech documents** — `.docx`
  (Verbatim-compatible) or `.cmir` (native, and the only format that
  supports autosave).
- **Default file format for new documents** — the format the Save As
  dialog defaults to for a doc you haven't saved yet. Existing files
  always re-save in their own format.
- **Seed new speech docs with a Pocket heading** — when on, New Speech
  Document opens with a Pocket carrying the speech's name; off starts
  blank.

**Send / Read / Marked docs**

- **Prefix preset saves** — when on, the Save As Send Doc / Read Doc /
  Marked Doc presets and the silent Save Send Doc / Save Marked Cards commands
  prepend a filename prefix.
- **Send Doc / Read Doc / Marked Doc filename prefix** — the prefix each
  preset uses (defaults `SEND_` / `READ_` / `MARKED_`); change any, or leave one
  empty for no prefix.
- **Send Doc destination** *(desktop)* — whether Save Send Doc writes
  beside the source file or into a fixed folder
  (see [Saving a send doc](#saving-a-send-doc)).
- **Send Doc folder** *(desktop)* — the fixed folder used when the
  destination above is "Fixed folder."
- **Marked Cards destination** *(desktop)* — whether Save Marked Cards writes
  beside the source file or into a fixed folder (see
  [Saving marked cards](#saving-marked-cards)).
- **Marked Cards folder** *(desktop)* — the fixed folder used when the Marked
  Cards destination is "Fixed folder."

**File search**

- **File search folders** *(desktop)* — the roots scanned for the palette's
  file search (the `f` prefix). Empty disables file search (see
  [The Search Everything palette](#the-search-everything-palette-mod-shift-space)).
- **File search: file formats to list** *(desktop)* — which document
  formats appear in results: both `.cmir` and `.docx`, or just one.
- **File search: objects to find within a file** *(desktop)* — which
  structural objects (blocks, tags, cites, …) the palette lists when you
  dive into a file.
- **File search: default outline depth** *(desktop)* — how far a file's
  outline is expanded the moment you dive in.
- **File search: auto-pin recent & frequent files** *(desktop)* — keeps
  recent and frequent files warm for instant dives; turn off to warm only
  files you pin by hand.

### Appearance

How things look. None of these change the file — only your view (see
[Appearance and accessibility](#16-appearance-and-accessibility)).

**Theme & chrome**

- **Theme** — light, dark, or follow the system.
- **Apply theme to the document area** — off by default, so dark mode
  darkens only the interface and the document stays paper-like; on darkens
  the document too.
- **Icon style** — modern line icons (default) or classic glyphs;
  interface only.
- **Show doc name in ribbon** — show the active filename as a pill in the
  ribbon's center, handy when the title bar is hidden. Off by default;
  hidden in multi-pane (each pane shows its own chip).
- **Show undo / redo buttons** — a stacked Undo / Redo button pair at the
  far left of the ribbon, before the file buttons. Off by default —
  undo/redo always work by keyboard either way.
- **Ribbon tooltips** — what a hovered ribbon button shows: both, label
  only, shortcut only, or none.

**Document typography**

- **Style font sizes (pt)** — render size for each named style.
- **Style typography** — bold / italic / underline / box per named style.
- **Body font** — the editor's content font, including dyslexia-friendly
  options.
- **Line spacing** — the line-height multiplier, per paragraph type.
- **Paragraph spacing** — blank space before and after each paragraph
  type, in points (distinct from line spacing, which is the gap between
  lines).
- **Style colors** — the color of Analytic and Undertag text (the same
  control as Accessibility → Color overrides → Document text).
- **Distinguish background color from highlighting** — overlays a
  deliberately faint dot grid on background color so it can be told
  apart from highlighting at a glance. Off by default — the two stay
  visually identical. Display-only; the file and anything you copy or
  export are untouched.
- **Show character styles** — show the cite / underline / emphasis
  buttons in the ribbon.

**Formatting panel**

- **Formatting panel** — how the Pocket / Hat / Block / Tag / Analytic
  buttons read: labels, shortcuts, both, or hidden.
- **Preview styles in formatting panel** — make the formatting buttons
  preview the look of the style they apply.

**Nav pane & indicators**

- **Format nav pane entries by type** — style navigation entries by
  heading level and type (on), or as a uniform list where only
  indentation shows hierarchy (off).
- **Cite preview on hover** — show a card's cite-formatted text beside its
  navigation-pane entry when you hover.
- **Flashcards-due dot** — show a red dot on the ribbon's Manage
  Flashcards button when cards are due for review today. On by default.

**Timer display**

- **Timer position in the ribbon** — which edge of the ribbon the timer
  panel sits on when shown: the far left (default) or the far right.
- **Prep button label style** — how the Aff / Neg prep buttons are
  marked: text (A: / N:), color, or both.
- **Compact timer layout** — drop the 9 / 6 / 3 presets and tuck Reset
  under Start / Pause.
- **Flash timer when countdown is low** — flash the speech timer red at
  the configured thresholds.

### Editing

Typing helpers and the behavior of the cutting and condense commands
(see [Cutting and formatting cards](#3-cutting-and-formatting-cards)).

**Typing**

- **Smart quotes** — curl a straight `'` / `"` to the right direction as you
  type; Backspace right after reverts. Off by default.
- **Custom dash** — turn a typed `---` (or `--`, your choice) into an en
  or em dash (spaced or unspaced) on the trigger's last hyphen;
  Backspace right after reverts to the literal hyphens. Off by default.

**New paragraph on Enter**

- **Enter at the end of a structural style creates** — six dropdowns,
  one per structural style, choosing what pressing Enter at the *end*
  of that style creates. "Normal paragraph" (the default for all six)
  keeps today's behavior. Any other choice acts exactly like pressing
  Enter and then that style's key on the new line — including card
  splits — so Tag → Tag starts a fresh card on every Enter, and
  Analytic → Analytic chains analytics. One Ctrl-Z undoes the whole
  step.

**Condense**

- **F3 condense: preserve paragraph integrity** — keep paragraphs
  separate (on) or merge collapsible runs (off).
- **F3 condense: use pilcrow markers** — when merging, mark each old
  paragraph break with a 6-pt ¶ so Uncondense can restore it.
- **Condense after Paste Text (F2)** — run your default condense
  automatically on pasted text.
- **Condense: heading handling** — how selection condense treats
  headings, cites, and undertags: Strict (block it), Respect (keep them
  separate, default), or Demolish (merge everything).
- **Condense with warning: marker delimiter** — the bracket style around
  the PARAGRAPH INTEGRITY PAUSES / RESUMES markers.

**Formatting operations**

- **Extract Undertag: wrap in quotes** — wrap the excerpt that Extract
  Undertag pulls in double quotes.
- **Bridge formatting across gaps automatically** — when you format a word
  next to an already-formatted one, close the small gap so the styling reads as
  continuous (the manual Fix Formatting Gaps command is unaffected). Body text
  only.
- **Bridge formatting across** — which gaps the automatic bridging closes:
  whitespace and punctuation (default), or whitespace only.
- **Shrink keeps protected text at Normal size** — keep Omitted spans,
  warning markers, and your custom protections full-size when Shrinking.
- **Custom shrink protections** — extra strings (or regexes) Shrink
  should leave at Normal size.
- **F9 toggle-off also clears direct formatting** — toggling underline
  off also strips direct formatting in the range.

**Create Reference**

- **Include the FOR REFERENCE heading** — start the copied excerpt with
  the `<<CITE FOR REFERENCE>>` heading line (on by default). The three
  settings below shape that line and are disabled while it's off.
- **Heading delimiter** — which bracket pair wraps the heading:
  `<< >>` (default), `[ ]`, `[[ ]]`, `< >`, `{ }`, or `{{ }}`.
- **Include the cite in the heading** — whether the card's cite appears
  (the SMITH 24 in `<<SMITH 24 FOR REFERENCE>>`).
- **Custom heading text** — replace the FOR REFERENCE label with your
  own. Type `%Cite%` where the cite should go — e.g. `FROM %Cite%`
  gives `<<FROM SMITH 24>>`; without `%Cite%` the cite is
  prepended as usual. Leave empty for the default label.
- **Reduce text size** / **Reduce text size by (points)** — whether the
  excerpt's text shrinks, and by how many points (default 3; never below
  1pt).
- **Highlights become** — what happens to highlighted text in the
  excerpt: a grey background (default), a background in the same color
  as the highlight (like the Highlight to Background command), kept as
  highlights, or removed.
- **Use Gray-50% body text** — render the excerpt's body text in gray;
  the heading line stays black.

**Standardize exceptions**

- **Highlighting exception** — the highlight color that "Standardize
  Highlighting (with Exception)" leaves untouched. One of Word's 15
  highlight colors; defaults to yellow.
- **Background color exception** — the background color that "Standardize
  Background Color (with Exception)" leaves untouched. Any color; defaults
  to yellow.

**Acronym marking**

- **Custom acronym letters** — teach the acronym commands (Alt-F10
  emphasize, Alt-F11 highlight, Underline Acronym) which letters to mark
  for specific phrases instead of each word's first letter. Type a
  phrase, then click its letters in the picker — the marked letters are
  exactly what the commands will mark when your selection is that phrase.

**Insert surfaces**

- **Show dropzone shelf** — show or hide the dropzone pill; the shelf
  still works when hidden
  (see [Send-to-speech and the dropzone](#send-to-speech-and-the-dropzone)).
- **Show quick card buttons** — show the Quick Cards ribbon cluster (off by
  default; quick cards still work while hidden, and the command bar still opens
  by shortcut).

**Translation**

- **Translation** — backend (MyMemory / Anthropic / Google Cloud
  Translation), source and target languages, MyMemory email, and Google
  API key for the Translate command (Mod-Shift-T). See
  [Translate](#11-ai-features).
- **Prepend a "translation by" marker** — put a `[TRANSLATION BY …]` line
  above the translated text on the clipboard. On by default.

### Keyboard shortcuts

Rebind any command: search for it, click **+** to add a binding, **×** to
remove one, **↺** to restore its default. A few window-level shortcuts
(like Mod-W) are handled by the OS and can't be overridden (see
[Keyboard shortcuts](#17-keyboard-shortcuts)).

### Comments & AI

- **Comment author name** — the name attached to comments you write.
- **Comment author initials** — the badge on your comments;
  auto-derived from the name if left blank.
- **Enable AI features** — master switch for the AI comment features;
  needs an API key (see [AI features](#11-ai-features)).
- **Anthropic API key** — stored locally; sent only to api.anthropic.com.
- **AI model (advanced)** — the Claude model id all AI features use; blank
  uses the model built into your release. Set a newer id if the built-in
  one is retired. A malformed entry is ignored.
- **Enable Clod mode** — the playful in-flight placeholder ("Clod is
  making toast…") while the AI composes a reply.
- **AI cite-creator prompt** — the system prompt the cite creator uses;
  leave blank for the built-in default.

### Accessibility

- **Reduce motion** — turn off UI animations: follow the system, always
  on, or always off.
- **Steady text cursor (no blinking)** — stop the text cursor blinking and
  show a steady caret instead. Off by default.
- **Default document zoom** — the body-text zoom level documents open at, and
  reset to on reload (zoom is per-editor and no longer persists). 50–200%,
  100% by default.
- **Screen reader support** *(desktop)* — let screen readers and other
  assistive technology read CardMirror. **Off by default**: a current Chromium
  bug crashes the window (white screen, lost work) while building the
  accessibility tree, so CardMirror disables it to stay stable. Turn it on only
  if you rely on a screen reader — it re-activates the known crash — and restart
  CardMirror to apply.
- **Color-vision friendly palette** — remaps the colors that carry meaning
  (annotation accents, voice-mode dots, prep-timer Aff/Neg, search-match
  highlights, category chips) onto a palette engineered to stay
  distinguishable under red-green and blue-yellow color-vision deficiencies.
  Works with both light and dark themes; any colors you set under **Color
  overrides** still win. This preset changes CardMirror's interface colors
  only — highlights and background colors stored in documents are
  untouched. For those, use the **Override highlight/background color**
  settings below and the status-bar color names setting above.
- **Distinguish annotations by underline shape** — add a shape-coded
  underline to in-document annotation ranges so you can tell them apart
  without relying on their tint colors: comments dotted, flashcards
  solid, AI threads dashed, private notes double. Off shows just the
  tinted backgrounds. Works independently of the palette above.
- **Italicize analytic entries in the nav pane** — show the navigation
  pane's Analytic entries in italics so they stand out from tags by
  shape, not color alone. Also useful in dark mode and with "Format nav
  pane entries by type" off, where the analytic color cue doesn't
  appear at all.
- **Override highlight color in display** — render highlights in your
  chosen colors regardless of what's stored on the mark (display-only).
- **Highlight override colors** — up to three ordered colors; the
  most-common highlight in the doc maps to the first, the next to the
  second, the rest to the last.
- **Override background color in display** — the same, for background
  color.
- **Background override colors** — the colors used for the above.
- **Show highlight & background color names in the status bar** — the
  status bar
  reports the actual stored color names for the text at your cursor
  (e.g. `Hl: Yellow · Sh: none`). Highlight hues often carry meaning in
  shared files; this gives you that meaning as text — useful if colors
  are hard to tell apart, or alongside the overrides above. Works in the
  three-pane workspace too (it follows the focused pane).
- **Color overrides** — override any interface color (and document text);
  your picks win over the built-in themes and presets.
- **Interface font** — the font for the app's interface (ribbon, dialogs,
  navigation, comments), separate from the body font; includes
  dyslexia-friendly options.

---

## 16. Appearance and accessibility

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
- **Accessibility overrides.** Remap highlight and background colors,
  override document text color, and pick dyslexia-friendly body fonts
  (Atkinson Hyperlegible, Lexend, OpenDyslexic, and others). CardMirror
  also forces readable contrast on highlighted and shaded text
  automatically. A **Steady text cursor (no blinking)** option (off by
  default) replaces the blinking caret with a steady one.
- **Zoom.** **Mod-=** / **Mod--** zoom the document text; the status bar
  shows the level (click to reset). Zoom is **per editor** — it applies only
  to the document you're in, so you can zoom one document in while another
  stays out, independently per pane in the three-pane workspace. It doesn't
  sync across windows or persist; instead documents open at a default you can
  set (Settings → Accessibility → **Default document zoom**, 100% by default)
  and reset to it on reload. You can also pinch on a trackpad or hold Ctrl and
  scroll, once you turn that on under Settings → General → **Pinch /
  Ctrl+Scroll to zoom** (off by default). **(Desktop only:)** **Mod-Alt-=** /
  **Mod-Alt--** scale the whole interface uniformly across windows, not just
  the document.

---

## 17. Keyboard shortcuts

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
| Mod-Alt-8 | Smart Shrink |
| Alt-F8 | Copy previous cite |
| Tab / Shift-Tab | Indent / Outdent |
| Mod-Alt-Up / Mod-Alt-Down | Move container (card / section) up / down |

### Moving and selecting
On macOS, use **Alt/Option** in place of **Ctrl**. Add **Shift** to any of
these to extend the selection.
| Shortcut | Action |
|----------|--------|
| Ctrl-Left / Ctrl-Right | Previous / next word |
| Ctrl-Up / Ctrl-Down | Previous / next paragraph |
| PageUp / PageDown | Previous / next heading |
| Alt-A | Select the current heading and everything under it |

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
| *(unbound)* | Send to the starred recipient / group — bind it in Settings |
| Mod-P / Mod-Alt-P | Insert most recently received card at cursor / at end of doc |
| Mod-Shift-N | Add note to selection |
| Mod-Shift-Q | Ask AI about selection |
| Mod-Shift-X | Format cite from selection |
| Mod-Shift-R | Repair OCR/PDF text in selection |
| Mod-Alt-R | Repair Formatting in selection |
| Mod-Shift-T | Translate selection (to clipboard) |
| Mod-Shift-D | Toggle a reading-position marker (Space / Enter also work in read mode) |

### Files and view
| Shortcut | Action |
|----------|--------|
| Mod-S / Mod-Shift-S | Save / Save As |
| Mod-Alt-S | Save Send Doc |
| Mod-Alt-M | Save Marked Cards |
| Mod-= / Mod-- | Zoom in / out |
| Mod-Alt-= / Mod-Alt-- / Mod-Alt-0 | Interface scale up / down / reset (desktop) |

### Multi-doc workspace
| Shortcut | Action |
|----------|--------|
| Mod-1 / Mod-2 / Mod-3 | Focus slot 1 / 2 / 3 |
| Mod-Shift-1/2/3 | Move active doc to slot |
| Mod-Shift-F | Expand / restore the focused slot |
| Mod-W | Close the focused document or window |

### Voice control (desktop)
| Shortcut | Action |
|----------|--------|
| Ctrl-Shift-V | Start / stop a voice control session |

The full, current list is always in the app: press **📖** in the ribbon.

---

## 18. What's not here yet

CardMirror is in active development. Planned, but not built yet:

- **Library-wide search** — a persistent index of your whole evidence
  corpus. For now, the [Search Everything palette](#5-finding-things)
  searches files by name and lets you dive into one at a time.
- **Transclusion** — live references to a card that lives in another file.
- **Real-time collaboration.**
- **Numbered and bulleted lists**.
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

## 19. Glossary

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
