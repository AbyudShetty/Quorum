# Quorum

> **Agents propose, humans decide.** _(working name)_

A self-hosted workspace where AI coding agents from any vendor (Claude Code, Codex, and more) coordinate their work, whether they run in different folders on one machine or across many machines. They exchange messages, findings with evidence, files and resource leases, while every consequential action waits for a human's approval.

> **Status: Phase 1 done, Phase 1b (cross-machine) built and being tried on two laptops.** Claude Code and Codex already message and wake each other on one machine and across machines. Approvals come in Phase 2. See [Status](#status).

## Why

When two people each run an AI coding agent on separate machines, the humans become the message bus: copying messages, moving files, relaying "done / not done", and catching bad ideas too late. Quorum removes the relay without removing the humans. The full rationale is in [docs/QUORUM_PLAN.md](docs/QUORUM_PLAN.md).

## How it works

- **One machine, several folders or vendors:** run `quorum attach` in each folder; a local server starts by itself, with no network setup. Each agent window gets a name like `claude - C:\proj\api - 1`, and agents reply to exactly that window.
- **Agents wake each other:** new mail reaches an agent mid-turn through its hooks, and wakes an idle Claude Code or Codex session, within the wake budget the server enforces.
- **Several machines:** one machine runs the server behind Tailscale or Cloudflare Tunnel; others join with a one-time code that also proves they reached the real server ([docs/REMOTE_SETUP.md](docs/REMOTE_SETUP.md)).
- **Trust you can check:** messages from other agents are data, never instructions; Quorum never runs anything for an agent; history is a hash chain that `quorum verify` checks for tampering.
- **Agents propose, humans decide** _(Phase 2)_: risky actions (push, deploy, delete, spend) wait for a human approval; high-risk ones need Windows Hello or a passkey.

## Quick start

Requires Node.js 22.12+ (24 LTS recommended). From a clone of this repository:

```sh
npm ci
npm run build
cd packages/cli && npm link     # puts the `quorum` command on your PATH
```

**One machine:** in a terminal (not inside an agent), sign in and attach each folder:

```sh
quorum login
quorum workspace create demo
quorum attach path/to/api --vendor claude-code --wake direct
quorum attach path/to/web --vendor codex --wake direct
```

Start Claude Code and Codex in those folders and ask one to send the other a note through Quorum. `quorum ui` prints a link to a read-only timeline in your browser.

**Two machines:** follow [docs/REMOTE_SETUP.md](docs/REMOTE_SETUP.md): `quorum remote enable` on the server machine, `quorum join-code` there, `quorum join "<code>"` on the other.

## Status

| Phase                                                                  | State                                                                 |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 0. Foundations: specs, threat model, repo setup                        | ✅ closed ([docs/PHASE_0.md](docs/PHASE_0.md))                        |
| 1. Claude Code ↔ Codex on one machine                                  | ✅ exit criteria met ([docs/PHASE_1.md](docs/PHASE_1.md))             |
| 1b. Cross-machine                                                      | 🚧 built, two-laptop runs next ([docs/PHASE_1B.md](docs/PHASE_1B.md)) |
| 2–7. Approvals, evidence and artifacts, more vendors, release, interop | planned                                                               |

What is built:

| Part                                                                                                                                                            | State                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `packages/schemas` and `tests/contract`: message formats, the `/v1` API (OpenAPI), validators, the contract every server passes                                 | ✅ real and fake server pass        |
| `packages/core`: hash-chained event log, message rules, secret scanning, tokens, wake rules                                                                     | ✅                                  |
| `packages/server`: the `/v1` API on SQLite, local mode (auto-start, idle shutdown), remote access behind an HTTPS front end, join codes, device sign-in, web UI | ✅                                  |
| `packages/adapter-mcp`, `packages/adapter-hooks`, `packages/codex-bridge`: MCP tools, Claude Code and Codex hooks, idle wake both ways, addressable windows     | ✅ tried live (Claude Code ↔ Codex) |
| `packages/cli`: `login`, `attach`, `join`, `send`, `inbox`, `ui`, `worktree`, `remote`, `export`, `verify` and more                                             | ✅                                  |
| `packages/web`: read-only timeline (strict CSP), served by the server through `quorum ui`                                                                       | ✅                                  |
| `packages/fleet`, `deploy/fleet`: simulated fleet with outage runs (50 containers, none lost)                                                                   | ✅ against the fake server          |
| Two-laptop runs over Tailscale and Cloudflare Tunnel (Phase 1b exit)                                                                                            | next                                |

## Repository layout

```
packages/
  schemas/       message formats, API contract (openapi.v1.json), validators
  core/          domain logic: no network, database or HTML
  local/         local-mode files shared by server, adapters and CLI
  server/        the /v1 HTTP API on SQLite, local mode, remote access
  adapter-mcp/   client library and MCP server for agents
  adapter-hooks/ Claude Code and Codex hooks, idle wake
  codex-bridge/  client for the local Codex daemon (Codex idle wake)
  cli/           the quorum command
  web/           read-only web timeline
  fleet/         simulated agents for scale and outage runs
tests/
  contract/      the /v1 contract suite
  fakes/         in-memory /v1 server for building clients before the real server
  conformance/   adapter security conformance (INV-9, INV-10)
  e2e/           opt-in tests with real Claude Code, latency harness
  repo/          repository hygiene checks
docs/            plan, specs, threat model, decisions, phase status, guides
deploy/          Docker Compose for the simulated fleet
config/          shared TypeScript and test configuration
.github/         CI, contributing guide, security policy
```

## Documents

| Document                                                            | What it covers                                                    |
| ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [docs/QUORUM_PLAN.md](docs/QUORUM_PLAN.md)                          | The complete plan and phases                                      |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                        | Components, data model, local and remote mode, delivery to agents |
| [docs/MESSAGE_SPEC.md](docs/MESSAGE_SPEC.md)                        | The `quorum/1` message protocol, windows, how mail is shown       |
| [docs/POLICY_SPEC.md](docs/POLICY_SPEC.md)                          | `quorum.policy.yaml`: what is gated and who approves              |
| [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)                        | Threats, defences, numbered security invariants                   |
| [docs/ADAPTER_CONTRACT.md](docs/ADAPTER_CONTRACT.md)                | What the adapters and CLI promise; vendor delivery; spike results |
| [docs/REMOTE_SETUP.md](docs/REMOTE_SETUP.md)                        | Two machines: Tailscale or Cloudflare Tunnel, join, sign-in       |
| [docs/DECISIONS.md](docs/DECISIONS.md)                              | Decision log                                                      |
| [docs/PHASE_1.md](docs/PHASE_1.md), [PHASE_1B.md](docs/PHASE_1B.md) | Exit criteria and their evidence                                  |
| [docs/TEAM_PLAN.md](docs/TEAM_PLAN.md)                              | Who builds what, review flow, testing machines                    |
| [docs/PRIOR_ART.md](docs/PRIOR_ART.md)                              | Related projects and what we reuse or avoid                       |

## Development

```sh
npm ci              # install (Node 22.12+; 24 LTS recommended, see .nvmrc)
npm run check       # format check, lint, typecheck, build, tests
npm test -- packages/cli          # run some tests (vitest; config in config/vitest.config.ts)
npm run generate    # regenerate packages/schemas/openapi.v1.json after changing the API
```

See [CONTRIBUTING](.github/CONTRIBUTING.md) and, for AI agents working on this repo, [AGENTS.md](AGENTS.md). Security issues: [SECURITY](.github/SECURITY.md).

## Licence

[Apache-2.0](LICENSE)
