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

/** The discovery entry if a server answers on its port with the same instance id. */
export const liveServer = async (dataDir: string): Promise<LocalDiscovery | undefined> => {
  const found = await readDiscovery(dataDir);
  if (!found) return undefined;
  try {
    const response = await fetch(`http://127.0.0.1:${String(found.port)}/v1/health`, {
      signal: AbortSignal.timeout(2000),
    });
    const body = (await response.json()) as { instance_id?: unknown };
    return body.instance_id === found.instance_id ? found : undefined;
  } catch {
    return undefined;
  }
};

export class ServerStartError extends Error {}

/** Make sure a local server is running, starting one if needed. */
export const ensureLocalServer = async (
  dataDir: string,
  options: { start: () => void | Promise<void>; timeoutMs?: number },
): Promise<void> => {
  if (await liveServer(dataDir)) return;
  await options.start();
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  while (Date.now() < deadline) {
    await delay(150);
    if (await liveServer(dataDir)) return;
  }
  throw new ServerStartError(
    'The local Quorum server did not start within 15 s. Run `quorum serve --local` in a terminal to see why.',
  );
};
