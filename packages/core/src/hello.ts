// The server identity handshake (INV-24, ARCHITECTURE §6). The server signs, with its Ed25519
// instance key, "quorum/1 hello\n" + instance_id + "\n" + nonce. Clients (adapters, CLI) check
// the signature against the public key they pinned, before sending any credential.
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import type { HelloResponse } from '@quorum/schemas';

/** The exact bytes the server signs. */
export const helloMessage = (instanceId: string, nonce: string): Buffer =>
  Buffer.from(`quorum/1 hello\n${instanceId}\n${nonce}`, 'utf8');

/** A fresh 32-byte nonce, base64url. */
export const newHelloNonce = (): string => randomBytes(32).toString('base64url');

/**
 * True only if the response proves possession of the pinned key for this nonce.
 * Any mismatch — different key, instance, nonce or a bad signature — is false: the caller must
 * then abort without sending a credential, never fall back (INV-24).
 */
export const verifyHello = (
  pinnedPublicKey: string,
  nonce: string,
  response: HelloResponse,
): boolean => {
  if (response.public_key !== pinnedPublicKey) return false;
  try {
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: pinnedPublicKey },
      format: 'jwk',
    });
    return verify(
      null,
      helloMessage(response.instance_id, nonce),
      key,
      Buffer.from(response.signature, 'base64url'),
    );
  } catch {
    return false;
  }
};

/**
 * The server's key fingerprint (remote mode, INV-24): base64url SHA-256 of the 32 raw key bytes.
 * A join code or server link carries it, so the first contact can check the key it is shown.
 */
export const serverFingerprint = (publicKey: string): string =>
  createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('base64url');

/** What a server link or join code says: where the server is, its key, maybe a one-time secret. */
export interface ServerLink {
  /**
   * https://host[:port] (http only for this machine's loopback, for tests and trials), or
   * quorum://<relay host>/<fingerprint> for a server reached through the relay (D-18).
   */
  url: string;
  fingerprint: string;
  /** A join code's secret (`qrm_jc_…`); absent in a plain server link. */
  secret?: string;
}

const FINGERPRINT = /^[A-Za-z0-9_-]{43}$/;
const JOIN_SECRET = /^qrm_jc_[A-Za-z0-9_-]{43}$/;

/**
 * `https://host#k=<fingerprint>[&j=<join secret>]` (or `quorum://relay/<fingerprint>#k=…`): the
 * text people copy between machines.
 */
export const formatServerLink = (link: ServerLink): string =>
  `${link.url}#k=${link.fingerprint}${link.secret ? `&j=${link.secret}` : ''}`;

/** A server link or join code, or undefined when it is not one (wrong shape, wrong scheme). */
export const parseServerLink = (text: string): ServerLink | undefined => {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return undefined;
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const relayed = url.protocol === 'quorum:' && url.host !== '';
  if (!relayed && url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    return undefined;
  }
  if (url.username || url.password || url.search) return undefined;
  const path = url.pathname.replace(/\/$/, '');
  const params = new URLSearchParams(url.hash.slice(1));
  const fingerprint = params.get('k') ?? '';
  const secret = params.get('j') ?? undefined;
  if (!FINGERPRINT.test(fingerprint)) return undefined;
  if (secret !== undefined && !JOIN_SECRET.test(secret)) return undefined;
  // Through the relay, the path names the server: it must be the key the link pins.
  if (relayed ? path !== `/${fingerprint}` : path !== '') return undefined;
  const base = relayed ? `quorum://${url.host}/${fingerprint}` : url.origin;
  return { url: base, fingerprint, ...(secret ? { secret } : {}) };
};
