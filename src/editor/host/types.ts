/**
 * Host interface — the platform abstraction the editor talks to for
 * everything that isn't pure DOM manipulation.
 *
 * Why this exists: CardMirror runs in three contexts (regular browser
 * tab, installed PWA, native desktop binary wrapped by Electron /
 * Tauri). Each context offers a different way to open files, save
 * files, store settings, etc. The editor proper doesn't care which
 * context it's in — it calls `host.openFile()` and `host.saveAs()`
 * and the right thing happens.
 *
 * Adding a new platform = writing a new Host implementation. Adding
 * a new capability = extending this interface and implementing it in
 * each platform host.
 *
 * Lifecycle: `getHost()` (from `./index.ts`) returns the singleton
 * for the current platform, picked once at module load and never
 * swapped. Host implementations may hold internal state (e.g. cached
 * file handles for in-place saves); they're not assumed to be pure.
 */

/** File-type filter for native open/save dialogs. Mirrors Electron's
 *  `dialog.FileFilter` shape so the ElectronHost can pass it
 *  through verbatim; BrowserHost uses it to build the `<input
 *  accept="…">` attribute and the `showSaveFilePicker` types arg. */
export interface FileFilter {
  /** Human-readable label shown in the dialog (e.g. "CardMirror
   *  document"). */
  name: string;
  /** Extensions without the leading dot (e.g. `["docx"]`, `["cmir"]`,
   *  or `["docx", "cmir"]`). */
  extensions: string[];
}

/** Result of a successful `Host.openFile` — a file the user picked
 *  from a native dialog (or its web-platform equivalent). */
export interface OpenedFile {
  /** Display name (basename, no path). Used for chip labels, tab
   *  titles, and the slot-router prompt. */
  name: string;
  /** Full byte contents of the file. */
  bytes: Uint8Array;
  /** Opaque platform-specific handle that subsequent in-place saves
   *  (`Host.saveExisting`) can pass back to write to the same
   *  on-disk location. `undefined` when the platform doesn't expose
   *  a persistent reference — browsers without the File System
   *  Access API, for example. */
  handle?: unknown;
}

/** Result of a successful `Host.saveAs` — confirmation that the
 *  bytes hit storage at a user-chosen location. */
export interface SaveResult {
  /** Final filename the platform actually used. May differ from the
   *  `suggestedName` argument if the user renamed in the dialog
   *  (or if the browser's download path stripped extensions). */
  name: string;
  /** Opaque handle the future `Host.saveExisting` can use to write
   *  back to the same file without re-prompting. `undefined` when
   *  the platform can't hand one out. */
  handle?: unknown;
}

/** Options to `openFile`. */
export interface OpenFileOptions {
  /** Filters to show in the dialog. When omitted or empty, the
   *  dialog accepts any file (the BrowserHost's hidden input drops
   *  its `accept` attribute; Electron shows "All files"). The first
   *  filter is usually the default. */
  filters?: FileFilter[];
}

/** Options to `saveAs`. */
export interface SaveAsOptions {
  /** Filters to show in the save dialog. The first filter is
   *  usually used as the default format if the user doesn't pick
   *  a specific one. */
  filters?: FileFilter[];
}

/** A crash-recovery journal entry. Written every few seconds while
 *  a doc has unsaved edits; cleared on successful save or explicit
 *  close. On launch the host returns any stragglers from a previous
 *  session that crashed before they cleared.
 *
 *  The doc itself is stored as `bytes` in CardMirror native (`.cmir`)
 *  serialization — lossless and cheap to (de)serialize. The doc's
 *  *intended* on-disk format and handle are tracked separately so a
 *  recovered `.docx` doc can keep targeting Word on its next save. */
export interface JournalEntry {
  /** Stable identifier for the doc across the session — multi-doc
   *  uses its DocRecord uid; single-doc tracks one at module level.
   *  Recovery reuses the same uid so a recovered doc that crashes
   *  again overwrites the same journal slot. */
  uid: string;
  /** Last-known display name. Used in the recovery modal so the
   *  user knows what they're recovering. "Untitled" when the doc
   *  was never named. */
  filename: string;
  /** Last-known on-disk handle (Electron: absolute path string;
   *  Browser: the File System Access `FileSystemFileHandle`). Handles ARE
   *  structured-cloneable, so the browser one survives a reload via IndexedDB —
   *  a journaled/recovered doc keeps its file identity (for the duplicate-open
   *  guard, which only needs `isSameEntry`, and for in-place save, which
   *  re-requests permission on first write). `null` for never-saved docs. */
  handle: unknown;
  /** The format the doc was last saved in (or null if never saved).
   *  Drives whether a recovered + re-saved doc round-trips through
   *  `toDocx` or stays native. */
  format: 'cmir' | 'docx' | null;
  /** ISO 8601 timestamp of when this journal entry was written. */
  savedAt: string;
  /** Doc content as CardMirror native (`.cmir`) bytes — the editor
   *  passes this to `parseNative` on recovery. */
  bytes: Uint8Array;
}

/** The interface every platform host implements. New methods land
 *  here when the editor needs a new capability that varies between
 *  web and desktop. */
export interface Host {
  /** Identifier for telemetry / debug. Lowercase string, stable. */
  readonly kind: 'browser' | 'electron' | 'tauri';

  /** Show a native open-file picker. Resolve with the picked file's
   *  contents or `null` if the user cancelled. */
  openFile(opts?: OpenFileOptions): Promise<OpenedFile | null>;

  /** Show a native save-file picker pre-filled with `suggestedName`
   *  and write `bytes` to the user's chosen location. Resolve with
   *  the saved file's final name + a handle for future in-place
   *  saves, or `null` if the user cancelled. */
  saveAs(
    suggestedName: string,
    bytes: Uint8Array,
    opts?: SaveAsOptions,
  ): Promise<SaveResult | null>;

  /** Write `bytes` to the file referenced by `handle`. Used for the
   *  silent "Save" path (no dialog) — the caller already knows
   *  where the doc lives.
   *
   *  Throws when the handle is no longer writable (file deleted,
   *  moved, permissions revoked) or when the platform can't fulfil
   *  the contract — the caller can fall back to Save As in those
   *  cases. */
  saveExisting(handle: unknown, bytes: Uint8Array): Promise<void>;

  /** Ensure `handle` is writable, prompting for permission if needed, and
   *  resolve to whether write access is granted. Call this from a USER-GESTURE
   *  context (a Save click / autosave toggle) BEFORE the work that precedes the
   *  write (e.g. serialization), so the browser's readwrite permission prompt
   *  fires while the gesture's activation is still valid — and only when the
   *  user has shown save intent, not on open. No-op `true` on Electron (paths
   *  are always writable) and where there's no permission model. */
  ensureWritable(handle: unknown): Promise<boolean>;

  /** Whether this host can actually perform in-place saves. The
   *  caller uses this to decide whether to even surface the
   *  silent-Save affordance — when false, "Save" devolves into
   *  Save As. Browsers without the File System Access API return
   *  false; Electron / Tauri return true. */
  readonly supportsInPlaceSave: boolean;

  /** Persist `entry` to the journal store under `entry.uid`,
   *  overwriting any previous entry for that uid. Cheap to call —
   *  the editor fires this debounced after every doc-changing
   *  edit. */
  writeJournal(entry: JournalEntry): Promise<void>;

  /** Read every journal entry currently in the store. Called at
   *  startup to surface anything that didn't get cleared by a
   *  graceful save (i.e. the previous session crashed / was killed). */
  readJournals(): Promise<JournalEntry[]>;

  /** Remove the journal entry for `uid`. Called on successful
   *  save, on explicit close, or after the user discards a
   *  recovery offer. No-op when no journal exists for that uid. */
  deleteJournal(uid: string): Promise<void>;

  /** Read the per-user Learn store blob (flashcards, schedules, anchors,
   *  decks — the local annotation layer). `null` when none saved yet. */
  readLearnStore(): Promise<string | null>;

  /** Persist the Learn store blob (whole-blob write; caller debounces). */
  writeLearnStore(json: string): Promise<void>;

  /** Whether journaling actually persists across sessions on this
   *  host. Set to false by hosts that can't (e.g. a hypothetical
   *  browser without IndexedDB). The editor stops writing
   *  journals when this is false; the recovery modal still works
   *  on hosts where it's true. */
  readonly journalsSupported: boolean;

  /** Whether this host can spawn additional editor windows. True
   *  on Electron; false on the web edition. The "windows" workspace
   *  mode falls back to single-doc-replace UX when this is false. */
  readonly canSpawnWindow: boolean;

  /** Spawn a new editor window, optionally pre-loaded with a doc.
   *  Callers should gate on `canSpawnWindow`; on hosts that can't
   *  spawn, this rejects. */
  spawnWindow(payload: SpawnWindowPayload | null): Promise<void>;

  /** Called once at renderer boot to retrieve the initial doc the
   *  spawning window stashed for us. Returns `null` when this is
   *  the first window of a session (or the host doesn't support
   *  the spawn handshake). */
  getInitialDoc(): Promise<SpawnWindowPayload | null>;

  /** True iff this is the first window of the current app session.
   *  Used by the renderer to decide whether to surface the
   *  startup-recovery UI — only the first window should, since
   *  later windows would otherwise offer to "recover" docs the
   *  user already has open in earlier windows of the same session.
   *  On hosts that don't multi-window (web), always true. */
  isFirstWindow(): Promise<boolean>;
}

/** Payload exchanged between a spawning window and the freshly-
 *  spawned one. Carries enough provenance for the new window's
 *  renderer to mount the doc without re-prompting via the file
 *  picker. */
export interface SpawnWindowPayload {
  filename: string;
  bytes: Uint8Array;
  handle: string | null;
  format: 'cmir' | 'docx' | null;
  /** Pre-existing doc uid (when the doc is being moved between
   *  windows or recovered from a journal). Null for fresh docs. */
  uid: string | null;
  /** When true, the spawned window self-marks the new doc as the
   *  speech doc after mounting + registering its view. Used by
   *  the New Speech Document flow so the freshly-spawned window
   *  becomes the routing target for subsequent ` send-to-speech. */
  markAsSpeech?: boolean;
  /** When true, the spawned window mounts the doc DIRTY instead of
   *  the default clean. Used by the mode-switch reopen for docs
   *  that had unsaved changes — the payload bytes hold edits that
   *  exist nowhere on disk, so the close prompt must keep firing. */
  markDirty?: boolean;
  /** When set, the spawned window resolves this anchor against the
   *  mounted doc and scrolls + selects it. Used by the flashcard
   *  review's "Show in context" to open a card's source in its own
   *  window focused on the anchored text. Shape mirrors
   *  `AnchorDescriptor` (kept inline so host types don't depend on the
   *  editor layer). */
  focusAnchor?: { quote: string; prefix: string; suffix: string; approxPos: number };
}
