/**
 * Blog-account entitlement — the pure decision core.
 *
 * The stateful owner (persistence, fetch, IPC, broadcasts) is
 * pairing-ipc.ts; everything here is side-effect-free so the rules the
 * relay contract depends on — validity slack, the renewal window, and
 * the /relay/connect response taxonomy — are unit-testable without an
 * Electron process.
 *
 * The entitlement is a relay-minted bearer bound to this machine's
 * routing code. While the official relay runs UNGATED (the whole beta),
 * carrying one changes nothing functionally — the relay accepts it
 * alongside the shared token — it only pre-links the machine so a
 * future gating flip needs no client work.
 */

export interface EntitlementState {
  entitlement: string;
  /** Epoch ms. */
  expiresAt: number;
  /** Member email the relay reported at connect/renewal ('' unknown). */
  email: string;
}

/** Validate a parsed pairing-entitlement.json payload. */
export function parseStoredEntitlement(parsed: unknown): EntitlementState | null {
  const p = parsed as { entitlement?: unknown; expiresAt?: unknown; email?: unknown } | null;
  if (p && typeof p.entitlement === 'string' && typeof p.expiresAt === 'number') {
    return {
      entitlement: p.entitlement,
      expiresAt: p.expiresAt,
      email: typeof p.email === 'string' ? p.email : '',
    };
  }
  return null;
}

/** The entitlement usable as a bearer right now — 60s slack so a token
 *  never expires mid-request. */
export function entitlementIfValid(
  state: EntitlementState | null,
  now: number,
): EntitlementState | null {
  return state && state.expiresAt > now + 60_000 ? state : null;
}

/** Whether a code-less renewal is due: inside the final 24h (or past
 *  expiry — the relay honors a 30-day continuity grace), or immediately
 *  when the stored state predates the email echo, so the status line
 *  fills in on launch. */
export function renewalDue(state: EntitlementState, now: number): boolean {
  return !(state.email && state.expiresAt - now > 24 * 3600 * 1000);
}

/** Structured result of a connect / renewal call against /relay/connect. */
export interface ConnectOutcome {
  ok: boolean;
  error?: string;
  expiresAt?: number;
  email?: string;
  limit?: number;
  wouldEvict?: { routingCode: string; boundAt: string };
  retryCode?: string;
}

export interface ConnectResponseBody {
  entitlement?: string;
  expiresAt?: number;
  email?: string;
  detail?: {
    error?: string;
    limit?: number;
    wouldEvict?: { routingCode: string; boundAt: string };
    retryCode?: string;
  };
}

/** What the caller should do with a /relay/connect response. `next` is
 *  the entitlement state to store: an object binds/renews, `null`
 *  clears (eviction), `undefined` leaves the stored state untouched. */
export interface ConnectInterpretation {
  outcome: ConnectOutcome;
  next: EntitlementState | null | undefined;
  /** True when the relay said this machine's seat was taken. */
  evicted: boolean;
}

/** Map a /relay/connect response onto the outcome + state transition.
 *  Mirrors the relay's verified contract: 200 binds/renews (keeping the
 *  last-known email when the fail-open lookup blanked it), 409 is either
 *  the seat-limit confirm flow or a visible eviction, 401 a bad/expired
 *  code (or missing renewal proof), 403 a lapsed membership, 404 a relay
 *  without the accounts endpoints. */
export function interpretConnectResponse(
  status: number,
  body: ConnectResponseBody,
  prev: EntitlementState | null,
): ConnectInterpretation {
  if (
    status >= 200 &&
    status < 300 &&
    typeof body.entitlement === 'string' &&
    typeof body.expiresAt === 'number'
  ) {
    const next: EntitlementState = {
      entitlement: body.entitlement,
      expiresAt: body.expiresAt,
      // A renewal that failed the (fail-open) email lookup keeps the
      // last-known email rather than blanking the status line.
      email: (typeof body.email === 'string' && body.email) || prev?.email || '',
    };
    return {
      outcome: { ok: true, expiresAt: body.expiresAt, email: next.email },
      next,
      evicted: false,
    };
  }
  const detail = body.detail;
  if (status === 409 && detail?.error === 'seatLimit') {
    return {
      outcome: {
        ok: false,
        error: 'seatLimit',
        limit: detail.limit,
        wouldEvict: detail.wouldEvict,
        retryCode: detail.retryCode,
      },
      next: undefined,
      evicted: false,
    };
  }
  if (status === 409 && detail?.error === 'youWereEvicted') {
    return { outcome: { ok: false, error: 'evicted' }, next: null, evicted: true };
  }
  if (status === 401) return { outcome: { ok: false, error: 'badCode' }, next: undefined, evicted: false };
  if (status === 403) return { outcome: { ok: false, error: 'subscription' }, next: undefined, evicted: false };
  if (status === 404) return { outcome: { ok: false, error: 'unsupported' }, next: undefined, evicted: false };
  return { outcome: { ok: false, error: `http ${status}` }, next: undefined, evicted: false };
}
