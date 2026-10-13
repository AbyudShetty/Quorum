// The pairing commands as Claude Code and Codex run them (D-20, PAIRING.md): Quorum's user-level
// hooks with no --attachment. Claude Code on "laptop A" sends `/quorum-id` (a UserPromptExpansion
// event); Codex on "laptop B" types `$quorum-attach <id>` (a UserPromptSubmit event); A's next
// prompt shows the request; `/quorum-allow` links them; mail flows through the relay; export and
// detach work; a session that never ran a command gets nothing.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadRemoteServer,
  MemoryCredentialStore,
  QuorumClient,
  saveRemoteServer,
} from '@quorum/adapter-mcp';
import { closeRelayConnections } from '@quorum/local';
import { type Relay, startRelay } from '@quorum/relay';
import { type LocalServer, startLocalServer } from '@quorum/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CliEnv, HUMAN_CREDENTIAL_KEY, main } from '../src/index.js';

let relay: Relay;
let root: string;
const servers: LocalServer[] = [];

interface Machine {
  dataDir: string;
  env: CliEnv;
  store: MemoryCredentialStore;
}

const machine = async (name: string): Promise<Machine> => {
  const dataDir = join(root, name);
  servers.push(
    await startLocalServer({
      dataDir,
      machine: name,
      relay: relay.url,
      idleShutdownMs: 0,
      federationIntervalMs: 100,
    }),
  );
  const store = new MemoryCredentialStore();
  return {
    dataDir,
    store,
    env: { out: () => undefined, err: () => undefined, store, dataDir, vendorPid: 4242 },
  };
};

/** Run one hook as the vendor would: JSON on stdin, JSON (or nothing) on stdout. */
const hook = async (m: Machine, vendor: 'claude-code' | 'codex', event: string, input: unknown) => {
  const out: string[] = [];
  const code = await main(['hook', vendor, event], {
    ...m.env,
    out: (t) => out.push(t),
    stdin: () => Promise.resolve(JSON.stringify(input)),
  });
  expect(code).toBe(0);
  const text = out.join('').trim();
  return text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
};

const folder = (name: string) => {
  const dir = join(root, 'projects', name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

let a: Machine;
let b: Machine;
let folderA: string;
let folderB: string;
const claudeA = (extra: Record<string, unknown>) => ({
  session_id: 'claude-a-1',
  cwd: folderA,
  ...extra,
});
const codexB = (extra: Record<string, unknown>) => ({
  session_id: 'codex-b-1',
  cwd: folderB,
  ...extra,
});

beforeAll(async () => {
  relay = await startRelay({ port: 0, lookupsPerMinute: 10_000, perMinute: 10_000 });
  root = mkdtempSync(join(tmpdir(), 'quorum-commands-'));
  a = await machine('laptop-a');
  b = await machine('laptop-b');
  folderA = folder('api');
  folderB = folder('web');
}, 60_000);

afterAll(async () => {
  closeRelayConnections();
  for (const server of servers) await server.close();
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

const until = async <T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string) => {
  for (let i = 0; i < 300; i++) {
    const value = await read();
    if (ok(value)) return value;
    await new Promise((done) => setTimeout(done, 30));
  }
  throw new Error(`timed out: ${what}`);
};

describe('pairing commands typed in sessions (D-20)', () => {
  let idA = '';
  let idB = '';

  it('a session that never ran a command gets nothing from the hooks', async () => {
    expect(
      await hook(a, 'claude-code', 'prompt', claudeA({ prompt: 'fix the build' })),
    ).toBeUndefined();
    expect(await hook(a, 'claude-code', 'session-start', claudeA({}))).toBeUndefined();
  });

  it('/quorum-id joins the session and shows its ID; the prompt never reaches the model', async () => {
    const out = await hook(
      a,
      'claude-code',
      'command',
      claudeA({ command_name: 'quorum-id', command_args: '' }),
    );
    expect(out?.decision).toBe('block');
    const reason = String(out?.reason);
    idA = /QRM-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/.exec(reason)?.[0] ?? '';
    expect(reason).toContain(`Quorum ID of this session (claude@api-1): ${idA}`);
    expect(reason).toContain(`/quorum-attach ${idA}`);
    expect(reason).toContain(`$quorum-attach ${idA}`);
    // Again: the same ID.
    const again = await hook(a, 'claude-code', 'command', claudeA({ command_name: 'quorum-id' }));
    expect(String(again?.reason)).toContain(idA);
  });

  it('$quorum-attach <id> in Codex asks the other person', async () => {
    await until(
      async () => (await fetch(`${relay.url.replace('ws://', 'http://')}/v1/lookup/${idA}`)).status,
      (s) => s === 200,
      'A in the phone book',
    );
    const out = await hook(
      b,
      'codex',
      'prompt',
      codexB({ prompt: `$quorum-attach ${idA.toLowerCase()}` }),
    );
    expect(out?.decision).toBe('block');
    expect(String(out?.reason)).toMatch(/^Quorum: asked QRM-.* to link with this session \(QRM-/);
    idB = /\((QRM-[0-9A-Z-]+)\)/.exec(String(out?.reason))?.[1] ?? '';
  });

  it("A's person sees the request at the next prompt, once, and /quorum-allow links them", async () => {
    const shown = await until(
      () => hook(a, 'claude-code', 'prompt', claudeA({ prompt: 'what is new?' })),
      (o) => String(o?.systemMessage).includes('wants to link'),
      'request notice at A',
    );
    expect(String(shown?.systemMessage)).toContain(`codex@laptop-b - `);
    expect(String(shown?.systemMessage)).toContain(`/quorum-allow ${idB}`);
    expect(await hook(a, 'claude-code', 'prompt', claudeA({ prompt: 'again' }))).toBeUndefined();

    const allowed = await hook(
      a,
      'claude-code',
      'command',
      claudeA({ command_name: 'quorum-allow', command_args: '' }),
    );
    expect(String(allowed?.reason)).toContain('Quorum: allowed.');
    expect(String(allowed?.reason)).toContain(`Linked with: codex@laptop-b - `);
    await until(
      () => hook(b, 'codex', 'prompt', codexB({ prompt: '$quorum-id' })),
      (o) => String(o?.reason).includes('Linked with: claude@laptop-a - '),
      'link at B',
    );
  }, 30_000);

  it("mail from B's session arrives in A's next prompt, framed, from B's window", async () => {
    // B's agent sends, as its quorum_send tool would.
    const pairing = JSON.parse(
      readFileSync(join(b.dataDir, 'hooks', 'pairing.json'), 'utf8'),
    ) as Record<string, { attachment: string }>;
    const attachment = pairing['codex:codex-b-1']?.attachment ?? '';
    const client = await QuorumClient.connect({
      dataDir: b.dataDir,
      credentialKey: attachment,
      store: b.store,
    });
    await client.sendToLinks({ to: [idA], type: 'note', body: { text: 'hello from codex on B' } });
    const delivered = await until(
      () => hook(a, 'claude-code', 'prompt', claudeA({ prompt: 'anything new?' })),
      (o) => JSON.stringify(o ?? {}).includes('hello from codex on B'),
      'mail at A',
    );
    const context = (delivered?.hookSpecificOutput as { additionalContext: string })
      .additionalContext;
    expect(context).toMatch(/<<quorum [0-9a-f]{16}>>/);
    expect(context).toContain(`codex@laptop-b - `);
    expect(context).toContain('hello from codex on B');
  }, 30_000);

  it('/quorum-export writes quorum-claude1.md in the folder', async () => {
    const out = await hook(a, 'claude-code', 'command', claudeA({ command_name: 'quorum-export' }));
    expect(String(out?.reason)).toContain('quorum-claude1.md');
    const file = join(folderA, 'quorum-claude1.md');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('> hello from codex on B');
  });

  it('a wrong ID says so; /quorum-detach unlinks without asking', async () => {
    const wrong = await hook(
      a,
      'claude-code',
      'command',
      claudeA({ command_name: 'quorum-attach', command_args: 'QRM-0000-0000-0000' }),
    );
    expect(String(wrong?.reason)).toBe(
      'Quorum: there is no session QRM-0000-0000-0000. Check the ID with the person who gave it to you.',
    );
    const detached = await hook(
      a,
      'claude-code',
      'command',
      claudeA({ command_name: 'quorum-detach' }),
    );
    expect(String(detached?.reason)).toBe(`Quorum: unlinked from ${idB}.`);
  });

  it('commands in a session that has not joined say how to join', async () => {
    const out = await hook(a, 'claude-code', 'command', {
      session_id: 'other',
      cwd: folderA,
      command_name: 'quorum-allow',
    });
    expect(String(out?.reason)).toBe(
      'Quorum: This session is not in Quorum yet: type /quorum-id first.',
    );
  });
});

describe('pairing commands on a laptop with leftovers, or stuck', () => {
  it('a sign-in to another machine left by `quorum login <link>` is dropped: this laptop is used', async () => {
    const c = await machine('laptop-c');
    await saveRemoteServer(c.dataDir, {
      url: 'https://old-tunnel.invalid',
      instance_id: 'in_old',
      public_key: 'AAAA',
    });
    await c.store.save(HUMAN_CREDENTIAL_KEY, {
      access_token: 'old',
      refresh_token: 'old',
      access_expires_at: Date.now() + 60_000,
    });
    const out = await hook(c, 'codex', 'prompt', {
      session_id: 'codex-c-1',
      cwd: folder('old'),
      prompt: '$quorum-id',
    });
    expect(String(out?.reason)).toMatch(/Quorum ID of this session \(codex@old-1\): QRM-/);
    expect(await loadRemoteServer(c.dataDir)).toBeUndefined();
  });

  it('a command that gets stuck answers before the vendor gives up, naming the step', async () => {
    const d = join(root, 'laptop-d');
    const out: string[] = [];
    await main(['hook', 'codex', 'prompt'], {
      out: (t) => out.push(t),
      err: () => undefined,
      store: new MemoryCredentialStore(),
      dataDir: d,
      startServer: () => new Promise(() => undefined), // a server that never comes up
      commandLimitMs: 200,
      stdin: () =>
        Promise.resolve(JSON.stringify({ session_id: 's', cwd: d, prompt: '$quorum-id' })),
    });
    const reason = (JSON.parse(out.join('')) as { reason: string }).reason;
    expect(reason).toContain('took too long and was stopped (at step "sign-in")');
    expect(readFileSync(join(d, 'hooks', 'commands.log'), 'utf8')).toMatch(
      /codex id \+\d+ms gave up at sign-in/,
    );
  });
});
