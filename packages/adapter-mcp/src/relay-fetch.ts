// Reaching a home server through the relay (DECISIONS D-18, ARCHITECTURE §8.4). A server reached
// this way has an address like `quorum://relay.example/<fingerprint>`: requests to it go over a
// WebSocket to the relay, which pairs it with the home server's own, and inside that a TLS 1.3
// session straight to the home server. The certificate's key must have the fingerprint in the
// address, so the relay (or anyone in between) can neither read nor change the traffic; the
// identity handshake (INV-24) then runs inside as usual. Other addresses go to plain `fetch`.
import { Agent, request as httpRequest } from 'node:http';
import type { Duplex } from 'node:stream';
import { Readable } from 'node:stream';
import { connect as tlsConnect } from 'node:tls';
import { serverFingerprint } from '@quorum/core';
import { connectThroughRelay } from '@quorum/local';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A relayed address split up, or undefined when it is not one. */
export const parseRelayUrl = (
  text: string,
): { relay: string; home: string; path: string } | undefined => {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'quorum:' || !url.host) return undefined;
  const [, home, ...rest] = url.pathname.split('/');
  if (!home || !/^[A-Za-z0-9_-]{43}$/.test(home)) return undefined;
  return {
    relay: `${LOOPBACK.has(url.hostname) ? 'ws' : 'wss'}://${url.host}`,
    home,
    path: `/${rest.join('/')}${url.search}`,
  };
};

class PinnedKeyError extends Error {
  constructor(relay: string) {
    super(
      `The server reached through ${relay} does not hold the key in its address: it may be an impostor. Nothing was sent.`,
    );
    this.name = 'PinnedKeyError';
  }
}

/** One TLS session to `home` through `relay`, its key checked before anything is sent. */
const openTunnel = async (relay: string, home: string): Promise<Duplex> => {
  const stream = await connectThroughRelay(relay, home);
  return new Promise((resolve, reject) => {
    const tls = tlsConnect({ socket: stream, rejectUnauthorized: false, minVersion: 'TLSv1.3' });
    tls.once('secureConnect', () => {
      const key = tls.getPeerX509Certificate()?.publicKey.export({ format: 'jwk' });
      if (key?.crv !== 'Ed25519' || !key.x || serverFingerprint(key.x) !== home) {
        const error = new PinnedKeyError(relay);
        tls.destroy(error);
        reject(error);
        return;
      }
      tls.removeListener('error', reject);
      resolve(tls);
    });
    tls.once('error', reject);
  });
};

/** Keep-alive connections per relayed server, so a process pays the setup once. */
const agents = new Map<string, Agent>();

class RelayAgent extends Agent {
  constructor(
    readonly relay: string,
    readonly home: string,
  ) {
    super({ keepAlive: true, maxSockets: 4, timeout: 30_000 });
  }
  override createConnection(
    _options: unknown,
    callback?: (error: Error | null, socket: Duplex) => void,
  ): undefined {
    openTunnel(this.relay, this.home).then(
      (socket) => {
        callback?.(null, socket);
      },
      (error: unknown) => {
        callback?.(error instanceof Error ? error : new Error(String(error)), undefined as never);
      },
    );
    return undefined;
  }
}

const agentFor = (relay: string, home: string): Agent => {
  const key = `${relay}/${home}`;
  let agent = agents.get(key);
  if (!agent) agents.set(key, (agent = new RelayAgent(relay, home)));
  return agent;
};

/** Close kept-alive relay connections, so a short command can exit. */
export const closeRelayConnections = (): void => {
  for (const agent of agents.values()) agent.destroy();
  agents.clear();
};

const bodyOf = (body: RequestInit['body']): string | Buffer | undefined => {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError('Requests through the relay send text or bytes only.');
};

const relayed = (
  target: { relay: string; home: string; path: string },
  init: RequestInit | undefined,
): Promise<Response> =>
  new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const method = (init?.method ?? 'GET').toUpperCase();
    const request = httpRequest(
      {
        agent: agentFor(target.relay, target.home),
        method,
        path: target.path,
        headers: { ...headers, host: 'quorum.relay' },
        ...(init?.signal ? { signal: init.signal } : {}),
      },
      (response) => {
        const status = response.statusCode ?? 502;
        const responseHeaders = new Headers();
        const raw = response.rawHeaders;
        for (let i = 0; i + 1 < raw.length; i += 2) {
          responseHeaders.append(raw[i] as string, raw[i + 1] as string);
        }
        const empty = method === 'HEAD' || [204, 205, 304].includes(status);
        if (empty) response.resume();
        resolve(
          new Response(empty ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>), {
            status,
            statusText: response.statusMessage ?? '',
            headers: responseHeaders,
          }),
        );
      },
    );
    request.on('error', (error) => {
      // Like fetch: a network failure is a TypeError, the cause says why.
      reject(error.name === 'AbortError' ? error : new TypeError('fetch failed', { cause: error }));
    });
    request.end(bodyOf(init?.body));
  });

/** `fetch`, plus `quorum://` addresses through the relay. */
export const createQuorumFetch =
  (base: typeof fetch = fetch): typeof fetch =>
  (input, init) => {
    const text = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const target = parseRelayUrl(text);
    return target ? relayed(target, init) : base(input, init);
  };

export const quorumFetch: typeof fetch = createQuorumFetch();
