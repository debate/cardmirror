# Architecture

The CardMirror editor's design — schema shape, rendering model,
multi-doc workspace, send-to-speech / read-mode / cross-pane drag
semantics, editing-behavior rules at node boundaries, and the
companion-tool integration surface.

---

## 1. Why ProseMirror

ProseMirror represents documents as a *typed tree*: every node has a `type`
declared by the schema, optional `attrs`, optional ordered child `content`
governed by a content expression, and optional `marks` (inline decorations
on text). Schema-violating transactions are rejected by construction.

This is a meaningful step up from a flat-paragraphs-with-styles model
(Word's, Quill's) for our use case because **debate documents are
genuinely tree-shaped**: Pocket > Hat > Block > Tag/Card is a real
hierarchy with semantics, not just visual indentation. When `card` is a
real node in the tree, operations target it as an object — select, move,
duplicate, query — without re-deriving its boundaries from style
sequences. That's the core leverage we're buying.

What ProseMirror *doesn't* give us for free: docx fidelity, debate
ergonomics, multi-doc coordination, read-mode UX. Those are work we do
on top of the substrate.

## 2. Project decomposition

The natural separation:

```
[Stylepox normalizer]  →  [docx]  →  [Importer]  →  [Schema]  ↔  [Editor]
                                                       ↓
                                                  [Exporter]  →  [docx]
```

- **Stylepox normalizer** — genuinely separate project. The project owner
  already maintains a working tool (Stylepox Cleaner) for legacy file
  remediation; not in scope for us.
- **Schema + Importer + Exporter + Editor** — single project, deeply
  intertwined. The schema is shared infrastructure; importer and exporter
  are 1:1 coupled to it; the editor consumes it.

Round-trip is a *quality property* of the schema/importer/exporter triple,
not a separable codebase. The schema must be designed against round-trip
realities from day one, not retrofitted.

### Build order

1. **Schema first** — small, defensible, designed against the
   realities of Verbatim's OOXML.
2. **Exporter** — schema → OOXML, tested by hand-constructing schema trees
   and verifying the docx renders correctly in Word + Advanced Verbatim.
3. **Importer alongside** — OOXML → schema, tested via
   `doc → import → export → doc` round-trip on the example docs.
4. **Editor on top** — once the schema is proven sound under round-trip,
   build the editing UX.

Unusual ordering for an editor project; justified because *the persistence
is the entire reason the project exists*.

## 3. The round-trip contract (fungibility)

Headline goal: **a user of our editor on a Verbatim-using team is a fully
equal participant in the file ecosystem**. Documents shipped from our
editor are visually and semantically indistinguishable from
Verbatim-produced docs, regardless of how the sender's editor is
configured. Documents received from Verbatim users round-trip back through
Verbatim cleanly.

Concretely:

- **Aggressive cleanup on import is OK.** We are *not* required to
  preserve arbitrary cruft. Stylepox, abandoned custom styles, irrelevant
  hyperlinks, font/spacing overrides — all fair to normalize.
- **Verbatim and Advanced Verbatim semantics must be preserved with
  full fidelity.** Anything Verbatim's macros key on must
  round-trip — style names, document variables, run-level
  attributes — and every Advanced Verbatim macro effect we replicate
  must produce a doc Verbatim-using teammates can re-open without
  noticing the seam.
- **Exports look native.** Style names, outline levels, document
  variables, and direct-formatting conventions must match what Verbatim
  itself produces. The receiver should not be able to tell our editor
  was involved.

The version of the round-trip property we are *not* committing to: byte
equivalence. Word docx files are not byte-stable across saves anyway
(rsids, generation timestamps, etc.). Semantic equivalence is what we own.

## 4. Schema shape

Working sketch — to be refined as we build. The structural skeleton:

```
doc:           sequence of block-level kinds (flat)
pocket:        Heading 1 paragraph (inline content, stable id)
hat:           Heading 2 paragraph (inline content, stable id)
block:         Heading 3 paragraph (inline content, stable id)
card:          tag (card_body | undertag | cite_paragraph | analytic | table)*
analytic_unit: analytic (card_body | undertag | cite_paragraph | table)*
tag:           inline*      (only inside card)
analytic:      inline*      (inside analytic_unit, or in-card cite slot)
undertag:      inline*
cite_paragraph, card_body: inline body paragraphs (inside cards or
                           analytic_units, or loose at doc level)
paragraph:     inline*      (unstyled body text — implicit Normal)
table:         table_row+   (at doc level OR inside a card / analytic_unit)
table_row:     (table_cell | table_header)+
table_cell:    paragraph+   (cells hold generic paragraphs only)
table_header:  paragraph+   (kept for prosemirror-tables compat;
                            importer always produces table_cell)
```

`card` and `analytic_unit` content expressions are deliberately loose
(any body-slot type, in any order, repeated) so editing operations can
insert / drop / re-classify children without bumping into schema
constraints mid-edit. The importer still produces conventional shapes
(tag, then any cite_paragraphs, then bodies, optionally with undertags
or an analytic in a card's cite-slot); the looseness is the runtime
contract. Round-trip is a no-op since the strict ordering is just one
legal arrangement.

`cite_paragraph` is admitted as an analytic_unit child even though
analytics aren't conventionally citations — see the cite-handling
section in §15 for the rationale.

Notes:

- **Top-level is a sequence**, not a singular root. Real `.docx` files
  routinely carry multiple "files" in one document separated by empty
  Heading1 paragraphs (e.g. a DA and its companion CP shipped together).
  The schema embraces this rather than fighting it.
- **Heading-level nodes are flat**, not tree containers. Hierarchy
  (which cards sit under which Block, which Block under which Hat, etc.)
  is implicit in document order + outline level — not enforced by
  schema containment. The nav panel walks the flat sequence and groups
  by outline level to derive the tree view.
- **Pocket is optional at root.** Some real working docs have zero
  Heading1 paragraphs. Top-level entry can be Hat, Block, or a plain
  paragraph.
- **Plain `paragraph` block** is a first-class block-level type for
  unstyled body text. Real docs frequently contain unstyled paragraphs
  interspersed with structured content (especially in speech docs);
  the schema admits them directly at any position. This subsumes the
  earlier "scratchpad" escape hatch — a region of loose paragraphs and
  headings *is* the natural shape, not an exception that needs special
  wrapping. We deliberately do **not** auto-classify by heading title
  (e.g. "Patch Notes", "Cutting Board"). The project owner uses such
  conventions personally but they're not community-wide; baking them
  into import logic would mis-handle other users' files.
- **Marks** for inline emphasis: `cite_mark`, `underline_mark`,
  `underline_direct`, `emphasis_mark`, `undertag_mark`,
  `analytic_mark`, plus direct-formatting marks `highlight(color)`,
  `font_size(pt)`, `bold`, `italic`, `strikethrough`, `superscript`,
  `subscript`, `font_color`, `shading(color)`, and `link(href)` for
  hyperlinks (URLs are the common case; intra-doc links to
  bookmarked headings are supported for completeness — see §12 on
  heading IDs). `comment_range(threadId)` anchors a range to a
  thread in the comments plugin state. `strikethrough` round-trips as `<w:strike/>`; OOXML's
  `<w:dstrike/>` (double strikethrough) imports as the same single-
  strike mark. `superscript` / `subscript` round-trip as `<w:vertAlign
  w:val="superscript|subscript"/>` and are mutually exclusive (each
  declares `excludes: 'superscript subscript'`).

  `underline_mark` is the named "Underline" character style — used
  in body textblocks. `underline_direct` is plain direct underline
  (no rStyle on export) — used in structural textblocks (tag,
  analytic, pocket, hat, block, undertag). The named-style-
  normalizer plugin (and the importer's post-build pass) keep the
  context invariant: `underline_direct` never lands in a body slot;
  `underline_mark` never lands in a structural slot. Visually
  identical; the distinction matters for OOXML round-trip and for
  Verbatim's semantic classification.
- **Per-paragraph round-trip attrs.** Every node that serializes to
  `<w:p>` (paragraph, pocket, hat, block, tag, analytic, undertag,
  cite_paragraph, card_body) carries two attrs that preserve OOXML
  paragraph-level state across import → editor → export:
    - `indent` — left indent in dxa (1440 = 1 inch). Tab / Shift-Tab
      indent / outdent by one step (720 dxa). Rendered inline as
      `padding-left`.
    - `spacing` — opaque `{ [oxmlAttr]: value }` map captured from
      `<w:spacing>`. Round-tripped verbatim; rendering deliberately
      ignores it (per-type CSS governs the editor's visible rhythm).
  Tables carry analogous round-trip-only opacity: `table.rawTblPr`
  captures the entire inner content of `<w:tblPr>` (borders / styles
  / shading); `table_cell.rawTcPr` / `table_header.rawTcPr` capture
  per-cell `<w:tcPr>` extras (tcBorders, shd, vAlign) minus the
  structurally regenerated bits (gridSpan, vMerge, tcW) and any
  track-change markers. The exporter re-emits these fragments
  verbatim; the schema has no UI to edit them.
- **Comments** are first-class. Each commented range carries a
  `comment_range(threadId)` mark; the thread data
  (`Comment[]` with author / date / text / `kind` / `parentId`)
  lives in a plugin state map keyed by threadId. Round-trips to
  `<w:commentRangeStart/End>` in document.xml plus the
  `word/comments.xml` and `word/commentsExtended.xml` parts. The
  side-column UI is a grid-sibling of the editor in single-pane
  mode, toggled by the ribbon's Comments panel. In multi-pane
  mode the shell adopts the same column as a sibling of the
  three-pane row — visually a narrow fourth slot that shrinks
  the doc panes equally; threads shown follow focus, and cards
  re-layout as the focused pane scrolls. The `comment_range`
  mark renders with a subtle inline indicator so commented text
  is visible at a glance. AI-comment identification rides on
  `initials: 'AI'` + an author name ending in `(AI)` so it
  survives docx round-trip (Word strips the `kind` field on
  export); `isAiComment` recognizes either signal and honors
  legacy `kind: 'ai'` for back-compat with comments saved
  before the switch.
- **Track changes are accepted on import.** Wrapped runs inside
  `<w:ins>` / `<w:moveTo>` are recursed into as kept content;
  `<w:del>` / `<w:moveFrom>` are dropped entirely. `<w:pPrChange>` /
  `<w:rPrChange>` are ignored implicitly because pPr/rPr parsing
  only reads known properties. Table-revision markers
  (`<w:tcPrChange>`, `<w:cellIns>`, etc.) are stripped from
  `rawTblPr` / `rawTcPr` before storage.
- **Stable heading IDs.** Every heading-level node (`pocket`, `hat`,
  `block`, `tag`, `analytic` when it owns a paragraph) carries an
  `attrs.id` UUID, generated when the heading is created and preserved
  through all subsequent edits. Required by transclusion (§12) so that
  references survive heading renames and body edits. Round-tripped to
  docx as bracketing `<w:bookmarkStart w:name="..."/>` /
  `<w:bookmarkEnd/>` markers around the heading paragraph — Word's
  native mechanism for stable named locations, well-tolerated by
  Verbatim's cleanup passes.
- **Linked paragraph + character pair** (Analytic, Undertag, Cite) is
  handled by exposing each as *both* a block node and a mark. The source
  XML chooses the representation: `<w:pStyle w:val="Analytic"/>` →
  block node; `<w:rStyle w:val="AnalyticChar"/>` → mark. Export
  reverses.
- **The dual-encoding of Underline** (named style + direct
  `Font.Underline` property) must be preserved on export — Verbatim's own
  code keys on both. Same caution for `undertag_mark` and italic for
  parity.
- **Pilcrow** — a special inline node that exports as a 6pt ¶ glyph;
  represents a soft paragraph boundary inside a condensed card. Not
  observed in working drafts (the Condense feature is rare in the
  example docs), so low priority for v1, but the schema slot should
  exist.
- **Reading-position markers are just plain styled text**, not a
  special schema node. When the reader stops mid-card, an action in
  read mode inserts visible text (e.g. "Marked 7:32") at the cursor
  position with a distinguishing color (matching Verbatim's red-text
  convention from `Paperless.SendToSpeech`). The marker round-trips
  trivially because it's regular text in a regular paragraph. It's
  intentionally visible — readable by anyone who opens the doc, so
  other round participants can reference it.

## 5. Three-layer rendering model

Verbatim conflates content and visual styling — styles live inside each
docx, so changing display means changing every doc, and shipping a doc
ships your display preferences with it. We separate the layers:

1. **Schema** — structural types only. Does not specify rendering.
2. **Display config** — per-user, per-machine. Maps each schema node and
   mark to render parameters (font, size, color, weight, italic, spacing,
   indent, line-height, etc.). Stored as a per-user JSON; never touches
   any document.
3. **Direct formatting** — normal editing operation that overrides
   defaults on a specific node. Ships with the doc as part of the doc.

The export contract:

- Schema-typed structure → canonical Verbatim style definitions
  (`Heading4` for Tag, `Style13ptBold` for Cite, etc.).
- Direct formatting → run/paragraph properties on those styles, exactly
  as Word represents direct overrides.
- Display config → never touches the docx.

A user who wants a particular doc's tags to render a custom color for
*all* viewers applies direct formatting in the doc — same mechanism as
overriding `Font.Color` in Word. No special "embed config" toggle, no
team-wide config sharing required for v1.

The settings UI is itself a substantial feature: live-preview style
editor with per-node-type panels. This matches Verbatim's configuration
menu functionality and is non-negotiable.

**Accessibility customization is the same mechanism.** Per-user display
config is the natural place for accessibility presets — large-text mode,
high-contrast palettes, dyslexia-friendly fonts (e.g. OpenDyslexic),
increased line spacing, etc. These ride on top of the same display-config
infrastructure that handles personal style preferences; we just ship a
small library of accessibility-oriented presets the user can enable.
None of this leaks into exported docs (per the rules above).

## 6. Platform: web + desktop with shared core

Both editions ship from the same core. Architectural rule: anything that
isn't platform-specific lives in the shared core.

| Layer | Shared core | Desktop-only | Web-only |
|-------|-------------|--------------|----------|
| Schema | ✓ | | |
| Importer / Exporter | ✓ | | |
| Editor commands, plugins | ✓ | | |
| ProseMirror NodeViews + display config | ✓ | | |
| File I/O | (interface) | local FS | File System Access API + cloud |
| Read-mode keyboard lockdown | (logic) | OS-level | best-effort browser |
| Cross-app capture (Fast Debate Paste) | | OS hotkeys | n/a (browser limit) |
| Real-time collab (eventual) | (CRDT integration) | | sync server |

**Offline-primary positioning.** Tournament use is exclusively offline; the
desktop edition is the primary daily driver. The web edition's purpose is
collaboration and accessibility for users without full desktop machines.

## 7. Multi-doc workspace

Multi-doc is a *foundational* design decision, not a late add-on. Several
features collapse into "have N docs open at once with cross-doc
operations":

- The user's existing side-by-side workflow (cutting-board → structured
  area, drag-drop between panes).
- **Send-to-speech** (a card from the source doc lands in a designated
  speech doc).
- **Block Search results** opening in another pane.
- **Transclusion targets** (see §12) needing to be loaded in the
  background.

A single-pane editor would have to be retrofitted for all of these.
Building the multi-pane scaffolding from day one avoided that retrofit.

The shipped shell is a three-slot workspace. Two layouts switch
automatically based on viewport width: **compact** (vertical stack,
narrow viewports) and **wide-scroll** (slots side-by-side at a fixed
target width, the workspace overflow-scrolls horizontally when more
than two slots are visible). Each slot owns its own doc stack
(open-doc history with back / forward / close-and-restore semantics)
so working on a doc, hopping to a related one, and returning lands
the user back exactly where they were. **Mod-1 / Mod-2 / Mod-3** focus
slots 1, 2, and 3 respectively.

Cross-pane copy is a drag gesture: pick up a card or heading subtree
in one slot's editor or nav panel, drop into another slot. The
implementation is a coordinator-level transaction pair (serialize
from source, apply to target) sharing machinery with send-to-speech
(§10) — same primitive, different pickup affordance (per §13). Schema
validation runs on the destination, so cross-pane drops respect the
target's content rules just like in-doc drops.

**Per-pane state** that does *not* live on the doc: read mode (§9),
nav-panel collapsed state, scroll position, paintbrush arming. Two
slots can hold the same doc — one in edit mode for the cutter, one
in read mode at the podium — without conflict; per-doc view config
is plugin state keyed by `editorId`.

Cross-doc operations are coordinator code: ProseMirror transactions are
per-doc, but a coordinator can apply paired transactions in two docs as
a single user-visible action with one undo step.

## 8. Editor UI surfaces

Three load-bearing UI elements that we commit to up-front because their
shape ripples into the schema and rendering decisions.

### Default to "web view" — no page boundaries in the editing surface

ProseMirror is natively pageless: there's no `Page` concept, no
auto-pagination, no print preview. This matches Word's "Web Layout" view
mode and is what we want as the default.

We still need to **round-trip page breaks** in the docx, since real
templates include them — most notably the canonical Pocket style has
`<w:pageBreakBefore/>`, so every Pocket starts on a new page in
Word's "Print Layout" view. The schema
treats page breaks as **attributes preserved through round-trip but
not rendered as page boundaries** in our editing surface. Hard page
breaks (`<w:br w:type="page"/>`) become a `page_break` inline node that
renders as a faint horizontal divider (or is hidden, configurable);
`pageBreakBefore` becomes a paragraph attribute.

Print/PDF export, when we get to it, can honor page breaks. The editing
surface ignores them.

### Navigation panel / outline view

A persistent side panel showing the heading hierarchy of the active
document, like Word's Navigation Pane (`View` → `Navigation Pane`).

Affordances required:

- **Tree rendering** of all heading-level nodes: Pocket > Hat > Block
  > Tag (and Analytic at the same level as Tag). Indentation reflects
  outline level.
- **Collapse/expand** subtrees. Collapsed state is a UI-only attribute,
  not stored in the doc.
- **Drag-to-reorder** within and across levels. Drops respect the
  schema (you can't drop a Hat into a Card; you can drop a Block into
  any Hat). Equivalent to Verbatim's `MoveUp` / `MoveDown` /
  `MoveToBottom` macros but as direct manipulation.
- **Promote / demote** — change a node's outline level (Tag → Block,
  Block → Hat, etc.). The schema permits these by allowing
  outline-level nodes at multiple positions; promote/demote is just a
  type-change transaction.
- **Delete heading and contents** — atomic deletion of the entire
  subtree rooted at the selected heading.
- **Select heading and contents** — selects the heading paragraph
  plus every descendant. Equivalent of Verbatim's
  `SelectHeadingAndContent` macro.
- **Grab heading and contents** — copy (or cut) the entire subtree
  to clipboard, schema-aware. Pastes elsewhere as the same subtree
  shape, not as loose paragraphs.

Implementation: the panel is a derived view of the schema's heading
nodes. It re-renders incrementally on each transaction that affects a
heading. ProseMirror's `descendants` traversal makes this cheap.

### Concrete render fixtures (Pocket box, Emphasis box, etc.)

Some of Verbatim's canonical styles use Word features that have direct
CSS analogues but need explicit handling. The display config (per §5)
ships with these as the default rendering, matching what Verbatim
produces:

| Style    | Verbatim feature | Default render |
|----------|------------------|----------------|
| Pocket (Heading1) | `<w:pBdr>` on all four sides | Paragraph rectangle (CSS `border` on the block element) |
| Hat (Heading2) | `<w:pageBreakBefore/>` + centered, double underline | Centered, double-underlined heading; page-break ignored in web view |
| Block (Heading3) | `<w:pageBreakBefore/>` + centered, single underline | Centered, single-underlined heading; page-break ignored in web view |
| Emphasis (character) | `<w:bdr>` single 1pt | Inline rectangle around the emphasized run (CSS `border` on the inline element) |

Round-trip note: these features are declared in the canonical style
definitions, so on export we emit the standard Verbatim style block
into `word/styles.xml` and the document paragraphs/runs simply
reference the style. We don't redundantly emit borders per-paragraph
unless a user has applied direct-formatting overrides.

User display config can override these defaults for personal viewing
(per §5 rules — config never touches the docx). If a user wants a
particular doc to render *differently for everyone*, that's direct
formatting on individual paragraphs/runs, which ships with the doc.

---

## 9. Read mode (view mode of the editor)

Read mode is **not a separate UI surface** — it's a view mode of the
same editor with an invisibility filter applied. Same NodeViews, same
schema, same doc; non-read-aloud content is hidden via a CSS-class
toggle. This is the non-destructive equivalent of `InvisibilityOn`.

Read mode is **per-pane** in the multi-doc workspace (§7), not global
and not a doc attribute. One slot can be a read surface at the podium
while another slot holds the same (or a different) doc in edit mode
— the read-mode flag lives in pane state keyed by `editorId`. The
ribbon's read-mode toggle (`toggleReadMode` in the command registry,
§15) acts on the focused pane and is rebindable through the keyboard-
shortcuts settings panel.

What read mode actually does:

- **Hide non-read-aloud content** via the read-aloud predicate (below).
  Implementation: a doc-level class on the editor toggles a stylesheet
  that sets `display: none` (or `visibility: hidden`) on elements that
  don't pass the predicate. ProseMirror keeps rendering everything;
  only the styling differs. Nothing is destructive.
- **Block general editing input.** Trackpad twitches and stray
  keystrokes at the podium cannot insert characters or trigger
  commands. Only navigation and a small allowlist of read-mode-specific
  operations work.
- **Allow inserting reading-position markers** — the one editing-shaped
  operation read mode permits. A keystroke inserts visible text (e.g.
  "Marked 7:32") at the cursor in a distinguishing color (red, by
  default, matching the Verbatim convention). The marker is plain
  styled text, not a special schema node — it survives the
  read-mode → edit-mode transition because nothing about it is
  read-mode-specific, just its insertion mechanism.
- **Adjust display config for podium use** is a user choice, not a
  read-mode-imposed change. Users who want larger text, different
  contrast, or simpler chrome at the podium configure this in their
  display config (which can include accessibility presets, see §5).
  We don't impose a "read mode visual style"; we provide the knobs.

### Read-aloud predicate

The rule that decides what stays visible in read mode (and what
counts as "reading material" for the word-count macro analog):

> Paragraphs in `Tag`, `Cite`, or `Analytic` style, OR characters
> with highlighting, OR characters inside a paragraph that already
> passes the predicate.

This same predicate is shared across read mode, send-to-speech
filtering, and word-count analysis. Single source of truth, multiple
consumers.

## 10. Send-to-speech and speech-doc shape

Speech docs are regular saveable documents — they aren't a special doc
type. They typically have **partial hierarchy**: enough block-level
structure (often a Block heading per send) for the speaker to navigate
via the navigation panel during delivery, but no requirement that they
mirror the full Pocket > Hat > Block > Tag scaffolding of source
files. The conventional assembly pattern is:

1. From a source doc, the user invokes "send to speech" on a Block
   heading (or drags the heading from the nav panel). The Block plus
   all its content moves into the speech doc as a single unit,
   preserving the Block's local hierarchy (block + cards beneath).
2. The speaker drags entries around in the final speech doc to
   establish reading order.
3. The speaker types unstyled bridge text between cards as they
   build their flow. This unstyled text rides as `paragraph` content
   between the cards (per §4).
4. At delivery time, read mode's invisibility filter (§9) hides
   the bridge text and non-highlighted material; the speaker reads
   what's left.

The most architecturally demanding feature. Lives on top of the
multi-doc workspace + cross-doc-coordinator + read-mode foundation.

What a "send" action does:

1. Source doc card is selected.
2. Coordinator applies a transaction in the speech doc that inserts the
   card content at the active insertion point.
3. Coordinator applies a transaction in the source doc that places a
   reading-position bookmark or "sent" marker at the source position.
4. The pair is presented as one user-visible action with one undo step.

Speech docs are regular saveable documents. They aren't a special doc
type. Transient/per-round speeches use a "new scratch speech" affordance
to skip the normal save-flow friction; persistent speeches (canned 1AC,
blocks) save normally.

The "Marked at HH:MM" indicator from stock Verbatim is the same
mechanism described in §4 and §9 — a plain styled-text marker the
reader inserts when stopping mid-card. The send-to-speech action does
not insert it automatically; it's a separate read-mode operation
invoked when the reader pauses. The two actions share no machinery
beyond "insert text at cursor."

## 11. Search

Two scopes, two phases. Both are planned for a later release —
the workspace shell, schema, and round-trip are in place; full-text
and schema-aware search across docs is roadmap work.

**Workspace search** — across all currently-open docs in the
workspace. Index lives in memory, updates incrementally as docs are
edited. Schema-aware: queries can filter by node type ("all cards
under hat X", "all cites by author Y"), not just text.

**Corpus search** — across the user's entire evidence library on
disk, including files not currently open. Persistent on-disk index,
file-watcher for updates, larger engineering investment. The
priority that supersedes the existing standalone Block Search tool.

Block Search's current capabilities (Ctrl+Space focus, Context View,
multi-select, batch-process, send-to-target) are the feature targets;
the schema-awareness of our index is the value-add over the current
external tool.

Until corpus search ships, the existing standalone Block Search remains
useful for indexing files that aren't open in the editor.

**Interim: command-palette file search (`f`).** A first, deliberately
un-indexed slice of corpus search ships in the command palette. `f`
recurses the configured `fileSearchRoot` for `.cmir` files (matched on
filename), Enter opens one, and Tab dives into a file — parsing it and
listing its structural objects (blocks / tags / cites / …, per
`fileSearchObjectTypes`) so the user can search within it and insert a
match as a slice (`file-search.ts`, reusing `collectHeadings` /
`computeHeadingRange`). The recursive `.cmir` *file listing* is cached
and persisted in the main process with per-file mtime + size
(`host:list-cmir-files`, `{userData}/cmir-file-index.json`), refreshed
in the background — so repeat searches and post-launch searches don't
re-walk the tree. But *object/content* search is still parse-on-demand
(one file at a time, when dived into): there's no persistent content
index yet, and the schema-aware corpus-wide queries described above are
still the destination. The stored mtimes are the hook for the eventual
content index's reparse-only-what-changed pass. Staged this way to find
the performance ceiling before investing in full indexing.

### Search as the transclusion-target picker

Search is also how the user picks transclusion targets (see §12). When
the user invokes "transclude here," the search panel opens in a
target-picker mode: results are filtered to heading-level nodes
(transclusion-eligible), and selecting a result resolves the source
identity (file path + stable heading ID) for the new
`transclusion_ref` node. Same index, same UI, narrower filter — no
parallel UI to maintain.

## 12. Transclusion

Two flavors discussed; v1 ships the simpler one, v2+ may layer the
ambitious one. The picker UX, target identity, and back-reference
tracking are common to both.

### Picker: search-driven

The user invokes "transclude here" from a position in their consumer
doc. The search panel opens in target-picker mode (§11): the corpus
is filtered to heading-level nodes (transclusion-eligible). The user
queries — "impact defense economy" — picks a result, and a new
`transclusion_ref` node is inserted at the cursor.

This means transclusion is naturally driven by what's *in* the user's
corpus rather than by remembering paths. The same search machinery
that powers normal evidence retrieval powers transclusion targeting.

### Target identity

A `transclusion_ref` stores `{source_path, source_heading_id,
content_hash, cached_content, last_refreshed}`:

- `source_heading_id` is the stable UUID on the target heading
  (per §4). This is what survives heading renames and body edits;
  the heading text is *not* the identity.
- `source_path` locates the source doc on disk (in v1) or as a
  resolvable reference (URL, content-addressed hash) in later
  versions.
- `content_hash` and `last_refreshed` drive the staleness indicator.

### v1: refresh-on-demand

Renders `cached_content`. User clicks "refresh" to re-fetch from
source and reconcile. Stale indicator when source's current hash
differs from `content_hash`. No backend; works offline.

### v2+: live shared cards

Same schema node, push-based updates via Y.js + ProseMirror or
similar. Requires backend (or P2P sync), auth, conflict resolution
UX. The schema doesn't change — the difference is push vs pull and
the network/sync layer underneath.

### Back-reference tracking (producer-side)

Producers — users editing the doc that *contains* the source heading —
need to know that destructive edits will propagate. Tracking lives in
a workspace-scoped sidecar index, not in the source doc itself:

- **Storage**: a sidecar JSON file (`<workspace>/.transclusion-index.json`
  or similar) maps `heading_id → [{consumer_path, consumer_position,
  last_seen}]`.
- **Population**: built by scanning consumer docs in the workspace at
  startup, on demand, or incrementally as docs are saved. Fully
  reconstructible from scratch.
- **Why sidecar instead of in-doc**: embedding back-refs in the source
  doc would (a) modify a doc just because someone else transcluded
  from it, awkward semantics; (b) need to survive Verbatim cleanup
  passes that don't know about them. A sidecar avoids both.
- **Round-trip**: the sidecar is workspace-local and *not* part of
  the docx. It's lost when a doc travels to another machine; the
  receiving machine rebuilds its own index by scanning its workspace.

### Producer-side UX (destructive-edit warning)

When a user is editing inside a heading whose ID has back-refs:

- A **non-modal indicator** in the heading's gutter shows
  "referenced by N docs." Click to see the list.
- On a **destructive edit** (large deletion, content-replacing
  operation, deletion of the heading itself), prompt to confirm
  with the option to **"fork the heading"**: duplicate the heading
  in place, give the duplicate a fresh ID, and let consumers
  continue pointing at the old (now-immutable-by-convention) copy
  while the user's edits proceed on the working copy.
- "Destructive" is heuristic, not load-bearing. False positives
  (over-warning) are tolerable; false negatives (silently breaking
  consumers) are not.

### Cycle detection

Required in either flavor. A → B → A is rejected at the picker
stage; if the user attempts it, the picker shows the cycle path and
declines to insert the reference.

### Export behavior — snapshots, not references

When a doc with `transclusion_ref` nodes is exported to docx, each
reference is **frozen as a snapshot of its current `cached_content`**
in the exported file. The exported docx contains plain content — no
transclusion identity, no special markup, fully native to Verbatim.
Anyone opening the file sees ordinary evidence; they don't (and
shouldn't) know it was transcluded.

This is what falls out of the model by default: `cached_content` is
what we render, and what we render is what we export.

#### Implication: re-import drops transclusion identity by default

If the user exports a doc to docx and later re-imports the *same* file,
the transclusion-ness is lost — every reference comes back as plain
content. To get the references back, the user re-transcludes (the
search-driven picker makes this cheap).

This is acceptable for v1 because the natural workflow is: keep the
working file open in the editor (where transclusions persist as
references), and export to docx only for sharing or archiving.

#### Optional refinement (deferred): bookmark-anchored sidecar

For users who want transclusion identity to survive a docx round-trip
(export → close → re-open → still transcluded), a deferrable
refinement: wrap each snapshot on export in a uniquely-named
`<w:bookmarkStart w:name="transclusion-{uuid}"/>` ... `<w:bookmarkEnd/>`,
and write a workspace-scoped sidecar (combine with the back-ref
sidecar from above) that maps each bookmark UUID to its source
identity. On re-import, bookmarks with the `transclusion-` prefix
restore as `transclusion_ref` nodes if the sidecar is present;
without the sidecar, they're harmless (Verbatim ignores unknown
bookmark names; the content is still readable).

Defer until there's evidence users want it; the default snapshot
behavior is the right v1.

## 13. Drag-and-drop on cards/blocks

ProseMirror NodeViews + the standard drag/drop APIs make this
straightforward:

- Each block-typed node renders with a drag handle (gutter affordance,
  hover-to-reveal grip, modifier+click target — UX choice).
- Schema-aware drop zones: the schema's content expressions tell us
  which siblings a node can move between. Invalid drop targets are
  not lit up; invalid drops are rejected.
- Atomic moves: one ProseMirror transaction repositions a node and its
  descendants. Single undo step.
- Modifier scoping (super-drag = card, super+shift-drag = block, etc.)
  is a UX choice on top of the same primitive.
- Drag works **from the navigation panel** (§8) as well as from the
  editor surface — drag a heading entry in the outline view; drop it
  anywhere a heading of that type is valid. Same primitive, different
  pickup affordance.

The Hyprland super+click+drag analogy holds well — Hyprland operates on
a tree of windows; we operate on a tree of nodes.

### Cross-doc drag = send-to-speech as a UI affordance

Drag-and-drop works **between documents** in the workspace, not just
within a single doc. Pick up a card in your evidence file, drop it
into a speech-doc pane — that's a one-gesture cross-doc copy. Same
mechanism for a heading dragged from one doc's nav panel into
another doc's editor or nav panel.

Cross-doc drag and the send-to-speech command (§10) are **the same
primitive with different UI surfaces**. Both serialize a fragment from
the source doc, apply it as a transaction in the target doc, and (for
send-to-speech specifically) optionally fire a paired transaction in
the source doc. The cross-doc-coordinator code lives once; it's
exposed as drag-and-drop, as an explicit "send to speech" command, and
(via the search panel) as "send result to target."

Schema validation still applies: dropping a Block into a Card in
another doc is rejected for the same reason it's rejected within one
doc. Cross-doc drops respect the destination schema.

Performance consideration for very long docs (1000+ cards): only
compute drop targets near the drop point, not across the whole tree.
Concretely the drag-handle plugin uses an `IntersectionObserver` to
lazily mount drop-indicator decorations only on the heading nodes
currently near the viewport (with a generous root margin so a fast
scroll-then-drop still hits a primed target). Headings outside that
window keep zero DOM overhead until the user gets close.

## 14. Editing semantics (card-aware editing behavior)

The schema (§4) gives us strong structural guarantees: a card has a
required tag, undertags belong to the tag they follow, an analytic_unit
has an analytic at its root, etc. Word doesn't enforce any of this —
its editing model is "every paragraph is independent; styles are just
labels." Most of the time the user's editing actions (Backspace, Enter,
Delete, type-text, paste, drag) are unambiguous, but at node boundaries
Word's loose semantics and our typed schema disagree. This section is
the catalog of those disagreements and the rules we pick.

The general design tension: **Word's behavior is what users have
muscle memory for**, but it can produce schema-invalid intermediate
states (a card with no tag, an undertag outside a card, a Heading-3
that turns into a body paragraph mid-keystroke). We pick a rule per
interaction; the editor enforces it via ProseMirror commands and
keymap overrides. Where in doubt, prefer the rule that matches the
*user's likely intent* over the rule that matches Word.

This section is the source of truth for those rules.

### Body-slot absorption after card / analytic_unit

A body-slot node at doc level whose immediate previous sibling is a
`card` or `analytic_unit` is auto-absorbed into that container. The
absorbable types are exactly the ones that are valid children of both
container types — `paragraph`, `cite_paragraph`, `undertag`, and the
already-typed `card_body`. Type mapping:

- `paragraph` → `card_body`.
- `cite_paragraph` → `cite_paragraph` (preserved as-is).
- `undertag` → `undertag` (preserved). Undertags do NOT terminate the
  absorption zone — F7 on plain text followed by undertag annotations
  should produce a single card with the undertag absorbed, not a card
  followed by an orphaned undertag.
- `card_body` → `card_body` (rare at doc level, preserved if seen).

To bound a region of loose body-slot paragraphs after a card, insert
a heading (Pocket / Hat / Block) or another container — anything not
in the list above breaks the absorption zone.

Cases preserved (no absorption):

- Heading → paragraph → tag (legitimate bridge text between a section
  heading and the cards beneath it).
- Doc start → paragraph (top-of-doc preface).
- Heading → paragraph → heading (loose paragraph between sections).

Implemented as `src/editor/absorb-plugin.ts`, an `appendTransaction`
plugin that runs after every doc-changing transaction.

### Cite paragraph classification (runtime invariant)

A paragraph-like textblock's *type* tracks its inline content's cite
state. On every dispatched transaction, `src/editor/cite-classifier-plugin.ts`
walks the doc and:

- Promotes a `card_body` (in a card or analytic_unit) or a doc-level
  `paragraph` to `cite_paragraph` if any of its inline runs carries
  the `cite_mark` mark.
- Demotes a `cite_paragraph` back to `card_body` (inside a container)
  or `paragraph` (at doc level) if no inline run carries `cite_mark`.

This single bidirectional rule makes pastes, splits, F8 / inline-mark
toggles, and other content edits keep the paragraph type consistent
with the user's visible cite content without per-operation logic. The
importer uses the same rule on load.

`cite_paragraph` is admitted inside `analytic_unit` (alongside
`card_body` and `undertag`) so the classifier doesn't have to special-
case that container. Conventionally analytics don't carry citations,
but the looser schema collapses what had become a forest of edge
cases in the cite-paste logic and makes "any body slot can hold a
cite" the universal rule.

### Tag boundary editing

The rules below all apply equivalently to `analytic` (in an
`analytic_unit`). Pocket / Hat / Block use ProseMirror's default
behavior — no overrides needed.

A paragraph counts as **blank** for these rules if its `textContent`
trimmed is empty (whitespace-only paragraphs included). The "previous
paragraph" of a tag is whatever appears immediately before the tag's
containing card in document order — this includes the last `card_body`
of a preceding card, since that's the candidate for being a blank
trailing line that the user might want to delete.

##### Empty tag-only container
If the tag (or analytic) is empty AND it is the only child of its
container (no body, no cite, no undertag), Backspace at the start
*or* Delete at the end of the head deletes the whole container. If
that would leave the doc with no children at all, the container is
replaced by an empty paragraph so the editor still has a textblock
for the cursor. Whitespace-only heads count as empty for this rule.

##### Empty tag with surviving siblings — merge into previous
If the tag (or analytic) is empty (or whitespace-only) AND the
container has other children (card_body, cite_paragraph, undertag,
or an in-card analytic), Backspace at the head's start *or* Delete
at its end drops the empty head and migrates the container's
remaining children into whatever doc-level node sits before it:

- Previous is a card / analytic_unit → append. An analytic in a
  card's cite-slot folds to card_body when merging into an
  analytic_unit (no cite-slot there).
- Previous is anything else (paragraph, heading, …) or there is no
  previous node → lift the survivors to doc level.

Cursor lands at the merge boundary: end of the preceding content
on Backspace, start of the merged content on Delete.

##### Backspace at the start of a tag (non-empty tag)
Permitted only when the preceding paragraph is blank — delete the
blank paragraph; the tag stays intact and the cursor remains at the
start of the tag. Otherwise, prohibited (no-op). The rule applies
regardless of whether the blank paragraph is at doc level or is a
trailing card_body inside the previous card.

##### Enter in the middle of a tag
Word's default behavior: split the tag at the cursor; the pre-cursor
text becomes a new tag-shaped card inserted before the original; the
post-cursor text remains in the original card with all its existing
content (cite, body, etc.). Both halves keep tag styling. Cursor lands
at the start of the post-cursor (continuation) tag.

##### Forward Delete at the end of a tag (non-empty tag)
Permitted only when the next paragraph in document order is also a
tag. Merges the two tags into one; the resulting card retains the
later card's content (cite/body/etc.). When the next paragraph is
anything else (cite, body, undertag, heading), the operation is
prohibited.

##### Backspace at the start of the first body slot
Cursor at offset 0 of the FIRST body slot in a card or analytic_unit
(the body whose previous sibling is the container's anchor — typically
a `cite_paragraph` immediately after the tag, but the rule applies to
any body type):

- If the head is blank: drop the head and merge the container's
  surviving children into whatever doc-level node sits before it.
  Same cross-type folding as the empty-head merge initiated from the
  head side.
- If the head is non-empty: no-op, swallow the event.

The non-empty case explicitly refuses ProseMirror's default
`joinBackward`, which would merge the body's inline content into the
tag — silently mixing cite-styled or body text into the heading.

Bodies that aren't the first slot (cursor at start of `body2` in
`[tag, body1, body2]`) fall through to the default — `joinBackward`
correctly joins them with their previous sibling in the same
container.

##### Forward Delete at the end of the last body in a container
Cursor at the end of the LAST child of a card / analytic_unit, where
that last child is a body slot (card_body / undertag / cite_paragraph
/ in-card analytic — anything but the container's anchor):

- If the next doc-level sibling is a card or analytic_unit whose head
  is blank (whitespace-only): drop the blank head and absorb that
  container's surviving children into the current container. The same
  cross-type coercion as the empty-tag merge applies — analytic in a
  card's cite-slot folds to card_body when going into an
  analytic_unit. Cursor stays at the end of the original last body.
- Otherwise (next is a non-empty card/analytic_unit, a heading, a
  paragraph, or end of doc): no-op. The default Word behavior of
  pulling the next paragraph into the current body as plain text is
  refused, since it'd silently destroy tag/heading structure.

Mirror of the "empty tag with surviving siblings — merge into
previous" rule above, just initiated from the body side instead of
the empty-head side.

##### Enter at the end of a tag
Creates a new card_body (Normal style) and moves the cursor into it.
The card_body is inserted at the schema-correct position within the
current card.

##### Enter at the start of a tag
Splits with an empty tag before the original — i.e., a new empty card
(empty tag, no body) is inserted before the current card; the original
card's content is unchanged; the cursor remains at the start of the
original tag.

## 15. Companion-tool integration boundaries

The user maintains several companion tools today (referenced in
`https://debate-decoded.ghost.io/leveling-up-verbatim/` and elsewhere).
Most of these tools are *patches around Word's limitations*. In a
purpose-built editor, many of them stop being external tools and
become features of the platform. The integration question is "what
gap in Word did this tool exist to fill, and does our editor close
that gap natively?"

### Verbatim ribbon-command parity

The same logic applies to Verbatim's own ribbon commands. Operations
like `AutoNumberTags`, `DeNumberTags`, `AutoFormatCite`,
`ReformatAllCites`, `FixFakeTags`, `ConvertToDefaultStyles`, and the
shrink/condense/expand family are simple text-manipulation transforms
operating on the schema. They cost essentially nothing to reimplement
as native editor commands and the value is feature parity — users
don't need to bounce to Word for any of them.

Native versions of every Verbatim ribbon command that isn't subsumed
by editor primitives we already have (e.g., `MoveUp`/`MoveDown` are
subsumed by drag-and-drop; `SelectHeadingAndContent` is subsumed by
the navigation panel) map directly to schema transforms here.

The ribbon commands (all in `src/editor/ribbon-commands.ts` unless
noted) are routed through a single `RibbonCommandId` registry so the
"Keyboard shortcuts" settings panel can rebind anything through one
overrides surface:

- **Structural-style hotkeys (F4 / F5 / F6 / F7 / Mod-F7 / Mod-F8).**
  Set the current paragraph or heading to Pocket / Hat / Block / Tag /
  Analytic / Undertag respectively. Conversion rules handle every
  cursor position: any doc-level textblock that holds inline content
  (`paragraph`, `cite_paragraph`, `undertag`, `card_body`, `pocket`,
  `hat`, `block`) ↔ heading is in-place; tag (inside card) and
  analytic (inside analytic_unit) dissolve their wrapper; any in-card
  body slot (`card_body`, `cite_paragraph`, `undertag`) splits the
  card. When dissolving a card's tag to undertag, if the previous
  doc-level sibling is a card of the same type, the new undertag and
  any surviving non-head children are absorbed into that previous
  card (round-trips the F7→Mod-F8 promote-then-demote case cleanly).
  Multi-paragraph selections apply the target style to every touched
  paragraph in a single rebuild. Heading IDs preserved across
  heading↔heading conversions.

  **Strip-on-apply.** Every promotion code path strips
  `PROMOTION_STRIP_MARK_NAMES` (all direct formatting + every
  named-style mark) from the new structural block's content — the
  destination's CSS typography defines the run's identity. Exception:
  tag ↔ analytic is a same-tier swap (same structural role, only the
  cite/analytic semantic differs), so `convertCardToAnalyticUnit`,
  `convertAnalyticUnitToCard`, and the matching branch of
  `asTransformed` deliberately preserve direct formatting.
- **Mod-B / Mod-I.** Toggle the `bold` / `italic` direct-formatting
  marks via `toggleMark`. Standard Word semantics.
- **F2 — Paste Text (armed mode).** Browsers won't let a web app
  read the clipboard programmatically without a permission prompt
  (Chromium's "Paste" chip, Firefox's "Paste" popup with no
  persistent grant), so F2 can't be a one-keystroke action. Instead
  F2 toggles a flag in `paste-plugin.ts`; the next real
  Ctrl/Cmd+V paste consumes the flag, strips all marks, inserts
  via `buildPlainTextSlice` (paragraph breaks on `\r\n` / `\r` /
  `\n`), and disarms. Status-bar pill shows the armed state. When
  the `condenseOnPaste` setting is on (default off), runs the same
  condense F3 invokes immediately after the paste lands. The paste
  plugin also auto-splits the destination container when the
  pasted slice is a single `tag` or `analytic` node and the cursor
  sits in a body slot of a card / analytic_unit — preserving the
  structural type instead of falling back to PM's "fit inline
  content" behavior which would otherwise strip the heading wrapper.
- **F8 — apply Cite character style.** Applies `cite_mark` to text in
  the selection but skips structural blocks (tag, analytic, pocket,
  hat, block, undertag); a span across a tag-bracketed body region
  only marks the body portions. No-op on collapsed selections.
  Strips direct formatting (font_size / color / family, bold, italic,
  strikethrough, highlight, shading) in the same range — the named
  style's typography replaces direct overrides.
- **F9 / Mod-U — toggle Underline.** Two backing marks reflect
  Verbatim's named-style vs direct distinction:
  `underline_mark` (the "Underline" character style — used in body
  textblocks) and `underline_direct` (direct-formatting underline,
  no rStyle on export — used in structural textblocks: tag, analytic,
  pocket, hat, block, undertag). Toggle off only when every selected
  character is already underlined (either mark counts); partial state
  adds underline to the not-yet-underlined characters. Empty
  selection: expand to the **word at the cursor** — the maximal run
  of non-whitespace characters in the cursor's textblock — and toggle
  that. Mark boundaries do not break a word: two text nodes with no
  whitespace between are one word. No-op when the cursor is in
  whitespace, in an empty textblock, or on an inline leaf. Adding
  `underline_mark` to body text strips any conflicting `cite_mark` /
  `emphasis_mark` in the range — body text holds at most one of
  cite / underline / emphasis. Mod-U is a registered alias of F9
  for the future settings UI; only F9 surfaces in the ribbon chrome.
  **Apply direction** strips direct formatting (Verbatim parity);
  `underline_direct` is excluded from the strip set so the
  structural-segment apply doesn't erase its own newly-added mark.
  **Toggle-off direction** strips direct formatting only when the
  `clearFormattingOnNamedStyleToggleOff` setting is on (default;
  matches Verbatim's "press F9 twice clears formatting"). Off-state
  preserves any direct formatting the user manually applied.
- **F10 — apply Emphasis character style.** Same shape as F8 in most
  respects — applies `emphasis_mark` to text in the selection, skips
  structural blocks (tag, analytic, pocket, hat, block, undertag),
  apply-only (idempotent). Schema `excludes` on `emphasis_mark` auto-
  strip any `cite_mark` / `underline_mark` in the range. Differs from
  F8 on empty selection: F10 expands to the word at the cursor (same
  whitespace-delimited "word" as F9), where F8 just no-ops. The
  asymmetry matches typical usage — cites are phrases the user
  deliberately selects, emphasis is often a single word and the
  cursor-on-word gesture is convenient. F8 and F10 share
  `applyBodyMark()` internally; the differing empty-selection
  behavior is parameterized via `expandToWordWhenEmpty`. Both strip
  direct formatting in the marked range as part of the apply.
- **Alt-F10 — Emphasize Acronym.** Per-word-first-letter variant of
  F10: walks the selection, expands to whole-word boundaries, and
  applies `emphasis_mark` to the first character of each word —
  intended for marking the source letters of an acronym
  ("United States Capitol Police" → U, S, C, P). Word definition
  matches the Layer-1 word iterator (`isWordChar` in
  `word-break.ts`), so `U.S.A.` is three words and each leading
  letter is marked individually. No-op on empty selection. Skips
  structural blocks (same body-only rule as F10).
- **F11 — toggle Highlight.** Color-agnostic toggle: if every char in
  the selection already carries any `highlight` mark, the toggle
  strips it. Otherwise the active color (from `settings.lastHighlight
  Color`) is applied across the whole range, replacing any existing
  color. Empty selection: no-op (no word expansion — highlights are
  typically multi-word). No structural-block skip — tags / analytics
  / etc. can carry highlights, since they're a runtime annotation,
  not a semantic style. Supports all 15 Word named highlight colors
  (`yellow`, `green`, `cyan`, `magenta`, `blue`, `red`, plus the six
  `dark*` variants, `lightGray`, `darkGray`, `black`) round-tripped
  as `<w:highlight w:val="…"/>`.
- **Alt-F11 — Highlight Acronym.** Per-word-first-letter variant of
  F11, mirroring Alt-F10's relationship to F10. Same selection-
  expand + word-walk as Emphasize Acronym; applies the active
  highlight color (`settings.lastHighlightColor`) to the first
  character of each word. Two deviations from Emphasize Acronym
  that parallel F11 vs F10: no structural-block skip (works in
  tags / analytics / etc., same as F11) and no direct-formatting
  strip (highlight is additive). Apply-only — re-running with a
  different active color overwrites the previous acronym color on
  the same first-letter slots.
- **Mod-F11 — toggle Background color (shading).** Same toggle shape
  as F11 but operates on the `shading` mark (`<w:shd w:fill="…"/>`,
  RGB hex). Independent of highlight — both marks can coexist on the
  same character. When both are present, highlight wins visually
  because `highlight` is defined after `shading` in the schema, so
  PM's mark-rank ordering puts highlight as the inner DOM wrapper.
  Default active color is `D2D2D2` (Verbatim's "protected highlight"
  grey produced by `HighlightToBackgroundColor`).

**Ribbon color panel:** a third panel section after the cite panel
holds three split buttons — Highlight (highlighter glyph), Background
(paint-bucket glyph), Font Color (`A` glyph tinted by the active font
color). Each control is a slim split button: a wider main button +
a narrower arrow (visually subordinate). The panel is a 2×2 grid with
column-major flow — Highlight at top-left, Shading directly under it,
Font color top-right (bottom-right reserved). Same stacked rhythm as
the cite panel.

**Selection-present click:** the main button applies the active color
to the selection via the matching command (F11 / Mod-F11 toggle for
highlight/shading; direct-apply for font color, with `null` meaning
Automatic).

**Empty-selection click → paintbrush mode** (Word's highlighter
behavior). Clicking a main button with an empty selection toggles a
sticky paintbrush mode for that mark. The editor cursor changes
(`cursor: cell` via a `.pmd-paintbrush-{mode}` class on
`view.dom` / `.ProseMirror`), the active button reads as
"grayed-out / pressed", and every subsequent drag-select inside the
editor automatically applies the active color. The mode stays active
across multiple applications until Escape or clicking the same button
again. Clicking a different color button switches the paintbrush type
(state is single-slot).

Three Word-mirroring refinements:
  - **Toggle behavior** (highlight + shading paintbrush): the
    paintbrush apply uses the toggle command (`applyHighlight` /
    `applyShading`), not `setHighlightColor` / `setShadingColor`.
    Re-painting an already-marked range strips the mark. Color-
    agnostic — any uniform mark, regardless of its color, gets
    stripped on re-paint. Font color paintbrush stays as `setFontColor`
    since font color isn't a binary on/off mark.
  - **Selection collapses after each apply** ("lift the brush"). The
    paintbrush mouseup handler captures the apply transaction, appends
    a `setSelection(TextSelection.create(doc, sel.to))`, and dispatches
    once — so the user sees what they just painted without the
    selection overlay obscuring it, and undo treats apply + collapse
    as one step.
  - Paintbrush is button-only — F11 / Mod-F11 hotkeys remain pure
    toggles that no-op on empty selection.

**Arrow → swatch picker.** Each picker is a 4×4 grid with 16 entries.
The top-left swatch is consistently the strip/automatic option across
all three controls; the remaining 15 are Word's named highlight
colors with canonical RGBs.
  - Highlight: top-left "No highlight" (strips, one-shot, does not
    persist) + 15 Word named colors (persisted by name).
  - Background: top-left "No background color" (strips, one-shot) +
    15 RGB equivalents of the Word names (persisted by hex).
  - Font Color: top-left "Automatic" (persisted as `null`, removes
    the mark) + 15 RGB equivalents.

Picking a swatch updates the per-control setting where applicable
(`lastHighlightColor`, `lastShadingColor`, `lastFontColor`) AND
applies it to the current selection in one click. The picker dismisses
on outside-click or Escape. Live "current color" bars under each
main button stay in sync with settings.

Font color is fully independent of highlight and shading — applying
one never touches the others. `font_color` round-trips as
`<w:color w:val="…"/>` and writes `null` (the Automatic option) as
"no mark" rather than explicit black.

**`000000` is rendered as inherited, not as an inline style.** Word
writes `w:color="000000"` on a large fraction of runs even when the
user picked "Automatic" or never touched the color picker. The
`font_color` mark imports those faithfully, but `toDOM` skips the
inline `style="color: #000000"` for the `000000` sentinel and emits
only `data-color="000000"`. This lets dark mode and the
Accessibility-panel per-token text-color override beat what would
otherwise be a hardcoded black. Round-trip is intact: the exporter
reads `attrs.color` directly, and `parseDOM` reads from `data-color`.

**Luminance bands give CSS arbitrary-color contrast control.**
`colorBand(hex)` in `src/schema/marks.ts` classifies a 6-hex RGB
into `dark` (perceived luminance `(0.299r + 0.587g + 0.114b) / 255 < 0.4`)
or `light`. Both `font_color` and `shading` emit a `data-*-band`
attribute on the rendered span. Downstream CSS rules read those
attributes to mandate contrast:

- `[data-shading-band]` rules force black/white text inside any
  shading span based on the background's luminance. Mirrors what
  `.pmd-highlight[data-highlight=yellow]` and siblings do for the
  16 named highlight colors, but generalizes to the arbitrary
  hexes shading carries.
- `[data-color-band="dark"]` in dark mode + apply-to-document
  overrides the run's inline `color:` to inherit `--pmd-c-text`,
  so any text the user (or Word) marked with a color too dark to
  read on `#1a1a1a` becomes readable. Three higher-specificity
  rules reverse this override inside `.pmd-highlight`,
  `[data-shading-band]`, and `<a>` containers — those scopes own
  text color and would otherwise have their mandated contrast
  clobbered by the override.

Hyperlinks use a `--pmd-c-link` token: `#0563C1` in light mode (matches
Word's canonical hyperlink blue), `#7AB0FF` in dark mode (sky blue,
readable against `#1a1a1a`). `.ProseMirror a` applies the token via
`!important` to beat the per-run `font_color` marks Word stamps onto
each hyperlink run.

**Note on default shading grey:** Verbatim's `HighlightToBackgroundColor`
macro produces shading at RGB `D2D2D2`, which is close to but not
identical to Word's `lightGray` highlight equivalent at `C0C0C0`
("Gray 25%"). The shading dropdown uses the Word-standard `C0C0C0`
and that's also the default `lastShadingColor`. Existing `D2D2D2`
shading in imported docs renders at its exact hex — the schema
preserves the actual color attr regardless of the palette — so
round-trip stays lossless; only newly-applied shading uses the
Word-standard value.
- **Alt-F8 — Copy previous cite.** Reframed from Verbatim's
  `CopyPreviousCite`. Source: cite_paragraphs whose end is before the
  cursor in the cursor's enclosing card; falls back to the most
  recent earlier source (a card with cites, or a run of free-
  floating cite_paragraphs at doc level — whichever is most recent).
  Destination: insert as a sibling at the cursor's paragraph level,
  replacing the paragraph if it's an empty/whitespace-only body slot.
  Uniform across card / analytic_unit / doc level — no new-card
  spawning, no splitting.

### Condense / Uncondense / Toggle Case (F3 family)

Verbatim parity for the text-collapse and case-toggle hotkeys. Three
condense modes plus reverse and case toggle:

- **F3 — default condense.** Reads `paragraphIntegrity` + `usePilcrows`
  from settings and runs one of three branches:
  - `paragraphIntegrity: true` → **Branch C**: clean intra-paragraph
    whitespace in every textblock in scope (tabs / NBSPs → space;
    collapse runs of spaces; strip leading space), then remove any
    `card_body` / doc-level `paragraph` that ends up empty after the
    cleanup. Mirrors Verbatim's `^p^w` + `^p^p` collapse: empty or
    whitespace-only paragraphs between content paragraphs disappear,
    so "paragraph ↵↵↵ paragraph" becomes "paragraph ↵ paragraph".
    Structural placeholders (empty tag, cite_paragraph, undertag,
    pocket, hat, block, analytic) are kept — removing an empty tag
    would dissolve its card, and the others may be intentional slots.
    No merging, no type changes for surviving textblocks.
  - `paragraphIntegrity: false, usePilcrows: false` → **Branch A**:
    merge collapsible paragraphs (card_body / doc-level paragraph)
    using single spaces at original boundaries.
  - `paragraphIntegrity: false, usePilcrows: true` → **Branch B**:
    merge collapsible paragraphs using 6-pt ¶ (U+00B6) markers at
    original boundaries — recoverable via Uncondense.
- **Alt-F3 — condense without integrity (no pilcrows).** Forces
  Branch A regardless of settings.
- **Mod-Alt-F3 — condense without integrity (with pilcrows).** Forces
  Branch B regardless of settings.
- **Mod-Alt-Shift-F3 — Uncondense.** Finds 6-pt ¶ markers in scope
  and splits the containing textblock at each (drops the ¶ char).
- **Shift-F3 — toggle case.** 3-state cycle on the selection:
  lowercase → UPPERCASE → Title Case → lowercase. Mixed-case
  selections start at lowercase.

**Scope** (all condense modes):
  - Selection non-empty → operate on the selection's range.
  - Selection empty + cursor in a card or analytic_unit → operate on
    the whole container.
  - Selection empty + cursor at doc level → no-op.

**The `headingMode` setting** modifies selection-based merging
(Alt+F3 / Mod+Alt+F3 / F3-when-integrity-off) only — no-selection
in-card and Branch C ignore it. Three options:
  - `'strict'` — selection-based condense **no-ops** if the selection
    touches any structural element (`pocket` / `hat` / `block` /
    `tag` / `analytic` / `cite_paragraph` / `undertag`). Safest mode.
    Body-only selections behave like `'respect'`.
  - `'respect'` (default) — touched paragraphs of type `pocket` /
    `hat` / `block` / `tag` / `analytic` / `cite_paragraph` /
    `undertag` stay separate; only consecutive runs of `card_body`
    and doc-level `paragraph` merge (each run yielding one merged
    textblock of the run's source type).
  - `'demolish'` — every touched paragraph contributes its *full
    text* to a single merged textblock whose type = type of the
    first touched paragraph. Cards / analytic_units whose head was
    touched dissolve; their non-touched body slots reconstitute (a
    leftover tag at doc level starts a new card; an orphan body slot
    at doc level demotes to a paragraph).

**Pilcrow representation:** a `¶` (U+00B6) text node carrying a
**non-inclusive** `pilcrow_marker` mark (rendered via CSS class
`.pmd-pilcrow { font-size: 6pt }`). Non-inclusive specifically so the
cursor adjacent to a pilcrow doesn't inherit the 6-pt formatting —
typing near a pilcrow stays at the surrounding text size, not 6-pt.

Round-trips losslessly via Verbatim's canonical encoding: exporter
writes `<w:sz w:val="12"/>` (and `w:szCs`) for any run carrying
`pilcrow_marker`; importer recognizes a `<w:t>¶</w:t>` run sized to
6-pt and swaps the `font_size:12` mark it would normally apply for
`pilcrow_marker`. Uncondense detects pilcrows via either the new
`pilcrow_marker` mark or the legacy `font_size:12 + ¶` pairing (for
back-compat with docs saved before this fix), so plain ¶ characters
at body size are still left alone.

**Ribbon button (Paragraph Integrity ¶):** lives in a new doc-ops
panel section after the color panel. Visual pressed/unpressed state
mirrors `settings.paragraphIntegrity` via `aria-pressed` — pressed
when on, unpressed when off. Settings panel also exposes
`paragraphIntegrity`, `usePilcrows`, and `respectHeadings` as toggle
entries. The doc-ops panel is reserved space for future doc-level
operations.

**Ribbon UI:** the formatting panel (3×2 grid of structural-style
buttons) and the cite panel (2×2 grid for inline marks: Cite, Underline,
Emphasis, plus one reserved slot) are settings-driven: a
`formattingPanelMode` dropdown chooses *labels / shortcuts / both /
hidden*, and a `formattingPanelPreview` toggle controls whether the
buttons preview the styles they apply (bold / underline / color / box,
following per-style typography flags). Tooltips display the active
keyboard binding using the platform's modifier glyphs.

**Empty Verbatim ribbon slots:** the Cleanup family (AutoNumberTags,
ReformatAllCites, ConvertToDefaultStyles, …) is planned for a later
release. The same registry surface will hold them when they land. F12 (Clear),
Shrink (`Mod-8`), Create Reference, and the F11 / F2 / F3 families
are all wired through the registry already. (Verbatim's F11 was
Highlight Yellow — single-color; ours is a fuller toggle-plus-picker
with the full Word palette and a sibling background-color control.
Verbatim's F3 family — Condense / CondenseNoPilcrows /
CondenseWithPilcrows / Uncondense — is shipped via our F3 / Alt+F3 /
Mod+Alt+F3 / Mod+Alt+Shift+F3 rebinding.)

### Image insertion

Images live in the schema as an `image` inline atom — base64 PNG/JPEG
bytes, EMU width/height (round-tripped through OOXML's
`<wp:inline>` / `<wp:extent>`), and an `alt` attribute (round-tripped
through `<wp:docPr descr>`, per §17). Insertion paths:

- **Ribbon insert-image button** (next to the table dropdown in the
  formatting panel) opens a file picker, reads the blob via
  `src/editor/image-insert.ts:buildImageNodeFromBlob`, decodes
  intrinsic pixel dimensions on a hidden `<img>`, and inserts an
  `image` node at the cursor with EMU = px × 9525.
- **Paste-image-from-clipboard** (Mod-V) is handled by the existing
  paste plugin: when the clipboard carries an image blob (no html /
  plain text wins over it), the plugin routes through the same
  `buildImageNodeFromBlob` path.
- **Right-click context menu** on an image (`image-context-menu-
  plugin.ts`) holds the AI image actions described below.

### AI features

All AI is gated by the `aiFeaturesEnabled` setting plus a user-
provided `anthropicApiKey` stored in localStorage and POSTed direct
from the browser to Anthropic (no server middleman). Master toggle
hides every AI UI when off, even if a key is set. Cite-creator and
image features share `src/editor/ai/activity-cycler.ts` and
`src/editor/ai/thinking-tooltip.ts` for the purple "thinking" pill
(a span whose width tracks the current activity line via
`ResizeObserver` so the chip auto-fits the active label).

Shipped commands:

- **`aiCreateCite` (Mod-Shift-X) — format selection as a cite.**
  POSTs the selection text to Claude with the user's omission-
  bracket style preferences; the reply is a citation paragraph with
  `cite_mark` on the extracted author/title tokens. Inserts at the
  cite slot above the cursor's card.
- **`aiAskAboutSelection` (Mod-Shift-Q) — start an AI comment
  thread.** Builds context from the selection plus the enclosing
  tag / analytic / cite-paragraph and POSTs it to Claude with the
  user's question; reply lands as a `kind: 'ai'` comment in a fresh
  thread anchored to the selection. `@AI` mentions inside an
  existing thread re-invoke the model with thread history + range
  as context.
- **`aiGenerateAltText` (right-click an image → Generate alt text
  from image).** Sends the image bytes plus a vision content block;
  reply is wrapped in the user's omission-bracket style as
  `[ALT TEXT: …]` and inserted as a paragraph immediately after the
  image (the transaction preserves the user's existing
  selection/scroll position — earlier versions accidentally jumped
  the viewport to the end of the doc).
- **`aiGenerateTable` (right-click an image → Generate table from
  image).** Sends the image bytes with a structured-output prompt
  asking Claude to extract the table as a JSON description; the
  result is converted to a real schema `table` node (with `bold` /
  `italic` marks and `gridSpan` / `vMerge` attrs for merged cells)
  and inserted below the image.

## 16. Tournament reliability

The desktop edition is the production surface for tournament use.
Hard requirements:

- **Fully offline.** No network calls in any code path that fires
  during a round. AI features must gracefully degrade (gray out) when
  offline.
- **Aggressive autosave.** Every transaction is committed to disk
  (probably via a journal-style mechanism so the editor can recover
  even from a hard kill).
- **Crash recovery.** On launch, the editor should detect any
  uncommitted journal state and offer recovery.
- **No surprise updates.** Auto-update during a round is a footgun;
  desktop builds need a clear "delay updates" affordance for tournament
  weekends.
- **Spell-check off by default.** Per the project owner, continuous
  background spell-check is a perf concern for large debate docs (some
  source files exceed 200,000 words). Available as an opt-in feature,
  not a default behavior.

The web edition is explicitly not for tournament use; its target is
collaboration and accessibility for users without full desktop machines.

## 17. Accessibility and customization

Accessibility is a baseline requirement, not a deferred polish task. Two
specific things need to be true from the ground up:

1. **The visual layer is fully customizable.** Every color, font choice,
   and typography decoration the user sees should be reachable through
   the display-config layer (§5). Hard-coded colors in CSS are a bug —
   they prevent a future colorblind palette, dark mode, or per-user
   override from working.
2. **Alt text is a schema-level concern.** Image nodes carry an `alt`
   attribute that round-trips through OOXML's `<wp:docPr descr="…">`.
   Any future image-edit UI must expose alt text editing as a
   first-class control, not an advanced/hidden one.

### What's wired now

- **Color variables.** The major UI and editor colors are CSS custom
  properties defined in one place (`:root` for chrome, `#editor` for
  document-style colors). Changing a palette is a swap of variable
  values, not a sweep through 1000+ lines of CSS.
- **Per-style color overrides.** `displayColors.{analytic,undertag}` in
  settings let users pick those two per-style colors directly. The same
  mechanism extends to other styles when needed.
- **Per-style typography flags** continue the §5 pattern: each flag
  toggles a class on `#editor`; CSS rules predicated on the class apply
  the decoration. Adding a new flag is one line in DisplayTypography +
  one CSS rule.
- **Image alt attribute** is in the schema (`image.attrs.alt`) and
  preserved on round-trip; OOXML import reads `<wp:docPr descr>`
  (with `<pic:cNvPr descr>` as a fallback for older producers), and
  export writes both. Manual edit lands via the image right-click
  menu's **Edit alt text…** item — a multi-line dialog whose `Save`
  button writes to `image.attrs.alt` directly. The AI alt-text
  generator updates the same attribute when it runs, and short-
  circuits with a Keep / Regenerate dialog when an image already
  has alt text so users don't burn tokens re-describing images
  someone has already annotated.
- **Icon set.** All chrome glyphs are line icons (Untitled UI free
  icons) rather than emoji/text symbols, so they inherit the theme
  color and render identically across platforms. Each is a
  `<span class="pmd-icon pmd-icon-NAME">` painted in `currentColor`
  through a CSS `mask` set to a data-URL SVG. The masks live in
  `src/editor/icons.css`, generated from the gitignored Untitled UI
  clone by `scripts/gen-icons.mjs` (re-run after editing its `MAP`); the
  app ships self-contained with no runtime SVG assets. `icons.ts`
  provides `icon()` / `setIcon()` for JS-built buttons. The whole set
  re-skins by flipping `data-icons` on the document root: `"modern"`
  (default) uses the SVG masks, `"classic"` drops the mask and restores
  the original emoji/text glyph via `::before`. The `iconSet` setting
  drives the attribute (`applyIconSet`), exactly mirroring how `theme`
  drives `data-theme` — same one-attribute-reskins-everything pattern as
  the color variables above.

### What's deferred (but the wiring should anticipate)

- **Dark mode.** Reuses the color-variable infrastructure. Implemented
  as an alternate set of `:root` variable values gated on a
  `data-theme="dark"` (or `prefers-color-scheme`).
- **High-contrast / colorblind palettes.** Same mechanism — alternate
  variable values selected via a setting.
- **Dyslexia-friendly font preset.** `bodyFont` already accepts any
  family; a preset library (OpenDyslexic, Lexie Readable, etc.) plugs
  into the existing setting. Fonts will need to be bundled (offline
  desktop) or loaded from a CDN (web).
- **Document accessibility checker.** A panel that flags images
  with empty `alt`, low-contrast highlight/shading slots, color-only
  ins/del markup once track-changes ships, and headings out of order.
  Hooks all exist in the schema today; this is a UI-only addition.
- **Reduced-motion respect.** Drag pickup animation (vacuum) and any
  other transitions should be gated on
  `@media (prefers-reduced-motion: reduce)` once we ship more motion.
- **Screen-reader semantics.** Heading nodes (pocket/hat/block/tag)
  already render as `<h1>`–`<h4>`, which screen readers handle. As
  more interactive UI lands (drag handles, menus, etc.), each needs
  appropriate ARIA labels.

### The principle

If a contributor finds themselves writing a hex literal in a CSS file
or a hard-coded color anywhere in the codebase, that's a smell. There
should be a CSS variable for it (or a setting that drives one). The
cost of doing this on the way in is roughly zero; the cost of
retrofitting it later is high and tends not to happen.

## 18. Out of scope for v1

- Multi-user real-time collaboration (transclusion option 1, live
  shared cards). Defers to a phase that has backend infrastructure.
- Corpus-scale search. Workspace-scale search ships first.
- Cross-app capture for the web edition. Always a desktop-only
  capability.
- Embedding user display config in exports. Direct formatting handles
  the actual use case; team-wide custom rendering can wait.
- Pilcrow round-trip fidelity. Schema slot exists; the export logic
  can be stubbed until a real document with pilcrows shows up.
- Tabroom Pairings, Stylepox legacy remediation. Stay external.
- **Versioning / history** (file history, named versions, branching).
  Project owner deferred until later; standard undo + autosave is
  enough for v1.
- **Schema migration / version compatibility.** Defer until going
  public; while the user is the only user, breaking changes are
  recoverable by hand.
- **Comments / annotations.** Some teams use them; project owner notes
  it'd be nice but isn't a priority. Word's comment XML is not hard to
  preserve through round-trip even without rendering, so v1 should at
  minimum *preserve* comments on round-trip without rendering them.
- **Localization** beyond English. No non-English debate communities
  in scope right now.

## 19. Learn (spaced-repetition)

Flashcards (and, in a later step, Ask-AI threads) are a **per-user
annotation layer that never enters the document.** This is the load-
bearing decision: a debater works in `.docx` and shares files freely,
so anything written into the document body or its comment XML would
leak the user's private study material. The layer lives only on the
user's machine. See `reference-docs/mnemonic-medium/SPEC-learn-system.md`
for the full spec.

**Storage.** `LearnStore` (`learn-store.ts`) is a host-agnostic,
unit-testable model with persistence injected. The renderer wires it
(`learn-store-host.ts`) to a single whole-blob host KV
(`read/writeLearnStore` → `{userData}/learn-store.json` on desktop,
`localStorage` on web), debounced like the other stores. Review reads
entirely from here — no file I/O.

**Document identity.** Because the cards live outside the file, the file
needs a stable id to re-associate with. Each document carries a hidden
`cmirDocId`: a top-level field in `.cmir`, and for `.docx` a custom
document property in `docProps/custom.xml` (FMTID
`{D5CDD505-2E9C-101B-9397-08002B2CF9AE}`, `cmirDocId`) — verified to
survive a real Word open/edit/save. `index.ts` mints it lazily on first
annotation (`ensureDocId`, rekeying the in-memory session uid via
`rekeyDoc`), backfills it on open/save, and forks a copy's annotations
on Save As (`copyDocAnnotations`).

**Split identity.** Identity is deliberately split so a file-copy shares
one logical card and one schedule while each file keeps its own
grounding:

- per `cardId`: `CardDef` (content) + `ScheduleEntry` (schedule)
- per (`cardId`, `docId`): `CardAnchor` (how the card is grounded in a
  file)
- per (`threadId`, `docId`): `AiThread`

So the same card reviewed once counts once across every file it appears
in, but breaking the text reference in one file (or deleting that file)
never touches the card's schedule.

**Anchoring.** `learn-anchor.ts` builds a Hypothesis-style descriptor
(exact quote + a window of prefix/suffix context + approximate
position) and re-resolves it against an edited document, disambiguating
duplicate quotes by context then nearest position. An anchor that can't
resolve becomes "unanchored" — which (per the spec) must not affect the
card's schedule or file association.

**Scheduling.** `learn-scheduler.ts` is a pure binary ladder (no ease
factor; FSRS-ready fields reserved). Grading is Orbit-style: a
remembered card advances along the interval ladder; a forgotten card
relearns *and* is retried later in the same session (`gradeCard`
returns `retryInSession`). Days are local-day buckets.

**UI.** `learn-create-ui.ts` (`openCardEditor` — anchor a Q&A or cloze
card to the selection on create, or edit an existing card's content),
`learn-session-ui.ts` (the review overlay, driven by
`learnStore.queue(scope, today)`), `learn-manage-ui.ts` (browse cards
grouped by file with edit / suspend / delete, a New-card action for an
unanchored card, and a link-to-file action that attaches an unanchored
card to a document — stamping a docId into an id-less file via
`readDocIdFromBytes` / `stampDocId` in `src/docid.ts`, lossless for both
formats — via the `manageFlashcards` command or the Home button), and
the Home screen's Learn section
(`home-screen.ts`, rebuilt from the store: review-all + manage +
per-file / per-deck due breakdown).

**Multi-pane.** The docId lives on the `DocRecord` (`multi-pane-shell.ts`),
not just the single-doc globals. `index.ts` resolves the *active* doc's
identity mode-agnostically: `activeDocIdentity()` reads the focused
record's `{docId, uid}` (or the single-doc globals), `ensureActiveDocId()`
mints/rekeys it, and `setActiveDocId()` writes it back (through the
`setFocusedDocId` shell hook). The record reads its docId from the file
on open, persists it on every save / autosave / journal write, and
restores it on crash recovery — so Create Flashcard and review behave
identically in either layout.

**Deferred.** Rendering anchored cards in the comments column + an
unanchored / re-ground list; migrating Ask-AI threads from round-tripped
comments into this same local layer.
