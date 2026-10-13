// The relay on Node (`quorum relay`): one HTTP server, three WebSocket routes, rooms in memory.
// The hosted relay runs the same router in a Cloudflare Durable Object (worker/).
//
//   GET /health                            {"status":"ok","relay":"quorum-relay/1"}
//   GET /v1/home/<home>        WebSocket   the home server's control connection
//   GET /v1/connect/<home>     WebSocket   another machine asking for that home
//   GET /v1/accept/<home>/<conn> WebSocket the home's side of one connection
//
// Nothing is stored and nothing is logged; rooms live only while their sockets are open.
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  type Arrival,
  arriveAccept,
  arriveConnect,
  arriveHome,
  CONN_ID,
  HOME_ID,
  MAX_FRAME_BYTES,
  onClose,
  onMessage,
  RELAY_PROTOCOL,
  type Room,
  type RoomSocket,
  type SocketMeta,
} from './router.js';

export interface RelayOptions {
  /** Default 127.0.0.1: put it behind HTTPS (a reverse proxy or tunnel) to offer it to others. */
  host?: string;
  /** Default 7430; 0 = any free port. */
  port?: number;
  /** Take the client address from X-Forwarded-For / CF-Connecting-IP (behind a proxy you run). */
  trustProxy?: boolean;
  /** New WebSockets per client address per minute. Default 120. */
  perMinute?: number;
}

export interface Relay {
  /** ws://host:port */
  url: string;
  port: number;
  close(): Promise<void>;
}

class NodeSocket implements RoomSocket {
  #meta: SocketMeta;
  constructor(
    readonly ws: WebSocket,
    meta: SocketMeta,
  ) {
    this.#meta = meta;
  }
  get meta(): SocketMeta {
    return this.#meta;
  }
  setMeta(meta: SocketMeta): void {
    this.#meta = meta;
  }
  send(data: string | Uint8Array): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(data);
  }
  close(code: number, reason: string): void {
    this.ws.close(code, reason);
  }
}

class NodeRoom implements Room {
  readonly members = new Set<NodeSocket>();
  sockets(filter?: { kind: SocketMeta['kind']; conn?: string }): RoomSocket[] {
    return [...this.members].filter(
      (s) =>
        !filter ||
        (s.meta.kind === filter.kind &&
          (filter.conn === undefined || ('conn' in s.meta && s.meta.conn === filter.conn))),
    );
  }
}

const toBytes = (data: RawData): Uint8Array =>
  Array.isArray(data)
    ? Buffer.concat(data)
    : data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : data;

export const startRelay = async (options: RelayOptions = {}): Promise<Relay> => {
  const rooms = new Map<string, NodeRoom>();
  const roomOf = (home: string): NodeRoom => {
    let room = rooms.get(home);
    if (!room) rooms.set(home, (room = new NodeRoom()));
    return room;
  };
  const perMinute = options.perMinute ?? 120;
  const recent = new Map<string, { windowStart: number; count: number }>();
  const allowed = (client: string): boolean => {
    const now = Date.now();
    const entry = recent.get(client);
    if (!entry || now - entry.windowStart >= 60_000) {
      recent.set(client, { windowStart: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= perMinute;
  };
  const clientOf = (request: IncomingMessage): string => {
    if (options.trustProxy) {
      const header = request.headers['cf-connecting-ip'] ?? request.headers['x-forwarded-for'];
      const first = (Array.isArray(header) ? header[0] : header)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return request.socket.remoteAddress ?? 'unknown';
  };

  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ status: 'ok', relay: RELAY_PROTOCOL }));
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found.\n');
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const reject = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${String(status)} ${text}\r\nConnection: close\r\n\r\n`);
    };
    const parts = (request.url ?? '').split('?')[0]?.split('/') ?? [];
    const [, v1, route, home, conn] = parts;
    if (v1 !== 'v1' || !home || !HOME_ID.test(home)) {
      reject(404, 'Not Found');
      return;
    }
    const client = clientOf(request);
    if (!allowed(client)) {
      reject(429, 'Too Many Requests');
      return;
    }
    const room = roomOf(home);
    let arrival: Arrival;
    if (route === 'home' && parts.length === 4) arrival = arriveHome(home);
    else if (route === 'connect' && parts.length === 4) arrival = arriveConnect(room, home, client);
    else if (route === 'accept' && parts.length === 5 && conn && CONN_ID.test(conn)) {
      arrival = arriveAccept(room, home, conn);
    } else {
      reject(404, 'Not Found');
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      if ('refuse' in arrival) {
        ws.close(arrival.refuse.code, arrival.refuse.reason);
        return;
      }
      const member = new NodeSocket(ws, arrival.meta);
      room.members.add(member);
      // Half-open connections (a laptop that went to sleep) are found by pings and dropped.
      let alive = true;
      ws.on('pong', () => {
        alive = true;
      });
      const pinger = setInterval(() => {
        if (!alive) ws.terminate();
        alive = false;
        ws.ping();
      }, 30_000);
      pinger.unref();
      ws.on('message', (data, isBinary) => {
        void onMessage(
          room,
          member,
          isBinary ? toBytes(data) : Buffer.from(toBytes(data)).toString('utf8'),
        );
      });
      ws.on('close', () => {
        clearInterval(pinger);
        room.members.delete(member);
        onClose(room, member);
        if (room.members.size === 0) rooms.delete(home);
      });
      ws.on('error', () => {
        ws.terminate();
      });
      if (arrival.greet) member.send(arrival.greet);
      arrival.after?.();
    });
  });

  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 7430, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `ws://${host.includes(':') ? `[${host}]` : host}:${String(port)}`,
    port,
    close: async () => {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    },
  };
};
