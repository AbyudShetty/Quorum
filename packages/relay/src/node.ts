// The relay on Node (`quorum relay`): one HTTP server, three WebSocket routes, rooms in memory.
// The hosted relay runs the same router in a Cloudflare Durable Object (worker/).
//
//   GET /health                            {"status":"ok","relay":"quorum-relay/1"}
//   GET /v1/home/<home>        WebSocket   the home server's control connection
//   GET /v1/connect/<home>     WebSocket   another machine asking for that home
//   GET /v1/accept/<home>/<conn> WebSocket the home's side of one connection
//   GET /v1/lookup/<quorum id>             {"home","salt"} or 404 "no such ID" (D-20)
//
// Nothing is logged. The only thing kept is the phone book (Quorum ID → home, D-20), in a file
// when `phonebookFile` is given (`quorum relay` keeps it in the data folder), else in memory.
// Rooms live only while their sockets are open.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  type Arrival,
  lookupId,
  type Phonebook,
  type PhonebookEntry,
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
  /** ID lookups per client address per minute. Default 30. */
  lookupsPerMinute?: number;
  /** Where the phone book is kept (JSON). Default: memory only. */
  phonebookFile?: string;
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

/** The phone book in memory, written to a file (atomically) after each change when one is given. */
const filePhonebook = async (file: string | undefined): Promise<Phonebook> => {
  const entries = new Map<string, PhonebookEntry>();
  if (file) {
    try {
      const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, PhonebookEntry>;
      for (const [id, entry] of Object.entries(saved)) entries.set(id, entry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  let writing = Promise.resolve();
  return {
    get: (id) => Promise.resolve(entries.get(id)),
    put: (id, entry) => {
      entries.set(id, entry);
      if (!file) return Promise.resolve();
      writing = writing.then(async () => {
        await mkdir(dirname(file), { recursive: true });
        const temp = `${file}.tmp`;
        await writeFile(temp, JSON.stringify(Object.fromEntries(entries)));
        await rename(temp, file);
      });
      return writing;
    },
  };
};

class NodeRoom implements Room {
  readonly members = new Set<NodeSocket>();
  constructor(readonly phonebook: Phonebook) {}
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
  const phonebook = await filePhonebook(options.phonebookFile);
  const rooms = new Map<string, NodeRoom>();
  const roomOf = (home: string): NodeRoom => {
    let room = rooms.get(home);
    if (!room) rooms.set(home, (room = new NodeRoom(phonebook)));
    return room;
  };
  /** Fixed-window limits per client address. */
  const limiter = (perMinute: number) => {
    const recent = new Map<string, { windowStart: number; count: number }>();
    return (client: string): boolean => {
      const now = Date.now();
      const entry = recent.get(client);
      if (!entry || now - entry.windowStart >= 60_000) {
        if (recent.size > 10_000) recent.clear();
        recent.set(client, { windowStart: now, count: 1 });
        return true;
      }
      entry.count += 1;
      return entry.count <= perMinute;
    };
  };
  const allowed = limiter(options.perMinute ?? 120);
  const lookupAllowed = limiter(options.lookupsPerMinute ?? 30);
  const clientOf = (request: IncomingMessage): string => {
    if (options.trustProxy) {
      const header = request.headers['cf-connecting-ip'] ?? request.headers['x-forwarded-for'];
      const first = (Array.isArray(header) ? header[0] : header)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return request.socket.remoteAddress ?? 'unknown';
  };

  const json = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  };
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    if (request.method === 'GET' && url === '/health') {
      json(response, 200, { status: 'ok', relay: RELAY_PROTOCOL });
      return;
    }
    const lookup = /^\/v1\/lookup\/([^/?]+)$/.exec(url);
    if (request.method === 'GET' && lookup) {
      if (!lookupAllowed(clientOf(request))) {
        json(response, 429, { error: 'Too many lookups; try again in a minute.' });
        return;
      }
      void lookupId(phonebook, decodeURIComponent(lookup[1] ?? '')).then((entry) => {
        if (entry) json(response, 200, entry);
        else json(response, 404, { error: 'No such ID.' });
      });
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
