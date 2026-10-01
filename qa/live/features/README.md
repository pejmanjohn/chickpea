# Feature map

One file per user-facing feature, written for the verifier. Each file says what
the feature covers, how a person reaches it, how to drive it on a QA lane, and
what proves it, including the traps earlier runs fell into. It is public and
credential-free: lane aliases and channel roles only, never workspace, channel
or account coordinates.

Use it in every mode:

- `changed`: map the diff's areas (`npm run verify:regression -- --plan`) to the
  feature files below and build cases from their "How to drive it" sections.
- `regression` and `release`: walk the whole table. A feature with no case in
  the run is reported as untested, not silently skipped.
- Mid-run, record a new gotcha with `record lesson` (see
  [records.md](../operator/records.md)). Before the run's PR merges, fold each
  lesson into the feature file it belongs to, so the next run starts from it.

The [live contract catalog](../generated/feature-map.md) and its
[scenario census](../lessons/scenario-index.md) keep the ten older executable
contracts. The files here cover every current feature, including those ten.

| Feature | File | Doors | Record areas | Docs page |
| --- | --- | --- | --- | --- |
| Agents: create, welcome, instructions, archive | [agents.md](agents.md) | Slack, Admin, MCP | `agents`, `delivery` | `/agents/agents/` |
| Slack conversations: mentions, threads, DMs, replies, files | [slack-conversations.md](slack-conversations.md) | Slack | `delivery` | `/slack/conversations/` |
| Steering: Stop, follow-ups, hand-back | [steering.md](steering.md) | Slack | `delivery` | `/slack/conversations/` |
| Activity status | [activity-status.md](activity-status.md) | Slack | `activity`, `delivery` | `/slack/replies/` |
| Connections and connectors | [connections.md](connections.md) | Slack, Admin, MCP | `connections`, `providers` | `/agents/connect-a-service/` |
| Schedules | [schedules.md](schedules.md) | Slack, Admin | `routines`, `delivery` | `/agents/schedules/` |
| Memory | [memory.md](memory.md) | Slack, Admin | `memory` | `/agents/memory/` |
| Skills | [skills.md](skills.md) | Slack, Admin, MCP | `skills` | `/agents/skills/` |
| Repositories and coding workspaces | [coding.md](coding.md) | Slack, Admin | `sandbox` | `/agents/coding-sandbox/` |
| Browser use and website logins | [browser.md](browser.md) | Slack, Admin | `browser` | `/agents/browser/` |
| Models, providers and images | [models.md](models.md) | Admin, Slack | `providers` | `/agents/models-and-providers/` |
| Agent conversations | [agent-conversations.md](agent-conversations.md) | Slack | `agents`, `delivery` | `/slack/conversations/` |
| Slack reading tools | [slack-reading.md](slack-reading.md) | Slack | `delivery` | `/slack/conversations/` |
| Admin: sign-in, team, usage, settings | [admin.md](admin.md) | Admin | `admin`, `usage` | `/admin/` |
| Management MCP door | [management-mcp.md](management-mcp.md) | MCP | `agents`, `admin` | `/admin/management-mcp/` |
| Installation, setup and upgrades | [installation.md](installation.md) | Admin, Slack | `auth`, `releases` | `/start/` |

Docs pages are paths on the public docs site.

## File shape

Keep each file short and in this order. Prefer a sentence a verifier can act on
over background the docs site already explains.

```markdown
# <Feature>

Docs: <docs path(s)>. Record areas: `<area>`. Legacy contracts: LC-0N, or none.

## What it covers
User-visible behaviours, one bullet each.

## How a person reaches it
Slack, Admin and MCP entry points, one bullet per door that applies.

## How to drive it on a lane
Lane needs (profile, provider keys, fixtures, actors), the case-add shape
(areas, proof, maxWaitMs), the synthetic request with a run marker, and the
cleanup contract.

## Proof and gotchas
Which readback proves what, and the traps earlier runs hit.
```

A "Case shape" line in a feature file lists only the flags to add to a complete
`case-add`; [agents.md](agents.md) shows a full command, and
[records.md](../operator/records.md) shows the `resource` flags every
registration needs.
