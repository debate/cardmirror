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
  type ReaderConfig,
  type DisplaySizes,
  type DisplayTypography,
  type DisplayColors,
  type FormattingPanelMode,
  type HeadingMode,
} from './settings.js';
import { isFontAvailable } from './font-detect.js';

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

class SettingsModal {
  private overlay: HTMLDivElement;
  private dialog: HTMLDivElement;

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
  }

  close(): void {
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

    const list = document.createElement('div');
    list.className = 'pmd-settings-list';
    for (const meta of SETTING_METADATA) {
      list.appendChild(this.renderEntry(meta));
    }
    if (SETTING_METADATA.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'pmd-settings-empty';
      empty.textContent = 'No settings to configure yet.';
      list.appendChild(empty);
    }
    this.dialog.appendChild(list);
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
    if (meta.description) {
      const desc = document.createElement('span');
      desc.className = 'pmd-settings-row-desc';
      desc.textContent = meta.description;
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
    } else if (meta.kind === 'headingMode') {
      row.appendChild(text);
      row.appendChild(buildHeadingModeEditor());
      return row;
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

let singleton: SettingsModal | null = null;

export function openSettings(): void {
  if (!singleton) singleton = new SettingsModal();
  singleton.open();
}
