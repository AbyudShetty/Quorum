// The `quorum` command line (Track B). Phase 1 commands that work against any /v1 server:
// status, inbox, send, export, verify and mcp. `attach`, `detach`, `serve`, `stop`, `worktree`
// and `ui` follow once the server endpoints and the human login flow exist (see README).
//
// Everything is a function of (argv, env) so tests can run it against the fake server without
// spawning processes. Output that contains other participants' messages is always framed as
// untrusted data (INV-9), because a person may paste it to an agent.
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createIdFactory, parseJsonl, verifyChain } from '@quorum/core';
import type { SubmittedEnvelope } from '@quorum/schemas';
import {
  ApiError,
  type CredentialStore,
  Cursor,
  createQuorumMcpServer,
  defaultDataDir,
  frameMessages,
  IdentityError,
  loadAttachment,
  Outbox,
  QuorumClient,
  serveStdio,
  UnreachableError,
} from '@quorum/adapter-mcp';

export interface CliEnv {
  out: (text: string) => void;
  err: (text: string) => void;
  store: CredentialStore;
  dataDir?: string;
  fetch?: typeof fetch;
}

/** Keychain entry for the signed-in human (used by `export`). */
export const HUMAN_CREDENTIAL_KEY = 'human';

const HELP = `quorum: coordinate AI coding agents (Phase 1, work in progress)

Usage: quorum <command> [options]

  status [--attachment <at_id>]              Is the local server up, and is it really ours?
  inbox  --attachment <at_id> [--workspace <ws>] [--limit <n>] [--keep]
                                             Show new messages (framed as untrusted data)
  send   --attachment <at_id> --to <address> [--to ...] --text <text> [--workspace <ws>]
                                             Send a note as that agent
  export --workspace <ws>                    Print the workspace event log (JSON Lines); humans only
  verify <file.jsonl> --workspace <ws>       Check an exported log's hash chain
  mcp    --attachment <at_id>                Run the MCP server for an agent (used by Claude Code / Codex)
  help

Not yet available: attach, detach, serve, stop, worktree, ui.
`;

class UsageError extends Error {}

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
      default:
        throw new UsageError(`Unknown command "${command}". Run \`quorum help\`.`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      env.err(`${error.message}\n`);
      return 64;
    }
    if (error instanceof IdentityError) {
      env.err(`IDENTITY CHECK FAILED: ${error.message}\n`);
      return 2;
    }
    if (error instanceof UnreachableError) {
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

const connect = (env: CliEnv, credentialKey: string): Promise<QuorumClient> =>
  QuorumClient.connect({
    dataDir: dataDirOf(env),
    credentialKey,
    store: env.store,
    ...(env.fetch ? { fetch: env.fetch } : {}),
  });

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
  const client = await connect(env, values.attachment ?? HUMAN_CREDENTIAL_KEY);
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
  const cursor = new Cursor(dataDirOf(env), info.attachment);
  const page = await client.inbox(workspace, await cursor.get(workspace), limit);
  if (page.messages.length === 0) {
    env.out('No new messages.\n');
    return 0;
  }
  env.out(`${frameMessages(page.messages)}\n`);
  if (!values.keep) {
    await client.ack(workspace, page.next_after);
    await cursor.advance(workspace, page.next_after);
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

const mcp = async (args: string[], env: CliEnv): Promise<number> => {
  const { values } = parseArgs({ args, options: { attachment: { type: 'string' } }, strict: true });
  const info = await attachmentOf(env, values.attachment);
  const dataDir = dataDirOf(env);
  const server = createQuorumMcpServer({
    client: await connect(env, info.attachment),
    outbox: new Outbox(dataDir, info.attachment),
    cursor: new Cursor(dataDir, info.attachment),
    attachment: info,
  });
  await serveStdio(server);
  return 0;
};
