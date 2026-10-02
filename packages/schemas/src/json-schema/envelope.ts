// The quorum/1 envelope (MESSAGE_SPEC §2), in two variants:
//  - submitted: what a client sends; server-assigned fields are forbidden.
//  - delivered: what a client receives; carries server fields, and may have a type this
//    client does not know yet (render it as a note, MESSAGE_SPEC §2.1.4).
import { bodySchemaId, MESSAGE_TYPES } from './bodies.js';
import { common, LIMITS } from './common.js';

export const SUBMITTED_ENVELOPE_ID = 'urn:quorum:schema:envelope:submitted:1';
export const DELIVERED_ENVELOPE_ID = 'urn:quorum:schema:envelope:delivered:1';

/** Fields only the server may set (MESSAGE_SPEC §2). */
export const SERVER_FIELDS = ['seq', 'received_at', 'event', 'flags'] as const;

const sharedProperties = {
  spec: { const: 'quorum/1' },
  id: common('messageId'),
  workspace: common('workspaceId'),
  thread: common('threadId'),
  to: {
    type: 'array',
    minItems: 1,
    maxItems: LIMITS.recipientsMax,
    uniqueItems: true,
    items: common('recipientAddress'),
  },
  type_version: { type: 'integer', minimum: 1 },
  created_at: common('timestamp'),
  reply_to: common('messageId'),
  body: { type: 'object' },
  refs: common('refList'),
  signature: { type: 'string', pattern: '^ed25519:[A-Za-z0-9_-]+$' },
} as const;

const required = [
  'spec',
  'id',
  'workspace',
  'from',
  'to',
  'type',
  'type_version',
  'created_at',
  'body',
];

/** Validate the body against its type's schema, for every known type. */
const bodyByType = MESSAGE_TYPES.map((type) => ({
  if: { required: ['type'], properties: { type: { const: type } } },
  then: { properties: { body: { $ref: bodySchemaId(type) } } },
}));

/** A request is a task for exactly one named recipient (MESSAGE_SPEC §5.2). */
const requestHasOneRecipient = {
  if: { required: ['type'], properties: { type: { const: 'request' } } },
  then: {
    properties: {
      to: { type: 'array', maxItems: 1, items: { not: { const: '*' } } },
    },
  },
};

export const submittedEnvelopeSchema = {
  $id: SUBMITTED_ENVELOPE_ID,
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'quorum/1 envelope (submitted by a client)',
  type: 'object',
  required,
  properties: {
    ...sharedProperties,
    from: common('senderAddress'),
    type: { enum: [...MESSAGE_TYPES] },
    // Present = rejected, never silently rewritten (MESSAGE_SPEC §2).
    ...Object.fromEntries(SERVER_FIELDS.map((field) => [field, false])),
  },
  allOf: [...bodyByType, requestHasOneRecipient],
} as const;

export const deliveredEnvelopeSchema = {
  $id: DELIVERED_ENVELOPE_ID,
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'quorum/1 envelope (delivered by the server)',
  type: 'object',
  required: [...required, 'seq', 'received_at', 'event'],
  properties: {
    ...sharedProperties,
    from: {
      anyOf: [common('senderAddress'), common('systemAddress')],
    },
    // Unknown types are allowed on delivery; known ones are fully validated.
    type: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' },
    seq: { type: 'integer', minimum: 1 },
    received_at: common('timestamp'),
    event: common('eventId'),
    flags: {
      type: 'array',
      maxItems: 32,
      uniqueItems: true,
      items: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' },
    },
  },
  allOf: [...bodyByType],
} as const;
