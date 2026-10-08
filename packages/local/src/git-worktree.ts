// `quorum worktree` (ARCHITECTURE §13): give an agent its own git working tree. This is the second
// and last process the CLI can cause to start (INV-10): `git worktree add`, with a fixed shape,
// only from the human's own `quorum worktree` command. No MCP tool and no message can reach it.
// Every argument is checked before git runs, git is started without a shell, and nothing from a
// message ever gets here.
import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';

/** The only branches Quorum creates: `quorum/<agent name>`. */
export const QUORUM_BRANCH = /^quorum\/[a-z0-9][a-z0-9-]{0,63}$/;

export class GitWorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitWorktreeError';
  }
}

export interface GitWorktreeOptions {
  /** The repository's working tree root (absolute). */
  repo: string;
  /** Where the new working tree goes (absolute; must not exist yet). */
  dir: string;
  /** The new branch, `quorum/<agent name>`. */
  branch: string;
  /** Default two minutes: a checkout of a large repository takes a while. */
  timeoutMs?: number;
}

/** A path git can never read as an option or a URL: absolute, no leading dash, no control chars. */
const plainPath = (path: string): boolean =>
  // eslint-disable-next-line no-control-regex
  isAbsolute(path) && !path.startsWith('-') && !/[\u0000-\u001f]/.test(path);

/** `git -C <repo> worktree add -b <branch> <dir>`: nothing else, no shell. */
export const addGitWorktree = (options: GitWorktreeOptions): Promise<void> => {
  const { repo, dir, branch } = options;
  if (!plainPath(repo) || !plainPath(dir)) {
    return Promise.reject(new GitWorktreeError('Folders must be absolute paths.'));
  }
  if (!QUORUM_BRANCH.test(branch)) {
    return Promise.reject(
      new GitWorktreeError(`Quorum only creates branches named quorum/<agent>, not "${branch}".`),
    );
  }
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', repo, 'worktree', 'add', '-b', branch, dir],
      { windowsHide: true, timeout: options.timeoutMs ?? 120_000, shell: false },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }
        const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
        reject(
          new GitWorktreeError(
            missing
              ? 'git was not found. Install git, or add it to PATH.'
              : `git worktree add failed: ${stderr.trim() || error.message}`,
          ),
        );
      },
    );
  });
};
