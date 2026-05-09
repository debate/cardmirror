/**
 * Read-mode decoration plugin.
 *
 * Tags each text node with one of two CSS classes:
 *   - `pmd-rm-keep`  — read-aloud content; visible in read mode
 *   - `pmd-rm-hide`  — non-read-aloud filler; hidden in read mode
 *
 * The decision is made per text node based on its parent paragraph and
 * its marks:
 *   - In `cite_paragraph`: keep iff carrying `cite_mark`.
 *   - In `card_body` / `paragraph` / `undertag`: keep iff carrying `highlight`.
 *   - Elsewhere (heading paragraphs etc.): no decoration — block-level
 *     CSS handles whether they show.
 *
 * The decorations are emitted unconditionally; CSS in style.css
 * activates the hide/show behavior only when the editor's root carries
 * `.pmd-read-mode`.
 *
 * Why the plugin instead of pure CSS: marks nest in the rendered DOM
 * (a highlight inside an underline ends up inside the underline's
 * span). Targeting "non-read-aloud text" via CSS specificity races
 * against the nested wrapper structure; tagging text nodes directly
 * with a per-node class avoids that entirely.
 */

import { Plugin } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';

export const readModePlugin: Plugin<DecorationSet> = new Plugin<DecorationSet>({
  state: {
    init(_, { doc }) {
      return computeDecorations(doc);
    },
    apply(tr, prev) {
      if (!tr.docChanged) return prev;
      return computeDecorations(tr.doc);
    },
  },
  props: {
    decorations(state) {
      return readModePlugin.getState(state);
    },
  },
});

function computeDecorations(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;

    const $pos = doc.resolve(pos);
    const parent = $pos.parent.type.name;

    let keep: boolean;
    if (parent === 'cite_paragraph') {
      keep = node.marks.some((m) => m.type.name === 'cite_mark');
    } else if (parent === 'card_body' || parent === 'paragraph' || parent === 'undertag') {
      keep = node.marks.some((m) => m.type.name === 'highlight');
    } else {
      return;
    }

    decos.push(
      Decoration.inline(pos, pos + node.nodeSize, {
        class: keep ? 'pmd-rm-keep' : 'pmd-rm-hide',
      }),
    );
  });
  return DecorationSet.create(doc, decos);
}
