// Federation must respect revocation and route only unambiguous recipients (INV-7, INV-13, INV-34).
import { createIdFactory, newQuorumId } from '@quorum/core';
import type { PeerSession, QuorumIdCreated } from '@quorum/schemas';
import { afterEach, describe, expect, it } from 'vitest';
import { Registry } from '../src/index.js';
import { type Harness, startHarness } from './harness.js';

const open: Harness[] = [];
const start = async (options: Parameters<typeof startHarness>[0] = {}) => {
  const h = await startHarness(options);
  open.push(h);
  return h;
};

afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

const session = async (h: Harness, name: string) => {
  const human = await h.signIn();
  const created = await h.request('POST', '/v1/quorum-ids', {
    token: human.token,
    body: { vendor: 'claude-code', vendor_session_id: name, root: h.folder(name) },
  });
  expect(created.status).toBe(201);
  const result = created.body as QuorumIdCreated;
  const token = result.credentials?.access_token;
  if (!token) throw new Error('The new session did not receive credentials.');
  return { ...result, token, human, caller: h.quorum.authenticate(token) };
};

const remoteFace = (home: string, machine = 'other-laptop'): PeerSession => ({
  ...newQuorumId(home),
  tool: 'codex',
  machine,
  label: 'codex@web-1',
  path: '~/web',
});

const message = (from: string, to: string, text: string) => ({
  from,
  to,
  message: {
    id: createIdFactory().id('message'),
    type: 'note',
    type_version: 1,
    created_at: new Date().toISOString(),
    body: { text },
  },
});

const remoteHome = 'R'.repeat(43);

describe('federation respects agent revocation (INV-13)', () => {
  it('applies the per-agent message budget to incoming federation mail (INV-15)', async () => {
    const h = await start({ messagesPerMinute: 2 });
    const own = await session(h, 'limited');
    const from = remoteFace(remoteHome);
    h.quorum.receiveLink(remoteHome, { from, to: own.id });
    h.quorum.allowLinks(own.caller, { id: from.id });
    h.quorum.receiveMessage(remoteHome, message(from.id, own.id, 'one'));
    h.quorum.receiveMessage(remoteHome, message(from.id, own.id, 'two'));
    expect(() =>
      h.quorum.receiveMessage(remoteHome, message(from.id, own.id, 'over limit')),
    ).toThrow();
    expect(h.quorum.exportSession(own.caller)).not.toContain('over limit');
    h.advance(60_001);
    expect(() =>
      h.quorum.receiveMessage(remoteHome, message(from.id, own.id, 'after reset')),
    ).not.toThrow();
  });
  it.each(['local session', 'remote mirror'] as const)(
    'rejects messages after the %s is revoked, keeping earlier messages',
    async (revoked) => {
      const h = await start();
      const own = await session(h, 'inbox');
      const from = remoteFace(remoteHome);
      const registry = new Registry(h.db);
      h.quorum.receiveLink(remoteHome, { from, to: own.id });
      const linked = h.quorum.allowLinks(own.caller, { id: from.id });
      const workspace = linked.links[0]?.workspace;
      if (!workspace) throw new Error('The approved link has no workspace.');
      const before = message(from.id, own.id, 'before revocation');
      h.quorum.receiveMessage(remoteHome, before);

      const agent = revoked === 'local session' ? own.agent.id : registry.mirrorAgent(from.id)?.id;
      if (!agent) throw new Error('The linked session has no agent.');
      const result = await h.request('POST', `/v1/agents/${agent}/revoke`, {
        token: own.human.token,
      });
      expect(result.status).toBe(204);
      expect(() =>
        h.quorum.receiveMessage(remoteHome, message(from.id, own.id, 'after revocation')),
      ).toThrow();

      const history = await h.request('GET', `/v1/workspaces/${workspace}/export`, {
        token: own.human.token,
      });
      expect(history.status).toBe(200);
      expect(history.text).toContain('before revocation');
      expect(history.text).not.toContain('after revocation');
    },
  );

  it.each(['revoke', 'detach'] as const)(
    'refuses new requests and acceptance after the local session is disabled by %s',
    async (action) => {
      const from = remoteFace(remoteHome);
      const h = await start({
        federation: {
          lookup: () => Promise.resolve({ home: remoteHome, salt: from.salt }),
          flush: () => Promise.resolve('delivered'),
          queued: () => undefined,
        },
      });
      const own = await session(h, 'disabled');
      await h.quorum.requestLink(own.caller, { to: from.id });
      const result =
        action === 'revoke'
          ? await h.request('POST', `/v1/agents/${own.agent.id}/revoke`, {
              token: own.human.token,
            })
          : await h.request('DELETE', `/v1/attachments/${own.attachment ?? ''}`, {
              token: own.human.token,
            });
      expect(result.status).toBe(204);

      expect(() => h.quorum.receiveAccept(remoteHome, { from, to: own.id })).toThrow();
      expect(() => h.quorum.receiveLink(remoteHome, { from, to: own.id })).toThrow();
      const newPeer = remoteFace(remoteHome);
      expect(() => h.quorum.receiveLink(remoteHome, { from: newPeer, to: own.id })).toThrow();
      expect(new Registry(h.db).workspacesOf(own.agent.id)).toEqual([]);
    },
  );

  it('does not revive a revoked mirror through repeated requests or acceptances', async () => {
    const h = await start();
    const own = await session(h, 'mirror');
    const from = remoteFace(remoteHome);
    h.quorum.receiveLink(remoteHome, { from, to: own.id });
    h.quorum.allowLinks(own.caller, { id: from.id });
    const registry = new Registry(h.db);
    const mirror = registry.mirrorAgent(from.id);
    if (!mirror) throw new Error('The approved remote session has no mirror.');
    h.quorum.revokeAgent(h.quorum.authenticate(own.human.token), mirror.id);

    expect(() => h.quorum.receiveLink(remoteHome, { from, to: own.id })).toThrow();
    expect(() => h.quorum.receiveAccept(remoteHome, { from, to: own.id })).toThrow();
    expect(registry.agent(mirror.id)?.status).toBe('revoked');
  });

  it('returns no such ID when another local session tries to attach a revoked session', async () => {
    const h = await start();
    const a = await session(h, 'local-a');
    const b = await session(h, 'local-b');
    h.quorum.revokeAgent(h.quorum.authenticate(a.human.token), a.agent.id);
    const result = await h.request('POST', '/v1/links', { token: b.token, body: { to: a.id } });
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ error: { code: 'pairing.no_such_id' } });
  });
});

describe('recipient aliases cannot silently choose another linked session (INV-7, INV-34)', () => {
  it('rejects a shared short label and accepts a machine-qualified label or Quorum ID', async () => {
    const h = await start();
    const own = await session(h, 'sender');
    const a = remoteFace('A'.repeat(43), 'alpha');
    const b = remoteFace('B'.repeat(43), 'beta');
    for (const [home, from] of [
      ['A'.repeat(43), a],
      ['B'.repeat(43), b],
    ] as const) {
      h.quorum.receiveLink(home, { from, to: own.id });
      h.quorum.allowLinks(own.caller, { id: from.id });
    }

    const ambiguous = await h.request('POST', '/v1/links/send', {
      token: own.token,
      body: { to: ['codex@web-1'], type: 'note', body: { text: 'must not pick a laptop' } },
    });
    expect(ambiguous.status).toBe(400);
    expect(h.quorum.exportSession(own.caller)).not.toContain('must not pick a laptop');

    for (const to of ['codex@beta-web-1', 'codex@beta - ~/web - 1', b.id]) {
      const result = await h.request('POST', '/v1/links/send', {
        token: own.token,
        body: { to: [to], type: 'note', body: { text: 'specifically beta' } },
      });
      expect(result.status).toBe(201);
      expect(result.body).toMatchObject({ sent: [{ to: b.id }] });
    }
  });

  it('requires a Quorum ID when two peers claim the same machine and window label', async () => {
    const h = await start();
    const own = await session(h, 'namesake');
    const a = remoteFace('A'.repeat(43));
    const b = remoteFace('B'.repeat(43));
    for (const [home, from] of [
      ['A'.repeat(43), a],
      ['B'.repeat(43), b],
    ] as const) {
      h.quorum.receiveLink(home, { from, to: own.id });
      h.quorum.allowLinks(own.caller, { id: from.id });
    }
    const ambiguous = await h.request('POST', '/v1/links/send', {
      token: own.token,
      body: {
        to: ['codex@other-laptop - ~/web - 1'],
        type: 'note',
        body: { text: 'ambiguous sender line' },
      },
    });
    expect(ambiguous.status).toBe(400);
    const exact = await h.request('POST', '/v1/links/send', {
      token: own.token,
      body: { to: [b.id], type: 'note', body: { text: 'the intended session' } },
    });
    expect(exact.status).toBe(201);
    expect(exact.body).toMatchObject({ sent: [{ to: b.id }] });
  });
});
