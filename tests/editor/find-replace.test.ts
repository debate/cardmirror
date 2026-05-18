/**
 * Find / Replace plugin — matching + navigate + replace behavior.
 * UI / floating bar is tested via real-use; the plugin's match
 * scanning and replacement semantics are covered here.
 */

import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { schema } from '../../src/schema/index.js';
import {
  findReplaceKey,
  findReplacePlugin,
  runReplace,
  runReplaceAll,
} from '../../src/editor/find-replace-plugin.js';

function paragraph(text: string) {
  return text
    ? schema.nodes['paragraph']!.create(null, schema.text(text))
    : schema.nodes['paragraph']!.create(null, []);
}

function makeDoc(children: import('prosemirror-model').Node[]) {
  return schema.nodes['doc']!.createChecked(null, children);
}

function freshState(text: string): EditorState {
  return EditorState.create({
    doc: makeDoc([paragraph(text)]),
    schema,
    plugins: [findReplacePlugin()],
  });
}

function setQuery(
  state: EditorState,
  query: string,
  opts: { caseSensitive?: boolean; wholeWord?: boolean } = {},
): EditorState {
  return state.apply(
    state.tr.setMeta(findReplaceKey, {
      type: 'setQuery',
      query,
      caseSensitive: !!opts.caseSensitive,
      wholeWord: !!opts.wholeWord,
    }),
  );
}

describe('find-replace plugin', () => {
  it('finds every occurrence of a substring', () => {
    const state = setQuery(freshState('hello world hello again hello'), 'hello');
    const s = findReplaceKey.getState(state)!;
    expect(s.matches.length).toBe(3);
    expect(s.currentIndex).toBe(0);
  });

  it('case-insensitive by default', () => {
    const state = setQuery(freshState('Hello WORLD hElLo'), 'hello');
    const s = findReplaceKey.getState(state)!;
    expect(s.matches.length).toBe(2);
  });

  it('case-sensitive when toggled', () => {
    const state = setQuery(freshState('Hello WORLD hElLo'), 'hello', {
      caseSensitive: true,
    });
    const s = findReplaceKey.getState(state)!;
    expect(s.matches.length).toBe(0);
  });

  it('whole-word excludes substring hits', () => {
    const state = setQuery(freshState('the cat catalog scatter'), 'cat', {
      wholeWord: true,
    });
    const s = findReplaceKey.getState(state)!;
    expect(s.matches.length).toBe(1);
  });

  it('navigate wraps around the ends', () => {
    let state = setQuery(freshState('a a a'), 'a');
    expect(findReplaceKey.getState(state)!.currentIndex).toBe(0);
    state = state.apply(
      state.tr.setMeta(findReplaceKey, { type: 'navigate', dir: 1 }),
    );
    expect(findReplaceKey.getState(state)!.currentIndex).toBe(1);
    state = state.apply(
      state.tr.setMeta(findReplaceKey, { type: 'navigate', dir: 1 }),
    );
    state = state.apply(
      state.tr.setMeta(findReplaceKey, { type: 'navigate', dir: 1 }),
    );
    // Three forward hops from index 0 in a list of 3 → wraps back to 0.
    expect(findReplaceKey.getState(state)!.currentIndex).toBe(0);
    state = state.apply(
      state.tr.setMeta(findReplaceKey, { type: 'navigate', dir: -1 }),
    );
    expect(findReplaceKey.getState(state)!.currentIndex).toBe(2);
  });

  it('replace swaps the current match and rescans', () => {
    let state = setQuery(freshState('foo bar foo bar'), 'foo');
    expect(findReplaceKey.getState(state)!.matches.length).toBe(2);
    const cmd = runReplace('XYZ');
    let next: EditorState | null = null;
    cmd(state, (tr) => { next = state.apply(tr); });
    expect(next).not.toBeNull();
    state = next!;
    expect(state.doc.textContent).toBe('XYZ bar foo bar');
    const s = findReplaceKey.getState(state)!;
    // One match left (the second 'foo'); active index advanced to it.
    expect(s.matches.length).toBe(1);
    expect(s.currentIndex).toBe(0);
  });

  it('replace all swaps every match in a single transaction', () => {
    let state = setQuery(freshState('foo bar foo bar foo'), 'foo');
    const cmd = runReplaceAll('Q');
    let next: EditorState | null = null;
    cmd(state, (tr) => { next = state.apply(tr); });
    expect(next).not.toBeNull();
    state = next!;
    expect(state.doc.textContent).toBe('Q bar Q bar Q');
    const s = findReplaceKey.getState(state)!;
    expect(s.matches.length).toBe(0);
    expect(s.currentIndex).toBe(-1);
  });

  it('clear resets the state', () => {
    let state = setQuery(freshState('a a a'), 'a');
    expect(findReplaceKey.getState(state)!.matches.length).toBe(3);
    state = state.apply(
      state.tr.setMeta(findReplaceKey, { type: 'clear' }),
    );
    const s = findReplaceKey.getState(state)!;
    expect(s.query).toBe('');
    expect(s.matches.length).toBe(0);
    expect(s.currentIndex).toBe(-1);
  });

  it('rescans automatically when the doc changes', () => {
    let state = setQuery(freshState('foo bar foo'), 'foo');
    expect(findReplaceKey.getState(state)!.matches.length).toBe(2);
    // Append " foo" at the end of the paragraph by inserting text.
    const insertAt = state.doc.content.size - 1;
    state = state.apply(state.tr.insertText(' foo', insertAt));
    expect(findReplaceKey.getState(state)!.matches.length).toBe(3);
  });

  it('matches across separate textblocks (one per paragraph)', () => {
    const doc = makeDoc([
      paragraph('hello world'),
      paragraph('again hello'),
      paragraph('no match here'),
    ]);
    const state = EditorState.create({
      doc,
      schema,
      plugins: [findReplacePlugin()],
    });
    const next = setQuery(state, 'hello');
    expect(findReplaceKey.getState(next)!.matches.length).toBe(2);
  });
});
