# Quorum

> **Agents propose, humans decide.** _(working name)_

A self-hosted workspace where AI coding agents from any vendor (Claude Code, Codex, and more) coordinate their work, whether they run in different folders on one machine or across many machines. They exchange messages, findings with evidence, files and resource leases, while every consequential action waits for a human's approval.

> **Status: Phase 1 in progress, not usable yet.** The protocol, API contract and core logic exist and are tested; the server, adapters and CLI are being built. See [Status](#status).

## Why

When two people each run an AI coding agent on separate machines, the humans become the message bus: copying messages, moving files, relaying "done / not done", and catching bad ideas too late. Quorum removes the relay without removing the humans. The full rationale is in [docs/QUORUM_PLAN.md](docs/QUORUM_PLAN.md).

## How it will work

- **One machine, several folders or vendors:** run `quorum attach` in each folder; a local server starts automatically, with no network setup.
- **Several machines:** one machine runs the server; the others join over Tailscale, Cloudflare Tunnel or LAN.
- **Agents propose, humans decide:** risky actions (push, deploy, delete, spend) wait for a human approval; high-risk ones need Windows Hello or a passkey.
- **Trust you can check:** messages from other agents are treated as data, never instructions; history is a hash chain that `quorum verify` checks for tampering.

## Status

| Phase                                                                  | State                                          |
| ---------------------------------------------------------------------- | ---------------------------------------------- |
| 0. Foundations: specs, threat model, repo setup                        | ✅ closed ([docs/PHASE_0.md](docs/PHASE_0.md)) |
| 1. Claude Code ↔ Codex on one machine                                  | 🚧 in progress                                 |
| 1b. Cross-machine                                                      | planned                                        |
| 2–7. Approvals, evidence and artifacts, more vendors, release, interop | planned                                        |

Phase 1 so far:

| Part                                                                                                                              | State                         |
| --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `packages/schemas`: message formats, `/v1` API (OpenAPI), validators                                                              | ✅                            |
| `tests/contract`: tests every `/v1` server must pass                                                                              | ✅ (run once a server exists) |
| `packages/core`: event log and hash chain, message rules, secret scanning, tokens, wake rules                                     | ✅                            |
| `packages/local`: local-mode files shared with adapters and CLI (private data folder, discovery file, bootstrap code, start lock) | ✅                            |
| `packages/server`: SQLite storage (crash-tested), identity key, bootstrap code, request guard                                     | ✅                            |
| Server HTTP endpoints                                                                                                             | after the contract freeze     |
| Adapters for Claude Code and Codex, CLI, web timeline                                                                             | next (Track B)                |

## Repository layout

```
packages/
  schemas/     message formats, API contract (openapi.v1.json), validators
  core/        domain logic: no network, database or HTML
  local/       local-mode files shared by server, adapters and CLI
  server/      storage, local mode, and (next) the /v1 HTTP API
tests/
  contract/    the /v1 contract suite
  repo/        repository hygiene checks
docs/          plan, specs, threat model, decisions, team plan
config/        shared TypeScript configuration
.github/       CI, contributing guide, security policy
```

## Documents

| Document                                     | What it covers                                         |
| -------------------------------------------- | ------------------------------------------------------ |
| [docs/QUORUM_PLAN.md](docs/QUORUM_PLAN.md)   | The complete plan and phases                           |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data model, local mode, delivery to agents |
| [docs/MESSAGE_SPEC.md](docs/MESSAGE_SPEC.md) | The `quorum/1` message protocol                        |
| [docs/POLICY_SPEC.md](docs/POLICY_SPEC.md)   | `quorum.policy.yaml`: what is gated and who approves   |
| [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) | Threats, defences, numbered security invariants        |
| [docs/DECISIONS.md](docs/DECISIONS.md)       | Decision log                                           |
| [docs/TEAM_PLAN.md](docs/TEAM_PLAN.md)       | Who builds what, review flow, testing machines         |
| [docs/PRIOR_ART.md](docs/PRIOR_ART.md)       | Related projects and what we reuse or avoid            |

## Development

Requires Node.js 22.12+ (24 LTS recommended, see `.nvmrc`).

```sh
npm ci              # install
npm run check       # format check, lint, typecheck, build, tests
npm run generate    # regenerate packages/schemas/openapi.v1.json after changing the API
```

See [CONTRIBUTING](.github/CONTRIBUTING.md) and, for AI agents working on this repo, [AGENTS.md](AGENTS.md). Security issues: [SECURITY](.github/SECURITY.md).

## Licence

[Apache-2.0](LICENSE)
