// SQLite setup and schema migrations (ARCHITECTURE §4).
import Database from 'better-sqlite3';

export type Db = Database.Database;

/**
 * Schema migrations, applied in order and recorded in `PRAGMA user_version`.
 * Never edit a released migration; append a new one.
 */
const MIGRATIONS: readonly string[] = [
  // 1: the append-only, hash-chained event log (INV-8).
  `
  CREATE TABLE events (
    workspace TEXT NOT NULL,
    seq       INTEGER NOT NULL CHECK (seq >= 1),
    ev_id     TEXT NOT NULL UNIQUE,
    ts        TEXT NOT NULL,
    actor     TEXT NOT NULL,
    kind      TEXT NOT NULL,
    payload   TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    hash      TEXT NOT NULL,
    PRIMARY KEY (workspace, seq)
  ) STRICT, WITHOUT ROWID;

  -- History can only grow: the database itself refuses edits and deletions.
  CREATE TRIGGER events_no_update BEFORE UPDATE ON events
    BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  CREATE TRIGGER events_no_delete BEFORE DELETE ON events
    BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  `,
  // 2: the registry: who exists, what is attached, and credentials (ARCHITECTURE §3, §6, §12).
  // Not rebuildable from the log on purpose: it holds token hashes, which never go into events
  // (INV-11). Every change to it is also recorded as an event in each affected workspace (INV-8).
  `
  CREATE TABLE humans (
    id         TEXT PRIMARY KEY,
    address    TEXT NOT NULL UNIQUE,
    is_owner   INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1)),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE workspaces (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL REFERENCES humans (id),
    created_at TEXT NOT NULL
  ) STRICT;

  -- status: active; retired (detached, can be re-attached); revoked (only a human undoes it).
  CREATE TABLE agents (
    id         TEXT PRIMARY KEY,
    address    TEXT NOT NULL UNIQUE,
    vendor     TEXT NOT NULL,
    owner      TEXT NOT NULL REFERENCES humans (id),
    folder     TEXT,
    status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired', 'revoked')),
    created_at TEXT NOT NULL
  ) STRICT;

  -- principal: a hu_ or ag_ id.
  CREATE TABLE members (
    workspace TEXT NOT NULL REFERENCES workspaces (id),
    principal TEXT NOT NULL,
    PRIMARY KEY (workspace, principal)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX members_principal ON members (principal);

  CREATE TABLE attachments (
    id                TEXT PRIMARY KEY,
    agent             TEXT NOT NULL REFERENCES agents (id),
    owner             TEXT NOT NULL REFERENCES humans (id),
    root              TEXT NOT NULL,
    root_key          TEXT NOT NULL,
    vendor            TEXT NOT NULL,
    wake              TEXT NOT NULL CHECK (wake IN ('off', 'direct', 'all')),
    wake_types        TEXT,
    lease_enforcement TEXT NOT NULL CHECK (lease_enforcement IN ('warn', 'block')),
    created_at        TEXT NOT NULL,
    detached_at       TEXT
  ) STRICT;
  CREATE INDEX attachments_root ON attachments (root_key, vendor);

  -- Only hashes (INV-11). A family is one login or attach; rotation stays in the family.
  CREATE TABLE tokens (
    hash       TEXT PRIMARY KEY,
    kind       TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    principal  TEXT NOT NULL,
    family     TEXT NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('active', 'rotated', 'revoked')),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX tokens_family ON tokens (family);
  CREATE INDEX tokens_principal ON tokens (principal);

  CREATE TABLE sessions (
    id                TEXT PRIMARY KEY,
    agent             TEXT NOT NULL REFERENCES agents (id),
    vendor_session_id TEXT NOT NULL,
    worktree_key      TEXT NOT NULL,
    repo              TEXT,
    worktree          TEXT,
    started_at        TEXT NOT NULL,
    ended_at          TEXT
  ) STRICT;
  CREATE INDEX sessions_open ON sessions (ended_at, worktree_key);

  -- Stable rp_/wt_ ids per canonical path key (ARCHITECTURE §13).
  CREATE TABLE path_ids (
    kind TEXT NOT NULL CHECK (kind IN ('repository', 'worktree')),
    key  TEXT NOT NULL,
    id   TEXT NOT NULL UNIQUE,
    PRIMARY KEY (kind, key)
  ) STRICT, WITHOUT ROWID;
  `,
  // 3: numbered sessions (MESSAGE_SPEC §1.1): each window of an agent gets a label such as
  // claude@api-1, numbered per tool, machine and folder.
  `
  ALTER TABLE sessions ADD COLUMN label TEXT;
  ALTER TABLE sessions ADD COLUMN machine TEXT;
  ALTER TABLE sessions ADD COLUMN label_group TEXT;
  CREATE INDEX sessions_label ON sessions (ended_at, label_group);
  `,
  // 4: the window's folder as shown in messages (home folder as ~, so usernames don't travel).
  `
  ALTER TABLE sessions ADD COLUMN display_root TEXT;
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

const migrate = (db: Db): void => {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > SCHEMA_VERSION) {
    // Fail closed: never run against a database written by a newer Quorum.
    throw new Error(
      `the database schema is version ${String(current)}, newer than this Quorum supports (${String(SCHEMA_VERSION)}). Upgrade Quorum.`,
    );
  }
  for (let version = current; version < SCHEMA_VERSION; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version] ?? '');
      db.pragma(`user_version = ${String(version + 1)}`);
    })();
  }
};

/**
 * Open (or create) a Quorum database. WAL with synchronous=FULL: a committed event survives
 * a crash or power loss, and readers never block the single writer.
 */
export const openDatabase = (file: string): Db => {
  const db = new Database(file);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    migrate(db);
    return db;
  } catch (error) {
    db.close(); // don't leak the file handle when refusing to open
    throw error;
  }
};
