// The hosted relay's glue (worker/index.js) driven through a stand-in for Cloudflare's Durable
// Object state and WebSocketPair: roles kept in tags and attachments, as after hibernation.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
let RoomClass: new (state: FakeState) => RoomLike;
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
  // Node's Response refuses status 101; Cloudflare's takes it with a webSocket.
  g.Response = class {
    constructor(
      readonly body: unknown,
      readonly init: { status: number; webSocket?: FakeSocket },
    ) {}
    get webSocket() {
      return lastInside;
    }
  };
  // @ts-expect-error -- plain JavaScript module without types
  RoomClass = ((await import('../worker/index.js')) as { Room: typeof RoomClass }).Room;
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
