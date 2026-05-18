/**
 * Settings modal UI.
 *
 * Click the gear icon in the header → opens a modal listing every entry
 * in `SETTING_METADATA`. The modal renders the appropriate control
 * (toggle / number / etc.) for each setting and writes through to the
 * settings store immediately.
 */

import {
  SETTING_METADATA,
  SETTINGS_DEFAULTS,
  settings,
  DISPLAY_SIZE_KEYS,
  DISPLAY_COLOR_KEYS,
  type SettingMeta,
  type SettingsCategory,
  type Settings,
  type ReaderConfig,
  type DisplaySizes,
  type DisplayTypography,
  type DisplayColors,
  type FormattingPanelMode,
  type HeadingMode,
  type CondenseWarningDelimiter,
  type ShrinkProtection,
  condenseWarningCloseFor,
} from './settings.js';
import { isFontAvailable } from './font-detect.js';
import { buildKeybindingsEditor } from './keybindings-editor.js';
import { getHost, getElectronHost } from './host/index.js';

/**
 * Available body fonts. A mix of Microsoft Office defaults (likely
 * installed on Windows / Mac with Office), open-source Linux-friendly
 * alternatives (Liberation, DejaVu, Noto), and CSS generic categories
 * (always available). Fonts not installed on the user's system fall
 * back to the next item in the CSS font-family chain.
 */
const COMMON_FONTS = [
  // Microsoft Office defaults
  'Calibri',
  'Cambria',
  'Times New Roman',
  'Arial',
  'Georgia',
  'Verdana',
  // Apple defaults
  'Helvetica',
  // Open-source Linux/cross-platform
  'Liberation Serif',
  'Liberation Sans',
  'DejaVu Serif',
  'DejaVu Sans',
  'Noto Serif',
  'Noto Sans',
  // CSS generic categories (always available, browser picks system default)
  'serif',
  'sans-serif',
  'monospace',
];

/** Human-readable label for each display-size key. */
const DISPLAY_SIZE_LABELS: Record<keyof DisplaySizes, string> = {
  normal: 'Normal (body)',
  pocket: 'Pocket',
  hat: 'Hat',
  block: 'Block',
  tag: 'Tag',
  analytic: 'Analytic',
  cite: 'Cite',
  underline: 'Underline',
  emphasis: 'Emphasis',
  undertag: 'Undertag',
};

/** Tab labels shown in the settings dialog, in display order. */
const CATEGORY_TABS: { id: SettingsCategory; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'editing', label: 'Editing' },
  { id: 'shortcuts', label: 'Keyboard shortcuts' },
  { id: 'comments-ai', label: 'Comments & AI' },
];

class SettingsModal {
  private overlay: HTMLDivElement;
  private dialog: HTMLDivElement;
  /** Rows whose enabled state is gated on another boolean setting,
   *  keyed by the setting that drives them. Refilled each open()
   *  via renderEntry bookkeeping; consumed by `refreshDependents`. */
  private dependentRows: Map<keyof Settings, HTMLElement[]> = new Map();
  /** Unsubscribe handle returned by `settings.subscribe` while the
   *  dialog is open. Cleared on close. */
  private settingsUnsubscribe: (() => void) | null = null;
  /** Currently-selected tab. Persists for the lifetime of the modal
   *  instance (across opens) so reopening lands you back where you
   *  were, but resets if the page reloads. */
  private activeCategory: SettingsCategory = 'general';

  constructor() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'pmd-settings-overlay';
    this.overlay.style.display = 'none';

    this.dialog = document.createElement('div');
    this.dialog.className = 'pmd-settings-dialog';
    this.overlay.appendChild(this.dialog);

    // Click outside the dialog → close.
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });

    // Escape closes.
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
    // Subscribe so toggling any "parent" setting (AI master switch,
    // multi-doc, etc.) greys / un-greys the dependent rows live
    // without needing a re-open.
    this.settingsUnsubscribe = settings.subscribe(() => this.refreshDependents());
    this.refreshDependents();
  }

  close(): void {
    if (this.settingsUnsubscribe) {
      this.settingsUnsubscribe();
      this.settingsUnsubscribe = null;
    }
    this.overlay.style.display = 'none';
  }

  private render(): void {
    this.dialog.innerHTML = '';

    const header = document.createElement('header');
    header.className = 'pmd-settings-header';
    const title = document.createElement('h2');
    title.textContent = 'Settings';
    header.appendChild(title);
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'pmd-settings-close';
    closeBtn.textContent = '×';
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', () => this.close());
    header.appendChild(closeBtn);
    this.dialog.appendChild(header);

    // Tab strip.
    const tabStrip = document.createElement('nav');
    tabStrip.className = 'pmd-settings-tabs';
    tabStrip.setAttribute('role', 'tablist');
    const tabButtons: Partial<Record<SettingsCategory, HTMLButtonElement>> = {};
    for (const { id, label } of CATEGORY_TABS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pmd-settings-tab';
      btn.setAttribute('role', 'tab');
      btn.textContent = label;
      btn.addEventListener('click', () => this.setActiveCategory(id));
      tabStrip.appendChild(btn);
      tabButtons[id] = btn;
    }
    this.dialog.appendChild(tabStrip);

    // Panels — one per category. Only the active panel is visible
    // (set via `hidden`); we build all of them up-front so the
    // refreshDependents pass can find rows under inactive tabs too.
    this.dependentRows.clear();
    const panels: Partial<Record<SettingsCategory, HTMLDivElement>> = {};
    for (const { id } of CATEGORY_TABS) {
      const panel = document.createElement('div');
      panel.className = 'pmd-settings-list pmd-settings-panel';
      panel.setAttribute('role', 'tabpanel');
      const hostKind = getHost().kind;
      const entries = SETTING_METADATA.filter(
        (m) => m.category === id && (!m.electronOnly || hostKind === 'electron'),
      );
      for (const meta of entries) {
        const row = this.renderEntry(meta);
        if (meta.dependsOn) {
          const bucket = this.dependentRows.get(meta.dependsOn) ?? [];
          bucket.push(row);
          this.dependentRows.set(meta.dependsOn, bucket);
        }
        panel.appendChild(row);
      }
      if (entries.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'pmd-settings-empty';
        empty.textContent = 'No settings in this section yet.';
        panel.appendChild(empty);
      }
      this.dialog.appendChild(panel);
      panels[id] = panel;
    }

    // Wire tab selection logic.
    const applyActive = (): void => {
      for (const { id } of CATEGORY_TABS) {
        const isActive = id === this.activeCategory;
        const btn = tabButtons[id];
        const panel = panels[id];
        if (btn) {
          btn.classList.toggle('pmd-settings-tab-active', isActive);
          btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
          btn.tabIndex = isActive ? 0 : -1;
        }
        if (panel) panel.hidden = !isActive;
      }
    };
    this.setActiveCategory = (id: SettingsCategory) => {
      this.activeCategory = id;
      applyActive();
    };
    applyActive();
  }

  /** Re-binding handle so tab buttons can change the active panel
   *  without re-rendering the whole dialog. Reassigned each
   *  `render()` to point at the just-built tabButtons / panels. */
  private setActiveCategory: (id: SettingsCategory) => void = () => {};

  /** Toggle the `pmd-settings-row-disabled` class on every row that
   *  has `dependsOn` set, whenever the parent setting changes. Also
   *  disables every input / button inside those rows so the controls
   *  don't fire events while the row reads as "off". */
  private refreshDependents(): void {
    for (const [parentKey, rows] of this.dependentRows) {
      const enabled = Boolean(settings.get(parentKey));
      for (const row of rows) {
        row.classList.toggle('pmd-settings-row-disabled', !enabled);
        const controls = row.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement | HTMLSelectElement>(
          'input, button, textarea, select',
        );
        for (const c of controls) c.disabled = !enabled;
      }
    }
  }

  private renderEntry(meta: SettingMeta): HTMLElement {
    const row = document.createElement('div');
    row.className = 'pmd-settings-row';

    const label = document.createElement('label');
    label.className = 'pmd-settings-row-label';

    const text = document.createElement('div');
    text.className = 'pmd-settings-row-text';
    const head = document.createElement('span');
    head.className = 'pmd-settings-row-title';
    head.textContent = meta.label;
    text.appendChild(head);
    const descText = meta.descriptionFn ? meta.descriptionFn() : meta.description;
    if (descText) {
      const desc = document.createElement('span');
      desc.className = 'pmd-settings-row-desc';
      desc.textContent = descText;
      text.appendChild(desc);
    }
    label.appendChild(text);

    if (meta.kind === 'toggle') {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'pmd-settings-toggle';
      checkbox.checked = !!settings.get(meta.key);
      checkbox.addEventListener('change', () => {
        settings.set(meta.key as 'showCitePreview', checkbox.checked as never);
      });
      label.appendChild(checkbox);
    } else if (meta.kind === 'readers') {
      // Description above, list editor below — different shape from
      // the inline label+toggle layout.
      row.appendChild(text);
      row.appendChild(buildReadersEditor());
      return row;
    } else if (meta.kind === 'displaySizes') {
      row.appendChild(text);
      row.appendChild(buildDisplaySizesEditor());
      return row;
    } else if (meta.kind === 'displayTypography') {
      row.appendChild(text);
      row.appendChild(buildTypographyEditor());
      return row;
    } else if (meta.kind === 'displayColors') {
      row.appendChild(text);
      row.appendChild(buildColorsEditor());
      return row;
    } else if (meta.kind === 'bodyFont') {
      row.appendChild(text);
      row.appendChild(buildBodyFontEditor());
      return row;
    } else if (meta.kind === 'lineHeights') {
      row.appendChild(text);
      row.appendChild(buildLineHeightsEditor());
      return row;
    } else if (meta.kind === 'formattingPanelMode') {
      label.appendChild(buildFormattingPanelModeEditor());
    } else if (meta.kind === 'multiDocLayoutMode') {
      row.appendChild(text);
      row.appendChild(buildMultiDocLayoutModeEditor());
      return row;
    } else if (meta.kind === 'speechDocFormat') {
      row.appendChild(text);
      row.appendChild(buildSpeechDocFormatEditor());
      return row;
    } else if (meta.kind === 'saveFormat') {
      row.appendChild(text);
      row.appendChild(buildSaveFormatEditor());
      return row;
    } else if (meta.kind === 'headingMode') {
      row.appendChild(text);
      row.appendChild(buildHeadingModeEditor());
      return row;
    } else if (meta.kind === 'condenseWarningDelimiter') {
      row.appendChild(text);
      row.appendChild(buildCondenseWarningDelimiterEditor());
      return row;
    } else if (meta.kind === 'shrinkCustomProtections') {
      row.appendChild(text);
      row.appendChild(buildShrinkProtectionsEditor());
      return row;
    } else if (meta.kind === 'keybindings') {
      row.appendChild(text);
      row.appendChild(buildKeybindingsEditor());
      return row;
    } else if (meta.kind === 'folder') {
      // Path display + Browse… / Clear buttons, mounted UNDER the
      // explainer paragraph (same shape as readers / displaySizes /
      // etc). The inline-label layout would cram the path next to
      // the title and clip on anything longer than `~/foo`. Only
      // ever used for electronOnly settings, so the picker host is
      // always present at click time.
      const wrap = document.createElement('div');
      wrap.className = 'pmd-settings-folder';
      const pathEl = document.createElement('span');
      pathEl.className = 'pmd-settings-folder-path';
      const refreshPath = (): void => {
        const value = settings.get(meta.key) as string;
        pathEl.textContent = value || '(not set)';
        pathEl.classList.toggle('pmd-settings-folder-empty', !value);
      };
      refreshPath();
      const browseBtn = document.createElement('button');
      browseBtn.type = 'button';
      browseBtn.className = 'pmd-settings-btn';
      browseBtn.textContent = 'Browse…';
      browseBtn.addEventListener('click', () => {
        void (async (): Promise<void> => {
          // `folder` kind is gated by `electronOnly`, so the host
          // is always Electron here. If it's somehow not, no-op
          // safely rather than throw.
          const electron = getElectronHost();
          if (!electron) return;
          const current = settings.get(meta.key) as string;
          const picked = await electron.pickDirectory({
            defaultPath: current || undefined,
            title: meta.label,
          });
          if (picked == null) return;
          settings.set(meta.key, picked as never);
          refreshPath();
        })();
      });
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'pmd-settings-btn';
      clearBtn.textContent = 'Clear';
      clearBtn.addEventListener('click', () => {
        settings.set(meta.key, '' as never);
        refreshPath();
      });
      wrap.appendChild(pathEl);
      wrap.appendChild(browseBtn);
      wrap.appendChild(clearBtn);
      row.appendChild(text);
      row.appendChild(wrap);
      return row;
    } else if (meta.kind === 'text' || meta.kind === 'password') {
      // Plain string input. Used for comment author / initials,
      // Anthropic API key, etc. Password kind masks the value.
      const input = document.createElement('input');
      input.type = meta.kind === 'password' ? 'password' : 'text';
      input.className = 'pmd-settings-text';
      input.autocomplete = 'off';
      input.spellcheck = false;
      const initial = settings.get(meta.key);
      input.value = typeof initial === 'string' ? initial : '';
      input.addEventListener('change', () => {
        settings.set(meta.key as 'commentAuthor', input.value as never);
      });
      label.appendChild(input);
    } else if (meta.kind === 'aiCitePrompt') {
      // Just a button — the actual prompt editor pops up in its
      // own modal because the prompt's long enough that an inline
      // textarea would shove the rest of the settings dialog off-
      // screen.
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pmd-settings-btn';
      btn.textContent = 'Edit prompt';
      btn.addEventListener('click', () => {
        void import('./ai/edit-prompt-modal.js').then((m) => m.openCitePromptEditor());
      });
      label.appendChild(btn);
    } else if (meta.kind === 'clod') {
      // Standard boolean toggle with an easter-egg twist:
      // Mod (Ctrl/Cmd) + Alt + Shift + click opens the Clod
      // customization dialog (activity pools per time period,
      // time-period boundaries). The three-modifier combo is
      // deliberately obscure — you have to know it's there.
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'pmd-settings-toggle';
      checkbox.checked = !!settings.get(meta.key);
      // The click event arrives BEFORE `change`, so we can detect
      // the easter-egg combo and bail out of the normal toggle path
      // when triggered.
      checkbox.addEventListener('click', (e) => {
        if (!(e instanceof MouseEvent)) return;
        const mod = e.ctrlKey || e.metaKey;
        if (!(mod && e.altKey && e.shiftKey)) return;
        e.preventDefault();
        // Browsers fire `change` even when click default is prevented
        // for some checkbox states; restore the checked value
        // explicitly so the toggle doesn't flip as a side-effect.
        checkbox.checked = !!settings.get(meta.key);
        void import('./ai/clod-configurator.js').then((m) => m.openClodConfigurator());
      });
      checkbox.addEventListener('change', () => {
        settings.set(meta.key as 'clodEnabled', checkbox.checked as never);
      });
      label.appendChild(checkbox);
    }

    row.appendChild(label);
    return row;
  }
}

function buildTypographyEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-typography-editor';

  function flagRow(
    key: keyof DisplayTypography,
    labelText: string,
  ): HTMLElement {
    const row = document.createElement('label');
    row.className = 'pmd-typography-flag-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!settings.get('displayTypography')[key];
    cb.addEventListener('change', () => {
      settings.set('displayTypography', {
        ...settings.get('displayTypography'),
        [key]: cb.checked,
      });
    });
    row.appendChild(cb);
    const lbl = document.createElement('span');
    lbl.textContent = labelText;
    row.appendChild(lbl);
    return row;
  }

  wrap.appendChild(flagRow('citeUnderlined', 'Cite: underlined'));
  wrap.appendChild(flagRow('underlineBold', 'Underline: bold'));
  wrap.appendChild(flagRow('undertagItalic', 'Undertag: italic'));
  wrap.appendChild(flagRow('undertagBold', 'Undertag: bold'));
  wrap.appendChild(flagRow('emphasisBold', 'Emphasis: bold'));
  wrap.appendChild(flagRow('emphasisItalic', 'Emphasis: italic'));
  wrap.appendChild(flagRow('emphasisBox', 'Emphasis: boxed'));

  const sizeRow = document.createElement('label');
  sizeRow.className = 'pmd-typography-size-row';
  const sizeLbl = document.createElement('span');
  sizeLbl.textContent = 'Emphasis box thickness:';
  sizeRow.appendChild(sizeLbl);
  const sizeInput = document.createElement('input');
  sizeInput.type = 'number';
  sizeInput.className = 'pmd-typography-size-input';
  sizeInput.min = '0.25';
  sizeInput.max = '12';
  sizeInput.step = '0.25';
  sizeInput.value = String(settings.get('displayTypography').emphasisBoxSize);
  sizeInput.addEventListener('change', () => {
    const v = parseFloat(sizeInput.value);
    if (!Number.isFinite(v) || v <= 0) {
      sizeInput.value = String(settings.get('displayTypography').emphasisBoxSize);
      return;
    }
    settings.set('displayTypography', {
      ...settings.get('displayTypography'),
      emphasisBoxSize: v,
    });
  });
  sizeRow.appendChild(sizeInput);
  const unit = document.createElement('span');
  unit.className = 'pmd-typography-unit';
  unit.textContent = 'pt';
  sizeRow.appendChild(unit);
  wrap.appendChild(sizeRow);

  // Lives in this sub-editor (not as a top-level row) because it's a
  // sub-option of emphasis-box rendering — sits below the box thickness.
  const hideBordersRow = document.createElement('label');
  hideBordersRow.className = 'pmd-typography-flag-row pmd-typography-flag-row-with-desc';
  const hideBordersCb = document.createElement('input');
  hideBordersCb.type = 'checkbox';
  hideBordersCb.checked = !!settings.get('hideEmphasisBordersInReadMode');
  hideBordersCb.addEventListener('change', () => {
    settings.set('hideEmphasisBordersInReadMode', hideBordersCb.checked);
  });
  hideBordersRow.appendChild(hideBordersCb);
  const hideBordersText = document.createElement('div');
  hideBordersText.className = 'pmd-typography-flag-text';
  const hideBordersLbl = document.createElement('span');
  hideBordersLbl.textContent = 'Hide all emphasis borders in read mode';
  hideBordersText.appendChild(hideBordersLbl);
  const hideBordersDesc = document.createElement('span');
  hideBordersDesc.className = 'pmd-typography-flag-desc';
  hideBordersDesc.textContent =
    'Turn this on to strip every emphasis border in read mode, including around highlighted text.';
  hideBordersText.appendChild(hideBordersDesc);
  hideBordersRow.appendChild(hideBordersText);
  wrap.appendChild(hideBordersRow);

  // Re-render input values if settings change elsewhere.
  const unsubscribe = settings.subscribe(() => {
    const t = settings.get('displayTypography');
    sizeInput.value = String(t.emphasisBoxSize);
    // Sync checkboxes — the first N are typography flags (column order
    // matches flagKeys), the last is the hide-emphasis-borders toggle.
    const checkboxes = wrap.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    const flagKeys: (keyof DisplayTypography)[] = [
      'citeUnderlined', 'underlineBold',
      'undertagItalic', 'undertagBold',
      'emphasisBold', 'emphasisItalic', 'emphasisBox',
    ];
    flagKeys.forEach((k, i) => {
      const cb = checkboxes[i];
      if (cb) cb.checked = !!t[k];
    });
    const hideCb = checkboxes[flagKeys.length];
    if (hideCb) hideCb.checked = !!settings.get('hideEmphasisBordersInReadMode');
  });
  wrap.addEventListener('DOMNodeRemoved', () => unsubscribe());

  return wrap;
}

function buildColorsEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-colors-editor';

  const inputs: Partial<Record<keyof DisplayColors, HTMLInputElement>> = {};

  const LABELS: Record<keyof DisplayColors, string> = {
    analytic: 'Analytic',
    undertag: 'Undertag',
  };

  for (const key of DISPLAY_COLOR_KEYS) {
    const row = document.createElement('label');
    row.className = 'pmd-colors-row';

    const lbl = document.createElement('span');
    lbl.className = 'pmd-colors-label';
    lbl.textContent = LABELS[key];
    row.appendChild(lbl);

    const picker = document.createElement('input');
    picker.type = 'color';
    picker.className = 'pmd-colors-input';
    picker.value = settings.get('displayColors')[key];
    picker.addEventListener('input', () => {
      settings.set('displayColors', {
        ...settings.get('displayColors'),
        [key]: picker.value,
      });
    });
    row.appendChild(picker);

    inputs[key] = picker;
    wrap.appendChild(row);
  }

  // Sync if settings change elsewhere (e.g. another tab).
  const unsubscribe = settings.subscribe(() => {
    const c = settings.get('displayColors');
    for (const key of DISPLAY_COLOR_KEYS) {
      const inp = inputs[key];
      if (inp && inp.value !== c[key]) inp.value = c[key];
    }
  });
  wrap.addEventListener('DOMNodeRemoved', () => unsubscribe());

  return wrap;
}

function buildBodyFontEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-body-font-editor';

  const select = document.createElement('select');
  select.className = 'pmd-body-font-select';

  function populate(): void {
    select.innerHTML = '';
    const current = settings.get('bodyFont');
    // Filter to fonts that are actually installed (or that we can't
    // detect — generics always pass). Always include the user's
    // current selection even if it's not detected, so a saved-but-
    // unavailable font is still visible & re-selectable.
    const available = COMMON_FONTS.filter(isFontAvailable);
    const options = available.includes(current)
      ? available
      : [current, ...available];
    for (const font of options) {
      const opt = document.createElement('option');
      opt.value = font;
      opt.textContent = font;
      // Render each option in the font itself so the user can preview
      // before committing. Generic CSS keywords (serif, sans-serif,
      // monospace) must NOT be quoted; named fonts must be.
      const isGeneric = ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui'].includes(font);
      opt.style.fontFamily = isGeneric ? font : `"${font}", sans-serif`;
      if (font === current) opt.selected = true;
      select.appendChild(opt);
    }
  }

  populate();

  select.addEventListener('change', () => {
    settings.set('bodyFont', select.value);
  });

  wrap.appendChild(select);

  const unsubscribe = settings.subscribe(() => {
    if (select.value !== settings.get('bodyFont')) populate();
  });
  wrap.addEventListener('DOMNodeRemoved', () => unsubscribe());

  return wrap;
}

type LineHeightKey =
  | 'lineHeight'
  | 'lineHeightCite'
  | 'lineHeightTag'
  | 'lineHeightAnalytic'
  | 'lineHeightHeading'
  | 'lineHeightUndertag';

const LINE_HEIGHT_ROWS: { key: LineHeightKey; label: string }[] = [
  { key: 'lineHeight', label: 'Body' },
  { key: 'lineHeightCite', label: 'Cite paragraphs' },
  { key: 'lineHeightTag', label: 'Tags' },
  { key: 'lineHeightAnalytic', label: 'Analytics' },
  { key: 'lineHeightHeading', label: 'Pocket / Hat / Block' },
  { key: 'lineHeightUndertag', label: 'Undertags' },
];

function buildLineHeightsEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-line-heights-editor';

  const rowsContainer = document.createElement('div');
  rowsContainer.className = 'pmd-line-heights-rows';
  wrap.appendChild(rowsContainer);

  function render(): void {
    rowsContainer.innerHTML = '';
    for (const { key, label: labelText } of LINE_HEIGHT_ROWS) {
      const row = document.createElement('div');
      row.className = 'pmd-line-height-row';

      const label = document.createElement('label');
      label.className = 'pmd-line-height-row-label';
      label.textContent = labelText;
      row.appendChild(label);

      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'pmd-line-height-input';
      input.min = '1.0';
      input.max = '2.0';
      input.step = '0.05';
      input.value = String(settings.get(key));
      input.addEventListener('change', () => {
        const v = parseFloat(input.value);
        if (!Number.isFinite(v)) {
          input.value = String(settings.get(key));
          return;
        }
        settings.set(key, v);
      });
      row.appendChild(input);

      const unit = document.createElement('span');
      unit.className = 'pmd-line-height-unit';
      unit.textContent = '× font size';
      row.appendChild(unit);

      rowsContainer.appendChild(row);
    }
  }

  // Reset button: restores every line-spacing knob to its built-in
  // default. Same styling/shape as the zoom reset button in the
  // status bar.
  const footer = document.createElement('div');
  footer.className = 'pmd-line-heights-footer';
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'pmd-line-heights-reset-btn';
  resetBtn.textContent = '↺';
  resetBtn.title = 'Restore defaults';
  resetBtn.setAttribute('aria-label', 'Restore line spacing defaults');
  resetBtn.addEventListener('click', () => {
    for (const { key } of LINE_HEIGHT_ROWS) {
      settings.set(key, SETTINGS_DEFAULTS[key]);
    }
  });
  footer.appendChild(resetBtn);
  wrap.appendChild(footer);

  const unsubscribe = settings.subscribe(() => {
    if (!(document.activeElement && wrap.contains(document.activeElement))) {
      render();
    }
  });
  render();
  wrap.addEventListener('DOMNodeRemoved', () => unsubscribe());

  return wrap;
}

function buildDisplaySizesEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-display-sizes-editor';

  function commit(next: DisplaySizes): void {
    settings.set('displaySizes', next);
  }

  function render(): void {
    wrap.innerHTML = '';
    const sizes = settings.get('displaySizes');
    for (const key of DISPLAY_SIZE_KEYS) {
      const row = document.createElement('div');
      row.className = 'pmd-display-size-row';

      const label = document.createElement('label');
      label.className = 'pmd-display-size-label';
      label.textContent = DISPLAY_SIZE_LABELS[key];
      row.appendChild(label);

      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'pmd-display-size-input';
      input.min = '1';
      input.max = '144';
      input.step = '0.5';
      input.value = String(sizes[key]);
      input.addEventListener('change', () => {
        const v = parseFloat(input.value);
        if (!Number.isFinite(v) || v <= 0) {
          input.value = String(sizes[key]);
          return;
        }
        commit({ ...settings.get('displaySizes'), [key]: v });
      });
      row.appendChild(input);

      const unit = document.createElement('span');
      unit.className = 'pmd-display-size-unit';
      unit.textContent = 'pt';
      row.appendChild(unit);

      wrap.appendChild(row);
    }
  }

  const unsubscribe = settings.subscribe((s) => {
    void s;
    render();
  });
  render();

  wrap.addEventListener('DOMNodeRemoved', () => {
    unsubscribe();
  });

  return wrap;
}

function buildReadersEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-readers-editor';

  const list = document.createElement('div');
  list.className = 'pmd-readers-list';
  wrap.appendChild(list);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'pmd-readers-add';
  addBtn.textContent = '+ Add reader';
  wrap.appendChild(addBtn);

  function commit(readers: ReaderConfig[]): void {
    settings.set('readers', readers);
  }

  function render(): void {
    list.innerHTML = '';
    const readers = settings.get('readers');

    readers.forEach((reader, idx) => {
      const row = document.createElement('div');
      row.className = 'pmd-reader-row';

      const primary = document.createElement('span');
      primary.className = 'pmd-reader-rank';
      primary.textContent = idx < 2 ? `#${idx + 1}` : '';
      primary.title = idx < 2 ? 'Shown live in the status bar' : 'Shown in Word Count Selection only';
      row.appendChild(primary);

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'pmd-reader-name';
      nameInput.value = reader.name;
      nameInput.placeholder = 'Name';
      nameInput.addEventListener('change', () => {
        const next = settings.get('readers').map((r, i) =>
          i === idx ? { ...r, name: nameInput.value.trim() || r.name } : r,
        );
        commit(next);
      });
      row.appendChild(nameInput);

      const wpmInput = document.createElement('input');
      wpmInput.type = 'number';
      wpmInput.className = 'pmd-reader-wpm';
      wpmInput.min = '1';
      wpmInput.step = '1';
      wpmInput.value = String(reader.wpm);
      wpmInput.addEventListener('change', () => {
        const v = parseInt(wpmInput.value, 10);
        if (!Number.isFinite(v) || v <= 0) {
          wpmInput.value = String(reader.wpm);
          return;
        }
        const next = settings.get('readers').map((r, i) =>
          i === idx ? { ...r, wpm: v } : r,
        );
        commit(next);
      });
      row.appendChild(wpmInput);

      const wpmLabel = document.createElement('span');
      wpmLabel.className = 'pmd-reader-wpm-label';
      wpmLabel.textContent = 'wpm';
      row.appendChild(wpmLabel);

      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'pmd-reader-move';
      upBtn.textContent = '↑';
      upBtn.title = 'Move up';
      upBtn.disabled = idx === 0;
      upBtn.addEventListener('click', () => {
        const cur = [...settings.get('readers')];
        if (idx === 0) return;
        [cur[idx - 1], cur[idx]] = [cur[idx]!, cur[idx - 1]!];
        commit(cur);
      });
      row.appendChild(upBtn);

      const downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.className = 'pmd-reader-move';
      downBtn.textContent = '↓';
      downBtn.title = 'Move down';
      downBtn.disabled = idx === readers.length - 1;
      downBtn.addEventListener('click', () => {
        const cur = [...settings.get('readers')];
        if (idx >= cur.length - 1) return;
        [cur[idx], cur[idx + 1]] = [cur[idx + 1]!, cur[idx]!];
        commit(cur);
      });
      row.appendChild(downBtn);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'pmd-reader-delete';
      delBtn.textContent = '×';
      delBtn.title = 'Remove reader';
      delBtn.addEventListener('click', () => {
        const next = settings.get('readers').filter((_, i) => i !== idx);
        if (next.length === 0) return; // keep at least one
        commit(next);
      });
      row.appendChild(delBtn);

      list.appendChild(row);
    });
  }

  addBtn.addEventListener('click', () => {
    const cur = settings.get('readers');
    commit([...cur, { name: `Reader ${cur.length + 1}`, wpm: 200 }]);
  });

  // Re-render when readers change (e.g., from elsewhere or own edits).
  const unsubscribe = settings.subscribe((s) => {
    // Only re-render if the readers list changed.
    void s;
    render();
  });
  // Also re-render once now.
  render();

  // Best-effort cleanup if the editor is detached (modal closes & rebuilds).
  wrap.addEventListener('DOMNodeRemoved', () => {
    unsubscribe();
  });

  return wrap;
}

function buildFormattingPanelModeEditor(): HTMLElement {
  const select = document.createElement('select');
  select.className = 'pmd-formatting-panel-mode-select';
  const options: { value: FormattingPanelMode; label: string }[] = [
    { value: 'labels', label: 'Show style names' },
    { value: 'shortcuts', label: 'Show keyboard shortcuts' },
    { value: 'both', label: 'Show name · shortcut' },
    { value: 'hidden', label: 'Hide the panel' },
  ];
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.value === settings.get('formattingPanelMode')) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    settings.set('formattingPanelMode', select.value as FormattingPanelMode);
  });
  return select;
}

function buildSpeechDocFormatEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-multi-doc-layout-mode-editor';
  const options: { value: 'docx' | 'cmir'; label: string }[] = [
    { value: 'docx', label: '.docx — Verbatim-compatible (default)' },
    { value: 'cmir', label: '.cmir — CardMirror native (enables autosave)' },
  ];
  const groupName = `pmd-speech-doc-format-${Math.random().toString(36).slice(2, 8)}`;
  for (const o of options) {
    const row = document.createElement('label');
    row.className = 'pmd-multi-doc-layout-mode-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = groupName;
    input.value = o.value;
    input.checked = o.value === settings.get('defaultSpeechDocFormat');
    input.addEventListener('change', () => {
      if (input.checked) settings.set('defaultSpeechDocFormat', o.value);
    });
    row.appendChild(input);
    const labelText = document.createElement('span');
    labelText.className = 'pmd-multi-doc-layout-mode-row-label';
    labelText.textContent = o.label;
    row.appendChild(labelText);
    wrap.appendChild(row);
  }
  return wrap;
}

function buildSaveFormatEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-multi-doc-layout-mode-editor';
  const options: { value: 'docx' | 'cmir'; label: string }[] = [
    { value: 'docx', label: '.docx — Word / Verbatim-compatible (default)' },
    { value: 'cmir', label: '.cmir — CardMirror native (enables autosave)' },
  ];
  const groupName = `pmd-save-format-${Math.random().toString(36).slice(2, 8)}`;
  for (const o of options) {
    const row = document.createElement('label');
    row.className = 'pmd-multi-doc-layout-mode-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = groupName;
    input.value = o.value;
    input.checked = o.value === settings.get('defaultSaveFormat');
    input.addEventListener('change', () => {
      if (input.checked) settings.set('defaultSaveFormat', o.value);
    });
    row.appendChild(input);
    const labelText = document.createElement('span');
    labelText.className = 'pmd-multi-doc-layout-mode-row-label';
    labelText.textContent = o.label;
    row.appendChild(labelText);
    wrap.appendChild(row);
  }
  return wrap;
}

function buildMultiDocLayoutModeEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-multi-doc-layout-mode-editor';
  const options: { value: 'compact' | 'wide'; label: string }[] = [
    { value: 'compact', label: 'Compact — all 3 panes side by side' },
    { value: 'wide', label: 'Wide-scroll — 2 full + edge of 3rd (click to snap)' },
  ];
  const groupName = `pmd-multi-doc-layout-${Math.random().toString(36).slice(2, 8)}`;
  for (const o of options) {
    const row = document.createElement('label');
    row.className = 'pmd-multi-doc-layout-mode-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = groupName;
    input.value = o.value;
    input.checked = o.value === settings.get('multiDocLayoutMode');
    input.addEventListener('change', () => {
      if (input.checked) settings.set('multiDocLayoutMode', o.value);
    });
    row.appendChild(input);
    const labelText = document.createElement('span');
    labelText.className = 'pmd-multi-doc-layout-mode-row-label';
    labelText.textContent = o.label;
    row.appendChild(labelText);
    wrap.appendChild(row);
  }
  return wrap;
}

function buildHeadingModeEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-heading-mode-editor';
  const options: { value: HeadingMode; label: string }[] = [
    { value: 'strict', label: "Strict — don't condense if headings are in the selection" },
    { value: 'respect', label: 'Respect — keep headings separate, merge the rest (default)' },
    { value: 'demolish', label: 'Demolish — merge everything, headings included' },
  ];
  // Radio buttons instead of a <select> so the long option labels
  // wrap to multiple lines if the dialog is narrow.
  const groupName = `pmd-heading-mode-${Math.random().toString(36).slice(2, 8)}`;
  for (const o of options) {
    const row = document.createElement('label');
    row.className = 'pmd-heading-mode-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = groupName;
    input.value = o.value;
    input.checked = o.value === settings.get('headingMode');
    input.addEventListener('change', () => {
      if (input.checked) settings.set('headingMode', o.value);
    });
    row.appendChild(input);
    const text = document.createElement('span');
    text.className = 'pmd-heading-mode-row-label';
    text.textContent = o.label;
    row.appendChild(text);
    wrap.appendChild(row);
  }
  return wrap;
}

function buildCondenseWarningDelimiterEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-condense-warning-delimiter-editor';
  const opens: CondenseWarningDelimiter[] = ['[', '[[', '<', '<<', '{', '{{'];
  const groupName = `pmd-cw-delim-${Math.random().toString(36).slice(2, 8)}`;
  for (const open of opens) {
    const close = condenseWarningCloseFor(open);
    const row = document.createElement('label');
    row.className = 'pmd-condense-warning-delimiter-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = groupName;
    input.value = open;
    input.checked = open === settings.get('condenseWarningDelimiter');
    input.addEventListener('change', () => {
      if (input.checked) settings.set('condenseWarningDelimiter', open);
    });
    row.appendChild(input);
    const sample = document.createElement('span');
    sample.className = 'pmd-condense-warning-delimiter-sample';
    sample.textContent = `${open}PARAGRAPH INTEGRITY PAUSES${close}`;
    row.appendChild(sample);
    wrap.appendChild(row);
  }

  // Custom row: radio + two short text inputs for open/close. When
  // 'custom' is selected, the inputs become live; otherwise they're
  // still editable (so the user can type before committing the radio
  // — Word-style) but visually muted.
  const customRow = document.createElement('label');
  customRow.className =
    'pmd-condense-warning-delimiter-row pmd-condense-warning-delimiter-row-custom';
  const customRadio = document.createElement('input');
  customRadio.type = 'radio';
  customRadio.name = groupName;
  customRadio.value = 'custom';
  customRadio.checked = settings.get('condenseWarningDelimiter') === 'custom';
  customRadio.addEventListener('change', () => {
    if (customRadio.checked) settings.set('condenseWarningDelimiter', 'custom');
  });
  customRow.appendChild(customRadio);

  const pauseInput = document.createElement('input');
  pauseInput.type = 'text';
  pauseInput.className = 'pmd-condense-warning-delimiter-input';
  pauseInput.placeholder = 'replaces [PARAGRAPH INTEGRITY PAUSES]';
  pauseInput.value = settings.get('condenseWarningCustomPauseMarker');
  pauseInput.addEventListener('input', () => {
    settings.set('condenseWarningCustomPauseMarker', pauseInput.value);
  });

  const resumeInput = document.createElement('input');
  resumeInput.type = 'text';
  resumeInput.className = 'pmd-condense-warning-delimiter-input';
  resumeInput.placeholder = 'replaces [PARAGRAPH INTEGRITY RESUMES]';
  resumeInput.value = settings.get('condenseWarningCustomResumeMarker');
  resumeInput.addEventListener('input', () => {
    settings.set('condenseWarningCustomResumeMarker', resumeInput.value);
  });

  // The label-text portion: a column with the "Custom" header and
  // the two full-marker inputs stacked. Each input is the WHOLE
  // text that goes into the marker paragraph (not just a bracket),
  // so there's no sample preview — the input value IS the preview.
  // The outer row's `align-items: flex-start` keeps the radio
  // aligned with the header at the top of the column.
  const customInner = document.createElement('div');
  customInner.className = 'pmd-condense-warning-delimiter-custom-inner';
  const customLabel = document.createElement('div');
  customLabel.textContent = 'Custom (must set both):';
  customLabel.className = 'pmd-condense-warning-delimiter-custom-label';
  customInner.appendChild(customLabel);
  customInner.appendChild(pauseInput);
  customInner.appendChild(resumeInput);
  customRow.appendChild(customInner);
  wrap.appendChild(customRow);

  return wrap;
}

/**
 * Custom shrink-protections editor — analogous to the readers editor
 * but with a per-row `regex` checkbox. Each row: text input for the
 * pattern, regex checkbox, delete button. Footer "+ Add" button.
 *
 * Validation: invalid regex sources flash an inline note on the row.
 * Shrink itself silently skips them at compile time, so a typo
 * doesn't break the command — the note is purely a UX hint.
 */
function buildShrinkProtectionsEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-shrink-protections-editor';

  const list = document.createElement('div');
  list.className = 'pmd-shrink-protections-list';
  wrap.appendChild(list);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'pmd-shrink-protections-add';
  addBtn.textContent = '+ Add protection';
  wrap.appendChild(addBtn);

  function commit(next: ShrinkProtection[]): void {
    settings.set('shrinkCustomProtections', next);
  }

  function render(): void {
    list.innerHTML = '';
    const rules = settings.get('shrinkCustomProtections');
    rules.forEach((rule, idx) => {
      const row = document.createElement('div');
      row.className = 'pmd-shrink-protection-row';

      const patternInput = document.createElement('input');
      patternInput.type = 'text';
      patternInput.className = 'pmd-shrink-protection-pattern';
      patternInput.value = rule.pattern;
      patternInput.placeholder = rule.isRegex
        ? 'regex source'
        : 'literal string';
      patternInput.addEventListener('change', () => {
        const next = settings.get('shrinkCustomProtections').map((r, i) =>
          i === idx ? { ...r, pattern: patternInput.value } : r,
        );
        commit(next);
      });
      row.appendChild(patternInput);

      const regexLabel = document.createElement('label');
      regexLabel.className = 'pmd-shrink-protection-regex-toggle';
      const regexCb = document.createElement('input');
      regexCb.type = 'checkbox';
      regexCb.checked = rule.isRegex;
      regexCb.addEventListener('change', () => {
        const next = settings.get('shrinkCustomProtections').map((r, i) =>
          i === idx ? { ...r, isRegex: regexCb.checked } : r,
        );
        commit(next);
      });
      regexLabel.appendChild(regexCb);
      const regexTxt = document.createElement('span');
      regexTxt.textContent = 'regex';
      regexLabel.appendChild(regexTxt);
      row.appendChild(regexLabel);

      // Inline note for invalid regex sources. Updated on input so
      // the user gets immediate feedback.
      const note = document.createElement('span');
      note.className = 'pmd-shrink-protection-note';
      const validate = (): void => {
        if (!regexCb.checked || !patternInput.value) {
          note.textContent = '';
          return;
        }
        try {
          new RegExp(patternInput.value, 'gi');
          note.textContent = '';
        } catch (err) {
          note.textContent = `invalid: ${(err as Error).message}`;
        }
      };
      patternInput.addEventListener('input', validate);
      regexCb.addEventListener('change', validate);
      validate();

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'pmd-shrink-protection-delete';
      delBtn.textContent = '×';
      delBtn.title = 'Remove protection';
      delBtn.addEventListener('click', () => {
        const next = settings
          .get('shrinkCustomProtections')
          .filter((_, i) => i !== idx);
        commit(next);
      });
      row.appendChild(delBtn);

      // Note goes after the delete button so its `flex: 0 0 100%`
      // wraps to its own line BELOW the row instead of pushing the
      // delete button down. Order in DOM dictates wrap order.
      row.appendChild(note);

      list.appendChild(row);
    });

    if (rules.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'pmd-shrink-protections-empty';
      empty.textContent = 'No custom protections.';
      list.appendChild(empty);
    }
  }

  addBtn.addEventListener('click', () => {
    const cur = settings.get('shrinkCustomProtections');
    commit([...cur, { pattern: '', isRegex: false }]);
  });

  const unsubscribe = settings.subscribe((s) => {
    void s;
    // Skip re-render while the user is TYPING in a text input — a
    // re-render would replace the input element and drop focus. But
    // do re-render when buttons / checkboxes are focused (so + Add
    // and × delete refresh the list live).
    const active = document.activeElement;
    const isTextInputFocused =
      active instanceof HTMLInputElement &&
      active.type === 'text' &&
      wrap.contains(active);
    if (!isTextInputFocused) render();
  });
  render();
  wrap.addEventListener('DOMNodeRemoved', () => unsubscribe());

  return wrap;
}

let singleton: SettingsModal | null = null;

export function openSettings(): void {
  if (!singleton) singleton = new SettingsModal();
  singleton.open();
}
