// Runs the fake /v1 server as a process and provisions a workspace with N agents, for the fleet
// harness (deploy/fleet). Writes a manifest the agent containers read. Test tooling only: the
// manifest holds tokens, so it lives on a private compose volume and is never a product feature.
//   node tests/fakes/fake-server/dist/serve.js
// Environment: FLEET_AGENTS (default 50), FLEET_PORT (8787), FLEET_HOST (0.0.0.0),
// FLEET_PUBLIC_URL (http://server:8787), FLEET_MANIFEST (/shared/fleet.json).
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { startFakeServer } from './fake-server.js';

const count = Number(process.env.FLEET_AGENTS ?? 50);
const port = Number(process.env.FLEET_PORT ?? 8787);
const host = process.env.FLEET_HOST ?? '0.0.0.0';
const manifestPath = process.env.FLEET_MANIFEST ?? '/shared/fleet.json';
const publicUrl = process.env.FLEET_PUBLIC_URL ?? `http://server:${String(port)}`;

if (!Number.isInteger(count) || count < 2 || count > 500) {
  throw new Error('FLEET_AGENTS must be a whole number from 2 to 500');
}

const server = await startFakeServer({ host, port, localMode: false });
const workspace = server.createWorkspace('fleet');
const agents = Array.from({ length: count }, (_, i) => {
  const address = `agent:fleet-${String(i + 1).padStart(3, '0')}@lab`;
  const { token, refreshToken } = server.addAgent(address, [workspace], 'generic');
  return { address, token, refreshToken };
});

const manifest = {
  baseUrl: publicUrl,
  publicKey: server.publicKey,
  instanceId: server.instanceId,
  workspace,
  agents,
};
await mkdir(dirname(manifestPath), { recursive: true });
// Written atomically: agents never read half a manifest.
await writeFile(`${manifestPath}.tmp`, JSON.stringify(manifest), { mode: 0o600 });
await rename(`${manifestPath}.tmp`, manifestPath);
console.log(
  `fake /v1 server on ${host}:${String(port)} with ${String(count)} agents; manifest ${manifestPath}`,
);

const stop = () => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
