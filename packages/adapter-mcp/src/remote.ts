// Talking to a Quorum server on another machine (Phase 1b, ARCHITECTURE §6, §8.3). Everything
// starts from a server link or join code (`https://host#k=<fingerprint>[&j=<code>]`): before any
// secret is sent, the server must prove it holds the key whose fingerprint the link carries
// (INV-24), and from then on that key is pinned, exactly like the discovery file pins the local
// server's key.
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { newHelloNonce, serverFingerprint, type ServerLink, verifyHello } from '@quorum/core';
import {
  type AttachmentCreated,
  type DeviceStarted,
  type JoinRequest,
  type LocalBootstrapResponse,
  validateApiPayload,
} from '@quorum/schemas';
import { writePrivateFile } from '@quorum/local';
import { ApiError, IdentityError, type Target, UnreachableError } from './client.js';
import { quorumFetch } from '@quorum/local';

/** A server on another machine, with the key this machine pinned for it. */
export interface RemoteServer {
  url: string;
  instance_id: string;
  public_key: string;
}

export const targetOf = (server: RemoteServer): Target => ({
  baseUrl: server.url,
  publicKey: server.public_key,
  instanceId: server.instance_id,
});

const TIMEOUT_MS = 15_000;

const post = async (
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> => {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new UnreachableError(`Cannot reach the Quorum server at ${new URL(url).origin}.`, error);
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed };
};

/** A refusal as an ApiError (the server's code, message and fix). */
const refused = (status: number, body: unknown): ApiError => {
  const error = (body as { error?: { code?: string; message?: string; fix?: string } } | undefined)
    ?.error;
  return new ApiError(
    status,
    error?.code ?? 'server.unexpected',
    error?.message ?? `The server answered ${String(status)}.`,
    error?.fix ?? 'Try again; if it keeps happening, check the server.',
  );
};

/**
 * Check the server behind a link: it must sign a fresh nonce with a key whose fingerprint the link
 * carries (INV-24). Nothing secret is sent before this succeeds; a mismatch throws IdentityError.
 */
export const pinServer = async (
  link: ServerLink,
  fetchImpl: typeof fetch = quorumFetch,
): Promise<RemoteServer> => {
  const nonce = newHelloNonce();
  const reply = await post(fetchImpl, `${link.url}/v1/hello`, { nonce });
  const checked = validateApiPayload('helloResponse', reply.body);
  if (reply.status !== 200 || !checked.ok) {
    throw new IdentityError(
      `${link.url} did not answer the identity check, so it may not be a Quorum server. Nothing was sent.`,
    );
  }
  const hello = checked.value;
  if (
    serverFingerprint(hello.public_key) !== link.fingerprint ||
    !verifyHello(hello.public_key, nonce, hello)
  ) {
    throw new IdentityError(
      `The server at ${link.url} does not hold the key in this link: it may be an impostor, or the link is from another server. Nothing was sent.`,
    );
  }
  return { url: link.url, instance_id: hello.instance_id, public_key: hello.public_key };
};

/** Spend a join code: check the server first, then attach a folder on this machine to it. */
export const joinServer = async (
  link: ServerLink,
  request: Omit<JoinRequest, 'code'>,
  fetchImpl: typeof fetch = quorumFetch,
): Promise<{ server: RemoteServer; created: AttachmentCreated }> => {
  if (!link.secret) throw new Error('This link has no join code (j=…).');
  const server = await pinServer(link, fetchImpl);
  const reply = await post(fetchImpl, `${server.url}/v1/join`, { ...request, code: link.secret });
  if (reply.status !== 201) throw refused(reply.status, reply.body);
  return { server, created: reply.body as AttachmentCreated };
};

/** Device sign-in, waiting side: the codes to show and to poll with. */
export const startDeviceLogin = async (
  server: RemoteServer,
  machine: string,
  fetchImpl: typeof fetch = quorumFetch,
): Promise<DeviceStarted> => {
  const reply = await post(fetchImpl, `${server.url}/v1/auth/device`, { machine });
  if (reply.status !== 201) throw refused(reply.status, reply.body);
  return reply.body as DeviceStarted;
};

/** One poll: the human and tokens once approved, `pending` before that. */
export const collectDeviceLogin = async (
  server: RemoteServer,
  deviceCode: string,
  fetchImpl: typeof fetch = quorumFetch,
): Promise<LocalBootstrapResponse | 'pending'> => {
  const reply = await post(fetchImpl, `${server.url}/v1/auth/device/token`, {
    device_code: deviceCode,
  });
  if (reply.status === 200) return reply.body as LocalBootstrapResponse;
  if (reply.status === 409) return 'pending';
  throw refused(reply.status, reply.body);
};

// --- which server this machine's human uses -------------------------------------------------

const remoteServerPath = (dataDir: string): string => join(dataDir, 'remote-server.json');

const isServer = (value: unknown): value is RemoteServer => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.url === 'string' &&
    /^https?:\/\//.test(v.url) &&
    typeof v.instance_id === 'string' &&
    typeof v.public_key === 'string'
  );
};

/**
 * Remember that this machine's human signs in to a server elsewhere (`quorum login <link>`). No
 * secrets: the tokens are in the keychain. Absent means the local server, as in Phase 1.
 */
export const saveRemoteServer = async (dataDir: string, server: RemoteServer): Promise<void> => {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writePrivateFile(remoteServerPath(dataDir), `${JSON.stringify(server, null, 2)}\n`);
};

export const loadRemoteServer = async (dataDir: string): Promise<RemoteServer | undefined> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(remoteServerPath(dataDir), 'utf8'));
    return isServer(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

export const removeRemoteServer = (dataDir: string): Promise<void> =>
  rm(remoteServerPath(dataDir), { force: true });

export const isRemoteServer = isServer;
