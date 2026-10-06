# @quorum/adapter-hooks

Track: **B** (taken over by abyud while abhijna is away), see `docs/TEAM_PLAN.md` §2.

Claude Code and Codex hooks: how mail reaches an agent between tool calls and at turn boundaries (ARCHITECTURE §15). Each hook is a short process the vendor starts: `quorum hook <claude-code|codex> <event> --attachment <at_id>`. It reads the vendor's JSON on stdin, talks to the server, prints the vendor's JSON (or nothing) and always exits 0, so a Quorum problem never blocks the agent.

| Event (`quorum hook …`) | Vendor event       | What it does                                                                                                                                                                                                                                  |
| ----------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session-start`         | `SessionStart`     | Registers the session with the vendor's real session id (shared-working-tree warning, INV-28), reports presence, and adds an introduction plus unread mail as `additionalContext`.                                                            |
| `prompt`                | `UserPromptSubmit` | Presence `working`; new mail next to the human's prompt.                                                                                                                                                                                      |
| `post-tool`             | `PostToolUse`      | Presence `working` (at most every 20 s); new mail next to the tool result.                                                                                                                                                                    |
| `stop`                  | `Stop`             | Asks the server (which holds the current wake mode) whether the new mail may continue the turn (`POST …/wake`, INV-29). Only on a grant: `{"decision":"block","reason": <framed mail>}`. Never twice in a row (`stop_hook_active`, spike S3). |
| `session-end`           | `SessionEnd`       | Presence `offline` and the session ends, both at once (Codex allows these hooks about a second).                                                                                                                                              |

**Idle wake (Codex):** `startCodexWaker`, run by `quorum mcp` for Codex attachments, watches the live stream; on new mail it finds an idle Codex session in the folder (preferring those its hooks registered), asks the server for a wake and, only on a grant, starts one turn through the shared Codex daemon (`@quorum/codex-bridge`). The framed mail goes into the thread's history and the turn starts with no user input, so the person sees only the agent's reply, which starts by showing the mail (`IDLE_WAKE_INTRO`, as on Claude Code); the person's prompt box stays the human's. Codex runs `quorum mcp` inside its shared daemon, one for every Codex window in the folder, so the waker serves them all: for each idle window its hooks registered it asks the server for a wake as that window (each window for its own mail), and it sends each window the daemon still has open a heartbeat every 30 s. `activeWindow` tells `quorum mcp` which window a tool call is for: the one whose hooks ran last (`activeAtMs`). A busy session is left alone: its hooks deliver mid-turn. Off: wake mode `off` or `QUORUM_CODEX_IDLE_WAKE=off`.

**Idle wake (Claude Code):** `quorum hook claude-code watch` is installed as a second `SessionStart` hook and a second `Stop` hook with `asyncRewake: true` (so a new window can be woken before its first prompt), so Claude Code runs it in the background when a turn ends. It holds the live stream (SSE) open; when mail arrives it asks the server for a wake (same rules as above) and, only on a grant, prints the framed mail and exits 2, which wakes the idle session. It stands down quietly when wake mode is `off`, when a newer watcher, a new prompt or the session's end replaces it, and after 8 hours. Codex has no such hook; see the Codex waker above.

Rules:

- Every message goes through the untrusted framing (`frameMessage`, MESSAGE_SPEC §8, INV-9). Mail is acknowledged after it is framed, up to the last message shown; whatever does not fit (about 10 000 characters) comes with the next hook.
- The adapter never decides to wake an agent; the server does, with the wake mode, budget and loop pause (INV-29).
- Nothing here starts processes or evaluates code (INV-10); the conformance test scans this package too.
- If the identity check fails (something else answers on Quorum's port), Claude Code shows the human a `systemMessage`; the model gets nothing and no credential is sent (INV-24). Codex hooks stay silent.
- Small per-attachment state (vendor session → Quorum session, last heartbeat) lives in `<data>/hooks/<at_id>.json`, never in the project folder.

Pending: a live run of the idle watcher in an interactive Claude Code session on Windows (spike S1); channels (S2) stay an alternative. Codex `Stop` continuation is documented by OpenAI but not yet seen live.

## Tests

`hooks.test.ts` runs every hook against the real local server: introduction and session registration, framed mail delivered once, both vendors' event names, turn continuation only on a server grant and never twice in a row, wake mode `off` and broadcasts under `direct`, session end, the heartbeat throttle, long mail in parts, and identity or connection failures.
