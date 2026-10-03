# @quorum/adapter-mcp

Track: **B** (adapters). The client side of Quorum: what an agent, the CLI and the hook adapter use to talk to a `/v1` server. The behaviour it promises is specified in [docs/ADAPTER_CONTRACT.md](../../docs/ADAPTER_CONTRACT.md).

| Export                                                 | What it does                                                                                                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `QuorumClient.connect`                                 | Finds the local server, verifies its identity (INV-24), then sends/reads with refreshed tokens (INV-11); also the bootstrap login, attachments (create, update, delete) and the agent list |
| `KeychainCredentialStore`, `MemoryCredentialStore`     | Tokens in the OS keychain (INV-25), or in memory for tests                                                                                                                                 |
| `Outbox`                                               | Durable local queue; safe to re-send (INV-20)                                                                                                                                              |
| `frameMessage`, `frameMessages`                        | Untrusted-data framing for everything shown to an agent (INV-9)                                                                                                                            |
| `createQuorumMcpServer`, `serveStdio`                  | The `quorum_send`, `quorum_inbox`, `quorum_status` MCP tools                                                                                                                               |
| `loadAttachment`, `saveAttachment`, `removeAttachment` | The per-attachment record in the private data directory                                                                                                                                    |
| `startHeartbeat`                                       | Presence: a heartbeat every 30 s, `offline` at once on stop (MESSAGE_SPEC §5.10)                                                                                                           |

Where the server publishes its port and key (`defaultDataDir`, the discovery file) comes from `@quorum/local`, shared with the server and CLI.

Dependencies: `@modelcontextprotocol/sdk` (official MCP SDK; planned in ARCHITECTURE §11), `@napi-rs/keyring` (OS keychain, D-11), `zod` (the SDK's schema library, a required peer of the SDK).

Tests use the fake server in `tests/fakes/fake-server`.
