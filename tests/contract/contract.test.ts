// The /v1 contract: every implementation (real server, fake server) must pass this suite.
// Skipped until a target is given:  QUORUM_CONTRACT_TARGET=<module exporting createTarget> npm test
// See tests/contract/README.md.
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readBootstrapCode } from '@quorum/local';
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

  // --- Added after the first freeze (contract answers to the adapter contract's questions) ---

  describe('local sign-in with the bootstrap code (ARCHITECTURE §6)', () => {
    const exchange = (code: string) =>
      call(t.baseUrl, 'POST', '/v1/auth/local-bootstrap', { body: { code } });

    it('swaps a fresh code once for the owner human tokens, then removes it', async (context) => {
      if (!t.bootstrap) return context.skip();
      await t.bootstrap.reissue();
      const file = await readBootstrapCode(t.bootstrap.dataDir);
      expectPayload('localBootstrapFile', file);
      const reply = await exchange(file?.code ?? '');
      expect(reply.status).toBe(200);
      expectPayload('localBootstrapResponse', reply.body);
      const token = (reply.body as { credentials: { access_token: string } }).credentials
        .access_token;
      expect((await call(t.baseUrl, 'GET', '/v1/workspaces', { token })).status).toBe(200);
      expect(await readBootstrapCode(t.bootstrap.dataDir)).toBeUndefined();
      const again = await exchange(file?.code ?? '');
      expect(again.status).toBe(401);
      expectError(again.body);
    });

    it('refuses a wrong, malformed, replaced or expired code', async (context) => {
      if (!t.bootstrap) return context.skip();
      await t.bootstrap.reissue();
      const replaced = (await readBootstrapCode(t.bootstrap.dataDir))?.code ?? '';
      await t.bootstrap.reissue();
      const current = (await readBootstrapCode(t.bootstrap.dataDir))?.code ?? '';
      expect((await exchange(replaced)).status).toBe(401);
      expect((await exchange(`qrm_bc_${'A'.repeat(43)}`)).status).toBe(401);
      expect((await exchange('nope')).status).toBe(400);
      if (t.advanceClock) {
        t.advanceClock(11 * 60_000);
        expect((await exchange(current)).status).toBe(401);
      }
    });
  });

  describe('attachments, inbox default, presence and sessions', () => {
    const attach = async (folder: string, vendor: string) => {
      const root = (await t.makeFolder?.(folder)) ?? '';
      const reply = await call(t.baseUrl, 'POST', '/v1/attachments', {
        token: t.human.token,
        body: { root, vendor, workspaces: [t.workspace] },
      });
      expect(reply.status).toBe(201);
      expectPayload('attachmentCreated', reply.body);
      const created = reply.body as {
        attachment: { id: string };
        agent: { address: string };
        credentials: { access_token: string };
      };
      return {
        root,
        id: created.attachment.id,
        address: created.agent.address,
        token: created.credentials.access_token,
      };
    };

    const message = (from: string, token: string, type: string, to: string[], body: unknown) =>
      call(t.baseUrl, 'POST', `${ws()}/messages`, {
        token,
        body: {
          spec: 'quorum/1',
          id: `msg_${ulid()}`,
          workspace: t.workspace,
          from,
          to,
          type,
          type_version: 1,
          created_at: new Date().toISOString(),
          body,
        },
      });

    it('PATCH changes wake settings, for humans only (INV-30)', async (context) => {
      if (!t.makeFolder) return context.skip();
      const a = await attach('patch', 'codex');
      const path = `/v1/attachments/${a.id}`;
      const reply = await call(t.baseUrl, 'PATCH', path, {
        token: t.human.token,
        body: { wake: 'direct', wake_types: ['request'], lease_enforcement: 'block' },
      });
      expect(reply.status).toBe(200);
      expectPayload('attachment', reply.body);
      expect(reply.body).toMatchObject({
        id: a.id,
        wake: 'direct',
        wake_types: ['request'],
        lease_enforcement: 'block',
      });
      const patch = (token: string, body: unknown, target = path) =>
        call(t.baseUrl, 'PATCH', target, { token, body }).then((r) => r.status);
      expect(await patch(t.human.token, {})).toBe(400);
      expect(await patch(t.human.token, { root: a.root })).toBe(400);
      expect(await patch(a.token, { wake: 'all' })).toBe(403);
      expect(
        await patch(t.human.token, { wake: 'all' }, `/v1/attachments/at_${'0'.repeat(26)}`),
      ).toBe(404);
    });

    it('DELETE detaches: the agent token stops working at once (INV-13)', async (context) => {
      if (!t.makeFolder) return context.skip();
      const a = await attach('detach', 'codex');
      const reply = await call(t.baseUrl, 'DELETE', `/v1/attachments/${a.id}`, {
        token: t.human.token,
      });
      expect(reply.status).toBe(204);
      expect((await call(t.baseUrl, 'GET', `${ws()}/inbox`, { token: a.token })).status).toBe(401);
    });

    it('inbox without `after` resumes after the last ack; after=0 starts at the beginning', async (context) => {
      if (!t.makeFolder) return context.skip();
      const a = await attach('inbox-a', 'claude-code');
      const b = await attach('inbox-b', 'codex');
      const first = await message(a.address, a.token, 'note', [b.address], { text: 'one' });
      await message(a.address, a.token, 'note', [b.address], { text: 'two' });
      const texts = async (query = '') => {
        const reply = await call(t.baseUrl, 'GET', `${ws()}/inbox${query}`, { token: b.token });
        return (reply.body as { messages: { body: { text: string } }[] }).messages.map(
          (m) => m.body.text,
        );
      };
      expect(await texts()).toEqual(['one', 'two']);
      const ack = await call(t.baseUrl, 'POST', `${ws()}/inbox/ack`, {
        token: b.token,
        body: { up_to: (first.body as { seq: number }).seq },
      });
      expect(ack.status).toBe(204);
      expect(await texts()).toEqual(['two']);
      expect(await texts('?after=0')).toEqual(['one', 'two']);
    });

    it('lists the folder name (never a path) and presence from heartbeats (MESSAGE_SPEC §5.10)', async (context) => {
      if (!t.makeFolder || !t.advanceClock) return context.skip();
      const a = await attach('presence-app', 'codex');
      const find = async () => {
        const reply = await call(t.baseUrl, 'GET', `${ws()}/agents`, { token: t.human.token });
        expectPayload('agentList', reply.body);
        return (reply.body as { agents: { address: string }[] }).agents.find(
          (x) => x.address === a.address,
        );
      };
      const before = await find();
      expect(before).toMatchObject({ folder: 'folder-presence-app', presence: 'offline' });
      expect(JSON.stringify(before)).not.toContain(a.root);
      const beat = (status: string) =>
        message(a.address, a.token, 'heartbeat', ['*'], { status, resources_in_use: [] });
      expect((await beat('working')).status).toBe(201);
      expect(await find()).toMatchObject({ presence: 'online', status: 'working' });
      t.advanceClock(89_000);
      expect(await find()).toMatchObject({ presence: 'online' });
      t.advanceClock(2_000);
      expect(await find()).toMatchObject({ presence: 'offline', status: 'offline' });
      await beat('idle');
      expect(await find()).toMatchObject({ presence: 'online', status: 'idle' });
      await beat('offline');
      expect(await find()).toMatchObject({ presence: 'offline', status: 'offline' });
    });

    it('warns both agents in a shared working tree (INV-28), and sessions end once', async (context) => {
      if (!t.makeFolder) return context.skip();
      const a = await attach('shared', 'claude-code');
      const b = await attach('shared', 'codex');
      const register = (agent: { token: string; root: string }) =>
        call(t.baseUrl, 'POST', '/v1/sessions', {
          token: agent.token,
          body: { vendor_session_id: `s-${ulid()}`, root: agent.root },
        });
      const first = await register(a);
      expect(first.status).toBe(201);
      expectPayload('sessionCreated', first.body);
      expect(first.body).toMatchObject({ shared_worktree_with: [] });
      const second = await register(b);
      expect(second.status).toBe(201);
      expect(second.body).toMatchObject({ shared_worktree_with: [a.address] });

      for (const agent of [a, b]) {
        const inbox = await call(t.baseUrl, 'GET', `${ws()}/inbox?after=0`, { token: agent.token });
        const notices = (
          inbox.body as { messages: { from: string; body: { kind?: string } }[] }
        ).messages.filter((m) => m.from === 'system:quorum' && m.body.kind === 'shared_worktree');
        expect(notices.length, agent.address).toBeGreaterThan(0);
        for (const notice of notices) {
          const checked = validateDeliveredEnvelope(notice);
          expect(checked.ok ? [] : checked.issues).toEqual([]);
        }
      }

      const sessionPath = `/v1/sessions/${(first.body as { session_id: string }).session_id}`;
      expect((await call(t.baseUrl, 'DELETE', sessionPath, { token: a.token })).status).toBe(204);
      expect((await call(t.baseUrl, 'DELETE', sessionPath, { token: a.token })).status).toBe(404);
    });

    it('only agents register sessions', async () => {
      const reply = await call(t.baseUrl, 'POST', '/v1/sessions', {
        token: t.human.token,
        body: { vendor_session_id: 'x', root: '/tmp/x' },
      });
      expect(reply.status).toBe(403);
      expectError(reply.body);
    });
  });
});
