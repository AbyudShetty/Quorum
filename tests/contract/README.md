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

## Optional hooks

Cases added after the first freeze (bootstrap sign-in, attachment PATCH and DELETE, the inbox default, folder and presence, sessions and shared-working-tree notices) need a little help from the target. `ContractTarget` has optional hooks; a target without one skips the cases that need it:

| Hook                                | Used for                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| `makeFolder(name)`                  | a folder the human can attach (it must exist on the server's machine in local mode) |
| `bootstrap: { dataDir, reissue() }` | reading `local/bootstrap.json` and issuing a fresh code, as a restart does          |
| `advanceClock(ms)`                  | code expiry and the 90 s presence timeout                                           |

Both the real server (`packages/server/test/contract.test.ts`) and the fake server (`tests/fakes/fake-server/contract.test.ts`) run the whole suite on every `npm test`.
