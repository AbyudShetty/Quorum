# RFC: human-requested session ID rotation

Status: **implementation authorized**. Abyud reported discussing rotation with Abhijna and
asked to implement the separate `/quorum-rotate` command, keeping `/quorum-id` unchanged.
This records that authorization and the implementation contract for review under TEAM_PLAN
§5.3; it does not claim a GitHub review, merge, deployment or Phase 1b exit.

## Behavior

Claude Code uses `/quorum-rotate`; Codex uses `$quorum-rotate`. It is the seventh installed
command. `/quorum-id` always returns the current ID, joining only when necessary; it never
rotates. Rotation requires an already joined session and accepts no arguments. The typed human
command is intercepted before the model runs; no MCP rotation tool is exposed.

Rotation assigns a fresh self-certifying ID and retires the old one. It unlinks established
peers and cancels pending requests. Every peer must approve again through ordinary pairing.
The vendor session, agent, attachment, window label, credentials, historical workspace membership,
conversation history and blocks remain. It cannot restore a revoked principal or widen any
permission. Rotating an ID does not revoke compromised credentials.

## API and retries

`POST /v1/quorum-ids/rotate` requires a human token and this request:

```json
{
  "vendor": "codex",
  "vendor_session_id": "the-current-vendor-session-id",
  "root": "C:\\projects\\api",
  "expected_id": "QRM-AAAA-BBBB-CCCC"
}
```

Response, HTTP 200:

```json
{
  "previous_id": "QRM-AAAA-BBBB-CCCC",
  "id": "QRM-DDDD-EEEE-FFFF",
  "detached": ["QRM-1111-2222-3333"]
}
```

The IDs above illustrate the shape. The active identity must belong to the authenticated human,
vendor session and canonical attached folder. Agents, another owner, a wrong folder or an
inactive identity are refused. Request and response reject unknown fields. API schema revision
`1.1.0-draft` adds two version-1 payload schemas and the OpenAPI route; the message envelope
remains `quorum/1` because its wire format did not change.

`expected_id` makes retries safe. A request matching the current ID performs one transaction.
A retry naming the immediately preceding ID returns the saved original response while its
replacement remains current, including after restart. Once another rotation supersedes that
replacement, the old request returns HTTP 409, `pairing.id_changed`. It never silently performs
another rotation. Read the current ID, then deliberately retry with that ID.

## Atomic storage and delivery

Migration 6 adds durable rotation receipts. One transaction cancels unsent old-ID link/accept
outbox rows, queues old-ID unlinks, removes both sides of local links, changes the public ID and
salt, moves existing blocks, saves the retry receipt and appends a human-attributed
`quorum_id.rotated` audit event. Retired IDs cannot be allocated again. Existing message and
conversation events remain unchanged.

Accepted messages remain in FIFO order ahead of their unlink. A handshake already in flight
is retained in the same destination queue so the unlink cannot overtake it. Work that has not
started is cancelled. Cancellation epochs and immediate old-ID invalidation prevent a late
lookup, acceptance or new message from restoring the retired identity. Remote unlink delivery
can lag while a peer is offline; the local authorization change takes effect at commit.

Blocks owned by this session move to its new ID; local peers' blocks of this session follow the
same local identity. No cross-server identity alias or automatic trust migration is introduced.
A remote peer cannot infer a new ID from an old one. A new pairing still requires consent.

After commit, register the new ID with the relay and update hook state. A per-session lock spans
the hook operation; ordinary `/quorum-id` reads the authoritative server ID to recover a stale
cache after a lost response or failed local write. Rotation clears stale request/display marks
without deleting conversation state. Failed transactions leave the old identity and links intact.

The relay may retain an old phone-book entry. That entry grants no authority: requests for the
retired ID get the existing no-such-ID response from its home. No relay wire-format change or
phone-book deletion protocol is needed.

## Security and validation

Touches INV-7, INV-8, INV-11, INV-12, INV-20, INV-25, INV-30 and INV-34 without weakening them.
Shared contract tests cover schema shape, stable agent/credentials, human-only access,
folder/activity checks, concurrent retries and superseded requests against real and fake
servers. Server and hook regressions cover local/relay links, history, blocks, transaction
rollback, outbox ordering and stale local state. The live two-laptop run also exercises rotation.

Back up and verify real data before migration. An older binary must refuse a newer database
schema. Rollback uses that binary's pre-migration backup; it never rewrites the append-only
event log, revives retired IDs or silently relinks peers. Joint review and the existing Phase 1b
manual exit gates still apply before release.
