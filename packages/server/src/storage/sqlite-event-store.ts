// The EventStore port on SQLite (ARCHITECTURE §4). Same rules as MemoryEventStore: appends
// must continue the chain exactly, and nothing is ever updated or deleted.
import {
  ChainConflictError,
  type ChainHead,
  type EventRecord,
  type EventStore,
  genesisHash,
  hashEvent,
} from '@quorum/core';
import type { Db } from './database.js';

interface Row {
  workspace: string;
  seq: number;
  ev_id: string;
  ts: string;
  actor: string;
  kind: string;
  payload: string;
  prev_hash: string;
  hash: string;
}

const toEvent = (row: Row): EventRecord => ({
  ev_id: row.ev_id,
  workspace: row.workspace,
  seq: row.seq,
  ts: row.ts,
  actor: row.actor,
  kind: row.kind,
  payload: JSON.parse(row.payload) as Record<string, unknown>,
  prev_hash: row.prev_hash,
  hash: row.hash,
});

export class SqliteEventStore implements EventStore {
  readonly #head;
  readonly #insert;
  readonly #read;
  readonly #appendAll;

  constructor(db: Db) {
    this.#head = db.prepare<[string], { seq: number; hash: string }>(
      'SELECT seq, hash FROM events WHERE workspace = ? ORDER BY seq DESC LIMIT 1',
    );
    this.#insert = db.prepare(
      'INSERT INTO events (workspace, seq, ev_id, ts, actor, kind, payload, prev_hash, hash) VALUES (@workspace, @seq, @ev_id, @ts, @actor, @kind, @payload, @prev_hash, @hash)',
    );
    this.#read = db.prepare<[string, number, number], Row>(
      'SELECT * FROM events WHERE workspace = ? AND seq > ? ORDER BY seq LIMIT ?',
    );
    // One transaction per append: the chain check and the inserts see the same head.
    this.#appendAll = db.transaction((workspace: string, events: readonly EventRecord[]) => {
      let head: ChainHead | undefined = this.#head.get(workspace);
      for (const event of events) {
        const continues =
          event.workspace === workspace &&
          event.seq === (head?.seq ?? 0) + 1 &&
          event.prev_hash === (head?.hash ?? genesisHash(workspace));
        if (!continues) throw new ChainConflictError(workspace, head, event);
        if (hashEvent(event) !== event.hash) {
          throw new Error(
            `event ${String(event.seq)} carries a hash that does not match its content`,
          );
        }
        this.#insert.run({ ...event, payload: JSON.stringify(event.payload) });
        head = { seq: event.seq, hash: event.hash };
      }
    });
  }

  head(workspace: string): Promise<ChainHead | undefined> {
    return Promise.resolve(this.#head.get(workspace));
  }

  append(workspace: string, events: readonly EventRecord[]): Promise<void> {
    // IMMEDIATE takes the write lock up front, so two writers cannot both read the same head.
    // Failures become a rejected promise, like every other EventStore.
    try {
      this.#appendAll.immediate(workspace, events);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  read(
    workspace: string,
    options: { after?: number; limit?: number } = {},
  ): Promise<EventRecord[]> {
    // In SQLite, LIMIT -1 means no limit.
    const rows = this.#read.all(workspace, options.after ?? 0, options.limit ?? -1);
    return Promise.resolve(rows.map(toEvent));
  }
}
