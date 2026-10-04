// The real local server as a contract target (tests/contract):
//   QUORUM_CONTRACT_TARGET=packages/server/test/contract-target.ts npm test
// Everything is set up through the public API, exactly as the CLI would: the owner signs in with
// the bootstrap code, creates a workspace and attaches two folders.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBootstrapCode } from '@quorum/local';
import type { CreateTarget } from '../../../tests/contract/target.js';
import { startLocalServer } from '../src/index.js';

const post = async (baseUrl: string, path: string, body: unknown, token?: string) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: ${String(response.status)} ${await response.text()}`);
  return (await response.json()) as Record<string, unknown>;
};

export const createTarget: CreateTarget = async () => {
  const root = mkdtempSync(join(tmpdir(), 'quorum-contract-'));
  let offsetMs = 0;
  const server = await startLocalServer({
    dataDir: join(root, 'data'),
    idleShutdownMs: 0,
    machine: 'contract',
    ownerName: 'owner',
    clock: () => new Date(Date.now() + offsetMs),
  });
  const code = (await readBootstrapCode(server.dataDir))?.code ?? '';
  const signIn = await post(server.baseUrl, '/v1/auth/local-bootstrap', { code });
  const human = signIn.human as { address: string };
  const humanToken = (signIn.credentials as { access_token: string }).access_token;
  const workspace = (await post(server.baseUrl, '/v1/workspaces', { name: 'contract' }, humanToken))
    .id as string;
  const attach = async (folder: string, vendor: string) => {
    const dir = join(root, folder);
    mkdirSync(dir);
    const created = await post(
      server.baseUrl,
      '/v1/attachments',
      { root: dir, vendor, workspaces: [workspace] },
      humanToken,
    );
    return {
      address: (created.agent as { address: string }).address,
      token: (created.credentials as { access_token: string }).access_token,
    };
  };
  const agentA = await attach('api', 'claude-code');
  const agentB = await attach('web', 'codex');
  return {
    baseUrl: server.baseUrl,
    localMode: true,
    pinnedPublicKey: server.publicKey,
    workspace,
    agentA,
    agentB,
    human: { address: human.address, token: humanToken },
    makeFolder: (name) => {
      const dir = join(root, `folder-${name}`);
      mkdirSync(dir, { recursive: true });
      return Promise.resolve(dir);
    },
    bootstrap: { dataDir: server.dataDir, reissue: () => server.issueBootstrap() },
    advanceClock: (ms) => {
      offsetMs += ms;
    },
    close: async () => {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
};
