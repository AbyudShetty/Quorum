// Process entry: wires the real keychain and the real stdout/stderr into `main`.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { closeRelayConnections, KeychainCredentialStore } from '@quorum/adapter-mcp';
import { defaultDataDir } from '@quorum/local';
import { main } from './cli.js';
import { ensureLocalServer } from './local-server.js';

/**
 * The keychain service for this data folder (INV-25). The usual folder keeps plain `quorum`;
 * another one (QUORUM_HOME: a trial install, a test) gets its own, so signing in there never
 * replaces the usual sign-in.
 */
export const keychainService = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string => {
  if (!env.QUORUM_HOME) return 'quorum';
  const norm = (p: string) => (platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  const home = norm(env.QUORUM_HOME);
  if (home === norm(defaultDataDir({ ...env, QUORUM_HOME: undefined }, platform))) return 'quorum';
  return `quorum:${createHash('sha256').update(home).digest('hex').slice(0, 12)}`;
};

export const runFromProcess = (argv: string[]): Promise<number> =>
  // Kept-alive relay connections (D-18) would keep a finished command running: close them.
  main(argv, {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    store: new KeychainCredentialStore(keychainService()),
    // A question only a person at a terminal can answer (INV-30). Without a terminal (an agent's
    // shell, a pipe, CI) the answer is no.
    confirm: async (question) => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^y(es)?$/i.test((await terminal.question(`${question} [y/N] `)).trim());
      } finally {
        terminal.close();
      }
    },
    stdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    },
    // Commands start the local server when it is not running (ARCHITECTURE §8.2).
    startServer: (dataDir) =>
      ensureLocalServer(dataDir, {
        // Loaded only when a server must be started, so commands stay light otherwise.
        start: async () => {
          (await import('@quorum/server')).spawnLocalServer(dataDir);
        },
      }),
  }).finally(closeRelayConnections);
