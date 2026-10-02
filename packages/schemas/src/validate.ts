// Validators for both tracks: adapters check before sending, the server checks on receipt.
// Errors are turned into plain issues (path + rule + message) that the server maps onto the
// error shape in MESSAGE_SPEC §6.
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { API_SCHEMA_IDS, apiSchemas } from './json-schema/api.js';
import { bodySchemas } from './json-schema/bodies.js';
import { commonSchema, LIMITS } from './json-schema/common.js';
import {
  DELIVERED_ENVELOPE_ID,
  deliveredEnvelopeSchema,
  SUBMITTED_ENVELOPE_ID,
  submittedEnvelopeSchema,
} from './json-schema/envelope.js';
import { ERROR_RESPONSE_ID, errorResponseSchema } from './json-schema/error.js';
import { POLICY_ID, policySchema } from './json-schema/policy.js';
import type {
  ApiPayloads,
  DeliveredEnvelope,
  ErrorResponse,
  PolicyV1,
  SubmittedEnvelope,
  UnknownDeliveredEnvelope,
} from './types.js';

export interface ValidationIssue {
  /** JSON Pointer to the offending value ("" is the whole document). */
  path: string;
  /** JSON Schema keyword that failed, or "maxBytes" for the body size limit. */
  rule: string;
  message: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

/** Every schema, for tools that want the JSON (OpenAPI, non-TypeScript clients). */
export const ALL_SCHEMAS = [
  commonSchema,
  ...Object.values(bodySchemas),
  submittedEnvelopeSchema,
  deliveredEnvelopeSchema,
  errorResponseSchema,
  policySchema,
  ...Object.values(apiSchemas),
] as const;

/** RFC 3339 date-time with a real calendar date (no ajv-formats dependency needed). */
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?([Zz]|[+-]\d{2}:\d{2})$/;
export const isRfc3339 = (value: string): boolean => {
  const m = RFC3339.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 60 // leap second
  );
};

// Strict mode catches schema mistakes; strictRequired is off only because conditional
// requirements (`then: { required: [...] }`) name properties defined one level up.
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
  allowUnionTypes: true,
});
ajv.addFormat('date-time', { type: 'string', validate: isRfc3339 });
for (const schema of ALL_SCHEMAS) ajv.addSchema(schema);

const compiled = (id: string): ValidateFunction => {
  const fn = ajv.getSchema(id);
  if (!fn) throw new Error(`schema ${id} is not registered`);
  return fn;
};

const validators = {
  submitted: compiled(SUBMITTED_ENVELOPE_ID),
  delivered: compiled(DELIVERED_ENVELOPE_ID),
  error: compiled(ERROR_RESPONSE_ID),
  policy: compiled(POLICY_ID),
};

/** Turn Ajv errors into issues, dropping the "must match then schema" noise from if/then. */
const toIssues = (errors: ErrorObject[] | null | undefined): ValidationIssue[] => {
  const seen = new Set<string>();
  const issues: ValidationIssue[] = [];
  for (const e of errors ?? []) {
    // "must match then schema" and the propertyNames wrapper only repeat a more precise error.
    if (e.keyword === 'if' || e.keyword === 'propertyNames') continue;
    const issue =
      e.propertyName === undefined
        ? { path: e.instancePath, rule: e.keyword, message: describe(e) }
        : {
            path: `${e.instancePath}/${pointerEscape(e.propertyName)}`,
            rule: 'propertyNames',
            message: `"${e.propertyName}" is not an allowed key here`,
          };
    const key = `${issue.path}|${issue.rule}|${issue.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      issues.push(issue);
    }
  }
  return issues;
};

const pointerEscape = (segment: string): string =>
  segment.replaceAll('~', '~0').replaceAll('/', '~1');

const describe = (e: ErrorObject): string => {
  if (e.keyword === 'false schema') {
    return `${e.instancePath.slice(1)} is set by the server and must not be sent`;
  }
  if (e.keyword === 'required') {
    return `missing required field "${(e.params as { missingProperty: string }).missingProperty}"`;
  }
  return e.message ?? 'is invalid';
};

const bodyTooLarge = (body: unknown): ValidationIssue | undefined => {
  // JSON.stringify returns undefined for undefined, whatever its type says.
  const json = JSON.stringify(body) as string | undefined;
  const bytes = Buffer.byteLength(json ?? '', 'utf8');
  if (bytes <= LIMITS.bodyMaxBytes) return undefined;
  return {
    path: '/body',
    rule: 'maxBytes',
    message: `body is ${String(bytes)} bytes; the limit is ${String(LIMITS.bodyMaxBytes)}. Put large content in an artifact and reference it.`,
  };
};

const check = <T>(
  fn: ValidateFunction,
  input: unknown,
  extra: ValidationIssue[] = [],
): ValidationResult<T> => {
  const issues = [...(fn(input) ? [] : toIssues(fn.errors)), ...extra];
  return issues.length === 0 ? { ok: true, value: input as T } : { ok: false, issues };
};

const sizeIssues = (input: unknown): ValidationIssue[] => {
  if (typeof input !== 'object' || input === null || !('body' in input)) return [];
  const issue = bodyTooLarge(input.body);
  return issue ? [issue] : [];
};

/** A message a client wants to send (MESSAGE_SPEC §2.1). */
export const validateSubmittedEnvelope = (input: unknown): ValidationResult<SubmittedEnvelope> =>
  check(validators.submitted, input, sizeIssues(input));

/** A message received from the server. Unknown types pass with their body unchecked. */
export const validateDeliveredEnvelope = (
  input: unknown,
): ValidationResult<DeliveredEnvelope | UnknownDeliveredEnvelope> =>
  check(validators.delivered, input, sizeIssues(input));

/** A parsed quorum.policy.yaml (POLICY_SPEC §2). */
export const validatePolicy = (input: unknown): ValidationResult<PolicyV1> =>
  check(validators.policy, input);

/** An error response body (MESSAGE_SPEC §6). */
export const validateErrorResponse = (input: unknown): ValidationResult<ErrorResponse> =>
  check(validators.error, input);

export type ApiPayloadKind = keyof typeof apiSchemas;

/**
 * An API request or response payload (health, hello, tokens, attachments, sessions, inbox
 * pages, …). The contract tests use this to check every server response.
 */
export const validateApiPayload = <K extends ApiPayloadKind>(
  kind: K,
  input: unknown,
): ValidationResult<ApiPayloads[K]> => check<ApiPayloads[K]>(compiled(API_SCHEMA_IDS[kind]), input);
