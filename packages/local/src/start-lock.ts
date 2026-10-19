// "Only one local server starts" (ARCHITECTURE §8.2): when several agents start at the same
// moment, exactly one takes `<data dir>/local/server.lock` and starts the server.
//
// The lock file is never visible half-written: its content (pid + a random token) is written to
// a temporary file first and then hard-linked into place, which atomically fails if the lock
// already exists. The token tells two attempts from the same process apart.
import { randomUUID } from 'node:crypto';
import { link, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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

const readText = (path: string): Promise<string | undefined> =>
  readFile(path, 'utf8').catch(() => undefined);

const parseLock = (text: string | undefined): LockContent | undefined => {
  const match = text === undefined ? null : /^(\d+)\n([0-9a-f-]{36})\n?$/.exec(text);
  return match ? { pid: Number(match[1]), token: match[2] ?? '' } : undefined;
};

const readLock = async (path: string): Promise<LockContent | undefined> =>
  parseLock(await readText(path));

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

const held = (path: string, token: string): LockAttempt => ({
  acquired: true,
  lock: {
    release: async () => {
      if ((await readLock(path))?.token === token) await rm(path, { force: true });
    },
  },
});

const heldBy = async (path: string): Promise<LockAttempt> => ({
  acquired: false,
  holderPid: (await readLock(path))?.pid ?? 0,
});

/**
 * Take the start lock. If another live process holds it, report that process instead.
 * A lock left by a dead process (crash) or an unreadable lock file is replaced.
 *
 * Replacing is guarded by a second lock file, `server.lock.takeover`: only its holder may remove
 * the lock, and only if the file still has the content judged stale. Without it, a starter delayed
 * between reading a stale lock and removing it could remove the fresh lock of the starter that
 * replaced it first, and both would run (seen under load, 2026-10-19).
 */
export const acquireStartLock = async (
  dataDir: string,
  alive: (pid: number) => boolean = isProcessAlive,
): Promise<LockAttempt> => {
  const path = lockPath(dataDir);
  const token = randomUUID();
  if (await tryCreate(path, token)) return held(path, token);

  const staleText = await readText(path);
  const holder = parseLock(staleText);
  if (holder && alive(holder.pid)) return { acquired: false, holderPid: holder.pid };

  const guard = `${path}.takeover`;
  if (!(await tryCreate(guard, token))) {
    // Someone is replacing it now. A guard left by a process that died while holding it (a few
    // milliseconds' window) is cleared, so the next start succeeds.
    const left = await readText(guard);
    const owner = parseLock(left);
    if (left !== undefined && (!owner || !alive(owner.pid)) && (await readText(guard)) === left) {
      await rm(guard, { force: true });
    }
    return heldBy(path);
  }
  try {
    // A fresh lock cannot appear while the stale file exists (creating fails), and only the guard
    // holder removes it, so the content check and the removal cannot be overtaken.
    const now = await readText(path);
    if (now !== undefined && now === staleText) await rm(path, { force: true });
    return (await tryCreate(path, token)) ? held(path, token) : await heldBy(path);
  } finally {
    await rm(guard, { force: true });
  }
};
