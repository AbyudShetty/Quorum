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
export { type AppOptions, buildApp, MAX_REQUEST_BYTES } from './http/app.js';
export {
  addressName,
  AlreadyRunningError,
  type LocalServer,
  type LocalServerOptions,
  SERVER_VERSION,
  startLocalServer,
} from './local/serve.js';
export {
  type Caller,
  HEARTBEAT_INTERVAL_MS,
  Quorum,
  type QuorumOptions,
  SYSTEM_CHAIN,
} from './service/quorum.js';
export { Registry } from './storage/registry.js';
export { localServerCommand, spawnLocalServer } from './local/spawn.js';
