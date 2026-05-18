# Changelog

User-facing release notes for CardMirror. Each entry lists the
behavior, features, or bug fixes a release brought; rationale and
internal refactors live in commit messages, not here.

## Unreleased

- New setting: **default file format for new docs**. Pick `.docx`
  (default — Word- / Verbatim-compatible) or `.cmir` (CardMirror's
  native format, enables autosave); the Save-As dialog defaults to
  that format for any doc that doesn't yet have an on-disk handle.
  Existing files on disk still re-save in whatever format they were
  opened from.
- New setting: **jump to doc top when read mode toggles**. Off by
  default (today's stay-put behavior). When on, toggling read mode
  in either direction scrolls to the top of the doc and places the
  cursor at the start.
- Zoom in / out / reset and the highlight / shading paint-mode
  toggles are now registered ribbon commands, so users can bind
  them to keys via Settings → Keybindings. Default bindings:
  `Mod-=` for zoom in, `Mod--` for zoom out; `zoomReset` and the
  paintbrush toggles ship unbound (`Mod-0` is a browser-level
  reset that Chromium won't always let the page intercept, so the
  status-bar reset button remains the discoverable affordance).
- Keyboard-shortcut command labels (Settings → Keybindings) now
  use consistent title casing across the board.
- The AI alt-text generator now ships surrounding context with the
  image — the enclosing card's tag and cite, plus the paragraphs
  immediately before and after the image — so descriptions reflect
  what the image is *doing* in the argument instead of generic
  "a chart with bars" captions.
- Shift-F3 (cycle case) now keeps the selection after each press,
  so the user can re-press to advance to the next case state
  (lower → UPPER → Title → lower) without re-selecting.
- Speech-doc designation now uses the same warm-gold accent in both
  single-window multi-window mode (the banner under the ribbon) and
  single-window multi-pane mode (the per-pane chip), so the "this
  is the speech doc" affordance reads the same regardless of window
  topology.
- Ribbon cleanup: the plain-paste toggle (`T`) is hidden on desktop
  (F2 reads the clipboard directly there — no armed state to show),
  and the autosave toggle (⏱) is hidden on the web edition
  (autosave requires an on-disk file handle, which the browser
  can't provide).

## 0.1.0-alpha.1 — 2026-05-16

First downloadable preview of CardMirror. **This is an alpha.**
Expect bugs, missing features, and occasional breakage. Don't use
it for tournament-day work yet; keep a Verbatim copy of anything
important.

What works:

- Open and save Microsoft Word `.docx` files. Round-trips against
  Verbatim-format docs.
- Native `.cmir` format for lossless save / restore (no Word
  conversion costs, autosave-eligible).
- Verbatim-parity editing model: Pocket / Hat / Block / Tag /
  Analytic / Undertag styles, F-key shortcuts, condense /
  uncondense / case-toggle, emphasis / underline / highlight,
  shrink, send-to-speech, paste-as-plain.
- Multi-doc workspace — pick between a three-pane single-window
  layout or one window per doc.
- Send-to-speech across windows in multi-window mode.
- Per-doc read mode and autosave.
- Crash-recovery journal — unsaved drafts come back on next
  launch.
- Word-style left navigation pane: outline view, multi-select,
  drag-reorder.

Not in this release (planned):

- Full-text and schema-aware search across open docs / the
  evidence library on disk.
- Transclusion (live-linked content from a source doc).
- Cross-window drag-and-drop. (Cross-pane drag within multi-pane
  mode works.)

Operational:

- **Crash dumps** are collected locally to disk only — never
  uploaded anywhere. If CardMirror crashes and you want to send
  a report, open *Help → Open Crash Dumps Folder* and attach
  the minidump to a GitHub issue.
- **Auto-update**: on launch, CardMirror checks GitHub Releases
  for a newer version and downloads it in the background. When
  one's ready, a dialog asks whether to restart now or install
  on next quit. *Help → Check for Updates…* triggers the same
  check on demand.

Platforms:

- **macOS** — `.dmg` for Intel (x64) and Apple Silicon (arm64).
- **Windows** — NSIS installer (`.exe`) for x64.
- **Linux** — `.AppImage` (distribution-agnostic) and `.pacman`
  (Arch-native; install with `sudo pacman -U file.pacman`) for
  x64.

Known gaps:

- Desktop builds are unsigned. First-launch warnings on
  Windows (SmartScreen) and macOS (Gatekeeper) require a
  right-click → Open. See README.
