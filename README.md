<p align="center">
  <img src="./logo.png" alt="CardMirror" width="280" />
</p>

# CardMirror

CardMirror is a debate-evidence editor for high school and college
policy, Lincoln–Douglas, and public forum. If you're used to
**[Verbatim](https://github.com/ashtarcommunications/verbatim)** —
the Microsoft Word add-in most US debate teams use — CardMirror is
a from-scratch standalone replacement for the editor side of that
stack. Same Pocket / Hat / Block / Tag structure, same F-key
chords (F4 / F5 / F6 / F7 / F8 / F9 / F10 / F11), same
send-to-speech workflow, same Word-compatible `.docx` round-trip —
without needing Word installed at all.

CardMirror is a native editor — no Word, no macros, no add-in
surface. That keeps it fast on the multi-megabyte evidence files
Verbatim users live in, and it makes the same editor first-class
on Windows, macOS, and Linux (Word for macOS is meaningfully
rougher than Word for Windows, and there's no Word for Linux at
all — sidestepping Word sidesteps both gaps). The deeper
architectural payoff is search: because every doc is a structured
tree of cards, cites, and headings rather than a flat stream of
styled paragraphs, a future release will let you search your
entire evidence library by author, tag, or structural position
across every open doc — folded into the editor instead of run
through a separate tool like [Block Search](https://debate-decoded.ghost.io/blocksearch-making-large-files-usable/).

You can run CardMirror as a **desktop app** on Windows, macOS, or
Linux — the recommended path for tournament-day work — or as a
**web preview** in any modern browser, useful for trying things
out or working from a Chromebook / school machine where you can't
install desktop software.

**▶ Try the live web preview: <https://ant981228.github.io/cardmirror/>**

> **🚧 Status: alpha preview.** CardMirror is in active development.
> Expect rough edges, missing features, and occasional breakage.
> Keep a Verbatim copy of anything that matters until the editor
> proves itself on your workflow — not recommended for actual
> tournament-day use yet.
>
> **Desktop builds are unsigned.** Alpha builds aren't code-signed.
> On Windows the SmartScreen filter shows a "Windows protected your
> PC" dialog the first time you launch — click *More info* → *Run
> anyway*. On macOS Gatekeeper refuses to open the app on first
> launch ("can't be opened because Apple cannot check it for
> malicious software"); right-click the app in Finder, choose
> *Open*, then *Open* again in the confirmation dialog. Each is a
> one-time prompt per machine.

See [`CHANGELOG.md`](./CHANGELOG.md) for release notes;
[`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full design;
[`PROJECT.md`](./PROJECT.md) for project orientation.

## Install

Desktop builds live on the [Releases page](https://github.com/ant981228/cardmirror/releases).
Pick the file for your operating system, run the installer, and
launch CardMirror like any other app.

### macOS

1. Download the `.dmg` for your Mac:
   - **Apple Silicon (M1 / M2 / M3 / M4)**: `CardMirror-x.x.x-arm64.dmg`.
   - **Intel**: `CardMirror-x.x.x.dmg` (or `-x64.dmg`).
2. Open the `.dmg`, drag **CardMirror** to your Applications folder.
3. **First launch only.** Gatekeeper refuses to open unsigned apps.
   You'll see one of two messages depending on your macOS version:

   - **"can't be opened because Apple cannot check it for malicious
     software"** → Open Finder → Applications, **right-click** (or
     Control-click) **CardMirror** → **Open**. Click **Open** in the
     confirmation dialog. From then on, normal double-click works.

   - **"is damaged and can't be opened"** → macOS has hard-quarantined
     the app and the right-click workaround doesn't suffice. Open a
     terminal (Spotlight → "Terminal") and run:
     ```sh
     sudo xattr -cr /Applications/CardMirror.app
     ```
     You'll be asked for your password. After that, normal
     double-click works.

### Windows

1. Download `CardMirror Setup x.x.x.exe`.
2. Run the installer (Next → Install → Finish).
3. **First launch only.** SmartScreen shows "Windows protected your
   PC." Click **More info** → **Run anyway**.

### Linux

Two options for any distro:

- **AppImage** (works on every modern distro): download
  `cardmirror-x.x.x.AppImage`. In a terminal, in the download
  folder, run:
  ```sh
  chmod +x cardmirror-x.x.x.AppImage
  ./cardmirror-x.x.x.AppImage
  ```
  Or double-click after `chmod +x` if your file manager supports
  launching AppImages.

- **Arch / Manjaro** — use the AUR:
  ```sh
  yay -S cardmirror-bin
  # or with paru: paru -S cardmirror-bin
  ```
  Or grab `cardmirror-x.x.x.pacman` from the release directly and:
  ```sh
  sudo pacman -U cardmirror-x.x.x.pacman
  ```

### Updates

**Help → Check for Updates…** triggers a manual check that
resolves to one of three dialogs: "You're on the latest version",
"Update available" (with a button to open the GitHub release page
so you can read what's in it; the actual download proceeds in the
background and a "restart now?" dialog fires when it finishes), or
"Couldn't check: \<reason\>" with the Releases URL as a fallback.

**Auto-check on launch is off by default**. Opt in via Settings →
General → "About this install" → **Check for updates on launch**.
When enabled, the first window of each app session does a silent
check at boot; if an update is found, the same "Update available"
dialog pops. Errors and "you're current" outcomes are silent on
the auto-launch path — no notifications when you're offline or
already up to date.

Linux users who installed via AUR can also update through `yay
-Syu`; both update paths work, pick whichever feels more natural.

## (Optional) Set up AI features

A few features call out to Anthropic's Claude API:

- AI-formatted citations from a pasted URL or freeform quote.
- AI image alt-text and table-from-image (right-click an image).
- AI commenting / explain features in the comments column.

To enable them:

1. Get an API key from
   [console.anthropic.com](https://console.anthropic.com/) (you'll
   need to top up a small amount of credit — Anthropic doesn't have
   a free tier for the API).
2. In CardMirror, click the ⚙ gear icon in the ribbon.
3. Toggle **AI features** on and paste your API key into the
   **Anthropic API key** field.

The key is stored locally on your machine and is sent directly to
Anthropic when you trigger an AI feature. It doesn't travel through
a third-party server.

## Run from source

You only need this if you want to **build CardMirror yourself**
(contribute, run a development branch, or use the editor on a
platform we don't publish binaries for). For day-to-day use,
download a release above.

### 1. Install Node.js

CardMirror is built with JavaScript / TypeScript and needs **Node.js**
to run. Node is a regular desktop installer.

- **macOS** — open [nodejs.org](https://nodejs.org/) in your browser
  and click the blue **"LTS"** download button. Open the `.pkg`
  file from Downloads and click through the installer.
- **Windows** — open [nodejs.org](https://nodejs.org/) and click the
  blue **"LTS"** download button. Open the `.msi` file from
  Downloads and click through the installer.
- **Linux** — the easiest path is the official installer at
  [nodejs.org/en/download](https://nodejs.org/en/download/) — pick
  your distro and follow the few commands it shows.

You don't need to verify the install — if the next step works, Node
is installed.

### 2. Download the source

1. Open
   [the CardMirror page on GitHub](https://github.com/ant981228/cardmirror)
   in your browser.
2. Click the **green `<> Code` button** near the top of the file list.
3. Click **"Download ZIP"** at the bottom of the dropdown.
4. Unzip the download. You'll get a folder called
   **`cardmirror-main`**. Move it somewhere you can find later —
   your Desktop or Documents is fine.
5. **Open the `cardmirror-main` folder and look inside.** Some
   unzippers double-wrap. You want the folder that directly
   contains `package.json`, `README.md`, `index.html`, and `src/`
   — if you only see another `cardmirror-main` folder, that's the
   wrapper; open it.

### 3. Open a terminal inside that folder

A "terminal" is a window where you type commands. You're going to
open one already pointing at the CardMirror folder.

- **macOS** — enable Finder → right-click → *Services → New
  Terminal at Folder* once via System Settings → Keyboard →
  Keyboard Shortcuts → Services → Files and Folders, then
  right-click the folder.
- **Windows** — open File Explorer in the folder, click the address
  bar, type `cmd`, press Enter.
- **Linux** — right-click inside the folder and pick *Open Terminal
  Here* (Nautilus / Dolphin / Thunar all offer it).

Sanity check: type `ls` (macOS / Linux) or `dir` (Windows) and
press Enter. You should see `package.json`, `README.md`, `src`,
`apps`. If you don't, your terminal is one folder too high up.

### 4. Install dependencies

```sh
npm install
```

Downloads everything CardMirror needs. Takes 30 seconds to a couple
of minutes. Deprecation warnings are normal; only red `error` lines
indicate trouble.

### 5. Run the web edition

```sh
npm run dev
```

After a few seconds, open `http://localhost:5173/` in your browser.

### Run the desktop edition (from source)

```sh
npm run desktop:dev
```

This builds the Electron main process, starts the Vite dev server,
and launches the desktop window. Same code, same renderer — but in
a native window with file-system access.

### Coming back later

Open a terminal in the same folder; run `npm run dev` (or
`npm run desktop:dev`) again. To pick up newer code, download a
fresh ZIP and rerun `npm install` in it.

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

The idea to use ProseMirror, as well as credit for dozens of course-corrections along the way, belongs to [text editor wizard Slim Lim](https://slim.computer/). 

If you're curious how ProseMirror works under the hood,
[Marijn's launch post](https://marijnhaverbeke.nl/blog/prosemirror-1.html)
is the best high-level introduction, and
[the ProseMirror docs](https://prosemirror.net/docs/) cover the
APIs in depth.

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
