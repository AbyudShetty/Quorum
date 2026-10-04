// Accepting messages and reading them back (MESSAGE_SPEC §2, §4).
// `acceptMessage` decides; the caller appends the resulting event to the store and then
// applies it to the `MessageLog` projection. Nothing here does I/O.
import { createHash } from 'node:crypto';
import {
  type DeliveredEnvelope,
  type MessageType,
  type SubmittedEnvelope,
  validateSubmittedEnvelope,
} from '@quorum/schemas';
import { canonicalJson } from './canonical-json.js';
import { DomainError } from './errors.js';
import type { EventRecord, NewEvent } from './hash-chain.js';
import type { IdFactory } from './ids.js';
import { findSecrets } from './secrets.js';

/** Who is calling, as established from their token (never from the request body). */
export interface Principal {
  kind: 'agent' | 'human';
  address: string;
  /** Message types this token may send (INV-12). Undefined = every type its kind may send. */
  messageTypes?: ReadonlySet<MessageType>;
}

/** Event kinds this module writes and reads. */
export const MESSAGE_EVENTS = {
  accepted: 'message.accepted',
  acked: 'inbox.acked',
} as const;

export type AcceptOutcome =
  /** New message: append `event`; its seq becomes the message's seq. */
  | { outcome: 'append'; event: NewEvent; envelope: SubmittedEnvelope }
  /** Same id and identical content as an earlier message: return the original result. */
  | { outcome: 'duplicate'; original: StoredMessage }
  /** A heartbeat: update presence, record nothing (MESSAGE_SPEC §5.10). */
  | { outcome: 'presence'; envelope: SubmittedEnvelope & { type: 'heartbeat' } };

export interface AcceptRequest {
  /** The workspace in the URL. */
  workspace: string;
  principal: Principal;
  /** The request body, unchecked. */
  input: unknown;
  /** Server time (RFC 3339). */
  now: string;
  ids: IdFactory;
}

const contentHash = (envelope: unknown): string =>
  createHash('sha256').update(canonicalJson(envelope), 'utf8').digest('hex');

/**
 * Check a submitted message against every rule that does not need storage, in this order:
 * schema and size → workspace → sender identity (INV-7) → human-only types (INV-1) →
 * token scope (INV-12) → secrets (INV-14) → idempotency (MESSAGE_SPEC §2.1.3).
 * Throws DomainError for the first rule that fails.
 */
export const acceptMessage = (log: MessageLog, request: AcceptRequest): AcceptOutcome => {
  const { principal, input } = request;

  const checked = validateSubmittedEnvelope(input);
  if (!checked.ok) {
    const tooBig = checked.issues.find((i) => i.rule === 'maxBytes');
    if (tooBig) {
      throw new DomainError(
        'too_large',
        'message.too_large',
        tooBig.message,
        'Put large content in an artifact and reference it from the message.',
        '/body',
      );
    }
    const first = checked.issues[0];
    throw new DomainError(
      'invalid',
      'message.invalid',
      `The message does not match the quorum/1 schema: ${first?.path || '(root)'} ${first?.message ?? ''}`.trim(),
      'Fix the field at `path` and send again; see docs/MESSAGE_SPEC.md for the rules.',
      first?.path ?? '',
    );
  }
  const envelope = checked.value;

  if (envelope.workspace !== request.workspace) {
    throw new DomainError(
      'invalid',
      'message.workspace_mismatch',
      `The message names ${envelope.workspace} but was sent to ${request.workspace}.`,
      'Send it to the workspace named in its `workspace` field.',
      '/workspace',
    );
  }

  if (envelope.from !== principal.address) {
    throw new DomainError(
      'forbidden',
      'message.sender_mismatch',
      `The message claims to be from ${envelope.from}, but the token belongs to ${principal.address}.`,
      `Set "from" to "${principal.address}".`,
      '/from',
    );
  }

  if (envelope.type === 'approval_decision' && principal.kind !== 'human') {
    throw new DomainError(
      'forbidden',
      'message.human_only',
      'Only humans can decide approvals.',
      'Ask a human to approve or reject in the approval queue.',
      '/type',
    );
  }

  if (principal.messageTypes && !principal.messageTypes.has(envelope.type)) {
    throw new DomainError(
      'forbidden',
      'message.type_not_allowed',
      `This token may not send "${envelope.type}" messages.`,
      'Ask a workspace owner to widen the agent scope in the policy, or send a different type.',
      '/type',
    );
  }

  const secret =
    findSecrets(envelope.body, '/body')[0] ?? findSecrets(envelope.refs ?? [], '/refs')[0];
  if (secret) {
    throw new DomainError(
      'invalid',
      'message.secret_detected',
      `The message contains what looks like a ${secret.kind}. It was not stored.`,
      'Remove the secret and rotate it if it was real. Share credentials through your own secret manager, never through Quorum.',
      secret.path,
    );
  }

  const existing = log.byId(envelope.id);
  if (existing) {
    if (existing.contentHash === contentHash(envelope))
      return { outcome: 'duplicate', original: existing };
    throw new DomainError(
      'conflict',
      'message.id_conflict',
      `A different message with id ${envelope.id} was already accepted.`,
      'Use a fresh id for a new message; resend identical content to retry safely.',
      '/id',
    );
  }

  if (envelope.type === 'heartbeat') {
    return { outcome: 'presence', envelope: envelope as SubmittedEnvelope & { type: 'heartbeat' } };
  }

  // Thread: as sent; else the thread of the message it replies to; else a new thread.
  const thread =
    envelope.thread ??
    (envelope.reply_to ? log.byId(envelope.reply_to)?.envelope.thread : undefined) ??
    request.ids.id('thread');
  const stored = { ...envelope, thread } as SubmittedEnvelope;

  return {
    outcome: 'append',
    envelope: stored,
    event: {
      ev_id: request.ids.id('event'),
      ts: request.now,
      actor: principal.address,
      kind: MESSAGE_EVENTS.accepted,
      // The hash covers what the client sent, so a retry with the same body is recognised.
      payload: { envelope: stored, content_hash: contentHash(envelope) },
    },
  };
};

/** The only sender a client can never be (INV-7): server notices (MESSAGE_SPEC §4). */
export const SYSTEM_ADDRESS = 'system:quorum';

/**
 * A server notice: a `note` from `system:quorum` with a machine-readable `kind`
 * (e.g. `shared_worktree`), recorded like any other message. Clients trust `kind` only when the
 * sender is `system:quorum`; agents can put any text in their own notes.
 */
export const systemNotice = (request: {
  workspace: string;
  to: readonly string[];
  kind: string;
  text: string;
  details?: Record<string, unknown>;
  now: string;
  ids: IdFactory;
}): { event: NewEvent; envelope: SubmittedEnvelope } => {
  const envelope = {
    spec: 'quorum/1',
    id: request.ids.id('message'),
    workspace: request.workspace,
    from: SYSTEM_ADDRESS,
    to: [...request.to],
    type: 'note',
    type_version: 1,
    thread: request.ids.id('thread'),
    created_at: request.now,
    body: { ...request.details, text: request.text, kind: request.kind },
  } as unknown as SubmittedEnvelope;
  return {
    envelope,
    event: {
      ev_id: request.ids.id('event'),
      ts: request.now,
      actor: SYSTEM_ADDRESS,
      kind: MESSAGE_EVENTS.accepted,
      payload: { envelope, content_hash: contentHash(envelope) },
    },
  };
};

/** An acknowledgement as an event: who has read up to which seq. */
export const ackEvent = (
  principal: Principal,
  upTo: number,
  now: string,
  ids: IdFactory,
): NewEvent => {
  if (!Number.isInteger(upTo) || upTo < 0) {
    throw new DomainError(
      'invalid',
      'inbox.bad_ack',
      'up_to must be a non-negative integer.',
      'Send the seq of the last message you processed.',
      '/up_to',
    );
  }
  return {
    ev_id: ids.id('event'),
    ts: now,
    actor: principal.address,
    kind: MESSAGE_EVENTS.acked,
    payload: { address: principal.address, up_to: upTo },
  };
};

export interface StoredMessage {
  envelope: SubmittedEnvelope;
  seq: number;
  received_at: string;
  event: string;
  contentHash: string;
}

export interface Page {
  messages: DeliveredEnvelope[];
  next_after: number;
  has_more: boolean;
}

/** Who may read a message: its recipients, and everyone but the sender for broadcasts. */
export const canSee = (address: string, envelope: SubmittedEnvelope): boolean =>
  envelope.to.includes(address) || (envelope.to.includes('*') && envelope.from !== address);

const deliver = (m: StoredMessage): DeliveredEnvelope => ({
  ...m.envelope,
  seq: m.seq,
  received_at: m.received_at,
  event: m.event,
});

/**
 * The messages projection (ARCHITECTURE §3): rebuilt by replaying `message.accepted` and
 * `inbox.acked` events in order. Other event kinds are ignored.
 */
export class MessageLog {
  readonly #bySeq: StoredMessage[] = [];
  readonly #byId = new Map<string, StoredMessage>();
  readonly #acked = new Map<string, number>();

  apply(event: EventRecord): void {
    if (event.kind === MESSAGE_EVENTS.accepted) {
      const payload = event.payload as { envelope: SubmittedEnvelope; content_hash: string };
      const stored: StoredMessage = {
        envelope: payload.envelope,
        seq: event.seq,
        received_at: event.ts,
        event: event.ev_id,
        contentHash: payload.content_hash,
      };
      this.#bySeq.push(stored);
      this.#byId.set(stored.envelope.id, stored);
    } else if (event.kind === MESSAGE_EVENTS.acked) {
      const { address, up_to } = event.payload as { address: string; up_to: number };
      this.#acked.set(address, Math.max(this.#acked.get(address) ?? 0, up_to));
    }
  }

  byId(id: string): StoredMessage | undefined {
    return this.#byId.get(id);
  }

  /** The highest seq this address has acknowledged (0 if none). */
  ackedUpTo(address: string): number {
    return this.#acked.get(address) ?? 0;
  }

  /** Messages the address may see with seq > after, oldest first. */
  inbox(address: string, options: { after?: number; limit?: number } = {}): Page {
    return this.#page((m) => canSee(address, m.envelope), options);
  }

  /** Messages in one thread that the address may see. */
  thread(
    threadId: string,
    address: string,
    options: { after?: number; limit?: number } = {},
  ): Page {
    return this.#page(
      (m) => m.envelope.thread === threadId && canSee(address, m.envelope),
      options,
    );
  }

  #page(visible: (m: StoredMessage) => boolean, options: { after?: number; limit?: number }): Page {
    const after = options.after ?? 0;
    const limit = options.limit ?? 100;
    const matching = this.#bySeq.filter((m) => m.seq > after && visible(m));
    const page = matching.slice(0, limit);
    return {
      messages: page.map(deliver),
      next_after: page.at(-1)?.seq ?? after,
      has_more: matching.length > page.length,
    };
  }
}
