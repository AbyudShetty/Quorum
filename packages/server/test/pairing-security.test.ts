// Pairing authorization and failure boundaries (INV-8, INV-12, INV-20, INV-30, INV-34).
import { createIdFactory, newQuorumId } from '@quorum/core';
import type { PeerSession, QuorumIdCreated } from '@quorum/schemas';
import { afterEach, describe, expect, it } from 'vitest';
import { Registry } from '../src/index.js';
import { type Harness, note, startHarness } from './harness.js';

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
  const input = { vendor: 'claude-code', vendor_session_id: name, root: h.folder(name) };
  const result = await h.request('POST', '/v1/quorum-ids', { token: human.token, body: input });
  expect(result.status).toBe(201);
  const created = result.body as QuorumIdCreated;
  const token = created.credentials?.access_token;
  expect(token).toBeDefined();
  return { ...created, token: token as string, human, input };
};

const peer = 'A'.repeat(43);
const remoteFace = (): PeerSession => ({
  ...newQuorumId(peer),
  tool: 'codex',
  machine: 'other-laptop',
  label: 'codex@project-1',
  path: '~/project',
});

describe('pairing approval boundaries (INV-34)', () => {
  it.each(['pending', 'linked'] as const)(
    'preserves a %s link created during a phone-book lookup',
    async (state) => {
      const from = remoteFace();
      let finish!: (value: { home: string; salt: string }) => void;
      const lookup = new Promise<{ home: string; salt: string }>((resolve) => {
        finish = resolve;
      });
      const h = await start({
        federation: {
          lookup: () => lookup,
          flush: () => Promise.resolve('delivered'),
          queued: () => undefined,
        },
      });
      const own = await session(h, 'lookup-race');
      const caller = h.quorum.authenticate(own.token);
      const asking = h.quorum.requestLink(caller, { to: from.id });
      h.quorum.receiveLink(peer, { from, to: own.id });
      if (state === 'linked') h.quorum.allowLinks(caller, { id: from.id });
      finish({ home: peer, salt: from.salt });
      expect(await asking).toEqual({ state: 'linked' });
      expect(h.quorum.links(caller).links[0]).toMatchObject({ state: 'linked', tool: 'codex' });
    },
  );
  it('a remote requester cannot accept its own pending request on our behalf', async () => {
    const h = await start();
    const own = await session(h, 'pending');
    const from = remoteFace();
    expect(h.quorum.receiveLink(peer, { from, to: own.id })).toEqual({ state: 'pending' });
    expect(() => h.quorum.receiveAccept(peer, { from, to: own.id })).toThrow();
    expect(h.quorum.links(h.quorum.authenticate(own.token)).links).toEqual([
      expect.objectContaining({ id: from.id, state: 'pending' }),
    ]);
    expect(new Registry(h.db).workspacesOf(own.agent.id)).toEqual([]);

    // The local person's approval still works, and repeated acknowledgements are harmless.
    h.quorum.allowLinks(h.quorum.authenticate(own.token), { id: from.id });
    expect(h.quorum.receiveAccept(peer, { from, to: own.id })).toEqual({ state: 'linked' });
  });

  it('accepts the answer to a request our session actually made', async () => {
    const from = remoteFace();
    const h = await start({
      federation: {
        lookup: () => Promise.resolve({ home: peer, salt: from.salt }),
        flush: () => Promise.resolve('delivered'),
        queued: () => undefined,
      },
    });
    const own = await session(h, 'requested');
    await h.quorum.requestLink(h.quorum.authenticate(own.token), { to: from.id });
    expect(h.quorum.receiveAccept(peer, { from, to: own.id })).toEqual({ state: 'linked' });
  });

  it.each(['detach', 'block'] as const)(
    '%s stops same-laptop messages sent through the ordinary workspace API',
    async (action) => {
      const h = await start();
      const a = await session(h, 'left');
      const b = await session(h, 'right');
      const callerA = h.quorum.authenticate(a.token);
      const callerB = h.quorum.authenticate(b.token);
      await h.quorum.requestLink(callerA, { to: b.id });
      h.quorum.allowLinks(callerB, { id: a.id });
      const workspace = h.quorum.links(callerA).links[0]?.workspace as string;
      h.quorum.sendMessage(
        callerA,
        workspace,
        note(workspace, a.agent.address, [b.agent.address], 'before'),
      );
      if (action === 'block') h.quorum.blockSession(callerB, { id: a.id });
      else h.quorum.detachLinks(callerB, { id: a.id });

      const result = await h.request('POST', `/v1/workspaces/${workspace}/messages`, {
        token: a.token,
        body: note(workspace, a.agent.address, [b.agent.address], 'after'),
      });
      expect(result.status).toBe(403);
      expect(h.quorum.inbox(callerB, workspace, {}).messages.map((m) => m.body)).not.toContainEqual(
        { text: 'after' },
      );
      expect(h.quorum.exportSession(callerA)).toContain('before');
    },
  );
});

describe('session identity ownership (INV-12, INV-30)', () => {
  it("does not reveal or reissue another human's session identity", async () => {
    const h = await start();
    const own = await session(h, 'owned');
    const other = {
      id: createIdFactory().id('human'),
      address: 'human:other',
      is_owner: 0 as const,
      created_at: new Date().toISOString(),
    };
    new Registry(h.db).insertHuman(other);
    const caller = { kind: 'human' as const, id: other.id, address: other.address };
    for (const credentials of [false, true]) {
      await expect(
        h.quorum.createQuorumId(caller, { ...own.input, credentials }),
      ).rejects.toThrow();
    }
  });

  it('does not reuse a vendor session ID from another folder', async () => {
    const h = await start();
    const own = await session(h, 'original');
    const result = await h.request('POST', '/v1/quorum-ids', {
      token: own.human.token,
      body: { ...own.input, root: h.folder('different'), credentials: true },
    });
    expect(result.status).toBe(403);
    expect(result.body).not.toHaveProperty('credentials');
  });
});

describe('durable cross-machine sends (INV-8, INV-20)', () => {
  it('rolls back the local message when its delivery cannot be queued', async () => {
    const from = remoteFace();
    const h = await start({
      federation: {
        lookup: () => Promise.resolve({ home: peer, salt: from.salt }),
        flush: () => Promise.resolve('delivered'),
        queued: () => undefined,
      },
    });
    const own = await session(h, 'durable');
    const caller = h.quorum.authenticate(own.token);
    await h.quorum.requestLink(caller, { to: from.id });
    h.quorum.receiveAccept(peer, { from, to: own.id });
    const workspace = h.quorum.links(caller).links[0]?.workspace as string;
    h.db.exec(`CREATE TRIGGER fail_delivery BEFORE INSERT ON federation_outbox
      BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;`);
    expect(() =>
      h.quorum.sendToLinks(caller, {
        to: [from.id],
        type: 'note',
        body: { text: 'must be durable' },
      }),
    ).toThrow('simulated disk failure');
    expect(h.quorum.exportSession(caller)).not.toContain('must be durable');
    expect(h.quorum.inbox(caller, workspace, {}).messages).toEqual([]);
    h.db.exec('DROP TRIGGER fail_delivery');
    h.quorum.sendToLinks(caller, {
      to: [from.id],
      type: 'note',
      body: { text: 'must be durable' },
    });
    expect(h.quorum.exportSession(caller).match(/must be durable/g)).toHaveLength(1);
    expect(
      h.db.prepare("SELECT COUNT(*) AS n FROM federation_outbox WHERE kind = 'message'").get(),
    ).toEqual({ n: 1 });
  });
});
