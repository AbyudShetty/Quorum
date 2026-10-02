# Interview — lab-grad-students

> **SIMULATED interview. Do not count toward the 5-real-interview Phase 0 goal.**

- **Date:** 2026-10-02
- **Interviewer:** Simulated
- **Consent given:** yes (audio: no)
- **Role / context:** Two PhD students sharing a university GPU cluster for a vision paper deadline
- **Agents used:** Claude Code, Gemini CLI
- **Machines / environments:** Laptops, SLURM cluster login node, Colab for quick tests

## Top 3 pains (verbatim, from question 11)

1. "Know who's using which GPU before my agent submits another job."
2. "Agents shouldn't change anything in the shared dataset directory. Ever."
3. "My labmate's agent and mine keep both rewriting the same eval script."

## Story: last multi-agent session

Student A asked Claude Code to launch ablations while Student B asked Gemini CLI to debug a dataloader. Both agents edited `eval.py` independently. Student B's run used the older metric definition, so the tables in the paper draft disagreed.

## How information moved between agents

Lab Slack and a shared Google Doc of "who's running what". Agents had no access to either, so the students retyped relevant bits into prompts.

## Something that went wrong

An agent queued 12 jobs and exhausted the lab's fair-share quota, delaying a labmate's deadline run by two days. The agent said it had "checked availability", but it had only read a stale cached queue listing.

## Decisions they never delegate (and how they enforce it)

Anything that deletes or modifies datasets, and quota-consuming submissions over a certain size. Enforced by trust and by chmod on the data directory.

## Trust / setup concerns

Cannot install a server on the cluster without IT approval, so it would need to run on a personal machine and be reachable from the login node. Would not trust anything that stores code or data off-campus.

## Quotes worth keeping

- "IT will say no to anything that opens a port."
- "The agent was confident and wrong, which is worse than being unsure."

## Surprises (things the plan does not cover)

Institutional network and policy constraints may block the self-hosted model. Shared-resource etiquette (quota, fair-share) was a pain separate from GPU conflicts.
