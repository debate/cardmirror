/**
 * NodeView for a transclusion "live zone" (TRANSCLUSION_PLAN.md §4).
 *
 * The transcluded cards are REAL child nodes, so the zone is EDITABLE (a
 * `contentDOM` holds the children) — you can contextualise a tag or its
 * highlighting in place without breaking the link. A left gutter rail (the
 * reused card-unit rail grammar, in --pmd-c-transclusion) with a clickable link
 * glyph marks it; the glyph opens a Refresh / Unlink menu, and a reveal-on-hover
 * header shows the source breadcrumb, synced date, and an "edited" dot when the
 * zone diverges from the last-pulled source. Refresh re-reads the source and
 * replaces the children (confirming first when edited); Detach unwraps them.
 */
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView, NodeView } from 'prosemirror-view';
import { icon, type IconName } from './icons.js';
import { showToast } from './toast.js';
import { isZoneEdited } from './transclusion.js';
import {
  refreshZoneAtPos,
  detachZoneAtPos,
  rePickZoneAtPos,
  openZoneSourceAtPos,
} from './transclusion-actions.js';
import { transclusionSupported, refreshFailMessage } from './transclusion-resolve.js';

function railGlyph(): HTMLElement {
  const g = icon('link', { label: 'Live zone' });
  g.classList.add('pmd-transclusion-glyph');
  return g;
}

function formatSyncedDate(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return 'earlier';
  }
}

class TransclusionView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private readonly headerEl: HTMLElement;
  private statusEl: HTMLElement | null = null;
  private editedDot: HTMLElement | null = null;
  private node: PMNode;
  private readonly view: EditorView;
  private readonly getPos: () => number | undefined;
  private busy = false;
  private transient: 'unreachable' | 'web' | null = null;
  private menuEl: HTMLElement | null = null;

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;

    this.dom = document.createElement('div');
    this.dom.className = 'pmd-transclusion';

    // Chrome — not editable content.
    this.headerEl = document.createElement('div');
    this.headerEl.className = 'pmd-transclusion-header';
    this.headerEl.setAttribute('contenteditable', 'false');

    // The editable body: PM renders the transcluded children here.
    this.contentDOM = document.createElement('div');
    this.contentDOM.className = 'pmd-transclusion-body';

    this.dom.appendChild(this.headerEl);
    this.dom.appendChild(this.contentDOM);
    this.renderHeader();
  }

  private renderHeader(): void {
    this.closeMenu();
    this.headerEl.replaceChildren();

    // The always-visible rail glyph is the primary click target — it opens a
    // Refresh / Unlink menu (reachable without hovering, and on touch).
    const glyphBtn = document.createElement('button');
    glyphBtn.type = 'button';
    glyphBtn.className = 'pmd-transclusion-glyph-btn';
    glyphBtn.title = 'Live zone — refresh or unlink';
    glyphBtn.setAttribute('aria-label', 'Live zone actions');
    glyphBtn.appendChild(railGlyph());
    glyphBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    glyphBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleMenu();
    });
    this.headerEl.appendChild(glyphBtn);

    // "Edited" dot — lit when the zone diverges from the last-pulled source.
    const dot = document.createElement('span');
    dot.className = 'pmd-transclusion-edited-dot';
    dot.title = 'Edited — differs from source. Refresh to reset.';
    this.editedDot = dot;
    this.headerEl.appendChild(dot);

    const crumb = document.createElement('span');
    crumb.className = 'pmd-transclusion-crumb';
    crumb.textContent = String(this.node.attrs['source_label'] || 'Live zone');
    this.headerEl.appendChild(crumb);

    const status = document.createElement('span');
    status.className = 'pmd-transclusion-status';
    this.statusEl = status;
    this.headerEl.appendChild(status);

    const actions = document.createElement('div');
    actions.className = 'pmd-transclusion-actions';
    actions.appendChild(this.actionButton('reset', 'Refresh from source', () => this.onRefresh()));
    actions.appendChild(this.actionButton('search', 'Re-pick source', () => this.onRePick()));
    actions.appendChild(this.actionButton('edit', 'Unlink (detach)', () => this.onDetach()));
    this.headerEl.appendChild(actions);

    this.refreshStatusText();
    this.refreshEditedDot();
  }

  private refreshEditedDot(): void {
    if (!this.editedDot) return;
    const edited = isZoneEdited(this.node);
    this.editedDot.classList.toggle('is-edited', edited);
    this.dom.classList.toggle('pmd-transclusion-edited', edited);
  }

  private refreshStatusText(): void {
    if (!this.statusEl) return;
    let text: string;
    let state = 'ok';
    if (this.busy) {
      text = 'refreshing…';
      state = 'busy';
    } else if (this.transient === 'unreachable') {
      text = 'source not found · cached';
      state = 'unreachable';
    } else if (this.transient === 'web') {
      text = 'refresh on desktop';
      state = 'web';
    } else {
      const lr = Number(this.node.attrs['last_refreshed'] ?? 0);
      text = lr > 0 ? `synced ${formatSyncedDate(lr)}` : 'not yet refreshed';
    }
    this.statusEl.textContent = text;
    this.dom.setAttribute('data-status', state);
  }

  private actionButton(iconName: IconName, label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-transclusion-btn';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.appendChild(icon(iconName));
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  private toggleMenu(): void {
    if (this.menuEl) {
      this.closeMenu();
      return;
    }
    const menu = document.createElement('div');
    menu.className = 'pmd-transclusion-menu';
    menu.setAttribute('contenteditable', 'false');
    menu.appendChild(
      this.menuItem('open', 'Open source file', () => {
        this.closeMenu();
        this.onOpenSource();
      }),
    );
    menu.appendChild(
      this.menuItem('reset', 'Refresh from source', () => {
        this.closeMenu();
        this.onRefresh();
      }),
    );
    menu.appendChild(
      this.menuItem('search', 'Re-pick source…', () => {
        this.closeMenu();
        this.onRePick();
      }),
    );
    menu.appendChild(
      this.menuItem('edit', 'Unlink (detach)', () => {
        this.closeMenu();
        this.onDetach();
      }),
    );
    this.headerEl.appendChild(menu);
    this.menuEl = menu;
    setTimeout(() => {
      document.addEventListener('mousedown', this.onOutsidePointer, true);
      document.addEventListener('keydown', this.onMenuKey, true);
    }, 0);
  }

  private onOutsidePointer = (e: Event): void => {
    if (this.menuEl && !this.menuEl.contains(e.target as Node)) this.closeMenu();
  };

  private onMenuKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.closeMenu();
    }
  };

  private closeMenu(): void {
    if (!this.menuEl) return;
    this.menuEl.remove();
    this.menuEl = null;
    document.removeEventListener('mousedown', this.onOutsidePointer, true);
    document.removeEventListener('keydown', this.onMenuKey, true);
  }

  private menuItem(iconName: IconName, label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-transclusion-menu-item';
    btn.appendChild(icon(iconName));
    const span = document.createElement('span');
    span.textContent = label;
    btn.appendChild(span);
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  private onRefresh(): void {
    if (this.busy) return; // ignore re-entrant clicks while a refresh is in flight
    const pos = this.getPos();
    if (pos == null) return;
    if (!transclusionSupported()) {
      this.transient = 'web';
      this.refreshStatusText();
      showToast(refreshFailMessage('not-desktop'));
      return;
    }
    this.busy = true;
    this.transient = null;
    this.refreshStatusText();
    void refreshZoneAtPos(this.view, pos).then((outcome) => {
      this.busy = false;
      if (outcome.ok) {
        this.transient = null;
        this.refreshStatusText();
        // The dispatch replaced the node → a fresh NodeView renders the update.
      } else if (outcome.reason === 'cancelled' || outcome.reason === 'ambiguous') {
        // 'ambiguous' = the zone moved or was re-picked/detached while this
        // refresh was in flight; the zone itself is fine, so don't flag it
        // unreachable (that chip would stick). No error chrome.
        this.transient = null;
        this.refreshStatusText();
      } else {
        this.transient = outcome.reason === 'not-desktop' ? 'web' : 'unreachable';
        this.refreshStatusText();
        showToast(refreshFailMessage(outcome.reason));
      }
    });
  }

  private onDetach(): void {
    const pos = this.getPos();
    if (pos == null) return;
    detachZoneAtPos(this.view, pos);
  }

  private onRePick(): void {
    const pos = this.getPos();
    if (pos == null) return;
    if (!transclusionSupported()) {
      // Re-pick needs the picker + file reads, both desktop-only.
      showToast(refreshFailMessage('not-desktop'));
      return;
    }
    // Re-picking replaces the zone's content, so confirm first when it's edited —
    // symmetric with Refresh (which prompts before discarding local edits).
    if (
      isZoneEdited(this.node) &&
      typeof window !== 'undefined' &&
      !window.confirm(
        'Re-picking the source will replace your local edits to this live zone. Continue?',
      )
    ) {
      return;
    }
    rePickZoneAtPos(this.view, pos);
  }

  private onOpenSource(): void {
    const pos = this.getPos();
    if (pos == null) return;
    if (!transclusionSupported()) {
      // Opening the linked .cmir needs the desktop file layer.
      showToast(refreshFailMessage('not-desktop'));
      return;
    }
    openZoneSourceAtPos(this.view, pos);
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    const labelChanged = node.attrs['source_label'] !== this.node.attrs['source_label'];
    const lastRefreshedChanged = node.attrs['last_refreshed'] !== this.node.attrs['last_refreshed'];
    this.node = node;
    // Clear a stale transient error once a refresh has landed.
    if (lastRefreshedChanged) this.transient = null;
    if (labelChanged) this.renderHeader();
    else {
      this.refreshStatusText();
      this.refreshEditedDot();
    }
    // Return true so PM diffs the children into contentDOM itself.
    return true;
  }

  selectNode(): void {
    this.dom.classList.add('ProseMirror-selectednode');
  }

  deselectNode(): void {
    this.dom.classList.remove('ProseMirror-selectednode');
  }

  /** Keep events on our own chrome (header buttons / menu) away from PM;
   *  events inside the editable body fall through so edits work normally. */
  stopEvent(e: Event): boolean {
    const t = e.target as HTMLElement | null;
    return !!t?.closest?.('.pmd-transclusion-header');
  }

  /** Ignore mutations in our chrome; let PM handle the editable content. */
  ignoreMutation(m: MutationRecord | { type: 'selection'; target: Node }): boolean {
    if (m.type === 'selection') return false;
    return !this.contentDOM.contains((m as MutationRecord).target);
  }

  destroy(): void {
    this.closeMenu();
  }
}

/** NodeView factory map — merged into the editor's `nodeViews`. */
export const transclusionNodeViews = {
  transclusion_ref: (
    node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
  ): NodeView => new TransclusionView(node, view, getPos),
};
