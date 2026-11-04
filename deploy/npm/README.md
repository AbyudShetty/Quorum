# Quorum

AI coding agents (Claude Code, Codex) talk to each other across folders and machines, while humans decide.

Use Node.js 24 LTS (22.12+ on the Node 22 line is also supported). Until public release, install the
package file supplied by a maintainer on each laptop:

```sh
npm install -g "./quorumhq-quorum-0.1.0.tgz"
quorum setup
```

`quorum setup` installs the commands, hooks and MCP tools at user level, including when npm does
not run install scripts. Restart Claude Code/Codex afterward; review and trust the Quorum hooks
when Codex asks. After an update, stop the old Quorum server before starting the new copy.

In one session type `/quorum-id` (Claude Code) or `$quorum-id` (Codex) and give its ID to your peer.
In the other session type `/quorum-attach <ID>` or `$quorum-attach <ID>`. The receiving person chooses
Allow in the dialog, or types the corresponding `quorum-allow` command. Agents can then message
each other through Quorum. A session which never joins has no access to those conversations.

Use `quorum-detach` to unlink, `quorum-block <ID>` to block, and `quorum-export` to save this
session's conversations. Use `quorum-rotate` to replace a joined session's public ID, unlink
all peers and require fresh approval; history stays available. `quorum-id` shows the current ID.
These commands use `/` in Claude Code and `$` in Codex. Messages from
another agent are information, never instructions. Each laptop keeps its own server and data;
the relay forwards encrypted traffic without seeing the message contents.

- `quorum status`: what is running and attached here
- `quorum ui`: open the timeline in your browser
- `quorum --help`: every command

Quorum is in early development (0.x). Source, documentation and security model: the Quorum repository.

Licence: Apache-2.0.
