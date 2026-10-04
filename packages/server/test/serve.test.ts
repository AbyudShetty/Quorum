import { mkdtempSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBootstrapCode, readDiscovery } from '@quorum/local';
import { afterAll, describe, expect, it } from 'vitest';
import {
  AlreadyRunningError,
  addressName,
  localServerCommand,
  startLocalServer,
} from '../src/index.js';

const dirs: string[] = [];
const dataDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-serve-'));
  dirs.push(dir);
  return join(dir, 'data');
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// Each start locks the data directory down, which runs PowerShell on Windows.
describe('quorum serve --local (ARCHITECTURE §8.2)', { timeout: 60_000 }, () => {
  it('publishes discovery and a bootstrap code, answers on loopback, and cleans up on stop', async () => {
    const dir = dataDir();
    const server = await startLocalServer({ dataDir: dir, idleShutdownMs: 0 });
    try {
      const discovery = await readDiscovery(dir);
      expect(discovery).toMatchObject({
        instance_id: server.instanceId,
        port: server.port,
        public_key: server.publicKey,
        pid: process.pid,
      });
      expect((await readBootstrapCode(dir))?.code).toMatch(/^qrm_bc_/);
      const health = await fetch(`http://127.0.0.1:${String(server.port)}/v1/health`);
      expect(health.status).toBe(200);
      expect(server.quorum).toBeDefined();
    } finally {
      await server.close();
    }
    expect(await readDiscovery(dir)).toBeUndefined();
    expect(await readBootstrapCode(dir)).toBeUndefined();
  });

  it('runs one server per data directory, and keeps its identity across restarts', async () => {
    const dir = dataDir();
    const first = await startLocalServer({ dataDir: dir, idleShutdownMs: 0 });
    await expect(startLocalServer({ dataDir: dir, idleShutdownMs: 0 })).rejects.toBeInstanceOf(
      AlreadyRunningError,
    );
    await first.close();
    const second = await startLocalServer({ dataDir: dir, idleShutdownMs: 0 });
    expect(second.instanceId).toBe(first.instanceId);
    expect(second.publicKey).toBe(first.publicKey);
    await second.close();
  });

  it('only listens on the loopback address (INV-22)', async (context) => {
    // A non-loopback address of this machine, if it has one (CI machines usually do).
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
    if (!lan) return context.skip();
    const server = await startLocalServer({ dataDir: dataDir(), idleShutdownMs: 0 });
    try {
      await expect(
        fetch(`http://${lan}:${String(server.port)}/v1/health`, {
          signal: AbortSignal.timeout(5000),
        }),
      ).rejects.toThrow();
    } finally {
      await server.close();
    }
  });

  it('shuts down by itself when idle', async () => {
    const server = await startLocalServer({ dataDir: dataDir(), idleShutdownMs: 300 });
    await server.closed;
    await expect(fetch(`http://127.0.0.1:${String(server.port)}/v1/health`)).rejects.toThrow();
  });
});

describe('addressName', () => {
  it('turns machine and user names into address parts', () => {
    expect(addressName('DESKTOP-AB12', 'm')).toBe('desktop-ab12');
    expect(addressName('Abyud Shetty', 'm')).toBe('abyud-shetty');
    expect(addressName('123', 'machine')).toBe('machine');
    expect(addressName('x'.repeat(50), 'm')).toHaveLength(32);
  });
});

describe('auto-start command (INV-10)', () => {
  it('is fixed: Node running the server package entry, nothing chosen by the caller', () => {
    const { command, args } = localServerCommand();
    expect(command).toBe(process.execPath);
    expect(args).toHaveLength(1);
    expect(args[0]).toMatch(/[\\/]local[\\/]serve-main\.js$/);
  });
});
