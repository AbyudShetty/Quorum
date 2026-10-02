// Process entry: wires the real keychain and the real stdout/stderr into `main`.
import { KeychainCredentialStore } from '@quorum/adapter-mcp';
import { main } from './cli.js';

export const runFromProcess = (argv: string[]): Promise<number> =>
  main(argv, {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    store: new KeychainCredentialStore(),
  });
