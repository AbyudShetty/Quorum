// One simulated agent: sends direct notes to random peers at a steady rate and polls its inbox,
// recording what it sent and when everything it received arrived. It uses the same client library
// as the real adapters (identity check, token refresh), so a fleet run exercises that path too.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdFactory } from '@quorum/core';
import {
  ApiError,
  MemoryCredentialStore,
  Outbox,
  QuorumClient,
  type Target,
  UnreachableError,
} from '@quorum/adapter-mcp';
import type { SubmittedEnvelope } from '@quorum/schemas';

export interface AgentConfig {
  target: Target;
  workspace: string;
  address: string;
  accessToken: string;
  refreshToken: string;
  /** Addresses this agent may message (never itself). */
  peers: string[];
  /** Messages per second sent by this agent. */
  ratePerSecond: number;
  /** How long it keeps sending. */
  durationMs: number;
  /** How long it keeps receiving after it stops sending, so late messages are counted. */
  drainMs?: number;
  pollIntervalMs?: number;
  /** How often queued messages are retried. Default 100 ms. */
  flushIntervalMs?: number;
  /** Seed for peer choice, so a run can be repeated. */
  seed?: number;
  /**
   * Called once the agent is connected and before its clock starts. A fleet uses it as a start
   * barrier: containers start at different times, and without a common start the early agents
   * would finish (and stop listening) before the late ones begin, which looks like message loss.
   */
  barrier?: () => Promise<void>;
  /**
   * Shared by the agents of one in-process run: once every agent has stopped sending and every
   * queued message has arrived, draining ends early. `drainMs` stays the upper bound, so a slow
   * machine gets time instead of a false "lost", and a fast one does not wait for nothing.
   */
  progress?: FleetProgress;
}

export interface FleetProgress {
  agents: number;
  sendersDone: number;
  queued: number;
  received: number;
}

/** True when an in-process fleet has delivered everything it queued. */
const settled = (p: FleetProgress | undefined): boolean =>
  p !== undefined && p.sendersDone === p.agents && p.received >= p.queued;

export interface AgentResult {
  address: string;
  sent: { id: string; to: string; at: number }[];
  received: { id: string; from: string; latencyMs: number }[];
  duplicates: number;
  errors: Record<string, number>;
  /** Still in the outbox when the run ended (never delivered). */
  unsent?: number;
}

/** Small deterministic PRNG (mulberry32): the harness must be repeatable. */
export const prng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const runAgent = async (config: AgentConfig): Promise<AgentResult> => {
  const store = new MemoryCredentialStore();
  await store.save('fleet', {
    access_token: config.accessToken,
    refresh_token: config.refreshToken,
    access_expires_at: Date.now() + 55 * 60_000,
  });
  const client = await QuorumClient.connect({
    target: config.target,
    credentialKey: 'fleet',
    store,
  });

  const result: AgentResult = {
    address: config.address,
    sent: [],
    received: [],
    duplicates: 0,
    errors: {},
  };
  const fail = (error: unknown) => {
    const key =
      error instanceof ApiError
        ? error.code
        : error instanceof UnreachableError
          ? 'unreachable'
          : 'unexpected';
    result.errors[key] = (result.errors[key] ?? 0) + 1;
  };

  await config.barrier?.();
  const outbox = new Outbox(await mkdtemp(join(tmpdir(), 'quorum-fleet-')), 'fleet');

  const ids = createIdFactory();
  const random = prng(config.seed ?? 1);
  const seen = new Set<string>();
  const pollMs = config.pollIntervalMs ?? 100;
  const sendUntil = Date.now() + config.durationMs;
  const receiveUntil = sendUntil + (config.drainMs ?? 2000);
  let cursor = 0;

  const sender = async () => {
    const gap = 1000 / config.ratePerSecond;
    // Spread agents out so a fleet does not send in lockstep.
    let next = Date.now() + random() * gap;
    while (config.peers.length > 0 && next < sendUntil) {
      await sleep(Math.max(0, next - Date.now()));
      const to = config.peers[Math.floor(random() * config.peers.length)] ?? config.peers[0] ?? '';
      const at = Date.now();
      const envelope = {
        spec: 'quorum/1',
        id: ids.id('message'),
        workspace: config.workspace,
        from: config.address,
        to: [to],
        type: 'note',
        type_version: 1,
        created_at: new Date(at).toISOString(),
        body: { text: 'fleet', sent_at: at, n: result.sent.length },
      } as unknown as SubmittedEnvelope;
      // Like a real adapter: write to the outbox first. Delivery is the flusher's job, so a server
      // outage delays messages instead of losing them (INV-20). "Sent" here means "queued".
      try {
        await outbox.enqueue({ workspace: config.workspace, envelope });
        result.sent.push({ id: envelope.id, to, at });
        if (config.progress) config.progress.queued += 1;
      } catch (error) {
        fail(error);
      }
      next += gap;
    }
  };

  const flusher = async () => {
    while (Date.now() < receiveUntil && !settled(config.progress)) {
      try {
        if ((await outbox.size()) > 0) {
          const flushed = await outbox.flush((ws, e) => client.send(ws, e));
          for (const refused of flushed.rejected) {
            result.errors[refused.code] = (result.errors[refused.code] ?? 0) + 1;
          }
        }
      } catch (error) {
        fail(error);
      }
      await sleep(config.flushIntervalMs ?? 100);
    }
  };

  const receiver = async () => {
    while (Date.now() < receiveUntil && !settled(config.progress)) {
      try {
        const page = await client.inbox(config.workspace, { after: cursor, limit: 100 });
        const now = Date.now();
        for (const message of page.messages) {
          if (seen.has(message.id)) {
            result.duplicates += 1;
            continue;
          }
          seen.add(message.id);
          if (config.progress) config.progress.received += 1;
          const sentAt = (message.body as { sent_at?: unknown }).sent_at;
          result.received.push({
            id: message.id,
            from: message.from,
            latencyMs: typeof sentAt === 'number' ? now - sentAt : Number.NaN,
          });
        }
        if (page.messages.length > 0) {
          cursor = page.next_after;
          await client.ack(config.workspace, cursor);
        }
        if (page.has_more) continue;
      } catch (error) {
        fail(error);
      }
      await sleep(pollMs);
    }
  };

  await Promise.all([
    sender().finally(() => {
      if (config.progress) config.progress.sendersDone += 1;
    }),
    flusher(),
    receiver(),
  ]);
  result.unsent = await outbox.size();
  return result;
};
