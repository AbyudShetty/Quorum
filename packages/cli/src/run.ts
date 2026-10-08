// Process entry: wires the real keychain and the real stdout/stderr into `main`.
import { createInterface } from 'node:readline/promises';
import { KeychainCredentialStore } from '@quorum/adapter-mcp';
import { main } from './cli.js';
import { ensureLocalServer } from './local-server.js';

export const runFromProcess = (argv: string[]): Promise<number> =>
  main(argv, {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    store: new KeychainCredentialStore(),
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
  });
