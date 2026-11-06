import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer, type RequestListener, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeDiscovery } from '@quorum/local';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureLocalServer, liveServer } from '../src/local-server.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const published = async (handler: RequestListener) => {
  const dir = await mkdtemp(join(tmpdir(), 'quorum-start-probe-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected loopback port');
  await mkdir(join(dir, 'local'));
  await writeDiscovery(dir, {
    instance_id: '01M440Q95R4B0GGBXMS7RXKTQ6',
    pid: process.pid,
    port: address.port,
    public_key: 'gSiB27VYaHIyRb695lsHSnRwo3vliwhSGbVm6dNAN-s',
    version: 'test',
    started_at: new Date().toISOString(),
  });
  return dir;
};

describe('local readiness under rate limiting', () => {
  it('does not spawn or poll repeatedly when a running server returns 429', async () => {
    let probes = 0;
    const dir = await published((_req, res) => {
      probes++;
      res.writeHead(429, { 'retry-after': '17' }).end('{}');
    });
    const start = vi.fn();
    await expect(ensureLocalServer(dir, { start })).rejects.toThrow('Retry after 17 s');
    expect(start).not.toHaveBeenCalled();
    expect(probes).toBe(1);
    expect(await liveServer(dir)).toBeUndefined();
    for (let i = 0; i < 20; i++) {
      await expect(ensureLocalServer(dir, { start })).rejects.toThrow('HTTP 429');
    }
    expect(probes).toBe(1);
  });

  it('shares simultaneous startup checks, and allows a later check to recover', async () => {
    let busy = true;
    let probes = 0;
    const dir = await published((_req, res) => {
      probes++;
      if (busy) res.writeHead(429).end('{}');
      else res.end(JSON.stringify({ instance_id: '01M440Q95R4B0GGBXMS7RXKTQ6' }));
    });
    const start = vi.fn();
    const calls = await Promise.allSettled(
      Array.from({ length: 30 }, () => ensureLocalServer(dir, { start })),
    );
    expect(calls.every((r) => r.status === 'rejected')).toBe(true);
    expect(probes).toBe(1);
    busy = false;
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    await ensureLocalServer(dir, { start });
    expect(probes).toBe(2);
    expect(start).not.toHaveBeenCalled();
  });
});
