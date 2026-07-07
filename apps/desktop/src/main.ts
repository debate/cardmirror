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
 *   - Host cross-window state: speech-doc registry, dropzone shelf,
 *     Quick Cards library, duplicate-open guard, crash-recovery
 *     journals, and auto-update.
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
import { registerVoiceIpc } from './voice/ipc';
import { registerFlowIpc } from './flow-bridge.js';
import { registerPairingIpc } from './pairing-ipc.js';
import {
  readAccessibilityTreeEnabled,
  writeAccessibilityTreeEnabled,
} from './accessibility-pref.js';
import { installMacAccessibilitySuppression } from './ax-suppress-mac.js';
import { resolveCmirCandidates, isWithin } from './transclusion-path.js';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { gzip as zlibGzip, gunzip as zlibGunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { startFastPasteBridge, stopFastPasteBridge } from './fast-paste-bridge.js';

const DEV_SERVER_URL = 'http://localhost:5173';

// macOS scroll-perf tuning. Belt-and-suspenders: none of these
// switches was the root fix for the historical scroll stalls (the
// Electron 33 → 42 / Chromium 130 → 148 bump was), but each is
// cheap and well-understood.
//
// `enable-zero-copy` lets the GPU upload raster tiles directly
// from main memory instead of double-buffering through the CPU —
// useful on Apple Silicon where the GPU shares system memory.
// `ignore-gpu-blocklist` overrides Chromium's conservative GPU
// blocklist so Apple Silicon devices that fall into a denied
// bucket still get full hardware acceleration.
// `enable-skia-graphite` opts into Chromium's newer Skia GPU
// backend (Dawn → Metal on macOS). On Chromium 148 (Electron 42)
// this is default-on for Apple platforms — the switch is a no-op,
// kept explicit to defend against any future default flip and to
// document the path we depend on.
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

// Default the renderer accessibility tree OFF. Electron 42 / Chromium 148 has a
// deterministic crash in Blink's accessibility serialization
// (blink::AXBlockFlowData::ComputeNeighborOnLine — a CHECK in the new
// AXBlockFlowIterator line-navigation code) that fires whenever an assistive-tech
// / UI-Automation client (screen reader, Windows Voice Access, Live Captions, …)
// turns the accessibility tree on. Symbolicated from real crash dumps; not fixed
// on current Chromium trunk. `--disable-renderer-accessibility` stops Chromium
// building/serializing the tree on Windows/Linux. On macOS the switch is not
// enough — an assistive-tech client setting AXEnhancedUserInterface on NSApp
// re-enables the tree behind it — so a second prong (installMacAccessibility-
// Suppression, called in whenReady) swizzles that AppKit path shut as well.
//
// Users who genuinely need a screen reader can opt back in via Settings (machine-
// local pref read here; the toggle prompts a restart since Chromium reads switches
// at startup). Fail-safe: any read failure leaves the switch ON (tree disabled).
// MUST run before `app.whenReady()`.
let rendererAccessibilityEnabled = false;
try {
  rendererAccessibilityEnabled = readAccessibilityTreeEnabled(app.getPath('userData'));
} catch {
  rendererAccessibilityEnabled = false;
}
if (!rendererAccessibilityEnabled) {
  app.commandLine.appendSwitch('disable-renderer-accessibility');
}

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
  /** Mode-switch reopen of a doc with unsaved changes: the spawned
   *  window mounts it dirty instead of the default clean. Passed
   *  through opaquely. */
  markDirty?: boolean;
  /** "Show in context": spawned window scrolls + selects this anchor
   *  after mounting. Passed through opaquely (stored + returned via
   *  get-initial-doc); the renderer resolves it. */
  focusAnchor?: { quote: string; prefix: string; suffix: string; approxPos: number };
  /** Join a collaboration share code instead of mounting a doc. Passed
   *  through opaquely (stored + returned via get-initial-doc); the renderer
   *  runs the join. */
  joinShareCode?: string;
}
const pendingInitialDocs = new Map<number, InitialDocPayload>();

/** Window id of the first window of this app session. Set on the
 *  first `createWindow` call; re-claimable by the next created
 *  window once the last window closes (macOS keeps the app alive
 *  windowless — without the reset, no window created after that
 *  point would ever run startup recovery). Used by the
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

/** Window ids whose renderer is in multi-pane (3-slot workspace)
 *  mode. Populated/cleared by the renderer at boot via
 *  `host:register-multipane`, so it stays accurate across the
 *  reload a workspace-mode toggle triggers. Lets the OS-open path
 *  reuse an existing multi-pane window (routing the file through
 *  its slot picker) instead of spawning a blank one. Single-pane
 *  windows are absent, so they keep the spawn-a-new-window path. */
const multiPaneWindows = new Set<number>();

/** A multi-pane window to hand an externally-opened file to — the
 *  focused one when it's multi-pane, else any multi-pane window.
 *  Null when none exist (single-pane session, or cold launch). */
function pickMultiPaneTarget(): BrowserWindow | null {
  if (multiPaneWindows.size === 0) return null;
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed() && multiPaneWindows.has(focused.id)) {
    return focused;
  }
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && multiPaneWindows.has(w.id)) return w;
  }
  return null;
}

/** Open a file the OS handed us (macOS `open-file`, Windows / Linux
 *  argv at launch or second-instance — e.g. "Open with… CardMirror").
 *  Multi-pane reuses an open window and routes the file through its
 *  slot picker (no blank new window); single-pane / cold launch spawns
 *  a fresh window with the file as its initial doc (VS Code / Word-like,
 *  and the single-pane behavior is unchanged). */
async function openExternalFile(filePath: string): Promise<void> {
  const ext = path.extname(filePath).toLowerCase();
  const format: 'cmir' | 'docx' | null =
    ext === '.cmir' ? 'cmir' : ext === '.docx' ? 'docx' : null;
  if (!format) return;
  // Duplicate-open guard for the OS-open path. The in-app Open dialog
  // gets this via `host:open-path-check`; Finder / Dock / "Open with…"
  // double-clicks arrive here and must run the same check, or a file
  // already open in another window opens a second, conflicting copy
  // (whichever copy closes first then releases the shared claim).
  if (focusExistingOwner(filePath)) return;
  const target = pickMultiPaneTarget();
  if (target) {
    // Hand off to the existing workspace — it reads the path and shows
    // its slot picker. Bring it forward so the picker is visible.
    target.webContents.send('host:external-open', { path: filePath });
    if (target.isMinimized()) target.restore();
    target.focus();
    return;
  }
  try {
    const buf = await fs.readFile(filePath);
    createWindow({
      filename: path.basename(filePath),
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
    // advertise its own default minimum to the WM (~800×600 on some
    // Linux compositors). Pinning both to 0 advertises "no minimum"
    // so tiling WMs and split-screen layouts can shrink the window
    // arbitrarily; the renderer's CSS / JS handles narrow-viewport
    // degradation from there.
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

  // Mirror tagged renderer console lines to the main-process stdout —
  // renderer console output is otherwise only visible in DevTools,
  // which makes diagnostics like the repair-skip log unreadable from
  // a terminal dev session. Tagged-only: full forwarding would spam.
  win.webContents.on('console-message', (...args: unknown[]) => {
    // Electron emits (event, level, message, line, sourceId) in the
    // legacy signature and (event{level,message,...}) in the new one.
    const evt = args[0] as { message?: unknown; level?: unknown };
    const fromEvent = evt?.message;
    const msg = typeof fromEvent === 'string' ? fromEvent : args[2];
    if (typeof msg !== 'string') return;
    const level = typeof evt?.level === 'string' || typeof evt?.level === 'number' ? evt.level : args[1];
    // Error-level renderer output (uncaught exceptions, console.error)
    // is forwarded unconditionally — invisible exceptions in deferred
    // callbacks have repeatedly been the missing diagnostic.
    const isError = level === 3 || level === 'error';
    if (isError || /^\[(repair(-fmt)?|cardmirror)\]/.test(msg)) {
      console.log(`[renderer${isError ? ':error' : ''}] ${msg}`);
    }
  });

  // Renderer-crash recovery + telemetry. A NATIVE renderer death — the
  // Electron 42 / Chromium 148 accessibility CHECK
  // (blink::AXBlockFlowData::ComputeNeighborOnLine, confirmed from field
  // crash dumps), a GPU-process crash, or an OOM — otherwise leaves a
  // permanently blank window with no way back: the journal/autosave timers
  // die with the renderer, so unsaved work is stranded. We record the
  // reason (we capture NOTHING for these in-app today — only Crashpad
  // minidumps the user has to dig out) and reload, turning a terminal
  // white screen into a blink-and-recover: the reloaded renderer's startup
  // flow restores unsaved work from the crash journal.
  const recentReloads: number[] = [];
  win.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    const stamp =
      `${new Date().toISOString()} render-process-gone reason=${details.reason} ` +
      `exitCode=${details.exitCode ?? '?'} title=${JSON.stringify(win.isDestroyed() ? '' : win.getTitle())}`;
    console.error(`[main:renderer-crash] ${stamp}`);
    void fs
      .appendFile(path.join(app.getPath('userData'), 'renderer-crashes.log'), stamp + '\n')
      .catch(() => {});
    if (win.isDestroyed()) return;
    // Loop guard: if the doc deterministically re-crashes on load, don't
    // spin — preserve the journal and tell the user to restart.
    const now = Date.now();
    while (recentReloads.length > 0 && now - recentReloads[0]! > 30_000) recentReloads.shift();
    recentReloads.push(now);
    if (recentReloads.length > 3) {
      dialog.showErrorBox(
        'CardMirror kept crashing',
        'The editor window crashed several times in a row. Your unsaved work is preserved ' +
          'in the recovery journal — please quit and reopen CardMirror.',
      );
      return;
    }
    win.webContents.reload();
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
    multiPaneWindows.delete(win.id);
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

/** Toggle DevTools on the window that asked. Backs the rebindable
 *  "Open Developer Console" ribbon command: the packaged app sets a
 *  null application menu on Windows/Linux, so the stock accelerators
 *  (F12 / Ctrl+Shift+I) don't exist there — without this, a packaged
 *  build has no console access at all. */
ipcMain.handle('host:toggle-devtools', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.webContents.toggleDevTools();
});

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

// Renderer accessibility tree toggle (see the `--disable-renderer-accessibility`
// block above). The pref is machine-local and read at startup; these let the
// settings UI show + change it. Changing it needs a restart to take effect.
ipcMain.handle('host:get-accessibility-tree-enabled', () =>
  readAccessibilityTreeEnabled(app.getPath('userData')),
);
ipcMain.handle('host:set-accessibility-tree-enabled', (_event, enabled: unknown) => {
  writeAccessibilityTreeEnabled(app.getPath('userData'), enabled === true);
});
// The state ACTUALLY APPLIED this session (the value read at startup, which
// decides whether `--disable-renderer-accessibility` was appended). May differ
// from the saved pref until the next restart — the settings UI uses this to show
// "currently on/off" and whether a restart is pending.
ipcMain.handle('host:get-accessibility-tree-applied', () => rendererAccessibilityEnabled);
// Whether Chromium currently reports an assistive-tech / UI-Automation client as
// active. True here means this machine would hit the AX crash if the tree were
// enabled — surfaced in Settings so the user understands why it's off.
ipcMain.handle('host:is-accessibility-support-active', () =>
  app.isAccessibilitySupportEnabled(),
);
// Full app relaunch — used by the accessibility toggle so the Chromium switch
// (read only at process start) actually takes effect.
ipcMain.handle('host:relaunch-app', () => {
  app.relaunch();
  app.exit(0);
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

// ── Card-cutter local plugin (experimental; NEVER bundled in the
// release). The engine ships as a user-installed JS bundle on disk; the
// renderer asks for its source here and runs it in its main world. ──
function cardCutterDefaultPath(): string {
  return path.join(app.getPath('userData'), 'plugins', 'cardcutter.global.js');
}
ipcMain.handle('host:cardcutter-pick-file', async (event) => {
  const win = ownerWindow(event.sender);
  const result = await dialog.showOpenDialog(win ?? new BrowserWindow({ show: false }), {
    title: 'Select card-cutter engine file',
    properties: ['openFile'],
    filters: [{ name: 'JavaScript', extensions: ['js', 'mjs', 'cjs'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0]!;
});
ipcMain.handle('host:cardcutter-read', async (_event, explicit: string | null) => {
  const target =
    (explicit && explicit.trim()) || process.env.CARDCUTTER_ENGINE || cardCutterDefaultPath();
  try {
    const source = await fs.readFile(target, 'utf8');
    return { source, path: target };
  } catch (err) {
    return { error: (err as Error).message, path: target };
  }
});

// Read a file at a known absolute path — used by the home
// screen's "open recent" path, which already has the path from
// the recents list and shouldn't pop a file picker. Returns null
// (rather than throwing) when the file is missing / unreadable so
// the caller can prune a stale recent entry gracefully.
ipcMain.handle('host:read-file-at-path', async (_event, filePath: string) => {
  if (typeof filePath !== 'string' || !filePath) return null;
  try {
    const bytes = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const format: 'cmir' | 'docx' | null =
      ext === '.cmir' ? 'cmir' : ext === '.docx' ? 'docx' : null;
    if (!format) return null;
    return {
      name: path.basename(filePath),
      bytes: new Uint8Array(bytes),
      handle: filePath,
      format,
    };
  } catch {
    return null;
  }
});

// Resolve + read a source .cmir for a transclusion refresh. Given the
// transcluding doc's own absolute path and a RELATIVE ref, resolve against the
// doc's directory, then HARD-SCOPE the result to the configured library roots
// (or the doc's own folder) and reject any `..` escape — the ref can travel
// inside a document authored by someone else (TRANSCLUSION_PLAN.md §3.2). It
// only ever parses a .cmir looking for a heading; it executes nothing. Returns
// null (never throws) on any failure, which the renderer treats as
// "unreachable — render from cache."
/** Upper bound on a source `.cmir` we'll pull into memory for a transclusion
 *  refresh. Generous vs. real debate masters (tens of MB); it exists to stop a
 *  hostile/oversized file (or a symlink to a device) from exhausting memory. */
const MAX_CMIR_READ_BYTES = 256 * 1024 * 1024;

/**
 * Resolve a transclusion source ref to a safe, canonical absolute path (or null).
 * Lexical containment (resolveCmirCandidates) can't see through symlinks, and the
 * filesystem FOLLOWS them — so a `.cmir` symlink inside a root could otherwise be
 * followed to an arbitrary file outside it (the ref travels in a doc someone else
 * authored). Re-verify on the CANONICAL path: realpath the target AND the allowed
 * roots (a root may itself live under a symlink), then require the real target to
 * sit inside a real root, be a regular file, and be within a sane size. This is
 * the actual boundary; the lexical check is just a fast pre-filter. Never throws.
 */
async function safeResolveCmirPath(
  docPath: string,
  sourceRef: string,
  refBase: 'doc' | 'root',
  rootList: string[],
  sourceAbs: string,
): Promise<string | null> {
  const candidates = resolveCmirCandidates(docPath, sourceRef, refBase, rootList, sourceAbs);
  const allowedBases = refBase === 'root' ? rootList : [...rootList, path.dirname(docPath)];
  const realBases: string[] = [];
  for (const b of allowedBases) {
    try {
      realBases.push(await fs.realpath(b));
    } catch {
      realBases.push(b);
    }
  }
  for (const abs of candidates) {
    try {
      const real = await fs.realpath(abs);
      // Symlink (or symlinked parent dir) that escapes every allowed root → drop.
      if (!realBases.some((rb) => isWithin(rb, real))) continue;
      const st = await fs.stat(real);
      // Reject devices/FIFOs (a `.cmir` symlink to /dev/zero would read forever)
      // and absurdly large files. Debate masters run to tens of MB → generous cap.
      if (!st.isFile() || st.size > MAX_CMIR_READ_BYTES) continue;
      return real;
    } catch {
      // try the next candidate root
    }
  }
  return null;
}

/** Coerce the untrusted IPC ref args, or null when malformed. */
function normalizeRefArgs(
  docPath: unknown,
  sourceRef: unknown,
  base: unknown,
  roots: unknown,
  sourceAbs: unknown,
): {
  docPath: string;
  sourceRef: string;
  refBase: 'doc' | 'root';
  rootList: string[];
  sourceAbs: string;
} | null {
  if (typeof docPath !== 'string' || typeof sourceRef !== 'string') return null;
  const refBase: 'doc' | 'root' = base === 'root' ? 'root' : 'doc';
  const rootList = Array.isArray(roots)
    ? roots.filter((r): r is string => typeof r === 'string' && r !== '')
    : [];
  return {
    docPath,
    sourceRef,
    refBase,
    rootList,
    sourceAbs: typeof sourceAbs === 'string' ? sourceAbs : '',
  };
}

ipcMain.handle(
  'host:read-cmir-file',
  async (
    _event,
    docPath: unknown,
    sourceRef: unknown,
    base: unknown,
    roots: unknown,
    sourceAbs: unknown,
  ) => {
    const a = normalizeRefArgs(docPath, sourceRef, base, roots, sourceAbs);
    if (!a) return null;
    const real = await safeResolveCmirPath(a.docPath, a.sourceRef, a.refBase, a.rootList, a.sourceAbs);
    if (!real) return null;
    try {
      const bytes = await fs.readFile(real);
      return { bytes: new Uint8Array(bytes), name: path.basename(real) };
    } catch {
      return null;
    }
  },
);

/** Resolve a transclusion source ref to its safe absolute path (for "Open source
 *  file" from a live zone). Same boundary as reading — never resolves a path
 *  outside the allowed roots. */
ipcMain.handle(
  'host:resolve-cmir-path',
  async (
    _event,
    docPath: unknown,
    sourceRef: unknown,
    base: unknown,
    roots: unknown,
    sourceAbs: unknown,
  ) => {
    const a = normalizeRefArgs(docPath, sourceRef, base, roots, sourceAbs);
    if (!a) return null;
    return safeResolveCmirPath(a.docPath, a.sourceRef, a.refBase, a.rootList, a.sourceAbs);
  },
);

// Bulk-convert support: recursively list files of a given extension
// under a directory, and write bytes to an arbitrary path. Used by the
// home-screen .docx↔.cmir bulk converter.
ipcMain.handle(
  'host:list-files-recursive',
  async (_event, dir: string, ext: string): Promise<Array<{ path: string; relPath: string }>> => {
    if (typeof dir !== 'string' || !dir || typeof ext !== 'string' || !ext) return [];
    const suffix = `.${ext.toLowerCase()}`;
    const out: Array<{ path: string; relPath: string }> = [];
    async function walk(cur: string): Promise<void> {
      let entries;
      try {
        entries = await fs.readdir(cur, { withFileTypes: true });
      } catch {
        return; // unreadable dir — skip
      }
      for (const ent of entries) {
        const name = ent.name;
        // Skip OS/Office junk that shares the extension but isn't a real
        // document: Word lock/owner files (~$…), macOS AppleDouble sidecars
        // (._…), and the __MACOSX metadata folder mac zips leave behind. These
        // aren't valid zips and would otherwise each surface as a scary error.
        if (name.startsWith('~$') || name.startsWith('._')) continue;
        const full = path.join(cur, name);
        if (ent.isDirectory()) {
          if (name === '__MACOSX') continue;
          await walk(full);
        } else if (ent.isFile() && name.toLowerCase().endsWith(suffix)) {
          out.push({ path: full, relPath: path.relative(dir, full) });
        }
      }
    }
    await walk(dir);
    return out;
  },
);

// ── Bulk-compress (temporary migration tool) ────────────────────────
// Rewrites every .cmir under a folder gzip-compressed, in place. The
// app reads compressed files transparently and writes them on save, but
// existing bulk-converted corpora would only shrink as files are
// re-saved — so this migrates them in one pass. Properties:
//   - idempotent: already-gzip files are skipped (re-runnable, mixed
//     folders fine);
//   - lossless: each rewrite is inflated and compared to the original
//     before the destructive replace;
//   - atomic: temp file + rename, so an interrupt can't corrupt a file;
//   - mtime-preserving: restores each file's mtime so the command bar's
//     recency ordering isn't disturbed.
// Runs in main (not the renderer like bulk-convert) to avoid streaming
// the whole corpus across IPC and to get atomic rename + utimes.
interface BulkCompressSummary {
  total: number;
  compressed: number;
  skipped: number;
  failed: number;
  bytesBefore: number;
  bytesAfter: number;
}

// zlib on libuv's thread pool: the sync variants would block the main
// process's event loop for the duration of each file's deflate +
// inflate-verify, stalling every window's IPC (saves, journal writes,
// menus, dialogs) for the whole bulk run.
const gzip = promisify(zlibGzip);
const gunzip = promisify(zlibGunzip);

ipcMain.handle(
  'host:bulk-compress',
  async (event, dir: string): Promise<BulkCompressSummary> => {
    if (typeof dir !== 'string' || !dir) throw new Error('bulk-compress: no folder');

    const files: string[] = [];
    async function walk(cur: string): Promise<void> {
      let entries;
      try {
        entries = await fs.readdir(cur, { withFileTypes: true });
      } catch {
        return; // unreadable dir — skip
      }
      for (const ent of entries) {
        const full = path.join(cur, ent.name);
        if (ent.isDirectory()) await walk(full);
        else if (ent.isFile() && ent.name.toLowerCase().endsWith('.cmir')) files.push(full);
      }
    }
    await walk(dir);

    const summary: BulkCompressSummary = {
      total: files.length,
      compressed: 0,
      skipped: 0,
      failed: 0,
      bytesBefore: 0,
      bytesAfter: 0,
    };
    const sender = event.sender;
    let lastSent = 0;
    const sendProgress = (force = false): void => {
      const now = Date.now();
      if (!force && now - lastSent < 100) return;
      lastSent = now;
      if (!sender.isDestroyed()) {
        sender.send('host:bulk-compress:progress', {
          done: summary.compressed + summary.skipped + summary.failed,
          ...summary,
        });
      }
    };

    for (const file of files) {
      try {
        const buf = await fs.readFile(file);
        summary.bytesBefore += buf.length;
        // Already compressed (gzip magic) → leave it, count as skipped.
        if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
          summary.skipped++;
          summary.bytesAfter += buf.length;
          sendProgress();
          continue;
        }
        const gz = await gzip(buf, { level: 6 });
        // Verify losslessness before the destructive replace.
        if (Buffer.compare(await gunzip(gz), buf) !== 0) {
          throw new Error('compression verification failed');
        }
        const st = await fs.stat(file);
        const tmp = `${file}.compress-tmp`;
        await fs.writeFile(tmp, gz);
        try {
          await fs.rename(tmp, file); // atomic on POSIX/Windows same-volume
        } catch (err) {
          await fs.unlink(tmp).catch(() => {});
          throw err;
        }
        // Restore the original mtime so recency sorting isn't disturbed.
        await fs.utimes(file, st.atime, st.mtime).catch(() => {});
        summary.compressed++;
        summary.bytesAfter += gz.length;
      } catch (err) {
        summary.failed++;
        console.error('bulk-compress failed for', file, err);
      }
      sendProgress();
    }
    sendProgress(true);
    return summary;
  },
);

// ── Cached .cmir file index (command-palette file search) ───────────
// The search-root listing — with per-file mtime + size, which a future
// content index can use to reparse only changed files — is cached in
// memory and on disk (`{userData}/cmir-file-index.json`): reads return
// instantly from cache and revalidate in the background. Persists
// across launches.

interface CmirFileEntry {
  path: string;
  relPath: string;
  mtimeMs: number;
  size: number;
}

const cmirIndexMem = new Map<string, CmirFileEntry[]>(); // search root → entries
const cmirRevalidating = new Set<string>();
let cmirIndexDiskLoaded = false;

function cmirIndexPath(): string {
  return path.join(app.getPath('userData'), 'cmir-file-index.json');
}

async function ensureCmirIndexLoaded(): Promise<void> {
  if (cmirIndexDiskLoaded) return;
  cmirIndexDiskLoaded = true;
  try {
    const text = await fs.readFile(cmirIndexPath(), 'utf8');
    const parsed = JSON.parse(text);
    if (parsed && parsed.roots && typeof parsed.roots === 'object') {
      for (const [root, entries] of Object.entries(parsed.roots)) {
        if (Array.isArray(entries)) cmirIndexMem.set(root, entries as CmirFileEntry[]);
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('Failed to read cmir-file-index.json:', err);
    }
  }
}

let cmirIndexWriteTail: Promise<void> = Promise.resolve();
function persistCmirIndex(): Promise<void> {
  const snapshot = Object.fromEntries(cmirIndexMem);
  cmirIndexWriteTail = cmirIndexWriteTail.catch(() => {}).then(async () => {
    const finalPath = cmirIndexPath();
    const tmpPath = `${finalPath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify({ version: 1, roots: snapshot }));
    await fs.rename(tmpPath, finalPath);
  });
  return cmirIndexWriteTail;
}

/** Walk `root` recursively for openable files (`.cmir` + `.docx`),
 *  recording mtime + size. */
async function scanCmirFiles(root: string): Promise<CmirFileEntry[]> {
  const out: CmirFileEntry[] = [];
  const isOpenable = (name: string): boolean => {
    // Skip Word's `~$…docx` owner/lock files — not real documents.
    if (name.startsWith('~$')) return false;
    const lower = name.toLowerCase();
    return lower.endsWith('.cmir') || lower.endsWith('.docx');
  };
  async function walk(cur: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) await walk(full);
      else if (ent.isFile() && isOpenable(ent.name)) {
        try {
          const st = await fs.stat(full);
          out.push({ path: full, relPath: path.relative(root, full), mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          /* vanished between readdir and stat — skip */
        }
      }
    }
  }
  await walk(root);
  return out;
}

/** Added / removed / mtime-changed since the cached listing? */
function cmirListingsDiffer(a: CmirFileEntry[], b: CmirFileEntry[]): boolean {
  if (a.length !== b.length) return true;
  const prev = new Map(a.map((e) => [e.path, e.mtimeMs]));
  return b.some((e) => prev.get(e.path) !== e.mtimeMs);
}

/** Push a freshly-revalidated listing to every window so an open
 *  command palette can swap it in live (it filters by `root`). */
function broadcastCmirIndexUpdated(root: string, entries: CmirFileEntry[]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('host:cmir-files-updated', { root, entries });
  }
}

/** Background refresh — updates the cache (+ disk) only if the tree
 *  changed, then broadcasts the fresh listing so any open palette
 *  refreshes live (and it's also ready for the next open). Coalesced
 *  per-root so concurrent searches don't pile up walks. */
function revalidateCmirIndex(root: string): void {
  if (cmirRevalidating.has(root)) return;
  cmirRevalidating.add(root);
  void scanCmirFiles(root)
    .then((fresh) => {
      cmirRevalidating.delete(root);
      const prev = cmirIndexMem.get(root);
      if (!prev || cmirListingsDiffer(prev, fresh)) {
        cmirIndexMem.set(root, fresh);
        void persistCmirIndex();
        broadcastCmirIndexUpdated(root, fresh);
      }
    })
    .catch(() => cmirRevalidating.delete(root));
}

ipcMain.handle('host:list-cmir-files', async (_event, root: string): Promise<CmirFileEntry[]> => {
  if (typeof root !== 'string' || !root) return [];
  await ensureCmirIndexLoaded();
  const cached = cmirIndexMem.get(root);
  if (cached) {
    // Instant from cache; refresh in the background for next time.
    revalidateCmirIndex(root);
    return cached;
  }
  // Cold (first ever / new root): scan now, cache, persist.
  const fresh = await scanCmirFiles(root);
  cmirIndexMem.set(root, fresh);
  void persistCmirIndex();
  return fresh;
});

ipcMain.handle('host:write-file-at-path', async (_event, filePath: string, bytes: unknown) => {
  if (typeof filePath !== 'string' || !filePath) throw new Error('write-file-at-path: no path');
  // Ensure the parent directory exists (bulk convert writes into a
  // destination folder, preserving the input's subfolder structure).
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, bytesToBuffer(bytes));
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

// Silent "Save Send Doc" / "Save Marked Cards" write. The renderer has already
// resolved the destination (a fixed folder, or the source file's own folder),
// the final filename, AND passes the source document's own path as
// `siblingHandle`; main joins, guards against clobbering the source, and
// writes. Returns the literal string 'collision' whenever the resolved target
// would overwrite the source document — in EITHER destination mode (e.g. a
// custom/empty prefix at the same folder + format, or a fixed folder that
// happens to contain the source) — so the renderer can defer to the Save As
// dialog instead.
ipcMain.handle(
  'host:save-send-doc',
  async (
    _event,
    opts: { folder: string | null; siblingHandle: string | null; filename: string },
    bytes: unknown,
  ) => {
    const dir = opts.folder ?? (opts.siblingHandle ? path.dirname(opts.siblingHandle) : null);
    if (!dir) return null;
    const target = path.join(dir, opts.filename);
    if (opts.siblingHandle && path.resolve(target) === path.resolve(opts.siblingHandle)) {
      return 'collision';
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytesToBuffer(bytes));
    return { name: path.basename(target), handle: target };
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

// ─── Learn store (local annotation layer) — whole-blob KV ──────────
function learnStorePath(): string {
  return path.join(app.getPath('userData'), 'learn-store.json');
}

ipcMain.handle('host:read-learn-store', async (): Promise<string | null> => {
  try {
    return await fs.readFile(learnStorePath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    console.warn('Failed to read learn-store.json:', err);
    return null;
  }
});

// Serialize writes (tmp → atomic rename) so quick consecutive saves can't
// tear the file — same discipline as the journal / quick-cards writers.
let learnStoreWriteTail: Promise<void> = Promise.resolve();
ipcMain.handle('host:write-learn-store', (_event, json: string) => {
  if (typeof json !== 'string') return learnStoreWriteTail;
  learnStoreWriteTail = learnStoreWriteTail.catch(() => {}).then(async () => {
    const finalPath = learnStorePath();
    const tmpPath = `${finalPath}.tmp`;
    await fs.writeFile(tmpPath, json);
    await fs.rename(tmpPath, finalPath);
  });
  return learnStoreWriteTail;
});

// ─── Multi-window: spawn + initial-doc handshake ──────────────────
// Renderers in "windows mode" (multiDocWorkspace = false on
// Electron) call `host:spawn-window` to open a new BrowserWindow,
// optionally with an initial doc already loaded. The freshly-
// spawned window's renderer calls `host:get-initial-doc` once at
// boot to retrieve the payload (or `null` if it was just opened
// blank). Main owns the pending-map keyed by window id.

ipcMain.handle('host:spawn-window', async (_event, payload: InitialDocPayload | null) => {
  // `payload.bytes` may arrive as a Buffer / typed array depending on
  // the IPC transfer; stored as-is — the renderer normalizes at read
  // time.
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

// The renderer reports its workspace mode at boot (and re-reports on
// the reload a mode toggle triggers) so the OS-open path knows which
// windows can take a file into their slot picker.
ipcMain.handle('host:register-multipane', async (event, isMultiPane: boolean) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (isMultiPane) multiPaneWindows.add(win.id);
  else multiPaneWindows.delete(win.id);
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

// True while a mode switch is closing the other windows. Backstop
// against two concurrent rounds: if two windows each initiated, each
// would treat the OTHER's surviving host as a window to close, so they
// would close each other and leave nothing open. The renderer gates
// the switch to the initiating window only (remote settings changes
// don't trigger it); this guard catches anything that slips past.
let modeSwitchInProgress = false;

// Docs journaled by the windows that close for a mode switch. Each
// closing renderer reports its {uid, dirty} list before close-self;
// the surviving window collects (and clears) the accumulated set
// after its reload so it can auto-reopen exactly the switch's docs
// — sessionStorage can't carry the closed windows' lists across.
let modeSwitchJournaledDocs: Array<{ uid: string; dirty: boolean }> = [];

ipcMain.handle('host:journal-and-close-other-windows', async (event) => {
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (modeSwitchInProgress) return;
  modeSwitchInProgress = true;
  // Fresh round — drop reports left over from an earlier switch
  // whose surviving window never collected them.
  modeSwitchJournaledDocs = [];
  try {
  const others = BrowserWindow.getAllWindows().filter(
    (w) => w !== sender && !w.isDestroyed(),
  );
  await Promise.all(
    others.map(
      (w) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            // The renderer never closed itself in time: destroy()
            // skips its journal, so its doc is lost on reopen.
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
  } finally {
    modeSwitchInProgress = false;
  }
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

ipcMain.handle(
  'host:mode-switch-journaled',
  (_event, docs: Array<{ uid: string; dirty: boolean }>) => {
    if (Array.isArray(docs)) modeSwitchJournaledDocs.push(...docs);
  },
);

ipcMain.handle('host:take-mode-switch-journaled', () => {
  const docs = modeSwitchJournaledDocs;
  modeSwitchJournaledDocs = [];
  return docs;
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

/** If a live window already owns `p`, focus (and un-minimize) it and
 *  return true. A stale entry (owner window gone) is cleaned up and
 *  the function returns false. Shared by the renderer-driven pre-open
 *  check (`host:open-path-check`) and the OS-open path
 *  (`openExternalFile`) so Finder / Dock / "Open with…" double-clicks
 *  get the SAME duplicate-open guard the in-app Open dialog does.
 *  `excludeWinId` lets a caller treat "already owned by me" as "free." */
function focusExistingOwner(p: string, excludeWinId?: number): boolean {
  const norm = canonicalOpenPath(p);
  const ownerId = openPathOwners.get(norm);
  if (ownerId === undefined || ownerId === excludeWinId) return false;
  const ownerWin = BrowserWindow.fromId(ownerId);
  if (!ownerWin || ownerWin.isDestroyed()) {
    openPathOwners.delete(norm);
    windowOpenPaths.get(ownerId)?.delete(norm);
    return false;
  }
  if (ownerWin.isMinimized()) ownerWin.restore();
  ownerWin.focus();
  return true;
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

// ─── Dropzone shelf (cross-window scratch space) ───────────────────
// Renderers drop slice content here; main keeps the list in memory
// and broadcasts every change so every window's bubble stays in
// sync. Cleared on app restart per spec (no disk persistence).

interface DropzoneItem {
  id: string;
  label: string;
  type: string;
  sliceJson: unknown;
  createdAt: number;
}

let dropzoneItems: DropzoneItem[] = [];

function broadcastDropzoneState(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('dropzone:changed', dropzoneItems);
  }
}

ipcMain.handle('host:dropzone-list', async () => dropzoneItems);

ipcMain.handle('host:dropzone-add', async (_event, item: DropzoneItem) => {
  if (!item || typeof item.id !== 'string' || !item.id) return;
  // De-dup by id — re-adding the same id moves it to the end (most
  // recent), which is the natural "use this again" semantics.
  dropzoneItems = dropzoneItems.filter((x) => x.id !== item.id);
  dropzoneItems.push(item);
  broadcastDropzoneState();
});

ipcMain.handle('host:dropzone-remove', async (_event, id: string) => {
  if (typeof id !== 'string' || !id) return;
  const next = dropzoneItems.filter((x) => x.id !== id);
  if (next.length === dropzoneItems.length) return;
  dropzoneItems = next;
  broadcastDropzoneState();
});

ipcMain.handle('host:dropzone-clear', async () => {
  if (dropzoneItems.length === 0) return;
  dropzoneItems = [];
  broadcastDropzoneState();
});

// ─── Quick Cards (persistent, cross-window snippet library) ────────
// Renderers add/edit named rich-text snippets; main keeps the
// canonical list in memory, persists it to
// `{userData}/quick-cards.json`, and broadcasts every change so every
// window stays in sync. Unlike the dropzone, this DOES persist across
// app restarts.

interface QuickCardIpc {
  id: string;
  name: string;
  tags: string[];
  contentJson: unknown;
  nameLower: string;
  tagsLower: string[];
  textLower: string;
  sourceName: string;
  createdAt: number;
  updatedAt: number;
}

let quickCards: QuickCardIpc[] = [];
let quickCardsLoaded = false;

function quickCardsPath(): string {
  return path.join(app.getPath('userData'), 'quick-cards.json');
}

/** Lazy one-time load from disk. Every handler awaits this first so
 *  the first mutation of a session doesn't clobber a saved library. */
async function ensureQuickCardsLoaded(): Promise<void> {
  if (quickCardsLoaded) return;
  quickCardsLoaded = true;
  try {
    const text = await fs.readFile(quickCardsPath(), 'utf8');
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.cards)) {
      quickCards = parsed.cards.filter(
        (c: unknown): c is QuickCardIpc =>
          !!c && typeof c === 'object' && typeof (c as QuickCardIpc).id === 'string',
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('Failed to read quick-cards.json:', err);
    }
    quickCards = [];
  }
}

// Serialize writes (tmp → atomic rename) so two quick mutations can't
// race to a torn file — same discipline as the journal writer.
let quickCardsWriteTail: Promise<void> = Promise.resolve();
function persistQuickCards(): Promise<void> {
  const snapshot = quickCards;
  quickCardsWriteTail = quickCardsWriteTail.catch(() => {}).then(async () => {
    const finalPath = quickCardsPath();
    const tmpPath = `${finalPath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify({ version: 1, cards: snapshot }));
    await fs.rename(tmpPath, finalPath);
  });
  return quickCardsWriteTail;
}

function broadcastQuickCardsState(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('quick-cards:changed', quickCards);
  }
}

ipcMain.handle('host:quick-cards-list', async () => {
  await ensureQuickCardsLoaded();
  return quickCards;
});

ipcMain.handle('host:quick-cards-upsert', async (_event, card: QuickCardIpc) => {
  if (!card || typeof card.id !== 'string' || !card.id) return;
  await ensureQuickCardsLoaded();
  // De-dup by id — upsert covers both new-card adds and edits.
  quickCards = [...quickCards.filter((c) => c.id !== card.id), card];
  broadcastQuickCardsState();
  await persistQuickCards();
});

ipcMain.handle('host:quick-cards-bulk-upsert', async (_event, cards: QuickCardIpc[]) => {
  if (!Array.isArray(cards)) return;
  await ensureQuickCardsLoaded();
  const incoming = new Map(
    cards.filter((c) => c && typeof c.id === 'string' && c.id).map((c) => [c.id, c]),
  );
  if (incoming.size === 0) return;
  quickCards = [...quickCards.filter((c) => !incoming.has(c.id)), ...incoming.values()];
  broadcastQuickCardsState();
  await persistQuickCards();
});

ipcMain.handle('host:quick-cards-remove', async (_event, id: string) => {
  if (typeof id !== 'string' || !id) return;
  await ensureQuickCardsLoaded();
  const next = quickCards.filter((c) => c.id !== id);
  if (next.length === quickCards.length) return;
  quickCards = next;
  broadcastQuickCardsState();
  await persistQuickCards();
});

ipcMain.handle('host:quick-cards-clear', async () => {
  await ensureQuickCardsLoaded();
  if (quickCards.length === 0) return;
  quickCards = [];
  broadcastQuickCardsState();
  await persistQuickCards();
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
  // Focus the owning window (and clean up a stale entry) via the same
  // helper the OS-open path uses; `win.id` is excluded so "already
  // owned by me" reads as free.
  return { takenByOther: focusExistingOwner(p, win.id) };
});

// "Show in context" cross-window focus: if another window owns `p`,
// focus it AND send it the anchor so it scrolls to the card's text.
// Returns whether it was delivered (false ⇒ caller spawns a window).
ipcMain.handle(
  'host:focus-anchor-in-window',
  async (event, p: string, descriptor: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || typeof p !== 'string' || !p) return { delivered: false };
    const norm = canonicalOpenPath(p);
    const ownerId = openPathOwners.get(norm);
    if (ownerId === undefined || ownerId === win.id) return { delivered: false };
    const ownerWin = BrowserWindow.fromId(ownerId);
    if (!ownerWin || ownerWin.isDestroyed()) {
      openPathOwners.delete(norm);
      windowOpenPaths.get(ownerId)?.delete(norm);
      return { delivered: false };
    }
    if (ownerWin.isMinimized()) ownerWin.restore();
    ownerWin.focus();
    ownerWin.webContents.send('host:focus-anchor', { descriptor });
    return { delivered: true };
  },
);

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
  const owner = openPathOwners.get(norm);
  if (owner !== win.id) return;
  openPathOwners.delete(norm);
  windowOpenPaths.get(win.id)?.delete(norm);
});

// Voice recognition service (SPEC-voice.md §12 item 2): session
// lifecycle + PCM-in / parse-events-out channels live in voice/ipc.ts.
registerVoiceIpc();

// Verbatim Flow bridge (Windows COM → Excel). No-ops off Windows.
registerFlowIpc();

// Cross-machine card sharing — receive poller + send + inbox. Idle until
// the renderer sends `host:pairing-configure` with sharing enabled.
registerPairingIpc();

ipcMain.handle('host:speech-set', async (event, uid: string | null) => {
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  if (!senderWin) return;
  if (uid === null) {
    speechRegistration = null;
    broadcastSpeechState();
    return;
  }
  if (typeof uid !== 'string' || !uid) return;
  // Look up the OWNING window for this uid (which may not be the
  // sender's — the Select Speech Doc modal lets a renderer pick a
  // doc that lives in a different window). Fall back to the
  // sender's window if the uid isn't registered yet, which is the
  // legacy "Mark Active as Speech" path where caller == owner.
  const ownerId = docOwners.get(uid);
  const targetId = ownerId ?? senderWin.id;
  speechRegistration = { uid, windowId: targetId };
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
    // Last window gone → let the next created window claim
    // first-window status (and with it the startup-recovery UI).
    // While other windows remain, firstness stays retired — a
    // window spawned mid-session must not offer to "recover" docs
    // that are open in those windows.
    if (BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length === 0) {
      firstWindowId = null;
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
      // No Cmd/Ctrl+R accelerator on plain Reload: a stray Cmd+R mid-edit
      // reloads the renderer and reads like a crash / data loss. Intentional
      // reloads go via this click or Force Reload (Cmd+Shift+R), which is
      // unlikely to be hit by accident.
      { label: 'Reload', click: () => BrowserWindow.getFocusedWindow()?.webContents.reload() },
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
      {
        label: 'User Manual',
        click: () => {
          void shell.openExternal(MANUAL_URL);
        },
      },
      {
        label: 'Privacy Policy',
        click: () => {
          void shell.openExternal(PRIVACY_URL);
        },
      },
      {
        label: 'Terms of Use',
        click: () => {
          void shell.openExternal(TERMS_URL);
        },
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
    // No native menu on Windows/Linux: there it reserves Alt+<key> for menu
    // mnemonics, which swallows the editor's Alt shortcuts before they reach the
    // keymap. Every menu command's accelerator is also a ribbon keybinding
    // handled by the renderer, so dropping the bar loses no shortcut. macOS keeps
    // its expected global menu bar (where Option doesn't trigger mnemonics).
    Menu.setApplicationMenu(process.platform === 'darwin' ? buildMenu() : null);
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

/** The user manual (MANUAL.md), rendered on GitHub. Linked from the Help
 *  menu so the full guide is one click away. */
const MANUAL_URL = 'https://github.com/ant981228/cardmirror/blob/main/MANUAL.md';

/** The privacy policy (PRIVACY.md), rendered on GitHub. Linked from the Help
 *  menu alongside the manual (and from Settings → General). */
const PRIVACY_URL = 'https://github.com/ant981228/cardmirror/blob/main/PRIVACY.md';

/** The terms of use (TERMS.md), rendered on GitHub. Linked from the Help menu
 *  alongside the manual and privacy policy (and from Settings → General). */
const TERMS_URL = 'https://github.com/ant981228/cardmirror/blob/main/TERMS.md';

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
  // macOS can DETECT updates but can't self-install them (unsigned
  // builds can't use Squirrel.Mac), so don't promise a background
  // download there — point the user at the .dmg instead.
  const macManual = process.platform === 'darwin';
  void dialog
    .showMessageBox(win, {
      type: 'info',
      buttons: ['Open release page', 'Close'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update available',
      message: `CardMirror ${info.version} is available.`,
      detail: macManual
        ? "Open the release page to download the new .dmg and reinstall — CardMirror can't install updates automatically on macOS yet."
        : 'Downloading in the background. When the download finishes you can restart to install, or quit normally and it will install on next launch.',
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
  // macOS: detection works, but unsigned builds can't self-install via
  // Squirrel.Mac. Keep the check on (so "Update available" still
  // fires), but turn off the background download + install-on-quit and
  // skip the "downloaded — restart to install" dialog, which would
  // otherwise advertise an auto-update that can't actually happen. Mac
  // users update by downloading the new .dmg.
  const isMac = process.platform === 'darwin';
  autoUpdater.autoDownload = !isMac;
  autoUpdater.autoInstallOnAppQuit = !isMac;
  autoUpdater.on('error', (err) => {
    console.warn('Auto-update error:', err);
  });
  autoUpdater.on('update-available', (info) => {
    console.log(`Auto-update: ${info.version} available${isMac ? '' : ', downloading…'}`);
  });
  if (!isMac) {
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
  }
  // The at-launch check fires from the renderer's boot path (gated
  // on the `checkForUpdatesOnLaunch` setting + `host.isFirstWindow()`)
  // via the `host:trigger-auto-update-check` IPC handler; subsequent
  // windows in the same session skip it. The persistent event handlers
  // above stay wired so the "Update ready" dialog still fires when the
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
  // One-time cleanup: the retired cross-window debug probe appended to
  // this log without bound in every user profile; remove it on sight.
  void fs
    .unlink(path.join(app.getPath('userData'), 'cross-window-debug.log'))
    .catch(() => {});
  // Accessibility crash workaround telemetry: whether we disabled the
  // renderer AX tree this launch, and whether Chromium reports an
  // assistive-tech / UIA client active (i.e. this machine would hit the
  // AX crash if the tree were enabled).
  console.log(
    `[cardmirror] ax-tree-disabled=${!rendererAccessibilityEnabled} ax-support-active=${app.isAccessibilitySupportEnabled()}`,
  );
  // macOS second prong: unless the user opted the tree back on, swizzle the
  // AppKit AXEnhancedUserInterface path shut so an assistive-tech client can't
  // re-enable the Chromium tree behind the disable-renderer-accessibility
  // switch. Runs here (not at module load) because it needs the shared
  // NSApplication to exist; before createWindow so no webContents is exposed
  // to the crash path first. No-op off macOS.
  if (!rendererAccessibilityEnabled) {
    installMacAccessibilitySuppression();
  }
  // An assistive-tech client connecting mid-session — another
  // confirmation signal for the AX crash trigger.
  app.on('accessibility-support-changed', (_event, enabled) => {
    console.log(`[cardmirror] ax-support-changed enabled=${enabled}`);
  });
  // macOS only — see the note at the other setApplicationMenu call. Windows/Linux
  // get no native menu bar so it can't swallow Alt-key editor shortcuts.
  Menu.setApplicationMenu(process.platform === 'darwin' ? buildMenu() : null);
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
  // Fast Debate Paste integration — 127.0.0.1-only HTTP server
  // exposing `/ping` and `/insert` for the external client. If the
  // port is taken or the discovery file can't be written, the
  // bridge silently bails and the client falls back to its
  // keystroke path (the integration is never a hard dependency).
  void startFastPasteBridge();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Tear down the Fast Debate Paste bridge before the app exits so
// the discovery file goes with us (stale-file tolerance is
// designed in, but cleaning up our own state means the next launch
// starts from a known-empty state).
app.on('before-quit', () => {
  void stopFastPasteBridge();
});
