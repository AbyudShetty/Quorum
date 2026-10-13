// The pairing commands in Claude Code and Codex (DECISIONS D-20, PAIRING.md). Quorum's hooks are
// set up once for every session (user level); a session joins only when the person types a
// command in it:
//
//   /quorum-id               (Codex: $quorum-id)              this session joins; shows its ID
//   /quorum-attach <id>      (Codex: $quorum-attach <id>)     ask that session's person to link
//   /quorum-allow [id]       (Codex: $quorum-allow [id])      accept a waiting request (or all)
//   /quorum-detach [id]      (Codex: $quorum-detach [id])     unlink (one, or all); nobody is asked
//   /quorum-block <id>       (Codex: $quorum-block <id>)      unlink and block
//   /quorum-export           (Codex: $quorum-export)          write quorum-<tool><n>.md here
//
// The hook reads the command from what the person typed (Claude Code `UserPromptExpansion`, which
// fires only for commands a person types; Codex `UserPromptSubmit`, the raw prompt), does it, and
// blocks the prompt so the model never runs (no tokens) and never sees it. An agent cannot type a
// prompt, so it can never link, allow or detach by itself, whatever a message says (INV-34).
// Sessions that never ran a command are not in Quorum: their hooks return at once.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type AttachmentInfo, findGit, type QuorumClient } from '@quorum/adapter-mcp';
import { parseQuorumId } from '@quorum/core';
import { writePrivateFile } from '@quorum/local';
import type { LinkInfo, QuorumIdCreated, Vendor } from '@quorum/schemas';
import type { HookVendor } from './hooks.js';
import { loadHookState, saveHookState } from './state.js';

export const QUORUM_COMMANDS = ['id', 'attach', 'allow', 'detach', 'block', 'export'] as const;
export type QuorumCommandName = (typeof QUORUM_COMMANDS)[number];

export interface QuorumCommand {
  name: QuorumCommandName;
  /** What followed the command, trimmed. */
  args: string;
}

const field = (input: unknown, name: string): unknown =>
  typeof input === 'object' && input !== null
    ? (input as Record<string, unknown>)[name]
    : undefined;

/** The prefix people type in each vendor: `/quorum-id` in Claude Code, `$quorum-id` in Codex. */
export const commandText = (vendor: HookVendor, name: QuorumCommandName): string =>
  `${vendor === 'codex' ? '$' : '/'}quorum-${name}`;

/**
 * The command in what the person typed, if it is one. Claude Code: the `UserPromptExpansion` input
 * (`command_name`, `command_args`). Codex: a prompt that starts with `$quorum-…` (or `/quorum-…`).
 */
export const parseQuorumCommand = (input: unknown): QuorumCommand | undefined => {
  const name = field(input, 'command_name');
  if (typeof name === 'string') {
    const match = /^quorum-([a-z]+)$/.exec(name);
    const command = match?.[1] as QuorumCommandName | undefined;
    if (!command || !QUORUM_COMMANDS.includes(command)) return undefined;
    const args = field(input, 'command_args');
    return { name: command, args: typeof args === 'string' ? args.trim() : '' };
  }
  const prompt = field(input, 'prompt');
  if (typeof prompt !== 'string') return undefined;
  const match = /^\s*[$/]quorum-([a-z]+)\b[ \t]*([^\n]*)\s*$/i.exec(prompt);
  const command = match?.[1]?.toLowerCase() as QuorumCommandName | undefined;
  if (!command || !QUORUM_COMMANDS.includes(command)) return undefined;
  return { name: command, args: (match?.[2] ?? '').trim() };
};

// --- which sessions joined (<data>/hooks/pairing.json) ------------------------------------------

/** A session that ran a command: its Quorum ID and the attachment holding its credentials. */
export interface PairedSession {
  id: string;
  attachment: string;
  /** Request IDs already shown to the person (each is shown once per run of the session). */
  shown?: string[];
  /** When the idle session was woken for link requests (ms), for the hourly cap. */
  asked?: number[];
}

const pairingPath = (dataDir: string): string => join(dataDir, 'hooks', 'pairing.json');

export const sessionKey = (vendor: string, input: unknown): string | undefined => {
  const id = field(input, 'session_id');
  return typeof id === 'string' && id.length > 0 && id.length <= 256
    ? `${vendor}:${id}`
    : undefined;
};

export const loadPairing = async (dataDir: string): Promise<Record<string, PairedSession>> => {
  try {
    const parsed = JSON.parse(await readFile(pairingPath(dataDir), 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, PairedSession>)
      : {};
  } catch {
    return {};
  }
};

export const savePairing = async (
  dataDir: string,
  sessions: Record<string, PairedSession>,
): Promise<void> => {
  await mkdir(join(dataDir, 'hooks'), { recursive: true, mode: 0o700 });
  await writePrivateFile(pairingPath(dataDir), `${JSON.stringify(sessions)}\n`);
};

/** The paired session behind a hook's input, if this session joined Quorum. */
export const pairedSession = async (
  dataDir: string,
  vendor: string,
  input: unknown,
): Promise<PairedSession | undefined> => {
  const key = sessionKey(vendor, input);
  return key ? (await loadPairing(dataDir))[key] : undefined;
};

// --- running a command --------------------------------------------------------------------------

export interface CommandContext {
  vendor: HookVendor;
  command: QuorumCommand;
  input: unknown;
  dataDir: string;
  /** The person's own client (local sign-in happens here if needed). */
  human: () => Promise<Pick<QuorumClient, 'createQuorumId'>>;
  /** Keep a new session's credentials (keychain) and its attachment record (data folder). */
  saveSession: (created: QuorumIdCreated, root: string, vendor: Vendor) => Promise<void>;
  /** The session's own client. */
  agent: (
    attachment: string,
  ) => Promise<
    Pick<
      QuorumClient,
      | 'createSession'
      | 'links'
      | 'requestLink'
      | 'allowLinks'
      | 'detachLinks'
      | 'blockSession'
      | 'exportLinks'
    > & { session: string | undefined }
  >;
  /** The vendor process this hook belongs to. Default: our parent process. */
  vendorPid?: number;
  now?: () => number;
  /** Called as each step starts (`sign-in`, `create-id`, …), so a slow command can say where. */
  step?: (name: string) => void;
}

/** A link as people read it: `codex@laptop-b - ~\proj\web - 2 (QRM-…)`. */
export const linkLine = (link: LinkInfo): string => {
  if (link.tool === 'pending') return link.id;
  const number = /-(\d+)$/.exec(link.label)?.[1] ?? '';
  return `${link.tool}@${link.machine} - ${link.path} - ${number} (${link.id})`;
};

const describeLinks = (vendor: HookVendor, links: readonly LinkInfo[]): string[] => {
  const linked = links.filter((l) => l.state === 'linked');
  const asked = links.filter((l) => l.state === 'requested');
  const waiting = links.filter((l) => l.state === 'pending');
  return [
    ...(linked.length ? [`Linked with: ${linked.map(linkLine).join('; ')}.`] : []),
    ...(asked.length ? [`Waiting for an answer from: ${asked.map(linkLine).join('; ')}.`] : []),
    ...waiting.map(
      (l) =>
        `${linkLine(l)} wants to link with this session: ${commandText(vendor, 'allow')} ${l.id} to accept, ${commandText(vendor, 'block')} ${l.id} to block.`,
    ),
  ];
};

/** The export file for a session: quorum-claude2.md for claude@api-2. */
export const exportFileName = (label: string | undefined, vendor: HookVendor): string => {
  const tool = vendor === 'codex' ? 'codex' : 'claude';
  const number = /-(\d+)$/.exec(label ?? '')?.[1] ?? '1';
  return `quorum-${tool}${number}.md`;
};

/** Keep the export file out of git, like Quorum's other per-machine files. */
const excludeFromGit = async (root: string, name: string): Promise<void> => {
  const git = await findGit(root).catch(() => undefined);
  if (!git) return;
  const file = join(git.common_dir, 'info', 'exclude');
  const current = await readFile(file, 'utf8').catch(() => '');
  if (current.split(/\r?\n/).includes(`/${name}`)) return;
  await mkdir(join(git.common_dir, 'info'), { recursive: true });
  await writeFile(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}/${name}\n`);
};

const sessionId = (input: unknown): string => {
  const id = field(input, 'session_id');
  return typeof id === 'string' ? id : '';
};

const cwdOf = (input: unknown): string => {
  const cwd = field(input, 'cwd');
  return typeof cwd === 'string' && cwd ? cwd : process.cwd();
};

/**
 * Make sure this session has joined: its ID (created by the person's own client the first time),
 * its credentials saved, and its window registered (so it has a number like claude@api-2).
 */
const join_ = async (
  context: CommandContext,
): Promise<{ session: PairedSession; label: string | undefined; created: boolean }> => {
  const key = sessionKey(context.vendor, context.input);
  if (!key) throw new Error('The hook input has no session id.');
  const sessions = await loadPairing(context.dataDir);
  let session = sessions[key];
  let created = false;
  const root = cwdOf(context.input);
  const vendor: Vendor = context.vendor;
  if (!session) {
    context.step?.('sign-in');
    const human = await context.human();
    context.step?.('create-id');
    let made = await human.createQuorumId({
      vendor,
      vendor_session_id: sessionId(context.input),
      root,
    });
    if (!made.credentials) {
      // Known ID, but this machine lost its credentials: ask for fresh ones.
      made = await human.createQuorumId({
        vendor,
        vendor_session_id: sessionId(context.input),
        root,
        credentials: true,
      });
    }
    if (!made.attachment) throw new Error('The server gave no attachment for the new ID.');
    context.step?.('save-session');
    await context.saveSession(made, root, vendor);
    session = { id: made.id, attachment: made.attachment };
    sessions[key] = session;
    await savePairing(context.dataDir, sessions);
    created = made.created;
  }
  // Register (or find) this window, as the session-start hook would.
  const state = await loadHookState(context.dataDir, session.attachment);
  const vendorSession = sessionId(context.input);
  let window = state.sessions[vendorSession];
  let label = window ? state.windows?.[window]?.label : undefined;
  if (!window) {
    context.step?.('register-window');
    const client = await context.agent(session.attachment);
    const git = await findGit(root).catch(() => undefined);
    const registered = await client.createSession({
      vendor_session_id: vendorSession,
      root,
      ...(git ? { git } : {}),
    });
    window = registered.session_id;
    label = registered.label;
    state.sessions[vendorSession] = window;
    state.windows = {
      ...state.windows,
      [window]: {
        key: vendorSession,
        label: label ?? '',
        vendorPid: context.vendorPid ?? process.ppid,
        activeAtMs: (context.now ?? Date.now)(),
      },
    };
    await saveHookState(context.dataDir, session.attachment, state);
  }
  return { session, label, created };
};

/** Run a typed command; the text is shown to the person (the prompt itself is blocked). */
export const runQuorumCommand = async (context: CommandContext): Promise<string> => {
  const { vendor, command } = context;
  const say = (name: QuorumCommandName) => commandText(vendor, name);
  const notJoined = `This session is not in Quorum yet: type ${say('id')} first.`;

  if (command.name === 'id' || command.name === 'attach') {
    let target: string | undefined;
    if (command.name === 'attach') {
      target = parseQuorumId(command.args);
      if (!target) {
        return `Quorum: give the other session's ID, e.g. ${say('attach')} QRM-7KD2-PX9F-M3TA.`;
      }
    }
    const { session, label } = await join_(context);
    context.step?.(command.name === 'id' ? 'links' : 'request-link');
    const client = await context.agent(session.attachment);
    if (command.name === 'id') {
      const links = (await client.links()).links;
      return [
        `Quorum ID of this session${label ? ` (${label})` : ''}: ${session.id}`,
        `Give it to the other person; they type ${commandText('claude-code', 'attach')} ${session.id} in Claude Code, or ${commandText('codex', 'attach')} ${session.id} in Codex.`,
        ...describeLinks(vendor, links),
      ].join('\n');
    }
    if (target === session.id) return "Quorum: that is this session's own ID.";
    try {
      const outcome = await client.requestLink(target ?? '');
      return {
        requested: `Quorum: asked ${target ?? ''} to link with this session (${session.id}). You will see when their person allows it.`,
        queued: `Quorum: ${target ?? ''} is on a laptop that is not reachable right now; the request goes out when it is back.`,
        linked: `Quorum: linked with ${target ?? ''}. Your agent can now message it.`,
      }[outcome.state];
    } catch (error) {
      if ((error as { code?: string }).code === 'pairing.no_such_id') {
        return `Quorum: there is no session ${target ?? ''}. Check the ID with the person who gave it to you.`;
      }
      throw error;
    }
  }

  const session = await pairedSession(context.dataDir, vendor, context.input);
  if (!session) return `Quorum: ${notJoined}`;
  context.step?.(command.name);
  const client = await context.agent(session.attachment);

  if (command.name === 'allow') {
    const id = command.args ? parseQuorumId(command.args) : undefined;
    if (command.args && !id)
      return `Quorum: that is not an ID; type ${say('allow')} (all) or ${say('allow')} QRM-….`;
    try {
      const links = (await client.allowLinks(id)).links;
      return ['Quorum: allowed.', ...describeLinks(vendor, links)].join('\n');
    } catch (error) {
      if ((error as { code?: string }).code === 'pairing.no_request') {
        return 'Quorum: no session is waiting to link with this one.';
      }
      throw error;
    }
  }
  if (command.name === 'detach') {
    const id = command.args ? parseQuorumId(command.args) : undefined;
    if (command.args && !id)
      return `Quorum: that is not an ID; type ${say('detach')} (all) or ${say('detach')} QRM-….`;
    const detached = await client.detachLinks(id);
    return detached.length
      ? `Quorum: unlinked from ${detached.join(', ')}.`
      : 'Quorum: this session had no links.';
  }
  if (command.name === 'block') {
    const id = parseQuorumId(command.args);
    if (!id) return `Quorum: give the ID to block, e.g. ${say('block')} QRM-7KD2-PX9F-M3TA.`;
    await client.blockSession(id);
    return `Quorum: blocked ${id}. It is unlinked, and to it this session's ID now looks like one that does not exist.`;
  }
  // export
  const markdown = await client.exportLinks();
  const root = cwdOf(context.input);
  const state = await loadHookState(context.dataDir, session.attachment);
  const window = state.sessions[sessionId(context.input)];
  const name = exportFileName(window ? state.windows?.[window]?.label : undefined, vendor);
  await writeFile(join(root, name), markdown);
  await excludeFromGit(root, name).catch(() => undefined);
  return `Quorum: exported this session's conversations to ${join(root, name)} (kept out of git). Run ${say('export')} again to update it.`;
};

/** What the hook prints for a command: block the prompt, show the text. */
export const commandOutput = (text: string): string =>
  JSON.stringify({ decision: 'block', reason: text });

/** At most this many wakes for link requests per session per hour (a requester cannot burn tokens). */
export const REQUEST_WAKES_PER_HOUR = 5;

/**
 * The requests to wake the idle session `key` for now: new ones (not yet shown in this run), within
 * the hourly cap. They are marked shown, so the next prompt does not repeat them. Never when the
 * session's wake mode is off (INV-29).
 */
export const takeRequestWake = async (
  dataDir: string,
  key: string,
  links: readonly LinkInfo[],
  options: { wakeOff?: boolean; now?: number } = {},
): Promise<LinkInfo[]> => {
  if (options.wakeOff) return [];
  const sessions = await loadPairing(dataDir);
  const session = sessions[key];
  if (!session) return [];
  const fresh = newRequests(session, links);
  if (fresh.length === 0) return [];
  const now = options.now ?? Date.now();
  const recent = (session.asked ?? []).filter((at) => now - at < 3_600_000);
  if (recent.length >= REQUEST_WAKES_PER_HOUR) return []; // the next prompt still shows them
  session.asked = [...recent, now];
  session.shown = [...(session.shown ?? []), ...fresh.map((l) => l.id)];
  await savePairing(dataDir, sessions);
  return fresh;
};

/** Requests waiting for this session that the person has not been shown yet in this run. */
export const newRequests = (session: PairedSession, links: readonly LinkInfo[]): LinkInfo[] =>
  links.filter((l) => l.state === 'pending' && !session.shown?.includes(l.id));

/** The line that tells the person about a waiting request. */
export const requestNotice = (vendor: HookVendor, links: readonly LinkInfo[]): string =>
  links
    .map(
      (l) =>
        `Quorum: ${linkLine(l)} wants to link with this session. Quorum asks you in a dialog; or type ${commandText(vendor, 'allow')} ${l.id} to accept, or ${commandText(vendor, 'block')} ${l.id} to block.`,
    )
    .join('\n');

/**
 * What the agent is told when a session asks to link: open Quorum's dialog, which only the person
 * can answer (INV-34). The agent cannot accept; it only brings the question up.
 */
export const requestAsk = (vendor: HookVendor, links: readonly LinkInfo[]): string =>
  [
    ...links.map((l) => `Quorum: ${linkLine(l)} wants to link with this session.`),
    'Before anything else, call the quorum_requests tool: it asks your human in a dialog that only they can answer (you cannot answer it). Then tell them the outcome in one line and carry on.',
    `If that tool is not available, tell them to type ${commandText(vendor, 'allow')} <id> to accept or ${commandText(vendor, 'block')} <id> to block.`,
  ].join('\n');

/** Add hidden context for the agent to a hook's output (`additionalContext`). */
export const withContext = (eventName: string, stdout: string, text: string): string => {
  let output: Record<string, unknown>;
  try {
    output = stdout ? (JSON.parse(stdout) as Record<string, unknown>) : {};
  } catch {
    output = {};
  }
  const specific = (output.hookSpecificOutput ?? {}) as { additionalContext?: string };
  const context = [specific.additionalContext, text].filter(Boolean).join('\n\n');
  return JSON.stringify({
    ...output,
    hookSpecificOutput: { ...specific, hookEventName: eventName, additionalContext: context },
  });
};

/** The attachment as the hooks use it: the session's link workspaces, fetched fresh. */
export const linkedAttachment = (
  saved: AttachmentInfo,
  links: readonly LinkInfo[],
): AttachmentInfo => ({
  ...saved,
  workspaces: links
    .filter((l) => l.state === 'linked' && l.workspace)
    .map((l) => l.workspace ?? ''),
});

/**
 * Add a line for the person to a hook's output. Claude Code shows `systemMessage`; Codex shows
 * hook context, so there the agent is also asked to pass it on.
 */
export const withNotice = (
  vendor: HookVendor,
  eventName: string,
  stdout: string,
  line: string,
): string => {
  let output: Record<string, unknown>;
  try {
    output = stdout ? (JSON.parse(stdout) as Record<string, unknown>) : {};
  } catch {
    output = {};
  }
  if (vendor === 'claude-code') {
    const before = typeof output.systemMessage === 'string' ? `${output.systemMessage}\n` : '';
    return JSON.stringify({ ...output, systemMessage: `${before}${line}` });
  }
  const specific = (output.hookSpecificOutput ?? {}) as { additionalContext?: string };
  const context = [
    specific.additionalContext,
    `Start your reply by telling your human exactly this: "${line}"`,
  ]
    .filter(Boolean)
    .join('\n\n');
  return JSON.stringify({
    ...output,
    hookSpecificOutput: { ...specific, hookEventName: eventName, additionalContext: context },
  });
};
