export {
  checkPrivate,
  defaultDataDir,
  ensurePrivateDir,
  type PrivacyCheck,
  writePrivateFile,
} from './local/data-dir.js';
export {
  discoveryPath,
  readDiscovery,
  removeDiscovery,
  writeDiscovery,
} from './local/discovery.js';
export { loadOrCreateInstance, type ServerInstance } from './local/instance.js';
export { checkLocalRequest, localHosts, type RequestFacts } from './local/request-guard.js';
export {
  acquireStartLock,
  isProcessAlive,
  type LockAttempt,
  lockPath,
  type StartLock,
} from './local/start-lock.js';
export { type Db, openDatabase, SCHEMA_VERSION } from './storage/database.js';
export { SqliteEventStore } from './storage/sqlite-event-store.js';
