/**
 * Send pill — a drop target that pushes a card to a paired machine.
 *
 * Drag any card (from the editor, the dropzone, or the receive pill) over
 * this pill and it EXPANDS to reveal your partners and groups; drop on one
 * to send. It registers a `DragSurface` with the shared drag controller
 * (same mechanism the dropzone uses); the controller calls our `absorb`
 * when a card is dropped on a target row. Group targets fan the card out
 * to every member.
 *
 * No expansion happens without an active drag — the pill is a small
 * button otherwise.
 */

import { Slice } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import {
  dragController,
  type DragItem,
  type DragSurface,
} from '../drag-controller.js';
import { deriveDropzoneLabel } from '../dropzone-store.js';
import { schema } from '../../schema/index.js';
import { settings, type PairingGroup } from '../settings.js';
import { showToast } from '../toast.js';
import { relayClient, sendOutcomeToast, type SendItem } from './relay-client.js';
import { collabEnabled } from '../collab/collab-gate.js';
import { collabInviter } from '../collab/collab-hooks.js';

interface SendPillMountOptions {
  parent: HTMLElement;
}

interface SendTarget {
  /** Recipient codes this row resolves to (one for a partner, many for a
   *  group). */
  codes: string[];
  /** Human label for the toast. */
  label: string;
  /** Group label stamped on the card, when this target is a group. */
  via?: string;
}

function pointInRect(r: { left: number; right: number; top: number; bottom: number }, x: number, y: number): boolean {
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/** Bounding box that encloses both rects (and the gap between them). */
function unionRect(
  a: DOMRect,
  b: DOMRect,
): { left: number; right: number; top: number; bottom: number } {
  return {
    left: Math.min(a.left, b.left),
    right: Math.max(a.right, b.right),
    top: Math.min(a.top, b.top),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

/** Two-people glyph for the per-contact "invite to collaborate" button. */
const COLLAB_INVITE_ICON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';

export class SendPillController {
  private root!: HTMLDivElement;
  private bar!: HTMLDivElement;
  private panel!: HTMLDivElement;
  private surface: DragSurface | null = null;
  private unregisterSurface: (() => void) | null = null;
  private unsubscribeSettings: (() => void) | null = null;
  private unsubscribeController: (() => void) | null = null;
  private expanded = false;
  /** Click-to-invite mode: the panel is open from a CLICK (not a drag), so
   *  each row shows a collaboration-invite button. A drag-to-send never
   *  reveals the buttons (the `pmd-send-invite-mode` class gates them). */
  private inviteMode = false;
  private onDocPointerDown: ((e: PointerEvent) => void) | null = null;
  /** Row element → resolved target, rebuilt with the partner/group list. */
  private targets = new Map<HTMLElement, SendTarget>();

  mount(opts: SendPillMountOptions): void {
    this.root = document.createElement('div');
    this.root.className = 'pmd-pill pmd-send-pill';
    this.root.dataset['open'] = 'false';

    this.panel = document.createElement('div');
    this.panel.className = 'pmd-send-panel';
    this.root.appendChild(this.panel);

    this.bar = document.createElement('div');
    this.bar.className = 'pmd-pill-bar pmd-send-bar';
    this.bar.title = 'Drag a card here to send it';
    const icon = document.createElement('span');
    icon.className = 'pmd-pill-icon';
    icon.setAttribute('aria-hidden', 'true');
    // Paper-plane glyph.
    icon.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg>';
    this.bar.appendChild(icon);
    const labelEl = document.createElement('span');
    labelEl.className = 'pmd-pill-label';
    labelEl.textContent = 'Send';
    this.bar.appendChild(labelEl);
    this.root.appendChild(this.bar);

    // Click-to-invite (collab sessions): the same partner/group rows,
    // but a click on one sends a session invite — starting a session on
    // the current doc first when none is active. Only offered while the
    // collab gate is open; otherwise the pill stays drag-only.
    this.bar.addEventListener('click', () => {
      if (!collabEnabled() || !collabInviter()) return;
      if (this.inviteMode) this.collapse();
      else this.openInviteMode();
    });

    opts.parent.appendChild(this.root);

    this.surface = {
      hitTest: (clientX, clientY) => {
        if (!settings.get('pairingEnabled')) return null;
        // Active zone = just the bar when collapsed; once expanded, the
        // UNION of the bar and the (above, wider) panel so the pointer can
        // travel from the bar up into the partner list without falling into
        // the gap between them — which would otherwise collapse the pill.
        const barRect = this.bar.getBoundingClientRect();
        let inside = pointInRect(barRect, clientX, clientY);
        if (!inside && this.expanded) {
          inside = pointInRect(unionRect(barRect, this.panel.getBoundingClientRect()), clientX, clientY);
        }
        if (!inside) return null;
        // Hovering the pill: it becomes the winning surface (dy 0). Once
        // expanded, resolve which target row the pointer is over.
        if (this.expanded) {
          const targetEl = this.targetRowAt(clientX, clientY);
          if (targetEl) {
            const target = this.targets.get(targetEl);
            if (target) {
              return {
                el: targetEl,
                insertPos: 0,
                dy: 0,
                absorb: (items) => this.sendItems(items, target),
              };
            }
          }
        }
        // Over the pill but not on a partner/group row (bar, gap, padding):
        // a no-op absorb so releasing here just closes the pill instead of
        // falling through to the controller's "insert into the doc" path.
        return { el: this.bar, insertPos: 0, dy: 0, absorb: () => {} };
      },
      highlight: (el) => {
        if (el === null) {
          this.collapse();
          return;
        }
        this.expand();
        this.clearRowHighlight();
        if (el.classList.contains('pmd-send-target')) {
          el.classList.add('pmd-send-target-hot');
          this.bar.classList.remove('pmd-send-bar-hot');
        } else {
          this.bar.classList.add('pmd-send-bar-hot');
        }
      },
    };
    this.unregisterSurface = dragController.registerSurface(this.surface);

    // Tear down highlight + collapse when any drag ends (drop elsewhere,
    // cancel, etc.) — the controller doesn't clear surfaces itself.
    this.unsubscribeController = dragController.subscribe((event) => {
      if (event === 'end') this.collapse();
    });

    this.renderTargets();
    this.applyVisibility();
    this.unsubscribeSettings = settings.subscribe(() => {
      this.renderTargets();
      this.applyVisibility();
      this.applyClickAffordance();
    });
    this.applyClickAffordance();
  }

  /** Cursor + tooltip reflect whether clicking does anything. */
  private applyClickAffordance(): void {
    const clickable = collabEnabled() && collabInviter() !== null && settings.get('pairingEnabled');
    this.bar.classList.toggle('pmd-send-bar-clickable', clickable);
    this.bar.title = clickable
      ? 'Drag a card here to send it · Click to invite to a collaboration session'
      : 'Drag a card here to send it';
  }

  private openInviteMode(): void {
    this.inviteMode = true;
    this.expand();
    // Reveals the per-row collaboration-invite buttons (CSS-gated on this
    // class), so they appear only on a click-open, never mid-drag.
    this.root.classList.add('pmd-send-invite-mode');
    // Outside click closes (capture so editor clicks count too).
    this.onDocPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && this.root.contains(e.target)) return;
      this.collapse();
    };
    document.addEventListener('pointerdown', this.onDocPointerDown, true);
  }

  unmount(): void {
    this.unregisterSurface?.();
    this.unsubscribeSettings?.();
    this.unsubscribeController?.();
    this.root.remove();
  }

  private applyVisibility(): void {
    this.root.hidden = !settings.get('pairingEnabled');
  }

  /** Rebuild the partner + group drop rows from settings. */
  private renderTargets(): void {
    this.panel.innerHTML = '';
    this.targets.clear();

    const partners = settings.get('pairingPartners').filter((p) => p.code);
    const groups = settings
      .get('pairingGroups')
      .filter((g) => g.memberCodes.some((c) => partners.some((p) => p.code === c)));

    if (partners.length === 0 && groups.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'pmd-send-empty';
      hint.textContent = 'Add a recipient in Settings → Collaboration.';
      this.panel.appendChild(hint);
      return;
    }

    if (groups.length > 0) {
      this.panel.appendChild(this.sectionLabel('Groups'));
      for (const g of groups) {
        const row = this.groupRow(g, partners);
        this.addInviteButton(row);
        this.panel.appendChild(row);
      }
    }
    if (partners.length > 0) {
      this.panel.appendChild(this.sectionLabel('To'));
      for (const p of partners) {
        const row = this.targetRow(p.name || p.code, [p.code], p.name || p.code);
        this.addInviteButton(row);
        this.panel.appendChild(row);
      }
    }
  }

  /** Append the per-contact "invite to collaborate" button. Hidden by CSS
   *  until the pill is opened by a click (invite mode); clicking it starts a
   *  session on the current doc (if none) and invites that recipient/group. */
  private addInviteButton(row: HTMLElement): void {
    const target = this.targets.get(row);
    if (!target) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-send-invite-btn';
    btn.title = 'Invite to collaborate';
    btn.setAttribute('aria-label', 'Invite to collaborate');
    btn.innerHTML = COLLAB_INVITE_ICON;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.collapse();
      collabInviter()?.({ codes: target.codes, label: target.label, via: target.via });
    });
    row.appendChild(btn);
  }

  private sectionLabel(text: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'pmd-send-section';
    el.textContent = text;
    return el;
  }

  private groupRow(
    group: PairingGroup,
    partners: { code: string; name: string }[],
  ): HTMLElement {
    const codes = group.memberCodes.filter((c) => partners.some((p) => p.code === c));
    const row = this.targetRow(group.label || 'Group', codes, group.label || 'Group', group.label);
    const count = document.createElement('span');
    count.className = 'pmd-send-target-count';
    count.textContent = `${codes.length}`;
    count.title = `${codes.length} recipient${codes.length === 1 ? '' : 's'}`;
    row.appendChild(count);
    row.classList.add('pmd-send-target-group');
    return row;
  }

  private targetRow(label: string, codes: string[], toastLabel: string, via?: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'pmd-send-target';
    const name = document.createElement('span');
    name.className = 'pmd-send-target-name';
    name.textContent = label;
    name.title = label;
    row.appendChild(name);
    this.targets.set(row, { codes, label: toastLabel, via });
    return row;
  }

  private targetRowAt(x: number, y: number): HTMLElement | null {
    for (const el of this.targets.keys()) {
      if (pointInRect(el.getBoundingClientRect(), x, y)) return el;
    }
    return null;
  }

  private clearRowHighlight(): void {
    this.bar.classList.remove('pmd-send-bar-hot');
    for (const el of this.targets.keys()) el.classList.remove('pmd-send-target-hot');
  }

  private expand(): void {
    if (this.expanded) return;
    this.expanded = true;
    this.root.dataset['open'] = 'true';
  }

  private collapse(): void {
    if (this.inviteMode) {
      this.inviteMode = false;
      this.root.classList.remove('pmd-send-invite-mode');
      if (this.onDocPointerDown) {
        document.removeEventListener('pointerdown', this.onDocPointerDown, true);
        this.onDocPointerDown = null;
      }
    }
    if (!this.expanded) {
      this.clearRowHighlight();
      return;
    }
    this.expanded = false;
    this.root.dataset['open'] = 'false';
    this.clearRowHighlight();
  }

  /** Resolve each dragged item to a SendItem and push to the target. */
  private async sendItems(items: DragItem[], target: SendTarget): Promise<void> {
    const session = dragController.getSession();
    if (!session) return;
    const srcView: EditorView = session.view;
    if (target.codes.length === 0) {
      showToast('That group has no recipients yet');
      return;
    }

    const sendItems: SendItem[] = [];
    for (const item of items) {
      let slice: Slice;
      try {
        slice = item.prebuilt ?? srcView.state.doc.slice(item.from, item.to);
      } catch {
        continue;
      }
      const type = item.type || slice.content.firstChild?.type.name || 'text';
      const label = item.label || deriveDropzoneLabel(slice, type);
      sendItems.push({ label, type, sliceJson: slice.toJSON() });
    }
    if (sendItems.length === 0) return;

    let ok = 0;
    let fail = 0;
    let authFail = 0;
    for (const si of sendItems) {
      const res = await relayClient.send(target.codes, si, { via: target.via });
      ok += res.ok;
      fail += res.fail;
      authFail += res.authFail;
    }
    showToast(sendOutcomeToast(target.label, { ok, fail, authFail }));
  }
}
