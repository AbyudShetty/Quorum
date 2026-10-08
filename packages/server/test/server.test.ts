// The real server beyond the shared contract: security invariants, persistence and identity rules.
import { execFileSync } from 'node:child_process';
import { readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { type EventRecord, parseJsonl, verifyChain } from '@quorum/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type Harness, note, setUp, startHarness, ulid } from './harness.js';

const open: Harness[] = [];
const start = async (options: Parameters<typeof startHarness>[0] = {}) => {
  const harness = await startHarness(options);
  open.push(harness);
  return harness;
};
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close();
});

const windows = process.platform === 'win32';

/** The events of an export, failing on any malformed line. */
const eventsOf = (text: string): EventRecord[] => {
  const { values, problem } = parseJsonl(text);
  expect(problem).toBeUndefined();
  return values as EventRecord[];
};

describe('tokens (INV-11, INV-23)', () => {
  it('stores no token in the database, only hashes', async () => {
    const h = await start();
    const { a, human } = await setUp(h);
    const dump = h.db
      .prepare<[], { hash: string }>('SELECT hash FROM tokens')
      .all()
      .map((r) => r.hash);
    expect(dump.every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true);
    const file = readFileSync(join(h.dataDir, 'quorum.db'));
    for (const token of [a.token, a.refresh, human.token, human.refresh]) {
      expect(file.includes(Buffer.from(token))).toBe(false);
    }
  });

  it('rotates refresh tokens; reusing a rotated one revokes the whole family', async () => {
    const h = await start();
    const { a, workspace } = await setUp(h);
    const first = await h.request('POST', '/v1/auth/refresh', {
      body: { refresh_token: a.refresh },
    });
    expect(first.status).toBe(200);
    const pair = first.body as { access_token: string; refresh_token: string };
    const inbox = (token: string) =>
      h.request('GET', `/v1/workspaces/${workspace}/inbox`, { token }).then((r) => r.status);
    expect(await inbox(pair.access_token)).toBe(200);

    const reuse = await h.request('POST', '/v1/auth/refresh', {
      body: { refresh_token: a.refresh },
    });
    expect(reuse.status).toBe(401);
    expect((reuse.body as { error: { code: string } }).error.code).toBe('auth.refresh_reused');
    expect(await inbox(pair.access_token)).toBe(401);
    expect(await inbox(a.token)).toBe(401);
    const second = await h.request('POST', '/v1/auth/refresh', {
      body: { refresh_token: pair.refresh_token },
    });
    expect(second.status).toBe(401);
  });

  it('expires access tokens after an hour', async () => {
    const h = await start();
    const { a, workspace } = await setUp(h);
    h.advance(3_600_000);
    const reply = await h.request('GET', `/v1/workspaces/${workspace}/inbox`, { token: a.token });
    expect(reply.status).toBe(401);
  });

  it('never echoes a presented token in an error', async () => {
    const h = await start();
    const bogus = `qrm_at_${'Z'.repeat(43)}`;
    const reply = await h.request('GET', '/v1/workspaces', { token: bogus });
    expect(reply.status).toBe(401);
    expect(reply.text).not.toContain(bogus);
  });

  it('rate-limits requests without a token and repeated failed sign-ins (INV-23)', async () => {
    const h = await start({ openRequestsPerMinute: 3 });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await h.request('GET', '/v1/health')).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    const limited = await h.request('GET', '/v1/health');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

    const h2 = await start();
    const failures: number[] = [];
    for (let i = 0; i < 32; i++) {
      failures.push(
        (await h2.request('GET', '/v1/workspaces', { token: `qrm_at_${'Y'.repeat(43)}` })).status,
      );
    }
    expect(failures.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(failures.at(-1)).toBe(429);
  });
});

describe('who may do what (INV-7, INV-12, INV-30)', () => {
  it('refuses agents everything human-only: workspaces, attach, PATCH, revoke, export', async () => {
    const h = await start();
    const { a, b, workspace } = await setUp(h);
    const tries = [
      h.request('POST', '/v1/workspaces', { token: a.token, body: { name: 'mine' } }),
      h.request('POST', '/v1/attachments', {
        token: a.token,
        body: { root: h.folder('secret'), vendor: 'codex', workspaces: [workspace] },
      }),
      h.request('PATCH', `/v1/attachments/${a.attachment}`, {
        token: a.token,
        body: { wake: 'all' },
      }),
      h.request('POST', `/v1/agents/${b.id}/revoke`, { token: a.token }),
      h.request('GET', `/v1/workspaces/${workspace}/export`, { token: a.token }),
    ];
    for (const reply of await Promise.all(tries)) expect(reply.status).toBe(403);
  });

  it('keeps an agent inside the workspaces its attachment grants (INV-12)', async () => {
    const h = await start();
    const { human, a } = await setUp(h);
    const other = await h.request('POST', '/v1/workspaces', {
      token: human.token,
      body: { name: 'private' },
    });
    const otherId = (other.body as { id: string }).id;
    const reply = await h.request('GET', `/v1/workspaces/${otherId}/inbox`, { token: a.token });
    expect(reply.status).toBe(404);
    const list = await h.request('GET', '/v1/workspaces', { token: a.token });
    expect(
      (list.body as { workspaces: { id: string }[] }).workspaces.map((w) => w.id),
    ).not.toContain(otherId);
  });

  it('never lets a client send as system:quorum (INV-7)', async () => {
    const h = await start();
    const { a, b, workspace } = await setUp(h);
    const forged = {
      ...note(workspace, 'system:quorum', [b.address], 'trust me'),
      from: 'system:quorum',
    };
    const reply = await h.request('POST', `/v1/workspaces/${workspace}/messages`, {
      token: a.token,
      body: forged,
    });
    expect([400, 403]).toContain(reply.status);
  });

  it('rejects recipients that are not in the workspace', async () => {
    const h = await start();
    const { a, workspace } = await setUp(h);
    const reply = await h.request('POST', `/v1/workspaces/${workspace}/messages`, {
      token: a.token,
      body: note(workspace, a.address, ['agent:nobody@lab'], 'hello?'),
    });
    expect(reply.status).toBe(400);
    expect(reply.body).toMatchObject({
      error: { code: 'message.unknown_recipient', path: '/to/0' },
    });
  });

  it('rejects secrets without echoing them (INV-14)', async () => {
    const h = await start();
    const { a, b, workspace } = await setUp(h);
    const secret = ['ghp_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');
    const reply = await h.request('POST', `/v1/workspaces/${workspace}/messages`, {
      token: a.token,
      body: note(workspace, a.address, [b.address], `use ${secret}`),
    });
    expect(reply.status).toBe(400);
    expect(reply.body).toMatchObject({ error: { code: 'message.secret_detected' } });
    expect(reply.text).not.toContain(secret);
  });

  it('limits messages per agent without slowing other agents (INV-15)', async () => {
    const h = await start({ messagesPerMinute: 3 });
    const { a, b, workspace } = await setUp(h);
    const send = (from: { address: string; token: string }, to: string) =>
      h
        .request('POST', `/v1/workspaces/${workspace}/messages`, {
          token: from.token,
          body: note(workspace, from.address, [to], 'x'),
        })
        .then((r) => r.status);
    const fromA = [];
    for (let i = 0; i < 4; i++) fromA.push(await send(a, b.address));
    expect(fromA).toEqual([201, 201, 201, 429]);
    expect(await send(b, a.address)).toBe(201);
  });
});

describe('local requests (INV-26)', () => {
  it('rejects a foreign Host and a foreign Origin on writes', async () => {
    const h = await start();
    expect(
      (await h.request('GET', '/v1/health', { headers: { host: 'attacker.example:51234' } }))
        .status,
    ).toBe(403);
    const { human } = await setUp(h);
    const reply = await h.request('POST', '/v1/workspaces', {
      token: human.token,
      body: { name: 'x' },
      headers: { origin: 'https://attacker.example' },
    });
    expect(reply.status).toBe(403);
  });
});

describe('revocation (INV-13)', () => {
  it('stops the token and closes open streams at once', async () => {
    const h = await start();
    const { human, a, b, workspace } = await setUp(h);
    let closed = false;
    const received: unknown[] = [];
    h.quorum.subscribe({ kind: 'agent', id: b.id, address: b.address }, workspace, undefined, {
      send: (m) => received.push(m),
      close: () => {
        closed = true;
      },
    });
    await h.request('POST', `/v1/workspaces/${workspace}/messages`, {
      token: a.token,
      body: note(workspace, a.address, [b.address], 'live'),
    });
    expect(received).toHaveLength(1);
    const revoke = await h.request('POST', `/v1/agents/${b.id}/revoke`, { token: human.token });
    expect(revoke.status).toBe(204);
    expect(closed).toBe(true);
    const after = await h.request('GET', `/v1/workspaces/${workspace}/inbox`, { token: b.token });
    expect(after.status).toBe(401);
    const refresh = await h.request('POST', '/v1/auth/refresh', {
      body: { refresh_token: b.refresh },
    });
    expect(refresh.status).toBe(401);
  });
});

describe('the event log (INV-8)', () => {
  it('records every state change and the export verifies', async () => {
    const h = await start();
    const { human, a, b, workspace } = await setUp(h);
    await h.request('POST', `/v1/workspaces/${workspace}/messages`, {
      token: a.token,
      body: note(workspace, a.address, [b.address], 'hi'),
    });
    await h.request('POST', `/v1/workspaces/${workspace}/inbox/ack`, {
      token: b.token,
      body: { up_to: 99 },
    });
    await h.request('PATCH', `/v1/attachments/${b.attachment}`, {
      token: human.token,
      body: { wake: 'direct' },
    });
    const session = await h.request('POST', '/v1/sessions', {
      token: a.token,
      body: { vendor_session_id: 's1', root: h.folder('api') },
    });
    await h.request(
      'DELETE',
      `/v1/sessions/${(session.body as { session_id: string }).session_id}`,
      {
        token: a.token,
      },
    );
    await h.request('POST', `/v1/agents/${a.id}/revoke`, { token: human.token });
    await h.request('DELETE', `/v1/attachments/${b.attachment}`, { token: human.token });

    const exported = await h.request('GET', `/v1/workspaces/${workspace}/export`, {
      token: human.token,
    });
    expect(exported.status).toBe(200);
    expect(exported.headers['content-type']).toContain('application/x-ndjson');
    const events = eventsOf(exported.text);
    expect(verifyChain(workspace, events)).toMatchObject({ ok: true });
    expect(events.map((e) => e.kind)).toEqual([
      'workspace.created',
      'attachment.created',
      'attachment.created',
      'message.accepted',
      'inbox.acked',
      'attachment.updated',
      'session.started',
      'session.ended',
      'agent.revoked',
      'attachment.detached',
    ]);
    for (const token of [human.token, a.token, b.token, a.refresh]) {
      expect(exported.text).not.toContain(token);
    }
    // Attach events name the folder, never its full path.
    expect(exported.text).not.toContain(h.folder('api').replaceAll('\\', '\\\\'));
  });

  it('survives a restart: workspaces, messages, acks and tokens are all still there', async () => {
    const h = await start();
    const { a, b, workspace } = await setUp(h);
    const sent = await h.request('POST', `/v1/workspaces/${workspace}/messages`, {
      token: a.token,
      body: note(workspace, a.address, [b.address], 'before restart'),
    });
    await h.request('POST', `/v1/workspaces/${workspace}/messages`, {
      token: a.token,
      body: note(workspace, a.address, [b.address], 'second'),
    });
    await h.request('POST', `/v1/workspaces/${workspace}/inbox/ack`, {
      token: b.token,
      body: { up_to: (sent.body as { seq: number }).seq },
    });
    open.splice(open.indexOf(h), 1);
    const again = await h.restart();
    open.push(again);
    const inbox = await again.request('GET', `/v1/workspaces/${workspace}/inbox`, {
      token: b.token,
    });
    expect(inbox.status).toBe(200);
    const texts = (inbox.body as { messages: { body: { text: string } }[] }).messages.map(
      (m) => m.body.text,
    );
    expect(texts).toEqual(['second']);
  });

  it('keeps one message per id under concurrent retries (MESSAGE_SPEC §2.1.3)', async () => {
    const h = await start();
    const { a, b, workspace } = await setUp(h);
    const message = note(workspace, a.address, [b.address], 'once', `msg_${ulid()}`);
    const replies = await Promise.all(
      Array.from({ length: 5 }, () =>
        h.request('POST', `/v1/workspaces/${workspace}/messages`, {
          token: a.token,
          body: message,
        }),
      ),
    );
    expect(replies.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(new Set(replies.map((r) => (r.body as { seq: number }).seq)).size).toBe(1);
  });
});

describe('attach (ARCHITECTURE §12, D-12, INV-25)', () => {
  it('names agents after vendor and folder, and keeps the identity across detach and re-attach', async () => {
    const h = await start();
    const { human, a, attach, workspace } = await setUp(h);
    expect(a.address).toBe('agent:claude-api@lab');

    const again = await attach('api', 'claude-code');
    expect(again.id).toBe(a.id); // same folder, same vendor: same identity, fresh credentials
    expect(again.attachment).toBe(a.attachment);

    await h.request('DELETE', `/v1/attachments/${a.attachment}`, { token: human.token });
    const back = await attach('api', 'claude-code');
    expect(back.id).toBe(a.id);
    expect(back.attachment).not.toBe(a.attachment);
    const inbox = await h.request('GET', `/v1/workspaces/${workspace}/inbox`, {
      token: back.token,
    });
    expect(inbox.status).toBe(200);
  });

  it('gives a revoked agent a new identity when its folder is attached again', async () => {
    const h = await start();
    const { human, a, attach } = await setUp(h);
    await h.request('POST', `/v1/agents/${a.id}/revoke`, { token: human.token });
    const fresh = await attach('api', 'claude-code');
    expect(fresh.id).not.toBe(a.id);
    expect(fresh.address).toBe('agent:claude-api-2@lab');
  });

  it('refuses a missing folder and the data directory, however it is spelled (INV-25)', async () => {
    const h = await start();
    const { human, workspace } = await setUp(h);
    const attachRoot = (root: string) =>
      h.request('POST', '/v1/attachments', {
        token: human.token,
        body: { root, vendor: 'codex', workspaces: [workspace] },
      });
    expect((await attachRoot(join(h.dir, 'missing'))).body).toMatchObject({
      error: { code: 'attachment.root_missing' },
    });
    expect((await attachRoot(h.dataDir)).body).toMatchObject({
      error: { code: 'attachment.data_dir' },
    });
    expect((await attachRoot(h.dir)).body).toMatchObject({
      error: { code: 'attachment.data_dir' },
    });
    expect((await attachRoot(join(h.dataDir, 'local'))).body).toMatchObject({
      error: { code: 'attachment.data_dir' },
    });
    // A link to the data directory is the same folder.
    const link = join(h.dir, 'innocent-looking');
    if (windows)
      execFileSync('cmd', ['/c', 'mklink', '/J', link, h.dataDir], { windowsHide: true });
    else symlinkSync(h.dataDir, link);
    expect((await attachRoot(link)).body).toMatchObject({
      error: { code: 'attachment.data_dir' },
    });
  });
});

describe('presence and shared working trees (INV-28)', () => {
  it('does not warn about a session whose agent went silent', async () => {
    const h = await start();
    const { a, b } = await setUp(h);
    const root = h.folder('shared');
    const register = (token: string) =>
      h.request('POST', '/v1/sessions', { token, body: { vendor_session_id: ulid(), root } });
    await register(a.token);
    h.advance(91_000); // A never sent a heartbeat and its session is old: it is gone
    const second = await register(b.token);
    expect(second.body).toMatchObject({ shared_worktree_with: [] });
  });

  it('records online/offline transitions, not every heartbeat', async () => {
    const h = await start();
    const { human, a, workspace } = await setUp(h);
    const beat = () =>
      h.request('POST', `/v1/workspaces/${workspace}/messages`, {
        token: a.token,
        body: {
          ...note(workspace, a.address, ['*'], ''),
          type: 'heartbeat',
          body: { status: 'working', resources_in_use: [] },
        },
      });
    for (let i = 0; i < 3; i++) expect((await beat()).status).toBe(201);
    h.advance(100_000);
    h.quorum.sweepPresence();
    const exported = await h.request('GET', `/v1/workspaces/${workspace}/export`, {
      token: human.token,
    });
    const presence = eventsOf(exported.text)
      .filter((e) => e.kind === 'presence.changed')
      .map((e) => (e.payload as { presence: string }).presence);
    expect(presence).toEqual(['online', 'offline']);
  });
});

describe('wake decisions (INV-29)', () => {
  const wakeDirect = async (h: Harness) => {
    const setup = await setUp(h);
    await h.request('PATCH', `/v1/attachments/${setup.b.attachment}`, {
      token: setup.human.token,
      body: { wake: 'direct' },
    });
    return setup;
  };
  const ask = (h: Harness, workspace: string, token: string) =>
    h
      .request('POST', `/v1/workspaces/${workspace}/wake`, { token, body: {} })
      .then((r) => r.body as { wake: boolean; reason?: string; seq?: number });

  it('keeps the hourly budget across a restart (grants are in the log)', async () => {
    const h = await start({ wakesPerHour: 2 });
    const { a, b, workspace } = await wakeDirect(h);
    for (let i = 0; i < 2; i++) {
      await h.request('POST', `/v1/workspaces/${workspace}/messages`, {
        token: a.token,
        body: note(workspace, a.address, [b.address], `wake ${String(i)}`),
      });
      const granted = await ask(h, workspace, b.token);
      expect(granted, `round ${String(i)}`).toMatchObject({ wake: true });
      await h.request('POST', `/v1/workspaces/${workspace}/inbox/ack`, {
        token: b.token,
        body: { up_to: granted.seq },
      });
    }
    await h.request('POST', `/v1/workspaces/${workspace}/messages`, {
      token: a.token,
      body: note(workspace, a.address, [b.address], 'one too many'),
    });
    expect(await ask(h, workspace, b.token)).toEqual({ wake: false, reason: 'budget_exhausted' });

    open.splice(open.indexOf(h), 1);
    const again = await h.restart();
    open.push(again);
    expect(await ask(again, workspace, b.token)).toEqual({
      wake: false,
      reason: 'budget_exhausted',
    });
    again.advance(3_600_001); // an hour later the budget is free again (the access token too)
    const fresh = await again.request('POST', '/v1/auth/refresh', {
      body: { refresh_token: b.refresh },
    });
    const token = (fresh.body as { access_token: string }).access_token;
    expect(await ask(again, workspace, token)).toMatchObject({ wake: true });
  });

  it('pauses wakes in a thread of agents talking only to each other, until a human writes', async () => {
    const h = await start({ agentOnlyMessagesBeforePause: 2 });
    const { human, a, b, workspace } = await wakeDirect(h);
    const thread = `th_${ulid()}`;
    const say = (from: { address: string; token: string }, to: string, text: string) =>
      h.request('POST', `/v1/workspaces/${workspace}/messages`, {
        token: from.token,
        body: { ...note(workspace, from.address, [to], text), thread },
      });
    for (const text of ['one', 'two', 'three']) await say(a, b.address, text);
    expect(await ask(h, workspace, b.token)).toEqual({ wake: false, reason: 'thread_paused' });
    await say(human, b.address, 'carry on');
    expect((await ask(h, workspace, b.token)).wake).toBe(true);
  });
});

describe('one wake per message (INV-29)', () => {
  it('grants a message once, however many adapters ask, also after a restart', async () => {
    const h = await start();
    const { human, a, b, workspace } = await setUp(h);
    await h.request('PATCH', `/v1/attachments/${b.attachment}`, {
      token: human.token,
      body: { wake: 'direct' },
    });
    await h.request('POST', `/v1/workspaces/${workspace}/messages`, {
      token: a.token,
      body: note(workspace, a.address, [b.address], 'wake once'),
    });
    const ask = (harness: Harness) =>
      harness
        .request('POST', `/v1/workspaces/${workspace}/wake`, { token: b.token, body: {} })
        .then((r) => r.body as { wake: boolean; reason?: string });
    const answers = await Promise.all([ask(h), ask(h), ask(h)]);
    expect(answers.filter((x) => x.wake)).toHaveLength(1);
    expect(answers.filter((x) => !x.wake).every((x) => x.reason === 'no_mail')).toBe(true);
    open.splice(open.indexOf(h), 1);
    const again = await h.restart();
    open.push(again);
    expect(await ask(again)).toEqual({ wake: false, reason: 'no_mail' });
  });
});

describe('numbered sessions: one window, one label (MESSAGE_SPEC §1.1)', () => {
  const open = async (
    h: Harness,
    agent: { token: string },
    folder: string,
    vendorSession = ulid(),
  ): Promise<{ id: string; label: string }> => {
    const reply = await h.request('POST', '/v1/sessions', {
      token: agent.token,
      body: { vendor_session_id: vendorSession, root: h.folder(folder) },
    });
    const body = reply.body as { session_id: string; label: string };
    return { id: body.session_id, label: body.label };
  };
  const as = (agent: { token: string }, session?: { id: string }) => ({
    token: agent.token,
    ...(session ? { headers: { 'quorum-session': session.id } } : {}),
  });

  it('numbers windows per tool and folder; a resumed conversation keeps its number', async () => {
    const h = await start();
    const { a, b } = await setUp(h);
    const conversation = ulid();
    const w1 = await open(h, a, 'api', conversation);
    const w2 = await open(h, a, 'api');
    const codex = await open(h, b, 'web');
    expect([w1.label, w2.label, codex.label]).toEqual([
      'claude@api-1',
      'claude@api-2',
      'codex@web-1',
    ]);
    await h.request('DELETE', `/v1/sessions/${w1.id}`, { token: a.token });
    // A new conversation (e.g. after /clear) gets the next number, never a used one.
    expect((await open(h, a, 'api')).label).toBe('claude@api-3');
    // Resuming the first conversation gives its number back.
    expect((await open(h, a, 'api', conversation)).label).toBe('claude@api-1');
    // ...but not while a live window holds it.
    expect((await open(h, a, 'api', conversation)).label).toBe('claude@api-4');
    h.advance(91_000); // every window went silent: still no number is handed out twice
    expect((await open(h, a, 'api')).label).toBe('claude@api-5');
  });

  it('stamps the sending window, and ignores a session that is not the caller’s (INV-7)', async () => {
    const h = await start();
    const { a, b, workspace } = await setUp(h);
    const mine = await open(h, a, 'api');
    const theirs = await open(h, b, 'web');
    const send = (session: { id: string }, text: string) =>
      h.request('POST', `/v1/workspaces/${workspace}/messages`, {
        ...as(a, session),
        body: note(workspace, a.address, [b.address], text),
      });
    await send(mine, 'from my window');
    await send(theirs, 'borrowed header');
    const inbox = await h.request('GET', `/v1/workspaces/${workspace}/inbox`, { token: b.token });
    const messages = (
      inbox.body as { messages: { body: { text: string }; from_session?: unknown }[] }
    ).messages;
    expect(messages[0]?.from_session).toEqual({
      id: mine.id,
      label: 'claude@api-1',
      machine: 'lab',
      path: expect.stringMatching(/api$/) as unknown,
    });
    expect(messages[1]?.from_session).toBeUndefined();
  });

  it('starts a new window where the agent’s windows got to: no old mail again', async () => {
    const h = await start();
    const { a, b, workspace } = await setUp(h);
    const send = (text: string) =>
      h.request('POST', `/v1/workspaces/${workspace}/messages`, {
        token: b.token,
        body: note(workspace, b.address, [a.address], text),
      });
    const unread = async (session: { id: string }) => {
      const page = await h.request('GET', `/v1/workspaces/${workspace}/inbox`, as(a, session));
      return page.body as { messages: { body: { text: string } }[]; next_after: number };
    };
    const first = await open(h, a, 'api');
    await send('old one');
    await send('old two');
    const read = await unread(first);
    expect(read.messages.map((m) => m.body.text)).toEqual(['old one', 'old two']);
    await h.request('POST', `/v1/workspaces/${workspace}/inbox/ack`, {
      ...as(a, first),
      body: { up_to: read.next_after },
    });
    await h.request('DELETE', `/v1/sessions/${first.id}`, { token: a.token });
    await send('while no window was open'); // nobody read this one: the next window gets it
    const next = await open(h, a, 'api'); // e.g. after /clear
    await send('new');
    expect((await unread(next)).messages.map((m) => m.body.text)).toEqual([
      'while no window was open',
      'new',
    ]);
  });

  it('delivers a reply to that window only; the agent’s other window does not see it', async () => {
    const h = await start();
    const { a, b, workspace } = await setUp(h);
    const w1 = await open(h, a, 'api');
    const w2 = await open(h, a, 'api');
    const codex = await open(h, b, 'web');
    const reply = await h.request('POST', `/v1/workspaces/${workspace}/messages`, {
      ...as(b, codex),
      body: note(workspace, b.address, ['claude@api-2'], 'only for window 2'),
    });
    expect(reply.status).toBe(201);
    const texts = async (session?: { id: string }) => {
      const page = await h.request(
        'GET',
        `/v1/workspaces/${workspace}/inbox?after=0`,
        as(a, session),
      );
      return (page.body as { messages: { body: { text: string } }[] }).messages.map(
        (m) => m.body.text,
      );
    };
    expect(await texts(w2)).toEqual(['only for window 2']);
    expect(await texts(w1)).toEqual([]);
    expect(await texts()).toEqual(['only for window 2']); // the CLI, as the agent, sees all its mail
    const long = await h.request('POST', `/v1/workspaces/${workspace}/messages`, {
      ...as(b, codex),
      body: note(workspace, b.address, ['claude@lab-api-1'], 'long form'),
    });
    expect(long.status).toBe(201);
    expect(await texts(w1)).toEqual(['long form']);
    const gone = await h.request('POST', `/v1/workspaces/${workspace}/messages`, {
      ...as(b, codex),
      body: note(workspace, b.address, ['claude@api-7'], 'nobody'),
    });
    expect(gone.body).toMatchObject({
      error: { code: 'message.unknown_recipient', path: '/to/0' },
    });
  });

  it('keeps a read position and a wake per window', async () => {
    const h = await start();
    const { human, a, b, workspace } = await setUp(h);
    await h.request('PATCH', `/v1/attachments/${a.attachment}`, {
      token: human.token,
      body: { wake: 'direct' },
    });
    const w1 = await open(h, a, 'api');
    const w2 = await open(h, a, 'api');
    const sent = await h.request('POST', `/v1/workspaces/${workspace}/messages`, {
      token: b.token,
      body: note(workspace, b.address, [a.address], 'to the agent'),
    });
    const seq = (sent.body as { seq: number }).seq;
    await h.request('POST', `/v1/workspaces/${workspace}/inbox/ack`, {
      ...as(a, w1),
      body: { up_to: seq },
    });
    const unread = async (session: { id: string }) =>
      (
        (await h.request('GET', `/v1/workspaces/${workspace}/inbox`, as(a, session))).body as {
          messages: unknown[];
        }
      ).messages.length;
    expect(await unread(w1)).toBe(0);
    expect(await unread(w2)).toBe(1); // window 2 has not read it yet
    const wake = (session: { id: string }) =>
      h
        .request('POST', `/v1/workspaces/${workspace}/wake`, { ...as(a, session), body: {} })
        .then((r) => (r.body as { wake: boolean }).wake);
    expect(await wake(w2)).toBe(true);
    expect(await wake(w2)).toBe(false); // once per message per window
  });
});

describe('web UI sign-in: quorum ui → one-time link → session cookie (ARCHITECTURE §6, INV-21)', () => {
  const link = async (h: Harness, token: string) => {
    const reply = await h.request('POST', '/v1/auth/ui-link', { token });
    return { status: reply.status, body: reply.body as { code: string; path: string } };
  };
  const sessionOf = (reply: { headers: Record<string, unknown> }) =>
    /quorum_ui=(qrm_us_[A-Za-z0-9_-]{43})/.exec(String(reply.headers['set-cookie']))?.[1];

  it('gives a human a single-use link that opens a strict session cookie', async () => {
    const h = await start();
    const { human, a, workspace } = await setUp(h);
    expect((await link(h, a.token)).status).toBe(403); // agents cannot sign in to the UI
    const issued = await link(h, human.token);
    expect(issued.status).toBe(201);
    expect(issued.body.path).toBe(`/login?code=${issued.body.code}`);

    const opened = await h.request('GET', issued.body.path);
    expect(opened.status).toBe(303);
    expect(opened.headers.location).toBe('/');
    const cookie = String(opened.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect((await h.request('GET', issued.body.path)).status).toBe(401); // used up

    // The timeline, with message text escaped (INV-21).
    await h.request('POST', `/v1/workspaces/${workspace}/messages`, {
      token: a.token,
      body: note(workspace, a.address, ['*'], '<script>alert(1)</script> hello'),
    });
    const session = sessionOf(opened) ?? '';
    const page = await h.request('GET', '/', { headers: { cookie: `quorum_ui=${session}` } });
    expect(page.status).toBe(200);
    expect(String(page.headers['content-security-policy'])).toContain("script-src 'self'");
    const fragment = await h.request('GET', `/fragment/timeline?ws=${workspace}`, {
      headers: { cookie: `quorum_ui=${session}` },
    });
    expect(fragment.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt; hello');
    expect(fragment.text).not.toContain('<script>alert');
  });

  it('refuses pages without a session, but serves the vendored assets', async () => {
    const h = await start();
    await setUp(h);
    const page = await h.request('GET', '/');
    expect(page.status).toBe(401);
    expect(page.text).toContain('quorum ui');
    const forged = await h.request('GET', '/', {
      headers: { cookie: `quorum_ui=qrm_us_${'x'.repeat(43)}` },
    });
    expect(forged.status).toBe(401);
    expect((await h.request('GET', '/static/app.css')).status).toBe(200);
  });

  it('expires links after 60 s, and checks the Host like the API (INV-26)', async () => {
    const h = await start();
    const { human } = await setUp(h);
    const late = await link(h, human.token);
    h.advance(61_000);
    expect((await h.request('GET', late.body.path)).status).toBe(401);
    const rebound = await link(h, human.token);
    const evil = await h.request('GET', rebound.body.path, {
      headers: { host: 'evil.example:51234' },
    });
    expect(evil.status).not.toBe(303);
  });
});
