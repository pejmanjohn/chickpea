# Live contract verification

This runbook covers attended verification of Chickpea in real Admin, Slack, and provider flows. The public files define the behavior contract and safe record formats. They do not contain target coordinates, credentials, browser profiles, or a working live coordinator.

## V1 operating model

V1 selects one named target per run. Feature-sandbox targets may allow `case` and `smoke`; only the exact alias `dedicated-qa` may run `deep`. Runs stay serial per target. The runner never deploys or repairs Chickpea. A local test, a deployed version, a traffic percentage, a screenshot, or a correct final reply is supporting context, not live-contract proof.

The environment layer provisions the target and owns its Worker, D1, Slack app, workspace, gateway, worktree claim, deployment fence and receipt, sandbox lifecycle, demo promotion, and infrastructure cleanup. The Live Contract Verifier owns contracts, suites, its run journal, the per-target run lock, semantic actions, human gates, observers, product-state cleanup or residue, evidence, reports, and this operator skill. Do not add another runner, doctor, journal, evidence format, or cleanup engine for feature lanes.

The public CLI is a protocol. It validates a private overlay and doctor snapshot, then emits one structured next action at a time. It cannot authenticate to Slack, Cloudflare, Composio, or a browser. Do not perform live mutations from its output unless a private coordinator supplies all of these controls:

- one-use challenges bound to the run, variant, step, attempt, target, actor, expected revision, and mutation class;
- durable action and cleanup receipts;
- authoritative readback after each action and after an ambiguous outcome;
- exact-ID reversal or revision-checked restoration;
- a final target, inventory, and cleanup postflight.

No such coordinator ships in this repository. Without one, doctor and deterministic checks may run, but live mutation is blocked.

## Public and private inputs

The repository ships the catalog, runner, observers, safety modules, alias-only target example, generated feature map, and operator skill. Keep the resolved target overlay, candidate provenance map, source register, privacy approvals, credentials, browser profiles, journals, evidence, screenshots, and transcripts outside Git and npm package roots.

Private config may name multiple targets, but a run resolves exactly one. `env target <alias>` produces its overlay and private-config aliases. `env attest <alias>` produces the verifier doctor snapshot from authoritative environment readback. Consume those schemas directly instead of copying immutable IDs into a lane-specific file.

Each target may declare `allowedSuites`. Feature targets use `case` and `smoke`; `dedicated-qa` alone may include `deep`. Suite policy limits where a suite runs. It cannot remove required variants or change their assertions.

The selected target allowlist binds the exact workspace, Slack app, Worker, provider project, read-only provider auth config, timezone, evidence root, and required deployment bindings. The private resolver uses aliases for:

- the target, workspace, Slack app, Worker, provider project, provider read-only auth config, timezone, evidence root, and lock location;
- each role-specific browser profile and fixture identity;
- any authority needed by the private coordinator.

The public fixture kinds are exact: `actor`, `slack_channel`, `slack_dm`, `slack_app`, `agent`, `routine`, `provider_account`, and `source_fixture`. An overlay with another kind fails validation. Fixture classes are `immutable_baseline`, `resettable_fixture`, `run_owned`, and `attributed_residue`.

## Evidence root and target lock

Use one canonical absolute evidence root outside the repository and every npm package root. The private coordinator creates run directories with mode `0700` and files with mode `0600`. A run directory contains its journal, content-free observations, receipts, and failure capsules. Raw Slack or provider content never belongs in a public report.

Reuse the same four role users across dedicated QA and feature-sandbox workspaces. Their aliases must resolve to four distinct Computer Use-addressable browser apps. Do not substitute tabs in one ambiguous browser session. V1 has no API actor. Add one only if measured attended time later justifies its authority and maintenance cost.

The target lock lives under that target's evidence root. It records the run ID, PID, host, and start time and uses no-overwrite creation. The private binding of lock path to target makes it target-specific. Different targets have different locks and evidence roots.

- A live PID blocks every run.
- The same run on the same host may reacquire its stale lock after proving the PID is inactive.
- A different run or foreign host cannot take over a stale lock.
- A stopped run may clear its lock only after proving the PID is inactive and the journal has no unresolved intent.
- An unresolved intent forces cleanup-only recovery. Read back the exact effect before deciding whether to reverse it. Never replay the original mutation on an unknown outcome.

The public lock module enforces these rules, but no public lock-management command or private coordinator ships here.

There is no host-wide run lock. Different targets may run concurrently on one host. The private coordinator uses one host-local Computer Use mutex only while it executes a semantic UI action. Release it after authoritative readback reaches that action's postcondition or the action pauses for a human gate. Terminal or API actions and observer polling on other targets do not take the UI mutex.

## Before a live run

1. Run `npm run typecheck` and the smallest relevant `tests/live-contract-*.test.ts` files.
2. After committing public changes, run `npm run verify:oss-export`. It verifies immutable `HEAD`, so it does not grade uncommitted files.
3. Claim one target with `env claim <alias>`.
4. Run `env target <alias>` and `env attest <alias>`. Use their overlay/config and snapshot outputs directly. Do not hand-copy live coordinates into public files.
5. Run `npm run verify:live:doctor -- --target <private-overlay> --snapshot <private-snapshot>`.
6. Require a ready doctor result before resolving any mutating credential or browser app.

Doctor must bind the repository and manifest digests to the serving version, one 100-percent deployment, gateway identity and health, deployment bindings, Slack workspace and app, provider project and read-only auth config, timezone, actor roles, observers, evidence root, and target lock. Missing roles, observer gaps, target drift, an unsafe evidence root, or any lock blocks the run.

## Choose the smallest suite

- `case` runs selected variants while developing or investigating one feature.
- `smoke` is the normal release check. It should run before `deep`.
- `deep` runs the full catalog on `dedicated-qa` and places installation reset last. Reject it on every other target, even if a caller asks for it directly.

Use the generated [feature map](../../qa/live/generated/feature-map.md) to find contracts, entry points, actors, and fixtures. Contract assertions live in the catalog, not this runbook.

The initial planning budgets are 45 minutes wall-clock and 20 minutes attended for smoke, and four hours wall-clock and two hours attended for deep. Human gates include approval, OAuth consent, login, CAPTCHA, credential entry, and provider permission. The operator completes those gates; the journal records only a bounded result and receipt digest. Measure actual elapsed and attended time during acceptance. These numbers are planning estimates, not pass criteria.

## Action, observation, and cleanup

At each step, recheck target identity and current actor authority. The private coordinator issues the exact challenge and performs the declared action once. Observers may retry within their bounded poll and provider rate-limit budget. A mutation may retry only after exact readback proves it did not apply.

Grade each assertion from its named authoritative observer. Keep the product result separate from cleanup. A product failure can still clean successfully, and a product pass becomes `cleanup_failed` when cleanup or postflight fails.

Cleanup reverses exact run-owned resources, restores resettable fixtures only from a captured prior revision, and records attributable Slack residue that the product cannot delete. Postflight confirms target identity, expected baselines, no unexpected resources, and no unresolved intent before releasing the lock.

Keep the accepted content-free summary. Delete superseded private run directories after review or after 14 days, whichever comes first. V1 has no retention daemon or remote evidence service.

## When to add more infrastructure

Keep the per-target file lock while runs are attended and single-host for that target. Different claimed targets may run in parallel without sharing a lock; only their Computer Use action windows serialize. Design a remote lease with fencing only before same-target multi-host or unattended operation. Add a private coordinator only when its real target adapters and authority stores exist. Do not put those bindings in the OSS package.

Treat first-install as a future pre-install-stage contract in this catalog. Reuse this runner, journal, evidence, and cleanup model; do not create an installation runner beside it.

## Verifier upkeep

After unexpected behavior, rerun doctor and check feature-map freshness. Compare the smallest affected contract with current product intent. Update only verifier-owned cases, lessons, observer adapters, or generated files when intent is settled. If product behavior regressed or intent is unclear, keep the assertion and report the mismatch. V1 has no maintenance command, outcome state machine, dashboard, or background service.
