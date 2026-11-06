// Making sure the local server runs (ARCHITECTURE §8.2 auto-start).
//
// A command that finds no live server asks `start` to launch one, then waits for its discovery
// file. Two commands starting at once is safe: the server itself takes the start lock, so the
// second one exits and both clients find the first. The identity handshake still runs afterwards
// in QuorumClient.connect, so a squatter answering /v1/health gains nothing (INV-24).
// This file starts no process itself (INV-10): `start` comes from @quorum/server.
import { setTimeout as delay } from 'node:timers/promises';
import { readDiscovery } from '@quorum/local';
import type { LocalDiscovery } from '@quorum/schemas';

// Respect Retry-After across background scans. A busy server must not trigger replacement
// processes or consume the next window's entire unauthenticated request quota.
const throttled = new Map<string, { until: number; error: ServerStartError }>();

/** The discovery entry if a server answers on its port with the same instance id. */
const probeServer = async (dataDir: string): Promise<LocalDiscovery | undefined> => {
  const busy = throttled.get(dataDir);
  if (busy && busy.until > Date.now()) throw busy.error;
  throttled.delete(dataDir);
  const found = await readDiscovery(dataDir);
  if (!found) return undefined;
  try {
    const response = await fetch(`http://127.0.0.1:${String(found.port)}/v1/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after'));
      const retry = Number.isFinite(seconds) && seconds > 0 ? Math.min(60, Math.ceil(seconds)) : 60;
      await response.body?.cancel();
      const error = new ServerStartError(
        `The local Quorum server is answering but rate-limited (HTTP 429). Retry after ${String(retry)} s. Close stale agent sessions if this persists; no replacement server was started.`,
      );
      if (throttled.size >= 128) {
        const oldest = throttled.keys().next().value;
        if (oldest !== undefined) throttled.delete(oldest);
      }
      throttled.set(dataDir, { until: Date.now() + retry * 1000, error });
      throw error;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const body = (await response.json()) as { instance_id?: unknown };
    return body.instance_id === found.instance_id ? found : undefined;
  } catch (error) {
    if (error instanceof ServerStartError) throw error;
    return undefined;
  }
};

export class ServerStartError extends Error {}

/** Readiness is only a hint; clients still verify the pinned identity before credentials. */
export const liveServer = (dataDir: string): Promise<LocalDiscovery | undefined> =>
  probeServer(dataDir).catch((error: unknown) => {
    if (error instanceof ServerStartError) return undefined;
    throw error;
  });

const starting = new Map<string, Promise<void>>();

/** Make sure a local server is running, starting one if needed. */
export const ensureLocalServer = (
  dataDir: string,
  options: { start: () => void | Promise<void>; timeoutMs?: number },
): Promise<void> => {
  const pending = starting.get(dataDir);
  if (pending) return pending;
  const work = ensureStarted(dataDir, options).finally(() => {
    if (starting.get(dataDir) === work) starting.delete(dataDir);
  });
  starting.set(dataDir, work);
  return work;
};

const ensureStarted = async (
  dataDir: string,
  options: { start: () => void | Promise<void>; timeoutMs?: number },
): Promise<void> => {
  if (await probeServer(dataDir)) return;
  await options.start();
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  while (Date.now() < deadline) {
    await delay(150);
    if (await probeServer(dataDir)) return;
  }
  throw new ServerStartError(
    'The local Quorum server did not start within 15 s. Run `quorum serve --local` in a terminal to see why.',
  );
};
