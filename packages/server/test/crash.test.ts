// Chaos: kill a writer process in the middle of appending (plan §11 layer 5). Nothing that was
// reported committed may be lost, no half-written event may appear, and the chain must verify.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyChain } from '@quorum/core';
import { afterAll, describe, expect, it } from 'vitest';
import { openDatabase, SqliteEventStore } from '../src/index.js';

const WS = 'ws_01J9Z8X7W6V5T4S3R2Q1P0N9M8';
const writer = fileURLToPath(new URL('./fixtures/crash-writer.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'quorum-crash-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run the writer until it reports `atLeast` commits, then kill it hard. Returns the last reported seq. */
const writeThenKill = (file: string, atLeast: number): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [writer, file, WS], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let lastCommitted = 0;
    let buffer = '';
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) lastCommitted = Number(line.replace('committed ', ''));
      if (lastCommitted >= atLeast && !child.killed) child.kill('SIGKILL');
    });
    child.on('exit', (code, signal) => {
      if (signal === 'SIGKILL' || child.killed) resolve(lastCommitted);
      else reject(new Error(`writer exited on its own (code ${String(code)}): ${stderr}`));
    });
    child.on('error', reject);
  });

describe('crash safety (SQLite, WAL, synchronous=FULL)', () => {
  it(
    'loses nothing that was committed when the writer is killed mid-write',
    { timeout: 60_000 },
    async () => {
      const file = join(dir, 'quorum.db');
      openDatabase(file).close(); // create the schema

      let reported = 0;
      for (let round = 1; round <= 3; round++) {
        reported = await writeThenKill(file, reported + 150);
      }

      const db = openDatabase(file);
      const events = await new SqliteEventStore(db).read(WS);
      db.close();
      expect(events.length).toBeGreaterThanOrEqual(reported);
      expect(verifyChain(WS, events)).toMatchObject({ ok: true, count: events.length });
    },
  );
});
