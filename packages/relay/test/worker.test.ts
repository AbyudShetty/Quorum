// The hosted relay's glue (worker/index.js) driven through a stand-in for Cloudflare's Durable
// Object state and WebSocketPair: roles kept in tags and attachments, as after hibernation.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  Phonebook: new (state: { storage: unknown }) => { fetch(request: Request): Promise<Response> };
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
    const objects = new Map<string, InstanceType<WorkerModule['Phonebook']>>();
    const env = {
      PHONEBOOK: {
        idFromName: (name: string) => name,
        get: (name: string) => {
          let object = objects.get(name);
          if (!object) {
            const stored = new Map<string, unknown>();
            object = new worker.Phonebook({
              storage: {
                get: (key: string) => Promise.resolve(stored.get(key)),
                put: (key: string, value: unknown) => {
                  stored.set(key, value);
                  return Promise.resolve();
                },
              },
            });
            objects.set(name, object);
          }
          const target = object;
          return {
            fetch: (input: string, init?: RequestInit) => target.fetch(new Request(input, init)),
          };
        },
      },
    };
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
