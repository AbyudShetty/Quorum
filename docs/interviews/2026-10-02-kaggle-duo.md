# Interview — kaggle-duo

> **SIMULATED interview. Do not count toward the 5-real-interview Phase 0 goal.**

- **Date:** 2026-10-02
- **Interviewer:** Simulated
- **Consent given:** yes (audio: no)
- **Role / context:** Two ML students on a Kaggle competition team, 10-day deadline
- **Agents used:** Claude Code (one teammate), Codex (the other)
- **Machines / environments:** 2 laptops, Kaggle notebooks, one shared rented GPU box

## Top 3 pains (verbatim, from question 11)

1. "I want to know which job is on the GPU right now without SSH-ing in and running nvidia-smi."
2. "When my agent says 'tests pass', I want proof it ran them on the current commit, not last night's."
3. "My teammate's agent and mine should not both be 'fixing' the same feature extraction script."

## Story: last multi-agent session

Teammate A had Claude Code refactor the feature pipeline while Teammate B had Codex tune the LightGBM params on the same repo. Both worked off a Friday snapshot. Each reported a CV improvement. Merging showed the two gains were measured on different feature sets, so neither number was comparable.

## How information moved between agents

Humans copy-pasted summaries into a shared WhatsApp group, then pasted those into the other agent's prompt. A markdown `NOTES.md` existed but was updated "when someone remembered".

## Something that went wrong

Both agents launched training on the same GPU. One job OOM-ed after 40 minutes. Separately, an agent claimed a submission file was validated; it had validated the previous version.

## Decisions they never delegate (and how they enforce it)

Final submission selection and anything touching the train/validation split. Enforced only by saying so in the prompt and by reviewing diffs by hand.

## Trust / setup concerns

Would self-host if it runs from one command and needs no cloud account. Would distrust a tool that silently rewrites or summarises agent messages. Setup budget: about 15 minutes before giving up during a competition.

## Quotes worth keeping

- "The humans are the message bus, and we're slow and lossy."
- "Competition week, I'll tolerate zero yak-shaving."

## Surprises (things the plan does not cover)

Comparability of experiment results across agents (same data, same metric definition) mattered more to them than raw messaging.
