# Decisions log

Append-only log of implementation decisions and their rationale. Each
entry has a date, a one-line summary, and the reasoning.

## 2026-05-08: TypeScript + raw ProseMirror + Vite + Vitest

**Stack:**
- **TypeScript 5.x** — universal for ProseMirror projects; strong
  typing helps with schema correctness.
- **Raw ProseMirror** (not TipTap) — direct schema control matters here
  because we have non-trivial schema requirements (custom node types,
  stable heading IDs, scratchpad nesting, link marks). TipTap is a
  productive wrapper but adds a layer of indirection we don't need.
- **Vite** — modern, fast, works for both library and app builds.
- **Vitest** — first-class TS support, integrates with Vite, fast.

**Rejected alternatives:**
- TipTap: see above.
- Webpack: heavyweight; Vite is the default for greenfield TS projects.
- Jest: slower than Vitest for TS, more config friction.

## 2026-05-08: jszip + fast-xml-parser for OOXML

**Stack:**
- **jszip** — well-known, mature, isomorphic (browser + Node).
- **fast-xml-parser** for parsing — fast, returns plain JS objects
  rather than DOM, easy to traverse.
- **Hand-rolled emission** for writing — OOXML output is templated and
  we control all the namespaces and formatting; a heavy XML lib adds
  more friction than it removes for our specific patterns.

**Rejected alternatives:**
- `@xmldom/xmldom`: full DOM API, but heavier than we need.
- `xmlbuilder2`: nice fluent emit API, but two-libs-one-job feels
  unnecessary when we control all the patterns.
- `xml2js`: older, less performant.

## 2026-05-08: Single package, monorepo deferred

Starting with a single package containing schema + import + export +
(eventually) editor. We'll split into a monorepo (`@prosemirror-debate/schema`,
`@prosemirror-debate/docx-converter`, etc.) only if web/desktop divergence
or external publication forces it. YAGNI for v0.

## 2026-05-08: Stable heading IDs via crypto.randomUUID()

Per `ARCHITECTURE.md §4`, every heading-level node gets an `id` attr.
Generated with `crypto.randomUUID()` (Node-built-in, no extra dep).
Round-tripped to docx as bracketing `<w:bookmarkStart w:name="..."/>` /
`<w:bookmarkEnd/>` markers around the heading paragraph.

The bookmark name pattern is `pmd-heading-<uuid>` — the `pmd-` prefix
namespaces our bookmarks so we can distinguish them from existing
Verbatim bookmarks (e.g., the VirtualTub flow uses bookmarks for its own
purposes per `NOTES-verbatim.md §4`).

## 2026-05-08: Inline node IDs not initially required

Heading IDs are required for transclusion targeting. Inline runs and
non-heading paragraphs do not need stable IDs in v0 — there's no feature
yet that targets them.

## 2026-05-08: Schema marks vs nodes for Cite/Analytic/Undertag

Per `ARCHITECTURE.md §4`, Cite/Analytic/Undertag are linked
paragraph+character pairs in OOXML. We model each as **both a block
node and a mark**:
- `<w:pStyle w:val="Analytic"/>` on a paragraph → block node `analytic`
- `<w:rStyle w:val="AnalyticChar"/>` on a run → mark `analytic_mark`
- Same for Undertag and Cite.

Export reverses: block-node → pStyle on the paragraph; mark → rStyle on
the run. This matches how Word's linked styles actually work and keeps
both representations available without forcing a one-shape-fits-all
decision.

## 2026-05-08: Direct-formatting marks chosen explicitly

Direct formatting captured as marks, not node attributes:
`bold`, `italic`, `font_color`, `font_size`, `highlight`, `shading`,
`link`, plus the named-style emphasis marks (cite_mark, underline_mark,
emphasis_mark, undertag_mark, analytic_mark).

Reasoning: marks compose freely on text ranges; attributes on nodes
would make sub-paragraph formatting awkward. ProseMirror's mark system
is exactly designed for this.

## 2026-05-08: "underline_mark" emits both rStyle AND direct underline

Per `NOTES-verbatim.md §5` gotcha #1, Verbatim's own code commits the
dual representation. Our exporter emits both `<w:rStyle w:val="StyleUnderline"/>`
*and* `<w:u w:val="single"/>` for any text carrying `underline_mark`.
Importer recognizes either form (style ref OR direct prop) as the mark.

## 2026-05-08: Node.js v24.15.0 LTS, installed user-local

Installed Node.js LTS to `~/.local/opt/node-v24.15.0-linux-x64/`,
symlinked binaries into `~/.local/bin/`. No system-wide install (no
sudo available). This affects only the project owner's user account.

## 2026-05-08: Schema design — heading-level nodes are flat paragraphs

Initial schema design had pocket/hat/block as tree containers with
their `inline` content nested inside. But docx represents these as
*paragraphs with Heading1-3 styles in document order*, with hierarchy
implicit via outline level — there is no docx-level "Pocket contains
Hat" containment. Round-tripping the tree-container model would
require synthesizing/dropping container boundaries on import/export,
which is awkward.

Resolution: pocket / hat / block / analytic / undertag are flat
paragraph nodes with `inline*` content. Card *is* a tree container
because the user values cards as objects (move-card, send-to-speech).
The "Pocket contains the following Hats and Blocks" tree-shaped view
is built dynamically by the navigation panel, not stored in the
schema.

Trade-off: the schema doesn't enforce well-formed outline hierarchy
(can't say "a Block inside a Pocket can't have a Hat between them").
That validation, if needed, lives at a higher layer.

## 2026-05-08: Cite paragraph classification on import is heuristic

When the importer sees `Tag → Normal → Normal → ...`, it classifies
the FIRST Normal as `cite_paragraph` and subsequent Normals as
`card_body`. Real docs always or nearly-always have this shape, so
the heuristic is fine for v0. A smarter classifier (text-shape based)
can replace it later if we encounter mis-classifications.

## 2026-05-08: Reverted paragraph-default rPr inheritance entirely

User flagged that an analytic paragraph with `<w:pPr><w:rPr><w:u/></w:rPr></w:pPr>`
was rendering ALL of its text underlined when only some runs should be.
Inspecting the OOXML spec (17.7.5.10):

> The rPr element ... when it is the child of a pPr element, the run
> properties are applied to the glyph used to represent the physical
> location of the paragraph mark.

So `<w:pPr>/<w:rPr>` defines the formatting of the paragraph-mark glyph
(the ¶), not the runs in the paragraph. Runs are formatted by their
own `<w:rPr>` and the `<w:pStyle>`'s linked character style. They do
NOT inherit from `<w:pPr>/<w:rPr>`.

Earlier in this session I had introduced inheritance of `<w:pPr>/<w:rPr>`
onto runs, motivated by a (mis-)reading of the survey notes about
"mass highlighting affecting pPr/rPr." That's now reverted. The
importer reads each run's own rPr only and ignores pPr/rPr's run
properties.

Round-trip impact: mark counts on Aff went from ~17,791 underline_marks
(inflated by bogus inheritance) down to 16,311, matching the survey's
ground-truth count of 16,211 StyleUnderline rStyle uses + ~100 runs
that have direct `<w:u>` (no rStyle). Round-trip remains lossless.

## 2026-05-08: Named-style marks override paragraph-default font_size on import (now obsolete)

(This decision rests on paragraph-default rPr inheritance, which was
reverted above. Both this and the inheritance behavior are gone.)

User feedback while reviewing the v0 playground: in shrunk imported
docs (where the shrink macro sets paragraph-default `<w:sz w:val="16"/>`
to render the body at 8pt), underlined/emphasized text was rendering
at 8pt instead of staying at the canonical 11pt. The user expected
contrast — small body, full-size underline.

Root cause: my `mergeMarks` was inheriting paragraph-default font_size
onto every run, including runs that have a named-style mark
(underline_mark / emphasis_mark / cite_mark / etc.). Per OOXML's
character-style cascade, the named character style's implicit font
size declaration (e.g., StyleUnderline → sz=22 / 11pt) overrides the
paragraph default. Word renders accordingly.

Fix: in `mergeMarks`, skip inheriting `font_size` from defaults when
the run has any named-style mark. The run renders via its CSS class's
inherited size (typically 11pt from #editor). An explicit run-level
`<w:sz>` still applies (becomes a font_size mark on the run, wins via
inline style on the inner span).

Round-trip remains lossless — the fix changes what marks get attached
on import, but per-run explicit sizes are still preserved both ways.

## 2026-05-08: Undertags absorbed into cards (don't end card boundary)

User feedback while reviewing the v0 playground: an undertag paragraph
following a tag was breaking the card's hover-bar continuity, because
the undertag wasn't included in the card's content expression and ended
up as a sibling of the card.

Schema fix: card content expression is now
`tag undertag* (cite_paragraph | analytic)? card_body*`. Undertags
attached to a tag belong inside the same card.

Importer also updated: after consuming the tag, the card-grouping pass
absorbs any number of undertags before looking for cite/analytic/body.
Standalone undertags (between cards) are still legal at doc-level
positions, just not orphaned within a card sequence.

## 2026-05-08: Paragraph-default rPr inheritance with named-style guard

Real docx files (per `NOTES-verbatim.md §6`) put mass-applied
formatting on a paragraph's default run properties (`<w:pPr><w:rPr>`),
not per-run. Runs inherit these unless they specify a conflicting
property.

Subtle bug discovered during round-trip testing: named-style marks
(cite_mark, underline_mark, emphasis_mark, undertag_mark, analytic_mark)
all map to the same OOXML slot — `<w:rStyle>`. A run can only carry
one rStyle. If the paragraph default has rStyle=StyleUnderline and a
run has rStyle=Style13ptBold, naive merging gives the run BOTH marks
in our schema, but on re-export only one rStyle is emitted, silently
dropping the other.

Fix: in `mergeMarks`, named-style marks are treated as a single slot.
If a run has any named-style mark, ALL named-style marks from
defaults are dropped (run wins). Other mark types (highlight, bold,
font_color, etc.) merge normally.

Round-trip on real docs confirmed: all 126 tests pass with the merge
fix in place.

## 2026-05-09: Retired the `scratchpad` node

Originally introduced as a "schema escape hatch" for messy or
unstructured regions when the schema was a strict tree
(`pocket → hat → block → card`). After the 2026-05-08 refactor making
heading-level nodes flat paragraphs, the doc's `BLOCK_CONTENT` became
permissive enough to accept loose paragraphs, headings, cards, and
analytic_units in any order at any position. A `<div class="pmd-scratchpad">`
wrapper with the same content model added no structural value — every
real use case (bridge text between cards, "Patch Notes" notes, loose
paragraphs under a Block heading) is already handled by plain
`paragraph` blocks at doc level.

Considered repurposing it for nav-pane suppression (headings inside a
scratchpad would be skipped from the outline) but the project owner
doesn't want that behavior — existing docs use heading-styled scratch
content (the "Patch Notes" pattern) and *do* want it visible in the
nav.

Changes:
- Removed `scratchpad` from `nodes.ts` and from `BLOCK_CONTENT`.
- Importer's three scratchpad fallback paths (failed analytic_unit
  construction, failed card construction, failed top-level doc) now
  emit children directly into the doc, coercing tags/analytics into
  their required wrappers via `coerceToDocChild` (renamed from
  `coerceToScratchpadChild`).
- Exporter no longer treats `scratchpad` as a transparent container.
- Editor starter doc, CSS, and tests updated.

All 137 tests pass.

## 2026-05-09: Paragraph absorption rule for loose paragraphs after a card

Settles one of the §14 editing-semantics open questions. The rule: a
top-level `paragraph` whose immediate previous sibling is a `card` or
`analytic_unit` is auto-absorbed into that container as a `card_body`.
A heading (Pocket / Hat / Block) breaks the absorption zone, so the
escape mechanism for "I want loose paragraphs after this card" is to
insert a heading first.

Why not encode this in the schema: ProseMirror content expressions are
context-free, so they can't say "paragraph is illegal after a card but
legal after a heading." Two alternatives both fail in different ways:
- Drop `paragraph` from the doc content entirely → kills the legitimate
  Block → paragraph → Tag pattern (loose bridge text between a section
  heading and its cards).
- Wrap headings in a `section` container that owns its loose paragraphs
  → much bigger refactor of the doc shape, gains little.

Implementation: `src/editor/absorb-plugin.ts`, an `appendTransaction`
plugin that runs after every doc-changing transaction. Walks doc-level
children once, rebuilds any card / analytic_unit that needs to grow,
and replaces doc content with the new fragment. Returns null (no
transaction) when the doc already complies, so steady-state edits are
free.

The rule matches what the importer already produces — `Importer`'s
card-grouping pass greedily absorbs Normal paragraphs after a tag as
`card_body` until the next heading. The plugin is the runtime
counterpart that prevents users from constructing the same broken state
mid-edit.

Starter doc updated: the demo "loose paragraph" was moved to between
the Block heading and the first card, so it sits in a position the
absorption rule preserves rather than auto-absorbing on first edit.

## 2026-05-10: Tag boundary editing rules

Settles ARCHITECTURE.md §14's open questions on Backspace / Delete /
Enter at tag boundaries. Per the project owner's collaborator-poll
answers:

- **Backspace at start of tag**: permitted only when the preceding
  paragraph is blank (whitespace-only). The blank paragraph is deleted;
  the tag is preserved. "Previous paragraph" includes the trailing
  card_body of a preceding card — those count too.
- **Enter mid-tag**: Word's default split-into-two-tags behavior is
  correct. In our schema this means a new card is inserted before the
  current card with just the pre-cursor tag content; the original card
  retains the post-cursor text plus all existing cite/body/undertags.
- **Forward Delete at end of tag**: permitted only when the next
  paragraph is also a tag (i.e., merging adjacent tag-only cards). All
  other forward-delete cases at the tag boundary are prohibited.
- **Enter at end of tag**: creates a Normal-styled paragraph (in
  schema terms, a card_body) appended at the schema-correct position;
  cursor lands in the new card_body. Note: this overrides Verbatim's
  Tag→Cite styleNext default — pressing Enter at end of tag goes to a
  body, not a cite.
- **Enter at start of tag**: a new empty card is inserted before the
  current card; the original is unchanged.

The same rules apply to `analytic` inside an `analytic_unit`. Pocket,
Hat, Block use ProseMirror's default behavior unchanged — no card
boundary to enforce, so the loose semantics are fine.

Implementation will land separately as keymap commands; this entry
records only the policy.

## 2026-05-09: Accessibility and customization groundwork upfront

Per the project owner: bake accessibility-readiness into the schema +
CSS + settings layer now, even though no end-user accessibility UI
ships in v0. The cost of retrofitting later is high; the cost of
doing it on the way in is roughly zero.

Concrete steps taken:

- Every UI color routes through a CSS variable defined at `:root`
  (chrome) or driven by settings (per-style document colors). Hex
  literals in CSS files are a smell — there should be a variable for
  it or a setting that drives one.
- Per-style display config covers what users have most asked to
  control (color of analytic and undertag, italic/bold flags for
  undertag and emphasis, box thickness for emphasis). New flags are
  one line in `DisplayTypography` + one CSS rule predicated on a
  class on `#editor`.
- Image `alt` is in the schema (`image.attrs.alt`) and round-trips
  through OOXML `<wp:docPr descr="…">`. Alt-text editing UI is
  deferred; the schema slot is already there.

What's deferred but anticipated by the wiring: dark mode, high-
contrast / colorblind palettes, dyslexia-friendly font preset,
reduced-motion respect, screen-reader semantics polish. All of these
are alternate values for the existing variable / setting surfaces or
small additions to already-typed nodes.

See `ARCHITECTURE.md §18` for the full inventory.

## 2026-05-10: Drag-and-drop infrastructure

Cross-surface drag-and-drop ships in two directions:

- **Nav → editor.** Drop indicators in the editor surface render as
  horizontal blue lines at each viable target (heading top edges +
  end-of-doc). The drag controller hit-tests on pointermove; the
  closest indicator within a band wins, with a fall-through to the
  topmost/bottommost extreme so dragging into empty space below a
  short doc snaps to the bottom.
- **Editor → nav.** Triggered by holding the pickup modifier
  (Ctrl+Alt+Shift on Linux/Win, Cmd+Option+Shift on Mac) — a non-
  obvious choice because there are no free single-modifier
  combinations Word doesn't already claim, and we need a modifier
  the user holds while clicking to pick up a card-like unit. On
  modifier press the cursor changes to grab, hovered containers
  (smallest enclosing card / analytic_unit / pocket / hat / block)
  show a dashed outline; pointerdown starts the drag.

Nav-pane multi-select is level-locked: a `[tag + analytic]` selection
is permitted because both are outline level 4, but `[tag + block]` is
not. Lock by outline level rather than exact node type so peers can
travel together even when they differ structurally.

Auto-expand / auto-collapse: hovering a collapsed entry for 400 ms
expands it; pointing away from an auto-expanded entry's subtree for
400 ms re-collapses. Symmetric timers so the feel matches.

CSS `zoom` on `#editor` complicates indicator positioning: child
elements positioned in the host's local coordinate system render at
`top * zoom` viewport pixels, so `coordsAtPos` viewport-distance has
to be divided by the zoom factor before assignment.

## 2026-05-10: Empty-tag-only container deletes; whitespace counts as empty

Refines the tag-boundary rules above. If the tag (or analytic) is
empty AND it's the only child of its container, Backspace at the
start *or* Delete at the end of the head deletes the whole container.
Whitespace-only heads are treated the same as truly empty ones — the
user thinks of "blank" as the unit they're trying to remove, not the
literal `content.size === 0` distinction.

If deleting would leave the doc with no children at all, the
container is replaced by an empty paragraph so the editor always has
a textblock for the cursor to land in.

## 2026-05-10: Verbatim ribbon — structural-style commands and registry

Implements the F4–F7 / Mod-F7 / Mod-F8 / Mod-B / Mod-I / F8 / Alt-F8
ribbon commands per Verbatim parity. All commands route through a
single registry (`src/editor/ribbon-commands.ts`):

- `StructuralRibbonCommandId` (`setPocket`, `setHat`, `setBlock`,
  `setTag`, `setAnalytic`, `setUndertag`) — the subset rendered as
  buttons in the formatting panel.
- `RibbonCommandId` — a superset adding `toggleBold`, `toggleItalic`,
  `applyCite`, `copyPreviousCite`. These are keyboard-only for now;
  the registry shape doesn't preclude buttons later.
- `DEFAULT_RIBBON_KEYS` — the canonical key for each ID. Verbatim's
  hotkeys win where they exist (`F4`–`F7`, `Alt-F8`); Word's wins for
  inline marks (`Mod-B`, `Mod-I`); we picked the rest by analogy.
- `buildRibbonKeymap(overrides)` — produces a keymap object given
  optional per-ID overrides. Settings UI for rebinding isn't built
  yet, but the surface is.

**Conversion rules** are intentionally context-aware:

- Doc-level paragraph ↔ heading: in-place setNodeMarkup.
- Tag (in card) / analytic (in analytic_unit): dissolve the wrapper,
  lift body children to doc level (card_body / cite_paragraph →
  paragraph, undertag stays, analytic → analytic_unit wrap).
- Card_body: split the card. Cursor's body stays in the original; new
  heading + lifted bodies become doc-level siblings.
- Multi-paragraph selection: apply the target style to every touched
  paragraph in a single replaceWith over the affected doc-level
  range; cards split / dissolve as needed.

`applyCite` (F8) is the exception that doesn't change paragraph
shape — it just adds `cite_mark` to inline content in the selection,
skipping structural blocks (tag, analytic, pocket, hat, block,
undertag). No-op on collapsed selections. The cite-classifier plugin
(below) then promotes the destination paragraph to `cite_paragraph`
automatically.

## 2026-05-10: Formatting panel UI

A grid of structural-style buttons in the ribbon, to the right of
Open/Save, separated by a divider. Pocket / Hat / Block / Tag /
Analytic / Undertag in a 3×2 column-major grid. The Cite button
sits in its own panel to the right of the formatting panel with the
same divider treatment, set up as a 2×N grid so it aligns with the
formatting panel's top row and so more inline-mark buttons can be
added beside it.

Two settings drive presentation:

- `formattingPanelMode`: `'labels' | 'shortcuts' | 'both' | 'hidden'`.
  Buttons show the style name, the active keyboard binding, "name ·
  shortcut" (using the same middle-dot separator as the status-bar
  read-time line), or are hidden entirely.
- `formattingPanelPreview`: when on, each button previews the visual
  treatment of the style it applies (Pocket boxed, Hat double-
  underlined, Block underlined, Tag bold, Analytic colored, Undertag
  italic+colored, Cite bold/underlined per settings).

The undertag and cite preview rules mirror the editor's per-style
typography flags (italic / bold / underlined) — toggling those flags
in settings updates both the editor's rendering and the ribbon
button's preview.

mousedown handlers `preventDefault` so a button click doesn't steal
focus from the editor — commands need to act on the live cursor's
paragraph.

## 2026-05-10: Cite handling unification

Reconciles a forest of edge cases in cite-paste / cite-paragraph
classification under a single rule. Three coordinated changes:

**1. Schema:** `analytic_unit` content is loosened to
`analytic (card_body | undertag | cite_paragraph)*`. Conventionally
an analytic doesn't carry a citation, but the looser schema makes
"any body slot can hold a cite" the universal rule and avoids the
forced new-card-spawn that was the only previous fallback when the
user wanted a cite below an analytic body.

**2. Cite-classifier plugin (`src/editor/cite-classifier-plugin.ts`):**
an `appendTransaction` that keeps each paragraph's *type* in sync
with its content's cite state. The rule is bidirectional:

- A `card_body` (in a card or analytic_unit) or doc-level `paragraph`
  with any `cite_mark`-bearing inline run → promote to `cite_paragraph`.
- A `cite_paragraph` whose content has no `cite_mark` → demote back
  to `card_body` (inside a container) or `paragraph` (at doc level).

This fixes the manual-paste case (where pasted cite content kept the
destination's `card_body` type), the Enter-split case (where the
post-split half stayed a `cite_paragraph` despite being plain), and
makes runtime classification match what the importer does on load.

**3. Importer:** the in-card cite vs body classifier is now content-
based ("any cite_mark in inlines → cite_paragraph"), not position-
based ("first Normal after the tag is the cite"). Cards / analytic_
units with multiple cite paragraphs round-trip cleanly. Free-floating
doc-level paragraphs with cite content are promoted to doc-level
`cite_paragraph` on import too — so F8'd standalone paragraphs that
were exported survive re-import.

Downstream effects:

- `copyPreviousCite` (Alt-F8) collapses to one rule: find the cite,
  insert it as a sibling at the cursor's paragraph level, replacing
  the paragraph if it's an empty/whitespace-only body slot. No more
  splitting, no more new-card wrapping. Free-floating cite_paragraphs
  at doc level count as a "source" alongside cards with cites; the
  most recent source (in doc order) wins.
- `absorb-plugin` also absorbs `cite_paragraph` siblings into a
  preceding card / analytic_unit, type preserved.
- `applyCite` (F8): applies `cite_mark` to text in the selection
  except in structural blocks (tag, analytic, pocket, hat, block,
  undertag) — the destination paragraph's type updates via the
  classifier on the same dispatch cycle.

## 2026-05-10: Empty tag with surviving body merges into previous

Extends the tag-boundary rules. If the tag (or analytic) is empty
AND its container has other children (body, cite, undertag, in-card
analytic), Backspace at the head's start *or* Delete at its end
drops the empty head and migrates the surviving children:

- Previous doc-level node is a `card` / `analytic_unit` → append the
  survivors. Analytic in a card's cite-slot folds to card_body when
  the prev is an analytic_unit.
- Anything else (paragraph, heading, …) or no previous node → lift
  the survivors to doc level.

Cursor lands at the merge boundary — end of preceding content on
Backspace, start of merged content on Delete.

Rationale: the empty tag is a meaningless boundary the user wants
gone; the card's content should flow into the natural container
above it. Eliminates the "stuck — backspace does nothing because the
preceding content isn't blank" trap.

## 2026-05-10: Forward Delete at the end of a body — refuse destructive merge

Cursor at the end of the LAST body of a card / analytic_unit, press
Delete:

- If the next doc-level sibling is a card or analytic_unit whose head
  is blank: absorb its surviving children into the current container
  (cross-type folding applies). Mirror of the empty-tag-merge rule
  initiated from the body side.
- Otherwise (next is a non-empty card/analytic_unit, a heading, a
  paragraph, or end of doc): no-op, swallow the event.

The "no-op" case explicitly refuses Word's default of pulling the
next paragraph's text into the current body — that's silently
destructive at a tag/heading boundary. We'd rather make Delete look
broken in that one case than corrupt structure.

Symmetric with backspace-into-body-of-prev: both refuse to cross a
non-blank head boundary destructively, and both *do* cross a blank-
head boundary by collapsing it.
