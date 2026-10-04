// What `quorum attach` writes into a project folder and `quorum detach` takes back out.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type QuorumCommand,
  quorumOnPath,
  removeVendorConfig,
  writeVendorConfig,
} from '../src/vendor-config.js';

const dirs: string[] = [];
const project = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quorum vendor-')); // a space, like "SIDE PROJ"
  dirs.push(dir);
  await mkdir(join(dir, '.git'));
  return dir;
};
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const ID = 'at_01J9Z8X7W6V5T4S3R2Q1P0N9M8';
const OTHER = 'at_01J9Z8X7W6V5T4S3R2Q1P0N9M9';
const absolute: QuorumCommand = {
  node: 'C:\\Program Files\\nodejs\\node.exe',
  bin: 'C:\\work\\SIDE PROJ\\Quorum\\packages\\cli\\bin\\quorum.js',
  onPath: false,
};
const byName: QuorumCommand = { ...absolute, onPath: true };
interface HookEntry {
  type: string;
  command: string;
  args?: string[];
  timeout?: number;
}
interface Settings {
  permissions?: unknown;
  hooks?: Record<string, { matcher?: string; hooks: HookEntry[] }[]>;
}
const json = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as Settings;
/** The first hook of an event's first group. */
const firstHook = (settings: Settings, event: string) => settings.hooks?.[event]?.[0]?.hooks[0];

describe('Claude Code: .claude/settings.local.json', () => {
  it('adds the five hooks in exec form, keeps other settings, and is idempotent', async () => {
    const root = await project();
    const file = join(root, '.claude', 'settings.local.json');
    await mkdir(join(root, '.claude'));
    await writeFile(
      file,
      JSON.stringify({
        permissions: { allow: ['Bash(npm test)'] },
        hooks: {
          PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'lint' }] }],
        },
      }),
    );
    const first = await writeVendorConfig('claude-code', root, ID, absolute);
    expect(first.changes.map((c) => c.action)).toEqual(['updated', 'updated']);
    await writeVendorConfig('claude-code', root, ID, absolute); // again: no duplicates

    const settings = await json(file);
    expect(settings.permissions).toEqual({ allow: ['Bash(npm test)'] });
    expect(Object.keys(settings.hooks ?? {}).sort()).toEqual([
      'PostToolUse',
      'SessionEnd',
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
    ]);
    expect(settings.hooks?.PostToolUse).toHaveLength(2); // the person's lint hook and ours
    expect(settings.hooks?.Stop).toHaveLength(1);
    expect(firstHook(settings, 'Stop')).toEqual({
      type: 'command',
      command: absolute.node,
      args: [absolute.bin, 'hook', 'claude-code', 'stop', '--attachment', ID],
      timeout: 30,
    });
    expect(first.steps[0]).toContain(
      `claude mcp add --scope local quorum -- "${absolute.node}" "${absolute.bin}" mcp --attachment ${ID}`,
    );
    expect(await readFile(join(root, '.git', 'info', 'exclude'), 'utf8')).toContain(
      '/.claude/settings.local.json',
    );
    expect(JSON.stringify(settings)).not.toMatch(/qrm_/); // never a token (INV-25)
  });

  it('removes only this attachment, leaving the rest', async () => {
    const root = await project();
    await writeVendorConfig('claude-code', root, ID, byName);
    await writeVendorConfig('claude-code', root, OTHER, byName);
    const removed = await removeVendorConfig('claude-code', root, ID);
    expect(removed.map((c) => c.action)).toEqual(['removed']);
    const text = await readFile(join(root, '.claude', 'settings.local.json'), 'utf8');
    expect(text).not.toContain(ID);
    expect(text).toContain(OTHER);
    expect(
      firstHook(await json(join(root, '.claude', 'settings.local.json')), 'Stop'),
    ).toMatchObject({
      command: 'quorum',
      args: ['hook', 'claude-code', 'stop', '--attachment', OTHER],
    });
  });

  it('leaves a settings file it cannot parse untouched', async () => {
    const root = await project();
    await mkdir(join(root, '.claude'));
    await writeFile(join(root, '.claude', 'settings.local.json'), '{ broken');
    const result = await writeVendorConfig('claude-code', root, ID, byName);
    expect(result.changes[0]).toMatchObject({ action: 'skipped' });
    expect(await readFile(join(root, '.claude', 'settings.local.json'), 'utf8')).toBe('{ broken');
  });
});

describe('Codex: .codex/config.toml and .codex/hooks.json', () => {
  it('adds the MCP server table and the hooks, keeping other servers and settings', async () => {
    const root = await project();
    await mkdir(join(root, '.codex'));
    await writeFile(
      join(root, '.codex', 'config.toml'),
      'model = "o4"\n\n[mcp_servers.docs]\ncommand = "docs-server"\n',
    );
    await writeVendorConfig('codex', root, ID, absolute);
    await writeVendorConfig('codex', root, ID, absolute);
    const toml = await readFile(join(root, '.codex', 'config.toml'), 'utf8');
    expect(toml).toContain('model = "o4"');
    expect(toml).toContain('[mcp_servers.docs]');
    expect(toml.match(/\[mcp_servers\.quorum\]/g)).toHaveLength(1);
    expect(toml).toContain(`command = '${absolute.node}'`);
    expect(toml).toContain(`args = ['${absolute.bin}', 'mcp', '--attachment', '${ID}']`);

    const hooks = await json(join(root, '.codex', 'hooks.json'));
    expect(firstHook(hooks, 'SessionEnd')).toEqual({
      type: 'command',
      command: `"${absolute.node}" "${absolute.bin}" hook codex session-end --attachment ${ID}`,
      timeout: 3,
    });
    const exclude = await readFile(join(root, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('/.codex/config.toml');
    expect(exclude).toContain('/.codex/hooks.json');
  });

  it('uses the bare command name when quorum is on the PATH', async () => {
    const root = await project();
    await writeVendorConfig('codex', root, ID, byName);
    const toml = await readFile(join(root, '.codex', 'config.toml'), 'utf8');
    expect(toml).toContain(`command = 'quorum'`);
    const hooks = await json(join(root, '.codex', 'hooks.json'));
    expect(firstHook(hooks, 'Stop')?.command).toBe(`quorum hook codex stop --attachment ${ID}`);
  });

  it('detach removes the table and hooks it added, and nothing else', async () => {
    const root = await project();
    await mkdir(join(root, '.codex'));
    await writeFile(join(root, '.codex', 'config.toml'), '[mcp_servers.docs]\ncommand = "d"\n');
    await writeVendorConfig('codex', root, ID, byName);
    const removed = await removeVendorConfig('codex', root, ID);
    expect(removed.map((c) => c.action).sort()).toEqual(['removed', 'removed']);
    const toml = await readFile(join(root, '.codex', 'config.toml'), 'utf8');
    expect(toml).not.toContain('quorum');
    expect(toml).toContain('[mcp_servers.docs]');
    expect((await json(join(root, '.codex', 'hooks.json'))).hooks).toBeUndefined();
  });
});

describe('quorumOnPath', () => {
  it('finds a quorum command on the PATH without running anything', async () => {
    const dir = await project();
    expect(await quorumOnPath(dir)).toBe(false);
    await writeFile(join(dir, process.platform === 'win32' ? 'quorum.cmd' : 'quorum'), '');
    expect(await quorumOnPath(dir)).toBe(true);
  });
});
