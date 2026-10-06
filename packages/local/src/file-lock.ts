// A small cross-process lock in the private data directory: `mkdir` either creates the lock
// directory or fails because another process holds it, atomically on every OS. Used where several
// short-lived processes share one thing, e.g. an attachment's credentials: the MCP server, every
// hook and the idle watcher may want to refresh the same token, and two refreshes of one rotating
// refresh token would look like theft to the server (INV-11) and revoke the whole family.
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export interface FileLockOptions {
  /** Give up waiting after this long (default 10 s). */
  timeoutMs?: number;
  /** A lock older than this was left by a crashed process and is taken over (default 30 s). */
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
  await mkdir(locks, { mode: 0o700 }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  const path = join(locks, `${safe(name)}.lock`);
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  const staleMs = options.staleMs ?? 30_000;
  for (;;) {
    try {
      await mkdir(path);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const held = await stat(path).catch(() => undefined);
      if (held && Date.now() - held.mtimeMs > staleMs) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new FileLockTimeout(`Timed out waiting for the lock ${name}.`);
      }
      await delay(25 + Math.floor(Math.random() * 25));
    }
  }
  try {
    return await work();
  } finally {
    await rm(path, { recursive: true, force: true });
  }
};
