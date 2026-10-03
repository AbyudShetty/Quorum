# @quorum/server

Track: **A** (abyud), see `docs/TEAM_PLAN.md` §2.

The Quorum server. So far: storage and the server side of local mode (the shared local-mode files, data directory, discovery and start lock, live in [`@quorum/local`](../local/README.md) and are re-exported here). The `/v1` HTTP endpoints follow after the contract freeze (`contract-v1`), on top of these.

| Module                       | What it does                                                                                                                                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage/database`           | Opens SQLite with WAL and `synchronous=FULL` (committed events survive crashes), applies versioned migrations, refuses a database from a newer Quorum, and makes the `events` table append-only with triggers (INV-8). |
| `storage/sqlite-event-store` | The `EventStore` port on SQLite. Passes the same contract tests as `MemoryEventStore`; appends take the write lock first so two writers cannot fork the chain.                                                         |
| `local/instance`             | The server's Ed25519 instance key and ID, created once; answers `POST /v1/hello` (INV-24).                                                                                                                             |
| `local/bootstrap`            | Issues the one-time local bootstrap code on each start (10 minutes, single use, only its hash kept in memory) and redeems it; the file is removed once spent or expired.                                               |
| `local/request-guard`        | Host and Origin checks against DNS rebinding and cross-site requests (INV-26).                                                                                                                                         |

## Tests

- `event-store.test.ts`: the EventStore contract run against both stores, plus SQLite specifics (reopen, append-only triggers, schema version, two writers).
- `crash.test.ts`: kills a writer process mid-write three times; nothing reported as committed is lost and the chain still verifies.
- `local.test.ts`: instance identity and the hello handshake, request guard.
- `bootstrap.test.ts`: the bootstrap code works once, expires after 10 minutes, survives wrong guesses, and two simultaneous exchanges cannot both succeed.

## Dependency note

`better-sqlite3` ships prebuilt binaries for Windows, Linux and macOS inside the package. Install scripts are switched off for the whole project (`.npmrc`: `ignore-scripts=true`), because npm 10 (Node 22) would otherwise try to compile it and fail without Visual Studio. The `allowScripts` entry in `package.json` records the same decision for npm 11.
