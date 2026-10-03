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
node deploy/fleet/run.mjs --agents 50 --duration 15 --outage 5 --outage-at 4   # drop the server for 5 s mid-run
```

The exit code is the verdict (0 pass, 1 fail, 2 could not run). `--keep` leaves the containers and volume for inspection (`docker compose -f deploy/fleet/docker-compose.yml down -v` removes them). The script is plain Node, so it behaves the same in PowerShell, cmd and bash.

What it starts: one `server` container, N `agent` replicas and a `report` container. Each agent claims the lowest free index through the shared volume (no per-replica configuration), connects, then waits at a **start barrier** until all N are ready, so every agent runs in the same time window. `report` waits for all results (with a timeout) and fails if a replica never produced one: a crashed agent is a failure, not a silence.

The server's port is not published to the host. Each agent container is limited to 128 MB, the server to 512 MB.

Without the barrier, a 50-agent run in Docker showed 90 of 1000 messages "lost" and a 10 s worst-case latency. Both were harness artifacts (early agents finished and stopped listening before late containers started); the barrier removed them.

## Settings (environment)

| Variable              | Default               | Meaning                                                              |
| --------------------- | --------------------- | -------------------------------------------------------------------- |
| `FLEET_AGENTS`        | 20                    | Number of agents (2 to 500)                                          |
| `FLEET_DURATION_S`    | 30                    | How long each agent sends                                            |
| `FLEET_RATE`          | 2                     | Messages per second per agent, to random peers                       |
| `FLEET_DRAIN_S`       | 3                     | Extra receiving time so late messages count                          |
| `FLEET_POLL_MS`       | 100                   | Inbox poll interval (latency is bounded by this)                     |
| `FLEET_SEED`          | 1                     | Peer-choice seed; the same seed repeats the same traffic             |
| `FLEET_OUTAGE_S`      | 0                     | Chaos: seconds the server drops every connection (its state is kept) |
| `FLEET_OUTAGE_AT_S`   | 3                     | Seconds after the start barrier before the outage begins             |
| `FLEET_BARRIER_S`     | 120                   | How long an agent waits at the start barrier before failing          |
| `FLEET_REPORT_WAIT_S` | duration + drain + 60 | How long `report` waits for missing results                          |

## What a run checks

- **lost:** the server accepted it (`201`) but the addressed agent never saw it within the drain window.
- **misdelivered:** an agent saw a direct message addressed to someone else (inbox isolation).
- **unsent:** still in an agent's outbox when the run ended.
- **errors:** every non-success reply or network failure, by code. In an outage run `unreachable` is expected and tolerated; any other error still fails the run.
- **latency:** sender clock to receiver clock (same host, so skew is negligible), p50/p95/p99/max. With polling, expect roughly half the poll interval on average.

## Outage runs (chaos)

Agents send like the real adapters do: each message is written to the outbox first and a separate flusher delivers it, so a dead server delays mail instead of losing it (INV-20). With `--outage`, the server container drops every connection for a while once all agents are running, then comes back with its state intact. The run passes only if every message still arrives. A control test (server never returns) must fail with `unsent` and `lost`, so the detector is proven too.

Latency in these runs includes the outbox flush interval (up to 100 ms), so p50 is about 100 ms instead of the earlier ~50 ms.

## Results so far (fake server, one machine, 2026-10-03)

| Run                                      | Sent | Lost | Misdelivered | p50    | p95    | max    |
| ---------------------------------------- | ---- | ---- | ------------ | ------ | ------ | ------ |
| 6 agents as separate host processes      | 72   | 0    | 0            | 48 ms  | 64 ms  | 65 ms  |
| 50 agents in one host process, 8 s       | 800  | 0    | 0            | 54 ms  | 112 ms | 121 ms |
| 20 containers, 8 s (before the barrier)  | 320  | 0    | 0            | 57 ms  | 514 ms | 2.5 s  |
| 50 containers, 10 s (before the barrier) | 1000 | 90   | 0            | 66 ms  | 3.6 s  | 10 s   |
| 50 containers, 10 s, with the barrier    | 999  | 0    | 0            | 54 ms  | 100 ms | 399 ms |
| 50 containers, 10 s, outbox sending      | 999  | 0    | 0            | 108 ms | 212 ms | 656 ms |
| 20 containers, 4 s outage mid-run        | 560  | 0    | 0            | 124 ms | 3.4 s  | 4.1 s  |
| **50 containers, 5 s outage mid-run**    | 1500 | 0    | 0            | 145 ms | 4.6 s  | 5.5 s  |

Docker Desktop VM: 16 CPUs, 16 GB. These measure the harness and client path against the **fake** server, not the real one. Latency is mostly the 100 ms poll interval.

## Security notes

The manifest holds the agents' tokens so replicas need no setup. It lives on a private compose volume with mode 0600 and the fake server's tokens are worthless outside the run. Do not reuse this pattern for real credentials (INV-25: real tokens live in the OS keychain).
