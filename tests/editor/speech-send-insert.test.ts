// @vitest-environment jsdom
/**
 * insertSpeechSlice placement matrix — a sent card must land as a clean
 * top-level sibling in the receiving doc, NEVER splitting a host card.
 * Every card split forces ProseMirror to synthesize the schema-required
 * leading `tag`, which the user sees as blank tag lines ("2-3 blank F7
 * lines after the card" — field report, 2026-07-11: a leftover RANGE
 * selection in the speech doc raw-inserted the slice mid-text).
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import { takeSendSlice, insertSpeechSlice } from '../../src/editor/speech-doc-send.js';

function card(tagText: string, bodyText: string): PMNode {
  return schema.nodes['card']!.create(null, [
    schema.nodes['tag']!.create(null, tagText ? schema.text(tagText) : undefined),
    schema.nodes['card_body']!.create(null, bodyText ? schema.text(bodyText) : undefined),
  ]);
}
function para(text = ''): PMNode {
  return schema.nodes['paragraph']!.create(null, text ? schema.text(text) : undefined);
}
function mkView(doc: PMNode): EditorView {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return new EditorView(host, { state: EditorState.create({ doc, schema }) });
}
function countEmptyTags(doc: PMNode): number {
  let n = 0;
  doc.descendants((node) => {
    if (node.type.name === 'tag' && node.content.size === 0) n++;
    return true;
  });
  return n;
}
function cardCount(doc: PMNode): number {
  let n = 0;
  doc.forEach((c) => {
    if (c.type.name === 'card') n++;
  });
  return n;
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

/** The tilde slice: caret inside a single card's body → whole-card slice. */
function takeSingleCardSlice(): ReturnType<typeof takeSendSlice> {
  const src = mkView(
    schema.nodes['doc']!.create(null, [card('MY TAG', 'card body words'), para('after')]),
  );
  let bodyPos = -1;
  src.state.doc.descendants((n, p) => {
    if (n.type.name === 'card_body' && bodyPos < 0) bodyPos = p + 2;
    return true;
  });
  src.dispatch(src.state.tr.setSelection(TextSelection.create(src.state.doc, bodyPos)));
  const slice = takeSendSlice(src);
  src.destroy();
  return slice;
}

describe('insertSpeechSlice placement', () => {
  it('a whole-card slice is closed (node boundaries)', () => {
    const slice = takeSingleCardSlice()!;
    expect(slice.openStart).toBe(0);
    expect(slice.openEnd).toBe(0);
  });

  it('never synthesizes empty tags, across target shapes', async () => {
    const slice = takeSingleCardSlice()!;
    const targets: Array<[string, () => EditorView, boolean]> = [
      ['empty doc, atEnd', () => mkView(schema.nodes['doc']!.create(null, [para()])), true],
      [
        'caret on a blank line (fill)',
        () => {
          const v = mkView(schema.nodes['doc']!.create(null, [card('EXIST', 'stuff'), para()]));
          v.dispatch(
            v.state.tr.setSelection(TextSelection.create(v.state.doc, v.state.doc.content.size - 1)),
          );
          return v;
        },
        false,
      ],
      [
        'caret inside an existing card (snaps to boundary)',
        () => {
          const v = mkView(
            schema.nodes['doc']!.create(null, [card('EXIST', 'stuff here'), para('tail')]),
          );
          let bp = -1;
          v.state.doc.descendants((n, p) => {
            if (n.type.name === 'card_body' && bp < 0) bp = p + 3;
            return true;
          });
          v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, bp)));
          return v;
        },
        false,
      ],
      ['atEnd with non-empty last child', () => mkView(schema.nodes['doc']!.create(null, [para('existing')])), true],
      [
        'RANGE selection inside an existing card (the field bug)',
        () => {
          const v = mkView(
            schema.nodes['doc']!.create(null, [card('EXIST', 'stuff here'), para('tail')]),
          );
          let bp = -1;
          v.state.doc.descendants((n, p) => {
            if (n.type.name === 'card_body' && bp < 0) bp = p + 2;
            return true;
          });
          v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, bp, bp + 4)));
          return v;
        },
        false,
      ],
    ];
    for (const [name, mk, atEnd] of targets) {
      const v = mk();
      const cardsBefore = cardCount(v.state.doc);
      insertSpeechSlice(v, slice, atEnd);
      await settle();
      expect(countEmptyTags(v.state.doc), `${name}: empty tags`).toBe(0);
      // Exactly ONE card added — the sent one; a split would add fragments.
      expect(cardCount(v.state.doc), `${name}: card count`).toBe(cardsBefore + 1);
      v.destroy();
    }
  });

  it('a failing insert alerts instead of silently losing the card', async () => {
    // The insert runs in a 0 ms defer, unreachable by any caller try/catch —
    // and on a cross-window send the sender is told "delivered" before the
    // receiving window inserts. A throw here used to be a silently lost card
    // (fail-safe hardening, 2026-07-12).
    const slice = takeSingleCardSlice();
    expect(slice).not.toBeNull();
    const dest = mkView(schema.nodes['doc']!.create(null, [para()]));
    (dest as unknown as { dispatch: () => void }).dispatch = () => {
      throw new Error('boom mid-insert');
    };
    insertSpeechSlice(dest, slice!, true);
    await settle();
    const dialogs = [...document.querySelectorAll('.pmd-route-dialog')];
    expect(dialogs.some((el) => el.textContent?.includes("Couldn't insert the card"))).toBe(true);
    expect(dialogs.some((el) => el.textContent?.includes('boom mid-insert'))).toBe(true);
    // Dismiss via the alert's OK so its document-level listeners unregister.
    document.querySelector<HTMLButtonElement>('.pmd-text-prompt-ok')?.click();
    document.querySelectorAll('.pmd-route-overlay').forEach((o) => o.remove());
    dest.destroy();
  });

  it('a destroyed destination view is a silent no-op, not a crash or an alert', async () => {
    const slice = takeSingleCardSlice();
    const dest = mkView(schema.nodes['doc']!.create(null, [para()]));
    insertSpeechSlice(dest, slice!, true);
    dest.destroy(); // closed within the 0 ms defer window
    await settle();
    expect(document.querySelector('.pmd-route-dialog')).toBeNull();
  });
});
