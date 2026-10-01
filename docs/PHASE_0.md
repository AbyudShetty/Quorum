# Phase 0 — Foundations: status

Phase 1 MUST NOT start until every exit criterion below is ✅ (AGENTS.md rule 1).

## Exit criteria (plan §13)

| #   | Criterion                                            | Owner          | Status                                                                                                             |
| --- | ---------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------ |
| E1  | Specs reviewed by abyud                              | abyud          | ⏳ pending — review the specs **as updated 2026-10-01** (local mode, INV-23–31)                                    |
| E2  | Specs reviewed by **one other person**               | abhijna        | ⏳ pending — review the pushed docs, confirm/challenge D-14, record below (TEAM_PLAN §5.2)                         |
| E3  | CI green on an empty skeleton                        | abyud          | ⏳ local checks pass; repo `AbyudShetty/Quorum` exists (public, empty); needs first push + abhijna as collaborator |
| E4  | Interview notes saved (≥ 5 people, top 3 pains each) | both (~3 each) | ⏳ 0 / 5 — kit in [interviews/](interviews/README.md)                                                              |

## Deliverables

| Deliverable                                                    | Status                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `docs/PRIOR_ART.md` (re-check of §3)                           | ✅ drafted 2026-10-01                                                                 |
| `docs/THREAT_MODEL.md`                                         | ✅ draft                                                                              |
| `docs/MESSAGE_SPEC.md`                                         | ✅ draft                                                                              |
| `docs/POLICY_SPEC.md`                                          | ✅ draft                                                                              |
| `docs/ARCHITECTURE.md`                                         | ✅ draft                                                                              |
| `docs/DECISIONS.md` (§17 answers)                              | ✅ D-2–D-4, D-7–D-13 accepted (D-8 provisional); D-5 revisit requested; D-1, D-6 open |
| Licence (Apache-2.0)                                           | ✅                                                                                    |
| CI, lint/format, test runner                                   | ✅ configured                                                                         |
| `AGENTS.md` / `CLAUDE.md`, `CONTRIBUTING.md`, `SECURITY.md`    | ✅                                                                                    |
| Interview kit                                                  | ✅                                                                                    |
| Same-machine topologies (T1/T2) + local mode in plan and specs | ✅ draft (2026-10-01)                                                                 |
| `docs/TEAM_PLAN.md` (two-person split)                         | ✅ draft                                                                              |

## Spec review checklist (for E1/E2)

Reviewers: read THREAT_MODEL → MESSAGE_SPEC → POLICY_SPEC → ARCHITECTURE → TEAM_PLAN (≈ 60 min). Record the outcome below.

- [ ] Every threat in plan §8 maps to at least one invariant (INV-n) with a planned test.
- [ ] Answer the "Open questions for Phase 0 review" at the end of each spec.
- [ ] Gated-action enforcement model (THREAT_MODEL §6.1) is acceptable.
- [ ] Message types and fields are sufficient for the two-machine sprint benchmark (plan §12).
- [ ] Policy defaults are safe and understandable in one minute.
- [ ] Nothing in the architecture requires a paid service or blocks five-minute setup.
- [ ] Local mode (T1/T2) keeps every invariant; INV-23–INV-31 are acceptable; one-minute same-machine setup is realistic.
- [ ] D-8 re-sequencing (accepted provisionally) still looks right after reading the specs.
- [ ] TEAM_PLAN track split and contract-first flow work for both of us.

### Review record

| Reviewer | Date | Docs reviewed | Outcome / changes requested |
| -------- | ---- | ------------- | --------------------------- |
|          |      |               |                             |
