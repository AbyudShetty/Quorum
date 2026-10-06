# @quorum/local

Track: **A** (abyud), see `docs/TEAM_PLAN.md` §2.

Local-mode building blocks shared by the server, the adapters and the CLI. No database, so adapters can use it without pulling in SQLite. Depends only on `@quorum/schemas`.

| Module           | What it does                                                                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data-dir`       | The private data directory (`QUORUM_HOME`, else `%LOCALAPPDATA%\Quorum` or `~/.quorum`). Creates it private, verifies it, and refuses to run otherwise, printing the exact fix (INV-25).                                         |
| `windows-acl`    | Windows: works with SIDs, so it is language-independent. Removes inherited and explicit access for other accounts. Needed because folders under `%LOCALAPPDATA%` can inherit read access for groups such as `CodexSandboxUsers`. |
| `discovery`      | The `local/server.json` discovery file (port, key to pin; `localDiscovery` schema). Atomic writes; a malformed file is treated as missing.                                                                                       |
| `bootstrap-file` | The `local/bootstrap.json` code file (`localBootstrapFile` schema). The CLI reads it and exchanges the code at `POST /v1/auth/local-bootstrap`. Expired or malformed codes read as missing.                                      |
| `start-lock`     | Exactly one local server starts when several agents start at once; locks left by crashed processes are taken over.                                                                                                               |
| `file-lock`      | `withFileLock(dataDir, name, work)`: a cross-process lock (`mkdir` is atomic) in `<data>/locks`, taken over when stale. Used so processes sharing one credential never refresh it twice (INV-11).                                |

`@quorum/server` re-exports all of these, so `import { defaultDataDir } from '@quorum/server'` keeps working; new code should import from `@quorum/local`.

## Tests

`local.test.ts`: data-directory privacy (real ACLs on Windows, modes on Linux/macOS), discovery file, bootstrap code file, start lock.
