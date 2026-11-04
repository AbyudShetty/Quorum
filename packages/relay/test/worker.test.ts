// The hosted relay's glue (worker/index.js) driven through a stand-in for Cloudflare's Durable
// Object state and WebSocketPair: roles kept in tags and attachments, as after hibernation.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { newQuorumId } from '@quorum/core';
import { homeProofMessage } from '../src/router.js';

class FakeSocket {
  sent: (string | Uint8Array)[] = [];
  closed: number | undefined;
  #attachment: unknown;
  accept() {
    // the refusal path accepts, then closes
  }
  send(data: string | Uint8Array) {
    if (this.closed !== undefined) throw new Error('closed');
    this.sent.push(data);
  }
  close(code: number) {
    this.closed ??= code;
  }
  serializeAttachment(value: unknown) {
    this.#attachment = structuredClone(value);
  }
  deserializeAttachment() {
    return structuredClone(this.#attachment);
  }
  texts() {
    return this.sent
      .filter((d): d is string => typeof d === 'string')
      .map((d) => JSON.parse(d) as Record<string, unknown>);
  }
}

class FakeState {
  accepted: { ws: FakeSocket; tags: string[] }[] = [];
  setWebSocketAutoResponse() {
    // answered by Cloudflare without waking the object
  }
  acceptWebSocket(ws: FakeSocket, tags: string[]) {
    this.accepted.push({ ws, tags });
  }
  getWebSockets(tag?: string) {
    return this.accepted
      .filter((a) => a.ws.closed === undefined && (tag === undefined || a.tags.includes(tag)))
      .map((a) => a.ws);
  }
}

interface RoomLike {
  fetch(request: Request): Promise<{ webSocket: FakeSocket }>;
  webSocketMessage(ws: FakeSocket, message: string | ArrayBuffer): Promise<void>;
  webSocketClose(ws: FakeSocket): Promise<void>;
}

const saved = {
  pair: undefined as unknown,
  response: globalThis.Response,
  rr: undefined as unknown,
};
let RoomClass: new (state: FakeState, env?: unknown) => RoomLike;
interface WorkerModule {
  default: { fetch(request: Request, env: unknown): Promise<Response> };
  Phonebook: new (state: { storage: unknown }) => {
    fetch(request: Request): Promise<Response>;
    alarm(): Promise<void>;
  };
}
let worker: WorkerModule;
let lastInside: FakeSocket;

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  saved.pair = g.WebSocketPair;
  saved.rr = g.WebSocketRequestResponsePair;
  g.WebSocketPair = function WebSocketPair() {
    lastInside = new FakeSocket();
    return { 0: new FakeSocket(), 1: lastInside };
  };
  g.WebSocketRequestResponsePair = function WebSocketRequestResponsePair() {
    // an auto-response rule: nothing to do in tests
  };
  // Node's Response refuses status 101; Cloudflare's takes it with a webSocket. Others are real.
  const Real = saved.response;
  g.Response = function Response(
    body: ConstructorParameters<typeof Real>[0],
    init?: { status?: number },
  ) {
    if (init?.status !== 101) return new Real(body, init);
    return { status: 101, webSocket: lastInside };
  };
  // @ts-expect-error -- plain JavaScript module without types
  worker = (await import('../worker/index.js')) as WorkerModule;
  RoomClass = (worker as unknown as { Room: typeof RoomClass }).Room;
});

afterAll(() => {
  const g = globalThis as Record<string, unknown>;
  g.WebSocketPair = saved.pair;
  g.WebSocketRequestResponsePair = saved.rr;
  g.Response = saved.response;
});

const request = (path: string) =>
  new Request(`https://relay.example${path}`, {
    headers: { upgrade: 'websocket', 'cf-connecting-ip': '203.0.113.7' },
  });

/** Persistent state shared by fresh Worker isolates and fresh Durable Object instances. */
const hosted = () => {
  const objects = new Map<string, InstanceType<WorkerModule['Phonebook']>>();
  const stored = new Map<string, Map<string, unknown>>();
  const alarms = new Map<string, number>();
  let upgrades = 0;
  const env = {
    PHONEBOOK: {
      idFromName: (name: string) => name,
      get: (name: string) => {
        let object = objects.get(name);
        if (!object) {
          const values = stored.get(name) ?? new Map<string, unknown>();
          stored.set(name, values);
          let running = Promise.resolve();
          const storage = {
            get: (key: string) => Promise.resolve(structuredClone(values.get(key))),
            put: (key: string, value: unknown) => {
              values.set(key, structuredClone(value));
              return Promise.resolve();
            },
            delete: (key: string) => Promise.resolve(values.delete(key)),
            setAlarm: (when: number) => {
              alarms.set(name, when);
              return Promise.resolve();
            },
            transaction: <T>(work: (target: unknown) => Promise<T>) => {
              const next = running.then(() => work(storage));
              running = next.then(
                () => undefined,
                () => undefined,
              );
              return next;
            },
          };
          object = new worker.Phonebook({ storage });
          objects.set(name, object);
        }
        const target = object;
        return {
          fetch: (input: string, init?: RequestInit) => target.fetch(new Request(input, init)),
        };
      },
    },
    ROOMS: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: () => {
          upgrades++;
          return Promise.resolve(new Response('room'));
        },
      }),
    },
  };
  const call = (path: string, ip = '203.0.113.7', upgrade = false) =>
    worker.default.fetch(
      new Request(`https://relay.example${path}`, {
        headers: { 'cf-connecting-ip': ip, ...(upgrade ? { upgrade: 'websocket' } : {}) },
      }),
      env,
    );
  return { env, objects, stored, alarms, call, upgrades: () => upgrades };
};

describe('hosted relay glue (worker/index.js)', () => {
  it('proves a home, pairs a connection and passes bytes, all through tags and attachments', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const publicKey = privateKey.export({ format: 'jwk' }).x ?? '';
    const home = createHash('sha256')
      .update(Buffer.from(publicKey, 'base64url'))
      .digest('base64url');
    const room = new RoomClass(new FakeState());

    const control = (await room.fetch(request(`/v1/home/${home}`))).webSocket;
    const { nonce } = control.texts()[0] as { nonce: string };
    await room.webSocketMessage(
      control,
      JSON.stringify({
        type: 'prove',
        public_key: publicKey,
        signature: sign(null, homeProofMessage(home, nonce), privateKey).toString('base64url'),
      }),
    );
    expect([control.closed, control.texts().at(-1)]).toEqual([undefined, { type: 'ready' }]);

    const b = (await room.fetch(request(`/v1/connect/${home}`))).webSocket;
    const open = control.texts().at(-1) as { type: string; conn: string; client: string };
    expect(open).toMatchObject({ type: 'open', client: '203.0.113.7' });

    const a = (await room.fetch(request(`/v1/accept/${home}/${open.conn}`))).webSocket;
    expect(b.texts().at(-1)).toEqual({ type: 'paired' });

    await room.webSocketMessage(b, new Uint8Array([1, 2, 3]).buffer);
    expect(a.sent.at(-1)).toEqual(new Uint8Array([1, 2, 3]));
    await room.webSocketMessage(a, new Uint8Array([4]).buffer);
    expect(b.sent.at(-1)).toEqual(new Uint8Array([4]));

    b.close(1000);
    await room.webSocketClose(b);
    expect(a.closed).toBe(1000);
  });

  it('refuses a connection to a home that is not there', async () => {
    const room = new RoomClass(new FakeState());
    const b = (await room.fetch(request(`/v1/connect/${'A'.repeat(43)}`))).webSocket;
    expect(b.closed).toBe(4404);
  });
});

describe('hosted phone book (worker/index.js, D-20)', () => {
  it('keeps one Durable Object per ID, filled by the proven home, read by lookups', async () => {
    const { env, objects } = hosted();
    const { privateKey } = generateKeyPairSync('ed25519');
    const publicKey = privateKey.export({ format: 'jwk' }).x ?? '';
    const home = createHash('sha256')
      .update(Buffer.from(publicKey, 'base64url'))
      .digest('base64url');
    const room = new RoomClass(new FakeState(), env);
    const control = (await room.fetch(request(`/v1/home/${home}`))).webSocket;
    const { nonce } = control.texts()[0] as { nonce: string };
    await room.webSocketMessage(
      control,
      JSON.stringify({
        type: 'prove',
        public_key: publicKey,
        signature: sign(null, homeProofMessage(home, nonce), privateKey).toString('base64url'),
      }),
    );
    const mine = newQuorumId(home);
    const theirs = newQuorumId('A'.repeat(43));
    await room.webSocketMessage(control, JSON.stringify({ type: 'register', ids: [mine, theirs] }));
    expect(control.texts().at(-1)).toEqual({ type: 'registered', ids: [mine.id] });
    expect([...objects.keys()]).toEqual([mine.id]);

    const lookup = (id: string) =>
      worker.default.fetch(new Request(`https://relay.example/v1/lookup/${id}`), env);
    const found = await lookup(mine.id);
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({ home, salt: mine.salt });
    expect((await lookup(theirs.id)).status).toBe(404);
  });
});

describe('hosted relay request limits (INV-15, D-20)', () => {
  const missing = 'QRM-0000-0000-0000';

  it('rejects malformed encoding without touching storage, and keeps answering health', async () => {
    const h = hosted();
    for (const suffix of ['%', '%E0%A4%A', '%FF']) {
      expect((await h.call(`/v1/lookup/${suffix}`)).status).toBe(400);
    }
    expect(h.objects.size).toBe(0);
    expect((await h.call('/health')).status).toBe(200);
    expect((await h.call(`/v1/lookup/${missing}`)).status).toBe(404);
  });

  it('counts concurrent lookups per address across different IDs and fresh object instances', async () => {
    const h = hosted();
    const replies = await Promise.all(
      Array.from({ length: 31 }, (_, i) =>
        h.call(`/v1/lookup/${i % 2 ? missing : 'QRM-1111-1111-1111'}`),
      ),
    );
    expect(replies.filter((r) => r.status === 404)).toHaveLength(30);
    expect(replies.filter((r) => r.status === 429)).toHaveLength(1);
    expect(replies.find((r) => r.status === 429)?.headers.get('retry-after')).toMatch(
      /^[1-9][0-9]?$/,
    );
    h.objects.clear(); // simulate hibernation/recreation while retaining Durable Object storage
    expect((await h.call(`/v1/lookup/${missing}`)).status).toBe(429);
    expect((await h.call(`/v1/lookup/${missing}`, '203.0.113.8')).status).toBe(404);
    expect([...h.stored.keys()].filter((key) => key.startsWith('limits:'))).toHaveLength(2);
    expect([...h.stored.keys()].some((key) => key.includes('203.0.113'))).toBe(false);
  });

  it('limits upgrades before room forwarding, independently of the lookup budget', async () => {
    const h = hosted();
    for (let i = 0; i < 120; i++) {
      expect((await h.call(`/v1/connect/${'A'.repeat(43)}`, undefined, true)).status).toBe(200);
    }
    const refused = await h.call(`/v1/home/${'B'.repeat(43)}`, undefined, true);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toMatch(/^[1-9][0-9]?$/);
    expect(h.upgrades()).toBe(120);
    expect((await h.call(`/v1/lookup/${missing}`)).status).toBe(404);
    expect((await h.call(`/v1/home/${'B'.repeat(43)}`, '203.0.113.8', true)).status).toBe(200);
  });

  it('resets expired windows and an old cleanup alarm does not delete a fresh window', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const h = hosted();
      for (let i = 0; i < 30; i++) await h.call(`/v1/lookup/${missing}`);
      expect((await h.call(`/v1/lookup/${missing}`)).status).toBe(429);
      const object = [...h.objects.values()][0];
      expect(object).toBeDefined();
      clock.mockReturnValue(1_060_001);
      expect((await h.call(`/v1/lookup/${missing}`)).status).toBe(404);
      await object?.alarm();
      expect([...h.stored.values()][0]?.get('rate:lookup')).toEqual({ start: 1_060_001, count: 1 });
      expect([...h.alarms.values()][0]).toBe(1_120_001);
      clock.mockReturnValue(1_120_002);
      await object?.alarm();
      expect([...h.stored.values()][0]?.size).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });
});
