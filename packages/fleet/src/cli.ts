// `quorum-fleet` commands:
//   agent   one container: claim an index, run that agent, write its result
//   report  after a run: read every result, print the summary, exit 1 if anything was lost
//   local   run every agent of a manifest in this process (no Docker)
// Settings come from the environment so a compose file can scale agents with no per-replica config.
import { mkdir, open, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runAgent, type AgentResult } from './agent.js';
import {
  agentConfig,
  parseManifest,
  type FleetManifest,
  runLocalFleet,
  type RunOptions,
} from './fleet.js';
import { formatSummary, passed, summarize } from './summary.js';

const number = (env: NodeJS.ProcessEnv, name: string, fallback: number): number => {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
};

const runOptions = (env: NodeJS.ProcessEnv): RunOptions => ({
  ratePerSecond: number(env, 'FLEET_RATE', 2),
  durationMs: number(env, 'FLEET_DURATION_S', 30) * 1000,
  drainMs: number(env, 'FLEET_DRAIN_S', 3) * 1000,
  pollIntervalMs: number(env, 'FLEET_POLL_MS', 100),
  seed: number(env, 'FLEET_SEED', 1),
});

const readManifest = async (path: string): Promise<FleetManifest> => {
  // The server writes the manifest atomically, but it may not exist yet when a container starts.
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      return parseManifest(JSON.parse(await readFile(path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`manifest ${path} never appeared`);
};

/** Each replica takes the lowest free index by creating a claim file exclusively. */
const claimIndex = async (dir: string, count: number): Promise<number> => {
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    try {
      await (await open(join(dir, `claim-${String(i)}`), 'wx')).close();
      return i;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error('every agent index is already claimed');
};

/**
 * Mark this agent ready and wait until all `count` agents are (or fail after `timeoutS`). Agents
 * leave the barrier within one poll of each other, so the run window is common to all of them.
 */
export const startBarrier = async (
  dir: string,
  index: number,
  count: number,
  timeoutS: number,
): Promise<void> => {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `ready-${String(index)}`), '');
  const deadline = Date.now() + timeoutS * 1000;
  while ((await readdir(dir)).filter((f) => f.startsWith('ready-')).length < count) {
    if (Date.now() > deadline) {
      throw new Error(
        `start barrier: not all ${String(count)} agents became ready in ${String(timeoutS)} s`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const listResults = async (dir: string): Promise<string[]> => {
  try {
    return await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
};

const countResults = async (dir: string): Promise<number> =>
  (await listResults(dir)).filter((f) => f.endsWith('.json')).length;

/** Sending time + drain + startup slack for the slowest replica. */
const defaultWaitMs = (env: NodeJS.ProcessEnv): number =>
  (number(env, 'FLEET_DURATION_S', 30) + number(env, 'FLEET_DRAIN_S', 3) + 60) * 1000;

export const runFleetCli = async (
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = console.log,
): Promise<number> => {
  const [command] = argv;
  const manifestPath = env.FLEET_MANIFEST ?? '/shared/fleet.json';
  const resultsDir = env.FLEET_RESULTS_DIR ?? join(dirname(manifestPath), 'results');

  switch (command) {
    case 'agent': {
      const manifest = await readManifest(manifestPath);
      const index = await claimIndex(
        env.FLEET_CLAIM_DIR ?? join(dirname(manifestPath), 'claims'),
        manifest.agents.length,
      );
      const readyDir = env.FLEET_READY_DIR ?? join(dirname(manifestPath), 'ready');
      const config = {
        ...agentConfig(manifest, index, runOptions(env)),
        barrier: () =>
          startBarrier(
            readyDir,
            index,
            manifest.agents.length,
            number(env, 'FLEET_BARRIER_S', 120),
          ),
      };
      const result = await runAgent(config);
      await mkdir(resultsDir, { recursive: true });
      await writeFile(
        join(resultsDir, `${String(index).padStart(4, '0')}.json`),
        JSON.stringify(result),
      );
      log(
        `agent ${result.address}: sent ${String(result.sent.length)}, received ${String(result.received.length)}`,
      );
      return 0;
    }

    case 'report': {
      const expected = env.FLEET_AGENTS ? Number(env.FLEET_AGENTS) : undefined;
      // Replicas finish at different times, so wait for them (but never forever: a crashed
      // replica must end in a failed report, not a hung one).
      const waitMs = number(env, 'FLEET_REPORT_WAIT_S', 0) * 1000 || defaultWaitMs(env);
      const deadline = Date.now() + waitMs;
      while (expected !== undefined && Date.now() < deadline) {
        const found = await countResults(resultsDir);
        if (found >= expected) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const files = (await listResults(resultsDir)).filter((f) => f.endsWith('.json'));
      const results = await Promise.all(
        files.map(
          async (f) => JSON.parse(await readFile(join(resultsDir, f), 'utf8')) as AgentResult,
        ),
      );
      const summary = summarize(results);
      log(formatSummary(summary));
      if (expected !== undefined && results.length !== expected) {
        log(
          `MISSING RESULTS: expected ${String(expected)} agents, found ${String(results.length)}`,
        );
        return 1;
      }
      const ok = passed(summary, { allowUnreachable: Number(env.FLEET_OUTAGE_S) > 0 });
      log(ok ? 'PASS' : 'FAIL');
      return ok || env.FLEET_FAIL_ON_LOSS === '0' ? 0 : 1;
    }

    case 'local': {
      const manifest = await readManifest(manifestPath);
      const results = await runLocalFleet(manifest, runOptions(env));
      const summary = summarize(results);
      log(formatSummary(summary));
      return passed(summary, { allowUnreachable: Number(env.FLEET_OUTAGE_S) > 0 }) ? 0 : 1;
    }

    default:
      log('Usage: quorum-fleet <agent|report|local>   (settings: FLEET_* environment variables)');
      return command === undefined || command === 'help' ? 0 : 64;
  }
};
