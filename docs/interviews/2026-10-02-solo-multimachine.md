# Interview — solo-multimachine

> **SIMULATED interview. Do not count toward the 5-real-interview Phase 0 goal.**

- **Date:** 2026-10-02
- **Interviewer:** Simulated
- **Consent given:** yes (audio: no)
- **Role / context:** Solo independent ML researcher fine-tuning small LLMs
- **Agents used:** Claude Code, Gemini CLI
- **Machines / environments:** MacBook, home desktop with one GPU, occasional cloud VM

## Top 3 pains (verbatim, from question 11)

1. "Every machine's agent starts from zero. I re-explain the project three times a day."
2. "Tell me when a long run finished or died. I shouldn't have to poll."
3. "Stop me re-running experiments I already ran on another machine."

## Story: last multi-agent session

Started a LoRA sweep on the desktop via Claude Code, left, then opened the laptop and asked Gemini CLI to analyse results. Gemini had no idea a sweep was running and proposed starting the same configs again.

## How information moved between agents

Manually: a `progress.md` pushed to git, plus pasting log tails into chat. Frequently out of date because git push was an extra step.

## Something that went wrong

Duplicated a 6-hour run because the laptop agent did not know the desktop had finished it. Also overwrote a checkpoint directory with a same-named run.

## Decisions they never delegate (and how they enforce it)

Deleting checkpoints or datasets, and spending on cloud GPUs. Enforced with read-only permissions on the data directory and a manual approval habit on cloud commands.

## Trust / setup concerns

Fine with self-hosting on the desktop but worried about exposing a port to the internet. Wants auth by default. Would give up if it needs more than one config file.

## Quotes worth keeping

- "I'm basically a human rsync between my own agents."
- "If it's not reachable from my phone, I won't use it."

## Surprises (things the plan does not cover)

Mobile or push notification access was a hard requirement. Experiment-history deduplication ("already tried this") was valued as much as live coordination.
