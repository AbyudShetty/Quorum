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

  /**
   * Local mode only: exchange the one-time bootstrap code for the owner's human tokens. The local
   * server writes the code (10-minute expiry, single use) into its private data directory, so only
   * someone who can read that directory (the owning OS user, INV-25) can present it.
   */
  localBootstrapRequest: schema('local-bootstrap-request', {
    type: 'object',
    required: ['code'],
    properties: { code: { type: 'string', pattern: '^qrm_bc_[A-Za-z0-9_-]{43}$' } },
  }),
  localBootstrapResponse: schema('local-bootstrap-response', {
    type: 'object',
    required: ['human', 'credentials'],
    properties: {
      human: {
        type: 'object',
        required: ['id', 'address'],
        properties: { id: common('humanId'), address: common('humanAddress') },
      },
      /** Shown once; the CLI stores them in the OS keychain under "human" (INV-11, INV-25). */
      credentials: tokenPair,
    },
  }),

  /**
   * A one-time web login link for the calling human (`quorum ui`, ARCHITECTURE §6): the code is
   * single use and expires in 60 s; `GET /login?code=…` exchanges it for a session cookie.
   */
  uiLink: schema('ui-link', {
    type: 'object',
    required: ['code', 'path', 'expires_in'],
    properties: {
      code: { type: 'string', pattern: '^qrm_ul_[A-Za-z0-9_-]{43}$' },
      /** Open this path on the server's origin (`http://localhost:<port>` in local mode). */
      path: { type: 'string', pattern: '^/login\\?code=qrm_ul_[A-Za-z0-9_-]{43}$' },
      expires_in: { type: 'integer', minimum: 1, maximum: 600 },
    },
  }),

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
  /** An attachment as the server reports it. */
  attachment: schema('attachment', {
    type: 'object',
    required: ['id', 'root', 'vendor', 'workspaces', 'wake', 'lease_enforcement'],
    properties: {
      id: common('attachmentId'),
      root: absolutePath,
      vendor: { enum: [...VENDORS] },
      workspaces: { type: 'array', items: common('workspaceId') },
      wake: { enum: ['off', 'direct', 'all'] },
      wake_types: { type: 'array', uniqueItems: true, items: { enum: [...MESSAGE_TYPES] } },
      lease_enforcement: { enum: ['warn', 'block'] },
    },
  }),
  /**
   * Change an attachment's per-human settings (ARCHITECTURE §15.2, D-9). Humans only; every change
   * is recorded in the event log. Send only the fields to change; `wake_types: []` clears the filter.
   */
  attachmentUpdate: schema('attachment-update', {
    type: 'object',
    minProperties: 1,
    additionalProperties: false,
    properties: {
      wake: { enum: ['off', 'direct', 'all'] },
      wake_types: { type: 'array', uniqueItems: true, items: { enum: [...MESSAGE_TYPES] } },
      lease_enforcement: { enum: ['warn', 'block'] },
    },
  }),
  attachmentCreated: schema('attachment-created', {
    type: 'object',
    required: ['attachment', 'agent', 'credentials'],
    properties: {
      attachment: { $ref: apiId('attachment') },
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
      /** How the folder is shown to others: the home folder as ~ (MESSAGE_SPEC §1.1). */
      display_root: {
        type: 'string',
        minLength: 1,
        maxLength: 4096,
        pattern: '^[^\\u0000-\\u001f]+$',
      },
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
      /** This window's label, e.g. `claude@api-1` (numbers count up per tool, folder, machine). */
      label: common('sessionLabel'),
      machine: common('name'),
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

  /**
   * An agent's adapter asks whether new mail may wake it or continue its turn (ARCHITECTURE §15.2).
   * The server decides with the attachment's wake mode, the hourly budget and the agent-only-loop
   * pause (INV-29); adapters never decide on their own. A granted wake is recorded in the log.
   */
  wakeRequest: schema('wake-request', {
    type: 'object',
    additionalProperties: false,
    properties: {
      /** Consider messages after this seq. Omitted: after the caller's last acknowledged seq. */
      after: { type: 'integer', minimum: 0 },
    },
  }),
  wakeDecision: schema('wake-decision', {
    type: 'object',
    required: ['wake'],
    properties: {
      wake: { type: 'boolean' },
      /** Why not (only when `wake` is false). */
      reason: {
        enum: [
          'no_mail',
          'mode_off',
          'own_message',
          'not_direct',
          'type_filtered',
          'thread_paused',
          'budget_exhausted',
        ],
      },
      /** The message that justified the wake (only when `wake` is true). */
      message: common('messageId'),
      seq: { type: 'integer', minimum: 1 },
    },
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
            /**
             * Name of the attached folder (e.g. "api"), never a full path, so message headers can
             * show it without leaking home directories (MESSAGE_SPEC §8). Present when known.
             */
            folder: {
              type: 'string',
              minLength: 1,
              maxLength: 255,
              pattern: '^[^\\\\/\\u0000-\\u001f]+$',
            },
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

  /**
   * Local mode bootstrap code file `<data dir>/local/bootstrap.json` (ARCHITECTURE §6). Like the
   * discovery file it is part of the contract: the CLI reads it. Unlike it, it holds a secret, which
   * the private data directory protects (INV-25). The server removes it once used or expired.
   */
  localBootstrapFile: schema('local-bootstrap-file', {
    type: 'object',
    required: ['code', 'expires_at'],
    properties: {
      code: { type: 'string', pattern: '^qrm_bc_[A-Za-z0-9_-]{43}$' },
      expires_at: common('timestamp'),
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
