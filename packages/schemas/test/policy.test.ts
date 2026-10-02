import { describe, expect, it } from 'vitest';
import { type PolicyV1, validateErrorResponse, validatePolicy } from '../src/index.js';

// The example policy from POLICY_SPEC §2, as parsed from YAML.
const examplePolicy: PolicyV1 = {
  version: 1,
  defaults: {
    approval_expiry: '24h',
    grant_ttl: '15m',
    quorum: 1,
    independent_approver: false,
    veto: true,
    user_verification_from: 'high',
    approval_required_from: 'low',
  },
  humans: { abyud: { roles: ['owner'] }, abhijna: { roles: ['owner'] } },
  agents: {
    default_scope: {
      message_types: [
        'note',
        'request',
        'task_update',
        'finding',
        'retraction',
        'artifact_ready',
        'lease',
        'approval_request',
        'heartbeat',
      ],
      artifacts: 'read-write',
    },
    overrides: { 'codex-web@laptop-b': { artifacts: 'read-only' } },
  },
  actions: {
    'git.push': { approvers: ['role:owner'] },
    'git.force_push': { quorum: 2, risk: 'critical', independent_approver: true },
    'deploy.*': { risk: 'high', independent_approver: true },
    'test.run_local': { gated: false, ungated_reason: 'Local test runs are cheap and reversible.' },
  },
  limits: {
    messages_per_minute: 60,
    approval_requests_per_hour: 20,
    max_lease_ttl: '12h',
    workspace_disk: '50GiB',
    max_upload: '10GiB',
    wakes_per_hour: 20,
    agent_only_messages_before_pause: 12,
  },
};

const rules = (input: unknown): string[] => {
  const result = validatePolicy(input);
  return result.ok ? [] : result.issues.map((i) => `${i.path} ${i.rule}`);
};

describe('policy v1', () => {
  it('accepts the example policy from POLICY_SPEC §2', () => {
    expect(rules(examplePolicy)).toEqual([]);
  });

  it('accepts the smallest policy (built-in defaults apply)', () => {
    expect(rules({ version: 1 })).toEqual([]);
  });

  it('rejects unknown keys so a typo can never loosen policy (INV-5)', () => {
    expect(rules({ version: 1, defualts: { veto: false } })).toEqual([' additionalProperties']);
    expect(rules({ version: 1, defaults: { vetoo: false } })).toEqual([
      '/defaults additionalProperties',
    ]);
  });

  it('rejects other versions', () => {
    expect(rules({ version: 2 })).toEqual(['/version const']);
  });

  it('never lets the built-in safe namespaces be configured (POLICY_SPEC §3)', () => {
    for (const key of ['read.files', 'message', 'draft.*']) {
      expect(rules({ version: 1, actions: { [key]: { risk: 'low' } } })).toEqual([
        `/actions/${key} propertyNames`,
      ]);
    }
  });

  it('accepts exact and prefix-wildcard action keys', () => {
    expect(
      rules({ version: 1, actions: { 'deploy.prod': {}, 'spend.*': {}, 'readme.update': {} } }),
    ).toEqual([]);
  });

  it('requires a reason to un-gate an action (INV-6)', () => {
    expect(rules({ version: 1, actions: { 'test.run': { gated: false } } })).toEqual([
      '/actions/test.run required',
    ]);
  });

  it('never moves user verification above high (INV-31)', () => {
    expect(rules({ version: 1, defaults: { user_verification_from: 'critical' } })).toEqual([
      '/defaults/user_verification_from enum',
    ]);
  });

  it('never lets an agent scope include approval_decision (INV-1)', () => {
    const agents = { default_scope: { message_types: ['note', 'approval_decision'] } };
    expect(rules({ version: 1, agents })).toEqual(['/agents/default_scope/message_types/1 enum']);
  });

  it('checks durations, sizes and approver names', () => {
    const bad = {
      version: 1,
      defaults: { approval_expiry: '24 hours' },
      limits: { workspace_disk: '50GB' },
      actions: { 'git.push': { approvers: ['owner'] } },
    };
    expect(rules(bad)).toEqual([
      '/defaults/approval_expiry pattern',
      '/actions/git.push/approvers/0 pattern',
      '/limits/workspace_disk pattern',
    ]);
  });
});

describe('error response (MESSAGE_SPEC §6)', () => {
  const example = {
    error: {
      code: 'finding.missing_evidence',
      message: 'A finding needs a method and either metrics or a reproduce command.',
      path: '/body/metrics',
      fix: 'Add "metrics": {"accuracy": 0.91} or "reproduce": "python eval.py --seed 1".',
    },
  };

  it('accepts the example from the spec', () => {
    expect(validateErrorResponse(example).ok).toBe(true);
  });

  it('requires a stable dotted code and a fix', () => {
    const result = validateErrorResponse({ error: { code: 'Bad Code', message: 'x' } });
    expect(result.ok ? [] : result.issues.map((i) => `${i.path} ${i.rule}`)).toEqual([
      '/error required',
      '/error/code pattern',
    ]);
  });
});
