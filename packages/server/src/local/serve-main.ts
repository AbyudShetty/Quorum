// Process entry for a background local server (spawned by `spawnLocalServer`). Runs until idle
// shutdown or a stop signal, then exits. The data directory comes from QUORUM_HOME.
import { AlreadyRunningError, startLocalServer } from './serve.js';

try {
  const server = await startLocalServer();
  const stop = () => void server.close();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await server.closed;
} catch (error) {
  // A second starter losing the race is normal: the winner serves both.
  if (!(error instanceof AlreadyRunningError)) {
    process.stderr.write(`quorum local server: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
