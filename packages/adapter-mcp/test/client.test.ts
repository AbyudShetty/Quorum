import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, IdentityError, UnreachableError } from '../src/index.js';
import { connectAs, note, startWorld, type World } from './helpers.js';

let world: World | undefined;
afterEach(async () => {
  await world?.server.close();
  world = undefined;
});

describe('QuorumClient identity check (INV-24)', () => {
  it('connects to the real server and sends messages with its token', async () => {
    world = await startWorld();
    const client = await connectAs(world);
    const sent = await client.send(
      world.workspace,
      note(world, world.agent.address, [world.peer.address], 'hi'),
    );
    expect(sent.duplicate).toBe(false);
    expect((await client.inbox(world.workspace)).messages).toHaveLength(0); // addressed to the peer
  });

  it('refuses a server that holds a different key, and sends no credential', async () => {
    world = await startWorld();
    const seen: (string | null)[] = [];
    const spy: typeof fetch = (input, init) => {
      seen.push(new Headers(init?.headers).get('authorization'));
      return fetch(input, init);
    };
    await expect(
      connectAs(world, { target: { ...world.target, publicKey: 'A'.repeat(43) }, fetch: spy }),
    ).rejects.toBeInstanceOf(IdentityError);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((h) => h === null)).toBe(true);
  });

  it('refuses a squatter on the port and never shows it a token', async () => {
    world = await startWorld();
    const publicKey = world.server.publicKey;
    const received: string[] = [];
    const squatter = createServer((req, res) => {
      received.push(req.headers.authorization ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          instance_id: '01J9ZZZZZZZZZZZZZZZZZZZZZZ',
          public_key: publicKey,
          signature: 'A'.repeat(86),
        }),
      );
    });
    await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve));
    const port = (squatter.address() as AddressInfo).port;
    try {
      await expect(
        connectAs(world, {
          target: { ...world.target, baseUrl: `http://localhost:${String(port)}` },
        }),
      ).rejects.toBeInstanceOf(IdentityError);
      expect(received.length).toBeGreaterThan(0);
      expect(received.every((h) => h === '')).toBe(true);
    } finally {
      squatter.closeAllConnections();
      squatter.close();
    }
  });

  it('refuses a server whose instance differs from the discovery file', async () => {
    world = await startWorld();
    await expect(
      connectAs(world, { target: { ...world.target, instanceId: '01J9ZZZZZZZZZZZZZZZZZZZZZZ' } }),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  it('reports an unreachable server as such, not as an identity failure', async () => {
    world = await startWorld();
    await expect(
      connectAs(world, { target: { ...world.target, baseUrl: 'http://localhost:1' } }),
    ).rejects.toBeInstanceOf(UnreachableError);
  });
});

describe('QuorumClient tokens (INV-11)', () => {
  const expire = async (w: World) => {
    await w.store.save('at_test', {
      access_token: w.agent.token,
      refresh_token: w.agent.refreshToken,
      access_expires_at: Date.now() - 1000,
    });
  };

  it('refreshes an expired access token, stores the rotated pair, and keeps working', async () => {
    world = await startWorld();
    await expire(world);
    const client = await connectAs(world);
    await client.inbox(world.workspace);
    const stored = await world.store.load('at_test');
    expect(stored?.refresh_token).not.toBe(world.agent.refreshToken);
    expect(stored?.access_expires_at).toBeGreaterThan(Date.now());
    await client.inbox(world.workspace); // uses the new token
  });

  it('shares one refresh between concurrent calls (a second would reuse the old token)', async () => {
    world = await startWorld();
    await expire(world);
    const client = await connectAs(world);
    const workspace = world.workspace;
    const results = await Promise.all(Array.from({ length: 5 }, () => client.inbox(workspace)));
    expect(results).toHaveLength(5);
  });

  it('turns server errors into ApiError with the fix', async () => {
    world = await startWorld();
    const client = await connectAs(world);
    const bad = {
      ...note(world, world.agent.address, [world.peer.address], 'x'),
      from: world.peer.address,
    };
    const error = await client.send(world.workspace, bad).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: 'message.sender_mismatch', permanent: true });
    expect((error as ApiError).fix).toContain(world.agent.address);
  });

  it('fails clearly when there are no stored credentials', async () => {
    world = await startWorld();
    const client = await connectAs(world, { credentialKey: 'at_missing' });
    await expect(client.inbox(world.workspace)).rejects.toMatchObject({
      code: 'auth.no_credentials',
    });
  });
});

describe('QuorumClient outages', () => {
  it('reports a dropped server as unreachable and works again when it returns', async () => {
    world = await startWorld();
    const client = await connectAs(world);
    world.server.setOutage('down');
    await expect(client.inbox(world.workspace)).rejects.toBeInstanceOf(UnreachableError);
    world.server.setOutage('off');
    expect((await client.inbox(world.workspace)).messages).toEqual([]);
  });

  it('gives up on a server that accepts requests but never answers', async () => {
    world = await startWorld();
    const client = await connectAs(world, { requestTimeoutMs: 300 });
    world.server.setOutage('hang');
    const began = Date.now();
    await expect(client.inbox(world.workspace)).rejects.toBeInstanceOf(UnreachableError);
    expect(Date.now() - began).toBeLessThan(3000);
    world.server.setOutage('off');
    await client.inbox(world.workspace); // and recovers
  });
});
