# Policy specification — `quorum.policy.yaml` v1

Status: **draft for Phase 0 review** · Source: plan §4.1, §7 item 4, §8 · Last updated: 2026-10-01

A policy answers three questions for any action: **Is it gated? Who may approve? How many approvals, for how long?** It is a small YAML file per workspace, readable by humans in a minute.

## 1. Principles

1. **Deny by default.** Any action not explicitly classified is gated (INV-5).
2. **Safe means safe.** Only `read`, `analyse`, `draft` and `message` style actions are safe; they are built in and cannot be redefined.
3. **Loosening is explicit and gated.** Every change that makes the policy more permissive is a `policy.change` approval request and is logged with its diff (INV-6). Tightening takes effect immediately but is still logged.
4. **Fail closed.** An invalid policy prevents server start (or is rejected on reload, keeping the previous valid policy) with an error naming the line and the fix. There is no permissive fallback.
5. **Never auto-approve.** Expiry yields `expired` (INV-4).

## 2. File format

```yaml
version: 1

defaults:
  approval_expiry: 24h # how long a pending request waits before it expires
  grant_ttl: 15m # how long an issued grant can be used once approved
  quorum: 1 # approvals needed
  independent_approver: false # true → approver must not own the requesting agent; always true at high/critical
  veto: true # any eligible reject → rejected
  user_verification_from: high # passkey needed at/above this risk; may be lowered to medium/low, never raised above high (INV-31)

humans:
  abyud: { roles: [owner] }
  abhijna: { roles: [owner] }

agents: # default scopes; tokens can be narrower, never wider
  default_scope:
    message_types:
      [
        note,
        request,
        task_update,
        finding,
        retraction,
        artifact_ready,
        lease,
        approval_request,
        heartbeat,
      ]
    artifacts: read-write
  overrides:
    claude-api@laptop-a: { artifacts: read-write }
    codex-web@laptop-b: { artifacts: read-only }

actions:
  git.push: { approvers: [role:owner, role:maintainer] }
  git.push.protected_branch: { quorum: 2, risk: high, independent_approver: true }
  git.force_push: { quorum: 2, risk: critical, independent_approver: true }
  deploy.*: { risk: high, independent_approver: true }
  submit: { quorum: 2, risk: high, approval_expiry: 2h }
  spend.*: { risk: high, approvers: [role:owner] }
  delete.*: { risk: medium }
  artifact.delete: { risk: medium }
  artifact.promote: { risk: medium } # mark a version as "the one to use"
  compute.exceed_lease: { risk: medium }
  lease.break: { risk: medium } # forcibly end another agent's lease
  policy.change: { approvers: [role:owner], risk: high }
  workspace.attach: { risk: medium } # bind a folder/agent to a workspace (INV-30)
  artifact.copy_local: { risk: low } # upload a local_ref artifact's bytes into the store
  artifact.share_sensitive: { risk: high } # share a file on the sensitive-file denylist (INV-27)
  agent.identity_change: { risk: low } # new/retired identity for an existing attachment

  # Explicitly un-gating something requires a reason; the reason is shown in the UI.
  # test.run_local:  { gated: false, ungated_reason: "Local test runs are cheap and reversible." }

limits:
  messages_per_minute: 60 # per agent
  approval_requests_per_hour: 20
  max_lease_ttl: 12h
  workspace_disk: 50GiB
  max_upload: 10GiB
  wakes_per_hour: 20 # per agent, across all wake mechanisms (INV-29)
  agent_only_messages_before_pause: 12 # per thread; wakes pause until a human posts
```

Durations use `<int><s|m|h|d>`; sizes use `KiB|MiB|GiB`. The file is validated against a JSON Schema (`packages/schemas/policy.v1.json`, Phase 2).

## 3. Action names and matching

- Action names are dotted lowercase segments: `git.push`, `deploy.prod`, `spend.cloud_gpu`.
- A rule key matches either exactly or as a prefix wildcard (`deploy.*` matches `deploy.prod` and `deploy.staging.eu`).
- **Most specific wins** (exact > longer prefix > shorter prefix). On ties, the **stricter** rule wins (higher quorum, independent approver, shorter expiry, higher risk).
- Unmatched names → gated with `defaults` (INV-5).
- Rule fields not set inherit from `defaults`.
- Built-in safe actions (`read.*`, `analyse.*`, `draft.*`, `message.*`) are never gated and cannot appear in `actions:`.

## 4. Evaluation (pure function)

```
evaluate(action, requester, policy) -> {
  gated: boolean,
  risk: low|medium|high|critical,
  eligible_approvers: set<human>,   // humans with a listed role (default: all members)
  quorum: int,                      // set per action, any value 1..|eligible approvers|; larger values make the policy invalid
  independent_approver: boolean,
  veto: boolean,
  approval_expiry, grant_ttl: duration
}
```

The policy engine is a pure, deterministic function with no I/O, so it is exhaustively unit-tested and identical on server and CLI (`quorum policy explain git.push` prints the result and _which rule_ produced it).

Decision rules:

1. The requester (agent) and its owner's identity are attached to the request.
2. An eligible approver is a human with an allowed role; never an agent (INV-1); never the requester (INV-2); if `independent_approver` — which is **always on for `high`/`critical`** — never the requesting agent's owner (in a two-person team, the other person approves high-risk actions of your agents). At or above `user_verification_from` (and always for `high`/`critical`), the decision must carry a hardware-backed user-verification signature bound to the request — Windows Hello from `quorum approve` in the terminal, or a passkey in the browser (INV-31).
3. Each human counts once. A decision is bound to the `preview_hash` (INV-3).
4. When `approvals ≥ quorum` → `approved` and a single-use grant is issued (expires after `grant_ttl`).
5. If `veto` and any eligible human rejects → `rejected`.
6. On `approval_expiry` → `expired`. Never approved (INV-4).
7. If the request is modified, all collected decisions are discarded (new `preview_hash`).

## 5. Policy changes

- The active policy is stored in the event log (`policy.activated` events with the full text and SHA-256), so any past decision can be explained by the policy that was active at the time.
- `quorum policy diff` shows the proposed change. The server classifies it as **tightening** or **loosening** (any of: un-gating, lowering quorum, removing `independent_approver`, removing `veto`, lengthening expiry/TTL, widening scopes or limits, raising `wakes_per_hour` or `agent_only_messages_before_pause`, raising `user_verification_from`, adding approvers). Loosening requires approval via `policy.change`.
- Editing the YAML file on disk while the server is running is treated as a _proposed_ change, not an applied one.

## 6. Local mode and per-attachment settings

- Local mode (T1/T2) uses **exactly the same policy and defaults** as remote mode; being on one machine never loosens anything. The policy lives in the server's private data directory and is changed through `quorum policy` like any other.
- Some behaviour is chosen **per attachment by its human** rather than by workspace policy, because it only affects their own agent (ARCHITECTURE §13, §15.2):
  - `wake: off | direct | all` (+ optional `wake_types`) — how eagerly new messages wake or continue the agent. Default `off` when `attach` runs non-interactively.
  - `lease_enforcement: warn | block` — what the agent's edit hook does on a path leased by another agent. Default `warn`.
- These settings can never exceed the workspace `limits` (wake budget, agent-only-loop pause), which stay under policy control.

## 7. Templates (Phase 7)

Policy templates (ML competition, web app, data pipeline) are deferred to Phase 7 per the plan. The default policy shipped in Phase 2 is the example above, minus the named humans.

## 8. Open questions for Phase 0 review

Answers recorded 2026-10-01 by abyud (D-14); abhijna confirms or challenges them in the E2 review.

1. **Rejection behaviour — still open** (THREAT_MODEL §8 Q3, D-14): what happens after a rejection (reason required, reconsideration, preserving the work) is being designed; final calls stay with humans.
2. ~~Quorum size~~ — **decided:** depends on the action; `quorum` is set per action and may be any value up to the number of eligible approvers.
3. ~~CLI approvals~~ — **decided:** yes, `quorum approve` in the terminal for every risk level; for `high`/`critical` it triggers **Windows Hello** directly from the terminal (no browser). Other OSes use a browser passkey until a terminal option is verified (spike S6, ARCHITECTURE §15.4).
4. ~~Wake limits~~ — **accepted:** start with `wakes_per_hour: 20`, `agent_only_messages_before_pause: 12`; calibrate during Phase 1 dogfooding.
