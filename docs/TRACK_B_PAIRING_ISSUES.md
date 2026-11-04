# Pairing review: issues for Track B

**Implementation update, 2026-11-04:** the two findings below have code fixes and automated
regressions. Pairing MCP calls now require a per-invocation proof from the exact vendor session's
PreToolUse hook, with no last-active/PID fallback. Pairing-state mutations and joins use cross-process
locks. See [adapter hardening](PHASE_1B_ADAPTER_HARDENING.md) for the implementation and remaining
vendor-runtime validation. The original issue descriptions are retained below as review history.

Drafts for Abyud to discuss with Abhijna, 2026-11-04. These are review findings, not authorization to
edit Track B or change the shared contract. They must be resolved or explicitly assessed before
claiming the Phase 1b exit criteria.

## Codex tools can resolve another session's identity

**Affected:** `packages/cli/src/cli.ts`, `pairingMcp`, its `candidates` and `resolve` functions.

The Codex resolver selects the first candidate from saved Codex sessions without proving that the
tool call belongs to that vendor session. Candidates can span folders. A window which never joined
Quorum may therefore obtain a different joined session's tools and visibility. The documented
same-folder, last-window limitation does not cover cross-folder selection.

**Expected:** an unjoined session is unreachable and cannot act as another session (Y2, INV-7,
INV-12, INV-34). Investigate the vendor's per-call thread identity. At minimum bind candidates to
the configured folder; fail closed when the exact session cannot be established. Folder filtering
alone does not prove isolation between two sessions in one folder.

**Validation:** separate folders and two windows in the same folder; only one window joins. The
other must receive no linked-session identity, history, or ability to send. Repeat after resume
and while both windows are active. Any shared-contract change follows TEAM_PLAN §5.3.

## Concurrent hooks can overwrite pairing notification state

**Affected:** `packages/adapter-hooks/src/pairing.ts`, `updateSession`, `takeRequestWake`, and other
whole-file readers/writers of `hooks/pairing.json`.

Reading, changing, and writing in one async function does not serialize separate hook processes.
Two hooks may read the same file, then each overwrite changes made by the other. The new `asking`
and notification marks can be lost, and competing request wakes can exceed the intended cap.

**Expected:** all modifications share a cross-process lock, or an equivalent atomic storage
mechanism. Preserve each session's changes, release locks on failures, handle stale owners, and
keep the private data directory protections (INV-25, INV-29).

**Validation:** force two hook processes to read before either writes, change separate sessions
and then the same session, and assert that pending notifications and rate-limit records survive.
Use scratch profiles and Quorum homes; do not install hooks into a maintainer's active environment.
