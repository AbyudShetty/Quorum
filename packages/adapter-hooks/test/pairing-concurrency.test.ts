// Hook state is shared by independent processes. Taking a wake or acceptance notification must
// serialize its read and write, not merely perform them in one async function (INV-25, INV-29).
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { LinkInfo } from '@quorum/schemas';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadPairing,
  type CommandContext,
  REQUEST_WAKES_PER_HOUR,
  savePairing,
  runQuorumCommand,
  takeLinkNews,
  takeRequestWake,
  updatePairing,
} from '../src/index.js';

const dirs: string[] = [];
const scratch = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quorum-pairing-lock-'));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const session = (id = 'QRM-1111-1111-1111') => ({ id, attachment: 'at_one' });
const link = (id: string, state: LinkInfo['state'] = 'pending'): LinkInfo => ({
  id,
  state,
  tool: 'claude',
  machine: 'other',
  path: '~/project',
  label: 'claude@project-1',
});

describe('pairing state transactions', () => {
  it('initializes one vendor session only once when two commands arrive together', async () => {
    const dir = await scratch();
    let created = 0;
    let saved = 0;
    let windows = 0;
    const agent: Awaited<ReturnType<CommandContext['agent']>> = {
      session: undefined,
      createSession: () => {
        windows += 1;
        return Promise.resolve({
          session_id: 'sess_one',
          agent: { id: 'ag_one', address: 'agent:one@home' },
          label: 'claude@project-1',
          shared_worktree_with: [],
        });
      },
      links: () => Promise.resolve({ id: 'QRM-1111-1111-1111', links: [] }),
      requestLink: () => Promise.resolve({ state: 'requested' }),
      allowLinks: () => Promise.resolve({ links: [] }),
      detachLinks: () => Promise.resolve([]),
      blockSession: () => Promise.resolve(),
      exportLinks: () => Promise.resolve(''),
    };
    const context: CommandContext = {
      vendor: 'claude-code',
      command: { name: 'id', args: '' },
      input: { session_id: 'one', cwd: dir },
      dataDir: dir,
      human: () =>
        Promise.resolve({
          rotateQuorumId: () => Promise.reject(new Error('Not used in this test')),
          createQuorumId: async () => {
            created += 1;
            await new Promise((resolve) => setTimeout(resolve, 50));
            return {
              ...session(),
              agent: { id: 'ag_one', address: 'agent:one@home' },
              created: true,
              credentials: {
                access_token: 'test-access',
                refresh_token: 'test-refresh',
                token_type: 'Bearer',
                expires_in: 3600,
                refresh_expires_in: 7200,
              },
            };
          },
        }),
      saveSession: () => {
        saved += 1;
        return Promise.resolve();
      },
      agent: () => Promise.resolve(agent),
    };
    const results = await Promise.all([runQuorumCommand(context), runQuorumCommand(context)]);
    expect(results.every((text) => text.includes('QRM-1111-1111-1111'))).toBe(true);
    expect({ created, saved, windows }).toEqual({ created: 1, saved: 1, windows: 1 });
  });
  it('preserves changes to separate sessions made by concurrent hooks', async () => {
    const dir = await scratch();
    const changed = await Promise.allSettled(
      Array.from({ length: 24 }, (_, n) =>
        updatePairing(dir, (sessions) => {
          sessions[`codex:${String(n)}`] = session();
        }),
      ),
    );
    expect(changed.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(Object.keys(await loadPairing(dir))).toHaveLength(24);
  });

  it('takes an accepted-link notification only once across competing watchers', async () => {
    const dir = await scratch();
    const id = 'QRM-2222-2222-2222';
    await savePairing(dir, { 'codex:one': { ...session(), asking: [id] } });
    const news = await Promise.all(
      Array.from({ length: 12 }, () => takeLinkNews(dir, 'codex:one', [link(id, 'linked')])),
    );
    expect(news.flat()).toHaveLength(1);
    expect((await loadPairing(dir))['codex:one']?.asking).toBeUndefined();
  });

  it('enforces the hourly request-wake cap even when checks overlap', async () => {
    const dir = await scratch();
    await savePairing(dir, { 'codex:one': session() });
    const wakes = await Promise.all(
      Array.from({ length: 12 }, (_, n) =>
        takeRequestWake(dir, 'codex:one', [link(`request-${String(n)}`)], { now: 1_000 }),
      ),
    );
    expect(wakes.flat()).toHaveLength(REQUEST_WAKES_PER_HOUR);
    const saved = (await loadPairing(dir))['codex:one'];
    expect(saved?.asked).toHaveLength(REQUEST_WAKES_PER_HOUR);
    expect(saved?.shown).toHaveLength(REQUEST_WAKES_PER_HOUR);
  });

  it('waits for another process to finish its update before reading the state', async () => {
    const dir = await scratch();
    await savePairing(dir, { 'codex:first': session() });
    const path = join(dir, 'hooks', 'pairing.json');
    const lock = join(dir, 'locks', 'pairing-state.lock');
    // The child holds the same PID/token lock as a hook, then commits another session. The
    // parent's update must read after that commit, otherwise it erases the child's session.
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
      const fs = require('node:fs');
      const [file, lock] = process.argv.slice(1);
      fs.writeFileSync(lock, process.pid + '\\n' + require('node:crypto').randomUUID() + '\\n', {flag: 'wx', mode: 0o600});
      process.stdout.write('locked\\n');
      process.stdin.once('data', () => {
        const state = JSON.parse(fs.readFileSync(file, 'utf8'));
        state['claude-code:child'] = { id: 'QRM-3333-3333-3333', attachment: 'at_child' };
        fs.writeFileSync(file, JSON.stringify(state));
        fs.unlinkSync(lock);
        process.exit(0);
      });
    `,
        path,
        lock,
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const exit = once(child, 'exit');
    try {
      await once(child.stdout, 'data');
      let changed = false;
      const update = updatePairing(dir, (sessions) => {
        changed = true;
        sessions['codex:parent'] = session();
      });
      void update.catch(() => undefined); // Observe failure immediately while the child holds it.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(changed).toBe(false);
      child.stdin.write('release');
      await update;
      expect(Object.keys(await loadPairing(dir)).sort()).toEqual([
        'claude-code:child',
        'codex:first',
        'codex:parent',
      ]);
      expect((await exit)[0]).toBe(0);
    } finally {
      child.kill();
      await exit;
    }
  });

  it('releases the lock when a state mutation fails', async () => {
    const dir = await scratch();
    await savePairing(dir, { 'codex:one': session() });
    await expect(
      updatePairing(dir, (sessions) => {
        sessions['codex:lost'] = session();
        throw new Error('failed change');
      }),
    ).rejects.toThrow('failed change');
    await updatePairing(dir, (sessions) => {
      sessions['codex:next'] = session();
    });
    expect(Object.keys(await loadPairing(dir))).toEqual(['codex:one', 'codex:next']);
  });

  it.each(['{', '[]', '{"codex:one":{"id":"id","attachment":"at_one","asked":"bad"}}'])(
    'refuses malformed state without overwriting it: %s',
    async (raw) => {
      const dir = await scratch();
      await mkdir(join(dir, 'hooks'));
      const file = join(dir, 'hooks', 'pairing.json');
      await writeFile(file, raw);
      await expect(loadPairing(dir)).rejects.toThrow(/pairing state/);
      await expect(
        updatePairing(dir, (sessions) => {
          sessions['codex:new'] = session();
        }),
      ).rejects.toThrow(/pairing state/);
      await expect(savePairing(dir, {})).rejects.toThrow(/pairing state/);
      expect(await readFile(file, 'utf8')).toBe(raw);
    },
  );
});
