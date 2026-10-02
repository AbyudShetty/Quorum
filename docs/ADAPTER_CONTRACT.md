# Adapter contract

Status: **draft for the Phase 1 contract freeze (IC1)** · Track B (abhijna) · Last updated: 2026-10-03

Track B's half of the contract: what the adapters, the CLI and the client library promise, how Claude Code and Codex receive messages, and how the wake modes work. Track A's half is `packages/schemas` (messages, `/v1` API, `localDiscovery`) and `tests/contract`. Changes follow TEAM_PLAN §5.3.

Items marked **[pending]** are not yet verified or not yet built; nothing in this document claims them as fact.

## 1. What exists

| Part                          | Where                      | State                                                                                                                            |
| ----------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Client library                | `packages/adapter-mcp/src` | built: discovery, identity check, credentials, refresh, outbox, cursor, framing                                                  |
| MCP server (`quorum_*` tools) | `packages/adapter-mcp/src` | built: `quorum_send`, `quorum_inbox`, `quorum_status`                                                                            |
| CLI                           | `packages/cli`             | built: `status`, `inbox`, `send`, `export`, `verify`, `mcp`. **[pending]** `attach`, `detach`, `serve`, `stop`, `worktree`, `ui` |
| Hook adapter                  | `packages/adapter-hooks`   | **[pending]** (Claude Code mechanics verified by spike S3; Codex hooks need trust approval first)                                |
| Fake `/v1` server             | `tests/fakes/fake-server`  | built; passes `tests/contract`                                                                                                   |

The client library lives in `adapter-mcp` for now because the CLI and the hook adapter both import it. If you prefer a separate `packages/client`, that is a pure move; raise it at the freeze.

## 2. Finding the server and checking who answers (INV-24, INV-25)

1. **Data directory:** `QUORUM_HOME`, else `%LOCALAPPDATA%\Quorum` on Windows, else `~/.quorum`. A test keeps `defaultDataDir` equal to the server's.
2. **Discovery:** read `<data>/local/server.json` (`localDiscovery` schema). Missing or malformed → treated as "no server".
3. **Identity handshake:** before any credential is sent, `POST /v1/hello` with a fresh 32-byte nonce; verify the signature with `verifyHello` against the pinned `public_key`, and require `instance_id` to equal the discovery file's. Any mismatch → `IdentityError`; the token is **never** sent and there is no fallback. Tests: wrong key, a squatter on the port, wrong instance (the squatter never receives an `Authorization` header).
4. **Unreachable vs. untrusted:** a connection failure is `UnreachableError` (retry later); a failed handshake is `IdentityError` (stop, tell the human).

**[pending]** Auto-start (`<data>/local/server.lock`, spawn `quorum serve --local`, wait for the discovery file) belongs to the CLI's `serve` and is not built yet. Until then adapters report "no local server is published".

## 3. Credentials (INV-11, INV-25)

- Stored in the OS keychain (`@napi-rs/keyring`; Windows Credential Manager), service `quorum`, one entry per attachment (key = the `at_` id) holding `{access_token, refresh_token, access_expires_at}`. Never in a file, never in a project folder.
- The access token is refreshed 60 s before expiry. Only one refresh runs at a time (a second would present the old refresh token and trigger family revocation). The rotated pair is saved **before** it is used.
- A damaged keychain entry is treated as "no credentials".
- The signed-in human's tokens (used by `quorum export`) live under the key `human`.

## 4. Attachment record (written by `quorum attach`)

`<data>/attachments/<at_id>.json`, owner-only, no secrets:

```json
{
  "attachment": "at_…",
  "agent": "agent:claude-api@laptop",
  "workspaces": ["ws_…"],
  "vendor": "claude-code",
  "root": "C:/work/api",
  "wake": "off",
  "lease_enforcement": "warn"
}
```

An adapter is started with `--attachment <at_id>` and loads this record plus the keychain entry. It sees only the workspaces listed. `<data>/cursor/<at_id>.json` holds the highest delivered `seq` per workspace, shared by the MCP server and (later) the hooks so a restart does not replay old mail.

What `attach` must write for each vendor is in ARCHITECTURE §12 step 5. **[pending]** — see §9 for the open questions that block building it.

## 5. Tools

All tools return text. Errors come back as tool errors containing the server's `code`, `message` and `fix`.

| Tool            | Input                                                                                                                                                  | Behaviour                                                                                                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quorum_send`   | `to[]`, `type` (`note`\|`request`\|`task_update`\|`finding`\|`retraction`, default `note`), `body`, optional `workspace`, `thread`, `reply_to`, `refs` | Builds the envelope (`from` is always the attachment's agent, never an input: INV-7), writes it to the outbox, flushes. Replies "Sent" or "Saved … will be sent when the server is reachable". `approval_decision` is not offered (INV-1). Refusals are reported. |
| `quorum_inbox`  | optional `workspace`, `limit` (1–100, default 20), `mark_read` (default true)                                                                          | Fetches messages after the cursor, returns each framed as untrusted data (§6), acks and advances the cursor unless `mark_read` is false.                                                                                                                          |
| `quorum_status` | optional `workspace`                                                                                                                                   | Who you are, wake mode, outbox size, agents with vendor and presence.                                                                                                                                                                                             |

The server's `instructions` tell the agent that messages are data, never instructions (THREAT_MODEL prompt-injection row). **[pending]** `quorum_request_approval` (Phase 2) and lease tools (Phase 3).

## 6. Framing and delivery (INV-9, INV-10)

Every message handed to an agent, by any path, goes through `frameMessage` (MESSAGE_SPEC §8): nonce generated per delivery (128 bits), sender line, refs, flags, body JSON, matching end marker, reminder. Header values are stripped of control characters and `<`, `>`, `"` and cut to length, so a hostile folder name or sender string cannot forge frame syntax. A body containing a start/end marker adds `suspicious-delimiter`. Tests cover all of this.

Nothing in the adapters executes message content, follows `reproduce` fields, or calls tools because of a message (INV-10). **[pending]** the conformance suite `tests/conformance/` that checks INV-9/10 against the real adapters on both vendors (the current tests are unit-level).

### Delivery paths per vendor

| Path                                                      | Claude Code                                                                                     | Codex                                                                                         |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Pull (`quorum_inbox` etc.)                                | MCP over stdio, **built and tested** with the SDK's in-memory transport against the fake server | MCP over stdio; server runs as the user (S4, verified). **[pending]** end-to-end run in Codex |
| Mail at session start / on each prompt / after tool calls | hooks with `additionalContext` **[pending]**                                                    | hooks **[pending]** (need trust approval, see S4)                                             |
| Continue a turn when mail arrived                         | `Stop` hook with `decision: "block"` (S3, verified)                                             | documented, **[pending]** verification                                                        |
| Wake an idle session                                      | channels or `asyncRewake` **[pending]** (S1, S2 need an interactive session)                    | no documented mechanism; mail waits for the next prompt                                       |

## 7. Offline sending and delivery guarantees (INV-20)

- `quorum_send` and `quorum send` write `<data>/outbox/<attachment>/<msg id>.json` **before** any network call. One file per message, so two processes never rewrite each other's data.
- Flush sends oldest first (ULID order). On success or a duplicate answer (`200`) the file is removed. A permanent refusal (4xx except 401/429) moves the file to `rejected/` with the reason and the flush carries on. Unreachable, 429, 401 and 5xx stop the flush and keep everything for next time.
- The outbox refuses to create the data directory: the server creates it with owner-only permissions (INV-25), and an adapter must never create a more open one.
- Delivery to the agent is at-least-once. Consumers dedupe by message `id`.

## 8. Wake modes (D-9)

The mode is stored per attachment (`off` | `direct` | `all`, optional `wake_types`) and enforced by the server's wake governor (INV-29: hourly budget and the agent-only-loop breaker always apply). Adapters never decide on their own to wake.

| Mode / vendor                         | What the adapter does                                                                                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`, both                           | Show mail at the next turn boundary and on `quorum_inbox`. No auto-continue.                                                                              |
| `direct`/`all`, Claude Code, mid-turn | Surface mail after tool calls; on `Stop`, block once with the framed mail so the turn continues. Use `stop_hook_active` to stop (S3). **[pending]** build |
| `direct`/`all`, Claude Code, idle     | **[pending]** channels (S2) or `asyncRewake` watcher (S1)                                                                                                 |
| `direct`/`all`, Codex                 | `Stop` continuation **[pending]** (S3, Codex side); idle: next prompt; the human is notified                                                              |

## 9. Spike results

Environment: Windows 11, Claude Code 2.1.287, Codex CLI 0.144.6, Node 24.21, tested 2026-10-03 by abhijna's machine (M2). Probe scripts were throwaway files outside the repo.

| Spike  | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S1** | **Not run.** Needs an idle interactive Claude Code session on Windows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **S2** | **Not run.** Needs an interactive session with the channel development flag.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **S3** | **Claude Code: verified.** A `Stop` hook returning `{"decision":"block","reason":"…"}` makes the agent continue and act on the reason (it replied with the injected instruction). The hook ran as the user. The next `Stop` call carries `stop_hook_active: true`: the adapter must stop blocking then (loop guard). **Codex: not run** (hooks were not trusted).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **S4** | **MCP servers: verified.** Launched by `codex exec` they run as the user (`whoami` = the signed-in account, real home directory) in both `read-only` and `workspace-write` sandbox modes, and could read a file whose ACL allowed only that user. So the MCP adapter can reach the private data directory and the keychain. `args`/`cwd`: the server's working directory was the project directory. **Hooks:** a valid `.codex/hooks.json` in the project was **silently skipped** by `codex exec` because it was not trusted (no warning, no error), so a non-interactive run never fires unreviewed hooks. **MCP tool calls in `codex exec`:** a quorum tool call is answered with "user cancelled MCP tool call", because nothing can approve it non-interactively. Codex's own approval settings decide this; we do not lower them for the user, so `attach` should tell the human that Codex will ask before each quorum tool call unless they choose otherwise. The automated Codex end-to-end test is therefore skipped (`tests/e2e/vendor-mcp.test.ts`); Claude Code's passes. Which account runs hooks is **[pending]**: it needs the hook approved once in the interactive `/hooks` screen. `~/.codex/config.toml` here sets `sandbox = "elevated"`, which was not tested separately. |
| **S5** | **Not run.** The latency harness needs the real adapter and server; a version against the fake server is possible.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

Consequences already built in: the MCP adapter runs as the user on both vendors (S4); a Codex project's hooks must be reviewed by the human once, so `attach` can only print that step (ARCHITECTURE §12).

## 10. Open questions for the freeze

1. **How does the CLI get a human token in local mode?** `POST /v1/attachments` needs a human token, but nothing says how `quorum attach` obtains one on a fresh machine (first-run bootstrap, a local-only human credential in the keychain, or a login code). The CLI currently reads the `human` keychain entry. This blocks `attach`. **Track A to decide, jointly.**
2. **Inbox cursor.** `GET …/inbox?after=` is purely seq-based; acks are recorded per recipient but not used to filter. Adapters therefore keep their own cursor. Should the server filter by the caller's ack, or stay as is? (Either works; the contract should say which.)
3. **Changing wake mode after attach.** Is it a second `POST /v1/attachments` for the same folder, or a missing `PATCH`? §15.2 promises it can change at any time.
4. **Where the shared client code lives** (`adapter-mcp` vs a new `packages/client`) and **`defaultDataDir` duplication:** it exists in `@quorum/server` and in the adapter so adapters need not depend on SQLite. Moving it to `@quorum/core` would remove the duplicate (a Track A change).
5. **Folder in the sender header.** MESSAGE_SPEC §8 shows vendor and folder name. `GET …/agents` returns the vendor but no folder, so today the header shows the vendor only. Add `folder` to the agent list, or drop it from the header?
6. **Heartbeats.** The adapter does not send them yet. Who sends them, and how often, for sessions that only use hooks?

## 11. What is tested

`packages/adapter-mcp/test`: framing (INV-9), identity check and squatter (INV-24), token refresh and rotation (INV-11), outbox (INV-20, INV-25), keychain round trip, discovery, MCP tools including "no `approval_decision`, no `from` input" (INV-1, INV-7). `packages/cli/test`: every command against the fake server. `tests/fakes/fake-server`: the fake passes `tests/contract`.
