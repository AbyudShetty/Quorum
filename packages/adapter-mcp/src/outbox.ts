// The local outbox (MESSAGE_SPEC §4, INV-20): messages are written to disk before they are sent,
// so a server that is down or restarting loses nothing; idempotency by message id (§2.1.3) makes
// a re-send harmless. One file per message, named by its ULID, so enqueueing and flushing from
// two processes (MCP server and a hook) never rewrite each other's data.
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SubmittedEnvelope } from '@quorum/schemas';
import { ApiError, UnreachableError } from './client.js';

export interface QueuedMessage {
  workspace: string;
  envelope: SubmittedEnvelope;
}

export interface FlushResult {
  sent: string[];
  /** Rejected for good by the server; moved to `rejected/` with the reason. */
  rejected: { id: string; code: string; message: string }[];
  /** Still queued (server unreachable, rate limited or token expired). */
  pending: number;
  /** Why the flush stopped early, when it did. */
  stoppedBy?: 'unreachable' | 'credentials' | 'rate_limited' | 'server';
}

export type SendFn = (workspace: string, envelope: SubmittedEnvelope) => Promise<unknown>;

export class Outbox {
  readonly #dir: string;

  /**
   * @param dataDir the private Quorum data directory; it must already exist (the server creates
   *   it with owner-only permissions, INV-25), so the outbox never creates a more open one.
   * @param name one outbox per attachment
   */
  constructor(
    readonly dataDir: string,
    name: string,
  ) {
    this.#dir = join(dataDir, 'outbox', name.replaceAll(/[^A-Za-z0-9_-]/g, '_'));
  }

  async #ensure(): Promise<void> {
    try {
      await mkdir(join(this.dataDir, 'outbox'), { mode: 0o700 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new Error(
          `The Quorum data directory ${this.dataDir} does not exist. Run \`quorum serve --local\` once.`,
          { cause: error },
        );
      }
      if (code !== 'EEXIST') throw error;
    }
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
  }

  /** Write the message durably before any attempt to send it. */
  async enqueue(message: QueuedMessage): Promise<void> {
    await this.#ensure();
    const file = join(this.#dir, `${message.envelope.id}.json`);
    const temp = `${file}.${String(process.pid)}.tmp`;
    await writeFile(temp, JSON.stringify(message), { mode: 0o600 });
    await rename(temp, file);
  }

  async #queued(): Promise<string[]> {
    try {
      return (await readdir(this.#dir)).filter((f) => f.endsWith('.json')).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async size(): Promise<number> {
    return (await this.#queued()).length;
  }

  /** Send everything queued, oldest first. Stops at the first failure that a retry could fix. */
  async flush(send: SendFn): Promise<FlushResult> {
    const result: FlushResult = { sent: [], rejected: [], pending: 0 };
    const files = await this.#queued();
    for (const [index, name] of files.entries()) {
      const path = join(this.#dir, name);
      let message: QueuedMessage;
      try {
        message = JSON.parse(await readFile(path, 'utf8')) as QueuedMessage;
      } catch {
        // Another flusher finished this one, or the file is unreadable; leave it for the next pass.
        continue;
      }
      try {
        await send(message.workspace, message.envelope);
        await rm(path, { force: true });
        result.sent.push(message.envelope.id);
      } catch (error) {
        if (error instanceof ApiError && error.permanent) {
          await this.#reject(path, name, error);
          result.rejected.push({
            id: message.envelope.id,
            code: error.code,
            message: error.message,
          });
        } else if (error instanceof UnreachableError || error instanceof ApiError) {
          result.pending = files.length - index;
          result.stoppedBy =
            error instanceof UnreachableError
              ? 'unreachable'
              : error.status === 401
                ? 'credentials'
                : error.status === 429
                  ? 'rate_limited'
                  : 'server';
          return result;
        } else {
          throw error;
        }
      }
    }
    return result;
  }

  async #reject(path: string, name: string, error: ApiError): Promise<void> {
    const rejected = join(this.#dir, 'rejected');
    await mkdir(rejected, { recursive: true, mode: 0o700 });
    await writeFile(join(rejected, `${name}.reason.txt`), `${error.code}: ${error.message}\n`, {
      mode: 0o600,
    });
    await rename(path, join(rejected, name));
  }
}
