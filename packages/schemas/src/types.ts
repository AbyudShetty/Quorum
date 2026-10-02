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
