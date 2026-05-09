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
import { settings } from './settings.js';
import { readModePlugin } from './read-mode-plugin.js';

const editorEl = document.getElementById('editor')!;
const navEl = document.getElementById('nav-panel')!;
const dropzone = document.getElementById('dropzone') as HTMLInputElement;
const openBtn = document.getElementById('open-btn') as HTMLButtonElement;
const exportBtn = document.getElementById('export-btn') as HTMLButtonElement;
const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement;
const readModeBtn = document.getElementById('read-mode-btn') as HTMLButtonElement;

// Module-level state. Declared before the settings subscriber registers
// so that `applyReadMode` can read `view` without a temporal-dead-zone
// ReferenceError on initial call.
let view: EditorView | null = null;
let currentDoc: PMNode = makeStarterDoc();

openBtn.addEventListener('click', () => dropzone.click());
settingsBtn.addEventListener('click', () => openSettings());
readModeBtn.addEventListener('click', () => settings.set('readMode', !settings.get('readMode')));

// Apply read-mode visual state and editing lockdown whenever the
// setting changes (and once now to handle the persisted value).
settings.subscribe((s) => applyReadMode(s.readMode));
applyReadMode(settings.get('readMode'));

function applyReadMode(on: boolean): void {
  editorEl.classList.toggle('pmd-read-mode', on);
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
    schema.nodes['scratchpad']!.create(null, [
      schema.nodes['paragraph']!.create(null, schema.text('Scratchpad text — schema escape hatch.')),
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
      keymap(baseKeymap),
      readModePlugin,
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
    },
  });
  currentDoc = doc;
  navPanel.attach(view);
  exportBtn.disabled = false;
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
