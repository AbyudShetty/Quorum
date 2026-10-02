// The `quorum export` format (ARCHITECTURE §3): one event per line, canonical JSON, oldest first.
import { canonicalJson } from './canonical-json.js';
import type { EventRecord } from './hash-chain.js';

/** Serialize events as JSON Lines (each line canonical, file ends with a newline). */
export const toJsonl = (events: Iterable<EventRecord>): string => {
  let out = '';
  for (const event of events) out += `${canonicalJson(event)}\n`;
  return out;
};

export interface JsonlProblem {
  /** 1-based line number. */
  line: number;
  message: string;
}

/**
 * Parse JSON Lines. Blank lines are skipped; a line that is not JSON is reported and parsing
 * stops there, because everything after it can no longer be trusted to be in order.
 * Values are returned unchecked: pass them to `verifyChain`.
 */
export const parseJsonl = (text: string): { values: unknown[]; problem?: JsonlProblem } => {
  const values: unknown[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      return {
        values,
        problem: { line: index + 1, message: `line ${String(index + 1)} is not valid JSON` },
      };
    }
  }
  return { values };
};
