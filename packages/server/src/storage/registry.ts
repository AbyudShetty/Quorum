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
      'INSERT INTO agents (id, address, vendor, owner, folder, status, created_at) VALUES (@id, @address, @vendor, @owner, @folder, @status, @created_at)',
      { ...row },
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
      `INSERT INTO sessions (id, agent, vendor_session_id, worktree_key, repo, worktree, started_at, ended_at)
       VALUES (@id, @agent, @vendor_session_id, @worktree_key, @repo, @worktree, @started_at, @ended_at)`,
      { ...row },
    );
  }

  endSession(id: string, at: string): void {
    this.#run('UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL', [at, id]);
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
}
