// The `quorum` command line (Track B). Phase 1: serve, stop, login, workspace, attach, detach,
// status, inbox, send, export, verify and mcp. `worktree` and `ui` follow (see README).
// Commands that talk to the local server start it when it is not running (ARCHITECTURE §8.2).
//
// Everything is a function of (argv, env) so tests can run it against the fake server without
// spawning processes. Output that contains other participants' messages is always framed as
// untrusted data (INV-9), because a person may paste it to an agent.
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createIdFactory, parseJsonl, verifyChain } from '@quorum/core';
import {
  defaultDataDir,
  isProcessAlive,
  readBootstrapCode,
  readDiscovery,
  removeBootstrapCode,
  removeDiscovery,
} from '@quorum/local';
import { MESSAGE_TYPES, type SubmittedEnvelope, VENDORS } from '@quorum/schemas';
import {
  ApiError,
  type CredentialStore,
  createQuorumMcpServer,
  frameMessages,
  senderResolver,
  startHeartbeat,
  startSession,
  IdentityError,
  loadAttachment,
  removeAttachment,
  saveAttachment,
  Outbox,
  QuorumClient,
  serveStdio,
  UnreachableError,
} from '@quorum/adapter-mcp';
import {
  HOOK_EVENTS,
  HOOK_VENDORS,
  type HookEvent,
  type HookVendor,
  runHook,
} from '@quorum/adapter-hooks';
import { liveServer, ServerStartError } from './local-server.js';
import {
  type ConfigChange,
  type QuorumCommand,
  quorumCommand,
  removeVendorConfig,
  writeVendorConfig,
} from './vendor-config.js';

export interface CliEnv {
  out: (text: string) => void;
  err: (text: string) => void;
  store: CredentialStore;
  dataDir?: string;
  /** Folder `attach` uses when none is given. Default: the process's working directory. */
  cwd?: string;
  fetch?: typeof fetch;
  /**
   * Make sure the local server runs, starting it if needed (auto-start). Left out in tests, which
   * bring their own server.
   */
  startServer?: (dataDir: string) => Promise<void>;
  /** The hook payload a vendor writes to stdin (`quorum hook`). */
  stdin?: () => Promise<string>;
  /** How vendors start `quorum` (default: by name if on the PATH, else Node + this CLI). */
  quorumCommand?: () => Promise<QuorumCommand>;
  /** Stop a verified local server process (default: SIGTERM). Tests replace it. */
  killServer?: (pid: number) => void;
}

/** Keychain entry for the signed-in human (used by `export`). */
export const HUMAN_CREDENTIAL_KEY = 'human';

const HELP = `quorum: coordinate AI coding agents (Phase 1, work in progress)

Usage: quorum <command> [options]

  serve --local [--idle-minutes <n>]         Run the local server in this terminal (commands also
                                             start it in the background when needed)
  stop                                       Stop the local server
  login                                      Sign in as the owner on this machine (local server)
  workspace create <name> | workspace list   Create or list your workspaces
  attach [dir] --vendor <v> [--workspace <ws>] [--wake off|direct|all] [--name <n>] [--new-identity]
         [--no-config]                       Connect a folder to a workspace as an agent and write
                                             the vendor hooks and MCP config (kept out of git)
  attach --update <at_id> [--wake ...] [--wake-types a,b] [--lease-enforcement warn|block]
                                             Change an attachment's wake settings
  detach <at_id>                             Disconnect an attachment and forget its credentials
  status [--attachment <at_id>]              Is the local server up, and is it really ours?
  inbox  --attachment <at_id> [--workspace <ws>] [--limit <n>] [--keep]
                                             Show new messages (framed as untrusted data)
  send   --attachment <at_id> --to <address> [--to ...] --text <text> [--workspace <ws>]
                                             Send a note as that agent
  export --workspace <ws>                    Print the workspace event log (JSON Lines); humans only
  verify <file.jsonl> --workspace <ws>       Check an exported log's hash chain
  mcp    --attachment <at_id>                Run the MCP server for an agent (used by Claude Code / Codex)
  hook   <claude-code|codex> <session-start|prompt|post-tool|stop|session-end> --attachment <at_id>
                                             Run one vendor hook (reads its JSON on stdin; used by
                                             Claude Code / Codex, never fails the agent)
  help

Not yet available: worktree, ui.
`;

class UsageError extends Error {}
/** Something the person has to do first (no code, not signed in). Exit 1 with the fix. */
class NeedsActionError extends Error {}

const need = <T>(value: T | undefined, message: string): T => {
  if (value === undefined || value === '') throw new UsageError(message);
  return value;
};

export const main = async (argv: string[], env: CliEnv): Promise<number> => {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        env.out(HELP);
        return command === undefined ? 1 : 0;
      case 'serve':
        return await serve(rest, env);
      case 'stop':
        return await stop(rest, env);
      case 'workspace':
        return await workspace(rest, env);
      case 'login':
        return await login(rest, env);
      case 'attach':
        return await attach(rest, env);
      case 'detach':
        return await detach(rest, env);
      case 'status':
        return await status(rest, env);
      case 'inbox':
        return await inbox(rest, env);
      case 'send':
        return await send(rest, env);
      case 'export':
        return await exportLog(rest, env);
      case 'verify':
        return await verify(rest, env);
      case 'mcp':
        return await mcp(rest, env);
      case 'hook':
        return await hook(rest, env);
      default:
        throw new UsageError(`Unknown command "${command}". Run \`quorum help\`.`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      env.err(`${error.message}\n`);
      return 64;
    }
    if (error instanceof NeedsActionError) {
      env.err(`${error.message}\n`);
      return 1;
    }
    if (error instanceof IdentityError) {
      env.err(`IDENTITY CHECK FAILED: ${error.message}\n`);
      return 2;
    }
    if (error instanceof UnreachableError || error instanceof ServerStartError) {
      env.err(`${error.message}\n`);
      return 3;
    }
    if (error instanceof ApiError) {
      env.err(`${error.code}: ${error.message}\nFix: ${error.fix}\n`);
      return 1;
    }
    throw error;
  }
};

const dataDirOf = (env: CliEnv): string => env.dataDir ?? defaultDataDir();

const connect = async (
  env: CliEnv,
  credentialKey: string,
  options: { autoStart?: boolean } = {},
): Promise<QuorumClient> => {
  if (options.autoStart ?? true) await env.startServer?.(dataDirOf(env));
  return QuorumClient.connect({
    dataDir: dataDirOf(env),
    credentialKey,
    store: env.store,
    ...(env.fetch ? { fetch: env.fetch } : {}),
  });
};

const attachmentOf = async (env: CliEnv, id: string | undefined) => {
  const attachment = need(id, 'Pass --attachment <at_id>.');
  const info = await loadAttachment(dataDirOf(env), attachment);
  if (!info) {
    throw new UsageError(
      `No attachment ${attachment} on this machine. Run \`quorum attach\` in the project folder.`,
    );
  }
  return info;
};

const workspaceOf = (workspaces: string[], given: string | undefined): string => {
  if (given) {
    if (!workspaces.includes(given)) {
      throw new UsageError(
        `This attachment is not part of ${given}. Use one of: ${workspaces.join(', ')}.`,
      );
    }
    return given;
  }
  const [only, ...more] = workspaces;
  if (only && more.length === 0) return only;
  throw new UsageError(`Several workspaces: pass --workspace <${workspaces.join('|')}>.`);
};

const status = async (args: string[], env: CliEnv): Promise<number> => {
  const { values } = parseArgs({ args, options: { attachment: { type: 'string' } }, strict: true });
  // Status reports; it never starts a server.
  const client = await connect(env, values.attachment ?? HUMAN_CREDENTIAL_KEY, {
    autoStart: false,
  });
  const health = await client.health();
  env.out(
    `Local server: running, version ${health.version}, instance ${health.instance_id}\n` +
      `Address: ${client.baseUrl}\nIdentity: verified against the pinned key\n`,
  );
  return 0;
};

const inbox = async (args: string[], env: CliEnv): Promise<number> => {
  const { values } = parseArgs({
    args,
    options: {
      attachment: { type: 'string' },
      workspace: { type: 'string' },
      limit: { type: 'string', default: '20' },
      keep: { type: 'boolean', default: false },
    },
    strict: true,
  });
  const info = await attachmentOf(env, values.attachment);
  const workspace = workspaceOf(info.workspaces, values.workspace);
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new UsageError('--limit must be a whole number from 1 to 100.');
  }
  const client = await connect(env, info.attachment);
  const page = await client.inbox(workspace, { limit });
  if (page.messages.length === 0) {
    env.out('No new messages.\n');
    return 0;
  }
  const agents = await client.agents(workspace).catch(() => []);
  env.out(`${frameMessages(page.messages, { sender: senderResolver(agents) })}\n`);
  if (!values.keep) {
    await client.ack(workspace, page.next_after); // the server starts the next read here
  }
  if (page.has_more) env.out('(More messages are waiting.)\n');
  return 0;
};

const send = async (args: string[], env: CliEnv): Promise<number> => {
  const { values } = parseArgs({
    args,
    options: {
      attachment: { type: 'string' },
      workspace: { type: 'string' },
      to: { type: 'string', multiple: true },
      text: { type: 'string' },
    },
    strict: true,
  });
  const info = await attachmentOf(env, values.attachment);
  const workspace = workspaceOf(info.workspaces, values.workspace);
  const to = values.to ?? [];
  if (to.length === 0) throw new UsageError('Pass at least one --to <address> (or --to "*").');
  const text = need(values.text, 'Pass --text "<message>".');

  const envelope = {
    spec: 'quorum/1',
    id: createIdFactory().id('message'),
    workspace,
    from: info.agent,
    to,
    type: 'note',
    type_version: 1,
    created_at: new Date().toISOString(),
    body: { text },
  } as unknown as SubmittedEnvelope;

  const outbox = new Outbox(dataDirOf(env), info.attachment);
  await outbox.enqueue({ workspace, envelope });
  try {
    const client = await connect(env, info.attachment);
    const result = await outbox.flush((ws, e) => client.send(ws, e));
    const refused = result.rejected.find((r) => r.id === envelope.id);
    if (refused) {
      env.err(`Refused (${refused.code}): ${refused.message}\n`);
      return 1;
    }
    env.out(`Sent ${envelope.id}.\n`);
    return 0;
  } catch (error) {
    if (error instanceof UnreachableError) {
      env.out(`Saved ${envelope.id}; the server is not reachable, it will be sent when it is.\n`);
      return 0;
    }
    throw error;
  }
};

const exportLog = async (args: string[], env: CliEnv): Promise<number> => {
  const { values } = parseArgs({ args, options: { workspace: { type: 'string' } }, strict: true });
  const workspace = need(values.workspace, 'Pass --workspace <ws_id>.');
  const client = await connect(env, HUMAN_CREDENTIAL_KEY);
  env.out(await client.exportEvents(workspace));
  return 0;
};

const verify = async (args: string[], env: CliEnv): Promise<number> => {
  const { values, positionals } = parseArgs({
    args,
    options: { workspace: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  });
  const file = need(
    positionals[0],
    'Pass the exported file: quorum verify <file.jsonl> --workspace <ws_id>.',
  );
  const workspace = need(values.workspace, 'Pass --workspace <ws_id>.');
  const parsed = parseJsonl(await readFile(file, 'utf8'));
  if (parsed.problem) {
    env.err(`${file} is not valid JSON Lines: ${JSON.stringify(parsed.problem)}\n`);
    return 1;
  }
  const result = verifyChain(workspace, parsed.values);
  if (result.ok) {
    env.out(`OK: ${String(parsed.values.length)} events, hash chain intact.\n`);
    return 0;
  }
  env.err(`VERIFICATION FAILED:\n${JSON.stringify(result, null, 2)}\n`);
  return 1;
};

/** `quorum serve --local`: run the local server in the foreground until Ctrl+C or `quorum stop`. */
const serve = async (args: string[], env: CliEnv): Promise<number> => {
  const { values } = parseArgs({
    args,
    options: { local: { type: 'boolean', default: false }, 'idle-minutes': { type: 'string' } },
    strict: true,
  });
  if (!values.local) {
    throw new UsageError(
      'Only local mode exists so far: run `quorum serve --local`. Remote mode (join codes over Tailscale or Cloudflare Tunnel) comes in Phase 1b.',
    );
  }
  const idleRaw = values['idle-minutes'];
  const idle = idleRaw === undefined ? undefined : Number(idleRaw);
  if (idle !== undefined && !(Number.isInteger(idle) && idle >= 0 && idle <= 1440)) {
    throw new UsageError('--idle-minutes must be a whole number from 0 (never) to 1440.');
  }
  // Loaded only here, so `quorum mcp` and the other commands never load the database driver.
  const { AlreadyRunningError, startLocalServer } = await import('@quorum/server');
  let server: Awaited<ReturnType<typeof startLocalServer>>;
  try {
    server = await startLocalServer({
      dataDir: dataDirOf(env),
      ...(idle === undefined ? {} : { idleShutdownMs: idle * 60_000 }),
    });
  } catch (error) {
    if (error instanceof AlreadyRunningError) {
      env.out(`${error.message}\n`);
      return 0;
    }
    // e.g. a data folder that cannot be made private: the message carries the exact fix (INV-25).
    env.err(`The local server did not start: ${(error as Error).message}\n`);
    return 1;
  }
  env.out(
    `Quorum local server on ${server.baseUrl} (instance ${server.instanceId}).\n` +
      `Data: ${server.dataDir}\nStop it with Ctrl+C or \`quorum stop\`.\n`,
  );
  const shutdown = () => void server.close();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await server.closed;
  process.off('SIGINT', shutdown);
  process.off('SIGTERM', shutdown);
  env.out('Stopped.\n');
  return 0;
};

/** Remove the files a server that was killed could not remove itself, if they are still its own. */
const removeStaleFiles = async (dataDir: string, instanceId: string): Promise<void> => {
  if ((await readDiscovery(dataDir))?.instance_id !== instanceId) return;
  await removeBootstrapCode(dataDir);
  await removeDiscovery(dataDir);
};

/**
 * `quorum stop`. Only a process that just proved, by the identity handshake, that it is our server
 * is signalled: after a crash the pid in the discovery file may belong to an unrelated program.
 */
const stop = async (args: string[], env: CliEnv): Promise<number> => {
  parseArgs({ args, options: {}, strict: true });
  const dataDir = dataDirOf(env);
  const found = await readDiscovery(dataDir);
  if (!found) {
    env.out('No local Quorum server is running.\n');
    return 0;
  }
  try {
    await connect(env, HUMAN_CREDENTIAL_KEY, { autoStart: false });
  } catch (error) {
    if (!(error instanceof UnreachableError)) throw error; // identity failure: signal nothing
    await removeStaleFiles(dataDir, found.instance_id);
    env.out('The local server was not running; removed the files it left behind.\n');
    return 0;
  }
  (env.killServer ?? ((pid) => process.kill(pid, 'SIGTERM')))(found.pid);
  // Done when the process is gone or the server no longer answers (it closed cleanly).
  for (let waited = 0; waited < 10_000; waited += 100) {
    if (!isProcessAlive(found.pid) || !(await liveServer(dataDir))) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  // On Windows the signal ends the process at once, before it can tidy up.
  await removeStaleFiles(dataDir, found.instance_id);
  env.out(`Stopped the local server (pid ${String(found.pid)}).\n`);
  return 0;
};

/** `quorum workspace create <name>` / `quorum workspace list` (humans). */
const workspace = async (args: string[], env: CliEnv): Promise<number> => {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true, strict: true });
  const [action, name] = positionals;
  const client = await humanClient(env);
  if (action === 'create') {
    const created = await client.createWorkspace(
      need(name, 'Pass a name: quorum workspace create <name> (lowercase letters, digits, -).'),
    );
    env.out(`Created workspace ${created.name} (${created.id}).\n`);
    return 0;
  }
  if (action === 'list') {
    const mine = await client.workspaces();
    env.out(
      mine.length === 0
        ? 'No workspaces yet. Create one: quorum workspace create <name>\n'
        : `${mine.map((w) => `${w.id}  ${w.name}`).join('\n')}\n`,
    );
    return 0;
  }
  throw new UsageError('Use `quorum workspace create <name>` or `quorum workspace list`.');
};

/** The signed-in human's client; tells the person what to do if they have not signed in. */
const humanClient = async (env: CliEnv): Promise<QuorumClient> => {
  const client = await connect(env, HUMAN_CREDENTIAL_KEY);
  if (!(await env.store.load(HUMAN_CREDENTIAL_KEY))) {
    throw new NeedsActionError('You are not signed in. Run `quorum login` first.');
  }
  return client;
};

const oneOf = <T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  flag: string,
): T | undefined => {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new UsageError(`${flag} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
};

const login = async (args: string[], env: CliEnv): Promise<number> => {
  parseArgs({ args, options: {}, strict: true });
  const dataDir = dataDirOf(env);
  // A server started now writes a fresh code; one already running keeps its current code.
  await env.startServer?.(dataDir);
  const file = await readBootstrapCode(dataDir);
  if (!file) {
    throw new NeedsActionError(
      'There is no valid sign-in code. The local server writes a new one each time it starts and it ' +
        'lasts 10 minutes: restart the local server (`quorum stop`, then run any quorum command), then run `quorum login` again.',
    );
  }
  // The identity check runs first, so the code only ever goes to the server we pinned (INV-24).
  const client = await connect(env, HUMAN_CREDENTIAL_KEY);
  const human = await client.bootstrapLogin(file.code);
  env.out(`Signed in as ${human.address}. Credentials are in your OS keychain.\n`);
  return 0;
};

/** Is `child` the same folder as `parent` or inside it? (Case-insensitive on Windows.) */
const isInside = (child: string, parent: string): boolean => {
  const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rel = relative(fold(parent), fold(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

const attach = async (args: string[], env: CliEnv): Promise<number> => {
  const { values, positionals } = parseArgs({
    args,
    options: {
      workspace: { type: 'string' },
      vendor: { type: 'string' },
      wake: { type: 'string' },
      'wake-types': { type: 'string' },
      'lease-enforcement': { type: 'string' },
      name: { type: 'string' },
      'new-identity': { type: 'boolean', default: false },
      'no-config': { type: 'boolean', default: false },
      update: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });
  const wake = oneOf(values.wake, ['off', 'direct', 'all'] as const, '--wake');
  const lease = oneOf(
    values['lease-enforcement'],
    ['warn', 'block'] as const,
    '--lease-enforcement',
  );
  const wakeTypes = values['wake-types']
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => oneOf(s, MESSAGE_TYPES, '--wake-types') as (typeof MESSAGE_TYPES)[number]);

  if (values.update) {
    const change = {
      ...(wake ? { wake } : {}),
      ...(wakeTypes ? { wake_types: wakeTypes } : {}),
      ...(lease ? { lease_enforcement: lease } : {}),
    };
    if (Object.keys(change).length === 0) {
      throw new UsageError('Nothing to change: pass --wake, --wake-types or --lease-enforcement.');
    }
    const info = await loadAttachment(dataDirOf(env), values.update);
    const client = await humanClient(env);
    const updated = await client.updateAttachment(values.update, change);
    if (info) {
      await saveAttachment(dataDirOf(env), {
        ...info,
        wake: updated.wake,
        lease_enforcement: updated.lease_enforcement,
        ...(updated.wake_types ? { wake_types: updated.wake_types } : {}),
      });
    }
    env.out(
      `Updated ${values.update}: wake ${updated.wake}, lease enforcement ${updated.lease_enforcement}.\n`,
    );
    return 0;
  }

  const vendor = oneOf(values.vendor, VENDORS, '--vendor');
  if (!vendor) {
    throw new UsageError(
      `Pass --vendor ${VENDORS.join('|')} (automatic detection is not built yet).`,
    );
  }
  const dataDir = dataDirOf(env);
  const root = await realpath(resolve(env.cwd ?? process.cwd(), positionals[0] ?? '.')).catch(
    () => {
      throw new UsageError(`The folder ${positionals[0] ?? '.'} does not exist.`);
    },
  );
  // Compare canonical paths on both sides: the data folder may be spelled as a symlink, a junction
  // or a Windows 8.3 short name (RUNNER~1), and `root` was already canonicalised (INV-25). A data
  // folder that does not exist yet falls back to its absolute path.
  const canonicalDataDir = await realpath(dataDir).catch(() => resolve(dataDir));
  if (isInside(root, canonicalDataDir) || isInside(canonicalDataDir, root)) {
    throw new UsageError(
      'Refusing to attach the Quorum data directory (or a folder containing it).',
    );
  }

  const client = await humanClient(env);
  let workspace = values.workspace;
  if (!workspace) {
    const mine = await client.workspaces();
    if (mine.length !== 1 || !mine[0]) {
      throw new UsageError(
        mine.length === 0
          ? 'You have no workspace yet. Create one: quorum workspace create <name>'
          : `Pass --workspace <ws_id>; yours are: ${mine.map((w) => `${w.id} (${w.name})`).join(', ')}.`,
      );
    }
    workspace = mine[0].id;
  }

  const created = await client.createAttachment({
    root,
    vendor,
    workspaces: [workspace],
    ...(values.name ? { agent_name: values.name } : {}),
    ...(values['new-identity'] ? { new_identity: true } : {}),
    wake: wake ?? 'off', // non-interactive default (ARCHITECTURE §15.2); a prompt is not built yet
    ...(wakeTypes ? { wake_types: wakeTypes } : {}),
    lease_enforcement: lease ?? 'warn',
  });
  const id = created.attachment.id;
  // Credentials go to the keychain, never to a file or the project folder (INV-25).
  await env.store.save(id, {
    access_token: created.credentials.access_token,
    refresh_token: created.credentials.refresh_token,
    access_expires_at: Date.now() + created.credentials.expires_in * 1000,
  });
  await saveAttachment(dataDir, {
    attachment: id,
    agent: created.agent.address,
    workspaces: created.attachment.workspaces,
    vendor,
    root,
    wake: created.attachment.wake,
    ...(created.attachment.wake_types ? { wake_types: created.attachment.wake_types } : {}),
    lease_enforcement: created.attachment.lease_enforcement,
  });

  env.out(
    `Attached ${root} as ${created.agent.address} (${id}), wake ${created.attachment.wake}.\n\n`,
  );
  if (values['no-config']) {
    env.out(setupInstructions(vendor, id, root));
    return 0;
  }
  const command = await (env.quorumCommand ?? quorumCommand)();
  const config = await writeVendorConfig(vendor, root, id, command);
  env.out(describeChanges(config.changes));
  if (config.steps.length > 0) {
    env.out(`\nNext:\n${config.steps.map((step) => `- ${step}`).join('\n')}\n`);
  }
  env.out(`\nTo undo everything: quorum detach ${id}\n`);
  return 0;
};

/** One line per file written, kept or removed. */
const describeChanges = (changes: readonly ConfigChange[]): string =>
  changes.map((c) => `  ${c.action.padEnd(7)} ${c.file}${c.note ? ` (${c.note})` : ''}\n`).join('');

/** With --no-config: what to set up by hand. */
const setupInstructions = (vendor: string, id: string, root: string): string => {
  const undo = `To undo: quorum detach ${id}\n`;
  if (vendor === 'claude-code') {
    return (
      `Next, in ${root}:\n  claude mcp add --scope local quorum -- quorum mcp --attachment ${id}\n` +
      '(If `quorum` is not on your PATH yet, use `node <repo>/packages/cli/bin/quorum.js` instead.)\n' +
      `Hooks (mail while the agent works) were not written: run attach without --no-config.\n${undo}`
    );
  }
  if (vendor === 'codex') {
    return (
      `Next, create ${root}/.codex/config.toml (keep it out of git, e.g. via .git/info/exclude):\n` +
      `  [mcp_servers.quorum]\n  command = "quorum"\n  args = ["mcp", "--attachment", "${id}"]\n` +
      'Codex asks before each quorum tool call unless you change its approval settings.\n' +
      `Hooks were not written: run attach without --no-config.\n${undo}`
    );
  }
  return `Start the MCP server with: quorum mcp --attachment ${id}\n${undo}`;
};

const detach = async (args: string[], env: CliEnv): Promise<number> => {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true, strict: true });
  const id = need(positionals[0], 'Pass the attachment id: quorum detach <at_id>.');
  const info = await loadAttachment(dataDirOf(env), id);
  const client = await humanClient(env);
  await client.deleteAttachment(id);
  await env.store.remove(id);
  await removeAttachment(dataDirOf(env), id);
  env.out(`Detached ${id}. Its credentials were removed from the keychain.\n`);
  if (info) env.out(describeChanges(await removeVendorConfig(info.vendor, info.root, id)));
  return 0;
};

const mcp = async (args: string[], env: CliEnv): Promise<number> => {
  const { values } = parseArgs({ args, options: { attachment: { type: 'string' } }, strict: true });
  const info = await attachmentOf(env, values.attachment);
  const dataDir = dataDirOf(env);
  const client = await connect(env, info.attachment);
  // Tell the server which working tree this session is in, so it can warn when another agent is
  // in the same one (INV-28). Best effort: an unreachable server must not stop the agent.
  const session = await startSession({ client, root: info.root });
  const server = createQuorumMcpServer({
    client,
    outbox: new Outbox(dataDir, info.attachment),
    attachment: info,
    ...(session ? { session } : {}),
  });
  // Presence: a heartbeat every 30 s, and `offline` at once when the session ends (stdin closes
  // when Claude Code or Codex exits).
  const presence = startHeartbeat({ client, attachment: info });
  let closing: Promise<void> | undefined;
  const goodbye = () =>
    (closing ??= Promise.all([presence.stop(), session?.end()]).then(() => undefined));
  server.server.onclose = () => {
    void goodbye();
  };
  // When Claude Code or Codex exits normally our stdin closes: say offline and end the session
  // before leaving. (A hard kill skips this; the server then stops counting the session as live
  // after 90 s without heartbeats.)
  process.stdin.once('end', () => {
    void goodbye().finally(() => process.exit(0));
  });
  await serveStdio(server);
  return 0;
};

/**
 * `quorum hook <vendor> <event> --attachment <at_id>`: one Claude Code or Codex hook. Prints the
 * vendor's JSON (or nothing) and always exits 0, so a Quorum problem never blocks the agent.
 */
const hook = async (args: string[], env: CliEnv): Promise<number> => {
  const { values, positionals } = parseArgs({
    args,
    options: { attachment: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  });
  const [vendor, event] = positionals;
  if (!HOOK_VENDORS.includes(vendor as HookVendor) || !HOOK_EVENTS.includes(event as HookEvent)) {
    throw new UsageError(
      `Use: quorum hook <${HOOK_VENDORS.join('|')}> <${HOOK_EVENTS.join('|')}> --attachment <at_id>.`,
    );
  }
  const info = await attachmentOf(env, values.attachment);
  let input: unknown;
  try {
    input = JSON.parse((await env.stdin?.()) ?? '');
  } catch {
    input = undefined;
  }
  const result = await runHook({
    vendor: vendor as HookVendor,
    event: event as HookEvent,
    input,
    attachment: info,
    dataDir: dataDirOf(env),
    // Starting a server only makes sense when a session begins or the human asks something.
    connect: () =>
      connect(env, info.attachment, { autoStart: event === 'session-start' || event === 'prompt' }),
  });
  if (result.stdout) env.out(`${result.stdout}\n`);
  return 0;
};
