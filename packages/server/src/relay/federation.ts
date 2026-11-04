// Reaching other laptops' Quorum servers (DECISIONS D-20, PAIRING.md §3). Link requests, answers,
// unlinks and messages for another server wait in the federation outbox (SQLite) and are sent
// through the relay to `quorum://<relay>/<their key fingerprint>/v1/federation/<kind>`: TLS to
// their pinned key (INV-33), presenting this server's own key as the client certificate so they
// know which laptop is calling. Delivered items leave the outbox; "no such ID" drops them; a
// laptop that is off is retried with backoff until it is back (INV-20).
import { createQuorumFetch, type TlsIdentity } from '@quorum/local';
import type { FederationPort } from '../service/quorum.js';
import type { OutboxRow, Registry } from '../storage/registry.js';
import { lookupQuorumId } from './phonebook.js';

export interface FederationOptions {
  /** The relay, wss://host (ws:// only on loopback). */
  relay: string;
  identity: TlsIdentity;
  registry: Registry;
  /** A queued link request was refused there ("no such ID"): the service forgets it. */
  onRefused?: (row: OutboxRow) => void;
  /** How often due items are retried. Default 15 s. */
  intervalMs?: number;
  /** Base fetch for the phone book lookups (tests). */
  fetch?: typeof fetch;
  /** Server-to-server transport seam for tests. Defaults to TLS with pinned server keys. */
  transport?: typeof fetch;
  now?: () => Date;
}

export interface Federation extends FederationPort {
  /** Send everything that is due now. */
  drain(): Promise<void>;
  /** Abort and settle active sends before the database is closed. Queued items stay durable. */
  close(): Promise<void>;
}

type Outcome = 'delivered' | 'refused' | 'unreachable';

/** 5 s, 10 s, 20 s … at most 10 minutes between attempts. */
const backoffMs = (attempts: number): number => Math.min(5_000 * 2 ** attempts, 600_000);

export const startFederation = (options: FederationOptions): Federation => {
  const send =
    options.transport ?? createQuorumFetch(options.fetch ?? fetch, { identity: options.identity });
  const now = options.now ?? (() => new Date());
  const relayHost = new URL(options.relay).host;
  const inFlight = new Map<string, Promise<Outcome>>();
  const stopping = new AbortController();
  let closed = false;
  // Shutdown can run during a transport await; read through a call to avoid stale narrowing.
  const isClosed = () => closed;

  const deliver = (id: string): Promise<Outcome> => {
    if (closed) return Promise.resolve('unreachable');
    const active = inFlight.get(id);
    if (active) return active;
    // Re-read rather than use a drain's stale snapshot: a concurrent flush may have removed it.
    const row = options.registry.outboxItem(id);
    if (!row) return Promise.resolve('delivered');
    if (
      row.next_at > now().toISOString() ||
      options.registry.outboxHead(row.remote_home)?.id !== row.id
    ) {
      return Promise.resolve('unreachable');
    }
    // Put the promise in the map before starting any I/O, so flush and drain share one attempt.
    const attempt = Promise.resolve().then(async (): Promise<Outcome> => {
      if (isClosed()) return 'unreachable';
      let status: number;
      try {
        const response = await send(
          `quorum://${relayHost}/${row.remote_home}/v1/federation/${row.kind}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: row.payload,
            signal: AbortSignal.any([stopping.signal, AbortSignal.timeout(20_000)]),
          },
        );
        status = response.status;
        await response.body?.cancel();
      } catch {
        status = 0;
      }
      // A send can finish while shutdown is awaiting it. Keep its durable row for replay rather
      // than touching a database that the caller may be about to close (INV-20).
      if (isClosed()) return 'unreachable';
      if (status >= 200 && status < 300) {
        options.registry.outboxDelivered(row.id);
        return 'delivered';
      }
      if (status === 404 || status === 400) {
        // No such ID there (or blocked), or a request that will never be valid: give up.
        // If updating the service fails, leave the row available for a later, idempotent retry.
        options.onRefused?.(row);
        options.registry.outboxDelivered(row.id);
        return 'refused';
      }
      options.registry.outboxRetry(
        row.id,
        new Date(now().getTime() + backoffMs(row.attempts)).toISOString(),
      );
      return 'unreachable';
    });
    const tracked = attempt.finally(() => {
      inFlight.delete(row.id);
    });
    inFlight.set(row.id, tracked);
    return tracked;
  };

  // Concurrent callers await the same drain. Destinations may progress in parallel, while every
  // individual destination remains ordered. Bound each batch to eight connections.
  let running: Promise<void> | undefined;
  const drain = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (running) return running;
    const work = async () => {
      for (;;) {
        if (closed) return;
        const due = options.registry.dueOutbox(now().toISOString(), 8);
        if (due.length === 0) break;
        // Include in-flight heads: deliver joins their promises rather than skipping to a later
        // item. New rows queued during these awaits are found on the next iteration.
        await Promise.all(due.map((row) => deliver(row.id)));
      }
    };
    running = work().finally(() => {
      running = undefined;
    });
    return running;
  };

  const backgroundDrain = () => {
    // A storage/service error leaves the item queued. Background callbacks must not reject out
    // of the event loop and crash the server; the next timer retries it.
    void drain().catch(() => undefined);
  };

  const timer = setInterval(backgroundDrain, options.intervalMs ?? 15_000);
  timer.unref();

  return {
    lookup: (id) => lookupQuorumId(options.relay, id, options.fetch ?? fetch),
    flush: deliver,
    queued: () => {
      if (!closed) setImmediate(backgroundDrain);
    },
    drain,
    close: async () => {
      closed = true;
      clearInterval(timer);
      stopping.abort();
      await Promise.allSettled([...(running ? [running] : []), ...inFlight.values()]);
    },
  };
};
