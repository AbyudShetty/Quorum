# Architecture

Status: **draft for Phase 0 review** · Source: plan §7 · Decisions: [DECISIONS.md](DECISIONS.md) · Last updated: 2026-10-01

## 1. Shape of the system

```
            ┌──────────────────────────── Quorum Server (one Node.js process) ────────────────────────────┐
            │  HTTP API /v1 (JSON)   ·  SSE push  ·  HTML routes (server-rendered + HTMX)  · [A2A: Ph. 6] │
            │  ──────────────────────────────── core (pure TypeScript) ────────────────────────────────── │
            │  commands → validate (JSON Schema) → authorize (scopes, policy) → append event → project    │
            │  ─────────────────────────────────────── ports ──────────────────────────────────────────── │
            │  EventStore · ProjectionStore · BlobStore · Clock · Ids · Crypto · Notifier                 │
            │  ─────────────────────────────────────── adapters ───────────────────────────────────────── │
            │  SQLite (default) | Postgres (later)   ·   local disk blobs   ·   SSE | WebSocket (later)   │
            └──────────────▲───────────────────────▲───────────────────────────────▲──────────────────────┘
                           │ loopback or HTTPS     │                               │ loopback or HTTPS
                           │ + agent token         │                               │ + session cookie
                 MCP adapter (stdio) + hooks   CLI (`quorum ...`)         Browser / phone (humans)
                           │
                Claude Code / Codex / Gemini / OpenCode
```

The one rule that keeps everything replaceable: **the core knows nothing about HTTP, SQL, HTML or networks.** It receives commands, emits events, and talks to the world only through ports (interfaces). Every technology choice in [DECISIONS.md](DECISIONS.md) lives behind a port or at the edge.

## 2. Packages

Matches plan §18. Each package is an npm workspace under `packages/`. Track ownership is in [TEAM_PLAN.md](TEAM_PLAN.md).

| Package            | Responsibility                                                                                                                                                                      | Depends on                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `schemas`          | JSON Schemas for envelope, every message type, policy, API payloads (OpenAPI for `/v1`); generated TS types. **Language-neutral single source of truth.**                           | —                                   |
| `core` **[added]** | Domain logic: event log + hash chain, projections, policy engine, task/lease/approval state machines, retraction propagation, shared-worktree detection, wake budget. Pure, no I/O. | schemas                             |
| `server`           | Fastify HTTP API, SSE, auth, local/remote mode, SQLite/Postgres + blob adapters, HTML routes.                                                                                       | core, schemas, web                  |
| `web`              | Server-side templates, CSS, vendored HTMX; no build step required.                                                                                                                  | —                                   |
| `cli`              | `quorum serve/attach/detach/status/stop/worktree/join/send/inbox/export/verify/approve/lease/...`                                                                                   | schemas (talks to server over HTTP) |
| `adapter-mcp`      | MCP server exposing `quorum_*` tools; untrusted framing; local outbox; server identity check; credential storage.                                                                   | schemas                             |
| `adapter-hooks`    | Vendor-specific delivery: Claude Code and Codex hooks (Phase 1), wake mechanisms.                                                                                                   | adapter-mcp                         |

`core` is an addition to the plan's layout: separating it from `server` is what makes storage, transport and UI swappable and lets the policy engine run identically in the CLI (`quorum policy explain`).

## 3. Data model: event-sourced

1. **Command** (e.g. `SendMessage`) arrives via HTTP, CLI or MCP.
2. **Validate** against JSON Schema; **authenticate** (token → principal); **authorize** (scopes, policy).
3. **Append event** to the workspace's chain in one transaction:
   ```
   { ev_id, workspace, seq, ts, actor, kind, payload, prev_hash, hash }
   hash = SHA-256( JCS(event without hash) );  genesis prev_hash = SHA-256("quorum/1 genesis " + workspace)
   ```
4. **Project**: update read tables (inbox, threads, tasks, leases, approvals, artifacts, flags, sessions) in the same transaction.
5. **Notify** SSE subscribers after commit.

Properties:

- Tables are disposable projections: `quorum rebuild` replays the log.
- `quorum export` writes JSONL (one event per line, plus the chain head); `quorum verify` re-hashes it (INV-8). Clients store the latest `(seq, hash)` they have seen as **checkpoints**; `quorum verify --against-checkpoints` detects a consistent rewrite by the operator.
- Per-workspace chains keep export, verification and deletion independent per workspace.
- Heartbeats are presence state, not events (MESSAGE_SPEC §5.10). Session start/end, attachment and identity changes **are** events.

## 4. Storage

| Port              | Default adapter                                                                             | Notes                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `EventStore`      | SQLite via `better-sqlite3`, WAL mode, `synchronous=FULL` for the event table               | Single writer, append-only; schema migrations versioned and tested.                        |
| `ProjectionStore` | Same SQLite DB                                                                              | Rebuildable.                                                                               |
| `BlobStore`       | Content-addressed files: `blobs/sha256/ab/cd/<hash>`; atomic rename after hash verification | Resumable chunked upload (Phase 3); dedup free. File names come only from hashes (INV-27). |

Postgres is a second implementation of the same ports (later), validated by running **the same storage contract test suite** against both.

The data directory is per OS user: `~/.quorum/` on Linux/macOS, `%LOCALAPPDATA%\Quorum\` on Windows. It must be private to that user (INV-25).

## 5. Transport and API

- **HTTP JSON API** under `/v1`. Versioned; additive changes only within a major version. This API is the single contract for CLI, adapters, the web UI and any future SPA or non-TypeScript client. It is specified as OpenAPI in `packages/schemas` and frozen at the start of Phase 1 (contract-first, see TEAM_PLAN).
- **Push:** SSE with `Last-Event-ID` resume by `seq` (lossless reconnect). WebSocket can be added as a second `Notifier` adapter if bidirectional push is ever needed.
- **Agents** connect through the MCP adapter (stdio to the agent; loopback HTTP or HTTPS to the server). Agents that cannot run MCP use the CLI.
- **Errors** follow MESSAGE_SPEC §6: stable code, what/why, exact fix.

## 6. Identity and auth

| Principal                  | Credential                                                                                                                                                           | Details                                                                                                                                                                                                                                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agent                      | Access token (1 h) + refresh token (30 d, rotating, family revocation on reuse)                                                                                      | 256-bit random with a recognisable prefix (`qrm_at_`, `qrm_rt_`, `qrm_jc_`) so a leaked token is caught by the secret scanner (INV-14); stored server-side as SHA-256 hashes (INV-11); scoped (INV-12). Client side stored in the **OS keychain** (D-11). Phase 3: Ed25519 key per agent, generated locally. |
| Human (web)                | Session cookie                                                                                                                                                       | `HttpOnly; Secure; SameSite=Strict`, CSRF token on state changes (INV-21).                                                                                                                                                                                                                                   |
| Human (login)              | One-time login link/code from the CLI (`quorum ui`, single use, 60 s)                                                                                                | Exchanged for a session cookie.                                                                                                                                                                                                                                                                              |
| Human (high-risk approval) | **Hardware-backed user verification** (Phase 2, D-10): Windows Hello key credential from the terminal (`quorum approve`), or a WebAuthn passkey in the browser/phone | Challenge commits to `request_id` + `preview_hash`; the server verifies the signature against the key registered to that human (INV-31). Terminal path: TPM-backed key via Windows `KeyCredentialManager`, signing prompts Windows Hello (spike S6).                                                         |
| Join (remote)              | Join code: server URL + server key fingerprint + single-use secret, expires in 10 min, text + QR                                                                     | Exchanged for agent credentials; the human who created it becomes the agent's owner.                                                                                                                                                                                                                         |
| Attach (local)             | `quorum attach` run by the human                                                                                                                                     | Creates attachment + agent + credentials (§12). Phase 1: confirmed interactively and logged; Phase 2: a gated action (INV-30).                                                                                                                                                                               |

**Server identity (INV-24).** Every server has an Ed25519 instance key. Clients never send a credential until the server has signed a fresh client nonce (`POST /v1/hello`; the signed bytes are the UTF-8 text `quorum/1 hello`, a newline, the instance ID, a newline, then the nonce) with the key whose public half the client has pinned — from the private discovery file in local mode, or from the join code in remote mode. This defeats a local process that grabs the port, and a network attacker who isn't stopped by TLS.

## 7. Web UI (server-rendered + HTMX)

- HTML is rendered on the server with contextual auto-escaping templates; HTMX swaps fragments; the timeline updates live via SSE (HTMX SSE extension).
- **Vendored assets only** (HTMX served from our own origin, no CDN) and a strict CSP: `default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'` (INV-21).
- HTML routes are a thin layer that calls the **same core commands** as the JSON API — no business logic in templates or route handlers. This is the migration seam to an SPA: an SPA would consume `/v1` unchanged.
- Mobile-first layout: the approval screen shows summary, risk, requester, evidence, preview/diff and rollback plan without horizontal scrolling; one tap to approve, plus a passkey prompt for `high`/`critical`. The same approvals work from the terminal (`quorum approve`), where `high`/`critical` trigger Windows Hello directly (§6).
- In local mode the UI is served at `http://localhost:<port>` (not `127.0.0.1`), because WebAuthn requires a domain as relying-party ID and `localhost` is a secure context in browsers.

## 8. Networking and topologies

The server only knows: _bind addresses_, _public URL_, _TLS on/off_. It contains no Tailscale- or Cloudflare-specific code.

### 8.1 Topologies

|        | Example                                                            | Server                                                        | Network setup                                      |
| ------ | ------------------------------------------------------------------ | ------------------------------------------------------------- | -------------------------------------------------- |
| **T1** | Claude Code in `~/proj/api` + Claude Code in `~/proj/web`          | local mode, auto-started                                      | none                                               |
| **T2** | Claude Code + Codex in the same repo (or two repos) on one machine | local mode, auto-started                                      | none                                               |
| **T3** | Agents on different machines                                       | remote mode on one machine; its own agents still use loopback | Tailscale (default, D-5), Cloudflare Tunnel or LAN |

One server can serve local and remote clients at the same time; local clients always connect over loopback.

### 8.2 Local mode (T1, T2)

- **One server per OS user per machine**, holding any number of workspaces. Data directory as in §4.
- **Bind:** loopback only — `127.0.0.1` and `::1` — on an OS-assigned port. Local mode can never bind a non-loopback address (INV-22).
- **Why loopback TCP and not a named pipe/Unix socket by default:** Node cannot set a restrictive ACL on Windows named pipes, so a pipe adds no protection there; MCP HTTP clients and browsers need TCP anyway. **Tokens are the security boundary on loopback** (INV-23): any local process or other OS user can reach the port, but nothing works without a token. A Unix socket in the private data directory may be added later on Linux/macOS as defence in depth.
- **Discovery file** `<data>/local/server.json` (private, INV-25): `{ instance_id, pid, port, public_key, version, started_at }`. No secrets.
- **Auto-start:** an adapter or CLI command that finds no healthy server takes `<data>/local/server.lock` (exclusive create), spawns `quorum serve --local` detached, waits for the discovery file, then performs the identity handshake (§6). A stale file (dead pid or failed handshake) is removed under the lock. This makes concurrent first starts by two agents safe.
- **Lifetime:** `quorum status`, `quorum stop`. The server shuts down after `idle_shutdown` (default 30 min) with no connected clients and no pending approvals; all state is in SQLite, so restarts lose nothing.
- **Request checks (INV-26):** the `Host` header must be `localhost:<port>`, `127.0.0.1:<port>` or `[::1]:<port>`; state-changing requests with a foreign `Origin` are rejected. This stops malicious web pages (DNS rebinding, cross-site posts) from talking to the local server.
- **Humans:** `quorum ui` opens a one-time login link. Approving from a phone needs the server to be reachable from the phone, i.e. remote mode (§8.3); in pure local mode, approvals happen on the same machine.

### 8.3 Remote mode (T3)

| Topology                                        | How                                                                                               | Status                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Same LAN / hotspot                              | bind private IP; TLS recommended                                                                  | supported                                                           |
| **Different networks (default recommendation)** | **Tailscale**: server stays private on the tailnet; HTTPS via `tailscale serve` or MagicDNS certs | documented as default (D-5; revisit requested, see DECISIONS)       |
| Different networks (alternative)                | Cloudflare Tunnel (public HTTPS hostname), or plain WireGuard                                     | documented; Phase 1b exit tests Tailscale **and** Cloudflare Tunnel |

Refusing an insecure public bind is enforced by INV-22. Being on the tailnet is never treated as authentication. With Cloudflare Tunnel the server is internet-reachable, so authentication, rate limits and INV-24 pinning carry all of the protection.

## 9. Migration seams (keep every decision reversible)

| Decision                                   | Seam                                                                           | Cost to switch later                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------- |
| SQLite → Postgres                          | `EventStore`/`ProjectionStore` ports + shared contract tests                   | New adapter + data migration via `export`/`import` JSONL |
| SSE → WebSocket                            | `Notifier` port; clients already resume by `seq`                               | Additive                                                 |
| HTMX → SPA                                 | `/v1` JSON API is complete on its own; HTML routes hold no logic               | Build the SPA; delete templates                          |
| Tailscale → Cloudflare/WireGuard/LAN       | Server is network-agnostic (§8)                                                | Docs only                                                |
| Loopback TCP → Unix socket / pipe (local)  | Local transport is chosen by the discovery file (`port` or `socket`)           | Additive                                                 |
| OS keychain → other secret store           | `CredentialStore` port in adapter/CLI                                          | New adapter                                              |
| Vendor delivery mechanism (hooks/channels) | `adapter-hooks` per vendor behind the adapter contract                         | Per-vendor change; conformance suite guards it           |
| TypeScript → other languages for clients   | JSON Schemas + HTTP API are language-neutral                                   | Generate clients from schemas                            |
| Our protocol ↔ A2A                         | Gateway module mapping Agent Cards/tasks to Quorum agents/requests; JCS shared | Additive (Phase 6)                                       |

## 10. Capacity and latency targets (measured in Phase 1 for local, Phase 5 for scale)

Design point: a team of 2–10 humans, up to **50 agents** per server (the simulated-fleet target in plan §11).

| Metric                                                             | Target on a 4-core laptop with SSD          |
| ------------------------------------------------------------------ | ------------------------------------------- |
| Sustained message appends                                          | ≥ 500/s per workspace                       |
| Push latency, local mode (append → adapter receives over loopback) | p95 < 20 ms                                 |
| Push latency, LAN (append → SSE delivery)                          | p95 < 100 ms                                |
| Into the model's context                                           | see §15.3 (depends on vendor and wake mode) |
| Local auto-start (first `attach` → server ready)                   | < 2 s                                       |
| Concurrent SSE streams                                             | ≥ 200                                       |
| Event log size before needing Postgres                             | ≥ 10 M events                               |
| Server cold start                                                  | < 1 s                                       |

SQLite in WAL mode with a single writer comfortably meets these; Postgres exists for teams that outgrow one machine, not because the default is weak.

## 11. Planned runtime dependencies (each justified when added, plan §19)

| Dependency                  | Why                                                                                                                                                                 | Phase |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `fastify`                   | HTTP server, schema-based validation hooks, mature                                                                                                                  | 1     |
| `better-sqlite3`            | Fast, synchronous, transactional SQLite                                                                                                                             | 1     |
| `ajv`                       | JSON Schema 2020-12 validation (in `@quorum/schemas`; MIT, ~456 M weekly downloads). RFC 3339 dates are checked by our own function, so `ajv-formats` is not needed | 1     |
| `ulid`                      | Sortable IDs                                                                                                                                                        | 1     |
| _(none)_ for RFC 8785 JCS   | Implemented in `@quorum/core` (~30 lines): for JSON values JCS is sorted keys plus ECMAScript serialization, tested against the RFC examples                        | 1     |
| `@modelcontextprotocol/sdk` | Official MCP SDK (also used for Claude Code channels)                                                                                                               | 1     |
| `@napi-rs/keyring`          | OS keychain (Windows Credential Manager, macOS Keychain, Linux Secret Service) for client credentials; MIT, ~5.5 M weekly downloads (D-11)                          | 1     |
| `htmx.org` (vendored file)  | UI interactivity without a build step                                                                                                                               | 1     |
| `yaml`                      | Policy file parsing                                                                                                                                                 | 2     |
| `@simplewebauthn/server`    | Passkey verification for high-risk approvals; MIT, ~5.9 M weekly downloads (D-10)                                                                                   | 2     |
| Node `crypto` built-ins     | SHA-256, random, Ed25519 (no libsodium needed)                                                                                                                      | 1/3   |

Exact package choices for templating and CLI parsing are made in Phase 1, with the reason in the PR.

## 12. Attachments, agents and sessions

Three layers, so identity can be stable by default yet changed whenever needed (D-12):

| Object         | Prefix  | What it is                                                                                                             | Lifetime                              |
| -------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **Attachment** | `at_`   | (machine, canonical folder, vendor) bound by a human to one or more workspaces                                         | Until `quorum detach`                 |
| **Agent**      | `ag_`   | The identity others address (`claude-api@laptop-a`); owns an inbox, tokens, later a signing key                        | Stable; by default one per attachment |
| **Session**    | `sess_` | One live run of the vendor tool, identified by the vendor's `session_id` (both Claude Code and Codex pass it to hooks) | Start → end of that run               |

**Agent record:** `id, name, vendor (claude-code | codex | gemini-cli | opencode | generic), machine, owner, attachment, root (canonical absolute path), repo (rp_), worktree (wt_), sessions[], public_key (Phase 3)`.

**Naming:** `<vendor-short>-<folder-name>@<machine>`, e.g. `claude-api@laptop-a`, `codex-web@laptop-a`. Collisions get `-2`, `-3`. `quorum agent rename` changes the display name; the `ag_` id never changes.

**Flexible identity (D-12):**

- Default: a new session in the same attachment reuses the agent identity, so its inbox and history carry over.
- `quorum attach --new-identity` or `quorum agent new <name>` creates a fresh identity for the same folder; the old one keeps its history and can be retired (`quorum agent retire`).
- A second **simultaneous** session of the same vendor in the same attachment gets a temporary identity (`claude-api-2`), retired when its session ends unless kept (`quorum agent keep`).
- A session can be pinned explicitly with the environment variable `QUORUM_AGENT=<name>`.
- Every identity change is an event in the log.

**`quorum attach [dir] [--workspace <ws>] [--vendor auto|claude-code|codex] [--wake off|direct|all] [--new-identity]`:**

1. Canonicalize `dir` (resolve symlinks); refuse the Quorum data directory.
2. Ensure the local server is running (§8.2).
3. Detect installed vendors and ask which agent(s) work in this folder.
4. Create the attachment, agent and credentials; store credentials in the OS keychain, never in the folder.
5. Write vendor configuration **outside version control**:
   - Claude Code: `claude mcp add --scope local quorum -- quorum mcp --attachment <at_id>` (stored in `~/.claude.json` for this project); hooks in `.claude/settings.local.json`; add `permissions.deny` read rules for the Quorum data directory (defence in depth, THREAT_MODEL §6).
   - Codex: `.codex/config.toml` with `[mcp_servers.quorum]` (`command`, `args` including `--attachment <at_id>`) and `.codex/hooks.json`; paths added to `.git/info/exclude` (never `.gitignore`). Codex requires the project to be trusted and its hooks to be reviewed once in `/hooks`; `attach` prints those steps.
6. Ask the wake mode (§15.2).
7. If another live agent uses the same working tree, warn and offer `quorum worktree` (§13).
8. Print every file written and the undo command `quorum detach`.

**Visibility:** an adapter learns its attachment from `--attachment`, cross-checked against `CLAUDE_PROJECT_DIR` (Claude Code) or the hook `cwd` (both vendors). It sees only the workspaces that attachment grants (token scope, INV-12). From a subfolder, the CLI uses the nearest attached ancestor folder (like git). Adding a workspace to an attachment is `workspace.attach` (INV-30); agents cannot widen their own visibility.

## 13. Agents sharing a folder (T2)

- **Detection (INV-28):** each session reports its canonical root plus, for git repos, `git rev-parse --show-toplevel` and `--git-common-dir`. The server assigns a stable repo id `rp_…` per canonical git common directory (all worktrees of one repo share it) and a worktree id `wt_…` per canonical worktree root; like every ID they are a prefix plus a ULID (MESSAGE_SPEC §1), not a hash. Two live sessions with the same `wt_` trigger a `shared_worktree` notice from `system:quorum` to both agents and a banner for the humans, until one detaches or a human acknowledges.
- **Recommended: one worktree per agent.** `quorum worktree [--agent <name>]` runs `git worktree add ../<repo>-<agent> -b quorum/<agent>` and moves the attachment there. `attach` offers this automatically.
- **If agents stay in one tree:**
  - Leases: `worktree:wt_…` (exclusive = "I am the only writer here") and `path:rp_…/<glob>` for areas.
  - Edit-time warnings: both Claude Code and Codex have a `PreToolUse` hook (Codex covers `apply_patch`). The adapter warns the agent, through hook context, before it edits a path leased by another agent. Per attachment `lease_enforcement: warn | block` (default `warn`); `block` denies the tool call.
  - Commit hygiene: the agents share one git index, so the instruction snippet tells agents to stage only their own paths (`git add <paths>`, never `git add -A`) and an optional pre-commit guard checks leases (Phase 3).

## 14. Artifacts: storage modes

| Mode                  | Where the bytes are                                                                                                               | Who can use it                                    | Cross-machine                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------- |
| `stored`              | Copied into the server's content-addressed store                                                                                  | Members with artifact scope, via the server       | Yes                                                           |
| `local_ref` **[new]** | Stay at their path on the publisher's machine; the server stores only `{machine, attachment, relative path, sha256, size, mtime}` | Agents on the same machine read the path directly | No — remote consumers see "local to laptop-a; ask for a copy" |
| `local_only`          | Never leave the machine; metadata only                                                                                            | Same machine                                      | No                                                            |

- **Publishing `local_ref`:** the publisher's adapter resolves the path, checks that it lies inside its attached root and outside the Quorum data directory and the sensitive-file denylist (INV-27), and streams a SHA-256.
- **Using `local_ref`:** the consumer's adapter returns the path only after checking the hash (cached per path + size + mtime + inode within a session). If the file changed, the artifact is flagged `changed-on-disk` and the publisher must publish a new version.
- **The server never opens `local_ref` paths** — it cannot be used to read files.
- **Explicit copy:** `quorum artifact copy <art>@v<n>` (run by the publisher's side) uploads the bytes, creating a new `stored` version with lineage `copied_from`. Policy action `artifact.copy_local` (gated, low risk by default).

## 15. Delivering messages to agents

Verified against official docs on 2026-10-01; re-verify every vendor release (plan §10). Sources: [Claude Code hooks](https://code.claude.com/docs/en/hooks), [Claude Code MCP](https://code.claude.com/docs/en/mcp), [Claude Code channels](https://code.claude.com/docs/en/channels-reference), [Codex hooks](https://developers.openai.com/codex/hooks), [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

### 15.1 Mechanisms per vendor

| Mechanism                                    | Claude Code                                                                                                                                                                                                                                                                                                                | Codex                                                                                     |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| MCP tools (`quorum_inbox` etc., pull)        | ✅ stdio/HTTP; `CLAUDE_PROJECT_DIR` set for servers                                                                                                                                                                                                                                                                        | ✅ stdio/streamable HTTP; `~/.codex/config.toml` or trusted-project `.codex/config.toml`  |
| Unread summary at session start              | `SessionStart` hook, `additionalContext`                                                                                                                                                                                                                                                                                   | `SessionStart` hook, `additionalContext`                                                  |
| New mail when the human sends a prompt       | `UserPromptSubmit`, `additionalContext`                                                                                                                                                                                                                                                                                    | `UserPromptSubmit`, `additionalContext`                                                   |
| New mail while the agent works               | `PostToolUse` (and `PreToolUse`), `additionalContext` next to the tool result                                                                                                                                                                                                                                              | `PostToolUse`, `additionalContext`                                                        |
| Keep going when mail arrived during the turn | to verify (spike S3)                                                                                                                                                                                                                                                                                                       | `Stop` hook `decision: "block"` continues the turn                                        |
| Wake an **idle** session                     | **Channels** (research preview): server declares `claude/channel`, pushes `notifications/claude/channel`; custom channels need `--dangerously-load-development-channels server:quorum` until allowlisted. **Background hook** with `asyncRewake: true` "wakes Claude on exit code 2" (idle behaviour to verify, spike S1). | **No documented mechanism.** Mail waits for the next human prompt; the human is notified. |
| Hook trust                                   | Hooks in settings files                                                                                                                                                                                                                                                                                                    | Non-managed hooks must be reviewed/trusted in `/hooks`                                    |

Every delivery path uses the untrusted framing (MESSAGE_SPEC §8, INV-9) and goes through the same adapter code; vendor differences live only in `adapter-hooks`.

### 15.2 Wake mode — the user's choice (D-9)

Per attachment, chosen at `quorum attach` (interactive prompt explaining the trade-off) and changeable any time (`quorum attach --wake …` or the UI):

| Mode     | Behaviour                                                                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`    | Never wake or auto-continue; mail is shown at the next turn boundary and via `quorum_inbox`. **Default when `attach` runs non-interactively.** |
| `direct` | Wake/continue for messages addressed to this agent (not broadcasts). Suggested in the interactive prompt.                                      |
| `all`    | Also wake for broadcasts (`*`).                                                                                                                |

Optional `wake_types` narrows further (e.g. only `request` and `retraction`). Whatever the mode, the **wake budget and the agent-only-loop circuit breaker always apply** (INV-29, POLICY_SPEC `limits`), and waking never bypasses the agent's own permission prompts.

### 15.3 Delivery latency targets (local mode)

| Path                                                           | Target                                                    |
| -------------------------------------------------------------- | --------------------------------------------------------- |
| Append → adapter receives                                      | p95 < 20 ms                                               |
| Agent mid-turn (PostToolUse)                                   | by the end of the next tool call                          |
| Idle Claude Code, channels enabled, wake ≠ `off`               | p95 < 1 s into context                                    |
| Idle Claude Code, `asyncRewake` watcher (if spike S1 confirms) | p95 < 2 s into context                                    |
| Idle Codex, or wake = `off`                                    | next turn; human notified (terminal/desktop/UI) p95 < 1 s |

### 15.4 Phase 1 spikes (results go into the adapter contract)

- **S1** `asyncRewake` background watcher wakes an idle Claude Code session; behaviour on Windows.
- **S2** One stdio MCP server acting as both tool server and channel; behaviour without the development flag (events silently dropped).
- **S3** Turn continuation on `Stop` for both vendors; loop protection.
- **S4** Codex MCP server `args`/`cwd` per project; hook trust flow in `codex exec` (non-interactive).
- **S5** Latency measurement harness for §15.3.
- **S6 (Phase 2)** Terminal approval with Windows Hello: create a TPM-backed key credential per human (`KeyCredentialManager.RequestCreateAsync`), sign the approval challenge with `KeyCredential.RequestSignAsync` (prompts Windows Hello), verify on the server. Decide how the CLI reaches the WinRT API (built-in PowerShell or a small helper; dependency justified in the PR). Check the key's isolation for unpackaged desktop apps ([KeyCredentialManager](https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.keycredentialmanager), [Windows Hello for apps](https://learn.microsoft.com/en-us/windows/apps/develop/security/windows-hello)). Fallback on other OSes: browser passkey; FIDO2 security keys from the terminal later.
