// The Quorum service: every /v1 command, independent of HTTP (ARCHITECTURE §3).
//
// Each command validates, authorizes, then commits its registry changes and their events in ONE
// SQLite transaction (INV-8: no state change without an event), then updates the in-memory
// message projections and pushes to open streams. Commands run synchronously from the first
// check to the commit, so two requests can never interleave inside one (single process, single
// writer: the start lock guarantees one server per data directory).
//
// Migration seam: the message projections are rebuilt in memory from the log on start. Moving them
// to SQL tables (or Postgres) changes this file only; the API and the log stay the same.
import { realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  acceptMessage,
  ackEvent,
  agentName,
  decideRefresh,
  DomainError,
  type EventRecord,
  folderName,
  generateToken,
  labelSlug,
  hashToken,
  type IdFactory,
  MessageLog,
  type NewEvent,
  pathKey,
  PresenceBook,
  type WakeDecision as CoreWakeDecision,
  WakeGovernor,
  type Principal,
  type StoredMessage,
  sharedWorktreeWith,
  systemNotice,
  tokenKind,
  toolName,
} from '@quorum/core';
import {
  type AgentList,
  type ApiPayloadKind,
  type ApiPayloads,
  type Attachment,
  type AttachmentCreated,
  type InboxPage,
  type LocalBootstrapResponse,
  type UiLink,
  type MessageAccepted,
  type MessageType,
  type SessionCreated,
  type SubmittedEnvelope,
  type TokenPair,
  validateApiPayload,
  type Vendor,
  type Workspace,
  type WakeDecision,
  type WorkspaceList,
} from '@quorum/schemas';
import type { Db } from '../storage/database.js';
import type {
  AgentRow,
  AttachmentRow,
  HumanRow,
  Registry,
  SessionRow,
} from '../storage/registry.js';
import type { SqliteEventStore } from '../storage/sqlite-event-store.js';
import { Notifier, type Subscriber } from './notifier.js';
import { RateLimiter } from './rate-limit.js';

/** Instance-level events (owner sign-in, refresh-token reuse) live in their own chain. */
export const SYSTEM_CHAIN = 'ws_00000000000000000000000000';

const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 24 * 3600;
/** MESSAGE_SPEC §5.10: heartbeats every 30 s, offline after 3 missed. */
export const HEARTBEAT_INTERVAL_MS = 30_000;
const PRESENCE_TTL_MS = 3 * HEARTBEAT_INTERVAL_MS;
const MAX_PAGE = 500;

/** Who is calling, from the token only (INV-7). */
export interface Caller {
  kind: 'human' | 'agent';
  /** hu_ or ag_ id. */
  id: string;
  address: string;
  /**
   * The calling window, when the request names one of this agent's open sessions
   * (`Quorum-Session` header). Verified here, so a window can never speak as another (INV-7).
   */
  session?: { id: string; label: string; machine: string; path?: string };
}

/** A folder shown with the home folder as ~ (so a username never travels with a message). */
const homeShortened = (path: string, home: string): string => {
  const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const h = home.replace(/[\\/]+$/, '');
  return h && fold(path).startsWith(fold(h)) && /^[\\/]?$/.test(path.charAt(h.length))
    ? `~${path.slice(h.length)}`
    : path;
};

/** `claude@api-1` → `claude@abyud-laptop-api-1`: the form that is unique across machines. */
const longLabel = (label: string, machine: string): string => label.replace('@', `@${machine}-`);

const SESSION_LABEL_FORM = /^[a-z][a-z0-9-]{0,31}@[a-z0-9][a-z0-9-]{0,95}-[1-9][0-9]{0,3}$/;

export interface QuorumOptions {
  db: Db;
  registry: Registry;
  store: SqliteEventStore;
  ids: IdFactory;
  /** Local mode checks attach roots on this machine and refuses the data directory (INV-25). */
  mode: 'local' | 'remote';
  dataDir: string;
  /** Host part of agent addresses (`agent:claude-api@<machine>`). */
  machine: string;
  /** Name of the owner human created on first local sign-in (`human:<ownerName>`). */
  ownerName: string;
  /** Default: the system clock. */
  clock?: () => Date;
  /** Messages per agent per minute (POLICY_SPEC `messages_per_minute`). */
  messagesPerMinute?: number;
  /** Wake limits (POLICY_SPEC `limits`; INV-29). Defaults: 20 per hour, pause after 12. */
  wakesPerHour?: number;
  agentOnlyMessagesBeforePause?: number;
}

const notFound = (code: string, message: string, fix: string) =>
  new DomainError('not_found', code, message, fix);

/**
 * A folder's real path (symlinks, junctions and 8.3 short names resolved). A folder that does not
 * exist (yet) keeps its own name under its nearest existing parent's real path.
 */
const resolvedPath = (path: string): string => {
  const missing: string[] = [];
  for (let current = path; ;) {
    try {
      return join(realpathSync.native(current), ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      missing.push(basename(current));
      current = parent;
    }
  }
};

/** `quorum ui` login links live 60 s; the web sessions they open, 12 hours. */
const UI_LINK_MS = 60_000;
const UI_SESSION_MS = 12 * 60 * 60 * 1000;

const unauthorized = (code = 'auth.invalid_token') =>
  new DomainError(
    'unauthorized',
    code,
    'Missing, invalid, expired or revoked token.',
    'Send "Authorization: Bearer <access token>"; when it expires, refresh it at /v1/auth/refresh.',
  );

const platformOf = (): 'win32' | 'posix' => (process.platform === 'win32' ? 'win32' : 'posix');

/** Is path key `child` the same as or inside path key `parent`? */
const keyInside = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);

export class Quorum {
  readonly #db: Db;
  readonly #registry: Registry;
  readonly #store: SqliteEventStore;
  readonly #ids: IdFactory;
  readonly #options: QuorumOptions;
  readonly #clock: () => Date;
  readonly #logs = new Map<string, MessageLog>();
  readonly #presence = new PresenceBook(HEARTBEAT_INTERVAL_MS);
  readonly #wake: WakeGovernor;
  /** Messages that already woke each agent: one wake per message, however many adapters ask. */
  readonly #woken = new Map<string, Set<string>>();
  /** When each session last made a request (ms): a window is live while it keeps talking. */
  readonly #sessionSeen = new Map<string, number>();
  /** Web sign-in (hashes only): one-time links and the sessions they open. */
  readonly #uiLinks = new Map<string, { principal: string; expiresMs: number }>();
  readonly #uiSessions = new Map<string, { principal: string; expiresMs: number }>();
  readonly #messageLimit: RateLimiter;
  readonly #heartbeatLimit: RateLimiter;
  readonly notifier = new Notifier();

  private constructor(options: QuorumOptions) {
    this.#options = options;
    this.#db = options.db;
    this.#registry = options.registry;
    this.#store = options.store;
    this.#ids = options.ids;
    this.#clock = options.clock ?? (() => new Date());
    const nowMs = () => this.#clock().getTime();
    this.#messageLimit = new RateLimiter(options.messagesPerMinute ?? 60, 60_000, nowMs);
    this.#heartbeatLimit = new RateLimiter(12, 60_000, nowMs);
    this.#wake = new WakeGovernor({
      wakesPerHour: options.wakesPerHour ?? 20,
      agentOnlyMessagesBeforePause: options.agentOnlyMessagesBeforePause ?? 12,
    });
  }

  /**
   * Feed an event to the wake governor: thread runs from messages, and, when replaying the log at
   * start, the budget from granted wakes (live grants were already counted by `decide`).
   */
  #observe(event: EventRecord, replay: boolean): void {
    if (event.kind === 'message.accepted') {
      this.#wake.observe((event.payload as { envelope: SubmittedEnvelope }).envelope);
    } else if (event.kind === 'wake.granted') {
      const { agent, message, session } = event.payload as {
        agent: string;
        message: string;
        session?: string;
      };
      const key = session ? `${agent}#${session}` : agent;
      const woken = this.#woken.get(key) ?? new Set<string>();
      woken.add(message);
      this.#woken.set(key, woken);
      if (replay) this.#wake.recordWake(agent, Date.parse(event.ts));
    }
  }

  /** Open the service and rebuild the message projections from the log. */
  static async open(options: QuorumOptions): Promise<Quorum> {
    const quorum = new Quorum(options);
    for (const workspace of options.registry.workspaceIds()) {
      const log = new MessageLog();
      for (let after = 0; ;) {
        const events = await options.store.read(workspace, { after, limit: 5000 });
        for (const event of events) {
          log.apply(event);
          quorum.#observe(event, true);
        }
        const last = events.at(-1);
        if (!last) break;
        after = last.seq;
      }
      quorum.#logs.set(workspace, log);
    }
    return quorum;
  }

  // --- plumbing -------------------------------------------------------------------------------

  #now(): string {
    return this.#clock().toISOString();
  }

  #event(actor: string, kind: string, payload: Record<string, unknown>): NewEvent {
    return { ev_id: this.#ids.id('event'), ts: this.#now(), actor, kind, payload };
  }

  /**
   * Run `work` and append the events it returns, all in one immediate transaction; then feed new
   * messages and acks to the projections and push messages to open streams.
   */
  #commit<T>(work: () => { result: T; events: [workspace: string, event: NewEvent][] }): T {
    const run = this.#db.transaction(() => {
      const { result, events } = work();
      const byWorkspace = new Map<string, NewEvent[]>();
      for (const [workspace, event] of events) {
        byWorkspace.set(workspace, [...(byWorkspace.get(workspace) ?? []), event]);
      }
      const appended = [...byWorkspace].flatMap(([workspace, inputs]) =>
        this.#store.appendNewSync(workspace, inputs),
      );
      return { result, appended };
    });
    const { result, appended } = run.immediate();
    for (const event of appended) {
      const log = this.#logs.get(event.workspace);
      if (!log) continue;
      log.apply(event);
      this.#observe(event, false);
      if (event.kind === 'message.accepted') {
        const id = (event.payload as { envelope: { id: string } }).envelope.id;
        const stored = log.byId(id);
        if (stored) this.notifier.publish(event.workspace, stored);
      }
    }
    return result;
  }

  #check<K extends ApiPayloadKind>(kind: K, input: unknown): ApiPayloads[K] {
    const result = validateApiPayload(kind, input);
    if (result.ok) return result.value;
    const first = result.issues[0];
    throw new DomainError(
      'invalid',
      'request.invalid',
      `The request does not match the API schema: ${first?.path || '(root)'} ${first?.message ?? ''}`.trim(),
      'Fix the field at `path`; see packages/schemas/openapi.v1.json.',
      first?.path ?? '',
    );
  }

  #requireHuman(caller: Caller): void {
    if (caller.kind !== 'human') {
      throw new DomainError(
        'forbidden',
        'auth.human_only',
        'Only a human can do this; agent tokens are refused (INV-30).',
        'Ask your human to run the matching `quorum` command.',
      );
    }
  }

  /** The workspace, if it exists and the caller belongs to it; 404 otherwise (no existence leak). */
  #workspaceFor(caller: Caller, workspace: string): MessageLog {
    const log = this.#logs.get(workspace);
    if (!log || !this.#registry.isMember(workspace, caller.id)) {
      throw notFound(
        'workspace.not_found',
        `There is no workspace ${workspace} that you belong to.`,
        'List your workspaces with GET /v1/workspaces (or `quorum status`).',
      );
    }
    return log;
  }

  #workspaceIdsOf(principal: string): string[] {
    return this.#registry.workspacesOf(principal).map((w) => w.id);
  }

  // --- tokens (ARCHITECTURE §6, INV-11) -------------------------------------------------------

  /** Insert a fresh access + refresh pair; call inside a commit. Only hashes are stored. */
  #issuePair(principal: string, family = this.#ids.ulid()): TokenPair {
    const now = this.#clock();
    const at = (seconds: number) => new Date(now.getTime() + seconds * 1000).toISOString();
    const access = generateToken('access');
    const refresh = generateToken('refresh');
    const base = { principal, family, status: 'active' as const, created_at: now.toISOString() };
    this.#registry.insertToken({
      ...base,
      hash: hashToken(access),
      kind: 'access',
      expires_at: at(ACCESS_TTL_S),
    });
    this.#registry.insertToken({
      ...base,
      hash: hashToken(refresh),
      kind: 'refresh',
      expires_at: at(REFRESH_TTL_S),
    });
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_S,
      refresh_expires_in: REFRESH_TTL_S,
    };
  }

  #principal(id: string): Caller | undefined {
    if (id.startsWith('hu_')) {
      const human = this.#registry.human(id);
      return human && { kind: 'human', id: human.id, address: human.address };
    }
    const agent = this.#registry.agent(id);
    return agent?.status === 'active'
      ? { kind: 'agent', id: agent.id, address: agent.address }
      : undefined;
  }

  /**
   * The caller behind an access token, or 401 (INV-23: also on loopback). With `sessionId` (the
   * `Quorum-Session` header) and when it is one of this agent's open, labelled sessions, the
   * caller carries that window; anything else is ignored rather than refused, so a window whose
   * session just ended keeps working as the plain agent.
   */
  authenticate(token: string | undefined, sessionId?: string): Caller {
    if (!token || tokenKind(token) !== 'access') throw unauthorized();
    const row = this.#registry.token(hashToken(token));
    if (
      row?.kind !== 'access' ||
      row.status !== 'active' ||
      Date.parse(row.expires_at) <= this.#clock().getTime()
    ) {
      throw unauthorized();
    }
    const caller = this.#principal(row.principal);
    if (!caller) throw unauthorized();
    if (caller.kind !== 'agent' || !sessionId) return caller;
    const session = this.#registry.session(sessionId);
    if (
      session?.agent !== caller.id ||
      session.ended_at !== null ||
      !session.label ||
      !session.machine
    ) {
      return caller;
    }
    this.#sessionSeen.set(session.id, this.#clock().getTime()); // the window is alive
    return {
      ...caller,
      session: {
        id: session.id,
        label: session.label,
        machine: session.machine,
        ...(session.display_root ? { path: session.display_root } : {}),
      },
    };
  }

  /** Rotate a refresh token. Presenting a rotated one again revokes the whole family (INV-11). */
  refresh(input: unknown): TokenPair {
    const { refresh_token } = this.#check('tokenRefreshRequest', input);
    const invalid = () => unauthorized('auth.invalid_refresh');
    if (tokenKind(refresh_token) !== 'refresh') throw invalid();
    const hash = hashToken(refresh_token);
    const row = this.#registry.token(hash);
    if (row?.kind !== 'refresh') throw invalid();
    const decision = decideRefresh(row, this.#clock());
    if (decision.outcome === 'reject_and_revoke_family') {
      const principal = this.#principal(row.principal);
      this.#commit(() => {
        this.#registry.revokeFamily(decision.family);
        return {
          result: undefined,
          events: [
            [
              SYSTEM_CHAIN,
              this.#event('system:quorum', 'auth.refresh_reused', {
                principal: principal?.address ?? row.principal,
                family: decision.family,
              }),
            ],
          ],
        };
      });
      throw new DomainError(
        'unauthorized',
        'auth.refresh_reused',
        'This refresh token was already used, so another copy may exist. Every token from the same sign-in is now revoked.',
        'Sign in again (`quorum login`, or `quorum attach` for an agent) and check where the old token could have leaked.',
      );
    }
    if (decision.outcome === 'reject') throw invalid();
    if (!this.#principal(row.principal)) throw invalid();
    return this.#commit(() => {
      this.#registry.setTokenStatus(hash, 'rotated');
      return { result: this.#issuePair(row.principal, decision.family), events: [] };
    });
  }

  /**
   * Local mode: sign in the owner after a valid bootstrap code (the caller has checked it).
   * The first sign-in creates the owner human.
   */
  signInOwner(): LocalBootstrapResponse {
    return this.#commit(() => {
      const events: [string, NewEvent][] = [];
      let owner = this.#registry.owner();
      if (!owner) {
        owner = {
          id: this.#ids.id('human'),
          address: `human:${this.#options.ownerName}`,
          is_owner: 1,
          created_at: this.#now(),
        } satisfies HumanRow;
        this.#registry.insertHuman(owner);
        events.push([
          SYSTEM_CHAIN,
          this.#event('system:quorum', 'human.created', { human: owner.address, owner: true }),
        ]);
      }
      events.push([
        SYSTEM_CHAIN,
        this.#event(owner.address, 'human.signed_in', { method: 'local-bootstrap' }),
      ]);
      return {
        result: {
          human: { id: owner.id, address: owner.address },
          credentials: this.#issuePair(owner.id),
        },
        events,
      };
    });
  }

  /** This machine's name: the host part of agent addresses here. */
  get machine(): string {
    return this.#options.machine;
  }

  // --- web UI sign-in (ARCHITECTURE §6: `quorum ui`, one-time link → session cookie) ----------

  /**
   * A one-time login link for the calling human: single use, 60 s. Kept in memory as a hash only
   * (a restart forgets it, which can only end sign-ins early).
   */
  createUiLink(caller: Caller): UiLink {
    this.#requireHuman(caller);
    const nowMs = this.#clock().getTime();
    this.#pruneUi(nowMs);
    const code = generateToken('uiLink');
    this.#uiLinks.set(hashToken(code), { principal: caller.id, expiresMs: nowMs + UI_LINK_MS });
    return { code, path: `/login?code=${code}`, expires_in: UI_LINK_MS / 1000 };
  }

  /** Spend a login link: a new UI session for its human, or 401 (unknown, used or expired). */
  openUiSession(code: string | undefined): { session: string; maxAgeSeconds: number } {
    const invalid = () =>
      new DomainError(
        'unauthorized',
        'auth.invalid_ui_link',
        'This login link is wrong, expired or already used.',
        'Run `quorum ui` again and open the new link within 60 seconds.',
      );
    if (!code || tokenKind(code) !== 'uiLink') throw invalid();
    const hash = hashToken(code);
    const link = this.#uiLinks.get(hash);
    this.#uiLinks.delete(hash); // single use, whatever happens next
    const nowMs = this.#clock().getTime();
    if (!link || link.expiresMs <= nowMs) throw invalid();
    const caller = this.#principal(link.principal);
    if (caller?.kind !== 'human') throw invalid();
    const session = generateToken('uiSession');
    this.#uiSessions.set(hashToken(session), {
      principal: caller.id,
      expiresMs: nowMs + UI_SESSION_MS,
    });
    this.#commit(() => ({
      result: undefined,
      events: [
        [SYSTEM_CHAIN, this.#event(caller.address, 'human.signed_in', { method: 'ui-link' })],
      ],
    }));
    return { session, maxAgeSeconds: UI_SESSION_MS / 1000 };
  }

  /** The human behind a UI session cookie, or 401. */
  authenticateUi(session: string | undefined): Caller {
    if (!session || tokenKind(session) !== 'uiSession')
      throw unauthorized('auth.invalid_ui_session');
    const entry = this.#uiSessions.get(hashToken(session));
    if (!entry || entry.expiresMs <= this.#clock().getTime()) {
      throw unauthorized('auth.invalid_ui_session');
    }
    const caller = this.#principal(entry.principal);
    if (caller?.kind !== 'human') throw unauthorized('auth.invalid_ui_session');
    return caller;
  }

  #pruneUi(nowMs: number): void {
    for (const map of [this.#uiLinks, this.#uiSessions]) {
      for (const [hash, entry] of map) if (entry.expiresMs <= nowMs) map.delete(hash);
    }
  }

  // --- workspaces ----------------------------------------------------------------------------

  listWorkspaces(caller: Caller): WorkspaceList {
    return {
      workspaces: this.#registry
        .workspacesOf(caller.id)
        .map(({ id, name, created_at }) => ({ id, name, created_at })),
    };
  }

  createWorkspace(caller: Caller, input: unknown): Workspace {
    this.#requireHuman(caller);
    const { name } = this.#check('workspaceCreate', input);
    if (this.#registry.workspaceByName(name)) {
      throw new DomainError(
        'conflict',
        'workspace.exists',
        `A workspace named "${name}" already exists.`,
        'Pick another name, or use the existing workspace.',
      );
    }
    const workspace = { id: this.#ids.id('workspace'), name, created_at: this.#now() };
    this.#logs.set(workspace.id, new MessageLog());
    try {
      return this.#commit(() => {
        this.#registry.insertWorkspace({ ...workspace, created_by: caller.id });
        this.#registry.addMember(workspace.id, caller.id);
        return {
          result: workspace,
          events: [
            [
              workspace.id,
              this.#event(caller.address, 'workspace.created', { name, members: [caller.address] }),
            ],
          ],
        };
      });
    } catch (error) {
      this.#logs.delete(workspace.id);
      throw error;
    }
  }

  // --- attachments (ARCHITECTURE §12, INV-25, INV-30) ----------------------------------------

  #publicAttachment(row: AttachmentRow): Attachment {
    return {
      id: row.id,
      root: row.root,
      vendor: row.vendor as Vendor,
      workspaces: this.#workspaceIdsOf(row.agent),
      wake: row.wake,
      ...(row.wake_types === null
        ? {}
        : { wake_types: JSON.parse(row.wake_types) as MessageType[] }),
      lease_enforcement: row.lease_enforcement,
    };
  }

  /**
   * The canonical root. Local mode resolves it on this machine (symlinks, junctions, 8.3 short
   * names) and refuses the data directory or any folder containing it, comparing canonical forms
   * on both sides so no spelling slips past (INV-25, INV-27).
   */
  async #canonicalRoot(root: string): Promise<string> {
    if (this.#options.mode !== 'local') return root;
    const canonical = await realpath(root).catch(() => {
      throw new DomainError(
        'invalid',
        'attachment.root_missing',
        `The folder ${root} does not exist on this machine.`,
        'Attach an existing folder (the CLI sends its canonical absolute path).',
        '/root',
      );
    });
    const dataDir = await realpath(this.#options.dataDir).catch(() =>
      resolve(this.#options.dataDir),
    );
    const platform = platformOf();
    const rootKey = pathKey(canonical, platform);
    const dataKey = pathKey(dataDir, platform);
    if (keyInside(rootKey, dataKey) || keyInside(dataKey, rootKey)) {
      throw new DomainError(
        'invalid',
        'attachment.data_dir',
        'Refusing to attach the Quorum data directory or a folder that contains it: agents there could read its keys and codes.',
        'Attach your project folder instead.',
        '/root',
      );
    }
    return canonical;
  }

  #takenNames(): Set<string> {
    const suffix = `@${this.#options.machine}`;
    return new Set(
      [...this.#registry.agentAddresses()]
        .filter((address) => address.endsWith(suffix))
        .map((address) => address.slice('agent:'.length, -suffix.length)),
    );
  }

  async createAttachment(caller: Caller, input: unknown): Promise<AttachmentCreated> {
    this.#requireHuman(caller);
    const body = this.#check('attachmentCreate', input);
    for (const workspace of body.workspaces) this.#workspaceFor(caller, workspace);
    const root = await this.#canonicalRoot(body.root);
    // Everything after the await re-reads state and runs synchronously up to the commit.
    for (const workspace of body.workspaces) this.#workspaceFor(caller, workspace);
    const rootKey = pathKey(root, platformOf());
    const previous = this.#registry.attachmentsFor(rootKey, body.vendor, caller.id);
    const live = previous.find((a) => a.detached_at === null);
    if (live && !body.new_identity) return this.#reattach(caller, live, body);

    const now = this.#now();
    const machine = this.#options.machine;
    let agent: AgentRow | undefined;
    if (body.agent_name !== undefined) {
      const existing = this.#registry.agentByAddress(`agent:${body.agent_name}@${machine}`);
      if (existing) {
        const reusable =
          existing.status === 'retired' &&
          existing.owner === caller.id &&
          existing.vendor === body.vendor;
        if (!reusable) {
          throw new DomainError(
            'invalid',
            'attachment.name_taken',
            `The agent name "${body.agent_name}" is already used on this machine.`,
            'Choose another --name, or leave it out to get a default name.',
            '/agent_name',
          );
        }
        agent = existing;
      }
    } else if (!body.new_identity) {
      // Stable identity by default (D-12): re-attaching a detached folder brings its agent back.
      agent = previous
        .map((a) => this.#registry.agent(a.agent))
        .find((a) => a?.status === 'retired');
    }
    const reused = agent !== undefined;
    const name = body.agent_name ?? agentName(body.vendor, folderName(root), this.#takenNames());
    const agentRow: AgentRow = agent ?? {
      id: this.#ids.id('agent'),
      address: `agent:${name}@${machine}`,
      vendor: body.vendor,
      owner: caller.id,
      folder: folderName(root) || null,
      status: 'active',
      created_at: now,
    };
    const attachment: AttachmentRow = {
      id: this.#ids.id('attachment'),
      agent: agentRow.id,
      owner: caller.id,
      root,
      root_key: rootKey,
      vendor: body.vendor,
      wake: body.wake ?? 'off',
      wake_types: body.wake_types ? JSON.stringify(body.wake_types) : null,
      lease_enforcement: body.lease_enforcement ?? 'warn',
      created_at: now,
      detached_at: null,
    };
    return this.#commit(() => {
      if (reused) this.#registry.setAgentStatus(agentRow.id, 'active');
      else this.#registry.insertAgent(agentRow);
      this.#registry.insertAttachment(attachment);
      for (const workspace of body.workspaces) this.#registry.addMember(workspace, agentRow.id);
      const credentials = this.#issuePair(agentRow.id);
      const payload = {
        attachment: attachment.id,
        agent: agentRow.address,
        agent_id: agentRow.id,
        vendor: body.vendor,
        folder: agentRow.folder,
        wake: attachment.wake,
        ...(body.wake_types ? { wake_types: body.wake_types } : {}),
        lease_enforcement: attachment.lease_enforcement,
        reused_identity: reused,
      };
      return {
        result: {
          attachment: this.#publicAttachment(attachment),
          agent: { id: agentRow.id, address: agentRow.address },
          credentials,
        },
        events: this.#workspaceIdsOf(agentRow.id).map((workspace) => [
          workspace,
          this.#event(caller.address, 'attachment.created', payload),
        ]),
      };
    });
  }

  /**
   * `quorum attach` on a folder that is already attached: same identity, fresh credentials (e.g.
   * the keychain entry was lost), plus any newly named workspaces and changed settings.
   */
  #reattach(
    caller: Caller,
    live: AttachmentRow,
    body: ApiPayloads['attachmentCreate'],
  ): AttachmentCreated {
    const agent = this.#registry.agent(live.agent);
    if (!agent) throw new Error(`attachment ${live.id} has no agent`);
    const added = body.workspaces.filter((w) => !this.#registry.isMember(w, agent.id));
    const settings = {
      wake: body.wake ?? live.wake,
      wake_types: body.wake_types ? JSON.stringify(body.wake_types) : live.wake_types,
      lease_enforcement: body.lease_enforcement ?? live.lease_enforcement,
    };
    return this.#commit(() => {
      this.#registry.updateAttachment(live.id, settings);
      for (const workspace of added) this.#registry.addMember(workspace, agent.id);
      const credentials = this.#issuePair(agent.id);
      const updated = { ...live, ...settings };
      return {
        result: {
          attachment: this.#publicAttachment(updated),
          agent: { id: agent.id, address: agent.address },
          credentials,
        },
        events: this.#workspaceIdsOf(agent.id).map((workspace) => [
          workspace,
          this.#event(caller.address, 'attachment.reissued', {
            attachment: live.id,
            agent: agent.address,
            workspaces_added: added,
            wake: settings.wake,
            lease_enforcement: settings.lease_enforcement,
          }),
        ]),
      };
    });
  }

  /** The caller's live attachment, or 404 for anyone else's (no existence leak). */
  #ownAttachment(caller: Caller, id: string): AttachmentRow {
    this.#requireHuman(caller);
    const row = this.#registry.attachment(id);
    if (row?.owner !== caller.id || row.detached_at !== null) {
      throw notFound(
        'attachment.not_found',
        `There is no attachment ${id} of yours.`,
        'Run `quorum status` to see your attachments.',
      );
    }
    return row;
  }

  updateAttachment(caller: Caller, id: string, input: unknown): Attachment {
    const row = this.#ownAttachment(caller, id);
    const change = this.#check('attachmentUpdate', input);
    const settings = {
      wake: change.wake ?? row.wake,
      wake_types:
        change.wake_types === undefined
          ? row.wake_types
          : change.wake_types.length === 0
            ? null
            : JSON.stringify(change.wake_types),
      lease_enforcement: change.lease_enforcement ?? row.lease_enforcement,
    };
    const agent = this.#registry.agent(row.agent);
    return this.#commit(() => {
      this.#registry.updateAttachment(id, settings);
      return {
        result: this.#publicAttachment({ ...row, ...settings }),
        events: this.#workspaceIdsOf(row.agent).map((workspace) => [
          workspace,
          this.#event(caller.address, 'attachment.updated', {
            attachment: id,
            agent: agent?.address ?? row.agent,
            changes: { ...change },
          }),
        ]),
      };
    });
  }

  /** Detach: the agent is retired, its tokens revoked and its streams closed (INV-13). */
  deleteAttachment(caller: Caller, id: string): void {
    const row = this.#ownAttachment(caller, id);
    const agent = this.#registry.agent(row.agent);
    const now = this.#now();
    this.#commit(() => {
      this.#registry.detachAttachment(id, now);
      if (agent?.status === 'active') this.#registry.setAgentStatus(row.agent, 'retired');
      this.#registry.revokePrincipal(row.agent);
      const ended = this.#registry.endSessionsOf(row.agent, now);
      return {
        result: undefined,
        events: this.#workspaceIdsOf(row.agent).map((workspace) => [
          workspace,
          this.#event(caller.address, 'attachment.detached', {
            attachment: id,
            agent: agent?.address ?? row.agent,
            sessions_ended: ended,
          }),
        ]),
      };
    });
    this.notifier.closePrincipal(row.agent);
  }

  /** Revoke an agent at once: tokens, sessions and streams (INV-13). */
  revokeAgent(caller: Caller, agentId: string): void {
    this.#requireHuman(caller);
    const agent = this.#registry.agent(agentId);
    const shares =
      agent !== undefined &&
      (agent.owner === caller.id ||
        this.#workspaceIdsOf(agent.id).some((w) => this.#registry.isMember(w, caller.id)));
    if (!agent || !shares) {
      throw notFound(
        'agent.not_found',
        `There is no agent ${agentId} in your workspaces.`,
        'List agents with GET /v1/workspaces/{workspace}/agents.',
      );
    }
    if (agent.status !== 'revoked') {
      const now = this.#now();
      const live = this.#registry.attachmentOfAgent(agent.id);
      this.#commit(() => {
        this.#registry.setAgentStatus(agent.id, 'revoked');
        this.#registry.revokePrincipal(agent.id);
        if (live) this.#registry.detachAttachment(live.id, now);
        const ended = this.#registry.endSessionsOf(agent.id, now);
        return {
          result: undefined,
          events: this.#workspaceIdsOf(agent.id).map((workspace) => [
            workspace,
            this.#event(caller.address, 'agent.revoked', {
              agent: agent.address,
              agent_id: agent.id,
              sessions_ended: ended,
            }),
          ]),
        };
      });
    }
    this.notifier.closePrincipal(agent.id);
  }

  // --- sessions (ARCHITECTURE §13, INV-28) ---------------------------------------------------

  #online(agentId: string, address: string, nowMs: number): boolean {
    const entry = this.#presence.get(address);
    const beating =
      entry !== undefined &&
      entry.presence === 'online' &&
      nowMs - entry.last_seen <= PRESENCE_TTL_MS;
    return beating || this.notifier.isStreaming(agentId);
  }

  /**
   * Is this open session still a live window? Yes when it started recently or made a request
   * within the presence timeout. A session that never spoke with its own id (older adapters, or
   * before a server restart) falls back to its agent's presence.
   */
  #sessionLive(session: SessionRow, nowMs: number): boolean {
    if (session.ended_at !== null) return false;
    const agent = this.#registry.agent(session.agent);
    if (agent?.status !== 'active') return false;
    if (nowMs - Date.parse(session.started_at) <= PRESENCE_TTL_MS) return true;
    const seen = this.#sessionSeen.get(session.id);
    if (seen !== undefined) return nowMs - seen <= PRESENCE_TTL_MS;
    return this.#online(agent.id, agent.address, nowMs);
  }

  /** Open sessions that are live windows. */
  #liveSessions(nowMs: number): { agent: string; worktreeKey: string }[] {
    return this.#registry.openSessions().flatMap((s) => {
      const agent = this.#registry.agent(s.agent);
      return agent && this.#sessionLive(s, nowMs)
        ? [{ agent: agent.address, worktreeKey: s.worktree_key }]
        : [];
    });
  }

  /**
   * Resolve session labels in `to` (MESSAGE_SPEC §1.1): the short form names a live session on the
   * sender's machine, the long form (`claude@<machine>-api-1`) one anywhere. Returns the agents and
   * sessions reached; an unknown or ended label fails loudly, like any unknown recipient.
   */
  #resolveSessionLabels(
    caller: Caller,
    to: unknown,
  ): { delivered_to: string[]; to_sessions: string[] } | undefined {
    if (!Array.isArray(to)) return undefined;
    const labels = (to as unknown[])
      .map((value, index) => ({ value, index }))
      .filter((x): x is { value: string; index: number } => typeof x.value === 'string')
      .filter((x) => SESSION_LABEL_FORM.test(x.value));
    if (labels.length === 0) return undefined;
    const nowMs = this.#clock().getTime();
    const myMachine = caller.address.split('@')[1] ?? '';
    const live = this.#registry
      .openSessions()
      .filter((s) => s.label && s.machine && this.#sessionLive(s, nowMs));
    const deliveredTo = new Set<string>();
    const toSessions = new Set<string>();
    for (const { value, index } of labels) {
      const session = live.find(
        (s) =>
          (s.label === value && s.machine === myMachine) ||
          longLabel(s.label ?? '', s.machine ?? '') === value,
      );
      const agent = session && this.#registry.agent(session.agent);
      if (!session || !agent) {
        throw new DomainError(
          'invalid',
          'message.unknown_recipient',
          `No open session is called ${value}.`,
          'The window may have closed: send to its agent address instead (GET /v1/workspaces/{workspace}/agents).',
          `/to/${String(index)}`,
        );
      }
      deliveredTo.add(agent.address);
      toSessions.add(session.id);
    }
    return { delivered_to: [...deliveredTo], to_sessions: [...toSessions] };
  }

  createSession(caller: Caller, input: unknown): SessionCreated {
    if (caller.kind !== 'agent') {
      throw new DomainError(
        'forbidden',
        'auth.agent_only',
        'Only agents register sessions.',
        'Use the agent token from `quorum attach`.',
      );
    }
    const body = this.#check('sessionCreate', input);
    const platform = platformOf();
    // A window works inside its agent's attached folder: a session elsewhere could raise or dodge
    // shared-working-tree warnings for folders the agent was never attached to (INV-28).
    const attached = this.#registry.attachmentOfAgent(caller.id);
    // Compare real paths: the same folder can be spelled as a Windows 8.3 short name
    // (C:\Users\RUNNER~1), through a symlink or a junction, and attachment roots are stored
    // resolved. Only local mode can resolve: the folder is on this machine.
    const realRoot = this.#options.mode === 'local' ? resolvedPath(body.root) : body.root;
    const rootKey = pathKey(realRoot, platform);
    if (
      attached &&
      rootKey !== attached.root_key &&
      !rootKey.startsWith(
        attached.root_key.endsWith('/') ? attached.root_key : `${attached.root_key}/`,
      )
    ) {
      throw new DomainError(
        'invalid',
        'session.outside_attachment',
        'A session must be inside the folder this agent is attached to.',
        `Start the agent in ${attached.root} (or a folder inside it).`,
        '/root',
      );
    }
    const worktreeKey = pathKey(body.git?.worktree_root ?? body.root, platform);
    const nowMs = this.#clock().getTime();
    const shared = sharedWorktreeWith(
      { agent: caller.address, worktreeKey },
      this.#liveSessions(nowMs),
    );
    const sessionId = this.#ids.id('session');
    const now = this.#now();
    // The label: tool@folder-n, numbered per tool, machine and folder (see below).
    const agentRow = this.#registry.agent(caller.id);
    const tool = toolName(agentRow?.vendor ?? 'generic');
    const machine = caller.address.split('@')[1] ?? 'machine';
    const folder = labelSlug(folderName(body.root) || agentRow?.folder || 'folder');
    const group = `${tool}|${machine}|${folder}`;
    const open = this.#registry.openSessionsInGroup(group);
    const stale = open.filter((s) => !this.#sessionLive(s, nowMs));
    // Each conversation keeps one number: a resumed one (same vendor session) gets its number
    // back unless a live window holds it; a new one gets the next number. Never handed out twice.
    const numberOf = (s: SessionRow) => Number(/-(\d+)$/.exec(s.label ?? '')?.[1] ?? 0);
    const everyone = this.#registry.sessionsInGroup(group);
    const held = new Set(open.filter((s) => this.#sessionLive(s, nowMs)).map((s) => numberOf(s)));
    const resumed = everyone
      .filter((s) => s.vendor_session_id === body.vendor_session_id)
      .map((s) => numberOf(s))
      .find((n) => n > 0 && !held.has(n));
    const number = resumed ?? Math.max(0, ...everyone.map((s) => numberOf(s))) + 1;
    const label = `${tool}@${folder}-${String(number)}`;
    // How others see the folder. The client's `~` form is used only when it names the same folder
    // (its last part matches the root's); otherwise the server shows the root itself, so a window
    // cannot present itself as another folder (MESSAGE_SPEC §1.1).
    const claimed = body.display_root;
    const lastPart = (p: string) => labelSlug(p.split(/[\\/]/).filter(Boolean).at(-1) ?? '');
    const displayRoot =
      claimed && lastPart(claimed) === lastPart(realRoot)
        ? claimed
        : homeShortened(realRoot, homedir());
    return this.#commit(() => {
      // Windows that went away without saying so give their numbers back.
      for (const old of stale) this.#registry.endSession(old.id, now);
      const repo = body.git
        ? this.#registry.pathId('repository', pathKey(body.git.common_dir, platform), () =>
            this.#ids.id('repository'),
          )
        : undefined;
      const worktree = body.git
        ? this.#registry.pathId('worktree', worktreeKey, () => this.#ids.id('worktree'))
        : undefined;
      this.#registry.insertSession({
        id: sessionId,
        agent: caller.id,
        vendor_session_id: body.vendor_session_id,
        worktree_key: worktreeKey,
        repo: repo ?? null,
        worktree: worktree ?? null,
        started_at: now,
        ended_at: null,
        label,
        machine,
        label_group: group,
        display_root: displayRoot,
      });
      const events: [string, NewEvent][] = this.#workspaceIdsOf(caller.id).flatMap(
        (workspace): [string, NewEvent][] => [
          ...stale.map((old): [string, NewEvent] => [
            workspace,
            this.#event('system:quorum', 'session.ended', { session: old.id, reason: 'stale' }),
          ]),
          [
            workspace,
            this.#event(caller.address, 'session.started', {
              session: sessionId,
              label,
              ...(repo ? { repo } : {}),
              ...(worktree ? { worktree } : {}),
              shared_worktree_with: shared,
            }),
          ],
          // A new window starts reading where the agent's windows got to: it gets only mail none
          // of them read, never the history again (MESSAGE_SPEC §1.1).
          ...this.#startingPoint(workspace, caller.address, sessionId),
        ],
      );
      if (shared.length > 0) {
        events.push(...this.#sharedWorktreeNotices([caller.address, ...shared], worktree, now));
      }
      return {
        result: {
          session_id: sessionId,
          agent: { id: caller.id, address: caller.address },
          ...(repo ? { repo } : {}),
          ...(worktree ? { worktree } : {}),
          shared_worktree_with: shared,
          label,
          machine,
        },
        events,
      };
    });
  }

  /** The read position a new window starts from, as an ack of that window (none if at 0). */
  #startingPoint(workspace: string, address: string, session: string): [string, NewEvent][] {
    const from = this.#logs.get(workspace)?.furthestAck(address) ?? 0;
    if (from === 0) return [];
    return [
      [workspace, ackEvent({ kind: 'agent', address }, from, this.#now(), this.#ids, session)],
    ];
  }

  /**
   * A `shared_worktree` notice to every agent in the working tree (INV-28), each in its own first
   * workspace and copied to its owner there, so it reaches agents that share no workspace too.
   */
  #sharedWorktreeNotices(
    agents: readonly string[],
    worktree: string | undefined,
    now: string,
  ): [string, NewEvent][] {
    return agents.flatMap((address): [string, NewEvent][] => {
      const agent = this.#registry.agentByAddress(address);
      const workspace = agent && this.#workspaceIdsOf(agent.id)[0];
      if (!agent || !workspace) return [];
      const others = agents.filter((a) => a !== address);
      const owner = this.#registry.human(agent.owner);
      const to = [address];
      if (owner && this.#registry.isMember(workspace, owner.id)) to.push(owner.address);
      const { event } = systemNotice({
        workspace,
        to,
        kind: 'shared_worktree',
        text:
          `${others.join(', ')} ${others.length === 1 ? 'is' : 'are'} working in the same folder as ${address}. ` +
          'Stage only your own files (git add <paths>, never git add -A) and coordinate before editing shared files. ' +
          'A separate git worktree per agent avoids this (`quorum worktree`).',
        details: { agents: [...agents], ...(worktree ? { worktree } : {}) },
        now,
        ids: this.#ids,
      });
      return [[workspace, event]];
    });
  }

  endSession(caller: Caller, sessionId: string): void {
    const session = this.#registry.session(sessionId);
    if (session?.agent !== caller.id || session.ended_at !== null) {
      throw notFound(
        'session.not_found',
        `There is no open session ${sessionId} of yours.`,
        'Nothing to do: the session is already over.',
      );
    }
    const now = this.#now();
    this.#sessionSeen.delete(sessionId);
    this.#commit(() => {
      this.#registry.endSession(sessionId, now);
      return {
        result: undefined,
        events: this.#workspaceIdsOf(caller.id).map((workspace) => [
          workspace,
          this.#event(caller.address, 'session.ended', { session: sessionId }),
        ]),
      };
    });
  }

  // --- messages (MESSAGE_SPEC §2–§5) ---------------------------------------------------------

  #presenceEvents(address: string, presence: 'online' | 'offline'): [string, NewEvent][] {
    const agent = this.#registry.agentByAddress(address);
    if (!agent) return [];
    return this.#workspaceIdsOf(agent.id).map((workspace) => [
      workspace,
      this.#event('system:quorum', 'presence.changed', { agent: address, presence }),
    ]);
  }

  sendMessage(
    caller: Caller,
    workspace: string,
    input: unknown,
  ): { status: 200 | 201; body: MessageAccepted } {
    const log = this.#workspaceFor(caller, workspace);
    const heartbeat =
      typeof input === 'object' &&
      input !== null &&
      (input as { type?: unknown }).type === 'heartbeat';
    (heartbeat ? this.#heartbeatLimit : this.#messageLimit).take(
      caller.id,
      heartbeat ? 'heartbeats' : 'messages',
    );
    const principal: Principal = { kind: caller.kind, address: caller.address };
    // Server fields (never from the client, INV-7): the sending window, and who a session label reached.
    const targets = heartbeat
      ? undefined
      : this.#resolveSessionLabels(caller, (input as { to?: unknown } | null)?.to);
    const serverFields = {
      ...(caller.session && !heartbeat ? { from_session: caller.session } : {}),
      ...targets,
    };
    const outcome = acceptMessage(log, {
      workspace,
      principal,
      input,
      now: this.#now(),
      ids: this.#ids,
      ...(Object.keys(serverFields).length > 0 ? { serverFields } : {}),
    });

    if (outcome.outcome === 'duplicate') {
      const { envelope, seq, received_at, event } = outcome.original;
      return { status: 200, body: { id: envelope.id, seq, received_at, event } };
    }

    if (outcome.outcome === 'presence') {
      const nowMs = this.#clock().getTime();
      const change = this.#presence.heartbeat(caller.address, outcome.envelope.body, nowMs);
      const events = change ? this.#presenceEvents(caller.address, change.presence) : [];
      const appended = events.length ? this.#commit(() => ({ result: events, events })) : undefined;
      const here = appended?.find(([w]) => w === workspace)?.[1];
      return {
        status: 201,
        body: {
          id: outcome.envelope.id,
          seq: Math.max(1, this.#headSeq(workspace)),
          received_at: this.#now(),
          event: here?.ev_id ?? this.#ids.id('event'),
          flags: ['presence_only'],
        },
      };
    }

    // Every recipient must belong to the workspace: a typo fails loudly instead of vanishing.
    const members = this.#registry.memberAddresses(workspace);
    const reached = targets?.delivered_to ?? [];
    outcome.envelope.to.forEach((address, i) => {
      // A session label stands for its agent, which must belong to this workspace too.
      const label = SESSION_LABEL_FORM.test(address);
      const ok = label ? reached.every((agent) => members.has(agent)) : members.has(address);
      if (address !== '*' && !ok) {
        throw new DomainError(
          'invalid',
          'message.unknown_recipient',
          `${address} is not a member of this workspace.`,
          'Check the address with GET /v1/workspaces/{workspace}/agents, or send to "*".',
          `/to/${String(i)}`,
        );
      }
    });

    this.#commit(() => ({ result: undefined, events: [[workspace, outcome.event]] }));
    const stored = log.byId(outcome.envelope.id) as StoredMessage;
    return {
      status: 201,
      body: {
        id: stored.envelope.id,
        seq: stored.seq,
        received_at: stored.received_at,
        event: stored.event,
      },
    };
  }

  #headSeq(workspace: string): number {
    return this.#registry.workspace(workspace) ? (this.#store.headSync(workspace)?.seq ?? 0) : 0;
  }

  inbox(caller: Caller, workspace: string, options: { after?: number; limit?: number }): InboxPage {
    const log = this.#workspaceFor(caller, workspace);
    const session = caller.session?.id;
    return log.inbox(caller.address, {
      after: options.after ?? log.ackedUpTo(caller.address, session),
      limit: Math.min(options.limit ?? 100, MAX_PAGE),
      ...(session ? { session } : {}),
    });
  }

  thread(
    caller: Caller,
    workspace: string,
    thread: string,
    options: { after?: number; limit?: number },
  ): InboxPage {
    const log = this.#workspaceFor(caller, workspace);
    return log.thread(thread, caller.address, {
      after: options.after ?? 0,
      limit: Math.min(options.limit ?? 100, MAX_PAGE),
      ...(caller.session ? { session: caller.session.id } : {}),
    });
  }

  ack(caller: Caller, workspace: string, input: unknown): void {
    const log = this.#workspaceFor(caller, workspace);
    const { up_to } = this.#check('ackRequest', input);
    const session = caller.session?.id;
    if (up_to <= log.ackedUpTo(caller.address, session)) return; // nothing new: no event noise
    const event = ackEvent(
      { kind: caller.kind, address: caller.address },
      up_to,
      this.#now(),
      this.#ids,
      session,
    );
    this.#commit(() => ({ result: undefined, events: [[workspace, event]] }));
  }

  /**
   * Open a live stream. With `lastEventId`, first replays everything visible after it, then goes
   * live with no gap (both happen synchronously, so no message can slip in between).
   */
  subscribe(
    caller: Caller,
    workspace: string,
    lastEventId: number | undefined,
    sink: Pick<Subscriber, 'send' | 'close'>,
  ): () => void {
    const log = this.#workspaceFor(caller, workspace);
    if (lastEventId !== undefined) {
      for (let after = lastEventId; ;) {
        const page = log.inbox(caller.address, {
          after,
          limit: MAX_PAGE,
          ...(caller.session ? { session: caller.session.id } : {}),
        });
        for (const message of page.messages) sink.send(message);
        if (!page.has_more) break;
        after = page.next_after;
      }
    }
    return this.notifier.add({
      principal: caller.id,
      address: caller.address,
      ...(caller.session ? { session: caller.session.id } : {}),
      workspace,
      send: (message) => {
        sink.send(message);
      },
      close: () => {
        sink.close();
      },
    });
  }

  /**
   * May unread mail wake this agent or continue its turn? The server decides (INV-29): wake mode,
   * wake types, hourly budget and the agent-only-loop pause. A grant is recorded in the log.
   */
  requestWake(caller: Caller, workspace: string, input: unknown): WakeDecision {
    if (caller.kind !== 'agent') {
      throw new DomainError(
        'forbidden',
        'auth.agent_only',
        'Only agents ask to be woken.',
        'Use the agent token from `quorum attach`.',
      );
    }
    const log = this.#workspaceFor(caller, workspace);
    const { after } = this.#check('wakeRequest', input ?? {});
    const attachment = this.#registry.attachmentOfAgent(caller.id);
    if (!attachment || attachment.wake === 'off') return { wake: false, reason: 'mode_off' };
    const settings = {
      mode: attachment.wake,
      ...(attachment.wake_types === null
        ? {}
        : { types: JSON.parse(attachment.wake_types) as MessageType[] }),
    };
    const session = caller.session?.id;
    const pending = log.inbox(caller.address, {
      after: after ?? log.ackedUpTo(caller.address, session),
      limit: MAX_PAGE,
      ...(session ? { session } : {}),
    }).messages;
    if (pending.length === 0) return { wake: false, reason: 'no_mail' };
    const nowMs = this.#clock().getTime();
    const denials: CoreWakeDecision[] = [];
    // One wake per message per window (or per agent, for callers without a session).
    const wakeKey = session ? `${caller.address}#${session}` : caller.address;
    const woken = this.#woken.get(wakeKey);
    for (const message of pending) {
      // Several adapters may ask about the same mail (two Codex windows; Claude's Stop hook and its
      // idle watcher): the first grant wins and the message never wakes the agent twice.
      if (woken?.has(message.id)) continue;
      const decision = this.#wake.decide(caller.address, message, settings, nowMs);
      if (!decision.wake) {
        denials.push(decision);
        continue;
      }
      const thread = message.thread ?? message.id;
      this.#commit(() => ({
        result: undefined,
        events: [
          [
            workspace,
            this.#event('system:quorum', 'wake.granted', {
              agent: caller.address,
              ...(session ? { session } : {}),
              message: message.id,
              thread,
            }),
          ],
        ],
      }));
      return { wake: true, message: message.id, seq: message.seq };
    }
    // Everything pending already woke the agent once: nothing new to wake for.
    if (denials.length === 0) return { wake: false, reason: 'no_mail' };
    // The most important reason first: limits before filters.
    const order = [
      'budget_exhausted',
      'thread_paused',
      'type_filtered',
      'not_direct',
      'own_message',
    ];
    const reason = order.find((r) => denials.some((d) => !d.wake && d.reason === r));
    return {
      wake: false,
      reason: (reason ?? 'own_message') as NonNullable<WakeDecision['reason']>,
    };
  }

  agents(caller: Caller, workspace: string): AgentList {
    this.#workspaceFor(caller, workspace);
    const nowMs = this.#clock().getTime();
    return {
      agents: this.#registry.activeAgentsIn(workspace).map((agent) => {
        const entry = this.#presence.get(agent.address);
        const online = this.#online(agent.id, agent.address, nowMs);
        return {
          id: agent.id,
          address: agent.address,
          vendor: agent.vendor as Vendor,
          ...(agent.folder ? { folder: agent.folder } : {}),
          presence: online ? 'online' : 'offline',
          ...(entry ? { status: online ? entry.status : 'offline' } : {}),
          ...(online && entry?.current_task ? { current_task: entry.current_task } : {}),
          ...(entry ? { last_seen: new Date(entry.last_seen).toISOString() } : {}),
        };
      }),
    };
  }

  /** Record agents that went silent as offline (call periodically). */
  sweepPresence(): void {
    const changes = this.#presence.sweep(this.#clock().getTime());
    const events = changes.flatMap((c) => this.#presenceEvents(c.address, c.presence));
    if (events.length) this.#commit(() => ({ result: undefined, events }));
  }

  /** The workspace log as JSON Lines (INV-8); never contains tokens (INV-11). */
  async exportEvents(caller: Caller, workspace: string): Promise<string> {
    this.#requireHuman(caller);
    this.#workspaceFor(caller, workspace);
    const lines: string[] = [];
    for (let after = 0; ;) {
      const events = await this.#store.read(workspace, { after, limit: 5000 });
      for (const event of events) lines.push(JSON.stringify(event));
      const last = events.at(-1);
      if (!last) break;
      after = last.seq;
    }
    return lines.length ? `${lines.join('\n')}\n` : '';
  }

  /** Drop expired tokens (call now and then). */
  pruneTokens(): void {
    this.#registry.deleteExpiredTokens(this.#now());
  }

  close(): void {
    this.notifier.closeAll();
  }
}
