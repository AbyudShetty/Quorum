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

Limits: frames up to 1 MiB, 64 open connections per home, new connections per address per minute (Node), and the home itself rate-limits connections per address.
