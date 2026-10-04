// Start the local server in the background (ARCHITECTURE §8.2 auto-start). This is the only way
// the CLI and adapters can cause a process to start, and it lives here, outside their sources, so
// they stay free of process APIs (INV-10, tests/conformance/inv10-no-exec.test.ts). The command is
// fixed: Node running this package's own server entry. Callers choose only the data directory.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** The fixed command line: Node and the compiled server entry. */
export const localServerCommand = (): { command: string; args: string[] } => ({
  command: process.execPath,
  args: [fileURLToPath(new URL('./serve-main.js', import.meta.url))],
});

/** Spawn a detached local server for `dataDir`; it exits by itself when idle. */
export const spawnLocalServer = (dataDir: string): void => {
  const { command, args } = localServerCommand();
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, QUORUM_HOME: dataDir },
  });
  child.unref();
};
