// Local-mode building blocks now live in @quorum/local (no database, so adapters and the CLI can
// use them). Re-exported here so existing `@quorum/server` imports keep working.
export {
  acquireStartLock,
  bootstrapPath,
  checkPrivate,
  defaultDataDir,
  discoveryPath,
  ensurePrivateDir,
  isProcessAlive,
  type LockAttempt,
  lockPath,
  type PrivacyCheck,
  readBootstrapCode,
  readDiscovery,
  removeBootstrapCode,
  removeDiscovery,
  type StartLock,
  writeBootstrapCode,
  writeDiscovery,
  writePrivateFile,
} from '@quorum/local';
export { LocalBootstrap, type LocalBootstrapOptions } from './local/bootstrap.js';
export { loadOrCreateInstance, type ServerInstance } from './local/instance.js';
export { checkLocalRequest, localHosts, type RequestFacts } from './local/request-guard.js';
export { type Db, openDatabase, SCHEMA_VERSION } from './storage/database.js';
export { SqliteEventStore } from './storage/sqlite-event-store.js';
