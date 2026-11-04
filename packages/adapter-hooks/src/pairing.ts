// The pairing commands in Claude Code and Codex (DECISIONS D-20, PAIRING.md). Quorum's hooks are
// set up once for every session (user level); a session joins only when the person types a
// command in it:
//
//   /quorum-id               (Codex: $quorum-id)              this session joins; shows its ID
//   /quorum-rotate           (Codex: $quorum-rotate)          replaces this session's ID; unlinks peers
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
import { type AttachmentInfo, findGit, peerLine, type QuorumClient } from '@quorum/adapter-mcp';
import { parseQuorumId } from '@quorum/core';
import { withFileLock, writePrivateFile } from '@quorum/local';
import { createHash } from 'node:crypto';
import type { LinkInfo, QuorumIdCreated, Vendor } from '@quorum/schemas';
import type { HookVendor } from './hooks.js';
import { loadHookState, saveHookState } from './state.js';

export const QUORUM_COMMANDS = [
  'id',
  'rotate',
  'attach',
  'allow',
  'detach',
  'block',
  'export',
] as const;
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
  /**
   * IDs this session asked to link with, until the person is told the other side accepted (the
   * requester otherwise never learned it, seen live 2026-10-22).
   */
  asking?: string[];
}

const pairingPath = (dataDir: string): string => join(dataDir, 'hooks', 'pairing.json');

export const sessionKey = (vendor: string, input: unknown): string | undefined => {
  const id = field(input, 'session_id');
  return typeof id === 'string' && id.length > 0 && id.length <= 256
    ? `${vendor}:${id}`
    : undefined;
};

export const loadPairing = async (dataDir: string): Promise<Record<string, PairedSession>> => {
  let raw: string;
  try {
    raw = await readFile(pairingPath(dataDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Quorum pairing state is malformed; restore it before changing session links.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Quorum pairing state is malformed; restore it before changing session links.');
  }
  for (const value of Object.values(parsed)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('Quorum pairing state contains an invalid session.');
    }
    const session = value as Partial<PairedSession>;
    if (
      typeof session.id !== 'string' ||
      !session.id ||
      typeof session.attachment !== 'string' ||
      !session.attachment ||
      (session.shown !== undefined &&
        (!Array.isArray(session.shown) || !session.shown.every((id) => typeof id === 'string'))) ||
      (session.asking !== undefined &&
        (!Array.isArray(session.asking) ||
          !session.asking.every((id) => typeof id === 'string'))) ||
      (session.asked !== undefined &&
        (!Array.isArray(session.asked) ||
          !session.asked.every((at) => typeof at === 'number' && Number.isFinite(at))))
    ) {
      throw new Error('Quorum pairing state contains an invalid session.');
    }
  }
  return parsed as Record<string, PairedSession>;
};

const writePairing = async (
  dataDir: string,
  sessions: Record<string, PairedSession>,
): Promise<void> => {
  await mkdir(join(dataDir, 'hooks'), { recursive: true, mode: 0o700 });
  await writePrivateFile(pairingPath(dataDir), `${JSON.stringify(sessions)}\n`);
};

/** Serialize the complete read/change/write across hooks, MCP processes and idle watchers. */
export const updatePairing = async <T>(
  dataDir: string,
  change: (sessions: Record<string, PairedSession>) => T,
): Promise<T> => {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  return withFileLock(dataDir, 'pairing-state', async () => {
    const sessions = await loadPairing(dataDir);
    const before = JSON.stringify(sessions);
    const result = change(sessions);
    if (JSON.stringify(sessions) !== before) await writePairing(dataDir, sessions);
    return result;
  });
};

/** Replace the complete state (initialization/tests); production mutations use updatePairing. */
export const savePairing = async (
  dataDir: string,
  sessions: Record<string, PairedSession>,
): Promise<void> => {
  await updatePairing(dataDir, (current) => {
    for (const key of Object.keys(current)) Reflect.deleteProperty(current, key);
    Object.assign(current, sessions);
  });
};

/**
 * Change one session's entry: read the file, change, write at once. Hooks run at the same moment (the
 * watcher checks every 2 s), so a copy read at a hook's start must not be written back at its end.
 */
const updateSession = async <T>(
  dataDir: string,
  key: string,
  change: (session: PairedSession) => T,
): Promise<T | undefined> =>
  updatePairing(dataDir, (sessions) => {
    const session = sessions[key];
    if (!session) return undefined;
    return change(session);
  });

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
  human: () => Promise<Pick<QuorumClient, 'createQuorumId' | 'rotateQuorumId'>>;
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
export const linkLine = (link: LinkInfo): string => peerLine(link);

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
const joinUnlocked = async (
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
    const joined = session;
    await updatePairing(context.dataDir, (current) => {
      current[key] = joined;
    });
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

const withSessionLock = async <T>(context: CommandContext, work: () => Promise<T>): Promise<T> => {
  const key = sessionKey(context.vendor, context.input);
  if (!key) throw new Error('The hook input has no session id.');
  await mkdir(context.dataDir, { recursive: true, mode: 0o700 });
  const digest = createHash('sha256').update(key).digest('hex');
  // Joining, ID refresh and rotation span server calls. Keep one session's entire operation
  // ordered without holding the shared state lock while waiting for the network.
  return withFileLock(context.dataDir, `pairing-join-${digest}`, work, {
    timeoutMs: 35_000,
    staleMs: 120_000,
  });
};

const join_ = (context: CommandContext) => withSessionLock(context, () => joinUnlocked(context));

/** Repair a cached ID after a committed rotation whose response/local write was lost. */
const rememberCurrentId = async (
  context: CommandContext,
  session: PairedSession,
  id: string | undefined,
): Promise<PairedSession> => {
  if (!id || parseQuorumId(id) !== id) {
    throw new Error("The server did not return this session's current Quorum ID.");
  }
  const key = sessionKey(context.vendor, context.input) ?? '';
  const updated = await updateSession(context.dataDir, key, (saved) => {
    if (saved.attachment !== session.attachment)
      throw new Error("This session's attachment changed.");
    if (saved.id !== id) {
      saved.id = id;
      Reflect.deleteProperty(saved, 'shown');
      Reflect.deleteProperty(saved, 'asked');
      Reflect.deleteProperty(saved, 'asking');
    }
    return saved;
  });
  if (!updated) throw new Error('This session is no longer in Quorum.');
  return updated;
};

/** Run a typed command; the text is shown to the person (the prompt itself is blocked). */
export const runQuorumCommand = async (context: CommandContext): Promise<string> => {
  const { vendor, command } = context;
  const say = (name: QuorumCommandName) => commandText(vendor, name);
  const notJoined = `This session is not in Quorum yet: type ${say('id')} first.`;

  if (command.name === 'id') {
    if (command.args)
      return `Quorum: ${say('id')} takes no arguments. Use ${say('rotate')} for a new ID.`;
    return withSessionLock(context, async () => {
      const { session, label } = await joinUnlocked(context);
      context.step?.('links');
      const client = await context.agent(session.attachment);
      const list = await client.links();
      const current = await rememberCurrentId(context, session, list.id);
      return [
        `Quorum ID of this session${label ? ` (${label})` : ''}: ${current.id}`,
        `Give it to the other person; they type ${commandText('claude-code', 'attach')} ${current.id} in Claude Code, or ${commandText('codex', 'attach')} ${current.id} in Codex.`,
        ...describeLinks(vendor, list.links),
      ].join('\n');
    });
  }

  if (command.name === 'rotate') {
    if (command.args) return `Quorum: ${say('rotate')} takes no arguments.`;
    return withSessionLock(context, async () => {
      const session = await pairedSession(context.dataDir, vendor, context.input);
      if (!session) return `Quorum: ${notJoined}`;
      context.step?.('links');
      const client = await context.agent(session.attachment);
      const { id } = await client.links();
      if (!id) throw new Error("The server did not return this session's current Quorum ID.");
      context.step?.('sign-in');
      const human = await context.human();
      context.step?.('rotate-id');
      const rotated = await human.rotateQuorumId({
        vendor,
        vendor_session_id: sessionId(context.input),
        root: cwdOf(context.input),
        expected_id: id,
      });
      await rememberCurrentId(context, session, rotated.id);
      return [
        `Quorum: this session's new ID is ${rotated.id}.`,
        `The old ID ${rotated.previous_id} no longer works. All links were removed; share the new ID to pair again.`,
        'Your conversation history and block list are preserved.',
      ].join('\n');
    });
  }

  if (command.name === 'attach') {
    const target = parseQuorumId(command.args);
    if (!target) {
      return `Quorum: give the other session's ID, e.g. ${say('attach')} QRM-7KD2-PX9F-M3TA.`;
    }
    const { session } = await join_(context);
    context.step?.('request-link');
    const client = await context.agent(session.attachment);
    if (target === session.id) return "Quorum: that is this session's own ID.";
    try {
      const outcome = await client.requestLink(target);
      if (outcome.state !== 'linked') {
        // Tell the person when the other side accepts (takeLinkNews).
        const key = sessionKey(vendor, context.input) ?? '';
        await updateSession(context.dataDir, key, (s) => {
          if (s.id !== session.id) return; // A rotation superseded this in-flight request.
          if (!s.asking?.includes(target)) s.asking = [...(s.asking ?? []), target];
        });
      }
      return {
        requested: `Quorum: asked ${target} to link with this session (${session.id}). You will see when their person allows it.`,
        queued: `Quorum: ${target} is on a laptop that is not reachable right now; the request goes out when it is back.`,
        linked: `Quorum: linked with ${target}. Your agent can now message it.`,
      }[outcome.state];
    } catch (error) {
      if ((error as { code?: string }).code === 'pairing.no_such_id') {
        return `Quorum: there is no session ${target}. Check the ID with the person who gave it to you.`;
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
  return (
    (await updateSession(dataDir, key, (session) => {
      const fresh = newRequests(session, links);
      if (fresh.length === 0) return [];
      const now = options.now ?? Date.now();
      const recent = (session.asked ?? []).filter((at) => now - at < 3_600_000);
      if (recent.length >= REQUEST_WAKES_PER_HOUR) return [];
      session.asked = [...recent, now];
      session.shown = [...(session.shown ?? []), ...fresh.map((l) => l.id)];
      return fresh;
    })) ?? []
  );
};

/**
 * The links this session asked for that the other side has accepted since the person was last told.
 * Requests made before `asking` existed are picked up from their `requested` state. With `take`,
 * they are marked told.
 */
export const takeLinkNews = async (
  dataDir: string,
  key: string,
  links: readonly LinkInfo[],
  options: { take?: boolean } = {},
): Promise<LinkInfo[]> =>
  (await updateSession(dataDir, key, (session) => {
    const asking = [...(session.asking ?? [])];
    for (const l of links) if (l.state === 'requested' && !asking.includes(l.id)) asking.push(l.id);
    const accepted = links.filter((l) => l.state === 'linked' && asking.includes(l.id));
    const told = options.take === false ? [] : accepted.map((l) => l.id);
    const left = asking.filter((id) => !told.includes(id));
    if (left.length > 0) session.asking = left;
    else Reflect.deleteProperty(session, 'asking');
    return accepted;
  })) ?? [];

/** The line that tells the person a link they asked for is made. */
export const acceptedNotice = (links: readonly LinkInfo[]): string =>
  links
    .map((l) => `Quorum: ${linkLine(l)} accepted your link request. Your agent can now message it.`)
    .join('\n');

/** What the agent is told when a link it asked for is made: tell the person. */
export const acceptedAsk = (links: readonly LinkInfo[]): string =>
  [
    ...links.map(
      (l) =>
        `Quorum: ${linkLine(l)} accepted this session's link request; the two are now linked and can message each other (quorum_send).`,
    ),
    'Tell your human this in one line, then carry on with what you were doing.',
  ].join('\n');

/**
 * At a prompt or session start: the requests not yet shown in this run (marked shown) and the links
 * accepted since the person was last told (marked told). Read and written at once (updateSession).
 */
export const takePromptNews = async (
  dataDir: string,
  key: string,
  links: readonly LinkInfo[],
  options: { restart?: boolean } = {},
): Promise<{ requests: LinkInfo[]; accepted: LinkInfo[] }> => {
  const requests =
    (await updateSession(dataDir, key, (session) => {
      if (options.restart) session.shown = []; // shown once per run (again after a resume)
      const fresh = newRequests(session, links);
      if (fresh.length > 0) session.shown = [...(session.shown ?? []), ...fresh.map((l) => l.id)];
      return fresh;
    })) ?? [];
  return { requests, accepted: await takeLinkNews(dataDir, key, links) };
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
