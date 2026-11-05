import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MemoryCredentialStore } from '@quorum/adapter-mcp';
import { startRelay, type Relay } from '@quorum/relay';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main, type CliEnv } from '../src/cli.js';

const dirs: string[] = [];
let relay: Relay | undefined;
afterEach(async () => {
  await relay?.close();
  relay = undefined;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const fixture = async () => {
  const home = await mkdtemp(join(tmpdir(), 'quorum-doctor-'));
  dirs.push(home);
  const bin = join(home, 'quorum.js');
  await writeFile(bin, '// fixture');
  const out: string[] = [];
  const store = new MemoryCredentialStore();
  const env: CliEnv = {
    home,
    dataDir: join(home, 'data'),
    store,
    path: dirname(process.execPath),
    quorumCommand: () => Promise.resolve({ node: process.execPath, bin, onPath: false }),
    out: (text) => out.push(text),
    err: (text) => out.push(text),
  };
  expect(await main(['setup', '--quiet'], env)).toBe(0);
  out.length = 0;
  return { home, env, store, out, text: () => out.join('') };
};

describe('read-only environment diagnostics', () => {
  it('checks a configured profile offline without changing files or writing credentials', async () => {
    const f = await fixture();
    const file = join(f.home, '.claude', 'settings.json');
    const before = await readFile(file, 'utf8');
    const receipt = await readFile(join(f.home, 'data', 'setup.json'), 'utf8');
    const save = vi.spyOn(f.store, 'save');
    const remove = vi.spyOn(f.store, 'remove');
    expect(await main(['doctor', '--offline'], f.env)).toBe(0);
    expect(f.text()).toContain('Setup matches this runtime');
    expect(f.text()).toContain('network checks skipped');
    expect(save).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await readFile(join(f.home, 'data', 'setup.json'), 'utf8')).toBe(receipt);
  });

  it('reports invalid vendor configuration and does not silently repair it', async () => {
    const f = await fixture();
    const file = join(f.home, '.codex', 'hooks.json');
    await writeFile(file, '{broken');
    expect(await main(['doctor', '--offline'], f.env)).toBe(1);
    expect(f.text()).toContain('configuration is missing, unreadable or invalid');
    expect(await readFile(file, 'utf8')).toBe('{broken');
  });

  it('detects a stale Node executable in the setup receipt', async () => {
    const f = await fixture();
    const file = join(f.home, 'data', 'setup.json');
    const marker = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...marker, node: 'missing-old-node' }));
    expect(await main(['doctor', '--offline'], f.env)).toBe(1);
    expect(f.text()).toContain('Setup is incomplete or stale');
  });

  it('identifies the old development launcher selected by PATH', async () => {
    const f = await fixture();
    const binDir = join(f.home, 'bin');
    await mkdir(binDir);
    await writeFile(
      join(binDir, process.platform === 'win32' ? 'quorum.cmd' : 'quorum'),
      'node node_modules/@quorum/cli/bin/quorum.js',
    );
    expect(await main(['doctor', '--offline'], { ...f.env, path: binDir })).toBe(1);
    expect(f.text()).toContain('old @quorum/cli development link');
  });

  it('redacts credential-store exceptions instead of printing their contents', async () => {
    const f = await fixture();
    vi.spyOn(f.store, 'load').mockRejectedValue(new Error('Bearer do-not-print-this'));
    expect(await main(['doctor', '--offline'], f.env)).toBe(1);
    expect(f.text()).toContain('OS keychain is unavailable');
    expect(f.text()).not.toContain('do-not-print-this');
  });

  it('checks both HTTP health and a real WebSocket upgrade', async () => {
    const f = await fixture();
    relay = await startRelay({ port: 0 });
    expect(await main(['doctor'], { ...f.env, relay: relay.url })).toBe(0);
    expect(f.text()).toContain('OK Relay HTTP health');
    expect(f.text()).toContain('OK Relay WebSocket upgrade');
  });

  it('rejects insecure remote relay URLs without making a request', async () => {
    const f = await fixture();
    const fetcher = vi.fn<typeof fetch>();
    expect(await main(['doctor'], { ...f.env, relay: 'ws://example.com', fetch: fetcher })).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(f.text()).toContain('TLS verification was not disabled');
  });

  it('does not treat a non-relay HTTP response as healthy', async () => {
    const f = await fixture();
    const fetcher: typeof fetch = () => Promise.resolve(new Response('<html>proxy sign-in</html>'));
    expect(await main(['doctor'], { ...f.env, fetch: fetcher })).toBe(1);
    expect(f.text()).toContain('response/configuration is invalid');
  });
});
