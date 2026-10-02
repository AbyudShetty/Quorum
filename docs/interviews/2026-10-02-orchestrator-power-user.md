# Interview — orchestrator-power-user

> **SIMULATED interview. Do not count toward the 5-real-interview Phase 0 goal.**

- **Date:** 2026-10-02
- **Interviewer:** Simulated
- **Consent given:** yes (audio: no)
- **Role / context:** Senior backend engineer, runs 5 to 8 agents in parallel via tmux and a homemade orchestrator script
- **Agents used:** Claude Code (most), Codex, Gemini CLI
- **Machines / environments:** Workstation, two remote dev servers, git worktrees

## Top 3 pains (verbatim, from question 11)

1. "Tell me which of my eight agents is stuck, not just that eight are running."
2. "Agent claims need receipts. 'Done' should link to a diff and a test run."
3. "Cross-vendor handoff. My Claude agent finishes and my Codex agent should pick up without me."

## Story: last multi-agent session

Spawned a planner agent that split a refactor into six tasks across worktrees. Four finished; one looped on a failing test for an hour; one waited on a permission prompt nobody saw. He discovered both only when checking manually after lunch.

## How information moved between agents

Via files in a shared `tasks/` directory and a polling shell script. Brittle: format drift between vendors broke parsing several times.

## Something that went wrong

An agent marked a task complete after a mocked test passed, and downstream agents built on code that did not work. Cost half a day of rework.

## Decisions they never delegate (and how they enforce it)

Architecture choices and anything affecting public API shape. Enforced by making the planner produce a plan he approves before workers start.

## Trust / setup concerns

Self-hosting is no problem. Requires an open protocol and no vendor lock-in. Would not trust a layer that can reorder or drop messages without logging it.

## Quotes worth keeping

- "Spawning agents is solved. Supervising them isn't."
- "I don't want a dashboard to look at. I want to be paged when something's wrong."

## Surprises (things the plan does not cover)

Wants stuck-detection (loop and permission-prompt waits) and evidence-backed completion claims. Treats alerting as primary, a dashboard as secondary.
