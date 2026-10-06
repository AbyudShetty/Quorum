// One window, one session: `quorum mcp` adopts the session its window's hooks registered.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  adoptWindow,
  forgetMcpWindow,
  type HookWindow,
  loadHookState,
  recordMcpWindow,
  saveHookState,
  trackWindow,
} from '../src/index.js';

const dirs: string[] = [];
const dataDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quorum-adopt-'));
  dirs.push(dir);
  await mkdir(join(dir, 'hooks'));
  return dir;
};
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const S1 = `sess_${'1'.repeat(26)}`;
const S2 = `sess_${'2'.repeat(26)}`;
const W1: HookWindow = { key: 'claude-window-a', label: 'claude@api-1', vendorPid: 100 };
const W2: HookWindow = { key: 'claude-window-b', label: 'claude@api-2', vendorPid: 200 };
const windows: Record<string, HookWindow> = { [S1]: W1, [S2]: W2 };

describe('adoptWindow', () => {
  it('adopts the window started by its own vendor process, and marks it', async () => {
    const dir = await dataDir();
    await saveHookState(dir, 'at_x', { sessions: {}, windows });
    const adopted = await adoptWindow(dir, 'at_x', { vendorPid: 200, selfPid: 9, timeoutMs: 0 });
    expect(adopted).toEqual({ id: S2, key: 'claude-window-b', label: 'claude@api-2' });
    expect((await loadHookState(dir, 'at_x')).windows?.[S2]?.adoptedBy).toBe(9);
  });

  it('leaves a window held by another live MCP server, and takes it from a dead one', async () => {
    const dir = await dataDir();
    await saveHookState(dir, 'at_x', {
      sessions: {},
      windows: { [S1]: { ...W1, adoptedBy: 7 } },
    });
    const held = await adoptWindow(dir, 'at_x', {
      vendorPid: 100,
      selfPid: 9,
      timeoutMs: 0,
      alive: () => true,
    });
    expect(held).toBeUndefined();
    const takeover = await adoptWindow(dir, 'at_x', {
      vendorPid: 100,
      selfPid: 9,
      timeoutMs: 0,
      alive: () => false,
    });
    expect(takeover?.id).toBe(S1);
  });

  it('waits for the session-start hook, then gives up', async () => {
    const dir = await dataDir();
    const later = setTimeout(() => {
      void saveHookState(dir, 'at_x', { sessions: {}, windows });
    }, 200);
    const adopted = await adoptWindow(dir, 'at_x', { vendorPid: 100, selfPid: 9, timeoutMs: 3000 });
    clearTimeout(later);
    expect(adopted?.label).toBe('claude@api-1');
    expect(
      await adoptWindow(dir, 'at_x', { vendorPid: 300, selfPid: 9, timeoutMs: 100 }),
    ).toBeUndefined();
  });
});

describe('the window quorum mcp speaks for', () => {
  it('records its own session for the late hook, and forgets it unless a hook took it over', async () => {
    const dir = await dataDir();
    const own = await recordMcpWindow(dir, 'at_x', {
      id: S1,
      label: 'codex@web-1',
      vendorPid: 100,
      selfPid: 9,
    });
    expect(own).toEqual({ id: S1, key: 'mcp-9', label: 'codex@web-1' });
    expect((await loadHookState(dir, 'at_x')).windows?.[S1]).toEqual({
      key: 'mcp-9',
      label: 'codex@web-1',
      vendorPid: 100,
      adoptedBy: 9,
    });
    await forgetMcpWindow(dir, 'at_x', S1);
    expect((await loadHookState(dir, 'at_x')).windows?.[S1]).toBeUndefined();

    await saveHookState(dir, 'at_x', { sessions: {}, windows }); // a hook's window stays
    await forgetMcpWindow(dir, 'at_x', S1);
    expect((await loadHookState(dir, 'at_x')).windows?.[S1]).toEqual(W1);
  });

  it('follows a re-keyed window and moves to the next session after /clear', async () => {
    const dir = await dataDir();
    await saveHookState(dir, 'at_x', {
      sessions: {},
      windows: { [S1]: { key: 'mcp-9', label: 'claude@api-1', vendorPid: 100, adoptedBy: 9 } },
    });
    const seen: string[] = [];
    const tracker = trackWindow(
      dir,
      'at_x',
      { id: S1, key: 'mcp-9', label: 'claude@api-1' },
      { vendorPid: 100, selfPid: 9, everyMs: 30, onChange: (w) => seen.push(`${w.id}:${w.key}`) },
    );
    const until = async (check: () => boolean) => {
      for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
    };
    // The late session-start hook re-keys the window to the vendor's session id.
    await saveHookState(dir, 'at_x', {
      sessions: {},
      windows: { [S1]: { key: 'thread-1', label: 'claude@api-1', vendorPid: 100, adoptedBy: 9 } },
    });
    await until(() => tracker.current().key === 'thread-1');
    expect(tracker.current()).toEqual({ id: S1, key: 'thread-1', label: 'claude@api-1' });
    // /clear: the old session's window is gone, a new one started in the same process.
    await saveHookState(dir, 'at_x', {
      sessions: {},
      windows: { [S2]: { key: 'thread-2', label: 'claude@api-2', vendorPid: 100 } },
    });
    await until(() => tracker.current().id === S2);
    tracker.stop();
    expect(tracker.current()).toEqual({ id: S2, key: 'thread-2', label: 'claude@api-2' });
    expect(seen).toEqual([`${S1}:thread-1`, `${S2}:thread-2`]);
    expect((await loadHookState(dir, 'at_x')).windows?.[S2]?.adoptedBy).toBe(9);
  });
});
