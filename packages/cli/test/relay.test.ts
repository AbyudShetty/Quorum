// Phase 1b through the relay (DECISIONS D-18, ARCHITECTURE §8.4). "Laptop A" runs the real server
// with remote access through a real relay; "laptop B" is a second CLI with its own data folder and
// keychain, using the real `quorum://` transport (no stand-ins). B reaches the relay through a
// recording proxy, to show what the relay operator could see: not the messages, tokens or codes.
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { type AddressInfo, connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecureContext, TLSSocket } from 'node:tls';
import { closeRelayConnections, loadAttachment, MemoryCredentialStore } from '@quorum/adapter-mcp';
import { webSocketStream, writeRemoteConfig } from '@quorum/local';
import { type Relay, startRelay } from '@quorum/relay';
import { type LocalServer, startLocalServer } from '@quorum/server';
import { WebSocketServer } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { selfSignedCertificate } from '../../server/src/relay/certificate.js';
import { HOSTED_RELAY } from '../src/cli.js';
import { type CliEnv, main } from '../src/index.js';

let root: string;
let relay: Relay;
let server: LocalServer;
let proxy: Server;
/** Everything the relay sent towards laptop B, as raw bytes on the wire. */
const seenByB: Buffer[] = [];

const machine = (dataDir: string) => {
  const out: string[] = [];
  const err: string[] = [];
  const env: CliEnv = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    store: new MemoryCredentialStore(),
    dataDir,
    confirm: () => Promise.resolve(true), // the person at each terminal says yes (INV-30)
    sleep: () => new Promise((done) => setTimeout(done, 20)),
  };
  const run = async (...argv: string[]) => {
    out.length = 0;
    err.length = 0;
    const code = await main(argv, env);
    return { code, out: out.join(''), err: err.join('') };
  };
  return { env, run };
};

let a: ReturnType<typeof machine>;
let b: ReturnType<typeof machine>;
let workspace = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'quorum-relay-'));
  relay = await startRelay({ port: 0 });
  // A recording TCP proxy in front of the relay, for laptop B only.
  proxy = createServer((client) => {
    const upstream = connect(relay.port, '127.0.0.1');
    client.pipe(upstream);
    upstream.on('data', (chunk: Buffer) => {
      seenByB.push(chunk);
      client.write(chunk);
    });
    upstream.on('close', () => client.destroy());
    client.on('close', () => upstream.destroy());
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', done));

  const dataA = join(root, 'a-data');
  await mkdir(join(dataA, 'local'), { recursive: true });
  await writeRemoteConfig(dataA, { relay: relay.url });
  server = await startLocalServer({ dataDir: dataA, machine: 'laptop-a' });
  for (let i = 0; i < 200 && server.relayState?.() !== 'ready'; i++) {
    await new Promise((done) => setTimeout(done, 20));
  }
  a = machine(dataA);
  b = machine(join(root, 'b-data'));
  expect((await a.run('login')).code).toBe(0);
  const created = await a.run('workspace', 'create', 'demo');
  workspace = /(ws_[0-9A-Z]{26})/.exec(created.out)?.[1] ?? '';
}, 60_000);

afterAll(async () => {
  closeRelayConnections();
  await server.close();
  await relay.close();
  await new Promise<void>((done) =>
    proxy.close(() => {
      done();
    }),
  );
  await rm(root, { recursive: true, force: true });
});

/** The invite as laptop B uses it: through the recording proxy instead of the relay directly. */
const viaProxy = (invite: string) =>
  invite.replace(
    `quorum://127.0.0.1:${String(relay.port)}/`,
    `quorum://127.0.0.1:${String((proxy.address() as AddressInfo).port)}/`,
  );

describe('Phase 1b through the relay', () => {
  let joined = '';
  let secret = '';
  const folderB = () => join(root, 'b-projects', 'web');

  it('A is connected to the relay and shows a quorum:// server link', async () => {
    expect(server.relayState?.()).toBe('ready');
    const status = await a.run('remote', 'status');
    expect(status.out).toContain(`Remote access is on through the relay ${relay.url}`);
    expect(status.out).toMatch(
      /quorum:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{43}#k=[A-Za-z0-9_-]{43}/,
    );
  });

  it('B joins with an invite, through the relay only', async () => {
    const invite = await a.run('invite', '--wake', 'direct');
    expect(invite.code).toBe(0);
    const link = /quorum join "(quorum:\/\/\S+)"/.exec(invite.out)?.[1] ?? '';
    secret = /&j=(qrm_jc_\S+)/.exec(link)?.[1] ?? '';
    expect(secret).not.toBe('');
    await mkdir(folderB(), { recursive: true });
    const ok = await b.run('join', viaProxy(link), folderB(), '--vendor', 'codex');
    expect(ok.err).toBe('');
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(
      /as agent:codex-web@\S+ \(at_[0-9A-Z]{26}\), wake direct, on quorum:\/\//,
    );
    joined = /\((at_[0-9A-Z]{26})\)/.exec(ok.out)?.[1] ?? '';
  }, 30_000);

  it('messages flow both ways, and the relay saw none of them', async () => {
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
    const [, agentA = '', attachmentA = ''] =
      /as (agent:\S+) \((at_[0-9A-Z]{26})\)/.exec(attached.out) ?? [];
    expect(
      (await b.run('send', '--attachment', joined, '--to', agentA, '--text', 'secret plan from B'))
        .code,
    ).toBe(0);
    expect((await a.run('inbox', '--attachment', attachmentA)).out).toContain('secret plan from B');
    const agentB = (await loadAttachment(b.env.dataDir ?? '', joined))?.agent ?? '';
    expect(
      (
        await a.run(
          'send',
          '--attachment',
          attachmentA,
          '--to',
          agentB,
          '--text',
          'secret reply from A',
        )
      ).code,
    ).toBe(0);
    expect((await b.run('inbox', '--attachment', joined)).out).toContain('secret reply from A');

    const wire = Buffer.concat(seenByB).toString('latin1');
    expect(wire).toContain('"paired"'); // the recording works: the relay's own notices are visible
    for (const hidden of ['secret reply from A', 'secret plan from B', secret, 'Bearer', 'qrm_']) {
      expect(wire).not.toContain(hidden);
    }
  }, 30_000);
});

describe('a relay that pretends to be the home server', () => {
  it('cannot get the join code: B checks the TLS key against the invite first', async () => {
    // A fake relay: answers "paired" itself and runs TLS with a key of its own.
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const secureContext = createSecureContext({
      key: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      cert: selfSignedCertificate(privateKey, publicKey),
      minVersion: 'TLSv1.3',
    });
    const received: Buffer[] = [];
    const fake = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((done) => fake.once('listening', done));
    fake.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'paired' }));
      const tls = new TLSSocket(webSocketStream(ws), {
        isServer: true,
        secureContext,
      });
      tls.on('data', (chunk: Buffer) => received.push(chunk));
      tls.on('error', () => tls.destroy());
    });
    const fakePort = (fake.address() as AddressInfo).port;
    const invite = await a.run('invite');
    const link = /quorum join "(quorum:\/\/\S+)"/.exec(invite.out)?.[1] ?? '';
    const pointed = link.replace(
      /quorum:\/\/127\.0\.0\.1:\d+\//,
      `quorum://127.0.0.1:${String(fakePort)}/`,
    );
    await mkdir(join(root, 'b-projects', 'other'), { recursive: true });
    const refused = await b.run(
      'join',
      pointed,
      join(root, 'b-projects', 'other'),
      '--vendor',
      'codex',
    );
    expect(refused.code).not.toBe(0);
    expect(refused.err).toMatch(/does not hold the key|Cannot reach/);
    expect(Buffer.concat(received).length).toBe(0); // not one byte of the request reached it
    fake.close();
  }, 30_000);
});

describe('remote enable --relay', () => {
  it('uses the hosted relay by default, and saves another one given', async () => {
    const c = machine(join(root, 'c-data'));
    const saved = process.env.QUORUM_RELAY;
    delete process.env.QUORUM_RELAY;
    try {
      const hosted = await c.run('remote', 'enable');
      expect(hosted.code).toBe(0);
      expect(hosted.out).toContain(`Remote access is on through the relay ${HOSTED_RELAY}`);
      expect((await c.run('remote', 'enable', '--relay', 'http://example.org')).code).toBe(64);
      const ok = await c.run('remote', 'enable', '--relay', 'wss://relay.example.org');
      expect(ok.code).toBe(0);
      expect(ok.out).toContain('Remote access is on through the relay wss://relay.example.org');
      expect((await c.run('remote', 'status')).out).toContain(
        'through the relay wss://relay.example.org',
      );
    } finally {
      if (saved !== undefined) process.env.QUORUM_RELAY = saved;
    }
  });
});
