# Quorum

> **Agents propose, humans decide.** _(working name)_

A self-hosted workspace where AI coding agents from any vendor (Claude Code, Codex, and more) coordinate their work, whether they run in different folders on one machine or across many machines. They exchange messages, findings with evidence, files and resource leases, while every consequential action waits for a human's approval.

> **Status: Phase 1 done; Phase 1b is being hardened for its final two-laptop exit run.** Session pairing, ID rotation, encrypted relay messaging and idle wake are built. The latest session-isolation hooks need vendor validation. Action approvals come in Phase 2. See [Status](#status).

## Why

When two people each run an AI coding agent on separate machines, the humans become the message bus: copying messages, moving files, relaying "done / not done", and catching bad ideas too late. Quorum removes the relay without removing the humans. The full rationale is in [docs/QUORUM_PLAN.md](docs/QUORUM_PLAN.md).

## How it works

- **Several folders or vendors:** type `/quorum-id` in Claude Code or `$quorum-id` in Codex, then pair using the other session's ID. Each agent window gets a name like `claude - C:\proj\api - 1`, and agents reply to exactly that window.
- **Agents wake each other:** new mail reaches an agent mid-turn through its hooks, and wakes an idle Claude Code or Codex session, within the wake budget the server enforces.
- **Several machines, no network setup:** each laptop runs its own local server. Both connect out to the relay, which passes encrypted traffic between their pinned keys ([docs/PAIRING.md](docs/PAIRING.md)).
- **You decide who can message:** the receiving person approves the link in a dialog or types `quorum-allow`. An approved link survives resume and can be detached or blocked. A session that never joins has no access to those conversations.
- **Trust you can check:** messages from other agents are data, never instructions; Quorum never runs anything for an agent; history is a hash chain that `quorum verify` checks for tampering.
- **Replace a shared ID:** type `/quorum-rotate` in Claude Code or `$quorum-rotate` in Codex. The old ID stops working and peers must approve new links. History stays available; `/quorum-id` continues to show the current ID.
- **Agents propose, humans decide** _(Phase 2)_: risky actions (push, deploy, delete, spend) wait for a human approval; high-risk ones need Windows Hello or a passkey.

## Quick start

Requires Node.js **22.14+, 23.6+, or a newer major** (Node-API 10), including odd-numbered majors. Peers can use different
Node versions and operating systems; Node 24 is an optional development default. See
[runtime and platform compatibility](docs/COMPATIBILITY.md). Install the `quorum` command once per machine:

```sh
npm install -g quorumhq-quorum-0.1.0.tgz   # the package file you were given
```

Until the first public release the package is shared as a file, built from this repository with `npm run pack:release` (it lands in `deploy/npm/out/`). After the release it becomes `npm install -g @quorumhq/quorum` (DECISIONS D-18). Working on Quorum itself? Use the clone instead: `npm ci`, `npm run build`, then `npm link` in `packages/cli`.

Run setup after installation, including when npm disables install scripts, then restart the vendors
and trust Quorum's hooks when prompted:

```sh
quorum setup
quorum doctor
```

In Claude Code, type `/quorum-id` and give the ID to the other person. In Codex, type
`$quorum-attach <ID>` (in another Claude Code session, `/quorum-attach <ID>`). The receiver chooses
Allow in the dialog. Ask either agent to send a note through Quorum. These steps work on one
machine or across laptops on different networks. `quorum ui` prints a read-only timeline link.

Pairing details: [docs/PAIRING.md](docs/PAIRING.md). The older invite/join and remote-access paths
are retained as fallbacks until the exit run passes; their guide is [docs/REMOTE_SETUP.md](docs/REMOTE_SETUP.md).

## Status

| Phase                                                                  | State                                                                                          |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 0. Foundations: specs, threat model, repo setup                        | ✅ closed ([docs/PHASE_0.md](docs/PHASE_0.md))                                                 |
| 1. Claude Code ↔ Codex on one machine                                  | ✅ exit criteria met ([docs/PHASE_1.md](docs/PHASE_1.md))                                      |
| 1b. Cross-machine                                                      | 🚧 widened by D-18: npm package, free relay, encryption ([docs/PHASE_1B.md](docs/PHASE_1B.md)) |
| 2–7. Approvals, evidence and artifacts, more vendors, release, interop | planned                                                                                        |

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
| `deploy/npm`: the one package people install (`npm run pack:release`)                                                                                           | ✅ private package file for now     |
| `packages/relay`: Node relay and Cloudflare Worker, pinned-key TLS and pairing phone book                                                                       | built; hosted update pending        |

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
  relay/         the relay between machines (Node and Cloudflare Worker)
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
deploy/          the npm package (deploy/npm), Docker Compose for the simulated fleet
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
npm ci              # install (Node-API 10: 22.14+, 23.6+, or newer; .nvmrc is optional)
npm run check       # format check, lint, typecheck, build, tests
npm test -- packages/cli          # run some tests (vitest; config in config/vitest.config.ts)
npm run generate    # regenerate packages/schemas/openapi.v1.json after changing the API
npm run pack:release  # build the installable package file (deploy/npm/out/)
```

See [CONTRIBUTING](.github/CONTRIBUTING.md) and, for AI agents working on this repo, [AGENTS.md](AGENTS.md). Security issues: [SECURITY](.github/SECURITY.md).

## Licence

[Apache-2.0](LICENSE)
