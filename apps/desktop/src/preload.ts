/**
 * Electron preload script.
 *
 * Runs in an isolated bridging context between the main process and
 * the renderer. Exposes a narrow `window.electronAPI` surface via
 * Electron's `contextBridge` so the renderer can call into native
 * code without having full Node access.
 *
 * The shape exposed here matches the `ElectronAPI` interface
 * declared inside `src/editor/host/electron-host.ts`. If you add a
 * method here, mirror it there (and ideally in the cross-platform
 * Host interface so BrowserHost grows the same capability).
 */

import { contextBridge, ipcRenderer, webFrame } from 'electron';

interface FileFilter {
  name: string;
  extensions: string[];
}

interface JournalEntry {
  uid: string;
  filename: string;
  handle: string | null;
  format: 'cmir' | 'docx' | null;
  savedAt: string;
  bytes: Uint8Array;
}

contextBridge.exposeInMainWorld('electronAPI', {
  /** Read the system clipboard's plain-text content. Used by the
   *  F2 (Paste Plain) command on Electron — bypasses the Chromium
   *  web clipboard-permission UI that forces the web edition into
   *  a sticky-toggle workaround. */
  clipboardReadText: () => ipcRenderer.invoke('host:clipboard-read-text'),

  /** Trigger a manual auto-update check. Resolves with a status
   *  string the UI can use to show a friendly result message
   *  without needing to listen on its own autoUpdater channel. */
  checkForUpdates: () => ipcRenderer.invoke('host:check-for-updates') as Promise<{
    status: 'latest' | 'updating' | 'error' | 'dev';
    message?: string;
  }>,

  /** Trigger a silent at-launch update check. Same network call
   *  as `checkForUpdates`, but the main process suppresses the
   *  "you're on the latest" and "couldn't check" dialogs — only
   *  the "Update available" modal fires. No-op in dev builds. */
  triggerAutoUpdateCheck: () => ipcRenderer.invoke('host:trigger-auto-update-check'),

  /** Open the OS file manager at the crash-dumps folder. */
  openCrashDumpsFolder: () => ipcRenderer.invoke('host:open-crash-dumps'),

  /** Open a URL in the user's default OS browser (via shell.openExternal).
   *  Main filters to http(s) + mailto so file:// URLs can't escape. */
  openExternal: (url: string) => ipcRenderer.invoke('host:open-external', url),

  /** Open the native directory-picker dialog. Used by the
   *  settings UI for the "default folder" rows. Returns the
   *  chosen absolute path or null if the user cancelled. */
  pickDirectory: (opts?: { defaultPath?: string; title?: string }) =>
    ipcRenderer.invoke('host:pick-directory', opts),

  openFile: (opts: { filters: FileFilter[] }) =>
    ipcRenderer.invoke('host:open-file', opts),

  saveAs: (
    suggestedName: string,
    bytes: Uint8Array,
    opts: { filters: FileFilter[] },
  ) => ipcRenderer.invoke('host:save-as', suggestedName, bytes, opts),

  saveExisting: (handle: string, bytes: Uint8Array) =>
    ipcRenderer.invoke('host:save-existing', handle, bytes),

  /** Crash-recovery journal API. Stores per-doc snapshots under
   *  `app.getPath('userData')/journals/{uid}.cmir-journal`. */
  writeJournal: (entry: JournalEntry) =>
    ipcRenderer.invoke('host:write-journal', entry),
  readJournals: () => ipcRenderer.invoke('host:read-journals'),
  deleteJournal: (uid: string) =>
    ipcRenderer.invoke('host:delete-journal', uid),

  /** Spawn a new BrowserWindow, optionally pre-loaded with a doc. */
  spawnWindow: (payload: {
    filename: string;
    bytes: Uint8Array;
    handle: string | null;
    format: 'cmir' | 'docx' | null;
    uid: string | null;
    markAsSpeech?: boolean;
  } | null) => ipcRenderer.invoke('host:spawn-window', payload),

  /** Called once at renderer boot to retrieve any initial-doc
   *  payload the spawning window stashed for us. Null when the
   *  window was opened blank. */
  getInitialDoc: () => ipcRenderer.invoke('host:get-initial-doc'),

  /** True iff this is the first window of the current app session.
   *  Used by the renderer to gate the startup-recovery UI — only
   *  the first window should surface unsaved-journal restoration;
   *  windows spawned later in the session would otherwise offer to
   *  recover docs already open in OTHER windows of the same
   *  session. */
  isFirstWindow: () => ipcRenderer.invoke('host:is-first-window'),

  /** Mode-switch helper: tell main to broadcast
   *  `'mode-switch:please-close'` to every other open window and
   *  resolve once they've all closed. */
  journalAndCloseOtherWindows: () =>
    ipcRenderer.invoke('host:journal-and-close-other-windows'),

  /** Close this renderer's window programmatically. Called by the
   *  please-close handler after journaling. */
  closeSelf: () => ipcRenderer.invoke('host:close-self'),

  /** Subscribe to mode-switch please-close broadcasts. Returns an
   *  unsubscribe handle. */
  onPleaseCloseForModeSwitch(handler: () => void): () => void {
    const listener = (): void => handler();
    ipcRenderer.on('mode-switch:please-close', listener);
    return () => ipcRenderer.removeListener('mode-switch:please-close', listener);
  },

  /** Subscribe to user-initiated close requests. Main intercepts
   *  the window's `close` event and sends this so the renderer
   *  can prompt for unsaved-doc handling. The renderer's handler
   *  must call `host:close-self` to actually close, or do nothing
   *  (Cancel). */
  onCloseRequest(handler: () => void): () => void {
    const listener = (): void => handler();
    ipcRenderer.on('host:close-request', listener);
    return () => ipcRenderer.removeListener('host:close-request', listener);
  },

  /** Doc-lifecycle reporting for the main-process speech-doc
   *  registry. Renderers call register on mount and unregister on
   *  close, so main knows where each uid lives. */
  docRegister: (uid: string) => ipcRenderer.invoke('host:doc-register', uid),
  docUnregister: (uid: string) =>
    ipcRenderer.invoke('host:doc-unregister', uid),

  /** Cross-window duplicate-open guard. `openPathCheck(path)` is
   *  read-only — if another window already owns the path, main
   *  focuses that window and the caller gets `takenByOther:
   *  true` so it can toast + abort the open. Caller registers
   *  via `openPathRegister(path)` once it actually mounts the
   *  doc, and `openPathRelease(path)` when the doc unmounts
   *  (close, replace, Save-As to a different path). Main also
   *  cleans up claims automatically when a window closes, so
   *  missed releases don't permanently block re-opening. */
  openPathCheck: (path: string) =>
    ipcRenderer.invoke('host:open-path-check', path) as Promise<{
      takenByOther: boolean;
    }>,
  openPathRegister: (path: string) =>
    ipcRenderer.invoke('host:open-path-register', path),
  openPathRelease: (path: string) =>
    ipcRenderer.invoke('host:open-path-release', path),

  /** Set / clear / read the current speech-doc designation. Main
   *  broadcasts `speech:changed` to every window after any state
   *  change so UIs stay in sync. */
  speechSet: (uid: string | null) =>
    ipcRenderer.invoke('host:speech-set', uid),
  speechGet: () => ipcRenderer.invoke('host:speech-get'),

  /** Push the active filename for a registered uid so the
   *  Select-Speech-Doc modal can label every doc across every
   *  window. Call on mount and whenever the filename changes
   *  (save, save-as). Pass `null` for unsaved docs. */
  docInfoUpdate: (uid: string, filename: string | null) =>
    ipcRenderer.invoke('host:doc-info-update', { uid, filename }),

  /** List every open doc across every window. Each entry carries
   *  the uid, filename (or null), its owning window's id + title,
   *  whether it's the current speech doc, whether it lives in the
   *  caller's own window, and whether its window is currently
   *  focused. */
  listDocs: () =>
    ipcRenderer.invoke('host:list-docs') as Promise<
      Array<{
        uid: string;
        filename: string | null;
        windowId: number;
        windowTitle: string;
        isSpeech: boolean;
        isOwnWindow: boolean;
        isFocusedWindow: boolean;
      }>
    >,

  /** Subscribe to speech-state broadcasts. The handler receives the
   *  current `{ uid }` (uid is null when no speech doc is flagged). */
  onSpeechChanged(handler: (state: { uid: string | null }) => void): () => void {
    const listener = (_evt: unknown, state: { uid: string | null }): void =>
      handler(state);
    ipcRenderer.on('speech:changed', listener);
    return () => ipcRenderer.removeListener('speech:changed', listener);
  },

  /** Send a serialized PM slice to whatever window owns the speech
   *  doc. Returns whether the slice was delivered (`delivered:
   *  true`) or why not (`delivered: false, reason: ...`). */
  speechSendSlice: (payload: { sliceJson: unknown; atEnd: boolean }) =>
    ipcRenderer.invoke('host:speech-send-slice', payload),

  /** Subscribe to incoming speech-doc slices. The handler receives
   *  `{ uid, sliceJson, atEnd }` and is responsible for applying
   *  the slice to its local view that matches uid. */
  onIncomingSpeechSlice(
    handler: (payload: { uid: string; sliceJson: unknown; atEnd: boolean }) => void,
  ): () => void {
    const listener = (
      _evt: unknown,
      payload: { uid: string; sliceJson: unknown; atEnd: boolean },
    ): void => handler(payload);
    ipcRenderer.on('speech:incoming-slice', listener);
    return () =>
      ipcRenderer.removeListener('speech:incoming-slice', listener);
  },

  /** Push the renderer's current keybinding map to main so the
   *  application menu's accelerator labels track user rebinds.
   *  Values are PM-keymap strings (`Mod-o`, `Shift-Mod-s`,
   *  `Ctrl-ArrowLeft`); main translates each to Electron's
   *  accelerator form. Pass `null` for commands with no current
   *  binding so the accelerator hint is omitted. */
  setMenuBindings: (bindings: Record<string, string | null>) =>
    ipcRenderer.invoke('host:set-menu-bindings', bindings),

  /** Subscribe to native-menu commands. Main process broadcasts
   *  `'menu-command'` events to the focused window's webContents
   *  whenever the user picks File → Open / Save / etc. The
   *  renderer routes them through its existing ribbon-command
   *  registry. */
  onMenuCommand(handler: (command: string) => void): () => void {
    const listener = (_evt: unknown, command: string): void => handler(command);
    ipcRenderer.on('menu-command', listener);
    return () => ipcRenderer.removeListener('menu-command', listener);
  },

  /** Chrome scale — Chromium's per-frame page-zoom factor.
   *  Identical mechanism to the browser's Ctrl-+ / Ctrl-- chord:
   *  reflows the whole document including the editor surface,
   *  so the renderer's existing rem-based chrome and pt-based
   *  doc content both scale uniformly. Persisted per-window for
   *  the window's lifetime; the renderer reapplies the saved
   *  factor on every boot. */
  setZoomFactor: (factor: number): void => {
    webFrame.setZoomFactor(factor);
  },
  getZoomFactor: (): number => webFrame.getZoomFactor(),
});
