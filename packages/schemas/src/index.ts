/** Protocol version carried in every envelope's `spec` field (MESSAGE_SPEC §2). */
export const SPEC_VERSION = 'quorum/1';

export { ACTION_NAME, bodySchemaId, bodySchemas, MESSAGE_TYPES } from './json-schema/bodies.js';
export { commonSchema, ID_PREFIXES, LIMITS, type IdKind } from './json-schema/common.js';
export {
  DELIVERED_ENVELOPE_ID,
  deliveredEnvelopeSchema,
  SERVER_FIELDS,
  SUBMITTED_ENVELOPE_ID,
  submittedEnvelopeSchema,
} from './json-schema/envelope.js';
export { ERROR_RESPONSE_ID, errorResponseSchema } from './json-schema/error.js';
export { POLICY_ID, policySchema } from './json-schema/policy.js';
export type * from './types.js';
export {
  ALL_SCHEMAS,
  isRfc3339,
  validateDeliveredEnvelope,
  validateErrorResponse,
  validatePolicy,
  validateSubmittedEnvelope,
  type ValidationIssue,
  type ValidationResult,
} from './validate.js';
