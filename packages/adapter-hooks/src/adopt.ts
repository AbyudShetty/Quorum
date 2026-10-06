// One window, one session: `quorum mcp` adopts the session its window's hooks registered, so the
// tools, heartbeats and idle wake speak as the same window (`claude@api-1`) as the hooks. The
// link is the vendor process: Claude Code and Codex start both the MCP server and the hooks.
//
// The window can change while `quorum mcp` runs: `/clear` in Claude Code ends one session and starts
// the next in the same process, and Codex runs its session-start hook only with the first prompt
// (taking over the session `quorum mcp` registered meanwhile). `trackWindow` follows those changes.
import { setTimeout as delay } from 'node:timers/promises';
import { isProcessAlive } from '@quorum/local';
import { MCP_WINDOW_PREFIX } from './hooks.js';
import { loadHookState, saveHookState } from './state.js';

export interface AdoptedWindow {
  /** Quorum session id (`sess_…`). */
  id: string;
  /** The vendor's session key (for Codex: the thread id). */
  key: string;
  label: string;
}

export interface AdoptOptions {
  /** The vendor process this MCP server runs under (our parent). */
  vendorPid: number;
  /** This MCP server's process. */
  selfPid: number;
  /** How long to wait for the session-start hook (default 4 s). */
  timeoutMs?: number;
  alive?: (pid: number) => boolean;
}

/** The window registered by our vendor process and not held by another live MCP server. */
export const adoptWindow = async (
  dataDir: string,
  attachment: string,
  options: AdoptOptions,
): Promise<AdoptedWindow | undefined> => {
  const alive = options.alive ?? isProcessAlive;
  const deadline = Date.now() + (options.timeoutMs ?? 4000);
  for (;;) {
    const state = await loadHookState(dataDir, attachment);
    const candidates = Object.entries(state.windows ?? {})
      .filter(([, w]) => w.vendorPid === options.vendorPid)
      .filter(
        ([, w]) =>
          w.adoptedBy === undefined || w.adoptedBy === options.selfPid || !alive(w.adoptedBy),
      )
      .sort(([a], [b]) => (a < b ? 1 : -1)); // newest session first
    const found = candidates[0];
    if (found) {
      const [id, window] = found;
      state.windows = { ...state.windows, [id]: { ...window, adoptedBy: options.selfPid } };
      await saveHookState(dataDir, attachment, state).catch(() => undefined);
      return { id, key: window.key, label: window.label };
    }
    if (Date.now() >= deadline) return undefined;
    await delay(150);
  }
};

/**
 * Record the session `quorum mcp` registered itself (no hook had registered one in time), so the
 * window's session-start hook takes it over instead of opening a second one.
 */
export const recordMcpWindow = async (
  dataDir: string,
  attachment: string,
  window: { id: string; label: string; vendorPid: number; selfPid: number },
): Promise<AdoptedWindow> => {
  const key = `${MCP_WINDOW_PREFIX}${String(window.selfPid)}`;
  const state = await loadHookState(dataDir, attachment);
  state.windows = {
    ...state.windows,
    [window.id]: {
      key,
      label: window.label,
      vendorPid: window.vendorPid,
      adoptedBy: window.selfPid,
    },
  };
  await saveHookState(dataDir, attachment, state);
  return { id: window.id, key, label: window.label };
};

/** Forget a window `quorum mcp` recorded, if no hook took it over (it ends with `quorum mcp`). */
export const forgetMcpWindow = async (
  dataDir: string,
  attachment: string,
  id: string,
): Promise<void> => {
  const state = await loadHookState(dataDir, attachment);
  if (!state.windows?.[id]?.key.startsWith(MCP_WINDOW_PREFIX)) return;
  Reflect.deleteProperty(state.windows, id);
  await saveHookState(dataDir, attachment, state);
};

/**
 * The window that was active last (its hooks ran most recently). Codex runs one `quorum mcp` for
 * all its windows (inside its shared daemon), so a tool call speaks for the window the person is
 * using: the one whose prompt or tool hooks just ran.
 */
export const activeWindow = async (
  dataDir: string,
  attachment: string,
): Promise<AdoptedWindow | undefined> => {
  const state = await loadHookState(dataDir, attachment);
  const [found] = Object.entries(state.windows ?? {})
    .filter(([, w]) => !w.key.startsWith(MCP_WINDOW_PREFIX))
    .sort(([, a], [, b]) => (b.activeAtMs ?? 0) - (a.activeAtMs ?? 0));
  return found ? { id: found[0], key: found[1].key, label: found[1].label } : undefined;
};

export interface WindowTracker {
  /** The window `quorum mcp` speaks for right now. */
  current(): AdoptedWindow;
  stop(): void;
}

export interface TrackOptions extends AdoptOptions {
  /** How often to look (default 2 s). */
  everyMs?: number;
  /** Called after the window changed (new session, or its key or label changed). */
  onChange?: (window: AdoptedWindow) => void;
}

/**
 * Follow the window: when the hooks re-key it (Codex's late session start) or replace it (`/clear`:
 * the old session ends and a new one starts in the same vendor process), switch to the new one.
 */
export const trackWindow = (
  dataDir: string,
  attachment: string,
  start: AdoptedWindow,
  options: TrackOptions,
): WindowTracker => {
  let current = start;
  const stop = new AbortController();
  const stopped = () => stop.signal.aborted;
  const look = async () => {
    const state = await loadHookState(dataDir, attachment);
    const mine = state.windows?.[current.id];
    let next: AdoptedWindow | undefined;
    if (mine) {
      if (mine.key !== current.key || mine.label !== current.label) {
        next = { id: current.id, key: mine.key, label: mine.label };
      }
    } else {
      // Our session ended (its window is gone): adopt the newest window of the same process.
      next = await adoptWindow(dataDir, attachment, { ...options, timeoutMs: 0 });
    }
    if (next && !stopped()) {
      current = next;
      options.onChange?.(next);
    }
  };
  const loop = async () => {
    while (!stopped()) {
      await delay(options.everyMs ?? 2000, undefined, { signal: stop.signal }).catch(
        () => undefined,
      );
      if (!stopped()) await look().catch(() => undefined);
    }
  };
  void loop();
  return {
    current: () => current,
    stop: () => {
      stop.abort();
    },
  };
};
