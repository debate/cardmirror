// @vitest-environment jsdom
/**
 * Smart paste conversion wiring in handlePaste: recognized Word HTML
 * converts to structure when the setting is on; the setting gates it
 * off; unrecognized HTML falls through untouched; F2 plain-paste-armed
 * always wins over conversion.
 */
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { DOMParser as PMDOMParser } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  buildPastePlugin,
  plainPasteKey,
  type PastePluginCtx,
} from '../../src/editor/paste-plugin.js';

const WORD_HTML = `<html xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta name=Generator content="Microsoft Word 15"><style><!--
span.Style13ptBold {mso-style-name:"Style 13 pt Bold\\,Cite"; font-weight:bold; font-size:13.0pt;}
span.StyleUnderline {mso-style-name:"Style Underline"; text-decoration:underline;}
--></style></head><body><h4>Warming causes extinction</h4><p class=MsoNormal><span class=Style13ptBold>Smith ’23</span> — Jane</p><p class=MsoNormal>Feedback loops <span class=StyleUnderline>accelerate</span>.</p></body></html>`;

const PLAIN_WEB_HTML = `<article><h2>A headline</h2><p>Ordinary <b>web</b> text.</p></article>`;

function makeView(smartPaste: boolean): EditorView {
  const ctx: PastePluginCtx = {
    condenseOnPaste: () => false,
    paragraphIntegrity: () => false,
    usePilcrows: () => false,
    headingMode: () => 'respect',
    smartPasteConversion: () => smartPaste,
  };
  const doc = schema.nodes['doc']!.create(null, [
    schema.nodes['card']!.createChecked(null, [
      schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Existing tag')),
      schema.nodes['card_body']!.create(null, schema.text('existing body')),
    ]),
  ]);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const view = new EditorView(container, {
    state: EditorState.create({ doc, plugins: [buildPastePlugin(ctx)] }),
  });
  // Caret at the end of the existing body — a realistic paste target.
  const end = view.state.doc.content.size - 2;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
  return view;
}

function pasteEvent(flavors: Record<string, string>): ClipboardEvent {
  return {
    preventDefault: () => {},
    clipboardData: {
      files: [],
      getData: (type: string) => flavors[type] ?? '',
    },
  } as unknown as ClipboardEvent;
}

function firePaste(view: EditorView, event: ClipboardEvent): boolean {
  const plugin = view.state.plugins.find((p) => p.props.handlePaste)!;
  // The slice PM would hand handlePaste: the clipboard HTML parsed
  // against the schema (foreign markup degrades to plain paragraphs,
  // since our parse rules are pmd-class-qualified).
  const html = (event.clipboardData?.getData('text/html') ?? '');
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  const slice = PMDOMParser.fromSchema(schema).parseSlice(wrap);
  return plugin.props.handlePaste!.call(plugin, view, event, slice) === true;
}

/** Count structural nodes that only smart conversion could create. */
function structureCounts(view: EditorView): { tags: number; cites: number } {
  let tags = 0;
  let cites = 0;
  view.state.doc.descendants((n) => {
    if (n.type.name === 'tag') tags++;
    if (n.type.name === 'cite_paragraph') cites++;
    return true;
  });
  return { tags, cites };
}

describe('smart paste conversion in handlePaste', () => {
  it('Word HTML converts to a structured card when the setting is on', () => {
    const view = makeView(true);
    const handled = firePaste(view, pasteEvent({ 'text/html': WORD_HTML, 'text/plain': 'Warming…' }));
    expect(handled).toBe(true);
    expect(() => view.state.doc.check()).not.toThrow();
    const types: string[] = [];
    view.state.doc.descendants((n) => {
      if (n.isTextblock) types.push(`${n.type.name}:${n.textContent}`);
      return true;
    });
    expect(types).toContain('tag:Warming causes extinction');
    expect(types.some((t) => t.startsWith('cite_paragraph:Smith'))).toBe(true);
    view.destroy();
  });

  it('the setting gates conversion off — the default paths run, no structure is created', () => {
    const view = makeView(false);
    firePaste(view, pasteEvent({ 'text/html': WORD_HTML, 'text/plain': 'Warming…' }));
    // Whatever the default paths did with the degraded paragraphs,
    // they must not have created structure: still exactly the one
    // pre-existing tag, and no cite paragraph.
    expect(structureCounts(view)).toEqual({ tags: 1, cites: 0 });
    view.destroy();
  });

  it('unrecognized web HTML is never converted even with the setting on', () => {
    const view = makeView(true);
    firePaste(view, pasteEvent({ 'text/html': PLAIN_WEB_HTML, 'text/plain': 'Ordinary web text.' }));
    expect(structureCounts(view)).toEqual({ tags: 1, cites: 0 });
    view.destroy();
  });

  it('F2 plain-paste-armed wins over conversion', () => {
    const view = makeView(true);
    view.dispatch(view.state.tr.setMeta(plainPasteKey, { plainPasteArmed: true }));
    const handled = firePaste(
      view,
      pasteEvent({ 'text/html': WORD_HTML, 'text/plain': 'plain warming text' }),
    );
    expect(handled).toBe(true);
    expect(view.state.doc.textContent).toContain('plain warming text');
    // No structural conversion happened.
    let tags = 0;
    view.state.doc.descendants((n) => {
      if (n.type.name === 'tag') tags++;
      return true;
    });
    expect(tags).toBe(1); // only the pre-existing card's tag
    view.destroy();
  });
});
