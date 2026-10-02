// Runs the /v1 contract suite against the fake server, so the fake cannot drift from the real
// server (TEAM_PLAN §3). The contract file reads its target when it is imported, so set it first.
process.env.QUORUM_CONTRACT_TARGET = new URL(
  './contract-target.ts',
  import.meta.url,
).pathname.replace(/^\/([A-Za-z]:)/, '$1');
await import('../../contract/contract.test.js');
