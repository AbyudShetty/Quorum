# @quorum/cli

Track: **B**. The `quorum` command (`bin/quorum.js`). Parsing uses Node's built-in `util.parseArgs`; no extra dependency.

| Command                                                              | What it does                                                                     |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `quorum status [--attachment <at_id>]`                               | Is the local server up, and does it hold the pinned key (INV-24)? Exit 2 if not. |
| `quorum inbox --attachment <at_id> [--workspace] [--limit] [--keep]` | New messages, always framed as untrusted data (INV-9)                            |
| `quorum send --attachment <at_id> --to <addr> --text <text>`         | Send a note as that agent; saved locally first if the server is down             |
| `quorum export --workspace <ws>`                                     | Event log as JSON Lines (human credentials)                                      |
| `quorum verify <file.jsonl> --workspace <ws>`                        | Check an exported log's hash chain (INV-8)                                       |
| `quorum mcp --attachment <at_id>`                                    | MCP server over stdio, as launched by Claude Code or Codex                       |

Exit codes: 0 ok, 1 refused or verification failed, 2 identity check failed, 3 server unreachable, 64 usage error.

Not built yet: `attach`, `detach`, `serve`, `stop`, `worktree`, `ui`. `attach` needs a decision on how a human signs in locally (ADAPTER_CONTRACT §10).
