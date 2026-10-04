// IC2 (TEAM_PLAN §3): the CLI and the adapter client against the REAL local server, not the fake.
// Same process, real HTTP, real SQLite, real data directory; only the keychain is in memory.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryCredentialStore, QuorumClient, startSession } from '@quorum/adapter-mcp';
import { readBootstrapCode, readDiscovery } from '@quorum/local';
import { type LocalServer, startLocalServer } from '@quorum/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CliEnv, main } from '../src/index.js';

let root: string;
let server: LocalServer;
let env: CliEnv;
const out: string[] = [];
const err: string[] = [];
const run = async (...argv: string[]) => {
  out.length = 0;
  err.length = 0;
  const code = await main(argv, env);
  return { code, out: out.join(''), err: err.join('') };
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'quorum-ic2-'));
  server = await startLocalServer({ dataDir: join(root, 'data'), idleShutdownMs: 0 });
  env = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    store: new MemoryCredentialStore(),
    dataDir: server.dataDir,
    killServer: () => void server.close(),
  };
}, 60_000);

afterAll(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

const folder = async (name: string) => {
  const dir = join(root, 'projects', name);
  await mkdir(dir, { recursive: true });
  return dir;
};

describe('IC2: CLI and adapter against the real local server', () => {
  let api = '';
  let web = '';
  let attachmentA = '';
  let attachmentB = '';
  let agentA = '';
  let agentB = '';

  it('signs in the owner with the bootstrap code, once', async () => {
    const first = await run('login');
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/Signed in as human:/);
    expect(await readBootstrapCode(server.dataDir)).toBeUndefined();
    const again = await run('login');
    expect(again.code).toBe(1);
    expect(again.err).toContain('restart the local server');
  });

  it('creates a workspace and attaches Claude Code and Codex folders', async () => {
    expect((await run('attach', await folder('api'), '--vendor', 'claude-code')).err).toContain(
      'quorum workspace create',
    );
    const created = await run('workspace', 'create', 'demo');
    expect(created.code).toBe(0);
    expect((await run('workspace', 'list')).out).toContain('demo');

    api = await folder('api');
    web = await folder('web');
    const a = await run('attach', api, '--vendor', 'claude-code');
    expect(a.code).toBe(0);
    agentA = /as (agent:\S+) /.exec(a.out)?.[1] ?? '';
    attachmentA = /\((at_[0-9A-Z]{26})\)/.exec(a.out)?.[1] ?? '';
    const b = await run('attach', web, '--vendor', 'codex', '--wake', 'direct');
    expect(b.code).toBe(0);
    agentB = /as (agent:\S+) /.exec(b.out)?.[1] ?? '';
    attachmentB = /\((at_[0-9A-Z]{26})\)/.exec(b.out)?.[1] ?? '';
    expect(agentA).toMatch(/^agent:claude-api@/);
    expect(agentB).toMatch(/^agent:codex-web@/);
  });

  it('refuses to attach the data directory (INV-25)', async () => {
    const reply = await run('attach', server.dataDir, '--vendor', 'codex');
    expect(reply.code).toBe(64);
  });

  it('delivers a note from Claude Code to Codex, framed as untrusted data (INV-9)', async () => {
    const sent = await run(
      'send',
      '--attachment',
      attachmentA,
      '--to',
      agentB,
      '--text',
      'Please review the API diff.',
    );
    expect(sent.code).toBe(0);
    const inbox = await run('inbox', '--attachment', attachmentB);
    expect(inbox.code).toBe(0);
    expect(inbox.out).toContain('Please review the API diff.');
    expect(inbox.out).toContain(agentA);
    expect(inbox.out).toMatch(/untrusted/i);
    // Acknowledged: the next read starts after it.
    expect((await run('inbox', '--attachment', attachmentB)).out).toContain('No new messages');
  });

  it('warns both adapters when they share a working tree (INV-28)', async () => {
    const connect = (attachment: string) =>
      QuorumClient.connect({
        dataDir: server.dataDir,
        credentialKey: attachment,
        store: env.store,
      });
    const clientA = await connect(attachmentA);
    const clientB = await connect(attachmentB);
    const first = await startSession({ client: clientA, root: api });
    const second = await startSession({ client: clientB, root: api });
    expect(first?.sharedWorktreeWith).toEqual([]);
    expect(second?.sharedWorktreeWith).toEqual([agentA]);
    const [workspace] = await clientA.workspaces();
    const page = await clientA.inbox(workspace?.id ?? '', { after: 0 });
    expect(
      page.messages.some(
        (m) =>
          m.from === 'system:quorum' && (m.body as { kind?: string }).kind === 'shared_worktree',
      ),
    ).toBe(true);
    await first?.end();
    await second?.end();
  });

  it('runs vendor hooks: mail next to a tool result, as JSON the vendor reads', async () => {
    await run('send', '--attachment', attachmentA, '--to', agentB, '--text', 'Hook delivery.');
    env.stdin = () =>
      Promise.resolve(JSON.stringify({ session_id: 's-1', hook_event_name: 'PostToolUse' }));
    const result = await run('hook', 'codex', 'post-tool', '--attachment', attachmentB);
    expect(result.code).toBe(0);
    const output = JSON.parse(result.out) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(output.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(output.hookSpecificOutput.additionalContext).toContain('Hook delivery.');
    expect((await run('hook', 'codex', 'post-tool', '--attachment', attachmentB)).out).toBe('');
    env.stdin = () => Promise.resolve('not json');
    expect((await run('hook', 'codex', 'post-tool', '--attachment', attachmentB)).code).toBe(0);
    expect((await run('hook', 'emacs', 'post-tool', '--attachment', attachmentB)).code).toBe(64);
  });

  it('exports a log that verifies', async () => {
    const workspace = /(ws_[0-9A-Z]{26})/.exec((await run('workspace', 'list')).out)?.[1] ?? '';
    const exported = await run('export', '--workspace', workspace);
    expect(exported.code).toBe(0);
    const file = join(root, 'log.jsonl');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, exported.out);
    expect((await run('verify', file, '--workspace', workspace)).out).toContain(
      'hash chain intact',
    );
  });

  it('reports status, then stops the server only after it proves its identity', async () => {
    const status = await run('status');
    expect(status.out).toContain('verified');
    const stopped = await run('stop');
    expect(stopped.code).toBe(0);
    await server.closed;
    expect(await readDiscovery(server.dataDir)).toBeUndefined();
    expect((await run('stop')).out).toContain('No local Quorum server');
  });
});
