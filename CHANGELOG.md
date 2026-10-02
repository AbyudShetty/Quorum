# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project will use [Semantic Versioning](https://semver.org/) from its first release.

## [Unreleased]

### Added (Phase 1)

- Workspace scaffolding: first package `@quorum/schemas` (exports `SPEC_VERSION`), a standard package layout enforced by `tests/repo/packages.test.ts`, `npm run build` (TypeScript project references) in `check` and CI, and a `quorum-source` export condition so typecheck and tests use workspace sources without building. See CONTRIBUTING "Adding a package".

### Fixed

- Dependabot no longer proposes major upgrades of `@types/node` and `typescript`, which broke CI (types must match the oldest supported Node LTS; typescript-eslint does not support TypeScript 7 yet).

### Changed

- Phase 0 closed by joint decision (D-16): spec reviews and interviews waived; real interviews moved to Phase 5; five simulated interviews added (labelled as not counting).
- Rejection flow decided: a rejection opens a discussion (agent justifies, humans share thoughts, a human ends it); new `approval_required_from` lets users require approval for every gated action or only from a chosen risk up, never skipping `critical` (INV-32).
- Repository process recorded (D-15): `main` unprotected for now; no AI agent runs git — agents give the humans the commands to run (AGENTS.md).
- Plan and specs now cover three topologies: same machine/different folders (T1), same machine/mixed vendors incl. a shared folder (T2), and different machines (T3). Adds zero-network **local mode** (loopback, auto-start, tokens, server identity pinning), attachments/sessions and flexible agent identity, shared-working-tree detection and a worktree helper, `local_ref` artifacts, per-vendor delivery and wake modes for Claude Code and Codex (verified against official docs), local-mode latency targets, and invariants INV-23–INV-31.
- Phases re-sequenced (D-8, accepted provisionally): Phase 1 is Claude Code ↔ Codex on one machine; cross-machine moves to Phase 1b; Codex moves from Phase 4 to Phase 1.
- Decisions are made jointly by both maintainers; D-8–D-13 recorded; D-5 marked for revisit (Cloudflare Tunnel proposed).
- Spec open questions answered (D-14): message body limit 96 KiB; approvals needed set per action; independent approver always required for high/critical; sensitive files shareable only via the gated `artifact.share_sensitive`; high-risk approvals from the terminal with Windows Hello (browser passkey as fallback). The rejection flow stays open.

### Added

- `docs/TEAM_PLAN.md`: two-track split (abyud: core & security; abhijna: adapters, UI & scale testing), contract-first workflow, per-phase deliverables and integration checkpoints, review and RFC rules, testing across machines, dogfooding.

- Phase 0 foundations: architecture, message (`quorum/1`), policy and threat-model specifications; prior-art review; decision log; user-interview kit.
- Repository skeleton: Apache-2.0 licence, npm workspaces, TypeScript, ESLint, Prettier, Vitest, repository hygiene tests.
- CI: format/lint/typecheck/test on Node 22 and 24 (Linux and Windows), `npm audit`, dependency review, CodeQL, Dependabot.
- Project docs: `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `AGENTS.md`/`CLAUDE.md`.
