// Session pairing end to end (DECISIONS D-20, PAIRING.md): two real servers ("laptop A", "laptop
// B") and a real relay. Sessions get Quorum IDs, ask to link, the other side allows, messages flow
// both ways through the relay (TLS to pinned keys, each server proving its own key), blocks look
// like unknown IDs, detaching tells the other side, and a laptop that is off gets its mail later.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdFactory, newQuorumId, serverFingerprint } from '@quorum/core';
import { closeRelayConnections, createQuorumFetch, readBootstrapCode } from '@quorum/local';
import { type Relay, startRelay } from '@quorum/relay';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadOrCreateInstance, type LocalServer, startLocalServer } from '../src/index.js';

let relay: Relay;
let root: string;

interface Home {
  name: string;
  dataDir: string;
  server: LocalServer;
  human: string;
}

interface Session {
  home: Home;
  id: string;
  token: string;
  window: string;
}

const homes: Home[] = [];

const call = async (
  home: Home,
  method: string,
  path: string,
  options: { token?: string; session?: string; body?: unknown } = {},
) => {
  const response = await fetch(`${home.server.baseUrl}${path}`, {
    method,
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.session ? { 'quorum-session': options.session } : {}),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // markdown
  }
  return { status: response.status, body: body as Record<string, unknown> };
};

const startHome = async (name: string, dataDir = join(root, name)): Promise<Home> => {
  const server = await startLocalServer({
    dataDir,
    machine: name,
    relay: relay.url,
    idleShutdownMs: 0,
    federationIntervalMs: 100,
  });
  const code = (await readBootstrapCode(dataDir))?.code;
  const signIn = await fetch(`${server.baseUrl}/v1/auth/local-bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const human =
    signIn.status === 200
      ? ((await signIn.json()) as { credentials: { access_token: string } }).credentials
          .access_token
      : '';
  const home = { name, dataDir, server, human };
  homes.push(home);
  return home;
};

/** What `/quorum-id` does: the person (human token) gives a session its own agent and ID. */
const newSession = async (
  home: Home,
  vendor: 'claude-code' | 'codex',
  folder: string,
  vendorSession: string,
): Promise<Session> => {
  const dir = join(root, `${home.name}-projects`, folder);
  mkdirSync(dir, { recursive: true });
  const created = await call(home, 'POST', '/v1/quorum-ids', {
    token: home.human,
    body: { vendor, vendor_session_id: vendorSession, root: dir },
  });
  expect(created.status).toBe(201);
  const token = (created.body.credentials as { access_token: string }).access_token;
  const window = await call(home, 'POST', '/v1/sessions', {
    token,
    body: { vendor_session_id: vendorSession, root: dir },
  });
  expect(window.status).toBe(201);
  return { home, id: created.body.id as string, token, window: window.body.session_id as string };
};

const as = (s: Session, method: string, path: string, body?: unknown) =>
  call(s.home, method, path, {
    token: s.token,
    session: s.window,
    ...(body === undefined ? {} : { body }),
  });

const until = async <T>(read: () => Promise<T>, ok: (value: T) => boolean, what: string) => {
  let last: T | undefined;
  for (let i = 0; i < 300; i++) {
    last = await read();
    if (ok(last)) return last;
    await new Promise((done) => setTimeout(done, 30));
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)}`);
};

type LinkInfo = {
  id: string;
  state: string;
  tool: string;
  machine: string;
  label: string;
  workspace?: string;
};
const linksOf = async (s: Session) =>
  ((await as(s, 'GET', '/v1/links')).body.links ?? []) as LinkInfo[];

const inboxTexts = async (s: Session) => {
  const texts: string[] = [];
  for (const link of await linksOf(s)) {
    if (!link.workspace) continue;
    const page = await as(s, 'GET', `/v1/workspaces/${link.workspace}/inbox`);
    for (const m of (page.body.messages ?? []) as {
      body: { text?: string };
      from_session?: { label: string; machine: string };
    }[]) {
      texts.push(
        `${m.from_session ? `${m.from_session.label}@${m.from_session.machine}: ` : ''}${m.body.text ?? ''}`,
      );
    }
  }
  return texts;
};

/** The relay knows the ID (its home connected and registered it). */
const registered = (id: string) =>
  until(
    async () => (await fetch(`${relay.url.replace('ws://', 'http://')}/v1/lookup/${id}`)).status,
    (status) => status === 200,
    `${id} in the phone book`,
  );

let a: Home;
let b: Home;

beforeAll(async () => {
  relay = await startRelay({ port: 0, lookupsPerMinute: 10_000, perMinute: 10_000 });
  root = mkdtempSync(join(tmpdir(), 'quorum-pairing-'));
  a = await startHome('laptop-a');
  b = await startHome('laptop-b');
}, 60_000);

afterAll(async () => {
  closeRelayConnections();
  for (const home of homes) await home.server.close();
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

describe('session pairing across two laptops (D-20)', () => {
  let a1: Session;
  let b1: Session;

  it('a session gets a short, permanent Quorum ID, the same when it comes back', async () => {
    a1 = await newSession(a, 'claude-code', 'api', 'claude-session-1');
    b1 = await newSession(b, 'codex', 'web', 'codex-thread-1');
    expect(a1.id).toMatch(
      /^QRM-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/,
    );
    const again = await call(a, 'POST', '/v1/quorum-ids', {
      token: a.human,
      body: {
        vendor: 'claude-code',
        vendor_session_id: 'claude-session-1',
        root: join(root, 'laptop-a-projects', 'api'),
      },
    });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: a1.id, created: false });
    expect(again.body.credentials).toBeUndefined();
    await registered(a1.id);
    await registered(b1.id);
  }, 30_000);

  it('only an agent with a Quorum ID can link; a wrong ID is "no such ID"', async () => {
    const wrong = await as(a1, 'POST', '/v1/links', { to: 'QRM-0000-0000-0000' });
    expect(wrong.status).toBe(404);
    expect((wrong.body.error as { code: string }).code).toBe('pairing.no_such_id');
  });

  it('links after the other person allows it, then messages flow both ways', async () => {
    const asked = await as(a1, 'POST', '/v1/links', { to: b1.id });
    expect(asked.status).toBe(202);
    expect(asked.body).toEqual({ state: 'requested' });

    const waiting = await until(
      () => linksOf(b1),
      (l) => l[0]?.state === 'pending',
      'request at B',
    );
    expect(waiting[0]).toMatchObject({
      id: a1.id,
      tool: 'claude',
      machine: 'laptop-a',
      label: 'claude@api-1',
    });

    const allowed = await as(b1, 'POST', '/v1/links/allow', {});
    expect(allowed.status).toBe(200);
    await until(
      () => linksOf(a1),
      (l) => l[0]?.state === 'linked',
      'link at A',
    );
    expect((await linksOf(a1))[0]).toMatchObject({
      id: b1.id,
      tool: 'codex',
      machine: 'laptop-b',
      label: 'codex@web-1',
    });

    expect(
      (
        await as(a1, 'POST', '/v1/links/send', {
          to: [b1.id],
          type: 'note',
          body: { text: 'hello from A' },
        })
      ).status,
    ).toBe(201);
    await until(
      () => inboxTexts(b1),
      (t) => t.includes('claude@api-1@laptop-a: hello from A'),
      'mail at B',
    );

    // B replies the way an agent does: with the sender line it was shown.
    const sent = await as(b1, 'POST', '/v1/links/send', {
      to: [`claude@laptop-a - ${join(root, 'laptop-a-projects', 'api')} - 1`],
      type: 'note',
      body: { text: 'hello back from B' },
    });
    expect(sent.status).toBe(201);
    await until(
      () => inboxTexts(a1),
      (t) => t.includes('codex@web-1@laptop-b: hello back from B'),
      'mail at A',
    );
  }, 30_000);

  it('sends only to linked sessions', async () => {
    const stranger = await as(a1, 'POST', '/v1/links/send', {
      to: ['QRM-0000-0000-0000'],
      type: 'note',
      body: { text: 'x' },
    });
    expect(stranger.status).toBe(400);
    expect((stranger.body.error as { code: string }).code).toBe('message.unknown_recipient');
  });

  it('a blocked session gets "no such ID", exactly like an unknown one', async () => {
    const pest = await newSession(a, 'claude-code', 'other', 'claude-session-pest');
    await registered(pest.id);
    expect((await as(b1, 'POST', '/v1/links/block', { id: pest.id })).status).toBe(204);
    const blocked = await as(pest, 'POST', '/v1/links', { to: b1.id });
    const unknown = await as(pest, 'POST', '/v1/links', { to: 'QRM-0000-0000-0001' });
    expect(blocked.status).toBe(404);
    expect(blocked.body).toEqual(
      unknown.body.error
        ? {
            error: {
              ...unknown.body.error,
              message: (blocked.body.error as { message: string }).message,
            },
          }
        : unknown.body,
    );
    expect((blocked.body.error as { code: string }).code).toBe('pairing.no_such_id');
    expect(await linksOf(b1)).toHaveLength(1); // only A's session
  }, 30_000);

  it('mail for a laptop that is off waits, and arrives when it is back', async () => {
    await b.server.close();
    homes.splice(homes.indexOf(b), 1);
    const queued = await as(a1, 'POST', '/v1/links/send', {
      to: [b1.id],
      type: 'note',
      body: { text: 'while you were away' },
    });
    expect(queued.status).toBe(201);
    b = await startHome('laptop-b', b.dataDir);
    b1 = { ...b1, home: b };
    // A fresh window on the restarted server (the old one belonged to the closed process).
    const window = await call(b, 'POST', '/v1/sessions', {
      token: b1.token,
      body: { vendor_session_id: 'codex-thread-1', root: join(root, 'laptop-b-projects', 'web') },
    });
    b1 = { ...b1, window: window.body.session_id as string };
    await until(
      () => inboxTexts(b1),
      (t) => t.some((x) => x.endsWith('while you were away')),
      'late mail at B',
    );
  }, 60_000);

  it('detaching tells the other side; nobody is asked', async () => {
    expect((await as(a1, 'POST', '/v1/links/detach', { id: b1.id })).body).toEqual({
      detached: [b1.id],
    });
    expect(await linksOf(a1)).toEqual([]);
    await until(
      () => linksOf(b1),
      (l) => l.length === 0,
      'unlink at B',
    );
  }, 30_000);

  it("exports a session's conversations as Markdown", async () => {
    const exported = await as(a1, 'GET', '/v1/links/export');
    expect(exported.status).toBe(200);
    const text = exported.body as unknown as string;
    expect(text).toContain(`# Quorum: claude@api-1 (${a1.id})`);
    expect(text).toContain('> hello from A');
    expect(text).toContain('> hello back from B');
  });
});

describe('server to server is only for servers, for their own sessions (D-20)', () => {
  it('turns away a caller without a server key, and a session ID not derived from the caller', async () => {
    const target = await newSession(b, 'codex', 'guarded', 'codex-guarded');
    const face = (id: string, salt: string) => ({
      from: { id, salt, tool: 'claude', machine: 'laptop-x', path: '~/x', label: 'claude@x-1' },
      to: target.id,
    });
    // Straight to the loopback port: no relay, no server key.
    const real = newQuorumId(serverFingerprint(a.server.publicKey));
    const plain = await call(b, 'POST', '/v1/federation/link', { body: face(real.id, real.salt) });
    expect(plain.status).toBe(403);
    expect((plain.body.error as { code: string }).code).toBe('federation.peer_only');

    // Through the relay as laptop A's server, but claiming a session of another key.
    await registered(target.id);
    const instanceA = await loadOrCreateInstance(a.dataDir, createIdFactory());
    const asA = createQuorumFetch(fetch, { identity: instanceA.tlsIdentity() });
    const forged = newQuorumId('X'.repeat(43));
    const url = `quorum://127.0.0.1:${String(relay.port)}/${serverFingerprint(b.server.publicKey)}/v1/federation/link`;
    const post = (body: unknown) =>
      asA(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await post(face(forged.id, forged.salt))).status).toBe(404);
    // A's own derived ID is accepted (A's key really holds it).
    expect((await post(face(real.id, real.salt))).status).toBe(202);
  }, 30_000);
});

describe('two sessions on the same laptop (D-20)', () => {
  it('pair the same way, without the relay', async () => {
    const one = await newSession(a, 'claude-code', 'left', 'claude-left');
    const two = await newSession(a, 'codex', 'right', 'codex-right');
    expect((await as(one, 'POST', '/v1/links', { to: two.id })).body).toEqual({
      state: 'requested',
    });
    expect((await linksOf(two))[0]).toMatchObject({ id: one.id, state: 'pending' });
    // Attaching back is the same as allowing.
    expect((await as(two, 'POST', '/v1/links', { to: one.id })).body).toEqual({ state: 'linked' });
    expect((await linksOf(one))[0]).toMatchObject({ state: 'linked' });
    expect(
      (
        await as(one, 'POST', '/v1/links/send', {
          to: [two.id],
          type: 'note',
          body: { text: 'same laptop' },
        })
      ).status,
    ).toBe(201);
    expect(await inboxTexts(two)).toContain('claude@left-1@laptop-a: same laptop');
  });
});
