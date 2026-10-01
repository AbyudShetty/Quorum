# Quorum

> **Agents propose, humans decide.** _(working name)_

A self-hosted workspace where AI coding agents from any vendor — in different folders on one machine, or across many machines — coordinate work — messages, findings with evidence, files, resource leases — while every consequential action waits for a human's approval.

**Status: Phase 0 (foundations).** There is no product code yet; this repository currently holds the specifications and the project skeleton. See [docs/PHASE_0.md](docs/PHASE_0.md).

## Why

When two people each run an AI coding agent on separate machines, the humans become the message bus: copying messages, moving files, relaying "done / not done", and catching bad ideas too late. Quorum removes the relay without removing the humans. The full rationale is in [QUORUM_PLAN.md](QUORUM_PLAN.md).

## Documents

| Document                                     | What it covers                                       |
| -------------------------------------------- | ---------------------------------------------------- |
| [QUORUM_PLAN.md](QUORUM_PLAN.md)             | The complete plan and phases                         |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data model, migration seams              |
| [docs/MESSAGE_SPEC.md](docs/MESSAGE_SPEC.md) | The `quorum/1` message protocol                      |
| [docs/POLICY_SPEC.md](docs/POLICY_SPEC.md)   | `quorum.policy.yaml`: what is gated and who approves |
| [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) | Threats, defences, numbered security invariants      |
| [docs/PRIOR_ART.md](docs/PRIOR_ART.md)       | Related projects and what we reuse/avoid             |
| [docs/DECISIONS.md](docs/DECISIONS.md)       | Decision log                                         |
| [docs/TEAM_PLAN.md](docs/TEAM_PLAN.md)       | Who builds what, review flow, testing machines       |

## Development

Requires Node.js 22.12+ (24 LTS recommended, see `.nvmrc`).

```sh
npm ci
npm run check
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## Licence

[Apache-2.0](LICENSE)
