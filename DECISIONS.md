# Decisions log

Append-only log of implementation decisions and their rationale. Each
entry has a date, a one-line summary, and the reasoning.

## 2026-05-14: Multi-pane workspace (prototype)

First-cut implementation of SPEC-multi-pane.md. Lives on the
`multi-pane` branch. Gated by a single boolean setting
(`multiDocWorkspace`) — toggling requires a page reload to (re)build
the shell. With it OFF, today's single-doc shell loads as-is. With
it ON, the single-doc surfaces (`#editor`, `#nav-panel`,
`#comments-column`, the comments ribbon buttons) are hidden and a
new multi-pane shell takes over.

### Architecture

  - `src/editor/multi-pane-shell.ts` owns the shell. Three slots
    (`slot1` / `slot2` / `slot3`); each slot is a stack of 0+ live
    DocRecords (per-stack EditorView + NavigationPanel + per-pane
    drag surface). Hidden stack members keep their views in memory
    (Q14: live-view, no serialize). Active slots render in numeric
    order, left → right; empty slots take no space.
  - `editor/index.ts` keeps most of the chrome wiring unchanged.
    Three new exports — `setActiveView`, `getActiveView`,
    `enableMultiDocMode` plus `buildEditorPlugins` and
    `effectivePtForNode` — let the multi-pane module build per-pane
    views with the exact same plugin stack as the single-doc shell
    and steer the shared ribbon / status bar at the focused pane.
  - The shell's `enableMultiDocMode` flips a `multiDocActive` flag
    in `editor/index.ts` and registers a `multiDocOnFileOpen` hook;
    the existing `dropzone.change` handler delegates to that hook
    instead of running `mountView` when the flag is set.

### Layout cells

CSS-driven: the `.pmd-multi-row` has a `data-active` attribute (1 /
2 / 3) that flex sizing reads. With `data-layout="compact"`, each
active pane gets a fair share of the row (1 = full, 2 = halves, 3
= thirds). With `data-layout="wide"` and three active panes, panes
become 45% wide and the row is `overflow-x: auto;
scroll-snap-type: x mandatory` — clicking the visible peek snaps
to that pane. With 1 or 2 panes under wide-scroll, the layout
collapses to the same flex sizing as compact (nothing to scroll).

### Drag-and-drop

`drag-controller.ts`'s commit branch now handles cross-view drops
by always copying. The source slice's heading IDs are rewritten
(same `rewriteHeadingIds` the in-doc copy-drag uses) so the
workspace's id-uniqueness invariant holds. `DragSurface.hitTest`
returns an optional `view` so a cross-pane surface can declare
which doc the drop lands in. The editor surface (`drag-editor-
surface.ts`) and nav surface (`nav-panel.ts`) both populate it.
The nav surface also skips the same-doc "drop-on-self" guard when
the drop is cross-view (since the source range refers to a
different doc).

### Per-section nav outline filter

`NavigationPanel`'s constructor accepts `{ localMaxLevel: true }`.
When set, the 1/2/3/4 buttons toggle a per-instance level rather
than writing to the global `navMaxLevel` setting. Each pane's
section is independent — matches Q2.

### Typography / sizing inheritance

The single-doc shell scopes typography flags to `#editor.X`. The
multi-pane editors aren't descendants of `#editor`, so they
wouldn't pick up these rules. Two changes:

  - `applyDisplaySizes` / `applyLineHeight` / `applyBodyFont` now
    set their CSS custom properties on `documentElement` as well
    as on `#editor`. The single-doc behavior is unchanged
    (documentElement is an ancestor of `#editor`); the multi-pane
    editors inherit the same vars.
  - Mirror `pmd-cite-underlined` / `pmd-undertag-italic` / etc. to
    documentElement (most were already mirrored; added
    `pmd-underline-bold`). New CSS rules at the end of style.css
    duplicate the `#editor.X .pmd-Y` typography selectors for the
    multi-pane surface: `html.X .pmd-pane-editor .pmd-Y`.

### Routing prompt

Inline overlay (`promptForSlot`) showing three slot buttons +
Cancel. Each button labels its slot ("Slot 1") and shows the
current contents in a smaller line below ("(empty)" or
"filename" or "filename (+N)" for stacks). The per-pane "+ Open
file" footer button shortcuts past the prompt by setting
`pendingRoute` before triggering the picker.

### Comments off

`enableMultiDocMode` hides the comments toggle / add buttons and
the column itself. The comments plugin still runs in each pane's
state (cheap, and avoids re-shaping the plugin stack) — it just
has no UI to render against.

### Known limitations (prototype scope)

  - Toggling the master switch requires a page reload (acceptable
    per session).
  - `applyReadMode` only re-runs against `getActiveView()`. The
    other panes don't see the toggle until they're refocused —
    not a problem in practice since read-mode toggles are global
    via the setting and are cheap to re-apply on focus.
  - Find / Replace, AI flows, and the Doc / Card / Table menus
    all route through the focused pane only.
  - Live-view stacks consume per-doc memory. For a typical
    workspace of 3–6 docs this is well within budget.

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
(eventually) editor. We'll split into a monorepo (e.g.
`@cardmirror/schema`, `@cardmirror/docx-converter`) only if
web/desktop divergence or external publication forces it. YAGNI for v0.

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

See `ARCHITECTURE.md §17` for the full inventory.

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
  optional per-ID overrides. Rebinding UI lives in Settings as of
  2026-05-12 (see "Keybinding editor" entry below).

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

Verbatim's Shrink (font-size cycle on un-underlined runs) lives on
`Mod-8` — see the 2026-05-12 Shrink entry below for the full ruleset.

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

## 2026-05-11: `font_size` moved to outermost mark rank

Bug: in a paragraph at body default (11pt), scaling a span up via a
`font_size` mark left the surrounding emphasis box / highlight band
sized for 11pt — glyphs rendered at the larger size poked out
above and below the box. Same pattern for strikethrough, undertag,
analytic, link.

Cause: an inline element's `background` and `border` paint on a box
whose height comes from *its own* `font-size`, not from any
descendant. The DOM nesting was

```
<span class="pmd-emphasis">       ← inherited 11pt → 11pt-tall box
  <span class="pmd-highlight">    ← inherited 11pt → 11pt-tall band
    <span style="font-size: 26pt">← 26pt glyphs
```

because `font_size` was the highest-ranked mark in `marks.ts` and
therefore the innermost DOM wrapper. (Not related to
`font-size-class-plugin`'s `.pmd-fs-shrunk` pin — that plugin bails
out on paragraphs containing any bare text, which is most of them.)

Fix: define `font_size` as the FIRST mark in `marks.ts`, making it
the outermost wrapper. Now `<span style="font-size: 26pt">`
contains the named-style / highlight / shading / strikethrough
wrappers, those wrappers inherit 26pt, and their boxes match the
text. Word treats direct `<w:sz>` as overriding a character style's
size, so this also matches the OOXML semantic.

OOXML round-trip is unaffected — mark order within a run doesn't
change which `<w:rPr>` children get emitted, and `Mark.setFrom`
re-sorts mark sets by rank regardless of insertion order. The 13
mark-fidelity and 21 real-doc round-trip tests all still pass.

## 2026-05-11: F2 — Paste Text + tag/analytic-paste auto-split

Two paste-handling interventions, both housed in
`src/editor/paste-plugin.ts`.

### F2 → armed plain-paste mode

First pass at F2 used `navigator.clipboard.readText()` to read the
clipboard programmatically. Both Chromium and Firefox show a "Paste"
prompt for that call regardless of user gesture, and Firefox
explicitly refuses to offer a persistent grant for `clipboard-read`.
That's a UX dead end for a one-keystroke F2.

The user's `paste` event (Ctrl/Cmd+V), on the other hand, exposes
`event.clipboardData` directly — no prompt, no chip. So F2 became a
**toggle for a "next paste is plain" flag** kept in the paste
plugin's state. The flow:

1. User presses F2 (or clicks the "T" toggle in the ribbon's
   doc-ops panel, stacked below the ¶ Paragraph-Integrity button).
   Plugin state flips to `plainPasteArmed: true`; the ribbon button
   reflects the armed state via `aria-pressed="true"` (same pressed-
   look as the ¶ toggle and the paintbrush color buttons).
2. Every subsequent Ctrl/Cmd+V is intercepted by `handlePaste`:
   reads `event.clipboardData.getData('text/plain')`, replaces the
   selection with a slice from `buildPlainTextSlice` (newline-
   delimited, no marks), clears stored marks. The flag stays on —
   this is a **sticky toggle**, not a single-shot arm.
3. If `condenseOnPaste` is on, runs the F3 default condense
   immediately after each paste — Branch C if `paragraphIntegrity`,
   else `condenseMerge` with the live pilcrow / heading-mode
   settings.
4. Pressing F2 again (or clicking the ribbon button) toggles the
   flag back off; subsequent pastes fall through to PM's default
   formatted-paste behavior.

`buildPlainTextSlice` shape: single line → `Slice(Fragment(text), 0,
0)`; multi-line → `Slice([paragraph(line₀), …], 1, 1)` so the
slice's open ends merge into the surrounding block on insertion.
Recognises `\r\n`, `\r`, and `\n` as paragraph separators.

### Tag / analytic paste → split the destination container

PM's default "fit pasted content into the schema" behavior strips
heading wrappers that don't match the destination's content rule.
Pasting a copied tag into a card_body produced an inline-text
insertion (tag style lost). User wanted the structural type
preserved — and the natural action when a tag lands inside another
card is the same as F7: **split the destination card at the cursor,
new card starts with the pasted tag**.

`tryPasteSplitContainer` fires when:

- The pasted slice has exactly one top-level node AND that node is a
  `tag` or `analytic`.
- The cursor is at depth 2, inside a body slot (`card_body` |
  `cite_paragraph` | `undertag`) of a `card` | `analytic_unit`.

It then splits:

- Original container keeps `[head, …pre-cursor children, body(pre-
  cursor text)]`. Empty pre-body is dropped.
- New container (`card` for a pasted tag, `analytic_unit` for a
  pasted analytic) gets `[pastedHead, body(post-cursor text),
  …following children]`. Empty post-body is dropped. When the new
  container is an `analytic_unit` and a following child was an
  `analytic` (cite-position alternative inside a card), it's re-
  wrapped as `card_body` since analytic_unit only permits one
  analytic head.
- Cursor lands at the end of the pasted head's text — same
  convention as F7 (setTag), so the user can immediately edit the
  heading name.

Multi-node slices, non-head first-children, doc-level cursors, and
head-cursor positions all fall through to PM's default paste
handling — the auto-split is a precise targeted intervention, not a
general paste rewrite.

### Plumbing

- `RibbonContext` gained `condenseOnPaste: () => boolean` (consumed
  by the paste plugin, not by any Command directly).
- The global keydown handler in `index.ts` now passes `view` as the
  third Command argument so a future async-needing command could
  still dispatch from outside the editor's focus.
- Status-bar HTML gained `<div id="plain-paste-indicator">` (hidden
  by default); the paste plugin's `onArmedChange` callback toggles
  its `hidden` attribute.

## 2026-05-12: Emphasis box white-gap fix — drop the 2px padding

Highlights crossing an emphasis-boxed run showed a thin white sliver
on each side of the boxed text: the highlight bg only painted INSIDE
the `.pmd-highlight` span, but emphasis carried `padding: 0 2px` to
give the box visual breathing room — and that padding sat between
emphasis's border and the highlight's painted area.

**First attempt (reverted):** moved `shading` and `highlight` to outer
mark ranks (right after `font_size`) so highlight's bg would wrap the
entire emphasis span, padding and all. This filled the gap — but
created a worse bug. When a single continuous emphasis run has some
sub-ranges highlighted and others not, PM splits the inner mark into
multiple DOM spans at every change in the outer marks. With emphasis
inner, a run like `<hl><emph>how narrow </emph></hl><emph>his </emph><hl><emph>margins are</emph></hl>`
renders THREE `.pmd-emphasis` spans, each painting its own border —
visible as "phantom" internal borders inside what looks like a single
emphasis box to the user.

**Adopted fix:** keep the historical mark ranks (emphasis OUTER,
highlight INNER) and remove the `padding: 0 2px` from
`#editor.pmd-emphasis-box .pmd-emphasis`. With no padding, the
border hugs the text directly and there is no padding region for the
gap to appear in. A continuous emphasis run is still ONE
`.pmd-emphasis` span regardless of internal highlight changes, so no
phantom borders. This also matches Word's character-border rendering
more closely (Word's borders hug the text rather than reserving
internal padding).

## 2026-05-12: Shrunken paragraphs — line-height only, never font-size

### What changed

`pmd-fs-shrunk` paragraphs now carry inline
`style="line-height: <minPt × 1.2>pt"` — and nothing else. The
paragraph's own `font-size` is left alone. The bare-text inline
decoration is gone, and the `.pmd-fs-shrunk .pmd-*` font-size
pinning rules in CSS are gone.

### Why (the previous iterations)

V1 (original): plugin shrinks paragraph to `font-size: <min>pt;
line-height: <ramp>` whenever ALL text is marked small.
- Bug: bailed on any bare text, so mixed-font paragraphs
  (11pt body + 8pt citation runs — the common Verbatim shape)
  got no shrink at all.

V2 (the bare-text decoration): drop the hasBare bail; emit an
inline `Decoration.inline` over each bare-text range pinning it
back to 11pt + body line-height.
- Bug: the decoration relies on a separate strip-and-re-pin pass.
  When `font_size` marks were stripped via F9's toggle-off (or
  any other path), the newly-bare text didn't always pick up the
  decoration in the same paint cycle — text would appear small
  even though no `font_size` mark was on it. The debug chip
  reported the "right" size (body 11pt) while the visual stayed
  small. Architecturally, "shrunk" was leaking into a font
  cascade it should never have touched.

V3 (current): "shrunk" is a line-height adjustment only. The
paragraph keeps its body `font-size`. The strut gets the absolute
`line-height: <minPt × 1.2>pt` value, which is inherited as a
length by every inline descendant. Per-line rendering still works
because CSS line-box height = max(strut, content's natural extent):
- 8pt-only line: strut 9.6pt wins → 9.6pt tall. Tight.
- Bare 11pt line: content's 11pt natural extent wins → ~11pt.
- 13pt cite line: content wins → ~13pt.
- mixed line: tallest element wins. (Same as Word's "single".)

Named-style spans inherit the body cascade naturally (`.pmd-cite`
keeps its unconditional 13pt; `.pmd-underline` / `.pmd-emphasis`
inherit body 11pt), so no `.pmd-fs-shrunk .pmd-*` font-size pin
is needed.

Crucial invariant: applying / removing `font_size` marks now has
predictable visual results. Bare text is bare text — it renders
at its parent paragraph's font-size, full stop. The font-size
chip is now always consistent with what the user sees.

## 2026-05-12: Cite paragraph + tag + analytic line-height = 1.1

`#editor` carries `--pmd-line-height: 1.2` as the body default,
which for `.pmd-cite` text (13pt) produced a 15.6pt line strut —
visibly looser than Verbatim's tight cite rendering. Same applied
to tags and analytics (also 13pt).

Set `line-height: 1.1` directly on `.pmd-cite-para`, `.pmd-tag`, and
`#editor .pmd-analytic`. At 13pt × 1.1 = 14.3pt line strut, these
elements now match Verbatim's compact heading + cite look while body
paragraphs keep their 1.2 multiplier. The bare-text inline decoration
inside shrunk paragraphs still resolves `var(--pmd-line-height)` to
1.2, so mixed-font body paragraphs render correctly.

Trade-off acknowledged: the 1.1 here is a CSS literal rather than a
variable, so if we later expose body line-height as a user setting
those structural elements won't track it. Refactoring to a "tight"
companion variable can wait for that surfacing.

## 2026-05-12: Style apply strips direct formatting (F4–F10)

Verbatim semantics: applying a paragraph or character style is a
"reset to canonical" action — the new style's typography defines
the run's visual identity, and prior direct overrides
(font-size / color / family, bold, italic, strikethrough, highlight,
shading) lose their meaning. Our hotkeys now mirror that.

### F8 (Cite), F10 (Emphasis) — one-directional apply

`applyBodyMark` adds the named-style mark and then strips
`DIRECT_FORMATTING_MARK_NAMES` across the same range. Always. The
user can re-apply direct formatting manually afterward.

### F9 (Underline) — true toggle

- **Apply direction:** for each per-textblock segment, add the
  underline mark (`underline_mark` in body, `underline_direct` in
  structural per the existing body/structural split) and strip
  direct formatting. `underline_direct` is intentionally excluded
  from `DIRECT_FORMATTING_MARK_NAMES` so the strip pass doesn't
  erase the mark it just added in a structural segment.
- **Toggle-off direction:** removes both underline marks. Whether
  it also strips other direct formatting is gated by the new setting
  `clearFormattingOnNamedStyleToggleOff` (default **true** — matches
  Verbatim's "press F9 twice to clear formatting" workflow). Users
  who prefer F9 as a pure underline toggle can flip it off.

### F4 / F5 / F6 setHeading; F7 setTag; Mod-F7 setAnalytic; Mod-F8 setUndertag

Every promotion code path strips
`PROMOTION_STRIP_MARK_NAMES` from the new structural block's text
content. This is the union of direct formatting +
`underline_direct` + every named-style mark (cite_mark /
underline_mark / emphasis_mark / undertag_mark / analytic_mark).
`link` and `pilcrow_marker` are preserved (semantic content, not
formatting).

Strip is performed at content-fragment time (`stripPromotionMarksOnFragment`)
when a new structural node is being constructed from existing
content, and via `stripPromotionMarksOnTr` on `setNodeMarkup`
paths where content stays put but the wrapping node changes type.

### Exception: tag ↔ analytic same-tier swap

`convertCardToAnalyticUnit` (tag → analytic), `convertAnalyticUnitToCard`
(analytic → tag), and the matching branch of `asTransformed` inside
`applyStructuralToSelection` deliberately skip the strip. Tag and
analytic are the same structural tier — both are container anchors
holding a heading-shaped run, distinguished only by the cite vs
analytic semantic. Swapping between them isn't really "applying a
different style"; it's reclassifying the same heading. Preserving
direct formatting matches the user's expectation that bold/etc.
manually added to a tag survives an F7-while-already-in-analytic
(or Mod-F7 from a tag) reclassification.

All other dissolves (tag → pocket via setHeading, tag → undertag via
setUndertag, etc.) still strip.

## 2026-05-12: Shrink (Mod-8) — Verbatim parity with scoped omissions toggle

Port of Verbatim's `ShrinkText`. Cycles the size of "filler" (non-
underlined, non-emphasized) text through `11 → 8 → 7 → 6 → 5 → 4 → 11`;
mixed sizes normalize to 8 pt; underline / emphasis runs are exempt
and keep their existing size (the point of Shrink is to compress the
connective text while leaving the highlighted argument-text readable).

### Scope

- Empty selection inside a `card` → all `card_body` paragraphs of that
  card.
- Empty selection inside an `analytic_unit` → all `card_body`
  paragraphs of that unit.
- Empty selection in a doc-level `paragraph` → that paragraph.
- Empty selection in pocket / hat / block / doc-level undertag / doc-
  level cite_paragraph → no-op (those aren't body text).
- Non-empty selection → the parts of the selection that fall inside
  `card_body` paragraphs (in cards or analytic_units) and doc-level
  generic `paragraph` paragraphs. Tags, undertags, cite paragraphs,
  and headings within the selection are skipped.

### Protected-range handling

Two kinds of bracketed spans get optional special treatment, gated by
the new setting `shrinkRestoresOmissionsToNormal` (default **off**):

1. **Omissions** — `[…Omitted…]`, `[[…Omitted…]]`, `<…Omitted…>`,
   `<<…Omitted…>>`, `{…Omitted…}`, `{{…Omitted…}}`.
2. **"Condense with warning" markers** —
   `<open>PARAGRAPH INTEGRITY (PAUSES|RESUMES)<close>` for every one
   of the 6 delimiter variants (`[`/`[[`/`<`/`<<`/`{`/`{{`), regardless
   of the current `condenseWarningDelimiter` setting — so changing the
   delimiter mid-doc doesn't strand older markers.

All patterns are `gi` (case-insensitive, global); `.*?` is non-greedy
and JS `.` doesn't cross newlines, so bracket pairs stop at the
nearest closer in the same paragraph.

When **on**:

- Protected ranges are computed up front from the scope and **excluded
  from the cycle-decision input**. Without this exclusion, a protected
  span pinned at Normal from a prior cycle would make the size-set
  size > 1 on the next press, forcing the rest of the text back to 8
  pt and stranding the cycle.
- Protected ranges are also excluded from the size mutation; eligible
  text-node intervals are split around them via `subtractRanges`.
- After the eligible pass, protected ranges are forced to Normal size
  so they remain visible in the shrunken output (regardless of any
  pre-existing `font_size` mark).

When **off**, omissions and warning markers are treated as ordinary
text: shrunk with the surrounding body, no exclusion, no restore. The
default is off because the default doc style already keeps these spans
readable in normal view; the restore behavior is a power-user feature
for users who shrink aggressively but want their landmark text
preserved.

## 2026-05-12: Condense with warning (Card menu)

A selection-only, single-card variant of `condenseNoIntegrity` (Branch
A — merge with spaces, no pilcrows) that bookends its result with
explicit human-readable markers. Inspired by debate-community
convention for marking a condensed segment so a reader (or a later
editor) knows the source paragraphs were merged.

### Behavior

Validates the same shape as Create Reference: non-empty selection,
every touched textblock is `card_body`, all in a single parent `card`
(no-op otherwise — including selections that touch a tag, undertag,
cite paragraph, or content in another card). On match:

1. Merge the touched `card_body` paragraphs into one (cleaned
   whitespace; single-space joins between source paragraphs).
2. Replace the original `[first.pos, last.pos + last.nodeSize)` range
   with three `card_body` paragraphs:
   - `<open>PARAGRAPH INTEGRITY PAUSES<close>`
   - the merged paragraph
   - `<open>PARAGRAPH INTEGRITY RESUMES<close>`

Open / close come from the new `condenseWarningDelimiter` setting —
one of `[`, `[[`, `<`, `<<`, `{`, `{{` (close is the mirror), default
`[`. The setting is a radio-list editor in the Settings dialog.

### Surfacing

Lives in the Card menu's Condense subsection (alphabetically positioned
between "Condense with pilcrows" and "Uncondense"). No keyboard
binding — the registry entry has `''` for its default key, which
`buildRibbonKeymap` silently skips. The reference (cheat-sheet) modal
shows it under Condense with `—` for its key.

### Shrink interaction

The warning markers are scanned by Shrink alongside omissions and
governed by the same `shrinkRestoresOmissionsToNormal` toggle. See the
"Protected-range handling" section of the Shrink entry above.

## 2026-05-13: Select Similar Formatting (Doc menu, two variants)

Native port of Verbatim's `Formatting.SelectSimilar`. Verbatim wraps
Word's intrinsic `WordBasic.SelectSimilarFormatting` (with a
Shrink/Grow hack for plain body text — see the source at
`reference-docs/verbatim/desktop/src/Formatting.bas:272`); we have no
Word matcher to call, so this is a from-scratch implementation
defined entirely in `similar-selection-plugin.ts`.

### Matching fingerprint

For a cursor position, the fingerprint is `(parent textblock type,
non-font_size marks, chip-resolved effective pt)`. Mark equality is by
type AND attrs. Importantly: **the empty mark set is a valid
fingerprint**. Cursor on a `card_body` run with no direct formatting
matches *only* other plain `card_body` runs at the same effective pt,
not every `card_body` in the doc. Per the user spec: "if the style is
card_body and the direct formatting is none, we're matching NONE, not
matching all direct formatting."

**Font size uses the chip's resolver, not the raw `font_size` mark.**
The chip's `effectivePtForNode` walks: explicit `font_size` mark →
named-style mark default (cite/underline/emphasis/undertag/analytic)
→ parent block default (pocket/hat/block/tag/normal). The fingerprint
excludes `font_size` from the mark-equality check and compares the
resolved pt instead — so a bare tag run (13pt from tag style) matches
another tag run carrying `font_size: 26` (halfPoints, = 13pt). Both
read 13pt in the chip, so they're "similar" to the user even though
one mark set is empty and the other isn't. A tag run with
`font_size: 52` (= 26pt) doesn't match, because its chip pt differs.

The plugin is wired up via `buildSimilarSelectionPlugin(effectivePt)`
(factory) so the resolver is bound at construction time; both the
top-level commands and the plugin's own apply (which fires matching
when the scoped flow's cursor lands in the scope) use the same
resolver.

The "text node at the cursor" preference order is `$pos.nodeBefore`
first (matches Word's typing-continues-previous-run convention), then
`$pos.nodeAfter`. Cursor at an empty paragraph (no surrounding text)
returns no matches.

### Selection model — shadow selection

PM doesn't support disjoint selections, so matches are rendered as
inline decorations rather than a real `Selection`. A new plugin
(`similarSelectionPlugin`) holds plugin state `{ matches: RangePair[],
scope: RangePair | null, mode: 'idle' | 'awaiting-cursor' }` and emits
two decoration classes:

- `.pmd-similar-scope` — the user-picked outer range for the scoped
  variant. Faint amber background tint.
- `.pmd-similar-match` — each matched run. Dashed amber outline with
  a slightly stronger background.

No format command consumes the shadow selection yet — this is a pure
visual first cut. The follow-up is to extend selected ribbon commands
(font color / highlight / shading / bold / italic / font size /
F8-F10 / clearToNormal) to operate on the match set when the PM
selection is collapsed and matches are non-empty. Validating the
matching + dismissal UX before doing that plumbing.

### Two commands

- `selectSimilar` (unscoped) — no-op on a non-empty selection.
  Otherwise computes the fingerprint at the cursor, walks the whole
  doc, and dispatches `setMatches`.
- `selectSimilarScoped` — two-stage. First invocation requires a
  non-empty selection: that range becomes the scope, plugin enters
  `awaiting-cursor`, the scope renders with its tint. The next
  collapsed-cursor transaction inside the scope triggers matching
  restricted to the scope; if the cursor lands outside the scope,
  the scope is cancelled instead.

Both commands sit in a new "Select" subsection of the Doc menu
(alphabetically after Highlighting). Empty default keys — bind via
the keybinding editor if desired.

### Dismissal

Any doc-changing transaction clears matches + scope. Any selection-
changing transaction clears matches **unless** the new collapsed
cursor lands inside an existing match (which is what happens right
after the command's own dispatch — so the command doesn't dissipate
itself). Escape clears via `handleKeyDown`. The plugin's setMeta
transactions are recognized before the dismissal branch fires.

**Scoped re-fingerprinting (2026-05-14):** In the scoped flow, the
scope sticks around after matching completes. A cursor click inside
the original scope but outside any current match re-runs matching
from the new cursor — same scope, new fingerprint — instead of
dismissing. Lets the user fix several distinct formats in the same
span in quick succession without redrawing the selection each time.
Clicks outside the scope still dismiss; the unscoped flow is
unchanged (no scope, so any out-of-match cursor click clears).

### Why decorations and not a sidecar selection plugin

PM's intrinsic Selection has well-defined edit semantics; a shadow
selection rendered as decorations does not. Treating the match set
as a "current target for format ops" needs every consumer command to
opt in. Doing it as decorations + an explicit follow-up phase keeps
the contract sharp: ribbon commands keep their existing PM-Selection-
based semantics today, and the upcoming "operate on similar" surface
can be added incrementally without retrofitting every command at once.

## 2026-05-13: Keybinding editor

Activates the rebinding surface that has been sitting unused since the
ribbon registry first landed (2026-05-10 entry above). New
`ribbonKeyOverrides` setting — a `Partial<Record<RibbonCommandId,
string | string[]>>` — feeds the existing `buildRibbonKeymap` /
`ribbonCommandForKey` / `primaryKeyFor` override args from one place,
and a settings-dialog editor surfaces every command for rebinding.

### Settings storage

- `ribbonKeyOverrides` is the full override map. Absence of a key
  means "use the default for this command"; presence with a non-empty
  spec replaces the default; presence with `''` or `[]` means the
  command is explicitly unbound. The store sanitizes unknown shapes
  to `{}`.
- The override map is sanitized by shape only — unknown command IDs
  pass through (no circular import of the ID list, and stale IDs from
  a future rename simply have no effect at lookup time).

### Reactive plugin reconfigure

`mountView` builds the editor's plugin list via a new `buildEditorPlugins()`
helper. A settings subscriber compares `s.ribbonKeyOverrides` by
reference against the last applied value; when it changes,
`view.updateState(state.reconfigure({ plugins: buildEditorPlugins() }))`
swaps the plugin stack in place — the doc, selection, and history
survive. No remount, no reload.

The settings store reuses object identity (`set` short-circuits when
the value `===` the stored one), so the subscriber doesn't reconfigure
for unrelated setting changes — only when the override map actually
moved.

### Editor UI (`keybindings-editor.ts`)

- One row per `RibbonCommandId`, sorted alphabetically by
  `RIBBON_COMMAND_LABELS[id]` so users can find commands by name.
- Resolved bindings (overrides win, default fallback) render as chips
  with `×` to remove. Empty resolution renders as `—`.
- `+` per row enters a capture mode: listens for a `keydown` and
  builds a key string via `ribbonKeyStringFor`. Escape cancels. Bare
  modifiers, Escape/Tab/Enter/Space, and single-character keys
  without a modifier are rejected with an inline flash.
- Conflict policy: if the captured key is already bound to another
  command, that command's binding set has the key removed first (the
  trimmed list becomes that command's override). The displaced
  command's row flashes the change. This guarantees one-key-one-
  command — predictable for users, no last-keymap-wins surprise.
- `↺` per row drops the override entry entirely (back to default).
- "Restore all defaults" at the bottom clears the whole override map.

### Surfaces threaded with overrides

- `buildRibbonKeymap(settings.get('ribbonKeyOverrides'), …)` — the
  PM keymap inside the editor.
- Global `window` keydown handler in `index.ts` —
  `ribbonCommandForKey(keyString, settings.get('ribbonKeyOverrides'))`,
  so F-keys still fire commands when the editor isn't focused.
- Ribbon button tooltips —
  `primaryKeyFor(id, settings.get('ribbonKeyOverrides'))`.
- Reference (cheat-sheet) modal — reads overrides at render time so
  the displayed keys match the user's customizations.

## 2026-05-13: Copy-drag in the nav pane

File-manager convention: drag with **Ctrl** on Windows/Linux or
**Option** on macOS to copy instead of move. We support this for
nav-pane drags only (editor-sourced drag already requires a
Ctrl+Alt+Shift chord, so layering a "copy" modifier on top isn't
ergonomic). Force-move (the OS default modifier) and shortcut/symlink
aren't supported; the latter is the obvious shape for a future
transclusion gesture.

### Controller

`DragControllerImpl.commit(opts: { copy?: boolean })` branches between
`buildMoveTransaction` and the new `buildCopyTransaction`. Copy:
slice the source range(s), rewrite every heading-bearing node's `id`
attr to a fresh `newHeadingId()`, then insert at the drop target
without deleting the source. ID rewriting walks the slice's fragment
tree; text nodes (immutable, no id attr anyway) and inline leaves
are left intact.

The controller also tracks a `copyMode` flag, refreshed by the drag
source on pointermove / keydown / keyup. Subscribers (the pickup
pill) read it via `isCopyMode()` and update visuals without needing
their own modifier listeners. The flag resets to false on `begin`
and on `commit` / `cancel`.

### Nav pane

`isCopyModifier(e)` = `e.ctrlKey || e.altKey`. Accepting both
unconditionally is friendlier than platform-detecting — on macOS,
Ctrl-drag has no built-in conflicting semantic; on Windows/Linux,
Alt-drag is conventionally unused.

`onDragUp` reads the modifier off the pointerup event (final intent
at release time). `onDragMove` / `onDragKey` update the controller's
`copyMode` flag as the user holds or releases the modifier mid-drag,
so the pickup pill's copy badge tracks live. A `keyup` listener
mirrors the `keydown` listener so a release with no pointer motion
clears the badge.

### Visual

Pickup pill gets a `.pmd-nav-pickup-pill-copy` class while in copy
mode; a small green `+` badge renders in the bottom-right corner via
`::after`, echoing the OS file-manager copy-cursor pattern.

## 2026-05-13: Custom shrink protections + custom warning delimiter

Two related extensions to the protected-shrink system that lets users
keep tunneling more of their personal conventions into the editor.

### Settings model

- `shrinkCustomProtections: { pattern: string; isRegex: boolean }[]`
  — user-supplied protection rules. Literal entries are
  regex-escaped at compile time; regex entries pass through. Both
  compile with `gi` flags (matching the built-in shape). Invalid
  regex sources are silently skipped at compile time.
- `condenseWarningDelimiter` gains a `'custom'` value, paired with
  `condenseWarningCustomOpen` and `condenseWarningCustomClose`
  strings. The built-in enum values still use their mirror-pair
  closers; `'custom'` reads both halves from the user-typed strings.

### Shrink pipeline

`PROTECTED_RANGE_REGEXES` (the static const) is renamed
`BUILTIN_PROTECTED_REGEXES` and is now combined at runtime by a new
`compileShrinkProtections(custom, customDelimOpen, customDelimClose)`
into a `RegExp[]`. The shrink command consumes that list via a new
`ctx.shrinkProtectionPatterns` getter. The pipeline is still gated
by the existing `shrinkRestoresOmissionsToNormal` toggle — custom
protections share its on/off semantics rather than getting their own
switch.

`findProtectedRanges` previously walked the static list; it now
takes the patterns as a parameter. It also gained a zero-width-match
guard for user-supplied regexes (`/(?=)/gi` etc.) so a pathological
input can't cause an infinite loop.

### Condense-with-warning custom delimiter

`condenseWithWarning` now takes a `getDelimiter: () => { open, close }`
resolver instead of an enum. The editor's `ribbonContext.condenseWarning-
Delimiter` materializes the pair: built-in enum values produce the
mirror pair via `condenseWarningCloseFor`; `'custom'` reads the two
user-typed strings. If either half is empty when `'custom'` is
selected, the command no-ops with a console warn rather than
emitting half-formed markers.

The same custom open/close get auto-fed into the shrink protection
pipeline so the markers the command emits are also auto-protected —
fulfilling the "same pipeline" guarantee the user asked for.

### Settings UI

- "Custom shrink protections" — new row below the existing
  shrink-restores toggle. Same shape as the readers editor: text
  input + regex checkbox + delete + add-row footer. An inline note
  beneath each row flags invalid regex source as the user types
  (purely a UX hint; shrink itself silently skips bad regex).
- "Condense with warning: marker delimiter" — adds a "Custom" radio
  row beneath the six built-in rows, with two short text inputs for
  open and close + a live sample preview.

## 2026-05-13: Import — HYPERLINK field codes + soft / non-breaking hyphens

Two narrow import additions, both bidirectional.

### HYPERLINK field codes

Word emits two encodings for hyperlinks: the structured
`<w:hyperlink r:id="…">…</w:hyperlink>` element (modern, what our
exporter produces) and the older field-code form:

```xml
<w:r><w:fldChar w:fldCharType="begin"/></w:r>
<w:r><w:instrText> HYPERLINK "https://…" </w:instrText></w:r>
<w:r><w:fldChar w:fldCharType="separate"/></w:r>
<w:r>…display runs…</w:r>
<w:r><w:fldChar w:fldCharType="end"/></w:r>
```

The importer now tracks an `ImportContext.fieldStack` of `FieldState`
records (`phase: 'instr' | 'result'`, accumulated `instr`, parsed
`hyperlinkHref`). Field chars drive state transitions; `<w:instrText>`
accumulates into the top field's `instr`; on `separate`, we parse
`/HYPERLINK\s+"([^"]*)"/i` out of the instructions; on `end`, we pop.
Display runs between `separate` and `end` get our existing `link` mark
applied via the same `currentMarks()` resolver that handles
`<w:hyperlink>`-element-based links. Display content between `begin`
and `separate` (the spec section) is suppressed.

Non-HYPERLINK fields (PAGE, REF, DATE, …) pop through the same state
machine but contribute no mark; their result runs survive as plain
text, which is the right behavior for debate docs where field values
should be flattened on import.

On export we keep emitting only the `<w:hyperlink>` element form;
there's no reason to write field-code-style links.

### Soft / non-breaking hyphens

Imports now convert `<w:noBreakHyphen/>` → U+2011 and `<w:softHyphen/>`
→ U+00AD inline (as text nodes inheriting the run's marks). Exports
split text on these two characters before composing `<w:r>` children,
emitting `<w:noBreakHyphen/>` / `<w:softHyphen/>` between the surrounding
`<w:t>` segments. The previous behavior dropped both elements silently.

Round-trip is symmetric: a doc whose only hyphen content is U+2011 /
U+00AD passes through editor → docx → editor with identical text
content and identical OOXML hyphen-element placement.

## 2026-05-13: Superscript / subscript marks

Two new direct-formatting marks: `superscript` ↔
`<w:vertAlign w:val="superscript"/>` and `subscript` ↔
`<w:vertAlign w:val="subscript"/>`. Separate marks (not one mark with
a value attr) so the ProseMirror lifecycle handles toggle and mutual
exclusion natively — each declares `excludes: 'superscript subscript'`
so applying one strips the other automatically.

Renders as native `<sup>` / `<sub>`, letting the browser handle the
baseline shift and ~0.83em font scaling without per-mark CSS. Both
are `inclusive: true`, matching bold / italic / strikethrough: typing
adjacent to a run carrying the mark inherits it.

Two new ribbon commands — `toggleSuperscript` and `toggleSubscript`
— wired through the standard `shadowAwareToggleMark` so the
shadow-selection (`getOperatingRanges`) path applies uniformly.
Defaults follow Word: `Mod-Shift-=` for superscript, `Mod-=` for
subscript. Listed in the reference cheat sheet under "Inline
formatting" alongside bold / italic.

Importer reads `<w:vertAlign w:val="…"/>` inside `<w:rPr>` (the line
that previously dropped `vertAlign` with a `// drop` comment).
Exporter emits the right `<w:vertAlign/>` whenever either mark is
present; the `excludes` schema guarantee means at most one will be.

## 2026-05-13: Built-in shrink protection — FOOTNOTE callouts

Added six entries to `BUILTIN_PROTECTED_REGEXES` matching
`<delimiter>…FOOTNOTE…</delimiter>` for each of the six delimiter
shapes (`[`, `[[`, `<`, `<<`, `{`, `{{`), case-insensitive. Same
non-greedy `.*?` pattern shape as the existing Omissions entries
so any body text on either side of the literal "FOOTNOTE" stays
inside the protected range. Doubles listed before singles so the
longer match wins on overlap, matching the rest of the file's
ordering convention.

## 2026-05-13: AI explainer (comments-integrated) + Clod port

The comments plugin now hosts the user's AI-explainer flow. Two
entry points, both selection-based:

  - **`+` button / `addCommentToSelection`** — creates a normal
    human-only thread (no AI auto-fire). User can later type
    `@AI` in a reply to invoke the model.
  - **`🤖` button / `aiAskAboutSelection`** — creates a thread
    with a pending-AI flag and caches the explainer context at
    the moment the thread was opened. The user types their
    question into the first input; on submit the question is
    stored as the root comment AND a POST goes to Anthropic with
    the cached context. Reply arrives as a `kind: 'ai'` comment
    in the same thread.

### Anthropic client

`src/editor/ai/anthropic.ts` is a thin `fetch` wrapper around
`POST /v1/messages`. Direct browser calls require the
`anthropic-dangerous-direct-browser-access: true` header — the
user knowingly opts in by enabling AI features and pasting their
key. `AnthropicError` carries a `kind` discriminant
(`no-key | auth | rate-limit | server | network | parse`) so the
toast layer can pick a useful message without parsing strings.

### Context builder

`src/editor/ai/explain-context.ts` walks up from the selection's
`$from` to the nearest `card` or `analytic_unit`, collects its
`tag` / `analytic` / `cite_paragraph` children, and packages them
with the selection text. Doc-level selections fall through with
just the selection. The cached context is captured at thread
open so the AI sees what the user actually meant, even if the
user edits elsewhere before submitting.

### System prompt

The prompt frames replies as a research coach for an educational
tool. Each reply has three short parts: a direct answer (treated
as a jumping-off point, not the final word), specific search
terms, and concrete places to look (Google Scholar, JSTOR, SSRN,
think-tank archives, domain-specific journalists, debate-camp
evidence repos, etc.). Replies should be short enough for the
side-panel comment format.

### `@AI` mention

`hasAiMention(text)` matches `@AI` (case-insensitive) bounded by
non-word chars on either side, so substrings inside emails /
acronyms don't trigger. Any reply containing the mention
re-invokes the model with the thread's range as context. When
the original context wasn't cached (e.g. for a `+` thread),
`contextFromCurrentRange` rebuilds it from the comment_range
mark's current position.

### Clod persona port

Ported from the user's prior `Card Formatting Tools.py` so the
in-flight placeholder while the model is composing cycles
through time-of-day activities ("Clod is making toast…") instead
of plain "Thinking…".

  - `src/editor/ai/clod.ts` — activity pools per time period
    plus eight holidays that replace the day pool on their
    calendar date. `currentClodPeriod` handles ranges that cross
    midnight. `activitiesForNow` resolves custom overrides
    (non-empty user array → use that pool) vs built-in defaults.
  - **Settings UI** — a new "Enable Clod mode" toggle (kind
    `'clod'`). Easter egg: Mod + Alt + Shift + click on the
    checkbox opens `src/editor/ai/clod-configurator.ts`, a dialog
    with one tab per time period (activity-pool text area + reset
    button) plus a Time-Periods tab for the hour boundaries. We
    started with shift + right-click and had to switch — the
    browser's native context menu and our handler raced badly.
  - **Comments UI** — when AI is in-flight AND Clod mode is on,
    the placeholder text is a Clod activity. A 4-second ticker
    refreshes it via `data-activity-target` while the request is
    outstanding; the ticker stops on the last resolution.

### Master switch

`aiFeaturesEnabled` gates the entire surface: the 🤖 button is
hidden via the `hidden` attribute (and a settings subscriber re-
syncs on toggle), AI commands no-op with a toast, and `@AI`
mentions are ignored. Users can keep their key saved but go
offline ad-hoc by flipping the switch.

Inside the settings dialog, every AI-dependent setting (Anthropic
API key, Clod mode toggle, AI cite-creator prompt button) carries
`aiOnly: true` in its `SettingMeta`. The dialog subscribes to
settings on open and re-applies a `.pmd-settings-row-disabled`
class plus `disabled` on inputs/buttons whenever the master
toggle changes — toggling AI off greys those rows live, without
needing a re-open.

## 2026-05-13: Comments — round-trip + side column + AI groundwork

Comments are now a first-class feature. Three concerns:

### Schema + plugin

  - **Mark:** `comment_range` (non-inclusive, `{ threadId: string }`)
    anchors a range of text to a thread. Renders as a `<span class=
    "pmd-comment-range" data-comment-id="…">` with a subtle yellow
    underline so commented text is visible at a glance.
  - **Plugin state** (`src/editor/comments-plugin.ts`): a
    `Map<threadId, Thread>` lives in plugin state, NOT on the doc.
    Threads carry the heavy data (`Comment[]` with author / date /
    text / `kind: 'human' | 'ai'` / `parentId`). Mutations go
    through `setMeta(commentsKey, …)` payloads — `load`, `add`,
    `reply`, `edit-text`, `delete-thread`, `delete-comment`,
    `set-visible`. Doc-changing transactions trigger an
    `appendTransaction` that GC's threads whose mark has been
    deleted from the doc.

### Round-trip

  - **Importer** reads `<w:commentRangeStart/End>` brackets from
    document.xml and applies `comment_range` marks to text between
    them. A parallel `importComments` parser reads
    `word/comments.xml` (+ optional `word/commentsExtended.xml`)
    into the `Thread[]` shape: comments group into threads via the
    paraId / paraIdParent linkage; sorted root-first then by date.
  - **Exporter** brackets marked text with `<w:commentRangeStart>`
    / `<w:commentRangeEnd>` + `<w:commentReference>` runs and
    generates fresh `comments.xml` + `commentsExtended.xml`. Each
    comment gets an allocated `w14:paraId`; replies get a
    `paraIdParent` pointing at their parent's paraId.
  - **`fromDocxFull`** (new) returns `{ doc, threads }` for the
    editor. `fromDocx` keeps its `Promise<PMNode>` signature so
    existing tests / CLI / benchmarks aren't disturbed.
  - **`toDocx(doc, opts?)`** now accepts `{ threads }`. Without
    threads the exporter strips brackets and emits no comment
    parts — that's what "Save As → Include comments: off" does.
  - **Content_Types + rels** automatically picks up the
    `comments` and `commentsExtended` overrides via the new
    `Docx.addContentTypeOverrides` helper.

### UI

  - **Ribbon panel "Comments"** (new vertical stack right of view
    ops): `💬` toggles the side column, `+` adds a comment to the
    selection. Two new ribbon commands (`toggleCommentsVisible`,
    `addCommentToSelection`) are registered so users can bind keys
    via the keybinding editor.
  - **Right-side comment column** (`src/editor/comments-ui.ts`):
    flex-sibling of `#editor` in `#app`. Hidden by default;
    `commentsVisible` setting persists the user's last choice. Each
    thread renders as a card — author + initials badge + date
    header, body text, replies indented below, reply textarea at
    the bottom. AI comments (later round) get a purple badge and
    `kind` tag.
  - **First-comment flow**: clicking + on a selection creates an
    empty-root thread, opens the column, and focuses an input.
    First submit edits the root's text in place (via the new
    `edit-text` plugin action) rather than creating a reply.

### AI groundwork

No AI logic ships in this round. The pieces are pre-wired so
round 2 can drop in without breaking the import/export shape:

  - `Comment.kind: 'human' | 'ai'` field exists today; importer
    sets `'human'` for everything from docx; AI flows can stamp
    `'ai'` on threads they create. Round-trip drops `kind` (Word
    doesn't model it) — fine for now.
  - New settings: `commentAuthor` / `commentAuthorInitials`
    (display name for new comments), `anthropicApiKey` (stored
    locally, password input), `aiFeaturesEnabled` (master switch).
    All exposed in the settings dialog.
  - The user's AI design is documented in PROJECT.md: select
    text → keyboard shortcut → opens a comment input where the
    user types their question → submit routes to Anthropic with
    selection + surrounding card context → AI replies as the
    root comment. Replies that `@AI` mention the assistant re-
    invoke it with the thread as context.

## 2026-05-13: Save As — inclusion checkboxes + Read Mode export

The Save As dialog gains four checkboxes governing what survives
into the exported docx:

  - **Include comments** — placeholder; no-op until comments import
    lands (planned next step). Kept in the UI so the dialog shape
    doesn't shift between releases.
  - **Include analytics** — when unchecked, doc-level
    `analytic_unit`s drop wholesale and in-card `analytic` children
    drop. The owning card survives unless empty.
  - **Include undertags** — when unchecked, `undertag` nodes drop
    everywhere (doc-level, inside cards, inside analytic_units).
  - **Read mode** — mutually exclusive with the three above. Mirrors
    what the user sees with read mode enabled in the editor: keeps
    headings (pocket / hat / block) and structural tag / analytic
    paragraphs whole; filters `cite_paragraph` to text carrying
    `cite_mark`; filters `card_body` / `paragraph` / `undertag` to
    text carrying `highlight`; drops tables. Containers (card /
    analytic_unit) survive as long as at least one filtered child
    remains.

Mutual exclusion: ticking Read Mode unchecks + disables the three
include-* boxes; ticking any of them unticks Read Mode and re-
enables them. The result object's three include-* flags are forced
to `false` whenever Read Mode is on, so any downstream consumer
sees a self-consistent state.

Pipeline shape: a new `transformForExport(doc, opts)` in
`src/export/transform-for-export.ts` runs BEFORE `toDocx`. The
exporter itself stays option-agnostic — strip / filter logic lives
in one focused module that can grow as we add features.

Read-mode keep/hide rules deliberately mirror the runtime
`read-mode-plugin.ts` keep/hide rules AND the read-mode display CSS
in `style.css` so "save what you see" holds end-to-end:

  - **Doc level**: only pocket / hat / block / card / analytic_unit
    survive. Loose paragraphs / cite_paragraphs / card_bodies /
    undertags at doc level are `display: none` in read mode and so
    drop on export too.
  - **Inside a card / analytic_unit**: adjacent body paragraphs
    (`card_body`, `paragraph`) merge into a single flowing body —
    matching the read-mode CSS rule `.pmd-card > .pmd-card-body
    { display: contents }`. Block-level children (tag, analytic,
    cite_paragraph) flush the merge buffer first so their relative
    position is preserved.
  - **Undertags**: invisible in read mode CSS (not in the visible-
    children allowlist for either `.pmd-card` or `.pmd-analytic-
    unit`), so they drop wholesale. Tables likewise.
  - **Inline separator**: consecutive kept inlines get a synthesized
    space text node between them, matching the runtime CSS
    `.pmd-rm-keep::after { content: ' ' }` rule. We skip the
    separator when whitespace is already present on either side
    so the export doesn't get double-spaces.

The unit tests in `tests/export/transform-for-export.test.ts` lock
the parity branch by branch (merge across body chains, separator
insertion, cite-paragraph breaking the merge, undertag NOT
breaking it, etc.).

## 2026-05-13: In-app Save As dialog (replaces `window.prompt` fallback)

The export-button flow previously used `window.prompt` whenever the
File System Access API wasn't available, and had no entry point for
per-export options. Replaced with a Promise-based `openSaveAs` modal
(`src/editor/save-as-ui.ts`) that always runs first — Chromium users
still see the OS save dialog afterwards, with our chosen filename
pre-filled as `suggestedName`.

Shape:
  - Header with title + ✕ close button.
  - Body: filename input (defaults to the imported doc's name or
    `untitled.docx`; auto-appends `.docx` on confirm) plus an empty
    `.pmd-save-as-options` container that's hidden by `:empty` CSS.
    The container is the planned slot for the export options that
    prompted this rework (comments-anonymization toggle, page-break
    policy, etc.).
  - Footer: Cancel / Save buttons. Enter submits, Escape cancels,
    backdrop click cancels.

API: `openSaveAs(initialFilename) → Promise<SaveAsResult | null>`.
`null` means the user cancelled — caller bails. `SaveAsResult` is a
concrete interface (not `Record<string, unknown>`) so widening the
option set generates compile errors at every consumer.

## 2026-05-13: Paragraph spacing round-trip (rendering decoupled)

Every paragraph-like textblock now carries a `spacing:
Record<string, string> | null` attr that holds the OOXML
`<w:spacing>` attribute values verbatim. Importer captures every
attribute on `<w:spacing>` (before / after / line / lineRule /
beforeLines / afterLines / beforeAutospacing / afterAutospacing /
…); exporter re-emits them as `<w:spacing>` inside `<w:pPr>`.
Round-trip is byte-stable on a multiset-of-`(nodeType, attrs)`
basis across all real-doc fixtures.

Rendering deliberately ignores the stored spacing — per-type CSS
margins continue to govern the editor's visible paragraph rhythm,
matching the [[project-paragraph-spacing-planned]] design: the
stored value is data (for round-trip), the per-type setting is
presentation. Adding the per-type display-spacing setting in
settings/UI is a separate next step.

## 2026-05-13: Table / cell raw properties round-trip + track-changes accept-on-import

Two related import changes that widen OOXML fidelity without
requiring schema-level UI.

### Table / cell raw properties

`table` gains an opaque `rawTblPr: string | null` attr; `table_cell`
and `table_header` gain `rawTcPr: string | null`. Both hold serialized
OOXML fragments captured at import time.

  - `rawTblPr` captures the entire inner content of `<w:tblPr>`
    minus track-change records (`<w:tblPrChange>`). On export it
    replaces the default tblPr we'd otherwise generate — so
    `<w:tblBorders>`, custom `<w:tblStyle>`, shading, etc. round-trip
    byte-stable. New editor-created tables (rawTblPr null) still
    fall back to the default `TableGrid` / `<w:tblW>` / `<w:tblLook>`
    triple.

  - `rawTcPr` captures `<w:tcPr>` children minus the ones the
    exporter regenerates from structural attrs (`gridSpan`,
    `vMerge`, `tcW`) and track-change markers (`tcPrChange`,
    `cellIns`, `cellDel`, `cellMerge`). On export the captured
    fragment is appended after our structural bits inside the same
    `<w:tcPr>`, so `<w:tcBorders>`, `<w:shd>`, `<w:vAlign>`, etc. all
    survive untouched.

A new `serializeXmlNodes` helper in `src/ooxml/parse.ts` inverts
`parseXml` for the subset of OOXML we produce — preserves order,
attributes, and `#text` leaves. We hand-rolled this rather than
pulling in fast-xml-parser's XMLBuilder because the parser uses
`preserveOrder: true` and the builder's flag combinations under
that mode were a moving target.

No editor UI for editing these properties — explicit non-goal per
the user's request. Edit operations (split/merge cells, etc.)
preserve `rawTcPr` verbatim even when the structural change might
visually invalidate some borders; that's an accepted edge case for
the cheap round-trip win.

### Track changes — accept on import

The importer's `collectInlines` dispatch now handles the four OOXML
revision wrappers:

  - `<w:ins>` and `<w:moveTo>` → recurse, treating the inner runs
    as kept content.
  - `<w:del>` and `<w:moveFrom>` → no-op (entire wrapped run is
    dropped, including any `<w:delText>` content).

Paragraph- and run-level change records (`<w:pPrChange>`,
`<w:rPrChange>`) are silently ignored by existing pPr/rPr parsing
which already only extracts known properties. Table-level cell
revision markers (`<w:cellIns>`, `<w:cellDel>`, `<w:cellMerge>`,
`<w:tcPrChange>`, `<w:tblPrChange>`) are stripped from the captured
`rawTblPr` / `rawTcPr`, so accept-on-import is consistent everywhere.

On export we never emit revision elements — we only know about the
post-accept state, so there's nothing to write.

## 2026-05-13: Paragraph indent (Tab / Shift-Tab) + round-trip

Every node that serializes to `<w:p>` now carries an `indent` attr
holding the raw OOXML dxa value (1440 dxa = 1 inch = 96 CSS px).
`indentAttr` is centralized in `nodes.ts` and merged into all nine
paragraph-like textblocks (paragraph, pocket, hat, block, tag,
analytic, undertag, cite_paragraph, card_body). Default 0; rendered
as inline `padding-left: {dxa/15}px` so the editor's visible left
indent matches Word's layout.

Importer reads `<w:ind>` from `<w:pPr>`, preferring `w:left` and
falling back to `w:start` (RTL-aware). Negative or absent values
become 0. Exporter emits `<w:ind w:left="…"/>` whenever `indent > 0`.
Round-trip is byte-stable for the value — same multiset of
`(nodeType, dxa)` pairs after import → export → import.

New `src/editor/indent-keymap.ts`:
  - Tab: collapsed cursor inserts `\t`. Selection that fully covers
    the *content* of any paragraph (selection from contentStart to
    contentEnd inclusive) indents every paragraph the selection
    touches by one step (720 dxa = 0.5 inch). Partial-paragraph
    selection within a single paragraph falls through to default
    text-replace behavior.
  - Shift-Tab: decrements indent on every touched paragraph that
    has indent > 0; defers (no-op) otherwise. Works on the cursor's
    own paragraph for the collapsed case.

Registered as a keymap plugin AFTER `tableEditing()` so cell-Tab
navigation inside tables runs first; outside tables the indent
handler takes over.

## 2026-05-13: Tables inside cards and analytic_units

The schema now allows `table` as a child of `card` and `analytic_unit`
alongside the existing `card_body | undertag | cite_paragraph | analytic`
alternation. (`card`'s content still starts with `tag` — the first-
child constraint is preserved.) Tables can now be evidence-embedded
rather than always sitting between cards.

`insertTable()` was a doc-level-only insert (`$from.before(1)`); it
now walks up depths from the cursor outward, picking the innermost
container whose schema accepts a `table` child. doc / card /
analytic_unit accept; card_body and textblocks reject. The table
lands immediately before the cursor's ancestor at that depth — so
a cursor in a card_body produces a card-internal table just above
that body. When `canReplaceWith` returns false at every depth above
the cursor (e.g. cursor in a tag, the card's required-first-child
position) the walk decrements to the doc level and the table lands
outside the card.

OOXML round-trip is unaffected — `<w:tbl>` doesn't carry the
parent-context semantics our schema layer adds.

## 2026-05-13: Normal-formatting ribbon panel + Table dropdown

A new ribbon panel sits between the Doc / Card menu panel and the
doc-ops toggles. The panel hosts a `Table ▾` dropdown (same shape
as Doc / Card; opens via `openDocMenu` with the 10 table commands)
and a 3-cell row of small inline-mark toggles: superscript,
subscript, strikethrough. The Table section moved out of the Doc
menu — it now lives only in this dedicated dropdown. Bold / italic
intentionally do NOT get buttons here; their Mod-B / Mod-I shortcuts
are universal enough that surfacing a button would be redundant
clutter.

New ribbon command `toggleStrikethrough` rounds out the schema's
strikethrough mark — same `shadowAwareToggleMark` dispatch as bold
/ italic / super / sub. No default keybinding; users can bind via
the keybinding editor.

The small inline-mark buttons use plain line-height / text-align
centering rather than `display: inline-flex` so the native baseline
shift of `<sup>` / `<sub>` inside the labels survives. Flex alignment
collapsed the digits onto the cell center, hiding the super/subscript
visual cue.

## 2026-05-14: `content-visibility: auto` on cards + explicit-trigger width sync

`.pmd-card` / `.pmd-analytic-unit` / `.pmd-pocket` / `.pmd-hat` /
`.pmd-block` all use `content-visibility: auto` so the browser
skips layout for off-screen card subtrees. On long docs this is
the dominant per-keystroke savings — Layout cost in the user's
profile dropped substantially.

Skipped cards still need an intrinsic size for the scrollbar /
layout placeholder. Both axes use the `auto <length>` form, so
after a card has been rendered once the browser auto-remembers
its real size and reuses that on subsequent skips — visible cards
always re-render at their actual width when the layout changes,
and the remembered size gets refreshed naturally as the user
scrolls.

The `<length>` only matters for cards that have **never** been
on-screen. For width, a fixed pixel fallback would clip cards in
a narrow multi-pane slot, so we publish the editor's current
content-area width as `--pmd-card-intrinsic-width` and the cards'
`contain-intrinsic-width: auto var(...)` consumes it.
Measurement reads the ProseMirror element's `clientWidth` minus
its computed horizontal padding — `offsetWidth` on the outer
editor body included scrollbar gutter and didn't subtract PM's
1rem inner padding, which made the initial render a noticeable
~50px too wide.

The variable is updated by **explicit triggers, not a
ResizeObserver**. An earlier attempt with a ResizeObserver
deadlocked into a feedback loop: variable write → cards
re-layout at the new size → measured body width shifts by a
pixel → observer re-fires → ... Repeated attempts to break the
loop (rAF batching, same-value cache, switching from clientWidth
to `borderBoxSize.inlineSize`) all failed — the observed width
genuinely changed each iteration once the user clicked into the
editor, so the cache never gated. The fix was to drop the
observer entirely and update the variable on the events that
actually change the pane's available width:

- Single-doc (`editor/index.ts`): window resize + the global
  settings subscriber (covers nav-rail drag via `navWidth`, zoom,
  display-size changes).
- Multi-pane (`editor/multi-pane-shell.ts`): window resize, the
  settings subscriber (layout-mode toggle, nav drag), and every
  call to `refreshLayout` (which fires on slot push / close →
  active-count change).

Both sides coalesce trigger bursts into one rAF measurement so
multiple events landing in the same tick produce a single read.
A last-written-value cache short-circuits identical writes so
repeated sync calls from different triggers don't restamp the
CSS variable.

### Stopping the intrinsic-width propagation chain

After the observer was removed, a second symptom emerged: the
multi-pane editor would expand on window resize but never shrink
back. Specifically, the *entire editor surface* (not just the
cards) crept wider every time the user resized.

Root cause: `content-visibility: auto` cards publish a
`contain-intrinsic-width` for their skipped placeholder, and that
intrinsic-width is part of the parent ProseMirror element's
max-content. PM's max-content propagated up through
`.pmd-pane-editor` → `.pmd-pane-body` → `.pmd-pane` →
`.pmd-multi-row` → `.pmd-multi-shell` → `#app`. With `auto`
remembering enabled, skipped cards keep their **last rendered**
size — so when the window grew, cards re-rendered wider and the
chain inflated, but when the window shrank, off-screen cards
stayed wide and the chain never deflated.

Two CSS fixes broke the chain:

- **`contain: inline-size` on `.ProseMirror`** (the targeted fix):
  treats the PM box as inline-size-independent of its contents.
  PM is already `width: 100%` of its parent in practice, so this
  is purely about killing the upward propagation, not changing
  used width.
- **Explicit `min-width: 0` on `.pmd-multi-shell` and
  `.pmd-multi-row`**: these flex containers were missing it, so
  their default `min-width: auto` was a second path for
  min-content propagation. Belt and suspenders — the inline-size
  containment alone fixes the observed bug, but min-width:0 on the
  containers is correct hygiene given any descendant can publish
  an intrinsic size via containment.

### Drop-indicator rendering: visibility-gated via IntersectionObserver

`content-visibility: auto` introduced a third symptom: starting a
drag (text→nav pickup) froze the page for ~1s on a long doc, and
sometimes "click and hold without drag" appeared to do nothing.
Root cause: `EditorDragSurface.renderIndicators` walks every
heading in the doc and reads `offsetTop` to place a drop indicator
at each one's CSS top inside the host. With CV:auto skipping
off-screen subtrees, each `offsetTop` read on a descendant of a
skipped card forces the browser to materialize that subtree's
layout — and doing it N times in a tight loop costs the entire
doc's layout cost (or worse, if the materializations aren't
amortized).

Fix: render indicators ONLY for headings whose elements are
currently within (or near) the viewport. `EditorDragSurface` now
maintains an `IntersectionObserver` continuously, tracking which
`[data-id]` heading elements (and the doc's last child for the
doc-end indicator) are intersecting. The IO uses `root: null`
(viewport) and `rootMargin: '50%'` so a viewport-sized buffer of
indicators is rendered above and below the visible region —
indicators don't pop in as the user scrolls during a drag. A
`MutationObserver` (debounced via the idle scheduler) re-syncs
the observed-element set as PM transactions add or remove heading
nodes from the DOM.

`renderIndicators` now uses the IO-maintained `visibleHeadings`
set as a filter: walking `collectHeadings(doc)` is still O(headings)
but each iteration only does an `offsetTop` read for in-viewport
elements, which are already laid out — no CV:auto materialization
forced. On scroll during a drag, the IO callback re-runs
`renderIndicators` to refresh the visible-region indicator set.

Considered alternatives: (a) suppressing CV:auto for the duration
of the drag via a `:root.pmd-drag-active` class — works but still
forces a full-doc layout pass at drag start, which was the
"extremely slow" the user reported even after the freeze stopped;
(b) computing drop targets on-the-fly via `posAtCoords` and
rendering a single floating indicator — simplest, but loses the
"all drop targets visible at once" UX. Visibility-gated indicators
preserve the existing UX (still see indicators for every heading
in view) while avoiding the layout pass entirely.

### Follow-up: shaving the lingering pickup-entry delay

After the IO-based visibility gate, the freeze was gone but
pickup still took a beat to enter on a long doc. The user's
Performance recording (INP 425ms, processing duration 324ms)
showed the remaining cost was split between **both** drop-target
surfaces' `'begin'` subscribers — `renderIndicators` (editor)
and `renderDropIndicators` (nav-pane) — each iterating every
heading and calling `computeHeadingRange`. Bottom-up: 107ms in
`computeHeadingRange`'s call tree, 28ms in `collectCiteText`,
~80ms in forced layout from `offsetTop` reads.

Four cuts:

- `renderIndicators` reordered the heading walk so the visibility
  gate fires BEFORE any range computation, and replaced
  `computeHeadingRange` with a lightweight `headingInsertPos`. The
  full range computation for pocket / hat / block does a
  `nodesBetween(entry.pos + nodeSize, doc.content.size, ...)` walk
  to find the next equal-or-shallower heading — that walk is O(doc)
  in the worst case and was running for every heading in the doc
  before the visibility gate even got a chance to reject. Drop
  indicators only need each heading's *start* position, which is
  just `entry.pos` for pocket / hat / block and the resolved parent
  position for tag / analytic — no forward walk required.
- `headingInsertPos` lives in `editor/headings.ts` and is shared
  with `nav-panel.ts`. The nav-pane's `renderDropIndicators` was
  doing the same `computeHeadingRange` call per heading; replaced
  with the same helper. Both drop-target surfaces fire on every
  drag's `'begin'`, so this cut compounds across surfaces.
- `collectHeadings(doc, { skipCite: true })` — new opt-in that
  skips the per-tag `collectCiteText` descent. The editor surface
  doesn't read `entry.cite` at all (it's only displayed in the
  nav-pane's outline), so skipping the cite walk during
  drop-indicator placement saves ~30ms on a long doc. The nav-pane
  still uses the default (cite-enabled) form for its main
  outline render.
- Pickup-mode cursor CSS no longer uses the universal-descendant
  selector (`#editor.pmd-editor-pickup-mode *`), which was
  invalidating the cursor property on every element under the host
  (tens of thousands on a long doc) at class-toggle time. Cursor
  inherits in CSS, so setting it on `.ProseMirror` cascades to
  every text descendant without touching their individual style
  computations. Side note: the old selector keyed on `#editor`
  only, so the multi-pane host (`.pmd-pane-editor`) never showed
  the grab cursor at all — the `:is(#editor, .pmd-pane-editor)`
  rewrite fixes that too.
