# Phase 1b — Cross-machine: status

**Status: in progress (started 2026-10-11; widened 2026-10-13 by D-18).** Built by abyud; tried first on abyud's own two laptops, then with abhijna for the exit run when they return.

The first two-laptop run (Tailscale, 2026-10-12) worked both ways, but the setup took too many steps. D-18 adds npm packaging, a free default relay, end-to-end encryption between machines and asking before mail is read.

## Exit criteria (plan §13, amended by D-18)

| #   | Criterion                                                                                                                                                                                | Status  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Y1  | A Claude Code session on machine A and a Codex session on machine B, on different networks, exchange messages in < 5 minutes from `npm install -g` on a clean machine, through the relay | not yet |
| Y2  | A test shows the relay cannot read or alter the messages                                                                                                                                 | not yet |
| Y3  | Mail waiting for a session is held until its human allows it                                                                                                                             | not yet |
| Y4  | All Phase 1 exit criteria still hold ([PHASE_1.md](PHASE_1.md))                                                                                                                          | not yet |

## Steps

| #   | Step                                                                                                          | Status                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | Remote access: HTTPS front end (`tailscale serve`, `cloudflared`) → loopback server; `quorum remote` (INV-22) | ✅ built                                                                                                   |
| 2   | Join codes: server URL + key fingerprint + single-use secret, 10 min (INV-24 for remote)                      | ✅ built                                                                                                   |
| 3   | `quorum join` on the other machine                                                                            | ✅ built                                                                                                   |
| 4   | Human sign-in from another machine (device code: `quorum login <link>`, `quorum login approve <code>`)        | ✅ built                                                                                                   |
| 5   | Setup guides: Tailscale and Cloudflare Tunnel ([REMOTE_SETUP.md](REMOTE_SETUP.md)), now alternatives          | ✅ built                                                                                                   |
| 6   | Two-laptop run over Tailscale (abyud's laptops)                                                               | ✅ 2026-10-12: messages both ways; Codex hooks failed on laptop B (Codex 0.162), now never fail, re-test   |
| 7   | Packaging: one npm package, `npm install -g`; private package files until ready                               | ✅ built (`npm run pack:release`)                                                                          |
| 8   | Setup without friction: no daemon restarts or separate sign-ins to remember                                   | part: `quorum invite` turns remote access on and makes the code in one step                                |
| 9   | Relay: free default, outbound only, stores nothing, self-hostable; `quorum invite`                            | ✅ built (Node `quorum relay`, Cloudflare Worker); hosted at `quorum-relay.abyud.workers.dev` (2026-10-13) |
| 10  | End-to-end encryption between machines (keyed by the home server's identity, INV-24)                          | ✅ built: TLS 1.3 to the pinned key (INV-33)                                                               |
| 11  | Asking before mail is read when a session starts or resumes                                                   | ✅ built                                                                                                   |
| 12  | Exit run: two laptops from a clean `npm install -g`, then with abhijna                                        | —                                                                                                          |

Automated: `packages/cli/test/two-machines.test.ts` runs both machines in one process (a real server with remote access, a second CLI with its own data folder and keychain behind a stand-in front end): join with a forged fingerprint refused without spending the code, join, messages both ways, device sign-in with confirmation.

## Not built (Phase 1b)

- QR codes for join codes (text only).
- Binding a LAN address with Quorum's own TLS (the front end on loopback covers Tailscale and Cloudflare).
- Several remote servers for one machine's human at once (`quorum login <link>` switches; `quorum login` switches back).
- Delivery while the home machine is off (other machines queue instead; a relay that stores encrypted mail would be a later decision).

## Decided

- D-5 is settled by D-18: the relay is the default; Tailscale and Cloudflare Tunnel are alternatives.
