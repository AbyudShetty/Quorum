// The hosted Quorum relay (DECISIONS D-18) on Cloudflare Workers' free plan: one Durable Object
// per home server, so a home and the connections asking for it always meet in the same place. The
// pairing logic is the same router the Node relay runs (../src/router.ts). WebSockets use the
// Hibernation API: an idle home connection costs nothing, and each socket's role lives in its
// attachment and tags, so nothing is lost when the object sleeps. Nothing is logged. The only
// thing stored is the phone book (Quorum ID → home, D-20): one small Durable Object per ID.
/* global WebSocketPair, WebSocketRequestResponsePair */
import {
  arriveAccept,
  arriveConnect,
  arriveHome,
  CONN_ID,
  HOME_ID,
  lookupId,
  onClose,
  onMessage,
  RELAY_PROTOCOL,
} from '../src/router.ts';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

/** The phone book: each ID's entry lives in its own Durable Object (named by the ID). */
const phonebookOf = (env) => {
  const stub = (id) => env.PHONEBOOK.get(env.PHONEBOOK.idFromName(id));
  return {
    async get(id) {
      const response = await stub(id).fetch('https://phonebook/entry');
      return response.status === 200 ? response.json() : undefined;
    },
    async put(id, entry) {
      await stub(id).fetch('https://phonebook/entry', {
        method: 'PUT',
        body: JSON.stringify(entry),
      });
    },
  };
};

/** Routes: /health, /v1/lookup/<id>, /v1/home/<home>, /v1/connect/<home>, /v1/accept/<home>/<conn>. */
const route = (url) => {
  const parts = url.pathname.split('/');
  const [, v1, kind, home, conn] = parts;
  if (v1 !== 'v1' || !home || !HOME_ID.test(home)) return undefined;
  if ((kind === 'home' || kind === 'connect') && parts.length === 4) return { kind, home };
  if (kind === 'accept' && parts.length === 5 && conn && CONN_ID.test(conn)) {
    return { kind, home, conn };
  }
  return undefined;
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ status: 'ok', relay: RELAY_PROTOCOL });
    }
    const lookup = /^\/v1\/lookup\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && lookup) {
      const entry = await lookupId(phonebookOf(env), decodeURIComponent(lookup[1]));
      return entry ? json(entry) : json({ error: 'No such ID.' }, 404);
    }
    const target = route(url);
    if (!target || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Not found.\n', { status: 404 });
    }
    const room = env.ROOMS.get(env.ROOMS.idFromName(target.home));
    return room.fetch(request);
  },
};

/** A socket as the router sees it: its role is kept in the attachment. */
const wrappers = new WeakMap();
const wrap = (ws) => {
  let wrapped = wrappers.get(ws);
  if (!wrapped) wrappers.set(ws, (wrapped = wrapOnce(ws)));
  return wrapped;
};
const wrapOnce = (ws) => ({
  ws,
  get meta() {
    return ws.deserializeAttachment();
  },
  setMeta(meta) {
    ws.serializeAttachment(meta);
  },
  send(data) {
    try {
      ws.send(data);
    } catch {
      // already closing
    }
  },
  close(code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  },
});

const tagsOf = (meta) =>
  meta.kind === 'home' ? ['home'] : [meta.kind, `${meta.kind}:${meta.conn}`];

export class Room {
  constructor(state, env) {
    this.state = state;
    this.phonebook = phonebookOf(env);
    // Keepalive pings from home servers are answered without waking the object.
    state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'),
    );
  }

  /** Room interface for the router. */
  sockets(filter) {
    const tag = filter ? (filter.conn ? `${filter.kind}:${filter.conn}` : filter.kind) : undefined;
    return this.state.getWebSockets(tag).map(wrap);
  }

  async fetch(request) {
    const target = route(new URL(request.url));
    if (!target) return new Response('Not found.\n', { status: 404 });
    const client = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const arrival =
      target.kind === 'home'
        ? arriveHome(target.home)
        : target.kind === 'connect'
          ? arriveConnect(this, target.home, client)
          : arriveAccept(this, target.home, target.conn);
    const [outside, inside] = Object.values(new WebSocketPair());
    if ('refuse' in arrival) {
      inside.accept();
      inside.close(arrival.refuse.code, arrival.refuse.reason);
      return new Response(null, { status: 101, webSocket: outside });
    }
    this.state.acceptWebSocket(inside, tagsOf(arrival.meta));
    inside.serializeAttachment(arrival.meta);
    if (arrival.greet) inside.send(arrival.greet);
    arrival.after?.();
    return new Response(null, { status: 101, webSocket: outside });
  }

  async webSocketMessage(ws, message) {
    await onMessage(
      this,
      wrap(ws),
      typeof message === 'string' ? message : new Uint8Array(message),
    );
  }

  async webSocketClose(ws) {
    onClose(this, wrap(ws));
    // Answer the close, so the other end is not left waiting for it.
    wrap(ws).close(1000, 'Closed.');
  }

  async webSocketError(ws) {
    onClose(this, wrap(ws));
    wrap(ws).close(1011, 'Connection error.');
  }
}

/** One phone book entry (D-20): `{home, salt}` for the ID this object is named after. */
export class Phonebook {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.method === 'PUT') {
      await this.state.storage.put('entry', await request.json());
      return new Response(null, { status: 204 });
    }
    const entry = await this.state.storage.get('entry');
    return entry ? json(entry) : json({ error: 'No such ID.' }, 404);
  }
}
