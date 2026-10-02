# Contributing

Thanks for helping. Quorum is a security-sensitive tool, so the bar is "boring and verifiable".

## Ground rules

1. **Phase order.** Work follows the phases in [QUORUM_PLAN.md](QUORUM_PLAN.md) §13. Don't open PRs for a later phase while the current phase's exit criteria are unmet (status in `docs/PHASE_*.md`).
2. **Definition of done** (plan §19), enforced via the PR template:
   - tests added and passing (unit + relevant integration/adversarial cases);
   - docs updated and a `CHANGELOG.md` entry under `[Unreleased]`;
   - schemas updated and versioned if the protocol changed;
   - no new dependency without a written reason (licence must be permissive and free);
   - security implications noted, naming any invariant (INV-n) from [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) the change touches.
3. **Never weaken a security invariant.** Open an issue to discuss instead.
4. **Open decisions** (plan §17, `docs/DECISIONS.md`) are made by the maintainers; propose, don't decide.

## Setup

```sh
nvm use            # Node 24 LTS (22.12+ also supported)
npm ci
npm run check      # format:check, lint, typecheck, test
```

On Windows, Git is configured by `.gitattributes` to use LF line endings; please don't override it.

## Commits and PRs

- Maintainers: abyud and abhijna. Tracks, branch naming, review rules and the contract-change (RFC) flow are in [docs/TEAM_PLAN.md](docs/TEAM_PLAN.md) §5.
- `main` is currently unprotected (DECISIONS D-15): maintainers may push directly after `npm run check` passes. Outside contributors use PRs, reviewed by a maintainer.
- Small, focused PRs. Describe _why_.
- AI-assisted contributions are welcome; you are responsible for every line. Agents working on this repo follow [AGENTS.md](AGENTS.md).

## Licence

By contributing you agree that your contributions are licensed under the [Apache-2.0](LICENSE) licence (inbound = outbound, per section 5 of the licence).
