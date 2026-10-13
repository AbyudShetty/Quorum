// Both ends of a connection through the relay (DECISIONS D-18, ARCHITECTURE §8.4). The relay
// (@quorum/relay) pairs a WebSocket from another machine with one from the home server and passes
// binary frames between them; here such a WebSocket becomes a plain byte stream, on which the two
// ends run TLS keyed by the home server's identity (INV-24). The relay never sees inside.
import { Duplex } from 'node:stream';
import WebSocket, { type RawData } from 'ws';

/** The relay protocol (packages/relay/src/router.ts holds the relay's side). */
export const RELAY_PROTOCOL = 'quorum-relay/1';

/** The exact bytes a home server signs to prove its key to the relay. */
export const relayProofMessage = (home: string, nonce: string): Buffer =>
  Buffer.from(`${RELAY_PROTOCOL} home\n${home}\n${nonce}`, 'utf8');

/** The relay's own address checked: wss:// anywhere, ws:// only on this machine (tests, trials). */
export const checkRelayUrl = (text: string): { url: string } | { problem: string } => {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { problem: 'not a URL; expected wss://<relay host>' };
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback)) {
    return { problem: 'must start with wss:// (ws:// only for a relay on this machine)' };
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    return { problem: 'must be just wss://<host> or wss://<host>:<port>, with no path' };
  }
  return { url: `${url.protocol}//${url.host}` };
};

/** Writes are cut to this size; the relay passes frames up to 1 MiB. */
const FRAME_BYTES = 64 * 1024;
/** Above this much unsent data, writes wait. */
const HIGH_WATER_BYTES = 1024 * 1024;

/** A relay WebSocket (the `ws` library: unlike Node's built-in one it can be dropped at once). */
export type RelaySocket = WebSocket;

/** Open a WebSocket to the relay. */
export const openRelaySocket = (url: string): RelaySocket =>
  new WebSocket(url, { maxPayload: 2 * 1024 * 1024 });

const bytesOf = (data: RawData): Buffer =>
  Array.isArray(data)
    ? Buffer.concat(data)
    : data instanceof ArrayBuffer
      ? Buffer.from(data)
      : data;

/**
 * A WebSocket's binary frames as a byte stream (text frames are relay notices and are skipped).
 * Destroying the stream drops the connection at once instead of waiting for the other side to
 * acknowledge a close: a finished command (a vendor hook) must not stay alive for that.
 */
export const webSocketStream = (ws: RelaySocket): Duplex => {
  const stream = new Duplex({
    read() {
      // Frames are pushed as they arrive; a WebSocket offers no way to pause.
    },
    write(chunk: Buffer, _encoding, callback) {
      if (ws.readyState !== WebSocket.OPEN) {
        callback(new Error('The relay connection is closed.'));
        return;
      }
      for (let at = 0; at < chunk.length; at += FRAME_BYTES) {
        ws.send(chunk.subarray(at, at + FRAME_BYTES));
      }
      const drained = () => {
        if (ws.bufferedAmount > HIGH_WATER_BYTES && ws.readyState === WebSocket.OPEN) {
          setTimeout(drained, 5);
        } else callback();
      };
      drained();
    },
    final(callback) {
      ws.close(1000);
      callback();
    },
    destroy(error, callback) {
      ws.terminate();
      callback(error);
    },
  });
  ws.on('message', (data, isBinary) => {
    if (isBinary) stream.push(bytesOf(data));
  });
  ws.on('close', () => {
    stream.push(null);
  });
  ws.on('error', () => {
    stream.destroy(new Error('The relay connection failed.'));
  });
  return stream;
};

export class RelayError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'RelayError';
  }
}

const closeReason = (code: number, relay: string): string => {
  if (code === 4404) {
    return 'That Quorum server is not connected to the relay: is the home machine on, with `quorum remote enable` done there?';
  }
  if (code === 4429) return 'That Quorum server has too many open connections; try again shortly.';
  if (code === 4403) return 'That Quorum server refused the connection (too many from here?).';
  return `The relay at ${relay} closed the connection (${String(code)}).`;
};

/**
 * Ask the relay for `home` and wait until the home server has taken the connection. The stream
 * that comes back carries the TLS session to the home server (the caller checks its key).
 */
export const connectThroughRelay = (
  relay: string,
  home: string,
  timeoutMs = 10_000,
): Promise<Duplex> =>
  new Promise((resolve, reject) => {
    let ws: RelaySocket;
    try {
      ws = openRelaySocket(`${relay}/v1/connect/${home}`);
    } catch (error) {
      reject(new RelayError(`Cannot reach the relay at ${relay}: ${String(error)}`));
      return;
    }
    let settled = false;
    const fail = (error: RelayError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.terminate();
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(
        new RelayError(
          `No answer through the relay at ${relay} within ${String(timeoutMs / 1000)} s.`,
        ),
      );
    }, timeoutMs);
    const onMessage = (data: RawData, isBinary: boolean) => {
      if (isBinary || settled) return;
      let notice: unknown;
      try {
        notice = JSON.parse(bytesOf(data).toString('utf8'));
      } catch {
        return;
      }
      if ((notice as { type?: unknown }).type !== 'paired') return;
      settled = true;
      clearTimeout(timer);
      ws.off('message', onMessage);
      // Synchronously, so the first frames from the home server are not missed.
      resolve(webSocketStream(ws));
    };
    ws.on('message', onMessage);
    ws.on('close', (code) => {
      fail(new RelayError(closeReason(code, relay), code));
    });
    ws.on('error', () => {
      fail(new RelayError(`Cannot reach the relay at ${relay}.`));
    });
  });

/** The address other machines use for home `home` through `relay`: quorum://<relay host>/<home>. */
export const relayLinkUrl = (relay: string, home: string): string =>
  `quorum://${new URL(relay).host}/${home}`;
