// Runs the shared /v1 contract suite against the real local server (TEAM_PLAN §3).
// The contract file reads its target when it is imported, so set it first.
import { fileURLToPath } from 'node:url';

process.env.QUORUM_CONTRACT_TARGET = fileURLToPath(
  new URL('./contract-target.ts', import.meta.url),
);
await import('../../../tests/contract/contract.test.js');
