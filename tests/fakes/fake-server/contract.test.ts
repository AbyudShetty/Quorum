// Runs the /v1 contract suite against the fake server, so the fake cannot drift from the real
// server (TEAM_PLAN §3). The contract file reads its target when it is imported, so set it first.
// fileURLToPath (not URL.pathname) so paths with spaces are decoded, not double-encoded.
import { fileURLToPath } from 'node:url';

process.env.QUORUM_CONTRACT_TARGET = fileURLToPath(
  new URL('./contract-target.ts', import.meta.url),
);
await import('../../contract/contract.test.js');
