// The fake server as a contract target:
//   QUORUM_CONTRACT_TARGET=tests/fakes/fake-server/contract-target.ts npm test
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CreateTarget } from '../../contract/target.js';
import { startFakeServer } from './fake-server.js';

export const createTarget: CreateTarget = async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quorum-fake-contract-'));
  let now = Date.now();
  const server = await startFakeServer({ dataDir, clock: () => now });
  const human = server.addHuman('abhijna');
  const workspace = server.createWorkspace('contract');
  server.join(human.address, workspace);
  const agentA = server.addAgent('agent:claude-api@abhijna', [workspace], 'claude-code');
  const agentB = server.addAgent('agent:codex-web@abhijna', [workspace], 'codex');
  return {
    baseUrl: server.baseUrl,
    localMode: true,
    pinnedPublicKey: server.publicKey,
    workspace,
    agentA: { address: agentA.address, token: agentA.token },
    agentB: { address: agentB.address, token: agentB.token },
    human,
    // The fake never touches the disk for attach roots, so any absolute path will do.
    makeFolder: (name) => Promise.resolve(join(dataDir, `folder-${name}`)),
    bootstrap: { dataDir, reissue: () => server.issueBootstrap() },
    advanceClock: (ms) => {
      now += ms;
    },
    close: () => server.close(),
  };
};
