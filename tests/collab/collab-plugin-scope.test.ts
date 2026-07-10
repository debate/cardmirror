/**
 * Multi-pane fusion guard (regression for the released-build bug where opening a
 * second document while a co-editing session was live bound the new pane to the
 * session's shared LoroDoc and overwrote it — doc B "became" doc A).
 *
 * The fix scopes a session's binding plugins to its ONE owning `DocRecord.uid`
 * via `collabPluginsFor(targetUid)`, which `buildEditorPlugins` consults. This
 * pins down that gate: the owning uid gets the plugins; every other pane (and a
 * null/omitted uid) gets none.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Plugin } from 'prosemirror-state';
import {
  setCollabPluginSource,
  collabPluginsFor,
  type CollabPluginSource,
} from '../../src/editor/collab/collab-hooks.js';

const marker = new Plugin({});

function fakeSource(ownerUid: string | null): CollabPluginSource {
  return {
    ownerUid,
    plugins: () => [marker],
    ownsUndo: () => true,
    undo: () => false,
    redo: () => false,
  };
}

afterEach(() => setCollabPluginSource(null));

describe('collab plugin scoping (multi-pane fusion guard)', () => {
  it('binds the session ONLY to its owning doc uid; a second pane stays independent', () => {
    setCollabPluginSource(fakeSource('doc-A'));
    expect(collabPluginsFor('doc-A')).toEqual([marker]); // owner: gets the binding
    expect(collabPluginsFor('doc-B')).toEqual([]); // other pane: no binding → no fusion
  });

  it('never binds for a null/undefined uid (transient editors, unknown target)', () => {
    setCollabPluginSource(fakeSource('doc-A'));
    expect(collabPluginsFor(null)).toEqual([]);
    expect(collabPluginsFor(undefined)).toEqual([]);
  });

  it('binds nothing when no session is active', () => {
    setCollabPluginSource(null);
    expect(collabPluginsFor('doc-A')).toEqual([]);
  });

  it('re-targets when a new session owns a different doc', () => {
    setCollabPluginSource(fakeSource('doc-A'));
    expect(collabPluginsFor('doc-A')).toEqual([marker]);
    setCollabPluginSource(fakeSource('doc-B'));
    expect(collabPluginsFor('doc-A')).toEqual([]); // former owner no longer bound
    expect(collabPluginsFor('doc-B')).toEqual([marker]);
  });
});
