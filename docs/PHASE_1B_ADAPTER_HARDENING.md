# Pairing adapter and relay hardening

Implementation review, 2026-11-04. This follows the server hardening and does not start Phase 2.

## Each tool call belongs to its actual session

The pairing MCP server no longer selects the last active Codex window or a Claude window merely
because its process matches. Each vendor's PreToolUse hook identifies the exact joined session,
canonical folder, attachment and registered window, then rewrites the tool arguments with a fresh
one-use proof. The proof is bound to the tool and canonical argument hash and expires after one
minute. The MCP server consumes it before any network operation. It cannot be reused, changed to
another recipient/tool, or used by an unjoined window. The proof files contain hashes, not the
bearer proof or message contents, and abandoned records are expired and bounded.

Calls without a valid proof fail closed, including on vendors which do not support input rewriting
or where the new hooks have not been trusted. Run `quorum setup`, review the hooks, and restart the
vendor after updating. Setup revision 4 installs the hook. Each resolved invocation owns its own
HTTP client, so a concurrent window or a long approval dialog cannot change its session header.

The implementation follows the documented
[Codex PreToolUse input rewrite](https://learn.chatgpt.com/docs/hooks) and
[Claude Code PreToolUse input rewrite](https://code.claude.com/docs/en/hooks).
Codex requires `permissionDecision: allow` alongside `updatedInput`; Claude receives only the
input rewrite and keeps its normal permission flow. No PermissionRequest hook grants approvals.
The manual exit run must verify that a user-configured vendor tool approval policy still applies,
including bypass modes and nested code-mode calls. Automated SDK tests cannot establish vendor
runtime permission ordering or whether an installed version supports this behavior.

## Concurrent hook updates

All pairing-state read/change/write operations serialize through a named cross-process lock.
Joining has its own per-session lock; network calls never hold the global pairing-state lock.
Independent processes cannot overwrite notification records or exceed the request-wake budget
because they read the same old file. Malformed state is refused and preserved instead of becoming
an empty state file.

Named locks now use the startup lock's atomic PID/token file and guarded stale-owner takeover.
A live holder is never evicted just because its work exceeded an age threshold, and release checks
its ownership token. Older Quorum binaries used lock directories: stop those processes before
upgrading. A leftover legacy directory is refused, rather than deleted while an old holder may
still be using it. No automatic cleanup may remove a live lock.

## Relay input and abuse limits

Malformed percent-encoded lookup IDs return a controlled error on both relay implementations,
rather than crashing Node. Hosted relay lookup and WebSocket admission limits now use atomic
Durable Object counters per hashed client address. They reuse the existing PHONEBOOK binding and
persist across isolates and hibernation; no new Cloudflare binding or schema migration is needed.
The default limits are 30 lookups and 120 WebSocket upgrade requests per address per minute.
HTTP 429 includes Retry-After; storage failures return a retryable error. Deployment is separate
from building this source: a passing local Worker test does not prove the hosted copy is current.

## Verification and scope

Regression tests cover concurrent processes updating state, duplicate joins, notification and wake
limits, one-use proofs through the real MCP SDK, parallel windows, expired/replayed/modified
proofs, malformed relay paths, rate-window resets and concurrent limiter requests. Existing
server, contract, adapter and packaging checks still apply.

Security invariants: INV-7, INV-12, INV-15, INV-25, INV-29 and INV-34. This adapter hardening adds no
dependency or shared HTTP payload. The subsequent, explicitly authorized ID rotation feature adds
a separate human-only endpoint and API schema revision; see [its RFC](rfcs/ID_ROTATION.md).

The final server review also covers asynchronous pairing-command races: a lookup or delivery
finishing late must not undo a newer detach/block or delete a newly approved link after an older
refusal. The cancellation check is internal to in-flight operations; no new wire fields or
protocol tombstones are introduced. Queued link/unlink operations retain FIFO order.

The release packer excludes compiled JavaScript whose TypeScript source no longer exists. This
prevents a long-lived developer build directory from adding obsolete modules to the tarball.
