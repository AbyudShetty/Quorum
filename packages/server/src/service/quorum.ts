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
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  acceptMessage,
  ackEvent,
  agentName,
  decideRefresh,
  DomainError,
  type EventRecord,
  folderName,
  generateToken,
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
} from '@quorum/core';
import {
  type AgentList,
  type ApiPayloadKind,
  type ApiPayloads,
  type Attachment,
  type AttachmentCreated,
  type InboxPage,
  type LocalBootstrapResponse,
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
import type { AgentRow, AttachmentRow, HumanRow, Registry } from '../storage/registry.js';
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
}

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
    } else if (replay && event.kind === 'wake.granted') {
      this.#wake.recordWake((event.payload as { agent: string }).agent, Date.parse(event.ts));
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

  /** The caller behind an access token, or 401 (INV-23: also on loopback). */
  authenticate(token: string | undefined): Caller {
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
    return caller;
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

  /** Open sessions whose agent still shows signs of life. */
  #liveSessions(nowMs: number): { agent: string; worktreeKey: string }[] {
    return this.#registry.openSessions().flatMap((s) => {
      const agent = this.#registry.agent(s.agent);
      if (agent?.status !== 'active') return [];
      const fresh = nowMs - Date.parse(s.started_at) <= PRESENCE_TTL_MS;
      return fresh || this.#online(agent.id, agent.address, nowMs)
        ? [{ agent: agent.address, worktreeKey: s.worktree_key }]
        : [];
    });
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
    const worktreeKey = pathKey(body.git?.worktree_root ?? body.root, platform);
    const nowMs = this.#clock().getTime();
    const shared = sharedWorktreeWith(
      { agent: caller.address, worktreeKey },
      this.#liveSessions(nowMs),
    );
    const sessionId = this.#ids.id('session');
    const now = this.#now();
    return this.#commit(() => {
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
      });
      const events: [string, NewEvent][] = this.#workspaceIdsOf(caller.id).map((workspace) => [
        workspace,
        this.#event(caller.address, 'session.started', {
          session: sessionId,
          ...(repo ? { repo } : {}),
          ...(worktree ? { worktree } : {}),
          shared_worktree_with: shared,
        }),
      ]);
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
        },
        events,
      };
    });
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
    const outcome = acceptMessage(log, {
      workspace,
      principal,
      input,
      now: this.#now(),
      ids: this.#ids,
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
    outcome.envelope.to.forEach((address, i) => {
      if (address !== '*' && !members.has(address)) {
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
    return log.inbox(caller.address, {
      after: options.after ?? log.ackedUpTo(caller.address),
      limit: Math.min(options.limit ?? 100, MAX_PAGE),
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
    });
  }

  ack(caller: Caller, workspace: string, input: unknown): void {
    const log = this.#workspaceFor(caller, workspace);
    const { up_to } = this.#check('ackRequest', input);
    if (up_to <= log.ackedUpTo(caller.address)) return; // nothing new: no event noise
    const event = ackEvent(
      { kind: caller.kind, address: caller.address },
      up_to,
      this.#now(),
      this.#ids,
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
        const page = log.inbox(caller.address, { after, limit: MAX_PAGE });
        for (const message of page.messages) sink.send(message);
        if (!page.has_more) break;
        after = page.next_after;
      }
    }
    return this.notifier.add({
      principal: caller.id,
      address: caller.address,
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
    const pending = log.inbox(caller.address, {
      after: after ?? log.ackedUpTo(caller.address),
      limit: MAX_PAGE,
    }).messages;
    if (pending.length === 0) return { wake: false, reason: 'no_mail' };
    const nowMs = this.#clock().getTime();
    const denials: CoreWakeDecision[] = [];
    for (const message of pending) {
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
              message: message.id,
              thread,
            }),
          ],
        ],
      }));
      return { wake: true, message: message.id, seq: message.seq };
    }
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
