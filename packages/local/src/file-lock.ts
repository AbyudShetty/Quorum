// A small cross-process lock in the private data directory, using the startup lock's atomic
// PID/token file and guarded crash recovery. Used where several
// short-lived processes share one thing, e.g. an attachment's credentials: the MCP server, every
// hook and the idle watcher may want to refresh the same token, and two refreshes of one rotating
// refresh token would look like theft to the server (INV-11) and revoke the whole family.
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireStartLock, isProcessAlive } from './start-lock.js';

export interface FileLockOptions {
  /** Give up waiting after this long (default 10 s). */
  timeoutMs?: number;
  /** @deprecated Live holders are never evicted by age. Retained for caller compatibility. */
  staleMs?: number;
}

export class FileLockTimeout extends Error {}

const safe = (name: string): string => name.replaceAll(/[^A-Za-z0-9_-]/g, '_');

/**
 * Hold the lock `name` while `work` runs. The data directory must exist (the server creates it
 * private, INV-25); only `<dataDir>/locks` is created here.
 */
export const withFileLock = async <T>(
  dataDir: string,
  name: string,
  work: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> => {
  const locks = join(dataDir, 'locks');
  await mkdir(locks, { recursive: true, mode: 0o700 });
  const path = join(locks, `${safe(name)}.lock`);
  if ((await stat(path).catch(() => undefined))?.isDirectory()) {
    throw new FileLockTimeout(
      `An older Quorum process holds the lock ${name}. Stop older Quorum processes before updating; never remove a live lock.`,
    );
  }
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  for (;;) {
    const attempt = await acquireStartLock(dataDir, isProcessAlive, path);
    if (attempt.acquired) {
      try {
        return await work();
      } finally {
        await attempt.lock.release();
      }
    }
    if (Date.now() >= deadline)
      throw new FileLockTimeout(`Timed out waiting for the lock ${name}.`);
    await delay(25 + Math.floor(Math.random() * 25));
  }
};
