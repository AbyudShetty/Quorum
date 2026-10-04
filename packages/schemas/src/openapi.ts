// OpenAPI 3.1 description of the /v1 HTTP API: the contract between the server (Track A)
// and the adapters, CLI and web UI (Track B). Additive changes only within v1 (ARCHITECTURE §5).
// Component schemas keep their `$id`, so the URN references inside them resolve within this document.
import { apiSchemas } from './json-schema/api.js';
import { bodySchemas } from './json-schema/bodies.js';
import { commonSchema } from './json-schema/common.js';
import { deliveredEnvelopeSchema, submittedEnvelopeSchema } from './json-schema/envelope.js';
import { errorResponseSchema } from './json-schema/error.js';
import { policySchema } from './json-schema/policy.js';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schemaName: string) => ({ 'application/json': { schema: ref(schemaName) } });
const errorRef = (name: string) => ({ $ref: `#/components/responses/${name}` });

/** Who may call an operation. Tokens identify the principal; scopes are checked per request (INV-12). */
const agent = [{ agentToken: [] }];
const human = [{ humanToken: [] }];
const agentOrHuman = [{ agentToken: [] }, { humanToken: [] }];
const none: never[] = [];

const authErrors = {
  '401': errorRef('Unauthorized'),
  '403': errorRef('Forbidden'),
  '429': errorRef('TooManyRequests'),
};

const pathParam = (name: string, schemaName: string, description: string) => ({
  name,
  in: 'path',
  required: true,
  description,
  schema: { $ref: `#/components/schemas/Common/$defs/${schemaName}` },
});

const workspaceParam = pathParam('workspace', 'workspaceId', 'Workspace ID (`ws_…`).');

const pageParams = [
  {
    name: 'after',
    in: 'query',
    description: 'Return messages with `seq` greater than this. 0 = from the beginning.',
    schema: { type: 'integer', minimum: 0, default: 0 },
  },
  {
    name: 'limit',
    in: 'query',
    description: 'Page size.',
    schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
  },
];

/** The inbox resumes from the caller's last acknowledgement when `after` is omitted. */
const inboxParams = [
  {
    name: 'after',
    in: 'query',
    description:
      "Return messages with `seq` greater than this. Omitted: start after the caller's last acknowledged `seq` (0 if none), so a restarted client does not replay mail it already acknowledged. `after=0` always starts from the beginning.",
    schema: { type: 'integer', minimum: 0 },
  },
  ...pageParams.filter((p) => p.name !== 'after'),
];

export const openApiDocument = {
  openapi: '3.1.1',
  jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
  info: {
    title: 'Quorum API',
    version: '1.0.0-draft',
    license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    description: [
      'The `/v1` API of a Quorum server: the single contract for adapters, the CLI and the web UI.',
      '',
      'Rules that apply to every request:',
      '- Every request except `GET /v1/health` and `POST /v1/hello` needs a bearer token, also on loopback (INV-23).',
      '- Clients send no credential until `POST /v1/hello` has proven the server holds the key they pinned (INV-24).',
      '- In local mode the server rejects requests whose `Host` is not its own loopback name and port, and state-changing requests from a foreign `Origin` (INV-26).',
      '- Every error uses the `ErrorResponse` shape: a stable `code`, what happened, and the exact `fix` (MESSAGE_SPEC §6). Errors never echo secrets or tokens.',
      '- Rate limits and quotas apply per principal; `429` responses carry `Retry-After` (INV-15).',
    ].join('\n'),
  },
  servers: [
    {
      url: 'http://localhost:{port}',
      description: 'Local mode (port from the private discovery file)',
      variables: { port: { default: '0' } },
    },
    {
      url: 'https://{host}',
      description: 'Remote mode (Tailscale, Cloudflare Tunnel or LAN with TLS)',
      variables: { host: { default: 'quorum.example' } },
    },
  ],
  security: agentOrHuman,
  tags: [
    { name: 'server', description: 'Health and identity' },
    { name: 'auth', description: 'Tokens' },
    { name: 'setup', description: 'Workspaces, attachments, sessions' },
    { name: 'messages', description: 'Send, read, acknowledge, stream' },
    { name: 'members', description: 'Agents, presence, revocation' },
    { name: 'audit', description: 'Event log export' },
  ],
  paths: {
    '/v1/health': {
      get: {
        operationId: 'getHealth',
        tags: ['server'],
        summary: 'Is the server up? Never needs a token.',
        security: none,
        responses: { '200': { description: 'Server is up.', content: json('Health') } },
      },
    },
    '/v1/hello': {
      post: {
        operationId: 'hello',
        tags: ['server'],
        summary: 'Prove the server identity before any credential is sent (INV-24).',
        description:
          'The server signs, with its Ed25519 instance key, the UTF-8 bytes of `"quorum/1 hello\\n" + instance_id + "\\n" + nonce`. The client verifies the signature with the public key it pinned (private discovery file in local mode, join code in remote mode) and aborts on mismatch, without falling back.',
        security: none,
        requestBody: { required: true, content: json('HelloRequest') },
        responses: {
          '200': { description: 'Signed proof of identity.', content: json('HelloResponse') },
          '400': errorRef('BadRequest'),
          '429': errorRef('TooManyRequests'),
        },
      },
    },
    '/v1/auth/refresh': {
      post: {
        operationId: 'refreshToken',
        tags: ['auth'],
        summary: 'Exchange a refresh token for a new token pair (rotation).',
        description:
          'Each refresh token works once. Reusing a rotated refresh token revokes the whole token family (INV-11).',
        security: none,
        requestBody: { required: true, content: json('TokenRefreshRequest') },
        responses: {
          '200': {
            description: 'New tokens. The old refresh token is now invalid.',
            content: json('TokenPair'),
          },
          '400': errorRef('BadRequest'),
          '401': errorRef('Unauthorized'),
          '429': errorRef('TooManyRequests'),
        },
      },
    },
    '/v1/auth/local-bootstrap': {
      post: {
        operationId: 'localBootstrap',
        tags: ['auth'],
        summary: "Local mode: exchange the one-time bootstrap code for the owner's human tokens.",
        description: [
          'The local server writes a bootstrap code (`qrm_bc_…`, 10-minute expiry, single use) into its private data directory at `<data>/local/bootstrap.json`. Only the owning OS user can read it (INV-25), so presenting it proves the caller is that user. The first exchange creates the owner human.',
          '',
          'Remote mode answers `404`: there, humans sign in with join codes (Phase 1b).',
        ].join('\n'),
        security: none,
        requestBody: { required: true, content: json('LocalBootstrapRequest') },
        responses: {
          '200': {
            description: 'The owner human and their tokens. The code is now used up.',
            content: json('LocalBootstrapResponse'),
          },
          '400': errorRef('BadRequest'),
          '401': errorRef('Unauthorized'),
          '404': errorRef('NotFound'),
          '429': errorRef('TooManyRequests'),
        },
      },
    },
    '/v1/workspaces': {
      get: {
        operationId: 'listWorkspaces',
        tags: ['setup'],
        summary: 'Workspaces visible to the caller (agents: those their attachment grants).',
        security: agentOrHuman,
        responses: {
          '200': { description: 'Visible workspaces.', content: json('WorkspaceList') },
          ...authErrors,
        },
      },
      post: {
        operationId: 'createWorkspace',
        tags: ['setup'],
        summary: 'Create a workspace (humans only).',
        security: human,
        requestBody: { required: true, content: json('WorkspaceCreate') },
        responses: {
          '201': { description: 'Created.', content: json('Workspace') },
          '400': errorRef('BadRequest'),
          '409': errorRef('Conflict'),
          ...authErrors,
        },
      },
    },
    '/v1/attachments': {
      post: {
        operationId: 'createAttachment',
        tags: ['setup'],
        summary:
          'Bind a folder for one vendor to workspaces and issue agent credentials (`quorum attach`).',
        description:
          'Humans only: an agent can never attach itself or widen its own visibility (INV-30). Credentials are returned once; the CLI stores them in the OS keychain (INV-11, INV-25). The root must not be inside the Quorum data directory.',
        security: human,
        requestBody: { required: true, content: json('AttachmentCreate') },
        responses: {
          '201': {
            description: 'Attachment, agent identity and credentials.',
            content: json('AttachmentCreated'),
          },
          '400': errorRef('BadRequest'),
          '404': errorRef('NotFound'),
          ...authErrors,
        },
      },
    },
    '/v1/attachments/{attachment}': {
      patch: {
        operationId: 'updateAttachment',
        tags: ['setup'],
        summary: 'Change wake mode, wake types or lease enforcement of an attachment.',
        description:
          "Humans only. The change applies from the next message and is recorded in the event log. Wake settings can never exceed the workspace's wake budget and loop pause (INV-29).",
        security: human,
        parameters: [pathParam('attachment', 'attachmentId', 'Attachment ID (`at_…`).')],
        requestBody: { required: true, content: json('AttachmentUpdate') },
        responses: {
          '200': { description: 'The updated attachment.', content: json('Attachment') },
          '400': errorRef('BadRequest'),
          '404': errorRef('NotFound'),
          ...authErrors,
        },
      },
      delete: {
        operationId: 'deleteAttachment',
        tags: ['setup'],
        summary: 'Detach a folder (`quorum detach`); revokes its agent credentials.',
        security: human,
        parameters: [pathParam('attachment', 'attachmentId', 'Attachment ID (`at_…`).')],
        responses: {
          '204': { description: 'Detached.' },
          '404': errorRef('NotFound'),
          ...authErrors,
        },
      },
    },
    '/v1/sessions': {
      post: {
        operationId: 'createSession',
        tags: ['setup'],
        summary: 'Register a live vendor session for the calling agent.',
        description:
          'The server assigns stable repository and worktree IDs from the canonical git paths and reports other live agents in the same working tree (INV-28).',
        security: agent,
        requestBody: { required: true, content: json('SessionCreate') },
        responses: {
          '201': { description: 'Session registered.', content: json('SessionCreated') },
          '400': errorRef('BadRequest'),
          ...authErrors,
        },
      },
    },
    '/v1/sessions/{session}': {
      delete: {
        operationId: 'endSession',
        tags: ['setup'],
        summary: 'End a session (the vendor session closed).',
        security: agent,
        parameters: [pathParam('session', 'sessionId', 'Session ID (`sess_…`).')],
        responses: { '204': { description: 'Ended.' }, '404': errorRef('NotFound'), ...authErrors },
      },
    },
    '/v1/workspaces/{workspace}/messages': {
      post: {
        operationId: 'sendMessage',
        tags: ['messages'],
        summary: 'Send a message (any type the caller is allowed to send).',
        description: [
          'Validated against `SubmittedEnvelope`. `from` must match the token (INV-7); agents can never send `approval_decision` (INV-1); bodies are scanned for secrets (INV-14).',
          '',
          'Idempotent by `(workspace, id)`: resending identical content returns `200` with the original result; different content under the same `id` returns `409` (MESSAGE_SPEC §2.1.3).',
          '',
          '`heartbeat` messages update presence and are not stored in the event log (MESSAGE_SPEC §5.10).',
        ].join('\n'),
        security: agentOrHuman,
        parameters: [workspaceParam],
        requestBody: { required: true, content: json('SubmittedEnvelope') },
        responses: {
          '201': { description: 'Accepted and recorded.', content: json('MessageAccepted') },
          '200': {
            description: 'Already accepted earlier with identical content.',
            content: json('MessageAccepted'),
          },
          '400': errorRef('BadRequest'),
          '404': errorRef('NotFound'),
          '409': errorRef('Conflict'),
          '413': errorRef('PayloadTooLarge'),
          ...authErrors,
        },
      },
    },
    '/v1/workspaces/{workspace}/inbox': {
      get: {
        operationId: 'getInbox',
        tags: ['messages'],
        summary: 'Messages addressed to the caller (directly or via `*`), oldest first.',
        description:
          'For agents that cannot hold a stream open, e.g. between turns. Delivery is at-least-once; dedupe by `id`.',
        security: agentOrHuman,
        parameters: [workspaceParam, ...inboxParams],
        responses: {
          '200': { description: 'A page of messages.', content: json('InboxPage') },
          '404': errorRef('NotFound'),
          ...authErrors,
        },
      },
    },
    '/v1/workspaces/{workspace}/inbox/ack': {
      post: {
        operationId: 'ackInbox',
        tags: ['messages'],
        summary: 'Mark messages up to a `seq` as read for the caller.',
        security: agentOrHuman,
        parameters: [workspaceParam],
        requestBody: { required: true, content: json('AckRequest') },
        responses: {
          '204': { description: 'Acknowledged.' },
          '400': errorRef('BadRequest'),
          '404': errorRef('NotFound'),
          ...authErrors,
        },
      },
    },
    '/v1/workspaces/{workspace}/wake': {
      post: {
        operationId: 'requestWake',
        tags: ['messages'],
        summary: 'May new mail wake this agent or continue its turn? (agents only)',
        description: [
          "The server decides, never the adapter: the attachment's wake mode and `wake_types`, the hourly wake budget and the agent-only-loop pause all apply (ARCHITECTURE §15.2, INV-29). A granted wake counts against the budget and is recorded in the event log. Waking never bypasses the agent's own permission prompts.",
          '',
          'Adapters call this from a turn-end hook (e.g. `Stop`) when unread mail exists, and continue the turn only on `wake: true`.',
        ].join('\n'),
        security: agent,
        parameters: [workspaceParam],
        requestBody: { required: true, content: json('WakeRequest') },
        responses: {
          '200': { description: 'The decision.', content: json('WakeDecision') },
          '400': errorRef('BadRequest'),
          '404': errorRef('NotFound'),
          ...authErrors,
        },
      },
    },
    '/v1/workspaces/{workspace}/stream': {
      get: {
        operationId: 'streamMessages',
        tags: ['messages'],
        summary: 'Live push of messages visible to the caller (Server-Sent Events).',
        description:
          'Each event is `event: message`, `id: <seq>`, `data: <DeliveredEnvelope JSON>`. Reconnect with `Last-Event-ID` to receive everything after that `seq`: no message is lost across reconnects (MESSAGE_SPEC §4). The server closes the stream when the caller is revoked (INV-13).',
        security: agentOrHuman,
        parameters: [
          workspaceParam,
          {
            name: 'Last-Event-ID',
            in: 'header',
            description: 'Resume after this `seq`.',
            schema: { type: 'string', pattern: '^[0-9]+$' },
          },
        ],
        responses: {
          '200': {
            description: 'An open event stream.',
            content: { 'text/event-stream': { schema: { type: 'string' } } },
          },
          '404': errorRef('NotFound'),
          ...authErrors,
        },
      },
    },
    '/v1/workspaces/{workspace}/threads/{thread}/messages': {
      get: {
        operationId: 'getThread',
        tags: ['messages'],
        summary: 'Messages in one thread that the caller may see, oldest first.',
        security: agentOrHuman,
        parameters: [
          workspaceParam,
          pathParam('thread', 'threadId', 'Thread ID (`th_…`).'),
          ...pageParams,
        ],
        responses: {
          '200': { description: 'A page of messages.', content: json('InboxPage') },
          '404': errorRef('NotFound'),
          ...authErrors,
        },
      },
    },
    '/v1/workspaces/{workspace}/agents': {
      get: {
        operationId: 'listAgents',
        tags: ['members'],
        summary: 'Agents in the workspace with their presence and current status.',
        description:
          'An agent is `online` while it has sent a heartbeat within the last 90 seconds (MESSAGE_SPEC §5.10). `folder` is the name of the attached folder (e.g. `api`), never a full path.',
        security: agentOrHuman,
        parameters: [workspaceParam],
        responses: {
          '200': { description: 'Agents.', content: json('AgentList') },
          '404': errorRef('NotFound'),
          ...authErrors,
        },
      },
    },
    '/v1/agents/{agent}/revoke': {
      post: {
        operationId: 'revokeAgent',
        tags: ['members'],
        summary: 'Revoke an agent immediately: tokens stop working and its streams close (INV-13).',
        security: human,
        parameters: [pathParam('agent', 'agentId', 'Agent ID (`ag_…`).')],
        responses: {
          '204': { description: 'Revoked.' },
          '404': errorRef('NotFound'),
          ...authErrors,
        },
      },
    },
    '/v1/workspaces/{workspace}/export': {
      get: {
        operationId: 'exportEvents',
        tags: ['audit'],
        summary: 'The workspace event log as JSON Lines, for `quorum verify` (INV-8).',
        description:
          'One `Event` per line, oldest first. Tokens and secrets are never included (INV-11).',
        security: human,
        parameters: [workspaceParam],
        responses: {
          '200': {
            description: 'The event log.',
            content: { 'application/x-ndjson': { schema: ref('Event') } },
          },
          '404': errorRef('NotFound'),
          ...authErrors,
        },
      },
    },
  },
  components: {
    securitySchemes: {
      agentToken: {
        type: 'http',
        scheme: 'bearer',
        description: 'Access token issued to an agent at attach time (1 h; refresh to rotate).',
      },
      humanToken: {
        type: 'http',
        scheme: 'bearer',
        description: 'Access token of a human (CLI). The web UI uses a session cookie instead.',
      },
    },
    responses: {
      BadRequest: {
        description: 'The request does not match the schema; `path` points at the problem.',
        content: json('ErrorResponse'),
      },
      Unauthorized: {
        description: 'Missing, expired or revoked token.',
        content: json('ErrorResponse'),
      },
      Forbidden: {
        description: "The token's scope does not allow this.",
        content: json('ErrorResponse'),
      },
      NotFound: {
        description: 'No such object visible to the caller.',
        content: json('ErrorResponse'),
      },
      Conflict: {
        description: 'Conflicts with existing state (e.g. same message `id`, different content).',
        content: json('ErrorResponse'),
      },
      PayloadTooLarge: {
        description: 'The body exceeds 96 KiB; put large content in an artifact.',
        content: json('ErrorResponse'),
      },
      TooManyRequests: {
        description: 'Rate limit exceeded.',
        headers: {
          'Retry-After': {
            description: 'Seconds to wait.',
            schema: { type: 'integer', minimum: 1 },
          },
        },
        content: json('ErrorResponse'),
      },
    },
    schemas: {
      Common: commonSchema,
      SubmittedEnvelope: submittedEnvelopeSchema,
      DeliveredEnvelope: deliveredEnvelopeSchema,
      ErrorResponse: errorResponseSchema,
      Policy: policySchema,
      NoteBody: bodySchemas.note,
      RequestBody: bodySchemas.request,
      TaskUpdateBody: bodySchemas.task_update,
      FindingBody: bodySchemas.finding,
      RetractionBody: bodySchemas.retraction,
      ArtifactReadyBody: bodySchemas.artifact_ready,
      LeaseBody: bodySchemas.lease,
      ApprovalRequestBody: bodySchemas.approval_request,
      ApprovalDecisionBody: bodySchemas.approval_decision,
      HeartbeatBody: bodySchemas.heartbeat,
      Health: apiSchemas.health,
      HelloRequest: apiSchemas.helloRequest,
      HelloResponse: apiSchemas.helloResponse,
      TokenRefreshRequest: apiSchemas.tokenRefreshRequest,
      TokenPair: apiSchemas.tokenPair,
      LocalBootstrapRequest: apiSchemas.localBootstrapRequest,
      LocalBootstrapResponse: apiSchemas.localBootstrapResponse,
      WorkspaceCreate: apiSchemas.workspaceCreate,
      Workspace: apiSchemas.workspace,
      WorkspaceList: apiSchemas.workspaceList,
      AttachmentCreate: apiSchemas.attachmentCreate,
      Attachment: apiSchemas.attachment,
      AttachmentUpdate: apiSchemas.attachmentUpdate,
      AttachmentCreated: apiSchemas.attachmentCreated,
      WakeRequest: apiSchemas.wakeRequest,
      WakeDecision: apiSchemas.wakeDecision,
      AgentRef: apiSchemas.agentRef,
      SessionCreate: apiSchemas.sessionCreate,
      SessionCreated: apiSchemas.sessionCreated,
      MessageAccepted: apiSchemas.messageAccepted,
      InboxPage: apiSchemas.inboxPage,
      AckRequest: apiSchemas.ackRequest,
      AgentList: apiSchemas.agentList,
      Event: apiSchemas.event,
    },
  },
} as const;
