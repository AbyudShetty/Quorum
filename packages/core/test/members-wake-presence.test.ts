import type { SubmittedEnvelope } from '@quorum/schemas';
import { describe, expect, it } from 'vitest';
import {
  agentName,
  folderName,
  pathKey,
  PresenceBook,
  sharedWorktreeWith,
  WakeGovernor,
} from '../src/index.js';

describe('agentName (ARCHITECTURE §12, D-12)', () => {
  it('names an agent after its vendor and folder', () => {
    expect(agentName('claude-code', 'api', new Set())).toBe('claude-api');
    expect(agentName('codex', 'Web App_v2', new Set())).toBe('codex-web-app-v2');
    expect(agentName('generic', '', new Set())).toBe('agent');
  });

  it('adds -2, -3 on collisions (a second simultaneous session)', () => {
    expect(agentName('claude-code', 'api', new Set(['claude-api']))).toBe('claude-api-2');
    expect(agentName('claude-code', 'api', new Set(['claude-api', 'claude-api-2']))).toBe(
      'claude-api-3',
    );
  });

  it('always fits the 32-character name rule, even with a suffix', () => {
    const long = 'a-very-long-folder-name-that-keeps-going';
    const first = agentName('opencode', long, new Set());
    const second = agentName('opencode', long, new Set([first]));
    for (const name of [first, second]) expect(name).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
    expect(second.endsWith('-2')).toBe(true);
  });

  it('takes the folder name from Windows and POSIX paths', () => {
    expect(folderName('C:\\Users\\abyud\\proj\\api\\')).toBe('api');
    expect(folderName('/home/abhijna/proj/web')).toBe('web');
  });
});

describe('shared working tree detection (INV-28)', () => {
  it('recognises the same folder however it is spelled on Windows', () => {
    expect(pathKey('C:\\Users\\Abyud\\proj\\api\\', 'win32')).toBe(
      pathKey('c:/users/abyud//proj/api', 'win32'),
    );
    expect(pathKey('C:\\', 'win32')).toBe('c:/');
  });

  it('keeps case on POSIX, where it matters', () => {
    expect(pathKey('/home/a/Proj', 'posix')).not.toBe(pathKey('/home/a/proj', 'posix'));
    expect(pathKey('/', 'posix')).toBe('/');
  });

  it('reports other agents in the same tree, but not the same agent twice', () => {
    const tree = pathKey('C:\\proj\\api', 'win32');
    const live = [
      { agent: 'agent:claude-api@m1', worktreeKey: tree },
      { agent: 'agent:claude-api@m1', worktreeKey: tree },
      { agent: 'agent:codex-api@m1', worktreeKey: tree },
      { agent: 'agent:codex-web@m1', worktreeKey: pathKey('C:\\proj\\web', 'win32') },
    ];
    expect(sharedWorktreeWith({ agent: 'agent:claude-api@m1', worktreeKey: tree }, live)).toEqual([
      'agent:codex-api@m1',
    ]);
    expect(
      sharedWorktreeWith(
        { agent: 'agent:codex-web@m1', worktreeKey: live[3]?.worktreeKey ?? '' },
        live,
      ),
    ).toEqual([]);
  });
});

describe('WakeGovernor (D-9, INV-29)', () => {
  const B = 'agent:codex-web@m1';
  let counter = 0;
  const message = (overrides: Partial<SubmittedEnvelope> = {}): SubmittedEnvelope =>
    ({
      spec: 'quorum/1',
      id: `msg_${String(counter++).padStart(26, '0')}`,
      workspace: 'ws_x',
      thread: 'th_1',
      from: 'agent:claude-api@m1',
      to: [B],
      type: 'note',
      type_version: 1,
      created_at: '2026-10-02T10:00:00Z',
      body: { text: 'x' },
      ...overrides,
    }) as SubmittedEnvelope;
  const limits = { wakesPerHour: 3, agentOnlyMessagesBeforePause: 4 };

  it('follows the wake mode the user chose', () => {
    const g = new WakeGovernor(limits);
    const broadcast = message({ to: ['*'] });
    expect(g.decide(B, message(), { mode: 'off' }, 0)).toEqual({ wake: false, reason: 'mode_off' });
    expect(g.decide(B, broadcast, { mode: 'direct' }, 0)).toEqual({
      wake: false,
      reason: 'not_direct',
    });
    expect(g.decide(B, broadcast, { mode: 'all' }, 0)).toEqual({ wake: true });
    expect(g.decide(B, message(), { mode: 'direct', types: ['request'] }, 0)).toEqual({
      wake: false,
      reason: 'type_filtered',
    });
  });

  it('never wakes an agent with its own message', () => {
    expect(
      new WakeGovernor(limits).decide(B, message({ from: B, to: ['*'] }), { mode: 'all' }, 0),
    ).toEqual({
      wake: false,
      reason: 'own_message',
    });
  });

  it('enforces the hourly wake budget, then frees it after an hour', () => {
    const g = new WakeGovernor(limits);
    const results = [0, 1, 2, 3].map(
      (t) => g.decide(B, message(), { mode: 'direct' }, t * 1000).wake,
    );
    expect(results).toEqual([true, true, true, false]);
    expect(g.decide(B, message(), { mode: 'direct' }, 3_600_001).wake).toBe(true);
  });

  it('pauses a thread after too many agent-only messages until a human writes', () => {
    const g = new WakeGovernor({ ...limits, wakesPerHour: 100 });
    for (let i = 0; i < 5; i++) g.observe(message());
    expect(g.isPaused('th_1')).toBe(true);
    expect(g.decide(B, message(), { mode: 'direct' }, 0)).toEqual({
      wake: false,
      reason: 'thread_paused',
    });
    expect(g.decide(B, message({ thread: 'th_2' }), { mode: 'direct' }, 0).wake).toBe(true);
    g.observe(message({ from: 'human:abyud' }));
    expect(g.decide(B, message(), { mode: 'direct' }, 0).wake).toBe(true);
  });

  it('does not let system notices reset the loop counter', () => {
    const g = new WakeGovernor(limits);
    for (let i = 0; i < 5; i++) g.observe(message());
    g.observe(message({ from: 'system:quorum' }));
    expect(g.isPaused('th_1')).toBe(true);
  });
});

describe('PresenceBook (MESSAGE_SPEC §5.10)', () => {
  const A = 'agent:claude-api@m1';

  it('reports coming online once, not on every heartbeat', () => {
    const book = new PresenceBook(10_000);
    expect(book.heartbeat(A, { status: 'working', resources_in_use: [] }, 0)).toEqual({
      address: A,
      presence: 'online',
      at: 0,
    });
    expect(book.heartbeat(A, { status: 'idle', resources_in_use: [] }, 10_000)).toBeUndefined();
    expect(book.get(A)).toMatchObject({ presence: 'online', status: 'idle', last_seen: 10_000 });
  });

  it('marks agents offline after 3 missed intervals', () => {
    const book = new PresenceBook(10_000);
    book.heartbeat(A, { status: 'working', current_task: 'tk_1', resources_in_use: [] }, 0);
    expect(book.sweep(30_000)).toEqual([]);
    expect(book.sweep(30_001)).toEqual([{ address: A, presence: 'offline', at: 30_001 }]);
    expect(book.sweep(40_000)).toEqual([]);
    expect(book.get(A)?.presence).toBe('offline');
  });

  it('records an explicit offline heartbeat and a later return', () => {
    const book = new PresenceBook(10_000);
    book.heartbeat(A, { status: 'working', resources_in_use: [] }, 0);
    expect(book.heartbeat(A, { status: 'offline', resources_in_use: [] }, 1)).toEqual({
      address: A,
      presence: 'offline',
      at: 1,
    });
    expect(book.heartbeat(A, { status: 'idle', resources_in_use: [] }, 2)).toEqual({
      address: A,
      presence: 'online',
      at: 2,
    });
  });
});
