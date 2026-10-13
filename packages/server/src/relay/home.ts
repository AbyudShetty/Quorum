// The home server's link to the relay (DECISIONS D-18, ARCHITECTURE §8.4). The server keeps
// listening on loopback only (INV-22); this makes an outbound WebSocket to the relay, proves the
// instance key, and for each connection the relay announces opens a second WebSocket, runs TLS 1.3
// on it as the server (the certificate is the instance key, which the other machine pinned from
// its invite code) and hands the decrypted connection to the HTTP server. Requests that arrive this
// way count as remote (no local sign-in, tokens required, INV-23).
import type { Server } from 'node:http';
import { createSecureContext, TLSSocket } from 'node:tls';
import { serverFingerprint } from '@quorum/core';
import { relayLinkUrl, webSocketStream } from '@quorum/local';
import type { ServerInstance } from '../local/instance.js';

export interface RelayHomeOptions {
  /** The relay, wss://host (ws:// only on loopback). */
  relay: string;
  instance: ServerInstance;
  /** Where decrypted connections go. */
  server: Server;
  /** Connections through the relay open at once. Default 64. */
  maxConnections?: number;
  /** New connections per other-machine address per minute. Default 60. */
  perClientPerMinute?: number;
}

export type RelayHomeState = 'connecting' | 'ready' | 'down';

export interface RelayHome {
  /** The address other machines use: quorum://<relay host>/<fingerprint>. */
  readonly linkUrl: string;
  state(): RelayHomeState;
  /** Resolves once the relay has accepted this server's proof (or rejects after `timeoutMs`). */
  ready(timeoutMs?: number): Promise<void>;
  /** Which other-machine address a connection came from, if it came through the relay. */
  clientOf(socket: unknown): string | undefined;
  close(): void;
}

export const connectRelayHome = (options: RelayHomeOptions): RelayHome => {
  const home = serverFingerprint(options.instance.publicKey);
  const identity = options.instance.tlsIdentity();
  const secureContext = createSecureContext({ ...identity, minVersion: 'TLSv1.3' });
  const clients = new WeakMap<object, string>();
  const maxConnections = options.maxConnections ?? 64;
  const perClient = options.perClientPerMinute ?? 60;
  const recent = new Map<string, { windowStart: number; count: number }>();
  let open = 0;
  let state: RelayHomeState = 'connecting';
  let closed = false;
  let control: WebSocket | undefined;
  let backoffMs = 1000;
  let retry: NodeJS.Timeout | undefined;
  let keepalive: NodeJS.Timeout | undefined;
  const waiters = new Set<() => void>();

  const allowed = (client: string): boolean => {
    const now = Date.now();
    const entry = recent.get(client);
    if (!entry || now - entry.windowStart >= 60_000) {
      if (recent.size > 10_000) recent.clear();
      recent.set(client, { windowStart: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= perClient;
  };

  const accept = (conn: string, client: string) => {
    if (open >= maxConnections || !allowed(client)) {
      control?.send(JSON.stringify({ type: 'refuse', conn }));
      return;
    }
    open += 1;
    let counted = true;
    const done = () => {
      if (counted) open -= 1;
      counted = false;
    };
    const ws = new WebSocket(`${options.relay}/v1/accept/${home}/${conn}`);
    ws.addEventListener('close', done);
    ws.addEventListener('open', () => {
      const tls = new TLSSocket(webSocketStream(ws), { isServer: true, secureContext });
      clients.set(tls, client);
      tls.on('error', () => {
        tls.destroy();
      });
      tls.on('close', done);
      // Only a finished handshake reaches the HTTP server.
      tls.once('secure', () => {
        options.server.emit('connection', tls);
      });
    });
  };

  const connect = () => {
    if (closed) return;
    state = 'connecting';
    const ws = new WebSocket(`${options.relay}/v1/home/${home}`);
    control = ws;
    ws.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (message.type === 'challenge' && typeof message.nonce === 'string') {
        ws.send(
          JSON.stringify({
            type: 'prove',
            public_key: options.instance.publicKey,
            signature: options.instance.relayProof(home, message.nonce),
          }),
        );
      } else if (message.type === 'ready') {
        state = 'ready';
        backoffMs = 1000;
        for (const wake of waiters) wake();
        waiters.clear();
      } else if (
        message.type === 'open' &&
        typeof message.conn === 'string' &&
        /^[A-Za-z0-9_-]{22}$/.test(message.conn)
      ) {
        accept(message.conn, typeof message.client === 'string' ? message.client : 'unknown');
      }
    });
    ws.addEventListener('close', () => {
      if (control === ws) control = undefined;
      clearInterval(keepalive);
      if (closed) return;
      state = 'down';
      retry = setTimeout(connect, backoffMs);
      retry.unref();
      backoffMs = Math.min(backoffMs * 2, 60_000);
    });
    ws.addEventListener('error', () => {
      // `close` follows and schedules the retry.
    });
    clearInterval(keepalive);
    // Keeps idle network paths (home routers, mobile hotspots) from dropping the connection.
    keepalive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, 25_000);
    keepalive.unref();
  };
  connect();

  return {
    linkUrl: relayLinkUrl(options.relay, home),
    state: () => state,
    ready: (timeoutMs = 10_000) =>
      state === 'ready'
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              waiters.delete(wake);
              reject(
                new Error(`The relay at ${options.relay} did not accept this server in time.`),
              );
            }, timeoutMs);
            const wake = () => {
              clearTimeout(timer);
              resolve();
            };
            waiters.add(wake);
          }),
    clientOf: (socket) =>
      typeof socket === 'object' && socket !== null ? clients.get(socket) : undefined,
    close: () => {
      closed = true;
      clearTimeout(retry);
      clearInterval(keepalive);
      control?.close(1000);
    },
  };
};
