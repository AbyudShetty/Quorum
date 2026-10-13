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
  now?: () => Date;
}

export interface Federation extends FederationPort {
  /** Send everything that is due now. */
  drain(): Promise<void>;
  close(): void;
}

type Outcome = 'delivered' | 'refused' | 'unreachable';

/** 5 s, 10 s, 20 s … at most 10 minutes between attempts. */
const backoffMs = (attempts: number): number => Math.min(5_000 * 2 ** attempts, 600_000);

export const startFederation = (options: FederationOptions): Federation => {
  const send = createQuorumFetch(options.fetch ?? fetch, { identity: options.identity });
  const now = options.now ?? (() => new Date());
  const relayHost = new URL(options.relay).host;
  const inFlight = new Set<string>();
  let closed = false;

  const deliver = async (row: OutboxRow): Promise<Outcome> => {
    if (inFlight.has(row.id)) return 'unreachable';
    inFlight.add(row.id);
    try {
      let status: number;
      try {
        const response = await send(
          `quorum://${relayHost}/${row.remote_home}/v1/federation/${row.kind}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: row.payload,
            signal: AbortSignal.timeout(20_000),
          },
        );
        status = response.status;
        await response.body?.cancel();
      } catch {
        status = 0;
      }
      if (status >= 200 && status < 300) {
        options.registry.outboxDelivered(row.id);
        return 'delivered';
      }
      if (status === 404 || status === 400) {
        // No such ID there (or blocked), or a request that will never be valid: give up.
        options.registry.outboxDelivered(row.id);
        options.onRefused?.(row);
        return 'refused';
      }
      options.registry.outboxRetry(
        row.id,
        new Date(now().getTime() + backoffMs(row.attempts)).toISOString(),
      );
      return 'unreachable';
    } finally {
      inFlight.delete(row.id);
    }
  };

  // One drain at a time; a call while one runs makes it look again before it stops.
  let running = false;
  let again = false;
  /** Read through a call: `drain` calls during the awaits set it, which narrowing cannot see. */
  const lookAgain = () => again;
  const drain = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        for (;;) {
          if (closed) return;
          const due = options.registry
            .dueOutbox(now().toISOString())
            .filter((r) => !inFlight.has(r.id));
          if (due.length === 0) break;
          // In order, so a link's answer never overtakes its request. Items that could not be
          // delivered are due again later, so this ends when nothing is due now.
          for (const row of due) await deliver(row);
        }
      } while (lookAgain());
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void drain();
  }, options.intervalMs ?? 15_000);
  timer.unref();

  return {
    lookup: (id) => lookupQuorumId(options.relay, id, options.fetch ?? fetch),
    flush: async (outboxId) => {
      const row = options.registry.outboxItem(outboxId);
      return row ? deliver(row) : 'delivered';
    },
    queued: () => {
      setImmediate(() => {
        void drain();
      });
    },
    drain,
    close: () => {
      closed = true;
      clearInterval(timer);
    },
  };
};
