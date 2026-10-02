#!/usr/bin/env node
// Runs one fleet in Docker Compose and exits with the verdict (0 = pass).
//   node deploy/fleet/run.mjs [--agents 20] [--duration 30] [--rate 2] [--keep]
// Cross-platform on purpose: no shell syntax, so it behaves the same in PowerShell, cmd and bash.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    agents: { type: 'string', default: '20' },
    duration: { type: 'string', default: '30' },
    rate: { type: 'string', default: '2' },
    keep: { type: 'boolean', default: false },
  },
  strict: true,
});

const compose = join(dirname(fileURLToPath(import.meta.url)), 'docker-compose.yml');
const env = {
  ...process.env,
  FLEET_AGENTS: values.agents,
  FLEET_DURATION_S: values.duration,
  FLEET_RATE: values.rate,
};

const docker = (args, options = {}) =>
  spawnSync('docker', ['compose', '-f', compose, ...args], { env, encoding: 'utf8', ...options });

const down = () => docker(['down', '-v', '--remove-orphans'], { stdio: 'ignore' });

down(); // a previous run's volume must not leak into this one

const up = docker(['up', '-d', '--build'], { stdio: 'inherit' });
if (up.status !== 0) {
  console.error('docker compose up failed');
  down();
  process.exit(2);
}

// `wait` blocks until the report container stops. It prints "... exited with status code N".
const wait = docker(['wait', 'report']);
const printed = /status code (\d+)/.exec(wait.stdout ?? '')?.[1];
const verdict = printed === undefined ? Number.NaN : Number.parseInt(printed, 10);

const logs = docker(['logs', '--no-log-prefix', 'report']);
process.stdout.write(logs.stdout ?? '');
if (!values.keep) down();

process.exit(Number.isNaN(verdict) ? 2 : verdict);
