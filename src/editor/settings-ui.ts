/**
 * Settings modal UI.
 *
 * Click the gear icon in the header → opens a modal listing every entry
 * in `SETTING_METADATA`. The modal renders the appropriate control
 * (toggle / number / etc.) for each setting and writes through to the
 * settings store immediately.
 */

import {
  CUSTOMIZABLE_COLOR_TOKENS,
  DISPLAY_COLOR_TOKEN_TO_KEY,
  DEFAULT_DISPLAY_COLORS,
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
  DEFAULT_PARAGRAPH_SPACING,
  type ParagraphSpacingKey,
  type DisplayTypography,
  type DisplayColors,
  type FormattingPanelMode,
  type HeadingMode,
  type CondenseWarningDelimiter,
  type ShrinkProtection,
  type PairingPartner,
  type PairingGroup,
  condenseWarningCloseFor,
} from './settings.js';
import { generateGroupId, normalizePairingCode } from './pairing/pairing-ids.js';
import { regenerateOwnCode } from './pairing/pairing-wiring.js';
import { isFontAvailable } from './font-detect.js';
import { WORD_HIGHLIGHT_COLORS } from './color-palette.js';
import { buildKeybindingsEditor } from './keybindings-editor.js';
import { TRANSLATION_LANGUAGES } from './translate.js';
import { getHost, getElectronHost, isWindowsHost } from './host/index.js';
import { pushOverlay, popOverlay, isTopOverlay } from './overlay-stack.js';
import { getInstallInfo } from './install-info.js';
import { launchBenchmarkOverlay } from './benchmark-ui.js';
import { resetTimer } from './timer-state.js';
import { showToast } from './toast.js';
import { setIcon } from './icons';
import {
  FILE_OBJECT_KINDS,
  FILE_OBJECT_KIND_LABELS,
  type FileObjectKind,
} from './file-search.js';

/**
 * Available body fonts, organized into labeled groups. The dropdown
 * uses `<optgroup>` so the user can find a font by category. Fonts
 * not installed on the system are filtered out per-group via
 * `isFontAvailable`; if every font in a group is unavailable the
 * whole group is suppressed.
 *
 * The "Recommended for readability" group leads. The first three
 * entries (Atkinson Hyperlegible, Lexend, OpenDyslexic) are
 * SIL OFL fonts bundled with the app so every install has at least
 * one readability-tuned option regardless of what's on the host OS
 * — see `style.css`'s @font-face block and `src/editor/fonts/`.
 * The remaining three (Verdana, Tahoma, Comic Sans MS) are the
 * British Dyslexia Association's 2023 endorsed system sans-serifs
 * for body text aimed at dyslexic readers; they appear in the
 * group when the user's OS has them installed.
 */
interface FontGroup {
  label: string;
  fonts: string[];
}

const FONT_GROUPS: FontGroup[] = [
  {
    label: 'Recommended for readability',
    fonts: [
      // Bundled (SIL OFL). Always available.
      'Atkinson Hyperlegible',
      'Lexend',
      'OpenDyslexic',
      // System fonts — BDA-recommended; shown only if installed.
      'Verdana',
      'Tahoma',
      'Comic Sans MS',
    ],
  },
  {
    label: 'Microsoft Office defaults',
    fonts: ['Calibri', 'Cambria', 'Times New Roman', 'Arial', 'Georgia'],
  },
  {
    label: 'Apple defaults',
    fonts: ['Helvetica'],
  },
  {
    label: 'Open-source / cross-platform',
    fonts: [
      'Liberation Serif',
      'Liberation Sans',
      'DejaVu Serif',
      'DejaVu Sans',
      'Noto Serif',
      'Noto Sans',
    ],
  },
  {
    label: 'Generic',
    fonts: ['serif', 'sans-serif', 'monospace'],
  },
];

/** Flat list of every named font we know about. Used by
 *  `sanitizeBodyFont` (via the membership check) and for any caller
 *  that just wants "is this a recognized font name?" semantics. */
const COMMON_FONTS = FONT_GROUPS.flatMap((g) => g.fonts);

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

/** Run `callback` when `el` is no longer attached to the document.
 *  Replaces `el.addEventListener('DOMNodeRemoved', ...)` — the
 *  classic mutation event Chrome flagged as deprecated. Uses a
 *  MutationObserver on the document root and disconnects after
 *  firing. Returns a manual-cancel function in case the caller
 *  wants to tear down early. */
function onDetached(el: Element, callback: () => void): () => void {
  const obs = new MutationObserver(() => {
    if (!el.isConnected) {
      callback();
      obs.disconnect();
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
  return () => obs.disconnect();
}

/** Nudge a tab into the visible band of its scrolling container.
 *  If the tab's bounding rect is fully inside the container's
 *  rect, no-op. Otherwise scroll just enough to reveal it on the
 *  nearer side. Avoids `el.scrollIntoView` because that scrolls
 *  the WHOLE page (including the editor surface behind the modal)
 *  when the container itself is fully on-screen. */
function scrollTabIntoView(tab: HTMLElement, container: HTMLElement): void {
  const tr = tab.getBoundingClientRect();
  const cr = container.getBoundingClientRect();
  if (tr.left < cr.left) {
    container.scrollBy({ left: tr.left - cr.left, behavior: 'smooth' });
  } else if (tr.right > cr.right) {
    container.scrollBy({ left: tr.right - cr.right, behavior: 'smooth' });
  }
}

/** Tab labels shown in the settings dialog, in display order. */
export const CATEGORY_TABS: { id: SettingsCategory; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'editing', label: 'Editing' },
  { id: 'shortcuts', label: 'Keyboard' },
  { id: 'comments-ai', label: 'Comments & AI' },
  { id: 'pairing', label: 'Card Sharing' },
  // Accessibility intentionally lives at the far right — its
  // override-anything panel is a "last-resort" customization
  // surface, separated from the everyday tabs.
  { id: 'accessibility', label: 'Accessibility' },
];

/** A deep-link into the settings dialog: open a tab and optionally
 *  scroll to / flash a specific setting, or a named non-setting section
 *  (e.g. "About this install") via its `data-anchor`. */
export interface SettingsTarget {
  category?: SettingsCategory;
  settingKey?: keyof Settings;
  /** `data-anchor` value of a non-setting section to scroll to + flash. */
  anchor?: string;
}

class SettingsModal {
  private overlay: HTMLDivElement;
  private dialog: HTMLDivElement;
  /** Overlay-stack token while open, so Escape only closes this modal
   *  when it's the topmost (a dialog opened from here — e.g. the AI
   *  cite-prompt editor — handles its own Escape first). */
  private overlayToken: symbol | null = null;
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
  /** ResizeObserver for the tab strip, used to show / hide the
   *  scroll-arrow buttons when the tabs overflow horizontally.
   *  Disconnected on close() and on each new render(). */
  private tabsResizeObserver: ResizeObserver | null = null;

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

    // Escape closes — but only when this is the topmost overlay, so a
    // dialog opened from within Settings closes alone on the first press.
    document.addEventListener('keydown', (e) => {
      if (
        this.overlay.style.display !== 'none' &&
        e.key === 'Escape' &&
        this.overlayToken !== null &&
        isTopOverlay(this.overlayToken)
      ) {
        this.close();
      }
    });

    document.body.appendChild(this.overlay);
  }

  open(target?: SettingsTarget): void {
    this.render();
    this.overlay.style.display = '';
    if (this.overlayToken === null) this.overlayToken = pushOverlay();
    // Subscribe so toggling any "parent" setting (AI master switch,
    // multi-doc, etc.) greys / un-greys the dependent rows live
    // without needing a re-open.
    this.settingsUnsubscribe = settings.subscribe(() => this.refreshDependents());
    this.refreshDependents();
    // Deep-link: jump to a tab and (optionally) scroll to one setting,
    // e.g. when reached from the search palette's `s` shortcuts.
    if (target?.category) this.setActiveCategory(target.category);
    if (target?.settingKey) this.revealSetting(target.settingKey);
    if (target?.anchor) this.revealAnchor(target.anchor);
  }

  /** Scroll a named non-setting section (by `data-anchor`) into view and
   *  flash it — the deep-link target for things like "About this install"
   *  that aren't editable settings rows. */
  private revealAnchor(anchor: string): void {
    const el = this.dialog.querySelector<HTMLElement>(
      `[data-anchor="${CSS.escape(anchor)}"]`,
    );
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.remove('pmd-settings-row-flash');
      void el.offsetWidth; // restart the animation if already applied
      el.classList.add('pmd-settings-row-flash');
      el.addEventListener(
        'animationend',
        () => el.classList.remove('pmd-settings-row-flash'),
        { once: true },
      );
    });
  }

  /** Scroll a specific setting row into view and flash it. Runs on the
   *  next frame so the just-activated panel has laid out. */
  private revealSetting(key: keyof Settings): void {
    const row = this.dialog.querySelector<HTMLElement>(
      `.pmd-settings-row[data-setting-key="${CSS.escape(key)}"]`,
    );
    if (!row) return;
    requestAnimationFrame(() => {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.classList.remove('pmd-settings-row-flash');
      void row.offsetWidth; // restart the animation if already applied
      row.classList.add('pmd-settings-row-flash');
      row.addEventListener(
        'animationend',
        () => row.classList.remove('pmd-settings-row-flash'),
        { once: true },
      );
    });
  }

  close(): void {
    if (this.settingsUnsubscribe) {
      this.settingsUnsubscribe();
      this.settingsUnsubscribe = null;
    }
    if (this.tabsResizeObserver) {
      this.tabsResizeObserver.disconnect();
      this.tabsResizeObserver = null;
    }
    this.overlay.style.display = 'none';
    if (this.overlayToken !== null) {
      popOverlay(this.overlayToken);
      this.overlayToken = null;
    }
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
    setIcon(closeBtn, 'close');
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', () => this.close());
    header.appendChild(closeBtn);
    this.dialog.appendChild(header);

    // Tab strip + arrow scrollers. The bar wraps the nav so the
    // arrows sit flush against the divider line (it lives on the
    // bar, not the nav). The arrows are hidden when the strip
    // fits its container and revealed via ResizeObserver when it
    // overflows; each arrow disables at the end of its scroll
    // range. No native scrollbar — overflow-x: hidden on the nav.
    const tabsBar = document.createElement('div');
    tabsBar.className = 'pmd-settings-tabs-bar';

    const scrollLeftBtn = document.createElement('button');
    scrollLeftBtn.type = 'button';
    scrollLeftBtn.className = 'pmd-settings-tabs-scroll pmd-settings-tabs-scroll-left';
    scrollLeftBtn.setAttribute('aria-label', 'Scroll settings tabs left');
    setIcon(scrollLeftBtn, 'chevron-left');
    scrollLeftBtn.hidden = true;
    tabsBar.appendChild(scrollLeftBtn);

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
    tabsBar.appendChild(tabStrip);

    const scrollRightBtn = document.createElement('button');
    scrollRightBtn.type = 'button';
    scrollRightBtn.className = 'pmd-settings-tabs-scroll pmd-settings-tabs-scroll-right';
    scrollRightBtn.setAttribute('aria-label', 'Scroll settings tabs right');
    setIcon(scrollRightBtn, 'chevron-right');
    scrollRightBtn.hidden = true;
    tabsBar.appendChild(scrollRightBtn);

    this.dialog.appendChild(tabsBar);

    const scrollTabsBy = (dir: -1 | 1): void => {
      const step = Math.max(60, tabStrip.clientWidth * 0.6);
      tabStrip.scrollBy({ left: dir * step, behavior: 'smooth' });
    };
    scrollLeftBtn.addEventListener('click', () => scrollTabsBy(-1));
    scrollRightBtn.addEventListener('click', () => scrollTabsBy(1));

    const updateArrows = (): void => {
      const overflowing = tabStrip.scrollWidth > tabStrip.clientWidth + 1;
      if (!overflowing) {
        scrollLeftBtn.hidden = true;
        scrollRightBtn.hidden = true;
        return;
      }
      scrollLeftBtn.hidden = false;
      scrollRightBtn.hidden = false;
      scrollLeftBtn.disabled = tabStrip.scrollLeft <= 0;
      scrollRightBtn.disabled =
        tabStrip.scrollLeft + tabStrip.clientWidth >= tabStrip.scrollWidth - 1;
    };
    tabStrip.addEventListener('scroll', updateArrows);
    if (this.tabsResizeObserver) this.tabsResizeObserver.disconnect();
    this.tabsResizeObserver = new ResizeObserver(updateArrows);
    this.tabsResizeObserver.observe(tabStrip);
    // Initial pass — sizes are available immediately because the
    // dialog is already in the DOM (constructor appended overlay).
    updateArrows();

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
        (m) =>
          m.category === id &&
          (!m.electronOnly || hostKind === 'electron') &&
          (!m.windowsOnly || isWindowsHost()) &&
          (!m.webOnly || hostKind === 'browser') &&
          (!m.revealWhen || !!settings.get(m.revealWhen)),
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
      // "About this install" diagnostic block at the bottom of
      // General — read-only labels users can copy-paste into bug
      // reports. Lives here rather than in SETTING_METADATA
      // because it isn't a user-editable setting. The Benchmark
      // action (run the in-app perf suite) lives here too — not its
      // own tab, just an action button alongside the diagnostics.
      if (id === 'general') {
        panel.appendChild(buildBenchmarkSection(() => this.close()));
        panel.appendChild(buildInstallInfoSection());
        panel.appendChild(this.buildSettingsBackupSection());
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
      // If the newly-active tab is clipped by the scroll viewport
      // (clicked at the edge of view, or activated programmatically
      // while not in view), nudge it into the visible band.
      const activeBtn = tabButtons[this.activeCategory];
      if (activeBtn) scrollTabIntoView(activeBtn, tabStrip);
    };
    this.setActiveCategory = (id: SettingsCategory) => {
      this.activeCategory = id;
      applyActive();
    };
    applyActive();
  }

  /** Export / Import settings — pinned at the bottom of General. */
  private buildSettingsBackupSection(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'pmd-settings-backup';

    const title = document.createElement('div');
    title.className = 'pmd-settings-row-title';
    title.textContent = 'Back up settings';
    section.appendChild(title);

    const desc = document.createElement('div');
    desc.className = 'pmd-settings-row-desc';
    desc.textContent =
      'Save all your settings — shortcuts, keyboard macros, appearance, and the rest — to a file, or import a file to replace them. Importing overwrites your current settings. Your API keys (Anthropic, Google Translate) and MyMemory email are never included.';
    section.appendChild(desc);

    const actions = document.createElement('div');
    actions.className = 'pmd-settings-backup-actions';
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'pmd-settings-backup-btn';
    exportBtn.textContent = 'Export settings…';
    exportBtn.addEventListener('click', () => void this.doExportSettings());
    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.className = 'pmd-settings-backup-btn';
    importBtn.textContent = 'Import settings…';
    importBtn.addEventListener('click', () => void this.doImportSettings());
    actions.append(exportBtn, importBtn);
    section.appendChild(actions);

    return section;
  }

  private async doExportSettings(): Promise<void> {
    const payload = JSON.stringify(
      { version: 1, settings: settings.exportObject() },
      null,
      2,
    );
    const bytes = new TextEncoder().encode(payload);
    await getHost().saveAs('cardmirror-settings.json', bytes, {
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
  }

  private async doImportSettings(): Promise<void> {
    const opened = await getHost().openFile({
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!opened) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(opened.bytes));
    } catch {
      showToast(`Couldn't read “${opened.name}” as JSON.`);
      return;
    }
    // Accept the wrapped `{ version, settings }` shape or a bare object.
    const obj =
      parsed && typeof parsed === 'object'
        ? ((parsed as { settings?: unknown }).settings ?? parsed)
        : null;
    if (!obj || typeof obj !== 'object') {
      showToast(`“${opened.name}” doesn't look like a settings export.`);
      return;
    }
    if (
      !confirm(
        'Import settings? This replaces all your current settings (your API key is kept).',
      )
    ) {
      return;
    }
    settings.replaceAll(obj);
    this.render(); // rebuild the dialog so every control reflects the import
    showToast('Settings imported.');
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
    // Tag the row so the palette's settings shortcuts can scroll to it.
    row.dataset['settingKey'] = meta.key;

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
      // Sync the checkbox visual state back to the setting on
      // every settings change — covers the case where another
      // subscriber rejects the toggle (e.g., the multi-doc
      // workspace switch shows a confirm dialog and reverts when
      // the user cancels; without this listener, the checkbox
      // visually stays flipped even though the setting reverted).
      const unsub = settings.subscribe(() => {
        const cur = !!settings.get(meta.key);
        if (checkbox.checked !== cur) checkbox.checked = cur;
      });
      onDetached(checkbox, () => unsub());
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
    } else if (meta.kind === 'uiFont') {
      row.appendChild(text);
      row.appendChild(buildUiFontEditor());
      return row;
    } else if (meta.kind === 'lineHeights') {
      row.appendChild(text);
      row.appendChild(buildLineHeightsEditor());
      return row;
    } else if (meta.kind === 'paragraphSpacing') {
      row.appendChild(text);
      row.appendChild(buildParagraphSpacingEditor());
      return row;
    } else if (meta.kind === 'formattingPanelMode') {
      label.appendChild(buildFormattingPanelModeEditor());
    } else if (meta.kind === 'ribbonTooltipMode') {
      label.appendChild(buildRibbonTooltipModeEditor());
    } else if (meta.kind === 'multiDocLayoutMode') {
      row.appendChild(text);
      row.appendChild(buildMultiDocLayoutModeEditor());
      return row;
    } else if (meta.kind === 'mobileLayout') {
      row.appendChild(text);
      row.appendChild(buildMobileLayoutEditor());
      return row;
    } else if (meta.kind === 'cardCutterEmphasisStyle') {
      row.appendChild(text);
      row.appendChild(
        buildCardCutterRadio('cardCutterEmphasisStyle', [
          ['voice', 'Voice — emphasis inside the spoken read'],
          ['independent', 'Independent — emphasis marks power phrases'],
          ['minimal', 'Minimal — sparse emphasis'],
        ]),
      );
      return row;
    } else if (meta.kind === 'cardCutterAcronymSplitting') {
      row.appendChild(text);
      row.appendChild(
        buildCardCutterRadio('cardCutterAcronymSplitting', [
          ['off', 'Off (recommended)'],
          ['conservative', 'Conservative — established acronyms only'],
          ['aggressive', 'Aggressive'],
        ]),
      );
      return row;
    } else if (meta.kind === 'cardCutterClarifyingQuestions') {
      row.appendChild(text);
      row.appendChild(
        buildCardCutterRadio('cardCutterClarifyingQuestions', [
          ['when-ambiguous', "When ambiguous — the model's discretion"],
          ['always', 'Always ask'],
          ['never', 'Never ask'],
        ]),
      );
      return row;
    } else if (meta.kind === 'cardCutterDisable') {
      row.appendChild(text);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pmd-settings-btn';
      btn.textContent = 'Disable card cutter';
      btn.addEventListener('click', () => settings.set('cardCutterEnabled', false));
      row.appendChild(btn);
      return row;
    } else if (meta.kind === 'number') {
      row.appendChild(text);
      row.appendChild(buildNumberEditor(meta.key as keyof Settings));
      return row;
    } else if (meta.kind === 'voiceInputDevice') {
      row.appendChild(text);
      row.appendChild(buildVoiceInputDeviceEditor());
      return row;
    } else if (meta.kind === 'voiceDashStyle') {
      row.appendChild(text);
      row.appendChild(buildVoiceDashStyleEditor());
      return row;
    } else if (meta.kind === 'voiceDictationModel') {
      row.appendChild(text);
      row.appendChild(buildVoiceDictationModelEditor());
      return row;
    } else if (meta.kind === 'speechDocFormat') {
      row.appendChild(text);
      row.appendChild(buildSpeechDocFormatEditor());
      return row;
    } else if (meta.kind === 'saveFormat') {
      row.appendChild(text);
      row.appendChild(buildSaveFormatEditor());
      return row;
    } else if (meta.kind === 'translationConfig') {
      row.appendChild(text);
      row.appendChild(buildTranslationEditor());
      return row;
    } else if (meta.kind === 'sendDocDestination') {
      row.appendChild(text);
      row.appendChild(buildSendDocDestinationEditor());
      return row;
    } else if (meta.kind === 'findCategoryOrder') {
      row.appendChild(text);
      row.appendChild(buildFindCategoryOrderEditor());
      return row;
    } else if (meta.kind === 'color') {
      row.appendChild(text);
      row.appendChild(buildColorEditor(meta.key as keyof typeof SETTINGS_DEFAULTS));
      return row;
    } else if (meta.kind === 'colorSlots') {
      row.appendChild(text);
      row.appendChild(buildColorSlotsEditor(meta.key as keyof Settings));
      return row;
    } else if (meta.kind === 'theme') {
      row.appendChild(text);
      row.appendChild(buildThemeEditor());
      return row;
    } else if (meta.kind === 'iconSet') {
      row.appendChild(text);
      row.appendChild(buildIconSetEditor());
      return row;
    } else if (meta.kind === 'reduceMotion') {
      row.appendChild(text);
      row.appendChild(buildReduceMotionEditor());
      return row;
    } else if (meta.kind === 'timerProfile') {
      row.appendChild(text);
      row.appendChild(buildTimerProfileEditor());
      return row;
    } else if (meta.kind === 'timerProfileDurations') {
      row.appendChild(text);
      row.appendChild(buildTimerProfileDurationsEditor());
      return row;
    } else if (meta.kind === 'timerPrepLabel') {
      row.appendChild(text);
      row.appendChild(buildTimerPrepLabelEditor());
      return row;
    } else if (meta.kind === 'colorOverrides') {
      row.appendChild(text);
      row.appendChild(buildColorOverridesEditor());
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
    } else if (meta.kind === 'fileSearchFormats') {
      row.appendChild(text);
      row.appendChild(buildFileSearchFormatsEditor());
      return row;
    } else if (meta.kind === 'fileSearchObjectTypes') {
      row.appendChild(text);
      row.appendChild(buildFileObjectTypesEditor());
      return row;
    } else if (meta.kind === 'fileSearchOutlineDepth') {
      row.appendChild(text);
      row.appendChild(buildFileSearchOutlineDepthEditor());
      return row;
    } else if (meta.kind === 'keybindings') {
      row.appendChild(text);
      // The per-command keybindings list (~150 rows) is the single
      // heaviest part of opening Settings, and it lives under the
      // Keyboard tab — which isn't the default. Build it on the next
      // frame instead of blocking the open: the dialog appears instantly
      // and the list fills in invisibly (its panel starts hidden).
      const slot = document.createElement('div');
      row.appendChild(slot);
      requestAnimationFrame(() => slot.appendChild(buildKeybindingsEditor()));
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
    } else if (meta.kind === 'folderList') {
      // A list of folders, each removable, plus "+ Add folder". Used for the
      // multi-folder file search. electronOnly, so the picker host is present.
      const wrap = document.createElement('div');
      wrap.className = 'pmd-settings-folderlist';
      const getRoots = (): string[] => (settings.get(meta.key) as string[]) ?? [];
      const render = (): void => {
        wrap.innerHTML = '';
        const roots = getRoots();
        if (roots.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'pmd-settings-folderlist-empty';
          empty.textContent = '(none — file search is off)';
          wrap.appendChild(empty);
        } else {
          roots.forEach((rootPath, i) => {
            const rowEl = document.createElement('div');
            rowEl.className = 'pmd-settings-folder';
            const pathEl = document.createElement('span');
            pathEl.className = 'pmd-settings-folder-path';
            pathEl.textContent = rootPath;
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'pmd-pairing-delete';
            remove.title = 'Remove folder';
            setIcon(remove, 'close');
            remove.addEventListener('click', () => {
              settings.set(meta.key, getRoots().filter((_, j) => j !== i) as never);
              render();
            });
            rowEl.append(pathEl, remove);
            wrap.appendChild(rowEl);
          });
        }
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'pmd-readers-add';
        addBtn.textContent = '+ Add folder';
        addBtn.addEventListener('click', () => {
          void (async (): Promise<void> => {
            const electron = getElectronHost();
            if (!electron) return;
            const picked = await electron.pickDirectory({ title: meta.label });
            if (picked == null) return;
            const roots = getRoots();
            if (!roots.includes(picked)) {
              settings.set(meta.key, [...roots, picked] as never);
              render();
            }
          })();
        });
        wrap.appendChild(addBtn);
      };
      render();
      row.appendChild(text);
      row.appendChild(wrap);
      return row;
    } else if (meta.kind === 'cardCutterEnginePath') {
      // Like `folder`, but picks a FILE (the engine bundle) via the
      // native file dialog. electronOnly, so the host is always present.
      const wrap = document.createElement('div');
      wrap.className = 'pmd-settings-folder';
      const pathEl = document.createElement('span');
      pathEl.className = 'pmd-settings-folder-path';
      const refreshPath = (): void => {
        const value = settings.get(meta.key) as string;
        pathEl.textContent = value || '(default location)';
        pathEl.classList.toggle('pmd-settings-folder-empty', !value);
      };
      refreshPath();
      const browseBtn = document.createElement('button');
      browseBtn.type = 'button';
      browseBtn.className = 'pmd-settings-btn';
      browseBtn.textContent = 'Browse…';
      browseBtn.addEventListener('click', () => {
        void (async (): Promise<void> => {
          const electron = getElectronHost();
          if (!electron?.cardCutterPickFile) return;
          const picked = await electron.cardCutterPickFile();
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
    } else if (meta.kind === 'pairingOwnCode') {
      row.appendChild(text);
      row.appendChild(buildPairingOwnCodeEditor());
      return row;
    } else if (meta.kind === 'pairingPartners') {
      row.appendChild(text);
      row.appendChild(buildPairingPartnersEditor());
      return row;
    } else if (meta.kind === 'pairingGroups') {
      row.appendChild(text);
      row.appendChild(buildPairingGroupsEditor());
      return row;
    } else if (meta.kind === 'pairingReceiveFlash') {
      row.appendChild(text);
      row.appendChild(buildPairingReceiveFlashEditor());
      return row;
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
  onDetached(wrap, () => unsubscribe());

  return wrap;
}

function buildColorsEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-colors-editor';

  const inputs: Partial<Record<keyof DisplayColors, HTMLInputElement>> = {};
  const resets: Partial<Record<keyof DisplayColors, HTMLButtonElement>> = {};

  const LABELS: Record<keyof DisplayColors, string> = {
    analytic: 'Analytic',
    undertag: 'Undertag',
  };

  function setColor(key: keyof DisplayColors, value: string): void {
    settings.set('displayColors', { ...settings.get('displayColors'), [key]: value });
  }

  for (const key of DISPLAY_COLOR_KEYS) {
    // A plain <div> wrapper, not <label> — a <label> would forward
    // clicks on the reset button to the color input and pop the picker.
    const row = document.createElement('div');
    row.className = 'pmd-colors-row';

    const lbl = document.createElement('span');
    lbl.className = 'pmd-colors-label';
    lbl.textContent = LABELS[key];
    row.appendChild(lbl);

    const picker = document.createElement('input');
    picker.type = 'color';
    picker.className = 'pmd-colors-input';
    picker.value = settings.get('displayColors')[key];
    picker.addEventListener('input', () => setColor(key, picker.value));
    row.appendChild(picker);

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'pmd-colors-reset';
    setIcon(reset, 'reset');
    reset.title = 'Reset to default';
    reset.setAttribute('aria-label', `Reset ${LABELS[key]} color to default`);
    reset.addEventListener('click', () => setColor(key, DEFAULT_DISPLAY_COLORS[key]));
    row.appendChild(reset);

    inputs[key] = picker;
    resets[key] = reset;
    wrap.appendChild(row);
  }

  // Keep pickers + reset-enabled state in sync with the store (covers
  // edits from the linked Accessibility panel, another tab, or reset).
  function refresh(): void {
    const c = settings.get('displayColors');
    for (const key of DISPLAY_COLOR_KEYS) {
      const inp = inputs[key];
      if (inp && inp.value !== c[key]) inp.value = c[key];
      const rst = resets[key];
      if (rst) rst.disabled = c[key].toLowerCase() === DEFAULT_DISPLAY_COLORS[key].toLowerCase();
    }
  }
  refresh();
  const unsubscribe = settings.subscribe(refresh);
  onDetached(wrap, () => unsubscribe());

  return wrap;
}

/** Read-only "About this install" diagnostic block. Lives at the
 *  bottom of Settings → General so a user filing a bug report can
 *  grab their version + platform + UA in one place. The actions
 *  (Check for Updates, Open Crash Dumps Folder) are Electron-only;
 *  they're omitted on the web edition. */
function buildInstallInfoSection(): HTMLElement {
  const wrap = document.createElement('section');
  wrap.className = 'pmd-install-info-section';
  // Deep-link target: the command palette's "version / about this install"
  // result scrolls here (SettingsTarget.anchor).
  wrap.dataset['anchor'] = 'about-this-install';

  const hr = document.createElement('hr');
  hr.className = 'pmd-install-info-divider';
  wrap.appendChild(hr);

  const heading = document.createElement('div');
  heading.className = 'pmd-install-info-heading';
  heading.textContent = 'About this install';
  wrap.appendChild(heading);

  const list = document.createElement('dl');
  list.className = 'pmd-install-info-list';
  for (const entry of getInstallInfo()) {
    const dt = document.createElement('dt');
    dt.textContent = entry.label;
    list.appendChild(dt);
    const dd = document.createElement('dd');
    dd.textContent = entry.value;
    if (entry.mono) dd.classList.add('pmd-install-info-mono');
    list.appendChild(dd);
  }
  wrap.appendChild(list);

  // Action buttons — Electron-only because they shell out to the
  // OS (update check via electron-updater, crash-dumps folder via
  // shell.openPath). The web edition has neither capability.
  const electronHost = getElectronHost();
  if (electronHost) {
    // "Check for updates on launch" toggle. Lives in this section
    // alongside the manual Check-for-updates button because it's
    // the same conceptual surface — "how the app handles
    // updates." Off by default in alpha.3; users opt in if they
    // want at-launch checking. When enabled, only the first
    // window of an app session triggers the check; subsequent
    // spawned windows skip it. The actual at-launch trigger
    // lives in `index.ts`'s boot path.
    const launchRow = document.createElement('label');
    launchRow.className = 'pmd-install-info-launch-toggle';
    const launchInput = document.createElement('input');
    launchInput.type = 'checkbox';
    launchInput.checked = settings.get('checkForUpdatesOnLaunch');
    launchInput.addEventListener('change', () => {
      settings.set('checkForUpdatesOnLaunch', launchInput.checked);
    });
    const launchText = document.createElement('span');
    launchText.textContent = 'Check for updates on launch';
    launchRow.appendChild(launchInput);
    launchRow.appendChild(launchText);
    wrap.appendChild(launchRow);

    const actions = document.createElement('div');
    actions.className = 'pmd-install-info-actions';

    const updatesBtn = document.createElement('button');
    updatesBtn.type = 'button';
    updatesBtn.className = 'pmd-install-info-btn';
    updatesBtn.textContent = 'Check for updates';
    updatesBtn.addEventListener('click', () => {
      updatesBtn.disabled = true;
      updatesBtn.textContent = 'Checking…';
      const restore = (): void => {
        updatesBtn.disabled = false;
        updatesBtn.textContent = 'Check for updates';
      };
      // .catch handles the case where the main process is older
      // than the renderer (dev hot-reload of the renderer without
      // restarting Electron leaves no IPC handler registered, so
      // `invoke` rejects). Without it the button would stay in
      // the disabled "Checking…" state forever.
      electronHost.checkForUpdates().then((result) => {
        restore();
        if (result.status === 'latest') {
          showToast("You're on the latest version.");
        } else if (result.status === 'updating') {
          // macOS can detect but not self-install updates, so don't
          // claim a background download there — send users to the .dmg.
          const isMac = /Mac/i.test(navigator.userAgent);
          showToast(
            isMac
              ? 'Update available — download the new version from the releases page.'
              : 'Update available — downloading in the background.',
          );
        } else if (result.status === 'dev') {
          showToast('Update checks are only active in packaged builds.');
        } else {
          showToast(`Update check failed: ${result.message ?? 'unknown error'}`);
        }
      }).catch((err: unknown) => {
        restore();
        showToast(`Update check failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
    actions.appendChild(updatesBtn);

    const crashBtn = document.createElement('button');
    crashBtn.type = 'button';
    crashBtn.className = 'pmd-install-info-btn';
    crashBtn.textContent = 'Open crash dumps folder';
    crashBtn.addEventListener('click', () => {
      electronHost.openCrashDumpsFolder().catch((err: unknown) => {
        showToast(
          `Open crash dumps folder failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
    actions.appendChild(crashBtn);

    wrap.appendChild(actions);
  }

  return wrap;
}

/** Settings → Benchmark: a game-style in-app perf suite. The button closes the
 *  dialog first (the editor must be visible — occluded content gets its paints
 *  culled, which would falsify the frame times) and launches the overlay. */
function buildBenchmarkSection(closeDialog: () => void): HTMLElement {
  const section = document.createElement('section');
  section.className = 'pmd-settings-benchmark';

  const title = document.createElement('div');
  title.className = 'pmd-settings-row-title';
  title.textContent = 'Performance benchmark';
  section.appendChild(title);

  const desc = document.createElement('div');
  desc.className = 'pmd-settings-row-desc';
  desc.textContent =
    'Runs a battery of real in-editor operations on the currently open document — ' +
    'scrolling, jumping between headings, a drag-move, and a short editing sequence ' +
    '— and reports frame rate, frame-time percentiles, and latencies. Open your ' +
    'test document first (a large one tells the most); it is driven on screen while ' +
    'it runs and restored exactly afterward.';
  section.appendChild(desc);

  const actions = document.createElement('div');
  actions.className = 'pmd-settings-backup-actions';
  const run = document.createElement('button');
  run.type = 'button';
  run.className = 'pmd-settings-backup-btn';
  run.textContent = 'Run benchmark';
  run.addEventListener('click', () => {
    closeDialog();
    void launchBenchmarkOverlay();
  });
  actions.appendChild(run);
  section.appendChild(actions);

  return section;
}

function buildBodyFontEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-body-font-editor';

  const select = document.createElement('select');
  select.className = 'pmd-body-font-select';

  function populate(): void {
    select.innerHTML = '';
    const current = settings.get('bodyFont');
    const GENERICS = new Set([
      'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
    ]);
    function buildOption(font: string): HTMLOptionElement {
      const opt = document.createElement('option');
      opt.value = font;
      opt.textContent = font;
      // Render each option in the font itself so the user can preview
      // before committing. Generic CSS keywords (serif, sans-serif,
      // monospace) must NOT be quoted; named fonts must be.
      opt.style.fontFamily = GENERICS.has(font) ? font : `"${font}", sans-serif`;
      if (font === current) opt.selected = true;
      return opt;
    }
    // If the user's current selection isn't in any group (e.g., a
    // saved-but-unavailable bundled font, or a name the user typed
    // by hand), show it as a stand-alone option above the groups so
    // it's still visible and re-selectable.
    const currentInGroups = FONT_GROUPS.some((g) => g.fonts.includes(current));
    if (!currentInGroups) {
      select.appendChild(buildOption(current));
    }
    for (const group of FONT_GROUPS) {
      const available = group.fonts.filter(isFontAvailable);
      if (available.length === 0) continue;
      const og = document.createElement('optgroup');
      og.label = group.label;
      for (const font of available) og.appendChild(buildOption(font));
      select.appendChild(og);
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
  onDetached(wrap, () => unsubscribe());

  return wrap;
}

/** UI-font picker. Same shape as the body-font picker, but the
 *  default value is an empty string (= use the stylesheet's
 *  system-UI default) and the first option is an explicit "System
 *  default" entry that resolves to that empty string. */
function buildUiFontEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-body-font-editor';

  const select = document.createElement('select');
  select.className = 'pmd-body-font-select';

  function populate(): void {
    select.innerHTML = '';
    const current = settings.get('uiFont');
    const GENERICS = new Set([
      'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
    ]);

    // "System default" sentinel — value '' means "no override, use
    // the stylesheet's `--pmd-ui-font` default (the platform UI
    // stack)."
    const systemOpt = document.createElement('option');
    systemOpt.value = '';
    systemOpt.textContent = 'System default';
    if (current === '') systemOpt.selected = true;
    select.appendChild(systemOpt);

    function buildOption(font: string): HTMLOptionElement {
      const opt = document.createElement('option');
      opt.value = font;
      opt.textContent = font;
      opt.style.fontFamily = GENERICS.has(font) ? font : `"${font}", sans-serif`;
      if (font === current) opt.selected = true;
      return opt;
    }
    const currentInGroups = FONT_GROUPS.some((g) => g.fonts.includes(current));
    if (current !== '' && !currentInGroups) {
      select.appendChild(buildOption(current));
    }
    for (const group of FONT_GROUPS) {
      const available = group.fonts.filter(isFontAvailable);
      if (available.length === 0) continue;
      const og = document.createElement('optgroup');
      og.label = group.label;
      for (const font of available) og.appendChild(buildOption(font));
      select.appendChild(og);
    }
  }

  populate();

  select.addEventListener('change', () => {
    settings.set('uiFont', select.value);
  });

  wrap.appendChild(select);

  const unsubscribe = settings.subscribe(() => {
    if (select.value !== settings.get('uiFont')) populate();
  });
  onDetached(wrap, () => unsubscribe());

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

const PARAGRAPH_SPACING_ROWS: { label: string; before: ParagraphSpacingKey; after: ParagraphSpacingKey }[] = [
  { label: 'Body', before: 'bodyBefore', after: 'bodyAfter' },
  { label: 'Cite paragraphs', before: 'citeBefore', after: 'citeAfter' },
  { label: 'Tags', before: 'tagBefore', after: 'tagAfter' },
  { label: 'Analytics', before: 'analyticBefore', after: 'analyticAfter' },
  { label: 'Pockets', before: 'pocketBefore', after: 'pocketAfter' },
  { label: 'Hats', before: 'hatBefore', after: 'hatAfter' },
  { label: 'Blocks', before: 'blockBefore', after: 'blockAfter' },
  { label: 'Undertags', before: 'undertagBefore', after: 'undertagAfter' },
];

function buildParagraphSpacingEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-para-spacing-editor';

  const rowsContainer = document.createElement('div');
  rowsContainer.className = 'pmd-para-spacing-rows';
  wrap.appendChild(rowsContainer);

  function cell(key: ParagraphSpacingKey, value: number): HTMLElement {
    const c = document.createElement('span');
    c.className = 'pmd-para-spacing-cell';
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'pmd-para-spacing-input';
    input.min = '0';
    input.max = '96';
    input.step = '0.5';
    input.value = String(value);
    input.addEventListener('change', () => {
      const cur = settings.get('displayParagraphSpacing');
      const v = parseFloat(input.value);
      if (!Number.isFinite(v) || v < 0) {
        input.value = String(cur[key]);
        return;
      }
      settings.set('displayParagraphSpacing', { ...cur, [key]: v });
    });
    c.appendChild(input);
    const unit = document.createElement('span');
    unit.className = 'pmd-para-spacing-unit';
    unit.textContent = 'pt';
    c.appendChild(unit);
    return c;
  }

  function render(): void {
    rowsContainer.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'pmd-para-spacing-row pmd-para-spacing-head';
    head.appendChild(document.createElement('span')); // label column spacer
    for (const t of ['Before', 'After']) {
      const h = document.createElement('span');
      h.className = 'pmd-para-spacing-colhead';
      h.textContent = t;
      head.appendChild(h);
    }
    rowsContainer.appendChild(head);

    const spacing = settings.get('displayParagraphSpacing');
    for (const { label, before, after } of PARAGRAPH_SPACING_ROWS) {
      const row = document.createElement('div');
      row.className = 'pmd-para-spacing-row';
      const lbl = document.createElement('span');
      lbl.className = 'pmd-para-spacing-row-label';
      lbl.textContent = label;
      row.appendChild(lbl);
      row.appendChild(cell(before, spacing[before]));
      row.appendChild(cell(after, spacing[after]));
      rowsContainer.appendChild(row);
    }
  }

  const footer = document.createElement('div');
  footer.className = 'pmd-line-heights-footer';
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'pmd-line-heights-reset-btn';
  setIcon(resetBtn, 'reset');
  resetBtn.title = 'Restore defaults';
  resetBtn.setAttribute('aria-label', 'Restore paragraph spacing defaults');
  resetBtn.addEventListener('click', () => {
    settings.set('displayParagraphSpacing', { ...DEFAULT_PARAGRAPH_SPACING });
    // Re-sync the inputs (the subscriber skips re-render while focus is in
    // this editor, and the reset button holds focus).
    render();
  });
  footer.appendChild(resetBtn);
  wrap.appendChild(footer);

  const unsubscribe = settings.subscribe(() => {
    if (!(document.activeElement && wrap.contains(document.activeElement))) {
      render();
    }
  });
  render();
  onDetached(wrap, () => unsubscribe());

  return wrap;
}

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
  setIcon(resetBtn, 'reset');
  resetBtn.title = 'Restore defaults';
  resetBtn.setAttribute('aria-label', 'Restore line spacing defaults');
  resetBtn.addEventListener('click', () => {
    for (const { key } of LINE_HEIGHT_ROWS) {
      settings.set(key, SETTINGS_DEFAULTS[key]);
    }
    // Re-sync the inputs to the defaults. The settings subscriber skips
    // re-rendering while focus is inside this editor (so it can't clobber
    // a value you're typing) — and the reset button itself holds focus —
    // so the reset must redraw explicitly.
    render();
  });
  footer.appendChild(resetBtn);
  wrap.appendChild(footer);

  const unsubscribe = settings.subscribe(() => {
    if (!(document.activeElement && wrap.contains(document.activeElement))) {
      render();
    }
  });
  render();
  onDetached(wrap, () => unsubscribe());

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

  onDetached(wrap, () => unsubscribe());

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
      setIcon(upBtn, 'arrow-up');
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
      setIcon(downBtn, 'arrow-down');
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
      setIcon(delBtn, 'close');
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
  onDetached(wrap, () => unsubscribe());

  return wrap;
}

/** Your own pairing code: shown read-only with Copy + Regenerate. Empty
 *  until card sharing is enabled (the wiring layer mints it on enable). */
function buildPairingOwnCodeEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-pairing-owncode';

  const codeEl = document.createElement('code');
  codeEl.className = 'pmd-pairing-owncode-value';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'pmd-settings-btn';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', () => {
    const code = settings.get('pairingOwnCode');
    if (!code) return;
    void navigator.clipboard?.writeText(code).then(
      () => showToast('Pairing code copied'),
      () => showToast('Could not copy code'),
    );
  });

  const regenBtn = document.createElement('button');
  regenBtn.type = 'button';
  regenBtn.className = 'pmd-settings-btn';
  regenBtn.title =
    'Make a new code. Anyone using your old code can no longer reach you until you re-share.';
  regenBtn.addEventListener('click', () => {
    const had = !!settings.get('pairingOwnCode');
    if (
      had &&
      !window.confirm(
        'Regenerate your pairing code? Anyone you already shared the old code with will need the new one.',
      )
    ) {
      return;
    }
    // The keypair lives in the main process; ask it to mint a fresh one.
    void regenerateOwnCode().then(() => showToast('New pairing code generated'));
  });

  wrap.append(codeEl, copyBtn, regenBtn);

  function refresh(): void {
    const code = settings.get('pairingOwnCode');
    if (code) {
      codeEl.textContent = code;
      codeEl.classList.remove('pmd-pairing-owncode-empty');
      copyBtn.disabled = false;
      regenBtn.textContent = 'Regenerate';
    } else {
      codeEl.textContent = '(created when you enable card sharing)';
      codeEl.classList.add('pmd-pairing-owncode-empty');
      copyBtn.disabled = true;
      regenBtn.textContent = 'Generate now';
    }
  }
  refresh();
  const unsub = settings.subscribe(refresh);
  onDetached(wrap, () => unsub());
  return wrap;
}

/** Paired machines: nickname + code rows, modeled on the readers editor.
 *  A new partner starts with a placeholder name so it survives the
 *  set→sanitize round-trip while you paste its code. */
function buildPairingPartnersEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-pairing-editor';

  const list = document.createElement('div');
  list.className = 'pmd-pairing-list';
  wrap.appendChild(list);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'pmd-readers-add';
  addBtn.textContent = '+ Add recipient';
  wrap.appendChild(addBtn);

  const commit = (partners: PairingPartner[]): void => {
    settings.set('pairingPartners', partners);
  };

  function render(): void {
    list.innerHTML = '';
    const partners = settings.get('pairingPartners');
    if (partners.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pmd-pairing-empty';
      empty.textContent = 'No recipients yet. Add one with the code it shared with you.';
      list.appendChild(empty);
    }
    partners.forEach((partner, idx) => {
      const row = document.createElement('div');
      row.className = 'pmd-pairing-row';

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'pmd-pairing-name';
      nameInput.value = partner.name;
      nameInput.placeholder = 'Name';
      nameInput.addEventListener('change', () => {
        commit(
          settings
            .get('pairingPartners')
            .map((p, i) => (i === idx ? { ...p, name: nameInput.value.trim() } : p)),
        );
      });
      row.appendChild(nameInput);

      const codeInput = document.createElement('input');
      codeInput.type = 'text';
      codeInput.className = 'pmd-pairing-code';
      codeInput.value = partner.code;
      codeInput.placeholder = 'paste their code (cmk1.…)';
      codeInput.spellcheck = false;
      codeInput.autocomplete = 'off';
      codeInput.addEventListener('change', () => {
        const code = normalizePairingCode(codeInput.value);
        codeInput.value = code;
        commit(
          settings.get('pairingPartners').map((p, i) => (i === idx ? { ...p, code } : p)),
        );
      });
      row.appendChild(codeInput);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'pmd-pairing-delete';
      setIcon(delBtn, 'close');
      delBtn.title = 'Remove recipient';
      delBtn.addEventListener('click', () => {
        commit(settings.get('pairingPartners').filter((_, i) => i !== idx));
      });
      row.appendChild(delBtn);

      list.appendChild(row);
    });
  }

  addBtn.addEventListener('click', () => {
    const cur = settings.get('pairingPartners');
    commit([...cur, { code: '', name: `Recipient ${cur.length + 1}` }]);
  });

  render();
  const unsub = settings.subscribe(() => render());
  onDetached(wrap, () => unsub());
  return wrap;
}

/** Groups: a label + a checkbox per partner. Sending to a group fans
 *  the card out to every checked member. */
function buildPairingGroupsEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-pairing-editor';

  const list = document.createElement('div');
  list.className = 'pmd-pairing-group-list';
  wrap.appendChild(list);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'pmd-readers-add';
  addBtn.textContent = '+ Add group';
  wrap.appendChild(addBtn);

  const commit = (groups: PairingGroup[]): void => {
    settings.set('pairingGroups', groups);
  };

  function render(): void {
    list.innerHTML = '';
    const groups = settings.get('pairingGroups');
    const partners = settings.get('pairingPartners').filter((p) => p.code);
    if (groups.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pmd-pairing-empty';
      empty.textContent = 'No groups yet. A group sends one card to several recipients at once.';
      list.appendChild(empty);
    }
    groups.forEach((group, idx) => {
      const card = document.createElement('div');
      card.className = 'pmd-pairing-group';

      const header = document.createElement('div');
      header.className = 'pmd-pairing-group-header';

      const labelInput = document.createElement('input');
      labelInput.type = 'text';
      labelInput.className = 'pmd-pairing-name';
      labelInput.value = group.label;
      labelInput.placeholder = 'Group name';
      labelInput.addEventListener('change', () => {
        commit(
          settings
            .get('pairingGroups')
            .map((g, i) => (i === idx ? { ...g, label: labelInput.value.trim() } : g)),
        );
      });
      header.appendChild(labelInput);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'pmd-pairing-delete';
      setIcon(delBtn, 'close');
      delBtn.title = 'Remove group';
      delBtn.addEventListener('click', () => {
        commit(settings.get('pairingGroups').filter((_, i) => i !== idx));
      });
      header.appendChild(delBtn);
      card.appendChild(header);

      const members = document.createElement('div');
      members.className = 'pmd-pairing-group-members';
      if (partners.length === 0) {
        const hint = document.createElement('span');
        hint.className = 'pmd-pairing-empty';
        hint.textContent = 'Add recipients first, then check who belongs to this group.';
        members.appendChild(hint);
      } else {
        partners.forEach((p) => {
          const memberLabel = document.createElement('label');
          memberLabel.className = 'pmd-pairing-member';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = group.memberCodes.includes(p.code);
          cb.addEventListener('change', () => {
            commit(
              settings.get('pairingGroups').map((g, i) => {
                if (i !== idx) return g;
                const set = new Set(g.memberCodes);
                if (cb.checked) set.add(p.code);
                else set.delete(p.code);
                return { ...g, memberCodes: [...set] };
              }),
            );
          });
          const nameSpan = document.createElement('span');
          nameSpan.textContent = p.name || p.code;
          memberLabel.append(cb, nameSpan);
          members.appendChild(memberLabel);
        });
      }
      card.appendChild(members);
      list.appendChild(card);
    });
  }

  addBtn.addEventListener('click', () => {
    const cur = settings.get('pairingGroups');
    commit([...cur, { id: generateGroupId(), label: `Group ${cur.length + 1}`, memberCodes: [] }]);
  });

  render();
  const unsub = settings.subscribe(() => render());
  onDetached(wrap, () => unsub());
  return wrap;
}

/** Three-button segmented control for the receive-pill flash behavior,
 *  visually parallel to the reduce-motion / theme editors. */
function buildPairingReceiveFlashEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-theme-editor';
  const options: { value: Settings['pairingReceiveFlash']; label: string }[] = [
    { value: 'once', label: 'Flash once' },
    { value: 'repeat', label: 'Keep flashing' },
    { value: 'off', label: 'Off' },
  ];
  for (const o of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-theme-editor-btn';
    btn.textContent = o.label;
    btn.dataset['value'] = o.value;
    btn.addEventListener('click', () => settings.set('pairingReceiveFlash', o.value));
    wrap.appendChild(btn);
  }
  function refresh(): void {
    const cur = settings.get('pairingReceiveFlash');
    for (const btn of wrap.querySelectorAll<HTMLButtonElement>('.pmd-theme-editor-btn')) {
      btn.setAttribute('aria-pressed', btn.dataset['value'] === cur ? 'true' : 'false');
    }
  }
  refresh();
  const unsub = settings.subscribe(refresh);
  onDetached(wrap, () => unsub());
  return wrap;
}

function buildRibbonTooltipModeEditor(): HTMLElement {
  const select = document.createElement('select');
  select.className = 'pmd-formatting-panel-mode-select';
  const options: { value: 'none' | 'tooltip' | 'shortcut' | 'both'; label: string }[] = [
    { value: 'both', label: 'Label and shortcut' },
    { value: 'tooltip', label: 'Label only' },
    { value: 'shortcut', label: 'Shortcut only' },
    { value: 'none', label: 'No tooltips' },
  ];
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.value === settings.get('ribbonTooltipMode')) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    settings.set('ribbonTooltipMode', select.value as 'none' | 'tooltip' | 'shortcut' | 'both');
  });
  return select;
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

/** Microphone picker for voice control. Options populate async from
 *  enumerateDevices(); labels are blank until some getUserMedia call
 *  has been granted (the first voice session does this), so a generic
 *  "Microphone N" fallback keeps the list usable. */
function buildVoiceInputDeviceEditor(): HTMLElement {
  const select = document.createElement('select');
  select.className = 'pmd-body-font-select'; // shared themed-select style
  const current = settings.get('voiceInputDeviceId');

  const addOption = (value: string, label: string): void => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    opt.selected = value === current;
    select.appendChild(opt);
  };
  addOption('', 'System default');

  if (navigator.mediaDevices?.enumerateDevices) {
    void navigator.mediaDevices.enumerateDevices().then((devices) => {
      let n = 0;
      let sawCurrent = current === '';
      for (const d of devices) {
        if (d.kind !== 'audioinput' || d.deviceId === 'default') continue;
        n += 1;
        addOption(d.deviceId, d.label || `Microphone ${n}`);
        if (d.deviceId === current) sawCurrent = true;
      }
      // A previously-chosen device that's now unplugged still shows,
      // so the user can see (and clear) a stale selection.
      if (!sawCurrent) addOption(current, 'Saved device (not connected)');
    });
  }

  select.addEventListener('change', () => {
    settings.set('voiceInputDeviceId', select.value);
  });
  return select;
}

/** Generic editor for plain numeric settings (kind: 'number'). */
function buildNumberEditor(key: keyof Settings): HTMLElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'pmd-line-height-input';
  input.min = '0';
  input.step = '1';
  input.value = String(settings.get(key));
  input.addEventListener('change', () => {
    const v = Math.max(0, Math.round(parseFloat(input.value)));
    if (!Number.isFinite(v)) {
      input.value = String(settings.get(key));
      return;
    }
    settings.set(key, v as never);
    input.value = String(settings.get(key));
  });
  return input;
}

function buildVoiceDashStyleEditor(): HTMLElement {
  const select = document.createElement('select');
  select.className = 'pmd-body-font-select';
  const current = settings.get('voiceDashStyle');
  const options: Array<{ value: typeof current; label: string }> = [
    { value: 'em', label: '— em dash (default)' },
    { value: 'em-spaced', label: ' — em dash, spaced' },
    { value: 'en', label: '– en dash' },
    { value: 'en-spaced', label: ' – en dash, spaced' },
    { value: 'hyphen', label: '- hyphen' },
    { value: 'hyphen-spaced', label: ' - hyphen, spaced' },
    { value: 'double', label: '-- double dash' },
    { value: 'double-spaced', label: ' -- double dash, spaced' },
    { value: 'triple', label: '--- triple dash' },
    { value: 'triple-spaced', label: ' --- triple dash, spaced' },
  ];
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    opt.selected = o.value === current;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    settings.set('voiceDashStyle', select.value as typeof current);
  });
  return select;
}

function buildVoiceDictationModelEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-multi-doc-layout-mode-editor';
  const api = (window as unknown as {
    electronAPI?: {
      voiceDictationModelInfo(): Promise<{ present: boolean; downloading: boolean }>;
      voiceDownloadDictationModel(): Promise<{ ok: boolean; error?: string }>;
      onVoiceDownloadProgress(h: (p: { pct: number; extracting?: boolean }) => void): () => void;
    };
  }).electronAPI;

  const groupName = `pmd-voice-dict-model-${Math.random().toString(36).slice(2, 8)}`;
  for (const o of [
    { value: 'standard' as const, label: 'Standard — ships with CardMirror' },
    { value: 'large' as const, label: 'Large — better general-English dictation' },
  ]) {
    const row = document.createElement('label');
    row.className = 'pmd-multi-doc-layout-mode-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = groupName;
    input.checked = o.value === settings.get('voiceDictationModel');
    input.addEventListener('change', () => {
      if (input.checked) settings.set('voiceDictationModel', o.value);
    });
    const labelText = document.createElement('span');
    labelText.textContent = o.label;
    row.append(input, labelText);
    wrap.appendChild(row);
  }

  const status = document.createElement('div');
  status.className = 'pmd-voice-model-status';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pmd-voice-model-download';
  wrap.append(status, button);

  const refresh = async (): Promise<void> => {
    if (!api) {
      status.textContent = 'Desktop only.';
      button.style.display = 'none';
      return;
    }
    const info = await api.voiceDictationModelInfo();
    if (info.present) {
      status.textContent = 'Large model downloaded ✓';
      button.style.display = 'none';
    } else {
      status.textContent = info.downloading ? 'Downloading…' : 'Large model not downloaded.';
      button.style.display = info.downloading ? 'none' : '';
      button.textContent = 'Download large model (1.8 GB)';
    }
  };
  void refresh();

  button.addEventListener('click', () => {
    if (!api) return;
    button.style.display = 'none';
    const unsub = api.onVoiceDownloadProgress((p) => {
      status.textContent = p.extracting ? 'Extracting…' : `Downloading… ${p.pct}%`;
    });
    void api.voiceDownloadDictationModel().then((res) => {
      unsub();
      if (!res.ok) status.textContent = `Download failed: ${res.error ?? 'unknown'}`;
      void refresh();
    });
  });
  return wrap;
}

function buildFileSearchFormatsEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-multi-doc-layout-mode-editor';
  const options: { value: 'both' | 'cmir' | 'docx'; label: string }[] = [
    { value: 'both', label: 'Both .cmir and .docx (default)' },
    { value: 'cmir', label: '.cmir only' },
    { value: 'docx', label: '.docx only' },
  ];
  const groupName = `pmd-file-search-formats-${Math.random().toString(36).slice(2, 8)}`;
  const inputs: HTMLInputElement[] = [];
  for (const o of options) {
    const row = document.createElement('label');
    row.className = 'pmd-multi-doc-layout-mode-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = groupName;
    input.value = o.value;
    input.checked = o.value === settings.get('fileSearchFormats');
    input.addEventListener('change', () => {
      if (input.checked) settings.set('fileSearchFormats', o.value);
    });
    inputs.push(input);
    row.appendChild(input);
    const labelText = document.createElement('span');
    labelText.className = 'pmd-multi-doc-layout-mode-row-label';
    labelText.textContent = o.label;
    row.appendChild(labelText);
    wrap.appendChild(row);
  }
  // Re-sync if the value changes elsewhere while the panel is open.
  const unsub = settings.subscribe(() => {
    const cur = settings.get('fileSearchFormats');
    for (const input of inputs) input.checked = input.value === cur;
  });
  onDetached(wrap, () => unsub());
  return wrap;
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

/** Color editor: a free `<input type="color">` plus a row of
 *  preset swatches for the 15 OOXML highlight colors. Picking a
 *  preset writes its canonical hex into the setting and updates
 *  the free picker; using the free picker leaves the preset
 *  selection unhighlighted. Reads / writes the hex value (with
 *  leading `#`) directly via the settings store. */
function buildColorEditor(key: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-color-editor';
  const get = () => settings.get(key as keyof Settings) as string;
  const set = (v: string) => settings.set(key as keyof Settings, v as never);

  const top = document.createElement('div');
  top.className = 'pmd-color-editor-row';
  const input = document.createElement('input');
  input.type = 'color';
  input.className = 'pmd-color-editor-input';
  input.value = get();
  top.appendChild(input);
  const hex = document.createElement('span');
  hex.className = 'pmd-color-editor-hex';
  hex.textContent = input.value;
  top.appendChild(hex);
  wrap.appendChild(top);

  // Preset row: the 15 Word highlight colors as quick-pick swatches.
  const presets = document.createElement('div');
  presets.className = 'pmd-color-editor-presets';
  const swatchButtons: { btn: HTMLButtonElement; hex: string }[] = [];
  for (const c of WORD_HIGHLIGHT_COLORS) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'pmd-color-editor-swatch';
    sw.style.background = `#${c.rgb}`;
    sw.title = c.label;
    sw.setAttribute('aria-label', c.label);
    const hexValue = `#${c.rgb.toLowerCase()}`;
    sw.addEventListener('click', () => {
      set(hexValue);
      input.value = hexValue;
      hex.textContent = hexValue;
      refreshActive();
    });
    presets.appendChild(sw);
    swatchButtons.push({ btn: sw, hex: hexValue });
  }
  wrap.appendChild(presets);

  function refreshActive(): void {
    const current = get().toLowerCase();
    for (const { btn, hex } of swatchButtons) {
      btn.classList.toggle('pmd-color-editor-swatch-active', hex === current);
    }
  }

  input.addEventListener('input', () => {
    set(input.value);
    hex.textContent = input.value;
    refreshActive();
  });

  refreshActive();
  return wrap;
}

/** Theme selector — light / dark / system. Renders as a small
 *  segmented control. */
function buildThemeEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-theme-editor';
  const options: { value: 'light' | 'dark' | 'system'; label: string }[] = [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
    { value: 'system', label: 'System' },
  ];
  for (const o of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-theme-editor-btn';
    btn.textContent = o.label;
    btn.dataset['value'] = o.value;
    btn.addEventListener('click', () => settings.set('theme', o.value));
    wrap.appendChild(btn);
  }
  function refresh(): void {
    const cur = settings.get('theme');
    for (const btn of wrap.querySelectorAll<HTMLButtonElement>('.pmd-theme-editor-btn')) {
      btn.setAttribute('aria-pressed', btn.dataset['value'] === cur ? 'true' : 'false');
    }
  }
  refresh();
  const unsub = settings.subscribe(refresh);
  onDetached(wrap, () => unsub());
  return wrap;
}

/** Profile picker for the built-in timer. Each profile carries
 *  its own saved durations (see `timerProfiles` in settings);
 *  picking a profile loads that profile's saved
 *  `speechPresets` + `prepMinutes` into the live settings and
 *  refills the prep clocks. */
function buildTimerProfileEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-theme-editor';
  const options: { value: Settings['timerProfile']; label: string }[] = [
    { value: 'highSchool', label: 'High school' },
    { value: 'college', label: 'College' },
    { value: 'pomodoro', label: 'Pomodoro' },
  ];
  for (const o of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-theme-editor-btn';
    btn.textContent = o.label;
    btn.dataset['value'] = o.value;
    btn.addEventListener('click', () => {
      settings.set('timerProfile', o.value);
      const p = settings.get('timerProfiles')[o.value];
      settings.set('timerSpeechPresets', p.speechPresets as never);
      settings.set('timerPrepMinutes', p.prepMinutes);
      // Re-fill the live prep clocks to the new profile's total
      // — otherwise the buttons keep showing the previous
      // profile's remaining. Profile switch is conceptually
      // "set up a fresh round," so reset.
      resetTimer(p.prepMinutes * 60 * 1000);
    });
    wrap.appendChild(btn);
  }
  function refresh(): void {
    const cur = settings.get('timerProfile');
    for (const btn of wrap.querySelectorAll<HTMLButtonElement>('.pmd-theme-editor-btn')) {
      btn.setAttribute('aria-pressed', btn.dataset['value'] === cur ? 'true' : 'false');
    }
  }
  refresh();
  const unsub = settings.subscribe(refresh);
  onDetached(wrap, () => unsub());
  return wrap;
}

/** Inline number-input editor for the active profile's three
 *  speech-preset durations + per-side prep total. Edits write
 *  to BOTH the live setting (`timerSpeechPresets` /
 *  `timerPrepMinutes`) AND the active profile's saved slot
 *  inside `timerProfiles`, so switching to another profile and
 *  back picks the user's customization up again. */
function buildTimerProfileDurationsEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-timer-durations-editor';

  function makeField(label: string, getValue: () => number, onChange: (v: number) => void): HTMLElement {
    const field = document.createElement('label');
    field.className = 'pmd-timer-durations-field';
    const labelEl = document.createElement('span');
    labelEl.className = 'pmd-timer-durations-label';
    labelEl.textContent = label;
    field.appendChild(labelEl);
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.max = '999';
    input.step = '1';
    input.className = 'pmd-timer-durations-input';
    input.dataset['label'] = label;
    input.value = String(getValue());
    input.addEventListener('input', () => {
      const v = parseInt(input.value, 10);
      if (!Number.isFinite(v) || v < 0 || v > 999) return;
      onChange(v);
    });
    field.appendChild(input);
    const unit = document.createElement('span');
    unit.className = 'pmd-timer-durations-unit';
    unit.textContent = 'min';
    field.appendChild(unit);
    return field;
  }

  function buildFields(): void {
    wrap.innerHTML = '';
    const active = settings.get('timerProfile');
    const profileCfg = settings.get('timerProfiles')[active];
    const presets = profileCfg.speechPresets;
    for (let i = 0; i < 3; i++) {
      const labels = ['Preset 1', 'Preset 2', 'Preset 3'];
      const field = makeField(
        labels[i]!,
        () => presets[i] ?? 0,
        (v) => {
          const profiles = { ...settings.get('timerProfiles') };
          const cur = profiles[active];
          const nextPresets = cur.speechPresets.slice();
          nextPresets[i] = v;
          profiles[active] = { ...cur, speechPresets: nextPresets };
          settings.set('timerProfiles', profiles);
          settings.set('timerSpeechPresets', nextPresets as never);
        },
      );
      wrap.appendChild(field);
    }
    const prepField = makeField(
      'Prep',
      () => profileCfg.prepMinutes,
      (v) => {
        const profiles = { ...settings.get('timerProfiles') };
        const cur = profiles[active];
        profiles[active] = { ...cur, prepMinutes: v };
        settings.set('timerProfiles', profiles);
        settings.set('timerPrepMinutes', v);
        // Prep-total change refills the live prep clocks (same
        // semantics as the profile-switch case).
        resetTimer(v * 60 * 1000);
      },
    );
    wrap.appendChild(prepField);
  }

  buildFields();
  // Re-render on settings change so switching the active profile
  // refreshes the displayed values to that profile's saved durations.
  const unsub = settings.subscribe(buildFields);
  onDetached(wrap, () => unsub());
  return wrap;
}

/** Three-button segmented control for the Aff / Neg prep-button
 *  label style: text-only, color-only, or both. */
function buildTimerPrepLabelEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-theme-editor';
  const options: { value: Settings['timerPrepLabel']; label: string }[] = [
    { value: 'both', label: 'Both' },
    { value: 'text', label: 'Text only' },
    { value: 'color', label: 'Color only' },
  ];
  for (const o of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-theme-editor-btn';
    btn.textContent = o.label;
    btn.dataset['value'] = o.value;
    btn.addEventListener('click', () => settings.set('timerPrepLabel', o.value));
    wrap.appendChild(btn);
  }
  function refresh(): void {
    const cur = settings.get('timerPrepLabel');
    for (const btn of wrap.querySelectorAll<HTMLButtonElement>('.pmd-theme-editor-btn')) {
      btn.setAttribute('aria-pressed', btn.dataset['value'] === cur ? 'true' : 'false');
    }
  }
  refresh();
  const unsub = settings.subscribe(refresh);
  onDetached(wrap, () => unsub());
  return wrap;
}

/** Two-button segmented control for the `iconSet` setting, visually
 *  parallel to the theme editor. Modern (Untitled UI) / Classic (emoji). */
function buildIconSetEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-theme-editor';
  const options: { value: 'modern' | 'classic'; label: string }[] = [
    { value: 'modern', label: 'Modern' },
    { value: 'classic', label: 'Classic' },
  ];
  for (const o of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-theme-editor-btn';
    btn.textContent = o.label;
    btn.dataset['value'] = o.value;
    btn.addEventListener('click', () => settings.set('iconSet', o.value));
    wrap.appendChild(btn);
  }
  function refresh(): void {
    const cur = settings.get('iconSet');
    for (const btn of wrap.querySelectorAll<HTMLButtonElement>('.pmd-theme-editor-btn')) {
      btn.setAttribute('aria-pressed', btn.dataset['value'] === cur ? 'true' : 'false');
    }
  }
  refresh();
  const unsub = settings.subscribe(refresh);
  onDetached(wrap, () => unsub());
  return wrap;
}

/** Three-button segmented control for the `reduceMotion` setting,
 *  visually parallel to the theme editor. System / On / Off. */
function buildReduceMotionEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-theme-editor';
  const options: { value: 'auto' | 'on' | 'off'; label: string }[] = [
    { value: 'auto', label: 'System' },
    { value: 'on', label: 'On' },
    { value: 'off', label: 'Off' },
  ];
  for (const o of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-theme-editor-btn';
    btn.textContent = o.label;
    btn.dataset['value'] = o.value;
    btn.addEventListener('click', () => settings.set('reduceMotion', o.value));
    wrap.appendChild(btn);
  }
  function refresh(): void {
    const cur = settings.get('reduceMotion');
    for (const btn of wrap.querySelectorAll<HTMLButtonElement>('.pmd-theme-editor-btn')) {
      btn.setAttribute('aria-pressed', btn.dataset['value'] === cur ? 'true' : 'false');
    }
  }
  refresh();
  const unsub = settings.subscribe(refresh);
  onDetached(wrap, () => unsub());
  return wrap;
}

/** Ordered list of 1-3 color slots for the highlight / shading
 *  display overrides. Slot 0 maps to the most-common source
 *  color in the doc, slot 1 to the second-most-common, and the
 *  last slot doubles as the "everything else" catch-all. Frequency
 *  ranking happens in the highlight-frequency plugin; this UI
 *  just owns the values.
 *
 *  Renders as a stack of color pickers; the user can grow / shrink
 *  the list with `+ Add slot` / trash buttons. The last slot's
 *  trash is disabled (always at least one). */
function buildColorSlotsEditor(key: keyof Settings): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-color-slots-editor';

  const get = (): string[] => settings.get(key) as string[];
  const set = (slots: string[]) => settings.set(key, slots as never);

  function render(): void {
    wrap.innerHTML = '';
    const slots = get();
    for (let i = 0; i < slots.length; i++) {
      const row = document.createElement('div');
      row.className = 'pmd-color-slot-row';
      const rank = document.createElement('span');
      rank.className = 'pmd-color-slot-rank';
      // Last slot's caption clarifies it's the catch-all when N > 1.
      const isLast = i === slots.length - 1;
      const isOnly = slots.length === 1;
      if (isOnly) rank.textContent = '1';
      else if (isLast) rank.textContent = `${i + 1} · catch-all`;
      else rank.textContent = `${i + 1}`;
      row.appendChild(rank);
      const input = document.createElement('input');
      input.type = 'color';
      input.className = 'pmd-color-slot-input';
      input.value = slots[i]!;
      input.addEventListener('input', () => {
        const next = get().slice();
        next[i] = input.value;
        set(next);
      });
      row.appendChild(input);
      const hex = document.createElement('span');
      hex.className = 'pmd-color-slot-hex';
      hex.textContent = slots[i]!;
      input.addEventListener('input', () => {
        hex.textContent = input.value;
      });
      row.appendChild(hex);
      const trash = document.createElement('button');
      trash.type = 'button';
      trash.className = 'pmd-color-slot-trash';
      setIcon(trash, 'close');
      trash.title = 'Remove this slot';
      trash.disabled = slots.length <= 1;
      trash.addEventListener('click', () => {
        const next = get().slice();
        next.splice(i, 1);
        set(next);
      });
      row.appendChild(trash);
      wrap.appendChild(row);
    }
    if (slots.length < 3) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'pmd-color-slot-add';
      add.textContent = '+ Add slot';
      add.addEventListener('click', () => {
        const next = get().slice();
        // New slot defaults to the previous-last value so the
        // user sees a visible swatch immediately and can adjust.
        next.push(next[next.length - 1] ?? '#888888');
        set(next);
      });
      wrap.appendChild(add);
    }
  }

  render();
  const unsub = settings.subscribe(render);
  onDetached(wrap, () => unsub());
  return wrap;
}

/** Per-token color override panel. Structured like the
 *  keybindings editor: one row per overridable token, grouped
 *  into sections. Each row shows the current effective color +
 *  hex, a color picker that writes to the override, and a reset
 *  button that drops the override (revealing the default or
 *  whichever preset is active). */
function buildColorOverridesEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-color-overrides-editor';

  // Global reset header — clears every override at once.
  const header = document.createElement('div');
  header.className = 'pmd-color-overrides-header';
  const resetAll = document.createElement('button');
  resetAll.type = 'button';
  resetAll.className = 'pmd-color-overrides-reset-all';
  resetAll.textContent = '↺ Reset all overrides';
  resetAll.title = 'Drop every override and fall back to defaults';
  resetAll.addEventListener('click', () => {
    settings.set('customColorOverrides', {});
    // The document-text rows are backed by displayColors, not the
    // overrides blob — reset them too so "Reset all" clears every
    // row the user sees in this panel.
    settings.set('displayColors', { ...DEFAULT_DISPLAY_COLORS });
  });
  header.appendChild(resetAll);
  wrap.appendChild(header);

  function displayColorsAtDefault(): boolean {
    const dc = settings.get('displayColors');
    return DISPLAY_COLOR_KEYS.every(
      (k) => dc[k].toLowerCase() === DEFAULT_DISPLAY_COLORS[k].toLowerCase(),
    );
  }
  function refreshResetAll(): void {
    const has =
      Object.keys(settings.get('customColorOverrides')).length > 0 ||
      !displayColorsAtDefault();
    resetAll.disabled = !has;
  }
  refreshResetAll();
  const unsubResetAll = settings.subscribe(refreshResetAll);
  onDetached(wrap, () => unsubResetAll());

  // Group tokens by their `group` field, preserving manifest order.
  const groups = new Map<string, typeof CUSTOMIZABLE_COLOR_TOKENS[number][]>();
  for (const tok of CUSTOMIZABLE_COLOR_TOKENS) {
    let g = groups.get(tok.group);
    if (!g) { g = []; groups.set(tok.group, g); }
    g.push(tok);
  }

  function currentValue(name: string): string {
    return getComputedStyle(document.documentElement)
      .getPropertyValue('--' + name)
      .trim();
  }

  /** Resolve any CSS color string (hex / rgba / named / hsl) to
   *  numeric RGB + alpha. Used to pre-fill the color picker AND
   *  the alpha slider with the token's current effective value
   *  regardless of how it's stored. */
  // ONE reused, hidden probe for resolving color strings to rgba.
  // Appending + removing a fresh probe to <body> on every call (×37 rows ×
  // every settings change, plus at build) forced a full-document layout
  // recalc each time — the dominant settings-lag source on large docs.
  // Kept connected + laid out (`visibility:hidden`, off-screen) so
  // `getComputedStyle(probe).color` resolves, but reused so changing only
  // its own color dirties just this leaf element, not the whole document.
  const probe = document.createElement('span');
  probe.style.cssText =
    'position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none';
  document.body.appendChild(probe);
  onDetached(wrap, () => probe.remove());

  function parseToRgbaParts(css: string): {
    r: number; g: number; b: number; a: number;
  } {
    probe.style.color = css;
    const resolved = getComputedStyle(probe).color;
    const m = resolved.match(
      /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?/,
    );
    if (!m) return { r: 0, g: 0, b: 0, a: 1 };
    return {
      r: +m[1]!,
      g: +m[2]!,
      b: +m[3]!,
      a: m[4] !== undefined ? +m[4]! : 1,
    };
  }
  function toHex(r: number, g: number, b: number): string {
    const h = (n: number) => Math.round(n).toString(16).padStart(2, '0');
    return '#' + h(r) + h(g) + h(b);
  }
  /** Compose a numeric RGB + alpha back into a CSS color string.
   *  Alpha == 1 → `#rrggbb`; otherwise → `rgba(r, g, b, a)`.
   *  Keeps the override storage compact when no transparency is
   *  needed. */
  function composeColor(r: number, g: number, b: number, a: number): string {
    if (a >= 0.999) return toHex(r, g, b);
    return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${
      Math.round(a * 1000) / 1000
    })`;
  }

  function isOverridden(name: string): boolean {
    const overrides = settings.get('customColorOverrides');
    return Object.prototype.hasOwnProperty.call(overrides, name);
  }

  function setOverride(name: string, value: string): void {
    const next = { ...settings.get('customColorOverrides'), [name]: value };
    settings.set('customColorOverrides', next);
  }
  function clearOverride(name: string): void {
    const cur = settings.get('customColorOverrides');
    if (!Object.prototype.hasOwnProperty.call(cur, name)) return;
    const next = { ...cur };
    delete next[name];
    settings.set('customColorOverrides', next);
  }

  function renderRow(tok: typeof CUSTOMIZABLE_COLOR_TOKENS[number]): HTMLElement {
    const row = document.createElement('div');
    row.className = 'pmd-color-override-row';

    const label = document.createElement('span');
    label.className = 'pmd-color-override-label';
    label.textContent = tok.label;
    row.appendChild(label);

    const right = document.createElement('span');
    right.className = 'pmd-color-override-right';

    const swatch = document.createElement('span');
    swatch.className = 'pmd-color-override-swatch';
    const hex = document.createElement('span');
    hex.className = 'pmd-color-override-hex';

    const input = document.createElement('input');
    input.type = 'color';
    input.className = 'pmd-color-override-input';

    // Document-text tokens (analytic / undertag) are backed by the
    // `displayColors` setting, linked to the Appearance → Style colors
    // picker. For these the row reads / writes displayColors (a plain
    // opaque hex) instead of the overrides blob, and the alpha slider
    // is hidden — document text is never translucent.
    const dcKey = DISPLAY_COLOR_TOKEN_TO_KEY[tok.name];

    // Alpha slider, sized 0–1 with two-decimal steps. Lets the
    // user tune translucent tokens (`pmd-c-overlay`, the various
    // soft accents) — important for an accessibility tool, where
    // a user might need to dial the modal-scrim alpha way up for
    // readability or way down to keep underlying text legible.
    const alpha = document.createElement('input');
    alpha.type = 'range';
    alpha.className = 'pmd-color-override-alpha';
    alpha.min = '0';
    alpha.max = '1';
    alpha.step = '0.01';
    alpha.title = 'Opacity';
    if (dcKey) alpha.hidden = true;

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'pmd-color-override-reset';
    setIcon(reset, 'reset');
    reset.title = 'Reset to default';

    function refresh(): void {
      if (dcKey) {
        const value = settings.get('displayColors')[dcKey];
        swatch.style.background = value;
        hex.textContent = value;
        input.value = value;
        reset.disabled =
          value.toLowerCase() === DEFAULT_DISPLAY_COLORS[dcKey].toLowerCase();
        return;
      }
      const value = currentValue(tok.name);
      const { r, g, b, a } = parseToRgbaParts(value);
      swatch.style.background = value;
      hex.textContent = value;
      input.value = toHex(r, g, b);
      alpha.value = String(a);
      // Keep the button in the layout always so the row doesn't
      // shift width as the user drags the alpha slider into / out
      // of "this is now overridden" territory. Just toggle
      // disabled / aria-pressed for visual state.
      reset.disabled = !isOverridden(tok.name);
    }

    function write(): void {
      if (dcKey) {
        settings.set('displayColors', {
          ...settings.get('displayColors'),
          [dcKey]: input.value,
        });
        return;
      }
      const { r, g, b } = parseToRgbaParts(input.value);
      const a = Math.max(0, Math.min(1, +alpha.value));
      setOverride(tok.name, composeColor(r, g, b, a));
    }

    input.addEventListener('input', write);
    alpha.addEventListener('input', write);
    reset.addEventListener('click', () => {
      if (dcKey) {
        settings.set('displayColors', {
          ...settings.get('displayColors'),
          [dcKey]: DEFAULT_DISPLAY_COLORS[dcKey],
        });
      } else {
        clearOverride(tok.name);
      }
    });

    right.appendChild(swatch);
    right.appendChild(hex);
    right.appendChild(input);
    right.appendChild(alpha);
    right.appendChild(reset);
    row.appendChild(right);

    refresh();
    // Refresh this row only when ITS OWN token's value changes — the
    // document-text rows track `displayColors[dcKey]`, the rest their
    // own `customColorOverrides[name]`. (`refresh` reads a computed
    // style, so re-running it across all ~37 rows on every settings
    // change — or on every color edit, when only one token actually
    // changed — was the dominant settings lag on large docs. The
    // customizable tokens are independent base colors, so editing one
    // never changes another's effective value.)
    const tokenValue = (s: ReturnType<typeof settings.all>): unknown =>
      dcKey ? s.displayColors[dcKey] : s.customColorOverrides[tok.name];
    let lastBacking = tokenValue(settings.all());
    const unsub = settings.subscribe((s) => {
      const cur = tokenValue(s);
      if (cur !== lastBacking) {
        lastBacking = cur;
        refresh();
      }
    });
    onDetached(row, () => unsub());

    return row;
  }

  for (const [groupName, tokens] of groups) {
    const heading = document.createElement('div');
    heading.className = 'pmd-color-override-group-label';
    heading.textContent = groupName;
    wrap.appendChild(heading);
    for (const t of tokens) wrap.appendChild(renderRow(t));
  }

  return wrap;
}

function buildFindCategoryOrderEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-find-category-order-editor';
  const labels: Record<string, string> = {
    heading: 'Headings (Pocket / Hat / Block)',
    tag: 'Tags',
    cite: 'Cites',
    other: 'Other (body, analytics, undertags, …)',
  };

  function render(): void {
    wrap.innerHTML = '';
    const order = settings.get('findCategoryOrder');
    for (let i = 0; i < order.length; i++) {
      const cat = order[i]!;
      const row = document.createElement('div');
      row.className = 'pmd-find-category-order-row';
      const rank = document.createElement('span');
      rank.className = 'pmd-find-category-order-rank';
      rank.textContent = String(i + 1);
      row.appendChild(rank);
      const labelEl = document.createElement('span');
      labelEl.className = 'pmd-find-category-order-label';
      labelEl.textContent = labels[cat] ?? cat;
      row.appendChild(labelEl);
      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'pmd-find-category-order-btn';
      setIcon(upBtn, 'arrow-up');
      upBtn.title = 'Move up';
      upBtn.disabled = i === 0;
      upBtn.addEventListener('click', () => swap(i, i - 1));
      row.appendChild(upBtn);
      const downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.className = 'pmd-find-category-order-btn';
      setIcon(downBtn, 'arrow-down');
      downBtn.title = 'Move down';
      downBtn.disabled = i === order.length - 1;
      downBtn.addEventListener('click', () => swap(i, i + 1));
      row.appendChild(downBtn);
      wrap.appendChild(row);
    }
  }

  function swap(a: number, b: number): void {
    const cur = settings.get('findCategoryOrder').slice();
    const tmp = cur[a]!;
    cur[a] = cur[b]!;
    cur[b] = tmp;
    settings.set('findCategoryOrder', cur);
    render();
  }

  render();
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

function buildTranslationEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-translation-editor';

  // --- Backend radios ---
  const providers: { value: 'auto' | 'mymemory' | 'anthropic' | 'google'; label: string; note?: string }[] = [
    { value: 'auto', label: 'Automatic — Anthropic when AI features are on, otherwise MyMemory' },
    { value: 'mymemory', label: 'MyMemory — free, no key, works with AI features off' },
    { value: 'anthropic', label: 'Anthropic — highest quality (requires AI features)' },
    { value: 'google', label: 'Google Cloud Translation — needs an API key below' },
  ];
  const groupName = `pmd-translation-provider-${Math.random().toString(36).slice(2, 8)}`;
  // Anthropic-dependent radios, greyed when AI features are off.
  const anthropicRadios: HTMLInputElement[] = [];
  const fieldLabel = (txt: string): HTMLElement => {
    const l = document.createElement('div');
    l.className = 'pmd-settings-row-title';
    l.textContent = txt;
    return l;
  };

  for (const o of providers) {
    const row = document.createElement('label');
    row.className = 'pmd-multi-doc-layout-mode-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = groupName;
    input.value = o.value;
    input.checked = o.value === settings.get('translationProvider');
    input.addEventListener('change', () => {
      if (input.checked) settings.set('translationProvider', o.value);
    });
    if (o.value === 'anthropic') anthropicRadios.push(input);
    row.appendChild(input);
    const labelText = document.createElement('span');
    labelText.className = 'pmd-multi-doc-layout-mode-row-label';
    labelText.textContent = o.label;
    row.appendChild(labelText);
    wrap.appendChild(row);
  }

  // Note shown when AI features are off and Anthropic is greyed.
  const aiNote = document.createElement('div');
  aiNote.className = 'pmd-settings-row-desc pmd-translation-ai-note';
  aiNote.textContent = 'Anthropic translation is unavailable until you enable AI features under Comments & AI.';
  wrap.appendChild(aiNote);

  // Determinism / evidence-ethics caveat for the Anthropic backend.
  const caveat = document.createElement('div');
  caveat.className = 'pmd-settings-row-desc pmd-translation-caveat';
  caveat.textContent =
    'Note: The Anthropic translation system prompt directs the model to preserve the original meaning above all else. However, the translation may not be deterministic — re-running can produce slightly different wording. Keep this in mind if you are debating in a league or circuit where translated evidence requires a paper trail or reproducibility.';
  wrap.appendChild(caveat);

  const langRow = document.createElement('div');
  langRow.className = 'pmd-translation-langs';

  // --- Source language ---
  const srcWrap = document.createElement('div');
  srcWrap.appendChild(fieldLabel('Source language'));
  const srcSel = document.createElement('select');
  srcSel.className = 'pmd-body-font-select';
  const autoOpt = document.createElement('option');
  autoOpt.value = 'auto';
  autoOpt.textContent = 'Auto-detect';
  srcSel.appendChild(autoOpt);
  for (const l of TRANSLATION_LANGUAGES) {
    const opt = document.createElement('option');
    opt.value = l.code;
    opt.textContent = l.name;
    srcSel.appendChild(opt);
  }
  srcSel.value = settings.get('translationSourceLang');
  srcSel.addEventListener('change', () => settings.set('translationSourceLang', srcSel.value));
  srcWrap.appendChild(srcSel);
  langRow.appendChild(srcWrap);

  // --- Target language ---
  const tgtWrap = document.createElement('div');
  tgtWrap.appendChild(fieldLabel('Target language'));
  const tgtSel = document.createElement('select');
  tgtSel.className = 'pmd-body-font-select';
  for (const l of TRANSLATION_LANGUAGES) {
    const opt = document.createElement('option');
    opt.value = l.code;
    opt.textContent = l.name;
    tgtSel.appendChild(opt);
  }
  tgtSel.value = settings.get('translationTargetLang');
  tgtSel.addEventListener('change', () => settings.set('translationTargetLang', tgtSel.value));
  tgtWrap.appendChild(tgtSel);
  langRow.appendChild(tgtWrap);
  wrap.appendChild(langRow);

  // --- MyMemory email (optional, raises the daily limit) ---
  const emailWrap = document.createElement('div');
  emailWrap.className = 'pmd-translation-field';
  emailWrap.appendChild(fieldLabel('MyMemory email (optional)'));
  const emailDesc = document.createElement('div');
  emailDesc.className = 'pmd-settings-row-desc';
  emailDesc.textContent = 'Supplying an email raises MyMemory’s free limit from ~5,000 to ~50,000 characters/day.';
  emailWrap.appendChild(emailDesc);
  const email = document.createElement('input');
  email.type = 'email';
  email.className = 'pmd-settings-text';
  email.value = settings.get('myMemoryEmail');
  email.placeholder = 'you@example.com';
  email.addEventListener('change', () => settings.set('myMemoryEmail', email.value.trim()));
  emailWrap.appendChild(email);
  wrap.appendChild(emailWrap);

  // --- Google API key (only used by the Google backend) ---
  const keyWrap = document.createElement('div');
  keyWrap.className = 'pmd-translation-field';
  keyWrap.appendChild(fieldLabel('Google Cloud Translation API key'));
  const keyDesc = document.createElement('div');
  keyDesc.className = 'pmd-settings-row-desc';
  keyDesc.textContent = 'Only used by the Google backend. 500,000 characters/month are free; beyond that Google bills per character. Stored locally.';
  keyWrap.appendChild(keyDesc);
  const key = document.createElement('input');
  key.type = 'password';
  key.className = 'pmd-settings-text';
  key.value = settings.get('googleTranslateApiKey');
  key.addEventListener('change', () => settings.set('googleTranslateApiKey', key.value.trim()));
  keyWrap.appendChild(key);
  wrap.appendChild(keyWrap);

  // Live-grey the Anthropic radio + note based on the AI master switch.
  const applyAiState = (): void => {
    const ready = settings.get('aiFeaturesEnabled');
    for (const r of anthropicRadios) {
      r.disabled = !ready;
      r.closest('label')?.classList.toggle('pmd-settings-row-disabled', !ready);
    }
    aiNote.style.display = ready ? 'none' : '';
  };
  applyAiState();
  const unsub = settings.subscribe(() => {
    // Self-detach once the widget leaves the DOM (dialog re-render / close).
    if (!document.body.contains(wrap)) { unsub(); return; }
    applyAiState();
  });

  return wrap;
}

function buildSendDocDestinationEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-multi-doc-layout-mode-editor';
  const options: { value: 'sameFolder' | 'fixedFolder'; label: string }[] = [
    { value: 'sameFolder', label: 'Same folder as the document (default)' },
    { value: 'fixedFolder', label: 'Fixed folder (set below)' },
  ];
  const groupName = `pmd-send-doc-dest-${Math.random().toString(36).slice(2, 8)}`;
  for (const o of options) {
    const row = document.createElement('label');
    row.className = 'pmd-multi-doc-layout-mode-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = groupName;
    input.value = o.value;
    input.checked = o.value === settings.get('sendDocDestination');
    input.addEventListener('change', () => {
      if (input.checked) settings.set('sendDocDestination', o.value);
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

/** Generic radio-group editor for the string-valued card-cutter
 *  settings. Mirrors the other radio editors' markup. */
function buildCardCutterRadio(
  key: 'cardCutterEmphasisStyle' | 'cardCutterAcronymSplitting' | 'cardCutterClarifyingQuestions',
  options: [string, string][],
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-heading-mode-editor';
  const groupName = `pmd-${key}-${Math.random().toString(36).slice(2, 8)}`;
  for (const [value, label] of options) {
    const row = document.createElement('label');
    row.className = 'pmd-heading-mode-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = groupName;
    input.value = value;
    input.checked = settings.get(key) === value;
    input.addEventListener('change', () => {
      if (input.checked) settings.set(key, value as never);
    });
    row.appendChild(input);
    const span = document.createElement('span');
    span.className = 'pmd-heading-mode-row-label';
    span.textContent = label;
    row.appendChild(span);
    wrap.appendChild(row);
  }
  return wrap;
}

function buildMobileLayoutEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-mobile-layout-editor';
  const options: { value: 'auto' | 'mobile' | 'desktop'; label: string }[] = [
    { value: 'auto', label: 'Auto — mobile layout on small touch screens (default)' },
    { value: 'mobile', label: 'Mobile — always the view-first layout' },
    { value: 'desktop', label: 'Desktop — always this layout' },
  ];
  const groupName = `pmd-mobile-layout-${Math.random().toString(36).slice(2, 8)}`;
  for (const o of options) {
    const row = document.createElement('label');
    row.className = 'pmd-mobile-layout-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = groupName;
    input.value = o.value;
    input.checked = o.value === settings.get('mobileLayout');
    input.addEventListener('change', () => {
      if (!input.checked) return;
      settings.set('mobileLayout', o.value);
      // The shell is chosen once per load; offer the reload here so
      // the choice takes effect now rather than on the next visit.
      if (window.confirm('Reload now to apply the layout change?')) {
        window.location.reload();
      }
    });
    row.appendChild(input);
    const labelText = document.createElement('span');
    labelText.className = 'pmd-mobile-layout-row-label';
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

/** Four-button segmented control for `fileSearchOutlineDepth` — the
 *  deepest level the file-search outline expands to by default. */
function buildFileSearchOutlineDepthEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-theme-editor';
  const options: { value: number; label: string }[] = [
    { value: 1, label: 'Pocket' },
    { value: 2, label: 'Hat' },
    { value: 3, label: 'Block' },
    { value: 4, label: 'Tag' },
  ];
  for (const o of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-theme-editor-btn';
    btn.textContent = o.label;
    btn.dataset['value'] = String(o.value);
    btn.addEventListener('click', () => settings.set('fileSearchOutlineDepth', o.value));
    wrap.appendChild(btn);
  }
  function refresh(): void {
    const cur = String(settings.get('fileSearchOutlineDepth'));
    for (const btn of wrap.querySelectorAll<HTMLButtonElement>('.pmd-theme-editor-btn')) {
      btn.setAttribute('aria-pressed', btn.dataset['value'] === cur ? 'true' : 'false');
    }
  }
  refresh();
  const unsub = settings.subscribe(refresh);
  onDetached(wrap, () => unsub());
  return wrap;
}

/** Checklist of which structural objects the within-file search
 *  surfaces (pocket / hat / block / tag / cite / analytic), editing
 *  the `fileSearchObjectTypes` array. */
function buildFileObjectTypesEditor(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-file-object-types-editor';
  for (const kind of FILE_OBJECT_KINDS) {
    const row = document.createElement('label');
    row.className = 'pmd-file-object-type-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.addEventListener('change', () => {
      const cur = new Set(settings.get('fileSearchObjectTypes'));
      if (cb.checked) cur.add(kind);
      else cur.delete(kind);
      // Persist in canonical outline order.
      settings.set(
        'fileSearchObjectTypes',
        FILE_OBJECT_KINDS.filter((k) => cur.has(k)),
      );
    });
    const span = document.createElement('span');
    span.textContent = FILE_OBJECT_KIND_LABELS[kind];
    row.append(cb, span);
    wrap.appendChild(row);
  }
  const refresh = (): void => {
    const set = new Set(settings.get('fileSearchObjectTypes') as FileObjectKind[]);
    const boxes = wrap.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    FILE_OBJECT_KINDS.forEach((kind, i) => {
      const box = boxes[i];
      if (box) box.checked = set.has(kind);
    });
  };
  refresh();
  const unsub = settings.subscribe(refresh);
  onDetached(wrap, () => unsub());
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
      setIcon(delBtn, 'close');
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
  onDetached(wrap, () => unsubscribe());

  return wrap;
}

let singleton: SettingsModal | null = null;

export function openSettings(target?: SettingsTarget): void {
  if (!singleton) singleton = new SettingsModal();
  singleton.open(target);
}
