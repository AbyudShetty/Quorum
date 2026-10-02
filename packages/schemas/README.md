# @quorum/schemas

Track: **shared contract**. Changes follow the RFC flow in `docs/TEAM_PLAN.md` §5.3, and a protocol change bumps the schema version.

The machine-readable form of `docs/MESSAGE_SPEC.md` and `docs/POLICY_SPEC.md`. Every other package depends on this one.

## What's here

| Export                                                                     | What it is                                                                                                   |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `validateSubmittedEnvelope(x)`                                             | A message a client wants to send. Adapters call it before sending; the server calls it on receipt.           |
| `validateDeliveredEnvelope(x)`                                             | A message received from the server. Unknown types pass (show them as a note); known types are fully checked. |
| `validatePolicy(x)`                                                        | A parsed `quorum.policy.yaml`. Unknown keys are rejected so a typo can never loosen policy.                  |
| `validateErrorResponse(x)`                                                 | The single API error shape.                                                                                  |
| Types (`SubmittedEnvelope`, `FindingBody`, `PolicyV1`, …)                  | TypeScript view of the schemas.                                                                              |
| `ALL_SCHEMAS`, `*Schema` objects, `LIMITS`, `MESSAGE_TYPES`, `ID_PREFIXES` | The JSON Schemas (draft 2020-12) and constants, for OpenAPI and non-TypeScript clients.                      |

| `openApiDocument`, `openapi.v1.json` | The OpenAPI 3.1 description of the `/v1` API. After changing it, run `npm run generate` at the repo root; a test fails if the committed `openapi.v1.json` is out of date. |
| `validateApiPayload(kind, x)` | Any API request/response payload (health, hello, tokens, attachments, sessions, inbox pages, exported events). |

The executable form of the API contract is the suite in `tests/contract/` (see its README).

Every validator returns `{ ok: true, value }` or `{ ok: false, issues: [{ path, rule, message }] }`, where `path` is a JSON Pointer.

## What the schemas do not check

These need context the schema can't see, so `core`/`server` (Track A) enforce them:

- The sender matches the token (INV-7); agents may not send `approval_decision` (INV-1).
- Secrets in bodies (INV-14), rate limits and quotas (INV-15).
- Referenced objects exist in the same workspace; the artifact hash/size match what is stored.
- Task state transitions, lease conflicts, and policy semantics (quorum ≤ eligible approvers, `critical` always needs approval).
- The _effective_ risk of an approval request (policy can raise it, which can then require a `rollback_plan`).

## Choices made where the spec was silent (review at the contract freeze)

1. **Required fields.**
   - `request`: `title`, `description` and at least one `expected_outputs` are required.
   - `finding`: `claim`, `method` and `confidence` are required.
   - `heartbeat`: `status` and `resources_in_use` (may be empty) are required.
   - `approval_request`: `evidence_refs` (may be empty) and `diff_or_preview` are required.
2. **Task status `requested`** is set only by the server; clients can't send it.
3. **Lease `until`** is required to acquire or renew, but not to release.
4. **Rejecting** requires a `comment`; approving or closing doesn't.
5. **Size limits.** A body may be at most 96 KiB, measured as the UTF-8 bytes of its JSON. A single string may be at most 16 KiB, measured in characters.
6. **Name formats.** IDs use uppercase Crockford ULIDs; names and addresses are lowercase; dataset and slot names follow simple name patterns (see `LEASE_RESOURCE` in `bodies.ts`).
7. **Unknown types on delivery** must still look like a type name (lowercase, underscores); their body isn't checked.
8. **Timestamps** are checked as RFC 3339 by our own small function, instead of the `ajv-formats` package (which would pull in a second copy of Ajv).
