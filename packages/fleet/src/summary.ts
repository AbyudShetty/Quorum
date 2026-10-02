// Turning many agents' records into one verdict: how many messages were lost, how late the rest
// arrived, how many errors of each kind. "Lost" means sent successfully (the server said 201) but
// never seen by the addressed agent within the drain window.
import type { AgentResult } from './agent.js';

export interface FleetSummary {
  agents: number;
  sent: number;
  received: number;
  /** Sent but never received by the addressed agent. */
  lost: number;
  /** Received by an agent it was not addressed to (must be 0). */
  misdelivered: number;
  duplicates: number;
  latencyMs: { p50: number; p95: number; p99: number; max: number };
  errors: Record<string, number>;
}

const percentile = (sorted: readonly number[], p: number): number =>
  sorted.length === 0
    ? Number.NaN
    : (sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? Number.NaN);

export const summarize = (results: readonly AgentResult[]): FleetSummary => {
  const receivedBy = new Map<string, Set<string>>();
  for (const r of results) receivedBy.set(r.address, new Set(r.received.map((m) => m.id)));

  const addressedTo = new Map<string, string>();
  let sent = 0;
  let lost = 0;
  for (const r of results) {
    for (const s of r.sent) {
      sent += 1;
      addressedTo.set(s.id, s.to);
      // An address outside the result set cannot be judged; count it as not lost.
      if (receivedBy.has(s.to) && !receivedBy.get(s.to)?.has(s.id)) lost += 1;
    }
  }

  let received = 0;
  let misdelivered = 0;
  const latencies: number[] = [];
  const errors: Record<string, number> = {};
  let duplicates = 0;
  for (const r of results) {
    for (const m of r.received) {
      received += 1;
      const intended = addressedTo.get(m.id);
      if (intended !== undefined && intended !== r.address) misdelivered += 1;
      if (Number.isFinite(m.latencyMs)) latencies.push(m.latencyMs);
    }
    duplicates += r.duplicates;
    for (const [code, n] of Object.entries(r.errors)) errors[code] = (errors[code] ?? 0) + n;
  }
  latencies.sort((a, b) => a - b);

  return {
    agents: results.length,
    sent,
    received,
    lost,
    misdelivered,
    duplicates,
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: latencies.at(-1) ?? Number.NaN,
    },
    errors,
  };
};

const ms = (value: number): string => (Number.isFinite(value) ? `${value.toFixed(1)} ms` : 'n/a');

export const formatSummary = (s: FleetSummary): string =>
  [
    `agents ${String(s.agents)}   sent ${String(s.sent)}   received ${String(s.received)}`,
    `lost ${String(s.lost)}   misdelivered ${String(s.misdelivered)}   duplicates ${String(s.duplicates)}`,
    `latency p50 ${ms(s.latencyMs.p50)}   p95 ${ms(s.latencyMs.p95)}   p99 ${ms(s.latencyMs.p99)}   max ${ms(s.latencyMs.max)}`,
    `errors ${Object.keys(s.errors).length === 0 ? 'none' : JSON.stringify(s.errors)}`,
  ].join('\n');

/** The run passes when nothing was lost or misdelivered and no request failed. */
export const passed = (s: FleetSummary): boolean =>
  s.lost === 0 && s.misdelivered === 0 && Object.keys(s.errors).length === 0;
