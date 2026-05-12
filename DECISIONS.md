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

## 2026-05-10: Backspace at start of the first body slot

Cursor at offset 0 of a card / analytic_unit's first body slot
(typically a cite_paragraph right after the tag, but the rule covers
any body type there — card_body, undertag, in-card analytic):

- Head is blank → drop the head, merge the container's surviving
  children into the previous doc-level entity (same as the empty-head
  merge initiated from the head side).
- Head is non-empty → no-op, swallow the event.

The non-empty case explicitly refuses ProseMirror's default
`joinBackward`, which would merge the body's content into the tag
and silently mix cite-styled / body text into the heading. The
classifier already handles cite-paragraph identity (any paragraph
with `cite_mark` is a `cite_paragraph`), so the only thing missing
was preventing this destructive default at the boundary.

Bodies that aren't the first slot (cursor at start of body2 in
`[tag, body1, body2]`) fall through to default `joinBackward`, which
correctly merges them with their previous sibling in the same
container — that's the same-container case that doesn't cross any
tag/heading boundary.

Note on the "cite paragraph — enter inside / enter at end" subset of
the same backlog question: those follow from the classifier rule
without new keymap work. Enter splits a paragraph; both halves keep
their inline content, and the classifier re-types each based on
cite_mark presence on the next dispatch cycle. A split where the
post-cursor half has no cite_mark demotes that half to card_body;
where it does, both halves are cite_paragraph. No special-casing
needed.

## 2026-05-10: F9 / Mod-U — Underline as a body/structural-aware mark pair

Verbatim's "Underline" is a *named* character style (rStyle=
"StyleUnderline") plus direct `<w:u/>`. Real Verbatim docs use it on
evidence text inside card bodies. Applying it to a tag or a heading
mis-classifies that text as "underlined evidence" — wrong both
semantically and for round-trip cleanup paths.

The schema now carries two marks:

- `underline_mark` — the named style. Exports as
  `rStyle="StyleUnderline"` + `<w:u/>`. Used in body textblocks
  (paragraph, card_body, cite_paragraph).
- `underline_direct` — plain direct formatting. Exports as `<w:u/>`
  only (no rStyle). Used in structural textblocks (tag, analytic,
  pocket, hat, block, undertag).

Both render visually identical. The split is enforced two ways:

1. `applyUnderline` (F9 + Mod-U registered as an alias) picks the
   appropriate mark by the cursor's parent textblock type, and
   strips the other variant from the affected range so mixed
   selections still come out canonical. Adding `underline_mark` in
   a body also strips conflicting `cite_mark` / `emphasis_mark`
   in the range — body text holds at most one of the three named-
   style "evidence" marks.
2. `named-style-normalizer-plugin` runs on every dispatched
   transaction (and as a pure helper at import time) to enforce the
   invariant against any other code path that might violate it
   (paste, future commands, etc.).

The importer parses direct `<w:u/>` without rStyle as
`underline_direct` initially, then runs `normalizeUnderlineMarks`
to lift body-context direct underlines to the named-style mark.
rStyle="StyleUnderline" produces `underline_mark` directly. Real
Verbatim docs (which use the dual representation) always import as
`underline_mark`; the only ones that round-trip as `underline_direct`
are docs with structural-block direct underlines (rare but legitimate)
or non-Verbatim docs where a user pressed Ctrl+U without the
Underline style (the importer canonicalizes those into
`underline_mark` so they conform to the Verbatim convention on
re-export).

Mod-U is registered as a binding alias of F9 — same command, two
keys. To keep things uncluttered, only the primary binding (F9)
shows up in tooltips / ribbon chrome; aliases will surface in the
future "Keyboard shortcuts" settings UI. `DEFAULT_RIBBON_KEYS` now
admits `string | string[]` per command, and `buildRibbonKeymap`
binds every key in the array to the command.

## 2026-05-10: Mutual exclusion of cite / underline / emphasis via schema `excludes`

(Supersedes the earlier rejection of schema-level excludes.)

The three named-style "evidence" marks — `cite_mark`,
`underline_mark`, `emphasis_mark` — are now symmetrically mutually
exclusive at the schema level: each mark's `excludes` lists all
three (including itself, which is a harmless no-op since
`Mark.addToSet` short-circuits on `this.eq(other)`).

The earlier rejection rationale was wrong. `createChecked` and
`schema.text` do *not* validate `excludes`; that property only
affects `Mark.addToSet`, `tr.addMark`, and `toggleMark`. So
importing legacy data with overlapping marks works regardless —
schema construction just stores whatever marks are passed in.

Effects of the change:

- **Active commands** (`tr.addMark` for the chosen mark) auto-strip
  the other two in the affected range. F8 / F9 / F10 don't need
  their own `removeMark` calls for the other named-style marks.
- **Passive coexistence** (somehow both marks end up on the same
  character without going through a policy command — e.g., legacy
  Verbatim docs that paired rStyle="Cite" with direct `<w:u/>`)
  isn't resolved by the schema alone. The named-style-normalizer
  plugin gained a precedence rule: in a body textblock, if a
  character carries `cite_mark` or `emphasis_mark` plus any
  underline mark, drop the underline mark — cite / emphasis wins,
  the visual underline (if any) is governed by the cite-style /
  emphasis-style display settings rather than a separate mark.
- **F9 → underline on cite-marked text** still works: `tr.addMark`
  with `underline_mark` strips cite because `underline_mark` lists
  `cite_mark` in its excludes too. The active-command-wins
  semantics of `Mark.addToSet`.

The undertag analog of the same question is also resolved without
new code:

- Enter at end of an undertag → ProseMirror's `splitBlock` creates a
  new node of the parent's `defaultBlockAt` type. The `card` content
  expression `tag (card_body | undertag | cite_paragraph | analytic)*`
  picks `card_body` first, so the new sibling is a `card_body` —
  the "escape into body" option. The classifier doesn't interfere
  (new body is empty, no cite_mark).
- Backspace at start of an undertag in the first body slot →
  `backspaceAtFirstBodyStart` (above) applies the same tag-boundary
  protection as it does for cite_paragraph / card_body.
- Backspace at start of an undertag in any other position → default
  `joinBackward` folds the undertag's content into the previous body
  in the same container, losing the undertag wrapper. That's the
  natural "I'm done with this annotation, merge it into the body
  above" gesture; we leave the default in place.

## 2026-05-10: F10 — Apply Emphasis as F8's twin

`applyEmphasis` (F10) is structured as a twin of `applyCite` (F8):
both call a shared `applyBodyMark()` helper differing only in the
mark name, both apply-not-toggle, both skip the same set of
structural blocks (`tag`, `analytic`, `pocket`, `hat`, `block`,
`undertag`), both are no-ops on collapsed selections. The two F-keys
land on different named-style marks, but the policy and the code
path are identical.

Apply-only (not toggle) is the deliberate choice — same as F8 — so a
selection that touches a mix of emphasized and plain text ends up
uniformly emphasized rather than flipping based on the first
character's state. Removing emphasis isn't a separate hotkey; the
user gets there via F9 (which strips emphasis via schema excludes)
or by re-applying the same style and then changing it to something
else. F12 Clear Formatting (not yet shipped) is the eventual
"remove all named styles" gesture.

Adding emphasis to cite-marked or underline-marked text strips the
prior mark because `emphasis_mark.excludes` lists all three
named-style marks. So in body context the "one of cite / underline /
emphasis" invariant holds without F10 needing any explicit
`removeMark` calls — same mechanism that already governs F8 / F9.

Ribbon button: Emphasis sits in the cite panel next to Underline.
The panel is now a 2×2 grid with one slot reserved for the next
inline-mark command (likely F11 Highlight). Preview styling on the
button mirrors the editor's emphasis rendering: always underlined,
with `bold` / `italic` / `box` decorations gated on the same
`displayTypography.emphasisBold/Italic/Box` flags the editor uses,
mirrored onto `documentElement` so the rule reaches the ribbon
chrome (which lives outside `#editor`).

## 2026-05-10: F9 / F10 empty-selection "run" = whitespace-bounded word

(Correcting the initial F9 implementation, which read "run" as
ProseMirror text node.)

With no selection, F9 and F10 expand to the **word at the cursor** —
the maximal run of non-whitespace characters within the cursor's
textblock. ProseMirror mark boundaries do not break a word: "plain"
+ "bold" (two text nodes, different marks, no whitespace between)
acts as one word "plainbold". Inline leaves (images, etc.) count
as word boundaries.

No-op cases:
- Cursor in whitespace with whitespace on both sides (mid-gap on a
  double-space sequence).
- Cursor in an empty textblock.
- For F10 specifically: cursor in a structural block (tag /
  analytic / pocket / hat / block / undertag) — same skip rule that
  governs F10 on a non-empty selection. F9 has no skip rule (it
  works in structural blocks too, just with `underline_direct`).

F8 cite intentionally does *not* get this treatment — cites are
multi-word phrases the user deliberately selects, so empty-selection
stays a no-op. F9 toggle and F10 emphasis are commonly applied to a
single word and cursor-on-word is the natural gesture.

Implementation: a shared `wordRangeAtCursor(state)` helper builds a
per-position whitespace map for the cursor's textblock and scans
outward from `parentOffset` until it hits a boundary. `applyBodyMark`
gained an `expandToWordWhenEmpty` flag (true for F10, false for F8);
F9's empty-selection branch calls the helper directly because its
toggle logic isn't a body-only operation.

## 2026-05-10: F11 Highlight + Mod-F11 Shading — independent toggles, shared palette

Highlight (F11) and shading / background-color (Mod-F11) are two
related but independent inline marks. `highlight` round-trips as
`<w:highlight w:val="…"/>` (a Word-named color), `shading` round-
trips as `<w:shd w:fill="…"/>` (an RGB hex). They differ in
durability — Word's "Remove Highlighting" strips `highlight` but
leaves `shading`, which is what makes shading useful as "protected
highlight" (the role Verbatim's `HighlightToBackgroundColor` plays
with its D2D2D2 grey).

### Toggle semantics

Both are **color-agnostic** toggles: if every character in the
selection carries the mark in question (any color), the toggle
strips it. Otherwise the active color (from
`settings.lastHighlightColor` / `settings.lastShadingColor`) is
applied across the whole range, replacing any existing color in
already-marked characters. The dropdown swatch picker is the way
to *change* color on a uniform selection — picking a swatch
persists it AND repaints in one click. F11 alone never repaints in
place; it's strictly on/off.

Empty selection: **no-op**. Unlike F9 / F10, F11 / Mod-F11 do not
expand to a word at the cursor — highlights and shading are most
commonly applied to phrases longer than a word, and selecting first
is the natural gesture. No structural-block skip either — tags,
analytics, headings, undertags can all carry highlight / shading
because these marks are runtime annotations, not semantic styles.

### Visual stacking — highlight wins over shading

Both marks produce a background color. When both are present on the
same character, the user wants to see the highlight color (the
"loud" annotation), not the shading. This is enforced by **schema
mark order**: in `marks.ts`, `shading` is defined before `highlight`.
ProseMirror sorts marks by `MarkType.rank` (definition order), and
the later mark becomes the inner DOM wrapper — so highlight nests
inside shading and its `background-color` paints on top.

`Mark.setFrom` normalizes mark sets to rank order regardless of
insertion order, so this property holds even for marks added in
arbitrary sequence (importer, paste, command, etc.).

### Color palette

A single source of truth: `src/editor/color-palette.ts` defines
`WORD_HIGHLIGHT_COLORS` — Word's 15 named highlight colors with
their canonical RGBs (e.g. `yellow` → `FFFF00`). All three pickers
draw from this single list; the top-left swatch is consistently the
strip/automatic option (No highlight / No background / Automatic),
followed by the 15 colors.

Verbatim's `HighlightToBackgroundColor` produces shading at RGB
`D2D2D2`, which is *close to* but not identical to Word's `lightGray`
("Gray 25%") at `C0C0C0`. We considered keeping a separate Protected
swatch but cut it — the visual difference is ~7% lightness, and
existing `D2D2D2` shading in imported docs renders at its exact hex
because the schema preserves the actual `color` attr. Round-trip
stays lossless; only newly-applied shading uses Word's standard
`C0C0C0`.

CSS previously rendered only 6 highlight colors as muted shades.
Now all 15 use Word's saturated RGBs so what the editor renders
matches what Word renders — round-trip fidelity over visual softness.
Text color flips to white on the dark backgrounds (darkBlue,
darkRed, etc.) for readability; that's a render-time decision and
doesn't write a `font_color` mark.

### Color persistence

Each control's last-picked color persists via the settings store
(`lastHighlightColor` / `lastShadingColor` / `lastFontColor`),
sanitized on load and synced to localStorage on change. Defaults:
`yellow` / `C0C0C0` / `null` (Automatic). The picker swatch and
the bar indicator under each main button both reflect the active
value through a settings subscription.

### Paintbrush mode (Word-style sticky highlighter)

Clicking a main color button with **no selection** activates a
sticky paintbrush mode for that mark. Three Word-mirroring traits:

1. **Cursor + button signal.** Editor cursor switches to `cell` (via
   a `.pmd-paintbrush-{mode}` class on `view.dom` — the `.ProseMirror`
   element). Active button reads as grayed-out / pressed with an
   inset shadow. Together these tell the user "the brush is armed".
2. **Selection collapses after each apply** ("lift the brush"). The
   `mouseup` handler captures the paint transaction via a dispatch
   interceptor, appends a `setSelection` collapsing to the end of the
   painted range, and dispatches once. So the user sees what they
   just painted without the selection-blue overlay covering it, and
   undo treats apply + collapse as one operation.
3. **Toggle on uniform repaint** (highlight + shading only). The
   paintbrush calls `applyHighlight` / `applyShading` (the toggle
   commands), not `set*Color` — so dragging over an already-marked
   range strips the mark. Color-agnostic: any uniform mark, regardless
   of color, gets stripped. Font color paintbrush stays `setFontColor`
   because font color isn't binary on/off; the "Automatic" swatch
   persists as `null` so paintbrush-font-color with Automatic active
   becomes the strip-paint gesture for font color.

Mode persists across applications until **Escape** or **clicking the
same button again**. Clicking a different color button **switches**
the paintbrush type (state is a single slot — only one paintbrush
can be active).

Implementation in `color-panel.ts`:
- Module-local `activePaintbrush: 'highlight' | 'shading' | 'fontcolor' | null`.
- Document-level `mouseup` listener that's gated on
  `view.dom.contains(target)` so clicks on other ribbon buttons
  don't trigger paintbrush apply.
- Document-level `keydown` for Escape.
- `syncPaintbrushUI()` adds / removes `.pmd-paintbrush-{mode}` on
  the editor element and `.pmd-paintbrush-active` on the relevant
  button (adjacent-sibling selector tints the arrow too).
- `applyAndCollapseSelection(view, cmd)` captures the cmd's
  transaction, appends the selection collapse, and dispatches.

Paintbrush is **button-only** — F11 / Mod-F11 hotkeys remain pure
toggles that no-op on empty selection. Rationale: the keyboard
gesture is for "I've made a selection, now toggle this on/off". The
mouse gesture is for "I'm about to drag-select something to color".
Two distinct mental models, two distinct entry points.

### Command wiring

`applyHighlight` and `applyShading` take a `() => string` for the
active color (rather than capturing a snapshot), so the keymap
binding reads the latest value at keypress time. `buildRibbonKeymap`
and `getRibbonCommand` accept an optional `RibbonContext` —
`{ highlightColor, shadingColor }` — defaulting to `'yellow'` /
`'D2D2D2'` so existing tests don't need to wire settings (the
default-context value is intentionally Verbatim's historical
grey so tests reading default behavior stay stable).

### Why not a font color hotkey?

Word doesn't bind one and debate use is heavily black-by-default,
so font color is dropdown-only for now. Easy to add later if the
user wants e.g. Ctrl-Shift-C bound to "apply current font color".

## 2026-05-11: Condense family (F3) — Verbatim parity with rebound keys

Implemented Verbatim's text-collapse family with a simpler 4-key
mapping. The behavior follows Verbatim's `CondenseCard` / `Uncondense`
exactly (see `reference-docs/verbatim/desktop/src/Condense.bas`),
with three branches gated on two settings:

| `paragraphIntegrity` | `usePilcrows` | Branch | What F3 does |
|---|---|---|---|
| `true` | * | **C** | Clean intra-paragraph whitespace; no merging. |
| `false` | `false` | **A** | Merge collapsible runs with spaces. |
| `false` | `true` | **B** | Merge collapsible runs with 6-pt ¶ markers (reversible via Uncondense). |

**Hotkeys** (rebound from Verbatim for ergonomics):

| Ours | Verbatim equivalent | Forces |
|---|---|---|
| `F3` | `CondenseCard` (reads settings) | Whatever settings say (A / B / C). |
| `Alt-F3` | `Ctrl-F3` (CondenseNoPilcrows) | Branch A, regardless of settings. |
| `Mod-Alt-F3` | `Ctrl-Alt-F3` (CondenseWithPilcrows) | Branch B, regardless of settings. |
| `Mod-Alt-Shift-F3` | `Ctrl-Alt-Shift-F3` (Uncondense) | Find 6-pt ¶, split textblock at each. |
| `Shift-F3` | Word's `Shift-F3` (Toggle Case) | 3-state cycle on selection. |

Verbatim's Shrink (originally Alt-F3, font-size cycle on un-underlined
runs) is not yet implemented — the slot is now free since we rebound
Alt-F3 to no-integrity condense. A future implementation can pick a
new key (Ctrl-8 is Verbatim's alternate).

### The `headingMode` setting

Three distinct user models for how selection-based collapse handles
structural elements:

- **`'strict'`** — if the selection touches any structural element
  (heading / cite_paragraph / undertag), the operation is a no-op.
  Safest mode; the user opts into a more aggressive mode if they
  actually want to cross a structural boundary. Body-only selections
  behave like `'respect'`.
- **`'respect'` (default)** — preserves structural elements (`pocket`,
  `hat`, `block`, `tag`, `analytic`, `cite_paragraph`, `undertag`);
  only consecutive runs of `card_body` and doc-level `paragraph`
  merge.
- **`'demolish'`** — selection demolishes everything in the range.
  The merged textblock's type = type of the first touched paragraph.
  Cards / analytic_units whose head was touched dissolve; orphan body
  slots reconstitute (a leftover tag at doc level starts a new card;
  an orphan body slot at doc level demotes to a paragraph). The
  cite-classifier plugin re-evaluates the result, naturally promoting
  the merged textblock to `cite_paragraph` if `cite_mark` is present.

The original spec for `'demolish'`: "if someone selects across Body A
halfway through Body B, then the selected part of Body B will become
part of Card A, since Tag B will become a card_body unit." Because
the operation removes paragraph breaks, every touched paragraph
contributes its full text — not just the portion inside the selection
— since once a paragraph's leading or trailing break is gone, its
content joins what's adjacent.

The setting was originally a boolean (`respectHeadings: true/false`)
covering only `'respect'` and `'demolish'`. The 3-option enum adds
`'strict'` as the safest default for users who want condense to never
accidentally cross a tag/cite/undertag boundary. The setting is
settings-panel-only (no ribbon UI) — rare to toggle once chosen. The
ribbon exposes only the more frequently-flipped `paragraphIntegrity`
(via the ¶ button).

### No-selection in-card case

When the cursor is in a card or analytic_unit with no selection, the
collapse always uses the "respect headings"-style behavior implicitly:
- F3 (Branch C): per-textblock whitespace cleanup.
- Alt-F3 / Mod-Alt-F3: tag (schema-required), cite_paragraphs, and
  undertags stay separate; consecutive `card_body` runs merge.

This is required for schema validity (a card MUST start with a tag),
and it matches the spirit of Verbatim's `CondenseCard` which auto-
skips leading cites via `SelectCardTextRange`'s `IdentifyCite`
heuristic. We use type-level distinction (`cite_paragraph`) instead
of heuristic detection.

### Pilcrow representation

A `¶` (U+00B6) text node carrying a **non-inclusive** `pilcrow_marker`
mark. Rendered at 6-pt via a CSS class on the mark's span; the mark
itself has no attrs. Round-trips losslessly: the exporter writes
`<w:sz w:val="12"/>` for any run with `pilcrow_marker`, and the
importer detects a 6-pt run whose content is exactly `¶` and swaps
the `font_size:12` mark it would normally apply for `pilcrow_marker`.

**Why non-inclusive matters:** the original implementation used
`font_size` (inclusive=true) at halfPoints=12, which caused the
cursor adjacent to a pilcrow to inherit the 6-pt size — typing near
the pilcrow then produced 6-pt text. ProseMirror's `$pos.marks()`
includes inclusive marks from the previous text node at a child
boundary, so any inclusive mark on the pilcrow leaks into adjacent
typing. A dedicated non-inclusive marker mark sidesteps this; the
6-pt rendering still comes from CSS, but PM's storedMarks logic
correctly excludes the marker at the boundary.

Detection (for Uncondense) checks for either the new `pilcrow_marker`
or the legacy `font_size:12 + ¶` pairing, so docs saved before this
fix are still recognized.

Considered and rejected: introducing a dedicated `pilcrow` atom
inline node. Cleaner conceptually but requires more schema and
importer/exporter work; the mark approach is functionally equivalent
and a smaller change.

### Ribbon UI: doc-ops panel

A new ribbon panel section after the color panel. Currently holds the
Paragraph Integrity ¶ toggle. Reserved for future doc-level
operations (Clear Formatting, Shrink, format painter, etc.). Visual
state on the integrity toggle: `aria-pressed="true"` when on
(matching CSS gives a grayed-out pressed look — same treatment as
the paintbrush-active state on color buttons), `aria-pressed="false"`
when off.

## 2026-05-11: Absorb-plugin no longer terminates on undertag / card_body

The absorption rule (ARCHITECTURE §14.3) used to treat any non-paragraph,
non-cite_paragraph sibling as a boundary. That broke the natural case
of `F7` on plain text followed by undertag annotations:

```
paragraph   ← cursor here, hit F7
undertag
paragraph
```

The new card from F7 wrapped only the first paragraph. The absorb pass
saw the trailing undertag and stopped, leaving the undertag orphaned
at doc level and the third paragraph unabsorbed. Result: visually
disconnected, structurally surprising.

The rule now treats `paragraph`, `cite_paragraph`, `undertag`, and
`card_body` as absorbable — exactly the set of body-slot types valid
inside both `card` and `analytic_unit`. None of these terminate the
absorption zone; only proper containers (headings, other cards /
analytic_units, paragraphs at doc start) do.

This also makes the `dissolveContainerToUndertag` previous-card
absorb logic (next entry) partly redundant with the plugin pass —
the explicit logic still wins on cursor placement, but if it were
removed, the plugin would now produce the same shape via lift +
recalc. Kept for now because it preserves card content without going
through the paragraph→card_body round-trip and lands the cursor
deterministically.

## 2026-05-11: Heading commands accept all doc-level inline blocks; tag→undertag re-absorbs

Extends the conversion rules from the 2026-05-10 ribbon-commands entry
in two ways:

1. **Doc-level reach.** Originally the depth-1 branches of `setHeading`,
   `setTag`, `setAnalytic`, and `setUndertag` only accepted a plain
   `paragraph` (or another heading, for IDs). Real docs frequently have
   bare `cite_paragraph` and `undertag` at doc level — from cite-paste
   without a destination card, F8 on a doc-level paragraph, or the
   round-tripped output of a Mod-F8 dissolve. Those used to silently
   no-op under F4–F7. The set `DOC_LEVEL_CONVERTIBLE` now spans
   `paragraph`, `cite_paragraph`, `undertag`, `card_body`, plus the
   three heading types (`pocket`, `hat`, `block`); any of them
   converts in place. Heading IDs are still preserved when the source
   was already a heading; otherwise a fresh ID is minted.

2. **Promote-then-demote re-absorb.** Going from undertag → tag with
   F7 splits the card and produces a new card after it (existing
   behavior). Demoting that new card's tag back via Mod-F8 used to
   lift the surviving body children to doc level — losing the card
   wrapper that the user clearly still wanted. `dissolveContainerToUndertag`
   now checks the previous doc-level sibling: if it's the same
   container type (card or analytic_unit), the new undertag plus the
   current container's non-head children are appended to it and the
   current container is removed. Both card and analytic_unit accept
   `undertag` / `card_body` / `cite_paragraph` directly, so no
   per-child rewriting is needed. When there's no eligible previous
   sibling the existing lift-to-doc-level fallback still runs.
