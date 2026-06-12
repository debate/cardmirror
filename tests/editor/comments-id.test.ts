/**
 * Comment-id allocation: ids must stay within Word's 32-bit `w:id` range
 * and never collide with ids already present in a loaded document.
 */
import { describe, it, expect } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { schema } from '../../src/schema/index.js';
import { loadThreads, newCommentId, type Thread } from '../../src/editor/comments-plugin.js';

const INT32_MAX = 2_147_483_647;

function threadWithId(id: string): Thread {
  return {
    id,
    comments: [
      { id, author: 'A', initials: 'A', date: '', text: '', kind: 'human', parentId: null },
    ],
  };
}

describe('comment id allocation', () => {
  it('allocates int32-safe ids and seeds past loaded ids', () => {
    const doc = schema.nodes['doc']!.create(null, schema.nodes['paragraph']!.create());
    const state = EditorState.create({ doc });

    // Freshly allocated ids are small integers (the old Date.now() seed
    // was ~1.7e12, well past Word's signed-32-bit w:id).
    expect(Number(newCommentId())).toBeLessThan(INT32_MAX);

    // Loading threads advances the counter past every loaded id, so the
    // next new comment can't collide with an imported one.
    loadThreads(state, [threadWithId('9000')]);
    expect(Number(newCommentId())).toBeGreaterThan(9000);
  });
});
