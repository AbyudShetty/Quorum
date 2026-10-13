# Session pairing (DECISIONS D-20)

Status: **design, being built** (Phase 1b, replaces invite/join). Decided by abyud on 2026-10-13; abhijna to review on return.

## 1. What the person does

After `npm install -g @quorumhq/quorum`, five commands exist in every Claude Code and Codex session, in every folder:

| Claude Code             | Codex                   | What it does                                                                                                    |
| ----------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `/quorum-id`            | `$quorum-id`            | This session joins Quorum and shows its ID, e.g. `QRM-7KD2-PX9F-M3TA`. The ID belongs to it for life.           |
| `/quorum-attach <id>`   | `$quorum-attach <id>`   | Ask to link this session with the session that has that ID. The other person approves.                          |
| `/quorum-detach [<id>]` | `$quorum-detach [<id>]` | Unlink (one link, or all). The other side is not asked.                                                         |
| `/quorum-block <id>`    | `$quorum-block <id>`    | Never hear from that session again; to it, this session's ID looks like one that does not exist.                |
| `/quorum-export`        | `$quorum-export`        | Write this session's conversations with all its links to `quorum-<tool><n>.md` in the folder (kept out of git). |

A session that never runs `/quorum-id` or `/quorum-attach` never joins: no ID, no mail, no wakes. A link lasts until one side detaches; it survives resuming the session (`/clear` starts a new session with no ID).

**Approving.** When someone attaches to your session, the request waits until that session is open in its folder (running, or the next time you resume it). Then you see, at your next prompt:

```
Quorum: claude@laptop-a - ~\proj\api - 3 (QRM-7KD2-PX9F-M3TA) wants to link with this session.
Type /quorum-allow to link, /quorum-block QRM-7KD2-PX9F-M3TA to block it; anything else leaves it waiting.
```

(`/quorum-allow`, and `$quorum-allow` in Codex, is the sixth command: the answer to a request.)

**Groups.** Links are between two sessions and are all equal. A session linked to several others is the "orchestrator" shape; sessions all linked to each other are peers. Who leads is said by the humans in their prompts, not decided by the agents (plan §4.1).

## 2. Why the commands are safe

The commands are caught by Quorum's hook **from the text the person typed**, before the model runs: Claude Code's `UserPromptExpansion` event (fires only for commands a person types, never when Claude runs one) and Codex's `UserPromptSubmit` (the raw prompt; skills are typed as `$name`). The hook does the work, blocks the prompt (no tokens are spent) and shows the result. An agent cannot type a prompt, so an agent can never link, approve or detach on its own, even if a message asks it to (INV-30, plan §4.2). Verified live on Claude Code 2.1.287 and Codex 0.162.1 (2026-10-13).

## 3. How it works

- **Every laptop runs its own Quorum server** (as today, loopback only) and, once any of its sessions has an ID, connects out to the relay as a home (ARCHITECTURE §8.4).
- **IDs** are short and self-certifying: `QRM-` + the first 60 bits (12 Crockford base32 characters) of `SHA-256("quorum-id/1\n" + home key fingerprint + "\n" + a random 16-byte value)`. The relay keeps a **phone book**: ID → home fingerprint and that random value. A lookup must return both, and the asking server recomputes the ID, so a relay that lies about where an ID lives is caught (forging one would take about 2^60 hash attempts). The relay stores only these entries, rate-limits lookups, and never learns who is linked to whom.
- **Linking.** `/quorum-attach <id>` asks this laptop's server, which looks the ID up, connects to the other server through the relay (TLS to its pinned key, INV-33) and hands over a link request signed with its own instance key and its session's ID. The other server checks the signature against the requester's ID the same way, and queues the request for that session. On `/quorum-allow`, both servers record the link.
- **Messages.** An agent sends with `quorum_send` to a linked session (its sender line, as today). Its server stores the message and forwards it, signed, to the other server, which stores it and delivers it to the session the usual way (hooks, idle wake). Each server keeps its own copy; either side can export. If the other laptop is off, the sender's server keeps the message and retries until it is delivered (INV-20).
- **Same laptop:** the same, without the relay.
- **Blocking and wrong IDs** get the same answer, "no such ID": the relay for an unknown ID, the other server for a blocked one.

## 4. Install

`npm install -g` runs a setup step that writes, at user level: Quorum's hooks (`~/.claude/settings.json`, `~/.codex/hooks.json`), its MCP server (`quorum mcp`, for the `quorum_*` tools), the six commands (`~/.claude/commands/quorum-*.md`, `~/.codex/skills/quorum-*/SKILL.md`). Hooks of sessions without an ID exit at once. Codex asks the person once to trust the new hooks. Where install scripts are turned off, the first `quorum` command does the same. `quorum uninstall` removes all of it (npm no longer runs anything on uninstall).

## 5. What goes away

`quorum attach`, `invite`, `join`, `join-code`, `remote`, `login <link>`, `login approve`, `workspace`, the per-folder vendor config they wrote, Tailscale/Cloudflare front ends, and asking before mail is read (an approved link replaces it). Kept: `status`, `ui`, `stop`, `relay`, `verify`, `uninstall`.

## 6. Build order

1. ✅ Hook exits on Windows (no forced exit).
2. ✅ Hooks can catch the commands (both vendors, verified live).
3. The relay phone book (IDs, lookups, rate limits).
4. Server-to-server links: requests, approval, signed messages, retries.
5. The commands in the hooks; export.
6. Install-time setup and `quorum uninstall`.
7. Remove the old commands and their docs.

**Phase 1b exit (replaces the previous one):** a Claude Code session on laptop A and a Codex session on laptop B, on different networks, pair with `/quorum-id` and `/quorum-attach` and exchange messages, from `npm install -g` alone, in under 5 minutes; a session that never ran a command is not reachable; a blocked session sees "no such ID"; the relay cannot read or alter messages (INV-33); all Phase 1 exit criteria still hold.
