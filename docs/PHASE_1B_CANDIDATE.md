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
- Setup revision 5 installs all seven commands, including on an existing revision-4 setup.
- Updated pairing install instructions and packaging without stale compiled modules.

Details: [adapter hardening](PHASE_1B_ADAPTER_HARDENING.md),
[rotation RFC and approval record](rfcs/ID_ROTATION.md).

## Verification and artifact

`npm run check` passed on supported **Node 24.22.2**: formatting, ESLint, TypeScript, build and
the complete suite (**958 tests passed, 35 skipped; 69 test files passed**). The four additional
skips are the rotation cases in the standalone contract suite without a target; each also runs
and passes against the real and fake targets. Live vendor/network exit checks still require the
manual checklist; these results do not close the phase.

`npm run pack:release` rebuilt `deploy/npm/out/quorumhq-quorum-0.1.0.tgz` (100 files). A fresh
isolated install with scripts disabled successfully loaded the packaged CLI, recognized the
rotation command and opened/migrated/closed SQLite at schema version 6 on Node 24.22.2. The
packaged dependency manifest requires patched Fastify `^5.12.8` and Zod `^4.6.7` minimums.
The three packaging regressions passed again after these metadata changes.

SHA-256:

```text
cf378b3f2b0d92290d5bc9cd26e146463b0f8c1be7211f1b393e56b437eb03da
```

Supported-runtime verification uses a temporary Node 24 executable in ignored test storage;
the system Node installation and live vendor profiles stay unchanged. The earlier 911-test
result and tarball checksum describe an older build. Do not identify the candidate by its
`0.1.0` filename alone; earlier tarballs used the same name. Node 22 and Linux remain covered
by the existing CI matrix and must pass there before release.

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

The complete implementation also includes the earlier pre-exit hardening in this working tree.
Use `git status --short` and `git diff` to review before staging.

- Root: `CHANGELOG.md`, `README.md`, dependency manifests and lockfile.
- Packaging: `deploy/npm/README.md`, `deploy/npm/pack.mjs`, `tests/repo/release-package.test.ts`.
- Shared docs: `ADAPTER_CONTRACT.md`, `DECISIONS.md`, `MESSAGE_SPEC.md`, `PAIRING.md`,
  `THREAT_MODEL.md`, `PHASE_1B.md`, `PHASE_1B_ADAPTER_HARDENING.md`, `PHASE_1B_CANDIDATE.md`,
  `PHASE_1B_EXIT_TEST.md`, `TRACK_B_PAIRING_ISSUES.md`, `rfcs/ID_ROTATION.md`.
- Schemas: API payload types/schemas, revision export, OpenAPI source/generated JSON and tests
  in `packages/schemas`.
- Contracts: `tests/contract/{README.md,contract.test.ts,target.ts}`;
  `tests/fakes/fake-server/{fake-server.ts,contract-target.ts}`.
- Hooks: `src/{index.ts,pairing.ts,tool-proof.ts}` and
  `test/{pairing-concurrency.test.ts,tool-proof.test.ts,rotation.test.ts}` in `packages/adapter-hooks`.
- MCP: `package.json`, `src/{client.ts,pairing-mcp.ts}` and `test/client.test.ts` in `packages/adapter-mcp`.
- CLI: `src/{cli.ts,user-config.ts,pairing-tools.ts}` and
  `test/{user-config.test.ts,pairing-tools.test.ts,pairing-commands.test.ts}` in `packages/cli`.
- Local: `src/{file-lock.ts,start-lock.ts}` and `test/file-lock.test.ts` in `packages/local`.
- Relay: `README.md`, `src/node.ts`, `worker/index.js`, `test/{relay.test.ts,worker.test.ts}`
  in `packages/relay`.
- Server: `package.json`, `src/{http/app.ts,local/serve.ts,relay/federation.ts,service/quorum.ts,storage/database.ts,storage/registry.ts}`
  and `test/{contract-target.ts,pairing.test.ts,pairing-races.test.ts,pairing-rotation.test.ts}`
  in `packages/server`.

## Commands for the human

No agent has staged, committed, pushed, deployed, published or changed the phase's exit status.
Review the files, then run these from the repository root after the recorded checks pass:

```powershell
git diff --check
git add -- CHANGELOG.md README.md package.json package-lock.json deploy/npm/README.md deploy/npm/pack.mjs docs/ADAPTER_CONTRACT.md docs/DECISIONS.md docs/MESSAGE_SPEC.md docs/PAIRING.md docs/THREAT_MODEL.md docs/PHASE_1B.md docs/PHASE_1B_ADAPTER_HARDENING.md docs/PHASE_1B_CANDIDATE.md docs/PHASE_1B_EXIT_TEST.md docs/TRACK_B_PAIRING_ISSUES.md docs/rfcs/ID_ROTATION.md packages/adapter-hooks packages/adapter-mcp packages/cli packages/local packages/relay packages/schemas packages/server tests/contract tests/fakes/fake-server tests/repo/release-package.test.ts
git commit -m "Complete human ID rotation and harden Phase 1b readiness"
git push
```

These commands do not install the package on the second laptop or deploy the hosted Worker.
Follow the live checklist after those preparation steps; retain transcripts and evidence.
