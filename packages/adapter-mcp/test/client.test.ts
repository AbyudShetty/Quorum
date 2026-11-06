import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, IdentityError, UnreachableError } from '../src/index.js';
import { connectAs, note, startWorld, type World } from './helpers.js';

let world: World | undefined;
afterEach(async () => {
  await world?.server.close();
  world = undefined;
});

describe('QuorumClient identity check (INV-24)', () => {
  it('reports throttled identity checks without loading or sending credentials', async () => {
    world = await startWorld();
    const load = vi.spyOn(world.store, 'load');
    const seen: (string | null)[] = [];
    const fetcher: typeof fetch = (_url, init) => {
      seen.push(new Headers(init?.headers).get('authorization'));
      return Promise.resolve(new Response('{}', { status: 429, headers: { 'retry-after': '12' } }));
    };
    await expect(connectAs(world, { fetch: fetcher })).rejects.toMatchObject({
      status: 429,
      code: 'rate.limited',
      fix: 'Wait 12 s, close stale agent sessions if necessary, then retry.',
    });
    expect(load).not.toHaveBeenCalled();
    expect(seen).toEqual([null]);
  });

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

  it('lets several processes share one credential without a family revocation (INV-11)', async () => {
    // The MCP server, a hook and the idle watcher all refresh the same attachment's token. Each
    // is its own client here, sharing the keychain (the store) and the data directory's lock.
    world = await startWorld();
    await expire(world);
    const w = world;
    const clients = await Promise.all(
      Array.from({ length: 4 }, () => connectAs(w, { dataDir: w.dataDir })),
    );
    await Promise.all(clients.map((c) => c.inbox(w.workspace)));
    // Nobody presented a rotated refresh token, so every client still works afterwards.
    for (const client of clients) await client.inbox(w.workspace);
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

describe('QuorumClient human ID rotation', () => {
  const urlOf = (input: Parameters<typeof fetch>[0]): string =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const request = {
    vendor: 'codex' as const,
    vendor_session_id: 'vendor-session',
    root: '/projects/rotation',
    expected_id: 'QRM-1111-1111-1111',
  };

  it('sends the expected current ID unchanged and validates the new ID response', async () => {
    world = await startWorld();
    const calls: { method: string | undefined; body: unknown }[] = [];
    const reply = { previous_id: request.expected_id, id: 'QRM-2222-2222-2222', detached: [] };
    const client = await connectAs(world, {
      fetch: (input, init) => {
        if (urlOf(input).endsWith('/v1/quorum-ids/rotate')) {
          calls.push({
            method: init?.method,
            body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
          });
          return Promise.resolve(Response.json(reply));
        }
        return fetch(input, init);
      },
    });
    expect(await client.rotateQuorumId(request)).toEqual(reply);
    expect(calls).toEqual([{ method: 'POST', body: request }]);
  });

  it('rejects malformed rotation input before sending a request', async () => {
    world = await startWorld();
    let rotations = 0;
    const client = await connectAs(world, {
      fetch: (input, init) => {
        if (urlOf(input).endsWith('/v1/quorum-ids/rotate')) rotations += 1;
        return fetch(input, init);
      },
    });
    await expect(client.rotateQuorumId({ ...request, expected_id: 'not-an-id' })).rejects.toThrow(
      'rotation request does not match',
    );
    expect(rotations).toBe(0);
  });

  it('refuses malformed success responses instead of handing an invalid ID to the hook', async () => {
    world = await startWorld();
    const client = await connectAs(world, {
      fetch: (input, init) =>
        urlOf(input).endsWith('/v1/quorum-ids/rotate')
          ? Promise.resolve(Response.json({ previous_id: request.expected_id, id: 'broken' }))
          : fetch(input, init),
    });
    await expect(client.rotateQuorumId(request)).rejects.toThrow('invalid rotation response');
  });

  it('preserves an older server unsupported-endpoint error without falling back to join', async () => {
    world = await startWorld();
    const paths: string[] = [];
    const client = await connectAs(world, {
      fetch: (input, init) => {
        paths.push(urlOf(input));
        return urlOf(input).endsWith('/v1/quorum-ids/rotate')
          ? Promise.resolve(
              Response.json(
                {
                  error: { code: 'route.not_found', message: 'No such route', permanent: true },
                },
                { status: 404 },
              ),
            )
          : fetch(input, init);
      },
    });
    await expect(client.rotateQuorumId(request)).rejects.toMatchObject({ status: 404 });
    expect(paths.filter((path) => path.endsWith('/v1/quorum-ids'))).toEqual([]);
  });
});
