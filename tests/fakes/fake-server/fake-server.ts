// An in-memory /v1 server for Track B: adapters, CLI and UI are built against it before the real
// server exists. It must pass tests/contract (see contract.test.ts) so it cannot drift from the
// real one. It is a test double: no persistence, no rate limits, no policy engine.
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  acceptMessage,
  ackEvent,
  appendNew,
  canSee,
  createIdFactory,
  DomainError,
  helloMessage,
  MemoryEventStore,
  MessageLog,
  type Principal,
  type StoredMessage,
  folderName,
  generateToken,
  hashToken,
  pathKey,
  sharedWorktreeWith,
  systemNotice,
  tokenMatches,
  WakeGovernor,
} from '@quorum/core';
import { removeBootstrapCode, writeBootstrapCode } from '@quorum/local';
import {
  type ApiPayloadKind,
  type DeliveredEnvelope,
  type MessageType,
  validateApiPayload,
} from '@quorum/schemas';

const MAX_REQUEST_BYTES = 1024 * 1024;
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 24 * 3600;
const STATUS: Record<DomainError['kind'], number> = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  too_large: 413,
  rate_limited: 429,
};

interface Account extends Principal {
  id: string;
  vendor?: string;
  /** Folder name of the attached root (never a path). */
  folder?: string;
  revoked: boolean;
  workspaces: Set<string>;
}

interface Workspace {
  id: string;
  name: string;
  created_at: string;
  log: MessageLog;
}

interface Subscriber {
  account: Account;
  workspace: string;
  res: ServerResponse;
}

export interface FakeServerOptions {
  /** Reject requests whose Host is not this server's loopback address (INV-26). Default true. */
  localMode?: boolean;
  /** Address to bind. Default 127.0.0.1; the fleet's container uses 0.0.0.0 on a private network. */
  host?: string;
  /** Port to bind. Default: any free port. */
  port?: number;
  /**
   * Local-mode data directory. When given (and in local mode) the server writes a bootstrap code
   * to `<dataDir>/local/bootstrap.json`, like the real local server does on start.
   */
  dataDir?: string;
  /** Clock for presence (ms since epoch). Default Date.now. */
  clock?: () => number;
}

export interface FakeServer {
  baseUrl: string;
  instanceId: string;
  /** Ed25519 public key, base64url: what a client pins (INV-24). */
  publicKey: string;
  /** Create a human account and return its access token. */
  addHuman(name: string): { address: string; token: string };
  /** Create a workspace owned by nobody in particular: members are added with `join`. */
  createWorkspace(name: string): string;
  /** Create an agent account in the given workspaces and return its tokens. */
  addAgent(
    address: string,
    workspaces: string[],
    vendor?: string,
    folder?: string,
  ): { address: string; token: string; refreshToken: string };
  join(address: string, workspace: string): void;
  /**
   * Simulate an outage: `down` drops every connection at once (like a stopped server), `hang`
   * accepts requests and never answers (like a frozen one), `off` is normal service. State is kept.
   */
  setOutage(mode: 'off' | 'down' | 'hang'): void;
  /** Write a fresh bootstrap code, as a restarted local server does. Needs `dataDir`. */
  issueBootstrap(): Promise<void>;
  close(): Promise<void>;
}

export const startFakeServer = async (options: FakeServerOptions = {}): Promise<FakeServer> => {
  const localMode = options.localMode ?? true;
  const ids = createIdFactory();
  const store = new MemoryEventStore();
  const now = () => new Date().toISOString();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyB64 = publicKey.export({ format: 'jwk' }).x as string;
  const instanceId = ids.ulid();

  const workspaces = new Map<string, Workspace>();
  const accounts = new Map<string, Account>(); // by address
  const accessTokens = new Map<string, Account>(); // sha256(token) → account
  const refreshTokens = new Map<string, { account: Account; used: boolean }>();
  const subscribers = new Set<Subscriber>();
  interface AttachmentRecord {
    account: Account;
    id: string;
    root: string;
    vendor: string;
    workspaces: string[];
    wake: string;
    wake_types?: string[];
    lease_enforcement: string;
  }
  const attachments = new Map<string, AttachmentRecord>();
  const clock = options.clock ?? Date.now;
  /** Last heartbeat per agent: online for 90 s after it, or until it says offline. */
  const heartbeats = new Map<string, { at: number; status: string }>();
  /** Wake decisions as the real server makes them (INV-29); the fake does not persist grants. */
  const wakeGovernor = new WakeGovernor({ wakesPerHour: 20, agentOnlyMessagesBeforePause: 12 });
  const PRESENCE_TTL_MS = 90_000;
  let bootstrap: { hash: string; expiresAt: number; used: boolean } | undefined;
  let owner: Account | undefined;
  /** Live sessions: who, and in which working tree (INV-28). */
  const sessions = new Map<string, { account: Account; worktreeKey: string }>();
  /** Stable repository and worktree ids per canonical path, as the real server assigns them. */
  const repoIds = new Map<string, string>();
  const worktreeIds = new Map<string, string>();
  const stableId = (map: Map<string, string>, key: string, kind: 'repository' | 'worktree') => {
    const known = map.get(key);
    if (known) return known;
    const made = ids.id(kind);
    map.set(key, made);
    return made;
  };

  const publicAttachment = (a: AttachmentRecord) => ({
    id: a.id,
    root: a.root,
    vendor: a.vendor,
    workspaces: a.workspaces,
    wake: a.wake,
    ...(a.wake_types ? { wake_types: a.wake_types } : {}),
    lease_enforcement: a.lease_enforcement,
  });

  const issue = (account: Account) => {
    const access = generateToken('access');
    const refresh = generateToken('refresh');
    accessTokens.set(hashToken(access), account);
    refreshTokens.set(hashToken(refresh), { account, used: false });
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: 'Bearer' as const,
      expires_in: ACCESS_TTL_S,
      refresh_expires_in: REFRESH_TTL_S,
    };
  };

  const newAccount = (kind: 'agent' | 'human', address: string, vendor?: string): Account => {
    const account: Account = {
      kind,
      address,
      id: ids.id(kind === 'agent' ? 'agent' : 'human'),
      revoked: false,
      workspaces: new Set(),
      ...(vendor ? { vendor } : {}),
    };
    accounts.set(address, account);
    return account;
  };

  const makeWorkspace = (name: string): Workspace => {
    const ws: Workspace = {
      id: ids.id('workspace'),
      name,
      created_at: now(),
      log: new MessageLog(),
    };
    workspaces.set(ws.id, ws);
    return ws;
  };

  // --- helpers -------------------------------------------------------------------------------

  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_REQUEST_BYTES) {
        throw new DomainError(
          'too_large',
          'request.too_large',
          'The request is larger than 1 MiB.',
          'Put large content in an artifact.',
        );
      }
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new DomainError(
        'invalid',
        'request.bad_json',
        'The body is not valid JSON.',
        'Send JSON.',
      );
    }
  };

  const json = (res: ServerResponse, status: number, body?: unknown) => {
    if (body === undefined) {
      res.writeHead(status).end();
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };

  const authenticate = (req: IncomingMessage): Account => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const account = token ? accessTokens.get(hashToken(token)) : undefined;
    if (!account || account.revoked) {
      throw new DomainError(
        'unauthorized',
        'auth.invalid_token',
        'Missing, invalid or revoked token.',
        'Send "Authorization: Bearer <access token>"; refresh it at /v1/auth/refresh.',
      );
    }
    return account;
  };

  const member = (account: Account, workspaceId: string): Workspace => {
    const ws = workspaces.get(workspaceId);
    if (!ws) {
      throw new DomainError(
        'not_found',
        'workspace.not_found',
        'No such workspace.',
        'Check the id.',
      );
    }
    if (!account.workspaces.has(workspaceId)) {
      throw new DomainError(
        'forbidden',
        'workspace.not_member',
        'This token is not a member of that workspace.',
        'Attach to the workspace first.',
      );
    }
    return ws;
  };

  const requireHuman = (account: Account) => {
    if (account.kind !== 'human') {
      throw new DomainError(
        'forbidden',
        'auth.human_only',
        'Only humans may do this.',
        'Ask a human.',
      );
    }
  };

  const checkPayload = (kind: ApiPayloadKind, body: unknown) => {
    const result = validateApiPayload(kind, body);
    if (!result.ok) {
      const first = result.issues[0];
      throw new DomainError(
        'invalid',
        'request.invalid',
        `${first?.path || '(root)'} ${first?.message ?? 'is invalid'}`.trim(),
        'Fix the field at `path`.',
        first?.path ?? '',
      );
    }
    return result.value as unknown as Record<string, unknown>;
  };

  const sse = (res: ServerResponse, message: DeliveredEnvelope) => {
    res.write(`id: ${String(message.seq)}\nevent: message\ndata: ${JSON.stringify(message)}\n\n`);
  };

  const deliverLive = (workspace: string, stored: StoredMessage) => {
    const delivered = {
      ...stored.envelope,
      seq: stored.seq,
      received_at: stored.received_at,
      event: stored.event,
    } as DeliveredEnvelope;
    for (const sub of subscribers) {
      if (
        sub.workspace === workspace &&
        !sub.account.revoked &&
        canSee(sub.account.address, stored.envelope)
      ) {
        sse(sub.res, delivered);
      }
    }
  };

  // --- routes --------------------------------------------------------------------------------

  const route = async (req: IncomingMessage, res: ServerResponse, port: number) => {
    const url = new URL(req.url ?? '/', `http://localhost:${String(port)}`);
    const method = req.method ?? 'GET';
    const path = url.pathname;

    if (localMode) {
      const host = req.headers.host?.toLowerCase();
      const allowed = [
        `localhost:${String(port)}`,
        `127.0.0.1:${String(port)}`,
        `[::1]:${String(port)}`,
      ];
      if (!host || !allowed.includes(host)) {
        throw new DomainError(
          'forbidden',
          'request.foreign_host',
          'Foreign Host header.',
          `Use http://localhost:${String(port)}.`,
        );
      }
      const origin = req.headers.origin;
      if (
        method !== 'GET' &&
        origin !== undefined &&
        !allowed.some((h) => origin.toLowerCase() === `http://${h}`)
      ) {
        throw new DomainError(
          'forbidden',
          'request.foreign_origin',
          'Foreign Origin.',
          'Use the Quorum UI.',
        );
      }
    }

    if (method === 'GET' && path === '/v1/health') {
      json(res, 200, {
        status: 'ok',
        spec: 'quorum/1',
        version: '0.0.0-fake',
        instance_id: instanceId,
      });
      return;
    }

    if (method === 'POST' && path === '/v1/hello') {
      const body = checkPayload('helloRequest', await readBody(req)) as { nonce: string };
      const signature = sign(null, helloMessage(instanceId, body.nonce), privateKey).toString(
        'base64url',
      );
      json(res, 200, { instance_id: instanceId, public_key: publicKeyB64, signature });
      return;
    }

    if (method === 'POST' && path === '/v1/auth/refresh') {
      const body = checkPayload('tokenRefreshRequest', await readBody(req)) as {
        refresh_token: string;
      };
      const record = refreshTokens.get(hashToken(body.refresh_token));
      if (!record || record.used || record.account.revoked) {
        if (record?.used) record.account.revoked = true; // reuse: revoke the family (INV-11)
        throw new DomainError(
          'unauthorized',
          'auth.invalid_refresh',
          'Invalid refresh token.',
          'Attach again.',
        );
      }
      record.used = true;
      json(res, 200, issue(record.account));
      return;
    }

    if (method === 'POST' && path === '/v1/auth/local-bootstrap') {
      if (!localMode) {
        throw new DomainError(
          'not_found',
          'auth.bootstrap_unavailable',
          'Local bootstrap is only available in local mode.',
          'Sign in with a join code.',
        );
      }
      const body = checkPayload('localBootstrapRequest', await readBody(req)) as { code: string };
      const record = bootstrap;
      if (
        !record ||
        record.used ||
        clock() >= record.expiresAt ||
        !tokenMatches(body.code, record.hash)
      ) {
        throw new DomainError(
          'unauthorized',
          'auth.bootstrap_invalid',
          'This bootstrap code is wrong, expired or already used.',
          'Restart the local server to get a new code, then run `quorum login` again.',
        );
      }
      record.used = true;
      if (options.dataDir) await removeBootstrapCode(options.dataDir);
      owner ??= accounts.get('human:owner') ?? newAccount('human', 'human:owner');
      json(res, 200, {
        human: { id: owner.id, address: owner.address },
        credentials: issue(owner),
      });
      return;
    }

    // Everything below needs a token.
    const account = authenticate(req);

    if (method === 'GET' && path === '/v1/workspaces') {
      const list = [...account.workspaces]
        .map((id) => workspaces.get(id))
        .filter((w) => w !== undefined);
      json(res, 200, {
        workspaces: list.map(({ id, name, created_at }) => ({ id, name, created_at })),
      });
      return;
    }

    if (method === 'POST' && path === '/v1/workspaces') {
      requireHuman(account);
      const body = checkPayload('workspaceCreate', await readBody(req)) as { name: string };
      if ([...workspaces.values()].some((w) => w.name === body.name)) {
        throw new DomainError(
          'conflict',
          'workspace.exists',
          'A workspace with that name exists.',
          'Pick another name.',
        );
      }
      const ws = makeWorkspace(body.name);
      account.workspaces.add(ws.id);
      json(res, 201, { id: ws.id, name: ws.name, created_at: ws.created_at });
      return;
    }

    if (method === 'POST' && path === '/v1/attachments') {
      requireHuman(account);
      const body = checkPayload('attachmentCreate', await readBody(req)) as {
        root: string;
        vendor: string;
        workspaces: string[];
        agent_name?: string;
        wake?: string;
        wake_types?: string[];
        lease_enforcement?: string;
      };
      for (const id of body.workspaces) member(account, id);
      const taken = new Set([...accounts.keys()]);
      let name = body.agent_name ?? body.vendor.replaceAll(/[^a-z0-9]/g, '').slice(0, 20);
      for (let n = 2; taken.has(`agent:${name}@${account.address.slice(6)}`); n++)
        name = `${name}-${String(n)}`;
      const agent = newAccount('agent', `agent:${name}@${account.address.slice(6)}`, body.vendor);
      const folder = folderName(body.root);
      if (folder) agent.folder = folder;
      for (const id of body.workspaces) agent.workspaces.add(id);
      const attachmentId = ids.id('attachment');
      const record: AttachmentRecord = {
        account: agent,
        id: attachmentId,
        root: body.root,
        vendor: body.vendor,
        workspaces: body.workspaces,
        wake: body.wake ?? 'off',
        ...(body.wake_types ? { wake_types: body.wake_types } : {}),
        lease_enforcement: body.lease_enforcement ?? 'warn',
      };
      attachments.set(attachmentId, record);
      json(res, 201, {
        attachment: publicAttachment(record),
        agent: { id: agent.id, address: agent.address },
        credentials: issue(agent),
      });
      return;
    }

    let m = /^\/v1\/attachments\/(at_[0-9A-HJKMNP-TV-Z]{26})$/.exec(path);
    if (m && method === 'PATCH') {
      requireHuman(account);
      const attachment = attachments.get(m[1] ?? '');
      if (!attachment) {
        throw new DomainError(
          'not_found',
          'attachment.not_found',
          'No such attachment.',
          'Check the id.',
        );
      }
      const change = checkPayload('attachmentUpdate', await readBody(req)) as {
        wake?: string;
        wake_types?: string[];
        lease_enforcement?: string;
      };
      if (change.wake !== undefined) attachment.wake = change.wake;
      if (change.wake_types !== undefined) attachment.wake_types = change.wake_types;
      if (change.lease_enforcement !== undefined) {
        attachment.lease_enforcement = change.lease_enforcement;
      }
      json(res, 200, publicAttachment(attachment));
      return;
    }
    if (m && method === 'DELETE') {
      requireHuman(account);
      const attachment = attachments.get(m[1] ?? '');
      if (!attachment)
        throw new DomainError(
          'not_found',
          'attachment.not_found',
          'No such attachment.',
          'Check the id.',
        );
      attachment.account.revoked = true;
      attachments.delete(m[1] ?? '');
      json(res, 204);
      return;
    }

    if (method === 'POST' && path === '/v1/sessions') {
      if (account.kind !== 'agent') {
        throw new DomainError(
          'forbidden',
          'auth.agent_only',
          'Only agents open sessions.',
          'Use an agent token.',
        );
      }
      const body = checkPayload('sessionCreate', await readBody(req)) as {
        root: string;
        git?: { common_dir: string; worktree_root: string };
      };
      const platform = process.platform === 'win32' ? 'win32' : 'posix';
      // The working tree is the git worktree root, or the attached folder outside git.
      const worktreeKey = pathKey(body.git?.worktree_root ?? body.root, platform);
      const sessionId = ids.id('session');
      const live = [...sessions.values()].map((s) => ({
        agent: s.account.address,
        worktreeKey: s.worktreeKey,
      }));
      const sharedWith = sharedWorktreeWith({ agent: account.address, worktreeKey }, live);
      sessions.set(sessionId, { account, worktreeKey });
      // INV-28: every agent in the working tree gets a shared_worktree notice, like the real server.
      if (sharedWith.length > 0) {
        const everyone = [account.address, ...sharedWith];
        for (const address of everyone) {
          const target = accounts.get(address);
          const wsId = target ? [...target.workspaces][0] : undefined;
          const targetWs = wsId === undefined ? undefined : workspaces.get(wsId);
          if (!targetWs) continue;
          const others = everyone.filter((a) => a !== address);
          const { event } = systemNotice({
            workspace: targetWs.id,
            to: [address],
            kind: 'shared_worktree',
            text: `${others.join(', ')} working in the same folder as ${address}.`,
            details: { agents: everyone },
            now: now(),
            ids,
          });
          const [appended] = await appendNew(store, targetWs.id, [event]);
          if (!appended) continue;
          targetWs.log.apply(appended);
          const stored = targetWs.log.byId((event.payload.envelope as { id: string }).id);
          if (stored) deliverLive(targetWs.id, stored);
        }
      }
      json(res, 201, {
        session_id: sessionId,
        agent: { id: account.id, address: account.address },
        ...(body.git
          ? {
              repo: stableId(repoIds, pathKey(body.git.common_dir, platform), 'repository'),
              worktree: stableId(worktreeIds, worktreeKey, 'worktree'),
            }
          : {}),
        shared_worktree_with: sharedWith,
      });
      return;
    }

    m = /^\/v1\/sessions\/(sess_[0-9A-HJKMNP-TV-Z]{26})$/.exec(path);
    if (m && method === 'DELETE') {
      if (sessions.get(m[1] ?? '')?.account !== account) {
        throw new DomainError(
          'not_found',
          'session.not_found',
          'No such session.',
          'Check the id.',
        );
      }
      sessions.delete(m[1] ?? '');
      json(res, 204);
      return;
    }

    m = /^\/v1\/agents\/(ag_[0-9A-HJKMNP-TV-Z]{26})\/revoke$/.exec(path);
    if (m && method === 'POST') {
      requireHuman(account);
      const target = [...accounts.values()].find((a) => a.id === m?.[1]);
      if (!target)
        throw new DomainError('not_found', 'agent.not_found', 'No such agent.', 'Check the id.');
      target.revoked = true;
      for (const sub of subscribers) if (sub.account === target) sub.res.end(); // INV-13
      json(res, 204);
      return;
    }

    m = /^\/v1\/workspaces\/(ws_[0-9A-HJKMNP-TV-Z]{26})\/(.+)$/.exec(path);
    if (!m)
      throw new DomainError(
        'not_found',
        'route.not_found',
        'No such route.',
        'See openapi.v1.json.',
      );
    const ws = member(account, m[1] ?? '');
    const rest = m[2] ?? '';
    const principal: Principal = { kind: account.kind, address: account.address };

    if (method === 'POST' && rest === 'messages') {
      const outcome = acceptMessage(ws.log, {
        workspace: ws.id,
        principal,
        input: await readBody(req),
        now: now(),
        ids,
      });
      if (outcome.outcome === 'duplicate') {
        const { envelope, seq, received_at, event } = outcome.original;
        json(res, 200, { id: envelope.id, seq, received_at, event });
        return;
      }
      if (outcome.outcome === 'presence') {
        heartbeats.set(account.address, { at: clock(), status: outcome.envelope.body.status });
        json(res, 201, {
          id: outcome.envelope.id,
          seq: (await store.head(ws.id))?.seq ?? 1,
          received_at: now(),
          event: ids.id('event'),
          flags: ['presence_only'],
        });
        return;
      }
      const [event] = await appendNew(store, ws.id, [outcome.event]);
      if (!event) throw new Error('append returned no event');
      ws.log.apply(event);
      const stored = ws.log.byId(outcome.envelope.id);
      if (stored) deliverLive(ws.id, stored);
      json(res, 201, {
        id: outcome.envelope.id,
        seq: event.seq,
        received_at: event.ts,
        event: event.ev_id,
      });
      return;
    }

    if (method === 'GET' && rest === 'inbox') {
      // Without `after` the inbox starts after the caller's last acknowledged seq.
      const afterParam = url.searchParams.get('after');
      const page = ws.log.inbox(account.address, {
        after: afterParam === null ? ws.log.ackedUpTo(account.address) : Number(afterParam),
        limit: Number(url.searchParams.get('limit') ?? 100),
      });
      json(res, 200, page);
      return;
    }

    if (method === 'POST' && rest === 'inbox/ack') {
      const body = checkPayload('ackRequest', await readBody(req)) as { up_to: number };
      const [event] = await appendNew(store, ws.id, [ackEvent(principal, body.up_to, now(), ids)]);
      if (event) ws.log.apply(event);
      json(res, 204);
      return;
    }

    if (method === 'GET' && rest === 'stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': open\n\n');
      const last = Number(req.headers['last-event-id'] ?? NaN);
      const after = Number.isInteger(last) ? last : ((await store.head(ws.id))?.seq ?? 0);
      for (const message of ws.log.inbox(account.address, { after, limit: 500 }).messages)
        sse(res, message);
      const sub: Subscriber = { account, workspace: ws.id, res };
      subscribers.add(sub);
      req.on('close', () => subscribers.delete(sub));
      return;
    }

    m = /^threads\/(th_[0-9A-HJKMNP-TV-Z]{26})\/messages$/.exec(rest);
    if (method === 'GET' && m) {
      json(res, 200, ws.log.thread(m[1] ?? '', account.address, { limit: 500 }));
      return;
    }

    if (method === 'POST' && rest === 'wake') {
      if (account.kind !== 'agent') {
        throw new DomainError(
          'forbidden',
          'auth.agent_only',
          'Only agents ask to be woken.',
          'Use an agent token.',
        );
      }
      const body = checkPayload('wakeRequest', (await readBody(req)) ?? {}) as { after?: number };
      const attachment = [...attachments.values()].find((a) => a.account === account);
      if (!attachment || attachment.wake === 'off') {
        json(res, 200, { wake: false, reason: 'mode_off' });
        return;
      }
      const pending = ws.log.inbox(account.address, {
        after: body.after ?? ws.log.ackedUpTo(account.address),
        limit: 500,
      }).messages;
      if (pending.length === 0) {
        json(res, 200, { wake: false, reason: 'no_mail' });
        return;
      }
      let reason = 'own_message';
      for (const message of pending) {
        const decision = wakeGovernor.decide(
          account.address,
          message,
          {
            mode: attachment.wake as 'direct' | 'all',
            ...(attachment.wake_types ? { types: attachment.wake_types as MessageType[] } : {}),
          },
          clock(),
        );
        if (decision.wake) {
          json(res, 200, { wake: true, message: message.id, seq: message.seq });
          return;
        }
        reason = decision.reason;
      }
      json(res, 200, { wake: false, reason });
      return;
    }

    if (method === 'GET' && rest === 'agents') {
      const agents = [...accounts.values()]
        .filter((a) => a.kind === 'agent' && a.workspaces.has(ws.id) && !a.revoked)
        .map((a) => {
          const beat = heartbeats.get(a.address);
          const beatLive =
            beat !== undefined && beat.status !== 'offline' && clock() - beat.at < PRESENCE_TTL_MS;
          const online = beatLive || [...subscribers].some((s) => s.account === a);
          return {
            id: a.id,
            address: a.address,
            vendor: a.vendor ?? 'generic',
            ...(a.folder ? { folder: a.folder } : {}),
            presence: online ? 'online' : 'offline',
            ...(beat ? { status: beatLive ? beat.status : 'offline' } : {}),
            ...(beat ? { last_seen: new Date(beat.at).toISOString() } : {}),
          };
        });
      json(res, 200, { agents });
      return;
    }

    if (method === 'GET' && rest === 'export') {
      requireHuman(account);
      const events = await store.read(ws.id, { limit: 100_000 });
      res
        .writeHead(200, { 'content-type': 'application/x-ndjson' })
        .end(events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
      return;
    }

    throw new DomainError('not_found', 'route.not_found', 'No such route.', 'See openapi.v1.json.');
  };

  let outage: 'off' | 'down' | 'hang' = 'off';
  const server: Server = createServer((req, res) => {
    if (outage === 'down') {
      req.socket.destroy();
      return;
    }
    if (outage === 'hang') return; // never answered; closed when the server stops
    const port = (server.address() as AddressInfo).port;
    route(req, res, port).catch((error: unknown) => {
      if (error instanceof DomainError) {
        json(res, STATUS[error.kind], error.toResponse());
        return;
      }
      json(res, 500, {
        error: {
          code: 'server.internal',
          message: String(error),
          fix: 'This is a fake-server bug.',
        },
      });
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve),
  );
  const port = (server.address() as AddressInfo).port;

  const issueBootstrap = async (): Promise<void> => {
    if (!options.dataDir || !localMode) return;
    const code = generateToken('bootstrap');
    const expiresAt = clock() + 600_000;
    bootstrap = { hash: hashToken(code), expiresAt, used: false };
    // The real server creates its private data directory first; a test double only needs it to exist.
    await mkdir(join(options.dataDir, 'local'), { recursive: true });
    await writeBootstrapCode(options.dataDir, {
      code,
      expires_at: new Date(expiresAt).toISOString(),
    });
  };
  await issueBootstrap();

  return {
    baseUrl: `http://localhost:${String(port)}`,
    instanceId,
    publicKey: publicKeyB64,
    addHuman(name) {
      const account = newAccount('human', `human:${name}`);
      return { address: account.address, token: issue(account).access_token };
    },
    createWorkspace: (name) => makeWorkspace(name).id,
    addAgent(address, workspaceIds, vendor, folder) {
      const account = newAccount('agent', address, vendor);
      if (folder) account.folder = folder;
      for (const id of workspaceIds) account.workspaces.add(id);
      const tokens = issue(account);
      return { address, token: tokens.access_token, refreshToken: tokens.refresh_token };
    },
    join(address, workspace) {
      accounts.get(address)?.workspaces.add(workspace);
    },
    issueBootstrap: () => issueBootstrap(),
    setOutage(mode) {
      outage = mode;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const sub of subscribers) sub.res.end();
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
};
