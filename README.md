# prosemirror-debate

A ProseMirror-based editor that interoperates with **Advanced Verbatim**
(the project owner's fork of [Verbatim](https://github.com/ashtarcommunications/verbatim),
the de facto Microsoft Word add-in for US policy/LD/PF debate).

Project status: **active development.** Schema, lossless docx round-trip
(including tables, cell/table properties, indent, paragraph spacing,
hyperlinks via element + field-code forms, super/sub/strike, and more),
the editor UI ribbon (style hotkeys, color pickers, formatting panel,
Doc / Card / Table dropdown menus, keybinding editor, read mode,
shrink/condense pipeline, Select Similar Formatting, Fix Formatting
Gaps, Convert Analytics to Tags, Remove Hyperlinks), a nav-pane outline
with copy-drag, the multi-doc workspace (three configurable slots, with
compact and wide-scroll layouts), send-to-speech (backtick / Alt-`),
per-doc read mode, image insertion (paste + ribbon button), AI image
features (right-click an image for alt-text / table-from-image), and a
CLI for manual verification are all landed. Workspace search and
transclusion remain on the roadmap.

## Where to read

- [`PROJECT.md`](./PROJECT.md) — high-level orientation, headline design decisions.
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — full design: schema, multi-doc workspace, read mode, send-to-speech, integration boundaries.
- [`SPEC-multi-pane.md`](./SPEC-multi-pane.md) — multi-pane workspace spec (the design behind the implementation).
- [`NOTES-verbatim.md`](./NOTES-verbatim.md) — Verbatim's docx data model + real-world observations from the example docs.
- [`NOTES-custom-macros.md`](./NOTES-custom-macros.md) — Advanced Verbatim's custom macros, effect-level inventory.
- [`DECISIONS.md`](./DECISIONS.md) — append-only implementation decision log.

## Installing and running (first-time guide)

These steps assume you've never run code off GitHub before. They're
written for macOS, Windows, and Linux. The commands look the same on
all three; only the install steps differ.

### 1. Install Node.js

This project is a JavaScript / TypeScript app that needs Node.js
version **22 or newer** (we test on Node 24 LTS).

- **macOS** — download the **LTS** installer from
  [nodejs.org](https://nodejs.org/) and double-click it; or, if you
  have Homebrew, run `brew install node`.
- **Windows** — download the **LTS** installer from
  [nodejs.org](https://nodejs.org/) and click through it.
- **Linux** — your distro's package manager probably has an outdated
  Node. Use the official Node installer per
  [nodejs.org/en/download/package-manager](https://nodejs.org/en/download/package-manager)
  or, easier, install [`nvm`](https://github.com/nvm-sh/nvm) and run
  `nvm install --lts`.

Verify it worked. Open a terminal and run:

```sh
node --version
```

You should see something like `v22.x.x` or `v24.x.x`. If you see
`v20.x.x` or older, install a newer version before continuing.

### 2. Get the code

You have two options. The first (git) lets you pull future updates
with one command. The second (download zip) is simpler if you've
never used git.

**Option A — clone with git** (recommended):

If you don't have git installed, get it from
[git-scm.com](https://git-scm.com/) (mac/win) or your distro's
package manager (linux).

```sh
git clone https://github.com/ant981228/prosemirror-debate.git
cd prosemirror-debate
```

**Option B — download a zip**:

1. Open [the repo page on GitHub](https://github.com/ant981228/prosemirror-debate)
   in a browser.
2. Click the green **`<> Code`** button → **Download ZIP**.
3. Unzip it somewhere convenient (e.g. your Desktop).
4. Open a terminal in that folder. On macOS, right-click the
   folder in Finder → **Services** → **New Terminal at Folder**.
   On Windows, hold Shift and right-click inside the folder → **Open
   PowerShell window here** (or open a terminal and `cd` into it).

### 3. Install dependencies

In the project folder (the one with `package.json`), run:

```sh
npm install
```

This downloads everything the editor needs into a `node_modules/`
folder. Takes a minute or two the first time.

### 4. Start the editor

```sh
npm run dev
```

This starts the local dev server. You should see something like:

```
  VITE v...  ready in ... ms

  ➜  Local:   http://localhost:5173/
```

Open `http://localhost:5173/` in a browser. The editor loads with an
empty starter doc. Drag a `.docx` onto the page (or click the 📂 icon
in the ribbon) to open a real file.

### 5. (Optional) Set up AI features

A few features call out to Anthropic's Claude API:

- AI-formatted citations
- AI image alt-text and table-from-image (right-click an image)
- AI commenting / explain features

To enable them:

1. Get an API key from
   [console.anthropic.com](https://console.anthropic.com/) (you'll
   need to top up a small amount of credit — Anthropic doesn't have a
   free tier for the API).
2. In the editor, click the ⚙ gear icon in the ribbon.
3. Toggle **AI features** on and paste your API key into the
   **Anthropic API key** field.

The key is stored locally in your browser (in `localStorage`) and is
sent directly from your browser to Anthropic when you trigger an AI
feature. It never travels through a third-party server.

### Coming back later

Once you've installed everything, getting the editor running again
just takes one command from the project folder:

```sh
npm run dev
```

If you cloned with git, pull updates with:

```sh
git pull
npm install   # only needed if dependencies changed
npm run dev
```

## Other commands

```sh
npm test            # run all tests
npm run test:bench  # performance benchmarks
npm run typecheck   # strict TypeScript check
```

## Round-trip a docx

The CLI imports a Verbatim/Advanced-Verbatim docx, normalizes it through
our schema, and re-exports a fresh docx:

```sh
npm run round-trip path/to/input.docx [path/to/output.docx]
```

The output is fully native to Verbatim — same canonical style ids, same
direct-formatting conventions. Stylepox and other non-Verbatim cruft is
dropped on import (per [`ARCHITECTURE.md §3, §16`](./ARCHITECTURE.md)).

## Public API

```ts
import {
  schema,        // the ProseMirror schema
  fromDocx,      // .docx bytes → ProseMirror doc
  toDocx,        // ProseMirror doc → .docx bytes
  exportDoc,     // schema doc → { documentXml, relsXml }
  importDoc,     // document.xml → schema doc
  newHeadingId,  // generate a fresh stable heading UUID
} from 'prosemirror-debate';
```

### Example: read a docx, modify, write it back

```ts
import { fromDocx, toDocx } from 'prosemirror-debate';
import { readFile, writeFile } from 'node:fs/promises';

const buf = await readFile('input.docx');
const doc = await fromDocx(buf);

// `doc` is a ProseMirror Node — walk it, transform it, edit it...
console.log(`${doc.nodeSize} chars in tree`);

const out = await toDocx(doc);
await writeFile('output.docx', out);
```

### Schema highlights

```
doc:        sequence of block-level kinds
pocket:     Heading 1 paragraph (with stable id)
hat:        Heading 2 paragraph (with stable id)
block:      Heading 3 paragraph (with stable id)
card:       structured: tag (card_body | undertag | cite_paragraph | analytic | table)*
tag:        Heading 4 (only inside card)
cite_paragraph, card_body: body paragraphs inside cards
analytic:   outline-4 paragraph (Analytic style; can be standalone or in-card)
undertag:   Undertag-styled paragraph
paragraph:  unstyled body text (first-class — can sit between any nodes)
table:      table_row+ (at doc level OR inside a card / analytic_unit)
table_row:  (table_cell | table_header)+
table_cell: paragraph+
image:      inline atom (base64 bytes + EMU dimensions + alt; round-trips through .docx)
```

Every paragraph-like textblock carries round-trip-only attrs
`indent` (left indent in OOXML dxa) and `spacing` (verbatim
`<w:spacing>` map). Tables carry `rawTblPr` (table-level borders /
style / shading captured opaquely); cells carry `rawTcPr`
(per-cell borders, shading, vAlign).

Marks: `cite_mark`, `underline_mark`, `underline_direct`,
`emphasis_mark`, `undertag_mark`, `analytic_mark`, plus direct
formatting `bold`, `italic`, `strikethrough`, `superscript`,
`subscript`, `link`, `highlight`, `font_color`, `font_size`,
`shading`, `pilcrow_marker`, `font_family`, `comment_range`
(anchors a thread to a range of text).

See [`src/schema/`](./src/schema/) for full specs and
[`ARCHITECTURE.md §4`](./ARCHITECTURE.md) for design rationale.

## Round-trip fidelity

Verified on three real working docs from the project owner
(`reference-docs/example docs/`):

| File                          | Cards | Heading IDs | Highlights | Underlines | #555555 refs | #D2D2D2 shading |
|-------------------------------|------:|------------:|-----------:|-----------:|-------------:|----------------:|
| Aff - Merp! (1.8 MB)          |   362 |    preserved|     10,903 |     17,791 |        2,621 |             684 |
| DA - Reconciliation (1.0 MB)  |   321 |    preserved|     11,035 |     15,350 |          ≥1k |             411 |
| CP - Bifurcation PIC (252 KB) |    50 |    preserved|      1,481 |      1,807 |            0 |               0 |

All counts survive round-trip exactly. See `tests/round-trip/` for the
verifying tests.

## Performance baseline

(One-shot import + export on the example docs, taken from
`benchmarks/round-trip.bench.ts`. Single-threaded Node 24 LTS, x86_64 Linux.)

| File                                | Import   | Export   | Round-trip |
|-------------------------------------|---------:|---------:|-----------:|
| CP - Bifurcation PIC vs Fed Workers |    76 ms |    62 ms |     130 ms |
| DA - Reconciliation                 |   397 ms |   262 ms |     642 ms |
| Aff - Merp!                         |   528 ms |   304 ms |     826 ms |

Well within tolerable bounds for tournament-day use; further optimization
deferred until specific operations require it.

## License

(TBD — currently private.)
