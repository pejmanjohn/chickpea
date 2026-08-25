# Memory and schedules acceptance

## Purpose

Use this checklist to verify Agent memory, scheduled work, and the Admin surfaces that expose them before promoting a release beyond the disposable deployment.

## Accepted disposable release

- Date: August 25, 2026
- Worker URL: `https://chickpea-agent-first-disposable.pejmanjohn.workers.dev`
- Worker version: `17f00a2c-8174-4ed0-b90b-9ca6cbe0a78d`
- Worker source: `ff28fd1` on `codex/memory-schedule-reliability`
- Gateway version: `5e735e2b-03ab-4c14-ba29-204249a519f8`
- Gateway source: `2356fa0`
- Workspace: Acme Inc (`T0BFCGTP5JQ`)
- Runtime contract: `chickpea-v1`, installation revision 9
- Production: not changed

The Worker was deployed without changing or migrating `AUTH_DB`. The gateway was promoted to 100% before the final Worker acceptance pass.

## Automated gate

- Worker: `npm test` — 1,886 passing, 0 failing
- Worker: `npm run build` — passing
- Worker: `git diff --check` — passing
- Gateway: test suite — 38 passing, 0 failing
- Gateway: Worker build dry run — passing
- Gateway typecheck: blocked by the pre-existing missing Node type declarations used by gateway tests (`node:fs` and `node:path`), not by this change

The review validator confirmed all 10 structured findings. The separate Claude cross-model review timed out and produced no usable review artifact.

## Live memory acceptance

1. Save a distinctive Agent-owned fact in Admin and confirm the success state.
2. Ask the Agent for it in a granted named Channel.
3. Ask the same Agent for it in a direct message.
4. Confirm both answers use Agent memory attribution.
5. Mention base `@Chickpea` and confirm the request runs as `agent_chickpea`, without selecting the named Agent's memory.
6. Open the same Agent in two Admin tabs. Leave an unsaved Memory draft in one, save a remote update in the other, and return focus to the draft tab.
7. Confirm the draft is preserved. Discard it, reopen Memory, and confirm the latest remote value appears without reloading the page.

August 25 evidence:

- Channel and DM requests to Sprout returned the current `oryx-6417` acceptance code with `Agent memory supplied` attribution.
- A scheduled memory canary produced exactly `QA-SCHEDULE-MEMORY-cobalt` and completed once.
- After activation, fresh base mentions completed as `agent_chickpea`. The pre-activation base mention had routed to legacy `agent_default`, which exposed the ownership bug fixed in `ff28fd1`.
- Dirty-draft protection and the clean reopen refresh both passed across two already-open Admin tabs.

## Live schedule acceptance

1. Open Schedules and confirm the compact flat list contains only useful summary data: title, state, cadence, Channel, recent/next run, and eligible controls.
2. Resume a paused recurring schedule and confirm the success notice.
3. In a second already-open Admin tab, switch into Schedules and confirm it shows the active state without a page reload.
4. Let one occurrence run. Confirm a single Slack root, successful delivery, complete Usage data, and a durable Work/Run record.
5. Confirm the new Slack message uses `View schedule`, not `View in Audit`, and opens `/admin/agents/{agentId}?tab=schedules`.
6. Pause the recurring schedule and confirm no subsequent occurrence is admitted.
7. Delete a disposable completed one-time schedule. Confirm the destructive dialog, success notice, immediate list/count update, and the same no-reload update in the second Admin tab.

August 25 evidence:

- Pause and resume both succeeded from the Agent Schedules tab.
- A 4:15 PM recurring occurrence succeeded and delivered once with complete usage (`5,571` input and `45` output tokens).
- The pause prevented the 4:20 PM slot from being admitted.
- A fresh post-deploy 4:40 PM occurrence succeeded and delivered once with complete usage (`4,715` input and `29` output tokens). Its Slack context used `View schedule`, linked to `/admin/agents/agent_default?tab=schedules`, and the live destination opened with Schedules selected.
- Deleting `QA-SCHED-ONCE-0937` reduced the tab count from 3 to 2 in both open Admin tabs without a reload.
- Slack's Admin connection test reported `Connection healthy · Acme Inc`.

## Known limitations and follow-ups

- Acme Inc has only one human member, so non-member live privacy behavior cannot be exercised there. Automated tests cover non-member, redacted, and authorization-denial cases.
- One base-mention canary admitted during the activation/fix transition remained pending recovery. Fresh canaries after the fix completed as `agent_chickpea`; treat the old item as transition residue and monitor or retire it separately.
- Runtime drain still reported one unrelated executing Run. It did not block fresh Agent or scheduled work.
- The user-facing scheduled-post link now opens the Agent Schedules tab. The audit backend and page remain intentionally available as operational telemetry; remove any remaining user-facing audit navigation only after its diagnostic consumers are inventoried.
- The large Admin page and route modules remain a maintainability follow-up; extraction was not mixed into this reliability release.

## Promotion rule

Do not promote to production until the exact disposable revisions pass this checklist again and the production deployment is explicitly approved. Roll back the gateway first, then the Worker, if gateway delivery admission or session health regresses.
