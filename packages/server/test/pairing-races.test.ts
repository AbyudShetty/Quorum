// Newer human choices must win over network requests already awaiting a lookup or response.
import { newQuorumId } from '@quorum/core';
import type { PeerSession, QuorumIdCreated } from '@quorum/schemas';
import { afterEach, describe, expect, it } from 'vitest';
import { Registry } from '../src/index.js';
import { type Harness, startHarness } from './harness.js';

const opened: Harness[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const peer = 'A'.repeat(43);
const face = (): PeerSession => ({
  ...newQuorumId(peer),
  tool: 'codex',
  machine: 'peer',
  path: '~/project',
  label: 'codex@project-1',
});
const setup = async (
  from: PeerSession,
  lookup: Promise<{ home: string; salt: string }>,
  flush = Promise.resolve<'delivered' | 'refused' | 'unreachable'>('delivered'),
) => {
  const h = await startHarness({
    federation: { lookup: () => lookup, flush: () => flush, queued: () => undefined },
  });
  opened.push(h);
  const human = await h.signIn();
  const made = await h.request('POST', '/v1/quorum-ids', {
    token: human.token,
    body: { vendor: 'claude-code', vendor_session_id: 'local', root: h.folder('project') },
  });
  const own = made.body as QuorumIdCreated;
  if (!own.credentials) throw new Error('Missing credentials');
  const caller = h.quorum.authenticate(own.credentials.access_token);
  return { h, own, caller, human, where: { home: peer, salt: from.salt } };
};

describe('pairing cancellation during network awaits (INV-13, INV-34)', () => {
  it.each(['block', 'detach', 'detach-all'] as const)(
    'does not undo a newer %s during lookup',
    async (choice) => {
      const from = face();
      const lookup = deferred<{ home: string; salt: string }>();
      const { h, own, caller, where } = await setup(from, lookup.promise);
      const asking = h.quorum.requestLink(caller, { to: from.id });
      const rejected = expect(asking).rejects.toThrow();
      if (choice === 'block') h.quorum.blockSession(caller, { id: from.id });
      else h.quorum.detachLinks(caller, choice === 'detach-all' ? {} : { id: from.id });
      lookup.resolve(where);
      await rejected;
      expect(h.quorum.links(caller).links).toEqual([]);
      expect(new Registry(h.db).outboxSize()).toBe(0);
      if (choice === 'block') expect(new Registry(h.db).isBlocked(own.id, from.id)).toBe(true);
    },
  );

  it('does not let a stale refusal delete a link approved while the send was waiting', async () => {
    const from = face();
    const delivery = deferred<'refused'>();
    const { h, own, caller } = await setup(
      from,
      Promise.resolve({ home: peer, salt: from.salt }),
      delivery.promise,
    );
    const asking = h.quorum.requestLink(caller, { to: from.id });
    // requestLink reaches its flush await after the already-resolved lookup.
    await Promise.resolve();
    h.quorum.receiveAccept(peer, { from, to: own.id });
    delivery.resolve('refused');
    expect(await asking).toEqual({ state: 'linked' });
    expect(h.quorum.links(caller).links[0]).toMatchObject({ state: 'linked' });
  });

  it('does not report an in-flight send as requested after the person detached it', async () => {
    const from = face();
    const delivery = deferred<'delivered'>();
    const { h, caller } = await setup(
      from,
      Promise.resolve({ home: peer, salt: from.salt }),
      delivery.promise,
    );
    const asking = h.quorum.requestLink(caller, { to: from.id });
    const rejected = expect(asking).rejects.toThrow();
    await Promise.resolve();
    h.quorum.detachLinks(caller, { id: from.id });
    delivery.resolve('delivered');
    await rejected;
    expect(h.quorum.links(caller).links).toEqual([]);
    // Keep the original request before its cancellation: deleting an in-flight row would let
    // unlink overtake the request and leave a remote pending link behind.
    expect(new Registry(h.db).dueOutbox(new Date().toISOString())[0]?.kind).toBe('link');
    expect(h.db.prepare('SELECT kind FROM federation_outbox ORDER BY rowid').all()).toEqual([
      { kind: 'link' },
      { kind: 'unlink' },
    ]);
  });

  it('rejects a lookup result after the local identity was revoked', async () => {
    const from = face();
    const lookup = deferred<{ home: string; salt: string }>();
    const { h, own, caller, human, where } = await setup(from, lookup.promise);
    const asking = h.quorum.requestLink(caller, { to: from.id });
    const rejected = expect(asking).rejects.toThrow();
    h.quorum.revokeAgent(h.quorum.authenticate(human.token), own.agent.id);
    lookup.resolve(where);
    await rejected;
    expect(new Registry(h.db).linksOf(own.id)).toEqual([]);
    expect(new Registry(h.db).outboxSize()).toBe(0);
  });
});
