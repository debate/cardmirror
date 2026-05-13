/**
 * Keyboard-shortcut reference modal. A read-only "cheat sheet" view
 * of the ribbon's bound F-keys / Mod-keys, grouped conceptually.
 *
 * The button source-of-truth lives in `ribbon-commands.ts`
 * (DEFAULT_RIBBON_KEYS + RIBBON_COMMAND_LABELS). When we add a
 * rebinding UI later, the reference modal can switch to reading the
 * live overrides and stay accurate without per-binding edits here.
 */

import {
  DEFAULT_RIBBON_KEYS,
  RIBBON_COMMAND_LABELS,
  formatKeyForDisplay,
  type RibbonCommandId,
} from './ribbon-commands.js';

interface ShortcutGroup {
  title: string;
  commands: RibbonCommandId[];
}

const GROUPS: ShortcutGroup[] = [
  {
    title: 'Structural styles',
    commands: ['setPocket', 'setHat', 'setBlock', 'setTag', 'setAnalytic', 'setUndertag'],
  },
  {
    title: 'Character styles',
    commands: ['applyCite', 'applyUnderline', 'applyEmphasis', 'applyHighlight', 'applyShading'],
  },
  {
    title: 'Inline formatting',
    commands: ['toggleBold', 'toggleItalic'],
  },
  {
    title: 'Condense',
    commands: [
      'condenseDefault',
      'condenseNoIntegrity',
      'condenseNoIntegrityWithPilcrows',
      'uncondense',
      'toggleCase',
    ],
  },
  {
    title: 'Editing utilities',
    commands: ['pasteAsText', 'clearToNormal', 'copyPreviousCite'],
  },
];

class ReferenceModal {
  private overlay: HTMLDivElement;
  private dialog: HTMLDivElement;

  constructor() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'pmd-reference-overlay';
    this.overlay.style.display = 'none';

    this.dialog = document.createElement('div');
    this.dialog.className = 'pmd-reference-dialog';
    this.overlay.appendChild(this.dialog);

    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });

    document.addEventListener('keydown', (e) => {
      if (this.overlay.style.display !== 'none' && e.key === 'Escape') {
        this.close();
      }
    });

    document.body.appendChild(this.overlay);
  }

  open(): void {
    this.render();
    this.overlay.style.display = '';
  }

  close(): void {
    this.overlay.style.display = 'none';
  }

  private render(): void {
    this.dialog.innerHTML = '';

    const header = document.createElement('header');
    header.className = 'pmd-reference-header';
    const title = document.createElement('h2');
    title.textContent = 'Keyboard shortcuts';
    header.appendChild(title);
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'pmd-reference-close';
    closeBtn.textContent = '×';
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', () => this.close());
    header.appendChild(closeBtn);
    this.dialog.appendChild(header);

    const body = document.createElement('div');
    body.className = 'pmd-reference-body';

    for (const group of GROUPS) {
      const section = document.createElement('section');
      section.className = 'pmd-reference-group';

      const heading = document.createElement('h3');
      heading.className = 'pmd-reference-group-title';
      heading.textContent = group.title;
      section.appendChild(heading);

      const rows = document.createElement('div');
      rows.className = 'pmd-reference-group-rows';

      for (const id of group.commands) {
        const row = document.createElement('div');
        row.className = 'pmd-reference-row';

        const keySpec = DEFAULT_RIBBON_KEYS[id];
        const keys = Array.isArray(keySpec) ? keySpec : [keySpec];
        const keyText = keys
          .map((k) => formatKeyForDisplay(k))
          .filter((s) => s.length > 0)
          .join(' / ');

        const keyEl = document.createElement('span');
        keyEl.className = 'pmd-reference-key';
        keyEl.textContent = keyText || '—';
        row.appendChild(keyEl);

        const labelEl = document.createElement('span');
        labelEl.className = 'pmd-reference-label';
        labelEl.textContent = RIBBON_COMMAND_LABELS[id];
        row.appendChild(labelEl);

        rows.appendChild(row);
      }

      section.appendChild(rows);
      body.appendChild(section);
    }

    this.dialog.appendChild(body);
  }
}

let modal: ReferenceModal | null = null;

export function openReference(): void {
  if (!modal) modal = new ReferenceModal();
  modal.open();
}
