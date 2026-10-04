// Whether a new message may wake (or auto-continue) an agent: the user's wake mode (D-9),
// the per-agent wake budget, and the agent-only-loop circuit breaker (INV-29).
// How a wake is delivered is per vendor (ARCHITECTURE §15); this module only decides.
import type { MessageType, SubmittedEnvelope } from '@quorum/schemas';

export interface WakeSettings {
  mode: 'off' | 'direct' | 'all';
  /** Only these message types may wake the agent (undefined = all types). */
  types?: readonly MessageType[];
}

export interface WakeLimits {
  /** Per agent, rolling 60 minutes (POLICY_SPEC `wakes_per_hour`). */
  wakesPerHour: number;
  /** Per thread; wakes pause until a human posts there (`agent_only_messages_before_pause`). */
  agentOnlyMessagesBeforePause: number;
}

export type WakeDecision =
  | { wake: true }
  | {
      wake: false;
      reason:
        | 'mode_off'
        | 'own_message'
        | 'not_direct'
        | 'type_filtered'
        | 'thread_paused'
        | 'budget_exhausted';
    };

const HOUR_MS = 60 * 60 * 1000;
const threadOf = (m: SubmittedEnvelope): string => m.thread ?? m.id;

/**
 * Tracks recent wakes per agent and agent-only runs per thread. Feed every accepted message
 * to `observe`, then ask `decide` for each recipient. In-memory state: after a restart the
 * limits start fresh, which can only make the server stricter about later wakes, never looser
 * about human oversight (a paused thread stays paused until a human writes, see `observe`).
 */
export class WakeGovernor {
  readonly #wakes = new Map<string, number[]>();
  readonly #agentRun = new Map<string, number>();

  constructor(private readonly limits: WakeLimits) {}

  /** Count consecutive agent-only messages per thread; any human message resets the count. */
  observe(message: SubmittedEnvelope): void {
    const thread = threadOf(message);
    if (message.from.startsWith('human:')) this.#agentRun.set(thread, 0);
    else if (message.from.startsWith('agent:'))
      this.#agentRun.set(thread, (this.#agentRun.get(thread) ?? 0) + 1);
  }

  /**
   * Count a wake granted earlier (replayed from the log at start), so a restart never refills the
   * hourly budget early.
   */
  recordWake(recipient: string, atMs: number): void {
    this.#wakes.set(recipient, [...(this.#wakes.get(recipient) ?? []), atMs]);
  }

  /** True when a thread has had too many agent-only messages in a row (INV-29). */
  isPaused(thread: string): boolean {
    return (this.#agentRun.get(thread) ?? 0) > this.limits.agentOnlyMessagesBeforePause;
  }

  /**
   * May `message` wake `recipient`? Records the wake when the answer is yes.
   * Waking never bypasses the agent's own permission prompts; that is the vendor's job.
   */
  decide(
    recipient: string,
    message: SubmittedEnvelope,
    settings: WakeSettings,
    nowMs: number,
  ): WakeDecision {
    if (settings.mode === 'off') return { wake: false, reason: 'mode_off' };
    if (message.from === recipient) return { wake: false, reason: 'own_message' };
    const direct = message.to.includes(recipient);
    if (!direct && settings.mode === 'direct') return { wake: false, reason: 'not_direct' };
    if (settings.types && !settings.types.includes(message.type))
      return { wake: false, reason: 'type_filtered' };
    if (this.isPaused(threadOf(message))) return { wake: false, reason: 'thread_paused' };

    const recent = (this.#wakes.get(recipient) ?? []).filter((t) => nowMs - t < HOUR_MS);
    if (recent.length >= this.limits.wakesPerHour) {
      this.#wakes.set(recipient, recent);
      return { wake: false, reason: 'budget_exhausted' };
    }
    this.#wakes.set(recipient, [...recent, nowMs]);
    return { wake: true };
  }
}
