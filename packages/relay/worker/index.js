// The hosted Quorum relay (DECISIONS D-18) on Cloudflare Workers' free plan: one Durable Object
// per home server, so a home and the connections asking for it always meet in the same place. The
// pairing logic is the same router the Node relay runs (../src/router.ts). WebSockets use the
// Hibernation API: an idle home connection costs nothing, and each socket's role lives in its
// attachment and tags, so nothing is lost when the object sleeps. Nothing is stored or logged.
/* global WebSocketPair, WebSocketRequestResponsePair */
import {
  arriveAccept,
  arriveConnect,
  arriveHome,
  CONN_ID,
  HOME_ID,
  onClose,
  onMessage,
  RELAY_PROTOCOL,
} from '../src/router.ts';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

/** Routes: /health, /v1/home/<home>, /v1/connect/<home>, /v1/accept/<home>/<conn>. */
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
  constructor(state) {
    this.state = state;
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
  }

  async webSocketError(ws) {
    onClose(this, wrap(ws));
  }
}
