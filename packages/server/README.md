# @quorum/server

Track: **A** (abyud), see `docs/TEAM_PLAN.md` §2.

The Quorum server: the `/v1` HTTP API on SQLite, and local mode (`quorum serve --local`). The shared local-mode files (data directory, discovery, bootstrap code file, start lock) live in [`@quorum/local`](../local/README.md) and are re-exported here.

## How a request flows

1. **HTTP** (`http/app`, Fastify): Host/Origin check in local mode (INV-26), rate limits for requests without a token (INV-23), token → caller.
2. **Service** (`service/quorum`): validates the payload, checks who may do it, then commits the registry change **and** its events in one SQLite transaction (INV-8: no state change without an event).
3. **Projections**: new messages and acks update the in-memory message log; open streams get the message (SSE).

Commands run synchronously from the first check to the commit, so two requests never interleave inside one; the start lock guarantees one server per data directory.

| Module                       | What it does                                                                                                                                                                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http/app`                   | Routes for every `/v1` operation; maps `DomainError` to the ErrorResponse shape (MESSAGE_SPEC §6) and never echoes internals; SSE with `Last-Event-ID` resume and keepalives; `Retry-After` on 429.                                                                                     |
| `service/quorum`             | All rules: tokens (hash-only, rotation, family revocation on reuse, INV-11), owner sign-in, workspaces, attach (canonical roots, data directory refused, stable identity, INV-25/30), sessions and `shared_worktree` notices (INV-28), messages, presence, revocation (INV-13), export. |
| `service/rate-limit`         | Fixed-window limits per principal or client address (INV-15, INV-23).                                                                                                                                                                                                                   |
| `service/notifier`           | Fan-out of committed messages to open streams; closes a principal's streams on revocation.                                                                                                                                                                                              |
| `storage/database`           | SQLite with WAL and `synchronous=FULL`, versioned migrations (1: event log with append-only triggers; 2: registry), refuses a database from a newer Quorum.                                                                                                                             |
| `storage/registry`           | Humans, workspaces, agents, memberships, attachments, token hashes, sessions, stable `rp_`/`wt_` ids. Not rebuildable from the log on purpose (it holds token hashes, which never go into events); every change to it is also an event.                                                 |
| `storage/sqlite-event-store` | The `EventStore` port on SQLite, plus a synchronous append used inside the service's transactions.                                                                                                                                                                                      |
| `local/serve`                | `startLocalServer`: private data directory, start lock, database, instance key, loopback-only listen (INV-22), discovery file, a fresh bootstrap code, presence sweeps, idle shutdown (30 min), clean stop.                                                                             |
| `local/spawn`                | Auto-start: spawns the server entry (`local/serve-main`) detached. The only process the CLI can cause to start, with a fixed command line (INV-10).                                                                                                                                     |
| `local/instance`             | The server's Ed25519 instance key and ID, created once; answers `POST /v1/hello` (INV-24).                                                                                                                                                                                              |
| `local/bootstrap`            | Issues the one-time local bootstrap code on each start (10 minutes, single use, only its hash kept in memory) and redeems it; the file is removed once spent or expired.                                                                                                                |
| `local/request-guard`        | Host and Origin checks against DNS rebinding and cross-site requests (INV-26).                                                                                                                                                                                                          |

Instance-level events (owner created and signed in, refresh-token reuse) go into their own chain, `ws_00000000000000000000000000`, verified like any workspace chain.

## Tests

- `contract.test.ts`: the shared `/v1` contract suite (`tests/contract`) against the real local server, set up only through the public API.
- `server.test.ts`: security invariants beyond the contract: tokens never stored or echoed, refresh reuse revokes the family, expiry, rate limits for unauthenticated and failed requests, human-only operations, workspace scope, `system:quorum` cannot be forged, unknown recipients, secrets, per-agent limits, Host/Origin, revocation closes streams, every state change is an event and the export verifies, restart keeps everything, concurrent retries keep one message, attach naming and stable identity, the data directory refused through a junction or symlink, silent sessions not reported, presence transitions recorded.
- `serve.test.ts`: discovery and bootstrap files, one server per data directory, identity kept across restarts, loopback only, idle shutdown, the fixed auto-start command.
- `event-store.test.ts`, `crash.test.ts`, `local.test.ts`, `bootstrap.test.ts`: storage contract, crash safety, instance identity and request guard, bootstrap code.

## Dependency notes

- `fastify` (MIT): HTTP routing, body limits, JSON parsing with prototype-poisoning protection; planned in ARCHITECTURE §11. Logging is off, so tokens in headers and bodies are never written anywhere (INV-11).
- `better-sqlite3` ships prebuilt binaries for Windows, Linux and macOS inside the package. Install scripts are switched off for the whole project (`.npmrc`: `ignore-scripts=true`), because npm 10 (Node 22) would otherwise try to compile it and fail without Visual Studio. The `allowScripts` entry in `package.json` records the same decision for npm 11.
