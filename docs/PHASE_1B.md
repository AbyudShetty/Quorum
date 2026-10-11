# Phase 1b — Cross-machine: status

**Status: in progress (started 2026-10-11).** Built by abyud; tried first on abyud's own two laptops, then with abhijna for the exit run.

## Exit criteria (plan §13)

| #   | Criterion                                                                                                                                 | Status  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Y1  | A Claude Code session on machine A and a Codex session on machine B exchange messages in < 5 minutes from a clean install, over Tailscale | not yet |
| Y2  | The same over Cloudflare Tunnel                                                                                                           | not yet |
| Y3  | All Phase 1 exit criteria still hold ([PHASE_1.md](PHASE_1.md))                                                                           | not yet |

## Steps

| #   | Step                                                                                                          | Status   |
| --- | ------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | Remote access: HTTPS front end (`tailscale serve`, `cloudflared`) → loopback server; `quorum remote` (INV-22) | ✅ built |
| 2   | Join codes: server URL + key fingerprint + single-use secret, 10 min (INV-24 for remote)                      | next     |
| 3   | `quorum join` on the other machine                                                                            |          |
| 4   | Human sign-in from another machine (device code)                                                              |          |
| 5   | Setup guides: Tailscale and Cloudflare Tunnel                                                                 |          |
| 6   | Two-laptop exit run (abyud's laptops), then the run with abhijna                                              |          |

## Open

- D-5: which front end Quorum recommends by default (Tailscale or Cloudflare Tunnel). Decided jointly after trying both; the build supports both.
