/**
 * Collaboration-session UI flows: start / join / copy-code / end,
 * wired to the ribbon commands, plus the status-bar chip. Lazily
 * imported (this module pulls the Loro wasm via collab-session).
 *
 * One session per window at a time, bound to the single-doc view. The
 * flows own the editor's collab seams (collab-hooks): while a session
 * is live they register the plugin source (Loro sync + undo manager),
 * the transaction tagger (stamps sync-origin on the binding's remote
 * transactions so read mode and the AI coordinator admit them), and
 * refresh the plugin stack through the injected reconfigure capability.
 *
 * Invite transport: the share code (clipboard) and, on desktop, sealed
 * pairing-mailbox invites (inviteStarredFlow / joinSessionWithCode via
 * the Receive pill's Join).
 */

import type { EditorView } from 'prosemirror-view';
import { LoroUndoPlugin, loroSyncPluginKey, loroUndoPluginKey, undo as loroUndo, redo as loroRedo } from 'loro-prosemirror';
import { settings } from '../settings.js';
import { showToast } from '../toast.js';
import { promptForText, promptForChoice } from '../text-prompt.js';
import { markSyncOrigin } from '../sync-origin.js';
import { readModePlugin } from '../read-mode-plugin.js';
import { setCollabPluginSource, setCollabTransactionTagger } from './collab-hooks.js';
import { RoomsError } from './room-client.js';
import { getElectronHost } from '../host/index.js';
import { ensureBakedRelay, relayClient } from './collab-relay.js';
import { relayClient as pairingRelayClient } from '../pairing/relay-client.js';
import { resolveStarredTarget } from '../pairing/send-to-starred.js';
import { buildRoomInviteItem, ROOM_INVITE_MIN_VERSION } from '../pairing/room-invite.js';
import { collabInvariantHealPlugin } from './collab-invariants.js';
import { installCommentsSync, type CommentsSyncHandle } from './collab-comments.js';
import { attachSessionPersistence, type PersistHandle } from './collab-persist.js';
import { installCursorPresence, type CursorsHandle } from './collab-cursors.js';
import { collabRepairPlugin, lowestPeerIsLeader } from './collab-repair.js';
import { loadSessionRecord, loadPrefetch, deletePrefetch } from './collab-store.js';
import { importRoomKey, decryptBlob } from './collab-crypto.js';
import { setCommentIdSessionMode } from '../comments-plugin.js';
import { collabEnabled } from './collab-gate.js';
import { decodeShareCode } from './collab-crypto.js';
import { CollabSession } from './collab-session.js';

export interface CollabUiDeps {
  getView(): EditorView | null;
  refreshPlugins(): void;
  /** The `DocRecord.uid` of the document this session is being started/joined
   *  for — captured at install so the binding plugins only ever attach to that
   *  one doc's view (multi-pane fusion guard). */
  getOwnerUid?(): string | null;
  /** Swap THIS window's editor to a fresh unsaved doc for a joined
   *  session — must never spawn a window (the binding installs into the
   *  current view; a spawned window would never get it — field bug on
   *  desktop, 2026-07-03). Resolves false if the user cancelled out of
   *  overwriting unsaved edits. */
  newSessionDoc(): boolean | Promise<boolean>;
  /** Name the (unsaved) session doc in this window: window title, the
   *  filename chip, and the save-as default. Joiners get the host's
   *  title through the room's meta map — without this the window and
   *  the Sessions list just say "collaboration session" (field bug,
   *  2026-07-03). */
  setDocTitle?(title: string): void;
  /** Desktop multi-window: when the current window has a real doc open (not
   *  the disposable starter), spawn a NEW window to host the joined session
   *  and return true — the caller then aborts, and the spawned window runs
   *  the full join itself (so the session + Loro binding land together,
   *  never stranded). Returns false to join in THIS window (starter open, or
   *  single-window / web). */
  spawnJoinWindow?(shareCode: string): boolean;
}

interface ActiveState {
  session: CollabSession;
  shareCode: string;
}

let active: ActiveState | null = null;

function chipEl(): HTMLElement | null {
  return document.getElementById('collab-chip');
}

function updateChip(status: { connected: boolean; queuedUpdates: number } | null): void {
  const chip = chipEl();
  if (!chip) return;
  if (!status) {
    chip.hidden = true;
    chip.replaceChildren();
    return;
  }
  chip.hidden = false;
  const text = status.connected
    ? status.queuedUpdates > 0
      ? `Session: sending ${status.queuedUpdates}…`
      : 'Session: synced'
    : status.queuedUpdates > 0
      ? `Session: offline — ${status.queuedUpdates} queued`
      : 'Session: offline';
  // Chip = a text label + a presence-dots strip (kept as stable children so
  // the dots can refresh on their own timer without rebuilding the label).
  let label = chip.querySelector('.pmd-collab-chip-label');
  let dots = chip.querySelector('.pmd-collab-chip-dots');
  if (!(label instanceof HTMLElement) || !(dots instanceof HTMLElement)) {
    chip.replaceChildren();
    label = document.createElement('span');
    label.className = 'pmd-collab-chip-label';
    chip.appendChild(label);
    dots = document.createElement('span');
    dots.className = 'pmd-collab-chip-dots';
    chip.appendChild(dots);
  }
  label.textContent = text;
  renderPresenceDots(dots as HTMLElement);
}

/** One colored dot per person in the room, hover for the name. */
function renderPresenceDots(container: HTMLElement): void {
  const peers = cursors?.presence() ?? [];
  container.replaceChildren();
  for (const p of peers) {
    const dot = document.createElement('span');
    dot.className = 'pmd-collab-presence-dot' + (p.self ? ' pmd-collab-presence-dot-self' : '');
    dot.style.background = p.color;
    dot.title = p.self ? `${p.name} (you)` : p.name;
    container.appendChild(dot);
  }
}

/** Re-render just the dots (peers join/leave/expire between chip updates). */
function refreshPresenceDots(): void {
  const dots = chipEl()?.querySelector('.pmd-collab-chip-dots');
  if (dots instanceof HTMLElement) renderPresenceDots(dots);
}

let presenceTimer: ReturnType<typeof setInterval> | null = null;


/** Stamp the Loro binding's own transactions as sync-origin: both the
 *  remote-update imports and the init-time content replace carry the
 *  binding's meta, and neither is a user edit — read mode and the AI
 *  coordinator must admit them (rejection desyncs editor from CRDT). */
function collabTagger(tr: Parameters<typeof markSyncOrigin>[0]): void {
  if (tr.getMeta(loroSyncPluginKey) !== undefined || tr.getMeta(loroUndoPluginKey) !== undefined) {
    markSyncOrigin(tr);
  }
}

let commentsSync: CommentsSyncHandle | null = null;
let persist: PersistHandle | null = null;
let cursors: CursorsHandle | null = null;
let wakeCleanup: (() => void) | null = null;

/** Wake-from-sleep / network-return hooks (M3): a resumed laptop's
 *  stream socket is silently dead until timeouts notice — restart it
 *  the moment the OS tells us. Desktop: powerMonitor via the host
 *  seam; both editions: the browser 'online' event. */
function installWakeHooks(session: CollabSession): void {
  const onOnline = (): void => session.restart();
  window.addEventListener('online', onOnline);
  const offResume = getElectronHost()?.onPowerResumed?.(() => session.restart()) ?? null;
  wakeCleanup = () => {
    window.removeEventListener('online', onOnline);
    offResume?.();
  };
}

function installSeams(session: CollabSession, deps: CollabUiDeps): void {
  // The doc this session owns, captured now (the session's doc is focused at
  // install time for host / join / resume). Only this uid's view gets the
  // binding plugins — see CollabPluginSource.ownerUid.
  const ownerUid = deps.getOwnerUid?.() ?? null;
  setCollabTransactionTagger(collabTagger);
  installWakeHooks(session);
  commentsSync = installCommentsSync(session.loroDoc, () => deps.getView());
  // M3: crash-surviving session record (the home screen's Sessions
  // list resumes from it). Cleared only on explicit end/leave or a
  // remote tombstone — a crash leaving it behind is the feature.
  persist = attachSessionPersistence(session, active!.shareCode, () =>
    sessionDocTitle() || sharedDocTitle(session),
  );
  cursors = installCursorPresence(session, () => deps.getView());
  // Keep the presence dots current as peers join / leave / time out — the
  // chip text only updates on connection-status changes, not presence ones.
  if (presenceTimer === null) presenceTimer = setInterval(refreshPresenceDots, 3000);
  // Concurrent new comments must not collide on the shared map key —
  // both peers advance the same small-int counter otherwise.
  setCommentIdSessionMode(true);
  setCollabPluginSource({
    ownerUid,
    plugins: () => [
      ...session.plugins(),
      LoroUndoPlugin({ doc: session.loroDoc }),
      collabInvariantHealPlugin(),
      collabRepairPlugin(() =>
        lowestPeerIsLeader(session.loroDoc.peerIdStr, cursors?.visiblePeers() ?? []),
      ),
      commentsSync!.plugin,
      ...(cursors?.plugins() ?? []),
    ],
    ownsUndo: () => true,
    // Read-mode clamp (M4): swallow undo/redo entirely while reading.
    // The Loro undo manager can't be depth-bounded the way
    // prosemirror-history is (readModeAwareUndo's baseUndoDepth trick),
    // and its transactions carry the binding meta → sync-origin →
    // they'd sail through the read-mode lock and revert real edits
    // from under a "reading" user. Reading-marker drops lose keyboard
    // undo in sessions; markers remain removable by click.
    undo: (state, dispatch, view) =>
      readModePlugin.getState(state)?.on ? true : loroUndo(state, dispatch, view),
    redo: (state, dispatch, view) =>
      readModePlugin.getState(state)?.on ? true : loroRedo(state, dispatch, view),
  });
}

function clearSeams(keepRecord = false): void {
  setCollabTransactionTagger(null);
  setCollabPluginSource(null);
  wakeCleanup?.();
  wakeCleanup = null;
  commentsSync?.dispose();
  commentsSync = null;
  cursors?.dispose();
  cursors = null;
  if (presenceTimer !== null) {
    clearInterval(presenceTimer);
    presenceTimer = null;
  }
  setCommentIdSessionMode(false);
  // Terminal paths (explicit end/leave, remote tombstone, failed join)
  // drop the persisted record; a cancelled RESUME keeps it — the user
  // only declined the doc swap, the session is still theirs to resume.
  if (keepRecord) persist?.dispose();
  else void persist?.clear();
  persist = null;
}

function sessionCallbacks(deps: CollabUiDeps) {
  return {
    onStatus: (s: { connected: boolean; queuedUpdates: number }) => updateChip(s),
    onPresence: (bytes: Uint8Array) => cursors?.applyRemote(bytes),
    onBacklogMerged: (count: number) => {
      // Merge-visibility (M3): a travel-day backlog just landed — say
      // so, instead of the doc silently reshaping under the user.
      showToast(`Synced ${count} offline updates from the session — recent sections may have moved`);
    },
    onEnded: () => {
      // The explicit end/leave flows clean up themselves before the
      // session's onEnded fires; only a REMOTELY ended session (host
      // ended it, room GC'd) reaches past this guard.
      if (!active) return;
      const wasHost = active.session.role === 'host';
      active = null;
      clearSeams();
      updateChip(null);
      deps.refreshPlugins();
      showToast(
        wasHost
          ? 'Collaboration session ended'
          : 'Session ended — this copy is now yours alone',
      );
    },
    onFull: () => {
      showToast('That session is full (10 participants)');
    },
  };
}

/** Turn a relay failure into a user-actionable message. A 401 is the
 *  gating/auth signal — for INITIATING a session (send-gated per §5.4:
 *  paid initiates, free joins) that means a subscription is required;
 *  for join/resume it means the relay rejected the credentials. The
 *  401 is inherently ambiguous between "hosted relay, needs a paid
 *  account" and "self-host, wrong token", so the message names both
 *  without asserting which. Any non-401 keeps its raw reason. */
export function relayFailureMessage(err: unknown, opts: { initiating: boolean; verb: string }): string {
  if (err instanceof RoomsError && err.status === 401) {
    return opts.initiating
      ? 'Starting a collaboration session requires a relay. In Settings → Card ' +
          'Sharing, connect your Debate Decoded account or set up your own relay.'
      : 'The session relay rejected your credentials. In Settings → Card Sharing, ' +
          'connect your Debate Decoded account or set up your own relay.';
  }
  return `Could not ${opts.verb}: ${(err as Error).message}`;
}

function guardReady(deps: CollabUiDeps): EditorView | null {
  if (!collabEnabled()) return null;
  const view = deps.getView();
  if (!view) {
    showToast('Collaboration sessions need a single-document window');
    return null;
  }
  return view;
}

export async function startSessionFlow(deps: CollabUiDeps): Promise<void> {
  if (!collabEnabled()) return; // desktop-only; inert on the web edition
  const view = guardReady(deps);
  if (!view) return;
  if (active) {
    showToast('Already in a session — end or leave it first');
    return;
  }
  await ensureBakedRelay();
  const client = relayClient();
  if (!client) {
    showToast('Set the relay URL and token in Settings → Card Sharing first');
    return;
  }
  try {
    const { session, shareCode } = await CollabSession.host({
      pmDoc: view.state.doc,
      client,
      callbacks: sessionCallbacks(deps),
    });
    active = { session, shareCode };
    installSeams(session, deps);
    // Seed before start(): the first flush then carries the host's
    // existing comment threads alongside the seeded doc — and the doc
    // title, so joiners can name their unsaved copy.
    commentsSync!.seedFromView(view);
    session.loroDoc.getMap('meta').set('title', sessionDocTitle());
    session.loroDoc.commit();
    deps.refreshPlugins();
    session.start();
    updateChip({ connected: true, queuedUpdates: 0 });
    const copied = await navigator.clipboard?.writeText(shareCode).then(
      () => true,
      () => false,
    );
    showToast(
      copied
        ? 'Session started — share code copied, send it to your partner'
        : 'Session started — use "Copy Session Share Code" to invite',
    );
  } catch (err) {
    showToast(relayFailureMessage(err, { initiating: true, verb: 'start the session' }));
  }
}

export async function joinSessionFlow(deps: CollabUiDeps): Promise<void> {
  if (!collabEnabled()) return;
  const code = await promptForText({
    message: 'Paste the share code from your partner',
    placeholder: 'cmshare1.…',
    okLabel: 'Join',
  });
  if (!code) return;
  await joinSessionWithCode(deps, code);
}

/** Join with a code in hand — the prompt flow above and the Receive
 *  pill's invite Join both land here. */
export async function joinSessionWithCode(deps: CollabUiDeps, code: string): Promise<void> {
  if (!guardReady(deps)) return;
  // Don't overwrite the doc you're working in — or bump the session you're
  // already in: unless this window holds the disposable starter, hand the
  // join to a fresh window (which re-enters here with the starter open, so it
  // joins in place). Runs BEFORE the `active` guard and the session creation,
  // so an active-session window opens the new join elsewhere instead of
  // refusing, and the session + binding are born in the window that keeps them.
  if (deps.spawnJoinWindow?.(code.trim())) return;
  if (active) {
    showToast('Already in a session — end or leave it first');
    return;
  }
  await ensureBakedRelay();
  const client = relayClient();
  if (!client) {
    showToast('Set the relay URL and token in Settings → Card Sharing first');
    return;
  }
  const decoded = decodeShareCode(code);
  if (!decoded) {
    showToast('That does not look like a share code');
    return;
  }
  try {
    let session: CollabSession;
    let joinedOffline = false;
    try {
      session = await CollabSession.join({
        ...decoded,
        client,
        callbacks: sessionCallbacks(deps),
      });
    } catch (err) {
      // Offline (or relay unreachable): fall back to the invite's
      // prefetched seed (§4.1). Everything in it came FROM the room,
      // so resume() with no sentVersion is exact; start() syncs at the
      // next connectivity window.
      const pre = await loadPrefetch(decoded.roomId);
      if (!pre) throw err;
      const key = await importRoomKey(decoded.keyBytes);
      const blobs = await Promise.all(pre.blobs.map((b) => decryptBlob(key, b)));
      session = await CollabSession.resume({
        roomId: decoded.roomId,
        keyBytes: decoded.keyBytes,
        role: 'participant',
        snapshot: blobs[0]!,
        increments: blobs.slice(1),
        lastSeq: pre.lastSeq,
        client,
        callbacks: sessionCallbacks(deps),
      });
      joinedOffline = true;
    }
    void deletePrefetch(decoded.roomId);
    active = { session, shareCode: code.trim() };
    installSeams(session, deps);
    // Fresh unsaved doc IN THIS WINDOW; buildEditorPlugins now includes
    // the binding, which replaces the empty content from the session
    // state. A false return = the user balked at overwriting unsaved
    // edits — unwind without touching the room.
    if (!(await deps.newSessionDoc())) {
      active = null;
      clearSeams();
      await session.stop();
      updateChip(null);
      showToast('Join cancelled');
      return;
    }
    // The join snapshot already carries the host's thread map — land it
    // in the fresh pane's plugin state; same for the published title.
    commentsSync!.pull();
    adoptSharedTitle(deps, session);
    session.start();
    updateChip({ connected: !joinedOffline, queuedUpdates: 0 });
    showToast(
      joinedOffline
        ? 'Joined from the prefetched copy — will sync when you reconnect'
        : 'Joined the session',
    );
    deps.getView()?.focus();
  } catch (err) {
    active = null;
    clearSeams();
    showToast(relayFailureMessage(err, { initiating: false, verb: 'join' }));
  }
}

/** Resume a persisted session (home-screen Sessions list, M3). The
 *  persisted CRDT carries this peer's full history — including edits
 *  that never reached the relay before the app died — so start()'s
 *  first flush sends exactly the unsent diff and catch-up resumes from
 *  the stored cursor. A tombstoned room degrades through the normal
 *  onEnded path ("this copy is now yours alone") and clears the record. */
export async function resumeSessionFlow(deps: CollabUiDeps, roomId: string): Promise<void> {
  if (!collabEnabled()) return; // desktop-only; inert on the web edition
  if (!guardReady(deps)) return;
  if (active) {
    showToast(
      active.session.roomId === roomId
        ? 'That session is already active in this window'
        : 'Already in a session — end or leave it first',
    );
    return;
  }
  const record = await loadSessionRecord(roomId);
  if (!record) {
    showToast('No saved session to resume');
    return;
  }
  await ensureBakedRelay();
  const client = relayClient();
  if (!client) {
    showToast('Set the relay URL and token in Settings → Card Sharing first');
    return;
  }
  const decoded = decodeShareCode(record.shareCode);
  if (!decoded) {
    showToast('Saved session record is unreadable');
    return;
  }
  try {
    const session = await CollabSession.resume({
      roomId: record.roomId,
      keyBytes: decoded.keyBytes,
      role: record.role,
      snapshot: record.snapshot,
      increments: record.increments,
      lastSeq: record.lastSeq,
      sentVersion: record.sentVersion,
      client,
      callbacks: sessionCallbacks(deps),
    });
    active = { session, shareCode: record.shareCode };
    installSeams(session, deps);
    if (!(await deps.newSessionDoc())) {
      active = null;
      clearSeams(true); // keep the record — still resumable later
      await session.stop();
      updateChip(null);
      showToast('Resume cancelled');
      return;
    }
    commentsSync!.pull();
    adoptSharedTitle(deps, session);
    session.start();
    updateChip({ connected: false, queuedUpdates: session.queuedUpdates });
    showToast('Session resumed — syncing');
    deps.getView()?.focus();
  } catch (err) {
    active = null;
    clearSeams();
    showToast(relayFailureMessage(err, { initiating: false, verb: 'resume' }));
  }
}

export async function copyShareCodeFlow(): Promise<void> {
  if (!active) {
    showToast('No active session');
    return;
  }
  const ok = await navigator.clipboard?.writeText(active.shareCode).then(
    () => true,
    () => false,
  );
  showToast(ok ? 'Share code copied' : 'Could not copy the share code');
}

/** The host-published doc title from the room's meta map ('' when the
 *  host predates title publishing or hasn't named the doc). */
function sharedDocTitle(session: CollabSession): string {
  const t = session.loroDoc.getMap('meta').get('title');
  return typeof t === 'string' ? t.trim() : '';
}

/** Adopt the shared title in this window (joiner/resume paths). */
function adoptSharedTitle(deps: CollabUiDeps, session: CollabSession): void {
  const title = sharedDocTitle(session);
  if (title) deps.setDocTitle?.(title);
}

/** Current doc title for invite labels: document.title is
 *  `${filename} — CardMirror` in the single-doc windows sessions run
 *  in ('CardMirror' when untitled → ''). */
function sessionDocTitle(): string {
  const t = document.title;
  const cut = t.lastIndexOf(' — CardMirror');
  if (cut > 0) return t.slice(0, cut);
  return t === 'CardMirror' ? '' : t;
}

/** Shared invite-send tail: sealed pairing message, version-floored so
 *  pre-invite clients get the update-required toast instead of a dead
 *  card row. Assumes an active session. */
async function sendInviteTo(target: { codes: string[]; label: string; via?: string }): Promise<void> {
  const item = buildRoomInviteItem({
    shareCode: active!.shareCode,
    title: sessionDocTitle(),
  });
  const res = await pairingRelayClient.send(target.codes, item, {
    via: target.via,
    minReceiverVersion: ROOM_INVITE_MIN_VERSION,
  });
  if (res.fail === 0) showToast(`Invited ${target.label} ✓`);
  else if (res.ok === 0) showToast(`Couldn't reach ${target.label}`);
  else showToast(`Invited ${target.label} (${res.fail} failed)`);
}

/** Send a session invite to the starred partner/group. */
export async function inviteStarredFlow(): Promise<void> {
  if (!collabEnabled()) return;
  if (!active) {
    showToast('No active session — start one first');
    return;
  }
  if (!settings.get('pairingEnabled')) {
    showToast('Card sharing is off — invites travel through it');
    return;
  }
  const target = resolveStarredTarget(
    settings.get('pairingStarred'),
    settings.get('pairingPartners'),
    settings.get('pairingGroups'),
  );
  if (!target) {
    showToast('Star a partner or group in the Send pill first');
    return;
  }
  if (target.codes.length === 0) {
    showToast('The starred group has no recipients yet');
    return;
  }
  await sendInviteTo(target);
}

/** The Send pill's click-to-invite (§6 picker-first flow): with no
 *  active session, START one on the current doc, then invite the
 *  picked partner/group; with one active, just invite. */
export async function inviteTargetFlow(
  deps: CollabUiDeps,
  target: { codes: string[]; label: string; via?: string },
): Promise<void> {
  if (!collabEnabled()) return;
  if (!settings.get('pairingEnabled')) {
    showToast('Card sharing is off — invites travel through it');
    return;
  }
  if (target.codes.length === 0) {
    showToast('That group has no recipients yet');
    return;
  }
  if (!active) {
    await startSessionFlow(deps);
    if (!active) return; // start failed/cancelled — its toast explains
  }
  await sendInviteTo(target);
}

export async function endSessionFlow(deps: CollabUiDeps): Promise<void> {
  if (!active) {
    showToast('No active session');
    return;
  }
  const isHost = active.session.role === 'host';
  // In-app overlay, NOT window.confirm: Electron's native confirm on
  // Windows/Linux never hands keyboard focus back to the renderer —
  // the editor was untypeable until a reload (field bug, 2026-07-03).
  const choice = await promptForChoice({
    message: isHost ? 'End the session for everyone?' : 'Leave the session?',
    detail: isHost
      ? 'Participants keep their current copy.'
      : 'Your copy stays as it is now.',
    choices: [{ value: 'confirm', label: isHost ? 'End Session' : 'Leave Session' }],
  });
  if (choice !== 'confirm') return;
  const { session } = active;
  active = null;
  try {
    if (isHost) await session.end();
    else await session.stop();
  } finally {
    clearSeams();
    updateChip(null);
    deps.refreshPlugins();
    showToast(isHost ? 'Session ended' : 'Left the session');
    deps.getView()?.focus();
  }
}

/** Test seam: current session state. */
export function activeSession(): CollabSession | null {
  return active?.session ?? null;
}
