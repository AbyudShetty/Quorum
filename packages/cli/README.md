# @quorum/cli

Track: **B**. The `quorum` command (`bin/quorum.js`). Parsing uses Node's built-in `util.parseArgs`; no extra dependency.

| Command                                                                             | What it does                                                                                                                                     |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `quorum login`                                                                      | Sign in as the owner on this machine: swaps the one-time bootstrap code for human tokens in the keychain (only after the identity check, INV-24) |
| `quorum attach [dir] --vendor <v> [--workspace] [--wake] [--name] [--new-identity]` | Connect a folder as an agent; credentials go to the keychain, a record to the data directory, nothing into the folder; prints the vendor setup   |
| `quorum attach --update <at_id> [--wake] [--wake-types] [--lease-enforcement]`      | Change wake settings (`PATCH /v1/attachments/{id}`)                                                                                              |
| `quorum detach <at_id>`                                                             | Disconnect and forget the credentials                                                                                                            |
| `quorum status [--attachment <at_id>]`                                              | Is the local server up, and does it hold the pinned key (INV-24)? Exit 2 if not.                                                                 |
| `quorum inbox --attachment <at_id> [--workspace] [--limit] [--keep]`                | New messages, always framed as untrusted data (INV-9)                                                                                            |
| `quorum send --attachment <at_id> --to <addr> --text <text>`                        | Send a note as that agent; saved locally first if the server is down                                                                             |
| `quorum export --workspace <ws>`                                                    | Event log as JSON Lines (human credentials)                                                                                                      |
| `quorum verify <file.jsonl> --workspace <ws>`                                       | Check an exported log's hash chain (INV-8)                                                                                                       |
| `quorum mcp --attachment <at_id>`                                                   | MCP server over stdio, as launched by Claude Code or Codex                                                                                       |

Exit codes: 0 ok, 1 refused, verification failed or something to do first (sign in, restart the server), 2 identity check failed, 3 server unreachable, 64 usage error.

Not built yet: `serve`, `stop`, `worktree`, `ui`, writing the vendor config files and hooks for you (`attach` prints the exact commands instead), the interactive wake-mode prompt (non-interactive default `off`), and vendor auto-detection (`--vendor` is required). `login` cannot restart the local server yet; it tells you to.
