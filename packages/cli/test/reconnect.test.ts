// Long-lived clients (`quorum mcp`, the Codex waker) and a local server that restarts: the client
// finds the new server by itself, and nothing that took over the old port ever sees a token (INV-24).
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdentityError, MemoryCredentialStore, QuorumClient } from '@quorum/adapter-mcp';
import { readBootstrapCode } from '@quorum/local';
import { type LocalServer, startLocalServer } from '@quorum/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let root: string;
let dataDir: string;
const store = new MemoryCredentialStore();
const servers: LocalServer[] = [];
const start = async () => {
  const server = await startLocalServer({ dataDir, idleShutdownMs: 0 });
  servers.push(server);
  return server;
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'quorum-reconnect-'));
  dataDir = join(root, 'data');
  const server = await start();
  // Sign in and attach one agent through the public API, as the CLI does.
  const post = async (path: string, body: unknown, token?: string) => {
    const response = await fetch(`${server.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return (await response.json()) as Record<string, unknown>;
  };
  const code = (await readBootstrapCode(dataDir))?.code;
  const human = (
    (await post('/v1/auth/local-bootstrap', { code })).credentials as {
      access_token: string;
    }
  ).access_token;
  const ws = (await post('/v1/workspaces', { name: 'reconnect' }, human)).id as string;
  const folder = join(root, 'project');
  await mkdir(folder);
  const attached = await post(
    '/v1/attachments',
    { root: folder, vendor: 'codex', workspaces: [ws] },
    human,
  );
  const credentials = attached.credentials as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  await store.save('agent', {
    access_token: credentials.access_token,
    refresh_token: credentials.refresh_token,
    access_expires_at: Date.now() + credentials.expires_in * 1000,
  });
  await server.close();
}, 60_000);

afterAll(async () => {
  for (const server of servers) await server.close();
  await rm(root, { recursive: true, force: true });
});

describe('a local server that restarts', { timeout: 60_000 }, () => {
  it('is found again on its new port, with a fresh identity check', async () => {
    const first = await start();
    const client = await QuorumClient.connect({ dataDir, credentialKey: 'agent', store });
    expect(await client.workspaces()).toHaveLength(1);
    await first.close();
    const second = await start();
    expect(second.port).not.toBe(first.port);
    expect(await client.workspaces()).toHaveLength(1);
    expect(client.baseUrl).toBe(second.baseUrl);
    await second.close();
  });

  it('is started again through ensureServer when it is gone', async () => {
    const first = await start();
    let restarted = false;
    const client = await QuorumClient.connect({
      dataDir,
      credentialKey: 'agent',
      store,
      ensureServer: async () => {
        if (restarted) return;
        restarted = true;
        await start();
      },
    });
    await first.close();
    expect(await client.workspaces()).toHaveLength(1);
    await servers.at(-1)?.close();
  });

  it('never shows a token to a program that took over the old port', async () => {
    const server = await start();
    const client = await QuorumClient.connect({ dataDir, credentialKey: 'agent', store });
    expect(await client.workspaces()).toHaveLength(1);
    const port = server.port;
    await server.close(); // also removes the discovery file
    await expect(client.workspaces()).rejects.toThrow(); // gone: the client stops trusting the port
    const seen: IncomingHttpHeaders[] = [];
    const squatter = createServer((req, res) => {
      seen.push(req.headers);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"workspaces":[]}');
    });
    await new Promise<void>((resolve) => squatter.listen(port, '127.0.0.1', resolve));
    try {
      await expect(client.workspaces()).rejects.toBeInstanceOf(IdentityError);
      expect(seen.length).toBeGreaterThan(0); // it was asked to prove itself…
      expect(seen.every((h) => h.authorization === undefined)).toBe(true); // …and saw no token
    } finally {
      await new Promise<void>((resolve) =>
        squatter.close(() => {
          resolve();
        }),
      );
    }
  });
});
