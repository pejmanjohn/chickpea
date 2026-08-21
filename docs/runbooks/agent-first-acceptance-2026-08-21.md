# Agent-first Slack platform acceptance

Date: 2026-08-21

This report records the independent Fable review, the resulting remediations, and exact-revision acceptance evidence for the Agent-first Slack platform. It is intentionally text-only so the evidence ships in the open-source export instead of depending on local screenshots.

## Reviewed revisions

- Main runtime implementation after follow-up re-audit: `7e24e0fffb3a9cf3f0a2dadda465bcb53eec5feb`
- Main pull request: <https://github.com/pejmanjohn/chickpea/pull/5>
- Disposable Worker: <https://chickpea-agent-first-disposable.pejmanjohn.workers.dev>
- Disposable Worker version: `76665bf7-895e-4078-9133-4677dbe83563` at 100%
- Private gateway repository: `94071730ea1538de538dcd10070d21b94f9a2590`
- Private gateway pull request: <https://github.com/pejmanjohn/chickpea-slack-gateway/pull/1>
- Private gateway: <https://chickpea-slack-gateway.pejmanjohn.workers.dev>
- Private gateway version: `4e08b065-7866-4a6d-b63f-7cc7e50e0379` at 100%

## Independent review result

Fable found no remaining gap in the core product model: the Agent owns behavior, Slack handle and avatar, Channel reach, one memory, connections, schedules, edit policy, App Home routing, and archive/restore lifecycle. The shared-app and customer-owned-app lanes also remain intact.

Fable did identify implementation and operability gaps around the completed model. All meaningful findings were addressed:

| Finding | Resolution |
| --- | --- |
| Unauthenticated gateway sockets had no deadline | Each accepted socket schedules an authentication alarm. A live anonymous connection closed with code `1008` and reason `authentication_timeout`. |
| Every Channel turn could scan the full Slack Channel directory | Delivered Channel events are fresh membership evidence. Other discovery uses paginated `users.conversations` once and checks a local set. |
| Durable Object behavior had no executable tests | Gateway tests now exercise socket expiry and offline-notice suppression through the Durable Object classes. |
| Installer user-token authority was implicit | Admin and gateway operations documentation now disclose that the approving Owner/Admin grants encrypted user-group management authority and explain reconnect recovery. |
| A displaced gateway binding lacked clear recovery | Binding mismatch, transfer, revoked installer authority, and missing gateway session state now resolve to `Reconnect required`. |
| `chat.update` persona behavior was unproven | The presentation contract test proves the checklist is created with Agent persona, then updates the same timestamp while omitting author fields. Existing Acme messages retain the Sprout persona. |
| Discoverable non-editors saw a failing editor | Agent projections now include `canEdit`; non-editors receive a truthful read-only view with Duplicate but no mutating controls or edit-only data loads. |
| Offline notices could repeat without bound | Gateway notices are content-free and suppressed per workspace/Channel for five minutes. |
| A retired continuity-notice subsystem remained | The dead subsystem, schema field, state RPCs, and tests were removed. |
| App Home silently truncated at 24 Agents | App Home now states when it is showing 24 of a larger accessible set. |
| Public avatar validation admitted SVG | Gateway avatars accept only PNG, JPEG, and WebP. |
| Gateway operating limits were undocumented | The runbook now records installer recovery, binding transfer, rate limits, offline suppression, and the private-beta global-control ceiling. |
| Acceptance screenshots were local-only | This tracked report now carries the durable result and ships in the OSS export. |

Fable's follow-up re-audit independently re-ran both repositories and reproduced the live gateway probes. It confirmed all thirteen original findings were fixed and found one low-severity residual: the Agent-presence classifier handled gateway-specific binding mismatch codes but not the gateway's raw `binding_mismatch` response. Revision `7e24e0f` adds that response to the reconnect classifier and covers both revoked and displaced shared-app authority with the same explicit `Reconnect Slack` recovery.

The global gateway control Durable Object remains a documented private-beta scaling ceiling. It is sufficient for the current beta and must be sharded before broad multi-tenant scale; this is an explicit capacity boundary, not a hidden correctness gap.

## Automated acceptance

Main repository at `7e24e0f`:

- `npm test`: 1,465 passed, 0 failed.
- `npm run build`: passed and validated the generated Cloudflare artifact.
- `npm run verify:admin-ui`: 12/12 passed.
- `npm run verify:oss-export`: passed from the committed source. Its clean export repeated 1,464 tests with one intentional loopback-only skip, plus offline-turn, durability, provider, and deploy dry-run checks.
- `git diff --check`: passed.

Private gateway at `9407173`:

- `npm run typecheck`: passed.
- `npm test`: 31/31 passed.
- `npm run build`: Wrangler dry-run passed.
- `git diff --check`: passed.

## Live Cloudflare and Acme acceptance

- The disposable Worker serves version `76665bf7-895e-4078-9133-4677dbe83563` at 100% and preserved its existing `AUTH_DB` binding and reviewed schema.
- The permanent gateway serves version `4e08b065-7866-4a6d-b63f-7cc7e50e0379` at 100% and returns protocol version 1 from its health endpoint.
- `npm run verify:gateway-live` created a pending claim, retained only an encrypted deployment identity, and stored no Slack credential in the deployment.
- A live anonymous gateway WebSocket opened in 1.1 seconds and was closed by the authentication alarm after 20.9 seconds with code `1008` and reason `authentication_timeout`. The alarm is scheduled for 10 seconds; Cloudflare documents that alarm execution can be delayed, so this is a bounded authentication fence rather than a hard 10-second network SLA.
- Admin reports Acme workspace `T0BFCGTP5JQ` as Connected and `Connection healthy`, managed by the Chickpea gateway, with one configured Channel.
- Team shows one active Owner and the approved automatic-provisioning explanation. No manual invitation, second-Owner callout, invitation button, or Slack-directory error surface remains.
- The Slack settings screen includes the encrypted Owner/Admin user-group authority disclosure and exact reconnect recovery.
- Acme contains one Chickpea app. A fresh App Home open after the deployment re-rendered `Your Agents` with Sprout and `@sprout` through the new gateway revision.
- Existing direct-message acceptance shows Sprout-authored roots and replies, the current Agent avatar/persona, and `Sprout is ready`/`Sprout | cloudflare/@cf/zai-org/glm-5.2` attribution.

The current Acme workspace has only one Chickpea member, so the discoverable read-only Agent view is covered by route, projection, and rendered-UI tests rather than by creating a synthetic second person.

## Slack API basis

The membership optimization uses Slack's documented paginated [`users.conversations`](https://docs.slack.dev/reference/methods/users.conversations/) method for a member's conversations. Channel publication and membership proof continue to use Slack's documented [`conversations.members`](https://docs.slack.dev/reference/methods/conversations.members/) method where the complete Channel member list is actually required.

## Final result

The original Agent-first plan is complete across product model, open-source parity, private gateway, Admin UI, App Home, Acme Slack, management MCP, memory, connections, schedules, lifecycle, and both installation lanes. Fable's meaningful post-plan gaps are fixed and validated. The only retained limitation is the documented private-beta gateway-control scaling ceiling.
