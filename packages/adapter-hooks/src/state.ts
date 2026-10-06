// What a hook remembers between runs (each hook is a short-lived process): which Quorum session
// belongs to which vendor session, and when presence was last reported. Kept per attachment in the
// private data directory; nothing secret. A lost update (two hooks at once) costs at most one extra
// heartbeat or a session the server expires by itself.
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writePrivateFile } from '@quorum/local';

export interface HookState {
  /** Vendor session id → Quorum `sess_` id. */
  sessions: Record<string, string>;
  /** When a heartbeat was last sent (ms since epoch). */
  lastHeartbeatMs?: number;
  /**
   * Vendor session id → token of the one idle watcher allowed to run for it. A newer watcher, a
   * new prompt or the session's end replaces or removes the token, and the old watcher exits.
   */
  watchers?: Record<string, string>;
  /**
   * Quorum session id → its window: the vendor session key, the label and the vendor process.
   * `quorum mcp` runs in the same vendor process and adopts that session, so one window is one
   * session for its hooks, its tools and its idle wake.
   */
  windows?: Record<string, HookWindow>;
}

export interface HookWindow {
  key: string;
  label: string;
  vendorPid: number;
  /** The `quorum mcp` process that adopted this window, if any. */
  adoptedBy?: number;
  /**
   * When its hooks last ran (a prompt, a tool call, a turn's end). Codex runs one `quorum mcp` for
   * all its windows, which speaks for the most recently active one.
   */
  activeAtMs?: number;
}

const safe = (id: string): string => id.replaceAll(/[^A-Za-z0-9_-]/g, '_');

const statePath = (dataDir: string, attachment: string): string =>
  join(dataDir, 'hooks', `${safe(attachment)}.json`);

export const loadHookState = async (dataDir: string, attachment: string): Promise<HookState> => {
  try {
    const parsed = JSON.parse(await readFile(statePath(dataDir, attachment), 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return { sessions: {} };
    const value = parsed as {
      sessions?: unknown;
      lastHeartbeatMs?: unknown;
      watchers?: unknown;
      windows?: unknown;
    };
    const sessions: Record<string, string> = {};
    if (typeof value.sessions === 'object' && value.sessions !== null) {
      for (const [key, id] of Object.entries(value.sessions)) {
        if (typeof id === 'string') sessions[key] = id;
      }
    }
    const watchers: Record<string, string> = {};
    if (typeof value.watchers === 'object' && value.watchers !== null) {
      for (const [key, token] of Object.entries(value.watchers)) {
        if (typeof token === 'string') watchers[key] = token;
      }
    }
    const windows: Record<string, HookWindow> = {};
    if (typeof value.windows === 'object' && value.windows !== null) {
      for (const [id, raw] of Object.entries(value.windows as Record<string, unknown>)) {
        const w = raw as Partial<HookWindow> | null;
        if (
          typeof w?.key === 'string' &&
          typeof w.label === 'string' &&
          typeof w.vendorPid === 'number'
        ) {
          windows[id] = {
            key: w.key,
            label: w.label,
            vendorPid: w.vendorPid,
            ...(typeof w.adoptedBy === 'number' ? { adoptedBy: w.adoptedBy } : {}),
            ...(typeof w.activeAtMs === 'number' ? { activeAtMs: w.activeAtMs } : {}),
          };
        }
      }
    }
    return {
      sessions,
      ...(Object.keys(watchers).length > 0 ? { watchers } : {}),
      ...(Object.keys(windows).length > 0 ? { windows } : {}),
      ...(typeof value.lastHeartbeatMs === 'number'
        ? { lastHeartbeatMs: value.lastHeartbeatMs }
        : {}),
    };
  } catch {
    return { sessions: {} };
  }
};

/**
 * Save the state. The data directory must already exist (the server creates it private, INV-25);
 * only the `hooks` folder inside it is created here.
 */
export const saveHookState = async (
  dataDir: string,
  attachment: string,
  state: HookState,
): Promise<void> => {
  await mkdir(join(dataDir, 'hooks'), { mode: 0o700 }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  await writePrivateFile(statePath(dataDir, attachment), `${JSON.stringify(state)}\n`);
};
