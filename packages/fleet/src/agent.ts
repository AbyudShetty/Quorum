// One simulated agent: sends direct notes to random peers at a steady rate and polls its inbox,
// recording what it sent and when everything it received arrived. It uses the same client library
// as the real adapters (identity check, token refresh), so a fleet run exercises that path too.
import { createIdFactory } from '@quorum/core';
import {
  ApiError,
  MemoryCredentialStore,
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
  /** Seed for peer choice, so a run can be repeated. */
  seed?: number;
  /**
   * Called once the agent is connected and before its clock starts. A fleet uses it as a start
   * barrier: containers start at different times, and without a common start the early agents
   * would finish (and stop listening) before the late ones begin, which looks like message loss.
   */
  barrier?: () => Promise<void>;
}

export interface AgentResult {
  address: string;
  sent: { id: string; to: string; at: number }[];
  received: { id: string; from: string; latencyMs: number }[];
  duplicates: number;
  errors: Record<string, number>;
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
      try {
        await client.send(config.workspace, envelope);
        result.sent.push({ id: envelope.id, to, at });
      } catch (error) {
        fail(error);
      }
      next += gap;
    }
  };

  const receiver = async () => {
    while (Date.now() < receiveUntil) {
      try {
        const page = await client.inbox(config.workspace, cursor, 100);
        const now = Date.now();
        for (const message of page.messages) {
          if (seen.has(message.id)) {
            result.duplicates += 1;
            continue;
          }
          seen.add(message.id);
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

  await Promise.all([sender(), receiver()]);
  return result;
};
