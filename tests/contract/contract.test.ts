// The /v1 contract: every implementation (real server, fake server) must pass this suite.
// Skipped until a target is given:  QUORUM_CONTRACT_TARGET=<module exporting createTarget> npm test
// See tests/contract/README.md.
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type ApiPayloadKind,
  type SubmittedEnvelope,
  validateApiPayload,
  validateDeliveredEnvelope,
  validateErrorResponse,
} from '@quorum/schemas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, callWithHost, firstStreamEvent, ulid } from './helpers.js';
import type { ContractTarget, CreateTarget } from './target.js';

const targetModule = process.env.QUORUM_CONTRACT_TARGET;

/** Assert a payload matches its API schema, showing the issues if not. */
const expectPayload = (kind: ApiPayloadKind, body: unknown) => {
  const result = validateApiPayload(kind, body);
  expect(result.ok ? [] : result.issues).toEqual([]);
};

/** Assert an error response follows MESSAGE_SPEC §6. */
const expectError = (body: unknown) => {
  const result = validateErrorResponse(body);
  expect(result.ok ? [] : result.issues).toEqual([]);
};

describe.skipIf(!targetModule)('/v1 contract', () => {
  let t: ContractTarget;
  const ws = () => `/v1/workspaces/${t.workspace}`;

  const note = (text: string, overrides: Partial<SubmittedEnvelope> = {}): SubmittedEnvelope =>
    ({
      spec: 'quorum/1',
      id: `msg_${ulid()}`,
      workspace: t.workspace,
      from: t.agentA.address,
      to: [t.agentB.address],
      type: 'note',
      type_version: 1,
      created_at: new Date().toISOString(),
      body: { text },
      ...overrides,
    }) as SubmittedEnvelope;

  const send = (envelope: unknown, token = t.agentA.token) =>
    call(t.baseUrl, 'POST', `${ws()}/messages`, { token, body: envelope });

  beforeAll(async () => {
    const mod = (await import(pathToFileURL(resolve(targetModule ?? '')).href)) as {
      createTarget: CreateTarget;
    };
    t = await mod.createTarget();
  });

  afterAll(async () => {
    await t.close();
  });

  describe('server identity', () => {
    it('answers health without a token', async () => {
      const reply = await call(t.baseUrl, 'GET', '/v1/health');
      expect(reply.status).toBe(200);
      expectPayload('health', reply.body);
    });

    it('proves its identity with the pinned key (INV-24)', async () => {
      const nonce = randomBytes(32).toString('base64url');
      const reply = await call(t.baseUrl, 'POST', '/v1/hello', { body: { nonce } });
      expect(reply.status).toBe(200);
      expectPayload('helloResponse', reply.body);
      const hello = reply.body as { instance_id: string; public_key: string; signature: string };
      expect(hello.public_key).toBe(t.pinnedPublicKey);
      const key = createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: t.pinnedPublicKey },
        format: 'jwk',
      });
      const signed = Buffer.from(`quorum/1 hello\n${hello.instance_id}\n${nonce}`, 'utf8');
      expect(verify(null, signed, key, Buffer.from(hello.signature, 'base64url'))).toBe(true);
    });
  });

  describe('authentication', () => {
    it('rejects requests without a token, also on loopback (INV-23)', async () => {
      const reply = await call(t.baseUrl, 'GET', `${ws()}/inbox`);
      expect(reply.status).toBe(401);
      expectError(reply.body);
    });

    it('rejects an invalid token', async () => {
      const reply = await call(t.baseUrl, 'GET', `${ws()}/inbox`, { token: 'x'.repeat(43) });
      expect(reply.status).toBe(401);
      expectError(reply.body);
    });

    it('rejects a foreign Host header in local mode (INV-26)', async (context) => {
      if (!t.localMode) context.skip();
      expect(
        await callWithHost(t.baseUrl, '/v1/health', 'attacker.example'),
      ).toBeGreaterThanOrEqual(400);
    });
  });

  describe('sending messages', () => {
    it('accepts a valid message and assigns server fields', async () => {
      const reply = await send(note('hello from A'));
      expect(reply.status).toBe(201);
      expectPayload('messageAccepted', reply.body);
    });

    it('is idempotent by message id: same content → 200 with the same seq', async () => {
      const envelope = note('sent twice');
      const first = await send(envelope);
      const second = await send(envelope);
      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect((second.body as { seq: number }).seq).toBe((first.body as { seq: number }).seq);
    });

    it('rejects different content under an existing id with 409', async () => {
      const envelope = note('original');
      await send(envelope);
      const reply = await send({ ...envelope, body: { text: 'changed' } });
      expect(reply.status).toBe(409);
      expectError(reply.body);
    });

    it('rejects schema violations with 400 and a JSON Pointer path', async () => {
      const reply = await send({ ...note('x'), body: { text: '' } });
      expect(reply.status).toBe(400);
      expectError(reply.body);
      expect((reply.body as { error: { path?: string } }).error.path).toBe('/body/text');
    });

    it('rejects server-assigned fields instead of rewriting them', async () => {
      const reply = await send({ ...note('x'), seq: 1 });
      expect(reply.status).toBe(400);
      expectError(reply.body);
    });

    it('rejects a sender that does not match the token (INV-7)', async () => {
      const reply = await send(note('pretending', { from: t.agentB.address }));
      expect(reply.status).toBe(403);
      expectError(reply.body);
    });

    it('never accepts approval decisions from agents (INV-1)', async () => {
      const decision = {
        ...note('x'),
        type: 'approval_decision',
        to: [t.human.address],
        body: { request_id: `ap_${ulid()}`, decision: 'approve', preview_hash: 'a'.repeat(64) },
      };
      const reply = await send(decision);
      expect(reply.status).toBe(403);
      expectError(reply.body);
    });

    it('rejects bodies over 96 KiB with 413', async () => {
      const reply = await send({ ...note('x'), body: { text: 'x', blob: 'y'.repeat(97 * 1024) } });
      expect(reply.status).toBe(413);
      expectError(reply.body);
    });
  });

  describe('receiving messages', () => {
    it('delivers to the recipient inbox, pages by seq, and acknowledges', async () => {
      const sent = await send(note('for B'));
      const seq = (sent.body as { seq: number }).seq;

      const page = await call(t.baseUrl, 'GET', `${ws()}/inbox?after=${String(seq - 1)}`, {
        token: t.agentB.token,
      });
      expect(page.status).toBe(200);
      expectPayload('inboxPage', page.body);
      const messages = (page.body as { messages: { seq: number; body: unknown }[] }).messages;
      expect(messages[0]).toMatchObject({ seq, body: { text: 'for B' } });
      for (const message of messages) expect(validateDeliveredEnvelope(message).ok).toBe(true);

      const after = await call(t.baseUrl, 'GET', `${ws()}/inbox?after=${String(seq)}`, {
        token: t.agentB.token,
      });
      expect(
        (after.body as { messages: { seq: number }[] }).messages.every((m) => m.seq > seq),
      ).toBe(true);

      const ack = await call(t.baseUrl, 'POST', `${ws()}/inbox/ack`, {
        token: t.agentB.token,
        body: { up_to: seq },
      });
      expect(ack.status).toBe(204);
    });

    it('does not show A→B direct messages in a third party inbox', async () => {
      const sent = await send(note('private to B'));
      const seq = (sent.body as { seq: number }).seq;
      const page = await call(t.baseUrl, 'GET', `${ws()}/inbox?after=${String(seq - 1)}`, {
        token: t.human.token,
      });
      const seqs = (page.body as { messages: { seq: number }[] }).messages.map((m) => m.seq);
      expect(seqs).not.toContain(seq);
    });

    it('streams messages and resumes from Last-Event-ID without loss (MESSAGE_SPEC §4)', async () => {
      const sent = await send(note('streamed'));
      const seq = (sent.body as { seq: number }).seq;
      const event = await firstStreamEvent(
        `${t.baseUrl}${ws()}/stream`,
        t.agentB.token,
        String(seq - 1),
        String(seq),
      );
      expect(event?.event).toBe('message');
      expect(event?.data).toMatchObject({ seq, body: { text: 'streamed' } });
    });
  });
});
