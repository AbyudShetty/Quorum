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
