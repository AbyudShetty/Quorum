// The server's Ed25519 instance key and identity (INV-24). Created once per data directory and
// kept in the private data directory (INV-25); the public key is what clients pin.
import { createPrivateKey, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { helloMessage, type IdFactory } from '@quorum/core';
import { writePrivateFile } from '@quorum/local';
import type { HelloResponse } from '@quorum/schemas';

export interface ServerInstance {
  instanceId: string;
  /** Ed25519 public key, base64url (the value clients pin). */
  publicKey: string;
  /** Answer POST /v1/hello for a client nonce. */
  hello(nonce: string): HelloResponse;
}

const KEY_FILE = 'instance.key';
const ID_FILE = 'instance.json';

const publicKeyOf = (privateKey: KeyObject): string => {
  const x = privateKey.export({ format: 'jwk' }).x;
  if (!x) throw new Error('instance key has no public part');
  return x;
};

const instanceFrom = (instanceId: string, privateKey: KeyObject): ServerInstance => ({
  instanceId,
  publicKey: publicKeyOf(privateKey),
  hello: (nonce) => ({
    instance_id: instanceId,
    public_key: publicKeyOf(privateKey),
    signature: sign(null, helloMessage(instanceId, nonce), privateKey).toString('base64url'),
  }),
});

/** Load the instance identity from `dir`, creating it on first start. `dir` must already be private. */
export const loadOrCreateInstance = async (
  dir: string,
  ids: IdFactory,
): Promise<ServerInstance> => {
  try {
    const { instance_id } = JSON.parse(await readFile(join(dir, ID_FILE), 'utf8')) as {
      instance_id: string;
    };
    const privateKey = createPrivateKey(await readFile(join(dir, KEY_FILE), 'utf8'));
    return instanceFrom(instance_id, privateKey);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const { privateKey } = generateKeyPairSync('ed25519');
  const instanceId = ids.ulid();
  // Key first, identity second: a crash in between leaves no identity file, so the next start
  // simply creates a new identity instead of pairing an ID with a missing key.
  await writePrivateFile(
    join(dir, KEY_FILE),
    privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  );
  await writePrivateFile(
    join(dir, ID_FILE),
    `${JSON.stringify({ instance_id: instanceId, public_key: publicKeyOf(privateKey) })}\n`,
  );
  return instanceFrom(instanceId, privateKey);
};
