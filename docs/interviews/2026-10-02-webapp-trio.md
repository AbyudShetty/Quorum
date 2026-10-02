# Interview — webapp-trio

> **SIMULATED interview. Do not count toward the 5-real-interview Phase 0 goal.**

- **Date:** 2026-10-02
- **Interviewer:** Simulated
- **Consent given:** yes (audio: yes)
- **Role / context:** Three-person startup team building a Next.js SaaS product (non-ML)
- **Agents used:** Claude Code, Cursor, Codex
- **Machines / environments:** 3 laptops, GitHub, a staging server

## Top 3 pains (verbatim, from question 11)

1. "Two agents editing the same file in different branches. Warn me before we collide."
2. "Database migrations must never run without a human. I want that enforced, not requested politely."
3. "A single place showing what each agent is working on and why."

## Story: last multi-agent session

One dev had Claude Code add team-invite emails while another had Cursor rework the auth middleware. Both touched the user model. The merge conflict was resolved by a third agent run, which silently dropped a validation rule.

## How information moved between agents

Through GitHub PR descriptions and Slack. Agents never read Slack, so humans paraphrased decisions into prompts.

## Something that went wrong

An agent generated and ran a migration against staging that renamed a column another feature depended on. Nobody was told until the staging build broke.

## Decisions they never delegate (and how they enforce it)

Schema changes, auth logic, billing code, and dependency upgrades. Enforcement: a CLAUDE.md rule and CODEOWNERS, both of which agents can technically ignore.

## Trust / setup concerns

Needs it to work with all three agents, otherwise it is not worth it. Would not trust a tool that can write to the repo or see secrets in .env files. Setup budget: under an hour, and one person must own it.

## Quotes worth keeping

- "Instructions in a markdown file are a suggestion. I want a gate."
- "Our agents don't know each other exist."

## Surprises (things the plan does not cover)

File-level conflict warning and approval gates for risky actions, which are closer to a workflow-control product than a messaging layer. Interested in audit trails for compliance.
