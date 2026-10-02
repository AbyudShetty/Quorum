# Decision log

Lightweight ADRs. Each records the decision, why, how to undo it, and what would make us revisit it. Decisions listed in plan §17 "Open decisions", anything marked **open** here, and any plan change are made **jointly by both maintainers (abyud and abhijna)**. AI agents never decide them.

| #    | Decision                                                                                         | Status                                                                      | Date       |
| ---- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ---------- |
| D-1  | Working name "Quorum"; final name deferred                                                       | open (§17.1)                                                                | 2026-10-01 |
| D-2  | TypeScript on Node.js for the core                                                               | accepted (§17.2)                                                            | 2026-10-01 |
| D-3  | Apache-2.0 licence                                                                               | accepted (§17.3)                                                            | 2026-10-01 |
| D-4  | Server-rendered UI with HTMX                                                                     | accepted (§17.4)                                                            | 2026-10-01 |
| D-5  | Tailscale as default cross-network recommendation                                                | accepted (§17.5) — **revisit requested** (Cloudflare Tunnel proposed), open | 2026-10-01 |
| D-6  | A2A interop stays in Phase 6                                                                     | open (§17.6) — revisit if users ask                                         | 2026-10-01 |
| D-7  | Toolchain: Node 22/24 LTS, TypeScript 6.0, ESLint + typescript-eslint, Prettier, Vitest          | accepted                                                                    | 2026-10-01 |
| D-8  | Re-sequence: Phase 1 = Claude Code ↔ Codex on one machine (local mode); Phase 1b = cross-machine | accepted provisionally — revisit at Phase 0 spec review                     | 2026-10-01 |
| D-9  | Wake-on-message is a per-attachment user choice                                                  | accepted                                                                    | 2026-10-01 |
| D-10 | Passkey (WebAuthn user verification) for high/critical approvals                                 | accepted                                                                    | 2026-10-01 |
| D-11 | Client credentials in the OS keychain via `@napi-rs/keyring`                                     | accepted                                                                    | 2026-10-01 |
| D-12 | Agent identity: stable per attachment by default, changeable on demand                           | accepted                                                                    | 2026-10-01 |
| D-13 | Local-mode transport: loopback TCP + tokens + server identity pinning                            | accepted (outline approved)                                                 | 2026-10-01 |
| D-14 | Answers to the spec open questions                                                               | decided (abyud and abhijna, 2026-10-02)                                     | 2026-10-01 |
| D-15 | No branch protection on main for now; no agent runs git — agents hand humans the commands        | accepted by abyud — abhijna to confirm                                      | 2026-10-02 |
| D-16 | Phase 0 closed with E1/E2 and E4 waived (specs accepted on trust; simulated interviews)          | accepted (both); specs stay changeable                                      | 2026-10-02 |

---

## D-1 Name (open)

"Quorum" is a working name used in docs; nothing has been published under it. **Before the first public release**, check npm, PyPI and GitHub for clashes (plan header) and decide jointly. Renaming is cheap until a package is published: package names, CLI binary name and docs.

## D-2 TypeScript on Node.js

- **Why:** one language for server, CLI, MCP adapter and UI; `npx` distribution for the five-minute setup; official MCP TypeScript SDK; strong JSON Schema tooling.
- **Migration path:** the protocol is defined by language-neutral JSON Schemas and an HTTP API (ARCHITECTURE §9), so clients/adapters in Python or other languages can be generated or written without touching the server.
- **Revisit if:** a hard requirement appears that the Node ecosystem cannot meet (it would be unusual for this workload).

## D-3 Apache-2.0

- **Why:** permissive like MIT, plus an explicit patent grant and contributor patent terms — valuable for a security/governance tool that companies may adopt.
- **Consequences:** keep `LICENSE`; a `NOTICE` file only if we ever need attributions; contributions are under Apache-2.0 (inbound = outbound, see `.github/CONTRIBUTING.md`).
- **Revisit if:** never expected. Relicensing later requires contributor consent, so this is the stickiest decision.

## D-4 Server-rendered + HTMX

- **Why:** no client build step, small attack surface (strict CSP, no tokens in browser JS), fast on phones, boring.
- **Migration path:** HTML routes contain no business logic and call the same core commands as `/v1`; an SPA could consume `/v1` unchanged (ARCHITECTURE §7, §9).
- **Revisit if:** the planner view (Phase 7) or heavy client-side interaction outgrows HTMX fragments.

## D-5 Tailscale as default network recommendation (revisit requested)

- **Why (original):** the server stays private (not internet-reachable), WireGuard encryption, free personal tier, no router ports; smaller attack surface than a public tunnel.
- **Revisit requested 2026-10-01:** abhijna proposed Cloudflare Tunnel. Trade-off to settle jointly:
  - Cloudflare Tunnel: one public HTTPS hostname, nothing to install on joining machines, phones reach it anywhere; but the server is internet-reachable, so authentication, rate limits and INV-24 carry all protection; needs a Cloudflare account (and a domain for a stable hostname).
  - Tailscale: private by default, every machine (and phone) installs the client and joins the tailnet.
- **How it gets decided:** Phase 1b's exit tests **both** (plan §13), so the choice is made on measured setup time and friction. The server is network-agnostic either way (ARCHITECTURE §8), so this is a docs/default change, not code.
- **Revisit if:** onboarding tests (Phase 5) show the chosen default breaks the five-minute setup.

## D-6 A2A interop timing (open)

Stays in Phase 6 per plan. Ask both maintainers before moving it earlier. Cheap insurance taken now: JCS canonicalization (shared with A2A v1.0 signed Agent Cards).

## D-7 Toolchain

- Node: supported `>=22.12`; CI on 22 and 24 (LTS lines); `.nvmrc` = 24. Odd-numbered Node releases (e.g. 25) are not supported.
- TypeScript **6.0.x**, not 7.x: as of 2026-10-01 `typescript-eslint` supports `typescript <6.1`. Move to 7.x when typescript-eslint supports it.
- ESLint (flat config, `strictTypeChecked`), Prettier, Vitest; GitHub Actions pinned to commit SHAs; Dependabot, `npm audit`, dependency review and CodeQL for supply-chain scanning.
- npm workspaces (no extra monorepo tool).

## D-8 Phase re-sequencing: local first, Codex early (accepted provisionally)

- **Decision:** Phase 1 delivers Claude Code ↔ Codex on **one machine, two folders**, in local mode, contract-first. Cross-machine moves to Phase 1b. Codex moves from Phase 4 to Phase 1. See plan §13.
- **Why:** both maintainers use Claude Code and Codex daily, so this is the fastest path to dogfooding; it removes networking/TLS from the first milestone; it proves vendor neutrality from day one instead of in Phase 4.
- **Cost:** the original pain (two machines) is solved one sub-phase later. Phase 1b follows immediately and keeps the original Phase 1 exit criterion.
- **Revisit:** at the Phase 0 spec review (E1/E2). Reverting means swapping Phase 1 and 1b back in the plan.

## D-9 Wake-on-message is the user's choice

- **Decision:** per attachment `wake: off | direct | all` (+ optional `wake_types`), chosen in an interactive prompt at `quorum attach` and changeable any time; `off` when non-interactive. The wake budget and agent-only-loop circuit breaker always apply (INV-29).
- **Why:** waking removes the relay (the product's point) but lets other agents start turns in your session; users weigh that differently per project.
- **Revisit if:** dogfooding shows one default is always chosen.

## D-10 Hardware-backed user verification for high-risk approvals

- **Decision:** approving `high`/`critical` requests requires a hardware-backed user-verification signature bound to the request (INV-31). Policy may require it for lower risks too.
- **Terminal first (updated 2026-10-01 at abyud's request — "browser for passkey feels too much work"):** on Windows, `quorum approve` triggers **Windows Hello** directly from the terminal (TPM-backed key credential, server-verified signature; spike S6). The browser/phone passkey path (`@simplewebauthn/server`) remains for phones and non-Windows machines. Both give the same guarantee: no approval without a live human gesture.
- **Why:** an agent running as the same OS user can read local credentials; a passkey needs a physical touch/biometric. Also answers THREAT_MODEL open question 4.
- **Consequence:** the local UI is served at `http://localhost:<port>` (WebAuthn needs a domain); phone approvals need remote mode.

## D-11 Credentials in the OS keychain

- **Decision (delegated to the planning lead, "any safe option"):** adapters and CLI store tokens in the OS keychain through `@napi-rs/keyring` (MIT, ~5.5 M weekly downloads, maintained; Windows Credential Manager, macOS Keychain, Linux Secret Service). Where no keychain exists (headless Linux), `attach` fails with instructions instead of writing a plain-text file. Test containers in the simulated fleet receive short-lived test tokens through environment variables only.
- **Why:** plan §10 forbids plain-text secrets; the keychain separates OS users and is the platform default.
- **Limit:** it does not stop a same-user agent (THREAT_MODEL §6.7); D-10 covers that.
- **Migration path:** `CredentialStore` port (ARCHITECTURE §9).

## D-12 Agent identity

- **Decision:** one stable agent identity per attachment by default (inbox and history survive restarts); new identities on demand (`--new-identity`, `quorum agent new`), automatic temporary identities for simultaneous sessions, explicit pinning via `QUORUM_AGENT`; every change logged (ARCHITECTURE §12).
- **Why:** requested "stable but dynamic and flexible".

## D-13 Local-mode transport

- **Decision:** loopback TCP (`127.0.0.1`/`::1`, OS-assigned port), tokens on every request, server identity handshake against a key pinned in the private discovery file, Host/Origin checks (INV-23–INV-26).
- **Why:** works identically on Windows, macOS and Linux; Node cannot restrict named-pipe ACLs on Windows, so pipes would not be a security boundary; MCP clients and browsers need TCP anyway.
- **Migration path:** Unix sockets can be added on Linux/macOS later through the discovery file (ARCHITECTURE §9).

## D-14 Answers to the spec open questions (abyud, 2026-10-01)

Decisions are joint, so abhijna confirms or challenges these during the E2 review.

| Question                                                    | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Gated" = blocked at enforcement points (THREAT_MODEL §6.1) | accepted                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `independent_approver` for `high`/`critical`                | always on (off for `low`/`medium` unless the action sets it)                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Sensitive files                                             | never shareable by default; `artifact.share_sensitive` (high risk) to override                                                                                                                                                                                                                                                                                                                                                                                                   |
| Lease enforcement in shared trees                           | `warn` by default, `block` opt-in                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `request` recipients                                        | exactly one                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Message body limit                                          | **96 KiB**                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Ordering                                                    | server `seq`; `created_at` informational                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Approvals needed                                            | per action, any value up to the number of eligible approvers                                                                                                                                                                                                                                                                                                                                                                                                                     |
| CLI approvals                                               | yes; high-risk via Windows Hello in the terminal (D-10)                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Wake limits                                                 | start at 20/hour and 12 agent-only messages; calibrate in Phase 1                                                                                                                                                                                                                                                                                                                                                                                                                |
| **What happens after a rejection**                          | **Decided 2026-10-02:** not rigid. The rejecting human gives a reason; the request waits in `discussing`; the agent may justify itself and the humans share their thoughts; a human ends it by approving a revised request, reconsidering, or closing it (work stashed). Agents never decide the outcome (INV-1, INV-32). Plus `approval_required_from`: users choose whether every gated action needs approval (default) or only from a chosen risk up; `critical` always does. |

## D-15 Repository process: no branch protection (for now); no git work by any agent

- **Decision (abyud, 2026-10-02):** `main` stays unprotected; both maintainers may push directly after `npm run check` passes. Protection is turned on after the first incident (lost work, force push, broken `main` unnoticed); the ready-made ruleset is in TEAM_PLAN §5.2.
- **Agents and git (extended to both maintainers, 2026-10-02):** no AI agent — abyud's or abhijna's, Claude Code or Codex — runs git or GitHub commands that change anything (AGENTS.md). Agents give their human the exact commands; the humans run them. Exception: the human explicitly asks the agent to run a specific git command in the current conversation. Claude Code can additionally enforce this with deny rules in each person's untracked `.claude/settings.local.json` (abyud has them).
- **Why:** two trusted maintainers; minimal friction. Trade-off accepted: nothing technical stops a force push or a broken push to `main`.
- **Revisit if:** any incident, or a third contributor joins.

## D-16 Phase 0 closed with waivers

- **Decision (abyud and abhijna, 2026-10-02):** Phase 0 is closed so Phase 1 can start.
  - **E1/E2 waived:** the specs were too long to review line by line, so both maintainers accept them on trust. They remain drafts and change through the RFC flow (TEAM_PLAN §5.3) whenever something turns out wrong; nothing is frozen except by an explicit contract tag.
  - **E4 waived:** no real interviewees were found. The evidence is one real case (the maintainers' own hackathon: relaying messages and zipped files between agents) plus five **simulated** interviews in `docs/interviews/`, labelled as not counting. Simulated interviews reflect our own assumptions, so they are not validation.
- **Mitigations:** (1) the Phase 1 contract freeze (IC1) is a small, mandatory review by both of exactly what the code depends on: schemas, the `/v1` API and the adapter contract; (2) real user interviews move to Phase 5, before public release, alongside the stranger tests.
- **Revisit if:** dogfooding or early users contradict a spec assumption; then change the spec via RFC.
