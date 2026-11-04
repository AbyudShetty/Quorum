// The hosted Quorum relay (DECISIONS D-18) on Cloudflare Workers' free plan: one Durable Object
// per home server, so a home and the connections asking for it always meet in the same place. The
// pairing logic is the same router the Node relay runs (../src/router.ts). WebSockets use the
// Hibernation API: an idle home connection costs nothing, and each socket's role lives in its
// attachment and tags, so nothing is lost when the object sleeps. Nothing is logged. The only
// durable data is the phone book (Quorum ID → home, D-20): one small Durable Object per ID.
// Separate per-address objects keep short-lived rate counters and clean them up with alarms.
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

const rateLimits = { lookup: 30, upgrade: 120 };
const WINDOW_MS = 60_000;

/** One limiter per client, shared across isolates; its name cannot be a Quorum ID. */
const limit = async (env, request, kind) => {
  const client = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(client));
  const name = `limits:${Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  const target = env.PHONEBOOK.get(env.PHONEBOOK.idFromName(name));
  return target.fetch(`https://phonebook/limit/${kind}`, { method: 'POST' });
};

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
      let id;
      try {
        id = decodeURIComponent(lookup[1]);
      } catch {
        return json({ error: 'Malformed ID encoding.' }, 400);
      }
      const allowed = await limit(env, request, 'lookup');
      if (allowed.status !== 204) return allowed;
      const entry = await lookupId(phonebookOf(env), id);
      return entry ? json(entry) : json({ error: 'No such ID.' }, 404);
    }
    const target = route(url);
    if (!target || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Not found.\n', { status: 404 });
    }
    const allowed = await limit(env, request, 'upgrade');
    if (allowed.status !== 204) return allowed;
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
    const kind = /^\/limit\/(lookup|upgrade)$/.exec(new URL(request.url).pathname)?.[1];
    if (request.method === 'POST' && kind) {
      // Atomic even when two requests for one address arrive during storage I/O.
      const outcome = await this.state.storage.transaction(async (storage) => {
        const now = Date.now();
        const key = `rate:${kind}`;
        const previous = await storage.get(key);
        const window =
          previous && now - previous.start < WINDOW_MS ? previous : { start: now, count: 0 };
        const retryAfter = Math.max(1, Math.ceil((window.start + WINDOW_MS - now) / 1000));
        if (window.count >= rateLimits[kind]) return { allowed: false, retryAfter };
        await storage.put(key, { start: window.start, count: window.count + 1 });
        return { allowed: true, retryAfter };
      });
      // The limiter stores no history: discard counters after both windows have expired.
      await this.state.storage.setAlarm(Date.now() + WINDOW_MS);
      if (outcome.allowed) return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ error: 'Too many requests; try again in a minute.' }), {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'retry-after': String(outcome.retryAfter),
        },
      });
    }
    if (request.method === 'PUT') {
      await this.state.storage.put('entry', await request.json());
      return new Response(null, { status: 204 });
    }
    const entry = await this.state.storage.get('entry');
    return entry ? json(entry) : json({ error: 'No such ID.' }, 404);
  }

  async alarm() {
    // An already-scheduled alarm may overlap a fresh request. Delete only expired counters.
    const next = await this.state.storage.transaction(async (storage) => {
      const now = Date.now();
      let next;
      for (const kind of Object.keys(rateLimits)) {
        const key = `rate:${kind}`;
        const window = await storage.get(key);
        if (!window) continue;
        const expires = window.start + WINDOW_MS;
        if (expires <= now) await storage.delete(key);
        else next = next === undefined ? expires : Math.min(next, expires);
      }
      return next;
    });
    if (next !== undefined) await this.state.storage.setAlarm(next);
  }
}
