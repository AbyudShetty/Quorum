# @quorum/core

Track: **A** (abyud), see `docs/TEAM_PLAN.md` §2.

Quorum's domain logic, kept free of HTTP, SQL, HTML and networking (ARCHITECTURE §1). Storage and the outside world are reached only through ports (interfaces), so the server can swap SQLite for Postgres and the CLI can reuse the same rules.

| Module           | What it does                                                                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ids`            | Prefixed, time-sortable IDs (`msg_…`, `ev_…`), strictly increasing even within one millisecond. Clock and randomness are injectable for tests.                                                 |
| `canonical-json` | RFC 8785 (JCS) canonical JSON: one exact byte form per value, so hashes match on every machine (MESSAGE_SPEC §3).                                                                              |
| `hash-chain`     | Builds events into a per-workspace hash chain and verifies one: detects modified, inserted, deleted and reordered events (INV-8), and a fully rewritten log when compared against checkpoints. |
| `jsonl`          | The `quorum export` format: one event per line, read back with per-line problems.                                                                                                              |
| `event-store`    | The `EventStore` port the server implements on SQLite, plus `MemoryEventStore` for tests and fakes. Appends are append-only and must continue the chain.                                       |
