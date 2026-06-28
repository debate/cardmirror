/**
 * ElectronHost — the Host implementation for the Electron desktop
 * wrapper. Delegates every operation to the main process via the
 * preload-exposed `window.electronAPI`. The renderer never touches
 * Node directly; the bridge is intentionally narrow.
 *
 * Handles are plain strings (absolute file paths) — structured-clone
 * across IPC, no serialization tricks needed.
 */

import type {
  FileFilter,
  Host,
  JournalEntry,
  OpenFileOptions,
  OpenedFile,
  SaveAsOptions,
  SaveResult,
  SpawnWindowPayload,
} from './types.js';

/** Wire shape of a quick card across IPC. Structurally identical to
 *  the renderer's `QuickCard`; declared locally so this module takes
 *  no import dependency on the store (and no import cycle). */
export interface QuickCardIpc {
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

/** Cross-machine card sharing IPC shapes. Declared locally (structurally
 *  identical to the renderer's pairing types) so this module takes no
 *  import dependency on the pairing stores — same convention as
 *  `QuickCardIpc`. */
export interface PairingConfigIpc {
  /** Whether the receive poller should run. */
  enabled: boolean;
  /** Optional name stamped (inside the ciphertext) on outgoing cards. */
  displayName: string;
  /** App version, for the cross-version guard. */
  schemaVersion: string;
  /** Compatibility floor stamped on cards this build sends — the minimum
   *  receiver version that can read them. Blank = any version may receive. */
  minReceiverVersion?: string;
  /** Poll cadence in seconds. */
  pollSeconds: number;
}
export interface PairingSendItemIpc {
  label: string;
  type: string;
  sliceJson: unknown;
}
export interface PairingSendIpc {
  recipientCodes: string[];
  item: PairingSendItemIpc;
  via?: string;
}
export interface PairingInboxItemIpc {
  id: string;
  label: string;
  type: string;
  sliceJson: unknown;
  senderName: string;
  senderCode: string;
  via?: string;
  receivedAt: number;
  read: boolean;
}

/** Verbatim Flow bridge result shapes (mirrors verbatim-flow.ps1). */
export interface FlowAvailable {
  available: boolean;
  workbook?: string;
  reason?: string;
  error?: string;
}
export interface FlowResult {
  ok: boolean;
  written?: number;
  needsConfirm?: boolean;
  cell?: string;
  cells?: string[];
  template?: string;
  error?: string;
}

/** Final tallies from a bulk-compress run. */
export interface BulkCompressSummary {
  total: number;
  compressed: number;
  skipped: number;
  failed: number;
  bytesBefore: number;
  bytesAfter: number;
}
/** Throttled progress during a bulk-compress run (`done` of `total`). */
export interface BulkCompressProgress extends BulkCompressSummary {
  done: number;
}

/** The shape we expect the preload script to expose. Defined here
 *  (and not imported from the desktop workspace) so the editor
 *  doesn't take a build-time dependency on Electron-specific code. */
interface ElectronAPI {
  clipboardReadText(): Promise<string>;
  openExternal(url: string): Promise<void>;
  pickDirectory(opts?: {
    defaultPath?: string;
    title?: string;
  }): Promise<string | null>;
  openFile(opts: { filters: FileFilter[] }): Promise<{
    name: string;
    bytes: Uint8Array;
    handle: string;
  } | null>;
  /** Verbatim Flow bridge (Windows COM → Excel). Optional so an older
   *  preload tolerates its absence. */
  flowAvailable?(): Promise<FlowAvailable>;
  flowSend?(payload: { cells: string[] }, force?: boolean): Promise<FlowResult>;
  flowPull?(): Promise<FlowResult>;
  flowCreate?(templatePath?: string): Promise<FlowResult>;
  flowStartHost?(): Promise<FlowResult>;
  /** Card-cutter local plugin (experimental; optional so an older
   *  preload tolerates its absence). */
  cardCutterPickFile?(): Promise<string | null>;
  cardCutterLoad?(
    enginePath?: string | null,
  ): Promise<{ ok: boolean; path?: string; error?: string }>;
  getPathForFile(file: File): string;
  readFileAtPath(filePath: string): Promise<{
    name: string;
    bytes: Uint8Array;
    handle: string;
    format: 'cmir' | 'docx';
  } | null>;
  saveAs(
    suggestedName: string,
    bytes: Uint8Array,
    opts: { filters: FileFilter[] },
  ): Promise<{ name: string; handle: string } | null>;
  saveExisting(handle: string, bytes: Uint8Array): Promise<void>;
  saveSendDoc(
    opts: { folder: string | null; siblingHandle: string | null; filename: string },
    bytes: Uint8Array,
  ): Promise<{ name: string; handle: string } | 'collision' | null>;
  listFilesRecursive(dir: string, ext: string): Promise<Array<{ path: string; relPath: string }>>;
  listCmirFiles(
    root: string,
  ): Promise<Array<{ path: string; relPath: string; mtimeMs: number; size: number }>>;
  /** Fires when main's background revalidation finds the `.cmir`
   *  listing for `root` changed, so an open command palette can swap in
   *  the fresh listing live instead of waiting for the next open. */
  onCmirFileIndexUpdated(
    handler: (payload: {
      root: string;
      entries: Array<{ path: string; relPath: string; mtimeMs: number; size: number }>;
    }) => void,
  ): () => void;
  writeFileAtPath(filePath: string, bytes: Uint8Array): Promise<void>;
  bulkCompress(
    dir: string,
    onProgress: (p: BulkCompressProgress) => void,
  ): Promise<BulkCompressSummary>;
  writeJournal(entry: JournalEntry): Promise<void>;
  readJournals(): Promise<JournalEntry[]>;
  deleteJournal(uid: string): Promise<void>;
  readLearnStore(): Promise<string | null>;
  writeLearnStore(json: string): Promise<void>;
  spawnWindow(payload: SpawnWindowPayload | null): Promise<void>;
  getInitialDoc(): Promise<SpawnWindowPayload | null>;
  isFirstWindow(): Promise<boolean>;
  /** Report this window's workspace mode to main (multi-pane vs
   *  single-pane) so the OS "Open with…" path can reuse a multi-pane
   *  window's slot picker instead of spawning a blank window. */
  registerMultipane(isMultiPane: boolean): Promise<void>;
  /** TEMPORARY cross-window probe: fold a renderer event into main's
   *  cross-window debug log. Optional so an older preload tolerates it. */
  debugLog?(event: string, data?: unknown): void;
  /** Main forwards an OS-opened file (absolute path) to this window
   *  when it's an existing multi-pane workspace. Returns unsubscribe. */
  onExternalOpen(handler: (payload: { path: string }) => void): () => void;
  journalAndCloseOtherWindows(): Promise<void>;
  closeSelf(): Promise<void>;
  /** Optional so an older preload tolerates the mode-switch
   *  doc-list channel being absent. */
  reportModeSwitchJournaled?(docs: Array<{ uid: string; dirty: boolean }>): Promise<void>;
  takeModeSwitchJournaledDocs?(): Promise<Array<{ uid: string; dirty: boolean }>>;
  onPleaseCloseForModeSwitch(handler: () => void): () => void;
  onCloseRequest(handler: () => void): () => void;
  docRegister(uid: string): Promise<void>;
  docUnregister(uid: string): Promise<void>;
  /** Push the current filename for a uid so the Select-Speech-Doc
   *  modal can show meaningful row labels across every window. */
  docInfoUpdate(uid: string, filename: string | null): Promise<void>;
  /** Cross-window dropzone shelf. List returns current items;
   *  add/remove/clear mutate and broadcast via onDropzoneChanged. */
  dropzoneList(): Promise<
    Array<{ id: string; label: string; type: string; sliceJson: unknown; createdAt: number }>
  >;
  dropzoneAdd(item: {
    id: string;
    label: string;
    sliceJson: unknown;
    createdAt: number;
  }): Promise<void>;
  dropzoneRemove(id: string): Promise<void>;
  dropzoneClear(): Promise<void>;
  onDropzoneChanged(
    handler: (
      items: Array<{ id: string; label: string; type: string; sliceJson: unknown; createdAt: number }>,
    ) => void,
  ): () => void;

  /** Cross-window + persistent Quick Cards library. List returns the
   *  current cards; upsert/bulkUpsert/remove/clear mutate, persist to
   *  disk, and broadcast via onQuickCardsChanged. */
  quickCardsList(): Promise<QuickCardIpc[]>;
  quickCardsUpsert(card: QuickCardIpc): Promise<void>;
  quickCardsBulkUpsert(cards: QuickCardIpc[]): Promise<void>;
  quickCardsRemove(id: string): Promise<void>;
  quickCardsClear(): Promise<void>;
  onQuickCardsChanged(handler: (cards: QuickCardIpc[]) => void): () => void;

  /** Cross-machine card sharing. The main process holds the relay URL +
   *  token, runs the receive poller, and owns the inbox; the renderer
   *  configures it, sends, and reads the inbox through these. Optional so
   *  an older preload (without the pairing build) degrades gracefully. */
  pairingConfigure?(cfg: PairingConfigIpc): Promise<{ ownCode: string }>;
  pairingRegenerateKey?(): Promise<{ ownCode: string }>;
  pairingSend?(payload: PairingSendIpc): Promise<{ ok: number; fail: number }>;
  pairingInboxList?(): Promise<PairingInboxItemIpc[]>;
  pairingInboxRemove?(id: string): Promise<void>;
  pairingInboxClear?(): Promise<void>;
  pairingInboxMarkAllRead?(): Promise<void>;
  onPairingInboxChanged?(handler: (items: PairingInboxItemIpc[]) => void): () => void;
  onPairingVersionMismatch?(
    handler: (info: {
      partnerVersion: string;
      localVersion: string;
      requiredVersion: string;
    }) => void,
  ): () => void;

  /** Return every open doc across every window with its current
   *  filename, owning window, and speech-doc status. */
  listDocs(): Promise<
    Array<{
      uid: string;
      filename: string | null;
      windowId: number;
      windowTitle: string;
      isSpeech: boolean;
      isOwnWindow: boolean;
      isFocusedWindow: boolean;
    }>
  >;
  openPathCheck(path: string): Promise<{ takenByOther: boolean }>;
  openPathRegister(path: string): Promise<void>;
  openPathRelease(path: string): Promise<void>;
  /** "Show in context": if another window owns `path`, focus it and send
   *  it the anchor to scroll to. `delivered: false` ⇒ spawn a window. */
  focusAnchorInWindow(
    path: string,
    descriptor: { quote: string; prefix: string; suffix: string; approxPos: number },
  ): Promise<{ delivered: boolean }>;
  /** Receive a "scroll to this anchor" request from another window's
   *  "Show in context" (this window owns the path). Returns unsubscribe. */
  onFocusAnchor(
    handler: (payload: {
      descriptor: { quote: string; prefix: string; suffix: string; approxPos: number };
    }) => void,
  ): () => void;
  speechSet(uid: string | null): Promise<void>;
  speechGet(): Promise<{ uid: string | null }>;
  onSpeechChanged(handler: (state: { uid: string | null }) => void): () => void;
  speechSendSlice(payload: {
    sliceJson: unknown;
    atEnd: boolean;
  }): Promise<{ delivered: boolean; reason?: string }>;
  onIncomingSpeechSlice(
    handler: (payload: { uid: string; sliceJson: unknown; atEnd: boolean }) => void,
  ): () => void;
  /** Subscribe to menu-driven commands from the native menu bar.
   *  Returns an unsubscribe handle. */
  onMenuCommand(handler: (command: string) => void): () => void;
  /** Push the current keybinding map to main so the native menu's
   *  accelerator hints stay in sync with user rebinds. Values are
   *  PM-keymap strings; pass `null` for commands with no current
   *  binding so the accelerator slot is left blank. */
  setMenuBindings(bindings: Record<string, string | null>): Promise<void>;
  /** Run a manual auto-update check (mirrors Help → Check for
   *  Updates…). Resolves with a status the UI can render. */
  checkForUpdates(): Promise<{
    status: 'latest' | 'updating' | 'error' | 'dev';
    message?: string;
  }>;
  /** Trigger a silent at-launch update check. Same network call as
   *  `checkForUpdates`, but the main process suppresses the
   *  "you're on the latest" / "couldn't check" dialogs that the
   *  manual path shows — only the "Update available" dialog
   *  fires. No-op in dev (non-packaged) builds. Called from the
   *  renderer at boot iff `checkForUpdatesOnLaunch` is enabled. */
  triggerAutoUpdateCheck(): Promise<void>;
  /** Open the OS file manager at the crash-dumps folder (mirrors
   *  Help → Open Crash Dumps Folder). */
  openCrashDumpsFolder(): Promise<void>;
  /** Chromium page-zoom factor for this window (1.0 = 100%).
   *  Synchronous renderer-side call into Electron's `webFrame`. */
  setZoomFactor(factor: number): void;
  getZoomFactor(): number;

  /** Fast Debate Paste integration. The renderer subscribes to
   *  `external:insert-text` requests dispatched from the main-process
   *  HTTP bridge (`apps/desktop/src/fast-paste-bridge.ts`), and replies
   *  via `external:insert-result`. Wire contract lives in the FDP
   *  integration spec (reference-docs). */
  onExternalInsertRequest(
    handler: (req: {
      requestId: string;
      text: string;
      role: 'card' | 'cite' | 'inline';
      newParagraph: boolean;
      omitted: boolean;
    }) => void,
  ): () => void;
  sendExternalInsertResult(result: {
    requestId: string;
    ok: boolean;
    error?: string;
    docTitle?: string;
  }): void;
}

function api(): ElectronAPI {
  const x = (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
  if (!x) throw new Error('ElectronHost selected but window.electronAPI is missing.');
  return x;
}

export class ElectronHost implements Host {
  readonly kind = 'electron' as const;
  readonly supportsInPlaceSave = true;
  readonly journalsSupported = true;
  readonly canSpawnWindow = true;

  async clipboardReadText(): Promise<string> {
    return api().clipboardReadText();
  }

  async openExternal(url: string): Promise<void> {
    await api().openExternal(url);
  }

  async pickDirectory(opts?: {
    defaultPath?: string;
    title?: string;
  }): Promise<string | null> {
    return api().pickDirectory(opts);
  }

  /** Verbatim Flow bridge (Windows COM → Excel). Resolve a "windows-only"
   *  / "unsupported" result on hosts that can't do it. */
  async flowAvailable(): Promise<FlowAvailable> {
    return (await api().flowAvailable?.()) ?? { available: false, error: 'unsupported' };
  }
  async flowSend(payload: { cells: string[] }, force?: boolean): Promise<FlowResult> {
    return (await api().flowSend?.(payload, force)) ?? { ok: false, error: 'unsupported' };
  }
  async flowPull(): Promise<FlowResult> {
    return (await api().flowPull?.()) ?? { ok: false, error: 'unsupported' };
  }
  async flowCreate(templatePath?: string): Promise<FlowResult> {
    return (await api().flowCreate?.(templatePath)) ?? { ok: false, error: 'unsupported' };
  }
  async flowStartHost(): Promise<FlowResult> {
    return (await api().flowStartHost?.()) ?? { ok: false, error: 'unsupported' };
  }

  /** Card-cutter local plugin: pick the engine file / load it from disk
   *  into the renderer. No-ops gracefully on an older preload. */
  async cardCutterPickFile(): Promise<string | null> {
    return (await api().cardCutterPickFile?.()) ?? null;
  }
  async cardCutterLoad(
    enginePath?: string | null,
  ): Promise<{ ok: boolean; path?: string; error?: string }> {
    return (
      (await api().cardCutterLoad?.(enginePath ?? null)) ?? {
        ok: false,
        error: 'card-cutter loading unsupported by this build',
      }
    );
  }

  async openFile(opts: OpenFileOptions = {}): Promise<OpenedFile | null> {
    const result = await api().openFile({ filters: opts.filters ?? [] });
    if (!result) return null;
    // Normalize the bytes — IPC sometimes hands us a Buffer-like
    // object (Node's `Buffer extends Uint8Array`); wrapping
    // guarantees a plain Uint8Array view that downstream code can
    // pass to `fromDocxFull` etc.
    return {
      name: result.name,
      bytes: result.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(result.bytes),
      handle: result.handle,
    };
  }

  /** Read a file at a known path without a picker. Returns null
   *  when the path is missing / unreadable (caller prunes the
   *  stale recent). ElectronHost-only — the home screen guards
   *  on host kind before calling. */
  /** Absolute path of a dropped File (drag-to-open). '' when it can't be
   *  resolved (no real path, or the bridge call fails). */
  getPathForFile(file: File): string {
    try {
      return api().getPathForFile(file);
    } catch {
      return '';
    }
  }

  async readFileAtPath(filePath: string): Promise<{
    name: string;
    bytes: Uint8Array;
    handle: string;
    format: 'cmir' | 'docx';
  } | null> {
    const result = await api().readFileAtPath(filePath);
    if (!result) return null;
    return {
      name: result.name,
      bytes: result.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(result.bytes),
      handle: result.handle,
      format: result.format,
    };
  }

  async saveAs(
    suggestedName: string,
    bytes: Uint8Array,
    opts: SaveAsOptions = {},
  ): Promise<SaveResult | null> {
    const result = await api().saveAs(suggestedName, bytes, {
      filters: opts.filters ?? [],
    });
    if (!result) return null;
    return { name: result.name, handle: result.handle };
  }

  async saveExisting(handle: unknown, bytes: Uint8Array): Promise<void> {
    if (typeof handle !== 'string') {
      throw new Error(
        'ElectronHost: saveExisting requires a string path handle.',
      );
    }
    await api().saveExisting(handle, bytes);
  }

  /** Silent "Save Send Doc" write. `opts.folder` (fixed-folder mode)
   *  or `opts.siblingHandle` (same-folder mode, the source file's path)
   *  resolves the destination directory in main. Returns the written
   *  file's name + path, `'collision'` when the target would overwrite
   *  the source (caller should fall back to Save As), or `null` when the
   *  destination couldn't be resolved. */
  async saveSendDoc(
    opts: { folder: string | null; siblingHandle: string | null; filename: string },
    bytes: Uint8Array,
  ): Promise<{ name: string; handle: string } | 'collision' | null> {
    return api().saveSendDoc(opts, bytes);
  }

  async listFilesRecursive(dir: string, ext: string): Promise<Array<{ path: string; relPath: string }>> {
    return api().listFilesRecursive(dir, ext);
  }

  /** Cached, persisted recursive `.cmir` listing for the file-search
   *  palette — returns instantly from main's in-memory / on-disk cache
   *  and revalidates in the background, avoiding a fresh directory walk
   *  on every palette open. */
  async listCmirFiles(
    root: string,
  ): Promise<Array<{ path: string; relPath: string; mtimeMs: number; size: number }>> {
    return api().listCmirFiles(root);
  }

  onCmirFileIndexUpdated(
    handler: (payload: {
      root: string;
      entries: Array<{ path: string; relPath: string; mtimeMs: number; size: number }>;
    }) => void,
  ): () => void {
    // Tolerate an older preload that predates this channel — no live
    // refresh, but everything else still works (next open reloads fresh).
    const fn = api().onCmirFileIndexUpdated;
    return typeof fn === 'function' ? fn(handler) : () => {};
  }

  async writeFileAtPath(filePath: string, bytes: Uint8Array): Promise<void> {
    await api().writeFileAtPath(filePath, bytes);
  }

  async bulkCompress(
    dir: string,
    onProgress: (p: BulkCompressProgress) => void,
  ): Promise<BulkCompressSummary> {
    return api().bulkCompress(dir, onProgress);
  }

  async writeJournal(entry: JournalEntry): Promise<void> {
    await api().writeJournal(entry);
  }

  async readJournals(): Promise<JournalEntry[]> {
    const raw = await api().readJournals();
    // Normalize bytes — they may arrive as a Buffer-shaped object
    // after the structured clone. Same defensive wrap as openFile.
    return raw.map((entry) => ({
      ...entry,
      bytes: entry.bytes instanceof Uint8Array ? entry.bytes : new Uint8Array(entry.bytes as ArrayBufferLike),
    }));
  }

  async deleteJournal(uid: string): Promise<void> {
    await api().deleteJournal(uid);
  }

  async readLearnStore(): Promise<string | null> {
    return api().readLearnStore();
  }

  async writeLearnStore(json: string): Promise<void> {
    await api().writeLearnStore(json);
  }

  async spawnWindow(payload: SpawnWindowPayload | null): Promise<void> {
    await api().spawnWindow(payload);
  }

  async getInitialDoc(): Promise<SpawnWindowPayload | null> {
    const result = await api().getInitialDoc();
    if (!result) return null;
    return {
      ...result,
      bytes: result.bytes instanceof Uint8Array
        ? result.bytes
        : new Uint8Array(result.bytes as ArrayBufferLike),
    };
  }

  async isFirstWindow(): Promise<boolean> {
    return await api().isFirstWindow();
  }

  async registerMultipane(isMultiPane: boolean): Promise<void> {
    // Tolerate an older preload (no channel) — main just won't reuse
    // this window for OS opens, falling back to spawn-a-window.
    await api().registerMultipane?.(isMultiPane);
  }

  /** TEMPORARY cross-window probe — see main.ts `xlog`. Fire-and-forget;
   *  never throws (logging must not perturb the flow it measures). */
  debugLog(event: string, data?: unknown): void {
    try {
      api().debugLog?.(event, data);
    } catch {
      /* ignore */
    }
  }

  onExternalOpen(handler: (payload: { path: string }) => void): () => void {
    const fn = api().onExternalOpen;
    return typeof fn === 'function' ? fn(handler) : () => {};
  }

  /** Mode-switch helper. Asks main to broadcast a please-close
   *  message to every other window and resolve once they've all
   *  closed. The originating renderer then journals its own doc
   *  and reloads. */
  async journalAndCloseOtherWindows(): Promise<void> {
    await api().journalAndCloseOtherWindows();
  }

  /** Programmatic "close this window." Called by the please-close
   *  handler after the renderer finishes journaling. */
  async closeSelf(): Promise<void> {
    await api().closeSelf();
  }

  /** Mode-switch helper: report the docs this window journaled in
   *  response to a please-close, so the surviving window can scope
   *  its post-reload auto-recovery to exactly the switch's docs. */
  async reportModeSwitchJournaled(docs: Array<{ uid: string; dirty: boolean }>): Promise<void> {
    await api().reportModeSwitchJournaled?.(docs);
  }

  /** Mode-switch helper: fetch (and clear) the doc lists the closed
   *  windows reported. Called once by the surviving window after
   *  its reload. */
  async takeModeSwitchJournaledDocs(): Promise<Array<{ uid: string; dirty: boolean }>> {
    return (await api().takeModeSwitchJournaledDocs?.()) ?? [];
  }

  /** Subscribe to mode-switch please-close broadcasts. */
  onPleaseCloseForModeSwitch(handler: () => void): () => void {
    return api().onPleaseCloseForModeSwitch(handler);
  }

  /** Subscribe to user-initiated window close requests. Main fires
   *  this when the user clicks the OS close button so the renderer
   *  can prompt for unsaved-doc handling before the window closes. */
  onCloseRequest(handler: () => void): () => void {
    return api().onCloseRequest(handler);
  }

  /** Doc-lifecycle reporting for the main-process speech-doc
   *  registry. Renderers call this on mount and unregister on close
   *  so main knows which window owns each uid. */
  async docRegister(uid: string): Promise<void> {
    await api().docRegister(uid);
  }

  async docUnregister(uid: string): Promise<void> {
    await api().docUnregister(uid);
  }

  async docInfoUpdate(uid: string, filename: string | null): Promise<void> {
    await api().docInfoUpdate(uid, filename);
  }

  async dropzoneList(): Promise<
    Array<{ id: string; label: string; type: string; sliceJson: unknown; createdAt: number }>
  > {
    return api().dropzoneList();
  }

  async dropzoneAdd(item: {
    id: string;
    label: string;
    sliceJson: unknown;
    createdAt: number;
  }): Promise<void> {
    await api().dropzoneAdd(item);
  }

  async dropzoneRemove(id: string): Promise<void> {
    await api().dropzoneRemove(id);
  }

  async dropzoneClear(): Promise<void> {
    await api().dropzoneClear();
  }

  onDropzoneChanged(
    handler: (
      items: Array<{ id: string; label: string; type: string; sliceJson: unknown; createdAt: number }>,
    ) => void,
  ): () => void {
    return api().onDropzoneChanged(handler);
  }

  async quickCardsList(): Promise<QuickCardIpc[]> {
    return api().quickCardsList();
  }

  async quickCardsUpsert(card: QuickCardIpc): Promise<void> {
    await api().quickCardsUpsert(card);
  }

  async quickCardsBulkUpsert(cards: QuickCardIpc[]): Promise<void> {
    await api().quickCardsBulkUpsert(cards);
  }

  async quickCardsRemove(id: string): Promise<void> {
    await api().quickCardsRemove(id);
  }

  async quickCardsClear(): Promise<void> {
    await api().quickCardsClear();
  }

  onQuickCardsChanged(handler: (cards: QuickCardIpc[]) => void): () => void {
    return api().onQuickCardsChanged(handler);
  }

  async pairingConfigure(cfg: PairingConfigIpc): Promise<{ ownCode: string }> {
    return (await api().pairingConfigure?.(cfg)) ?? { ownCode: '' };
  }

  async pairingRegenerateKey(): Promise<{ ownCode: string }> {
    return (await api().pairingRegenerateKey?.()) ?? { ownCode: '' };
  }

  async pairingSend(payload: PairingSendIpc): Promise<{ ok: number; fail: number }> {
    return (
      (await api().pairingSend?.(payload)) ?? { ok: 0, fail: payload.recipientCodes.length }
    );
  }

  async pairingInboxList(): Promise<PairingInboxItemIpc[]> {
    return (await api().pairingInboxList?.()) ?? [];
  }

  async pairingInboxRemove(id: string): Promise<void> {
    await api().pairingInboxRemove?.(id);
  }

  async pairingInboxClear(): Promise<void> {
    await api().pairingInboxClear?.();
  }

  async pairingInboxMarkAllRead(): Promise<void> {
    await api().pairingInboxMarkAllRead?.();
  }

  onPairingInboxChanged(handler: (items: PairingInboxItemIpc[]) => void): () => void {
    return api().onPairingInboxChanged?.(handler) ?? (() => {});
  }

  onPairingVersionMismatch(
    handler: (info: {
      partnerVersion: string;
      localVersion: string;
      requiredVersion: string;
    }) => void,
  ): () => void {
    return api().onPairingVersionMismatch?.(handler) ?? (() => {});
  }

  async listDocs(): Promise<
    Array<{
      uid: string;
      filename: string | null;
      windowId: number;
      windowTitle: string;
      isSpeech: boolean;
      isOwnWindow: boolean;
      isFocusedWindow: boolean;
    }>
  > {
    return api().listDocs();
  }

  /** Cross-window duplicate-open guard. `openPathCheck` is the
   *  read-only pre-load probe — if another window owns the
   *  path, main focuses it for the user and returns
   *  `takenByOther: true`. `openPathRegister` claims a path on
   *  successful mount; `openPathRelease` drops the claim on
   *  unmount. Window-close auto-cleanup handles force-quits.
   *  See the IPC handlers in `apps/desktop/src/main.ts`. */
  async openPathCheck(path: string): Promise<{ takenByOther: boolean }> {
    return await api().openPathCheck(path);
  }

  async openPathRegister(path: string): Promise<void> {
    await api().openPathRegister(path);
  }

  async openPathRelease(path: string): Promise<void> {
    await api().openPathRelease(path);
  }

  async focusAnchorInWindow(
    path: string,
    descriptor: { quote: string; prefix: string; suffix: string; approxPos: number },
  ): Promise<{ delivered: boolean }> {
    const fn = api().focusAnchorInWindow;
    if (typeof fn !== 'function') return { delivered: false };
    return await fn(path, descriptor);
  }

  onFocusAnchor(
    handler: (payload: {
      descriptor: { quote: string; prefix: string; suffix: string; approxPos: number };
    }) => void,
  ): () => void {
    const fn = api().onFocusAnchor;
    return typeof fn === 'function' ? fn(handler) : () => {};
  }

  /** Set / clear the current speech-doc designation. Main broadcasts
   *  `speech:changed` to every window after any state change. */
  async speechSet(uid: string | null): Promise<void> {
    await api().speechSet(uid);
  }

  async speechGet(): Promise<{ uid: string | null }> {
    return api().speechGet();
  }

  /** Subscribe to speech-state broadcasts. Handler receives the
   *  current `{ uid }` — uid is null when no speech doc is flagged. */
  onSpeechChanged(handler: (state: { uid: string | null }) => void): () => void {
    return api().onSpeechChanged(handler);
  }

  /** Send a serialized PM slice to whichever window owns the speech
   *  doc. Returns `{ delivered, reason? }`. */
  async speechSendSlice(payload: {
    sliceJson: unknown;
    atEnd: boolean;
  }): Promise<{ delivered: boolean; reason?: string }> {
    return api().speechSendSlice(payload);
  }

  /** Subscribe to incoming speech-doc slices from other windows. */
  onIncomingSpeechSlice(
    handler: (payload: { uid: string; sliceJson: unknown; atEnd: boolean }) => void,
  ): () => void {
    return api().onIncomingSpeechSlice(handler);
  }

  /** Subscribe to menu-driven commands from the native menu bar.
   *  Mirrors the preload's `onMenuCommand` API. Returns an unsubscribe
   *  function. Not part of the cross-platform Host interface — only
   *  the desktop shell exposes a menu, so this is ElectronHost-only. */
  onMenuCommand(handler: (command: string) => void): () => void {
    return api().onMenuCommand(handler);
  }

  /** Push the current keybinding map to main so menu accelerators
   *  follow user rebinds. Callers send a fresh map on every
   *  settings change; main de-dups by reassigning its store. */
  async setMenuBindings(bindings: Record<string, string | null>): Promise<void> {
    await api().setMenuBindings(bindings);
  }

  async checkForUpdates(): Promise<{
    status: 'latest' | 'updating' | 'error' | 'dev';
    message?: string;
  }> {
    return api().checkForUpdates();
  }

  async triggerAutoUpdateCheck(): Promise<void> {
    await api().triggerAutoUpdateCheck();
  }

  async openCrashDumpsFolder(): Promise<void> {
    await api().openCrashDumpsFolder();
  }

  /** Page-zoom factor for this window. Same mechanism as the
   *  browser's Ctrl-+ — reflows the whole document including
   *  the editor surface, so chrome and doc content scale
   *  uniformly. The renderer reapplies this on every boot from
   *  the persisted `chromeScalePct` setting. */
  setZoomFactor(factor: number): void {
    api().setZoomFactor(factor);
  }

  getZoomFactor(): number {
    return api().getZoomFactor();
  }
}
