# prosemirror-debate

A ProseMirror-based text editor for competitive debate, designed to
interoperate with **Advanced Verbatim** — the project owner's forked build
of [Verbatim](https://github.com/ashtarcommunications/verbatim), the de facto
Microsoft Word add-in used by US policy/LD/PF debaters.

## Objectives

1. **Edit Verbatim/Advanced-Verbatim documents** in a ProseMirror-based
   editor that ships as both a desktop app (primary, offline-first) and a
   web app (collaboration + accessibility for users without full
   desktop machines).
2. **Round-trip with full fidelity to Verbatim's semantics.** The
   fungibility goal: a user of our editor on a Verbatim-using team is a
   fully equal participant in the file ecosystem. Documents shipped from
   our editor are visually and semantically indistinguishable from
   Verbatim-produced docs to anyone receiving them. Aggressive cleanup of
   non-Verbatim cruft on import is fine; losing anything Verbatim or
   Advanced Verbatim treats as semantic is not.
3. **Replicate a useful subset of Verbatim's functionality** — and where
   possible, supersede it. Many of the user's existing companion tools
   (Block Search, Fast Debate Paste, AI cites/quals) exist to work around
   Word's limitations and naturally become editor features here.

## Repo layout

- `PROJECT.md` (this file) — project index and high-level orientation.
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — editor design decisions:
  schema shape, three-layer rendering model, multi-doc workspace, read
  mode, send-to-speech, search, transclusion, integration boundaries.
- [`NOTES-verbatim.md`](./NOTES-verbatim.md) — Verbatim's data model,
  style mechanics, real-world observations from working documents, and
  the round-trip contract specifics.
- [`NOTES-custom-macros.md`](./NOTES-custom-macros.md) — Advanced
  Verbatim's custom macros, effect-level. What features the editor
  needs to replicate (or supersede).
- `reference-docs/verbatim/` — upstream clone of stock Verbatim, read-only.
- `reference-docs/Debate.dotm` — the canonical Advanced Verbatim
  template. Source of truth for `Analytic` / `Undertag` style specs.
- `reference-docs/Custom-Verbatim-Styles-and-Macros/` — Advanced Verbatim
  custom macro `.txt` exports.
- `reference-docs/example docs/` — three real working documents from
  the project owner (one Aff, one DA, one CP). Used to sanity-check the
  schema and round-trip against actual practice rather than theory.

## Reading order for a new contributor

1. This file for orientation.
2. `ARCHITECTURE.md` for design decisions.
3. `NOTES-verbatim.md` for the docx data model.
4. `NOTES-custom-macros.md` for the bucket-3 feature inventory.

## Headline design decisions

These are the load-bearing choices. Full reasoning lives in the
referenced files.

- **Typed-tree schema with cards as real nodes** (not emergent from
  paragraph styles). Pocket > Hat > Block > Tag/Card is a real tree.
  Card-as-object operations (select, move, query, drag) fall out for
  free. — `ARCHITECTURE.md` §1.
- **Top-level is a sequence, Pocket is optional.** Real `.docx` files
  contain multiple "files" separated by empty Heading1s; some single
  "files" omit Heading1 entirely. The schema embraces this. —
  `ARCHITECTURE.md` §4.
- **Loose paragraphs are first-class.** Unstyled body text lives as a
  plain `paragraph` block at any position — no special "scratchpad"
  wrapping needed. Schema is permissive enough that messy regions
  (bridge text, "Patch Notes" notes, etc.) just look like sequences of
  headings and paragraphs. — `ARCHITECTURE.md` §4.
- **Three-layer rendering**: schema (structure) ↔ display config (per-user
  preferences, never touch docs) ↔ direct formatting (normal editing op,
  ships with the doc). Decouples "how I want to see Tags" from "how Tags
  render for everyone." — `ARCHITECTURE.md` §5.
- **Web + desktop with shared core.** Desktop is the tournament-day
  surface; web is for collaboration and accessibility. — `ARCHITECTURE.md`
  §6.
- **Multi-doc workspace is foundational, not retrofitted.** Required by
  send-to-speech, search results, drag-between-panes, transclusion.
  The three-slot workspace shell (compact + wide-scroll layouts, per-
  slot stacks, drag-copy between panes) is shipped. —
  `ARCHITECTURE.md` §7, [`SPEC-multi-pane.md`](./SPEC-multi-pane.md).
- **Editor UI surfaces** — pageless web-view as default, Word-style
  navigation panel for outline manipulation, faithful render fixtures
  for Pocket/Emphasis boxes. — `ARCHITECTURE.md` §8.
- **Read mode as a first-class peer to edit mode.** The reading surface
  at the podium matters as much as the editing surface; ironclad against
  accidental input. In multi-doc mode read mode is per-pane state, so
  one slot can be a read surface while others stay editable. —
  `ARCHITECTURE.md` §9.
- **Send-to-speech is the most architecturally demanding feature** and
  drives the workspace + read-mode + cross-doc-coordinator foundation.
  The backtick / Alt-backtick chord, NewSpeech, mark-as-speech, and a
  resolver interface for future multi-window are shipped. —
  `ARCHITECTURE.md` §10.
- **Round-trip is the dominant correctness criterion.** Schema, importer,
  and exporter are one tightly-coupled project. The Stylepox normalizer
  is genuinely separable (and the user already maintains a working
  version). — `ARCHITECTURE.md` §2-3.

## Open questions deliberately deferred

- Choice of desktop framework (Tauri vs Electron). Decide when desktop
  edition design firms up.
- File storage model for the web edition (File System Access API vs
  cloud-backed). Decide when web edition design firms up.
- Pilcrow round-trip strategy. Slot exists; can stub until a real doc
  with pilcrows shows up.
- Real-time collab (transclusion option 1) infrastructure. Defer to
  v2+; v1 ships option 3 (refresh on demand).

### Queued OOXML features

- **Numbered / bulleted lists** — `<w:numPr>` + `numbering.xml`. Held
  for now; common in real docs but a meaningful schema addition
  (new `bullet_list` / `ordered_list` / `list_item` nodes).
- **Per-type display-spacing setting** — paragraph spacing already
  round-trips through the schema's `spacing` attr; what's still
  pending is a settings-UI panel to override the visible rhythm per
  paragraph type (Pocket vs Hat vs Tag vs card_body, etc.). The
  stored OOXML values are data, the per-type setting is
  presentation. CSS hooks already exist in `style.css`; pattern-
  match the existing `--pmd-line-height` plumbing.

### AI features

The `aiFeaturesEnabled` setting gates a master toggle for every AI
call, plus `anthropicApiKey` (sent direct from the browser to
Anthropic — there's no server middleman) and `commentAuthor` for
attribution.

**Shipped today:**

- `aiAskAboutSelection` — Mod-Shift-Q on a selection POSTs the
  surrounding tag / analytic / cite-paragraph context plus the
  user's question, replies land as a `kind: 'ai'` comment in a
  fresh thread. `@AI` mentions inside an existing thread re-invoke
  the model with the thread + range as context.
- `aiCreateCite` — Mod-Shift-X on a selection formats it into a
  Verbatim-style citation, with `cite_mark` applied to the
  extracted tokens. Shows a purple "Thinking…" pill while in
  flight.
- **AI image features** — right-click any image and choose
  "Generate alt text from image" (writes a `[ALT TEXT: …]`
  paragraph below the image, using the user's omission-bracket
  style) or "Generate table from image" (extracts a real PM
  `table` node with bold/italic marks and merge attrs).

AI comments are visually distinguished (purple badge in the side
column). They round-trip via docx as regular comments; the `kind`
field is lost on export (Word has no concept).

### Explicit non-goals

The following OOXML features are out of scope; importer drops them,
exporter never emits them.

- **Section properties** — `<w:sectPr>` (margins, page size, columns).
  We don't model paginated layout.
- **Revision IDs** — `<w:rsid*>` on runs and paragraphs. Word-internal
  metadata, no semantic value.
- **Bookmarks beyond headings** — `<w:bookmarkStart>` / `<w:bookmarkEnd>`
  that don't carry our `pmd-heading-*` naming convention. We use
  bookmarks only as our stable heading-ID transport.
- **Footnotes / endnotes** — `<w:footnoteReference>` + `footnotes.xml`.
  Debate docs rarely use them; the cost of modeling footnote nodes
  outweighs the value.
