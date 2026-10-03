# /v1 contract suite

Track: **shared** (both maintainers, TEAM_PLAN §5.3). The executable form of `packages/schemas/openapi.v1.json`: any implementation of the `/v1` API must pass it, so the real server (Track A) and the fake server (Track B) cannot drift apart.

## Running it against an implementation

An implementation ships a **target module** exporting `createTarget` (see `target.ts`). It starts the server, creates a workspace with two agents and a human, and returns their tokens:

```ts
import type { CreateTarget } from '../../tests/contract/target.js';

export const createTarget: CreateTarget = async () => {
  const server = await startMyServer();
  return {
    baseUrl: server.url,
    localMode: true,
    pinnedPublicKey: server.publicKey,
    workspace,
    agentA,
    agentB,
    human,
    close: () => server.stop(),
  };
};
```

Then:

```powershell
$env:QUORUM_CONTRACT_TARGET = "packages/server/test/contract-target.ts"; npm test
```

Without `QUORUM_CONTRACT_TARGET` the suite is skipped (there is no server yet in Phase 1's contract step).

## Status codes the contract fixes

The OpenAPI document lists every status; these are the ones the suite pins down where a choice existed:

| Situation                                                         | Status                      |
| ----------------------------------------------------------------- | --------------------------- |
| No token or invalid token                                         | 401                         |
| `from` does not match the token (INV-7)                           | 403                         |
| Agent sends `approval_decision` (INV-1)                           | 403                         |
| Schema violation, incl. server-assigned fields sent by the client | 400, with `error.path`      |
| Same message `id`, different content                              | 409                         |
| Same message `id`, identical content                              | 200 with the original `seq` |
| Body over 96 KiB                                                  | 413                         |
| Foreign `Host` header in local mode (INV-26)                      | any 4xx                     |

## Not covered yet

Added to the API after the fake server was built, so the suite does not test them yet; the cases come with the real server (Track A), and the fake server gains them through the usual RFC flow (TEAM_PLAN §5.3):

- `POST /v1/auth/local-bootstrap`: works once, refuses expired, reused and wrong codes, answers 404 in remote mode.
- `PATCH /v1/attachments/{attachment}`: humans only, unknown fields rejected, change recorded in the log.
- `GET …/inbox` without `after`: starts after the caller's last acknowledged `seq`.
