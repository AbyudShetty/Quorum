// Client side of local-mode discovery (ARCHITECTURE §8.2): find the data directory, read the
// discovery file the server published and return the port and key to pin. The file holds no
// secrets; what protects the client is the identity handshake that follows (INV-24).
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type LocalDiscovery, validateApiPayload } from '@quorum/schemas';

/**
 * Same rule as the server: QUORUM_HOME if set; %LOCALAPPDATA%\Quorum on Windows; ~/.quorum
 * elsewhere. (Duplicated from @quorum/server so adapters do not depend on SQLite; the two must
 * stay equal, see the test.)
 */
export const defaultDataDir = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string => {
  if (env.QUORUM_HOME) return env.QUORUM_HOME;
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Quorum');
  }
  return join(home, '.quorum');
};

export const discoveryFile = (dataDir: string): string => join(dataDir, 'local', 'server.json');

/** The server's published details, or undefined if missing or malformed (treated alike). */
export const readLocalDiscovery = async (dataDir: string): Promise<LocalDiscovery | undefined> => {
  let text: string;
  try {
    text = await readFile(discoveryFile(dataDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const checked = validateApiPayload('localDiscovery', JSON.parse(text));
    return checked.ok ? checked.value : undefined;
  } catch {
    return undefined;
  }
};
