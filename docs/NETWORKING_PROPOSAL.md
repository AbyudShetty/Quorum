# Reaching another laptop: proposal for D-5

Status: **proposal, not decided.** Written by abhijna's agent on 2026-10-19 for abhijna and abyud. D-5 stays open until both decide, after the Phase 1b exit run and with the results of the spike in section 7. Nothing here changes code.

## 1. What is asked for

abhijna's requirement (2026-10-19): two people in different cities, on ordinary networks, must be able to pair and message, with **nothing on our end** (no server we run, no account we hold) and **as little setup as possible**.

Two of those cannot be fully had together: a method that works for _any_ two networks needs a publicly reachable meeting point, and someone runs it. So the proposal is about **who runs it and what happens when it fails**, not about removing it.

## 2. Where we are

- The pairing commands (`/quorum-id`, `/quorum-attach <id>`, D-20) and the encryption are settled: laptops talk to each other over TLS 1.3 pinned to the key inside the Quorum ID (INV-33), and only a person approves a link (INV-34).
- The **transport** is a relay: both laptops connect out to it. Ours is a Cloudflare Worker on the free plan (`quorum-relay.abyud.workers.dev`). Anyone can run one with `quorum relay`. The address is configurable (`--relay`, `QUORUM_RELAY`), but **both sides must use the same relay**, because the phone book (ID to laptop) lives there.
- The relay cannot read or alter messages. Its risk is **availability**, not trust.
- The hosted relay has no monitoring and a hard stop at the free-plan limits (recorded in `packages/relay/worker/README.md` on 2026-10-13: 100,000 requests a day, 13,000 GB-s of Durable Object time a day; re-check before relying on them).

## 3. The proposal in one paragraph

Keep the commands and the encryption. Make the transport **layered and swappable**, tried in this order: the same network directly; a direct peer-to-peer connection across networks (hole punching); a relay as the guarantee. Make **finding each other** independent of any one operator: each laptop publishes a small signed record of its current address, and the other side verifies it against the key pinned when the link was approved. The hosted relay stays only as the default last resort and is monitored.

## 4. The three layers

| Layer                     | Works when                                | Needs                                                       | Fails when                                                      |
| ------------------------- | ----------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------- |
| 1. Same network (LAN)     | Both laptops share a network              | Nothing                                                     | Different networks                                              |
| 2. Hole punching (direct) | Both NATs allow it                        | A way to find each other (section 5), a UDP-capable library | Strict or carrier-grade NAT on either side, locked-down offices |
| 3. Relay                  | Always, if the relay is reachable by both | A relay both sides use (hosted default, or self-hosted)     | The relay is down, rate-limited or blocked                      |

Layers are tried in order, with a short timeout each, and the result is remembered per link. A person sees none of this; `quorum status` says which layer a link uses.

**What stays true in every layer:** the connection is accepted only if it ends in the key in the other session's ID (INV-33); the middle layer sees who connects, when and how much, never content; a connection never creates a link (INV-34).

## 5. Finding each other, and re-pairing

Addresses change (a restart, a new network, a tunnel that expires). The app can handle that itself:

1. Each server signs a record `{ID, current addresses, counter, time}` with its instance key (the same key the ID is derived from).
2. It publishes the record to a place the other side can read without asking us. The other side checks the signature against the key pinned at approval and that the counter is higher than the last one it saw.
3. A forged record fails the signature; a replayed old one fails the counter; a malicious publisher can only withhold, which means "cannot connect", never exposure.
4. A record can only **update where an existing, approved link points**. It never adds a link and never skips an approval.

Where the record can live (to be chosen with the spike's results):

| Place                                                   | Operator           | Notes                                                                                                  |
| ------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------ |
| The other laptop (it tells the other when it moves)     | Nobody             | Works only while at least one old address is still valid. Fails when both restart, the normal morning. |
| A signed mutable record on the BitTorrent mainline DHT  | Nobody (public)    | Quorum already uses ed25519. Needs UDP; Windows firewall prompts likely; untested here.                |
| A public pub/sub topic derived from the ID (ntfy-style) | A third party      | Payload is a few hundred bytes, so spikes barely matter. Terms and retention not yet read.             |
| The relay's phone book (today)                          | The relay operator | Works; ties both sides to one relay.                                                                   |

## 6. Terms and limits of the services considered

Checked 2026-10-19. This is a summary, not legal advice; the primary sources are linked in the notes.

| Service                  | Confirmed                                                                                                                                                                                                    | Not confirmed                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Pinggy (ssh tunnel)      | May suspend or end service immediately and without notice; "as is"; bars unlawful content, phishing, malware, disruption; may collect and retain data. Free: 60-minute tunnels, random addresses (its site). | Its privacy policy; scripted use; WebSocket or non-web traffic; "one tunnel per IP". |
| Cloudflare Quick Tunnels | No uptime guarantee; "for testing and development"; 200 in-flight requests; no Server-Sent Events; address changes every run and ends when the process stops.                                                | Terms specific to Quick Tunnels (none found).                                        |
| localhost.run            | Third-party summaries only: free addresses rotate, limits unpublished, custom domains paid.                                                                                                                  | Its own terms (its site could not be read).                                          |

Conclusion: none promises stability, each can end service without notice, and Cloudflare says Quick Tunnels are not for production. A free tunnel is a useful fallback and a test baseline, not a foundation.

## 7. The spike (decides nothing; its results inform D-5)

**Question:** how well do layers 2 and the address record work for real pairs of laptops, and does the dependency behave on Windows?

**Candidates:** a hole-punching DHT library (Hyperswarm / HyperDHT is the first one to try), mainline-DHT mutable records for the address record, and an ssh tunnel (built-in `ssh`) as a baseline. Others (libp2p, WebRTC data channels) only if the first fails.

**Test matrix** (at least 10 attempts per cell, recorded in a table):

| Pair                                   | Why                                   |
| -------------------------------------- | ------------------------------------- |
| Home Wi-Fi, ISP 1 to home Wi-Fi, ISP 2 | The common case                       |
| Home Wi-Fi to phone hotspot            | Mobile carrier NAT (e.g. Jio, Airtel) |
| Hotspot to hotspot                     | The hard case                         |
| Same Wi-Fi                             | Layer 1                               |
| An office or campus network to home    | Locked-down networks                  |

**Measure:** connect success, time to connect, success after one side changes address and restarts, and whether the address record is found. Also: clean install on Windows 11 with no build tools, size added to the package, firewall or antivirus prompts, memory and CPU at idle.

**Proposed pass bar (to agree before running):** direct connections succeed for most home-to-home pairs; install is clean on Windows with prebuilt binaries; failures fall back to the relay with no manual step. Hotspot results are reported, not required.

**Dependency policy** (from abyud, 2026-10-19): a networking dependency is acceptable in principle if it is **optional, behind a seam, and installs cleanly on Windows**. The seam is a small transport interface; the relay implementation stays the default and the only required path.

**Out of scope for the spike:** changing the pairing commands, removing the relay, or touching the hosted relay.

## 8. The hosted relay in the meantime (does not wait for D-5)

| Step                        | What                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Re-check the limits         | Read Cloudflare's current free and paid terms for Workers and Durable Objects and update `worker/README.md`.                                             |
| Watch it                    | An external check on `/health`; the usage page in the Cloudflare dashboard; `wrangler tail` for errors. Name who looks (abyud's account today).          |
| Say what happens at a limit | Pairing and new links fail; open links drop; senders queue and retry (INV-20), so nothing is lost. Write this in `REMOTE_SETUP.md` and the relay README. |
| Pressure valve              | Document `QUORUM_RELAY` and `quorum relay` as the answer when the hosted relay is down or limited; both sides must use the same one.                     |
| Load test                   | Run the 50-agent fleet against the Worker to find where it stops. The fleet has so far run against the fake and the real local server only.              |
| Abuse                       | Per-address limits exist; decide whether a flood from many addresses needs more (for example proof-of-work on registration).                             |

## 9. Risks and what stays imperfect

- A relay is the only layer that works for every pair, so someone runs one. This proposal makes that choice the user's, not a requirement of ours, but a default must exist so strangers are not stuck.
- Public networks (the DHT, a pub/sub service) have their own failure modes and terms.
- Layered transport is more code and more test surface than one relay; the seam keeps the relay path unchanged.
- A tunnel or a reachable peer puts a server on the internet; INV-22 and INV-26 need a review of any path that does.
- Two people on the same relay only: a pair that is split across two relays cannot find each other until the address record layer exists.

## 10. Decision asked for (D-5)

Decide after the spike and the Phase 1b exit run:

1. Is the layered transport the direction (same network, then direct, then relay), with the relay address a setting?
2. Is a published, signed address record how links are re-found, and where does it live?
3. Is the hosted relay kept as the default last resort, monitored as in section 8?
4. Is the networking dependency accepted under the policy in section 7?

Until then: nothing in the product changes, and the hosted relay stays the default.

## Sources

- Pinggy: <https://pinggy.io/terms_of_service>, <https://pinggy.io/>
- Cloudflare Quick Tunnels: <https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/>
- Cloudflare website terms: <https://www.cloudflare.com/website-terms/>
- localhost.run summary (third party): <https://freetier.co/directory/products/localhostrun>
