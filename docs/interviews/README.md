# User interviews (Phase 0)

**Goal:** talk to at least 5 people who run multiple AI coding agents (any vendor, ideally across machines) and record their top 3 pains. Interviews test whether plan §1 generalises beyond our own hackathon — they can change the plan, which is the point.

Interviews are done by a human. One file per interview: copy [TEMPLATE.md](TEMPLATE.md) to `YYYY-MM-DD-<alias>.md`. Use an alias, never a real name, unless the person explicitly agrees.

## Who to recruit

- Hackathon/competition teams (Kaggle, ML challenges) — closest to our origin story.
- People running Claude Code + Codex/Gemini side by side; agent orchestrator users.
- Communities: r/ClaudeAI, r/ChatGPTCoding, r/LocalLLaMA, the Claude Code / Codex / Gemini CLI Discords, friends and classmates.
- Aim for variety: at least one person working solo across machines, one team of 2+, one non-ML project.

## Consent (read out at the start)

> "I'm researching how people coordinate multiple AI coding agents. I'll take notes; I won't record audio unless you agree. I'll only keep anonymised notes, and you can ask me to delete them at any time. Is that OK?"

## Script (30 min; ask open questions, don't pitch)

**Warm-up**

1. What do you build, and which AI coding agents do you use? On how many machines?
2. Walk me through the last time more than one agent worked on the same project.

**Pains** (dig into specifics; ask "what did you do then?")

3. How did information move between the agents? Who carried it?
4. Tell me about a time something went wrong between them (wrong file version, two jobs on the same GPU, a claim that turned out false, duplicated work).
5. What decisions do you never let an agent make alone? How do you enforce that today?
6. How do you find out an agent finished or is stuck?
7. What do you wish you could see in one place?

**Trust and setup**

8. Would you run a small self-hosted server for this? What would stop you?
9. What would make you _not_ trust a tool that sits between your agents?
10. How long would you spend setting this up before giving up?

**Close**

11. If you could fix only three things, what are they? (**Record these verbatim as the top 3.**)
12. Anyone else I should talk to?

**Don't** describe Quorum until the end (if at all) — it biases answers.

## Synthesis

After 5+ interviews, fill in the table below and note any plan changes in `docs/DECISIONS.md`.

| Pain (normalised) | # people | Covered by plan? (section) | Notes |
| ----------------- | -------- | -------------------------- | ----- |
|                   |          |                            |       |
