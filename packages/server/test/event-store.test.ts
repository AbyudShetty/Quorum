// The same EventStore rules must hold for every implementation (ARCHITECTURE §4): this suite
// runs against the in-memory store and the SQLite store.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendNew,
  ChainConflictError,
  chainEvent,
  createIdFactory,
  type EventStore,
  MemoryEventStore,
  type NewEvent,
  verifyChain,
} from '@quorum/core';
import { afterAll, describe, expect, it } from 'vitest';
import { type Db, openDatabase, SCHEMA_VERSION, SqliteEventStore } from '../src/index.js';

const WS = 'ws_01J9Z8X7W6V5T4S3R2Q1P0N9M8';
const OTHER = 'ws_01J9Z8X7W6V5T4S3R2Q1P0N9M9';
const ids = createIdFactory();
const input = (text: string): NewEvent => ({
  ev_id: ids.id('event'),
  ts: '2026-10-02T10:00:00Z',
  actor: 'human:abyud',
  kind: 'note.recorded',
  payload: { text, nested: { list: [1, 2.5, 'x'], flag: true, none: null } },
});

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-store-'));
  dirs.push(dir);
  return dir;
};
// Windows cannot delete open database files, so every test database is closed first.
const dbs: Db[] = [];
const open = (file: string): Db => {
  const db = openDatabase(file);
  dbs.push(db);
  return db;
};
afterAll(() => {
  for (const db of dbs) if (db.open) db.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const implementations: [string, () => EventStore][] = [
  ['MemoryEventStore', () => new MemoryEventStore()],
  ['SqliteEventStore', () => new SqliteEventStore(open(join(tempDir(), 'quorum.db')))],
];

describe.each(implementations)('%s (EventStore contract)', (_name, make) => {
  it('appends a chain, reads it back in order, and it verifies', async () => {
    const store = make();
    await appendNew(store, WS, [input('a'), input('b')]);
    await appendNew(store, WS, [input('c')]);
    const events = await store.read(WS);
    expect(events.map((e) => e.payload.text)).toEqual(['a', 'b', 'c']);
    expect(verifyChain(WS, events).ok).toBe(true);
    expect(await store.head(WS)).toEqual({ seq: 3, hash: events[2]?.hash });
  });

  it('round-trips payloads exactly, so hashes still match', async () => {
    const store = make();
    const [written] = await appendNew(store, WS, [input('exact')]);
    const [read] = await store.read(WS);
    expect(read).toEqual(written);
  });

  it('keeps workspaces apart', async () => {
    const store = make();
    await appendNew(store, WS, [input('mine')]);
    expect(await store.read(OTHER)).toEqual([]);
    expect(await store.head(OTHER)).toBeUndefined();
  });

  it('pages with after and limit', async () => {
    const store = make();
    await appendNew(store, WS, ['1', '2', '3', '4'].map(input));
    expect((await store.read(WS, { after: 1, limit: 2 })).map((e) => e.seq)).toEqual([2, 3]);
    expect((await store.read(WS, { after: 3 })).map((e) => e.seq)).toEqual([4]);
  });

  it('rejects an append that does not continue the chain', async () => {
    const store = make();
    await appendNew(store, WS, [input('a')]);
    await expect(
      store.append(WS, [chainEvent(WS, undefined, input('stale'))]),
    ).rejects.toBeInstanceOf(ChainConflictError);
    expect(await store.read(WS)).toHaveLength(1);
  });

  it('writes nothing when any event in a batch is invalid', async () => {
    const store = make();
    const a = chainEvent(WS, undefined, input('a'));
    const gap = chainEvent(WS, { seq: 5, hash: a.hash }, input('gap'));
    await expect(store.append(WS, [a, gap])).rejects.toBeInstanceOf(ChainConflictError);
    expect(await store.read(WS)).toEqual([]);
  });

  it('rejects an event whose hash does not match its content', async () => {
    const store = make();
    const forged = { ...chainEvent(WS, undefined, input('a')), payload: { text: 'changed' } };
    await expect(store.append(WS, [forged])).rejects.toThrow(/does not match its content/);
  });
});

describe('SqliteEventStore specifics', () => {
  it('survives closing and reopening the database', async () => {
    const file = join(tempDir(), 'quorum.db');
    const first = open(file);
    await appendNew(new SqliteEventStore(first), WS, [input('persisted')]);
    first.close();
    const reopened = new SqliteEventStore(open(file));
    const events = await reopened.read(WS);
    expect(events.map((e) => e.payload.text)).toEqual(['persisted']);
    expect(verifyChain(WS, events).ok).toBe(true);
  });

  it('refuses to edit or delete history at the database level (INV-8)', async () => {
    const db = open(join(tempDir(), 'quorum.db'));
    await appendNew(new SqliteEventStore(db), WS, [input('a')]);
    expect(() => db.prepare("UPDATE events SET actor = 'human:mallory'").run()).toThrow(
      /append-only/,
    );
    expect(() => db.prepare('DELETE FROM events').run()).toThrow(/append-only/);
  });

  it('records its schema version and refuses a newer database', () => {
    const file = join(tempDir(), 'quorum.db');
    const db = open(file);
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    db.pragma(`user_version = ${String(SCHEMA_VERSION + 1)}`);
    db.close();
    expect(() => openDatabase(file)).toThrow(/newer than this Quorum supports/);
  });

  it('uses WAL with full sync, so committed events survive a crash', () => {
    const db = open(join(tempDir(), 'quorum.db'));
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('synchronous', { simple: true })).toBe(2); // FULL
  });

  it('serialises two writers on the same file: the second sees the first and continues', async () => {
    const file = join(tempDir(), 'quorum.db');
    const a = new SqliteEventStore(open(file));
    const b = new SqliteEventStore(open(file));
    await appendNew(a, WS, [input('from a')]);
    await appendNew(b, WS, [input('from b')]);
    const stale = chainEvent(
      WS,
      { seq: 1, hash: (await a.read(WS))[0]?.hash ?? '' },
      input('stale'),
    );
    await expect(a.append(WS, [stale])).rejects.toBeInstanceOf(ChainConflictError);
    expect(verifyChain(WS, await a.read(WS))).toMatchObject({ ok: true, count: 2 });
  });
});
