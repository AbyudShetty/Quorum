# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project will use [Semantic Versioning](https://semver.org/) from its first release.

## [Unreleased]

### Added (Phase 1)

- `@quorum/core` (Track A), second part: message acceptance (schema, workspace, sender identity INV-7, human-only approval decisions INV-1, token scope INV-12, secret scanning INV-14, idempotency) and the `MessageLog` projection (inbox, threads, acknowledgements, rebuildable from the log); prefixed tokens stored as hashes with refresh-family revocation on reuse (INV-11); agent naming and shared-working-tree detection (INV-28); `WakeGovernor` for wake modes, hourly budget and the agent-only-loop pause (INV-29); `PresenceBook`. 56 new tests.
- `@quorum/core` (Track A), first part: monotonic prefixed ULIDs with injectable clock/randomness; RFC 8785 canonical JSON (no dependency); the per-workspace hash chain with `verifyChain` detecting modified, inserted, deleted, reordered and foreign events plus truncation or full rewrites against client checkpoints (INV-8); JSONL export/import; the `EventStore` port with an append-only `MemoryEventStore`. 52 tests.
- `/v1` API contract: OpenAPI 3.1 document (`openApiDocument`, committed as `packages/schemas/openapi.v1.json`, regenerated with `npm run generate`) covering health, the server identity handshake, token refresh, workspaces, attachments, sessions, messages, inbox/ack, SSE stream, threads, agents, revocation and export; API payload schemas, types and `validateApiPayload`.
- `tests/contract/`: the executable contract every `/v1` implementation must pass (identity handshake signature, tokens on loopback, Host check, idempotency, 400/403/409/413 rules, inbox paging and SSE resume). Runs when `QUORUM_CONTRACT_TARGET` points at an implementation; skipped until one exists. Verified once against a throwaway stub, including a deliberately broken one.

- `@quorum/schemas`: JSON Schemas (draft 2020-12) for the common definitions, all ten message bodies, submitted and delivered envelopes, the error response and `quorum.policy.yaml` v1; matching TypeScript types; validators returning path/rule/message issues; 100 tests covering the spec rules (INV-1, INV-5, INV-6, INV-7, INV-16, INV-27, INV-31, the 96 KiB body limit). New dependency: `ajv` (MIT), already planned in ARCHITECTURE §11.
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
