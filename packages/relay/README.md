# @quorum/relay

The relay that connects machines on different networks (DECISIONS D-18, ARCHITECTURE §8.4). Every machine connects **out** to it, so nobody installs a VPN or opens a port.

It pairs a connection from another machine with the home server it asks for, and passes bytes between them. It also keeps a **phone book** of Quorum IDs (D-20, [PAIRING.md](../../docs/PAIRING.md)): ID → the home key fingerprint and salt it was derived from. A home can only register IDs derived from its own key, over its proven control connection, and whoever looks an ID up recomputes it from the answer, so the relay cannot point an ID elsewhere undetected. It cannot read or change them: inside is a TLS 1.3 session straight to the home server, whose key the other machine pinned from its invite code (INV-24). Apart from the phone book it stores nothing and keeps no history; it sees only who connects to whom, when, and how much.

| Path                            | What                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| `GET /health`                   | `{"status":"ok","relay":"quorum-relay/1"}`                                                  |
| `GET /v1/lookup/<QRM-…>`        | `{"home","salt"}`, or 404 "No such ID." (rate-limited per address)                          |
| `GET /v1/home/<fingerprint>`    | WebSocket: a home server's control connection; it must sign a challenge with that key       |
| `GET /v1/connect/<fingerprint>` | WebSocket: another machine asking for that home; binary frames flow once `paired` arrives   |
| `GET /v1/accept/<fp>/<conn>`    | WebSocket: the home's side of one connection, named by an id only the proven home was given |

- `src/router.ts`: the pairing logic, Web Crypto only, so it runs on Node and in Cloudflare Workers.
- `src/node.ts`: `startRelay()`, used by `quorum relay` to self-host (one dependency: `ws`, the standard WebSocket server for Node).
- `worker/` and `wrangler.toml`: the hosted relay as a Cloudflare Worker with one Durable Object per home (free plan); see `worker/README.md`.

Limits: frames up to 1 MiB, 64 open connections per home, 120 new WebSocket requests and 30 ID
lookups per client address per minute (Node defaults and the hosted Worker). A refused HTTP
request returns 429 with `Retry-After`; malformed percent-encoded lookup IDs return 400.
The home itself also rate-limits connections per address.

The hosted Worker's counters use the existing `PHONEBOOK` Durable Object binding, with separate
objects named `limits:<SHA-256(client address)>`. These cannot collide with Quorum IDs and enforce
the budget across Worker isolates and object hibernation. Counter cleanup alarms remove expired
windows without deleting a newly reset window; no raw client address or request history is stored.
No new binding or migration is needed. Deploy the updated Worker before the Phase 1b exit run.
