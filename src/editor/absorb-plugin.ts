/**
 * Card-body absorption plugin.
 *
 * Enforces the editing-semantics rule (ARCHITECTURE.md §14.3): a
 * `paragraph` (or `cite_paragraph`) at doc level whose previous
 * sibling is a `card` or `analytic_unit` is auto-absorbed into that
 * container. To bound a region of loose paragraphs after a card,
 * the user inserts a heading (Pocket / Hat / Block) — anything
 * non-absorbable breaks the absorption zone.
 *
 * Absorption type mapping:
 *   - paragraph → card_body
 *   - cite_paragraph → cite_paragraph (valid as a child of both
 *     `card` and `analytic_unit`).
 *   - undertag → undertag (valid in both containers; the bare-doc-level
 *     case shows up after F7 on text that's followed by undertag
 *     annotations, or after promote-then-demote round-trips). Undertags
 *     do NOT terminate the absorption zone.
 *   - card_body → card_body (rare at doc level, but valid in both
 *     containers and harmless to absorb in place).
 *
 * Cases preserved (no absorption):
 *   - Block / Hat / Pocket → paragraph → tag        (legitimate bridge text)
 *   - Doc start → paragraph → anything              (top-of-doc preface)
 *   - Heading → paragraph → heading                  (between sections)
 *
 * Why an appendTransaction plugin and not a schema constraint:
 * ProseMirror content expressions are context-free, so they can't say
 * "paragraph is illegal here only when the previous sibling is a card."
 * Absorption runs after every doc-changing transaction; it walks the
 * doc-level children once and rebuilds any cards / analytic_units that
 * need to grow.
 */

import { Plugin } from 'prosemirror-state';
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { schema } from '../schema/index.js';

const ABSORBING_TYPES = new Set(['card', 'analytic_unit']);

export const absorbPlugin: Plugin = new Plugin({
  appendTransaction(transactions, _oldState, newState) {
    if (!transactions.some((t) => t.docChanged)) return null;

    const rebuilt = absorbedDocChildren(newState.doc);
    if (!rebuilt) return null;

    return newState.tr.replaceWith(0, newState.doc.content.size, rebuilt);
  },
});

/**
 * Walk the doc's top-level children and produce a new Fragment with
 * loose paragraphs / cite_paragraphs absorbed into preceding card /
 * analytic_unit siblings. Returns `null` if no changes were necessary,
 * so callers can skip dispatching a no-op transaction.
 */
export function absorbedDocChildren(doc: PMNode): Fragment | null {
  const out: PMNode[] = [];
  let absorbing: PMNode | null = null;
  let absorbed: PMNode[] = [];
  let modified = false;

  function flush(): void {
    if (absorbing === null) return;
    if (absorbed.length === 0) {
      out.push(absorbing);
    } else {
      const merged = absorbing.copy(
        absorbing.content.append(Fragment.fromArray(absorbed)),
      );
      out.push(merged);
      modified = true;
    }
    absorbing = null;
    absorbed = [];
  }

  doc.forEach((child) => {
    const t = child.type.name;
    if (ABSORBING_TYPES.has(t)) {
      flush();
      absorbing = child;
      return;
    }
    if (absorbing === null) {
      out.push(child);
      return;
    }
    if (t === 'paragraph') {
      absorbed.push(schema.nodes['card_body']!.create(null, child.content));
      return;
    }
    if (t === 'cite_paragraph' || t === 'undertag' || t === 'card_body') {
      // All three are valid in both card and analytic_unit content
      // expressions, so absorb regardless of container type. The bare
      // undertag case shows up after F7 on text followed by an undertag
      // annotation — without this, the undertag would orphan and the
      // absorption zone would terminate prematurely.
      absorbed.push(child);
      return;
    }
    // Anything else breaks the absorption zone.
    flush();
    out.push(child);
  });
  flush();

  if (!modified) return null;
  return Fragment.fromArray(out);
}
