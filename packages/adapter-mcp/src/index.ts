export {
  type AttachmentInfo,
  loadAttachment,
  removeAttachment,
  saveAttachment,
} from './attachment.js';
export {
  type AgentEntry,
  ApiError,
  type ConnectOptions,
  IdentityError,
  QuorumClient,
  resolveTarget,
  type Target,
  UnreachableError,
} from './client.js';
export {
  type CredentialStore,
  KeychainCredentialStore,
  MemoryCredentialStore,
  type StoredCredentials,
} from './credentials.js';
export { findGit, type GitInfo } from './git.js';
export {
  type FrameOptions,
  frameMessage,
  frameMessages,
  newFrameNonce,
  senderResolver,
  type SenderInfo,
} from './framing.js';
export {
  createQuorumMcpServer,
  INSTRUCTIONS,
  type McpDependencies,
  serveStdio,
} from './mcp-server.js';
export {
  HEARTBEAT_INTERVAL_MS,
  type Heartbeat,
  type HeartbeatOptions,
  type PresenceStatus,
  startHeartbeat,
} from './heartbeat.js';
export {
  type Session,
  sharedWorktreeNotice,
  startSession,
  type StartSessionOptions,
} from './session.js';
export { type FlushResult, Outbox, type QueuedMessage, type SendFn } from './outbox.js';
