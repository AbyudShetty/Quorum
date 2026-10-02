import { describe, expect, it } from 'vitest';
import {
  appendNew,
  ChainConflictError,
  chainEvent,
  createIdFactory,
  MemoryEventStore,
  type NewEvent,
  parseJsonl,
  toJsonl,
  verifyChain,
} from '../src/index.js';

const WS = 'ws_01J9Z8X7W6V5T4S3R2Q1P0N9M8';
const OTHER = 'ws_01J9Z8X7W6V5T4S3R2Q1P0N9M9';
const ids = createIdFactory();

const input = (text: string): NewEvent => ({
  ev_id: ids.id('event'),
  ts: '2026-10-02T10:00:00Z',
  actor: 'human:abyud',
  kind: 'note.recorded',
  payload: { text },
});

describe('MemoryEventStore', () => {
  it('appends a valid chain and reads it back in order', async () => {
    const store = new MemoryEventStore();
    await appendNew(store, WS, [input('a'), input('b')]);
    await appendNew(store, WS, [input('c')]);
    const events = await store.read(WS);
    expect(events.map((e) => e.payload.text)).toEqual(['a', 'b', 'c']);
    expect(verifyChain(WS, events).ok).toBe(true);
    expect(await store.head(WS)).toEqual({ seq: 3, hash: events[2]?.hash });
  });

  it('keeps workspaces apart', async () => {
    const store = new MemoryEventStore();
    await appendNew(store, WS, [input('mine')]);
    expect(await store.read(OTHER)).toEqual([]);
    expect(await store.head(OTHER)).toBeUndefined();
  });

  it('pages with after and limit', async () => {
    const store = new MemoryEventStore();
    await appendNew(store, WS, ['1', '2', '3', '4'].map(input));
    const page = await store.read(WS, { after: 1, limit: 2 });
    expect(page.map((e) => e.seq)).toEqual([2, 3]);
  });

  it('rejects an append that does not continue the chain (concurrent writer)', async () => {
    const store = new MemoryEventStore();
    const [first] = await appendNew(store, WS, [input('a')]);
    // Another writer appended from the same head first.
    const stale = chainEvent(WS, undefined, input('stale'));
    await expect(store.append(WS, [stale])).rejects.toBeInstanceOf(ChainConflictError);
    expect((await store.read(WS)).map((e) => e.ev_id)).toEqual([first?.ev_id]);
  });

  it('writes nothing when any event in a batch is invalid', async () => {
    const store = new MemoryEventStore();
    const a = chainEvent(WS, undefined, input('a'));
    const bad = chainEvent(WS, { seq: 5, hash: a.hash }, input('gap'));
    await expect(store.append(WS, [a, bad])).rejects.toBeInstanceOf(ChainConflictError);
    expect(await store.read(WS)).toEqual([]);
  });

  it('rejects an event whose hash does not match its content', async () => {
    const store = new MemoryEventStore();
    const a = { ...chainEvent(WS, undefined, input('a')), payload: { text: 'changed' } };
    await expect(store.append(WS, [a])).rejects.toThrow(/does not match its content/);
  });

  it('cannot be altered through objects the caller still holds', async () => {
    const store = new MemoryEventStore();
    const [event] = await appendNew(store, WS, [input('original')]);
    if (event) event.payload.text = 'tampered';
    const [read] = await store.read(WS);
    if (read) read.payload.text = 'tampered too';
    expect((await store.read(WS))[0]?.payload.text).toBe('original');
  });
});

describe('JSONL export', () => {
  it('round-trips a chain that still verifies', async () => {
    const store = new MemoryEventStore();
    await appendNew(store, WS, ['a', 'b', 'c'].map(input));
    const text = toJsonl(await store.read(WS));
    expect(text.endsWith('\n')).toBe(true);
    expect(text.trim().split('\n')).toHaveLength(3);
    const { values, problem } = parseJsonl(text);
    expect(problem).toBeUndefined();
    expect(verifyChain(WS, values).ok).toBe(true);
  });

  it('accepts Windows line endings and blank lines', () => {
    expect(parseJsonl('{"a":1}\r\n\r\n{"b":2}\r\n').values).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('reports the first line that is not JSON and stops there', () => {
    const { values, problem } = parseJsonl('{"a":1}\n{broken\n{"c":3}\n');
    expect(values).toEqual([{ a: 1 }]);
    expect(problem).toEqual({ line: 2, message: 'line 2 is not valid JSON' });
  });
});
