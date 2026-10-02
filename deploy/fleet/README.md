# Simulated fleet

Track: **B**. Many fake agents against a `/v1` server, to look for lost or misdelivered messages and to measure delivery latency at scale (plan Phase 5: 50 agents; Phase 1: the skeleton and a first number). Test tooling only; nothing here ships.

Today the server side is the **fake `/v1` server** (`tests/fakes/fake-server`). When the real server exists, only the `server` service changes; the agents, manifest and report stay the same.

## Without Docker (works now)

```sh
npm ci && npm run build
export FLEET_MANIFEST=/tmp/fleet/fleet.json FLEET_AGENTS=50 FLEET_HOST=127.0.0.1 \
       FLEET_PORT=8787 FLEET_PUBLIC_URL=http://127.0.0.1:8787 FLEET_DURATION_S=10
node tests/fakes/fake-server/dist/serve.js &        # starts the server, writes the manifest
node packages/fleet/bin/fleet.js local              # every agent in this process; prints the summary
```

PowerShell: set the same names with `$env:NAME = "value"` and run the two `node` lines in two terminals.

## With Docker

```sh
node deploy/fleet/run.mjs --agents 50 --duration 10      # builds, runs, prints the report, tears down
```

The exit code is the verdict (0 pass, 1 fail, 2 could not run). `--keep` leaves the containers and volume for inspection (`docker compose -f deploy/fleet/docker-compose.yml down -v` removes them). The script is plain Node, so it behaves the same in PowerShell, cmd and bash.

What it starts: one `server` container, N `agent` replicas and a `report` container. Each agent claims the lowest free index through the shared volume (no per-replica configuration), connects, then waits at a **start barrier** until all N are ready, so every agent runs in the same time window. `report` waits for all results (with a timeout) and fails if a replica never produced one: a crashed agent is a failure, not a silence.

The server's port is not published to the host. Each agent container is limited to 128 MB, the server to 512 MB.

Without the barrier, a 50-agent run in Docker showed 90 of 1000 messages "lost" and a 10 s worst-case latency. Both were harness artifacts (early agents finished and stopped listening before late containers started); the barrier removed them.

## Settings (environment)

| Variable           | Default | Meaning                                                  |
| ------------------ | ------- | -------------------------------------------------------- |
| `FLEET_AGENTS`     | 20      | Number of agents (2 to 500)                              |
| `FLEET_DURATION_S` | 30      | How long each agent sends                                |
| `FLEET_RATE`       | 2       | Messages per second per agent, to random peers           |
| `FLEET_DRAIN_S`    | 3       | Extra receiving time so late messages count              |
| `FLEET_POLL_MS`    | 100     | Inbox poll interval (latency is bounded by this)         |
| `FLEET_SEED`       | 1       | Peer-choice seed; the same seed repeats the same traffic |

## What a run checks

- **lost:** the server accepted it (`201`) but the addressed agent never saw it within the drain window.
- **misdelivered:** an agent saw a direct message addressed to someone else (inbox isolation).
- **errors:** every non-success reply or network failure, by code.
- **latency:** sender clock to receiver clock (same host, so skew is negligible), p50/p95/p99/max. With polling, expect roughly half the poll interval on average.

## Results so far (fake server, one machine, 2026-10-03)

| Run                                       | Sent | Lost | Misdelivered | p50   | p95    | max    |
| ----------------------------------------- | ---- | ---- | ------------ | ----- | ------ | ------ |
| 6 agents as separate host processes       | 72   | 0    | 0            | 48 ms | 64 ms  | 65 ms  |
| 50 agents in one host process, 8 s        | 800  | 0    | 0            | 54 ms | 112 ms | 121 ms |
| 20 containers, 8 s (before the barrier)   | 320  | 0    | 0            | 57 ms | 514 ms | 2.5 s  |
| 50 containers, 10 s (before the barrier)  | 1000 | 90   | 0            | 66 ms | 3.6 s  | 10 s   |
| **50 containers, 10 s, with the barrier** | 999  | 0    | 0            | 54 ms | 100 ms | 399 ms |

Docker Desktop VM: 16 CPUs, 16 GB. These measure the harness and client path against the **fake** server, not the real one. Latency is mostly the 100 ms poll interval.

## Security notes

The manifest holds the agents' tokens so replicas need no setup. It lives on a private compose volume with mode 0600 and the fake server's tokens are worthless outside the run. Do not reuse this pattern for real credentials (INV-25: real tokens live in the OS keychain).
