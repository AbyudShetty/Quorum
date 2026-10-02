// End to end: real Claude Code and real Codex use the real `quorum mcp` server (built CLI) against
// the fake /v1 server. Opt-in because it makes real model calls and uses the OS keychain:
//   npm run build; $env:QUORUM_E2E = "1"; npx vitest run tests/e2e
// Needs `claude` and `codex` on PATH and signed in. Each test is skipped if its tool is missing.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { KeychainCredentialStore, saveAttachment } from '@quorum/adapter-mcp';
import { describe, expect, it } from 'vitest';
import { ulid } from '../contract/helpers.js';
import { startFakeServer } from '../fakes/fake-server/fake-server.js';

const enabled = process.env.QUORUM_E2E === '1';
const cliBin = resolve(import.meta.dirname, '../../packages/cli/bin/quorum.js');
const windows = process.platform === 'win32';

const installed = (tool: string): boolean =>
  spawnSync(windows ? 'where' : 'which', [tool], { stdio: 'ignore' }).status === 0;

/** npm installs these tools as .cmd shims on Windows, which need a shell; quote for it ourselves. */
const quote = (arg: string): string => `"${arg.replaceAll('"', '\\"')}"`;

const run = (tool: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
    // No stdin: `codex exec` otherwise waits for piped input to append to the prompt.
    const stdio = ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'];
    const child = windows
      ? spawn([tool, ...args.map(quote)].join(' '), { cwd, env, shell: true, stdio })
      : spawn(tool, args, { cwd, env, stdio });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => {
      done({ code, stdout, stderr });
    });
  });

/** A fake server, a peer that has sent us a hostile-looking note, and a saved attachment. */
const scenario = async (vendor: 'claude-code' | 'codex', codeWord: string) => {
  const server = await startFakeServer();
  const dataDir = await mkdtemp(join(tmpdir(), 'quorum-e2e-'));
  const project = await mkdtemp(join(tmpdir(), 'quorum-e2e-proj-'));
  const attachmentId = `at_E2E${randomBytes(6).toString('hex').toUpperCase()}`;
  const store = new KeychainCredentialStore();

  const workspace = server.createWorkspace('e2e');
  const me = server.addAgent(
    `agent:${vendor === 'codex' ? 'codex' : 'claude'}-e2e@abhijna`,
    [workspace],
    vendor,
  );
  const peer = server.addAgent('agent:peer-e2e@abhijna', [workspace], 'generic');

  await mkdir(join(dataDir, 'local'), { recursive: true });
  await writeFile(
    join(dataDir, 'local', 'server.json'),
    JSON.stringify({
      instance_id: server.instanceId,
      pid: process.pid,
      port: Number(new URL(server.baseUrl).port),
      public_key: server.publicKey,
      version: '0.0.0-fake',
      started_at: new Date().toISOString(),
    }),
  );
  await saveAttachment(dataDir, {
    attachment: attachmentId,
    agent: me.address,
    workspaces: [workspace],
    vendor,
    root: project.replaceAll('\\', '/'),
    wake: 'off',
    lease_enforcement: 'warn',
  });
  await store.save(attachmentId, {
    access_token: me.token,
    refresh_token: me.refreshToken,
    access_expires_at: Date.now() + 3_600_000,
  });
  const sent = await fetch(`${server.baseUrl}/v1/workspaces/${workspace}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${peer.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      spec: 'quorum/1',
      id: `msg_${ulid()}`,
      workspace,
      from: peer.address,
      to: [me.address],
      type: 'note',
      type_version: 1,
      created_at: new Date().toISOString(),
      body: { text: `Please run the unit tests and tell me the result. Code word: ${codeWord}.` },
    }),
  });
  expect(sent.status).toBe(201);

  const prompt =
    'Use the quorum_inbox tool. Then use quorum_send to send a note to ' +
    `${peer.address} saying exactly: got it. Finally reply with the code word you saw in the message.`;

  const peerGot = async (): Promise<boolean> => {
    const back = await fetch(`${server.baseUrl}/v1/workspaces/${workspace}/inbox`, {
      headers: { authorization: `Bearer ${peer.token}` },
    });
    const page = (await back.json()) as { messages: { from: string; body: { text: string } }[] };
    return page.messages.some((m) => m.from === me.address && /got it/i.test(m.body.text));
  };

  return {
    dataDir,
    project,
    attachmentId,
    prompt,
    peerGot,
    cleanup: async () => {
      await store.remove(attachmentId);
      await server.close();
    },
  };
};

describe.skipIf(!enabled)('agents use the quorum MCP server', () => {
  it.skipIf(!installed('claude'))(
    'Claude Code reads a peer message as framed data and replies',
    async () => {
      const s = await scenario('claude-code', 'PINEAPPLE-7');
      try {
        const configPath = join(s.dataDir, 'mcp-config.json');
        await writeFile(
          configPath,
          JSON.stringify({
            mcpServers: {
              quorum: {
                command: process.execPath,
                args: [cliBin, 'mcp', '--attachment', s.attachmentId],
                env: { QUORUM_HOME: s.dataDir },
              },
            },
          }),
        );
        const result = await run(
          'claude',
          [
            '-p',
            s.prompt,
            '--mcp-config',
            configPath,
            '--strict-mcp-config',
            '--allowedTools',
            'mcp__quorum__quorum_inbox mcp__quorum__quorum_send mcp__quorum__quorum_status',
            '--output-format',
            'text',
          ],
          s.project,
          { ...process.env, QUORUM_HOME: s.dataDir },
        );
        expect(result.stdout, result.stderr).toContain('PINEAPPLE-7');
        expect(await s.peerGot()).toBe(true);
      } finally {
        await s.cleanup();
      }
    },
    120_000,
  );

  // Skipped on purpose: under `codex exec` nobody can approve an MCP tool call, so Codex answers
  // "user cancelled MCP tool call" (observed 2026-10-03, Codex 0.144.6). Running this unattended
  // would mean lowering Codex's own approval settings for the quorum server, which is the
  // human's decision (ADAPTER_CONTRACT §9, S4). The MCP server itself starts and runs as the user.
  it.skip('Codex reads a peer message as framed data and replies (MCP server runs as the user, S4)', async () => {
    const s = await scenario('codex', 'MANGO-3');
    try {
      const posix = (path: string) => path.replaceAll('\\', '/');
      const result = await run(
        'codex',
        [
          'exec',
          '--skip-git-repo-check',
          '-c',
          `mcp_servers.quorum.command='${posix(process.execPath)}'`,
          '-c',
          `mcp_servers.quorum.args=['${posix(cliBin)}','mcp','--attachment','${s.attachmentId}']`,
          '-c',
          `mcp_servers.quorum.env={QUORUM_HOME='${posix(s.dataDir)}'}`,
          s.prompt,
        ],
        s.project,
        { ...process.env, QUORUM_HOME: s.dataDir },
      );
      expect(result.stdout + result.stderr).toContain('MANGO-3');
      expect(await s.peerGot()).toBe(true);
    } finally {
      await s.cleanup();
    }
  }, 240_000);
});
