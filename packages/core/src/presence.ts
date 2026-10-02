// Presence from heartbeats (MESSAGE_SPEC §5.10): heartbeats are not events; only the
// transitions online ↔ offline are recorded. An agent is offline after 3 missed intervals.
import type { HeartbeatBody } from '@quorum/schemas';

export interface PresenceEntry {
  address: string;
  presence: 'online' | 'offline';
  status: HeartbeatBody['status'];
  current_task?: string;
  last_seen: number;
}

export interface PresenceChange {
  address: string;
  presence: 'online' | 'offline';
  at: number;
}

export class PresenceBook {
  readonly #entries = new Map<string, PresenceEntry>();

  constructor(
    /** Expected heartbeat interval in milliseconds. */
    private readonly intervalMs: number,
  ) {}

  /** Record a heartbeat. Returns a change when the agent comes (back) online. */
  heartbeat(address: string, body: HeartbeatBody, nowMs: number): PresenceChange | undefined {
    const before = this.#entries.get(address);
    const online = body.status !== 'offline';
    this.#entries.set(address, {
      address,
      presence: online ? 'online' : 'offline',
      status: body.status,
      ...(body.current_task === undefined ? {} : { current_task: body.current_task }),
      last_seen: nowMs,
    });
    const wasOnline = before?.presence === 'online';
    if (online !== wasOnline)
      return { address, presence: online ? 'online' : 'offline', at: nowMs };
    return undefined;
  }

  /** Mark agents offline after 3 missed intervals; returns the transitions to record. */
  sweep(nowMs: number): PresenceChange[] {
    const changes: PresenceChange[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.presence === 'online' && nowMs - entry.last_seen > 3 * this.intervalMs) {
        entry.presence = 'offline';
        entry.status = 'offline';
        changes.push({ address: entry.address, presence: 'offline', at: nowMs });
      }
    }
    return changes;
  }

  get(address: string): PresenceEntry | undefined {
    const entry = this.#entries.get(address);
    return entry && { ...entry };
  }
}
