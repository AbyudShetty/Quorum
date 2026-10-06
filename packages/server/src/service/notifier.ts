// Live push to open streams (ARCHITECTURE §3 step 5, MESSAGE_SPEC §4). Transport-neutral: the HTTP
// layer turns a Subscriber into an SSE response; a WebSocket notifier could do the same later.
import { canSee, type StoredMessage } from '@quorum/core';
import type { DeliveredEnvelope } from '@quorum/schemas';

export interface Subscriber {
  /** hu_ or ag_ id: revocation closes every stream of a principal (INV-13). */
  principal: string;
  address: string;
  /** The window this stream belongs to: mail for other windows of the agent is not pushed here. */
  session?: string;
  workspace: string;
  send(message: DeliveredEnvelope): void;
  close(): void;
}

export const delivered = (m: StoredMessage): DeliveredEnvelope => ({
  ...m.envelope,
  seq: m.seq,
  received_at: m.received_at,
  event: m.event,
});

export class Notifier {
  readonly #subscribers = new Set<Subscriber>();

  add(subscriber: Subscriber): () => void {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }

  /** Push a newly committed message to every stream that may see it. */
  publish(workspace: string, message: StoredMessage): void {
    const payload = delivered(message);
    for (const sub of this.#subscribers) {
      if (sub.workspace === workspace && canSee(sub.address, message.envelope, sub.session)) {
        sub.send(payload);
      }
    }
  }

  /** Close every stream of a principal (revocation, detach). */
  closePrincipal(principal: string): void {
    for (const sub of [...this.#subscribers]) {
      if (sub.principal === principal) {
        this.#subscribers.delete(sub);
        sub.close();
      }
    }
  }

  isStreaming(principal: string): boolean {
    for (const sub of this.#subscribers) if (sub.principal === principal) return true;
    return false;
  }

  get size(): number {
    return this.#subscribers.size;
  }

  closeAll(): void {
    for (const sub of [...this.#subscribers]) sub.close();
    this.#subscribers.clear();
  }
}
