# Security policy

Quorum's job is to keep humans in control of what AI agents do, so we treat security reports as the highest priority.

## Supported versions

Quorum is pre-release (Phase 0). Once released, the latest minor version receives security fixes.

## Reporting a vulnerability

**Please do not open a public issue.** Report privately through GitHub's **"Report a vulnerability"** button (Security tab → Advisories) on this repository.

Include: affected version/commit, steps to reproduce, impact, and — if you know it — which invariant in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) is broken.

What to expect:

| Step                                        | Target                                                   |
| ------------------------------------------- | -------------------------------------------------------- |
| Acknowledgement                             | within 3 days                                            |
| Initial assessment and severity             | within 7 days                                            |
| Fix or mitigation for high/critical         | as fast as possible; releases are blocked until resolved |
| Public advisory and credit (if you want it) | after a fix is available                                 |

We support coordinated disclosure and will not take action against good-faith research that respects users' data and stays within your own deployments.

## Scope

In scope: the server, CLI, adapters, web UI, protocol and default policy — especially anything that breaks an invariant (e.g. approving without a human, replaying approvals, forging identity, tampering with the event log undetected, escaping untrusted-message framing).

Out of scope: behaviour of third-party AI agents themselves, and issues requiring a fully compromised member machine (see THREAT_MODEL §6).
