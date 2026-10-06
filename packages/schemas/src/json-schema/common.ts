// Shared building blocks for every quorum/1 schema (MESSAGE_SPEC §1–§2).

/** Crockford base32 ULID (26 chars, no I, L, O, U). */
export const ULID = '[0-9A-HJKMNP-TV-Z]{26}';

/** Agent/machine/human name segment: 1–32 of a-z, 0-9, "-", starting with a letter. */
export const NAME = '[a-z][a-z0-9-]{0,31}';

/**
 * A session label (MESSAGE_SPEC §1.1): `<tool>@<folder>-<n>` on the sender's machine, or
 * `<tool>@<machine>-<folder>-<n>` from anywhere, e.g. `claude@api-1`, `codex@abhijna-laptop-web-2`.
 */
export const SESSION_LABEL = '[a-z][a-z0-9-]{0,31}@[a-z0-9][a-z0-9-]{0,95}-[1-9][0-9]{0,3}';

/** Size limits (MESSAGE_SPEC §2.1). Bodies are measured as UTF-8 bytes of their JSON. */
export const LIMITS = {
  bodyMaxBytes: 96 * 1024,
  stringMaxChars: 16 * 1024,
  refsMax: 64,
  recipientsMax: 32,
} as const;

/** ID prefixes (MESSAGE_SPEC §1). */
export const ID_PREFIXES = {
  workspace: 'ws',
  thread: 'th',
  message: 'msg',
  task: 'tk',
  finding: 'fd',
  artifact: 'art',
  lease: 'ls',
  approval: 'ap',
  agent: 'ag',
  human: 'hu',
  machine: 'mc',
  event: 'ev',
  attachment: 'at',
  session: 'sess',
  repository: 'rp',
  worktree: 'wt',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export const COMMON_ID = 'urn:quorum:schema:common:1';

/** `$ref` to a definition in the common schema. */
export const common = (def: string): { $ref: string } => ({ $ref: `${COMMON_ID}#/$defs/${def}` });

const idDefs = Object.fromEntries(
  Object.entries(ID_PREFIXES).map(([kind, prefix]) => [
    `${kind}Id`,
    { type: 'string', pattern: `^${prefix}_${ULID}$` },
  ]),
);

const REF_PATTERN =
  `^(?:(?:msg:msg|task:tk|finding:fd|lease:ls|approval:ap|thread:th)_${ULID}` +
  `|artifact:art_${ULID}(?:@v[1-9][0-9]{0,8})?)$`;

export const commonSchema = {
  $id: COMMON_ID,
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'quorum/1 common definitions',
  $defs: {
    ...idDefs,
    name: { type: 'string', pattern: `^${NAME}$` },
    agentAddress: { type: 'string', pattern: `^agent:${NAME}@${NAME}$` },
    humanAddress: { type: 'string', pattern: `^human:${NAME}$` },
    systemAddress: { const: 'system:quorum' },
    /** Who a client may claim to be (the server checks it against the token, INV-7). */
    senderAddress: {
      type: 'string',
      pattern: `^(?:agent:${NAME}@${NAME}|human:${NAME})$`,
    },
    /** One live session (one window) of an agent; the server resolves it when the message is sent. */
    sessionLabel: { type: 'string', pattern: `^${SESSION_LABEL}$` },
    /** Who may receive a message: an agent, a human, a session label, or everyone (`*`). */
    recipientAddress: {
      type: 'string',
      pattern: `^(?:agent:${NAME}@${NAME}|human:${NAME}|${SESSION_LABEL}|\\*)$`,
    },
    /** kind:id[@vN]; kind and id prefix must agree; only artifacts carry versions. */
    ref: { type: 'string', pattern: REF_PATTERN },
    refList: {
      type: 'array',
      maxItems: LIMITS.refsMax,
      uniqueItems: true,
      // Absolute, so it also resolves when this schema is embedded in the OpenAPI document.
      items: { $ref: `${COMMON_ID}#/$defs/ref` },
    },
    timestamp: { type: 'string', format: 'date-time' },
    sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    /** Ordinary free text: non-empty, bounded by the per-string limit. */
    text: { type: 'string', minLength: 1, maxLength: LIMITS.stringMaxChars },
    risk: { enum: ['low', 'medium', 'high', 'critical'] },
  },
} as const;
