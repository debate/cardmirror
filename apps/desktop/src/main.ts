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
    title: 'CardMirror',
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Stash the initial doc (if any) BEFORE loading the renderer so
  // the renderer's `host:get-initial-doc` call at boot finds it.
  if (initialDoc) {
    pendingInitialDocs.set(win.id, initialDoc);
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

ipcMain.handle('host:write-journal', async (_event, entry: JournalEntryIpc) => {
  if (!entry || typeof entry.uid !== 'string' || !entry.uid) {
    throw new Error('host:write-journal: entry.uid is required.');
  }
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
  await fs.writeFile(journalPathFor(entry.uid), JSON.stringify(envelope));
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
  createWindow(payload ?? undefined);
});

ipcMain.handle('host:get-initial-doc', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  const payload = pendingInitialDocs.get(win.id);
  if (!payload) return null;
  pendingInitialDocs.delete(win.id);
  return payload;
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
  windowDocs.get(win.id)?.delete(uid);
  // If the speech doc just got unregistered, clear the global flag
  // and notify everyone.
  if (speechRegistration?.uid === uid) {
    speechRegistration = null;
    broadcastSpeechState();
  }
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
  });
});

// ─── Native menu bar ───────────────────────────────────────────────

/** Send a menu-command IPC event to the currently focused window. */
function dispatchMenuCommand(command: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (!win) return;
  win.webContents.send('menu-command', command);
}

function buildMenu(): Menu {
  const isMac = process.platform === 'darwin';

  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      {
        label: 'New Document',
        accelerator: 'CmdOrCtrl+Alt+N',
        click: () => dispatchMenuCommand('newDocument'),
      },
      {
        label: 'Open…',
        accelerator: 'CmdOrCtrl+O',
        click: () => dispatchMenuCommand('openFile'),
      },
      { type: 'separator' },
      {
        label: 'Save',
        accelerator: 'CmdOrCtrl+S',
        click: () => dispatchMenuCommand('save'),
      },
      {
        label: 'Save As…',
        accelerator: 'Shift+CmdOrCtrl+S',
        click: () => dispatchMenuCommand('saveAs'),
      },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit' },
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
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Check for Updates…',
          // Manual update check. Same path as the on-launch one; the
          // user-driven 'update-not-available' branch shows a
          // confirmation so they know the check ran.
          click: () => {
            if (!app.isPackaged) {
              const win = BrowserWindow.getFocusedWindow();
              if (win) {
                void dialog.showMessageBox(win, {
                  type: 'info',
                  message: 'Update checks are only active in packaged builds.',
                });
              }
              return;
            }
            autoUpdater.once('update-not-available', () => {
              const win = BrowserWindow.getFocusedWindow();
              if (!win) return;
              void dialog.showMessageBox(win, {
                type: 'info',
                message: `You're on the latest version.`,
              });
            });
            autoUpdater.checkForUpdates().catch((err) => {
              console.warn('Manual update check failed:', err);
            });
          },
        },
        {
          label: 'Open Crash Dumps Folder',
          // Crash minidumps land in `app.getPath('crashDumps')`. We
          // don't upload them anywhere — users who hit a crash can
          // grab the dump from this folder and attach it to a bug
          // report manually.
          click: () => {
            void shell.openPath(app.getPath('crashDumps'));
          },
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

// ─── Auto-update ───────────────────────────────────────────────────
//
// electron-updater reads `app-update.yml` from inside the packaged
// app — electron-builder emits it as part of the release build with
// the GitHub Releases provider configured. In development (no
// `app.isPackaged`) the check is a no-op so we don't 404 against a
// missing config file. Failures are logged, never alerted.

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
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
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
  autoUpdater.checkForUpdates().catch((err) => {
    console.warn('Auto-update check failed:', err);
  });
}

// ─── App lifecycle ─────────────────────────────────────────────────

void app.whenReady().then(() => {
  Menu.setApplicationMenu(buildMenu());
  createWindow();
  startAutoUpdate();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
