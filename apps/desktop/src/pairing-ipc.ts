/**
 * Pairing main-process bridge — cross-machine card sharing.
 *
 * The main process is the single owner of:
 *   - the X25519 keypair (this machine's identity; private key in userData,
 *     never exposed to a renderer or the relay);
 *   - the relay base URL + bearer token (baked build constants; settings and
 *     env overrides for self-hosted relays);
 *   - the background delivery channel — an SSE push stream with poll
 *     catch-up, or interval polling against legacy relays (one channel,
 *     shared by all windows);
 *   - the inbox of received cards (persisted to userData, broadcast to
 *     every window via `pairing:inbox-changed`).
 *
 * DELIVERY: the relay live-pushes new cards over `GET /relay/stream` (see
 * relay-stream.ts); on every (re)connect — and on wake-from-sleep — the
 * client runs one catch-up `GET /messages`, so the store-and-forward
 * guarantee is unchanged. Relays without the stream endpoint (404) get
 * today's interval polling for the whole session. Delivery is
 * at-least-once; the `consumed` / `rx-<msgId>` dedupe absorbs overlap
 * between push and catch-up.
 *
 * END-TO-END ENCRYPTED: every card is sealed to the recipient's public key
 * (sealed box; see pairing-crypto.ts) before it leaves this process, and the
 * host sees only an opaque ciphertext bundle plus a hashed routing code. The
 * sender identity, group label, schema version, and card content all live
 * INSIDE the ciphertext — the relay host can interpret none of it.
 *
 * Addressing is DIRECTED: each machine receives only its own routing code
 * and never sends to itself, so there is no self-echo and no delete race.
 *
 * The relay contract here is identical to the scouting-assistant `/relay` API,
 * so pointing at production is a one-line change to DEFAULT_RELAY_URL.
 */

import { app, BrowserWindow, ipcMain, powerMonitor } from 'electron';
import { gzipSync } from 'node:zlib';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createPairingKeystore, routingId, type PairingKeystore, type SealedBundle } from './pairing-crypto.js';
import { BUILT_IN_RELAY_TOKEN } from './pairing-build.js';
import { RelayStream } from './relay-stream.js';
import {
  entitlementIfValid,
  interpretConnectResponse,
  parseStoredEntitlement,
  renewalDue,
  type ConnectOutcome,
  type ConnectResponseBody,
  type EntitlementState,
} from './pairing-entitlement.js';

/** Relay endpoint defaults. Resolution order (see relayUrl()/relayToken()):
 *  user settings (self-hosted relay) → env override → baked default. Env
 *  overrides point dev at the local mock, e.g.:
 *    PAIRING_RELAY_URL=http://127.0.0.1:3200 PAIRING_TOKEN=dev-pairing-token \
 *      npm run desktop:dev
 *
 *  The URL is not secret and is baked in. The TOKEN is NOT hard-coded here:
 *  this is a PUBLIC repo, so the real relay token is injected at build/run
 *  time via PAIRING_TOKEN (a packaged installer is built with that env set).
 *  It's only light gating anyway — the card payload is end-to-end encrypted,
 *  so the relay host can't read it.
 *
 *  NOTE: a double-clicked packaged app does not inherit shell env, so a
 *  distributed build must have PAIRING_TOKEN present in its BUILD env to bake
 *  the token into the artifact. For `desktop:dev` (launched from a shell) the
 *  env var is read directly at runtime. */
const DEFAULT_RELAY_URL =
  process.env.PAIRING_RELAY_URL || 'https://scouting-assistant.up.railway.app/relay';
const DEFAULT_RELAY_TOKEN = process.env.PAIRING_TOKEN || BUILT_IN_RELAY_TOKEN || 'dev-pairing-token';

interface PairingConfig {
  enabled: boolean;
  displayName: string;
  schemaVersion: string;
  /** Compatibility floor this build stamps on outgoing cards — the minimum
   *  receiver version that can read them. Blank = any version may receive. */
  minReceiverVersion: string;
  pollSeconds: number;
  /** Self-hosted relay base URL ('' = the official relay). */
  relayUrl: string;
  /** Bearer for a self-hosted relay ('' = the baked official token). */
  relayToken: string;
}

/** Effective relay base URL: settings override → env/baked default. */
function relayUrl(): string {
  const custom = config.relayUrl.trim().replace(/\/+$/, '');
  return custom || DEFAULT_RELAY_URL;
}

/** Effective bearer. This supplier is the single seam of the
 *  account-entitlement flow — everything (POST, GET, DELETE, stream)
 *  routes its Authorization through here. A valid stored entitlement is
 *  preferred for the OFFICIAL relay (which accepts it alongside the
 *  shared token while it runs ungated — linking an account is optional
 *  during the beta and gates nothing); custom self-hosted relays always
 *  use their own token, never entitlements. */
function relayToken(): string {
  const custom = config.relayToken.trim();
  if (custom) return custom;
  if (!config.relayUrl.trim()) {
    const ent = validEntitlement();
    if (ent) return ent.entitlement;
  }
  return DEFAULT_RELAY_TOKEN;
}

interface SendItem {
  label: string;
  type: string;
  sliceJson: unknown;
}

/** The plaintext sealed inside each message — never visible to the host. */
interface InnerPayload {
  schemaVersion?: string;
  /** Compatibility floor: the minimum receiver version that can read this card.
   *  Absent/blank = any version may receive it (the tolerant default). */
  minReceiverVersion?: string;
  senderCode?: string;
  senderName?: string;
  via?: string;
  item?: SendItem;
}

interface InboxItem {
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

/** What the relay returns per stored message: routing metadata in the clear
 *  plus the opaque encrypted bundle. */
interface RelayMessage extends Partial<SealedBundle> {
  msgId: string;
  recipientCode?: string;
  sentAt?: number;
  receivedAt?: number;
}

let config: PairingConfig = {
  enabled: false,
  displayName: '',
  schemaVersion: 'unknown',
  minReceiverVersion: '',
  pollSeconds: 30,
  relayUrl: '',
  relayToken: '',
};
/** Interval poller — legacy-relay fallback mode only. */
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** Low-frequency belt-and-suspenders catch-up while streaming. */
let catchupTimer: ReturnType<typeof setInterval> | null = null;
/** Live push stream (null while disabled or in fallback-poll mode). */
let stream: RelayStream | null = null;
/** Relay base URL that 404'd on /stream this session — don't re-probe it
 *  on every settings change; a DIFFERENT URL gets a fresh probe. */
let streamUnsupportedUrl: string | null = null;
let polling = false;
/** msgIds already handled this session — guards against re-processing if a
 *  DELETE failed (the message would still be on the relay next poll), and
 *  absorbs push/catch-up overlap (at-least-once delivery). */
const consumed = new Set<string>();

// ── Keystore (this machine's X25519 identity) ────────────────────────

let keystore: PairingKeystore | null = null;
function ks(): PairingKeystore {
  if (!keystore) {
    keystore = createPairingKeystore(path.join(app.getPath('userData'), 'pairing-keys.json'));
  }
  return keystore;
}

// ── Blog-account entitlement (persisted; optional during the beta) ────

let entitlementState: EntitlementState | null = null;
let entitlementLoaded = false;
/** Guards against overlapping renewal calls. */
let renewing = false;

function entitlementPath(): string {
  return path.join(app.getPath('userData'), 'pairing-entitlement.json');
}

async function ensureEntitlementLoaded(): Promise<void> {
  if (entitlementLoaded) return;
  entitlementLoaded = true;
  try {
    entitlementState = parseStoredEntitlement(
      JSON.parse(await fs.readFile(entitlementPath(), 'utf8')),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[pairing] Failed to read pairing-entitlement.json:', err);
    }
  }
}

async function persistEntitlement(): Promise<void> {
  try {
    if (entitlementState === null) {
      await fs.unlink(entitlementPath()).catch(() => {});
    } else {
      await fs.writeFile(entitlementPath(), JSON.stringify(entitlementState));
    }
  } catch (err) {
    console.warn('[pairing] Failed to persist entitlement:', err);
  }
}

function validEntitlement(): EntitlementState | null {
  return entitlementIfValid(entitlementState, Date.now());
}

function accountStatus(): {
  enabled: boolean;
  connected: boolean;
  expiresAt: number;
  email: string;
} {
  return {
    // Always available on desktop. The renderer's settings row keys its
    // visibility off this flag, so an older renderer paired with this
    // main still behaves.
    enabled: true,
    connected: validEntitlement() !== null,
    expiresAt: entitlementState?.expiresAt ?? 0,
    email: entitlementState?.email ?? '',
  };
}

function broadcastEntitlement(extra?: { evicted?: boolean; lapsed?: boolean }): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      w.webContents.send('pairing:entitlement-changed', { ...accountStatus(), ...extra });
    }
  }
}

async function connectAccount(connectCode: string, confirmEvict: boolean): Promise<ConnectOutcome> {
  await ensureEntitlementLoaded();
  // Code-less renewal must prove continuity: present the stored
  // entitlement (even a recently-expired one — the relay accepts a
  // 30-day grace) as the bearer. A bare routing code mints nothing.
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!connectCode.trim() && entitlementState) {
    headers['Authorization'] = `Bearer ${entitlementState.entitlement}`;
  }
  let res: Response;
  try {
    res = await fetch(`${relayUrl()}/connect`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        connectCode: connectCode.trim(),
        routingCode: ks().ownRoutingId(),
        confirmEvict,
      }),
    });
  } catch (err) {
    console.warn('[pairing] connect failed:', err);
    return { ok: false, error: 'network' };
  }
  const body = (await res.json().catch(() => ({}))) as ConnectResponseBody;
  const { outcome, next, evicted } = interpretConnectResponse(res.status, body, entitlementState);
  if (next !== undefined) {
    entitlementState = next;
    await persistEntitlement();
    broadcastEntitlement(evicted ? { evicted: true } : undefined);
  }
  return outcome;
}

/** Renew the entitlement when it is inside its final 24h (or already
 *  expired). Code-less renewal — the relay refreshes active bindings
 *  freely; a 409 here means this machine's seat was taken. */
async function maybeRenewEntitlement(): Promise<void> {
  if (renewing || config.relayUrl.trim()) return;
  await ensureEntitlementLoaded();
  if (entitlementState === null) return;
  if (!renewalDue(entitlementState, Date.now())) return;
  renewing = true;
  try {
    const outcome = await connectAccount('', false);
    if (outcome.ok) {
      console.log('[pairing] entitlement renewed');
    } else if (outcome.error === 'evicted') {
      console.warn('[pairing] this machine was unlinked from the blog account');
    } else if (outcome.error === 'subscription') {
      broadcastEntitlement({ lapsed: true });
    }
  } finally {
    renewing = false;
  }
}

// ── Inbox state (persisted, broadcast) ───────────────────────────────

let inbox: InboxItem[] = [];
let inboxLoaded = false;

function inboxPath(): string {
  return path.join(app.getPath('userData'), 'pairing-inbox.json');
}

async function ensureInboxLoaded(): Promise<void> {
  if (inboxLoaded) return;
  inboxLoaded = true;
  try {
    const text = await fs.readFile(inboxPath(), 'utf8');
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.items)) {
      inbox = parsed.items.filter(
        (it: unknown): it is InboxItem =>
          !!it && typeof it === 'object' && typeof (it as InboxItem).id === 'string',
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[pairing] Failed to read pairing-inbox.json:', err);
    }
    inbox = [];
  }
}

let inboxWriteTail: Promise<void> = Promise.resolve();
function persistInbox(): Promise<void> {
  const snapshot = inbox;
  inboxWriteTail = inboxWriteTail.catch(() => {}).then(async () => {
    const finalPath = inboxPath();
    const tmpPath = `${finalPath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify({ version: 1, items: snapshot }));
    await fs.rename(tmpPath, finalPath);
  });
  return inboxWriteTail;
}

function broadcastInbox(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('pairing:inbox-changed', inbox);
  }
}

let lastUnauthorizedBroadcast = 0;
function broadcastUnauthorized(): void {
  const now = Date.now();
  if (now - lastUnauthorizedBroadcast < 60_000) return; // at most once a minute
  lastUnauthorizedBroadcast = now;
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('pairing:unauthorized');
  }
}

function broadcastVersionMismatch(
  partnerVersion: string,
  localVersion: string,
  requiredVersion: string,
): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      w.webContents.send('pairing:version-mismatch', {
        partnerVersion,
        localVersion,
        requiredVersion,
      });
    }
  }
}

/** Compare two semver-ish versions (`X.Y.Z` or `X.Y.Z-pre.N`). Returns <0 if
 *  `a` is older than `b`, 0 if equal, >0 if newer. A release with no pre-release
 *  ranks above the same core with one (`1.0.0` > `1.0.0-alpha.1`); numeric
 *  pre-release identifiers compare numerically (so `alpha.9` < `alpha.10`). */
function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre = ''] = v.trim().split('-');
    const nums = core.split('.').map((n) => parseInt(n, 10) || 0);
    return {
      nums: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0],
      pre: pre ? pre.split('.') : [],
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i]! - pb.nums[i]!;
  }
  // No pre-release outranks a pre-release on the same core.
  if (pa.pre.length === 0 && pb.pre.length > 0) return 1;
  if (pa.pre.length > 0 && pb.pre.length === 0) return -1;
  const n = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1; // fewer identifiers ranks lower
    if (y === undefined) return 1;
    const xnum = /^\d+$/.test(x);
    const ynum = /^\d+$/.test(y);
    if (xnum && ynum) {
      const d = parseInt(x, 10) - parseInt(y, 10);
      if (d !== 0) return d;
    } else if (xnum !== ynum) {
      return xnum ? -1 : 1; // numeric identifiers rank below alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// ── Relay HTTP ───────────────────────────────────────────────────────

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${relayToken()}`, ...extra };
}

function deleteMessage(msgId: string): void {
  const url = `${relayUrl()}/messages/${encodeURIComponent(msgId)}`;
  fetch(url, { method: 'DELETE', headers: authHeaders() }).catch((err) => {
    console.warn(`[pairing] DELETE ${msgId} failed:`, err);
  });
}

/** One catch-up/poll cycle: pull our mailbox and process it. */
async function pollOnce(): Promise<void> {
  if (polling || !config.enabled) return;
  void maybeRenewEntitlement();
  polling = true;
  try {
    const url = `${relayUrl()}/messages?recipient=${encodeURIComponent(ks().ownRoutingId())}`;
    const res = await fetch(url, { method: 'GET', headers: authHeaders() });
    if (!res.ok) {
      console.warn(`[pairing] GET inbox returned ${res.status}`);
      return;
    }
    const data = (await res.json()) as { messages?: RelayMessage[] };
    const messages = data.messages ?? [];
    if (messages.length === 0) return;
    await processMessages(messages);
  } catch (err) {
    console.warn('[pairing] poll error:', err);
  } finally {
    polling = false;
  }
}

/** Decrypt + dedupe + inbox + ack one batch of relay messages. Shared by
 *  the poll path and the live stream (which delivers the same per-message
 *  shape one frame at a time). */
async function processMessages(messages: RelayMessage[]): Promise<void> {
  await ensureInboxLoaded();
  let changed = false;
  for (const m of messages) {
      if (!m || typeof m.msgId !== 'string') continue;
      if (consumed.has(m.msgId)) continue;
      consumed.add(m.msgId);

      // Decrypt the sealed bundle with our private key. A failure means it
      // wasn't really for us (or was sealed to a stale key of ours) — drop it.
      if (!m.epk || !m.iv || !m.ct || !m.tag) {
        deleteMessage(m.msgId);
        continue;
      }
      let inner: InnerPayload;
      try {
        inner = ks().open({ epk: m.epk, iv: m.iv, ct: m.ct, tag: m.tag }) as InnerPayload;
      } catch {
        console.warn('[pairing] could not decrypt a message; dropping');
        deleteMessage(m.msgId);
        continue;
      }

      // Compatibility floor (travels inside the ciphertext): a card may declare
      // the minimum receiver version that can safely read it. Reject ONLY when
      // that floor is set and we're older than it — a blank floor means any
      // version may receive, so cross-version sharing is tolerant by default.
      // Drop the rejected card, tell the UI, and clear it from the relay.
      const partnerVersion = inner.schemaVersion || 'unknown';
      const requiredMin = (inner.minReceiverVersion ?? '').trim();
      if (requiredMin && compareVersions(config.schemaVersion, requiredMin) < 0) {
        console.log(
          `[pairing] dropping card requiring >= ${requiredMin} ` +
            `(local ${config.schemaVersion}, from ${partnerVersion})`,
        );
        broadcastVersionMismatch(partnerVersion, config.schemaVersion, requiredMin);
        deleteMessage(m.msgId);
        continue;
      }

      const item = inner.item;
      if (!item || typeof item !== 'object') {
        deleteMessage(m.msgId);
        continue;
      }
      // Dedupe by source msgId so a failed DELETE can't double-add.
      const id = `rx-${m.msgId}`;
      if (!inbox.some((it) => it.id === id)) {
        inbox = [
          ...inbox,
          {
            id,
            label: typeof item.label === 'string' ? item.label : 'Card',
            type: typeof item.type === 'string' ? item.type : '',
            sliceJson: item.sliceJson,
            senderName: typeof inner.senderName === 'string' ? inner.senderName : '',
            senderCode: typeof inner.senderCode === 'string' ? inner.senderCode : '',
            via: typeof inner.via === 'string' && inner.via ? inner.via : undefined,
            receivedAt: Date.now(),
            read: false,
          },
        ];
        changed = true;
      }
      deleteMessage(m.msgId);
    }

  if (changed) {
    broadcastInbox();
    await persistInbox();
  }
}

// ── Delivery channel (push stream, poll catch-up, legacy fallback) ───

function stopDelivery(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (catchupTimer !== null) {
    clearInterval(catchupTimer);
    catchupTimer = null;
  }
  stream?.stop();
  stream = null;
}

/** Legacy mode — the relay has no /stream endpoint: today's interval
 *  polling, at the configured cadence. */
function startFallbackPolling(): void {
  if (pollTimer !== null) return;
  const ms = Math.max(5, config.pollSeconds) * 1000;
  console.log(`[pairing] polling every ${ms / 1000}s for ${ks().ownRoutingId()}`);
  void pollOnce();
  pollTimer = setInterval(() => void pollOnce(), ms);
}

/** (Re)start the delivery channel to match `config`. Push-first: open the
 *  SSE stream and run a catch-up poll on every (re)connect; a 404 from
 *  /stream marks this relay URL legacy for the session and switches to
 *  interval polling. While streaming, `pollSeconds` (floored to 5 min)
 *  paces a low-frequency belt-and-suspenders catch-up. */
function applyDelivery(): void {
  stopDelivery();
  if (!config.enabled) {
    console.log('[pairing] delivery off');
    return;
  }
  if (streamUnsupportedUrl !== null && streamUnsupportedUrl === relayUrl()) {
    startFallbackPolling();
    return;
  }
  void maybeRenewEntitlement();
  console.log(`[pairing] connecting push stream for ${ks().ownRoutingId()}`);
  stream = new RelayStream({
    url: () => `${relayUrl()}/stream?recipient=${encodeURIComponent(ks().ownRoutingId())}`,
    headers: () => authHeaders(),
    label: 'pairing',
    callbacks: {
      onConnected: () => {
        console.log('[pairing] push stream connected; running catch-up poll');
        void pollOnce();
      },
      onMessage: (data) => {
        if (data && typeof (data as RelayMessage).msgId === 'string') {
          void processMessages([data as RelayMessage]).catch((err) => {
            console.warn('[pairing] stream message error:', err);
          });
        }
      },
      onUnsupported: () => {
        console.log('[pairing] relay has no /stream — falling back to interval polling');
        streamUnsupportedUrl = relayUrl();
        startFallbackPolling();
      },
      onUnauthorized: () => {
        // A 401 means the relay rejected our credentials — a wrong
        // self-host token today, or (once gating enforces) a missing
        // subscription. Surface it to the user, throttled, so it never
        // spams: the two paths forward are connect an account or run
        // your own relay.
        console.warn('[pairing] relay rejected our token (401)');
        broadcastUnauthorized();
      },
    },
  });
  stream.start();
  const catchupMs = Math.max(config.pollSeconds, 300) * 1000;
  catchupTimer = setInterval(() => void pollOnce(), catchupMs);
}

// ── IPC ──────────────────────────────────────────────────────────────

export function registerPairingIpc(): void {
  // Configure returns this machine's public CODE (its X25519 public key), so
  // the renderer can display it and the user can share it. The private key
  // stays in main.
  let configured = false;
  ipcMain.handle(
    'host:pairing-configure',
    (_event, cfg: Partial<PairingConfig>): { ownCode: string } => {
      const prev = config;
      config = {
        enabled: !!cfg?.enabled,
        displayName: typeof cfg?.displayName === 'string' ? cfg.displayName : '',
        schemaVersion: typeof cfg?.schemaVersion === 'string' ? cfg.schemaVersion : 'unknown',
        minReceiverVersion:
          typeof cfg?.minReceiverVersion === 'string' ? cfg.minReceiverVersion : '',
        pollSeconds:
          typeof cfg?.pollSeconds === 'number' && Number.isFinite(cfg.pollSeconds)
            ? cfg.pollSeconds
            : 30,
        relayUrl: typeof cfg?.relayUrl === 'string' ? cfg.relayUrl : '',
        relayToken: typeof cfg?.relayToken === 'string' ? cfg.relayToken : '',
      };
      // Only materialize a keypair once the user actually turns sharing on,
      // so a fresh install that never enables it writes no key file.
      const ownCode = config.enabled ? ks().ownPublicCode() : '';
      // The renderer re-configures on EVERY settings change; only restart
      // the delivery channel when a field it depends on actually moved —
      // a display-name edit must not sever a live push stream.
      const deliveryChanged =
        !configured ||
        prev.enabled !== config.enabled ||
        prev.pollSeconds !== config.pollSeconds ||
        prev.relayUrl !== config.relayUrl ||
        prev.relayToken !== config.relayToken;
      configured = true;
      if (deliveryChanged) applyDelivery();
      return { ownCode };
    },
  );

  // Mint a fresh keypair (invalidates the old code for partners). Returns the
  // new public code and re-points delivery at the new routing code.
  // Rooms (collab sessions) run their HTTP/SSE client in the renderer;
  // hand it the same baked relay base + shared token card sharing uses,
  // as the LAST fallback after settings/dev-env. The rooms transport is
  // E2E encrypted, so the renderer holding the shared bearer token is
  // equivalent exposure to the web edition.
  ipcMain.handle('host:collab-relay-defaults', (): { url: string; token: string } => {
    return { url: relayUrl(), token: relayToken() };
  });

  ipcMain.handle('host:pairing-regenerate-key', (): { ownCode: string } => {
    const ownCode = ks().regenerate();
    consumed.clear();
    // The entitlement is bound to the OLD routing code — a new keypair
    // needs a fresh connect from the blog page.
    if (entitlementState !== null) {
      entitlementState = null;
      void persistEntitlement();
      broadcastEntitlement();
    }
    applyDelivery();
    return { ownCode };
  });

  // Blog-account entitlement surface. Optional during the beta — an
  // entitlement gates nothing while the relay runs ungated.
  ipcMain.handle(
    'host:pairing-connect-account',
    async (_e, payload: { connectCode: string; confirmEvict?: boolean }) => {
      if (typeof payload?.connectCode !== 'string' || !payload.connectCode.trim()) {
        return { ok: false, error: 'badCode' };
      }
      return connectAccount(payload.connectCode, !!payload.confirmEvict);
    },
  );
  ipcMain.handle('host:pairing-account-status', async () => {
    await ensureEntitlementLoaded();
    return accountStatus();
  });
  ipcMain.handle('host:pairing-disconnect-account', async () => {
    await ensureEntitlementLoaded();
    if (entitlementState !== null) {
      entitlementState = null;
      await persistEntitlement();
      broadcastEntitlement();
    }
    return accountStatus();
  });

  // Wake-from-sleep: the stream's socket may be silently dead — force a
  // prompt reconnect (whose hello triggers the catch-up poll). In
  // fallback-poll mode just poll immediately instead of waiting a cycle.
  powerMonitor.on('resume', () => {
    // Renderers first (collab session streams restart themselves) —
    // NOT gated on pairing being enabled.
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('host:power-resumed');
    }
    if (!config.enabled) return;
    console.log('[pairing] system resumed — refreshing delivery channel');
    if (stream) stream.restart();
    else void pollOnce();
  });

  ipcMain.handle(
    'host:pairing-send',
    async (
      _event,
      payload: {
        recipientCodes: string[];
        item: SendItem;
        via?: string;
        minReceiverVersion?: string;
      },
    ): Promise<{ ok: number; fail: number; authFail: number }> => {
      const targets = Array.isArray(payload?.recipientCodes)
        ? Array.from(new Set(payload.recipientCodes.filter((c) => typeof c === 'string' && c)))
        : [];
      if (targets.length === 0 || !payload?.item) {
        return { ok: 0, fail: targets.length, authFail: 0 };
      }
      const senderCode = ks().ownPublicCode();
      let ok = 0;
      let fail = 0;
      /** How many of `fail` were the relay DECLINING our credentials
       *  (401/403) rather than an outage — the renderer names the fix
       *  instead of "couldn't reach". Inert while the relay is ungated. */
      let authFail = 0;
      await Promise.all(
        targets.map(async (recipientPublicCode) => {
          try {
            // Seal everything-but-routing to the recipient's public key.
            // Per-message floor (session invites) beats the config-level
            // card floor; blank still means tolerant.
            const floor =
              typeof payload.minReceiverVersion === 'string' && payload.minReceiverVersion.trim()
                ? payload.minReceiverVersion.trim()
                : config.minReceiverVersion;
            const inner: InnerPayload = {
              schemaVersion: config.schemaVersion,
              // Omit when blank so the payload stays minimal and older receivers
              // never see an unexpected field; absent = tolerant.
              minReceiverVersion: floor || undefined,
              senderCode,
              senderName: config.displayName,
              via: payload.via,
              item: {
                label: payload.item.label,
                type: payload.item.type,
                sliceJson: payload.item.sliceJson,
              },
            };
            const bundle = ks().seal(inner, recipientPublicCode);
            const body = {
              v: 1 as const,
              recipientCode: routingId(recipientPublicCode),
              sentAt: Date.now(),
              ...bundle,
            };
            const gz = gzipSync(Buffer.from(JSON.stringify(body), 'utf8'));
            const res = await fetch(`${relayUrl()}/messages`, {
              method: 'POST',
              headers: authHeaders({
                'Content-Type': 'application/json',
                'Content-Encoding': 'gzip',
              }),
              body: gz,
            });
            if (res.ok) ok++;
            else {
              fail++;
              if (res.status === 401 || res.status === 403) authFail++;
              console.warn(`[pairing] POST returned ${res.status}`);
            }
          } catch (err) {
            fail++;
            console.warn('[pairing] send failed:', err);
          }
        }),
      );
      return { ok, fail, authFail };
    },
  );

  ipcMain.handle('host:pairing-inbox-list', async () => {
    await ensureInboxLoaded();
    return inbox;
  });

  ipcMain.handle('host:pairing-inbox-remove', async (_event, id: string) => {
    if (typeof id !== 'string' || !id) return;
    await ensureInboxLoaded();
    const next = inbox.filter((it) => it.id !== id);
    if (next.length === inbox.length) return;
    inbox = next;
    broadcastInbox();
    await persistInbox();
  });

  ipcMain.handle('host:pairing-inbox-clear', async () => {
    await ensureInboxLoaded();
    if (inbox.length === 0) return;
    inbox = [];
    broadcastInbox();
    await persistInbox();
  });

  ipcMain.handle('host:pairing-inbox-mark-read', async () => {
    await ensureInboxLoaded();
    if (!inbox.some((it) => !it.read)) return;
    inbox = inbox.map((it) => (it.read ? it : { ...it, read: true }));
    broadcastInbox();
    await persistInbox();
  });
}
