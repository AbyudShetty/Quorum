// The local discovery file `<data dir>/local/server.json` (ARCHITECTURE §8.2). Adapters and the
// CLI read it to find the local server's port and the key to pin. It holds no secrets.
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type LocalDiscovery, validateApiPayload } from '@quorum/schemas';
import { writePrivateFile } from './data-dir.js';

export const discoveryPath = (dataDir: string): string => join(dataDir, 'local', 'server.json');

/** Publish the running server's details atomically (readers never see a partial file). */
export const writeDiscovery = (dataDir: string, info: LocalDiscovery): Promise<void> =>
  writePrivateFile(discoveryPath(dataDir), `${JSON.stringify(info, null, 2)}\n`);

/**
 * The published details, or undefined if there is no file or it is malformed. A malformed file is
 * treated like a missing one: the caller then performs the identity handshake anyway (INV-24).
 */
export const readDiscovery = async (dataDir: string): Promise<LocalDiscovery | undefined> => {
  let text: string;
  try {
    text = await readFile(discoveryPath(dataDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const result = validateApiPayload('localDiscovery', JSON.parse(text));
    return result.ok ? result.value : undefined;
  } catch {
    return undefined;
  }
};

export const removeDiscovery = (dataDir: string): Promise<void> =>
  rm(discoveryPath(dataDir), { force: true });
