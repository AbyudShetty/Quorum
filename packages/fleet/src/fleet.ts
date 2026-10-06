// The manifest the server side writes (who the agents are and how to reach the server), and an
// in-process runner that drives every agent from one process: the same agent code the containers
// run, without Docker. Containers each run `runAgent` for one manifest entry (cli.ts).
import { type AgentConfig, type AgentResult, type FleetProgress, runAgent } from './agent.js';

export interface FleetManifest {
  baseUrl: string;
  publicKey: string;
  instanceId: string;
  workspace: string;
  agents: { address: string; token: string; refreshToken: string }[];
}

export interface RunOptions {
  ratePerSecond: number;
  durationMs: number;
  drainMs?: number;
  pollIntervalMs?: number;
  seed?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  if (typeof value !== 'string' || value === '') throw new Error(`manifest: "${key}" is missing`);
  return value;
};

export const parseManifest = (raw: unknown): FleetManifest => {
  if (!isRecord(raw) || !Array.isArray(raw.agents) || raw.agents.length < 2) {
    throw new Error('manifest: needs at least two agents');
  }
  return {
    baseUrl: text(raw, 'baseUrl'),
    publicKey: text(raw, 'publicKey'),
    instanceId: text(raw, 'instanceId'),
    workspace: text(raw, 'workspace'),
    agents: raw.agents.map((a) => {
      if (!isRecord(a)) throw new Error('manifest: bad agent entry');
      return {
        address: text(a, 'address'),
        token: text(a, 'token'),
        refreshToken: text(a, 'refreshToken'),
      };
    }),
  };
};

/** Config for the agent at `index`, addressing every other agent. */
export const agentConfig = (
  manifest: FleetManifest,
  index: number,
  options: RunOptions,
): AgentConfig => {
  const me = manifest.agents[index];
  if (!me) throw new Error(`manifest has no agent ${String(index)}`);
  return {
    target: {
      baseUrl: manifest.baseUrl,
      publicKey: manifest.publicKey,
      instanceId: manifest.instanceId,
    },
    workspace: manifest.workspace,
    address: me.address,
    accessToken: me.token,
    refreshToken: me.refreshToken,
    peers: manifest.agents.filter((_, i) => i !== index).map((a) => a.address),
    ratePerSecond: options.ratePerSecond,
    durationMs: options.durationMs,
    ...(options.drainMs === undefined ? {} : { drainMs: options.drainMs }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    seed: (options.seed ?? 1) + index,
  };
};

/** Every agent of the manifest in this process. */
export const runLocalFleet = (
  manifest: FleetManifest,
  options: RunOptions,
): Promise<AgentResult[]> => {
  // All agents share one tally, so the run ends as soon as everything queued has arrived.
  const progress: FleetProgress = {
    agents: manifest.agents.length,
    sendersDone: 0,
    queued: 0,
    received: 0,
  };
  return Promise.all(
    manifest.agents.map((_, i) => runAgent({ ...agentConfig(manifest, i, options), progress })),
  );
};
