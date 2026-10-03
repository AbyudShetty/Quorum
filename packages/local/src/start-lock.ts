// "Only one local server starts" (ARCHITECTURE §8.2): when several agents start at the same
// moment, exactly one takes `<data dir>/local/server.lock` and starts the server.
//
// The lock file is never visible half-written: its content (pid + a random token) is written to
// a temporary file first and then hard-linked into place, which atomically fails if the lock
// already exists. The token tells two attempts from the same process apart.
import { randomUUID } from 'node:crypto';
import { link, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const lockPath = (dataDir: string): string => join(dataDir, 'local', 'server.lock');

/** Is a process with this pid running? (EPERM means it exists but belongs to someone else.) */
export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export interface StartLock {
  /** Remove the lock, but only if it is still ours. */
  release(): Promise<void>;
}

export type LockAttempt =
  { acquired: true; lock: StartLock } | { acquired: false; holderPid: number };

interface LockContent {
  pid: number;
  token: string;
}

const readLock = async (path: string): Promise<LockContent | undefined> => {
  const text = await readFile(path, 'utf8').catch(() => undefined);
  const match = text === undefined ? null : /^(\d+)\n([0-9a-f-]{36})\n?$/.exec(text);
  return match ? { pid: Number(match[1]), token: match[2] ?? '' } : undefined;
};

/** Atomically create the lock with our content; false if it already exists. */
const tryCreate = async (path: string, token: string): Promise<boolean> => {
  const temp = `${path}.${token}.tmp`;
  await writeFile(temp, `${String(process.pid)}\n${token}\n`, { mode: 0o600 });
  try {
    await link(temp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    await rm(temp, { force: true });
  }
};

/**
 * After winning, wait briefly and confirm the lock still holds our token. This closes the rare
 * race where two starters both remove the same stale lock: the later one's removal would delete
 * the earlier winner's fresh lock, and that winner then sees a foreign token and backs off.
 */
const confirm = async (path: string, token: string, settleMs: number): Promise<LockAttempt> => {
  await delay(settleMs);
  const current = await readLock(path);
  if (current?.token === token) {
    return {
      acquired: true,
      lock: {
        release: async () => {
          if ((await readLock(path))?.token === token) await rm(path, { force: true });
        },
      },
    };
  }
  return { acquired: false, holderPid: current?.pid ?? 0 };
};

/**
 * Take the start lock. If another live process holds it, report that process instead.
 * A lock left by a dead process (crash) or an unreadable lock file is replaced.
 */
export const acquireStartLock = async (
  dataDir: string,
  alive: (pid: number) => boolean = isProcessAlive,
  settleMs = 25,
): Promise<LockAttempt> => {
  const path = lockPath(dataDir);
  const token = randomUUID();
  if (await tryCreate(path, token)) return confirm(path, token, settleMs);

  const holder = await readLock(path);
  if (holder && alive(holder.pid)) return { acquired: false, holderPid: holder.pid };

  // Stale or unreadable lock: its owner is gone. Replace it once; if someone else won, report them.
  await rm(path, { force: true });
  if (await tryCreate(path, token)) return confirm(path, token, settleMs);
  return { acquired: false, holderPid: (await readLock(path))?.pid ?? 0 };
};
