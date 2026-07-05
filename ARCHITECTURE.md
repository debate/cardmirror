# Architecture

How CardMirror is built and why: the schema, the round-trip contract,
the rendering model, the editing rules at node boundaries, and the
roadmap. This is the design document for contributors. For per-command
behavior, read the code; for what shipped when, read
[`DETAILED_CHANGELOG.md`](./DETAILED_CHANGELOG.md).

---

## 1. Why ProseMirror

ProseMirror models a document as a *typed tree*: every node has a schema
`type`, optional `attrs`, ordered child `content` governed by a content
expression, and inline `marks`. Transactions that would violate the
schema are rejected by construction.

Debate documents are tree-shaped — Pocket > Hat > Block > Tag/Card is a
real hierarchy, not just visual indentation. Modeling a `card` as an
actual node (rather than deriving its boundaries from a run of paragraph
styles, as Word does) means operations target it as an object: select,
move, duplicate, query. That is the leverage the whole editor is built
on.

ProseMirror gives us the tree, transactions, NodeViews, plugins, the
keymap, and history. Everything domain-specific — docx fidelity, debate
ergonomics, multi-doc coordination, read mode — is ours to build on top.

## 2. Project shape

```
[docx] → [Importer] → [Schema] ↔ [Editor]
                          ↓
                     [Exporter] → [docx]
```

Schema, importer, exporter, and editor are one tightly-coupled project.
The schema is shared infrastructure; importer and exporter are coupled
1:1 to it; the editor consumes it. Round-trip fidelity is a quality
property of the schema/importer/exporter triple, not a separable layer —
the schema must be designed against Verbatim's OOXML realities from the
start.

## 3. The round-trip contract

**A CardMirror user on a Verbatim team is a full participant in the file
ecosystem.** Files leaving CardMirror are visually and semantically
indistinguishable from Verbatim's own output, regardless of how the
sender configured their editor; files from Verbatim users round-trip
back through Verbatim cleanly.

- **Aggressive cleanup on import is fine.** Stylepox, abandoned custom
  styles, stray hyperlinks, font/spacing overrides — all fair to drop or
  normalize.
- **Verbatim semantics are preserved with full fidelity.** Anything
  Verbatim's macros key on — style names, document variables, run
  attributes — must survive. Every Advanced Verbatim effect we replicate
  must produce a doc a Verbatim teammate can reopen without noticing the
  seam.
- **Exports look native.** Style names, outline levels, and
  direct-formatting conventions match Verbatim's own.

We do **not** commit to byte equivalence — Word's docx isn't byte-stable
across saves anyway (rsids, timestamps). Semantic equivalence is the
contract.

### Native format (`.cmir`)

`.cmir` is the lossless native form: a JSON envelope (`format`,
`formatVersion`, the PM doc JSON, optional threads + `docId`) round-tripped
through `serializeNative` / `parseNative` (`native/index.ts`), the single
chokepoint every reader and writer funnels through (`docid.ts` is the one
direct-bytes bypass). The envelope is **gzip-compressed** (~10× smaller);
compression is a container concern, so `formatVersion` is unchanged. The
format is **self-describing by magic bytes** — legacy plaintext begins with
`{` (0x7B), gzip with 0x1F 0x8B — so `parseNative` sniffs two bytes and
inflates or passes through, and old uncompressed files keep opening with no
version flag. The codec is `fflate` (`native/codec.ts`), chosen because the
read/write path is synchronous and runs in the renderer + browser builds
where `node:zlib` is absent. Inflation happens only on open/dive, never on
the command-bar listing or repeated in-file search. (In alpha this shipped
one-shot — read + write together — plus a temporary Home-screen
bulk-compress tool to migrate existing libraries in place; §16-adjacent.)

## 4. Schema

Structural skeleton:

```
doc:           flat sequence of block-level kinds
pocket:        Heading 1  (inline content, stable id)
hat:           Heading 2  (inline content, stable id)
block:         Heading 3  (inline content, stable id)
card:          tag (card_body | undertag | cite_paragraph | analytic | table)*
analytic_unit: analytic (card_body | undertag | cite_paragraph | table)*
tag:           inline*   (only inside card)
analytic:      inline*   (inside analytic_unit, or a card's cite slot)
undertag:      inline*
cite_paragraph, card_body: body paragraphs (in cards/analytic_units or loose)
paragraph:     inline*   (unstyled body text — implicit Normal)
table:         table_row+ (at doc level or inside a card / analytic_unit)
table_row:     (table_cell | table_header)+
table_cell:    paragraph+
image:         inline atom (base64 bytes + EMU dimensions + alt)
```

Design decisions:

- **Top-level is a flat sequence, not a single root.** Real `.docx`
  files routinely pack several "files" into one document, separated by
  empty Heading 1 paragraphs (a DA shipped with its companion CP). The
  schema embraces this.
- **Heading nodes are flat, not containers.** Hierarchy is implicit in
  document order plus outline level. The nav panel walks the flat
  sequence and groups by level to derive the tree view.
- **Pocket is optional at root.** Some working docs have no Heading 1 at
  all; a doc can start with a Hat, Block, or plain paragraph.
- **Plain `paragraph` is first-class.** Unstyled body text can sit at any
  position. A messy region of loose paragraphs and headings *is* the
  natural shape — there's no special "scratchpad" wrapper. We do not
  auto-classify by heading title (e.g. "Patch Notes"); those conventions
  are personal, not community-wide.
- **Card content expressions are deliberately loose** (any body-slot
  type, any order, repeated) so edits can insert, drop, and re-classify
  children without hitting schema constraints mid-keystroke. The importer
  still produces conventional shapes; looseness is the runtime contract.

### Stable heading IDs

Every heading node (`pocket`/`hat`/`block`/`tag`/`analytic`) carries a
UUID `id`, assigned on creation and preserved through edits. The nav
panel keys jump-to, collapse/expand, and the level filter off it, and
it's the anchor for intra-doc links and future transclusion.

IDs are reassigned on every path that brings content *in* — paste,
drag-copy, send-to-speech, import — so duplicating a section never
duplicates an id. The id serializes to `data-id` in our HTML but is
deliberately not read back by `parseDOM`, so clipboard/import content
arrives id-less and gets a fresh one. In docx it round-trips as a
bracketing `<w:bookmarkStart>`/`<w:bookmarkEnd>` pair — Word's native
mechanism for stable named locations, well tolerated by Verbatim.

### Per-paragraph round-trip attrs

Every node that serializes to `<w:p>` carries two attrs that survive
import → edit → export:

- **`indent`** — left indent in dxa (1440 = 1"). Tab / Shift-Tab adjust
  it by one 720-dxa step. Rendered as `padding-left`.
- **`spacing`** — the `<w:spacing>` map captured opaquely and re-emitted
  verbatim. Rendering ignores it; per-type CSS governs the editor's
  visible rhythm (see §5).

Tables carry the same kind of opacity: `table.rawTblPr` captures
`<w:tblPr>` (borders/style/shading) and `table_cell.rawTcPr` captures
per-cell `<w:tcPr>` extras, both minus structurally-regenerated bits and
track-change markers. The exporter re-emits them; there's no UI to edit
them.

### Marks

Named-style marks: `cite_mark`, `underline_mark`, `emphasis_mark`,
`undertag_mark`, `analytic_mark`. Direct-formatting marks: `bold`,
`bold_off`, `italic`, `strikethrough`, `superscript`, `subscript`,
`underline_direct`, `highlight(color)`, `shading(color)`, `font_color`,
`font_size`, `font_family`, `link(href)`. Plus `comment_range(threadId)`
and `pilcrow_marker`.

`bold_off` is the inverse of the structural-default bold: tags/headings
render bold via CSS, so un-bolding a word needs an explicit override (an
inline `font-weight: normal`, mutually exclusive with `bold`, round-tripping
to `<w:b w:val="0"/>`). Mod-B is context-aware — `bold_off` in a
bold-by-default block, `bold` in body — mirroring how `underline_direct` vs
`underline_mark` is chosen by context.

Two subtleties carry real weight for round-trip:

- **Underline is dual-encoded.** `underline_mark` is the named
  "Underline" character style (used in body slots); `underline_direct`
  is plain direct underline with no rStyle (used in structural slots:
  tag, analytic, pocket, hat, block, undertag). They look identical, but
  Verbatim keys on the distinction. A normalizer keeps the invariant:
  the named style never lands in a structural slot, the direct one never
  in a body slot.
- **`000000` font color renders as inherited.** Word stamps
  `w:color="000000"` on huge numbers of runs even when the user picked
  "Automatic". We import it faithfully but skip the inline
  `style="color:#000000"` on export to DOM, emitting only
  `data-color="000000"` — so dark mode and accessibility overrides aren't
  defeated by hardcoded black. Round-trip stays lossless (the exporter
  reads the attr directly).

### Comments

Each commented range carries `comment_range(threadId)` — on text or on an
image (an inline atom, which carries the mark on the node itself); thread
data (author / date / text / `kind` / `parentId`) lives in plugin state
keyed by threadId. Round-trips to `<w:commentRangeStart/End>` plus
`word/comments.xml` and `commentsExtended.xml`. AI comments are
identified by an `AI`-suffixed author so the signal survives docx
round-trip (Word strips the `kind` field).

### Track changes

Accepted on import: `<w:ins>`/`<w:moveTo>` runs are kept, `<w:del>`/
`<w:moveFrom>` dropped, `<w:pPrChange>`/`<w:rPrChange>` ignored. We don't
emit revision markup.

## 5. Three-layer rendering

Verbatim conflates content and display — styles live inside each docx, so
changing how Tags look means editing every file, and shipping a file
ships your display preferences. CardMirror separates three layers:

1. **Schema** — structural types only. Specifies no rendering.
2. **Display config** — per-user, per-machine. Maps each node and mark to
   render parameters (font, size, color, spacing, …). Stored as per-user
   JSON; never touches a document.
3. **Direct formatting** — a normal editing operation that overrides
   defaults on a specific run or paragraph. Ships with the doc.

On export, schema structure becomes canonical Verbatim style definitions,
direct formatting becomes run/paragraph properties, and display config is
never written. A user who wants a doc's tags to render a certain way *for
everyone* applies direct formatting — the same mechanism as overriding a
color in Word.

Accessibility presets (large text, high contrast, dyslexia-friendly
fonts) are just display config, so they never leak into exports either.

## 6. Platform: shared core, two editions

Both editions ship from one core. Anything not platform-specific lives in
the shared core; only the thin edges differ.

| Layer | Shared | Desktop | Web |
|-------|:---:|:---:|:---:|
| Schema, importer/exporter, commands, plugins, NodeViews | ✓ | | |
| File I/O | interface | local FS | File System Access API |
| Read-mode input lockdown | logic | OS-level | best-effort |
| Cross-app capture, auto-update | | ✓ | — |
| Card sharing, co-editing (server-backed) | | ✓ | — |

The desktop edition (Electron) is the tournament-day driver and primary
daily tool; it's fully offline. The web edition exists for access from
machines that can't install software, and is explicitly not for
tournament use. It is deliberately capability-limited: the web edition
has **no server-dependent features**. Both networked capabilities are
desktop-only — card sharing's crypto and keystore are Electron-main-only
(a browser tab has no keypair), and co-editing is hard-closed on a
browser host by construction (§18) — so a browser tab never opens a
network session.

## 7. Multi-doc workspace

Multi-doc is foundational, not a retrofit: send-to-speech, search
results, cross-pane drag, and (later) transclusion all reduce to "have N
docs open with cross-doc operations." Building the scaffolding from day
one avoided rebuilding the single-pane editor for each.

The shell is a three-slot workspace with two auto-switching layouts —
**compact** (stacked, narrow viewports) and **wide-scroll** (side-by-side
at a target width, the workspace scrolling horizontally past two slots).
Each slot owns its own doc stack (back / forward / close-and-restore), so
hopping to a related doc and back lands you exactly where you were.
**Mod-1 / Mod-2 / Mod-3** focus the slots.

Per-pane state that does *not* live on the doc — read mode, nav-panel
collapse, scroll position, paintbrush arming — is plugin state keyed by
`editorId`. So two slots can hold the same doc, one editing and one in
read mode at the podium, without conflict.

Cross-doc operations are coordinator code: ProseMirror transactions are
per-doc, but a coordinator applies paired transactions in two docs as one
user-visible action with a single undo step. Cross-pane copy (drag a card
or heading into another slot) and send-to-speech (§10) are the same
primitive with different pickup affordances; schema validation runs on
the destination either way.

## 8. Editor UI surfaces

**Pageless by default.** ProseMirror has no page concept, matching Word's
Web Layout — what we want for editing. Page breaks still round-trip:
`pageBreakBefore` (every Pocket has it) becomes a paragraph attribute and
hard `<w:br type="page"/>` becomes a `page_break` node rendered as a faint
divider. The editing surface ignores them; a future print/PDF export can
honor them.

**Navigation panel.** A side panel showing the heading hierarchy, like
Word's Navigation Pane, derived by walking the schema's heading nodes and
grouping by outline level. It provides jump-to, collapse/expand
(UI-only), drag-to-reorder, promote/demote (a type-change transaction),
and select/grab-subtree — covering Verbatim's `MoveUp`/`MoveDown`/
`SelectHeadingAndContent` macros as direct manipulation. Re-renders
incrementally on transactions that touch a heading.

**Render fixtures.** Some canonical Verbatim styles use Word features
with direct CSS analogues, shipped as the default display config: the
Pocket box (`<w:pBdr>` → CSS border on the block), the Emphasis box
(`<w:bdr>` → inline border), and centered/underlined Hat and Block
headings. On export these reference the canonical style block in
`styles.xml` rather than re-emitting borders per paragraph. Users can
override them in their own display config (per §5).

## 9. Read mode

Read mode is a view mode of the same editor, not a separate surface:
same schema, same doc, same NodeViews, with a CSS class toggling an
invisibility filter. It's the non-destructive equivalent of Verbatim's
`InvisibilityOn`, and it's **per-pane** (keyed by `editorId`) — one slot
can read at the podium while another edits.

It does three things:

- **Hides non-read-aloud content** via the read-aloud predicate (below),
  using `display:none`. Nothing is destructive; ProseMirror still renders
  everything.
- **Locks out editing input** so a stray keystroke or trackpad twitch at
  the podium can't change the doc. The editor stays `editable` (so the
  caret is placeable) but a `filterTransaction` rejects every doc change
  except the marker edit and its bounded undo/redo; selection and meta-only
  transactions pass.
- **Allows reading-position markers** — the one editing-shaped operation
  it permits. Space, Enter, or the bound shortcut insert visible colored
  text ("Marked 7:32") at the cursor, matching Verbatim's red-text
  convention; triggering it on an existing marker removes it (toggle). It's
  just styled text, so it survives the return to edit mode and round-trips
  trivially. Each marker is its own undo step, and read-mode undo/redo is
  bounded to markers placed since entry — it can't reach prior edits.

### Read-aloud predicate

> A paragraph in **Tag**, **Cite**, or **Analytic** style, OR text with
> **highlighting**, OR text in a paragraph that already passes.

This single predicate is the shared source of truth for read mode,
send-to-speech filtering, and read-time word counts.

## 10. Send-to-speech

Speech docs are ordinary saveable documents, not a special type. They
usually carry only partial hierarchy — enough block-level structure for
the speaker to navigate during delivery. The workflow:

1. From a source doc, send a Block (or drag its nav-panel heading) into
   the speech doc; the Block and its contents arrive as one unit.
2. The speaker reorders entries to set reading order.
3. The speaker types unstyled bridge text between cards — it rides as
   plain `paragraph` content.
4. At delivery, read mode hides the bridge text and non-highlighted
   material; what's left is the speech.

A "send" is a coordinator action (§7): insert the card into the speech
doc, optionally drop a marker at the source, present both as one undo
step. This is the same primitive as cross-pane drag. A scratch-speech
affordance skips save-flow friction for per-round speeches; canned
speeches save normally. It's the most demanding feature in the editor and
the reason the workspace + read-mode + coordinator foundation exists.

## 11. Search

Two scopes, two phases.

**File search (shipped).** The command palette's `f` prefix recurses the
configured search root for `.cmir` files by filename; Enter opens one,
Tab dives in to parse it and list its structural objects (blocks, tags,
cites, analytics) so you can search within it and insert a match as a
slice. The recursive *file listing* is cached in the main process with
per-file mtime + size and refreshed in the background; *content* search
is still parse-on-demand, one file at a time. Find/replace within the
open doc and the quick-card search palette round out what's shipped.

**Corpus search (planned).** The cached mtimes are the hook for an
eventual persistent on-disk index with a file watcher and schema-aware
queries across the whole library ("all cites by author Y", "all cards
under hat X") — superseding the standalone Block Search tool. Staged this
way to find the performance ceiling before investing in full indexing.
The same search UI will double as the transclusion target picker (§14).

## 12. Editing semantics at node boundaries

The schema guarantees strong structure (a card has a required tag,
undertags belong to their tag, an analytic_unit roots an analytic). Word
enforces none of this — its model is "every paragraph is independent,
styles are labels." Most edits are unambiguous, but at node boundaries
Word's loose behavior and our typed schema disagree, and Word's behavior
is what users have muscle memory for. This section is the catalog of
those disagreements and the rule we pick for each. Where in doubt, we
prefer the user's likely intent over Word's literal behavior.

### Body-slot absorption (`absorb-plugin.ts`)

A body-slot node at doc level immediately after a `card` or
`analytic_unit` is absorbed into it: `paragraph` → `card_body`,
`cite_paragraph`/`undertag`/`card_body` preserved as-is. Undertags do
*not* end the absorption zone. To bound a run of loose body paragraphs
after a card, insert a heading or container. Legitimate bridge text
(heading → paragraph → tag, doc-start preface, paragraph between
sections) is left alone.

### Cite-paragraph classification (`cite-classifier-plugin.ts`)

A body textblock's *type* tracks its cite content. On every transaction:
a `card_body` or doc-level `paragraph` carrying any `cite_mark` is
promoted to `cite_paragraph`; a `cite_paragraph` with no `cite_mark` is
demoted back. This one bidirectional rule keeps pastes, splits, and F8
toggles consistent without per-operation logic, and the importer uses it
on load. `cite_paragraph` is admitted inside `analytic_unit` purely so
the classifier needn't special-case that container.

### Tag / analytic boundary rules

Pocket/Hat/Block use ProseMirror's defaults. Tag and analytic override
Backspace, Delete, and Enter (`tag-keymap.ts`, wired ahead of
`baseKeymap`). A paragraph counts as **blank** if its trimmed text is
empty.

- **Empty tag-only container** — Backspace at start or Delete at end
  deletes the whole container (replacing it with an empty paragraph if
  the doc would otherwise be empty).
- **Empty tag with surviving siblings** — drop the empty head and migrate
  the remaining children into the previous doc-level node (append if it's
  a card/analytic_unit, otherwise lift to doc level). An in-card analytic
  folds to card_body when merging into an analytic_unit.
- **Backspace at the start of a non-empty tag** — allowed only to delete
  a blank preceding paragraph; otherwise a no-op (refusing the default
  join that would merge body text into the heading).
- **Delete at the end of a non-empty tag** — allowed only when the next
  paragraph is also a tag, merging the two cards; otherwise a no-op.
- **Enter** — at the end of a tag, creates a `card_body`; mid-tag, splits
  into two cards; at the start, inserts an empty card before.
- **First/last body slot** — Backspace at the start of a card's first
  body, or Delete at the end of its last body, mirror the empty-head
  merge rules above rather than letting Word silently destroy structure.
  At the first body slot, an **empty** body is deleted outright (a blank
  line below the tag has nothing to collide, so Backspace removes it and
  drops the cursor at the tag's end); a non-empty body still no-ops.

## 13. Ribbon commands

Verbatim's ribbon commands are mostly text-manipulation transforms over
the schema, so reimplementing them is cheap and the payoff is parity —
users never bounce to Word. All commands route through a single
`RibbonCommandId` registry so the Keyboard-shortcuts settings panel can
rebind any of them through one surface. Per-command behavior lives in
`ribbon-commands.ts`; the keyboard reference (📖 in the app) is the
user-facing source of truth. The notable design points:

- **Structural hotkeys (F4–F7, Mod-F7, Mod-F8)** set Pocket / Hat /
  Block / Tag / Analytic / Undertag. Conversion handles every cursor
  position (in-place for doc-level textblocks, dissolve-wrapper for
  tag/analytic, split-card for in-card body slots) and preserves heading
  IDs across heading↔heading changes. Promotion strips direct formatting
  and named-style marks — the destination's typography defines the run's
  identity — except the same-tier tag↔analytic swap, which preserves it.
- **Mark commands (F8 cite, F9 underline, F10 emphasis, F11 highlight,
  Mod-F11 shading)** apply the corresponding mark and skip structural
  blocks where appropriate. Body text holds at most one of cite /
  underline / emphasis (enforced by schema `excludes` and the strip
  set). The `Alt-` variants (Alt-F10, Alt-F11) mark the first letter of
  each word, for acronyms.
- **F2 Paste Text** is armed-mode, not one-shot: browsers won't let a web
  app read the clipboard without a prompt, so F2 sets a flag that the
  next Ctrl/Cmd-V consumes, stripping marks.
- **F3 condense family** collapses whitespace and merges paragraphs, with
  three modes (paragraph integrity, pilcrows, or neither) and a
  `headingMode` governing how selections that touch structure behave.
  Pilcrows round-trip as a 6-pt ¶ run, Verbatim's canonical encoding.
- **Color panel** — split buttons for highlight, shading, and font color,
  each with a swatch picker and a Word-style paintbrush mode (arm on an
  empty selection, then drag-select to apply). Highlight supports the 15
  Word named colors; shading and font color take arbitrary hex, with a
  luminance-band attribute on the rendered span so CSS can force readable
  contrast.
- Shipped alongside: **F12** clear-to-Normal, **Mod-8** shrink,
  **Alt-F8** copy-previous-cite, plus table and image insertion.

**The cleanup family.** A few of Verbatim's cleanup commands are shipped —
Convert Analytics to Tags, Convert Cited Analytics to Tags, Fix
Formatting Gaps, Remove Hyperlinks, and Select Similar Formatting. The
rest (AutoNumberTags, DeNumberTags, ReformatAllCites, FixFakeTags,
ConvertToDefaultStyles, …) map cleanly to schema transforms but aren't
planned right now.

## 14. Images and AI

**Images** live as an inline `image` atom: base64 PNG/JPEG bytes, EMU
dimensions (round-tripped through `<wp:extent>`), and an `alt` attribute
(round-tripped through `<wp:docPr descr>`). Insert via the ribbon, paste
from the clipboard, or right-click for the AI actions and alt-text
editing.

**AI features** are all gated by the `aiFeaturesEnabled` setting plus a
user-provided Anthropic API key stored locally and POSTed directly to
Anthropic — no server middleman. Master toggle off hides every AI
surface. Shipped:

- **`aiCreateCite` (Mod-Shift-X)** formats a selection into a
  Verbatim-style citation with `cite_mark` on the extracted tokens.
- **`aiAskAboutSelection` (Mod-Shift-Q)** starts an AI comment thread
  with the surrounding card as context; `@AI` in a thread re-invokes it.
- **`aiGenerateAltText`** and **`aiGenerateTable`** (right-click an image)
  describe it as alt text or extract it into a real `table` node.
- **`repairText` (Mod-Shift-R)** fixes OCR/PDF extraction errors via a
  diff schema (`{fixes:[{find,replace}]}`, not a rewrite), located against
  a `\n`-separated flatten and applied in place; two `temperature:0` passes
  for recall, animated one-at-a-time, collapsed into a single undo
  (`collapseToSingleUndo`) since scattered cross-pass edits can't merge in
  PM history naturally (`repair-text.ts`, `repair-highlight-plugin.ts`).
- **`translate` (Mod-Shift-T)** translates the selection to the clipboard
  via a pluggable backend — MyMemory (keyless, with local `tinyld` source
  detection), Anthropic, or Google (`translate.ts`). NOT AI-gated:
  MyMemory works with AI features off. An optional `[TRANSLATION BY …]`
  marker is added to the clipboard and protected from Shrink.

All Anthropic calls resolve their model through `resolveAiModel()` (the
`aiModelOverride` setting when valid, else the single `DEFAULT_MODEL`
constant); a retired/unknown model surfaces a friendly `'model'`-kind
`AnthropicError` pointing the user at the override or an app update.

**Edit coordination.** Every AI op applies its edit *after* an async model
call, so the document can move between capturing a target position and
dispatching the edit — another AI op finishing, or the user typing.
`edit-coordinator.ts` resolves this with **leases**. A per-view plugin holds
each in-flight op's claimed region and remaps it through `tr.mapping` on
every transaction (the anchoring pattern §6 comments marks and the voice
plugin use). Two guarantees compose: edits *outside* a lease remap it, so the
op reads `lease.region()` (or a uniform `delta()`) at apply time instead of a
stale offset; edits *inside* a lease are blocked — `filterTransaction` (plus
a `coordinatorBlocks` pre-check in each shell's `dispatchTransaction` that
flashes the locked region) rejects any non-bypass transaction changing
content length inside a live lease, so an op's content plan stays valid while
nobody can retype under it. The op's own writes carry a bypass meta; because
leases remap, disjoint ops run concurrently while an overlapping `claimRegion`
is rejected (the caller toasts). Leases are view-only plugin state; the
bookkeeping transactions are meta-only and `markBypass` leaves `addToHistory`
alone, so an AI content edit stays a normal undo step. Every async
doc-mutating AI op (cite, text/format repair, image alt-text/table, and the
other in-flight editors) claims a lease for its request window and releases
it in a `finally`.

## 15. Accessibility and theming

Accessibility is a ground-floor requirement, served by the same display
layer as personal preferences (§5). The principle: **a hardcoded color
anywhere is a bug.** Every UI and document color is a CSS custom property
defined in one place; a palette swap is a change of variable values, not
a sweep through the CSS.

- **Theming** rides one attribute on the document root: `data-theme`
  swaps the color variables (light/dark/system), `data-icons` swaps the
  icon set (modern line icons vs. classic glyphs). Per-style color
  overrides flow through a single `displayColors` source of truth shared
  by the Appearance and Accessibility panels.
- **Icons** are line icons (Untitled UI) painted in `currentColor` via
  CSS `mask` over a data-URL SVG, generated by `scripts/gen-icons.mjs`,
  so the app ships self-contained and re-skins by attribute.
- **Alt text** is a schema attribute with a dedicated edit dialog, never
  hidden behind an advanced menu.
- **Headings render as `<h1>`–`<h4>`** for screen readers.

A colorblind palette shipped 2026-07: the **Color-vision friendly
palette** setting drives a `data-cvd` attribute on the document root
(the same pattern as `data-theme` / `data-icons` / `data-motion`),
gating Okabe–Ito token blocks in style.css that compose with either
theme; explicit per-token user overrides still win. Deferred but
anticipated by the wiring: high-contrast palettes, a dyslexia-font
preset library, and a document accessibility checker (flagging empty
alt, low-contrast slots, out-of-order headings).

## 16. Tournament reliability

The desktop edition is the production surface for rounds:

- **Fully offline.** No network call fires during a round; AI features
  gray out cleanly when offline.
- **Aggressive autosave + journaling**, so the editor survives a hard
  kill and offers crash recovery on next launch.
- **No surprise updates.** Auto-update is off by default; updates are a
  deliberate manual action.
- **Spell-check off by default** — a custom viewport-scoped checker
  (nspell over a bundled dictionary; only the on-screen text is checked,
  re-run after scroll/edit settles, so cost is bounded regardless of doc
  size). Off by default because debate evidence — author names, jargon,
  citations — trips a lot of false positives; opt-in, with right-click
  suggestions / add-to-dictionary / ignore.

## 17. Learn (spaced repetition)

Flashcards (and, later, Ask-AI threads) are a **per-user annotation layer
that never enters the document.** This is the load-bearing decision: a
debater shares `.docx` freely, so anything written into the file body or
its comment XML would leak private study material. The layer lives only
on the user's machine.

### Why this design (the evidence)

The shape of the feature follows the research on spaced repetition and
the "mnemonic medium" — principally Andy Matuschak and Michael Nielsen's
[Quantum Country](https://quantum.country), Nielsen's
[Augmenting Long-term Memory](https://augmentingcognition.com/ltm.html),
Matuschak's [Orbit](https://withorbit.com) and his
[evergreen notes](https://notes.andymatuschak.org). Debate evidence fits
that work's central claim well: spaced repetition pays for its overhead
most clearly on *platform knowledge* — foundational, largely declarative
material you build everything else on — and a debater's cards are exactly
that.

The strongest influence is **situated practice**. The recurring critique
of conventional systems (Anki, Quizlet) in this literature is that review
is disconnected from the work you actually care about, which starves the
emotional connection that keeps people reviewing at all; the mnemonic
medium's answer is to interleave prompts into the reading itself.
CardMirror takes that one step further into the editor — cards anchor to
the real evidence text and render beside it in the comments column, so
practice stays inside the file the debater already works in instead of a
separate app. The interleaving principle is well supported; the specific
beside-the-text placement is our extension of it.

Two interaction choices come from the same source. Deciding to remember
something should be a **lightweight, near-costless gesture**, so a card
is one action on a selection. And readers should **control their own
prompts** rather than inherit a fixed set — part of why the layer is
personal and local, not baked into the shared file.

**Scheduling** is deliberately simple: a binary remembered/forgotten
ladder in the style of Orbit, with forgotten cards retried later in the
same session. Quantum Country's data found in-session retry measurably
improves early accuracy; we adopt it on that empirical basis, noting the
literature itself flags that its fit with the classic spacing effect is
unsettled.

**Card types and AI drafting** follow the evidence's caveats rather than
its enthusiasms. We offer question-and-answer and cloze cards but lean
toward Q&A: the [prompt-writing literature](https://andymatuschak.org/prompts)
argues cloze tends toward shallow pattern-matching and weaker
understanding, while granting it's efficient and far better than no card
at all. And because writing good prompts is genuinely hard and
time-consuming — the main reason people stop — AI drafting matters:
current models produce usable prompts for declarative material when given
surrounding context and explicit guidance, but regress to surface-level
questions on more conceptual material, so AI output is a starting point
the user edits, not a finished card.

One honest gap: this literature is about long-term understanding and
retention, not competitive recall under time pressure. The
platform-knowledge and declarative-material fit is well grounded; the
"recall in a round" framing is our own extrapolation to debate.

### How it works

- **Storage.** `LearnStore` is a host-agnostic, unit-testable model with
  persistence injected (a whole-blob KV: a JSON file on desktop,
  `localStorage` on web). Review reads entirely from here — no file I/O.
- **Document identity.** Because cards live outside the file, each
  document carries a hidden `cmirDocId` (a top-level `.cmir` field; a
  custom document property in docx, verified to survive a Word
  open/edit/save). It's minted lazily on first annotation and backfilled
  on open/save.
- **Split identity.** Content + schedule are keyed by `cardId`; a card's
  *grounding* in a specific file is keyed by `(cardId, docId)`. So a card
  reviewed once counts once across every file it appears in, but breaking
  the text reference in one copy never touches the schedule.
- **Anchoring.** A Hypothesis-style descriptor (exact quote + context
  window + approximate position) re-resolves against an edited document,
  disambiguating duplicates by context then nearest position. Images join
  the same scheme: each flattens to a sentinel (object-replacement char +
  a content fingerprint), so an image — or a selection mixing text and
  images — anchors by content exactly like text. An anchor that can't
  resolve becomes "unanchored" and is re-groundable — and a broken anchor
  never affects the card's schedule or file association.
- **Scheduling.** A pure binary interval ladder (no ease factor;
  FSRS-ready fields reserved), graded Orbit-style — a forgotten card
  relearns and is retried later in the same session.
- **In context.** Anchored cards render in the comments column. The
  in-document highlight is a view-only decoration (`learn-highlight-
  plugin.ts`), never a `comment_range` mark, so a card's grounding cannot
  leak into a shared file by construction.

## 18. Collaboration sessions (co-editing) — early preview

**Status: early preview. Dormant by default, desktop-only, and gated
behind a developer-console flag; it may break.** Co-editing ships in the
build but is unreachable without deliberately opening the gate — there
is no user-facing setting yet. Treat this section as documenting a
feature under active field-testing, not a finished subsystem.

**Gating and reach.** `collab-gate.ts`'s `collabEnabled()` is the single
chokepoint every co-editing surface consults (ribbon commands, the
Send/Receive pills, the home-screen Sessions list, the session flows).
It hard-closes on a **browser host** before reading any flag, so the web
edition categorically has no co-editing (see §6); on desktop it stays
closed unless a build sets `VITE_COLLAB=1` or a developer flips
`localStorage['pmd-collab']='1'`. Flipping it on for a real release is a
code change here — an env var can't reach a packaged app — the same
posture as the pairing entitlement flag.

**CRDT core.** The shared document is a Loro CRDT (`loro-crdt` +
`loro-prosemirror`), chosen over Yjs in a recorded bake-off because Yjs
lost highlight-comment spans on concurrent merges where Loro's Peritext
marks preserved them. The ProseMirror doc binds to the Loro doc through
`LoroSyncPlugin`/`LoroUndoPlugin`; the schema's inclusive-vs-exclusive
mark rules map to Loro's mark `expand` behavior via `configTextStyle`.

**Transport: rooms relay.** Peers exchange encrypted CRDT updates
through a small "rooms" service (the same relay that carries card
sharing, currently served from the scouting backend). The wire contract
is six endpoints — create room, post/get updates, post snapshot, post
presence, stream (SSE) — with per-update and per-room size caps and a
7-day GC. **Everything is end-to-end encrypted**: the relay only ever
stores and forwards ciphertext (X25519 sealed-box room keys carried in
the share code), and by policy never logs or inspects update bodies.
Server-side gating (`RELAY_GATING`) rides the same `_authorize`
entitlement seam as card sharing, so turning co-editing auth on is a
pure env flip; a subscription lapse blocks *starting* new sessions but a
3-day grace keeps live sessions working.

**Sync discipline (why it survives a tournament network).** The session
layer (`collab-session.ts`) is built for connectivity that comes and
goes: a durable send queue holds updates across outages and posts them
exactly once on recovery; `lastSentVersion`/`ackedVersion` frontiers
gate flushes so nothing is sent twice or dropped; oversized payloads
ship as cap-sized update chunks (no snapshot detour); and a **delivery
cursor advances only from server-confirmed catch-up pages, never from a
pushed stream frame** — a shed or duplicated frame can't create a
permanent gap. A periodic catch-up, a self-echo watchdog (restart the
stream when your own posts stop echoing), and a room-history audit
(re-post everything this replica holds if compaction dropped it)
together recover a stuck peer with no human intervention. Two desync
studies (heavy-editing-under-chaos, then surgical network-disruption)
drove this to convergence across every tested pathology.

**Editor plugin stack** (assembled only after the gate opens):
`LoroSyncPlugin` + `LoroUndoPlugin` for the CRDT binding; a transaction
tagger that stamps sync-origin so read mode still admits a partner's
remote edits; `collabInvariantHealPlugin` and `collabRepairPlugin`
(prosemirror-tables `fixTables`, a schema-derived exclusive-marks sweep
run on *every* peer, and a container first-child invariant, structural
parts leader-gated); comment-thread sync; and presence cursors with
partner name flags and an AI-lease marker. The marks sweep uses a total
priority order (cite > emphasis > underline) so a concurrent
underline-vs-emphasis merge can never leave a schema-illegal run.

## 19. Roadmap and non-goals

### Planned

- **Verbatim Flow integration** — CardMirror's take on Verbatim's
  Excel-based flowing tool.
- **Corpus-wide search index** (§11) — the persistent on-disk layer above
  the shipped on-demand file search.
- **Transclusion.** A `transclusion_ref` node `{source_path,
  source_heading_id, content_hash, cached_content, last_refreshed}`,
  picked through the search UI (§11) and identified by the target's
  stable heading id (§4) so it survives renames. v1 is refresh-on-demand
  (render the cache, manual refresh, staleness indicator, no backend);
  v2+ adds push-based live cards over a sync layer without changing the
  schema. Producer-side back-references live in a workspace-scoped
  sidecar index (never in the source doc, so they survive Verbatim
  cleanup and don't mutate a doc just because someone transcluded from
  it). Cycles are rejected at the picker. **On export, each reference
  freezes to a snapshot** — the docx is plain, native content with no
  transclusion identity, so re-import returns plain content unless the
  user re-transcludes.
- **Numbered / bulleted lists** — `<w:numPr>` + `numbering.xml`; a real
  schema addition (`bullet_list` / `ordered_list` / `list_item`).
- **Per-type display-spacing setting.** Paragraph spacing already
  round-trips via the `spacing` attr; what's pending is a settings panel
  to override the *visible* rhythm per paragraph type. The CSS hooks
  exist; the stored OOXML values stay data, the per-type setting is
  presentation.
- **Real-time collaboration.** Shared editing now exists as a dormant,
  desktop-only **early preview** (§18) — not yet a shipped, user-facing
  feature. What remains for GA: a real on-switch (retiring the console
  gate), the entitlement/gating flip, and broader field-hardening.
  Live **transclusion v2** over the same sync layer is still deferred.
- **Fuller screen-reader support and accessibility presets** (§15) —
  complete keyboard/ARIA semantics, high-contrast and colorblind palettes,
  and a document accessibility checker, on top of the per-user
  customization already shipped.

### Out of scope

The importer drops these and the exporter never emits them:

- **Section properties** (`<w:sectPr>`: margins, page size, columns) — we
  don't model paginated layout.
- **Revision IDs** (`<w:rsid*>`) — Word-internal, no semantic value.
- **Non-heading bookmarks** — we use bookmarks only as our stable
  heading-ID transport.
- **Footnotes / endnotes** — rare in debate docs; not worth modeling.
- **Localization** beyond English, schema migration/versioning (while the
  user base is small, breaking changes are recoverable by hand), and
  file-version history (undo + autosave suffice for v1).
