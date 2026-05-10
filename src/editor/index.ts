/**
 * Minimal browser editor — v0.
 *
 * Mounts a ProseMirror EditorView with our schema. Lets the user drop a
 * .docx, see it rendered, and export it back. This exists as a visual
 * sanity check while we build the foundation; full editor UX (read mode,
 * navigation panel, send-to-speech, drag-and-drop, etc.) is later work.
 */

import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { history, undo, redo } from 'prosemirror-history';
import { baseKeymap } from 'prosemirror-commands';
import { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../schema/index.js';
import { fromDocx, toDocx } from '../index.js';
import { NavigationPanel } from './nav-panel.js';
import { openSettings } from './settings-ui.js';
import {
  settings,
  DISPLAY_SIZE_KEYS,
  type DisplaySizes,
  type DisplayTypography,
} from './settings.js';
import { readModePlugin } from './read-mode-plugin.js';
import { absorbPlugin } from './absorb-plugin.js';
import { fontSizeClassPlugin } from './font-size-class-plugin.js';
import {
  backspaceAtTagStart,
  deleteAtTagEnd,
  enterMidTag,
  enterAtTagEnd,
} from './tag-keymap.js';
import { openWordCount } from './word-count-ui.js';
import { countReadAloudWords, formatReadTime, formatNumber } from './word-count.js';

const editorEl = document.getElementById('editor')!;
const navEl = document.getElementById('nav-panel')!;
const dropzone = document.getElementById('dropzone') as HTMLInputElement;
const openBtn = document.getElementById('open-btn') as HTMLButtonElement;
const exportBtn = document.getElementById('export-btn') as HTMLButtonElement;
const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement;
const readModeBtn = document.getElementById('read-mode-btn') as HTMLButtonElement;
const wordCountBtn = document.getElementById('word-count-btn') as HTMLButtonElement;
const wordCountText = document.getElementById('word-count-text')!;
const zoomOutBtn = document.getElementById('zoom-out-btn') as HTMLButtonElement;
const zoomInBtn = document.getElementById('zoom-in-btn') as HTMLButtonElement;
const zoomResetBtn = document.getElementById('zoom-reset-btn') as HTMLButtonElement;
const zoomPct = document.getElementById('zoom-pct')!;

// Module-level state. Declared before the settings subscriber registers
// so that `applyReadMode` can read `view` without a temporal-dead-zone
// ReferenceError on initial call.
let view: EditorView | null = null;
let currentDoc: PMNode = makeStarterDoc();

openBtn.addEventListener('click', () => dropzone.click());
settingsBtn.addEventListener('click', () => openSettings());
readModeBtn.addEventListener('click', () => settings.set('readMode', !settings.get('readMode')));
wordCountBtn.addEventListener('click', () => { if (view) openWordCount(view); });

// Zoom controls.
zoomOutBtn.addEventListener('click', () => setZoom(settings.get('zoomPct') - 10));
zoomInBtn.addEventListener('click', () => setZoom(settings.get('zoomPct') + 10));
zoomResetBtn.addEventListener('click', () => setZoom(100));

function setZoom(pct: number): void {
  const clamped = Math.max(50, Math.min(200, Math.round(pct / 10) * 10));
  settings.set('zoomPct', clamped);
}

function applyZoom(pct: number): void {
  document.documentElement.style.setProperty('--editor-zoom', String(pct / 100));
  zoomPct.textContent = `${pct}%`;
  zoomResetBtn.disabled = pct === 100;
}

/**
 * Push displaySizes into CSS custom properties on `#editor`. CSS rules
 * for each named style use `font-size: var(--pmd-size-<name>)`, so
 * updating these variables retypes the whole editor.
 */
function applyDisplaySizes(sizes: DisplaySizes): void {
  for (const key of DISPLAY_SIZE_KEYS) {
    editorEl.style.setProperty(`--pmd-size-${key}`, `${sizes[key]}pt`);
  }
}

/**
 * Push typography flags onto `#editor` as classes (predicated CSS) and
 * as a CSS custom property for the box thickness. Each boolean either
 * adds or removes a class; CSS rules selector-gated on those classes
 * apply the corresponding decoration.
 */
function applyDisplayTypography(t: DisplayTypography): void {
  editorEl.classList.toggle('pmd-cite-underlined', t.citeUnderlined);
  editorEl.classList.toggle('pmd-underline-bold', t.underlineBold);
  editorEl.classList.toggle('pmd-emphasis-bold', t.emphasisBold);
  editorEl.classList.toggle('pmd-emphasis-italic', t.emphasisItalic);
  editorEl.classList.toggle('pmd-emphasis-box', t.emphasisBox);
  editorEl.style.setProperty('--pmd-emphasis-box-size', `${t.emphasisBoxSize}pt`);
}

/** CSS generic font categories — always available, picked by the
 *  browser per system. Don't quote these; quotes would turn them into
 *  literal font names that don't exist. */
const GENERIC_FONT_KEYWORDS = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
]);

function applyBodyFont(font: string): void {
  // Set font-family as an inline style directly. Quoted form for named
  // fonts (handles spaces and avoids ambiguity with CSS keywords);
  // unquoted form for generic categories. Inline style on #editor wins
  // over the stylesheet rule and inherits to all descendants.
  const head = GENERIC_FONT_KEYWORDS.has(font) ? font : `"${font}"`;
  editorEl.style.fontFamily = `${head}, 'Helvetica Neue', sans-serif`;
}

function applyLineHeight(multiplier: number): void {
  editorEl.style.setProperty('--pmd-line-height', String(multiplier));
}

// Apply read-mode visual state and editing lockdown whenever the
// setting changes (and once now to handle the persisted value).
settings.subscribe((s) => {
  applyReadMode(s.readMode);
  applyZoom(s.zoomPct);
  applyDisplaySizes(s.displaySizes);
  applyDisplayTypography(s.displayTypography);
  applyBodyFont(s.bodyFont);
  applyLineHeight(s.lineHeight);
  refreshWordCount();
});
applyReadMode(settings.get('readMode'));
applyZoom(settings.get('zoomPct'));
applyDisplaySizes(settings.get('displaySizes'));
applyDisplayTypography(settings.get('displayTypography'));
applyBodyFont(settings.get('bodyFont'));
applyLineHeight(settings.get('lineHeight'));

function refreshWordCount(): void {
  if (!view) {
    wordCountText.textContent = '—';
    return;
  }
  const sel = view.state.selection;
  const hasSelection = !sel.empty;
  const words = hasSelection
    ? countReadAloudWords(view.state.doc, sel.from, sel.to)
    : countReadAloudWords(view.state.doc);

  const readers = settings.get('readers').slice(0, 2);
  const head = hasSelection
    ? `Selection: ${formatNumber(words)}`
    : formatNumber(words);
  const parts = [head];
  for (const r of readers) {
    parts.push(`${r.name}: ${formatReadTime(words, r.wpm)}`);
  }
  wordCountText.textContent = parts.join(' · ');
}

function applyReadMode(on: boolean): void {
  editorEl.classList.toggle('pmd-read-mode', on);
  editorEl.classList.toggle(
    'pmd-rm-no-emphasis-borders',
    on && settings.get('hideEmphasisBordersInReadMode'),
  );
  readModeBtn.classList.toggle('pmd-active', on);
  if (view) view.setProps({ editable: () => !on });
}

const navPanel = new NavigationPanel(navEl);

function makeStarterDoc(): PMNode {
  return schema.nodes['doc']!.createChecked(null, [
    schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text('prosemirror-debate playground')),
    schema.nodes['paragraph']!.create(null, [
      schema.text('Drop a .docx in the input above to load it. The schema renders here as the canonical Verbatim layout (Pocket = box, Hat = centered double underline, Block = centered single underline, Tag = inline-bold).'),
    ]),
    schema.nodes['hat']!.create({ id: newHeadingId() }, schema.text('Example structures')),
    schema.nodes['block']!.create({ id: newHeadingId() }, schema.text('A block containing two cards')),
    schema.nodes['paragraph']!.create(null, schema.text('Loose paragraphs are first-class — they can sit between a heading and the cards beneath it. Paragraphs typed after a card auto-absorb as card_body; insert a heading to bound a region of loose text.')),
    schema.nodes['card']!.create(null, [
      schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Climate action delays catastrophic — IPCC')),
      // Undertags belong to the tag — they sit inside the card, not after it.
      schema.nodes['undertag']!.create(null, schema.text('Sub-tag note that explains the tag (green italic).')),
      schema.nodes['cite_paragraph']!.create(null, [
        schema.text('IPCC AR6 ', [schema.marks['cite_mark']!.create()]),
        schema.text('2023, '),
        schema.text('Synthesis Report', [schema.marks['italic']!.create()]),
        schema.text(', '),
        schema.text('https://ipcc.ch', [schema.marks['link']!.create({ href: 'https://www.ipcc.ch' })]),
      ]),
      schema.nodes['card_body']!.create(null, [
        schema.text('Plain context. '),
        schema.text('Underlined evidence claim ', [schema.marks['underline_mark']!.create()]),
        schema.text('plus highlighted ', [
          schema.marks['underline_mark']!.create(),
          schema.marks['highlight']!.create({ color: 'yellow' }),
        ]),
        schema.text('and emphasized.', [
          schema.marks['emphasis_mark']!.create(),
          schema.marks['highlight']!.create({ color: 'yellow' }),
        ]),
      ]),
    ]),
    schema.nodes['analytic_unit']!.create(null, [
      schema.nodes['analytic']!.create(
        { id: newHeadingId() },
        schema.text('A standalone analytic between cards (dark blue).'),
      ),
      schema.nodes['card_body']!.create(null, [
        schema.text('Body paragraphs after the analytic are absorbed into the unit, so the whole thing drags as one. Hover to see the gray bar — same boundary indicator as cards.'),
      ]),
    ]),
  ]);
}

function mountView(doc: PMNode): void {
  if (view) view.destroy();
  const state = EditorState.create({
    doc,
    schema,
    plugins: [
      history(),
      keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo }),
      // Tag/analytic boundary editing rules (ARCHITECTURE.md §14.3).
      // These run before baseKeymap so they get first crack at
      // Backspace / Delete / Enter when the cursor is in a tag.
      keymap({
        Backspace: backspaceAtTagStart,
        Delete: deleteAtTagEnd,
        Enter: (state, dispatch, view) =>
          enterAtTagEnd(state, dispatch, view) ||
          enterMidTag(state, dispatch, view),
      }),
      keymap(baseKeymap),
      readModePlugin,
      absorbPlugin,
      fontSizeClassPlugin,
    ],
  });
  view = new EditorView(editorEl, {
    state,
    editable: () => !settings.get('readMode'),
    dispatchTransaction(tx) {
      if (!view) return;
      const next = view.state.apply(tx);
      view.updateState(next);
      if (tx.docChanged) {
        currentDoc = next.doc;
        navPanel.update(next.doc);
      }
      // Selection or doc change → refresh the word-count strip.
      refreshWordCount();
    },
  });
  currentDoc = doc;
  navPanel.attach(view);
  exportBtn.disabled = false;
  refreshWordCount();
}

dropzone.addEventListener('change', async () => {
  const file = dropzone.files?.[0];
  if (!file) return;
  const buf = await file.arrayBuffer();
  try {
    const doc = await fromDocx(new Uint8Array(buf));
    mountView(doc);
    console.log(`Loaded ${file.name}: ${countSummary(doc)}`);
  } catch (err) {
    console.error('Failed to load docx:', err);
    alert(`Failed to load: ${err instanceof Error ? err.message : err}`);
  }
});

exportBtn.addEventListener('click', async () => {
  try {
    const bytes = await toDocx(currentDoc);
    // Copy into a regular ArrayBuffer for Blob's BlobPart contract.
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    const blob = new Blob([ab], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'exported.docx';
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error('Export failed:', err);
    alert(`Export failed: ${err instanceof Error ? err.message : err}`);
  }
});

function countSummary(doc: PMNode): string {
  const counts: Record<string, number> = {};
  doc.descendants((node) => {
    counts[node.type.name] = (counts[node.type.name] ?? 0) + 1;
  });
  return Object.entries(counts)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
}

mountView(currentDoc);
