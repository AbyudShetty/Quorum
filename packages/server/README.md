# @quorum/server

Track: **A** (abyud), see `docs/TEAM_PLAN.md` §2.

The Quorum server. So far: storage and the local-mode building blocks. The `/v1` HTTP endpoints follow after the contract freeze (`contract-v1`), on top of these.

| Module                       | What it does                                                                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage/database`           | Opens SQLite with WAL and `synchronous=FULL` (committed events survive crashes), applies versioned migrations, refuses a database from a newer Quorum, and makes the `events` table append-only with triggers (INV-8).           |
| `storage/sqlite-event-store` | The `EventStore` port on SQLite. Passes the same contract tests as `MemoryEventStore`; appends take the write lock first so two writers cannot fork the chain.                                                                   |
| `local/data-dir`             | The private data directory (`QUORUM_HOME`, else `%LOCALAPPDATA%\Quorum` or `~/.quorum`). Creates it private, verifies it, and refuses to run otherwise, printing the exact fix (INV-25).                                         |
| `local/windows-acl`          | Windows: works with SIDs, so it is language-independent. Removes inherited and explicit access for other accounts. Needed because folders under `%LOCALAPPDATA%` can inherit read access for groups such as `CodexSandboxUsers`. |
| `local/instance`             | The server's Ed25519 instance key and ID, created once; answers `POST /v1/hello` (INV-24).                                                                                                                                       |
| `local/discovery`            | The `local/server.json` discovery file adapters read (port, key to pin); atomic writes, malformed files treated as missing.                                                                                                      |
| `local/start-lock`           | Exactly one local server starts when several agents start at once; locks left by crashed processes are taken over.                                                                                                               |
| `local/request-guard`        | Host and Origin checks against DNS rebinding and cross-site requests (INV-26).                                                                                                                                                   |

## Tests

- `event-store.test.ts`: the EventStore contract run against both stores, plus SQLite specifics (reopen, append-only triggers, schema version, two writers).
- `crash.test.ts`: kills a writer process mid-write three times; nothing reported as committed is lost and the chain still verifies.
- `local.test.ts`: data-directory privacy (real ACLs on Windows, modes on Linux/macOS), instance identity and the hello handshake, discovery file, start lock, request guard.

## Dependency note

`better-sqlite3` ships prebuilt binaries for Windows, Linux and macOS inside the package. Install scripts are switched off for the whole project (`.npmrc`: `ignore-scripts=true`), because npm 10 (Node 22) would otherwise try to compile it and fail without Visual Studio. The `allowScripts` entry in `package.json` records the same decision for npm 11.
