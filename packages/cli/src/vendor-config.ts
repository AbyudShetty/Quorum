// Vendor configuration that `quorum attach` writes into the attached folder (ARCHITECTURE §12 step 5)
// and `quorum detach` removes: Claude Code hooks in `.claude/settings.local.json`; Codex MCP server
// and hooks in `.codex/config.toml` and `.codex/hooks.json`. Rules:
//  - Never secrets: tokens stay in the keychain (INV-25). Only commands that name the attachment.
//  - Never into version control: every file is listed in `.git/info/exclude`, never `.gitignore`.
//  - Merge, never clobber: other settings and hooks are kept; only entries for this attachment are
//    added or removed. A file that cannot be parsed is left alone and reported.
//  - Nothing is executed (INV-10): `claude mcp add` is printed for the person to run.
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findGit } from '@quorum/adapter-mcp';
import { HOOK_EVENT_NAMES, type HookEvent, HOOK_EVENTS } from '@quorum/adapter-hooks';

/** How vendors start `quorum`: by name when it is on the PATH, else Node plus this CLI's entry. */
export interface QuorumCommand {
  node: string;
  bin: string;
  onPath: boolean;
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/** Is a `quorum` command on the PATH? (Looks for the file; runs nothing.) */
export const quorumOnPath = async (path = process.env.PATH ?? ''): Promise<boolean> => {
  const names =
    process.platform === 'win32' ? ['quorum.cmd', 'quorum.exe', 'quorum.ps1'] : ['quorum'];
  for (const dir of path.split(delimiter).filter(Boolean)) {
    for (const name of names) if (await exists(join(dir, name))) return true;
  }
  return false;
};

export const quorumCommand = async (): Promise<QuorumCommand> => ({
  node: process.execPath,
  bin: fileURLToPath(new URL('../bin/quorum.js', import.meta.url)),
  onPath: await quorumOnPath(),
});

export interface ConfigChange {
  file: string;
  action: 'created' | 'updated' | 'removed' | 'skipped';
  note?: string;
}

export interface VendorConfigResult {
  changes: ConfigChange[];
  /** What the person still has to do. */
  steps: string[];
}

const TIMEOUT_S: Partial<Record<HookEvent, number>> = { 'session-end': 3 };

/** Does a hook entry belong to this attachment? (Attachment ids are unique ULIDs.) */
const isOurs = (hook: unknown, attachment: string): boolean => {
  const text = JSON.stringify(hook);
  return text.includes('--attachment') && text.includes(attachment);
};

type HookGroup = { matcher?: string; hooks: unknown[] };
type HooksFile = { hooks?: Record<string, HookGroup[]> } & Record<string, unknown>;

/** Remove this attachment's hooks from a settings object; returns whether anything changed. */
const stripHooks = (settings: HooksFile, attachment: string): boolean => {
  let changed = false;
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((group) => {
        if (!Array.isArray(group.hooks)) return group;
        const hooks = group.hooks.filter((h) => !isOurs(h, attachment));
        if (hooks.length !== group.hooks.length) changed = true;
        return { ...group, hooks };
      })
      .filter((group) => !Array.isArray(group.hooks) || group.hooks.length > 0);
    if (settings.hooks) {
      if (kept.length === 0) Reflect.deleteProperty(settings.hooks, event);
      else settings.hooks[event] = kept;
    }
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return changed;
};

/** Read a JSON settings file: {} if missing, undefined if it exists but is not a JSON object. */
const readJsonFile = async (file: string): Promise<HooksFile | undefined> => {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return {};
  }
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as HooksFile)
      : undefined;
  } catch {
    return undefined;
  }
};

const writeJsonFile = async (file: string, value: unknown): Promise<void> => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
};

/** Merge this attachment's hooks into a vendor hooks file. */
const mergeHooks = async (
  file: string,
  attachment: string,
  entry: (event: HookEvent) => Record<string, unknown>,
): Promise<ConfigChange> => {
  const existed = await exists(file);
  const settings = await readJsonFile(file);
  if (!settings) {
    return { file, action: 'skipped', note: 'not valid JSON; left unchanged' };
  }
  stripHooks(settings, attachment); // idempotent: re-attach replaces our entries
  const hooks = (settings.hooks ??= {});
  for (const event of HOOK_EVENTS) {
    const name = HOOK_EVENT_NAMES[event];
    (hooks[name] ??= []).push({ hooks: [entry(event)] });
  }
  await writeJsonFile(file, settings);
  return { file, action: existed ? 'updated' : 'created' };
};

const removeHooks = async (file: string, attachment: string): Promise<ConfigChange | undefined> => {
  if (!(await exists(file))) return undefined;
  const settings = await readJsonFile(file);
  if (!settings) return { file, action: 'skipped', note: 'not valid JSON; left unchanged' };
  if (!stripHooks(settings, attachment)) return undefined;
  await writeJsonFile(file, settings);
  return { file, action: 'removed' };
};

/** A TOML string: literal ('…') when possible, so Windows backslashes need no escaping. */
const tomlString = (value: string): string =>
  /['\n\r]/.test(value) ? JSON.stringify(value) : `'${value}'`;

const MCP_HEADER = '[mcp_servers.quorum]';

/** Split a TOML file around the `[mcp_servers.quorum]` table (and its subtables). */
const splitQuorumTable = (text: string): { before: string[]; table: string[]; after: string[] } => {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === MCP_HEADER);
  if (start < 0) return { before: lines, table: [], after: [] };
  let end = start + 1;
  while (end < lines.length) {
    const trimmed = (lines[end] ?? '').trim();
    if (trimmed.startsWith('[') && !trimmed.startsWith('[mcp_servers.quorum.')) break;
    end++;
  }
  return { before: lines.slice(0, start), table: lines.slice(start, end), after: lines.slice(end) };
};

const joinToml = (parts: string[][]): string =>
  `${parts
    .flat()
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;

/** Exclude files from git in `<common dir>/info/exclude` (never `.gitignore`). */
const excludeFromGit = async (root: string, files: string[]): Promise<ConfigChange | undefined> => {
  const git = await findGit(root);
  if (!git) return undefined;
  const exclude = join(git.common_dir, 'info', 'exclude');
  const current = await readFile(exclude, 'utf8').catch(() => '');
  const lines = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const wanted = files
    .map((f) => `/${relative(git.worktree_root, f).split(sep).join('/')}`)
    .filter((pattern) => !pattern.startsWith('/..') && !lines.has(pattern));
  if (wanted.length === 0) return undefined;
  await mkdir(dirname(exclude), { recursive: true });
  const prefix = current && !current.endsWith('\n') ? '\n' : '';
  await writeFile(exclude, `${current}${prefix}# quorum attach\n${wanted.join('\n')}\n`);
  return { file: exclude, action: 'updated' };
};

const quote = (s: string): string => (/[\s"]/.test(s) ? `"${s.replaceAll('"', '\\"')}"` : s);

/** Write the vendor configuration for an attachment. */
export const writeVendorConfig = async (
  vendor: string,
  root: string,
  attachment: string,
  command: QuorumCommand,
): Promise<VendorConfigResult> => {
  const mcpArgs = ['mcp', '--attachment', attachment];
  const hookArgs = (v: string, event: HookEvent) => ['hook', v, event, '--attachment', attachment];

  if (vendor === 'claude-code') {
    const settings = join(root, '.claude', 'settings.local.json');
    const change = await mergeHooks(settings, attachment, (event) => ({
      type: 'command',
      // Exec form (command + args): no shell, so paths with spaces need no quoting.
      command: command.onPath ? 'quorum' : command.node,
      args: command.onPath
        ? hookArgs('claude-code', event)
        : [command.bin, ...hookArgs('claude-code', event)],
      timeout: TIMEOUT_S[event] ?? 30,
    }));
    const changes = [change];
    if (change.action !== 'skipped') {
      const excluded = await excludeFromGit(root, [settings]);
      if (excluded) changes.push(excluded);
    }
    const run = command.onPath ? ['quorum'] : [command.node, command.bin];
    return {
      changes,
      steps: [
        `Register the MCP server (once, in ${root}):\n  claude mcp add --scope local quorum -- ${[...run, ...mcpArgs].map(quote).join(' ')}`,
      ],
    };
  }

  if (vendor === 'codex') {
    const configFile = join(root, '.codex', 'config.toml');
    const hooksFile = join(root, '.codex', 'hooks.json');
    const shellCommand = (event: HookEvent) =>
      (command.onPath
        ? ['quorum', ...hookArgs('codex', event)]
        : [command.node, command.bin, ...hookArgs('codex', event)]
      )
        .map(quote)
        .join(' ');
    const hooksChange = await mergeHooks(hooksFile, attachment, (event) => ({
      type: 'command',
      command: shellCommand(event),
      timeout: TIMEOUT_S[event] ?? 30,
    }));

    const existed = await exists(configFile);
    const text = existed ? await readFile(configFile, 'utf8') : '';
    const { before, after } = splitQuorumTable(text);
    const table = [
      MCP_HEADER,
      `command = ${tomlString(command.onPath ? 'quorum' : command.node)}`,
      `args = [${(command.onPath ? mcpArgs : [command.bin, ...mcpArgs]).map(tomlString).join(', ')}]`,
    ];
    await mkdir(dirname(configFile), { recursive: true });
    await writeFile(configFile, joinToml([before, [''], table, [''], after]));
    const changes: ConfigChange[] = [
      { file: configFile, action: existed ? 'updated' : 'created' },
      hooksChange,
    ];
    const excluded = await excludeFromGit(
      root,
      hooksChange.action === 'skipped' ? [configFile] : [configFile, hooksFile],
    );
    if (excluded) changes.push(excluded);
    return {
      changes,
      steps: [
        `Open Codex in ${root}, trust the project if asked, then run /hooks and review the Quorum hooks once (Codex skips unreviewed hooks).`,
        'Codex asks before each quorum tool call unless you change its approval settings.',
      ],
    };
  }

  return {
    changes: [],
    steps: [`Start the MCP server with: quorum mcp --attachment ${attachment}`],
  };
};

/** Remove an attachment's vendor configuration (other settings stay). */
export const removeVendorConfig = async (
  vendor: string,
  root: string,
  attachment: string,
): Promise<ConfigChange[]> => {
  const changes: ConfigChange[] = [];
  if (vendor === 'claude-code') {
    const change = await removeHooks(join(root, '.claude', 'settings.local.json'), attachment);
    if (change) changes.push(change);
  }
  if (vendor === 'codex') {
    const hooks = await removeHooks(join(root, '.codex', 'hooks.json'), attachment);
    if (hooks) changes.push(hooks);
    const configFile = join(root, '.codex', 'config.toml');
    const text = await readFile(configFile, 'utf8').catch(() => undefined);
    if (text !== undefined) {
      const { before, table, after } = splitQuorumTable(text);
      if (table.join('\n').includes(attachment)) {
        await writeFile(configFile, joinToml([before, [''], after]));
        changes.push({ file: configFile, action: 'removed' });
      }
    }
  }
  return changes;
};
