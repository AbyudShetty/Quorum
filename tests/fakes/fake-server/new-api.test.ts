// The parts of /v1 added after the first contract freeze (bootstrap login, attachment PATCH, inbox
// default, agent folder, heartbeats). The shared contract suite does not cover them yet (see
// tests/contract/README.md "Not covered yet"); these tests keep the fake aligned with the OpenAPI
// document until the real server's cases land.
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapPath, readBootstrapCode } from '@quorum/local';
import { validateApiPayload } from '@quorum/schemas';
import { afterEach, describe, expect, it } from 'vitest';
import { call, ulid } from '../../contract/helpers.js';
import { type FakeServer, type FakeServerOptions, startFakeServer } from './fake-server.js';

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const start = async (options: FakeServerOptions = {}) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quorum-fake-'));
  server = await startFakeServer({ dataDir, ...options });
  return { s: server, dataDir };
};

const exchange = (s: FakeServer, code: string) =>
  call(s.baseUrl, 'POST', '/v1/auth/local-bootstrap', { body: { code } });

describe('POST /v1/auth/local-bootstrap', () => {
  it('writes a code on start and swaps it once for the owner human', async () => {
    const { s, dataDir } = await start();
    const file = await readBootstrapCode(dataDir);
    expect(file?.code).toMatch(/^qrm_bc_/);
    expect(validateApiPayload('localBootstrapFile', file).ok).toBe(true);

    const reply = await exchange(s, file?.code ?? '');
    expect(reply.status).toBe(200);
    expect(validateApiPayload('localBootstrapResponse', reply.body).ok).toBe(true);
    const { credentials } = reply.body as { credentials: { access_token: string } };
    const created = await call(s.baseUrl, 'POST', '/v1/workspaces', {
      token: credentials.access_token,
      body: { name: 'mine' },
    });
    expect(created.status).toBe(201); // a human token

    await expect(readFile(bootstrapPath(dataDir))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await exchange(s, file?.code ?? '')).status).toBe(401); // single use
  });

  it('refuses a wrong code, an expired code and a malformed one', async () => {
    let now = Date.now();
    const { s, dataDir } = await start({ clock: () => now });
    const code = (await readBootstrapCode(dataDir))?.code ?? '';
    expect((await exchange(s, `qrm_bc_${'A'.repeat(43)}`)).status).toBe(401);
    expect((await exchange(s, 'nope')).status).toBe(400);
    now += 11 * 60_000;
    const expired = await exchange(s, code);
    expect(expired.status).toBe(401);
    expect((expired.body as { error: { fix: string } }).error.fix).toContain('Restart');
  });

  it('gives a fresh code after a restart, and the old one stops working', async () => {
    const { s, dataDir } = await start();
    const first = (await readBootstrapCode(dataDir))?.code ?? '';
    await s.issueBootstrap();
    const second = (await readBootstrapCode(dataDir))?.code ?? '';
    expect(second).not.toBe(first);
    expect((await exchange(s, first)).status).toBe(401);
    expect((await exchange(s, second)).status).toBe(200);
  });

  it('answers 404 in remote mode', async () => {
    const { s } = await start({ localMode: false });
    expect((await exchange(s, `qrm_bc_${'A'.repeat(43)}`)).status).toBe(404);
  });
});

describe('attachments, inbox default, folder and heartbeats', () => {
  const setup = async (options: FakeServerOptions = {}) => {
    const { s } = await start(options);
    const human = s.addHuman('abhijna');
    const workspace = s.createWorkspace('demo');
    s.join(human.address, workspace);
    const attach = await call(s.baseUrl, 'POST', '/v1/attachments', {
      token: human.token,
      body: { root: 'C:/work/web-app', vendor: 'codex', workspaces: [workspace] },
    });
    const created = attach.body as {
      attachment: { id: string };
      agent: { address: string };
      credentials: { access_token: string };
    };
    return { s, human, workspace, created };
  };

  it('PATCH changes wake settings and returns the attachment', async () => {
    const { s, human, created } = await setup();
    const path = `/v1/attachments/${created.attachment.id}`;
    const reply = await call(s.baseUrl, 'PATCH', path, {
      token: human.token,
      body: { wake: 'direct', wake_types: ['request'], lease_enforcement: 'block' },
    });
    expect(reply.status).toBe(200);
    expect(validateApiPayload('attachment', reply.body).ok).toBe(true);
    expect(reply.body).toMatchObject({
      wake: 'direct',
      wake_types: ['request'],
      lease_enforcement: 'block',
    });
  });

  it('PATCH rejects unknown fields, an empty body, agents and unknown ids', async () => {
    const { s, human, created } = await setup();
    const path = `/v1/attachments/${created.attachment.id}`;
    expect(
      (await call(s.baseUrl, 'PATCH', path, { token: human.token, body: { root: 'C:/x' } })).status,
    ).toBe(400);
    expect((await call(s.baseUrl, 'PATCH', path, { token: human.token, body: {} })).status).toBe(
      400,
    );
    expect(
      (
        await call(s.baseUrl, 'PATCH', path, {
          token: created.credentials.access_token,
          body: { wake: 'all' },
        })
      ).status,
    ).toBe(403);
    const missing = `/v1/attachments/at_${'0'.repeat(26)}`;
    expect(
      (await call(s.baseUrl, 'PATCH', missing, { token: human.token, body: { wake: 'all' } }))
        .status,
    ).toBe(404);
  });

  it('inbox without `after` starts after the last acknowledged seq; after=0 starts at the beginning', async () => {
    const { s, workspace } = await setup();
    const a = s.addAgent('agent:a@lab', [workspace]);
    const b = s.addAgent('agent:b@lab', [workspace]);
    const send = async (text: string) =>
      (
        await call(s.baseUrl, 'POST', `/v1/workspaces/${workspace}/messages`, {
          token: a.token,
          body: {
            spec: 'quorum/1',
            id: `msg_${ulid()}`,
            workspace,
            from: a.address,
            to: [b.address],
            type: 'note',
            type_version: 1,
            created_at: new Date().toISOString(),
            body: { text },
          },
        })
      ).body as { seq: number };
    const first = await send('one');
    await send('two');
    const inbox = (query = '') =>
      call(s.baseUrl, 'GET', `/v1/workspaces/${workspace}/inbox${query}`, { token: b.token }).then(
        (r) =>
          (r.body as { messages: { body: { text: string } }[] }).messages.map((m) => m.body.text),
      );
    expect(await inbox()).toEqual(['one', 'two']);
    await call(s.baseUrl, 'POST', `/v1/workspaces/${workspace}/inbox/ack`, {
      token: b.token,
      body: { up_to: first.seq },
    });
    expect(await inbox()).toEqual(['two']);
    expect(await inbox('?after=0')).toEqual(['one', 'two']);
  });

  it('lists the folder name (never a path) and live status from heartbeats', async () => {
    let now = Date.now();
    const { s, human, workspace, created } = await setup({ clock: () => now });
    const agentsPath = `/v1/workspaces/${workspace}/agents`;
    const list = async () =>
      (
        (await call(s.baseUrl, 'GET', agentsPath, { token: human.token })).body as {
          agents: { address: string; folder?: string; presence: string; status?: string }[];
        }
      ).agents.find((a) => a.address === created.agent.address);

    const before = await list();
    expect(before).toMatchObject({ folder: 'web-app', presence: 'offline' });
    expect(JSON.stringify(before)).not.toContain('C:/');

    const beat = (status: string) =>
      call(s.baseUrl, 'POST', `/v1/workspaces/${workspace}/messages`, {
        token: created.credentials.access_token,
        body: {
          spec: 'quorum/1',
          id: `msg_${ulid()}`,
          workspace,
          from: created.agent.address,
          to: ['*'],
          type: 'heartbeat',
          type_version: 1,
          created_at: new Date().toISOString(),
          body: { status, resources_in_use: [] },
        },
      });

    expect((await beat('working')).status).toBe(201);
    expect(await list()).toMatchObject({ presence: 'online', status: 'working' });

    now += 89_000;
    expect(await list()).toMatchObject({ presence: 'online' });
    now += 2_000; // 91 s of silence
    expect(await list()).toMatchObject({ presence: 'offline', status: 'offline' });

    await beat('idle');
    expect(await list()).toMatchObject({ presence: 'online', status: 'idle' });
    await beat('offline'); // clean session end: offline at once, not after 90 s
    expect(await list()).toMatchObject({ presence: 'offline', status: 'offline' });
    expect(validateApiPayload('agentList', { agents: [await list()] }).ok).toBe(true);
  });
});
