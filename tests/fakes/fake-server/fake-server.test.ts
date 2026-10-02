// Behaviour of the fake beyond the contract suite: the parts adapters and the CLI use that the
// contract does not pin down (attach, token refresh, revocation, export).
import { parseJsonl, verifyChain } from '@quorum/core';
import { validateApiPayload } from '@quorum/schemas';
import { afterEach, describe, expect, it } from 'vitest';
import { call, ulid } from '../../contract/helpers.js';
import { type FakeServer, startFakeServer } from './fake-server.js';

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const setup = async () => {
  server = await startFakeServer();
  const human = server.addHuman('abhijna');
  const workspace = server.createWorkspace('demo');
  server.join(human.address, workspace);
  return { s: server, human, workspace };
};

const attach = async (baseUrl: string, token: string, workspace: string) => {
  const reply = await call(baseUrl, 'POST', '/v1/attachments', {
    token,
    body: { root: 'C:/work/api', vendor: 'claude-code', workspaces: [workspace] },
  });
  return reply;
};

describe('fake server', () => {
  it('attaches an agent and returns schema-valid credentials', async () => {
    const { s, human, workspace } = await setup();
    const reply = await attach(s.baseUrl, human.token, workspace);
    expect(reply.status).toBe(201);
    expect(validateApiPayload('attachmentCreated', reply.body).ok).toBe(true);
  });

  it('rotates refresh tokens and revokes the family when one is reused (INV-11)', async () => {
    const { s, human, workspace } = await setup();
    const created = (await attach(s.baseUrl, human.token, workspace)).body as {
      credentials: { refresh_token: string; access_token: string };
    };
    const first = await call(s.baseUrl, 'POST', '/v1/auth/refresh', {
      body: { refresh_token: created.credentials.refresh_token },
    });
    expect(first.status).toBe(200);
    const reuse = await call(s.baseUrl, 'POST', '/v1/auth/refresh', {
      body: { refresh_token: created.credentials.refresh_token },
    });
    expect(reuse.status).toBe(401);
    const after = await call(s.baseUrl, 'GET', `/v1/workspaces/${workspace}/inbox`, {
      token: (first.body as { access_token: string }).access_token,
    });
    expect(after.status).toBe(401);
  });

  it('stops accepting a revoked agent (INV-13)', async () => {
    const { s, human, workspace } = await setup();
    const created = (await attach(s.baseUrl, human.token, workspace)).body as {
      agent: { id: string };
      credentials: { access_token: string };
    };
    const inbox = `/v1/workspaces/${workspace}/inbox`;
    expect(
      (await call(s.baseUrl, 'GET', inbox, { token: created.credentials.access_token })).status,
    ).toBe(200);
    const revoke = await call(s.baseUrl, 'POST', `/v1/agents/${created.agent.id}/revoke`, {
      token: human.token,
    });
    expect(revoke.status).toBe(204);
    expect(
      (await call(s.baseUrl, 'GET', inbox, { token: created.credentials.access_token })).status,
    ).toBe(401);
  });

  it('exports a log that verifies as an unbroken hash chain (INV-8)', async () => {
    const { s, human, workspace } = await setup();
    const agent = s.addAgent('agent:a@abhijna', [workspace]);
    for (const text of ['one', 'two']) {
      await call(s.baseUrl, 'POST', `/v1/workspaces/${workspace}/messages`, {
        token: agent.token,
        body: {
          spec: 'quorum/1',
          id: `msg_${ulid()}`,
          workspace,
          from: agent.address,
          to: ['*'],
          type: 'note',
          type_version: 1,
          created_at: new Date().toISOString(),
          body: { text },
        },
      });
    }
    const exported = await call(s.baseUrl, 'GET', `/v1/workspaces/${workspace}/export`, {
      token: human.token,
    });
    expect(exported.status).toBe(200);
    const { values } = parseJsonl(exported.body as string);
    expect(values).toHaveLength(2);
    expect(verifyChain(workspace, values).ok).toBe(true);
  });
});
