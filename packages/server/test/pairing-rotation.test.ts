// Public-ID rotation changes consent, never the agent's credentials or recorded history.
import * as core from '@quorum/core';
import type { PeerSession } from '@quorum/schemas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Registry, type QuorumOptions } from '../src/index.js';
import { type Harness, startHarness } from './harness.js';

const opened: Harness[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of opened.splice(0)) await h.close();
});
const setup = async (federation?: QuorumOptions['federation']) => {
  const h = await startHarness(federation ? { federation } : {});
  opened.push(h);
  const human = await h.signIn();
  const owner = h.quorum.authenticate(human.token);
  const join = async (name: string) => {
    const input = { vendor: 'codex', vendor_session_id: name, root: h.folder(name) };
    const own = await h.quorum.createQuorumId(owner, input);
    if (!own.credentials) throw new Error('Missing credentials');
    const caller = h.quorum.authenticate(own.credentials.access_token);
    return { own, caller, input, rotate: { ...input, expected_id: own.id } };
  };
  return { h, human, owner, join, registry: new Registry(h.db) };
};
const peer = 'A'.repeat(43);
const remote = (): PeerSession => ({
  ...core.newQuorumId(peer),
  tool: 'claude',
  machine: 'remote',
  path: '~/project',
  label: 'claude@project-1',
});
const outbox = (h: Harness) =>
  h.db
    .prepare<[], { id: string; kind: string; payload: string }>(
      'SELECT id, kind, payload FROM federation_outbox ORDER BY rowid',
    )
    .all();
const events = (h: Harness) =>
  h.db
    .prepare<[], { actor: string; payload: string }>(
      "SELECT actor, payload FROM events WHERE kind = 'quorum_id.rotated' ORDER BY seq",
    )
    .all();

describe('human session ID rotation (INV-7, INV-8, INV-13, INV-30, INV-34)', () => {
  it('unlinks both local sides, retains history, memberships, credentials, attachment and window', async () => {
    const { h, owner, join, registry } = await setup();
    const a = await join('one');
    const b = await join('two');
    const window = h.quorum.createSession(a.caller, {
      vendor_session_id: a.input.vendor_session_id,
      root: a.input.root,
    });
    await h.quorum.requestLink(a.caller, { to: b.own.id });
    h.quorum.allowLinks(b.caller, { id: a.own.id });
    const sent = h.quorum.sendToLinks(a.caller, {
      to: [b.own.id],
      type: 'note',
      body: { text: 'history survives rotation' },
    });
    const attachment = registry.attachmentOfAgent(a.own.agent.id);
    const memberships = registry.workspacesOf(a.own.agent.id);
    const rotated = await h.quorum.rotateQuorumId(owner, a.rotate);
    expect(rotated).toMatchObject({
      previous_id: a.own.id,
      detached: [b.own.id],
    });
    expect(rotated.id).not.toBe(a.own.id);
    expect(h.quorum.links(a.caller)).toEqual({ id: rotated.id, links: [] });
    expect(h.quorum.links(b.caller).links).toEqual([]);
    expect(registry.attachmentOfAgent(a.own.agent.id)).toEqual(attachment);
    expect(registry.workspacesOf(a.own.agent.id)).toEqual(memberships);
    expect(registry.latestSessionOf(a.own.agent.id)?.id).toBe(window.session_id);
    expect(h.quorum.authenticate(a.own.credentials?.access_token).id).toBe(a.own.agent.id);
    expect(h.quorum.exportSession(a.caller)).toContain('> history survives rotation');
    expect(h.quorum.exportSession(b.caller)).toContain('> history survives rotation');
    expect(sent.sent).toHaveLength(1);
    const current = await h.quorum.createQuorumId(owner, a.input);
    expect(current).toMatchObject({
      id: rotated.id,
      agent: a.own.agent,
      attachment: a.own.attachment,
    });
    expect(current.credentials).toBeUndefined();
    expect(registry.quorumId(a.own.id)).toBeUndefined();
    expect(events(h)).toHaveLength(1);
    expect(events(h)[0]?.actor).toBe(owner.address);
    expect(JSON.parse(events(h)[0]?.payload ?? '{}')).toMatchObject(rotated);
    await expect(h.quorum.requestLink(b.caller, { to: a.own.id })).rejects.toMatchObject({
      code: 'pairing.no_such_id',
    });
    await h.quorum.requestLink(b.caller, { to: rotated.id });
    expect(h.quorum.links(a.caller).links[0]?.state).toBe('pending');
  });

  it('preserves own blocks and blocks of the rotating session on the same laptop', async () => {
    const { h, owner, join, registry } = await setup();
    const a = await join('one');
    const b = await join('two');
    const c = await join('three');
    h.quorum.blockSession(a.caller, { id: b.own.id });
    h.quorum.blockSession(c.caller, { id: a.own.id });
    const rotated = await h.quorum.rotateQuorumId(owner, a.rotate);
    expect(registry.isBlocked(rotated.id, b.own.id)).toBe(true);
    expect(registry.isBlocked(c.own.id, rotated.id)).toBe(true);
    expect(registry.isBlocked(a.own.id, b.own.id)).toBe(false);
    await expect(h.quorum.requestLink(b.caller, { to: rotated.id })).rejects.toMatchObject({
      code: 'pairing.no_such_id',
    });
    await expect(h.quorum.requestLink(a.caller, { to: c.own.id })).rejects.toMatchObject({
      code: 'pairing.no_such_id',
    });
  });

  it('removes pending and requested local consent without approving the replacement', async () => {
    const { h, owner, join } = await setup();
    const a = await join('one');
    const b = await join('two');
    const c = await join('three');
    await h.quorum.requestLink(a.caller, { to: b.own.id });
    await h.quorum.requestLink(c.caller, { to: a.own.id });
    const rotated = await h.quorum.rotateQuorumId(owner, a.rotate);
    expect(new Set(rotated.detached)).toEqual(new Set([b.own.id, c.own.id]));
    for (const session of [a, b, c]) expect(h.quorum.links(session.caller).links).toEqual([]);
    expect(() => h.quorum.allowLinks(b.caller, { id: a.own.id })).toThrow(
      expect.objectContaining({ code: 'pairing.no_request' }),
    );
  });

  it('retries concurrent and lost responses once, durably; a superseded retry conflicts', async () => {
    const { h, owner, join } = await setup();
    const a = await join('one');
    const [first, retry] = await Promise.all([
      h.quorum.rotateQuorumId(owner, a.rotate),
      h.quorum.rotateQuorumId(owner, a.rotate),
    ]);
    expect(retry).toEqual(first);
    expect(events(h)).toHaveLength(1);
    const reopened = await h.restart();
    opened.splice(opened.indexOf(h), 1, reopened);
    expect(await reopened.quorum.rotateQuorumId(owner, a.rotate)).toEqual(first);
    expect(events(reopened)).toHaveLength(1);
    const second = await reopened.quorum.rotateQuorumId(owner, {
      ...a.rotate,
      expected_id: first.id,
    });
    expect(second.id).not.toBe(first.id);
    await expect(reopened.quorum.rotateQuorumId(owner, a.rotate)).rejects.toMatchObject({
      code: 'pairing.id_changed',
    });
    expect(events(reopened)).toHaveLength(2);
  });

  it('migrates an existing version-five identity without rewriting history or credentials', async () => {
    const { h, owner, join } = await setup();
    const a = await join('one');
    const before = h.db.prepare('SELECT * FROM events ORDER BY workspace, seq').all();
    // Remove precisely migration six from this fresh fixture, leaving a version-five database.
    h.db.exec('DROP TABLE quorum_id_rotations');
    h.db.pragma('user_version = 5');
    const reopened = await h.restart();
    opened.splice(opened.indexOf(h), 1, reopened);
    expect(reopened.db.pragma('user_version', { simple: true })).toBe(6);
    expect(reopened.db.prepare('SELECT * FROM events ORDER BY workspace, seq').all()).toEqual(
      before,
    );
    expect(reopened.quorum.authenticate(a.own.credentials?.access_token).id).toBe(a.own.agent.id);
    expect(await reopened.quorum.createQuorumId(owner, a.input)).toMatchObject({ id: a.own.id });
    await expect(reopened.quorum.rotateQuorumId(owner, a.rotate)).resolves.toMatchObject({
      previous_id: a.own.id,
    });
  });

  it('refuses anonymous and agent HTTP callers', async () => {
    const { h, join } = await setup();
    const a = await join('one');
    expect((await h.request('POST', '/v1/quorum-ids/rotate', { body: a.rotate })).status).toBe(401);
    const response = await h.request('POST', '/v1/quorum-ids/rotate', {
      token: a.own.credentials?.access_token ?? '',
      body: a.rotate,
    });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: 'auth.human_only' } });
    expect(events(h)).toHaveLength(0);
  });

  it.each(['owner', 'folder', 'vendor-session', 'revoked', 'detached'] as const)(
    'refuses a mismatched %s without changing identity',
    async (choice) => {
      const { h, owner, join, registry } = await setup();
      const a = await join('one');
      const caller = choice === 'owner' ? { ...owner, id: 'hu_someone_else' } : owner;
      const input = { ...a.rotate };
      if (choice === 'folder') input.root = h.folder('different');
      if (choice === 'vendor-session') input.vendor_session_id = 'unjoined';
      if (choice === 'revoked') h.quorum.revokeAgent(owner, a.own.agent.id);
      if (choice === 'detached') h.quorum.deleteAttachment(owner, a.own.attachment ?? '');
      await expect(h.quorum.rotateQuorumId(caller, input)).rejects.toMatchObject({
        code: 'pairing.identity_mismatch',
      });
      expect(registry.quorumIdOfAgent(a.own.agent.id)?.id).toBe(a.own.id);
      expect(events(h)).toHaveLength(0);
    },
  );

  it('requires expected_id and refuses obsolete expected IDs on HTTP', async () => {
    const { h, human, join } = await setup();
    const a = await join('one');
    expect(
      (await h.request('POST', '/v1/quorum-ids/rotate', { token: human.token, body: a.input }))
        .status,
    ).toBe(400);
    const response = await h.request('POST', '/v1/quorum-ids/rotate', {
      token: human.token,
      body: { ...a.rotate, expected_id: 'QRM-0000-0000-0000' },
    });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { code: 'pairing.id_changed' } });
  });

  it('rechecks active status after asynchronous folder canonicalization', async () => {
    const { h, owner, join, registry } = await setup();
    const a = await join('one');
    const rotating = h.quorum.rotateQuorumId(owner, a.rotate);
    h.quorum.revokeAgent(owner, a.own.agent.id);
    await expect(rotating).rejects.toMatchObject({ code: 'pairing.identity_mismatch' });
    expect(registry.quorumIdOfAgent(a.own.agent.id)?.id).toBe(a.own.id);
    expect(events(h)).toHaveLength(0);
  });

  it('rolls back links, blocks, identity, outbox, receipt and log together on append failure', async () => {
    const { h, owner, join, registry } = await setup();
    const a = await join('one');
    const b = await join('two');
    await h.quorum.requestLink(a.caller, { to: b.own.id });
    h.quorum.blockSession(a.caller, { id: 'QRM-0000-0000-0000' });
    const before = h.db.prepare('SELECT * FROM events ORDER BY workspace, seq').all();
    h.db.exec(
      "CREATE TRIGGER reject_rotation BEFORE INSERT ON events WHEN NEW.kind = 'quorum_id.rotated' BEGIN SELECT RAISE(ABORT, 'rotation append failed'); END",
    );
    await expect(h.quorum.rotateQuorumId(owner, a.rotate)).rejects.toThrow(
      'rotation append failed',
    );
    expect(registry.quorumIdOfAgent(a.own.agent.id)?.id).toBe(a.own.id);
    expect(registry.linksOf(a.own.id)[0]?.remote).toBe(b.own.id);
    expect(registry.linksOf(b.own.id)[0]?.remote).toBe(a.own.id);
    expect(registry.isBlocked(a.own.id, 'QRM-0000-0000-0000')).toBe(true);
    expect(registry.rotationOf(a.own.id)).toBeUndefined();
    expect(outbox(h)).toEqual([]);
    expect(h.db.prepare('SELECT * FROM events ORDER BY workspace, seq').all()).toEqual(before);
    h.db.exec('DROP TRIGGER reject_rotation');
    await expect(h.quorum.rotateQuorumId(owner, a.rotate)).resolves.toMatchObject({
      previous_id: a.own.id,
    });
  });

  it('does not reuse a retired ID when allocating another session or rotating again', async () => {
    const { h, owner, join } = await setup();
    const a = await join('one');
    const old = h.quorum.quorumIds()[0];
    if (!old) throw new Error('Missing ID');
    const rotated = await h.quorum.rotateQuorumId(owner, a.rotate);
    const generator = core.newQuorumId;
    const spy = vi
      .spyOn(core, 'newQuorumId')
      .mockReturnValueOnce(old)
      .mockImplementation(generator);
    const b = await join('two');
    expect(b.own.id).not.toBe(old.id);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockReturnValueOnce(old);
    const next = await h.quorum.rotateQuorumId(owner, { ...a.rotate, expected_id: rotated.id });
    expect(next.id).not.toBe(old.id);
  });
});

describe('rotation and old-ID federation deliveries', () => {
  it('cancels unsent handshakes, retains in-flight handshakes and messages before unlink', async () => {
    let inFlight: string[] = [];
    const from = remote();
    const { h, owner, join, registry } = await setup({
      lookup: () => Promise.resolve({ home: peer, salt: from.salt }),
      flush: () => Promise.resolve('unreachable'),
      queued: () => undefined,
      inFlightIds: () => inFlight,
    });
    const a = await join('one');
    await h.quorum.requestLink(a.caller, { to: from.id });
    const request = outbox(h)[0];
    if (!request) throw new Error('Missing request');
    inFlight = [request.id];
    h.quorum.receiveAccept(peer, { from, to: a.own.id });
    // Already accepted messages must retain their place before unlink.
    h.quorum.sendToLinks(a.caller, {
      to: [from.id],
      type: 'note',
      body: { text: 'accepted before rotation' },
    });
    // Duplicate accepts can be queued when a peer recovers its lost side.
    h.quorum.receiveLink(peer, { from, to: a.own.id });
    expect(outbox(h).map((r) => r.kind)).toEqual(['link', 'message', 'accept']);
    const rotated = await h.quorum.rotateQuorumId(owner, a.rotate);
    expect(rotated.detached).toEqual([from.id]);
    expect(outbox(h).map((r) => r.kind)).toEqual(['link', 'message', 'unlink']);
    expect(registry.dueOutbox(new Date().toISOString())[0]?.id).toBe(request.id);
    expect(JSON.parse(outbox(h)[2]?.payload ?? '{}')).toEqual({ from: a.own.id, to: from.id });
    expect(JSON.parse(events(h)[0]?.payload ?? '{}')).toMatchObject({ cancelled_handshakes: 1 });
    const message = JSON.parse(outbox(h)[1]?.payload ?? '{}') as { message: unknown };
    for (const retired of [a.own.id, 'QRM-0000-0000-0000']) {
      expect(() => h.quorum.receiveLink(peer, { from, to: retired })).toThrow(
        expect.objectContaining({ code: 'pairing.no_such_id' }),
      );
      expect(() => h.quorum.receiveAccept(peer, { from, to: retired })).toThrow(
        expect.objectContaining({ code: 'pairing.no_such_id' }),
      );
      expect(() =>
        h.quorum.receiveMessage(peer, { from: from.id, to: retired, message: message.message }),
      ).toThrow(expect.objectContaining({ code: 'pairing.no_such_id' }));
    }
    expect(registry.linksOf(rotated.id)).toEqual([]);
  });

  it('does not let an unresolved lookup revive the retired local identity', async () => {
    const from = remote();
    let resolve!: (value: { home: string; salt: string }) => void;
    const lookup = new Promise<{ home: string; salt: string }>((done) => {
      resolve = done;
    });
    const { h, owner, join } = await setup({
      lookup: () => lookup,
      flush: () => Promise.resolve('delivered'),
      queued: () => undefined,
    });
    const a = await join('one');
    const asking = h.quorum.requestLink(a.caller, { to: from.id });
    const rejected = expect(asking).rejects.toThrow();
    const rotated = await h.quorum.rotateQuorumId(owner, a.rotate);
    resolve({ home: peer, salt: from.salt });
    await rejected;
    expect(h.quorum.links(a.caller)).toEqual({ id: rotated.id, links: [] });
    expect(outbox(h)).toEqual([]);
  });

  it('does not let an in-flight request response restore an old local identity', async () => {
    const from = remote();
    let inFlight: string[] = [];
    let resolve!: (value: 'delivered') => void;
    const flushing = new Promise<'delivered'>((done) => {
      resolve = done;
    });
    const { h, owner, join } = await setup({
      lookup: () => Promise.resolve({ home: peer, salt: from.salt }),
      flush: () => flushing,
      queued: () => undefined,
      inFlightIds: () => inFlight,
    });
    const a = await join('one');
    const asking = h.quorum.requestLink(a.caller, { to: from.id });
    const rejected = expect(asking).rejects.toThrow();
    await Promise.resolve();
    inFlight = outbox(h)
      .filter((row) => row.kind === 'link')
      .map((row) => row.id);
    const rotated = await h.quorum.rotateQuorumId(owner, a.rotate);
    resolve('delivered');
    await rejected;
    expect(h.quorum.links(a.caller)).toEqual({ id: rotated.id, links: [] });
    expect(outbox(h).map((row) => row.kind)).toEqual(['link', 'unlink']);
  });
});
