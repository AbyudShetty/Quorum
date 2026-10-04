// An in-process server for tests: real service, real SQLite, real Fastify app, driven through
// app.inject (no sockets). Skips the data-directory ACL setup, which startLocalServer covers.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdFactory } from '@quorum/core';
import { readBootstrapCode } from '@quorum/local';
import type { FastifyInstance } from 'fastify';
import {
  type AppOptions,
  buildApp,
  type Db,
  LocalBootstrap,
  loadOrCreateInstance,
  openDatabase,
  Quorum,
  Registry,
  SqliteEventStore,
} from '../src/index.js';

export interface Reply {
  status: number;
  body: unknown;
  headers: Record<string, unknown>;
  text: string;
}

export interface Harness {
  dir: string;
  dataDir: string;
  db: Db;
  quorum: Quorum;
  app: FastifyInstance;
  /** Move the clock forward. */
  advance(ms: number): void;
  request(
    method: string,
    url: string,
    options?: { token?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<Reply>;
  /** Sign in the owner with the bootstrap code; returns the human access token. */
  signIn(): Promise<{ token: string; refresh: string; address: string }>;
  /** A folder that exists, under the test directory. */
  folder(name: string): string;
  /** Reopen service and app on the same database (a restart). */
  restart(): Promise<Harness>;
  close(): Promise<void>;
}

export const HOST = 'localhost:51234';

export const startHarness = async (
  overrides: Partial<Pick<AppOptions, 'openRequestsPerMinute'>> & {
    messagesPerMinute?: number;
    dir?: string;
    offset?: { ms: number };
  } = {},
): Promise<Harness> => {
  const dir = overrides.dir ?? mkdtempSync(join(tmpdir(), 'quorum-server-'));
  const dataDir = join(dir, 'data');
  mkdirSync(join(dataDir, 'local'), { recursive: true });
  const offset = overrides.offset ?? { ms: 0 };
  const clock = () => new Date(Date.now() + offset.ms);
  const db = openDatabase(join(dataDir, 'quorum.db'));
  const ids = createIdFactory();
  const instance = await loadOrCreateInstance(dataDir, ids);
  const quorum = await Quorum.open({
    db,
    registry: new Registry(db),
    store: new SqliteEventStore(db),
    ids,
    mode: 'local',
    dataDir,
    machine: 'lab',
    ownerName: 'owner',
    clock,
    ...(overrides.messagesPerMinute ? { messagesPerMinute: overrides.messagesPerMinute } : {}),
  });
  const bootstrap = new LocalBootstrap(dataDir, { now: clock });
  await bootstrap.issue();
  const app = buildApp({
    quorum,
    instance,
    version: 'test',
    mode: 'local',
    bootstrap,
    port: () => 51234,
    ...(overrides.openRequestsPerMinute
      ? { openRequestsPerMinute: overrides.openRequestsPerMinute }
      : {}),
  });
  await app.ready();

  const request: Harness['request'] = async (method, url, options = {}) => {
    const response = await app.inject({
      method: method as 'GET',
      url,
      headers: {
        host: HOST,
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { payload: JSON.stringify(options.body) }),
    });
    let body: unknown = response.body;
    try {
      body = response.body ? JSON.parse(response.body) : undefined;
    } catch {
      // not JSON
    }
    return { status: response.statusCode, body, headers: response.headers, text: response.body };
  };

  const harness: Harness = {
    dir,
    dataDir,
    db,
    quorum,
    app,
    advance: (ms) => {
      offset.ms += ms;
    },
    request,
    signIn: async () => {
      let code = (await readBootstrapCode(dataDir, clock()))?.code;
      if (!code) {
        await bootstrap.issue();
        code = (await readBootstrapCode(dataDir, clock()))?.code;
      }
      const reply = await request('POST', '/v1/auth/local-bootstrap', { body: { code } });
      if (reply.status !== 200) throw new Error(`sign-in failed: ${reply.text}`);
      const body = reply.body as {
        human: { address: string };
        credentials: { access_token: string; refresh_token: string };
      };
      return {
        token: body.credentials.access_token,
        refresh: body.credentials.refresh_token,
        address: body.human.address,
      };
    },
    folder: (name) => {
      const path = join(dir, 'folders', name);
      mkdirSync(path, { recursive: true });
      return path;
    },
    restart: async () => {
      await app.close();
      quorum.close();
      await bootstrap.discard();
      db.close();
      return startHarness({ ...overrides, dir, offset });
    },
    close: async () => {
      await app.close();
      quorum.close();
      await bootstrap.discard();
      if (db.open) db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return harness;
};

/** A workspace with two attached agents, ready for messaging. */
export const setUp = async (harness: Harness) => {
  const human = await harness.signIn();
  const ws = await harness.request('POST', '/v1/workspaces', {
    token: human.token,
    body: { name: 'lab' },
  });
  const workspace = (ws.body as { id: string }).id;
  const attach = async (folder: string, vendor: string, workspaces = [workspace]) => {
    const reply = await harness.request('POST', '/v1/attachments', {
      token: human.token,
      body: { root: harness.folder(folder), vendor, workspaces },
    });
    if (reply.status !== 201) throw new Error(`attach failed: ${reply.text}`);
    const body = reply.body as {
      attachment: { id: string };
      agent: { id: string; address: string };
      credentials: { access_token: string; refresh_token: string };
    };
    return {
      attachment: body.attachment.id,
      id: body.agent.id,
      address: body.agent.address,
      token: body.credentials.access_token,
      refresh: body.credentials.refresh_token,
    };
  };
  const a = await attach('api', 'claude-code');
  const b = await attach('web', 'codex');
  return { human, workspace, attach, a, b };
};

let counter = 0;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** A fresh, increasing ULID for message ids. */
export const ulid = (): string => {
  let time = Date.now();
  let head = '';
  for (let i = 0; i < 10; i++) {
    head = CROCKFORD.charAt(time % 32) + head;
    time = Math.floor(time / 32);
  }
  counter++;
  let tail = '';
  for (let i = 0, n = counter; i < 16; i++, n = Math.floor(n / 32)) {
    tail = CROCKFORD.charAt(n % 32) + tail;
  }
  return head + tail;
};

export const note = (workspace: string, from: string, to: string[], text: string, id?: string) => ({
  spec: 'quorum/1',
  id: id ?? `msg_${ulid()}`,
  workspace,
  from,
  to,
  type: 'note',
  type_version: 1,
  created_at: new Date().toISOString(),
  body: { text },
});
