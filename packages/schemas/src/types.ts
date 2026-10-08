// TypeScript view of the quorum/1 schemas. The JSON Schemas are the source of truth;
// test/types.test.ts checks typed fixtures against them so the two cannot drift silently.
import type { MessageType } from './json-schema/bodies.js';

export type { MessageType };

/** e.g. "agent:claude-api@laptop-a" or "human:abyud". */
export type SenderAddress = string;
/** A sender address or "*" (everyone in the workspace). */
export type RecipientAddress = string;
/** e.g. "finding:fd_…" or "artifact:art_…@v3". */
export type Ref = string;
/** RFC 3339 date-time. */
export type Timestamp = string;
export type Risk = 'low' | 'medium' | 'high' | 'critical';

export interface NoteBody {
  text: string;
}

export interface RequestBody {
  title: string;
  description: string;
  /** Refs (e.g. "artifact:art_…@v3") or short free-text descriptions. */
  inputs?: string[];
  expected_outputs: string[];
  deadline?: Timestamp;
  priority?: 'low' | 'normal' | 'high';
}

export interface TaskUpdateBody {
  task_id: string;
  status: 'accepted' | 'declined' | 'running' | 'blocked' | 'done' | 'failed';
  eta?: Timestamp;
  progress?: number;
  note?: string;
}

export type MetricValue =
  number | { value: number; unit?: string; ci95?: [number, number]; baseline?: number };

export interface FindingBody {
  claim: string;
  method: string;
  metrics?: Record<string, MetricValue>;
  sample_size?: number;
  data_refs?: Ref[];
  reproduce?: string;
  confidence: 'low' | 'medium' | 'high';
  caveats?: string[];
}

export interface RetractionBody {
  finding_id: string;
  reason: string;
  new_evidence?: Ref[] | FindingBody;
}

export interface ArtifactReadyBody {
  artifact_id: string;
  version: number;
  sha256: string;
  size: number;
  storage: 'stored' | 'local_ref' | 'local_only';
  location?: { machine: string; attachment: string; path: string };
  schema?: string;
  how_to_use: string;
}

export interface LeaseBody {
  resource: string;
  action: 'acquire' | 'renew' | 'release';
  mode?: 'exclusive' | 'shared';
  amount?: string;
  until?: Timestamp;
  reason: string;
  lease_id?: string;
}

export interface ApprovalRequestBody {
  action: string;
  summary: string;
  risk: Risk;
  evidence_refs: Ref[];
  diff_or_preview: string;
  rollback_plan?: string;
  supersedes?: string;
}

export interface ApprovalDecisionBody {
  request_id: string;
  decision: 'approve' | 'reject' | 'close';
  preview_hash: string;
  comment?: string;
}

export interface HeartbeatBody {
  status: 'idle' | 'working' | 'blocked' | 'offline';
  current_task?: string;
  resources_in_use: string[];
}

export interface BodyByType {
  note: NoteBody;
  request: RequestBody;
  task_update: TaskUpdateBody;
  finding: FindingBody;
  retraction: RetractionBody;
  artifact_ready: ArtifactReadyBody;
  lease: LeaseBody;
  approval_request: ApprovalRequestBody;
  approval_decision: ApprovalDecisionBody;
  heartbeat: HeartbeatBody;
}

interface EnvelopeBase<T extends MessageType> {
  spec: 'quorum/1';
  id: string;
  workspace: string;
  thread?: string;
  from: SenderAddress;
  to: RecipientAddress[];
  type: T;
  type_version: number;
  created_at: Timestamp;
  reply_to?: string;
  body: BodyByType[T];
  refs?: Ref[];
  signature?: string;
}

/** What a client sends. */
export type SubmittedEnvelope = { [T in MessageType]: EnvelopeBase<T> }[MessageType];

/** Server-assigned fields added on acceptance (MESSAGE_SPEC §2). */
export interface ServerFields {
  seq: number;
  received_at: Timestamp;
  event: string;
  flags?: string[];
  /** The sending window, stamped by the server (MESSAGE_SPEC §1.1). */
  from_session?: { id: string; label: string; machine: string; path?: string };
  /** Agents reached through a session label in `to`. */
  delivered_to?: string[];
  /** Sessions named by session labels in `to`: only those windows see the message. */
  to_sessions?: string[];
}

/** What a client receives for a type it knows. */
export type DeliveredEnvelope = SubmittedEnvelope & ServerFields;

/** What a client receives for a type it does not know yet: show it as a note. */
export interface UnknownDeliveredEnvelope extends ServerFields {
  spec: 'quorum/1';
  id: string;
  workspace: string;
  from: string;
  to: RecipientAddress[];
  type: string;
  type_version: number;
  created_at: Timestamp;
  body: Record<string, unknown>;
}

export interface ErrorResponse {
  error: { code: string; message: string; path?: string; fix: string };
}

export interface PolicyRule {
  gated?: boolean;
  risk?: Risk;
  quorum?: number;
  approvers?: string[];
  independent_approver?: boolean;
  veto?: boolean;
  approval_expiry?: string;
  grant_ttl?: string;
  ungated_reason?: string;
}

export interface AgentScope {
  message_types?: Exclude<MessageType, 'approval_decision'>[];
  artifacts?: 'none' | 'read-only' | 'read-write';
}

export interface PolicyV1 {
  version: 1;
  defaults?: {
    approval_expiry?: string;
    grant_ttl?: string;
    quorum?: number;
    independent_approver?: boolean;
    veto?: boolean;
    user_verification_from?: 'low' | 'medium' | 'high';
    approval_required_from?: Risk;
  };
  humans?: Record<string, { roles: string[] }>;
  agents?: { default_scope?: AgentScope; overrides?: Record<string, AgentScope> };
  actions?: Record<string, PolicyRule>;
  limits?: {
    messages_per_minute?: number;
    approval_requests_per_hour?: number;
    max_lease_ttl?: string;
    workspace_disk?: string;
    max_upload?: string;
    wakes_per_hour?: number;
    agent_only_messages_before_pause?: number;
  };
}

// ---------- /v1 API payloads (src/json-schema/api.ts, src/openapi.ts) ----------

export type Vendor = 'claude-code' | 'codex' | 'gemini-cli' | 'opencode' | 'generic';
export type WakeMode = 'off' | 'direct' | 'all';

export interface Health {
  status: 'ok';
  spec: 'quorum/1';
  version: string;
  instance_id: string;
}

export interface HelloRequest {
  /** 32 random bytes, base64url. */
  nonce: string;
}

export interface HelloResponse {
  instance_id: string;
  /** Ed25519 public key, base64url. */
  public_key: string;
  /** Ed25519 signature of "quorum/1 hello\n" + instance_id + "\n" + nonce, base64url. */
  signature: string;
}

export interface TokenRefreshRequest {
  refresh_token: string;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_expires_in: number;
}

export interface WorkspaceCreate {
  name: string;
}

export interface Workspace {
  id: string;
  name: string;
  created_at: Timestamp;
}

export interface WorkspaceList {
  workspaces: Workspace[];
}

export interface AttachmentCreate {
  root: string;
  vendor: Vendor;
  workspaces: string[];
  agent_name?: string;
  new_identity?: boolean;
  wake?: WakeMode;
  wake_types?: MessageType[];
  lease_enforcement?: 'warn' | 'block';
}

export interface AgentRef {
  id: string;
  address: string;
}

export interface Attachment {
  id: string;
  root: string;
  vendor: Vendor;
  workspaces: string[];
  wake: WakeMode;
  wake_types?: MessageType[];
  lease_enforcement: 'warn' | 'block';
}

/** PATCH /v1/attachments/{id}: only the fields to change. */
export interface AttachmentUpdate {
  wake?: WakeMode;
  wake_types?: MessageType[];
  lease_enforcement?: 'warn' | 'block';
}

export interface AttachmentCreated {
  attachment: Attachment;
  agent: AgentRef;
  credentials: TokenPair;
}

/** POST /v1/auth/local-bootstrap (local mode only). */
export interface LocalBootstrapRequest {
  /** The one-time code from the private data directory (qrm_bc_…). */
  code: string;
}

export interface LocalBootstrapResponse {
  human: { id: string; address: string };
  credentials: TokenPair;
}

export interface UiLink {
  code: string;
  path: string;
  expires_in: number;
}

export interface SessionCreate {
  vendor_session_id: string;
  root: string;
  /** How the folder is shown to others: the home folder as ~. */
  display_root?: string;
  git?: { common_dir: string; worktree_root: string };
}

export interface SessionCreated {
  session_id: string;
  agent: AgentRef;
  repo?: string;
  worktree?: string;
  shared_worktree_with: string[];
  /** This window's label, e.g. `claude@api-1`. */
  label?: string;
  machine?: string;
}

export interface MessageAccepted {
  id: string;
  seq: number;
  received_at: Timestamp;
  event: string;
  flags?: string[];
}

export interface InboxPage {
  messages: (DeliveredEnvelope | UnknownDeliveredEnvelope)[];
  next_after: number;
  has_more: boolean;
}

export interface AckRequest {
  up_to: number;
}

export interface AgentList {
  agents: {
    id: string;
    address: string;
    vendor: Vendor;
    /** Folder name only (e.g. "api"), never a full path. */
    folder?: string;
    presence: 'online' | 'offline';
    status?: 'idle' | 'working' | 'blocked' | 'offline';
    current_task?: string;
    last_seen?: Timestamp;
  }[];
}

/** POST /v1/workspaces/{ws}/wake (agents): may new mail wake or continue me? (INV-29) */
export interface WakeRequest {
  /** Consider messages after this seq; default: after the caller's last ack. */
  after?: number;
}

export type WakeDenial =
  | 'no_mail'
  | 'mode_off'
  | 'own_message'
  | 'not_direct'
  | 'type_filtered'
  | 'thread_paused'
  | 'budget_exhausted';

export interface WakeDecision {
  wake: boolean;
  reason?: WakeDenial;
  message?: string;
  seq?: number;
}

/** Local mode discovery file: how adapters find the local server and which key to pin. */
export interface LocalDiscovery {
  instance_id: string;
  pid: number;
  port: number;
  /** Ed25519 public key, base64url (pin this, INV-24). */
  public_key: string;
  version: string;
  started_at: Timestamp;
}

/**
 * Local mode bootstrap code file `<data dir>/local/bootstrap.json`: written by the local server on
 * each start, read by the CLI and exchanged at POST /v1/auth/local-bootstrap. Secret; the data
 * directory is private (INV-25). Removed once used or expired.
 */
export interface LocalBootstrapFile {
  /** `qrm_bc_…`, single use. */
  code: string;
  expires_at: Timestamp;
}

/** One line of `quorum export`. */
export interface EventRecord {
  ev_id: string;
  workspace: string;
  seq: number;
  ts: Timestamp;
  actor: string;
  kind: string;
  payload: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

export interface ApiPayloads {
  health: Health;
  helloRequest: HelloRequest;
  helloResponse: HelloResponse;
  tokenRefreshRequest: TokenRefreshRequest;
  tokenPair: TokenPair;
  localBootstrapRequest: LocalBootstrapRequest;
  localBootstrapResponse: LocalBootstrapResponse;
  uiLink: UiLink;
  workspaceCreate: WorkspaceCreate;
  workspace: Workspace;
  workspaceList: WorkspaceList;
  attachmentCreate: AttachmentCreate;
  attachment: Attachment;
  attachmentUpdate: AttachmentUpdate;
  attachmentCreated: AttachmentCreated;
  agentRef: AgentRef;
  sessionCreate: SessionCreate;
  sessionCreated: SessionCreated;
  messageAccepted: MessageAccepted;
  inboxPage: InboxPage;
  ackRequest: AckRequest;
  wakeRequest: WakeRequest;
  wakeDecision: WakeDecision;
  agentList: AgentList;
  localDiscovery: LocalDiscovery;
  localBootstrapFile: LocalBootstrapFile;
  event: EventRecord;
}
