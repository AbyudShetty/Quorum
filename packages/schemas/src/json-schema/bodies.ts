// Body schemas for the ten quorum/1 message types (MESSAGE_SPEC §5).
// Unknown fields are allowed and ignored (forward compatibility, MESSAGE_SPEC §2.1.4).
import { common, LIMITS, NAME, ULID } from './common.js';

export const MESSAGE_TYPES = [
  'note',
  'request',
  'task_update',
  'finding',
  'retraction',
  'artifact_ready',
  'lease',
  'approval_request',
  'approval_decision',
  'heartbeat',
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

export const bodySchemaId = (type: MessageType): string => `urn:quorum:schema:body:${type}:1`;

const shortText = (max: number) => ({ type: 'string', minLength: 1, maxLength: max }) as const;
const stringList = (maxItems: number, maxLength: number) =>
  ({ type: 'array', maxItems, items: shortText(maxLength) }) as const;

/** Relative path inside an attachment root: no absolute paths, drive letters or ".." segments (INV-27). */
const RELATIVE_PATH = '^(?![\\\\/])(?![A-Za-z]:)(?!(?:.*[\\\\/])?\\.\\.(?:[\\\\/]|$)).+$';

/** Lease resources (MESSAGE_SPEC §5.7). */
const LEASE_RESOURCE =
  `^(?:gpu:${NAME}/[0-9]{1,3}` +
  `|ram:${NAME}` +
  `|path:rp_${ULID}/.+` +
  `|worktree:wt_${ULID}` +
  `|dataset:[A-Za-z0-9][A-Za-z0-9._-]{0,127}` +
  `|slot:[a-z][a-z0-9_-]{0,63})$`;

/** Policy action names: dotted lowercase segments (POLICY_SPEC §3). */
export const ACTION_NAME = '^[a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]*)*$';

const metricValue = {
  oneOf: [
    { type: 'number' },
    {
      type: 'object',
      required: ['value'],
      properties: {
        value: { type: 'number' },
        unit: shortText(32),
        ci95: {
          type: 'array',
          prefixItems: [{ type: 'number' }, { type: 'number' }],
          minItems: 2,
          maxItems: 2,
        },
        baseline: { type: 'number' },
      },
    },
  ],
} as const;

const body = (type: MessageType, schema: Record<string, unknown>) => ({
  $id: bodySchemaId(type),
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: `quorum/1 ${type} body`,
  type: 'object',
  ...schema,
});

export const bodySchemas = {
  note: body('note', {
    required: ['text'],
    properties: { text: common('text') },
  }),

  request: body('request', {
    required: ['title', 'description', 'expected_outputs'],
    properties: {
      title: shortText(200),
      description: { type: 'string', maxLength: LIMITS.stringMaxChars },
      inputs: {
        type: 'array',
        maxItems: 64,
        items: { anyOf: [common('ref'), shortText(2000)] },
      },
      expected_outputs: { type: 'array', minItems: 1, maxItems: 32, items: shortText(2000) },
      deadline: common('timestamp'),
      priority: { enum: ['low', 'normal', 'high'], default: 'normal' },
    },
  }),

  task_update: body('task_update', {
    required: ['task_id', 'status'],
    properties: {
      task_id: common('taskId'),
      // `requested` is set by the server when a request arrives; clients move tasks on from there.
      status: { enum: ['accepted', 'declined', 'running', 'blocked', 'done', 'failed'] },
      eta: common('timestamp'),
      progress: { type: 'number', minimum: 0, maximum: 1 },
      note: shortText(4096),
    },
    // A blocked task must say why (MESSAGE_SPEC §5.3).
    if: { required: ['status'], properties: { status: { const: 'blocked' } } },
    then: { required: ['note'] },
  }),

  finding: body('finding', {
    required: ['claim', 'method', 'confidence'],
    properties: {
      claim: shortText(2000),
      method: shortText(LIMITS.stringMaxChars),
      metrics: {
        type: 'object',
        maxProperties: 64,
        propertyNames: { pattern: '^[A-Za-z][A-Za-z0-9_.@-]{0,63}$' },
        additionalProperties: metricValue,
      },
      sample_size: { type: 'integer', minimum: 0 },
      data_refs: common('refList'),
      reproduce: shortText(4096),
      confidence: { enum: ['low', 'medium', 'high'] },
      caveats: stringList(32, 2000),
    },
    // INV-16: a method plus at least one of non-empty metrics or a reproduce command.
    if: {
      not: { required: ['metrics'], properties: { metrics: { type: 'object', minProperties: 1 } } },
    },
    then: { required: ['reproduce'] },
  }),

  retraction: body('retraction', {
    required: ['finding_id', 'reason'],
    properties: {
      finding_id: common('findingId'),
      reason: shortText(4000),
      new_evidence: {
        anyOf: [common('refList'), { $ref: bodySchemaId('finding') }],
      },
    },
  }),

  artifact_ready: body('artifact_ready', {
    required: ['artifact_id', 'version', 'sha256', 'size', 'storage', 'how_to_use'],
    properties: {
      artifact_id: common('artifactId'),
      version: { type: 'integer', minimum: 1 },
      sha256: common('sha256'),
      size: { type: 'integer', minimum: 0 },
      storage: { enum: ['stored', 'local_ref', 'local_only'] },
      location: {
        type: 'object',
        required: ['machine', 'attachment', 'path'],
        properties: {
          machine: common('name'),
          attachment: common('attachmentId'),
          path: { type: 'string', minLength: 1, maxLength: 4096, pattern: RELATIVE_PATH },
        },
      },
      schema: shortText(4096),
      how_to_use: shortText(4096),
    },
    if: { required: ['storage'], properties: { storage: { const: 'local_ref' } } },
    then: { required: ['location'] },
  }),

  lease: body('lease', {
    required: ['resource', 'action', 'reason'],
    properties: {
      resource: { type: 'string', maxLength: 512, pattern: LEASE_RESOURCE },
      action: { enum: ['acquire', 'renew', 'release'] },
      mode: { enum: ['exclusive', 'shared'], default: 'exclusive' },
      amount: { type: 'string', pattern: '^[1-9][0-9]{0,9}(?:KiB|MiB|GiB|TiB)$' },
      until: common('timestamp'),
      reason: shortText(500),
      lease_id: common('leaseId'),
    },
    allOf: [
      {
        if: { required: ['action'], properties: { action: { enum: ['renew', 'release'] } } },
        then: { required: ['lease_id'] },
      },
      {
        if: { required: ['action'], properties: { action: { enum: ['acquire', 'renew'] } } },
        then: { required: ['until'] },
      },
    ],
  }),

  approval_request: body('approval_request', {
    required: ['action', 'summary', 'risk', 'evidence_refs', 'diff_or_preview'],
    properties: {
      action: { type: 'string', maxLength: 128, pattern: ACTION_NAME },
      summary: shortText(2000),
      risk: common('risk'),
      evidence_refs: common('refList'),
      // Inline text, or an artifact ref when the preview is too large for the body limit.
      diff_or_preview: { type: 'string', minLength: 1 },
      rollback_plan: shortText(LIMITS.stringMaxChars),
      supersedes: common('approvalId'),
    },
    // The server may raise the risk from policy and then require a rollback plan too.
    if: { required: ['risk'], properties: { risk: { enum: ['medium', 'high', 'critical'] } } },
    then: { required: ['rollback_plan'] },
  }),

  approval_decision: body('approval_decision', {
    required: ['request_id', 'decision', 'preview_hash'],
    properties: {
      request_id: common('approvalId'),
      decision: { enum: ['approve', 'reject', 'close'] },
      preview_hash: common('sha256'),
      comment: shortText(4000),
    },
    // A rejection must explain itself (POLICY_SPEC §4.1).
    if: { required: ['decision'], properties: { decision: { const: 'reject' } } },
    then: { required: ['comment'] },
  }),

  heartbeat: body('heartbeat', {
    required: ['status', 'resources_in_use'],
    properties: {
      status: { enum: ['idle', 'working', 'blocked', 'offline'] },
      current_task: common('taskId'),
      resources_in_use: {
        type: 'array',
        maxItems: 64,
        uniqueItems: true,
        items: common('leaseId'),
      },
    },
  }),
} satisfies Record<MessageType, Record<string, unknown>>;
