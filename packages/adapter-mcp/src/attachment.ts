// What an adapter knows about its attachment (ARCHITECTURE §12) besides its tokens: which agent
// it is, which workspaces it may use, how it may wake. `quorum attach` writes one file per
// attachment into the private data directory; nothing secret is in it (tokens live in the
// keychain, INV-25), and nothing is ever written into the attached project folder.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface AttachmentInfo {
  /** `at_…` */
  attachment: string;
  /** The agent's address, e.g. agent:claude-api@abhijna. */
  agent: string;
  workspaces: string[];
  vendor: string;
  /** Canonical absolute path of the attached folder. */
  root: string;
  wake: 'off' | 'direct' | 'all';
  lease_enforcement: 'warn' | 'block';
}

const isInfo = (value: unknown): value is AttachmentInfo => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.attachment === 'string' &&
    typeof v.agent === 'string' &&
    Array.isArray(v.workspaces) &&
    v.workspaces.length > 0 &&
    v.workspaces.every((w) => typeof w === 'string') &&
    typeof v.vendor === 'string' &&
    typeof v.root === 'string' &&
    (v.wake === 'off' || v.wake === 'direct' || v.wake === 'all') &&
    (v.lease_enforcement === 'warn' || v.lease_enforcement === 'block')
  );
};

const safe = (id: string): string => id.replaceAll(/[^A-Za-z0-9_-]/g, '_');

const infoPath = (dataDir: string, attachment: string): string =>
  join(dataDir, 'attachments', `${safe(attachment)}.json`);

export const saveAttachment = async (dataDir: string, info: AttachmentInfo): Promise<void> => {
  await mkdir(join(dataDir, 'attachments'), { recursive: true, mode: 0o700 });
  const path = infoPath(dataDir, info.attachment);
  const temp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(temp, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
};

export const loadAttachment = async (
  dataDir: string,
  attachment: string,
): Promise<AttachmentInfo | undefined> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(infoPath(dataDir, attachment), 'utf8'));
    return isInfo(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The highest message `seq` this attachment has already handed to its agent, per workspace.
 * Stored per attachment so the MCP server and hooks (separate processes) agree and a restart does
 * not replay old mail. Delivery is still at-least-once: consumers dedupe by message id.
 */
export class Cursor {
  readonly #path: string;

  constructor(dataDir: string, attachment: string) {
    this.#path = join(dataDir, 'cursor', `${safe(attachment)}.json`);
  }

  async #all(): Promise<Record<string, number>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#path, 'utf8'));
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, number>)
        : {};
    } catch {
      return {};
    }
  }

  async get(workspace: string): Promise<number> {
    const value = (await this.#all())[workspace];
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
  }

  /** Only ever moves forward. */
  async advance(workspace: string, seq: number): Promise<void> {
    const all = await this.#all();
    if ((all[workspace] ?? 0) >= seq) return;
    all[workspace] = seq;
    await mkdir(join(this.#path, '..'), { recursive: true, mode: 0o700 });
    const temp = `${this.#path}.${String(process.pid)}.tmp`;
    await writeFile(temp, JSON.stringify(all), { mode: 0o600 });
    await rename(temp, this.#path);
  }
}
