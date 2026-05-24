/**
 * CardMirror desktop — Electron main process.
 *
 * Responsibilities:
 *   - Create and manage the BrowserWindow that hosts the renderer.
 *   - Drive native open/save dialogs and read/write files from disk
 *     in response to renderer IPC. (Renderer-side Host abstraction
 *     in `src/editor/host/electron-host.ts`.)
 *   - Define the native menu bar; menu picks dispatch to the
 *     renderer as `'menu-command'` events, where they get routed
 *     through the same ribbon-command registry as keyboard
 *     shortcuts and ribbon buttons.
 *
 * Phase 3 scope (this file's job): native file I/O + menus. Phase 4
 * (autosave) and Phase 5 (packaged builds) layer on top.
 */

import {
  app,
  BrowserWindow,
  Menu,
  MenuItemConstructorOptions,
  clipboard,
  crashReporter,
  dialog,
  ipcMain,
  shell,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const DEV_SERVER_URL = 'http://localhost:5173';

// macOS scroll-perf tuning. Belt-and-suspenders settings retained
// from the alpha.2 → alpha.3 perf investigation; the root cause
// was resolved by bumping Electron 33 → 42 (Chromium 130 → 148)
// rather than by any one of these switches, but each is cheap,
// well-understood, and worth keeping in place.
//
// `enable-zero-copy` lets the GPU upload raster tiles directly
// from main memory instead of double-buffering through the CPU —
// useful on Apple Silicon where the GPU shares system memory.
// `ignore-gpu-blocklist` overrides Chromium's conservative GPU
// blocklist so Apple Silicon devices that fall into a denied
// bucket still get full hardware acceleration.
// `enable-skia-graphite` opts into Chromium's newer Skia GPU
// backend (Dawn → Metal on macOS). On Chromium 148 (Electron 42)
// this is default-on for Apple platforms — the switch is now a
// no-op, but kept explicit to defend against any future default
// flip and to document the path we depend on.
//
// MUST run before `app.whenReady()` — Chromium reads switches at
// gpu-process startup.
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('enable-zero-copy');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-skia-graphite');
}

// Start collecting crash minidumps as early as possible. We do
// NOT upload them — `uploadToServer: false` keeps everything on
// disk in `app.getPath('crashDumps')`. Users who hit a crash can
// pull the dump from there manually and attach it to a bug report.
// No telemetry, no remote endpoint, no third-party SDK.
crashReporter.start({
  productName: 'CardMirror',
  companyName: 'CardMirror',
  submitURL: '',
  uploadToServer: false,
});

interface FileFilter {
  name: string;
  extensions: string[];
}

let mainWindow: BrowserWindow | null = null;

/** Optional initial-doc payload handed to a freshly-spawned window's
 *  renderer when it asks `host:get-initial-doc` at boot. Lets the
 *  spawning renderer pre-load a file into the new window without
 *  going through the file dialog again. Keyed by `BrowserWindow.id`. */
interface InitialDocPayload {
  filename: string;
  bytes: unknown; // arrives from renderer as Uint8Array / Buffer / ArrayBuffer
  handle: string | null;
  format: 'cmir' | 'docx' | null;
  uid: string | null;
  /** New Speech Document flow: spawned window self-marks the new
   *  doc as the speech doc after mounting. Optional / absent for
   *  normal Open + New spawns. */
  markAsSpeech?: boolean;
}
const pendingInitialDocs = new Map<number, InitialDocPayload>();

/** Window id of the first window of this app session. Set once on
 *  the first `createWindow` call and never updated. Used by the
 *  renderer's startup-recovery flow to gate the "offer to restore
 *  unsaved journals" UI: only the first window of a session should
 *  surface that UI — a subsequent spawned-blank window would
 *  otherwise offer to recover the docs the user already has open
 *  in the OTHER windows of this same session, which is confusing
 *  and useless. */
let firstWindowId: number | null = null;

/** A file path the OS asked us to open during the brief window
 *  between process start and `app.whenReady()`. macOS fires
 *  `open-file` very early (before whenReady) when the user
 *  double-clicks a registered .docx/.cmir, so we stash the
 *  path here and consume it inside the `whenReady` handler
 *  instead of dropping it on the floor. Cleared once consumed. */
let pendingLaunchFile: string | null = null;

/** Pick the first argv element that looks like one of our
 *  associated file types. Used for Windows / Linux launches —
 *  the OS passes the clicked file as a regular CLI argument
 *  rather than firing a dedicated event the way macOS does. */
function pickFileFromArgv(argv: readonly string[]): string | null {
  for (const a of argv) {
    if (typeof a !== 'string') continue;
    const lower = a.toLowerCase();
    if (lower.endsWith('.cmir') || lower.endsWith('.docx')) return a;
  }
  return null;
}

/** Read a file from disk and spawn a fresh window with it as
 *  the initial doc. Used by the OS-driven open paths (macOS
 *  `open-file`, Windows / Linux argv at launch or
 *  second-instance). Spawning a new window per externally-
 *  opened file mirrors VS Code / Word behavior — avoids
 *  fighting with whatever's loaded in the focused window. */
async function openExternalFile(filePath: string): Promise<void> {
  try {
    const buf = await fs.readFile(filePath);
    const name = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const format: 'cmir' | 'docx' | null =
      ext === '.cmir' ? 'cmir' : ext === '.docx' ? 'docx' : null;
    if (!format) return;
    createWindow({
      filename: name,
      bytes: new Uint8Array(buf),
      handle: filePath,
      format,
      uid: null,
    });
  } catch (err) {
    console.warn('Failed to open external file:', filePath, err);
  }
}

/** Per-window allow-list for the next `close` event. The window
 *  close interception forwards the close to the renderer for
 *  confirmation; once the renderer has decided the window should
 *  close (Save, Save As, or Discard all do this; Cancel does not)
 *  it calls `host:close-self`, which adds the window's id here so
 *  the resulting `close` event passes through without bouncing
 *  back to the renderer. Cleared whenever a window is gone. */
const skipCloseConfirm = new Set<number>();

function createWindow(initialDoc?: InitialDocPayload): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    // Explicit 0×0 minimum: Electron + Chromium will otherwise
    // advertise its own default minimum to the WM (which, on some
    // Linux compositors, sits at ~800×600 — exactly the old value
    // we used to set here). Pinning both to 0 advertises "no
    // minimum" so tiling WMs and split-screen layouts can shrink
    // the window arbitrarily; the renderer's CSS / JS handles
    // narrow-viewport degradation from there.
    minWidth: 0,
    minHeight: 0,
    title: 'CardMirror',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Chromium throttles JS / rAF in renderers whose windows are
      // partially occluded or out of focus — defensible on a 50-tab
      // browser, but here the user has typically one window with the
      // doc they're editing, and macOS aggressively backgrounds apps
      // that lose focus for even a moment (App Nap, occlusion
      // detection, etc.). Keep the renderer at full throttle so
      // scrolling / nav-pane interaction doesn't take an extra frame
      // when the window happens to be behind another.
      backgroundThrottling: false,
    },
  });

  // Stash the initial doc (if any) BEFORE loading the renderer so
  // the renderer's `host:get-initial-doc` call at boot finds it.
  if (initialDoc) {
    pendingInitialDocs.set(win.id, initialDoc);
  }

  // First window of the app session is the only one allowed to
  // surface the startup-recovery UI; subsequent windows report
  // false via `host:is-first-window` and skip the prompt.
  if (firstWindowId === null) {
    firstWindowId = win.id;
  }

  if (!app.isPackaged) {
    void win.loadURL(DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    // electron-builder packages the renderer's vite-build output
    // under `Resources/renderer/` via the `extraResources` block in
    // apps/desktop/package.json. `process.resourcesPath` resolves
    // to that Resources dir on every platform (Contents/Resources on
    // macOS, resources/ on Windows / Linux). Same code path for all
    // packaged builds.
    void win.loadFile(
      path.join(process.resourcesPath, 'renderer', 'index.html'),
    );
  }

  // Track the focused window so menu commands fire at the right
  // place when multiple windows exist.
  win.on('focus', () => {
    mainWindow = win;
  });
  // Intercept user-initiated close (X button, Cmd-W, etc.) so the
  // renderer can prompt for unsaved-doc handling. The renderer
  // responds by either calling `host:close-self` (which adds the
  // window's id to `skipCloseConfirm` so the resulting close
  // event passes through cleanly) or by doing nothing (Cancel).
  // Programmatic closes from elsewhere in this file go through
  // the same skip-set, so they aren't double-prompted.
  win.on('close', (e) => {
    if (skipCloseConfirm.has(win.id)) {
      skipCloseConfirm.delete(win.id);
      return;
    }
    if (win.webContents.isDestroyed()) {
      // Renderer is gone — nothing to ask. Let the close proceed.
      return;
    }
    e.preventDefault();
    win.webContents.send('host:close-request');
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
    pendingInitialDocs.delete(win.id);
    skipCloseConfirm.delete(win.id);
  });

  mainWindow = win;
  return win;
}

/** Find the BrowserWindow that owns the renderer making an IPC
 *  call. Falls back to the focused window when sender lookup fails
 *  (shouldn't, but be defensive). */
function ownerWindow(sender: Electron.WebContents): BrowserWindow | null {
  return (
    BrowserWindow.fromWebContents(sender) ??
    BrowserWindow.getFocusedWindow() ??
    mainWindow
  );
}

/** Convert IPC-transferred bytes (which can arrive as a plain
 *  Uint8Array view, a Node Buffer, or even a structured-cloned
 *  ArrayBuffer depending on Electron version) into a Buffer the
 *  fs API will accept. */
function bytesToBuffer(bytes: unknown): Buffer {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  throw new TypeError('Unsupported bytes payload — expected Uint8Array / ArrayBuffer / Buffer.');
}

// ─── IPC handlers ──────────────────────────────────────────────────

/** F2 (Paste Plain Text) on Electron: the renderer asks main for
 *  the clipboard's plain-text content and pastes it immediately
 *  (no Ctrl/Cmd+V required, no sticky toggle). Web edition keeps
 *  its arm-then-paste flow because navigator.clipboard.readText
 *  needs a per-press permission grant under Chromium's web policy. */
ipcMain.handle('host:clipboard-read-text', () => clipboard.readText());

/** Trigger an electron-updater check from the renderer. Mirrors
 *  the Help → Check for Updates… menu item so the same flow can
 *  be reached from Settings → General → "About this install".
 *  In dev (non-packaged) the menu shows a friendly note instead
 *  of running; the renderer path returns `'dev'` so the UI can
 *  do the same. */
ipcMain.handle('host:check-for-updates', async () => {
  if (!app.isPackaged) return { status: 'dev' };
  return new Promise<{ status: 'latest' | 'updating' | 'error'; message?: string }>((resolve) => {
    const offNotAvailable = (): void => {
      autoUpdater.removeListener('update-not-available', notAvailable);
      autoUpdater.removeListener('update-available', available);
      autoUpdater.removeListener('error', errored);
    };
    const notAvailable = (): void => { offNotAvailable(); resolve({ status: 'latest' }); };
    const available = (): void => { offNotAvailable(); resolve({ status: 'updating' }); };
    const errored = (err: Error): void => {
      offNotAvailable();
      resolve({ status: 'error', message: err.message });
    };
    autoUpdater.once('update-not-available', notAvailable);
    autoUpdater.once('update-available', available);
    autoUpdater.once('error', errored);
    autoUpdater.checkForUpdates().catch((err: unknown) => {
      offNotAvailable();
      resolve({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    });
  });
});

/** At-launch silent update check. Called by the renderer at boot
 *  iff `settings.checkForUpdatesOnLaunch` is enabled AND this is
 *  the first window of the app session (mirrors the recovery-UI
 *  gating — only the first window of a session offers the
 *  prompt). No-op in dev. Routes through the same `runUpdateCheck`
 *  as the manual path but with the "latest" and "error" dialogs
 *  suppressed; only "Update available" fires a dialog, which is
 *  the same modal the manual flow shows. */
ipcMain.handle('host:trigger-auto-update-check', async () => {
  runUpdateCheck({ alertOnLatest: false, alertOnError: false });
});

/** Open the OS file manager at the crash-dumps folder. Mirrors
 *  the Help → Open Crash Dumps Folder menu item. */
ipcMain.handle('host:open-crash-dumps', async () => {
  await shell.openPath(app.getPath('crashDumps'));
});

/** Open a URL in the user's default OS browser. Used by the
 *  hyperlink context menu's "Open Link" action — we route through
 *  the shell instead of `window.open` so the link lands in the
 *  user's real browser, not a new Electron BrowserWindow. */
ipcMain.handle('host:open-external', async (_event, url: string) => {
  // Defensive: only allow http(s) + mailto so a crafted file:// URL
  // can't pop a local viewer the user didn't expect.
  if (typeof url !== 'string') return;
  if (!/^(https?:|mailto:)/i.test(url)) return;
  await shell.openExternal(url);
});

ipcMain.handle(
  'host:pick-directory',
  async (event, opts?: { defaultPath?: string; title?: string }) => {
    const win = ownerWindow(event.sender);
    const result = await dialog.showOpenDialog(
      win ?? new BrowserWindow({ show: false }),
      {
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: opts?.defaultPath,
        title: opts?.title,
      },
    );
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0]!;
  },
);

ipcMain.handle('host:open-file', async (event, opts: { filters?: FileFilter[] }) => {
  const win = ownerWindow(event.sender);
  const result = await dialog.showOpenDialog(win ?? new BrowserWindow({ show: false }), {
    properties: ['openFile'],
    filters: opts?.filters?.length ? opts.filters : [],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0]!;
  const bytes = await fs.readFile(filePath);
  return {
    name: path.basename(filePath),
    bytes: new Uint8Array(bytes),
    handle: filePath,
  };
});

ipcMain.handle(
  'host:save-as',
  async (
    event,
    suggestedName: string,
    bytes: unknown,
    opts: { filters?: FileFilter[] },
  ) => {
    const win = ownerWindow(event.sender);
    const result = await dialog.showSaveDialog(win ?? new BrowserWindow({ show: false }), {
      defaultPath: suggestedName,
      filters: opts?.filters?.length ? opts.filters : [],
    });
    if (result.canceled || !result.filePath) return null;
    await fs.writeFile(result.filePath, bytesToBuffer(bytes));
    return {
      name: path.basename(result.filePath),
      handle: result.filePath,
    };
  },
);

ipcMain.handle('host:save-existing', async (_event, handle: string, bytes: unknown) => {
  if (typeof handle !== 'string' || handle.length === 0) {
    throw new Error('host:save-existing: handle must be a non-empty path string.');
  }
  await fs.writeFile(handle, bytesToBuffer(bytes));
});

// ─── Crash-recovery journals ───────────────────────────────────────
// Each open doc gets one journal file at
//   {userData}/journals/{uid}.cmir-journal
// containing a small JSON envelope plus the doc bytes as base64.
// Written debounced after every doc-changing edit; cleared on save
// or explicit close; scanned at startup so a crash gets surfaced
// to the user as a recovery offer.

interface JournalEntryIpc {
  uid: string;
  filename: string;
  handle: string | null;
  format: 'cmir' | 'docx' | null;
  savedAt: string;
  bytes: unknown;
}

function journalsDir(): string {
  return path.join(app.getPath('userData'), 'journals');
}

function journalPathFor(uid: string): string {
  // Sanitize uid → filename. UIDs are app-generated so they're
  // already safe (alphanumeric + dashes), but a strict filter
  // defends against future formats.
  const safe = uid.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(journalsDir(), `${safe}.cmir-journal`);
}

async function ensureJournalsDir(): Promise<void> {
  await fs.mkdir(journalsDir(), { recursive: true });
}

// Per-uid serialization tail. The renderer can dispatch two
// `host:write-journal` invokes for the same uid in quick
// succession (e.g. a debounced edit-driven write still in flight
// when the mode-switch path fires `journalAll`). Two raw
// `fs.writeFile` calls to the same path then race: the kernel
// extends the file to fit whichever write's tail comes second,
// producing a JSON-then-garbage file that the recovery reader
// throws out as corrupt. Chaining writes for a given uid onto
// the previous one's settle keeps the on-disk file always valid.
const journalWriteTails = new Map<string, Promise<void>>();

ipcMain.handle('host:write-journal', (_event, entry: JournalEntryIpc) => {
  if (!entry || typeof entry.uid !== 'string' || !entry.uid) {
    throw new Error('host:write-journal: entry.uid is required.');
  }
  const previous = journalWriteTails.get(entry.uid) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    await ensureJournalsDir();
    const buf = bytesToBuffer(entry.bytes);
    // Wrap the doc bytes in a small JSON envelope so the file is
    // self-describing. base64 the doc bytes (cmir JSON text → b64 →
    // ASCII string we can stick inside the outer JSON). Slight size
    // overhead but keeps the file fully readable / inspectable.
    const envelope = {
      uid: entry.uid,
      filename: entry.filename,
      handle: entry.handle,
      format: entry.format,
      savedAt: entry.savedAt,
      bytesB64: buf.toString('base64'),
    };
    // Atomic write: stage into a sibling .tmp file then rename
    // over the real path. fs.rename is atomic on POSIX, so a
    // crash mid-write can't leave a half-written real journal,
    // and a concurrent reader either sees the previous valid
    // file or the new one — never a torn mix.
    const finalPath = journalPathFor(entry.uid);
    const tmpPath = `${finalPath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(envelope));
    await fs.rename(tmpPath, finalPath);
  });
  journalWriteTails.set(entry.uid, next);
  // GC the chain entry when this write settles, so the map
  // doesn't grow forever across long sessions. Only clear if
  // we're still the tail — a later write may have already
  // chained onto us.
  void next.finally(() => {
    if (journalWriteTails.get(entry.uid) === next) {
      journalWriteTails.delete(entry.uid);
    }
  });
  return next;
});

ipcMain.handle('host:read-journals', async () => {
  let entries: string[];
  try {
    entries = await fs.readdir(journalsDir());
  } catch (err) {
    // Dir doesn't exist yet → no journals to read.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const results: JournalEntryIpc[] = [];
  for (const name of entries) {
    if (!name.endsWith('.cmir-journal')) continue;
    const fullPath = path.join(journalsDir(), name);
    try {
      const text = await fs.readFile(fullPath, 'utf8');
      const parsed = JSON.parse(text);
      if (typeof parsed?.uid !== 'string' || typeof parsed?.bytesB64 !== 'string') continue;
      results.push({
        uid: parsed.uid,
        filename: typeof parsed.filename === 'string' ? parsed.filename : 'Untitled',
        handle: typeof parsed.handle === 'string' ? parsed.handle : null,
        format: parsed.format === 'cmir' || parsed.format === 'docx' ? parsed.format : null,
        savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : new Date(0).toISOString(),
        bytes: new Uint8Array(Buffer.from(parsed.bytesB64, 'base64')),
      });
    } catch (err) {
      // Skip corrupt journal files rather than blocking startup.
      console.warn(`Skipping corrupt journal ${name}:`, err);
    }
  }
  return results;
});

ipcMain.handle('host:delete-journal', async (_event, uid: string) => {
  if (typeof uid !== 'string' || !uid) return;
  try {
    await fs.unlink(journalPathFor(uid));
  } catch (err) {
    // Already gone is fine.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
});

// ─── Multi-window: spawn + initial-doc handshake ──────────────────
// Renderers in "windows mode" (multiDocWorkspace = false on
// Electron) call `host:spawn-window` to open a new BrowserWindow,
// optionally with an initial doc already loaded. The freshly-
// spawned window's renderer calls `host:get-initial-doc` once at
// boot to retrieve the payload (or `null` if it was just opened
// blank). Main owns the pending-map keyed by window id.

ipcMain.handle('host:spawn-window', async (_event, payload: InitialDocPayload | null) => {
  // Defensive normalization of `payload.bytes` — IPC may have
  // transferred it as a Buffer / typed array. Store as-is; the
  // renderer will normalize at read time too.
  const newWin = createWindow(payload ?? undefined);
  // If the spawn carries an on-disk path, claim it for the new
  // window right away so a concurrent open in a third window
  // can't sneak in between spawn and the new window's mount.
  // The spawner doesn't claim in `runOpenFlow` for this path
  // (it isn't going to host the doc itself), so there's nothing
  // to transfer FROM — just claim for the new window directly.
  // (Stale-owner override handles the rare case where the path
  // was previously owned by a window that died without
  // releasing.)
  if (payload && typeof payload.handle === 'string' && payload.handle) {
    const norm = canonicalOpenPath(payload.handle);
    const prevOwner = openPathOwners.get(norm);
    if (prevOwner !== undefined && prevOwner !== newWin.id) {
      windowOpenPaths.get(prevOwner)?.delete(norm);
    }
    openPathOwners.set(norm, newWin.id);
    let set = windowOpenPaths.get(newWin.id);
    if (!set) {
      set = new Set();
      windowOpenPaths.set(newWin.id, set);
    }
    set.add(norm);
  }
});

ipcMain.handle('host:get-initial-doc', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  const payload = pendingInitialDocs.get(win.id);
  if (!payload) return null;
  pendingInitialDocs.delete(win.id);
  return payload;
});

ipcMain.handle('host:is-first-window', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  return win.id === firstWindowId;
});

// ─── Mode-switch: journal-and-close other windows ─────────────────
// When the user toggles `multiDocWorkspace` in window A, every
// OTHER open window needs to journal its current doc and close
// before A reloads — so the post-reload recovery flow can pick up
// every doc and restore them in the new layout. Each renderer
// listens for `'mode-switch:please-close'`; on receipt it journals
// the current doc and calls `host:close-self`. We wait for the
// `closed` event on each before resolving, with a generous timeout
// fallback so a hung renderer doesn't strand the originating window.

const MODE_SWITCH_CLOSE_TIMEOUT_MS = 10000;

ipcMain.handle('host:journal-and-close-other-windows', async (event) => {
  const sender = BrowserWindow.fromWebContents(event.sender);
  const others = BrowserWindow.getAllWindows().filter(
    (w) => w !== sender && !w.isDestroyed(),
  );
  await Promise.all(
    others.map(
      (w) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (!w.isDestroyed()) w.destroy();
            resolve();
          }, MODE_SWITCH_CLOSE_TIMEOUT_MS);
          w.once('closed', () => {
            clearTimeout(timer);
            resolve();
          });
          w.webContents.send('mode-switch:please-close');
        }),
    ),
  );
});

ipcMain.handle('host:close-self', async (event) => {
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (sender && !sender.isDestroyed()) {
    // Mark this window as "already confirmed" so the close event
    // about to fire passes through the interception without
    // bouncing back to the renderer.
    skipCloseConfirm.add(sender.id);
    sender.close();
  }
});

// ─── Speech-doc registry ──────────────────────────────────────────
// Cross-window state for "which open doc is the current send-to-
// speech destination." Tracked by uid so it survives windows
// coming and going (and so renderers, which can't share EditorView
// refs, can compare locally). Main also keeps a map of which docs
// live in which windows, so send-to-speech knows where to route
// the slice. Each renderer reports its own docs via host:doc-
// register / host:doc-unregister at mount / close.

interface SpeechRegistration {
  uid: string;
  windowId: number;
}
let speechRegistration: SpeechRegistration | null = null;
const docOwners = new Map<string, number>(); // uid → windowId
const windowDocs = new Map<number, Set<string>>(); // windowId → uid set

// ─── Cross-window duplicate-open guard ────────────────────────────
// Maps an open file's absolute path to the BrowserWindow.id that
// currently has it loaded. Renderers register a path after they
// finish loading a doc with an on-disk handle, and release it when
// the doc unmounts (close, replace, Save-As to a different path).
// At open-time, renderers query `host:open-path-claim` — if the
// path is already owned by ANOTHER window, main focuses that
// window and tells the caller to abort; otherwise the path is
// claimed for the caller. Window-close cleanup runs in the shared
// `browser-window-created → closed` listener below.
const openPathOwners = new Map<string, number>(); // canonical-path → windowId
const windowOpenPaths = new Map<number, Set<string>>(); // windowId → canonical-paths

/** Canonical form of `p` for use as a key in `openPathOwners`.
 *  `path.resolve` collapses `./` and `../`, expands the cwd for
 *  relative paths, and normalizes separators. Doesn't case-fold —
 *  Windows is technically case-insensitive but a same-case match
 *  is good enough for the duplicate-guard's purpose (the dialog
 *  always returns the same casing for a given file). */
function canonicalOpenPath(p: string): string {
  return path.resolve(p);
}

/** Broadcast the current speech state to every window's renderer.
 *  Renderers reflect it in their UI (speech-mark button, etc.). */
function broadcastSpeechState(): void {
  const payload = speechRegistration
    ? { uid: speechRegistration.uid }
    : { uid: null };
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('speech:changed', payload);
  }
}

/** Per-uid display info pushed by renderers. Lets the
 *  Select-Speech-Doc modal (and any future cross-window doc
 *  picker) show meaningful labels for each open doc without
 *  having to query each window individually. Filename can be
 *  null for unsaved docs. */
const docInfo: Map<string, { filename: string | null }> = new Map();

ipcMain.handle('host:doc-register', async (event, uid: string) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || typeof uid !== 'string' || !uid) return;
  docOwners.set(uid, win.id);
  let set = windowDocs.get(win.id);
  if (!set) {
    set = new Set();
    windowDocs.set(win.id, set);
  }
  set.add(uid);
});

ipcMain.handle('host:doc-unregister', async (event, uid: string) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || typeof uid !== 'string' || !uid) return;
  docOwners.delete(uid);
  docInfo.delete(uid);
  windowDocs.get(win.id)?.delete(uid);
  // If the speech doc just got unregistered, clear the global flag
  // and notify everyone.
  if (speechRegistration?.uid === uid) {
    speechRegistration = null;
    broadcastSpeechState();
  }
});

/** Renderer pushes a uid's display info (currently just filename;
 *  the type is open for future fields). Called on doc mount and
 *  whenever the filename changes (save, save-as, rename). */
ipcMain.handle(
  'host:doc-info-update',
  async (
    _event,
    payload: { uid: string; filename: string | null },
  ) => {
    if (!payload || typeof payload.uid !== 'string' || !payload.uid) return;
    docInfo.set(payload.uid, {
      filename: typeof payload.filename === 'string' ? payload.filename : null,
    });
  },
);

/** List every open doc across every window. The Select Speech Doc
 *  modal calls this to populate its row list. Stale entries
 *  (windowless uids) are filtered out so the modal never offers
 *  a target that no longer has a home. */
ipcMain.handle('host:list-docs', async (event) => {
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  const senderId = senderWin ? senderWin.id : -1;
  const focusedWin = BrowserWindow.getFocusedWindow();
  const focusedId = focusedWin ? focusedWin.id : -1;
  const out: Array<{
    uid: string;
    filename: string | null;
    windowId: number;
    windowTitle: string;
    isSpeech: boolean;
    isOwnWindow: boolean;
    isFocusedWindow: boolean;
  }> = [];
  for (const [uid, windowId] of docOwners.entries()) {
    const win = BrowserWindow.fromId(windowId);
    if (!win || win.isDestroyed()) continue;
    const info = docInfo.get(uid);
    out.push({
      uid,
      filename: info?.filename ?? null,
      windowId,
      windowTitle: win.getTitle(),
      isSpeech: speechRegistration?.uid === uid,
      isOwnWindow: windowId === senderId,
      isFocusedWindow: windowId === focusedId,
    });
  }
  return out;
});

// Pre-load duplicate-open check. Renderer calls this BEFORE
// loading a file from disk. If another window owns the path, we
// focus that window and tell the caller `takenByOther: true` so
// the caller can toast + abort. Otherwise `false` and the caller
// proceeds to mount the doc. This handler does NOT register —
// registration happens through `host:open-path-register` once
// the doc has actually mounted (the centralized
// `setCurrentDocHandle` helper in the renderer wires that up).
ipcMain.handle('host:open-path-check', async (event, p: string) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || typeof p !== 'string' || !p) return { takenByOther: false };
  const norm = canonicalOpenPath(p);
  const ownerId = openPathOwners.get(norm);
  if (ownerId === undefined || ownerId === win.id) return { takenByOther: false };
  const ownerWin = BrowserWindow.fromId(ownerId);
  if (!ownerWin || ownerWin.isDestroyed()) {
    // Stale entry — window died without releasing. Clean up so
    // the next caller can register fresh.
    openPathOwners.delete(norm);
    windowOpenPaths.get(ownerId)?.delete(norm);
    return { takenByOther: false };
  }
  if (ownerWin.isMinimized()) ownerWin.restore();
  ownerWin.focus();
  return { takenByOther: true };
});

// Register `p` as owned by the caller's window. Idempotent — if
// the caller already owns it, no-op. If another window owns it,
// we overwrite (the caller's pre-load check should have caught
// the conflict; this is best-effort for paths picked up via
// Save-As / recovery where no check happened).
ipcMain.handle('host:open-path-register', async (event, p: string) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || typeof p !== 'string' || !p) return;
  const norm = canonicalOpenPath(p);
  const prevOwner = openPathOwners.get(norm);
  if (prevOwner === win.id) return;
  if (prevOwner !== undefined) {
    windowOpenPaths.get(prevOwner)?.delete(norm);
  }
  openPathOwners.set(norm, win.id);
  let set = windowOpenPaths.get(win.id);
  if (!set) {
    set = new Set();
    windowOpenPaths.set(win.id, set);
  }
  set.add(norm);
});

// Release a previously-registered path. No-op if the caller
// doesn't own it (defensive — shouldn't happen in normal flow).
ipcMain.handle('host:open-path-release', async (event, p: string) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || typeof p !== 'string' || !p) return;
  const norm = canonicalOpenPath(p);
  if (openPathOwners.get(norm) !== win.id) return;
  openPathOwners.delete(norm);
  windowOpenPaths.get(win.id)?.delete(norm);
});

ipcMain.handle('host:speech-set', async (event, uid: string | null) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (uid === null) {
    speechRegistration = null;
    broadcastSpeechState();
    return;
  }
  if (typeof uid !== 'string' || !uid) return;
  speechRegistration = { uid, windowId: win.id };
  broadcastSpeechState();
});

ipcMain.handle('host:speech-get', async () => {
  return speechRegistration ? { uid: speechRegistration.uid } : { uid: null };
});

/** Route a send-to-speech slice to whatever window owns the speech
 *  doc. Returns the result of the routing — caller cares whether
 *  the slice actually got applied vs. there's no speech doc / the
 *  speech doc's window has gone away. */
ipcMain.handle(
  'host:speech-send-slice',
  async (
    event,
    payload: { sliceJson: unknown; atEnd: boolean },
  ) => {
    const sender = BrowserWindow.fromWebContents(event.sender);
    if (!speechRegistration) return { delivered: false, reason: 'no-speech-doc' };
    const targetWin = BrowserWindow.fromId(speechRegistration.windowId);
    if (!targetWin || targetWin.isDestroyed()) {
      // Speech-doc's window vanished — drop the registration.
      speechRegistration = null;
      broadcastSpeechState();
      return { delivered: false, reason: 'speech-window-gone' };
    }
    // Same-window: tell the sender to handle it locally (cheaper +
    // avoids a round-trip).
    if (sender && targetWin === sender) {
      return { delivered: false, reason: 'same-window' };
    }
    targetWin.webContents.send('speech:incoming-slice', {
      uid: speechRegistration.uid,
      sliceJson: payload.sliceJson,
      atEnd: payload.atEnd,
    });
    return { delivered: true };
  },
);

// Clean up registrations when windows die without unregistering
// (force-close, crash, etc.).
app.on('browser-window-created', (_event, win) => {
  win.on('closed', () => {
    const docs = windowDocs.get(win.id);
    if (docs) {
      for (const uid of docs) docOwners.delete(uid);
      windowDocs.delete(win.id);
    }
    if (speechRegistration?.windowId === win.id) {
      speechRegistration = null;
      broadcastSpeechState();
    }
    // Release every open-path claim the window held — if the
    // window closed without releasing (force-quit, crash, etc.)
    // we'd otherwise leave stale entries blocking future opens.
    const paths = windowOpenPaths.get(win.id);
    if (paths) {
      for (const p of paths) openPathOwners.delete(p);
      windowOpenPaths.delete(win.id);
    }
  });
});

// ─── Native menu bar ───────────────────────────────────────────────

/** Send a menu-command IPC event to the currently focused window. */
function dispatchMenuCommand(command: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (!win) return;
  win.webContents.send('menu-command', command);
}

/** Current renderer-reported keybinding for each menu-bound ribbon
 *  command, in PM keymap form (`Mod-o`, `CmdOrCtrl+Alt+N`, etc.).
 *  Renderer pushes this map via `host:set-menu-bindings` whenever
 *  `ribbonKeyOverrides` changes; main rebuilds the application
 *  menu so accelerators stay in sync with the user's overrides. */
let menuBindings: Record<string, string | null> = {};

/** PM-keymap string ("Mod-o", "Shift-Mod-s", "Ctrl-ArrowLeft") to
 *  Electron accelerator ("CmdOrCtrl+O", "Shift+CmdOrCtrl+S",
 *  "Ctrl+Left"). Returns undefined when `key` is empty or null. */
function pmKeyToAccelerator(key: string | null | undefined): string | undefined {
  if (!key) return undefined;
  const parts = key.split('-');
  const out: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    switch (part) {
      case 'Mod': out.push('CmdOrCtrl'); break;
      case 'ArrowLeft': out.push('Left'); break;
      case 'ArrowRight': out.push('Right'); break;
      case 'ArrowUp': out.push('Up'); break;
      case 'ArrowDown': out.push('Down'); break;
      default:
        out.push(part.length === 1 ? part.toUpperCase() : part);
    }
  }
  return out.join('+');
}

/** Look up the current keybinding for a menu-bound command and
 *  format it as an Electron accelerator. Returns undefined when no
 *  binding is set — the menu item still appears, just without an
 *  accelerator hint on the right side. */
function menuAccelerator(commandId: string): string | undefined {
  return pmKeyToAccelerator(menuBindings[commandId]);
}

function buildMenu(): Menu {
  const isMac = process.platform === 'darwin';

  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      {
        label: 'Open…',
        accelerator: menuAccelerator('openFile'),
        click: () => dispatchMenuCommand('openFile'),
      },
      {
        label: 'New Document',
        accelerator: menuAccelerator('newDocument'),
        click: () => dispatchMenuCommand('newDocument'),
      },
      { type: 'separator' },
      {
        label: 'Save',
        accelerator: menuAccelerator('save'),
        click: () => dispatchMenuCommand('save'),
      },
      {
        label: 'Save As…',
        accelerator: menuAccelerator('saveAs'),
        click: () => dispatchMenuCommand('saveAs'),
      },
      { type: 'separator' },
      {
        label: 'Toggle Autosave',
        accelerator: menuAccelerator('toggleAutosave'),
        click: () => dispatchMenuCommand('toggleAutosave'),
      },
      { type: 'separator' },
      {
        // Smart close: in multi-pane mode, closes the visible doc in
        // the focused slot rather than the entire window. Falls
        // through to closing the window when there's no visible
        // doc to close. Cmd+W on macOS, Ctrl+W on Windows/Linux —
        // captured as an explicit menu accelerator so it overrides
        // Chromium's default close-window behavior.
        label: 'Close',
        accelerator: menuAccelerator('closeDocOrWindow') ?? 'CmdOrCtrl+W',
        click: () => dispatchMenuCommand('closeDocOrWindow'),
      },
      ...(!isMac ? [{ role: 'quit' as const }] : []),
    ],
  };

  const speechMenu: MenuItemConstructorOptions = {
    label: 'Speech',
    submenu: [
      {
        label: 'New Speech Document',
        accelerator: menuAccelerator('newSpeechDocument'),
        click: () => dispatchMenuCommand('newSpeechDocument'),
      },
      {
        label: 'Mark / Unmark Active as Speech Doc',
        accelerator: menuAccelerator('markActiveAsSpeech'),
        click: () => dispatchMenuCommand('markActiveAsSpeech'),
      },
      { type: 'separator' },
      {
        label: 'Send to Speech (At Cursor)',
        accelerator: menuAccelerator('sendToSpeechAtCursor'),
        click: () => dispatchMenuCommand('sendToSpeechAtCursor'),
      },
      {
        label: 'Send to Speech (At End)',
        accelerator: menuAccelerator('sendToSpeechAtEnd'),
        click: () => dispatchMenuCommand('sendToSpeechAtEnd'),
      },
      { type: 'separator' },
      {
        label: 'Select Speech Doc…',
        accelerator: menuAccelerator('selectSpeechDoc'),
        click: () => dispatchMenuCommand('selectSpeechDoc'),
      },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      // Zoom items route through OUR ribbon commands (chromeScale)
      // rather than Electron's native zoomIn/zoomOut roles, so the
      // accelerator labels match the user's actual bindings and
      // re-using the chord doesn't hit Chromium's own zoom.
      {
        label: 'Reset Zoom',
        accelerator: menuAccelerator('chromeScaleReset'),
        click: () => dispatchMenuCommand('chromeScaleReset'),
      },
      {
        label: 'Zoom In',
        accelerator: menuAccelerator('chromeScaleUp'),
        click: () => dispatchMenuCommand('chromeScaleUp'),
      },
      {
        label: 'Zoom Out',
        accelerator: menuAccelerator('chromeScaleDown'),
        click: () => dispatchMenuCommand('chromeScaleDown'),
      },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };

  const helpMenu: MenuItemConstructorOptions = {
    label: 'Help',
    submenu: [
      {
        label: 'Settings…',
        accelerator: menuAccelerator('openSettings'),
        click: () => dispatchMenuCommand('openSettings'),
      },
      {
        label: 'Keyboard Shortcuts…',
        accelerator: menuAccelerator('openShortcutsReference'),
        click: () => dispatchMenuCommand('openShortcutsReference'),
      },
      { type: 'separator' },
      {
        label: 'Check for Updates…',
        click: runManualUpdateCheck,
      },
      {
        label: 'Open Crash Dumps Folder',
        click: () => {
          void shell.openPath(app.getPath('crashDumps'));
        },
      },
      {
        // GPU diagnostics for bug reports. `chrome://gpu` is
        // blocked in Electron renderers; this exposes the same
        // data via `app.getGPUFeatureStatus()` + `app.getGPUInfo()`
        // and copies it to the clipboard so users can paste it
        // into an issue.
        label: 'Copy GPU Info',
        click: () => {
          void (async () => {
            const feature = app.getGPUFeatureStatus();
            let info: unknown = null;
            try {
              info = await app.getGPUInfo('complete');
            } catch (err) {
              info = { error: String(err) };
            }
            const payload = JSON.stringify(
              {
                versions: process.versions,
                commandLineSwitches: process.argv.slice(1),
                gpuFeatureStatus: feature,
                gpuInfo: info,
              },
              null,
              2,
            );
            clipboard.writeText(payload);
            const win = BrowserWindow.getFocusedWindow();
            if (win) {
              void dialog.showMessageBox(win, {
                type: 'info',
                message: 'GPU info copied to clipboard.',
                detail: 'Paste it into the conversation.',
              });
            }
          })();
        },
      },
    ],
  };

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    fileMenu,
    speechMenu,
    // Custom Edit menu — Electron's `role: 'editMenu'` defaults
    // Redo to Cmd/Ctrl+Shift+Z; we prefer the traditional Cmd/Ctrl+Y
    // and let the renderer's keymap accept both chords so muscle
    // memory keeps working either way.
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const, accelerator: 'CmdOrCtrl+Z' },
        { role: 'redo' as const, accelerator: 'CmdOrCtrl+Y' },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        ...(isMac
          ? [{ role: 'pasteAndMatchStyle' as const }, { role: 'delete' as const }]
          : [{ role: 'delete' as const }]),
        { type: 'separator' as const },
        { role: 'selectAll' as const },
      ],
    },
    viewMenu,
    helpMenu,
  ];

  return Menu.buildFromTemplate(template);
}

/** Renderer-driven menu rebuild. Stores the new bindings map and
 *  re-installs the application menu so the user's current
 *  keybindings (after rebinds via Settings → Keybindings) show
 *  next to each menu item. Idempotent — safe to call on every
 *  settings change. */
ipcMain.handle(
  'host:set-menu-bindings',
  async (_event, bindings: Record<string, string | null>) => {
    if (!bindings || typeof bindings !== 'object') return;
    menuBindings = { ...bindings };
    Menu.setApplicationMenu(buildMenu());
  },
);

// ─── Auto-update ───────────────────────────────────────────────────
//
// electron-updater reads `app-update.yml` from inside the packaged
// app — electron-builder emits it as part of the release build with
// the GitHub Releases provider configured. In development (no
// `app.isPackaged`) the check is a no-op so we don't 404 against a
// missing config file. Failures are logged, never alerted.

/** Public GitHub Releases page — fallback link surfaced in update
 *  dialogs so users always have a manual-download path. */
const RELEASES_URL = 'https://github.com/ant981228/cardmirror/releases';

/** Best-effort dialog-parent lookup. Prefers the focused window,
 *  but if the user has alt-tabbed away between clicking
 *  "Check for Updates" and the response arriving, falls back to the
 *  first available window. Returns `null` only when no windows
 *  exist at all (effectively never for the manual-check path). */
function dialogParentWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
}

/** Re-entrancy guard. A single in-flight check guards the manual
 *  (Help menu) path AND the auto-launch IPC path so the two can't
 *  race and double-dialog if they happen to overlap. */
let updateCheckInFlight = false;

/** Show the "Update available" modal. Same content whether the
 *  check was manual or auto-launched — modal, parented to the
 *  current window, with an "Open release page" button that deep-
 *  links to the tag's GitHub Release in the user's browser via
 *  `shell.openExternal`. */
function showUpdateAvailableDialog(info: { version: string }): void {
  const win = dialogParentWindow();
  if (!win) return;
  void dialog
    .showMessageBox(win, {
      type: 'info',
      buttons: ['Open release page', 'Close'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update available',
      message: `CardMirror ${info.version} is available.`,
      detail:
        'Downloading in the background. When the download finishes you can restart to install, or quit normally and it will install on next launch.',
    })
    .then((result) => {
      if (result.response === 0) {
        void shell.openExternal(`${RELEASES_URL}/tag/v${info.version}`);
      }
    });
}

/** Options gating which outcomes produce a user-facing dialog. The
 *  manual (Help menu) check shows all three; the auto-launch check
 *  shows only "available" — silent on "latest" (we don't want a
 *  dialog every launch when the user is current) and on "error"
 *  (offline-on-boot is too common to dialog about). */
interface UpdateCheckOpts {
  alertOnLatest: boolean;
  alertOnError: boolean;
}

/** Core update-check routine. Both the Help menu manual path and
 *  the renderer-driven auto-launch path call this. In-flight guard
 *  prevents the two from racing. `update-available` always fires
 *  `showUpdateAvailableDialog`; the latest / error dialogs are
 *  gated by `opts`. In dev (`!app.isPackaged`) shows an info
 *  dialog only for the manual path (`opts.alertOnLatest`); the
 *  auto-launch path is a complete no-op in dev. */
function runUpdateCheck(opts: UpdateCheckOpts): void {
  if (!app.isPackaged) {
    if (opts.alertOnLatest) {
      const win = dialogParentWindow();
      if (win) {
        void dialog.showMessageBox(win, {
          type: 'info',
          message: 'Update checks are only active in packaged builds.',
        });
      }
    }
    return;
  }
  if (updateCheckInFlight) return;
  updateCheckInFlight = true;

  // Mutual cleanup: whichever event fires first wins; the others
  // get unregistered so a single check produces one response and
  // doesn't fire stale handlers on a *later* check.
  const cleanup = (): void => {
    updateCheckInFlight = false;
    autoUpdater.off('update-not-available', onNotAvailable);
    autoUpdater.off('update-available', onAvailable);
    autoUpdater.off('error', onError);
  };

  const onNotAvailable = (): void => {
    cleanup();
    if (!opts.alertOnLatest) return;
    const win = dialogParentWindow();
    if (!win) return;
    void dialog.showMessageBox(win, {
      type: 'info',
      title: 'No updates',
      message: "You're on the latest version.",
      detail: `CardMirror ${app.getVersion()}`,
    });
  };

  const onAvailable = (info: { version: string }): void => {
    cleanup();
    showUpdateAvailableDialog(info);
  };

  const onError = (err: Error): void => {
    cleanup();
    if (!opts.alertOnError) return;
    const win = dialogParentWindow();
    if (!win) return;
    void dialog.showMessageBox(win, {
      type: 'warning',
      title: "Couldn't check for updates",
      message: "Couldn't check for updates.",
      detail: `${err.message || String(err)}\n\nYou can grab the latest build manually from:\n${RELEASES_URL}`,
    });
  };

  autoUpdater.once('update-not-available', onNotAvailable);
  autoUpdater.once('update-available', onAvailable);
  autoUpdater.once('error', onError);

  autoUpdater.checkForUpdates().catch((err: unknown) => {
    onError(err instanceof Error ? err : new Error(String(err)));
  });
}

/** Manual Help → Check for Updates click handler. Shows feedback
 *  for every possible outcome. */
function runManualUpdateCheck(): void {
  runUpdateCheck({ alertOnLatest: true, alertOnError: true });
}

function startAutoUpdate(): void {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (err) => {
    console.warn('Auto-update error:', err);
  });
  autoUpdater.on('update-available', (info) => {
    console.log(`Auto-update: ${info.version} available, downloading…`);
  });
  autoUpdater.on('update-downloaded', (info) => {
    console.log(`Auto-update: ${info.version} downloaded; will install on next quit.`);
    const win = dialogParentWindow();
    if (!win) return;
    void dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `CardMirror ${info.version} is ready to install.`,
      detail: 'Restart now to apply the update, or later — it will install when you quit the app.',
    }).then((result) => {
      if (result.response === 0) autoUpdater.quitAndInstall();
    });
  });
  // The actual at-launch check now fires from the renderer's
  // boot path (gated on the `checkForUpdatesOnLaunch` setting +
  // `host.isFirstWindow()`) via the `host:trigger-auto-update-check`
  // IPC handler. Subsequent windows in the same session skip the
  // check entirely. The persistent event handlers above stay
  // wired so the "Update ready" dialog still fires when the
  // download completes.
}

// ─── App lifecycle ─────────────────────────────────────────────────

// Single-instance lock so OS double-clicks of `.cmir` / `.docx`
// don't spawn a second copy of the app. If we don't hold the
// lock, a previous CardMirror process is already running and
// will receive the file path via the `second-instance` event
// below — bail out of this process cleanly.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // Another instance was launched (typically by the OS handing
  // us a file via "Open with"). Argv contains the new instance's
  // command line; mine the file path out of it and open it in a
  // new window of the existing app.
  app.on('second-instance', (_event, argv) => {
    const filePath = pickFileFromArgv(argv);
    if (filePath) void openExternalFile(filePath);
    // Pull the user's attention back to a window so they see the
    // newly-opened doc (or at least the existing app) on top.
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

// macOS fires `open-file` for Finder double-clicks of registered
// extensions. It can fire BEFORE `app.whenReady()`, so stash the
// path and consume it inside whenReady if we're not ready yet.
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (app.isReady()) {
    void openExternalFile(filePath);
  } else {
    pendingLaunchFile = filePath;
  }
});

void app.whenReady().then(() => {
  Menu.setApplicationMenu(buildMenu());
  // Decide what to mount on first launch:
  //   - macOS `open-file` already arrived → that file
  //   - Win / Linux: scan argv for a file path → that file
  //   - Otherwise: empty starter window
  const launchFile = pendingLaunchFile ?? pickFileFromArgv(process.argv);
  pendingLaunchFile = null;
  if (launchFile) {
    void openExternalFile(launchFile);
  } else {
    createWindow();
  }
  startAutoUpdate();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
