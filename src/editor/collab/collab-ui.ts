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
 * M2 invite transport is the share code (clipboard); pairing-mailbox
 * invites layer on later without changing anything here.
 */

import type { EditorView } from 'prosemirror-view';
import { LoroUndoPlugin, loroSyncPluginKey, loroUndoPluginKey, undo as loroUndo, redo as loroRedo } from 'loro-prosemirror';
import { settings } from '../settings.js';
import { showToast } from '../toast.js';
import { promptForText } from '../text-prompt.js';
import { markSyncOrigin } from '../sync-origin.js';
import { setCollabPluginSource, setCollabTransactionTagger } from './collab-hooks.js';
import { collabInvariantHealPlugin } from './collab-invariants.js';
import { installCommentsSync, type CommentsSyncHandle } from './collab-comments.js';
import { setCommentIdSessionMode } from '../comments-plugin.js';
import { collabEnabled, collabDevRelay } from './collab-gate.js';
import { decodeShareCode } from './collab-crypto.js';
import { RoomsClient } from './room-client.js';
import { CollabSession } from './collab-session.js';

export interface CollabUiDeps {
  getView(): EditorView | null;
  refreshPlugins(): void;
  newSessionDoc(): void;
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
    chip.textContent = '';
    return;
  }
  chip.hidden = false;
  chip.textContent = status.connected
    ? status.queuedUpdates > 0
      ? `Session: sending ${status.queuedUpdates}…`
      : 'Session: synced'
    : status.queuedUpdates > 0
      ? `Session: offline — ${status.queuedUpdates} queued`
      : 'Session: offline';
}

function relayClient(): RoomsClient | null {
  // Settings win; the dev env fallback lets the web dev build reach a
  // relay without the Electron-only Card Sharing fields.
  const dev = collabDevRelay();
  const url = (settings.get('pairingRelayUrl').trim() || dev?.url || '').replace(/\/+$/, '');
  const token = settings.get('pairingRelayToken').trim() || dev?.token || '';
  if (!url || !token) return null;
  return new RoomsClient({ baseUrl: () => url, token: () => token });
}

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

function installSeams(session: CollabSession, deps: CollabUiDeps): void {
  setCollabTransactionTagger(collabTagger);
  commentsSync = installCommentsSync(session.loroDoc, () => deps.getView());
  // Concurrent new comments must not collide on the shared map key —
  // both peers advance the same small-int counter otherwise.
  setCommentIdSessionMode(true);
  setCollabPluginSource({
    plugins: () => [
      ...session.plugins(),
      LoroUndoPlugin({ doc: session.loroDoc }),
      collabInvariantHealPlugin(),
      commentsSync!.plugin,
    ],
    ownsUndo: () => true,
    undo: loroUndo,
    redo: loroRedo,
  });
}

function clearSeams(): void {
  setCollabTransactionTagger(null);
  setCollabPluginSource(null);
  commentsSync?.dispose();
  commentsSync = null;
  setCommentIdSessionMode(false);
}

function sessionCallbacks(deps: CollabUiDeps) {
  return {
    onStatus: (s: { connected: boolean; queuedUpdates: number }) => updateChip(s),
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
  const view = guardReady(deps);
  if (!view) return;
  if (active) {
    showToast('Already in a session — end or leave it first');
    return;
  }
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
    // existing comment threads alongside the seeded doc.
    commentsSync!.seedFromView(view);
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
    showToast(`Could not start the session: ${(err as Error).message}`);
  }
}

export async function joinSessionFlow(deps: CollabUiDeps): Promise<void> {
  if (!collabEnabled()) return;
  if (active) {
    showToast('Already in a session — end or leave it first');
    return;
  }
  const client = relayClient();
  if (!client) {
    showToast('Set the relay URL and token in Settings → Card Sharing first');
    return;
  }
  const code = await promptForText({
    message: 'Paste the share code from your partner',
    placeholder: 'cmshare1.…',
    okLabel: 'Join',
  });
  if (!code) return;
  const decoded = decodeShareCode(code);
  if (!decoded) {
    showToast('That does not look like a share code');
    return;
  }
  try {
    const session = await CollabSession.join({
      ...decoded,
      client,
      callbacks: sessionCallbacks(deps),
    });
    active = { session, shareCode: code.trim() };
    installSeams(session, deps);
    // Fresh unsaved doc; buildEditorPlugins now includes the binding,
    // which replaces the empty content from the session state.
    deps.newSessionDoc();
    // The join snapshot already carries the host's thread map — land it
    // in the fresh pane's plugin state.
    commentsSync!.pull();
    session.start();
    updateChip({ connected: true, queuedUpdates: 0 });
    showToast('Joined the session');
  } catch (err) {
    active = null;
    clearSeams();
    showToast(`Could not join: ${(err as Error).message}`);
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

export async function endSessionFlow(deps: CollabUiDeps): Promise<void> {
  if (!active) {
    showToast('No active session');
    return;
  }
  const isHost = active.session.role === 'host';
  const ok = window.confirm(
    isHost
      ? 'End the session for everyone? Participants keep their current copy.'
      : 'Leave the session? Your copy stays as it is now.',
  );
  if (!ok) return;
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
  }
}

/** Test seam: current session state. */
export function activeSession(): CollabSession | null {
  return active?.session ?? null;
}
