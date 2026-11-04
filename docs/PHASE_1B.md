# Phase 1b — Cross-machine: status

**Status: in progress (started 2026-10-11; redesigned 2026-10-13 by D-20, session pairing).** Built by abyud; tried on abyud's two laptops, then with abhijna when they return.

History: the first build (Tailscale/Cloudflare front ends, join codes) and the second (the relay with `quorum invite` / `join`, D-18) both worked across two laptops, but setting up was still too much. D-20 replaces them with pairing commands typed in the session: see [PAIRING.md](PAIRING.md).

## Exit criteria (plan §13, D-20)

| #   | Criterion                                                                                                                                                                                                | Status                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Y1  | A Claude Code session on laptop A and a Codex session on laptop B, on different networks, pair with `/quorum-id` and `/quorum-attach` and exchange messages, from `npm install -g` alone, in < 5 minutes | not yet               |
| Y2  | A session that never ran a Quorum command is not reachable                                                                                                                                               | not yet               |
| Y3  | A blocked session sees "no such ID", like a wrong ID                                                                                                                                                     | not yet               |
| Y4  | The relay cannot read or alter messages (INV-33)                                                                                                                                                         | ✅ tested (relay e2e) |
| Y5  | All Phase 1 exit criteria still hold ([PHASE_1.md](PHASE_1.md))                                                                                                                                          | not yet               |

## Steps (PAIRING.md §6)

| #   | Step                                                                                                                                                                                | Status                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| —   | Kept from earlier builds: the relay (Node and Cloudflare Worker, hosted at `quorum-relay.abyud.workers.dev`), TLS to pinned keys (INV-33), the npm package (`npm run pack:release`) | ✅ built                                 |
| 1   | Hook exits on Windows (no forced exit; relay sockets dropped at once)                                                                                                               | ✅ built                                 |
| 2   | Hooks catch typed commands: Claude Code `UserPromptExpansion`, Codex `UserPromptSubmit` (`$name`)                                                                                   | ✅ verified live 2026-10-13              |
| 3   | The relay phone book: self-certifying short IDs, lookups, rate limits                                                                                                               | ✅ built (hosted relay: redeploy)        |
| 4   | Server-to-server links: requests, approval, signed messages, retries                                                                                                                | ✅ built (server; INV-34)                |
| 5   | The commands in the hooks; export                                                                                                                                                   | ✅ built                                 |
| 6   | Install-time setup and `quorum uninstall`                                                                                                                                           | ✅ built                                 |
| 7   | Remove the old commands (`attach`, `invite`, `join`, `remote`, …) and their docs                                                                                                    | held until exit run passes (D-19 review) |
| 8   | Exit run: two laptops from a clean `npm install -g`, then with abhijna                                                                                                              | —                                        |

Live runs so far: 2026-10-12 over Tailscale (messages both ways; Codex hooks then failed on a PowerShell-restricted laptop, fixed); 2026-10-13 twice through the hosted relay (whole conversations both ways; hook timeouts, display and held-mail problems, all addressed or replaced by D-20).

## Pre-exit hardening (2026-11-04)

Server authorization, revocation, queue durability, ordering and lifecycle fixes are recorded in
[PHASE_1B_HARDENING.md](PHASE_1B_HARDENING.md). The follow-up work adds per-call session proofs
for pairing MCP tools, serialized hook pairing-state updates, PID/token-based file locks, safe
malformed-lookup handling, and hosted relay rate limits. Details and vendor documentation are in
[PHASE_1B_ADAPTER_HARDENING.md](PHASE_1B_ADAPTER_HARDENING.md).

These are implementation and automated-test results, not a live exit sign-off. Use
[PHASE_1B_EXIT_TEST.md](PHASE_1B_EXIT_TEST.md) for the final run. The revised hosted Worker must be
deployed before that run, and both vendors must trust the new PreToolUse hook setup. Human-only
ID rotation is implemented as `/quorum-rotate` (Codex: `$quorum-rotate`), following Abyud's report
of discussing it with Abhijna: [RFC and contract](rfcs/ID_ROTATION.md). Naming (D-1) and the
alternative networking proposal (D-5) remain joint decisions; no new transport is selected here.
