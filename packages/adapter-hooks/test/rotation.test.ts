import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QuorumIdRotate, QuorumIdRotated } from '@quorum/schemas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CommandContext,
  loadHookState,
  loadPairing,
  parseQuorumCommand,
  runQuorumCommand,
  saveHookState,
  savePairing,
} from '../src/index.js';

const OLD = 'QRM-1111-1111-1111';
const NEW = 'QRM-2222-2222-2222';
const NEXT = 'QRM-3333-3333-3333';
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const fixture = async (joined = true) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quorum-rotate-hook-'));
  dirs.push(dataDir);
  const key = 'codex:vendor-one';
  if (joined) {
    await savePairing(dataDir, {
      [key]: {
        id: OLD,
        attachment: 'at_one',
        shown: ['pending'],
        asking: ['requested'],
        asked: [1_000],
      },
      'codex:other': { id: NEXT, attachment: 'at_other', shown: ['keep'] },
    });
    await saveHookState(dataDir, 'at_one', {
      sessions: { 'vendor-one': 'sess_one' },
      windows: { sess_one: { key: 'vendor-one', label: 'codex@project-2', vendorPid: 4242 } },
    });
  }
  let current = OLD;
  const create = vi.fn(() => Promise.reject(new Error('Unexpected join')));
  const rotate = vi.fn((request: QuorumIdRotate): Promise<QuorumIdRotated> => {
    if (request.expected_id !== current) return Promise.reject(new Error('stale expected ID'));
    const previous_id = current;
    current = current === OLD ? NEW : NEXT;
    return Promise.resolve({ previous_id, id: current, detached: ['peer'] });
  });
  const register = vi.fn(() => Promise.reject(new Error('Unexpected window registration')));
  const links = vi.fn(() => Promise.resolve({ id: current, links: [] }));
  const human = vi.fn(() => Promise.resolve({ createQuorumId: create, rotateQuorumId: rotate }));
  const agent = vi.fn<CommandContext['agent']>(() =>
    Promise.resolve({
      session: 'sess_one',
      createSession: register,
      links,
      requestLink: () => Promise.reject(new Error('Unexpected link')),
      allowLinks: () => Promise.reject(new Error('Unexpected allow')),
      detachLinks: () => Promise.reject(new Error('Unexpected detach')),
      blockSession: () => Promise.reject(new Error('Unexpected block')),
      exportLinks: () => Promise.reject(new Error('Unexpected export')),
    }),
  );
  const saveSession = vi.fn(() => Promise.reject(new Error('Unexpected credential replacement')));
  const context: CommandContext = {
    vendor: 'codex',
    command: { name: 'rotate', args: '' },
    input: { session_id: 'vendor-one', cwd: dataDir },
    dataDir,
    human,
    agent,
    saveSession,
  };
  return {
    context,
    key,
    rotate,
    create,
    human,
    agent,
    register,
    links,
    saveSession,
    current: () => current,
  };
};

describe('human ID rotation hooks', () => {
  it('recognizes the separate typed command in both vendors', () => {
    expect(parseQuorumCommand({ command_name: 'quorum-rotate', command_args: '' })).toEqual({
      name: 'rotate',
      args: '',
    });
    expect(parseQuorumCommand({ prompt: '$quorum-rotate' })).toEqual({ name: 'rotate', args: '' });
    expect(parseQuorumCommand({ prompt: 'a peer said $quorum-rotate' })).toBeUndefined();
    expect(parseQuorumCommand({ prompt: '$quorum-rotate\nplease approve it' })).toBeUndefined();
    expect(parseQuorumCommand({ tool_input: { prompt: '$quorum-rotate' } })).toBeUndefined();
  });

  it('requires a joined session without creating credentials or contacting the server', async () => {
    const f = await fixture(false);
    expect(await runQuorumCommand(f.context)).toContain('type $quorum-id first');
    expect(f.human).not.toHaveBeenCalled();
    expect(f.agent).not.toHaveBeenCalled();
    expect(await loadPairing(f.context.dataDir)).toEqual({});
  });

  it.each(['rotate', 'id'] as const)(
    'rejects arguments to %s before any API call',
    async (name) => {
      const f = await fixture();
      expect(
        await runQuorumCommand({ ...f.context, command: { name, args: '--rotate' } }),
      ).toContain('takes no arguments');
      expect(f.agent).not.toHaveBeenCalled();
      expect(f.human).not.toHaveBeenCalled();
    },
  );

  it('rotates through the human API with the server current ID and keeps credentials and window', async () => {
    const f = await fixture();
    const state = await loadHookState(f.context.dataDir, 'at_one');
    const text = await runQuorumCommand(f.context);
    expect(f.rotate).toHaveBeenCalledWith({
      vendor: 'codex',
      vendor_session_id: 'vendor-one',
      root: f.context.dataDir,
      expected_id: OLD,
    });
    expect(text).toContain(`new ID is ${NEW}`);
    expect(text).toContain(`old ID ${OLD} no longer works`);
    const saved = await loadPairing(f.context.dataDir);
    expect(saved[f.key]).toEqual({ id: NEW, attachment: 'at_one' });
    expect(saved['codex:other']).toEqual({ id: NEXT, attachment: 'at_other', shown: ['keep'] });
    expect(await loadHookState(f.context.dataDir, 'at_one')).toEqual(state);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.saveSession).not.toHaveBeenCalled();
    expect(f.register).not.toHaveBeenCalled();
    expect(await runQuorumCommand({ ...f.context, command: { name: 'id', args: '' } })).toContain(
      NEW,
    );
    expect(f.rotate).toHaveBeenCalledTimes(1);
  });

  it('leaves the local ID and notification marks untouched when rotation fails', async () => {
    const f = await fixture();
    const before = await loadPairing(f.context.dataDir);
    f.rotate.mockRejectedValueOnce(new Error('server unavailable'));
    await expect(runQuorumCommand(f.context)).rejects.toThrow('server unavailable');
    expect(await loadPairing(f.context.dataDir)).toEqual(before);
  });

  it('refuses an invalid current ID response without corrupting local state', async () => {
    const f = await fixture();
    const before = await loadPairing(f.context.dataDir);
    f.links.mockResolvedValueOnce({ id: 'broken', links: [] });
    await expect(
      runQuorumCommand({ ...f.context, command: { name: 'id', args: '' } }),
    ).rejects.toThrow('current Quorum ID');
    expect(await loadPairing(f.context.dataDir)).toEqual(before);
  });

  it('repairs a stale local ID after commit and lost response using ordinary quorum-id', async () => {
    const f = await fixture();
    const perform = f.rotate.getMockImplementation();
    if (!perform) throw new Error('Missing rotation fixture');
    f.rotate.mockImplementationOnce(async (request) => {
      // The server commits but the response never reaches the hook.
      await perform(request);
      throw new Error('response lost');
    });
    await expect(runQuorumCommand(f.context)).rejects.toThrow('response lost');
    expect((await loadPairing(f.context.dataDir))[f.key]?.id).toBe(OLD);
    const text = await runQuorumCommand({ ...f.context, command: { name: 'id', args: '' } });
    expect(text).toContain(`codex@project-2): ${NEW}`);
    expect((await loadPairing(f.context.dataDir))[f.key]).toEqual({
      id: NEW,
      attachment: 'at_one',
    });
    expect(f.current()).toBe(NEW);
  });

  it('serializes rotation and ID refresh so an older reply cannot restore the retired ID', async () => {
    const f = await fixture();
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.links.mockImplementationOnce(async () => {
      started();
      await waiting;
      return { id: OLD, links: [] };
    });
    const show = runQuorumCommand({ ...f.context, command: { name: 'id', args: '' } });
    await entered;
    const rotate = runQuorumCommand(f.context);
    release();
    await Promise.all([show, rotate]);
    expect((await loadPairing(f.context.dataDir))[f.key]?.id).toBe(NEW);
    expect(f.rotate).toHaveBeenCalledTimes(1);
  });
});
