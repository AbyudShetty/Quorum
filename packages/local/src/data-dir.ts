// The per-user private data directory (ARCHITECTURE §4, §8.2; INV-25).
import { chmod, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { currentUserSid, lockDown, lockDownCommands, otherEntries } from './windows-acl.js';

/**
 * Where Quorum keeps its database, keys and discovery file:
 * QUORUM_HOME if set; %LOCALAPPDATA%\Quorum on Windows; ~/.quorum elsewhere.
 */
export const defaultDataDir = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string => {
  if (env.QUORUM_HOME) return env.QUORUM_HOME;
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Quorum');
  }
  return join(home, '.quorum');
};

export type PrivacyCheck = { ok: true } | { ok: false; problem: string; fix: string };

/** Is `path` accessible only to the current user (plus SYSTEM/Administrators on Windows)? */
export const checkPrivate = async (
  path: string,
  platform: NodeJS.Platform = process.platform,
): Promise<PrivacyCheck> => {
  if (platform === 'win32') {
    const user = await currentUserSid();
    const others = await otherEntries(path, user);
    if (others.length === 0) return { ok: true };
    const explicit = others.filter((e) => !e.inherited).map((e) => e.sid);
    return {
      ok: false,
      problem: `${path} is readable by other accounts (${others.map((e) => e.sid).join(', ')})`,
      // Runnable as-is in PowerShell or cmd.
      fix: lockDownCommands(path, user, explicit)
        .map(([target, ...args]) => `icacls "${target ?? path}" ${args.join(' ')}`)
        .join('; '),
    };
  }
  const info = await stat(path);
  const mode = info.mode & 0o777;
  if ((mode & 0o077) === 0) return { ok: true };
  return {
    ok: false,
    problem: `${path} has permissions ${mode.toString(8)}; group or others can access it`,
    fix: `chmod ${info.isDirectory() ? '700' : '600'} "${path}"`,
  };
};

/**
 * Create `dir` if needed and make it private; then verify. Throws with the exact fix command if
 * it cannot be made private, so the server refuses to start rather than run exposed (INV-25).
 */
export const ensurePrivateDir = async (
  dir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> => {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (platform === 'win32') await lockDown(dir, await currentUserSid());
  else await chmod(dir, 0o700);
  const check = await checkPrivate(dir, platform);
  if (!check.ok) throw new Error(`${check.problem}. Fix: ${check.fix}`);
};

/**
 * Write a file atomically and privately: write a temporary file, then rename over the target,
 * so readers never see a half-written file. (On Windows the directory ACL protects it.)
 */
export const writePrivateFile = async (path: string, content: string): Promise<void> => {
  const temp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(temp, content, { mode: 0o600 });
  await rename(temp, path);
};
