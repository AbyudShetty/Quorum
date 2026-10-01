# Prior art

Status: **re-checked 2026-10-01** (Phase 0). Re-check again before Phase 1 starts and before any public release — this space changes monthly.

Method: project READMEs, official docs and paper abstracts as of the date above. Claims are as stated by each project and not independently benchmarked. "Reuse" means borrow the _idea_ (and, where licences allow, interoperate), not copy code.

## 1. Summary

Since the plan was written, the gap Quorum targets is still open, and research now names it explicitly: a June 2026 analysis of MCP, A2A, ACP and two other protocols found that **voting, dissent preservation, human escalation and audit/replay are absent or only partial** in all of them ([arXiv 2606.31498](https://arxiv.org/abs/2606.31498)). Those are Quorum's governance primitives.

The nearest neighbours either coordinate _coding agents without governance_ (MCP Agent Mail, agmsg, Claude Code agent teams) or _govern agents they run themselves_ (AgentTeams, AXME). None combines cross-vendor coding agents on separate machines with human approval gates, evidence-carrying findings, artifact lineage and resource leases.

## 2. Projects

### A2A (Agent2Agent) — Linux Foundation, v1.0 (12 March 2026)

- **What:** Standard for agent discovery (Agent Cards) and task exchange. v1.0 ships JSON-RPC 2.0, gRPC and HTTP+JSON bindings, plus **signed Agent Cards** (JWS, RFC 7515, over **JCS, RFC 8785** canonical JSON). 150+ organisations; integrated into the major clouds.
- **Reuse:** RFC 8785 JCS as our canonical form (already in MESSAGE_SPEC §3) so Phase 6 interop shares hashing/signing; borrow the task-state vocabulary where it fits; publish Agent Cards in Phase 6.
- **Avoid:** enterprise-scale surface area in the core. Learn from the A2A security analysis ([arXiv 2609.10871](https://arxiv.org/abs/2609.10871), 11 vulnerabilities in three classes):
  - _Cross-client context injection via unprotected context IDs_ → Quorum binds thread/task IDs to the workspace server-side and rejects foreign refs (MESSAGE_SPEC §1).
  - _Credential harvesting through multi-hop delegation_ → Quorum has no credential delegation; agents never forward tokens; grants are single-use and action-bound (INV-3).
  - _Rogue agents advertising unattested capabilities_ → capabilities/scopes are assigned by humans at join time, never self-declared (INV-12).

### MCP Agent Mail (Dicklesworthstone/mcp_agent_mail, plus a Rust port)

- **What:** FastMCP HTTP server for coding agents: memorable identities, inboxes/threads, advisory **file reservations** (exclusive/shared, TTL, optional pre-commit guard), Git-backed Markdown archive + SQLite FTS, web UI with a "Human Overseer" composer, signed static exports. Bearer/JWT auth; cross-machine via HTTP.
- **Reuse:** exclusive/shared lease modes with TTL (added to `lease`), a git pre-commit guard for `path:` leases, clearly labelled human messages, human-readable export alongside JSONL, `doctor`-style diagnostics.
- **Gap for our use:** no cross-agent approval queue, no evidence-carrying findings/retractions, no compute leases, no artifact versioning/lineage, no hash-chained log.
- **Avoid:** a very large tool surface (30+ MCP tools) — Quorum keeps ~8 tools so agents need no training (plan §9).

### agmsg

- **What:** Bash + one shared local SQLite file; Claude Code, Codex, Gemini, Copilot, OpenCode, Antigravity and others message each other; no daemon, no MCP.
- **Reuse:** the bar for simplicity — setup measured in seconds; the generic CLI fallback (plan §10.6) should be this easy.
- **Gap:** single machine, no governance, no identity beyond the file.

### Claude Code agent teams and cross-session messaging (vendor-native)

- **What:** experimental agent teams (lead + teammates, shared task list, mailbox) and cross-session messaging (`ListAgents`/`SendMessage`). **Channels** (research preview): an MCP server can push events into a running session (`claude/channel` capability), with sender gating recommended against prompt injection.
- **Reuse:** the shared task list / mailbox UX as a reference; hooks for between-turn delivery and channels for waking idle sessions (adapter-hooks, ARCHITECTURE §15); the channel docs' advice to gate on sender identity matches our verified-sender framing.
- **Gap:** single vendor; no cross-vendor governance layer.

### Codex (vendor-native extension points)

- **What:** MCP servers (stdio, streamable HTTP) and lifecycle hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, …) with `additionalContext` and a trust review for hooks. No documented way to wake an idle session (checked 2026-10-01).
- **Consequence:** Codex receives Quorum messages at turn boundaries; ARCHITECTURE §15 sets latency targets accordingly.

### AgentTeams (agentscope-ai/AgentTeams) — Apache-2.0, ~5.7k stars, v1.2.4 (Sep 2026)

- **What:** "Collaborative multi-agent OS" with a manager–workers model; humans and agents share **Matrix rooms**; AI gateway keeps real credentials away from workers; MinIO shared files; Kubernetes control plane.
- **Closest in spirit** (human-in-the-loop, auditability), but it runs its _own_ agent runtimes rather than the coding agents people already use, and needs Matrix + MinIO + Kubernetes.
- **Reuse:** "no hidden agent-to-agent calls" — everything visible in one timeline; keep credentials out of agents' hands.
- **Avoid:** heavy infrastructure; Quorum stays one process + SQLite (plan §4.7, five-minute setup).
- **Gap:** no evidence/retraction protocol, no compute leases documented, not built around Claude Code/Codex/Gemini CLI.

### AXME (AxmeAI) — durable execution with human approval gates

- **What:** durable workflows where agents, services and humans coordinate; several human task types (approval, review, clarification…), reminders/escalation/timeouts, kill switch enforced at a gateway; open protocol + managed cloud.
- **Reuse:** approval **reminders and escalation** (without ever auto-approving), and a **kill switch enforced server-side** (our instant mute/revoke, INV-13).
- **Avoid:** dependence on a managed cloud; Quorum must be fully self-hosted and free.

### Agent orchestrators (Composio Agent Orchestrator, Conductor, Nimbalyst, …)

- **What:** run many agents in parallel git worktrees on one machine, supervised from one surface.
- **Relationship:** complementary — they _launch_ agents; Quorum _coordinates and governs_ agents that already run on many machines. Worth an integration later, not competition.

## 3. Decisions taken from this review

1. Keep positioning: governance + trust layer, not raw messaging (plan §3 holds).
2. Adopt RFC 8785 JCS now (A2A compatibility).
3. Add `mode: exclusive|shared` to leases (MCP Agent Mail).
4. Capabilities are human-assigned, never self-declared (A2A security findings).
5. Preserve dissent: rejections need a comment; contradicting findings are kept, never deleted (governance-gaps paper).
6. Approvals get reminders and escalation, never auto-approval (AXME, INV-4).

## 4. Sources

- A2A v1.0 / Linux Foundation: <https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year>, <https://opensource.googleblog.com/2026/04/a-year-of-open-collaboration-celebrating-the-anniversary-of-a2a.html>
- A2ABreak security analysis: <https://arxiv.org/abs/2609.10871>
- Governance gaps in agent protocols: <https://arxiv.org/abs/2606.31498>
- MCP Agent Mail: <https://github.com/dicklesworthstone/mcp_agent_mail>
- agmsg: <https://agmsg.cc/> (many GitHub forks exist; confirm the canonical repository before linking it)
- Claude Code agent teams: <https://code.claude.com/docs/en/agent-teams>; cross-session messaging: <https://code.claude.com/docs/en/cross-session-messaging>; channels: <https://code.claude.com/docs/en/channels-reference>; hooks: <https://code.claude.com/docs/en/hooks>
- Codex hooks: <https://developers.openai.com/codex/hooks>; Codex MCP: <https://learn.chatgpt.com/docs/extend/mcp?surface=cli>
- AgentTeams: <https://github.com/agentscope-ai/AgentTeams>
- AXME: <https://github.com/AxmeAI/axme>
- Orchestrator overview: <https://www.augmentcode.com/tools/open-source-agent-orchestrators>
