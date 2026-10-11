// Phase 1b: two machines, one server. "Laptop A" runs the real server with remote access on;
// "laptop B" is a second CLI with its own data folder and keychain, reaching A through a stand-in
// for the HTTPS front end (`tailscale serve` / `cloudflared`): it rewrites A's public address to
// A's loopback port and adds the forwarding header those front ends add.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAttachment, MemoryCredentialStore } from '@quorum/adapter-mcp';
import { writeRemoteConfig } from '@quorum/local';
import { type LocalServer, startLocalServer } from '@quorum/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CliEnv, main } from '../src/index.js';

const PUBLIC = 'https://laptop-a.tail1234.ts.net';
let root: string;
let server: LocalServer;

const freePort = () =>
  new Promise<number>((done) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => {
        done(port);
      });
    });
  });

/** One machine's CLI: its own data folder, keychain and output. */
const machine = (dataDir: string, extra: Partial<CliEnv> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const env: CliEnv = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    store: new MemoryCredentialStore(),
    dataDir,
    confirm: () => Promise.resolve(true), // the person at each terminal says yes (INV-30)
    sleep: () => new Promise((done) => setTimeout(done, 20)),
    ...extra,
  };
  const run = async (...argv: string[]) => {
    out.length = 0;
    err.length = 0;
    const code = await main(argv, env);
    return { code, out: out.join(''), err: err.join('') };
  };
  return { env, run, out };
};

let a: ReturnType<typeof machine>;
let b: ReturnType<typeof machine>;
let workspace = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'quorum-1b-'));
  const dataA = join(root, 'a-data');
  await mkdir(join(dataA, 'local'), { recursive: true });
  const port = await freePort();
  await writeRemoteConfig(dataA, { public_url: PUBLIC, port });
  server = await startLocalServer({ dataDir: dataA, machine: 'laptop-a' });
  // Laptop B reaches A only through the front end.
  const frontEnd: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const headers = new Headers(init?.headers);
    headers.set('x-forwarded-for', '100.64.0.2');
    return fetch(url.replace(PUBLIC, `http://127.0.0.1:${String(port)}`), { ...init, headers });
  };
  a = machine(dataA);
  b = machine(join(root, 'b-data'), { fetch: frontEnd });
  expect((await a.run('login')).code).toBe(0);
  const created = await a.run('workspace', 'create', 'demo');
  workspace = /(ws_[0-9A-Z]{26})/.exec(created.out)?.[1] ?? '';
}, 60_000);

afterAll(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

describe('Phase 1b: an agent on laptop B joins the server on laptop A', () => {
  let joined = '';
  const folderB = () => join(root, 'b-projects', 'web');

  it('A shows its server link, with the key fingerprint', async () => {
    const status = await a.run('remote', 'status');
    expect(status.out).toContain(`Remote access is on: ${PUBLIC}`);
    expect(status.out).toMatch(/https:\/\/laptop-a\.tail1234\.ts\.net#k=[A-Za-z0-9_-]{43}/);
  });

  it('refuses a link whose fingerprint is not the server key, and sends nothing (INV-24)', async () => {
    const code = (await a.run('join-code', '--wake', 'direct')).out;
    const link = /(https:\/\/\S+#k=\S+&j=\S+)/.exec(code)?.[1] ?? '';
    await mkdir(folderB(), { recursive: true });
    const forged = link.replace(/#k=[A-Za-z0-9_-]{43}/, `#k=${'A'.repeat(43)}`);
    const refused = await b.run('join', forged, folderB(), '--vendor', 'codex');
    expect(refused.code).toBe(2); // identity check failed
    expect(refused.err).toContain('does not hold the key');
    // The code was never sent, so the real link still works once.
    const ok = await b.run('join', link, folderB(), '--vendor', 'codex');
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/as agent:codex-web@\S+ \(at_[0-9A-Z]{26}\), wake direct, on https/);
    joined = /\((at_[0-9A-Z]{26})\)/.exec(ok.out)?.[1] ?? '';
    expect((await loadAttachment(b.env.dataDir ?? '', joined))?.server?.url).toBe(PUBLIC);
    expect((await b.run('join', link, folderB(), '--vendor', 'codex')).code).not.toBe(0); // used
  });

  it('messages flow both ways between the laptops', async () => {
    const folderA = join(root, 'a-projects', 'api');
    await mkdir(folderA, { recursive: true });
    const attached = await a.run(
      'attach',
      folderA,
      '--vendor',
      'claude-code',
      '--workspace',
      workspace,
    );
    const local = /as (agent:\S+) \((at_[0-9A-Z]{26})\)/.exec(attached.out);
    const [, agentA = '', attachmentA = ''] = local ?? [];
    const agentB = (await loadAttachment(b.env.dataDir ?? '', joined))?.agent ?? '';

    expect(
      (await b.run('send', '--attachment', joined, '--to', agentA, '--text', 'hi from B')).code,
    ).toBe(0);
    const inboxA = await a.run('inbox', '--attachment', attachmentA);
    expect(inboxA.out).toContain('hi from B');
    expect(inboxA.out).toContain(agentB.replace('agent:', ''));

    expect(
      (await a.run('send', '--attachment', attachmentA, '--to', agentB, '--text', 'hi from A'))
        .code,
    ).toBe(0);
    expect((await b.run('inbox', '--attachment', joined)).out).toContain('hi from A');
  });
});

describe('Phase 1b: the human signs in on laptop B with a device code', () => {
  it('B waits for the code to be approved on A, then works as that human', async () => {
    const link =
      /(https:\/\/\S+#k=[A-Za-z0-9_-]{43})/.exec((await a.run('remote', 'status')).out)?.[1] ?? '';
    const waiting = b.run('login', link);
    let code = '';
    for (let i = 0; i < 100 && !code; i++) {
      await new Promise((done) => setTimeout(done, 20));
      code = /quorum login approve ([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(b.out.join(''))?.[1] ?? '';
    }
    expect(code).not.toBe('');
    expect((await a.run('login', 'approve', code)).out).toMatch(/Approved: \S+ is now signed in/);
    const signedIn = await waiting;
    expect(signedIn.code).toBe(0);
    expect(signedIn.out).toContain(`Signed in to ${PUBLIC}`);
    // Human commands on B now use A's server.
    expect((await b.run('workspace', 'list')).out).toContain('demo');
  });

  it('A must confirm the approval at its terminal', async () => {
    const link =
      /(https:\/\/\S+#k=[A-Za-z0-9_-]{43})/.exec((await a.run('remote', 'status')).out)?.[1] ?? '';
    const c = machine(join(root, 'c-data'), {
      fetch: b.env.fetch ?? fetch,
      sleep: () => new Promise((d) => setTimeout(d, 20)),
    });
    const waiting = c.run('login', link);
    let code = '';
    for (let i = 0; i < 100 && !code; i++) {
      await new Promise((done) => setTimeout(done, 20));
      code = /quorum login approve ([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(c.out.join(''))?.[1] ?? '';
    }
    a.env.confirm = () => Promise.resolve(false);
    try {
      expect((await a.run('login', 'approve', code)).code).toBe(64);
    } finally {
      a.env.confirm = () => Promise.resolve(true);
    }
    expect((await a.run('login', 'approve', code)).code).toBe(0); // now approved for real
    expect((await waiting).code).toBe(0);
  });
});
