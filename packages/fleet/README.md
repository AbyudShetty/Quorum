# @quorum/fleet

Track: **B**. Simulated agents and the run summary behind `deploy/fleet`. See [deploy/fleet/README.md](../../deploy/fleet/README.md) for how to run a fleet and for results.

| Export                         | What it does                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| `runAgent`                     | One fake agent: sends direct notes to random peers, polls its inbox, records what arrived |
| `runLocalFleet`                | Every agent of a manifest in one process                                                  |
| `summarize`, `passed`          | Loss, misdelivery, duplicates, errors and latency percentiles across all agents           |
| `runFleetCli` / `quorum-fleet` | `agent`, `report` and `local` commands, configured by `FLEET_*` environment variables     |

The agents use the same client library as the real adapters (`@quorum/adapter-mcp`), so a run also exercises the identity check and token refresh. No new dependencies.
