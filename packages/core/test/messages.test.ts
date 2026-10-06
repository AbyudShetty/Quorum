import type { SubmittedEnvelope } from '@quorum/schemas';
import { describe, expect, it } from 'vitest';
import {
  type AcceptOutcome,
  acceptMessage,
  ackEvent,
  appendNew,
  createIdFactory,
  DomainError,
  MemoryEventStore,
  MessageLog,
  type Principal,
} from '../src/index.js';

const WS = 'ws_01J9Z8X7W6V5T4S3R2Q1P0N9M8';
const A = 'agent:claude-api@laptop-a';
const B = 'agent:codex-web@laptop-a';
const C = 'agent:gemini-docs@laptop-b';
const H = 'human:abyud';
const NOW = '2026-10-02T10:00:00Z';

const agentA: Principal = { kind: 'agent', address: A };
const human: Principal = { kind: 'human', address: H };

/** A small in-memory workspace: accept → append → project, like the server will. */
const workspace = () => {
  const ids = createIdFactory();
  const store = new MemoryEventStore();
  const log = new MessageLog();

  const send = async (
    principal: Principal,
    input: unknown,
  ): Promise<AcceptOutcome & { seq?: number }> => {
    const outcome = acceptMessage(log, { workspace: WS, principal, input, now: NOW, ids });
    if (outcome.outcome !== 'append') return outcome;
    const [event] = await appendNew(store, WS, [outcome.event]);
    if (!event) throw new Error('no event appended');
    log.apply(event);
    return { ...outcome, seq: event.seq };
  };

  const envelope = (
    overrides: Partial<SubmittedEnvelope> & Record<string, unknown> = {},
  ): SubmittedEnvelope =>
    ({
      spec: 'quorum/1',
      id: ids.id('message'),
      workspace: WS,
      from: A,
      to: [B],
      type: 'note',
      type_version: 1,
      created_at: NOW,
      body: { text: 'hello' },
      ...overrides,
    }) as SubmittedEnvelope;

  const ack = async (principal: Principal, upTo: number) => {
    const [event] = await appendNew(store, WS, [ackEvent(principal, upTo, NOW, ids)]);
    if (event) log.apply(event);
  };

  return { ids, store, log, send, envelope, ack };
};

/** The DomainError thrown by `fn`, for asserting on code/kind/path. */
const rejection = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (error) {
    if (error instanceof DomainError)
      return { kind: error.kind, code: error.code, path: error.path };
    throw error;
  }
  throw new Error('expected a DomainError');
};

describe('acceptMessage', () => {
  it('accepts a valid message and records it as an event', async () => {
    const w = workspace();
    const result = await w.send(agentA, w.envelope());
    expect(result).toMatchObject({ outcome: 'append', seq: 1 });
    const [event] = await w.store.read(WS);
    expect(event).toMatchObject({ kind: 'message.accepted', actor: A, seq: 1 });
  });

  it('rejects schema violations with the path to the problem', async () => {
    const w = workspace();
    expect(await rejection(() => w.send(agentA, w.envelope({ body: { text: '' } })))).toEqual({
      kind: 'invalid',
      code: 'message.invalid',
      path: '/body/text',
    });
  });

  it('reports oversized bodies as too_large (413)', async () => {
    const w = workspace();
    const huge = w.envelope({ body: { text: 'x', blob: 'y'.repeat(97 * 1024) } as never });
    expect(await rejection(() => w.send(agentA, huge))).toMatchObject({
      kind: 'too_large',
      path: '/body',
    });
  });

  it('rejects a message addressed to another workspace', async () => {
    const w = workspace();
    const other = w.envelope({ workspace: 'ws_01J9Z8X7W6V5T4S3R2Q1P0N9M9' });
    expect(await rejection(() => w.send(agentA, other))).toMatchObject({
      code: 'message.workspace_mismatch',
    });
  });

  it('rejects a sender that does not match the token (INV-7)', async () => {
    const w = workspace();
    expect(await rejection(() => w.send(agentA, w.envelope({ from: B })))).toEqual({
      kind: 'forbidden',
      code: 'message.sender_mismatch',
      path: '/from',
    });
  });

  it('never accepts approval decisions from agents (INV-1)', async () => {
    const w = workspace();
    const decision = w.envelope({
      type: 'approval_decision',
      to: [H],
      body: { request_id: `ap_${w.ids.ulid()}`, decision: 'approve', preview_hash: 'a'.repeat(64) },
    });
    expect(await rejection(() => w.send(agentA, decision))).toMatchObject({
      kind: 'forbidden',
      code: 'message.human_only',
    });
    expect(await w.send(human, { ...decision, from: H, to: [A] })).toMatchObject({
      outcome: 'append',
    });
  });

  it('enforces the token scope (INV-12)', async () => {
    const w = workspace();
    const notesOnly: Principal = { ...agentA, messageTypes: new Set(['note']) };
    const finding = w.envelope({
      type: 'finding',
      body: { claim: 'x', method: 'y', confidence: 'low', reproduce: 'make test' },
    });
    expect(await rejection(() => w.send(notesOnly, finding))).toMatchObject({
      code: 'message.type_not_allowed',
    });
    expect(await w.send(notesOnly, w.envelope())).toMatchObject({ outcome: 'append' });
  });

  it('rejects secrets without echoing them (INV-14)', async () => {
    const w = workspace();
    const leaked = w.envelope({ body: { text: 'use key AKIAIOSFODNN7EXAMPLE for s3' } });
    try {
      await w.send(agentA, leaked);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      const e = error as DomainError;
      expect([e.code, e.path]).toEqual(['message.secret_detected', '/body/text']);
      expect(JSON.stringify(e.toResponse())).not.toContain('AKIAIOSFODNN7EXAMPLE');
    }
    expect(await w.store.read(WS)).toEqual([]);
  });

  it('is idempotent: identical resend returns the original seq', async () => {
    const w = workspace();
    const env = w.envelope();
    const first = await w.send(agentA, env);
    const again = await w.send(agentA, env);
    expect(first.seq).toBe(1);
    expect(again).toMatchObject({ outcome: 'duplicate', original: { seq: 1 } });
    expect(await w.store.read(WS)).toHaveLength(1);
  });

  it('rejects different content under an existing id (409)', async () => {
    const w = workspace();
    const env = w.envelope();
    await w.send(agentA, env);
    expect(
      await rejection(() => w.send(agentA, { ...env, body: { text: 'changed' } })),
    ).toMatchObject({
      kind: 'conflict',
      code: 'message.id_conflict',
    });
  });

  it('treats heartbeats as presence, not history (MESSAGE_SPEC §5.10)', async () => {
    const w = workspace();
    const beat = w.envelope({
      type: 'heartbeat',
      to: ['*'],
      body: { status: 'working', resources_in_use: [] },
    });
    expect(await w.send(agentA, beat)).toMatchObject({ outcome: 'presence' });
    expect(await w.store.read(WS)).toEqual([]);
  });

  it('assigns a thread: new, as given, or inherited from the replied-to message', async () => {
    const w = workspace();
    const first = await w.send(agentA, w.envelope());
    const thread = first.outcome === 'append' ? first.envelope.thread : undefined;
    expect(thread).toMatch(/^th_/);
    const reply = await w.send(
      { kind: 'agent', address: B },
      w.envelope({
        from: B,
        to: [A],
        reply_to: first.outcome === 'append' ? first.envelope.id : '',
      }),
    );
    expect(reply.outcome === 'append' && reply.envelope.thread).toBe(thread);
    const explicit = `th_${w.ids.ulid()}`;
    const third = await w.send(agentA, w.envelope({ thread: explicit }));
    expect(third.outcome === 'append' && third.envelope.thread).toBe(explicit);
  });
});

describe('MessageLog inbox', () => {
  it('shows direct messages only to their recipients', async () => {
    const w = workspace();
    await w.send(agentA, w.envelope({ to: [B], body: { text: 'for B' } }));
    expect(w.log.inbox(B).messages.map((m) => m.body)).toEqual([{ text: 'for B' }]);
    expect(w.log.inbox(C).messages).toEqual([]);
    expect(w.log.inbox(H).messages).toEqual([]);
  });

  it('shows broadcasts to everyone but the sender', async () => {
    const w = workspace();
    await w.send(agentA, w.envelope({ to: ['*'] }));
    expect(w.log.inbox(B).messages).toHaveLength(1);
    expect(w.log.inbox(H).messages).toHaveLength(1);
    expect(w.log.inbox(A).messages).toEqual([]);
  });

  it('delivers server fields with each message', async () => {
    const w = workspace();
    await w.send(agentA, w.envelope());
    const [message] = w.log.inbox(B).messages;
    expect(message).toMatchObject({ seq: 1, received_at: NOW });
    expect(message?.event).toMatch(/^ev_/);
  });

  it('pages by seq with next_after and has_more', async () => {
    const w = workspace();
    for (let i = 0; i < 5; i++) await w.send(agentA, w.envelope({ body: { text: String(i) } }));
    const first = w.log.inbox(B, { limit: 2 });
    expect([first.messages.map((m) => m.seq), first.next_after, first.has_more]).toEqual([
      [1, 2],
      2,
      true,
    ]);
    const last = w.log.inbox(B, { after: 4, limit: 2 });
    expect([last.messages.map((m) => m.seq), last.next_after, last.has_more]).toEqual([
      [5],
      5,
      false,
    ]);
    const empty = w.log.inbox(B, { after: 5 });
    expect([empty.messages, empty.next_after, empty.has_more]).toEqual([[], 5, false]);
  });

  it('filters a thread to what the reader may see', async () => {
    const w = workspace();
    const thread = `th_${w.ids.ulid()}`;
    await w.send(agentA, w.envelope({ thread, to: [B] }));
    await w.send(agentA, w.envelope({ thread, to: [C] }));
    await w.send(agentA, w.envelope({ to: [B] }));
    expect(w.log.thread(thread, B).messages.map((m) => m.seq)).toEqual([1]);
  });

  it('records acknowledgements and never moves them backwards', async () => {
    const w = workspace();
    const bob: Principal = { kind: 'agent', address: B };
    await w.ack(bob, 7);
    await w.ack(bob, 3);
    expect(w.log.ackedUpTo(B)).toBe(7);
    expect(w.log.ackedUpTo(C)).toBe(0);
    expect(() => ackEvent(bob, -1, NOW, w.ids)).toThrow(DomainError);
  });

  it('rebuilds the same state by replaying the event log (ARCHITECTURE §3)', async () => {
    const w = workspace();
    await w.send(agentA, w.envelope({ to: ['*'] }));
    await w.send(agentA, w.envelope({ to: [B] }));
    await w.ack({ kind: 'agent', address: B }, 2);
    const rebuilt = new MessageLog();
    for (const event of await w.store.read(WS)) rebuilt.apply(event);
    expect(rebuilt.inbox(B)).toEqual(w.log.inbox(B));
    expect(rebuilt.ackedUpTo(B)).toBe(2);
  });
});

describe('sessions: one window, its own mail (MESSAGE_SPEC §1.1)', () => {
  const A = 'agent:claude-api@m1';
  const W1 = `sess_${'1'.repeat(26)}`;
  const W2 = `sess_${'2'.repeat(26)}`;
  let seq = 0;
  const event = (kind: string, payload: Record<string, unknown>) => ({
    ev_id: `ev_${String(++seq).padStart(26, '0')}`,
    workspace: 'ws_x',
    seq,
    ts: '2026-10-02T10:00:00Z',
    actor: 'agent:codex-web@m1',
    kind,
    payload,
    prev_hash: '0'.repeat(64),
    hash: '0'.repeat(64),
  });
  const message = (id: string, to: string[], extra: Record<string, unknown> = {}) =>
    event('message.accepted', {
      envelope: {
        spec: 'quorum/1',
        id,
        workspace: 'ws_x',
        thread: `th_${'9'.repeat(26)}`,
        from: 'agent:codex-web@m1',
        to,
        type: 'note',
        type_version: 1,
        created_at: '2026-10-02T10:00:00Z',
        body: { text: id },
        ...extra,
      },
      content_hash: id,
    });
  const ids = (page: { messages: { id: string }[] }) => page.messages.map((m) => m.id);

  it('shows mail for a session label only to that window; agent and broadcast mail to all', () => {
    const log = new MessageLog();
    log.apply(message('msg-agent', [A]));
    log.apply(message('msg-w1', ['claude@api-1'], { delivered_to: [A], to_sessions: [W1] }));
    log.apply(message('msg-all', ['*']));
    expect(ids(log.inbox(A, { session: W1 }))).toEqual(['msg-agent', 'msg-w1', 'msg-all']);
    expect(ids(log.inbox(A, { session: W2 }))).toEqual(['msg-agent', 'msg-all']);
    expect(ids(log.inbox(A))).toEqual(['msg-agent', 'msg-w1', 'msg-all']); // the CLI sees all
  });

  it('keeps a read position per window', () => {
    const log = new MessageLog();
    log.apply(message('m1', [A]));
    log.apply(event('inbox.acked', { address: A, up_to: 1, session: W1 }));
    expect(log.ackedUpTo(A, W1)).toBe(1);
    expect(log.ackedUpTo(A, W2)).toBe(0);
    expect(log.ackedUpTo(A)).toBe(0);
  });

  it('knows the furthest any window of an address has read (where a new window starts)', () => {
    const log = new MessageLog();
    expect(log.furthestAck(A)).toBe(0);
    log.apply(event('inbox.acked', { address: A, up_to: 4, session: W1 }));
    log.apply(event('inbox.acked', { address: A, up_to: 2 }));
    log.apply(event('inbox.acked', { address: B, up_to: 9 }));
    expect(log.furthestAck(A)).toBe(4);
  });

  it('stores server fields with the message but hashes what the client sent', () => {
    const log = new MessageLog();
    const factory = createIdFactory();
    const input = {
      spec: 'quorum/1',
      id: factory.id('message'),
      workspace: WS,
      from: A,
      to: ['codex@web-1'],
      type: 'note',
      type_version: 1,
      created_at: '2026-10-02T10:00:00Z',
      body: { text: 'hi' },
    };
    const outcome = acceptMessage(log, {
      workspace: WS,
      principal: { kind: 'agent', address: A },
      input,
      now: '2026-10-02T10:00:01Z',
      ids: factory,
      serverFields: { from_session: { id: W1, label: 'claude@api-1', machine: 'm1' } },
    });
    if (outcome.outcome !== 'append') throw new Error(outcome.outcome);
    expect(outcome.envelope).toMatchObject({ from_session: { label: 'claude@api-1' } });
  });
});
