// `quorum setup` / `quorum uninstall` (D-20, PAIRING.md §4): Quorum in every Claude Code and Codex
// session, at user level, touching only its own entries.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
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
    expect(readFileSync(join(h, '.claude', 'commands', 'quorum-attach.md'), 'utf8')).toContain(
      'argument-hint: "<QRM-id>"',
    );

    const codexHooks = json(join(h, '.codex', 'hooks.json')).hooks as Record<string, Groups>;
    expect(codexHooks.UserPromptSubmit?.[0]?.hooks[0]?.command).toBe(
      'quorum.cmd hook codex prompt',
    );
    expect(codexHooks.UserPromptSubmit).toHaveLength(1);
    const toml = readFileSync(join(h, '.codex', 'config.toml'), 'utf8');
    expect(toml).toContain('model = "o4"');
    expect(toml).toContain('[mcp_servers.docs]');
    expect(toml.match(/\[mcp_servers\.quorum\]/g)).toHaveLength(1);
    expect(toml).toContain(`args = ['${command.bin}', 'mcp', '--vendor', 'codex']`);
    const skill = readFileSync(join(h, '.codex', 'skills', 'quorum-attach', 'SKILL.md'), 'utf8');
    expect(skill).toContain('name: quorum-attach');
    expect(skill).toContain('$quorum-attach <QRM-id>');
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
    expect(json(join(h, '.codex', 'hooks.json'))).toEqual({});
    expect(readFileSync(join(h, '.codex', 'config.toml'), 'utf8')).not.toContain('quorum');
  });
});
