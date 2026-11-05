// `quorum setup` / `quorum uninstall` (D-20, PAIRING.md §4): Quorum in every Claude Code and Codex
// session, at user level, touching only its own entries.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryCredentialStore } from '@quorum/adapter-mcp';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureSetUp, main } from '../src/cli.js';
import { removeUserConfig, writeUserConfig } from '../src/user-config.js';
import type { QuorumCommand } from '../src/vendor-config.js';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const home = () => {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-home-'));
  dirs.push(dir);
  return dir;
};

const command: QuorumCommand = {
  node: 'C:\\Program Files\\nodejs\\node.exe',
  bin: 'C:\\npm\\node_modules\\@quorumhq\\quorum\\lib\\cli\\bin\\quorum.js',
  onPath: true,
  platform: 'win32',
};
const dataDir = 'C:\\Users\\me\\AppData\\Local\\Quorum';
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
type Groups = { matcher?: string; hooks: Record<string, unknown>[] }[];

describe('quorum setup (user level)', () => {
  it('honors custom vendor profiles and uninstalls only from those profiles', async () => {
    const h = home();
    const env = {
      CODEX_HOME: join(h, 'codex profile α'),
      CLAUDE_CONFIG_DIR: join(h, 'claude profile α'),
    };
    mkdirSync(join(h, '.claude'));
    writeFileSync(join(h, '.claude', 'settings.json'), '{"untouched":true}');
    await writeUserConfig({ home: h, command, dataDir, env });
    expect(json(join(env.CLAUDE_CONFIG_DIR, 'settings.json')).hooks).toBeDefined();
    expect(json(join(env.CLAUDE_CONFIG_DIR, '.claude.json')).mcpServers).toBeDefined();
    expect(existsSync(join(env.CODEX_HOME, 'skills', 'quorum-rotate', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(h, '.claude', 'settings.json'), 'utf8')).toBe('{"untouched":true}');
    expect(existsSync(join(h, '.codex'))).toBe(false);
    await removeUserConfig({ home: h, dataDir, env });
    expect(json(join(env.CLAUDE_CONFIG_DIR, 'settings.json')).hooks).toBeUndefined();
    expect(existsSync(join(env.CODEX_HOME, 'skills', 'quorum-rotate'))).toBe(false);
    expect(readFileSync(join(h, '.claude', 'settings.json'), 'utf8')).toBe('{"untouched":true}');
  });

  it('does not treat a read error as a missing file or overwrite its contents', async () => {
    const h = home();
    const file = join(h, '.claude', 'settings.json');
    mkdirSync(file, { recursive: true });
    writeFileSync(join(file, 'keep.txt'), 'keep');
    await expect(writeUserConfig({ home: h, command, dataDir })).rejects.toThrow();
    expect(readFileSync(join(file, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('accepts UTF-8 BOM settings without losing unrelated fields', async () => {
    const h = home();
    mkdirSync(join(h, '.claude'));
    writeFileSync(join(h, '.claude', 'settings.json'), '\uFEFF{"model":"kept"}');
    writeFileSync(join(h, '.claude.json'), '\uFEFF{"numStartups":19}');
    await writeUserConfig({ home: h, command, dataDir });
    expect(json(join(h, '.claude', 'settings.json')).model).toBe('kept');
    expect(json(join(h, '.claude.json')).numStartups).toBe(19);
  });

  it('retries incomplete setup after the malformed file is repaired', async () => {
    const h = home();
    const data = join(h, 'data');
    mkdirSync(join(h, '.claude'));
    const file = join(h, '.claude', 'settings.json');
    writeFileSync(file, '{invalid');
    const out: string[] = [];
    const env = {
      home: h,
      dataDir: data,
      quorumCommand: () => Promise.resolve(command),
      store: new MemoryCredentialStore(),
      out: (text: string) => out.push(text),
      err: () => undefined,
    };
    expect(await main(['setup'], env)).toBe(1);
    expect(out.join('')).toContain('setup is incomplete');
    expect(json(join(data, 'setup.json')).complete).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('{invalid');
    writeFileSync(file, '{}');
    await ensureSetUp(env);
    expect(json(join(data, 'setup.json')).complete).toBe(true);
    expect(json(file).hooks).toBeDefined();
  });

  it('invalidates an older success receipt when a quiet upgrade cannot read configuration', async () => {
    const h = home();
    const data = join(h, 'data');
    const env = {
      home: h,
      dataDir: data,
      quorumCommand: () => Promise.resolve(command),
      store: new MemoryCredentialStore(),
      out: () => undefined,
      err: () => undefined,
    };
    expect(await main(['setup', '--quiet'], env)).toBe(0);
    const file = join(h, '.claude', 'settings.json');
    rmSync(file);
    mkdirSync(file);
    writeFileSync(join(file, 'keep'), 'untouched');
    expect(await main(['setup', '--quiet'], env)).toBe(0);
    expect(json(join(data, 'setup.json')).complete).toBe(false);
    expect(readFileSync(join(file, 'keep'), 'utf8')).toBe('untouched');
  });

  it('refreshes setup after CODEX_HOME changes with the same package and runtime', async () => {
    const h = home();
    const data = join(h, 'data');
    const env = {
      home: h,
      dataDir: data,
      quorumCommand: () => Promise.resolve(command),
      store: new MemoryCredentialStore(),
      out: () => undefined,
      err: () => undefined,
    };
    await ensureSetUp(env);
    const target = join(h, 'new codex home');
    await ensureSetUp({ ...env, vendorConfigEnv: { CODEX_HOME: target } });
    expect(existsSync(join(target, 'hooks.json'))).toBe(true);
    expect(json(join(data, 'setup.json')).config).toMatchObject({
      codexConfig: join(target, 'config.toml'),
    });
    expect(existsSync(join(h, '.codex', 'config.toml'))).toBe(true);
  });

  it('refuses an ambiguous relative profile path before modifying vendor files', async () => {
    const h = home();
    await expect(
      writeUserConfig({ home: h, command, dataDir, env: { CODEX_HOME: 'relative-profile' } }),
    ).rejects.toThrow('absolute configuration directory');
    expect(existsSync(join(h, '.claude'))).toBe(false);
  });

  it('refreshes hooks when a Node version manager changes the executable but keeps the same package', async () => {
    const h = home();
    const data = join(h, 'data');
    const env = {
      home: h,
      dataDir: data,
      quorumCommand: () => Promise.resolve(command),
      store: new MemoryCredentialStore(),
      out: () => undefined,
      err: () => undefined,
    };
    await ensureSetUp(env);
    const changed = { ...command, node: 'C:\\Node Runtimes\\v27\\node.exe' };
    await ensureSetUp({ ...env, quorumCommand: () => Promise.resolve(changed) });
    expect(json(join(data, 'setup.json')).node).toBe(changed.node);
    expect(readFileSync(join(h, '.codex', 'config.toml'), 'utf8')).toContain('v27');
    expect(readFileSync(join(h, '.claude', 'settings.json'), 'utf8')).toContain('v27');
  });

  it('upgrades an existing setup marker so installed sessions receive the rotation command', async () => {
    const h = home();
    const data = join(h, 'data');
    mkdirSync(data);
    writeFileSync(join(data, 'setup.json'), JSON.stringify({ bin: command.bin, revision: 4 }));
    await ensureSetUp({
      home: h,
      dataDir: data,
      quorumCommand: () => Promise.resolve(command),
      store: new MemoryCredentialStore(),
      out: () => undefined,
      err: () => undefined,
    });
    expect(existsSync(join(h, '.claude', 'commands', 'quorum-rotate.md'))).toBe(true);
    expect(existsSync(join(h, '.codex', 'skills', 'quorum-rotate', 'SKILL.md'))).toBe(true);
    expect(json(join(data, 'setup.json')).revision).toBe(6);
  });

  it('puts hooks, the tools and the commands into Claude Code and Codex, keeping what is there', async () => {
    const h = home();
    mkdirSync(join(h, '.claude'), { recursive: true });
    mkdirSync(join(h, '.codex'), { recursive: true });
    writeFileSync(
      join(h, '.claude', 'settings.json'),
      JSON.stringify({
        model: 'opus',
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-own-hook' }] }] },
        permissions: { allow: ['Bash(npm test)'] },
      }),
    );
    writeFileSync(
      join(h, '.claude.json'),
      JSON.stringify({ numStartups: 7, mcpServers: { docs: {} } }),
    );
    writeFileSync(
      join(h, '.codex', 'config.toml'),
      'model = "o4"\n\n[mcp_servers.docs]\ncommand = "d"\n',
    );

    await writeUserConfig({ home: h, command, dataDir });
    await writeUserConfig({ home: h, command, dataDir }); // twice: no duplicates

    const settings = json(join(h, '.claude', 'settings.json'));
    expect(settings.model).toBe('opus');
    const hooks = settings.hooks as Record<string, Groups>;
    expect(hooks.Stop?.some((g) => g.hooks.some((x) => x.command === 'my-own-hook'))).toBe(true);
    const quorumStops = (hooks.Stop ?? []).filter((g) => JSON.stringify(g).includes('quorum.js'));
    expect(quorumStops).toHaveLength(2); // the stop hook and the idle watcher
    const expansion = hooks.UserPromptExpansion?.[0];
    expect(expansion?.matcher).toBe('quorum-.*');
    expect(expansion?.hooks[0]).toMatchObject({
      command: command.node,
      args: [command.bin, 'hook', 'claude-code', 'command'],
    });
    // The idle watcher also starts next to a /quorum-* command (no turn ends after one).
    expect(hooks.UserPromptExpansion?.[1]).toMatchObject({
      matcher: 'quorum-.*',
      hooks: [{ args: [command.bin, 'hook', 'claude-code', 'watch'], asyncRewake: true }],
    });
    expect(hooks.UserPromptExpansion).toHaveLength(2);
    // Claude Code enforces a timeout on asyncRewake hooks, 600 s by default: a watcher killed then
    // never wakes the session for later mail (seen live, 2026-10-22). It must cover its 8 hours.
    const watchers = Object.values(hooks)
      .flat()
      .flatMap((g) => g.hooks)
      .filter((h) => (h as { asyncRewake?: boolean }).asyncRewake);
    expect(watchers).toHaveLength(3); // SessionStart, Stop, next to a /quorum-* command
    for (const w of watchers) expect((w as { timeout?: number }).timeout).toBe(8 * 60 * 60 + 60);
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd']) {
      expect(JSON.stringify(hooks[event])).not.toContain('--attachment');
    }
    const permissions = settings.permissions as { allow: string[]; deny: string[] };
    expect(permissions.allow).toEqual(['Bash(npm test)', 'mcp__quorum']);
    expect(permissions.deny).toEqual([
      'Read(//c/Users/me/AppData/Local/Quorum/**)',
      'Edit(//c/Users/me/AppData/Local/Quorum/**)',
    ]);

    const claudeJson = json(join(h, '.claude.json'));
    expect(claudeJson.numStartups).toBe(7);
    expect((claudeJson.mcpServers as Record<string, unknown>).quorum).toEqual({
      type: 'stdio',
      command: command.node,
      args: [command.bin, 'mcp', '--vendor', 'claude-code'],
    });
    const idCommand = readFileSync(join(h, '.claude', 'commands', 'quorum-id.md'), 'utf8');
    expect(idCommand).toContain('disable-model-invocation: true');
    const rotateCommand = readFileSync(join(h, '.claude', 'commands', 'quorum-rotate.md'), 'utf8');
    expect(rotateCommand).toContain('disable-model-invocation: true');
    expect(rotateCommand).toContain('Replace this session');
    expect(readFileSync(join(h, '.claude', 'commands', 'quorum-attach.md'), 'utf8')).toContain(
      'argument-hint: "<QRM-id>"',
    );

    const codexHooks = json(join(h, '.codex', 'hooks.json')).hooks as Record<string, Groups>;
    expect(hooks.PreToolUse?.[0]).toMatchObject({
      matcher: '^mcp__quorum__quorum_(send|inbox|status|requests)$',
      hooks: [{ args: [command.bin, 'hook', 'claude-code', 'pre-tool'], timeout: 10 }],
    });
    expect(codexHooks.PreToolUse?.[0]).toMatchObject({
      matcher: '^mcp__quorum__quorum_(send|inbox|status|requests)$',
      hooks: [{ command: 'quorum.cmd hook codex pre-tool', timeout: 10 }],
    });
    expect(codexHooks.UserPromptSubmit?.[0]?.hooks[0]?.command).toBe(
      'quorum.cmd hook codex prompt',
    );
    expect(codexHooks.UserPromptSubmit).toHaveLength(1);
    const toml = readFileSync(join(h, '.codex', 'config.toml'), 'utf8');
    expect(toml).toContain('model = "o4"');
    expect(toml).toContain('[mcp_servers.docs]');
    expect(toml.match(/\[mcp_servers\.quorum\]/g)).toHaveLength(1);
    expect(toml).toContain(`args = ['${command.bin}', 'mcp', '--vendor', 'codex']`);
    expect(toml).toContain('tool_timeout_sec = 600'); // time to answer Quorum's dialog
    const skill = readFileSync(join(h, '.codex', 'skills', 'quorum-attach', 'SKILL.md'), 'utf8');
    expect(skill).toContain('name: quorum-attach');
    expect(skill).toContain('$quorum-attach <QRM-id>');
    const rotateSkill = readFileSync(
      join(h, '.codex', 'skills', 'quorum-rotate', 'SKILL.md'),
      'utf8',
    );
    expect(rotateSkill).toContain('name: quorum-rotate');
    expect(rotateSkill).toContain('$quorum-rotate');
  });

  it('leaves a settings file it cannot read alone', async () => {
    const h = home();
    mkdirSync(join(h, '.claude'), { recursive: true });
    writeFileSync(join(h, '.claude', 'settings.json'), '{ not json');
    const changes = await writeUserConfig({ home: h, command, dataDir });
    expect(changes.find((c) => c.file.endsWith('settings.json'))?.action).toBe('skipped');
    expect(readFileSync(join(h, '.claude', 'settings.json'), 'utf8')).toBe('{ not json');
  });
});

describe('quorum uninstall (user level)', () => {
  it('takes out exactly what setup put in', async () => {
    const h = home();
    mkdirSync(join(h, '.claude'), { recursive: true });
    const before = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-own-hook' }] }] },
      permissions: { allow: ['Bash(npm test)'] },
    };
    writeFileSync(join(h, '.claude', 'settings.json'), JSON.stringify(before));
    writeFileSync(join(h, '.claude.json'), JSON.stringify({ numStartups: 7 }));
    await writeUserConfig({ home: h, command, dataDir });
    await removeUserConfig({ home: h, dataDir });

    expect(json(join(h, '.claude', 'settings.json'))).toEqual(before);
    expect(json(join(h, '.claude.json'))).toEqual({ numStartups: 7, mcpServers: {} });
    expect(existsSync(join(h, '.claude', 'commands', 'quorum-id.md'))).toBe(false);
    expect(existsSync(join(h, '.codex', 'skills', 'quorum-id'))).toBe(false);
    expect(existsSync(join(h, '.claude', 'commands', 'quorum-rotate.md'))).toBe(false);
    expect(existsSync(join(h, '.codex', 'skills', 'quorum-rotate'))).toBe(false);
    expect(json(join(h, '.codex', 'hooks.json'))).toEqual({});
    expect(readFileSync(join(h, '.codex', 'config.toml'), 'utf8')).not.toContain('quorum');
  });
});
