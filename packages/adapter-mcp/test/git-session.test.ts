import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AttachmentInfo,
  createQuorumMcpServer,
  findGit,
  Outbox,
  sharedWorktreeNotice,
  startSession,
} from '../src/index.js';
import { connectAs, startWorld, type World } from './helpers.js';

const temp = async (): Promise<string> => realpath(await mkdtemp(join(tmpdir(), 'quorum-git-')));

describe('findGit (no git binary needed)', () => {
  it('finds the working tree and git directory from a subfolder', async () => {
    const root = await temp();
    await mkdir(join(root, '.git'));
    await mkdir(join(root, 'src', 'deep'), { recursive: true });
    expect(await findGit(join(root, 'src', 'deep'))).toEqual({
      worktree_root: root,
      common_dir: join(root, '.git'),
    });
  });

  it('follows a linked worktree to the shared common directory', async () => {
    const main = await temp();
    const linked = await temp();
    const gitdir = join(main, '.git', 'worktrees', 'w1');
    await mkdir(gitdir, { recursive: true });
    await writeFile(join(gitdir, 'commondir'), '../..\n');
    await writeFile(join(linked, '.git'), `gitdir: ${gitdir}\n`);
    expect(await findGit(linked)).toEqual({
      worktree_root: linked,
      common_dir: join(main, '.git'),
    });
  });

  it('accepts a relative gitdir, and treats a submodule (no commondir) as its own common dir', async () => {
    const outer = await temp();
    await mkdir(join(outer, 'modules', 'lib'), { recursive: true });
    await mkdir(join(outer, 'lib'));
    await writeFile(join(outer, 'lib', '.git'), 'gitdir: ../modules/lib\n');
    expect(await findGit(join(outer, 'lib'))).toEqual({
      worktree_root: join(outer, 'lib'),
      common_dir: join(outer, 'modules', 'lib'),
    });
  });

  it('returns undefined outside git, for broken pointers, and ignores oversized .git files', async () => {
    const plain = await temp();
    expect(await findGit(plain)).toBeUndefined();
    const broken = await temp();
    await writeFile(join(broken, '.git'), 'gitdir: /no/such/place\n');
    expect(await findGit(broken)).toBeUndefined();
    const huge = await temp();
    await writeFile(join(huge, '.git'), `gitdir: ${'x'.repeat(10_000)}`);
    expect(await findGit(huge)).toBeUndefined();
    expect(await findGit(join(plain, 'missing'))).toBeUndefined();
  });

  const gitAvailable = spawnSync('git', ['--version']).status === 0;
  it.skipIf(!gitAvailable)(
    'agrees with real git for a repository and a linked worktree',
    async () => {
      const repo = await temp();
      const run = (cwd: string, ...args: string[]) => {
        const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
        return r.stdout.trim();
      };
      run(repo, 'init', '-q');
      run(
        repo,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'x',
      );
      const linked = join(await temp(), 'wt');
      run(repo, 'worktree', 'add', '-q', linked, '-b', 'other');
      for (const dir of [repo, linked]) {
        const expected = {
          worktree_root: await realpath(run(dir, 'rev-parse', '--show-toplevel')),
          common_dir: await realpath(resolve(dir, run(dir, 'rev-parse', '--git-common-dir'))),
        };
        expect(await findGit(dir)).toEqual(expected);
      }
    },
  );
});

describe('sessions and the shared working tree (INV-28)', () => {
  let world: World | undefined;
  let mcp: Client | undefined;
  afterEach(async () => {
    await mcp?.close();
    mcp = undefined;
    await world?.server.close();
    world = undefined;
  });

  /** A client signed in as a fresh agent of the world. */
  const agentClient = async (w: World, name: string) => {
    const a = w.server.addAgent(`agent:${name}@lab`, [w.workspace]);
    await w.store.save(name, {
      access_token: a.token,
      refresh_token: a.refreshToken,
      access_expires_at: Date.now() + 3_600_000,
    });
    return { client: await connectAs(w, { credentialKey: name }), address: a.address };
  };

  it('reports other live agents in the same folder, and nobody for another folder', async () => {
    world = await startWorld();
    const shared = await temp();
    const elsewhere = await temp();
    const a = await agentClient(world, 'one');
    const b = await agentClient(world, 'two');
    const c = await agentClient(world, 'three');

    const first = await startSession({ client: a.client, root: shared });
    const second = await startSession({ client: b.client, root: shared });
    const third = await startSession({ client: c.client, root: elsewhere });
    expect(first?.sharedWorktreeWith).toEqual([]);
    expect(second?.sharedWorktreeWith).toEqual([a.address]);
    expect(third?.sharedWorktreeWith).toEqual([]);

    await first?.end();
    await first?.end(); // safe twice
    const later = await startSession({ client: c.client, root: shared });
    expect(later?.sharedWorktreeWith).toEqual([b.address]); // the first agent left
  });

  it('does not count two sessions of the same agent as a collision', async () => {
    world = await startWorld();
    const root = await temp();
    const a = await agentClient(world, 'solo');
    await startSession({ client: a.client, root });
    expect((await startSession({ client: a.client, root }))?.sharedWorktreeWith).toEqual([]);
  });

  it('puts all worktrees of one repository under one repo id, each with its own worktree id', async () => {
    world = await startWorld();
    const main = await temp();
    const linked = await temp();
    await mkdir(join(main, '.git', 'worktrees', 'w'), { recursive: true });
    await writeFile(join(main, '.git', 'worktrees', 'w', 'commondir'), '../..');
    await writeFile(join(linked, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'w')}`);
    const a = await agentClient(world, 'main');
    const b = await agentClient(world, 'linked');
    const one = await a.client.createSession({
      vendor_session_id: 's1',
      root: main,
      git: (await findGit(main)) ?? { worktree_root: '', common_dir: '' },
    });
    const two = await b.client.createSession({
      vendor_session_id: 's2',
      root: linked,
      git: (await findGit(linked)) ?? { worktree_root: '', common_dir: '' },
    });
    expect(one.repo).toBe(two.repo);
    expect(one.worktree).not.toBe(two.worktree);
    expect(two.shared_worktree_with).toEqual([]); // different working trees: no collision
  });

  it('goes unregistered, not broken, when the server refuses or is down', async () => {
    world = await startWorld();
    const errors: unknown[] = [];
    await world.store.save('human', {
      access_token: world.human.token,
      refresh_token: 'qrm_rt_' + 'x'.repeat(43),
      access_expires_at: Date.now() + 3_600_000,
    });
    const refused = await startSession({
      client: await connectAs(world, { credentialKey: 'human' }), // humans may not open sessions
      root: await temp(),
      onError: (e) => errors.push(e),
    });
    expect(refused).toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  const attachmentOf = (w: World): AttachmentInfo => ({
    attachment: 'at_test',
    agent: w.agent.address,
    workspaces: [w.workspace],
    vendor: 'claude-code',
    root: 'C:/work/api',
    wake: 'off',
    lease_enforcement: 'warn',
  });

  const connectMcp = async (w: World, sharedWorktreeWith: string[]) => {
    const server = createQuorumMcpServer({
      client: await connectAs(w),
      outbox: new Outbox(w.dataDir, 'at_test'),
      attachment: attachmentOf(w),
      session: { sharedWorktreeWith },
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    mcp = new Client({ name: 'test', version: '0' });
    await mcp.connect(a);
    return mcp;
  };

  it('warns the agent in its instructions and in quorum_status when it shares a folder', async () => {
    world = await startWorld();
    const client = await connectMcp(world, ['agent:codex-web@abhijna']);
    expect(client.getInstructions()).toContain(
      'WARNING: agent:codex-web@abhijna is working in the same folder',
    );
    expect(client.getInstructions()).toContain('never git add -A');
    const status = await client.callTool({ name: 'quorum_status', arguments: {} });
    expect((status.content as { text: string }[])[0]?.text).toContain(
      'WARNING: agent:codex-web@abhijna',
    );
  });

  it('says nothing when the folder is not shared', async () => {
    world = await startWorld();
    const client = await connectMcp(world, []);
    expect(client.getInstructions()).not.toContain('WARNING');
    expect(sharedWorktreeNotice([])).toBeUndefined();
    expect(sharedWorktreeNotice(['a', 'b'])).toContain('a, b are working');
  });
});
