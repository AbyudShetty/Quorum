# Runtime and platform compatibility

Quorum requires **Node.js 22.14+, 23.6+, or a newer major**, providing **Node-API 10**. Devices do not need matching Node versions, operating
systems, home paths or CPU architectures: each runs its own local server, and they communicate
through the versioned, signed/TLS-protected Quorum protocol. Node major parity is not a gate.
Node 24 in `.nvmrc` is an optional developer default, not an installation prerequisite.

## Runtime coverage

The packaged-runtime test runs independently of Vite, Vitest, TypeScript and ESLint. Those are
developer tools; their narrower engine declarations must not become requirements for people
installing the release. The product needs Node-API 10 because of its SQLite native dependency;
older Node versions are not made compatible by editing `engines` or downgrading security fixes.

CI exercises the installed tarball on Node 22.14, 23, 24, 25, 26 and the available Node 27
prerelease. Each test starts two actual home-server processes, varying their Node executables,
routes traffic through a local TLS relay, requires approval, exchanges messages both ways, rotates
an ID, checks retained history and tests blocking. The peer uses Node 24. No shared runtime or
workspace dependency links are required. Main source checks additionally run on Node 22, 24 and 26.
The Node 24 pair is a same-version baseline; the other jobs exercise mixed runtimes.

Node 27 is prerelease as of this change. Compatibility testing is not a promise that every later
prerelease will work. Upstream security maintenance is separate from application compatibility:
use maintained runtime releases for deployments. Official schedule:
[Node.js releases](https://nodejs.org/en/about/previous-releases).

The old declared minimum of 22.12 was incorrect for the shipped `better-sqlite3` 13 binding.
Local Windows tests reproduced a native crash opening an in-memory database at 22.12; 22.14
and 23.6 open it successfully. The upstream binding explicitly requests `NAPI_VERSION=10`.
Both the CLI and `openDatabase` check the requirement before native initialization, replacing
a hard crash with a useful message on older patches. No security fix or native dependency is
downgraded. This boundary follows the official [Node-API matrix](https://nodejs.org/api/n-api.html#node-api-version-matrix)
and matches the [upstream issue](https://github.com/WiseLibs/better-sqlite3/issues/1514).

## Operating systems and native dependencies

Windows, macOS and Linux use the same npm package. CI includes all three operating systems;
local execution on this workstation can verify Windows only. New Linux/macOS jobs must pass
in GitHub before their results are treated as verified.

SQLite and the OS keychain use Node-API native bindings. Their packaged architecture builds,
not the Node major's V8 ABI, determine native availability. SQLite ships Windows/macOS x64 and
arm64 plus Linux glibc/musl x64 and arm64 builds. This inventory alone does not prove every
architecture/distro works: the packaged smoke loads both bindings and prints the actual tested
platform/architecture. Do not claim mobile, 32-bit, FreeBSD or an untested architecture as covered.

Windows uses Credential Manager; macOS uses Keychain; Linux requires a running Secret Service
and appropriate session/D-Bus access. A headless/container Linux session without that service
cannot persist Quorum credentials. There is no plaintext fallback (INV-25). Headless CI checks
native loading and federation without claiming a desktop-keychain round trip; the normal test
suite probes and exercises a real keychain where available.

Vendor-specific live hooks, GUI approval behavior, network/firewall conditions and hardware
architectures outside the runners remain part of real-device testing. Cross-runtime tests
support interoperability; they do not replace the two-person Phase 1b exit run.

## Installation and upgrades

- Install the release tarball; source workspaces and `npm link` are development setups.
  To migrate an old globally linked `@quorum/cli`, first run `npm uninstall -g @quorum/cli`,
  then install `@quorumhq/quorum` from the new tarball. npm owns the launcher; do not overwrite
  unrelated binaries or use `--force` to conceal a collision.
- Install-time setup is automatic. If npm disables scripts, the first ordinary invocation,
  including bare `quorum`, attempts setup. Explicit `quorum setup` remains a recovery command.
- Setup checks both the package path and Node executable path. A version-manager switch that
  changes `process.execPath` refreshes generated hooks/MCP commands on the next ordinary invocation.
  Restart already open vendor sessions afterward so they read the updated configuration.
- Stop the old Quorum server before upgrading and restart/resume agents afterward. On Windows,
  loaded native DLLs can prevent cleaning a development `node_modules`; the release installation
  is separate from the source tree. Stop affected development Quorum processes before a clean
  source install; do not kill every Node process or delete live credential/database directories.
- Different Node versions do not bypass protocol, key pinning, consent, identity, block or schema
  checks. No security property or schema version changes for runtime compatibility.
- Pending tool-proof scans use bounded filesystem concurrency under the existing mint lock.
  This keeps a full proof directory from exhausting Windows hook deadlines; the expiry rules,
  1024-record quota and one-use consumption remain unchanged. A last-slot race regression pins
  the quota under concurrent minting.

## Running the packaged regression

Before a live run, use `quorum doctor` on both devices (or `quorum doctor --offline` without
network checks). It checks the current runtime/launcher, private data directory, setup receipt,
vendor hooks/MCP presence, credential-store reads and relay HTTP plus WebSocket connectivity.
It does not create profiles, start a local home, write credentials or modify firewall/TLS settings.
It cannot prove vendor hook trust, full TOML validity, peer identity or GUI approval behavior;
those remain live checks. Keychain errors are reported without their raw contents.

Setup/uninstall honor the active `CODEX_HOME` and `CLAUDE_CONFIG_DIR`, including the relocated
Claude `.claude.json`. Use absolute profile paths. `QUORUM_HOME` should also be absolute so
hooks in different project folders do not select different data/credential scopes. Setup revision
6 caches the selected profile and marks partial/failed upgrades incomplete so repair is retried.
UTF-8 BOM JSON is accepted; unreadable configuration is preserved rather than treated as absent.
See the official [Codex state locations](https://developers.openai.com/codex/config-file/config-advanced)
and [Claude profile locations](https://code.claude.com/docs/en/claude-directory).

After building the tarball, install it into a disposable prefix with scripts disabled, then run:

```sh
node deploy/npm/runtime-smoke.mjs --package <prefix>/node_modules/@quorumhq/quorum --peer-node <other-node-executable>
```

The coordinator and its first server use the current Node; the second server uses `--peer-node`.
All generated hooks, profiles, keys and databases use private temporary directories, including
paths containing spaces and Unicode. The test never updates the caller's live vendor profiles.
Its output identifies the actual Node pair, OS and architecture. Missing runtimes/native builds,
setup failures and federation errors fail the check rather than silently skipping it.

Local results and the rebuilt package checksum are recorded in `PHASE_1B_CANDIDATE.md` after
verification. Source/CI compatibility changes are not a Phase 1b sign-off or a public release.
