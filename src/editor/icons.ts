/**
 * Icon helper. Returns a `<span class="pmd-icon pmd-icon-NAME">` that
 * the generated `icons.css` paints — Untitled UI line icons in
 * `currentColor` under `:root[data-icons="modern"]` (default), or the
 * original emoji glyph under `:root[data-icons="classic"]`. The set is
 * switched at runtime by the `iconSet` setting (see `applyIconSet` in
 * index.ts); no element needs rebuilding.
 *
 * `IconName` must stay in sync with the MAP in `scripts/gen-icons.mjs`.
 */

export type IconName =
  | 'open'
  | 'new'
  | 'save'
  | 'autosave'
  | 'paragraph-integrity'
  | 'mic'
  | 'speech-mark'
  | 'send-cursor'
  | 'send-end'
  | 'search'
  | 'tag'
  | 'manage'
  | 'add'
  | 'highlight'
  | 'shading'
  | 'image'
  | 'settings'
  | 'home'
  | 'close'
  | 'plus'
  | 'reset'
  | 'arrow-up'
  | 'arrow-down'
  | 'chevron-up'
  | 'chevron-down'
  | 'chevron-left'
  | 'chevron-right'
  | 'expand'
  | 'minus'
  | 'read-mode'
  | 'nav-toggle'
  | 'comments'
  | 'shortcuts'
  | 'timer'
  | 'link';

/** Create an icon span. Decorative by default (`aria-hidden`); pass a
 *  `label` for standalone icon buttons whose accessible name should be
 *  the icon itself. */
export function icon(name: IconName, opts: { label?: string } = {}): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = `pmd-icon pmd-icon-${name}`;
  if (opts.label) span.setAttribute('aria-label', opts.label);
  else span.setAttribute('aria-hidden', 'true');
  return span;
}

/** Replace an element's contents with an icon (clears text glyphs). */
export function setIcon(el: HTMLElement, name: IconName, opts?: { label?: string }): void {
  el.replaceChildren(icon(name, opts));
}
