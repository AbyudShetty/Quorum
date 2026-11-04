# Phase 1b server hardening

Track A review, 2026-11-04. These fixes preserve the existing pairing protocol and do not close
Phase 1b: the two-laptop exit run and the live Codex bypass-mode test are still required.

## Authorization and identity

- A remote `accept` only completes an outgoing request. A request waiting for our human's approval
  remains pending until the human approves; the remote requester cannot approve on our behalf.
- A vendor session's existing identity is returned or given replacement credentials only to its
  owner, in its canonical attached folder, while the identity is active.
- Detach and block stop new messages through both the pairing tools and the ordinary workspace
  message endpoint. Earlier conversations remain readable and exportable.
- Revoked or retired local identities cannot receive federation requests, approvals, or messages.
  Revoked remote mirror agents cannot resume delivery by sending more requests or approvals.
- An alias shared by several linked sessions is rejected. Use the session's Quorum ID, or a unique
  machine-qualified sender line. A short label must never silently pick a different laptop.
- Federated messages obey the per-agent message limit as well as the HTTP per-server limit.

Security invariants touched: INV-7 (attribution), INV-12 (scope), INV-13 (revocation), INV-15 (limits),
INV-30 (binding), INV-34 (human consent and linked-session delivery).

## Delivery and lifecycle

A local message and its federation delivery row now commit in the same SQLite transaction. If
queueing fails, the local event also rolls back: a locally recorded send cannot silently disappear
before it reaches the other laptop (INV-8, INV-20).

Federation preserves insertion order per destination server, including across retries and restarts.
Other destinations can progress while one is offline. Concurrent flush and drain calls share an
active attempt. Shutdown aborts and awaits active delivery before closing SQLite; interrupted rows
remain available for idempotent replay (INV-20, INV-34).

A fresh server stays available under its default idle policy after its first session joins Quorum,
even when that happens after startup. An explicitly configured idle timeout still applies.
Relay shutdown rejects readiness waiters and closes accepted connections. A connection that stalls
before completing TLS releases its slot after ten seconds, while established connections retain
normal HTTP keep-alive behavior (INV-15, INV-33).

## Verification

Regression coverage lives in `packages/server/test/pairing-security.test.ts`,
`pairing-revocation.test.ts`, `federation.test.ts`, `relay-home.test.ts`, and `serve.test.ts`.
The queue failure test uses a SQLite trigger to simulate failed insertion; ordering tests use
real SQLite and an injected transport, with the production TLS transport unchanged.

Run `npm run check` before committing. No new dependency, database migration, schema version, or
protocol change is required.
