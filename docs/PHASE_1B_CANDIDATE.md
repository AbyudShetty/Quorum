# Phase 1b candidate handoff

This is a private manual-test candidate, not a phase exit or public release.

## Implemented

- Invocation-bound pairing MCP identity for both vendors; no last-active or PID fallback.
- Serialized pairing-state changes, duplicate-join protection and PID/token file locks.
- One-use, tool/argument-bound, expiring proofs with quota and replay protection.
- Cancellation races: newer detach/block/revocation/rotation choices win.
- Hosted relay rate limits and safe malformed lookup handling on both fronts.
- Human `/quorum-rotate` / `$quorum-rotate`, with durable expected-ID retry receipts,
  retired IDs, fresh pairing consent, preserved history and blocks, and stale cache recovery.
- Setup revision 6 installs all seven commands, honors active vendor profiles and retries incomplete upgrades.
- Updated pairing install instructions and packaging without stale compiled modules.
- Mixed Node-runtime compatibility through Node 27 prerelease; no Node-24-only prerequisite.
- Node-executable-change hook repair, automatic setup on bare invocation, safe native-runtime
  guards, and bounded proof cleanup under Windows load. See [COMPATIBILITY.md](COMPATIBILITY.md).
- Read-only `quorum doctor`, BOM-aware settings reads, preserved unreadable config and private
  setup-state creation, with separate checks of relay HTTP and WebSocket reachability.

Details: [adapter hardening](PHASE_1B_ADAPTER_HARDENING.md),
[rotation RFC and approval record](rfcs/ID_ROTATION.md).

## Verification and artifact

`npm run check` passed on **Node 25.2.0** after the compatibility fixes: formatting, ESLint,
TypeScript, build and the complete suite (**993 tests passed, 35 skipped; 72 test files passed**).
The skipped standalone-contract/opt-in cases do not replace live vendor/network exit evidence.
The real and fake contract targets run in the normal suite. These results do not close the phase.

`npm run pack:release` rebuilt `deploy/npm/out/quorumhq-quorum-0.1.0.tgz` (104 files). A fresh
isolated install with scripts disabled passed native module loading, CLI startup, automatic
setup, SQLite migration and real TLS relay tests under every runtime pair below. The
packaged dependency manifest requires patched Fastify `^5.12.8` and Zod `^4.6.7` minimums.
Both CLI and database entry points now enforce Node-API 10 before native loading. The former
22.12 minimum was reproduced as a native crash; actual 22.12 binaries now fail clearly and safely.

| First home         | Second home        | Windows x64 packaged regression |
| ------------------ | ------------------ | ------------------------------- |
| 22.14.0            | 27.0.0-alpha.0.0.0 | passed                          |
| 23.6.0             | 25.2.0             | passed                          |
| 24.22.2            | 26.13.0            | passed                          |
| 25.2.0             | 27.0.0-alpha.0.0.0 | passed                          |
| 26.13.0            | 22.14.0            | passed                          |
| 27.0.0-alpha.0.0.0 | 24.22.2            | passed                          |

Each pair uses separate server processes and tests explicit consent, bidirectional delivery,
rotation with durable retries, retained history and blocking. Temporary profiles include spaces
and Unicode. The final package also passed installation in a path containing an ampersand,
read-only doctor checks before setup, and setup with custom Claude and Codex profile directories.
Linux/macOS and additional architectures are not claimed as locally tested: new
CI jobs exercise the package on those OS runners. Node 27 is currently prerelease.

SHA-256:

```text
3215058ce1df1dae33d7f844823b683af93aee7280315888bbf54a7ac44d9ee4
```

Additional Node executables live only in ignored test storage; the system Node installation was
not changed. Smoke tests use disposable profiles. The verified candidate was also installed over
the existing global `@quorumhq/quorum` package with scripts disabled; the old `@quorum/cli` link
is absent. The next ordinary invocation can repair setup; restart vendor sessions before testing.
The earlier 911/958-test results and checksums describe older builds. Do not identify the candidate
by its `0.1.0` filename alone. The expanded GitHub CI matrix must pass before release.

## Remaining gates

1. **Hosted Worker update:** deploy the revised source using the maintainer guide in
   `packages/relay/worker/README.md`; record the deployment. Local tests do not update the hosted copy.
2. **Live exit run:** [checklist](PHASE_1B_EXIT_TEST.md), including rotation, both vendors' updated
   hooks trusted, normal permission prompts preserved, and the same package checksum on both laptops.
3. **After a successful exit run:** legacy-command removal and a short regression smoke test,
   as agreed in the October 19 review. Phase 2 starts only after Phase 1b is formally closed.

The rotation implementation follows Abyud's reported discussion with Abhijna. The shared RFC,
schemas and tests are included together for the existing joint review flow; no GitHub approval,
merge or phase-exit acceptance is implied. D-1 and D-5 remain open.

## Dependency audit remediation

`npm audit --audit-level=high` passed with **zero vulnerabilities**. `npm audit signatures`
passed: **278 verified registry signatures, 76 attestations**. The audit threshold and CI
workflow are unchanged; install scripts remain disabled by `.npmrc`.

| Dependency  | Patched locked version |
| ----------- | ---------------------- |
| body-parser | 2.4.0                  |
| fast-uri    | 3.1.9 / 4.2.3          |
| Fastify     | 5.12.8                 |
| ip-address  | 10.7.6                 |
| qs          | 6.17.1                 |
| Vite        | 8.3.5                  |
| Zod         | 4.6.7                  |
| minimatch   | 11.0.4                 |

The minimatch advisory's fix starts at version 11; the audit tool's suggested downgrade to
ESLint 4 would break the existing tooling. Scoped overrides apply only under `eslint`,
`@eslint/config-array` and `@typescript-eslint/typescript-estree`. Their installed call sites use
the retained `Minimatch` constructor, `.match`, `.pattern` and `minimatch()` APIs, not the APIs
removed in version 11. Its Node engine range includes both supported Node lines. The new
transitive `@isaacs/nonrecursive-glob-match` helper is from the same maintainer and uses the
existing BlueOak-1.0.0 license. No direct project dependency or ESLint version changes.
See [the advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249) and
[the upstream changelog](https://github.com/isaacs/minimatch/blob/main/changelog.md).

## Changed files

The earlier ID-rotation/hardening change was committed by the human. This follow-up changes
runtime compatibility, onboarding and proof-scan performance. Use `git status --short` and
`git diff` to review the current changes before staging.

- CI/contributing: `.github/CONTRIBUTING.md`, `.github/workflows/ci.yml`.
- Root: `CHANGELOG.md`, `README.md`, `package.json`, `package-lock.json`.
- Test configuration: `config/vitest.config.ts` bounds Windows workers to avoid filesystem contention.
- Packaging: `deploy/npm/{README.md,manifest.json,pack.mjs,runtime-smoke.mjs}`.
- Docs: `docs/{COMPATIBILITY.md,DECISIONS.md,PHASE_1B.md,PHASE_1B_CANDIDATE.md,PHASE_1B_EXIT_TEST.md}`.
- Hooks: `packages/adapter-hooks/src/tool-proof.ts`, `packages/adapter-hooks/test/tool-proof.test.ts`.
- CLI: `packages/cli/bin/{quorum.js,runtime.js}`,
  `packages/cli/src/{cli.ts,run.ts,doctor.ts,vendor-paths.ts,user-config.ts,vendor-config.ts}`,
  `packages/cli/test/{cli.test.ts,runtime.test.ts,doctor.test.ts,user-config.test.ts}`.
- Server: `packages/server/src/storage/database.ts`, `packages/server/test/runtime.test.ts`.
- Packaging regression: `tests/repo/release-package.test.ts`.

Security properties touched: INV-7/12/25/34 for proof quota/cleanup, INV-25 for safe runtime
initialization and native credential handling, INV-33/34 for mixed-runtime federation tests.
No invariant, wire schema, credential storage rule or phase gate is weakened.

## Commands for the human

No agent has staged, committed, pushed, deployed, published or changed the phase's exit status.
Review the files, then run these from the repository root after the recorded checks pass:

```powershell
git diff --check
git add -- .github/CONTRIBUTING.md .github/workflows/ci.yml CHANGELOG.md README.md package.json package-lock.json config/vitest.config.ts deploy/npm docs/COMPATIBILITY.md docs/DECISIONS.md docs/PHASE_1B.md docs/PHASE_1B_CANDIDATE.md docs/PHASE_1B_EXIT_TEST.md packages/adapter-hooks/src/tool-proof.ts packages/adapter-hooks/test/tool-proof.test.ts packages/cli packages/server/src/storage/database.ts packages/server/test/runtime.test.ts tests/repo/release-package.test.ts
git commit -m "Harden Windows setup and verify mixed Node compatibility"
git push
```

These commands do not install the package on the second laptop or deploy the hosted Worker.
Follow the live checklist after those preparation steps; retain transcripts and evidence.
