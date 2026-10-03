// The local bootstrap code file `<data dir>/local/bootstrap.json` (ARCHITECTURE §6). On each start
// the local server writes a single-use code here (10-minute expiry); the CLI reads it and exchanges
// it at POST /v1/auth/local-bootstrap for the owner's human tokens. The code is a secret: only the
// private data directory protects it (INV-25), so it is never logged and removed once spent.
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type LocalBootstrapFile, validateApiPayload } from '@quorum/schemas';
import { writePrivateFile } from './data-dir.js';

export const bootstrapPath = (dataDir: string): string => join(dataDir, 'local', 'bootstrap.json');

/** Publish a new code atomically, replacing any earlier one. */
export const writeBootstrapCode = (dataDir: string, file: LocalBootstrapFile): Promise<void> =>
  writePrivateFile(bootstrapPath(dataDir), `${JSON.stringify(file, null, 2)}\n`);

/**
 * The current code, or undefined if there is none, it is malformed, or it has expired (`now`).
 * An expired code is reported as missing: the server would refuse it anyway.
 */
export const readBootstrapCode = async (
  dataDir: string,
  now: Date = new Date(),
): Promise<LocalBootstrapFile | undefined> => {
  let text: string;
  try {
    text = await readFile(bootstrapPath(dataDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const result = validateApiPayload('localBootstrapFile', JSON.parse(text));
    if (!result.ok) return undefined;
    return Date.parse(result.value.expires_at) > now.getTime() ? result.value : undefined;
  } catch {
    return undefined;
  }
};

export const removeBootstrapCode = (dataDir: string): Promise<void> =>
  rm(bootstrapPath(dataDir), { force: true });
