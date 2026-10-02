// The EventStore port (ARCHITECTURE §4). The server implements it on SQLite (Phase 1) and
// later Postgres; the same contract tests run against every implementation.
import {
  type ChainHead,
  chainEvent,
  type EventRecord,
  genesisHash,
  hashEvent,
  type NewEvent,
} from './hash-chain.js';

/** Thrown when an append does not continue the current chain (a concurrent writer won). */
export class ChainConflictError extends Error {
  constructor(
    readonly workspace: string,
    readonly expected: ChainHead | undefined,
    readonly attempted: { seq: number; prev_hash: string },
  ) {
    super(
      `append to ${workspace} expected seq ${String((expected?.seq ?? 0) + 1)} after ${expected?.hash ?? 'genesis'}, got seq ${String(attempted.seq)}`,
    );
    this.name = 'ChainConflictError';
  }
}

export interface EventStore {
  /** The last event of a workspace, or undefined if it has none. */
  head(workspace: string): Promise<ChainHead | undefined>;
  /**
   * Append events atomically. They must continue the chain exactly (seq and prev_hash),
   * otherwise nothing is written and ChainConflictError is thrown. Events are never updated
   * or deleted.
   */
  append(workspace: string, events: readonly EventRecord[]): Promise<void>;
  /** Events with seq > after, oldest first, at most `limit`. */
  read(workspace: string, options?: { after?: number; limit?: number }): Promise<EventRecord[]>;
}

/** Chain new events onto the current head and append them (one atomic write). */
export const appendNew = async (
  store: EventStore,
  workspace: string,
  inputs: readonly NewEvent[],
): Promise<EventRecord[]> => {
  let head = await store.head(workspace);
  const events: EventRecord[] = [];
  for (const input of inputs) {
    const event = chainEvent(workspace, head, input);
    events.push(event);
    head = { seq: event.seq, hash: event.hash };
  }
  await store.append(workspace, events);
  return events;
};

/** In-memory EventStore for tests and fakes. Same append rules as the real stores. */
export class MemoryEventStore implements EventStore {
  readonly #logs = new Map<string, EventRecord[]>();

  head(workspace: string): Promise<ChainHead | undefined> {
    const last = this.#logs.get(workspace)?.at(-1);
    return Promise.resolve(last ? { seq: last.seq, hash: last.hash } : undefined);
  }

  async append(workspace: string, events: readonly EventRecord[]): Promise<void> {
    const log = this.#logs.get(workspace) ?? [];
    let head = await this.head(workspace);
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
      head = { seq: event.seq, hash: event.hash };
    }
    // Copies, so later changes to the caller's objects cannot alter history.
    this.#logs.set(workspace, [...log, ...events.map((e) => structuredClone(e))]);
  }

  read(
    workspace: string,
    options: { after?: number; limit?: number } = {},
  ): Promise<EventRecord[]> {
    const after = options.after ?? 0;
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const events = (this.#logs.get(workspace) ?? []).filter((e) => e.seq > after).slice(0, limit);
    return Promise.resolve(events.map((e) => structuredClone(e)));
  }
}
