// Test the installed release, without the repository's workspace links or developer tooling.
// A pair of separate processes can use different Node executables; the protocol must still work.
// All hooks, databases and keys go in disposable profiles. Never use a maintainer's live profile.
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const self = fileURLToPath(import.meta.url);
const load = (pkg, file) => import(pathToFileURL(join(pkg, 'lib', file)).href);

async function worker() {
  const [, , , pkg, dataDir, relay, machine] = process.argv;
  const { startLocalServer } = await load(pkg, 'server/dist/index.js');
  const server = await startLocalServer({
    dataDir,
    relay,
    machine,
    ownerName: 'compat-owner',
    idleShutdownMs: 0,
    federationIntervalMs: 100,
  });
  process.on('message', async (message) => {
    if (message !== 'stop') return;
    try {
      await server.close();
    } finally {
      if (process.connected) process.disconnect();
    }
  });
  // If the coordinator dies, do not leave a background home or relay connection alive.
  process.on('disconnect', () => {
    void server.close();
  });
  process.send({ baseUrl: server.baseUrl, version: process.version, arch: process.arch });
}

async function main() {
  const { values } = parseArgs({
    options: { package: { type: 'string' }, 'peer-node': { type: 'string' } },
  });
  assert(values.package, 'Pass --package <installed @quorumhq/quorum directory>.');
  const pkg = resolve(values.package);
  const peerNode = values['peer-node'] ?? process.execPath;
  const root = await mkdtemp(join(tmpdir(), 'quorum compatibility α '));
  const children = [];
  let relay;
  let success = false;
  const requirePackage = createRequire(join(pkg, 'package.json'));

  async function start(node, name) {
    const dataDir = join(root, name, 'data');
    const child = fork(self, ['worker', pkg, dataDir, relay.url, name], {
      execPath: node,
      execArgv: [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr = (stderr + data.toString()).slice(-4000);
    });
    const exited = new Promise((resolveExit) =>
      child.once('close', (code, signal) => resolveExit({ code, signal })),
    );
    const item = { child, exited };
    children.push(item);
    const info = await new Promise((resolveReady, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Runtime ${name} startup timed out: ${stderr}`)),
        30_000,
      );
      const done = () => clearTimeout(timeout);
      child.once('message', (message) => {
        done();
        resolveReady(message);
      });
      child.once('error', (error) => {
        done();
        reject(error);
      });
      child.once('exit', (code) => {
        done();
        reject(new Error(`Runtime ${name} exited (${code}): ${stderr}`));
      });
    });
    return { ...info, dataDir };
  }

  async function request(home, method, path, { token, session, body, status = 200 } = {}) {
    const response = await fetch(`${home.baseUrl}${path}`, {
      method,
      signal: AbortSignal.timeout(25_000),
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(session ? { 'quorum-session': session } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, status, `${method} ${path}`);
    const text = await response.text();
    return response.headers.get('content-type')?.includes('application/json')
      ? JSON.parse(text)
      : text;
  }

  async function until(read, matches, what) {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const result = await read();
      if (matches(result)) return result;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw new Error(`Timed out waiting for ${what}.`);
  }

  async function joinSession(home, vendor, name) {
    const { code } = JSON.parse(await readFile(join(home.dataDir, 'local/bootstrap.json'), 'utf8'));
    const human = (await request(home, 'POST', '/v1/auth/local-bootstrap', { body: { code } }))
      .credentials.access_token;
    const project = join(root, `project ${name} α`);
    await mkdir(project);
    const input = { vendor, vendor_session_id: `compat-${name}`, root: project };
    const identity = await request(home, 'POST', '/v1/quorum-ids', {
      token: human,
      body: input,
      status: 201,
    });
    const token = identity.credentials.access_token;
    const window = await request(home, 'POST', '/v1/sessions', {
      token,
      body: { vendor_session_id: input.vendor_session_id, root: project },
      status: 201,
    });
    const session = { ...home, human, input, token, window: window.session_id, id: identity.id };
    session.call = (method, path, options = {}) =>
      request(home, method, path, { token, session: window.session_id, ...options });
    return session;
  }

  async function links(session) {
    return (await session.call('GET', '/v1/links')).links;
  }
  async function registered(id) {
    await until(
      async () => {
        const response = await fetch(`${relay.url.replace('ws:', 'http:')}/v1/lookup/${id}`);
        await response.arrayBuffer();
        return response.status;
      },
      (status) => status === 200,
      'relay registration',
    );
  }

  async function pair(a, b) {
    await registered(a.id);
    await registered(b.id);
    await a.call('POST', '/v1/links', { body: { to: b.id }, status: 202 });
    await until(
      () => links(b),
      (list) => list.some((link) => link.id === a.id && link.state === 'pending'),
      'pending consent',
    );
    await a.call('POST', '/v1/links/send', {
      body: { to: [b.id], type: 'note', body: { text: 'must not send' } },
      status: 400,
    });
    await b.call('POST', '/v1/links/allow', { body: { id: a.id } });
    await until(
      () => links(a),
      (list) => list.some((link) => link.id === b.id && link.state === 'linked'),
      'approved link',
    );
  }

  async function send(a, b, text) {
    await a.call('POST', '/v1/links/send', {
      body: { to: [b.id], type: 'note', body: { text } },
      status: 201,
    });
    const [link] = await links(b);
    assert(link?.workspace, 'An approved pair needs a workspace.');
    const messages = await until(
      async () => (await b.call('GET', `/v1/workspaces/${link.workspace}/inbox?after=0`)).messages,
      (list) => list.some((message) => message.body.text === text),
      'cross-runtime message',
    );
    assert.equal(
      messages.filter((message) => message.body.text === text).length,
      1,
      'Deliver once',
    );
  }

  try {
    // Loading the native binding catches missing OS/architecture builds even without a desktop
    // keychain service (headless Linux CI). Never fall back to plaintext credential storage.
    assert.equal(typeof requirePackage('@napi-rs/keyring').Entry, 'function');
    const cliHome = join(root, 'cli profile');
    await mkdir(cliHome);
    const cliOptions = {
      cwd: cliHome,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: cliHome,
        USERPROFILE: cliHome,
        CODEX_HOME: join(cliHome, 'codex profile'),
        CLAUDE_CONFIG_DIR: join(cliHome, 'claude profile'),
        QUORUM_HOME: join(cliHome, 'data'),
        PATH: dirname(process.execPath),
      },
    };
    const diagnostics = spawnSync(
      process.execPath,
      [join(pkg, 'bin/quorum.js'), 'doctor', '--offline'],
      cliOptions,
    );
    assert.equal(diagnostics.status, 1, 'An unconfigured profile must fail diagnostics.');
    assert.match(diagnostics.stdout, /read-only/);
    await assert.rejects(readFile(join(cliHome, 'claude profile/settings.json')), {
      code: 'ENOENT',
    });
    const cli = spawnSync(process.execPath, [join(pkg, 'bin/quorum.js')], cliOptions);
    assert.equal(
      cli.status,
      0,
      [cli.error?.message, cli.stderr, cli.stdout].filter(Boolean).join('\n') ||
        `Packaged CLI failed (signal ${cli.signal ?? 'none'}).`,
    );
    assert.match(cli.stdout, /Usage: quorum/);
    const settings = JSON.parse(
      await readFile(join(cliHome, 'claude profile/settings.json'), 'utf8'),
    );
    assert(
      settings.hooks?.PreToolUse,
      'First invocation must install hooks even with npm scripts disabled.',
    );
    assert.match(
      await readFile(join(cliHome, 'codex profile/config.toml'), 'utf8'),
      /mcp_servers.quorum/,
    );
    const marker = JSON.parse(await readFile(join(cliHome, 'data/setup.json'), 'utf8'));
    assert.equal(marker.node, process.execPath);
    assert.equal(marker.complete, true);
    const { startRelay } = await load(pkg, 'relay/dist/index.js');
    relay = await startRelay({ port: 0, lookupsPerMinute: 10_000, perMinute: 10_000 });
    const a = await joinSession(await start(process.execPath, 'runtime-a'), 'claude-code', 'a');
    const b = await joinSession(await start(peerNode, 'runtime-b'), 'codex', 'b');
    await pair(a, b);
    const text = `runtime-message-${randomUUID()}`;
    await send(a, b, text);
    await send(b, a, `${text}-reply`);
    await a.call('POST', '/v1/quorum-ids/rotate', {
      body: { ...a.input, expected_id: a.id },
      status: 403,
    });
    const rotation = await request(a, 'POST', '/v1/quorum-ids/rotate', {
      token: a.human,
      body: { ...a.input, expected_id: a.id },
    });
    const retried = await request(a, 'POST', '/v1/quorum-ids/rotate', {
      token: a.human,
      body: { ...a.input, expected_id: a.id },
    });
    assert.deepEqual(retried, rotation, 'Lost-response retry must not rotate twice');
    assert.notEqual(rotation.id, a.id);
    await until(
      () => links(b),
      (list) => list.length === 0,
      'remote unlink',
    );
    await b.call('POST', '/v1/links', { body: { to: a.id }, status: 404 });
    assert.match(await a.call('GET', '/v1/links/export'), new RegExp(text));
    a.id = rotation.id;
    await pair(b, a);
    await send(a, b, `${text}-after-rotation`);
    await a.call('POST', '/v1/links/block', { body: { id: b.id }, status: 204 });
    await until(
      () => links(b),
      (list) => list.length === 0,
      'block delivery',
    );
    await b.call('POST', '/v1/links', { body: { to: a.id }, status: 404 });
    console.log(
      `PASS ${process.platform}/${process.arch}: ${a.version} <-> ${b.version}; packaged CLI, native modules, first-use setup, TLS relay, consent, bidirectional delivery, rotation/history and block`,
    );
    success = true;
  } finally {
    for (const { child } of children) if (child.connected) child.send('stop', () => undefined);
    const results = [];
    for (const { child, exited } of children) {
      const timer = setTimeout(() => child.kill(), 10_000);
      const result = await exited;
      clearTimeout(timer);
      results.push(result);
    }
    await relay?.close();
    await rm(root, { recursive: true, force: true });
    if (success)
      for (const result of results)
        assert.equal(result.code, 0, `Worker shutdown (${result.signal ?? 'no signal'})`);
  }
}

try {
  if (process.argv[2] === 'worker') await worker();
  else await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
