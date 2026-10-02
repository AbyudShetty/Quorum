// Request/response payloads of the /v1 HTTP API (ARCHITECTURE §5–§6, §8.2, §12–§13).
// Message bodies and envelopes live in their own schemas; this file covers everything else.
import { MESSAGE_TYPES } from './bodies.js';
import { common, ULID } from './common.js';
import { DELIVERED_ENVELOPE_ID } from './envelope.js';

const apiId = (name: string): string => `urn:quorum:schema:api:${name}:1`;

/** base64url without padding, of an exact byte length. */
const base64url = (bytes: number) =>
  ({ type: 'string', pattern: `^[A-Za-z0-9_-]{${String(Math.ceil((bytes * 4) / 3))}}$` }) as const;

/** An absolute path on Windows ("C:\…", "\\server\…") or POSIX ("/…"). */
const absolutePath = {
  type: 'string',
  minLength: 1,
  maxLength: 4096,
  pattern: '^(?:[A-Za-z]:[\\\\/]|/|\\\\\\\\)',
} as const;

export const VENDORS = ['claude-code', 'codex', 'gemini-cli', 'opencode', 'generic'] as const;

const schema = (name: string, body: Record<string, unknown>) => ({
  $id: apiId(name),
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: `quorum/1 API ${name}`,
  ...body,
});

const tokenPair = {
  type: 'object',
  required: ['access_token', 'refresh_token', 'token_type', 'expires_in', 'refresh_expires_in'],
  properties: {
    access_token: { type: 'string', minLength: 32, maxLength: 512 },
    refresh_token: { type: 'string', minLength: 32, maxLength: 512 },
    token_type: { const: 'Bearer' },
    expires_in: { type: 'integer', minimum: 1 },
    refresh_expires_in: { type: 'integer', minimum: 1 },
  },
} as const;

export const apiSchemas = {
  health: schema('health', {
    type: 'object',
    required: ['status', 'spec', 'version', 'instance_id'],
    properties: {
      status: { const: 'ok' },
      spec: { const: 'quorum/1' },
      version: { type: 'string', minLength: 1, maxLength: 64 },
      instance_id: { type: 'string', pattern: `^${ULID}$` },
    },
  }),

  /**
   * Server identity handshake (INV-24). The server signs, with its Ed25519 instance key, the
   * UTF-8 bytes of: "quorum/1 hello\n" + instance_id + "\n" + nonce. Clients check the
   * signature against the public key they pinned before sending any credential.
   */
  helloRequest: schema('hello-request', {
    type: 'object',
    required: ['nonce'],
    properties: { nonce: base64url(32) },
  }),
  helloResponse: schema('hello-response', {
    type: 'object',
    required: ['instance_id', 'public_key', 'signature'],
    properties: {
      instance_id: { type: 'string', pattern: `^${ULID}$` },
      public_key: base64url(32),
      signature: base64url(64),
    },
  }),

  tokenRefreshRequest: schema('token-refresh-request', {
    type: 'object',
    required: ['refresh_token'],
    properties: { refresh_token: { type: 'string', minLength: 32, maxLength: 512 } },
  }),
  tokenPair: schema('token-pair', tokenPair),

  workspaceCreate: schema('workspace-create', {
    type: 'object',
    required: ['name'],
    properties: { name: common('name') },
  }),
  workspace: schema('workspace', {
    type: 'object',
    required: ['id', 'name', 'created_at'],
    properties: {
      id: common('workspaceId'),
      name: common('name'),
      created_at: common('timestamp'),
    },
  }),
  workspaceList: schema('workspace-list', {
    type: 'object',
    required: ['workspaces'],
    properties: { workspaces: { type: 'array', items: { $ref: apiId('workspace') } } },
  }),

  /** `quorum attach` (run by a human): bind a folder for one vendor to workspaces (ARCHITECTURE §12). */
  attachmentCreate: schema('attachment-create', {
    type: 'object',
    required: ['root', 'vendor', 'workspaces'],
    properties: {
      root: absolutePath,
      vendor: { enum: [...VENDORS] },
      workspaces: {
        type: 'array',
        minItems: 1,
        maxItems: 32,
        uniqueItems: true,
        items: common('workspaceId'),
      },
      agent_name: common('name'),
      new_identity: { type: 'boolean', default: false },
      wake: { enum: ['off', 'direct', 'all'], default: 'off' },
      wake_types: { type: 'array', uniqueItems: true, items: { enum: [...MESSAGE_TYPES] } },
      lease_enforcement: { enum: ['warn', 'block'], default: 'warn' },
    },
  }),
  attachmentCreated: schema('attachment-created', {
    type: 'object',
    required: ['attachment', 'agent', 'credentials'],
    properties: {
      attachment: {
        type: 'object',
        required: ['id', 'root', 'vendor', 'workspaces', 'wake', 'lease_enforcement'],
        properties: {
          id: common('attachmentId'),
          root: absolutePath,
          vendor: { enum: [...VENDORS] },
          workspaces: { type: 'array', items: common('workspaceId') },
          wake: { enum: ['off', 'direct', 'all'] },
          lease_enforcement: { enum: ['warn', 'block'] },
        },
      },
      agent: { $ref: apiId('agent-ref') },
      /** Shown once; the CLI stores them in the OS keychain (INV-11, INV-25). */
      credentials: tokenPair,
    },
  }),
  agentRef: schema('agent-ref', {
    type: 'object',
    required: ['id', 'address'],
    properties: { id: common('agentId'), address: common('agentAddress') },
  }),

  /** An adapter registers each vendor session (MESSAGE_SPEC §4, ARCHITECTURE §12–§13). */
  sessionCreate: schema('session-create', {
    type: 'object',
    required: ['vendor_session_id', 'root'],
    properties: {
      vendor_session_id: { type: 'string', minLength: 1, maxLength: 256 },
      root: absolutePath,
      git: {
        type: 'object',
        required: ['common_dir', 'worktree_root'],
        properties: { common_dir: absolutePath, worktree_root: absolutePath },
      },
    },
  }),
  sessionCreated: schema('session-created', {
    type: 'object',
    required: ['session_id', 'agent', 'shared_worktree_with'],
    properties: {
      session_id: common('sessionId'),
      agent: { $ref: apiId('agent-ref') },
      /** Server-assigned, stable per canonical git common directory / worktree root. */
      repo: common('repositoryId'),
      worktree: common('worktreeId'),
      /** Other live agents in the same working tree (INV-28); empty when alone. */
      shared_worktree_with: { type: 'array', items: common('agentAddress') },
    },
  }),

  messageAccepted: schema('message-accepted', {
    type: 'object',
    required: ['id', 'seq', 'received_at', 'event'],
    properties: {
      id: common('messageId'),
      seq: { type: 'integer', minimum: 1 },
      received_at: common('timestamp'),
      event: common('eventId'),
      flags: { type: 'array', items: { type: 'string' } },
    },
  }),
  inboxPage: schema('inbox-page', {
    type: 'object',
    required: ['messages', 'next_after', 'has_more'],
    properties: {
      messages: { type: 'array', items: { $ref: DELIVERED_ENVELOPE_ID } },
      /** Pass as `after` to get the next page; equals the last returned seq (or the input). */
      next_after: { type: 'integer', minimum: 0 },
      has_more: { type: 'boolean' },
    },
  }),
  ackRequest: schema('ack-request', {
    type: 'object',
    required: ['up_to'],
    properties: { up_to: { type: 'integer', minimum: 0 } },
  }),

  agentList: schema('agent-list', {
    type: 'object',
    required: ['agents'],
    properties: {
      agents: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'address', 'vendor', 'presence'],
          properties: {
            id: common('agentId'),
            address: common('agentAddress'),
            vendor: { enum: [...VENDORS] },
            presence: { enum: ['online', 'offline'] },
            status: { enum: ['idle', 'working', 'blocked', 'offline'] },
            current_task: common('taskId'),
            last_seen: common('timestamp'),
          },
        },
      },
    },
  }),

  /**
   * Local mode discovery file `<data dir>/local/server.json` (ARCHITECTURE §8.2). Not an HTTP
   * payload, but part of the contract: adapters and the CLI read it to find the local server and
   * the key to pin. It holds no secrets; the data directory is private (INV-25).
   */
  localDiscovery: schema('local-discovery', {
    type: 'object',
    required: ['instance_id', 'pid', 'port', 'public_key', 'version', 'started_at'],
    properties: {
      instance_id: { type: 'string', pattern: `^${ULID}$` },
      pid: { type: 'integer', minimum: 1 },
      port: { type: 'integer', minimum: 1, maximum: 65535 },
      public_key: base64url(32),
      version: { type: 'string', minLength: 1, maxLength: 64 },
      started_at: common('timestamp'),
    },
  }),

  /** One line of `quorum export` (JSONL); the hash chain from ARCHITECTURE §3 and INV-8. */
  event: schema('event', {
    type: 'object',
    required: ['ev_id', 'workspace', 'seq', 'ts', 'actor', 'kind', 'payload', 'prev_hash', 'hash'],
    properties: {
      ev_id: common('eventId'),
      workspace: common('workspaceId'),
      seq: { type: 'integer', minimum: 1 },
      ts: common('timestamp'),
      actor: {
        anyOf: [common('agentAddress'), common('humanAddress'), common('systemAddress')],
      },
      kind: { type: 'string', pattern: '^[a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]*)*$' },
      payload: { type: 'object' },
      prev_hash: common('sha256'),
      hash: common('sha256'),
    },
  }),
} as const;

export const API_SCHEMA_IDS = Object.fromEntries(
  Object.entries(apiSchemas).map(([key, value]) => [key, value.$id]),
) as { [K in keyof typeof apiSchemas]: string };
