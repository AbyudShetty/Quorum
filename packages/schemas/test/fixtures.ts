// Valid example messages, typed with the TypeScript view so the types and the JSON Schemas
// are checked against each other (if a type drifts from its schema, a fixture breaks).
import type { BodyByType, MessageType, SubmittedEnvelope } from '../src/index.js';

/** Valid Crockford ULIDs. */
export const U1 = '01J9Z8X7W6V5T4S3R2Q1P0N9M8';
export const U2 = '01J9Z8X7W6V5T4S3R2Q1P0N9M9';
export const HASH = 'a'.repeat(64);

export const bodies: { [T in MessageType]: BodyByType[T] } = {
  note: { text: 'Feature extraction v3 is ready for review.' },
  request: {
    title: 'Validate the v3 features on fold 2',
    description: 'Run the standard CV on fold 2 with the v3 feature set.',
    inputs: [`artifact:art_${U1}@v3`, 'fold 2 only'],
    expected_outputs: ['A finding with AUC and the exact command used'],
    priority: 'high',
  },
  task_update: { task_id: `tk_${U1}`, status: 'running', progress: 0.4 },
  finding: {
    claim: 'v3 features improve fold-2 AUC by 0.012',
    method: '5-fold CV, seed 1, same split as baseline',
    metrics: { auc: { value: 0.912, baseline: 0.9, ci95: [0.905, 0.919] }, logloss: 0.21 },
    sample_size: 48000,
    data_refs: [`artifact:art_${U1}@v3`],
    reproduce: 'python cv.py --features v3 --fold 2 --seed 1',
    confidence: 'medium',
    caveats: ['single seed'],
  },
  retraction: {
    finding_id: `fd_${U1}`,
    reason: 'The baseline was measured on a different split.',
    new_evidence: [`finding:fd_${U2}`],
  },
  artifact_ready: {
    artifact_id: `art_${U1}`,
    version: 3,
    sha256: HASH,
    size: 1024,
    storage: 'local_ref',
    location: { machine: 'laptop-a', attachment: `at_${U1}`, path: 'data/features_v3.parquet' },
    how_to_use: 'Load with pandas.read_parquet.',
  },
  lease: {
    resource: 'gpu:laptop-a/0',
    action: 'acquire',
    mode: 'exclusive',
    until: '2026-10-02T18:00:00Z',
    reason: 'Training run for fold 2',
  },
  approval_request: {
    action: 'git.push',
    summary: 'Push the v3 feature pipeline to main',
    risk: 'medium',
    evidence_refs: [`finding:fd_${U1}`],
    diff_or_preview: 'diff --git a/features.py b/features.py ...',
    rollback_plan: 'git revert the merge commit',
  },
  approval_decision: {
    request_id: `ap_${U1}`,
    decision: 'reject',
    preview_hash: HASH,
    comment: 'The baseline comparison uses a different split.',
  },
  heartbeat: { status: 'working', current_task: `tk_${U1}`, resources_in_use: [`ls_${U1}`] },
};

export const envelope = <T extends MessageType>(
  type: T,
  body: BodyByType[T] = bodies[type],
): SubmittedEnvelope =>
  ({
    spec: 'quorum/1',
    id: `msg_${U1}`,
    workspace: `ws_${U1}`,
    thread: `th_${U1}`,
    from: 'agent:claude-api@laptop-a',
    to: ['agent:codex-web@laptop-a'],
    type,
    type_version: 1,
    created_at: '2026-10-02T10:00:00Z',
    body,
    refs: [`artifact:art_${U1}@v3`],
  }) as SubmittedEnvelope;
