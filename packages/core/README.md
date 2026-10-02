# @quorum/core

Track: **A** (abyud), see `docs/TEAM_PLAN.md` §2.

Quorum's domain logic, kept free of HTTP, SQL, HTML and networking (ARCHITECTURE §1). Storage and the outside world are reached only through ports (interfaces), so the server can swap SQLite for Postgres and the CLI can reuse the same rules.

| Module              | What it does                                                                                                                                                                                                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ids`               | Prefixed, time-sortable IDs (`msg_…`, `ev_…`), strictly increasing even within one millisecond. Clock and randomness are injectable for tests.                                                                                                                                                                 |
| `canonical-json`    | RFC 8785 (JCS) canonical JSON: one exact byte form per value, so hashes match on every machine (MESSAGE_SPEC §3).                                                                                                                                                                                              |
| `hash-chain`        | Builds events into a per-workspace hash chain and verifies one: detects modified, inserted, deleted and reordered events (INV-8), and a fully rewritten log when compared against checkpoints.                                                                                                                 |
| `jsonl`             | The `quorum export` format: one event per line, read back with per-line problems.                                                                                                                                                                                                                              |
| `event-store`       | The `EventStore` port the server implements on SQLite, plus `MemoryEventStore` for tests and fakes. Appends are append-only and must continue the chain.                                                                                                                                                       |
| `messages`          | `acceptMessage` checks a submitted message in a fixed order — schema and size, workspace, sender identity (INV-7), human-only types (INV-1), token scope (INV-12), secrets (INV-14), idempotency — and returns the event to append. `MessageLog` is the projection behind inbox, threads and acknowledgements. |
| `secrets`           | High-confidence secret detection (cloud keys, vendor API keys, private keys, Quorum tokens). Findings name the field, never the value.                                                                                                                                                                         |
| `tokens`            | Prefixed bearer tokens (`qrm_at_`, `qrm_rt_`, `qrm_jc_`) with 256 random bits, stored as hashes, compared in constant time; refresh rotation where reusing a rotated token revokes the family (INV-11).                                                                                                        |
| `workspace-members` | Default agent names (`claude-api`, collisions `-2`), path keys that match a folder however it is spelled, and shared-working-tree detection (INV-28).                                                                                                                                                          |
| `wake`              | Whether a message may wake an agent: wake mode (D-9), hourly budget and the agent-only-loop pause (INV-29). Delivery itself is per vendor (Track B).                                                                                                                                                           |
| `presence`          | Online/offline from heartbeats; offline after 3 missed intervals.                                                                                                                                                                                                                                              |

## Errors

Core throws `DomainError` with a `kind` the server maps to HTTP (`invalid` 400, `unauthorized` 401, `forbidden` 403, `not_found` 404, `conflict` 409, `too_large` 413) and a stable `code`:

| Code                         | When                                               |
| ---------------------------- | -------------------------------------------------- |
| `message.invalid`            | Schema violation; `path` points at it              |
| `message.too_large`          | Body over 96 KiB                                   |
| `message.workspace_mismatch` | Envelope names a different workspace than the URL  |
| `message.sender_mismatch`    | `from` is not the token's principal (INV-7)        |
| `message.human_only`         | An agent sent `approval_decision` (INV-1)          |
| `message.type_not_allowed`   | Outside the token's scope (INV-12)                 |
| `message.secret_detected`    | A known secret format in the body or refs (INV-14) |
| `message.id_conflict`        | Same `id`, different content                       |
| `inbox.bad_ack`              | `up_to` is not a non-negative integer              |
