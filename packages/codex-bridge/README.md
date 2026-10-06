# @quorum/codex-bridge

Track: **B** (built by abyud while abhijna is away), see `docs/TEAM_PLAN.md` §2.

Wakes an idle Codex session. Codex hooks cannot do that, but Codex CLI 0.160+ runs sessions on a **shared local app-server daemon**, and a turn started there shows up live in the person's Codex window (verified in the 2026-10-05 spike, ADAPTER_CONTRACT §9). This package is the client for that daemon.

| Module      | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `daemon`    | `openCodexDaemon()` connects through `codex app-server proxy` (the daemon's control socket, protected by the OS account: no network port, no token); `threadsIn(root)` lists the sessions loaded in a folder; `startTurn(threadId, text)` puts `text` into the thread's history (`thread/inject_items`, role `user`) and starts one turn with no user input, so the window shows only the agent's reply (an older Codex gets `text` as the turn input). |
| `websocket` | Just enough WebSocket (handshake, masked client frames, reading frames) to speak to the daemon over the proxy's byte stream. No dependency.                                                                                                                                                                                                                                                                                                             |

Safety:

- `turn/start` sends only `threadId`, `input` (empty) and `turnTrigger: "quorum"`; `thread/inject_items` only the thread and one `user`-role text item, never a `developer` or `system` one. Never sandbox, approval, model or folder settings: the session keeps exactly the permissions the person gave it (tested).
- The proxy command is fixed (`codexProxyCommand`): Codex's managed daemon binary when present, else `codex` through the platform shell. Callers choose nothing. This is the only process Quorum's adapters can cause to start for Codex; the adapter and CLI sources themselves still contain no process APIs (INV-10).
- The waker that uses this (`@quorum/adapter-hooks`, `startCodexWaker`) asks the server for every wake (INV-29) and marks each woken turn as coming from Quorum, not the human.

The daemon protocol is marked experimental by OpenAI and may change between Codex releases; a failure here only means Codex is not woken (mail still arrives with the next prompt or tool call).

## Tests

`daemon.test.ts` runs against a fake daemon (CI has no Codex): handshake and `initialize`, sessions matched by folder however the path is spelled, the exact `turn/start` parameters, pings, refused/silent/closed connections, and the fixed proxy command.
