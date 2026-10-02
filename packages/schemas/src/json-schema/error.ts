// The single error shape every API response uses (MESSAGE_SPEC §6).

export const ERROR_RESPONSE_ID = 'urn:quorum:schema:error:1';

export const errorResponseSchema = {
  $id: ERROR_RESPONSE_ID,
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'quorum/1 error response',
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'fix'],
      properties: {
        /** Stable, documented, e.g. "finding.missing_evidence". */
        code: { type: 'string', pattern: '^[a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]*)+$' },
        /** What happened and why. Never contains secrets or tokens. */
        message: { type: 'string', minLength: 1, maxLength: 2000 },
        /** JSON Pointer to the offending input, when there is one. */
        path: { type: 'string', maxLength: 512 },
        /** The exact next step. */
        fix: { type: 'string', minLength: 1, maxLength: 2000 },
      },
    },
  },
} as const;
