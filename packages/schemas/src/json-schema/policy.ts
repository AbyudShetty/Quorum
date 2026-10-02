// quorum.policy.yaml v1, after YAML parsing (POLICY_SPEC §2).
// Unknown keys are rejected: a typo must never silently loosen policy (INV-5).
// Rules that need more than one field or the member list (quorum ≤ eligible approvers,
// critical can never skip approval) are enforced by the policy engine in `core`.
import { ACTION_NAME, MESSAGE_TYPES } from './bodies.js';
import { NAME } from './common.js';

export const POLICY_ID = 'urn:quorum:schema:policy:1';

const duration = { type: 'string', pattern: '^[1-9][0-9]{0,5}[smhd]$' } as const;
const size = { type: 'string', pattern: '^[1-9][0-9]{0,9}(?:KiB|MiB|GiB|TiB)$' } as const;
const count = { type: 'integer', minimum: 1, maximum: 1_000_000 } as const;
const risk = { enum: ['low', 'medium', 'high', 'critical'] } as const;

/** Built-in safe namespaces can never appear as policy rules (POLICY_SPEC §3). */
const RULE_KEY =
  '^(?!(?:read|analyse|draft|message)(?:\\.|$))' +
  ACTION_NAME.slice(1, -1) + // reuse the action-name grammar without its anchors
  '(?:\\.\\*)?$';

const approver = { type: 'string', pattern: `^(?:role|human):${NAME}$` } as const;

const scope = {
  type: 'object',
  additionalProperties: false,
  properties: {
    // approval_decision is human-only and can never be granted to an agent (INV-1).
    message_types: {
      type: 'array',
      uniqueItems: true,
      items: { enum: MESSAGE_TYPES.filter((type) => type !== 'approval_decision') },
    },
    artifacts: { enum: ['none', 'read-only', 'read-write'] },
  },
} as const;

const rule = {
  type: 'object',
  additionalProperties: false,
  properties: {
    gated: { type: 'boolean' },
    risk,
    quorum: { type: 'integer', minimum: 1, maximum: 100 },
    approvers: { type: 'array', minItems: 1, uniqueItems: true, items: approver },
    independent_approver: { type: 'boolean' },
    veto: { type: 'boolean' },
    approval_expiry: duration,
    grant_ttl: duration,
    ungated_reason: { type: 'string', minLength: 1, maxLength: 2000 },
  },
  // Un-gating is explicit and explained (POLICY_SPEC §2, INV-6).
  if: { required: ['gated'], properties: { gated: { const: false } } },
  then: { required: ['ungated_reason'] },
} as const;

export const policySchema = {
  $id: POLICY_ID,
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'quorum.policy.yaml v1',
  type: 'object',
  additionalProperties: false,
  required: ['version'],
  properties: {
    version: { const: 1 },
    defaults: {
      type: 'object',
      additionalProperties: false,
      properties: {
        approval_expiry: duration,
        grant_ttl: duration,
        quorum: { type: 'integer', minimum: 1, maximum: 100 },
        independent_approver: { type: 'boolean' },
        veto: { type: 'boolean' },
        // Never above high: high and critical always need user verification (INV-31).
        user_verification_from: { enum: ['low', 'medium', 'high'] },
        // Which gated actions wait for a human; critical always does (INV-32).
        approval_required_from: risk,
      },
    },
    humans: {
      type: 'object',
      propertyNames: { pattern: `^${NAME}$` },
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['roles'],
        properties: {
          roles: {
            type: 'array',
            minItems: 1,
            uniqueItems: true,
            items: { type: 'string', pattern: `^${NAME}$` },
          },
        },
      },
    },
    agents: {
      type: 'object',
      additionalProperties: false,
      properties: {
        default_scope: scope,
        overrides: {
          type: 'object',
          propertyNames: { pattern: `^${NAME}@${NAME}$` },
          additionalProperties: scope,
        },
      },
    },
    actions: {
      type: 'object',
      propertyNames: { pattern: RULE_KEY },
      additionalProperties: rule,
    },
    limits: {
      type: 'object',
      additionalProperties: false,
      properties: {
        messages_per_minute: count,
        approval_requests_per_hour: count,
        max_lease_ttl: duration,
        workspace_disk: size,
        max_upload: size,
        wakes_per_hour: count,
        agent_only_messages_before_pause: count,
      },
    },
  },
} as const;
