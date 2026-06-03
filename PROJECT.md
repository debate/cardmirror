# CardMirror

A standalone editor for competitive debate evidence. It reads and writes
the same Microsoft Word `.docx` files that **[Verbatim](https://github.com/ashtarcommunications/verbatim)**
produces — the Word add-in most US policy, LD, and PF teams use — so a
CardMirror user on a Verbatim team is a full participant in the file
ecosystem, without needing Word installed.

The project owner runs a forked build, **Advanced Verbatim**; CardMirror
targets fidelity with both.

## Goals

1. **Edit Verbatim documents** in a fast native editor, shipped as a
   desktop app (the tournament-day driver) and a web app (collaboration
   and access from machines that can't install software).
2. **Round-trip with full fidelity.** Documents leaving CardMirror are
   visually and semantically indistinguishable from Verbatim's own
   output. Aggressively dropping non-Verbatim cruft on import is fine;
   losing anything Verbatim treats as meaningful is not.
3. **Replace the Verbatim toolchain, then go past it.** Many companion
   tools debaters rely on (Block Search, Fast Debate Paste, AI cite
   formatting) exist to work around Word's limits. In a purpose-built
   editor they become native features.

## Repository map

| Path | What it is |
|------|------------|
| `PROJECT.md` | This file — orientation and index. |
| `ARCHITECTURE.md` | The design: schema, round-trip contract, rendering model, editing rules, and the feature roadmap. |
| `README.md` | User-facing install and usage; build-from-source. |
| `MANUAL.md` | The full user manual — every feature in plain terms. |
| `CHANGELOG.md` | Release notes for users. |
| `DETAILED_CHANGELOG.md` | The same releases with implementation notes for contributors. |
| `src/` | The shared editor core — schema, importer/exporter, plugins, commands. |
| `apps/desktop/` | The Electron desktop shell. |
| `tests/`, `benchmarks/` | Round-trip and performance suites (point `CARDMIRROR_DOCS_DIR` at your own `.docx` fixtures). |

New contributor: read this file, then `ARCHITECTURE.md`.

## Status

CardMirror is an alpha. The schema, importer, exporter, editor, and
multi-doc workspace are built and used daily; the round-trip is the
project's dominant correctness criterion and is tested against real
`.docx` files.

**Shipped:** docx round-trip · the full Pocket/Hat/Block/Tag schema ·
the F-key formatting commands · cards, analytics, tables, and images ·
read mode · send-to-speech · drag-and-drop reordering · the three-slot
multi-doc workspace · command-palette file search and find/replace ·
spaced-repetition flashcards · AI cite/alt-text/table/comment features ·
autosave and crash recovery · desktop auto-update.

**Planned** (rationale in `ARCHITECTURE.md`): Verbatim Flow integration ·
a persistent corpus-wide search index · transclusion · real-time
collaboration · numbered/bulleted lists · per-type display-spacing ·
fuller screen-reader support and accessibility presets. The
remaining Verbatim cleanup macros (AutoNumberTags, ReformatAllCites,
ConvertToDefaultStyles, …) aren't planned, though several cleanup
commands already ship.

**Out of scope:** section/page layout, footnotes, revision-ID metadata,
non-heading bookmarks, localization. The importer drops these; the
exporter never emits them.
