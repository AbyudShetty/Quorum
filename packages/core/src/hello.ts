// The server identity handshake (INV-24, ARCHITECTURE §6). The server signs, with its Ed25519
// instance key, "quorum/1 hello\n" + instance_id + "\n" + nonce. Clients (adapters, CLI) check
// the signature against the public key they pinned, before sending any credential.
import { createPublicKey, randomBytes, verify } from 'node:crypto';
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
