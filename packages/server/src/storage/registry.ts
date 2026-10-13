// The registry tables (migration 2): humans, workspaces, agents, memberships, attachments, token
// hashes, sessions and stable path ids. Plain synchronous SQLite access; the rules live in the
// service, and every change is committed together with its events (see Quorum.commit).
import type { Db } from './database.js';

export interface HumanRow {
  id: string;
  address: string;
  is_owner: 0 | 1;
  created_at: string;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
}

export type AgentStatus = 'active' | 'retired' | 'revoked';

export interface AgentRow {
  id: string;
  address: string;
  vendor: string;
  owner: string;
  folder: string | null;
  status: AgentStatus;
  created_at: string;
  /** For a mirror agent (a session on another laptop, D-20): its Quorum ID. */
  mirror_of?: string | null;
}

export interface AttachmentRow {
  id: string;
  agent: string;
  owner: string;
  root: string;
  root_key: string;
  vendor: string;
  wake: 'off' | 'direct' | 'all';
  /** JSON array of message types, or null for "all types". */
  wake_types: string | null;
  lease_enforcement: 'warn' | 'block';
  created_at: string;
  detached_at: string | null;
}

export type TokenStatus = 'active' | 'rotated' | 'revoked';

export interface TokenRow {
  hash: string;
  kind: 'access' | 'refresh';
  principal: string;
  family: string;
  status: TokenStatus;
  expires_at: string;
  created_at: string;
}

export interface SessionRow {
  id: string;
  agent: string;
  vendor_session_id: string;
  worktree_key: string;
  repo: string | null;
  worktree: string | null;
  started_at: string;
  ended_at: string | null;
  /** e.g. claude@api-1 (null for sessions from before numbering). */
  label: string | null;
  machine: string | null;
  /** tool|machine|folder: the group a window number belongs to. */
  label_group: string | null;
  /** The folder as shown in messages, e.g. ~\proj\api (home folder as ~). */
  display_root: string | null;
}

/** A session's permanent Quorum ID (D-20) and the agent that is that session. */
export interface QuorumIdRow {
  id: string;
  salt: string;
  agent: string;
  vendor: string;
  vendor_session_id: string;
  root: string;
  created_at: string;
}

/** requested: this side asked; pending: the other side asked and waits for /quorum-allow. */
export type LinkState = 'requested' | 'pending' | 'linked';

/** One side of a link between two sessions. */
export interface LinkRow {
  local: string;
  remote: string;
  remote_home: string;
  remote_salt: string;
  remote_tool: string;
  remote_machine: string;
  remote_path: string;
  remote_label: string;
  state: LinkState;
  /** The link's workspace, once linked. */
  workspace: string | null;
  /** The agent that is the other session here: a mirror, or a local session agent. */
  remote_agent: string | null;
  created_at: string;
  updated_at: string;
}

/** Something to send to another laptop's server, kept until it is delivered. */
export interface OutboxRow {
  id: string;
  remote_home: string;
  kind: string;
  payload: string;
  attempts: number;
  next_at: string;
  created_at: string;
}

export class Registry {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  // T names the row type the query returns; callers infer it from their declared return type.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  #get<T>(sql: string, ...params: unknown[]): T | undefined {
    return this.#db.prepare<unknown[], T>(sql).get(...params);
  }

  #all<T>(sql: string, ...params: unknown[]): T[] {
    return this.#db.prepare<unknown[], T>(sql).all(...params);
  }

  #run(sql: string, params: unknown[] | Record<string, unknown> = []): number {
    const statement = this.#db.prepare(sql);
    return (Array.isArray(params) ? statement.run(...params) : statement.run(params)).changes;
  }

  // --- humans ---------------------------------------------------------------------------------

  owner(): HumanRow | undefined {
    return this.#get('SELECT * FROM humans WHERE is_owner = 1');
  }

  human(id: string): HumanRow | undefined {
    return this.#get('SELECT * FROM humans WHERE id = ?', id);
  }

  insertHuman(row: HumanRow): void {
    this.#run(
      'INSERT INTO humans (id, address, is_owner, created_at) VALUES (@id, @address, @is_owner, @created_at)',
      { ...row },
    );
  }

  // --- workspaces and members ----------------------------------------------------------------

  workspace(id: string): WorkspaceRow | undefined {
    return this.#get('SELECT * FROM workspaces WHERE id = ?', id);
  }

  workspaceByName(name: string): WorkspaceRow | undefined {
    return this.#get('SELECT * FROM workspaces WHERE name = ?', name);
  }

  workspaceIds(): string[] {
    return this.#all<{ id: string }>('SELECT id FROM workspaces ORDER BY id').map((r) => r.id);
  }

  insertWorkspace(row: WorkspaceRow): void {
    this.#run(
      'INSERT INTO workspaces (id, name, created_by, created_at) VALUES (@id, @name, @created_by, @created_at)',
      { ...row },
    );
  }

  /** Workspaces the principal (hu_ or ag_ id) belongs to, oldest first. */
  workspacesOf(principal: string): WorkspaceRow[] {
    return this.#all(
      'SELECT w.* FROM workspaces w JOIN members m ON m.workspace = w.id WHERE m.principal = ? ORDER BY w.id',
      principal,
    );
  }

  isMember(workspace: string, principal: string): boolean {
    return (
      this.#get(
        'SELECT 1 FROM members WHERE workspace = ? AND principal = ?',
        workspace,
        principal,
      ) !== undefined
    );
  }

  addMember(workspace: string, principal: string): void {
    this.#run('INSERT OR IGNORE INTO members (workspace, principal) VALUES (?, ?)', [
      workspace,
      principal,
    ]);
  }

  /** Every address in a workspace (humans and agents of any status): valid recipients. */
  memberAddresses(workspace: string): Set<string> {
    const rows = this.#all<{ address: string }>(
      `SELECT h.address FROM members m JOIN humans h ON h.id = m.principal WHERE m.workspace = ?
       UNION SELECT a.address FROM members m JOIN agents a ON a.id = m.principal WHERE m.workspace = ?`,
      workspace,
      workspace,
    );
    return new Set(rows.map((r) => r.address));
  }

  /** Active agents in a workspace, oldest first. */
  activeAgentsIn(workspace: string): AgentRow[] {
    return this.#all(
      "SELECT a.* FROM agents a JOIN members m ON m.principal = a.id WHERE m.workspace = ? AND a.status = 'active' ORDER BY a.id",
      workspace,
    );
  }

  // --- agents ---------------------------------------------------------------------------------

  agent(id: string): AgentRow | undefined {
    return this.#get('SELECT * FROM agents WHERE id = ?', id);
  }

  agentByAddress(address: string): AgentRow | undefined {
    return this.#get('SELECT * FROM agents WHERE address = ?', address);
  }

  agentAddresses(): Set<string> {
    return new Set(
      this.#all<{ address: string }>('SELECT address FROM agents').map((r) => r.address),
    );
  }

  insertAgent(row: AgentRow): void {
    this.#run(
      'INSERT INTO agents (id, address, vendor, owner, folder, status, created_at, mirror_of) VALUES (@id, @address, @vendor, @owner, @folder, @status, @created_at, @mirror_of)',
      { ...row, mirror_of: row.mirror_of ?? null },
    );
  }

  setAgentStatus(id: string, status: AgentStatus): void {
    this.#run('UPDATE agents SET status = ? WHERE id = ?', [status, id]);
  }

  // --- attachments ----------------------------------------------------------------------------

  attachment(id: string): AttachmentRow | undefined {
    return this.#get('SELECT * FROM attachments WHERE id = ?', id);
  }

  /** The attachment currently held by an agent, if any. */
  attachmentOfAgent(agent: string): AttachmentRow | undefined {
    return this.#get(
      'SELECT * FROM attachments WHERE agent = ? AND detached_at IS NULL ORDER BY id DESC LIMIT 1',
      agent,
    );
  }

  /** Attachments of one folder for one vendor and owner, newest first (live and detached). */
  attachmentsFor(rootKey: string, vendor: string, owner: string): AttachmentRow[] {
    return this.#all(
      'SELECT * FROM attachments WHERE root_key = ? AND vendor = ? AND owner = ? ORDER BY id DESC',
      rootKey,
      vendor,
      owner,
    );
  }

  insertAttachment(row: AttachmentRow): void {
    this.#run(
      `INSERT INTO attachments (id, agent, owner, root, root_key, vendor, wake, wake_types, lease_enforcement, created_at, detached_at)
       VALUES (@id, @agent, @owner, @root, @root_key, @vendor, @wake, @wake_types, @lease_enforcement, @created_at, @detached_at)`,
      { ...row },
    );
  }

  updateAttachment(
    id: string,
    change: Pick<AttachmentRow, 'wake' | 'wake_types' | 'lease_enforcement'>,
  ): void {
    this.#run(
      'UPDATE attachments SET wake = @wake, wake_types = @wake_types, lease_enforcement = @lease_enforcement WHERE id = @id',
      { id, ...change },
    );
  }

  detachAttachment(id: string, at: string): void {
    this.#run('UPDATE attachments SET detached_at = ? WHERE id = ?', [at, id]);
  }

  // --- tokens ---------------------------------------------------------------------------------

  token(hash: string): TokenRow | undefined {
    return this.#get('SELECT * FROM tokens WHERE hash = ?', hash);
  }

  insertToken(row: TokenRow): void {
    this.#run(
      'INSERT INTO tokens (hash, kind, principal, family, status, expires_at, created_at) VALUES (@hash, @kind, @principal, @family, @status, @expires_at, @created_at)',
      { ...row },
    );
  }

  setTokenStatus(hash: string, status: TokenStatus): void {
    this.#run('UPDATE tokens SET status = ? WHERE hash = ?', [status, hash]);
  }

  /** Revoke every token of a family (refresh reuse, INV-11). Returns how many changed. */
  revokeFamily(family: string): number {
    return this.#run(
      "UPDATE tokens SET status = 'revoked' WHERE family = ? AND status != 'revoked'",
      [family],
    );
  }

  /** Revoke every token of a principal (revocation, detach; INV-13). */
  revokePrincipal(principal: string): number {
    return this.#run(
      "UPDATE tokens SET status = 'revoked' WHERE principal = ? AND status != 'revoked'",
      [principal],
    );
  }

  /** Drop tokens that expired before `cutoff`; they can never be used again. */
  deleteExpiredTokens(cutoff: string): number {
    return this.#run('DELETE FROM tokens WHERE expires_at < ?', [cutoff]);
  }

  // --- sessions -------------------------------------------------------------------------------

  session(id: string): SessionRow | undefined {
    return this.#get('SELECT * FROM sessions WHERE id = ?', id);
  }

  openSessions(): SessionRow[] {
    return this.#all('SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY id');
  }

  insertSession(row: SessionRow): void {
    this.#run(
      `INSERT INTO sessions (id, agent, vendor_session_id, worktree_key, repo, worktree, started_at, ended_at, label, machine, label_group, display_root)
       VALUES (@id, @agent, @vendor_session_id, @worktree_key, @repo, @worktree, @started_at, @ended_at, @label, @machine, @label_group, @display_root)`,
      { ...row },
    );
  }

  endSession(id: string, at: string): void {
    this.#run('UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL', [at, id]);
  }

  /** Every session of one label group, open or ended (numbers are never handed out twice). */
  sessionsInGroup(group: string): SessionRow[] {
    return this.#all('SELECT * FROM sessions WHERE label_group = ? ORDER BY id', group);
  }

  /** Open sessions of one label group (tool, machine, folder). */
  openSessionsInGroup(group: string): SessionRow[] {
    return this.#all(
      'SELECT * FROM sessions WHERE ended_at IS NULL AND label_group = ? ORDER BY id',
      group,
    );
  }

  /** End every open session of an agent (detach, revoke). Returns the ended ids. */
  endSessionsOf(agent: string, at: string): string[] {
    const ids = this.#all<{ id: string }>(
      'SELECT id FROM sessions WHERE agent = ? AND ended_at IS NULL',
      agent,
    ).map((r) => r.id);
    this.#run('UPDATE sessions SET ended_at = ? WHERE agent = ? AND ended_at IS NULL', [at, agent]);
    return ids;
  }

  // --- stable path ids ------------------------------------------------------------------------

  /** The stable id for a canonical path key, created on first use. */
  pathId(kind: 'repository' | 'worktree', key: string, make: () => string): string {
    const known = this.#get<{ id: string }>(
      'SELECT id FROM path_ids WHERE kind = ? AND key = ?',
      kind,
      key,
    );
    if (known) return known.id;
    const id = make();
    this.#run('INSERT INTO path_ids (kind, key, id) VALUES (?, ?, ?)', [kind, key, id]);
    return id;
  }

  // --- session pairing (migration 5, D-20) ----------------------------------------------------

  quorumId(id: string): QuorumIdRow | undefined {
    return this.#get('SELECT * FROM quorum_ids WHERE id = ?', id);
  }

  quorumIdOfAgent(agent: string): QuorumIdRow | undefined {
    return this.#get('SELECT * FROM quorum_ids WHERE agent = ?', agent);
  }

  quorumIdOfVendorSession(vendor: string, vendorSessionId: string): QuorumIdRow | undefined {
    return this.#get(
      'SELECT * FROM quorum_ids WHERE vendor = ? AND vendor_session_id = ?',
      vendor,
      vendorSessionId,
    );
  }

  allQuorumIds(): QuorumIdRow[] {
    return this.#all('SELECT * FROM quorum_ids ORDER BY created_at');
  }

  insertQuorumId(row: QuorumIdRow): void {
    this.#run(
      'INSERT INTO quorum_ids (id, salt, agent, vendor, vendor_session_id, root, created_at) VALUES (@id, @salt, @agent, @vendor, @vendor_session_id, @root, @created_at)',
      { ...row },
    );
  }

  link(local: string, remote: string): LinkRow | undefined {
    return this.#get('SELECT * FROM links WHERE local = ? AND remote = ?', local, remote);
  }

  linksOf(local: string): LinkRow[] {
    return this.#all('SELECT * FROM links WHERE local = ? ORDER BY created_at', local);
  }

  linkByWorkspace(workspace: string, local: string): LinkRow | undefined {
    return this.#get('SELECT * FROM links WHERE workspace = ? AND local = ?', workspace, local);
  }

  linksInWorkspace(workspace: string): LinkRow[] {
    return this.#all('SELECT * FROM links WHERE workspace = ?', workspace);
  }

  upsertLink(row: LinkRow): void {
    this.#run(
      `INSERT INTO links (local, remote, remote_home, remote_salt, remote_tool, remote_machine, remote_path, remote_label, state, workspace, remote_agent, created_at, updated_at)
       VALUES (@local, @remote, @remote_home, @remote_salt, @remote_tool, @remote_machine, @remote_path, @remote_label, @state, @workspace, @remote_agent, @created_at, @updated_at)
       ON CONFLICT (local, remote) DO UPDATE SET remote_home = excluded.remote_home, remote_salt = excluded.remote_salt,
         remote_tool = excluded.remote_tool, remote_machine = excluded.remote_machine, remote_path = excluded.remote_path,
         remote_label = excluded.remote_label, state = excluded.state, workspace = excluded.workspace,
         remote_agent = excluded.remote_agent, updated_at = excluded.updated_at`,
      { ...row },
    );
  }

  deleteLink(local: string, remote: string): number {
    return this.#run('DELETE FROM links WHERE local = ? AND remote = ?', [local, remote]);
  }

  isBlocked(local: string, remote: string): boolean {
    return (
      this.#get('SELECT 1 AS x FROM link_blocks WHERE local = ? AND remote = ?', local, remote) !==
      undefined
    );
  }

  block(local: string, remote: string, at: string): void {
    this.#run(
      'INSERT INTO link_blocks (local, remote, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      [local, remote, at],
    );
  }

  unblock(local: string, remote: string): void {
    this.#run('DELETE FROM link_blocks WHERE local = ? AND remote = ?', [local, remote]);
  }

  /** The agent's most recent window (open or not): its label and folder as others see them. */
  latestSessionOf(agent: string): SessionRow | undefined {
    return this.#get(
      'SELECT * FROM sessions WHERE agent = ? ORDER BY started_at DESC, id DESC LIMIT 1',
      agent,
    );
  }

  mirrorAgent(remoteQuorumId: string): AgentRow | undefined {
    return this.#get('SELECT * FROM agents WHERE mirror_of = ?', remoteQuorumId);
  }

  enqueueOutbox(row: OutboxRow): void {
    this.#run(
      'INSERT INTO federation_outbox (id, remote_home, kind, payload, attempts, next_at, created_at) VALUES (@id, @remote_home, @kind, @payload, @attempts, @next_at, @created_at)',
      { ...row },
    );
  }

  dueOutbox(now: string, limit = 50): OutboxRow[] {
    return this.#all(
      'SELECT * FROM federation_outbox WHERE next_at <= ? ORDER BY created_at LIMIT ?',
      now,
      limit,
    );
  }

  outboxItem(id: string): OutboxRow | undefined {
    return this.#get('SELECT * FROM federation_outbox WHERE id = ?', id);
  }

  outboxSize(): number {
    return this.#get<{ n: number }>('SELECT COUNT(*) AS n FROM federation_outbox')?.n ?? 0;
  }

  outboxDelivered(id: string): void {
    this.#run('DELETE FROM federation_outbox WHERE id = ?', [id]);
  }

  outboxRetry(id: string, nextAt: string): void {
    this.#run('UPDATE federation_outbox SET attempts = attempts + 1, next_at = ? WHERE id = ?', [
      nextAt,
      id,
    ]);
  }
}
