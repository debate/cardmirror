/**
 * Learn store — scopes, dedupe, grading, forget (archive/delete), rekey.
 */

import { describe, expect, it, vi } from 'vitest';
import { LearnStore, type CardDef } from '../../src/editor/learn-store.js';

const TODAY = '2026-05-27';
const NOW = '2026-05-27T12:00:00.000Z';
const card = (id: string): CardDef => ({ id, type: 'qa', front: `Q${id}`, back: `A${id}` });
const desc = (q: string) => ({ quote: q, prefix: '', suffix: '', approxPos: 0 });

function store() {
  return new LearnStore();
}

describe('cards + scopes', () => {
  it('upsert creates a due-today schedule; counts per scope', () => {
    const s = store();
    s.upsertCard(card('c1'), TODAY);
    s.setAnchor('c1', 'docA', desc('x'));
    expect(s.getSchedule('c1')?.state).toBe('new');
    expect(s.dueCount({ kind: 'all' }, TODAY)).toBe(1);
    expect(s.dueCount({ kind: 'file', docId: 'docA' }, TODAY)).toBe(1);
    expect(s.dueCount({ kind: 'file', docId: 'docB' }, TODAY)).toBe(0);
    expect(s.totalCount({ kind: 'file', docId: 'docA' })).toBe(1);
  });

  it('dedupes a card present in two files', () => {
    const s = store();
    s.upsertCard(card('c1'), TODAY);
    s.setAnchor('c1', 'docA', desc('x'));
    s.setAnchor('c1', 'docB', desc('x')); // same card, copied to another file
    expect(s.dueCount({ kind: 'all' }, TODAY)).toBe(1);
    expect(s.queue({ kind: 'all' }, TODAY)).toEqual(['c1']);
  });
});

describe('grading', () => {
  it('remembered advances + logs (no retry); forgot wants retry', () => {
    const s = store();
    s.upsertCard(card('c1'), TODAY);
    expect(s.grade('c1', 'remembered', TODAY, NOW)).toBe(false);
    expect(s.getSchedule('c1')?.state).toBe('review');
    expect(s.grade('c1', 'forgot', TODAY, NOW)).toBe(true);
    expect(s.getSchedule('c1')?.state).toBe('learning');
  });
});

describe('forgetDoc', () => {
  it('archive suspends the file’s cards', () => {
    const s = store();
    s.upsertCard(card('c1'), TODAY);
    s.setAnchor('c1', 'docA', desc('x'));
    s.forgetDoc('docA', 'archive');
    expect(s.getSchedule('c1')?.state).toBe('suspended');
    expect(s.dueCount({ kind: 'file', docId: 'docA' }, TODAY)).toBe(0);
    expect(s.getCard('c1')).toBeDefined(); // archived, not deleted
  });

  it('delete prunes cards anchored only in that file, keeps shared ones', () => {
    const s = store();
    s.upsertCard(card('only'), TODAY);
    s.setAnchor('only', 'docA', desc('x'));
    s.upsertCard(card('shared'), TODAY);
    s.setAnchor('shared', 'docA', desc('y'));
    s.setAnchor('shared', 'docB', desc('y'));
    s.forgetDoc('docA', 'delete');
    expect(s.getCard('only')).toBeUndefined(); // pruned
    expect(s.getCard('shared')).toBeDefined(); // still anchored in docB
    expect(s.anchorsForDoc('docA')).toEqual([]);
  });
});

describe('manage GUI: list / suspend / delete', () => {
  it('listCards + listAnchors expose content + grounding', () => {
    const s = store();
    s.upsertCard(card('c1'), TODAY);
    s.setAnchor('c1', 'docA', desc('x'));
    s.setAnchor('c1', 'docB', desc('x'));
    expect(s.listCards().map((c) => c.id)).toEqual(['c1']);
    expect(s.listAnchors().map((a) => a.docId).sort()).toEqual(['docA', 'docB']);
  });

  it('setSuspended toggles a single card without losing it', () => {
    const s = store();
    s.upsertCard(card('c1'), TODAY);
    s.setSuspended('c1', true);
    expect(s.getSchedule('c1')?.state).toBe('suspended');
    expect(s.dueCount({ kind: 'all' }, TODAY)).toBe(0);
    s.setSuspended('c1', false); // never reviewed → back to 'new'
    expect(s.getSchedule('c1')?.state).toBe('new');
    expect(s.dueCount({ kind: 'all' }, TODAY)).toBe(1);
  });

  it('deleteCard removes content, schedule, anchors, deck membership', () => {
    const s = store();
    s.upsertCard(card('c1'), TODAY);
    s.setAnchor('c1', 'docA', desc('x'));
    s.createDeck('D', 'd1', NOW);
    s.setDeckMembership('d1', 'c1', true);
    s.deleteCard('c1');
    expect(s.getCard('c1')).toBeUndefined();
    expect(s.getSchedule('c1')).toBeUndefined();
    expect(s.anchorsForDoc('docA')).toEqual([]);
    expect(s.queue({ kind: 'deck', deckId: 'd1' }, TODAY)).toEqual([]);
  });
});

describe('decks', () => {
  it('membership defines a deck scope', () => {
    const s = store();
    s.upsertCard(card('c1'), TODAY);
    s.upsertCard(card('c2'), TODAY);
    s.createDeck('Generics', 'd1', NOW);
    s.setDeckMembership('d1', 'c1', true);
    expect(s.queue({ kind: 'deck', deckId: 'd1' }, TODAY)).toEqual(['c1']);
    expect(s.dueCount({ kind: 'deck', deckId: 'd1' }, TODAY)).toBe(1);
  });
});

describe('copyDocAnnotations (Save As fork)', () => {
  it('copies anchors to the new docId; original retained; shared schedule', () => {
    const s = store();
    s.upsertCard(card('c1'), TODAY);
    s.setAnchor('c1', 'docA', desc('x'));
    s.copyDocAnnotations('docA', 'docB');
    expect(s.anchorsForDoc('docA').map((a) => a.cardId)).toEqual(['c1']); // original kept
    expect(s.anchorsForDoc('docB').map((a) => a.cardId)).toEqual(['c1']); // copy made
    // Same logical card → one schedule → reviewed once across both files.
    expect(s.dueCount({ kind: 'all' }, TODAY)).toBe(1);
  });

  it('copies AI threads with fresh threadIds', () => {
    const s = store();
    s.addAiThread({
      threadId: 't1',
      docId: 'docA',
      comments: [{ author: 'AI', text: 'hi', at: NOW, ai: true }],
      anchor: desc('x'),
      createdAt: NOW,
    });
    s.copyDocAnnotations('docA', 'docB');
    const copied = s.aiThreadsForDoc('docB');
    expect(copied).toHaveLength(1);
    expect(copied[0]!.threadId).not.toBe('t1'); // fresh id
    expect(copied[0]!.comments[0]!.text).toBe('hi');
  });
});

describe('rekeyDoc', () => {
  it('moves annotations from a session id to the real docId', () => {
    const s = store();
    s.upsertCard(card('c1'), TODAY);
    s.setAnchor('c1', 'session-uid', desc('x'));
    s.rekeyDoc('session-uid', 'realDoc');
    expect(s.dueCount({ kind: 'file', docId: 'realDoc' }, TODAY)).toBe(1);
    expect(s.anchorsForDoc('session-uid')).toEqual([]);
  });
});

describe('persistence + pub/sub', () => {
  it('persists on change and round-trips JSON', () => {
    const persist = vi.fn();
    const s = new LearnStore(persist);
    s.upsertCard(card('c1'), TODAY);
    s.setAnchor('c1', 'docA', desc('x'));
    expect(persist).toHaveBeenCalled();
    const json = s.toJson();
    const s2 = new LearnStore();
    s2.loadJson(json);
    expect(s2.getCard('c1')).toEqual(card('c1'));
    expect(s2.dueCount({ kind: 'file', docId: 'docA' }, TODAY)).toBe(1);
  });

  it('notifies subscribers', () => {
    const s = store();
    const fn = vi.fn();
    s.subscribe(fn);
    s.upsertCard(card('c1'), TODAY);
    expect(fn).toHaveBeenCalled();
  });
});

describe('AI threads (local annotation layer)', () => {
  const thread = (threadId: string, docId: string) => ({
    threadId,
    docId,
    comments: [],
    anchor: desc('q'),
    createdAt: NOW,
  });

  it('adds, scopes by doc, appends turns, and removes', () => {
    const s = store();
    s.addAiThread(thread('t1', 'docA'));
    s.addAiThread(thread('t2', 'docB'));
    expect(s.aiThreadsForDoc('docA').map((t) => t.threadId)).toEqual(['t1']);
    expect(s.getAiThread('t1')?.docId).toBe('docA');

    s.appendAiComment('t1', { author: 'Me', text: 'why?', at: NOW, ai: false });
    s.appendAiComment('t1', { author: 'Clod (AI)', text: 'because', at: NOW, ai: true });
    expect(s.getAiThread('t1')?.comments.map((c) => [c.text, c.ai ?? false])).toEqual([
      ['why?', false],
      ['because', true],
    ]);

    s.removeAiThread('t1');
    expect(s.getAiThread('t1')).toBeUndefined();
    expect(s.aiThreadsForDoc('docA')).toEqual([]);
  });

  it('round-trips AI threads through JSON', () => {
    const s = store();
    s.addAiThread(thread('t1', 'docA'));
    s.appendAiComment('t1', { author: 'Me', text: 'q', at: NOW });
    s.setAiThreadAnchor('t1', null); // unanchored
    const s2 = new LearnStore();
    s2.loadJson(s.toJson());
    const t = s2.getAiThread('t1');
    expect(t?.anchor).toBeNull();
    expect(t?.comments[0]?.text).toBe('q');
  });
});

describe('export / import cards', () => {
  it('exports content + schedule + anchors', () => {
    const s = store();
    s.upsertCard(card('c1'), TODAY);
    s.setAnchor('c1', 'docA', desc('hello'));
    const out = s.exportCards();
    expect(out).toHaveLength(1);
    expect(out[0]!.front).toBe('Qc1');
    expect(out[0]!.schedule?.state).toBe('new');
    expect(out[0]!.anchors).toEqual([{ docId: 'docA', anchor: desc('hello') }]);
  });

  it('importCards ADDs with fresh ids (never overwrites; re-import duplicates)', () => {
    const s = store();
    s.upsertCard(card('c1'), TODAY);
    const exported = s.exportCards();
    expect(s.importCards(exported, TODAY)).toBe(1);
    expect(s.listCards()).toHaveLength(2);
    s.importCards(exported, TODAY);
    expect(s.listCards()).toHaveLength(3);
    expect(new Set(s.listCards().map((c) => c.id)).size).toBe(3);
  });

  it('carries the schedule, or starts fresh when null', () => {
    const s = store();
    s.importCards(
      [
        {
          type: 'qa', front: 'Q', back: 'A', anchors: [],
          schedule: { state: 'review', dueOn: '2030-01-01', intervalDays: 10, reps: 3, lapses: 1, lastReviewed: '2026-01-01T00:00:00.000Z' },
        },
        { type: 'qa', front: 'Q2', back: 'A2', schedule: null, anchors: [] },
      ],
      TODAY,
    );
    const withSched = s.listCards().find((c) => c.front === 'Q')!;
    const fresh = s.listCards().find((c) => c.front === 'Q2')!;
    expect(s.getSchedule(withSched.id)?.state).toBe('review');
    expect(s.getSchedule(withSched.id)?.dueOn).toBe('2030-01-01');
    expect(s.getSchedule(withSched.id)?.cardId).toBe(withSched.id); // reassigned to the fresh id
    expect(s.getSchedule(fresh.id)?.state).toBe('new');
    expect(s.getSchedule(fresh.id)?.dueOn).toBe(TODAY);
  });

  it('grounds imported anchors to their doc', () => {
    const s = store();
    s.importCards(
      [{ type: 'qa', front: 'Q', back: 'A', schedule: null, anchors: [{ docId: 'docX', anchor: desc('z') }] }],
      TODAY,
    );
    const id = s.listCards()[0]!.id;
    expect(s.anchorsForDoc('docX').map((a) => a.cardId)).toEqual([id]);
  });
});
