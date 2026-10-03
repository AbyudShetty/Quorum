// What an adapter knows about its attachment (ARCHITECTURE §12) besides its tokens: which agent
// it is, which workspaces it may use, how it may wake. `quorum attach` writes one file per
// attachment into the private data directory; nothing secret is in it (tokens live in the
// keychain, INV-25), and nothing is ever written into the attached project folder.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
  /** Narrows which message types may wake the agent (POLICY_SPEC `wake_types`). */
  wake_types?: string[];
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

/** Forget an attachment's record (`quorum detach`). The keychain entry is removed by the caller. */
export const removeAttachment = (dataDir: string, attachment: string): Promise<void> =>
  rm(infoPath(dataDir, attachment), { force: true });
