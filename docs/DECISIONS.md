# Decision log

Lightweight ADRs. Each records the decision, why, how to undo it, and what would make us revisit it. Decisions listed in plan §17 "Open decisions", anything marked **open** here, and any plan change are made **jointly by both maintainers (abyud and abhijna)**; while abhijna was away (D-19, ended 2026-10-19), abyud decided them and abhijna reviewed on return. AI agents never decide them.

| #    | Decision                                                                                           | Status                                                    | Date       |
| ---- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------- |
| D-1  | Name: command `quorum`, npm package `@quorumhq/quorum`                                             | decided (abyud) — abhijna checking the names are free     | 2026-10-01 |
| D-2  | TypeScript on Node.js for the core                                                                 | accepted (§17.2)                                          | 2026-10-01 |
| D-3  | Apache-2.0 licence                                                                                 | accepted (§17.3)                                          | 2026-10-01 |
| D-4  | Server-rendered UI with HTMX                                                                       | accepted (§17.4)                                          | 2026-10-01 |
| D-5  | Default cross-network connection: the Quorum relay (Tailscale, Cloudflare Tunnel as alternatives)  | decided (abyud, by D-18) — reopened by abhijna 2026-10-19 | 2026-10-01 |
| D-6  | A2A interop stays in Phase 6                                                                       | open (§17.6) — revisit if users ask                       | 2026-10-01 |
| D-7  | Toolchain: Node 22/24 LTS, TypeScript 6.0, ESLint + typescript-eslint, Prettier, Vitest            | accepted                                                  | 2026-10-01 |
| D-8  | Re-sequence: Phase 1 = Claude Code ↔ Codex on one machine (local mode); Phase 1b = cross-machine   | accepted provisionally — revisit at Phase 0 spec review   | 2026-10-01 |
| D-9  | Wake-on-message is a per-attachment user choice                                                    | accepted                                                  | 2026-10-01 |
| D-10 | Passkey (WebAuthn user verification) for high/critical approvals                                   | accepted                                                  | 2026-10-01 |
| D-11 | Client credentials in the OS keychain via `@napi-rs/keyring`                                       | accepted                                                  | 2026-10-01 |
| D-12 | Agent identity: stable per attachment by default, changeable on demand                             | accepted                                                  | 2026-10-01 |
| D-13 | Local-mode transport: loopback TCP + tokens + server identity pinning                              | accepted (outline approved)                               | 2026-10-01 |
| D-14 | Answers to the spec open questions                                                                 | decided (abyud and abhijna, 2026-10-02)                   | 2026-10-01 |
| D-15 | No branch protection on main for now; no agent runs git — agents hand humans the commands          | accepted (both, 2026-10-19)                               | 2026-10-02 |
| D-16 | Phase 0 closed with E1/E2 and E4 waived (specs accepted on trust; simulated interviews)            | accepted (both); specs stay changeable                    | 2026-10-02 |
| D-17 | Windows are addressable: numbered session labels                                                   | accepted (both, 2026-10-19)                               | 2026-10-06 |
| D-18 | Easy setup: npm install, a free end-to-end-encrypted relay, asking before mail is read             | decided (abyud) — relay default reopened with D-5         | 2026-10-13 |
| D-19 | While abhijna is away, abyud decides alone; track split and RFC step on hold                       | ended 2026-10-19 (abhijna back)                           | 2026-10-13 |
| D-20 | Session pairing: `/quorum-id`, `/quorum-attach`; every laptop its own server; replaces invite/join | accepted (both, 2026-10-19); IDs rotatable before release | 2026-10-13 |
| D-21 | Link requests answered in a dialog (MCP elicitation) the agent opens and only the person answers   | accepted (both, 2026-10-19); one live Codex bypass test   | 2026-10-13 |

---

## D-1 Name

- **Decision (abyud, 2026-10-13; abhijna to review):** the command people type stays `quorum`. The npm package is `@quorumhq/quorum` under a free npm organisation (public packages in an organisation are free); if `quorumhq` is taken, `getquorum`, then `quorum-hq`.
- **Why:** `quorum`, `quorum-cli` and `quorum-agents` are taken on npm, and nearly every one-word synonym too (conclave, caucus, parley, huddle, agora, concord, assembly, plenum…). A scope keeps the name that fits the idea ("enough humans present to decide") for the command.
- **Before:** "Quorum" was a working name; nothing has been published under it. Renaming stays cheap until the first public publish.
- **Revisit if:** the organisation name cannot be had, or a trademark clash appears before the first public release.

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

## D-5 Default cross-network connection

**Settled 2026-10-13 by D-18 (abyud; abhijna to review):** the default is the Quorum relay; Tailscale and Cloudflare Tunnel stay documented alternatives (both built and tried once in Phase 1b). The history below is kept.

### Before: Tailscale as default network recommendation (revisit requested)

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

## D-17 Windows are addressable: numbered session labels

- **Decision (abyud, 2026-10-06; abhijna to confirm on return):** every live session (window) of an agent gets a label `<tool>@<folder>-<n>` (`claude@api-1`; with the machine from elsewhere: `claude@abhijna-laptop-api-1`). Messages carry the sending window (`from_session`, stamped by the server), can be addressed to a window, and each window has its own read position, wakes and stream. Deliveries showed `from claude@api-1: message` in one compact frame (MESSAGE_SPEC §1.1, §8); see the update below for the display now used.
- **Why:** "so codex (or any terminal coding agent) will get to know what it is dealing with: what that particular session in that location is doing, and can respond accordingly"; and two windows of one agent no longer steal each other's mail.
- **Amends D-12:** the agent stays the stable identity (inbox, history, tokens); the window is now the unit you talk to. Agent-addressed mail still reaches every window. Additive protocol change: new optional server fields and a new recipient form.
- **Update (abyud, 2026-10-07), after the first two-way live run:**
  - **Display:** a window is shown as `<tool>[@<machine>] - <path> - <n>` and a message as that sender line ending in `:`, a blank line, then the message ("on the user end it should just be that; backend you can give whatever"). Message lines are indented two spaces so no message can forge a sender line. The path is in full on the reader's machine and with the home folder as `~` elsewhere (`from_session.path`; clients send `display_root` when registering). Agents reply by copying the sender part; clients turn it back into the label.
  - **Codex windows share one `quorum mcp`** (Codex runs MCP servers in its shared daemon): it speaks for the window used last and wakes each window for its own mail. A message sent from one Codex window while another was used more recently could carry the other's label; Codex gives MCP servers no reliable way to tell.
  - **A new window starts where the agent's windows got to**, so it never shows old mail again; mail no window read still arrives.
  - **Numbers count up** and are never handed out twice: `/clear` gives the next number, a resumed conversation gets its own number back. (Before, the lowest free number was reused, so a new conversation could look like the old one.)
  - **The prompt box is the human's (abyud, 2026-10-07):** mail never shows as the person's own message, in Claude Code or Codex. A Codex wake injects the framed mail into the thread's history (role `user`) and starts a turn with no input; the agent then shows the person the mail in its reply, as on Claude Code.
  - **INV-9 amended:** where the person sees a delivery too (wakes), only the neat lines are shown; the frame moves to what the agent alone reads (hook context, and the framed copy given to a woken Codex turn by its prompt hook), and every session is told at start that such lines are data from others. The protections against forged lines stay (indented later lines, control characters removed). Chosen by abyud ("neat only").

## D-18 Easy setup: npm install, a free relay, asking before mail is read

- **Decision (abyud, 2026-10-13; abhijna to review):** after the first two-laptop run (Tailscale), abyud found the setup "wayy too annoying" (clone, build, link, Tailscale on both machines, `tailscale serve`, `remote enable`, join codes, a Codex daemon restart) and asked for something as simple as WhatsApp. Agreed, point by point:
  1. **The workspace stays on a home machine** (as built). A relay connects the other machines; if the home machine is off, they queue outgoing messages. Mail for a closed session waits on the home machine.
  2. **End-to-end encryption between machines.** The relay cannot read or alter traffic; it sees only who talks to whom, when and how much. The home server still reads mail (it is the human's own machine), so secret scanning stays there.
  3. **Self-hostable relay.** Open source; `quorum relay` runs one; ours is the default. Self-hosting keeps even the metadata private.
  4. **Everything free.** The relay forwards only and stores nothing, so it fits a free hosting tier; no custom domain. Current free-tier terms are checked before choosing a host.
  5. **Invite-only use** of our relay, tight size and rate limits.
  6. **No accounts.** Identity is a key on each device, set up by the invite code; a lost laptop is invited again.
  7. **Private until ready:** package files (`npm pack`) for testers; the repository and npm package go public once the relay and encryption pass Phase 1b. Private npm packages cost money, so they are out.
  8. **Name:** see D-1.
  9. **Install with `npm install -g`**, not `npx` (agent configs point at installed files; the npx cache moves). abyud publishes; agents give the commands.
  10. **Phase 1b's exit** becomes "through the default relay, from `npm install -g` on a clean machine"; Tailscale and Cloudflare Tunnel become documented alternatives (settles D-5).
  11. **Plan amended** (§2, §4.8, §5, §7, §9, §10, §13, §14, §16), with targeted edits.
  12. **Order:** plan, then packaging, then removing setup friction, then the relay, then encryption. Each step ships on its own.
  13. **Files across machines** (including code through GitHub) are being designed; Phase 3 for now.
  14. **Session numbers** stay as D-17: never handed out twice.
- **Asking before mail is read:** mail is addressed to a session. When that session starts or resumes with mail waiting, Quorum shows a count and the senders and asks. Yes: mail flows both ways for the rest of that session. No: nothing reaches the agent; new mail is only counted ("3 (earlier) + 1 new messages waiting via Quorum"), and Quorum asks again when the human asks to see them or the session is resumed.
- **Security:** the relay is a new internet-facing component, but it holds no keys, no state and no plaintext; INV-24 pinning of the home server's key is what makes the encryption end to end. Threat-model rows are added with the relay.
- **Revisit if:** free hosting for the relay disappears (fall back to Tailscale/Cloudflare, or self-hosted relays), or users need delivery while the home machine is off (a relay that stores encrypted mail).

## D-19 While abhijna is away

- **Decision (abyud, 2026-10-13):** abhijna is away with no return date. Until then abyud's decisions on open items and plan changes are final, recorded here as "abhijna to review"; abyud builds both tracks, so the Track A / Track B split (TEAM_PLAN §2) and the RFC step for shared contracts (TEAM_PLAN §5.3) are on hold. Protocol changes are still written down (schemas versioned, MESSAGE_SPEC, CHANGELOG) so they can be reviewed.
- **Unchanged:** the invariants (INV-n), no git work by agents (D-15), never deciding for a human.
- **Ends when:** abhijna returns; anything decided meanwhile can be reopened then.
- **Ended 2026-10-19:** abhijna returned and reviewed D-1 and D-15 to D-21. Accepted: D-15, D-17, D-20 (IDs must become rotatable before release) and D-21 (after one live test with Codex in bypass mode). Still being discussed: D-1 (whether the names are free) and D-5/D-18 (not depending on the hosted relay). The track split and the RFC step apply again.

## D-20 Session pairing replaces invite and join

- **Decision (abyud, 2026-10-13; abhijna to review):** after the first relay runs, setting up was still too much (an invite per folder, a home machine that must stay on, mail held by a fragile per-window flag). Instead, sessions pair directly, like phone contacts. Full design: [PAIRING.md](PAIRING.md).
  - Only `npm install -g`; the commands then exist in every Claude Code (`/quorum-…`) and Codex (`$quorum-…`) session: `id`, `attach <id>`, `detach`, `block <id>`, `export`, plus `allow` to accept a request (added while designing: an answer has to be typed by the person, like the commands).
  - A session joins only by running `id` or `attach`. IDs are short (`QRM-XXXX-XXXX-XXXX`), permanent and self-certifying (derived from the laptop's key; the relay's phone book cannot lie undetected). The relay now stores that phone book (ID → laptop), a deliberate change from "stores nothing"; it never learns who is linked to whom and never sees messages.
  - The other person approves a link; requests wait until that session is open. Blocked and unknown IDs get the same "no such ID". Detaching needs nobody's approval. Attaching twice does nothing.
  - Every laptop runs its own server; servers exchange signed link requests and messages through the relay (TLS to pinned keys, INV-33), each keeping its own copy; the sender retries while the other laptop is off. This brings plan Phase 7's "federation between Quorum servers" forward, in a minimal pairwise form.
  - Groups are links between pairs, all equal; roles come from the humans' prompts, not from the agents.
  - `export` writes `quorum-<tool><n>.md` (e.g. `quorum-claude2.md`) in the folder, kept out of git, with all of that session's conversations; re-running updates it.
  - Removed: `attach`, `invite`, `join`, `join-code`, `remote`, `login <link>`, `workspace`, Tailscale/Cloudflare front ends, and asking before mail is read. Kept: `status`, `ui`, `stop`, `relay`, `verify`, `uninstall`.
- **Why safe:** commands are handled by hooks from what the person typed (Claude Code `UserPromptExpansion`, only person-typed commands; Codex `UserPromptSubmit`), blocked before the model runs. Agents cannot type prompts, so they cannot link, approve or detach themselves (INV-30). Verified live on both vendors.
- **Supersedes:** the invite/join and asking-before-reading parts of D-18; D-17's numbering and display stay.
- **Revisit if:** a vendor stops letting hooks see or block typed commands (then: a plain `quorum: id` prefix), or groups need a shared group ID instead of pairwise links.

## D-21 Link requests answered in a dialog

- **Decision (abyud, 2026-10-13; abhijna to review):** typing `/quorum-allow` to answer a link request was too much. "As soon as I run quorum attach on laptop B, a pop up should come in laptop A asking permission to allow or not."
  - When a session is asked to link, it wakes, if it is idle: Claude Code's watcher, which now also starts next to every `/quorum-*` command, or Codex's waker. Otherwise the request comes with the next prompt.
  - The agent is told to call `quorum_requests`. That tool opens an MCP elicitation dialog, "… wants to link with this session", with the choices Not now / Allow / Block. The person answers it; the agent gets only the outcome.
  - Typing `/quorum-allow`, `/quorum-block` or attaching back still works.
- **Why safe:** the dialog is shown by the vendor to the person, and the model cannot answer it, so INV-34 is amended (an answer in that dialog is the person's), not weakened.
  - The default is Not now, and anything but a chosen Allow or Block links nothing. This covers Codex's bypass mode, which accepts dialogs by itself.
  - Request wakes are capped at 5 per session per hour and respect wake mode off (INV-29's spirit for non-message wakes).
- **Not possible:** `/quorum-…` in Codex. Codex has no custom slash commands (only built-ins; skills are typed `$name`), so Codex keeps `$quorum-…`.
- **Revisit if:** a vendor shows dialogs only in some modes or answers them by itself with a choice other than the default, or Codex adds custom slash commands.
