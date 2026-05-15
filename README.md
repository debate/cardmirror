# CardMirror

A ProseMirror-based editor that interoperates with **Advanced Verbatim**
(the project owner's fork of [Verbatim](https://github.com/ashtarcommunications/verbatim),
the de facto Microsoft Word add-in for US policy/LD/PF debate).

## Where to read

- [`PROJECT.md`](./PROJECT.md) — high-level orientation, headline design decisions.
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — full design: schema, multi-doc workspace, read mode, send-to-speech, integration boundaries.
- [`NOTES-verbatim.md`](./NOTES-verbatim.md) — Verbatim's docx data model + real-world observations from the example docs.
- [`NOTES-custom-macros.md`](./NOTES-custom-macros.md) — Advanced Verbatim's custom macros, effect-level inventory.
- [`DECISIONS.md`](./DECISIONS.md) — append-only implementation decision log.

## Installing and running (first-time guide)

This guide assumes **no prior experience** with the command line,
GitHub, or any of the tooling. You'll do four things: install Node.js,
download the code, open a "terminal" inside the folder, and run two
commands.

### 1. Install Node.js

CardMirror is built with JavaScript / TypeScript and needs **Node.js**
to run. Node is a regular desktop installer.

- **macOS** — open [nodejs.org](https://nodejs.org/) in your browser
  and click the big green **"LTS"** download button. Open the `.pkg`
  file from Downloads and click through the installer (Continue,
  Continue, Agree, Install, enter your password if asked, Close).
- **Windows** — open [nodejs.org](https://nodejs.org/) and click the
  green **"LTS"** download button. Open the `.msi` file from
  Downloads and click through the installer (Next, accept the
  license, Next, Next, Install, Finish).
- **Linux** — the easiest path is the official installer at
  [nodejs.org/en/download](https://nodejs.org/en/download/) — pick
  your distro and follow the few commands it shows.

You don't need to verify the install — if the next step works, Node
is installed.

### 2. Download CardMirror

1. Open
   [the CardMirror page on GitHub](https://github.com/ant981228/cardmirror)
   in your browser.
2. Click the **green `<> Code` button** near the top of the file list
   (right side, above the file table).
3. In the dropdown that opens, click **"Download ZIP"** at the bottom.
4. A file called `cardmirror-main.zip` lands in your Downloads
   folder. Double-click it to unzip.
5. You'll get a folder called **`cardmirror-main`**. Move it
   somewhere you can find later — your **Desktop** is fine, or
   **Documents**. The exact location doesn't matter, only that you
   can get back to it.

### 3. Open a "terminal" inside that folder

A "terminal" is a window where you can type a command and the
computer runs it. You're going to open one *already pointed at the
CardMirror folder*, so you don't have to navigate anywhere.

- **macOS** —
  1. Open **System Settings** → **Keyboard** → **Keyboard
     Shortcuts…** → **Services** → **Files and Folders**.
  2. Tick the box next to **"New Terminal at Folder"** (this is a
     one-time setup; macOS hides it by default).
  3. Close Settings.
  4. Open **Finder** and navigate to the `cardmirror-main`
     folder you unzipped.
  5. **Right-click** (or Control-click) the folder itself — *not*
     double-click — and choose **Services → New Terminal at
     Folder**.
  6. A black or white **Terminal** window opens. The folder name
     should appear in its title bar.

- **Windows** —
  1. Open **File Explorer** and navigate into the
     `cardmirror-main` folder (so you can see `package.json`,
     `README.md`, etc. in the file list).
  2. Click the **address bar** at the top of the File Explorer window
     once so the path becomes editable.
  3. Type `cmd` and press **Enter**. A black **Command Prompt**
     window opens with the folder path on the prompt line. (Alternate
     route: hold **Shift**, right-click an empty area of the folder,
     and pick **"Open in Terminal"** or **"Open PowerShell window
     here"**.)

- **Linux** — most file managers (Nautilus / Dolphin / Thunar) have an
  **"Open Terminal Here"** entry in the right-click menu. Right-click
  inside the `cardmirror-main` folder and pick that. If your
  file manager doesn't offer it, open a terminal manually and type
  `cd ` (note the trailing space), then drag the folder from the
  file manager onto the terminal window — the path gets pasted in
  — then press **Enter**.

You should now have a terminal window open, "inside" the
CardMirror folder. The next two steps are just two commands you
type into that window.

### 4. Install CardMirror's pieces

In the terminal you just opened, **type** (or copy-paste) this and
press **Enter**:

```
npm install
```

This downloads everything CardMirror depends on into a `node_modules`
folder. It prints a lot of text. **Wait for the prompt to come back**
(usually 30 seconds to a couple of minutes). You're done with this
step when you can type into the terminal again.

It's normal to see warnings about deprecated packages — those don't
matter. If you see a red **`error`** line that stops the install,
make sure Node.js installed correctly in step 1.

### 5. Start CardMirror

In the same terminal window, type:

```
npm run dev
```

After a few seconds you'll see something like:

```
  VITE v...  ready in ... ms

  ➜  Local:   http://localhost:5173/
```

Open your browser, type `http://localhost:5173/` into the address
bar, and press Enter. **CardMirror loads.** You'll see an empty
starter doc. Drag a `.docx` file onto the page (or click the 📂 icon
in the ribbon) to open a real document.

**Leave the terminal window open while you use the editor.** Closing
the terminal stops CardMirror. To stop it intentionally, click the
terminal window and press **Ctrl-C**.

### 6. (Optional) Set up AI features

A few features call out to Anthropic's Claude API:

- AI-formatted citations
- AI image alt-text and table-from-image (right-click an image)
- AI commenting / explain features

To enable them:

1. Get an API key from
   [console.anthropic.com](https://console.anthropic.com/) (you'll
   need to top up a small amount of credit — Anthropic doesn't have
   a free tier for the API).
2. In CardMirror, click the ⚙ gear icon in the ribbon.
3. Toggle **AI features** on and paste your API key into the
   **Anthropic API key** field.

The key is stored locally in your browser (in `localStorage`) and is
sent directly from your browser to Anthropic when you trigger an AI
feature. It never travels through a third-party server.

### Coming back later

Open a terminal in the same folder (step 3 above), and type:

```
npm run dev
```

That's it — CardMirror starts again at `http://localhost:5173/`.

To grab a newer version of the code, download the ZIP again (step 2)
into a fresh folder, and run `npm install` then `npm run dev` in
that new folder.

## Other commands

These all run inside the terminal pointed at the CardMirror folder
(same setup as the install steps above):

```
npm test            # run all tests
npm run test:bench  # performance benchmarks
npm run typecheck   # strict TypeScript check
```

### Testing round-trip against your own .docx files

The round-trip test suite and the round-trip benchmark both walk a
folder of `.docx` fixtures and run universal preservation checks on
each one (text length, heading IDs, mark counts, indent / spacing
multisets, etc.). Point them at any folder by setting
`CARDMIRROR_DOCS_DIR`:

```
CARDMIRROR_DOCS_DIR="/path/to/your/docx/files" npm test
CARDMIRROR_DOCS_DIR="/path/to/your/docx/files" npm run test:bench
```

When the variable isn't set, the suite looks under
`reference-docs/example docs/` (the project owner's local corpus).
When that folder doesn't exist either — the default state on a fresh
clone — the file-dependent tests skip cleanly and the rest of the
suite still runs.

## Round-trip a docx

The CLI imports a Verbatim/Advanced-Verbatim docx, normalizes it through
our schema, and re-exports a fresh docx:

```sh
npm run round-trip path/to/input.docx [path/to/output.docx]
```

The output is fully native to Verbatim — same canonical style ids, same
direct-formatting conventions. Stylepox and other non-Verbatim cruft is
dropped on import (per [`ARCHITECTURE.md §3`](./ARCHITECTURE.md)).

## Public API

```ts
import {
  schema,        // the ProseMirror schema
  fromDocx,      // .docx bytes → ProseMirror doc
  toDocx,        // ProseMirror doc → .docx bytes
  exportDoc,     // schema doc → { documentXml, relsXml }
  importDoc,     // document.xml → schema doc
  newHeadingId,  // generate a fresh stable heading UUID
} from 'cardmirror';
```

### Example: read a docx, modify, write it back

```ts
import { fromDocx, toDocx } from 'cardmirror';
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

## Acknowledgements

CardMirror is built on [ProseMirror](https://prosemirror.net/), the
modular rich-text editor framework created and maintained by
[Marijn Haverbeke](https://marijnhaverbeke.nl/). Nearly every editor
primitive CardMirror leans on — the schema-validated transactions,
the typed-tree document model, NodeViews, plugin state, the keymap
and history modules — is ProseMirror's. The work in this repo is a
debate-domain editor *on top of* that substrate, not a reinvention
of it.

Thank you to Marijn and the ProseMirror community for the years of
careful library design that made this project tractable. If
ProseMirror has been useful to you too, Marijn's work is supported
directly at <https://marijnhaverbeke.nl/fund/>.

## License

CardMirror is licensed under the
[PolyForm Noncommercial License 1.0.0](./LICENSE). You can read,
fork, modify, and share the source for any noncommercial purpose
(personal use, hobby projects, debate-team and academic use,
research, government use, charitable / public-interest
organizations); commercial use requires a separate license. See
[`LICENSE`](./LICENSE) for the full terms.

Underlying dependencies (ProseMirror and friends) ship under their
own permissive licenses, preserved in `node_modules/`.
