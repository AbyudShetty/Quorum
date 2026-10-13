// The `quorum` command line (Track B). Phase 1: serve, stop, login, workspace, attach, detach,
// status, inbox, send, export, verify, mcp, hook, worktree and ui.
// Commands that talk to the local server start it when it is not running (ARCHITECTURE §8.2).
//
// Everything is a function of (argv, env) so tests can run it against the fake server without
// spawning processes. Output that contains other participants' messages is always framed as
// untrusted data (INV-9), because a person may paste it to an agent.
import { appendFile, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  createIdFactory,
  formatServerLink,
  parseJsonl,
  parseServerLink,
  serverFingerprint,
  verifyChain,
} from '@quorum/core';
import {
  addGitWorktree,
  checkPublicUrl,
  checkRelayUrl,
  DEFAULT_RELAY,
  defaultDataDir,
  readRemoteConfig,
  type RemoteConfig,
  relayLinkUrl,
  removeRemoteConfig,
  writeRemoteConfig,
  GitWorktreeError,
  isProcessAlive,
  readBootstrapCode,
  readDiscovery,
  removeBootstrapCode,
  removeDiscovery,
} from '@quorum/local';
import {
  type AttachmentCreated,
  type QuorumIdCreated,
  MESSAGE_TYPES,
  type MessageType,
  type SubmittedEnvelope,
  type Vendor,
  VENDORS,
} from '@quorum/schemas';
import {
  ApiError,
  type AttachmentInfo,
  collectDeviceLogin,
  findGit,
  joinServer,
  listAttachments,
  loadRemoteServer,
  pinServer,
  quorumFetch,
  type RemoteServer,
  removeRemoteServer,
  saveRemoteServer,
  startDeviceLogin,
  targetOf,
  type CredentialStore,
  createPairingMcpServer,
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
  type Session,
  UnreachableError,
} from '@quorum/adapter-mcp';
import {
  commandOutput,
  HOOK_EVENT_NAMES,
  HOOK_EVENTS,
  HOOK_VENDORS,
  linkedAttachment,
  loadHookState,
  loadPairing,
  newRequests,
  pairingKey,
  parseQuorumCommand,
  requestNotice,
  runQuorumCommand,
  savePairing,
  withNotice,
  type CodexSessions,
  type HookEvent,
  type HookVendor,
  runHook,
  activeWindow,
  adoptWindow,
  forgetMcpWindow,
  isMailHeld,
  recordMcpWindow,
  startCodexWaker,
  trackWindow,
  watchForMail,
} from '@quorum/adapter-hooks';
import { openCodexDaemon } from '@quorum/codex-bridge';
import { liveServer, ServerStartError } from './local-server.js';
import {
  type ConfigChange,
  type QuorumCommand,
  quorumCommand,
  removeVendorConfig,
  writeVendorConfig,
} from './vendor-config.js';
import { removeUserConfig, writeUserConfig } from './user-config.js';

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
  /**
   * Ask the person at the terminal (INV-30: binding a folder to a workspace is confirmed by a human,
   * never done by an agent for itself). Resolves false when nobody can answer; there is no flag to
   * skip it, since an agent could pass a flag.
   */
  confirm?: (question: string) => Promise<boolean>;
  /** Wait between device sign-in polls (tests make it instant). */
  sleep?: (ms: number) => Promise<void>;
  /** The hook payload a vendor writes to stdin (`quorum hook`). */
  stdin?: () => Promise<string>;
  /** How vendors start `quorum` (default: by name if on the PATH, else Node + this CLI). */
  quorumCommand?: () => Promise<QuorumCommand>;
  /** Connect to the local Codex daemon (default: through `codex app-server proxy`). Tests replace it. */
  openCodex?: () => Promise<CodexSessions>;
  /** The vendor process `quorum mcp` runs under (default: our parent). Tests replace it. */
  vendorPid?: number;
  /** How long `quorum mcp` waits for its window's session-start hook (default 4 s). */
  adoptTimeoutMs?: number;
  /** How long a pairing command may take before it answers that it gave up (default 40 s). */
  commandLimitMs?: number;
  /** Stop a verified local server process (default: SIGTERM). Tests replace it. */
  killServer?: (pid: number) => void;
  /** The person's home folder, where ~/.claude and ~/.codex live (tests). */
  home?: string;
}

/** Keychain entry for the signed-in human (used by `export`). */
export const HUMAN_CREDENTIAL_KEY = 'human';

const HELP = `quorum: coordinate AI coding agents (Phase 1, work in progress)

Usage: quorum <command> [options]

  serve --local [--idle-minutes <n>]         Run the local server in this terminal (commands also
                                             start it in the background when needed)
  stop                                       Stop the local server
  login                                      Sign in as the owner on this machine (local server)
  login <server link> | login approve <code> Sign in to a server on another machine (device code)
  invite [--workspace <ws>] [--wake <m>]     A one-time code that attaches a folder on another
                                             machine (turns on remote access through the relay)
  join "<invite>" [dir] --vendor <v>         Attach a folder here to a server on another machine
  workspace create <name> | workspace list   Create or list your workspaces
  attach [dir] --vendor <v> [--workspace <ws>] [--wake off|direct|all] [--name <n>] [--new-identity]
         [--no-config]                       Connect a folder to a workspace as an agent and write
                                             the vendor hooks and MCP config (kept out of git)
  attach --update <at_id> [--wake ...] [--wake-types a,b] [--lease-enforcement warn|block]
                                             Change an attachment's wake settings, and rewrite
                                             its vendor hooks and MCP config to this version
  detach <at_id>                             Disconnect an attachment and forget its credentials
  ui                                         A one-time link to the read-only web timeline
  remote enable [--relay wss://…] | disable | status
                                             Let other machines reach this server through the relay
  remote enable --public-url https://… [--port <n>]
                                             ... or through an HTTPS front end on this machine
                                             (tailscale serve, cloudflared)
  join-code [--workspace <ws>] [--wake <m>]  Like invite, when remote access is already on
  relay [--port <n>] [--host <h>]            Run your own relay in this terminal
  worktree [--attachment <at_id>] [--agent <name>]
                                             Give the agent its own git worktree (../<repo>-<agent>,
                                             branch quorum/<agent>) and move its attachment there
  status [--attachment <at_id>]              Is the local server up, and is it really ours?
  inbox  --attachment <at_id> [--workspace <ws>] [--limit <n>] [--keep]
                                             Show new messages (framed as untrusted data)
  send   --attachment <at_id> --to <address> [--to ...] --text <text> [--workspace <ws>]
                                             Send a note as that agent
  export [--workspace <ws>] [--out <file>]   The workspace event log (JSON Lines, UTF-8); humans only
  verify <file.jsonl> [--workspace <ws>]     Check an exported log's hash chain
  mcp    --attachment <at_id>                Run the MCP server for an agent (used by Claude Code / Codex)
  hook   <claude-code|codex> <session-start|prompt|post-tool|stop|session-end> --attachment <at_id>
                                             Run one vendor hook (reads its JSON on stdin; used by
                                             Claude Code / Codex, never fails the agent)
  help
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
      case 'worktree':
        return await worktree(rest, env);
      case 'ui':
        return await ui(rest, env);
      case 'remote':
        return await remote(rest, env);
      case 'join-code':
        return await joinCode(rest, env);
      case 'invite':
        return await joinCode(rest, env, true);
      case 'relay':
        return await relayCommand(rest, env);
      case 'setup':
        return await setup(rest, env);
      case 'uninstall':
        return await uninstall(rest, env);
      case 'join':
        return await joinCommand(rest, env);
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
        return await hookNeverFails(rest, env);
      default:
        throw new UsageError(`Unknown command "${command}". Run \`quorum help\`.`);
    }
  } catch (error) {
    // Unknown or malformed options (node:util parseArgs) are usage errors too, not crashes.
    const parseError = String((error as { code?: unknown }).code).startsWith('ERR_PARSE_ARGS_');
    if (error instanceof UsageError || parseError) {
      env.err(`${(error as Error).message}\n`);
      return 64;
    }
    if (error instanceof NeedsActionError || error instanceof GitWorktreeError) {
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
  // Phase 1b: an attachment made with `quorum join`, or a human signed in with `quorum login
  // <link>`, talks to the server on the other machine with the key pinned then (INV-24).
  const dataDir = dataDirOf(env);
  const remote =
    credentialKey === HUMAN_CREDENTIAL_KEY
      ? await loadRemoteServer(dataDir)
      : (await loadAttachment(dataDir, credentialKey))?.server;
  if (remote) {
    return QuorumClient.connect({
      target: targetOf(remote),
      dataDir,
      credentialKey,
      store: env.store,
      ...(env.fetch ? { fetch: env.fetch } : {}),
    });
  }
  if (options.autoStart ?? true) await env.startServer?.(dataDirOf(env));
  const startServer = env.startServer;
  return QuorumClient.connect({
    dataDir: dataDirOf(env),
    credentialKey,
    store: env.store,
    // A long-lived client (`quorum mcp`) finds a restarted server again by itself.
    ...(startServer && (options.autoStart ?? true)
      ? { ensureServer: () => startServer(dataDirOf(env)) }
      : {}),
    ...(env.fetch ? { fetch: env.fetch } : {}),
  });
};

/**
 * The attachment a command is about: the one named with --attachment, else the one attached to the
 * current folder or its nearest attached parent, like git (ARCHITECTURE §12).
 */
const attachmentOf = async (env: CliEnv, id: string | undefined) => {
  if (id === undefined) {
    const cwd = env.cwd ?? process.cwd();
    const here = await realpath(cwd).catch(() => resolve(cwd));
    const around = (await listAttachments(dataDirOf(env)))
      .filter((a) => isInside(here, a.root))
      .sort((a, b) => b.root.length - a.root.length);
    const nearest = around.filter((a) => a.root === around[0]?.root);
    if (nearest.length === 1 && nearest[0]) return nearest[0];
    throw new UsageError(
      nearest.length === 0
        ? 'This folder is not attached. Run it in an attached folder, or pass --attachment <at_id>.'
        : `Several agents are attached here: pass --attachment ${nearest.map((a) => `${a.attachment} (${a.vendor})`).join(' or ')}.`,
    );
  }
  const attachment = id;
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
  const local = client.baseUrl.startsWith('http://');
  env.out(
    `${local ? 'Local server' : 'Server on another machine'}: running, version ${health.version}, instance ${health.instance_id}\n` +
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

/** The workspace a human command is about: the one given, else the human's only one. */
const humanWorkspace = async (client: QuorumClient, given: string | undefined): Promise<string> => {
  if (given) return given;
  const mine = await client.workspaces();
  if (mine.length === 1 && mine[0]) return mine[0].id;
  throw new UsageError(
    mine.length === 0
      ? 'You have no workspace yet.'
      : `Pass --workspace <ws_id>; yours are: ${mine.map((w) => `${w.id} (${w.name})`).join(', ')}.`,
  );
};

const exportLog = async (args: string[], env: CliEnv): Promise<number> => {
  const { values } = parseArgs({
    args,
    options: { workspace: { type: 'string' }, out: { type: 'string' } },
    strict: true,
  });
  const client = await connect(env, HUMAN_CREDENTIAL_KEY);
  const workspace = await humanWorkspace(client, values.workspace);
  const log = await client.exportEvents(workspace);
  if (!values.out) {
    env.out(log);
    return 0;
  }
  // Written as UTF-8 by us: a shell redirect may re-encode it (Windows PowerShell 5.1 writes UTF-16).
  const file = resolve(env.cwd ?? process.cwd(), values.out);
  await writeFile(file, log, 'utf8');
  const events = log.split('\n').filter((line) => line.trim()).length;
  env.out(`Wrote ${String(events)} events of ${workspace} to ${file}.\n`);
  return 0;
};

/** A text file as written by us or re-encoded by a shell: UTF-8 (with or without BOM) or UTF-16. */
const readText = async (file: string): Promise<string> => {
  const bytes = await readFile(file);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  const text = bytes.toString('utf8');
  return text.startsWith('\uFEFF') ? text.slice(1) : text;
};

const verify = async (args: string[], env: CliEnv): Promise<number> => {
  const { values, positionals } = parseArgs({
    args,
    options: { workspace: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  });
  const named = need(
    positionals[0],
    'Pass the exported file: quorum verify <file.jsonl> [--workspace <ws_id>].',
  );
  const file = resolve(env.cwd ?? process.cwd(), named);
  const workspace =
    values.workspace ?? (await humanWorkspace(await connect(env, HUMAN_CREDENTIAL_KEY), undefined));
  const parsed = parseJsonl(await readText(file));
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

/** The loopback port remote access uses unless another is given (the front end forwards here). */
export const DEFAULT_REMOTE_PORT = 7420;

/** The relay Quorum runs for everyone (D-18); `--relay` or QUORUM_RELAY name another one. */
export const HOSTED_RELAY: string = DEFAULT_RELAY;

/** The relay to use: the flag, then QUORUM_RELAY, then the hosted one. */
const relayToUse = (flag: string | undefined): string => {
  const chosen = flag ?? process.env.QUORUM_RELAY ?? (HOSTED_RELAY || undefined);
  if (!chosen) {
    throw new UsageError(
      'There is no hosted Quorum relay yet. Pass --relay wss://<relay> (one you run with `quorum relay`), or use a front end: --public-url https://<this machine>.',
    );
  }
  const checked = checkRelayUrl(chosen);
  if ('problem' in checked) throw new UsageError(`The relay ${chosen} ${checked.problem}.`);
  return checked.url;
};

/** Where other machines reach this server under these settings. */
const linkUrlOf = (config: RemoteConfig, publicKey: string): string =>
  'relay' in config ? relayLinkUrl(config.relay, serverFingerprint(publicKey)) : config.public_url;

/**
 * Turn remote access on through the relay, after the person confirms at a terminal (INV-30): an
 * agent cannot open the server to other machines.
 */
const enableRelay = async (env: CliEnv, relay: string): Promise<void> => {
  await confirmBinding(
    env,
    `Let other machines reach this Quorum server through the relay at ${relay}? The server connects out to it; the relay passes on encrypted traffic it cannot read, and everything still needs a token.`,
  );
  await writeRemoteConfig(dataDirOf(env), { relay });
};

/** Apply a change: restart a running server (clients reconnect by themselves). */
const restartIfRunning = async (env: CliEnv): Promise<void> => {
  if ((await readDiscovery(dataDirOf(env))) === undefined) return;
  await stop([], env);
  await humanClient(env); // starts it again with the new settings
};

/**
 * `quorum remote enable [--relay wss://…]`, `remote enable --public-url https://… [--port <n>]`,
 * `remote disable`, `remote status` (Phase 1b, ARCHITECTURE §8.3, §8.4). Lets other machines reach
 * this server: by default through the relay (the server connects out; TLS runs end to end to this
 * server's own key), or through an HTTPS front end on this machine (`tailscale serve`, or
 * `cloudflared` for Cloudflare Tunnel). The server itself keeps listening on loopback only
 * (INV-22); every request still needs a token (INV-23). Enabling is confirmed at a terminal, like
 * attaching.
 */
const remote = async (args: string[], env: CliEnv): Promise<number> => {
  const { values, positionals } = parseArgs({
    args,
    options: {
      relay: { type: 'string' },
      'public-url': { type: 'string' },
      port: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });
  const dataDir = dataDirOf(env);
  const action = positionals[0] ?? 'status';
  const current = await readRemoteConfig(dataDir);

  /** The link other machines use: their address for this server and its key fingerprint (INV-24). */
  const serverLink = async (config: RemoteConfig): Promise<string> => {
    await env.startServer?.(dataDir);
    const found = await readDiscovery(dataDir);
    return found
      ? `\nServer link (for \`quorum login <link>\` on another machine):\n\n  ${formatServerLink({ url: linkUrlOf(config, found.public_key), fingerprint: serverFingerprint(found.public_key) })}\n` +
          '\nTo attach a folder on another machine, run `quorum invite` here.\n'
      : '\nStart the server (any quorum command) to see its link.\n';
  };

  if (action === 'status') {
    if (!current) {
      env.out('Remote access is off: only this machine can reach the server.\n');
    } else if ('relay' in current) {
      env.out(
        `Remote access is on through the relay ${current.relay}.\n${await serverLink(current)}`,
      );
    } else {
      env.out(
        `Remote access is on: ${current.public_url} → http://127.0.0.1:${String(current.port)}.\n${await serverLink(current)}`,
      );
    }
    return 0;
  }
  if (action === 'disable') {
    await removeRemoteConfig(dataDir);
    await restartIfRunning(env);
    env.out(
      current && 'public_url' in current
        ? 'Remote access is off. Also stop the front end: `tailscale serve reset`, or stop cloudflared.\n'
        : 'Remote access is off: only this machine can reach the server.\n',
    );
    return 0;
  }
  if (action !== 'enable') {
    throw new UsageError(
      'Use: quorum remote enable [--relay wss://…] | enable --public-url https://… | disable | status',
    );
  }
  if (values['public-url'] === undefined) {
    if (values.port !== undefined) throw new UsageError('--port goes with --public-url.');
    const relay = relayToUse(values.relay);
    await enableRelay(env, relay);
    await restartIfRunning(env);
    env.out(
      `Remote access is on through the relay ${relay}.\n` +
        'The server stays on while remote access is on (no idle shutdown). After a reboot, start it with any quorum command.\n',
    );
    env.out(await serverLink({ relay }));
    return 0;
  }
  if (values.relay !== undefined) throw new UsageError('Pass either --relay or --public-url.');
  const checked = checkPublicUrl(values['public-url']);
  if ('problem' in checked) throw new UsageError(`--public-url ${checked.problem}.`);
  const port = values.port === undefined ? DEFAULT_REMOTE_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new UsageError('--port must be a number from 1024 to 65535.');
  }
  await confirmBinding(
    env,
    `Let other machines reach this Quorum server through ${checked.url}? It listens on 127.0.0.1:${String(port)}; everything still needs a token.`,
  );
  await writeRemoteConfig(dataDir, { public_url: checked.url, port });
  await restartIfRunning(env);
  env.out(
    `Remote access is on: ${checked.url} → http://127.0.0.1:${String(port)}.\n\n` +
      'Now let the front end forward to it (one of these, on this machine):\n' +
      `  Tailscale:          tailscale serve --bg ${String(port)}\n` +
      `  Cloudflare Tunnel:  cloudflared tunnel --url http://127.0.0.1:${String(port)}\n\n` +
      'The server stays on while remote access is on (no idle shutdown). After a reboot, start it with any quorum command.\n',
  );
  env.out(await serverLink({ public_url: checked.url, port }));
  return 0;
};

/**
 * `quorum relay [--port <n>] [--host <h>] [--trust-proxy]`: run a relay in this terminal, for
 * people who want their own instead of the hosted one (DECISIONS D-18). It stores nothing and
 * cannot read what it passes on. Offer it to other machines behind HTTPS (wss://), e.g. a reverse
 * proxy or tunnel you run.
 */
const relayCommand = async (args: string[], env: CliEnv): Promise<number> => {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      'trust-proxy': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const port = values.port === undefined ? 7430 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UsageError('--port must be a number from 0 to 65535.');
  }
  const { startRelay } = await import('@quorum/relay');
  const relay = await startRelay({
    port,
    ...(values.host ? { host: values.host } : {}),
    trustProxy: values['trust-proxy'],
    // The phone book (Quorum ID → laptop, D-20) outlives restarts: IDs are permanent.
    phonebookFile: join(dataDirOf(env), 'relay', 'phonebook.json'),
  });
  env.out(
    `Quorum relay on ${relay.url}. It keeps only its phone book of Quorum IDs and cannot read what it passes on.\n` +
      'Other machines need it over HTTPS: put it behind a reverse proxy or tunnel that gives wss://<host>, then on the home machine:\n\n' +
      '  quorum remote enable --relay wss://<host>\n\nStop it with Ctrl+C.\n',
  );
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await relay.close();
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

/** This computer's name as an address part (`DESKTOP-AB12` → `desktop-ab12`), like the server's. */
const machineName = (): string =>
  hostname()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, 32)
    .replace(/-+$/, '') || 'machine';

const login = async (args: string[], env: CliEnv): Promise<number> => {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true, strict: true });
  if (positionals[0] === 'approve') return loginApprove(positionals[1], env);
  if (positionals[0] !== undefined) return loginRemote(positionals[0], env);
  const dataDir = dataDirOf(env);
  // Signing in here makes this machine's server the one the human uses again.
  await removeRemoteServer(dataDir);
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

/**
 * `quorum login <server link>` (Phase 1b): sign in on this machine as a human of a server on
 * another machine. The server's key is checked against the link first (INV-24); then this machine
 * shows a code that the person approves where they are already signed in.
 */
const loginRemote = async (text: string, env: CliEnv): Promise<number> => {
  const link = parseServerLink(text);
  if (!link) {
    throw new UsageError(
      'That is not a server link. On the server machine, run `quorum remote status` and copy the link it prints (https://…#k=…).',
    );
  }
  const server = await pinServer(link, env.fetch ?? quorumFetch);
  const started = await startDeviceLogin(server, machineName(), env.fetch ?? quorumFetch);
  env.out(
    `Server checked: ${server.url} holds the key in the link.\n\n` +
      'To finish, on a machine where you are already signed in to it (e.g. the server machine), run:\n\n' +
      `  quorum login approve ${started.user_code}\n\n` +
      `Waiting (up to ${String(Math.round(started.expires_in / 60))} minutes)…\n`,
  );
  const sleep = env.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const deadline = Date.now() + started.expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(started.interval * 1000);
    const result = await collectDeviceLogin(server, started.device_code, env.fetch ?? quorumFetch);
    if (result === 'pending') continue;
    await env.store.save(HUMAN_CREDENTIAL_KEY, {
      access_token: result.credentials.access_token,
      refresh_token: result.credentials.refresh_token,
      access_expires_at: Date.now() + result.credentials.expires_in * 1000,
    });
    await saveRemoteServer(dataDirOf(env), server);
    env.out(
      `Signed in to ${server.url} as ${result.human.address}. Credentials are in your OS keychain.\n` +
        'Human commands on this machine (join-code, ui, export…) now use that server; `quorum login` alone switches back to this machine.\n',
    );
    return 0;
  }
  throw new NeedsActionError('The sign-in expired before it was approved. Run the command again.');
};

/** `quorum login approve <code>`: let a waiting machine sign in as you (confirmed at a terminal). */
const loginApprove = async (code: string | undefined, env: CliEnv): Promise<number> => {
  const userCode = need(
    code,
    'Pass the code the other machine shows: quorum login approve ABCD-2345.',
  )
    .trim()
    .toUpperCase();
  const client = await humanClient(env);
  await confirmBinding(
    env,
    `Sign in the machine waiting with code ${userCode} as you? Only approve a code you started yourself, on a machine you trust.`,
  );
  const approved = (await client.call('POST', '/v1/auth/device/approve', { user_code: userCode }))
    .body as { machine: string };
  env.out(`Approved: ${approved.machine} is now signed in as you.\n`);
  return 0;
};

/**
 * `quorum invite [--workspace <ws>] [--wake off|direct|all] [--relay wss://…]` (D-18), and the
 * older `quorum join-code`: a single-use code (10 minutes) that attaches a folder on another machine
 * as an agent of yours. `invite` also turns remote access on through the relay when it is off
 * (confirmed at a terminal, INV-30); `join-code` needs it on already.
 */
const joinCode = async (args: string[], env: CliEnv, asInvite = false): Promise<number> => {
  const { values } = parseArgs({
    args,
    options: {
      workspace: { type: 'string' },
      wake: { type: 'string' },
      relay: { type: 'string' },
    },
    strict: true,
  });
  if (!asInvite && values.relay !== undefined) {
    throw new UsageError('--relay goes with `quorum invite` or `quorum remote enable`.');
  }
  const wake = oneOf(values.wake, ['off', 'direct', 'all'] as const, '--wake');
  if (asInvite && !(await readRemoteConfig(dataDirOf(env)))) {
    const relay = relayToUse(values.relay);
    await enableRelay(env, relay);
    await restartIfRunning(env);
    env.out(`Remote access is on through the relay ${relay}.\n\n`);
  }
  const client = await humanClient(env);
  const workspace = await humanWorkspace(client, values.workspace);
  const created = (
    await client.call('POST', '/v1/join-codes', {
      workspaces: [workspace],
      ...(wake ? { wake } : {}),
    })
  ).body as { link: string; expires_in: number };
  const minutes = String(Math.round(created.expires_in / 60));
  env.out(
    asInvite
      ? `Invite to workspace ${workspace} (works once, for ${minutes} minutes). On the other machine, in the folder to attach, run:\n\n` +
          `  quorum join "${created.link}" --vendor <claude-code|codex>\n`
      : `Join code for workspace ${workspace} (works once, for ${minutes} minutes):\n\n` +
          `  ${created.link}\n\n` +
          'On the other machine, in the folder to attach, run:\n\n' +
          `  quorum join "${created.link}" --vendor <claude-code|codex>\n`,
  );
  return 0;
};

/** The canonical folder to attach, refusing the Quorum data directory (INV-25). */
const folderToAttach = async (env: CliEnv, given: string | undefined): Promise<string> => {
  const root = await realpath(resolve(env.cwd ?? process.cwd(), given ?? '.')).catch(() => {
    throw new UsageError(`The folder ${given ?? '.'} does not exist.`);
  });
  const dataDir = dataDirOf(env);
  // Compare canonical paths on both sides: the data folder may be spelled as a symlink, a junction
  // or a Windows 8.3 short name (RUNNER~1). A data folder that does not exist yet falls back to
  // its absolute path.
  const canonicalDataDir = await realpath(dataDir).catch(() => resolve(dataDir));
  if (isInside(root, canonicalDataDir) || isInside(canonicalDataDir, root)) {
    throw new UsageError(
      'Refusing to attach the Quorum data directory (or a folder containing it).',
    );
  }
  return root;
};

/**
 * `quorum join <join code> [dir] --vendor <v> [--name <n>] [--new-identity] [--no-config]`
 * (Phase 1b): attach a folder on this machine to a server on another machine. The server's key is
 * checked against the code before the code is sent (INV-24); the person confirms at a terminal
 * (INV-30). The attachment remembers the server, so hooks and tools connect there.
 */
const joinCommand = async (args: string[], env: CliEnv): Promise<number> => {
  const { values, positionals } = parseArgs({
    args,
    options: {
      vendor: { type: 'string' },
      name: { type: 'string' },
      'new-identity': { type: 'boolean', default: false },
      'no-config': { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const link = parseServerLink(
    need(positionals[0], 'Pass the join code: quorum join "<code>" --vendor <v>.'),
  );
  if (!link?.secret) {
    throw new UsageError(
      'That is not an invite. On the home machine, run `quorum invite` and copy the whole line it prints.',
    );
  }
  const vendor = oneOf(values.vendor, VENDORS, '--vendor');
  if (!vendor) throw new UsageError(`Pass --vendor ${VENDORS.join('|')}.`);
  const root = await folderToAttach(env, positionals[1]);
  await confirmBinding(
    env,
    `Attach ${root} as a ${vendor} agent to the Quorum server at ${link.url}? Agents working in this folder will read and send messages there.`,
  );
  const { server, created } = await joinServer(
    link,
    {
      root,
      vendor,
      machine: machineName(),
      ...(values.name ? { agent_name: values.name } : {}),
      ...(values['new-identity'] ? { new_identity: true } : {}),
    },
    env.fetch ?? quorumFetch,
  );
  await recordAttachment(env, created, { root, vendor, server, noConfig: values['no-config'] });
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
    const info = await loadAttachment(dataDirOf(env), values.update);
    if (Object.keys(change).length === 0 && !info) {
      throw new UsageError(
        `Unknown attachment ${values.update} on this machine. Run \`quorum attach\` in its folder.`,
      );
    }
    if (Object.keys(change).length > 0) {
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
    }
    // Bring the folder's hooks and MCP config up to this version of Quorum.
    if (info && !values['no-config']) {
      const command = await (env.quorumCommand ?? quorumCommand)();
      const config = await writeVendorConfig(
        info.vendor,
        info.root,
        values.update,
        command,
        dataDirOf(env),
      );
      env.out(describeChanges(config.changes));
    }
    return 0;
  }

  const vendor = oneOf(values.vendor, VENDORS, '--vendor');
  if (!vendor) {
    throw new UsageError(
      `Pass --vendor ${VENDORS.join('|')} (automatic detection is not built yet).`,
    );
  }
  const root = await folderToAttach(env, positionals[0]);

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

  await attachFolder(env, client, {
    root,
    vendor,
    workspaces: [workspace],
    ...(values.name ? { name: values.name } : {}),
    ...(values['new-identity'] ? { newIdentity: true } : {}),
    wake: wake ?? 'off', // non-interactive default (ARCHITECTURE §15.2); a prompt is not built yet
    ...(wakeTypes ? { wakeTypes } : {}),
    lease: lease ?? 'warn',
    noConfig: values['no-config'],
  });
  return 0;
};

interface AttachFolder {
  root: string;
  vendor: Vendor;
  workspaces: string[];
  name?: string;
  newIdentity?: boolean;
  wake: 'off' | 'direct' | 'all';
  wakeTypes?: MessageType[];
  lease: 'warn' | 'block';
  noConfig?: boolean;
  /** The person already confirmed (`quorum worktree` asks once, before git runs). */
  confirmed?: boolean;
}

/** Ask before binding a folder to a workspace; refuse when nobody at a terminal says yes. */
const confirmBinding = async (env: CliEnv, question: string): Promise<void> => {
  if (await (env.confirm ?? (() => Promise.resolve(false)))(question)) return;
  throw new UsageError(
    'Not confirmed. Attaching a folder must be confirmed by you in a terminal (INV-30): an agent cannot attach folders for itself. Run the command yourself and answer y.',
  );
};

/**
 * Create the attachment, keep its credentials in the keychain (never in a file or the project
 * folder, INV-25), record it, and write the vendor hooks and MCP config (kept out of git).
 */
const attachFolder = async (
  env: CliEnv,
  client: QuorumClient,
  folder: AttachFolder,
): Promise<{ id: string; agent: string }> => {
  const { root, vendor } = folder;
  if (!folder.confirmed) {
    await confirmBinding(
      env,
      `Attach ${root} as a ${vendor} agent${folder.name ? ` (${folder.name})` : ''} to workspace ${folder.workspaces.join(', ')}? Agents working in this folder will read and send messages there.`,
    );
  }
  const created = await client.createAttachment({
    root,
    vendor,
    workspaces: folder.workspaces,
    ...(folder.name ? { agent_name: folder.name } : {}),
    ...(folder.newIdentity ? { new_identity: true } : {}),
    wake: folder.wake,
    ...(folder.wakeTypes ? { wake_types: folder.wakeTypes } : {}),
    lease_enforcement: folder.lease,
  });
  return recordAttachment(env, created, {
    root,
    vendor,
    ...(folder.noConfig ? { noConfig: true } : {}),
  });
};

/**
 * Keep a new attachment's credentials in the keychain (never in a file or the project folder,
 * INV-25), record it (with its server when it is on another machine), and write the vendor hooks
 * and MCP config (kept out of git).
 */
const recordAttachment = async (
  env: CliEnv,
  created: AttachmentCreated,
  folder: { root: string; vendor: string; server?: RemoteServer; noConfig?: boolean },
): Promise<{ id: string; agent: string }> => {
  const { root, vendor } = folder;
  const id = created.attachment.id;
  await env.store.save(id, {
    access_token: created.credentials.access_token,
    refresh_token: created.credentials.refresh_token,
    access_expires_at: Date.now() + created.credentials.expires_in * 1000,
  });
  await saveAttachment(dataDirOf(env), {
    attachment: id,
    agent: created.agent.address,
    workspaces: created.attachment.workspaces,
    vendor,
    root,
    wake: created.attachment.wake,
    ...(created.attachment.wake_types ? { wake_types: created.attachment.wake_types } : {}),
    lease_enforcement: created.attachment.lease_enforcement,
    ...(folder.server ? { server: folder.server } : {}),
  });

  env.out(
    `Attached ${root} as ${created.agent.address} (${id}), wake ${created.attachment.wake}${folder.server ? `, on ${folder.server.url}` : ''}.\n\n`,
  );
  if (folder.noConfig) {
    env.out(setupInstructions(vendor, id, root));
    return { id, agent: created.agent.address };
  }
  const command = await (env.quorumCommand ?? quorumCommand)();
  const config = await writeVendorConfig(vendor, root, id, command, dataDirOf(env));
  env.out(describeChanges(config.changes));
  if (config.steps.length > 0) {
    env.out(`\nNext:\n${config.steps.map((step) => `- ${step}`).join('\n')}\n`);
  }
  env.out(`\nTo undo everything: quorum detach ${id}\n`);
  return { id, agent: created.agent.address };
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
  await detachFolder(env, await humanClient(env), id);
  return 0;
};

/** Detach: the server retires the agent, the keychain and the folder's config forget it. */
const detachFolder = async (env: CliEnv, client: QuorumClient, id: string): Promise<void> => {
  const info = await loadAttachment(dataDirOf(env), id);
  await client.deleteAttachment(id);
  await env.store.remove(id);
  await removeAttachment(dataDirOf(env), id);
  env.out(`Detached ${id}. Its credentials were removed from the keychain.\n`);
  if (info)
    env.out(describeChanges(await removeVendorConfig(info.vendor, info.root, id, dataDirOf(env))));
};

/**
 * `quorum ui` (ARCHITECTURE §6, §7): a one-time login link to the read-only web timeline, served
 * by the local server at `http://localhost:<port>` (localhost, not 127.0.0.1: a secure context, so
 * the session cookie can be Secure). Single use, 60 s; the CLI never opens a browser itself
 * (INV-10), it prints the link.
 */
const ui = async (args: string[], env: CliEnv): Promise<number> => {
  parseArgs({ args, options: {}, strict: true });
  const client = await humanClient(env);
  const link = await client.createUiLink();
  const origin = new URL(client.baseUrl);
  origin.hostname = 'localhost';
  env.out(
    `Open this link in your browser within ${String(link.expires_in)} seconds (it works once):\n\n` +
      `  ${origin.origin}${link.path}\n\n` +
      'The timeline is read-only and refreshes by itself. For a new link, run `quorum ui` again.\n',
  );
  return 0;
};

/**
 * `quorum worktree [--attachment <at_id>] [--agent <name>]` (ARCHITECTURE §13): give an agent its
 * own git working tree next to the repository, `../<repo>-<agent>` on branch `quorum/<agent>`,
 * and move its attachment there. The agent keeps its name, inbox and history: the old folder is
 * detached (its agent retired) and the new one attached under the same name (D-12).
 */
const worktree = async (args: string[], env: CliEnv): Promise<number> => {
  const { values } = parseArgs({
    args,
    options: { attachment: { type: 'string' }, agent: { type: 'string' } },
    strict: true,
  });
  const info = await attachmentOf(env, values.attachment);
  const git = await findGit(info.root);
  if (!git) throw new UsageError(`${info.root} is not in a git repository.`);
  const name = /^agent:([^@]+)@/.exec(info.agent)?.[1] ?? '';
  const agent = values.agent ?? name;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(agent)) {
    throw new UsageError('--agent: lowercase letters, digits and dashes (up to 64).');
  }
  const repo = git.worktree_root;
  const dir = join(dirname(repo), `${basename(repo)}-${agent}`);
  if (
    await stat(dir).then(
      () => true,
      () => false,
    )
  ) {
    throw new UsageError(`${dir} already exists. Pass --agent <another name>, or remove it.`);
  }
  await confirmBinding(
    env,
    `Create ${dir} (branch quorum/${agent}) and move agent ${info.agent} there? ${info.root} will be detached and the new folder attached to workspace ${info.workspaces.join(', ')}.`,
  );
  await addGitWorktree({ repo, dir, branch: `quorum/${agent}` });
  env.out(`Created ${dir} on branch quorum/${agent}.\n`);
  // The attachment may be a subfolder of the repository: the same subfolder in the new tree.
  const root = join(dir, relative(repo, info.root));
  await mkdir(root, { recursive: true });
  const client = await humanClient(env);
  await detachFolder(env, client, info.attachment);
  try {
    await attachFolder(env, client, {
      root,
      vendor: info.vendor as Vendor,
      workspaces: info.workspaces,
      name,
      wake: info.wake,
      ...(info.wake_types ? { wakeTypes: info.wake_types as MessageType[] } : {}),
      lease: info.lease_enforcement,
      confirmed: true,
    });
  } catch (error) {
    env.err(
      `The old folder was detached but attaching ${root} failed. To go back: quorum attach ${info.root} --vendor ${info.vendor} --name ${name}\n`,
    );
    throw error;
  }
  env.out(`\nStart the agent in ${root} from now on; ${info.root} is no longer attached.\n`);
  return 0;
};

/**
 * Which window `quorum mcp` speaks for (MESSAGE_SPEC §1.1), and how it follows changes.
 *
 * Claude Code starts one MCP server per window: adopt the session that window's hooks registered
 * (same vendor process). Without one yet (hooks off, or slow), register our own, which also tells
 * the server our working tree (INV-28), and record it so the window's hook takes it over. Then
 * follow the window: `/clear` ends one session and starts the next in the same process.
 *
 * Codex runs its MCP servers inside its shared daemon: one `quorum mcp` serves every Codex window
 * in the folder, and no process links it to one. It registers nothing (the windows' hooks do) and
 * speaks, for each tool call, as the window that was active last (its prompt or tool hooks just
 * ran); the Codex waker serves all the windows.
 */
const mcpWindow = async (
  env: CliEnv,
  client: QuorumClient,
  info: AttachmentInfo,
  dataDir: string,
): Promise<{
  label: () => string | undefined;
  beforeTool?: () => Promise<void>;
  session?: Session;
  stop: () => Promise<void>;
}> => {
  if (info.vendor === 'codex') {
    let label: string | undefined;
    return {
      label: () => label,
      beforeTool: async () => {
        const active = await activeWindow(dataDir, info.attachment).catch(() => undefined);
        client.session = active?.id;
        label = active?.label;
      },
      stop: () => Promise.resolve(),
    };
  }
  const vendorPid = env.vendorPid ?? process.ppid;
  const adopted = await adoptWindow(dataDir, info.attachment, {
    vendorPid,
    selfPid: process.pid,
    ...(env.adoptTimeoutMs === undefined ? {} : { timeoutMs: env.adoptTimeoutMs }),
  }).catch(() => undefined);
  const session = adopted ? undefined : await startSession({ client, root: info.root });
  const window =
    adopted ??
    (session?.id
      ? await recordMcpWindow(dataDir, info.attachment, {
          id: session.id,
          label: session.label ?? '',
          vendorPid,
          selfPid: process.pid,
        }).catch(() => undefined)
      : undefined);
  client.session = window?.id;
  const tracker = window
    ? trackWindow(dataDir, info.attachment, window, {
        vendorPid,
        selfPid: process.pid,
        onChange: (next) => {
          client.session = next.id;
        },
      })
    : undefined;
  return {
    label: () => tracker?.current().label ?? session?.label,
    ...(session ? { session } : {}),
    stop: async () => {
      tracker?.stop();
      await Promise.all([
        session?.end(),
        window
          ? forgetMcpWindow(dataDir, info.attachment, window.id).catch(() => undefined)
          : undefined,
      ]);
    },
  };
};

/**
 * `quorum mcp --vendor <v>` without `--attachment`: the tools in every session (D-20). Claude Code
 * runs one per window (its process is our parent); Codex runs one for all its windows, which speaks
 * for the window used last. A session that never joined gets told how to.
 */
const pairingMcp = async (vendor: HookVendor, env: CliEnv): Promise<number> => {
  const dataDir = dataDirOf(env);
  const vendorPid = env.vendorPid ?? process.ppid;
  const clients = new Map<string, QuorumClient>();
  const clientFor = async (attachment: string): Promise<QuorumClient> => {
    let client = clients.get(attachment);
    if (!client) clients.set(attachment, (client = await connect(env, attachment)));
    return client;
  };
  /** Paired sessions of this vendor with their windows, newest activity first. */
  const candidates = async () => {
    const sessions = await loadPairing(dataDir);
    const found: { attachment: string; window: string; vendorPid: number; activeAtMs: number }[] =
      [];
    for (const [key, session] of Object.entries(sessions)) {
      if (!key.startsWith(`${vendor}:`)) continue;
      const state = await loadHookState(dataDir, session.attachment);
      for (const [window, w] of Object.entries(state.windows ?? {})) {
        found.push({
          attachment: session.attachment,
          window,
          vendorPid: w.vendorPid,
          activeAtMs: w.activeAtMs ?? 0,
        });
      }
    }
    return found.sort((a, b) => b.activeAtMs - a.activeAtMs);
  };
  const targetOf = async (attachment: string, window: string) => {
    const saved = await loadAttachment(dataDir, attachment);
    if (!saved) return undefined;
    const client = await clientFor(attachment);
    client.session = window;
    return { client, attachment: linkedAttachment(saved, (await client.links()).links) };
  };
  const server = createPairingMcpServer({
    resolve: async () => {
      const all = await candidates();
      const mine = vendor === 'codex' ? all[0] : all.find((c) => c.vendorPid === vendorPid);
      return mine ? targetOf(mine.attachment, mine.window) : undefined;
    },
  });
  // Codex has no hook to wake an idle window: this shared process does, for each paired session.
  const wakers = new Map<string, { workspaces: string; stop: () => Promise<void> }>();
  const keepWakersCurrent = async () => {
    for (const { attachment, window } of await candidates()) {
      const target = await targetOf(attachment, window).catch(() => undefined);
      if (!target) continue;
      const workspaces = target.attachment.workspaces.join(',');
      const running = wakers.get(attachment);
      if (running?.workspaces === workspaces) continue;
      await running?.stop();
      const waker = await startCodexWaker({
        client: target.client,
        attachment: target.attachment,
        dataDir,
        openCodex: () => (env.openCodex ?? openCodexDaemon)(),
      }).catch(() => undefined);
      if (waker) wakers.set(attachment, { workspaces, stop: () => waker.stop() });
    }
  };
  const wakeTimer =
    vendor === 'codex' && process.env.QUORUM_CODEX_IDLE_WAKE !== 'off'
      ? setInterval(() => {
          void keepWakersCurrent().catch(() => undefined);
        }, 10_000)
      : undefined;
  wakeTimer?.unref();
  if (wakeTimer) void keepWakersCurrent().catch(() => undefined);
  const goodbye = async () => {
    if (wakeTimer) clearInterval(wakeTimer);
    await Promise.all([...wakers.values()].map((w) => w.stop()));
  };
  process.stdin.once('end', () => {
    void goodbye().finally(() => process.exit(0));
  });
  await serveStdio(server);
  return 0;
};

const mcp = async (args: string[], env: CliEnv): Promise<number> => {
  const { values } = parseArgs({
    args,
    options: { attachment: { type: 'string' }, vendor: { type: 'string' } },
    strict: true,
  });
  if (values.attachment === undefined) {
    const vendor = oneOf(values.vendor, HOOK_VENDORS, '--vendor') ?? 'claude-code';
    return pairingMcp(vendor, env);
  }
  const info = await attachmentOf(env, values.attachment);
  const dataDir = dataDirOf(env);
  const client = await connect(env, info.attachment);
  const window = await mcpWindow(env, client, info, dataDir);
  const server = createQuorumMcpServer({
    client,
    outbox: new Outbox(dataDir, info.attachment),
    attachment: info,
    ...(window.session ? { session: window.session } : {}),
    label: window.label,
    ...(window.beforeTool ? { beforeTool: window.beforeTool } : {}),
    mailHeld: async () =>
      (await isMailHeld(dataDir, info.attachment, client.session).catch(() => false))
        ? 'Your human has not said yes to reading the Quorum mail waiting for this session, so it stays unread. Ask them; they answer in the chat ("yes" or "show them").'
        : undefined,
  });
  // Presence: a heartbeat every 30 s, and `offline` at once when the session ends (stdin closes
  // when Claude Code or Codex exits).
  const presence = startHeartbeat({ client, attachment: info });
  // Codex: wake idle windows on mail the server allows (Codex has no hook for that; its shared
  // daemon does). Off switch: QUORUM_CODEX_IDLE_WAKE=off.
  const codexWaker =
    info.vendor === 'codex' && process.env.QUORUM_CODEX_IDLE_WAKE !== 'off'
      ? await startCodexWaker({
          client,
          attachment: info,
          dataDir,
          openCodex: () => (env.openCodex ?? openCodexDaemon)(),
        }).catch(() => undefined)
      : undefined;
  let closing: Promise<void> | undefined;
  const goodbye = () =>
    (closing ??= Promise.all([presence.stop(), window.stop(), codexWaker?.stop()]).then(
      () => undefined,
    ));
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
/**
 * A hook must never break the agent (ADAPTER_CONTRACT §6): whatever goes wrong, exit 0 with no
 * output, and note the error in `<data>/hooks/errors.log` so it can be found. Usage errors (a
 * wrong hook line in the vendor config) still exit 64, so a broken setup shows up.
 */
const hookNeverFails = async (args: string[], env: CliEnv): Promise<number> => {
  try {
    return await hook(args, env);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    const line = `${new Date().toISOString()} quorum hook ${args.slice(0, 2).join(' ')}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`;
    try {
      const dir = join(dataDirOf(env), 'hooks');
      await mkdir(dir, { recursive: true });
      await appendFile(join(dir, 'errors.log'), line);
    } catch {
      // Nowhere to write: still never fail the agent.
    }
    return 0;
  }
};

/**
 * The person's own client, signing in on this machine first when needed: a pairing command typed in
 * a session acts for the person who typed it (D-20), with the sign-in code from the private data
 * folder (INV-25), like `quorum login`.
 */
const ensureHuman = async (env: CliEnv): Promise<QuorumClient> => {
  const dataDir = dataDirOf(env);
  if (await loadRemoteServer(dataDir)) {
    // Pairing always uses this laptop's own server (D-20). A sign-in to another machine's server
    // left by `quorum login <link>` would send the commands there: drop it and its credentials.
    await removeRemoteServer(dataDir);
    await env.store.remove(HUMAN_CREDENTIAL_KEY);
  } else if (await env.store.load(HUMAN_CREDENTIAL_KEY)) {
    return humanClient(env);
  }
  await env.startServer?.(dataDir);
  const file = await readBootstrapCode(dataDir);
  if (!file)
    throw new NeedsActionError('Quorum could not sign you in on this machine: run `quorum login`.');
  const client = await connect(env, HUMAN_CREDENTIAL_KEY);
  await client.bootstrapLogin(file.code);
  return client;
};

/** Keep a newly paired session's credentials (keychain) and its attachment record. */
const savePairedSession = async (
  env: CliEnv,
  created: QuorumIdCreated,
  root: string,
  vendor: Vendor,
): Promise<void> => {
  if (!created.attachment || !created.credentials) return;
  const credentials = created.credentials;
  await env.store.save(created.attachment, {
    access_token: credentials.access_token,
    refresh_token: credentials.refresh_token,
    access_expires_at: Date.now() + credentials.expires_in * 1000,
  });
  await saveAttachment(dataDirOf(env), {
    attachment: created.attachment,
    agent: created.agent.address,
    workspaces: [],
    vendor,
    root,
    wake: 'direct',
    lease_enforcement: 'warn',
  });
};

/** Under the 60 s after which Claude Code and Codex give up on a hook, with room to exit. */
const COMMAND_LIMIT_MS = 40_000;

/** Kept small: when it passes this, it starts again (the previous one stays as commands.log.1). */
const COMMAND_LOG_MAX = 256 * 1024;

/**
 * The steps of a pairing command and how long each took, in `<data>/hooks/commands.log` (next to errors.log), so a command
 * that failed on someone's laptop can say where. Step names and errors only: never tokens or mail.
 */
const commandLog = (dataDir: string, what: string) => {
  const file = join(dataDir, 'hooks', 'commands.log');
  const started = Date.now();
  const lines: string[] = [];
  return {
    file,
    note: (text: string) => {
      lines.push(
        `${new Date().toISOString()} ${what} +${String(Date.now() - started)}ms ${text.replace(/\s+/g, ' ')}`,
      );
    },
    write: async () => {
      try {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        if (((await stat(file).catch(() => undefined))?.size ?? 0) > COMMAND_LOG_MAX) {
          await rm(`${file}.1`, { force: true });
          await writeFile(`${file}.1`, await readFile(file));
          await rm(file, { force: true });
        }
        await appendFile(file, `${lines.join('\n')}\n`);
      } catch {
        // The log is a help, never a reason for the command to fail.
      }
    },
  };
};

/**
 * `quorum hook <vendor> <event>` without `--attachment`: Quorum's user-level hooks, in every session
 * (D-20, PAIRING.md). A typed pairing command is done here and its prompt blocked; a session that
 * never ran one returns at once without contacting anything; a paired session gets its mail, wakes
 * and requests as before.
 */
const pairingHook = async (
  vendor: HookVendor,
  event: string,
  input: unknown,
  env: CliEnv,
): Promise<number> => {
  const dataDir = dataDirOf(env);
  if (event === 'command' || event === 'prompt') {
    const command = parseQuorumCommand(input);
    if (command) {
      const log = commandLog(dataDir, `${vendor} ${command.name}`);
      let step = 'start';
      const run = runQuorumCommand({
        vendor,
        command,
        input,
        dataDir,
        human: () => ensureHuman(env),
        saveSession: (created, root, v) => savePairedSession(env, created, root, v),
        agent: (attachment) => connect(env, attachment),
        ...(env.vendorPid === undefined ? {} : { vendorPid: env.vendorPid }),
        step: (name) => {
          step = name;
          log.note(name);
        },
      }).catch((error: unknown) => {
        log.note(`error: ${String(error)}`);
        if (error instanceof NeedsActionError || error instanceof ApiError) {
          return `Quorum: ${error.message}`;
        }
        return `Quorum: that did not work (${error instanceof Error ? error.message : String(error)}). Details are in ${log.file}.`;
      });
      // Vendors give up on a hook after 60 s and show only "hook timed out": stop well before.
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<string>((done) => {
        timer = setTimeout(() => {
          log.note(`gave up at ${step}`);
          done(
            `Quorum: that took too long and was stopped (at step "${step}"). Try again; if it keeps happening, send ${log.file}.`,
          );
        }, env.commandLimitMs ?? COMMAND_LIMIT_MS);
      });
      const text = await Promise.race([run, late]);
      clearTimeout(timer);
      log.note('done');
      await log.write();
      env.out(`${commandOutput(text)}\n`);
      return 0;
    }
  }
  if (event === 'command') return 0; // another command: not Quorum's
  const key = pairingKey(vendor, input);
  const sessions = key ? await loadPairing(dataDir) : {};
  const session = key ? sessions[key] : undefined;
  if (!key || !session) return 0; // not in Quorum: nothing to do, nothing contacted
  const saved = await loadAttachment(dataDir, session.attachment);
  if (!saved) return 0;
  if (event === 'watch') {
    // Claude Code's asyncRewake hook: exit 2 wakes the idle session with what we print.
    const client = await connect(env, session.attachment, { autoStart: false });
    const links = (await client.links()).links;
    const woke = await watchForMail({
      attachment: linkedAttachment(saved, links),
      dataDir,
      input,
      connect: () => Promise.resolve(client),
    });
    if (woke.output) env.err(`${woke.output}\n`);
    return woke.exitCode;
  }
  const client = await connect(env, session.attachment, {
    autoStart: event === 'session-start' || event === 'prompt',
  });
  const links = (await client.links()).links;
  const result = await runHook({
    vendor,
    event: event as HookEvent,
    input,
    attachment: linkedAttachment(saved, links),
    dataDir,
    connect: () => Promise.resolve(client),
    holdMail: false,
  });
  let stdout = result.stdout;
  if (event === 'session-start' || event === 'prompt') {
    // Requests waiting for this session: shown once per run (again after a resume).
    if (event === 'session-start') session.shown = [];
    const fresh = newRequests(session, links);
    if (fresh.length > 0) {
      stdout = withNotice(vendor, HOOK_EVENT_NAMES[event], stdout, requestNotice(vendor, fresh));
      session.shown = [...(session.shown ?? []), ...fresh.map((l) => l.id)];
    }
    await savePairing(dataDir, sessions);
  }
  if (stdout) env.out(`${stdout}\n`);
  return 0;
};

/** Where `quorum setup` notes that it ran (and with which installed copy of Quorum). */
const setupMarker = (dataDir: string): string => join(dataDir, 'setup.json');

/**
 * `quorum setup [--quiet]` (D-20, PAIRING.md §4): Quorum in every Claude Code and Codex session.
 * Run by `npm install -g` (and by the first `quorum` command when install scripts are off). It also
 * takes out the per-folder config of earlier `quorum attach` / `join` runs, which would otherwise
 * run alongside.
 */
const setup = async (args: string[], env: CliEnv): Promise<number> => {
  const { values } = parseArgs({
    args,
    options: { quiet: { type: 'boolean', default: false } },
    strict: true,
  });
  const dataDir = dataDirOf(env);
  const command = await (env.quorumCommand ?? quorumCommand)();
  const home = env.home ?? homedir();
  // Quietly (npm install's step): never fail the install; `quorum setup` shows what went wrong.
  const changes = await writeUserConfig({ home, command, dataDir }).catch((error: unknown) => {
    if (values.quiet) return undefined;
    throw error;
  });
  if (!changes) return 0;
  const earlier: string[] = [];
  for (const old of await listAttachments(dataDir)) {
    if (old.workspaces.length === 0 && !old.server) continue; // a paired session: no folder config
    const removed = await removeVendorConfig(old.vendor, old.root, old.attachment, dataDir);
    if (removed.length > 0) earlier.push(old.root);
  }
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    setupMarker(dataDir),
    `${JSON.stringify({ bin: command.bin, node: command.node, at: new Date().toISOString() })}\n`,
  );
  if (values.quiet) return 0;
  const skipped = changes.filter((c) => c.action === 'skipped');
  env.out(
    'Quorum is set up in Claude Code and Codex (all folders).\n\n' +
      'In any session, type /quorum-id in Claude Code (or $quorum-id in Codex) to get its ID; give it to the other person, who types /quorum-attach <ID> ($quorum-attach in Codex).\n\n' +
      'Restart sessions that are already open. Codex asks once to trust the new hooks: choose "Trust all and continue".\n' +
      (earlier.length
        ? `\nRemoved the older per-folder Quorum config from: ${earlier.join(', ')}.\n`
        : '') +
      (skipped.length
        ? `\nNot changed (fix by hand, then run \`quorum setup\` again): ${skipped.map((c) => `${c.file} (${c.note ?? ''})`).join('; ')}.\n`
        : ''),
  );
  return 0;
};

/**
 * Run `quorum setup` quietly when it never ran with this copy of Quorum (install scripts turned
 * off, or Quorum installed again elsewhere).
 */
export const ensureSetUp = async (env: CliEnv): Promise<void> => {
  const dataDir = dataDirOf(env);
  const command = await (env.quorumCommand ?? quorumCommand)();
  const marker = await readFile(setupMarker(dataDir), 'utf8').catch(() => '');
  if (marker.includes(JSON.stringify(command.bin))) return;
  await setup(['--quiet'], env).catch(() => undefined);
};

/**
 * `quorum uninstall`: take Quorum out of Claude Code and Codex again and stop the local server.
 * npm no longer runs anything on uninstall, so this comes first; the data folder (your sessions'
 * IDs and history) is kept.
 */
const uninstall = async (args: string[], env: CliEnv): Promise<number> => {
  parseArgs({ args, options: {}, strict: true });
  const dataDir = dataDirOf(env);
  const changes = await removeUserConfig({ home: env.home ?? homedir(), dataDir });
  await rm(setupMarker(dataDir), { force: true });
  await stop([], env).catch(() => 0);
  env.out(
    `Quorum is out of Claude Code and Codex (${String(changes.length)} settings changed). Restart open sessions.\n\n` +
      'To remove the program too:\n\n  npm uninstall -g @quorumhq/quorum\n\n' +
      `Your Quorum data (session IDs, history) stays in ${dataDir}; delete that folder to forget it.\n`,
  );
  return 0;
};

const hook = async (args: string[], env: CliEnv): Promise<number> => {
  const { values, positionals } = parseArgs({
    args,
    options: { attachment: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  });
  const [vendor, event] = positionals;
  const watch = vendor === 'claude-code' && event === 'watch';
  if (values.attachment === undefined && HOOK_VENDORS.includes(vendor as HookVendor)) {
    // Quorum's user-level hooks (D-20): every session, joined or not.
    const known = event === 'command' || watch || HOOK_EVENTS.includes(event as HookEvent);
    if (!known)
      throw new UsageError(
        `Use: quorum hook <${HOOK_VENDORS.join('|')}> <${HOOK_EVENTS.join('|')}|command|watch>.`,
      );
    let pairingInput: unknown;
    try {
      pairingInput = JSON.parse((await env.stdin?.()) ?? '');
    } catch {
      pairingInput = undefined;
    }
    return pairingHook(vendor as HookVendor, event ?? '', pairingInput, env);
  }
  if (
    !watch &&
    (!HOOK_VENDORS.includes(vendor as HookVendor) || !HOOK_EVENTS.includes(event as HookEvent))
  ) {
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
  if (watch) {
    // Claude Code's asyncRewake hook: exit 2 wakes the idle session with what we print.
    const woke = await watchForMail({
      attachment: info,
      dataDir: dataDirOf(env),
      input,
      connect: () => connect(env, info.attachment, { autoStart: false }),
    });
    if (woke.output) env.err(`${woke.output}\n`);
    return woke.exitCode;
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
