// @vitest-environment jsdom
/**
 * Image-vs-text clipboard precedence (field report 2026-07-15): Word
 * puts a rendered bitmap of the copied selection on the clipboard
 * ALONGSIDE text/html + text/plain, and handlePaste's image branch
 * ran first — so pasting cards from Word inserted a PICTURE of the
 * cards. Text flavors must win whenever they carry actual content;
 * the image branch is only for image-only clipboards (screenshots,
 * browser "Copy image" — whose text/html is at most a bare <img>).
 */
import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  buildPastePlugin,
  clipboardHasMeaningfulText,
  type PastePluginCtx,
} from '../../src/editor/paste-plugin.js';

// ---- clipboardHasMeaningfulText (the decision itself) ---------------

function fakeClipboard(flavors: Record<string, string>): DataTransfer {
  return {
    getData: (type: string) => flavors[type] ?? '',
  } as unknown as DataTransfer;
}

describe('clipboardHasMeaningfulText', () => {
  it('Word-style clipboard (bitmap + real text flavors) → true', () => {
    expect(
      clipboardHasMeaningfulText(
        fakeClipboard({
          'text/plain': 'Warming causes extinction\nSmith ’23',
          'text/html': '<p class=MsoNormal>Warming causes extinction</p>',
        }),
      ),
    ).toBe(true);
  });

  it('screenshot clipboard (no text flavors) → false', () => {
    expect(clipboardHasMeaningfulText(fakeClipboard({}))).toBe(false);
  });

  it('browser "Copy image" (empty plain, <img>-only html) → false', () => {
    expect(
      clipboardHasMeaningfulText(
        fakeClipboard({
          'text/html': '<meta charset="utf-8"><img src="https://example.com/x.png" alt="">',
        }),
      ),
    ).toBe(false);
  });

  it('whitespace-only text flavors → false (incl. &nbsp; entities)', () => {
    expect(clipboardHasMeaningfulText(fakeClipboard({ 'text/plain': '  \n\t ' }))).toBe(false);
    expect(
      clipboardHasMeaningfulText(
        fakeClipboard({ 'text/html': '<div>&nbsp; &#160;&#xA0;</div>' }),
      ),
    ).toBe(false);
  });

  it('html with real text but empty plain flavor → true', () => {
    expect(
      clipboardHasMeaningfulText(fakeClipboard({ 'text/html': '<p>actual content</p>' })),
    ).toBe(true);
  });
});

// ---- handlePaste wiring (the branch is actually gated) ---------------

const ctx: PastePluginCtx = {
  condenseOnPaste: () => false,
  paragraphIntegrity: () => false,
  usePilcrows: () => false,
  headingMode: () => 'respect',
  smartPasteConversion: () => false,
};

function makeView(): EditorView {
  const doc = schema.nodes['doc']!.create(null, [
    schema.nodes['card']!.createChecked(null, [
      schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('T')),
      schema.nodes['card_body']!.create(null, schema.text('body')),
    ]),
  ]);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const plugin = buildPastePlugin(ctx);
  return new EditorView(container, {
    state: EditorState.create({ doc, plugins: [plugin] }),
  });
}

/** Minimal paste event: enough surface for handlePaste. */
function fakePasteEvent(
  flavors: Record<string, string>,
  withImageFile: boolean,
): ClipboardEvent {
  const files = withImageFile ? [new File(['x'], 'clip.png', { type: 'image/png' })] : [];
  return {
    preventDefault: () => {},
    clipboardData: {
      files,
      getData: (type: string) => flavors[type] ?? '',
    },
  } as unknown as ClipboardEvent;
}

function callHandlePaste(view: EditorView, event: ClipboardEvent): boolean {
  const plugin = view.state.plugins.find((p) => p.props.handlePaste)!;
  const handler = plugin.props.handlePaste!;
  // Empty slice: the downstream card-fit / split paths all decline it,
  // so a `false` return means the paste fell through to PM's default —
  // i.e. the image branch did NOT consume it.
  const slice = view.state.doc.slice(0, 0);
  return handler.call(plugin, view, event, slice) === true;
}

describe('handlePaste image-vs-text precedence', () => {
  it('image-only clipboard still takes the image branch', () => {
    const view = makeView();
    expect(callHandlePaste(view, fakePasteEvent({}, true))).toBe(true);
    view.destroy();
  });

  it('image + meaningful text (the Word shape) does NOT take the image branch', () => {
    const view = makeView();
    const event = fakePasteEvent(
      {
        'text/plain': 'Warming causes extinction',
        'text/html': '<p class=MsoNormal>Warming causes extinction</p>',
      },
      true,
    );
    expect(callHandlePaste(view, event)).toBe(false);
    view.destroy();
  });

  it('image + <img>-wrapper html (browser Copy image) still takes the image branch', () => {
    const view = makeView();
    const event = fakePasteEvent(
      { 'text/html': '<img src="https://example.com/x.png">' },
      true,
    );
    expect(callHandlePaste(view, event)).toBe(true);
    view.destroy();
  });
});
