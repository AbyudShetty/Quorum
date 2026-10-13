// Quorum in every Claude Code and Codex session (DECISIONS D-20, PAIRING.md §4): `quorum setup`
// (run by `npm install -g`, or by the first `quorum` command when install scripts are off) writes
// user-level settings, and `quorum uninstall` takes them out again. Every session then has the
// pairing commands and Quorum's hooks and tools; hooks of sessions that never ran a command return
// at once without contacting anything.
//
//   Claude Code  ~/.claude/settings.json   hooks (incl. UserPromptExpansion for /quorum-*),
//                                         Read/Edit deny rules for the data folder, quorum tools allowed
//                ~/.claude.json           the MCP server (user scope)
//                ~/.claude/commands/      quorum-id.md … (the /quorum-* commands)
//   Codex        ~/.codex/hooks.json      hooks
//                ~/.codex/config.toml     [mcp_servers.quorum]
//                ~/.codex/skills/         quorum-id/SKILL.md … (the $quorum-* commands)
//
// Only entries Quorum wrote are touched: hooks are recognised by their `quorum … hook` command
// without --attachment; files and folders by their quorum- names.
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { HOOK_EVENT_NAMES, type HookEvent } from '@quorum/adapter-hooks';
import { dataDirDenyRules, type ConfigChange, type QuorumCommand } from './vendor-config.js';

export interface UserConfigOptions {
  /** The person's home folder (where ~/.claude and ~/.codex live). */
  home: string;
  command: QuorumCommand;
  dataDir: string;
}

/** What each command does, for the menus of both tools. */
const COMMANDS: readonly { name: string; hint?: string; what: string }[] = [
  { name: 'id', what: "Join Quorum: show this session's Quorum ID to share" },
  { name: 'attach', hint: '<QRM-id>', what: 'Ask to link this session with another session' },
  { name: 'allow', hint: '[QRM-id]', what: 'Accept a session that asked to link with this one' },
  { name: 'detach', hint: '[QRM-id]', what: 'Unlink from one session, or all' },
  { name: 'block', hint: '<QRM-id>', what: 'Unlink and block a session' },
  { name: 'export', what: "Write this session's Quorum conversations to quorum-<tool><n>.md here" },
];

const NOT_RUN =
  "This is a Quorum command; Quorum's hook handles it before the model runs. If you are reading this, Quorum's hook did not run: tell the person \"Quorum's helper did not run: run `quorum setup` in a terminal, then restart this session\" and do nothing else.";

const EVENTS: readonly HookEvent[] = [
  'session-start',
  'prompt',
  'post-tool',
  'stop',
  'session-end',
];
const TIMEOUT_S: Partial<Record<HookEvent, number>> = { 'session-end': 3 };

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

type Json = Record<string, unknown>;

const readJson = async (file: string): Promise<Json | undefined> => {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return {};
  }
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Json)
      : undefined;
  } catch {
    return undefined;
  }
};

const writeJson = async (file: string, value: unknown): Promise<void> => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
};

/** A hook entry Quorum wrote at user level: `quorum … hook …`, never with --attachment. */
const isOurHook = (hook: unknown): boolean => {
  const text = JSON.stringify(hook);
  return /quorum/i.test(text) && /"hook"|\shook\s/.test(text) && !text.includes('--attachment');
};

type Groups = { matcher?: string; hooks: unknown[] }[];

/** Settings without Quorum's user-level hooks; whether anything was removed. */
const stripOurHooks = (settings: Json): boolean => {
  const hooks = settings.hooks as Record<string, Groups> | undefined;
  if (!hooks || typeof hooks !== 'object') return false;
  let changed = false;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((group) => {
        if (!Array.isArray(group.hooks)) return group;
        const rest = group.hooks.filter((h) => !isOurHook(h));
        if (rest.length !== group.hooks.length) changed = true;
        return { ...group, hooks: rest };
      })
      .filter((group) => !Array.isArray(group.hooks) || group.hooks.length > 0);
    if (kept.length === 0) Reflect.deleteProperty(hooks, event);
    else hooks[event] = kept;
  }
  if (Object.keys(hooks).length === 0) Reflect.deleteProperty(settings, 'hooks');
  return changed;
};

const addHook = (settings: Json, event: string, entry: Json, matcher?: string): void => {
  const hooks = (settings.hooks ??= {}) as Record<string, Groups>;
  (hooks[event] ??= []).push({ ...(matcher ? { matcher } : {}), hooks: [entry] });
};

/** Program and arguments without a shell (Claude Code hooks, both MCP servers). */
const execForm = (command: QuorumCommand, args: string[]) =>
  command.onPath && (command.platform ?? process.platform) !== 'win32'
    ? { command: 'quorum', args }
    : { command: command.node, args: [command.bin, ...args] };

const quote = (s: string): string => (/[\s"]/.test(s) ? `"${s.replaceAll('"', '\\"')}"` : s);

/** A shell command line (Codex hooks): never a quoted path first, which PowerShell reads as a string. */
const shellForm = (command: QuorumCommand, args: string[]): string => {
  const windows = (command.platform ?? process.platform) === 'win32';
  return (
    command.onPath
      ? [windows ? 'quorum.cmd' : 'quorum', ...args]
      : [windows ? 'node' : command.node, command.bin, ...args]
  )
    .map(quote)
    .join(' ');
};

const tomlString = (value: string): string =>
  /['\n\r]/.test(value) ? JSON.stringify(value) : `'${value}'`;

const MCP_HEADER = '[mcp_servers.quorum]';

const splitQuorumTable = (text: string) => {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === MCP_HEADER);
  if (start < 0) return { before: lines, table: [] as string[], after: [] as string[] };
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

const paths = (home: string) => ({
  claudeSettings: join(home, '.claude', 'settings.json'),
  claudeJson: join(home, '.claude.json'),
  claudeCommands: join(home, '.claude', 'commands'),
  codexHooks: join(home, '.codex', 'hooks.json'),
  codexConfig: join(home, '.codex', 'config.toml'),
  codexSkills: join(home, '.codex', 'skills'),
});

/** Claude Code's permission rule for the quorum tools (they only message linked sessions). */
const ALLOW_TOOLS = 'mcp__quorum';

export const writeUserConfig = async (options: UserConfigOptions): Promise<ConfigChange[]> => {
  const { command, dataDir } = options;
  const p = paths(options.home);
  const changes: ConfigChange[] = [];

  // Claude Code: hooks, deny rules, tools allowed.
  const settings = await readJson(p.claudeSettings);
  if (!settings) {
    changes.push({
      file: p.claudeSettings,
      action: 'skipped',
      note: 'not valid JSON; left unchanged',
    });
  } else {
    const existed = await exists(p.claudeSettings);
    stripOurHooks(settings);
    for (const event of EVENTS) {
      addHook(settings, HOOK_EVENT_NAMES[event], {
        type: 'command',
        ...execForm(command, ['hook', 'claude-code', event]),
        timeout: TIMEOUT_S[event] ?? 30,
      });
    }
    // Typed /quorum-* commands: only commands a person types reach this event.
    addHook(
      settings,
      'UserPromptExpansion',
      { type: 'command', ...execForm(command, ['hook', 'claude-code', 'command']), timeout: 60 },
      'quorum-.*',
    );
    // The idle-wake watcher, for paired sessions only (others return at once). Also next to a typed
    // /quorum-* command: the command joins or links the session but no turn runs, so no Stop.
    const watcher = {
      type: 'command',
      ...execForm(command, ['hook', 'claude-code', 'watch']),
      asyncRewake: true,
    };
    for (const event of ['SessionStart', 'Stop']) addHook(settings, event, watcher);
    addHook(settings, 'UserPromptExpansion', watcher, 'quorum-.*');
    const permissions = (settings.permissions ??= {}) as { deny?: unknown; allow?: unknown };
    const deny = Array.isArray(permissions.deny) ? (permissions.deny as unknown[]) : [];
    permissions.deny = [...deny, ...dataDirDenyRules(dataDir).filter((r) => !deny.includes(r))];
    const allow = Array.isArray(permissions.allow) ? (permissions.allow as unknown[]) : [];
    if (!allow.includes(ALLOW_TOOLS)) permissions.allow = [...allow, ALLOW_TOOLS];
    await writeJson(p.claudeSettings, settings);
    changes.push({ file: p.claudeSettings, action: existed ? 'updated' : 'created' });
  }

  // Claude Code: the MCP server at user scope.
  const claudeJson = await readJson(p.claudeJson);
  if (!claudeJson) {
    changes.push({ file: p.claudeJson, action: 'skipped', note: 'not valid JSON; left unchanged' });
  } else {
    const servers = (claudeJson.mcpServers ??= {}) as Json;
    servers.quorum = {
      type: 'stdio',
      ...execForm(command, ['mcp', '--vendor', 'claude-code']),
    };
    await writeJson(p.claudeJson, claudeJson);
    changes.push({ file: p.claudeJson, action: 'updated' });
  }

  // Claude Code: the commands.
  await mkdir(p.claudeCommands, { recursive: true });
  for (const c of COMMANDS) {
    const file = join(p.claudeCommands, `quorum-${c.name}.md`);
    await writeFile(
      file,
      [
        '---',
        `description: ${c.what} (Quorum)`,
        ...(c.hint ? [`argument-hint: "${c.hint}"`] : []),
        'disable-model-invocation: true',
        '---',
        '',
        NOT_RUN,
        '',
      ].join('\n'),
    );
  }
  changes.push({ file: p.claudeCommands, action: 'updated', note: 'quorum-*.md' });

  // Codex: hooks.
  const codexHooks = await readJson(p.codexHooks);
  if (!codexHooks) {
    changes.push({ file: p.codexHooks, action: 'skipped', note: 'not valid JSON; left unchanged' });
  } else {
    const existed = await exists(p.codexHooks);
    stripOurHooks(codexHooks);
    for (const event of EVENTS) {
      addHook(codexHooks, HOOK_EVENT_NAMES[event], {
        type: 'command',
        command: shellForm(command, ['hook', 'codex', event]),
        timeout: TIMEOUT_S[event] ?? 60,
      });
    }
    await writeJson(p.codexHooks, codexHooks);
    changes.push({ file: p.codexHooks, action: existed ? 'updated' : 'created' });
  }

  // Codex: the MCP server.
  const configExisted = await exists(p.codexConfig);
  const text = configExisted ? await readFile(p.codexConfig, 'utf8') : '';
  const { before, after } = splitQuorumTable(text);
  const mcp = execForm(command, ['mcp', '--vendor', 'codex']);
  await mkdir(dirname(p.codexConfig), { recursive: true });
  await writeFile(
    p.codexConfig,
    joinToml([
      before,
      [''],
      [
        MCP_HEADER,
        `command = ${tomlString(mcp.command)}`,
        `args = [${mcp.args.map(tomlString).join(', ')}]`,
        // quorum_requests waits while the person reads Quorum's dialog (Codex's default is 60 s).
        'tool_timeout_sec = 600',
      ],
      [''],
      after,
    ]),
  );
  changes.push({ file: p.codexConfig, action: configExisted ? 'updated' : 'created' });

  // Codex: the commands, as skills typed `$quorum-…`.
  for (const c of COMMANDS) {
    const dir = join(p.codexSkills, `quorum-${c.name}`);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'SKILL.md'),
      [
        '---',
        `name: quorum-${c.name}`,
        `description: ${c.what} (Quorum). The person types $quorum-${c.name}${c.hint ? ` ${c.hint}` : ''}; Quorum's hook handles it. Never use this skill on your own.`,
        '---',
        '',
        NOT_RUN,
        '',
      ].join('\n'),
    );
  }
  changes.push({ file: p.codexSkills, action: 'updated', note: 'quorum-*' });
  return changes;
};

export const removeUserConfig = async (
  options: Omit<UserConfigOptions, 'command'>,
): Promise<ConfigChange[]> => {
  const p = paths(options.home);
  const changes: ConfigChange[] = [];

  const settings = await readJson(p.claudeSettings);
  if (settings && (await exists(p.claudeSettings))) {
    let changed = stripOurHooks(settings);
    const permissions = settings.permissions as { deny?: unknown; allow?: unknown } | undefined;
    const rules = dataDirDenyRules(options.dataDir);
    if (Array.isArray(permissions?.deny)) {
      const rest = (permissions.deny as unknown[]).filter((r) => !rules.includes(r as string));
      if (rest.length !== permissions.deny.length) changed = true;
      if (rest.length > 0) permissions.deny = rest;
      else Reflect.deleteProperty(permissions, 'deny');
    }
    if (Array.isArray(permissions?.allow)) {
      const rest = (permissions.allow as unknown[]).filter((r) => r !== ALLOW_TOOLS);
      if (rest.length !== permissions.allow.length) changed = true;
      if (rest.length > 0) permissions.allow = rest;
      else Reflect.deleteProperty(permissions, 'allow');
    }
    if (permissions && Object.keys(permissions).length === 0) {
      Reflect.deleteProperty(settings, 'permissions');
    }
    if (changed) {
      await writeJson(p.claudeSettings, settings);
      changes.push({ file: p.claudeSettings, action: 'removed' });
    }
  }

  const claudeJson = await readJson(p.claudeJson);
  const servers = claudeJson?.mcpServers as Json | undefined;
  if (claudeJson && servers && 'quorum' in servers) {
    Reflect.deleteProperty(servers, 'quorum');
    await writeJson(p.claudeJson, claudeJson);
    changes.push({ file: p.claudeJson, action: 'removed' });
  }

  for (const c of COMMANDS) {
    const file = join(p.claudeCommands, `quorum-${c.name}.md`);
    if (await exists(file)) await rm(file, { force: true });
    const dir = join(p.codexSkills, `quorum-${c.name}`);
    if (await exists(dir)) await rm(dir, { recursive: true, force: true });
  }
  changes.push({ file: p.claudeCommands, action: 'removed', note: 'quorum-*.md' });
  changes.push({ file: p.codexSkills, action: 'removed', note: 'quorum-*' });

  const codexHooks = await readJson(p.codexHooks);
  if (codexHooks && (await exists(p.codexHooks)) && stripOurHooks(codexHooks)) {
    await writeJson(p.codexHooks, codexHooks);
    changes.push({ file: p.codexHooks, action: 'removed' });
  }

  const text = await readFile(p.codexConfig, 'utf8').catch(() => undefined);
  if (text !== undefined) {
    const { before, table, after } = splitQuorumTable(text);
    if (table.length > 0) {
      await writeFile(p.codexConfig, joinToml([before, [''], after]));
      changes.push({ file: p.codexConfig, action: 'removed' });
    }
  }
  return changes;
};
