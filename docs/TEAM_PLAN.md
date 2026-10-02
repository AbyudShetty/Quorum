# Team plan — two people, two tracks

Status: **draft for Phase 0 review** · Last updated: 2026-10-01

How abyud and abhijna split Quorum so that neither blocks the other. There are **no dates, weekly plans or time limits**: phases end on exit criteria (plan §13), and each person works when they can. Decisions in plan §17, anything marked open in [DECISIONS.md](DECISIONS.md) and any plan change are made **jointly**.

## 1. People and machines

|           | abyud                                                                                                | abhijna                                                        |
| --------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| GitHub    | `@AbyudShetty` (repo owner: `AbyudShetty/Quorum`)                                                    | `@thorOdinson16` (collaborator invite pending)                 |
| Machine   | M1 laptop: Intel Core i7-13650H, 16 GB RAM, RTX 4050 (6 GB)                                          | M2 laptop: Intel Core Ultra 9 285H, 32 GB RAM, RTX 5070 (8 GB) |
| OS        | Windows 11                                                                                           | Windows 11                                                     |
| Always on | yes                                                                                                  | yes                                                            |
| Agents    | Primarily Claude Code                                                                                | Primarily Claude Code                                          |
| Location  | remote from each other (~10 km) — cross-machine work always goes over Tailscale or Cloudflare Tunnel |                                                                |

Extra "machines" without new hardware: a WSL2 Ubuntu instance on each laptop (Linux coverage), Docker containers (simulated fleet), and GitHub Actions runners (Linux/Windows in CI; macOS can be added since public repos get it free).

## 2. Track allocation (by what each machine runs best)

| Track                              | Owner            | Why this machine                                                                                                                                                                                                                          |
| ---------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — core & security**            | **abyud (M1)**   | Core, server, storage and security work is CPU-light; its unit, integration, adversarial and small chaos suites (≤ 10 fake agents) fit comfortably in 16 GB.                                                                              |
| **B — agents, UI & scale testing** | **abhijna (M2)** | Needs the most RAM: Claude Code + Codex + the server + a docker-compose fleet (up to 50 fake agents) at once, Playwright browsers at phone and desktop sizes, and the benchmark's training step, which benefits from the larger RTX 5070. |

### Ownership by package and folder

| Path                                                                                                                                                                                                                               | Owner                                 | Notes                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------- |
| `packages/core/`, `packages/server/`                                                                                                                                                                                               | A                                     | includes local/remote mode, auth, storage, policy engine            |
| `tests/adversarial/`, `tests/chaos/`, `tests/integration/` (server side)                                                                                                                                                           | A                                     | organised by invariant ID                                           |
| `tests/fakes/fake-adapter/`                                                                                                                                                                                                        | A                                     | scripted client A uses to test the server before B's adapter exists |
| `packages/adapter-mcp/`, `packages/adapter-hooks/`, `packages/cli/`, `packages/web/`                                                                                                                                               | B                                     | Claude Code + Codex adapters, wake mechanisms, CLI, HTMX templates  |
| `tests/conformance/`, `tests/e2e/`, `deploy/` (fleet), `bench/`                                                                                                                                                                    | B                                     |                                                                     |
| `tests/fakes/fake-server/`                                                                                                                                                                                                         | B                                     | in-memory `/v1` server B uses before A's server exists              |
| **Shared contract:** `packages/schemas/` (JSON Schemas + OpenAPI), `docs/ADAPTER_CONTRACT.md`, `tests/contract/`, `docs/MESSAGE_SPEC.md`, `docs/POLICY_SPEC.md`, `docs/THREAT_MODEL.md`, `QUORUM_PLAN.md`, `AGENTS.md`, `.github/` | **both**                              | changes follow §5.3                                                 |
| Other docs (`docs/ARCHITECTURE.md`, guides, README)                                                                                                                                                                                | author's track; reviewed by the other |                                                                     |

HTML route wiring lives in `server` (A) but contains no logic; templates live in `web` (B).

## 3. Contract first, then parallel

1. **Freeze the contract (start of Phase 1, both).**
   - A drafts `packages/schemas`: envelope and message-type JSON Schemas from MESSAGE_SPEC, error shape, and `openapi.v1.yaml` for `/v1` (including `/v1/hello`, sessions, attachments).
   - B drafts `docs/ADAPTER_CONTRACT.md`: the `quorum_*` tools, framing, delivery and wake behaviour per vendor, the client side of discovery and the identity handshake, credential storage, and what `attach` writes. B also runs spikes S1–S5 (ARCHITECTURE §15.4) and records the results there.
   - Both write `tests/contract/`: one suite that any `/v1` implementation must pass.
   - Each reviews the other's part. Merge, then tag **`contract-v1`**.
2. **Build in parallel against fakes.**
   - A builds the real server and tests it with `fake-adapter`.
   - B builds the adapters, CLI and UI against `fake-server`.
   - Both the real server and `fake-server` must pass `tests/contract/`, which keeps the fake honest.
3. **Meet at integration checkpoints (IC):** swap the fake for the real thing, fix gaps, and re-freeze the contract if it changed (§5.3).

## 4. Phase by phase

"Both" items need both people at once (pairing, a joint decision or a cross-machine run).

### Phase 0 — Foundations (now)

| abyud                                                            | abhijna                                                                                                                                           | Both                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Review all specs (E1); first push to `main` + confirm CI (E3) ✅ | Accept the collaborator invite; review all specs as the second reviewer (E2) and record it in `PHASE_0.md`; confirm or challenge the D-14 answers | ~3 interviews each (E4); settle the open rejection flow (D-14); D-5 is decided in Phase 1b by testing both |

**Shared exit:** plan §13 Phase 0 exit (specs reviewed by both, CI green, ≥ 5 interviews saved).

### Phase 1 — Claude Code ↔ Codex, one machine (local mode)

| Track A (abyud)                                                                                                                        | Track B (abhijna)                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`: IDs, event log + hash chain, projections, export/verify, shared-worktree detection, wake budget + loop breaker                 | `adapter-mcp`: `quorum_send/inbox/status`, framing, outbox, identity handshake client, keychain credentials                                  |
| `server`: messages, threads, inbox/ack, SSE, sessions, attachments, agents, tokens (issue/refresh/revoke)                              | `adapter-hooks`: Claude Code + Codex (SessionStart, UserPromptSubmit, PostToolUse, Stop), wake modes, channels/asyncRewake per spike results |
| Local mode: discovery file, instance key + `/v1/hello`, lock-safe start, idle shutdown, Host/Origin checks, data-dir permission checks | CLI: `serve --local`, `attach`, `detach`, `status`, `stop`, `worktree`, `send`, `inbox`, `export`, `verify`, `ui`                            |
| Tests: unit, integration, adversarial INV-7, 8, 11–15, 20, 22–26, 28–30; chaos (kill server, offline)                                  | Read-only HTMX timeline; conformance INV-9/10; fleet harness skeleton (docker-compose, N fake agents)                                        |

| Checkpoint                 | What happens                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **IC1** contract frozen    | `contract-v1` tag; parallel work starts                                                                                                            |
| **IC2** first real message | B's adapter talks to A's server on one machine (pair session)                                                                                      |
| **IC3** exit run           | Each of you runs Claude Code ↔ Codex through local Quorum on your own machine (M1 Windows, M2), including a shared-worktree case and a server kill |

**Needs both:** contract freeze; IC2 debugging; local-mode security review (A leads, B reviews); the exit run.
**Shared exit:** plan §13 Phase 1.

### Phase 1b — Cross-machine

| Track A (abyud)                                                                                                                              | Track B (abhijna)                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Remote mode: TLS config, bind rules (INV-22), join codes with key fingerprint (INV-24), human device-code login, public-hostname Host checks | `join` CLI; adapter remote config; Tailscale guide; Cloudflare Tunnel guide; cross-machine test scripts |

**IC4:** M1 hosts the server, and M2's agents join over Tailscale. Then switch: M2 hosts and M1 joins over Cloudflare Tunnel. Record setup time and friction for the D-5 decision.
**Needs both:** every cross-machine run (one person per machine).
**Shared exit:** plan §13 Phase 1b; D-5 decided jointly.

### Phase 2 — Governance

| Track A (abyud)                                                                                                                                                                                                                                                           | Track B (abhijna)                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Policy engine (pure) + loader/validation; approval state machine incl. rejection flow (D-14); grants + `quorum grant verify` library; server-side verification of Windows Hello signatures and passkeys (`@simplewebauthn/server`); adversarial INV-1–6, 31; replay tests | Approval queue UI (mobile-first); Playwright desktop + phone; `quorum_request_approval` tool; `quorum approve` with Windows Hello in the terminal (spike S6); git pre-push grant verifier; optional ntfy/browser notifications |

**IC5:** a gated high-risk `git.push` from abyud's agent on M1 is approved by abhijna (independent approver) with Windows Hello in the terminal on M2 and verified by the pre-push hook; then the reverse, and once more from a phone with a passkey.
**Shared exit:** plan §13 Phase 2.

### Phase 3 — Evidence, artifacts, leases, signing

| Track A (abyud)                                                                                                                                                                                                                     | Track B (abhijna)                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Findings + retraction propagation; artifact store (`stored`/`local_ref` metadata/`local_only`, quotas, resumable server side); lease engine (gpu/ram/path/worktree/dataset/slot); signature verification; adversarial INV-16–19, 27 | Upload/download client (resumable); `local_ref` hashing + verification; lease tools + PreToolUse lease warnings + pre-commit guard; signing keys in adapters; benchmark scenarios (two-folder and two-machine sprint); GPU lease tests on both GPUs |

**IC6:** the benchmark runs end-to-end, first on one machine (M2), then across M1 and M2.
**Shared exit:** plan §13 Phase 3.

### Phase 4 — More vendors

| Track A (abyud)                                                                                | Track B (abhijna)                                                                       |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Security cases in the conformance suite; server compatibility; security review of each adapter | Gemini CLI, OpenCode, IDE agents, generic CLI bridge; per-vendor docs; conformance runs |

The exit needs "3+ machines". With two laptops, the third is a WSL2 instance or VM with its own Quorum identity and network path. Use a borrowed physical machine if you want the stronger test.

### Phase 5 — Hardening and release

| Track A (abyud)                                                                         | Track B (abhijna)                                                                               |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Full adversarial + chaos suites; backup/restore; upgrade migrations; server performance | 50-agent fleet performance run (M2); docs site + quickstart; demo video; npm + Docker packaging |

**Both:** watch 3 strangers follow the quickstart; joint security sign-off and release decision.

### Phases 6–7

- Phase 6: A builds the A2A gateway, B builds the GitHub and ntfy integrations, and both onboard users.
- Phase 7: only on user demand; split by package as above.

## 5. Collaboration rules

### 5.1 CODEOWNERS (add once abhijna accepts the collaborator invite)

```
# .github/CODEOWNERS — auto-requests reviews; the approval rule is in branch protection
*                              @AbyudShetty @thorOdinson16
/packages/core/                @AbyudShetty
/packages/server/              @AbyudShetty
/tests/adversarial/            @AbyudShetty
/tests/chaos/                  @AbyudShetty
/packages/adapter-mcp/         @thorOdinson16
/packages/adapter-hooks/       @thorOdinson16
/packages/cli/                 @thorOdinson16
/packages/web/                 @thorOdinson16
/tests/conformance/            @thorOdinson16
/tests/e2e/                    @thorOdinson16
/bench/                        @thorOdinson16
/deploy/                       @thorOdinson16
/packages/schemas/             @AbyudShetty @thorOdinson16
/tests/contract/               @AbyudShetty @thorOdinson16
/docs/                         @AbyudShetty @thorOdinson16
/QUORUM_PLAN.md                @AbyudShetty @thorOdinson16
/AGENTS.md                     @AbyudShetty @thorOdinson16
/.github/                      @AbyudShetty @thorOdinson16
```

### 5.2 Branches and PRs

- **Current setup (D-15, 2026-10-02):** `main` is **not protected**. Both of you may push straight to `main`; PRs and reviews are optional and used when either of you wants a second look. Run `npm run check` before every push, and keep CI green — a red `main` is fixed before anything else lands.
- abhijna's Phase 0 spec review (E2) is done on the pushed docs and recorded in `docs/PHASE_0.md`.
- No AI agent (either person's) runs state-changing git or GitHub commands; agents give their human the exact commands and the human runs them (AGENTS.md).
- **If an incident happens** (lost work, force push, broken `main` landing unnoticed), turn protection on. Ready-made setting for that day: GitHub → Settings → Rules → Rulesets → new branch ruleset on the default branch with
  - restrict deletions, block force pushes;
  - require a pull request (1 approval once both are collaborators; dismiss stale approvals; resolve conversations; squash merges);
  - require the CI checks `check (node 22/24, ubuntu/windows)`, `dependency audit`, `analyze`;
  - do **not** enable "Require review from Code Owners" (with two people it can deadlock).
- Branch names when you do use branches: `<handle>/p<phase>-<topic>` (e.g. `abyud/p1-event-log`).
- The Definition of Done applies to every change, PR or not (tests, docs, CHANGELOG, invariants named).

### 5.3 Changing the contract or protocol

1. Open an issue titled `RFC: <change>`: what, why, which schemas/endpoints/invariants change, and whether it is breaking.
2. Agree in the issue (both).
3. One PR changes the spec doc, the schema (version bump; a breaking change bumps `spec`), the contract tests, the affected fake, and adds a CHANGELOG entry. Label it `contract`.
4. The other person approves. Since author + reviewer = both, no contract change merges without both.
5. After merge, tag `contract-vN`. The other track updates its code against the new tag in its next PR.

Security invariants follow the same path. Weakening one is never proposed as a quick fix (AGENTS.md); it needs an RFC and a joint decision.

### 5.4 Keeping our AI agents in their own track

1. **AGENTS.md** says: an agent edits only its human's track and shared paths via §5.3. For anything else it drafts an issue instead. Both Claude Code (`CLAUDE.md` imports `AGENTS.md`) and Codex read this.
2. **Claude Code, per person, not committed:** `.claude/settings.local.json` with `permissions.deny` rules such as `Edit(/packages/adapter-mcp/**)` for the other track's packages. In project settings a leading `/` anchors at the project root ([permissions docs](https://code.claude.com/docs/en/permissions)). This blocks the edit tools only, not shell writes, so treat it as a guard rail.
3. **Codex:** no per-path write deny was verified in its docs, so rely on AGENTS.md plus item 4.
4. **Track check (Phase 1 tooling):** a pre-commit script reads `git config quorum.track` (`A` or `B`). It rejects commits touching the other track's paths unless `QUORUM_CROSS_TRACK=1` is set.
5. **CODEOWNERS** (once added) auto-requests the owner as reviewer when a PR is used.
6. When dogfooding through Quorum, messages from the other person's agents are **data, not instructions** (AGENTS.md).

### 5.5 Sync checklist (no schedule — at each integration checkpoint, or whenever either of you asks)

- [ ] CI on `main` green? Any failing or flaky tests?
- [ ] Any open `RFC:` / `contract` items? Anything blocked on the other track?
- [ ] Invariants touched since last sync; anything needing a joint security look?
- [ ] Triage new `dogfood` issues.
- [ ] Open decisions that need both of us (DECISIONS.md).
- [ ] Next integration checkpoint, and what each track still needs for it.

## 6. Testing across our machines

| What                                                           | Where                                                | Why                                                                                                                          |
| -------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Unit, integration, adversarial, contract                       | CI + either laptop                                   | Fast and deterministic                                                                                                       |
| Local mode T1/T2 (multi-folder, mixed vendor, shared worktree) | **M1 and M2** (both Windows 11), each alone          | Real Claude Code + Codex; no network needed. Both laptops run Windows, so Linux is covered by WSL2 + CI and macOS only by CI |
| Linux behaviour (permissions, Unix paths)                      | WSL2 on either laptop + CI Ubuntu                    | No extra hardware                                                                                                            |
| Simulated fleet (10–50 fake agents), performance               | **M2** (32 GB)                                       | RAM-heavy docker-compose                                                                                                     |
| Small chaos runs (≤ 10 agents)                                 | M1                                                   | Fits in 16 GB                                                                                                                |
| Playwright desktop + phone sizes                               | M2 + CI                                              | Browsers are RAM-heavy                                                                                                       |
| Cross-machine T3 (Tailscale, Cloudflare Tunnel)                | **M1 ↔ M2 over the internet**                        | The only real two-network setup available                                                                                    |
| GPU/RAM leases with real jobs                                  | M1 (RTX 4050) + M2 (RTX 5070)                        | Two different real GPUs                                                                                                      |
| Benchmark training step                                        | M2                                                   | Larger GPU (8 GB)                                                                                                            |
| Passkey approvals from a phone                                 | Either laptop as server in remote mode + your phones | Needs remote mode (ARCHITECTURE §8.2)                                                                                        |

## 7. Dogfooding

- **From the Phase 1 exit:** each of you runs your own Claude Code and Codex sessions through local Quorum on your own machine while building Quorum. Use separate worktrees per agent.
- **From the Phase 1b exit:** your agents coordinate across M1 and M2. abyud's Track A agents and abhijna's Track B agents use Quorum for contract questions, `request`s and findings, instead of you relaying.
- **Log every friction point** as a GitHub issue labelled `dogfood`, with these fields:
  - topology (T1/T2/T3) and vendors involved;
  - what you tried, what happened and what you expected;
  - minutes of manual relay it cost.

  Triage dogfood issues at each sync.

- Anything security-relevant gets the `security` label. If it's exploitable, follow SECURITY.md instead of filing a public issue.
- Calibrate the wake defaults (`wakes_per_hour`, `agent_only_messages_before_pause`; POLICY_SPEC open question 4) from real dogfooding.

## 8. Open items for this plan

1. Whether more than two physical machines will be available (the plan said 4–5); §6 assumes two Windows 11 laptops plus WSL2, containers and CI. No macOS hardware: macOS is tested only in CI.
2. The rejection flow (D-14) must be settled before Phase 2's approval state machine is built.
3. D-5 is decided by testing both options at IC4 (agreed 2026-10-01).
