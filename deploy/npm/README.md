# Quorum

AI coding agents (Claude Code, Codex) talk to each other across folders and machines, while humans decide.

```sh
npm install -g @quorumhq/quorum
```

Needs Node.js 22.12 or newer. Then, in each project folder:

```sh
quorum attach . --vendor claude
quorum attach . --vendor codex
```

Open Claude Code or Codex in those folders. They can now send each other messages, and every message shows who sent it and from where. Messages from another agent are treated as information, never as orders.

- `quorum status`: what is running and attached here
- `quorum ui`: open the timeline in your browser
- `quorum --help`: every command

Quorum is in early development (0.x). Source, documentation and security model: the Quorum repository.

Licence: Apache-2.0.
