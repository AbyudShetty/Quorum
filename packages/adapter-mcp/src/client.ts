// The /v1 client every adapter and the CLI use. Two rules matter most:
//  1. INV-24: no credential is sent until the server has proven, with a fresh nonce, that it
//     holds the key we pinned. A failed check throws IdentityError and never falls back.
//  2. INV-11: refresh tokens rotate; the new pair is stored before the old one is forgotten.
import {
  type Attachment,
  type AttachmentCreate,
  type AttachmentCreated,
  type AttachmentUpdate,
  type DeliveredEnvelope,
  type ErrorResponse,
  type HelloResponse,
  type InboxPage,
  type SubmittedEnvelope,
  type TokenPair,
  validateApiPayload,
} from '@quorum/schemas';
import { newHelloNonce, verifyHello } from '@quorum/core';
import { defaultDataDir, readDiscovery } from '@quorum/local';
import type { CredentialStore, StoredCredentials } from './credentials.js';

export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityError';
  }
}

/** The server could not be reached (not running, wrong port, network). Safe to retry later. */
export class UnreachableError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'UnreachableError';
  }
}

/** The server answered with an error (MESSAGE_SPEC §6). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fix: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Retrying the same request can never succeed (bad input, forbidden, conflict). */
  get permanent(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429 && this.status !== 401;
  }
}

export interface Target {
  baseUrl: string;
  /** Ed25519 public key to pin, base64url. */
  publicKey: string;
  /** When known (discovery file), the instance the key must belong to. */
  instanceId?: string;
}

export interface ConnectOptions {
  /** Explicit server (remote mode, tests). Otherwise the local discovery file is used. */
  target?: Target;
  dataDir?: string;
  /** Keychain entry holding this principal's tokens. */
  credentialKey: string;
  store: CredentialStore;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 60_000;

export const resolveTarget = async (dataDir: string): Promise<Target> => {
  const found = await readDiscovery(dataDir);
  if (!found) {
    throw new UnreachableError(
      'No local Quorum server is published. Start it with `quorum serve --local` (adapters normally start it for you).',
    );
  }
  return {
    baseUrl: `http://localhost:${String(found.port)}`,
    publicKey: found.public_key,
    instanceId: found.instance_id,
  };
};

/** One entry of `GET …/agents`. `folder` is the folder name only, never a path. */
export interface AgentEntry {
  id: string;
  address: string;
  vendor: string;
  folder?: string;
  presence: string;
  status?: string;
}

export class QuorumClient {
  readonly #target: Target;
  readonly #key: string;
  readonly #store: CredentialStore;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #credentials: StoredCredentials | undefined;
  #refreshing: Promise<StoredCredentials> | undefined;

  private constructor(
    target: Target,
    key: string,
    store: CredentialStore,
    fetchImpl: typeof fetch,
    now: () => number,
  ) {
    this.#target = target;
    this.#key = key;
    this.#store = store;
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  /** Find the server, verify its identity, and only then load credentials. */
  static async connect(options: ConnectOptions): Promise<QuorumClient> {
    const target = options.target ?? (await resolveTarget(options.dataDir ?? defaultDataDir()));
    const client = new QuorumClient(
      target,
      options.credentialKey,
      options.store,
      options.fetch ?? fetch,
      options.now ?? Date.now,
    );
    await client.#handshake();
    client.#credentials = await options.store.load(options.credentialKey);
    return client;
  }

  get baseUrl(): string {
    return this.#target.baseUrl;
  }

  async #handshake(): Promise<void> {
    const nonce = newHelloNonce();
    const response = await this.#raw('POST', '/v1/hello', { nonce });
    const body: unknown = await response.json().catch(() => undefined);
    const checked = validateApiPayload('helloResponse', body);
    if (!response.ok || !checked.ok) {
      throw new IdentityError(
        'The server at this address did not answer the identity check. No credential was sent.',
      );
    }
    const hello: HelloResponse = checked.value;
    const expectedInstance = this.#target.instanceId;
    if (
      (expectedInstance !== undefined && hello.instance_id !== expectedInstance) ||
      !verifyHello(this.#target.publicKey, nonce, hello)
    ) {
      throw new IdentityError(
        'The server did not prove it holds the pinned key: another program may be using this port. No credential was sent.',
      );
    }
  }

  async #raw(method: string, path: string, body?: unknown, token?: string): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    try {
      return await this.#fetch(`${this.#target.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new UnreachableError(
        `Cannot reach the Quorum server at ${this.#target.baseUrl}.`,
        error,
      );
    }
  }

  async #accessToken(): Promise<string> {
    const current = this.#credentials;
    if (!current) {
      throw new ApiError(
        401,
        'auth.no_credentials',
        'No stored credentials for this attachment.',
        'Run `quorum attach` in this folder.',
      );
    }
    if (this.#now() < current.access_expires_at - REFRESH_MARGIN_MS) return current.access_token;
    return (await this.#refresh()).access_token;
  }

  /** One refresh at a time: two concurrent ones would reuse the same refresh token (INV-11). */
  #refresh(): Promise<StoredCredentials> {
    this.#refreshing ??= (async () => {
      try {
        const current = this.#credentials;
        if (!current) throw new Error('no credentials to refresh');
        const response = await this.#raw('POST', '/v1/auth/refresh', {
          refresh_token: current.refresh_token,
        });
        const body: unknown = await response.json().catch(() => undefined);
        const checked = validateApiPayload('tokenPair', body);
        if (!response.ok || !checked.ok) {
          throw this.#toApiError(response.status, body);
        }
        const pair: TokenPair = checked.value;
        const next: StoredCredentials = {
          access_token: pair.access_token,
          refresh_token: pair.refresh_token,
          access_expires_at: this.#now() + pair.expires_in * 1000,
        };
        // Store first: if we crash now the rotated token is not lost.
        await this.#store.save(this.#key, next);
        this.#credentials = next;
        return next;
      } finally {
        this.#refreshing = undefined;
      }
    })();
    return this.#refreshing;
  }

  #toApiError(status: number, body: unknown): ApiError {
    const parsed = (body ?? {}) as Partial<ErrorResponse>;
    const e = parsed.error;
    return new ApiError(
      status,
      e?.code ?? 'server.unexpected',
      e?.message ?? `The server answered ${String(status)}.`,
      e?.fix ?? 'Try again; if it keeps failing, run `quorum status`.',
      e?.path,
    );
  }

  async #authenticated(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; text: string }> {
    const response = await this.#raw(method, path, body, await this.#accessToken());
    const text = await response.text();
    if (!response.ok) {
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        // Not JSON: toApiError falls back to a generic message.
      }
      throw this.#toApiError(response.status, parsed);
    }
    return { status: response.status, text };
  }

  /** An authenticated JSON call. Throws ApiError or UnreachableError. */
  async call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const { status, text } = await this.#authenticated(method, path, body);
    return { status, body: text ? (JSON.parse(text) as unknown) : undefined };
  }

  /** The workspace event log as JSON Lines (humans only), for `quorum verify`. */
  async exportEvents(workspace: string): Promise<string> {
    return (await this.#authenticated('GET', `/v1/workspaces/${workspace}/export`)).text;
  }

  /** Send a message. `duplicate` is true if the server already had it (same id, same content). */
  async send(
    workspace: string,
    envelope: SubmittedEnvelope,
  ): Promise<{ seq: number; duplicate: boolean }> {
    const reply = await this.call('POST', `/v1/workspaces/${workspace}/messages`, envelope);
    return { seq: (reply.body as { seq: number }).seq, duplicate: reply.status === 200 };
  }

  /**
   * Messages for the caller. Without `after` the server starts after the caller's last
   * acknowledged seq, so an adapter only has to ack what it has handed to its agent; `after: 0`
   * starts from the beginning.
   */
  async inbox(
    workspace: string,
    options: { after?: number; limit?: number } = {},
  ): Promise<InboxPage> {
    const query = new URLSearchParams({ limit: String(options.limit ?? 100) });
    if (options.after !== undefined) query.set('after', String(options.after));
    const reply = await this.call('GET', `/v1/workspaces/${workspace}/inbox?${query.toString()}`);
    return reply.body as InboxPage;
  }

  async ack(workspace: string, upTo: number): Promise<void> {
    await this.call('POST', `/v1/workspaces/${workspace}/inbox/ack`, { up_to: upTo });
  }

  async agents(workspace: string): Promise<AgentEntry[]> {
    const reply = await this.call('GET', `/v1/workspaces/${workspace}/agents`);
    return (reply.body as { agents: AgentEntry[] }).agents;
  }

  /**
   * Local mode: swap the one-time bootstrap code for the owner's human tokens and store them under
   * this client's credential key. The code goes only to a server that already passed the identity
   * check (INV-24). Throws ApiError (401 wrong/expired/used code, 404 remote mode).
   */
  async bootstrapLogin(code: string): Promise<{ id: string; address: string }> {
    const response = await this.#raw('POST', '/v1/auth/local-bootstrap', { code });
    const body: unknown = await response.json().catch(() => undefined);
    const checked = validateApiPayload('localBootstrapResponse', body);
    if (!response.ok || !checked.ok) throw this.#toApiError(response.status, body);
    const { human, credentials } = checked.value;
    const stored: StoredCredentials = {
      access_token: credentials.access_token,
      refresh_token: credentials.refresh_token,
      access_expires_at: this.#now() + credentials.expires_in * 1000,
    };
    await this.#store.save(this.#key, stored);
    this.#credentials = stored;
    return human;
  }

  /** Humans only. Credentials are returned once; the caller stores them (INV-11, INV-25). */
  async createAttachment(request: AttachmentCreate): Promise<AttachmentCreated> {
    const reply = await this.call('POST', '/v1/attachments', request);
    return reply.body as AttachmentCreated;
  }

  /** Humans only: change wake settings or lease enforcement. */
  async updateAttachment(id: string, change: AttachmentUpdate): Promise<Attachment> {
    const reply = await this.call('PATCH', `/v1/attachments/${id}`, change);
    return reply.body as Attachment;
  }

  async deleteAttachment(id: string): Promise<void> {
    await this.call('DELETE', `/v1/attachments/${id}`);
  }

  async workspaces(): Promise<{ id: string; name: string }[]> {
    const reply = await this.call('GET', '/v1/workspaces');
    return (reply.body as { workspaces: { id: string; name: string }[] }).workspaces;
  }

  async health(): Promise<{ status: string; version: string; instance_id: string }> {
    const response = await this.#raw('GET', '/v1/health');
    return (await response.json()) as { status: string; version: string; instance_id: string };
  }
}

export type { DeliveredEnvelope };
