// The relay's whole job (DECISIONS D-18, ARCHITECTURE §8.4): pair a connection from another machine
// with the home server it asks for, and pass bytes between them. It never sees inside: the bytes are
// a TLS session between the two ends, keyed by the home server's identity key (INV-24). It stores
// nothing and keeps no history.
//
// Three kinds of WebSocket meet in a room (one room per home server):
//   home  the home server's control connection. It must prove it holds the key whose fingerprint
//         is the room's name, by signing a fresh challenge. Only one proven home per room.
//   b     a connection from another machine ("connect"). The relay tells the home about it.
//   a     the home's side of that one connection ("accept"), named by the connection id the relay
//         sent only to the proven home. Once a and b are paired, binary frames pass between them.
//
// Platform-neutral (Web Crypto only): the Node relay (`quorum relay`, src/node.ts) and the hosted
// one (a Cloudflare Durable Object per home, worker/) both drive it through `Room`.

export const RELAY_PROTOCOL = 'quorum-relay/1';
/** Largest frame passed on. The ends split their writes well below this. */
export const MAX_FRAME_BYTES = 1024 * 1024;
/** Open connections from other machines per home at once. */
export const MAX_CONNECTIONS_PER_HOME = 64;

/** A home's name: its key fingerprint (base64url SHA-256 of the raw Ed25519 key). */
export const HOME_ID = /^[A-Za-z0-9_-]{43}$/;
/** A connection id: 16 random bytes, base64url. */
export const CONN_ID = /^[A-Za-z0-9_-]{22}$/;

/** WebSocket close codes the relay uses (4000–4999 are free for applications). */
export const CLOSE = {
  replaced: 4000,
  protocol: 4400,
  unproven: 4401,
  refused: 4403,
  offline: 4404,
  full: 4429,
  tooBig: 1009,
} as const;

export type SocketMeta =
  | { kind: 'home'; home: string; nonce: string; proven: boolean }
  | { kind: 'b'; home: string; conn: string; paired: boolean }
  | { kind: 'a'; home: string; conn: string };

export interface RoomSocket {
  readonly meta: SocketMeta;
  setMeta(meta: SocketMeta): void;
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
}

export interface Room {
  /** Sockets in this room: all, one kind, or one kind of one connection. */
  sockets(filter?: { kind: SocketMeta['kind']; conn?: string }): RoomSocket[];
}

/** What to do with a new WebSocket: refuse it, or keep it with this meta, then greet and act. */
export type Arrival =
  | { refuse: { code: number; reason: string } }
  | { meta: SocketMeta; greet?: string; after?: () => void };

const encoder = new TextEncoder();

const base64url = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

const fromBase64url = (text: string): Uint8Array => {
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};

const randomId = (): string => base64url(crypto.getRandomValues(new Uint8Array(16)));

/** The exact bytes a home server signs to prove its key to the relay. */
export const homeProofMessage = (home: string, nonce: string): Uint8Array =>
  encoder.encode(`${RELAY_PROTOCOL} home\n${home}\n${nonce}`);

/** Does `publicKey` (raw Ed25519, base64url) have fingerprint `home` and sign the challenge? */
export const checkHomeProof = async (
  home: string,
  nonce: string,
  publicKey: string,
  signature: string,
): Promise<boolean> => {
  try {
    const raw = fromBase64url(publicKey);
    if (raw.length !== 32) return false;
    const fingerprint = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)));
    if (fingerprint !== home) return false;
    const key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      fromBase64url(signature),
      homeProofMessage(home, nonce),
    );
  } catch {
    return false;
  }
};

const provenHome = (room: Room): RoomSocket | undefined =>
  room.sockets({ kind: 'home' }).find((s) => s.meta.kind === 'home' && s.meta.proven);

/** A home server's control connection: challenge it first. */
export const arriveHome = (home: string): Arrival => {
  const nonce = randomId();
  return {
    meta: { kind: 'home', home, nonce, proven: false },
    greet: JSON.stringify({ type: 'challenge', protocol: RELAY_PROTOCOL, nonce }),
  };
};

/**
 * A connection from another machine. `client` is what the relay knows of it (its address), passed
 * to the home for rate limiting; the home decides whether to accept.
 */
export const arriveConnect = (room: Room, home: string, client: string): Arrival => {
  const target = provenHome(room);
  if (!target) {
    return { refuse: { code: CLOSE.offline, reason: 'That Quorum server is not connected.' } };
  }
  if (room.sockets({ kind: 'b' }).length >= MAX_CONNECTIONS_PER_HOME) {
    return { refuse: { code: CLOSE.full, reason: 'Too many open connections to that server.' } };
  }
  const conn = randomId();
  return {
    meta: { kind: 'b', home, conn, paired: false },
    after: () => {
      target.send(JSON.stringify({ type: 'open', conn, client: client.slice(0, 100) }));
    },
  };
};

/** The home's side of connection `conn`. Only the proven home was told the id. */
export const arriveAccept = (room: Room, home: string, conn: string): Arrival => {
  const waiting = room.sockets({ kind: 'b', conn })[0];
  if (
    !waiting ||
    waiting.meta.kind !== 'b' ||
    waiting.meta.paired ||
    room.sockets({ kind: 'a', conn }).length > 0
  ) {
    return { refuse: { code: CLOSE.offline, reason: 'No such connection.' } };
  }
  return {
    meta: { kind: 'a', home, conn },
    after: () => {
      waiting.setMeta({ kind: 'b', home, conn, paired: true });
      waiting.send(JSON.stringify({ type: 'paired' }));
    },
  };
};

const sizeOf = (data: string | Uint8Array): number =>
  typeof data === 'string' ? data.length : data.byteLength;

const parse = (data: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(data);
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

export const onMessage = async (
  room: Room,
  socket: RoomSocket,
  data: string | Uint8Array,
): Promise<void> => {
  if (sizeOf(data) > MAX_FRAME_BYTES) {
    socket.close(CLOSE.tooBig, 'Frame too large.');
    return;
  }
  const meta = socket.meta;
  if (meta.kind === 'home') {
    const message = typeof data === 'string' ? parse(data) : undefined;
    if (!message) {
      socket.close(CLOSE.protocol, 'The control connection carries JSON text only.');
      return;
    }
    if (!meta.proven) {
      const ok =
        message.type === 'prove' &&
        typeof message.public_key === 'string' &&
        typeof message.signature === 'string' &&
        (await checkHomeProof(meta.home, meta.nonce, message.public_key, message.signature));
      if (!ok) {
        socket.close(CLOSE.unproven, 'This server did not prove it holds the key it named.');
        return;
      }
      // This one is not proven yet, so only older proven connections are replaced (socket objects
      // need not be the same from one call to the next, e.g. after a Durable Object wakes).
      for (const other of room.sockets({ kind: 'home' })) {
        if (other.meta.kind === 'home' && other.meta.proven) {
          other.close(CLOSE.replaced, 'Replaced by a newer connection.');
        }
      }
      socket.setMeta({ ...meta, proven: true });
      socket.send(JSON.stringify({ type: 'ready' }));
      return;
    }
    if (message.type === 'refuse' && typeof message.conn === 'string') {
      for (const waiting of room.sockets({ kind: 'b', conn: message.conn })) {
        waiting.close(CLOSE.refused, 'The server refused this connection.');
      }
    } else if (message.type === 'ping') {
      socket.send(JSON.stringify({ type: 'pong' }));
    }
    return;
  }
  if (typeof data === 'string') return; // text frames on data connections carry nothing
  if (meta.kind === 'b' && !meta.paired) {
    socket.close(CLOSE.protocol, 'Wait for "paired" before sending.');
    return;
  }
  const partner = room.sockets({ kind: meta.kind === 'b' ? 'a' : 'b', conn: meta.conn })[0];
  if (partner) partner.send(data);
  else socket.close(1000, 'The other side has gone.');
};

export const onClose = (room: Room, socket: RoomSocket): void => {
  const meta = socket.meta;
  if (meta.kind === 'home') return; // open connections carry on; new ones wait for a new home
  for (const partner of room.sockets({ kind: meta.kind === 'b' ? 'a' : 'b', conn: meta.conn })) {
    partner.close(1000, 'The other side closed.');
  }
};
