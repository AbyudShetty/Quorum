// The per-workspace, append-only hash chain (ARCHITECTURE §3, INV-8).
//   hash      = SHA-256( JCS(event without hash) )
//   prev_hash = hash of the previous event, or the genesis hash for seq 1
//   genesis   = SHA-256( "quorum/1 genesis " + workspace )
import { createHash } from 'node:crypto';
import { type EventRecord, validateApiPayload } from '@quorum/schemas';
import { canonicalJson } from './canonical-json.js';

export type { EventRecord };

/** The last event of a chain: what a client remembers as a checkpoint. */
export interface ChainHead {
  seq: number;
  hash: string;
}

/** What the caller supplies for a new event; the chain fills in workspace, seq and hashes. */
export interface NewEvent {
  ev_id: string;
  ts: string;
  actor: string;
  kind: string;
  payload: Record<string, unknown>;
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export const genesisHash = (workspace: string): string => sha256(`quorum/1 genesis ${workspace}`);

/** The hash an event must carry, computed from everything except `hash` itself. */
export const hashEvent = (event: Omit<EventRecord, 'hash'> & { hash?: string }): string => {
  const { hash: _ignored, ...rest } = event;
  return sha256(canonicalJson(rest));
};

/** Build the next event of a workspace chain. `head` is undefined for the first event. */
export const chainEvent = (
  workspace: string,
  head: ChainHead | undefined,
  input: NewEvent,
): EventRecord => {
  const unhashed = {
    ev_id: input.ev_id,
    workspace,
    seq: (head?.seq ?? 0) + 1,
    ts: input.ts,
    actor: input.actor,
    kind: input.kind,
    payload: input.payload,
    prev_hash: head?.hash ?? genesisHash(workspace),
  };
  return { ...unhashed, hash: hashEvent(unhashed) };
};

export type ChainProblemKind =
  | 'invalid_event'
  | 'workspace_mismatch'
  | 'seq_mismatch'
  | 'duplicate_event_id'
  | 'prev_hash_mismatch'
  | 'hash_mismatch'
  | 'checkpoint_mismatch'
  | 'checkpoint_missing';

export interface ChainProblem {
  kind: ChainProblemKind;
  /** The seq where verification stopped (for checkpoints: the checkpoint's seq). */
  seq: number;
  message: string;
}

export type VerifyResult =
  | { ok: true; head: ChainHead | undefined; count: number }
  | { ok: false; problem: ChainProblem; verifiedUpTo: number };

/**
 * Verify a workspace's events in order (INV-8). Detects a modified event (hash mismatch), an
 * inserted, deleted or reordered event (seq or prev_hash mismatch), and events from another
 * workspace. A consistent rewrite of the whole log passes these checks, so also pass the
 * checkpoints that members' clients remember: any rewrite before a checkpoint is then detected.
 */
export const verifyChain = (
  workspace: string,
  events: Iterable<unknown>,
  checkpoints: readonly ChainHead[] = [],
): VerifyResult => {
  let head: ChainHead | undefined;
  const seen = new Set<string>();
  const hashAt = new Map<number, string>();
  const fail = (kind: ChainProblemKind, seq: number, message: string): VerifyResult => ({
    ok: false,
    problem: { kind, seq, message },
    verifiedUpTo: head?.seq ?? 0,
  });

  for (const raw of events) {
    const expectedSeq = (head?.seq ?? 0) + 1;
    const checked = validateApiPayload('event', raw);
    if (!checked.ok) {
      const issue = checked.issues[0];
      return fail(
        'invalid_event',
        expectedSeq,
        `event ${String(expectedSeq)} is malformed: ${issue?.path ?? ''} ${issue?.message ?? ''}`.trim(),
      );
    }
    const event = checked.value;
    if (event.workspace !== workspace) {
      return fail(
        'workspace_mismatch',
        event.seq,
        `event ${String(event.seq)} belongs to ${event.workspace}, not ${workspace}`,
      );
    }
    if (event.seq !== expectedSeq) {
      return fail(
        'seq_mismatch',
        event.seq,
        `expected seq ${String(expectedSeq)} but found ${String(event.seq)}: an event was inserted, deleted or reordered`,
      );
    }
    if (seen.has(event.ev_id)) {
      return fail('duplicate_event_id', event.seq, `event id ${event.ev_id} appears twice`);
    }
    const expectedPrev = head?.hash ?? genesisHash(workspace);
    if (event.prev_hash !== expectedPrev) {
      return fail(
        'prev_hash_mismatch',
        event.seq,
        `event ${String(event.seq)} does not link to the previous event: history before it was changed`,
      );
    }
    if (hashEvent(event) !== event.hash) {
      return fail(
        'hash_mismatch',
        event.seq,
        `event ${String(event.seq)} was modified after it was recorded`,
      );
    }
    seen.add(event.ev_id);
    hashAt.set(event.seq, event.hash);
    head = { seq: event.seq, hash: event.hash };
  }

  for (const checkpoint of checkpoints) {
    const hash = hashAt.get(checkpoint.seq);
    if (hash === undefined) {
      return fail(
        'checkpoint_missing',
        checkpoint.seq,
        `a client saw event ${String(checkpoint.seq)}, but the log ends at ${String(head?.seq ?? 0)}: the log was truncated`,
      );
    }
    if (hash !== checkpoint.hash) {
      return fail(
        'checkpoint_mismatch',
        checkpoint.seq,
        `event ${String(checkpoint.seq)} differs from what a client saw: the log was rewritten`,
      );
    }
  }

  return { ok: true, head, count: head?.seq ?? 0 };
};
