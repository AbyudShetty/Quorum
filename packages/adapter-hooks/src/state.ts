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
}

const safe = (id: string): string => id.replaceAll(/[^A-Za-z0-9_-]/g, '_');

const statePath = (dataDir: string, attachment: string): string =>
  join(dataDir, 'hooks', `${safe(attachment)}.json`);

export const loadHookState = async (dataDir: string, attachment: string): Promise<HookState> => {
  try {
    const parsed = JSON.parse(await readFile(statePath(dataDir, attachment), 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return { sessions: {} };
    const value = parsed as { sessions?: unknown; lastHeartbeatMs?: unknown };
    const sessions: Record<string, string> = {};
    if (typeof value.sessions === 'object' && value.sessions !== null) {
      for (const [key, id] of Object.entries(value.sessions)) {
        if (typeof id === 'string') sessions[key] = id;
      }
    }
    return {
      sessions,
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
