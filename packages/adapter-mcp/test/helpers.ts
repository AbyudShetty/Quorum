import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SubmittedEnvelope } from '@quorum/schemas';
import { ulid } from '../../../tests/contract/helpers.js';
import { type FakeServer, startFakeServer } from '../../../tests/fakes/fake-server/fake-server.js';
import {
  type ConnectOptions,
  MemoryCredentialStore,
  QuorumClient,
  type Target,
} from '../src/index.js';

export interface World {
  server: FakeServer;
  workspace: string;
  target: Target;
  dataDir: string;
  human: { address: string; token: string };
  agent: { address: string; token: string; refreshToken: string };
  peer: { address: string; token: string; refreshToken: string };
  store: MemoryCredentialStore;
}

/** A running fake server with one workspace, two agents and a human; credentials in memory. */
export const startWorld = async (): Promise<World> => {
  const server = await startFakeServer();
  const workspace = server.createWorkspace('demo');
  const human = server.addHuman('abhijna');
  server.join(human.address, workspace);
  const agent = server.addAgent('agent:claude-api@abhijna', [workspace], 'claude-code');
  const peer = server.addAgent('agent:codex-web@abhijna', [workspace], 'codex');
  const dataDir = await mkdtemp(join(tmpdir(), 'quorum-adapter-'));
  await mkdir(join(dataDir, 'local'), { recursive: true });
  const store = new MemoryCredentialStore();
  await store.save('at_test', {
    access_token: agent.token,
    refresh_token: agent.refreshToken,
    access_expires_at: Date.now() + 3_600_000,
  });
  return {
    server,
    workspace,
    target: { baseUrl: server.baseUrl, publicKey: server.publicKey, instanceId: server.instanceId },
    dataDir,
    human,
    agent,
    peer,
    store,
  };
};

export const connectAs = (
  world: World,
  overrides: Partial<ConnectOptions> = {},
): Promise<QuorumClient> =>
  QuorumClient.connect({
    target: world.target,
    credentialKey: 'at_test',
    store: world.store,
    ...overrides,
  });

export const note = (
  world: World,
  from: string,
  to: string[],
  text: string,
): SubmittedEnvelope => ({
  spec: 'quorum/1',
  id: `msg_${ulid()}`,
  workspace: world.workspace,
  from,
  to,
  type: 'note',
  type_version: 1,
  created_at: new Date().toISOString(),
  body: { text },
});
