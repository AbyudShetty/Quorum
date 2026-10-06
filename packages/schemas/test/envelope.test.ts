import { describe, expect, it } from 'vitest';
import {
  isRfc3339,
  MESSAGE_TYPES,
  type MessageType,
  validateDeliveredEnvelope,
  validateSubmittedEnvelope,
  type ValidationResult,
} from '../src/index.js';
import { bodies, envelope, U1 } from './fixtures.js';

/** Issues as "path rule" strings, for readable assertions. */
const issues = (result: ValidationResult<unknown>): string[] =>
  result.ok ? [] : result.issues.map((i) => `${i.path} ${i.rule}`);

/** A copy of a fixture with some fields changed or removed (undefined = removed). */
const tweak = (base: object, changes: Record<string, unknown>): Record<string, unknown> => {
  const merged: Record<string, unknown> = { ...structuredClone(base), ...changes };
  return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined));
};

describe('submitted envelope', () => {
  it.each(MESSAGE_TYPES)('accepts a valid %s', (type) => {
    expect(issues(validateSubmittedEnvelope(envelope(type)))).toEqual([]);
  });

  it('rejects server-assigned fields instead of rewriting them (MESSAGE_SPEC §2)', () => {
    const result = validateSubmittedEnvelope({ ...envelope('note'), seq: 7, flags: [] });
    expect(issues(result)).toEqual(['/seq false schema', '/flags false schema']);
    expect(result.ok || result.issues[0]?.message).toBe(
      'seq is set by the server and must not be sent',
    );
  });

  it('rejects system:quorum as a client sender (INV-7)', () => {
    expect(
      issues(validateSubmittedEnvelope({ ...envelope('note'), from: 'system:quorum' })),
    ).toEqual(['/from pattern']);
  });

  it('rejects unknown message types from clients', () => {
    expect(issues(validateSubmittedEnvelope({ ...envelope('note'), type: 'gossip' }))).toEqual([
      '/type enum',
    ]);
  });

  it('requires at least one recipient and at most 32', () => {
    expect(issues(validateSubmittedEnvelope({ ...envelope('note'), to: [] }))).toEqual([
      '/to minItems',
    ]);
    const many = Array.from({ length: 33 }, (_, i) => `human:h${String(i)}`);
    expect(issues(validateSubmittedEnvelope({ ...envelope('note'), to: many }))).toEqual([
      '/to maxItems',
    ]);
  });

  it('gives a request exactly one named recipient (MESSAGE_SPEC §5.2)', () => {
    expect(issues(validateSubmittedEnvelope({ ...envelope('request'), to: ['*'] }))).toEqual([
      '/to/0 not',
    ]);
    const two = ['agent:a@m', 'agent:b@m'];
    expect(issues(validateSubmittedEnvelope({ ...envelope('request'), to: two }))).toEqual([
      '/to maxItems',
    ]);
  });

  it('rejects refs whose kind and id prefix disagree', () => {
    expect(
      issues(validateSubmittedEnvelope({ ...envelope('note'), refs: [`finding:msg_${U1}`] })),
    ).toEqual(['/refs/0 pattern']);
  });

  it('only lets artifact refs carry a version', () => {
    expect(
      issues(validateSubmittedEnvelope({ ...envelope('note'), refs: [`finding:fd_${U1}@v2`] })),
    ).toEqual(['/refs/0 pattern']);
  });

  it('rejects malformed IDs and timestamps', () => {
    const bad = { ...envelope('note'), id: 'msg_lowercase', created_at: '2026-02-30T10:00:00Z' };
    expect(issues(validateSubmittedEnvelope(bad))).toEqual(['/id pattern', '/created_at format']);
  });

  it('keeps unknown fields for forward compatibility (MESSAGE_SPEC §2.1.4)', () => {
    expect(validateSubmittedEnvelope({ ...envelope('note'), future_field: 1 }).ok).toBe(true);
  });

  it('rejects a body over 96 KiB with a fix in the message', () => {
    const result = validateSubmittedEnvelope(envelope('note', { text: 'x'.repeat(16_000) }));
    expect(result.ok).toBe(true);
    // Unknown fields are allowed, so this is valid except for its size.
    const huge = { ...envelope('note'), body: { text: 'x', blob: 'y'.repeat(97 * 1024) } };
    const tooBig = validateSubmittedEnvelope(huge);
    expect(issues(tooBig)).toEqual(['/body maxBytes']);
    expect(tooBig.ok || tooBig.issues[0]?.message).toMatch(/limit is 98304.*artifact/);
  });
});

describe('message bodies', () => {
  const body = (type: MessageType, changes: Record<string, unknown>) =>
    validateSubmittedEnvelope({ ...envelope(type), body: tweak(bodies[type], changes) });

  it('rejects a finding without a method (INV-16)', () => {
    expect(issues(body('finding', { method: undefined }))).toEqual(['/body required']);
  });

  it('rejects a finding with neither metrics nor reproduce (INV-16)', () => {
    expect(issues(body('finding', { metrics: undefined, reproduce: undefined }))).toEqual([
      '/body required',
    ]);
    expect(issues(body('finding', { metrics: {}, reproduce: undefined }))).toEqual([
      '/body required',
    ]);
  });

  it('accepts a finding with only metrics or only reproduce', () => {
    expect(body('finding', { reproduce: undefined }).ok).toBe(true);
    expect(body('finding', { metrics: undefined }).ok).toBe(true);
  });

  it('requires a note when a task is blocked', () => {
    expect(issues(body('task_update', { status: 'blocked' }))).toEqual(['/body required']);
    expect(body('task_update', { status: 'blocked', note: 'waiting for fold 1' }).ok).toBe(true);
  });

  it('does not let clients set a task back to requested', () => {
    expect(issues(body('task_update', { status: 'requested' }))).toEqual(['/body/status enum']);
  });

  it('requires a location for local_ref artifacts', () => {
    expect(issues(body('artifact_ready', { location: undefined }))).toEqual(['/body required']);
    expect(body('artifact_ready', { storage: 'stored', location: undefined }).ok).toBe(true);
  });

  it.each([
    '../../.ssh/id_ed25519',
    'data/../../secret',
    '/etc/passwd',
    'C:\\Users\\me\\.quorum\\key',
    '..',
    '\\\\server\\share',
  ])('rejects the artifact path %s (INV-27)', (path) => {
    const location = { machine: 'laptop-a', attachment: `at_${U1}`, path };
    expect(issues(body('artifact_ready', { location }))).toEqual(['/body/location/path pattern']);
  });

  it.each([
    'gpu:laptop-a/0',
    'ram:laptop-b',
    `path:rp_${U1}/src/auth/**`,
    `worktree:wt_${U1}`,
    'dataset:train-v2',
    'slot:submission',
  ])('accepts the lease resource %s', (resource) => {
    expect(body('lease', { resource }).ok).toBe(true);
  });

  it('rejects path leases that are not scoped to a repository', () => {
    expect(issues(body('lease', { resource: 'path:src/**' }))).toEqual(['/body/resource pattern']);
  });

  it('requires lease_id to renew or release, and until to acquire or renew', () => {
    expect(issues(body('lease', { action: 'renew' }))).toEqual(['/body required']);
    expect(body('lease', { action: 'release', until: undefined, lease_id: `ls_${U1}` }).ok).toBe(
      true,
    );
    expect(issues(body('lease', { until: undefined }))).toEqual(['/body required']);
  });

  it('requires a rollback plan for medium risk and above', () => {
    expect(issues(body('approval_request', { rollback_plan: undefined }))).toEqual([
      '/body required',
    ]);
    expect(body('approval_request', { risk: 'low', rollback_plan: undefined }).ok).toBe(true);
  });

  it('rejects action names that are not dotted lowercase', () => {
    expect(issues(body('approval_request', { action: 'Git Push' }))).toEqual([
      '/body/action pattern',
    ]);
  });

  it('requires a reason to reject (POLICY_SPEC §4.1) but not to approve or close', () => {
    expect(issues(body('approval_decision', { comment: undefined }))).toEqual(['/body required']);
    expect(body('approval_decision', { decision: 'approve', comment: undefined }).ok).toBe(true);
    expect(body('approval_decision', { decision: 'close', comment: undefined }).ok).toBe(true);
  });

  it('rejects empty free text', () => {
    expect(issues(body('note', { text: '' }))).toEqual(['/body/text minLength']);
  });
});

describe('delivered envelope', () => {
  const delivered = {
    ...envelope('note'),
    seq: 42,
    received_at: '2026-10-02T10:00:01Z',
    event: `ev_${U1}`,
  };

  it('accepts server fields and flags', () => {
    expect(validateDeliveredEnvelope({ ...delivered, flags: ['retracted-dependency'] }).ok).toBe(
      true,
    );
  });

  it('requires the server fields', () => {
    expect(issues(validateDeliveredEnvelope(envelope('note')))).toEqual([
      ' required',
      ' required',
      ' required',
    ]);
  });

  it('accepts notices from system:quorum', () => {
    expect(validateDeliveredEnvelope({ ...delivered, from: 'system:quorum' }).ok).toBe(true);
  });

  it('accepts a type this client does not know, so it can be shown as a note', () => {
    expect(
      validateDeliveredEnvelope({ ...delivered, type: 'future_type', body: { anything: true } }).ok,
    ).toBe(true);
  });

  it('still validates bodies of known types', () => {
    expect(issues(validateDeliveredEnvelope({ ...delivered, body: {} }))).toEqual([
      '/body required',
    ]);
  });
});

describe('RFC 3339 timestamps', () => {
  it.each(['2026-10-02T10:00:00Z', '2026-10-02T10:00:00.123+05:30', '2024-02-29T00:00:00Z'])(
    'accepts %s',
    (value) => {
      expect(isRfc3339(value)).toBe(true);
    },
  );

  it.each([
    '2026-10-02',
    '2026-13-01T00:00:00Z',
    '2025-02-29T00:00:00Z',
    '2026-10-02 10:00:00Z',
    '2026-10-02T24:00:00Z',
  ])('rejects %s', (value) => {
    expect(isRfc3339(value)).toBe(false);
  });
});

describe('session labels (MESSAGE_SPEC §1.1)', () => {
  it.each(['claude@api-1', 'codex@web-12', 'claude@abhijna-laptop-api-2'])(
    'accepts %s as a recipient',
    (label) => {
      expect(issues(validateSubmittedEnvelope({ ...envelope('note'), to: [label] }))).toEqual([]);
    },
  );

  it.each(['claude@api', 'claude@api-0', 'Claude@api-1', 'claude@-1', 'claude@api-1x'])(
    'rejects the malformed label %s',
    (label) => {
      expect(issues(validateSubmittedEnvelope({ ...envelope('note'), to: [label] }))).toEqual([
        '/to/0 pattern',
      ]);
    },
  );

  it('never lets a client claim a sending session or session targets (INV-7)', () => {
    const forged = {
      ...envelope('note'),
      from_session: { id: `sess_${U1}`, label: 'claude@api-1', machine: 'laptop-a' },
      delivered_to: ['agent:codex-web@laptop-a'],
      to_sessions: [`sess_${U1}`],
    };
    expect(issues(validateSubmittedEnvelope(forged))).toEqual([
      '/from_session false schema',
      '/delivered_to false schema',
      '/to_sessions false schema',
    ]);
  });

  it('delivers the sending session and the session targets', () => {
    const delivered = {
      ...envelope('note'),
      to: ['codex@web-1'],
      seq: 3,
      received_at: '2026-10-02T10:00:01Z',
      event: `ev_${U1}`,
      from_session: { id: `sess_${U1}`, label: 'claude@api-1', machine: 'laptop-a' },
      delivered_to: ['agent:codex-web@laptop-a'],
      to_sessions: [`sess_${U1}`],
    };
    expect(issues(validateDeliveredEnvelope(delivered))).toEqual([]);
  });
});
