// Durable cross-server delivery: requests, approvals, messages and unlink must arrive in order,
// even when a destination goes offline or flush/drain overlap (INV-20, INV-34).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Federation, startFederation } from '../src/relay/federation.js';
import { type Db, openDatabase } from '../src/storage/database.js';
import { type OutboxRow, Registry } from '../src/storage/registry.js';

const fixtures: { dir: string; db: Db; federation?: Federation }[] = [];
const TIME = '2026-11-04T09:00:00.000Z';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const setup = (transport: typeof fetch, onRefused?: (row: OutboxRow) => void) => {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-federation-'));
  const file = join(dir, 'queue.db');
  const db = openDatabase(file);
  const fixture: (typeof fixtures)[number] = { dir, db };
  fixtures.push(fixture);
  const registry = new Registry(db);
  let time = Date.parse(TIME);
  const federation = startFederation({
    relay: 'wss://relay.example',
    identity: { key: 'unused with the test transport', cert: 'unused with the test transport' },
    registry,
    transport,
    now: () => new Date(time),
    intervalMs: 60_000,
    ...(onRefused ? { onRefused } : {}),
  });
  fixture.federation = federation;
  let next = 0;
  const queue = (kind: string, home = 'peer', createdAt = TIME) => {
    const row: OutboxRow = {
      id: `item-${String(++next)}`,
      remote_home: home,
      kind,
      payload: JSON.stringify({ sequence: next }),
      attempts: 0,
      next_at: TIME,
      created_at: createdAt,
    };
    registry.enqueueOutbox(row);
    return row.id;
  };
  return {
    db,
    file,
    registry,
    federation,
    queue,
    advance: (ms: number) => {
      time += ms;
    },
  };
};

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.federation?.close();
    if (fixture.db.open) fixture.db.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

describe('federation outbox ordering (INV-20, INV-34)', () => {
  it('keeps a message behind a retrying acceptance while another laptop progresses', async () => {
    let available = false;
    const calls: string[] = [];
    const transport: typeof fetch = (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      return Promise.resolve(
        new Response(null, { status: url.endsWith('/accept') && !available ? 503 : 204 }),
      );
    };
    const { federation, registry, queue, advance } = setup(transport);
    const accept = queue('accept');
    const message = queue('message');
    queue('message', 'other');

    await federation.drain();
    expect(calls.map((url) => url.replace('quorum://relay.example/', ''))).toEqual([
      'peer/v1/federation/accept',
      'other/v1/federation/message',
    ]);
    expect(registry.outboxItem(accept)?.attempts).toBe(1);
    expect(registry.outboxItem(message)?.attempts).toBe(0);
    available = true;
    advance(4_999);
    expect(await federation.flush(message)).toBe('unreachable');
    await federation.drain();
    expect(calls).toHaveLength(2);

    advance(1);
    await federation.drain();
    expect(calls.slice(2).map((url) => url.split('/').at(-1))).toEqual(['accept', 'message']);
    expect(registry.outboxSize()).toBe(0);
  });

  it('uses insertion order when a clock moves backwards and across a database reopen', async () => {
    const sent: string[] = [];
    const transport: typeof fetch = (input) => {
      sent.push(
        (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
          .split('/')
          .at(-1) ?? '',
      );
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    const { federation, file, db, queue } = setup(transport);
    const first = queue('link');
    const second = queue('unlink', 'peer', '2026-11-03T09:00:00.000Z');
    await federation.close();
    db.close();
    const reopened = openDatabase(file);
    const registry = new Registry(reopened);
    try {
      expect(registry.dueOutbox(TIME).map((row) => row.id)).toEqual([first]);
      registry.outboxDelivered(first);
      expect(registry.dueOutbox(TIME).map((row) => row.id)).toEqual([second]);
    } finally {
      reopened.close();
    }
    expect(sent).toEqual([]);
  });

  it('does not let concurrent flushes overtake a destination already being sent', async () => {
    const started = deferred<undefined>();
    const release = deferred<Response>();
    const calls: string[] = [];
    const transport: typeof fetch = (input) => {
      calls.push(
        (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
          .split('/')
          .at(-1) ?? '',
      );
      started.resolve(undefined);
      return calls.length === 1
        ? release.promise
        : Promise.resolve(new Response(null, { status: 204 }));
    };
    const { federation, registry, queue } = setup(transport);
    const first = queue('accept');
    const second = queue('message');
    const flushing = federation.flush(first);
    await started.promise;
    expect(await federation.flush(second)).toBe('unreachable');
    const same = federation.flush(first);
    const draining = federation.drain();
    const joined = federation.drain();
    expect(joined).toBe(draining);
    expect(calls).toEqual(['accept']);
    release.resolve(new Response(null, { status: 204 }));
    expect(await flushing).toBe('delivered');
    expect(await same).toBe('delivered');
    await draining;
    expect(calls).toEqual(['accept', 'message']);
    expect(registry.outboxSize()).toBe(0);
  });

  it('picks up a newly queued item before an active drain resolves', async () => {
    const started = deferred<undefined>();
    const release = deferred<Response>();
    let calls = 0;
    const transport: typeof fetch = () => {
      calls++;
      started.resolve(undefined);
      return calls === 1 ? release.promise : Promise.resolve(new Response(null, { status: 204 }));
    };
    const { federation, registry, queue } = setup(transport);
    queue('link');
    const draining = federation.drain();
    await started.promise;
    queue('unlink');
    federation.queued();
    release.resolve(new Response(null, { status: 204 }));
    await draining;
    expect(calls).toBe(2);
    expect(registry.outboxSize()).toBe(0);
  });

  it('does not lose a refused request when applying the refusal fails', async () => {
    const onRefused = vi
      .fn<NonNullable<Parameters<typeof startFederation>[0]['onRefused']>>()
      .mockImplementationOnce(() => {
        throw new Error('transaction failed');
      });
    const transport: typeof fetch = () => Promise.resolve(new Response(null, { status: 404 }));
    const { federation, registry, queue } = setup(transport, onRefused);
    const request = queue('link');
    await expect(federation.flush(request)).rejects.toThrow('transaction failed');
    expect(registry.outboxItem(request)).toBeDefined();
    expect(await federation.flush(request)).toBe('refused');
    expect(registry.outboxSize()).toBe(0);
    expect(onRefused).toHaveBeenCalledTimes(2);
  });
});

describe('federation shutdown (INV-20)', () => {
  it('aborts an active send and keeps its row for the next server start', async () => {
    const started = deferred<AbortSignal>();
    const transport: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error('missing cancellation signal');
        signal.addEventListener(
          'abort',
          () => {
            reject(new Error('aborted'));
          },
          { once: true },
        );
        started.resolve(signal);
      });
    const { federation, registry, queue, db } = setup(transport);
    const id = queue('message');
    const draining = federation.drain();
    const signal = await started.promise;
    await federation.close();
    await draining;
    expect(signal.aborted).toBe(true);
    expect(registry.outboxItem(id)).toMatchObject({ attempts: 0, next_at: TIME });
    db.close();
    await expect(federation.flush(id)).resolves.toBe('unreachable');
    await expect(federation.drain()).resolves.toBeUndefined();
    federation.queued();
    await expect(federation.close()).resolves.toBeUndefined();
  });

  it('waits for a late response without deleting the durable row during shutdown', async () => {
    const started = deferred<undefined>();
    const response = deferred<Response>();
    const transport: typeof fetch = () => {
      started.resolve(undefined);
      return response.promise;
    };
    const { federation, registry, queue } = setup(transport);
    const id = queue('message');
    const flushing = federation.flush(id);
    await started.promise;
    let closed = false;
    const closing = federation.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    response.resolve(new Response(null, { status: 204 }));
    await closing;
    expect(await flushing).toBe('unreachable');
    expect(registry.outboxItem(id)).toBeDefined();
  });
});
