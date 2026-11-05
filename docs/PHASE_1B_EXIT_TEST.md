# Phase 1b: final manual exit run

Status: **not run**. This checklist records evidence; it does not close the phase by itself.
The exit criteria remain in [PHASE_1B.md](PHASE_1B.md), with the accepted pairing design in
[PAIRING.md](PAIRING.md) and decisions D-19 to D-21.

## Before scheduling the run

- Verify that normal vendor approval settings remain effective: configure a Quorum tool to require
  approval, call it from a joined session, and decline once. The tool must not execute. Repeat
  with the tool's approval policy restored and confirm ordinary pairing tools work. Codex requires
  `allow` for PreToolUse input rewriting; this must not turn into a PermissionRequest approval.
  Keep explicit tool denials effective in both vendors. Also exercise nested code-mode MCP calls.

- Finish the session-isolation and hook-state concurrency fixes and their automated regressions.
- Run `npm run check` on the final source. Record its result and the Node version. Supported
  runtime needs Node-API 10 (22.14+, 23.6+, or newer). Both laptops can use their existing
  compatible Node versions; they do not need to match. Record the actual versions and include
  a mixed-version run. Node 24 is an optional development default, not a test prerequisite.
- Run `npm run pack:release` after the last source change. The existing tarball may be older than
  the current code. Copy the newly built file to both laptops; do not reuse an earlier download
  just because the version number and file name match.
- Record the tarball SHA-256 on both laptops and check that it matches:

  ```powershell
  Get-FileHash -Algorithm SHA256 -LiteralPath "deploy\npm\out\quorumhq-quorum-0.1.0.tgz"
  ```

- Confirm that the hosted relay has the required current build. A successful `/health` response
  proves reachability only; it does not identify the deployed source revision. A maintainer
  records the deployment used. This checklist does not deploy anything.
- Keep the legacy commands available until the exit run passes, per the October 19 decision.
  ID rotation is a separate pre-release condition; record its RFC and implementation status.

Use scratch project folders with no private files. Do not delete or reset either person's existing
Quorum data to simulate a clean install. A clean install requires a fresh test OS account or an
otherwise isolated user profile; ordinary user-level hooks and credentials must stay out of it.

## Record the environment

| Field                              | Laptop A             | Laptop B       |
| ---------------------------------- | -------------------- | -------------- |
| Person                             | Abyud                | Abhijna        |
| OS and version                     | pending              | pending        |
| Node and npm versions              | pending              | pending        |
| Agent and version                  | Claude Code: pending | Codex: pending |
| Network                            | pending              | pending        |
| Package SHA-256                    | pending              | pending        |
| Install start / first message time | pending              | pending        |

Use different internet networks, such as one home network and one phone hotspot. Claude-to-Claude
is useful extra coverage but does not replace the specified Claude-to-Codex exit run.

## Install the same package on both laptops

With each agent closed, open PowerShell in the folder containing the tarball:

```powershell
node --version
npm --version
npm install -g ".\quorumhq-quorum-0.1.0.tgz"
```

On A start Claude Code in its scratch project. On B start Codex in its scratch project. Accept
the vendor's prompt to trust Quorum's hooks if it appears.

Record every additional setup command or restart. If npm blocks the package's setup script,
`quorum setup` is the existing recovery command; it must be reported as an extra step when
assessing the "npm install alone" and five-minute requirement. Recovery success is not evidence
that the original clean-install criterion passed.

## Run the cases

Before opening the test sessions, run `quorum doctor` on both laptops. Resolve every FAIL and
record relevant WARN output. Run it in the same environment/profile used to launch the vendor,
especially when CODEX_HOME, CLAUDE_CONFIG_DIR or QUORUM_HOME is customized. Its HTTP/WebSocket
probe establishes reachability; it does not replace pairing, vendor trust or approval tests.

Keep both transcripts. Use a distinct message, such as `A-to-B-01`, for each send so duplicates and
missing messages are visible. Stop at a security failure; retain the evidence before retrying.

| Case                           | Human actions                                                                                                                                                                            | Required result                                                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Join and request (Y1)       | A types `/quorum-id` and gives B the ID. A leaves Claude idle. B types `$quorum-attach <A-ID>`.                                                                                          | A wakes and offers Not now / Allow / Block. The request is pending; no message flows yet.                                                                                     |
| 2. Defer approval              | A picks Not now, or dismisses the dialog. B checks `$quorum-id`.                                                                                                                         | The sessions remain unlinked. An automatic dialog acceptance with no chosen Allow also grants nothing.                                                                        |
| 3. Approve and notify (Y1)     | A opens the waiting request and picks Allow, or types `/quorum-allow <B-ID>`.                                                                                                            | Both sides report the link. B is told once that A accepted, without needing to ask for new mail.                                                                              |
| 4. Message each way (Y1)       | Ask A's agent to send `A-to-B-01` to B's Quorum ID. Then B sends `B-to-A-01`.                                                                                                            | Only the intended sessions receive each message once, with the correct tool, machine, folder and session number. Record elapsed time from install to first delivered message. |
| 5. Reverse request             | In fresh sessions, B types `$quorum-id`; A types `/quorum-attach <B-ID>`. B explicitly approves.                                                                                         | The dialog, approval notification and messaging also work with Codex as the receiving/approving side.                                                                         |
| 6. Long idle                   | Leave the receiving session idle for more than 10 minutes, then send a unique message. Repeat in the other direction.                                                                    | Each idle agent wakes and displays the message. No manual inbox prompt is needed.                                                                                             |
| 7. Unjoined sessions (Y2)      | Open an extra session in another folder and another in the same folder as a joined session. Do not run a Quorum command in them. Ask each for Quorum status/inbox using available tools. | Neither gets the joined session's identity, links, history, mail or ability to send as it. Neither receives a wake.                                                           |
| 8. Resume and new conversation | Resume a joined conversation, then separately start a new conversation or use `/clear`.                                                                                                  | The resumed conversation keeps its identity and links; the new conversation starts unjoined.                                                                                  |
| 9. Detach                      | A types `/quorum-detach <B-ID>`. Attempt a new send in either direction.                                                                                                                 | Both stop messaging through that link. Earlier history remains exportable. There is no approval prompt to detach.                                                             |
| 10. Block and unknown (Y3)     | Relink with explicit consent, then A types `/quorum-block <B-ID>`. From B try attaching A's ID. Also try a well-formed unused ID.                                                        | Both attempts give the same no-such-ID response; B cannot distinguish blocking from an unknown ID. A receives no new request or mail from B.                                  |
| 11. Offline queue              | With an approved pair, close B's agent and stop B's Quorum server. A sends distinct notes. Restart B and resume its conversation.                                                        | Pending messages arrive once and in order. The server or agent being absent never creates an approval.                                                                        |
| 12. Export                     | In a linked session type `/quorum-export` or `$quorum-export`; send one more message and export again.                                                                                   | `quorum-<tool><number>.md` contains that session's conversations and updates on the second export. It contains no tokens and stays outside Git.                               |

For case 11, explicitly stopping the remote Quorum server is needed to test server-to-server
queueing; merely closing its agent leaves its local server able to receive and store messages.
Use `quorum stop` only in the isolated test account, then a Quorum command to start it again.

## Rotate a disclosed ID

With an approved pair and exported history, record A's ID and type `/quorum-rotate` in A.
`/quorum-id` must show the replacement without another rotation. From B, attaching the old ID
must give no such ID and sending through the old link must fail. A's export must retain the
earlier conversation. Give B the new ID: attaching requests fresh approval and no message flows
until A explicitly allows it. Repeat with `$quorum-rotate` on Codex. Resume each vendor's
conversation and confirm its replacement ID persists; a new conversation stays unjoined.

If a command is interrupted, read `/quorum-id` or `$quorum-id` before trying again. Record any
unexpected additional rotation, stale ID display or restored link. Rotation replaces public
contact information; it is not a credential-revocation command.

## Codex bypass-mode approval test (D-21)

Use a fresh Codex session started by the human with:

```powershell
codex --dangerously-bypass-approvals-and-sandbox
```

The human types `$quorum-id` and gives A the ID. A requests a link. Allow the default/automatic
dialog outcome, without choosing Allow. Check both sessions: the link must remain pending and
messages must not flow. Then explicitly choose Allow and confirm that the link works.

Record the actual vendor version and dialog outcome. Do not infer safety from an SDK stand-in;
this case verifies the vendor behavior on which D-21 relies.

## Carry the Phase 1 guarantees forward (Y5)

- On one laptop, a Claude and a Codex session exchange mail with no network configuration.
- Two live sessions in the same Git working tree both receive the shared-worktree warning.
- Stop the local server, send again, and confirm restart/recovery without duplicate delivery.
- Export a workspace's JSONL log with the retained `quorum export` command and verify it with
  `quorum verify`. Change one message word in a separate copy; verification must fail. Keep the
  original export unchanged. This JSONL integrity test differs from the Markdown conversation export.
- Record the passing automated integration, conformance and local security suites from the exact
  build used for the run. The relay encryption/key-pinning regressions support Y4; message exchange
  by itself does not prove that the relay cannot read or alter content.

## Evidence and completion

| Criterion                                                                           | Result                                         | Evidence |
| ----------------------------------------------------------------------------------- | ---------------------------------------------- | -------- |
| Y1: clean install, mixed vendors, different networks, first message under 5 minutes | not run                                        | pending  |
| Y2: an unjoined session is unreachable                                              | not run                                        | pending  |
| Y3: blocked and unknown IDs are indistinguishable                                   | not run                                        | pending  |
| Y4: relay cannot read or alter content                                              | automated evidence exists; confirm final build | pending  |
| Y5: Phase 1 guarantees still hold                                                   | not run                                        | pending  |
| D-21: Codex bypass mode grants no implicit approval                                 | not run                                        | pending  |

Keep error messages, timestamps and `<data>/hooks/commands.log` for failures, without dumping the
data directory, bootstrap code, keychain entries, tokens, database, or unrelated conversation text.
If a fix is needed, rebuild and redistribute the package, record its new checksum, and rerun the
affected cases plus required regression checks.

Only after both maintainers accept the evidence should the status record be updated. Then remove
the legacy commands and stale documentation, run the automated checks again, and carry out a short
pairing smoke test of that cleanup. No Phase 2 implementation starts before Phase 1b is closed.
