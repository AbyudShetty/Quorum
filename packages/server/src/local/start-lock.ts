// "Only one local server starts" (ARCHITECTURE §8.2): when two agents start at the same moment,
// exactly one takes `<data dir>/local/server.lock` (exclusive create) and starts the server.
import { open, readFile, rm } from 'node:fs/promises';
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
  release(): Promise<void>;
}

export type LockAttempt =
  { acquired: true; lock: StartLock } | { acquired: false; holderPid: number };

const tryCreate = async (path: string): Promise<StartLock | undefined> => {
  try {
    const handle = await open(path, 'wx', 0o600); // fails if the file exists
    await handle.writeFile(String(process.pid));
    await handle.close();
    return { release: () => rm(path, { force: true }) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    throw error;
  }
};

/**
 * Take the start lock. If another live process holds it, report that process instead.
 * A lock left by a dead process (crash) is removed and taken over.
 */
export const acquireStartLock = async (
  dataDir: string,
  alive: (pid: number) => boolean = isProcessAlive,
): Promise<LockAttempt> => {
  const path = lockPath(dataDir);
  const first = await tryCreate(path);
  if (first) return { acquired: true, lock: first };

  const holderPid = Number.parseInt(await readFile(path, 'utf8').catch(() => ''), 10);
  if (Number.isInteger(holderPid) && holderPid > 0 && alive(holderPid))
    return { acquired: false, holderPid };

  // Stale lock: its owner is gone. Remove it and try once more; if someone else won the race,
  // report them rather than looping.
  await rm(path, { force: true });
  const second = await tryCreate(path);
  if (second) return { acquired: true, lock: second };
  const winner = Number.parseInt(await readFile(path, 'utf8').catch(() => '0'), 10);
  return { acquired: false, holderPid: winner };
};
