import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAttachment, MemoryCredentialStore } from '@quorum/adapter-mcp';
import { bootstrapPath } from '@quorum/local';
import { afterEach, describe, expect, it } from 'vitest';
import { type FakeServer, startFakeServer } from '../../../tests/fakes/fake-server/fake-server.js';
import { type CliEnv, HUMAN_CREDENTIAL_KEY, main } from '../src/index.js';

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** A local server with a published discovery file and a bootstrap code, and an empty keychain. */
const setup = async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quorum-cli-data-'));
  const project = await mkdtemp(join(tmpdir(), 'quorum-cli-proj-'));
  const s = await startFakeServer({ dataDir });
  server = s;
  await writeFile(
    join(dataDir, 'local', 'server.json'),
    JSON.stringify({
      instance_id: s.instanceId,
      pid: process.pid,
      port: Number(new URL(s.baseUrl).port),
      public_key: s.publicKey,
      version: '0.0.0-fake',
      started_at: new Date().toISOString(),
    }),
  );
  const out: string[] = [];
  const err: string[] = [];
  const store = new MemoryCredentialStore();
  const env: CliEnv = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    store,
    dataDir,
    cwd: project,
  };
  return { s, dataDir, project, store, env, text: () => out.join(''), errText: () => err.join('') };
};

const signedIn = async () => {
  const w = await setup();
  expect(await main(['login'], w.env)).toBe(0);
  const workspace = w.s.createWorkspace('demo');
  w.s.join('human:owner', workspace);
  return { ...w, workspace };
};

describe('quorum login', () => {
  it('swaps the code for credentials, stores them under "human", and the code is spent', async () => {
    const { env, store, dataDir, text } = await setup();
    expect(await main(['login'], env)).toBe(0);
    expect(text()).toContain('Signed in as human:owner');
    expect((await store.load(HUMAN_CREDENTIAL_KEY))?.access_token).toMatch(/^qrm_at_/);
    await expect(stat(bootstrapPath(dataDir))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await main(['login'], env)).toBe(1); // no new code until the server restarts
  });

  it('tells the person to restart the server when there is no valid code', async () => {
    const { env, errText, s } = await setup();
    await main(['login'], env);
    await s.issueBootstrap(); // restart: a new code exists again
    expect(await main(['login'], env)).toBe(0);
    expect(await main(['login'], env)).toBe(1);
    expect(errText()).toContain('restart the local server');
  });

  it('never sends the code to a server that fails the identity check (INV-24)', async () => {
    const { env, dataDir, s, errText } = await setup();
    const seen: string[] = [];
    const squatter = createServer((req, res) => {
      let body = '';
      req.on('data', (d: Buffer) => (body += d.toString()));
      req.on('end', () => {
        seen.push(`${req.method ?? ''} ${req.url ?? ''} ${body}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve));
    try {
      await writeFile(
        join(dataDir, 'local', 'server.json'),
        JSON.stringify({
          instance_id: s.instanceId,
          pid: process.pid,
          port: (squatter.address() as AddressInfo).port,
          public_key: s.publicKey,
          version: '0.0.0',
          started_at: new Date().toISOString(),
        }),
      );
      expect(await main(['login'], env)).toBe(2);
      expect(errText()).toContain('IDENTITY CHECK FAILED');
      expect(seen.join('\n')).not.toContain('qrm_bc_');
      expect(seen.every((line) => line.includes('/v1/hello'))).toBe(true);
    } finally {
      squatter.closeAllConnections();
      squatter.close();
    }
  });
});

describe('quorum attach / detach', () => {
  it('asks you to sign in first', async () => {
    const { env, errText } = await setup();
    expect(await main(['attach', '--vendor', 'codex'], env)).toBe(1);
    expect(errText()).toContain('quorum login');
  });

  it('attaches a folder, keeps credentials in the keychain, and prints the Codex setup', async () => {
    const { env, store, dataDir, project, workspace, text } = await signedIn();
    expect(await main(['attach', '--vendor', 'codex', '--workspace', workspace], env)).toBe(0);
    const id = /\((at_[0-9A-Z]{26})\)/.exec(text())?.[1] ?? '';
    expect(id).not.toBe('');
    expect(text()).toContain('.codex/config.toml');
    expect(text()).toContain(`args = ["mcp", "--attachment", "${id}"]`);
    expect(text()).toContain('wake off');

    expect((await store.load(id))?.access_token).toMatch(/^qrm_at_/);
    const record = await loadAttachment(dataDir, id);
    expect(record).toMatchObject({ vendor: 'codex', workspaces: [workspace], wake: 'off' });
    expect(record?.root.toLowerCase().replaceAll('\\', '/')).toContain(
      project.toLowerCase().replaceAll('\\', '/').split('/').at(-1),
    );
    // Nothing secret is in the record, and nothing was written into the project folder.
    expect(JSON.stringify(record)).not.toContain('qrm_');
    await expect(stat(join(project, '.codex'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses the only workspace when none is given, and asks when there are several', async () => {
    const { env, s, text, errText } = await signedIn();
    expect(await main(['attach', '--vendor', 'claude-code'], env)).toBe(0);
    expect(text()).toContain('claude mcp add --scope local quorum');
    const other = s.createWorkspace('second');
    s.join('human:owner', other);
    expect(await main(['attach', '--vendor', 'generic'], env)).toBe(64);
    expect(errText()).toContain('Pass --workspace');
  });

  it('rejects bad input without contacting the server', async () => {
    const { env, errText, dataDir } = await signedIn();
    expect(await main(['attach'], env)).toBe(64);
    expect(await main(['attach', '--vendor', 'emacs'], env)).toBe(64);
    expect(await main(['attach', '--vendor', 'codex', '--wake', 'sometimes'], env)).toBe(64);
    expect(await main(['attach', '--vendor', 'codex', 'no-such-folder'], env)).toBe(64);
    expect(await main(['attach', '--vendor', 'codex', dataDir], env)).toBe(64);
    expect(errText()).toContain('Quorum data directory');
    await mkdir(join(dataDir, 'nested'));
    expect(await main(['attach', '--vendor', 'codex', join(dataDir, 'nested')], env)).toBe(64);
  });

  it('refuses the data directory however its path is spelled: symlink or junction (INV-25)', async () => {
    const w = await signedIn();
    const alias = join(await mkdtemp(join(tmpdir(), 'quorum-alias-')), 'data');
    await symlink(w.dataDir, alias, 'junction'); // 'junction' needs no privileges on Windows
    const viaAlias: CliEnv = { ...w.env, dataDir: alias };
    // The CLI knows the data folder by the alias; the person attaches the real folder (and back).
    expect(await main(['attach', '--vendor', 'codex', w.dataDir], viaAlias)).toBe(64);
    expect(await main(['attach', '--vendor', 'codex', join(w.dataDir, 'local')], viaAlias)).toBe(
      64,
    );
    expect(await main(['attach', '--vendor', 'codex', alias], w.env)).toBe(64);
    expect(w.errText()).toContain('Quorum data directory');
  });

  it('refuses the data directory when it is spelled as a Windows 8.3 short name (INV-25)', async (context) => {
    if (process.platform !== 'win32') context.skip();
    const w = await signedIn();
    // GitHub's Windows runners use C:\Users\RUNNER~1\... for the temp folder.
    const shortName = spawnSync(
      'cmd.exe',
      ['/d', '/s', '/c', `for %I in ("${w.dataDir}") do @echo %~sI`],
      { encoding: 'utf8', windowsVerbatimArguments: true },
    ).stdout.trim();
    if (!shortName || shortName.toLowerCase() === w.dataDir.toLowerCase()) context.skip(); // no 8.3 names here
    const viaShortName: CliEnv = { ...w.env, dataDir: shortName };
    expect(await main(['attach', '--vendor', 'codex', w.dataDir], viaShortName)).toBe(64);
    expect(w.errText()).toContain('Quorum data directory');
  });

  it('changes wake settings with --update, and the local record follows', async () => {
    const { env, dataDir, text, workspace } = await signedIn();
    await main(['attach', '--vendor', 'codex', '--workspace', workspace], env);
    const id = /\((at_[0-9A-Z]{26})\)/.exec(text())?.[1] ?? '';
    expect(
      await main(
        ['attach', '--update', id, '--wake', 'direct', '--wake-types', 'request,retraction'],
        env,
      ),
    ).toBe(0);
    expect(text()).toContain('wake direct');
    expect(await loadAttachment(dataDir, id)).toMatchObject({
      wake: 'direct',
      wake_types: ['request', 'retraction'],
    });
    expect(await main(['attach', '--update', id], env)).toBe(64); // nothing to change
    expect(await main(['attach', '--update', id, '--wake-types', 'gossip'], env)).toBe(64);
  });

  it('detach removes the credentials and the record, and refuses an unknown id', async () => {
    const { env, store, dataDir, text, errText, workspace } = await signedIn();
    await main(['attach', '--vendor', 'codex', '--workspace', workspace], env);
    const id = /\((at_[0-9A-Z]{26})\)/.exec(text())?.[1] ?? '';
    expect(await main(['detach', id], env)).toBe(0);
    expect(await store.load(id)).toBeUndefined();
    expect(await loadAttachment(dataDir, id)).toBeUndefined();
    expect(await main(['detach', id], env)).toBe(1);
    expect(errText()).toContain('attachment.not_found');
    expect(await main(['detach'], env)).toBe(64);
  });

  it('an attached agent can then use inbox and send as itself', async () => {
    const { env, text, workspace, s } = await signedIn();
    await main(['attach', '--vendor', 'codex', '--workspace', workspace], env);
    const id = /\((at_[0-9A-Z]{26})\)/.exec(text())?.[1] ?? '';
    const peer = s.addAgent('agent:peer@lab', [workspace]);
    const agent = /as (agent:\S+) \(/.exec(text())?.[1] ?? '';
    await fetch(`${s.baseUrl}/v1/workspaces/${workspace}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${peer.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        spec: 'quorum/1',
        id: 'msg_01J9ZZZZZZZZZZZZZZZZZZZZZZ',
        workspace,
        from: peer.address,
        to: [agent],
        type: 'note',
        type_version: 1,
        created_at: new Date().toISOString(),
        body: { text: 'hello new agent' },
      }),
    });
    expect(await main(['inbox', '--attachment', id], env)).toBe(0);
    expect(text()).toContain('hello new agent');
    expect(
      await main(['send', '--attachment', id, '--to', peer.address, '--text', 'hi'], env),
    ).toBe(0);
  });
});
