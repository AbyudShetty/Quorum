import { describe, expect, it } from 'vitest';
import {
  chainEvent,
  createIdFactory,
  type EventRecord,
  genesisHash,
  hashEvent,
  type NewEvent,
  verifyChain,
  type VerifyResult,
} from '../src/index.js';

const WS = 'ws_01J9Z8X7W6V5T4S3R2Q1P0N9M8';

/** Element i, or a clear failure if the test setup is wrong. */
const at = <T>(items: T[], index: number): T => {
  const item = items[index];
  if (item === undefined) throw new Error(`no element ${String(index)}`);
  return item;
};
const ids = createIdFactory({ now: () => 1_759_400_000_000 });

const input = (n: number): NewEvent => ({
  ev_id: ids.id('event'),
  ts: '2026-10-02T10:00:00Z',
  actor: 'agent:claude-api@laptop-a',
  kind: 'message.accepted',
  payload: { n, text: `event ${String(n)}` },
});

/** A valid chain of `count` events. */
const buildChain = (count: number, workspace = WS): EventRecord[] => {
  const events: EventRecord[] = [];
  for (let n = 1; n <= count; n++) {
    const last = events.at(-1);
    events.push(chainEvent(workspace, last && { seq: last.seq, hash: last.hash }, input(n)));
  }
  return events;
};

const problemOf = (result: VerifyResult) =>
  result.ok ? undefined : { kind: result.problem.kind, seq: result.problem.seq };

describe('chainEvent', () => {
  it('links the first event to the workspace genesis hash', () => {
    const [first] = buildChain(1);
    expect(first?.seq).toBe(1);
    expect(first?.prev_hash).toBe(genesisHash(WS));
  });

  it('links each event to the previous hash and hashes its own content', () => {
    const [a, b] = buildChain(2);
    expect(b?.prev_hash).toBe(a?.hash);
    expect(b && hashEvent(b)).toBe(b?.hash);
  });

  it('gives different workspaces different genesis hashes', () => {
    expect(genesisHash(WS)).not.toBe(genesisHash('ws_01J9Z8X7W6V5T4S3R2Q1P0N9M9'));
  });
});

describe('verifyChain (INV-8)', () => {
  it('accepts an intact chain and reports its head', () => {
    const events = buildChain(5);
    const result = verifyChain(WS, events);
    expect(result).toEqual({ ok: true, head: { seq: 5, hash: events[4]?.hash }, count: 5 });
  });

  it('accepts an empty log', () => {
    expect(verifyChain(WS, [])).toEqual({ ok: true, head: undefined, count: 0 });
  });

  it('detects a modified event', () => {
    const events = buildChain(5);
    events[2] = { ...at(events, 2), payload: { n: 3, text: 'edited afterwards' } };
    expect(problemOf(verifyChain(WS, events))).toEqual({ kind: 'hash_mismatch', seq: 3 });
  });

  it('detects a modified event whose hash was recomputed to hide it', () => {
    const events = buildChain(5);
    const edited = { ...at(events, 2), payload: { n: 3, text: 'edited' } };
    events[2] = { ...edited, hash: hashEvent(edited) };
    expect(problemOf(verifyChain(WS, events))).toEqual({ kind: 'prev_hash_mismatch', seq: 4 });
  });

  it('detects a deleted event', () => {
    const events = buildChain(5);
    events.splice(1, 1);
    expect(problemOf(verifyChain(WS, events))).toEqual({ kind: 'seq_mismatch', seq: 3 });
  });

  it('detects an inserted event', () => {
    const events = buildChain(3);
    events.splice(1, 0, chainEvent(WS, { seq: 1, hash: at(events, 0).hash }, input(99)));
    expect(problemOf(verifyChain(WS, events))).toEqual({ kind: 'seq_mismatch', seq: 2 });
  });

  it('detects reordered events', () => {
    const events = buildChain(4);
    [events[1], events[2]] = [at(events, 2), at(events, 1)];
    expect(problemOf(verifyChain(WS, events))).toEqual({ kind: 'seq_mismatch', seq: 3 });
  });

  it('detects events from another workspace', () => {
    const other = buildChain(1, 'ws_01J9Z8X7W6V5T4S3R2Q1P0N9M9');
    expect(problemOf(verifyChain(WS, other))).toEqual({ kind: 'workspace_mismatch', seq: 1 });
  });

  it('detects malformed events', () => {
    expect(problemOf(verifyChain(WS, [{ seq: 1 }]))).toEqual({ kind: 'invalid_event', seq: 1 });
  });

  it('detects a duplicated event id', () => {
    const a = at(buildChain(1), 0);
    const dup = chainEvent(WS, { seq: 1, hash: a.hash }, { ...input(2), ev_id: a.ev_id });
    expect(problemOf(verifyChain(WS, [a, dup]))).toEqual({ kind: 'duplicate_event_id', seq: 2 });
  });

  it('reports how far the log was verified before the problem', () => {
    const events = buildChain(5);
    events[3] = { ...at(events, 3), actor: 'human:mallory' };
    const result = verifyChain(WS, events);
    expect(result.ok ? undefined : result.verifiedUpTo).toBe(3);
  });

  describe('with client checkpoints', () => {
    it('detects a consistent rewrite of the whole log', () => {
      const original = buildChain(5);
      const checkpoint = { seq: 3, hash: at(original, 2).hash };
      // An operator rewrites history from scratch: every hash is valid again.
      const rewritten = buildChain(5);
      expect(verifyChain(WS, rewritten).ok).toBe(true);
      expect(problemOf(verifyChain(WS, rewritten, [checkpoint]))).toEqual({
        kind: 'checkpoint_mismatch',
        seq: 3,
      });
    });

    it('detects a truncated log', () => {
      const original = buildChain(5);
      const checkpoint = { seq: 5, hash: at(original, 4).hash };
      expect(problemOf(verifyChain(WS, original.slice(0, 3), [checkpoint]))).toEqual({
        kind: 'checkpoint_missing',
        seq: 5,
      });
    });

    it('accepts the log when it matches every checkpoint', () => {
      const events = buildChain(5);
      const checkpoints = [1, 4].map((seq) => ({ seq, hash: at(events, seq - 1).hash }));
      expect(verifyChain(WS, events, checkpoints).ok).toBe(true);
    });
  });
});
