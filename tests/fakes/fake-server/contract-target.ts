// The fake server as a contract target:
//   QUORUM_CONTRACT_TARGET=tests/fakes/fake-server/contract-target.ts npm test
import type { CreateTarget } from '../../contract/target.js';
import { startFakeServer } from './fake-server.js';

export const createTarget: CreateTarget = async () => {
  const server = await startFakeServer();
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
    close: () => server.close(),
  };
};
