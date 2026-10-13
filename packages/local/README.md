# @quorum/local

Track: **A** (abyud), see `docs/TEAM_PLAN.md` §2.

Local-mode building blocks shared by the server, the adapters and the CLI. No database, so adapters can use it without pulling in SQLite. Depends only on `@quorum/schemas`.

| Module           | What it does                                                                                                                                                                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data-dir`       | The private data directory (`QUORUM_HOME`, else `%LOCALAPPDATA%\Quorum` or `~/.quorum`). Creates it private, verifies it, and refuses to run otherwise, printing the exact fix (INV-25).                                                                                                     |
| `windows-acl`    | Windows: works with SIDs, so it is language-independent. Removes inherited and explicit access for other accounts. Needed because folders under `%LOCALAPPDATA%` can inherit read access for groups such as `CodexSandboxUsers`.                                                             |
| `discovery`      | The `local/server.json` discovery file (port, key to pin; `localDiscovery` schema). Atomic writes; a malformed file is treated as missing.                                                                                                                                                   |
| `relay-link`     | Both ends of a connection through the relay (D-18): a WebSocket as a byte stream (`webSocketStream`), asking the relay for a home (`connectThroughRelay`), the proof message a home signs, `quorum://` link addresses.                                                                       |
| `bootstrap-file` | The `local/bootstrap.json` code file (`localBootstrapFile` schema). The CLI reads it and exchanges the code at `POST /v1/auth/local-bootstrap`. Expired or malformed codes read as missing.                                                                                                  |
| `start-lock`     | Exactly one local server starts when several agents start at once; locks left by crashed processes are taken over.                                                                                                                                                                           |
| `remote`         | `<data>/local/remote.json`: through the relay (`{"relay": "wss://…"}`, D-18), or the HTTPS front end's public address and the fixed loopback port it forwards to (`quorum remote enable`); `checkPublicUrl` accepts only `https://host[:port]`; a malformed file means remote access is off. |
| `git-worktree`   | `addGitWorktree({ repo, dir, branch })` runs only `git -C <repo> worktree add -b quorum/<agent> <dir>`: absolute paths, the `quorum/` branch shape, no shell. Used by `quorum worktree`; one of the two processes the CLI can cause to start (INV-10).                                       |
| `file-lock`      | `withFileLock(dataDir, name, work)`: a cross-process lock (`mkdir` is atomic) in `<data>/locks`, taken over when stale. Used so processes sharing one credential never refresh it twice (INV-11).                                                                                            |

`@quorum/server` re-exports all of these, so `import { defaultDataDir } from '@quorum/server'` keeps working; new code should import from `@quorum/local`.

## Tests

`local.test.ts`: data-directory privacy (real ACLs on Windows, modes on Linux/macOS), discovery file, bootstrap code file, start lock.
