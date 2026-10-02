# Fake `/v1` server

Track: **B**. An in-memory `/v1` server for building adapters, the CLI and the web UI before the real server (Track A) has its HTTP endpoints. A test double: no persistence, rate limits or policy engine.

It reuses `@quorum/core` for message acceptance, the inbox and the hash chain, so message rules match the real server by construction. It must pass the contract suite (`contract.test.ts` runs it on every `npm test`), which keeps the two from drifting apart.

## Use it in a test

```ts
import { startFakeServer } from '../fakes/fake-server/fake-server.js';

const server = await startFakeServer();
const human = server.addHuman('abhijna');
const workspace = server.createWorkspace('demo');
server.join(human.address, workspace);
const agent = server.addAgent('agent:claude-api@abhijna', [workspace], 'claude-code');
// server.baseUrl, server.publicKey (to pin, INV-24), agent.token, agent.refreshToken
await server.close();
```

## Covered endpoints

Everything in `openapi.v1.json` except artifacts: health, hello, refresh (rotating, family revoked on reuse), workspaces, attachments, sessions, messages, inbox, ack, SSE stream with `Last-Event-ID` resume, threads, agents, revoke and export. Local-mode Host and Origin checks (INV-26) are on by default.

## Known differences from the real server

- Heartbeats return a placeholder `seq` and are not recorded (the real server updates presence).
- Sessions do not detect shared worktrees (`shared_worktree_with` is always empty).
- Agent names from `attach` are derived simply, not by the core naming rules.
- No token expiry, rate limits (429) or token scopes (INV-12).
