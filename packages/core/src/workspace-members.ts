// Agent naming and shared-working-tree detection (ARCHITECTURE §12–§13, D-12, INV-28).
import type { Vendor } from '@quorum/schemas';

const VENDOR_SHORT: Record<Vendor, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  'gemini-cli': 'gemini',
  opencode: 'opencode',
  generic: 'agent',
};

const MAX_NAME = 32;

/** Lowercase a-z0-9 and single hyphens, starting with a letter. */
const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * The default agent name for a folder: "<vendor>-<folder>", e.g. "claude-api" (ARCHITECTURE §12).
 * Collisions get "-2", "-3", …; the result always fits the 32-character name rule.
 */
export const agentName = (
  vendor: Vendor,
  folderName: string,
  taken: ReadonlySet<string>,
): string => {
  const folder = slug(folderName);
  const base = (folder ? `${VENDOR_SHORT[vendor]}-${folder}` : VENDOR_SHORT[vendor])
    .slice(0, MAX_NAME)
    .replace(/-+$/, '');
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${String(n)}`;
    const candidate = base.slice(0, MAX_NAME - suffix.length).replace(/-+$/, '') + suffix;
    if (!taken.has(candidate)) return candidate;
  }
};

/**
 * A folder name as it appears in a window label (MESSAGE_SPEC §1.1): lowercase letters, digits
 * and single hyphens. Server and adapters derive labels with this, so they always agree.
 */
export const labelSlug = (folder: string): string =>
  folder
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '') || 'folder';

/** Short tool names used in window labels: claude, codex, gemini, opencode, agent. */
export const toolName = (vendor: string): string =>
  ({ 'claude-code': 'claude', codex: 'codex', 'gemini-cli': 'gemini', opencode: 'opencode' })[
    vendor
  ] ?? 'agent';

/** The last segment of a Windows or POSIX path ("C:\\proj\\api" → "api"). */
export const folderName = (path: string): string =>
  path
    .split(/[\\/]+/)
    .filter(Boolean)
    .at(-1) ?? '';

/**
 * A comparison key for a canonical path, so the same folder is recognised however it is spelled:
 * forward slashes, no duplicate or trailing slashes, and case-insensitive on Windows.
 * Adapters send already-canonical (symlink-resolved) paths; this only normalises spelling.
 */
export const pathKey = (path: string, platform: 'win32' | 'posix'): string => {
  let key = path.replaceAll('\\', '/').replace(/\/{2,}/g, '/');
  if (key.length > 1) key = key.replace(/\/+$/, '');
  if (platform === 'win32') key = key.toLowerCase();
  return /^[a-z]:$/i.test(key) ? `${key}/` : key;
};

export interface LiveSession {
  agent: string;
  /** pathKey of the worktree root (or the folder root outside git). */
  worktreeKey: string;
}

/**
 * Other agents working in the same working tree as `session` (INV-28). Sessions of the same
 * agent don't count: one agent with two windows open is not a collision.
 */
export const sharedWorktreeWith = (session: LiveSession, live: readonly LiveSession[]): string[] =>
  [
    ...new Set(
      live
        .filter((s) => s.worktreeKey === session.worktreeKey && s.agent !== session.agent)
        .map((s) => s.agent),
    ),
  ].sort();
