// Find the git working tree and common directory of a folder without running git, so the adapter
// can report them when it registers a session (ARCHITECTURE §13, INV-28). Pure file reads: the
// adapter never starts a process (INV-10). The result matches `git rev-parse --show-toplevel` and
// `--git-common-dir` for normal repositories, linked worktrees and submodules.
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export interface GitInfo {
  /** Canonical path of the folder that contains `.git` (the working tree root). */
  worktree_root: string;
  /** Canonical path of the repository's common git directory, shared by all its worktrees. */
  common_dir: string;
}

/** `.git` files are tiny; never read anything big a project folder happens to contain. */
const MAX_POINTER_BYTES = 4096;

const readSmall = async (path: string): Promise<string | undefined> => {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile() || info.size > MAX_POINTER_BYTES) return undefined;
  return readFile(path, 'utf8').catch(() => undefined);
};

/** The git directory a `.git` *file* points to, and the common directory behind it. */
const followPointer = async (dir: string, content: string): Promise<string | undefined> => {
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(content);
  if (!match?.[1]) return undefined;
  const gitdir = await realpath(isAbsolute(match[1]) ? match[1] : resolve(dir, match[1])).catch(
    () => undefined,
  );
  if (!gitdir) return undefined;
  // Linked worktrees have `commondir` (usually "../.."); submodules do not, their gitdir is common.
  const commondir = (await readSmall(join(gitdir, 'commondir')))?.trim();
  if (!commondir) return gitdir;
  return realpath(resolve(gitdir, commondir)).catch(() => undefined);
};

/** Walk up from `start` to the nearest working tree; undefined outside git. */
export const findGit = async (start: string): Promise<GitInfo | undefined> => {
  let dir = await realpath(start).catch(() => undefined);
  while (dir !== undefined) {
    const dotgit = join(dir, '.git');
    const info = await stat(dotgit).catch(() => undefined);
    if (info?.isDirectory()) return { worktree_root: dir, common_dir: await realpath(dotgit) };
    if (info?.isFile()) {
      const content = await readSmall(dotgit);
      const common = content === undefined ? undefined : await followPointer(dir, content);
      return common === undefined ? undefined : { worktree_root: dir, common_dir: common };
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
};
