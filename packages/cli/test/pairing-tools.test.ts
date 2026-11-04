// Calls through the actual MCP SDK, including its default argument normalization, must use
// the calling hook's session even when a different window was active most recently.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createPairingMcpServer,
  saveAttachment,
  type AttachmentInfo,
  type QuorumClient,
} from '@quorum/adapter-mcp';
import { savePairing, saveHookState } from '@quorum/adapter-hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { preparePairingToolCall, resolvePairingToolCall } from '../src/pairing-tools.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const setup = async (vendor: 'codex' | 'claude-code' = 'codex') => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quorum-tool-binding-'));
  dirs.push(dataDir);
  const root = join(dataDir, 'projects');
  await mkdir(root);
  for (const name of ['a', 'b']) {
    await mkdir(join(root, name));
    await saveAttachment(dataDir, {
      attachment: `at_${name}`,
      agent: `agent:codex-${name}@lab`,
      vendor,
      root: join(root, name),
      workspaces: [],
      wake: 'direct',
      lease_enforcement: 'warn',
    });
    await saveHookState(dataDir, `at_${name}`, {
      sessions: { [name]: `sess_${name}` },
      windows: {
        [`sess_${name}`]: {
          key: name,
          label: `codex@${name}-1`,
          vendorPid: 42,
          activeAtMs: name === 'b' ? Date.now() : 1,
        },
      },
    });
  }
  await savePairing(dataDir, {
    [`${vendor}:a`]: { id: 'QRM-1111-1111-1111', attachment: 'at_a' },
    [`${vendor}:b`]: { id: 'QRM-2222-2222-2222', attachment: 'at_b' },
  });
  const proofArgs = async (
    session: string,
    tool: string,
    args: Record<string, unknown> = {},
    cwd = join(root, session),
  ) => {
    const text = await preparePairingToolCall(
      dataDir,
      {
        session_id: session,
        cwd,
        tool_name: `mcp__quorum__${tool}`,
        tool_input: args,
      },
      vendor,
    );
    return JSON.parse(text) as {
      hookSpecificOutput: { permissionDecision: string; updatedInput?: Record<string, unknown> };
    };
  };
  return { dataDir, root, proofArgs };
};

describe('Codex pairing tools are bound per invocation', () => {
  it.each(['codex', 'claude-code'] as const)(
    'rejects stale window proofs and unjoined replacements in %s',
    async (vendor) => {
      const s = await setup(vendor);
      const before = (await s.proofArgs('a', 'quorum_status')).hookSpecificOutput.updatedInput;
      if (!before) throw new Error('Missing rewritten arguments');
      await saveHookState(s.dataDir, 'at_a', { sessions: {}, windows: {} });
      expect(
        await resolvePairingToolCall(s.dataDir, 'quorum_status', before, vendor),
      ).toBeUndefined();
      expect(
        (await s.proofArgs('unjoined-replacement', 'quorum_status', {}, join(s.root, 'a')))
          .hookSpecificOutput.permissionDecision,
      ).toBe('deny');
    },
  );

  it('rewrites Claude inputs without granting a permission decision', async () => {
    const s = await setup('claude-code');
    const prepared = (await s.proofArgs('a', 'quorum_status')).hookSpecificOutput;
    expect(prepared).not.toHaveProperty('permissionDecision');
    expect(
      await resolvePairingToolCall(
        s.dataDir,
        'quorum_status',
        prepared.updatedInput ?? {},
        'claude-code',
      ),
    ).toEqual({ attachment: 'at_a', window: 'sess_a' });
  });
  it('rejects unjoined sessions in the same or another folder, and mismatched joined folders', async () => {
    const s = await setup();
    for (const [session, cwd] of [
      ['unjoined', join(s.root, 'a')],
      ['unjoined', s.root],
      ['a', join(s.root, 'b')],
    ]) {
      expect(
        (await s.proofArgs(session ?? '', 'quorum_status', {}, cwd)).hookSpecificOutput
          .permissionDecision,
      ).toBe('deny');
    }
    expect(await resolvePairingToolCall(s.dataDir, 'quorum_status', {})).toBeUndefined();
    expect(
      await resolvePairingToolCall(s.dataDir, 'quorum_status', {
        _quorum_call: 'codex:a',
        session_id: 'a',
      }),
    ).toBeUndefined();
  });

  it('routes concurrent calls independently, despite another session being newer', async () => {
    const s = await setup();
    const calls: string[] = [];
    const server = createPairingMcpServer({
      resolve: async (call) => {
        const bound = await resolvePairingToolCall(s.dataDir, call.tool, call.args);
        if (!bound) return undefined;
        const client = {
          links: () => {
            calls.push(`${bound.attachment} status`);
            return Promise.resolve({ id: bound.attachment, links: [] });
          },
          sendToLinks: () => {
            calls.push(`${bound.attachment} send`);
            return Promise.resolve({ sent: [] });
          },
          inbox: () => {
            calls.push(`${bound.attachment} inbox`);
            return Promise.resolve({ messages: [] });
          },
        } as unknown as QuorumClient;
        return {
          client,
          attachment: { agent: 'agent:codex@lab', workspaces: ['ws_test'] } as AttachmentInfo,
        };
      },
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 'test', version: '0' });
    await server.connect(serverSide);
    await mcp.connect(clientSide);
    try {
      const a = (await s.proofArgs('a', 'quorum_status')).hookSpecificOutput.updatedInput;
      const b = (await s.proofArgs('b', 'quorum_status')).hookSpecificOutput.updatedInput;
      await Promise.all([
        mcp.callTool({ name: 'quorum_status', arguments: a }),
        mcp.callTool({ name: 'quorum_status', arguments: b }),
      ]);
      expect(calls.sort()).toEqual(['at_a status', 'at_b status']);
      const replay = await mcp.callTool({ name: 'quorum_status', arguments: a });
      expect(JSON.stringify(replay)).toContain('not in Quorum');
      const missing = await mcp.callTool({ name: 'quorum_status', arguments: {} });
      expect(JSON.stringify(missing)).toContain('not in Quorum');
      const send = (
        await s.proofArgs('a', 'quorum_send', { to: ['QRM-1111-1111-1111'], text: 'hi' })
      ).hookSpecificOutput.updatedInput;
      await mcp.callTool({ name: 'quorum_send', arguments: send });
      const inbox = (await s.proofArgs('b', 'quorum_inbox')).hookSpecificOutput.updatedInput;
      await mcp.callTool({ name: 'quorum_inbox', arguments: inbox });
      expect(calls).toContain('at_a send');
      expect(calls).toContain('at_b inbox');
    } finally {
      await mcp.close();
      await server.close();
    }
  });
});
