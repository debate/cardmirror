/**
 * Pairing wiring — boot glue for cross-machine card sharing.
 *
 *   - Mounts the Send + Receive pills into the pill tray.
 *   - Mints this machine's own code the first time sharing is enabled.
 *   - Pushes the current pairing config to the main process (which runs
 *     the poller + holds the token) on boot and on every settings change.
 *   - Surfaces a toast when a partner is on a different app version.
 *
 * Desktop v1: everything routes through the Electron host. On the web
 * edition (no `getElectronHost()`) this is inert — the pills render but
 * there is no poller/sender yet (deferred).
 */

import type { EditorView } from 'prosemirror-view';
import { getElectronHost } from '../host/index.js';
import { settings } from '../settings.js';
import { appVersion, CARD_COMPAT_MIN_VERSION } from '../install-info.js';
import { showToast } from '../toast.js';
import { inboxStore } from './inbox-store.js';
import { SendPillController } from './send-pill-ui.js';
import { ReceivePillController } from './receive-pill-ui.js';

/** Build + mount the Send and Receive pills into the tray (after the
 *  dropzone, so they sit to its right). */
export function mountPairingPills(
  tray: HTMLElement,
  getFocusedView: () => EditorView | null,
): void {
  new SendPillController().mount({ parent: tray });
  new ReceivePillController().mount({ parent: tray, getFocusedView });
}

/** Push the current settings to the main-process poller/sender. The main
 *  process owns this machine's keypair and returns its public code, which we
 *  mirror into settings for display + sharing. */
function applyConfig(): void {
  const electron = getElectronHost();
  if (!electron?.pairingConfigure) return;

  void electron
    .pairingConfigure({
      enabled: settings.get('pairingEnabled'),
      displayName: settings.get('pairingDisplayName'),
      schemaVersion: appVersion,
      minReceiverVersion: CARD_COMPAT_MIN_VERSION,
      pollSeconds: settings.get('pairingPollSeconds'),
      relayUrl: settings.get('pairingRelayUrl'),
      relayToken: settings.get('pairingRelayToken'),
    })
    .then(({ ownCode }) => {
      // Setting it re-fires the subscriber, but the value is now unchanged so
      // configure is a no-op next time — no loop.
      if (ownCode && settings.get('pairingOwnCode') !== ownCode) {
        settings.set('pairingOwnCode', ownCode);
      }
    });
}

/** Mint a fresh keypair in main and mirror the new code into settings.
 *  Invalidates the old code for partners (they must re-add the new one). */
export async function regenerateOwnCode(): Promise<void> {
  const electron = getElectronHost();
  if (!electron?.pairingRegenerateKey) return;
  const { ownCode } = await electron.pairingRegenerateKey();
  if (ownCode) settings.set('pairingOwnCode', ownCode);
}

let lastMismatchToast = 0;

/** Wire config sync + incoming-event handling. Idempotent-ish; call once
 *  at boot. */
export function initPairingWiring(): void {
  void inboxStore.init();

  const electron = getElectronHost();
  if (electron?.onPairingVersionMismatch) {
    electron.onPairingVersionMismatch((info) => {
      // Throttle so a backlog of incompatible cards doesn't spam toasts.
      const now = Date.now();
      if (now - lastMismatchToast < 8000) return;
      lastMismatchToast = now;
      const need = info.requiredVersion
        ? ` (${info.requiredVersion} or newer)`
        : '';
      showToast(
        `A shared card needs a newer CardMirror version${need} — ` +
          `update to receive it.`,
      );
    });
  }

  // Blog-account entitlement (dormant unless main enables the flow):
  // keep the settings mirror current and surface evictions — a user
  // whose seat was taken should learn it from a toast, not from cards
  // silently failing later.
  if (electron?.onPairingEntitlementChanged) {
    electron.onPairingEntitlementChanged((st) => {
      const mirror = st.connected ? st.expiresAt : 0;
      if (settings.get('pairingConnectedUntil') !== mirror) {
        settings.set('pairingConnectedUntil', mirror);
      }
      if (st.evicted) {
        showToast(
          'This machine was unlinked from your Debate Decoded account ' +
            '(another machine took the seat). Re-link from the connect page — ' +
            'or not: during the beta nothing requires the link.',
        );
      }
    });
  }

  // Relay rejected our credentials (401): a wrong self-host token today,
  // or a missing subscription once gating enforces. Same two-path
  // framing as the co-editing session-start message — plus the beta
  // context, since the ungated official relay shouldn't 401 at all
  // (a wrong custom-relay token or a stale build is the likely cause).
  if (electron?.onPairingUnauthorized) {
    electron.onPairingUnauthorized(() => {
      showToast(
        'Card sharing: the relay rejected your credentials. In Settings → ' +
          'Collaboration, connect your Debate Decoded account or set up your own relay. ' +
          '(During the beta the official relay requires no account, so this usually ' +
          'means a self-hosted relay token is wrong or the app needs an update.)',
      );
    });
  }

  applyConfig();
  settings.subscribe(() => applyConfig());
}
