# Live contract verification

This runbook covers attended verification of Chickpea in real Admin, Slack, and provider flows. The public files define the behavior contract and safe record formats. They do not contain target coordinates, credentials, browser profiles, or a working live coordinator.

## V1 operating model

V1 selects one named target per run. Feature-sandbox targets may allow `case` and `smoke`; only the exact alias `dedicated-qa` may run `deep`. Runs stay serial per target. The runner never deploys or repairs Chickpea. A local test, a deployed version, a traffic percentage, a screenshot, or a correct final reply is supporting context, not live-contract proof.

The environment layer provisions the target and owns its Worker, D1, Slack app, workspace, gateway, worktree claim, deployment fence and receipt, sandbox lifecycle, demo promotion, and infrastructure cleanup. The Live Contract Verifier owns contracts, suites, its run journal, the per-target run lock, semantic actions, human gates, observers, product-state cleanup or residue, evidence, reports, and this operator skill. Do not add another runner, doctor, journal, evidence format, or cleanup engine for feature lanes.

The public CLI is a protocol. It validates a private overlay and doctor snapshot, then emits one structured next action at a time. It cannot authenticate to Slack, Cloudflare, Composio, or a browser. This first landing is deterministic-green verifier foundation, not live-complete V1. Do not perform live mutations from its output unless the verifier's next-phase coordinator supplies all of these controls:

- one-use challenges bound to the run, variant, step, attempt, target, actor, expected revision, and mutation class;
- durable action and cleanup receipts;
- authoritative readback after each action and after an ambiguous outcome;
- exact-ID reversal or revision-checked restoration;
- a final target, inventory, and cleanup postflight.

That coordinator does not ship in the foundation landing. Without it, doctor and deterministic checks may run, but live mutation is blocked. The first real smoke belongs on `dedicated-qa` after the environment's initial target provisioning and before demo/promotion work.

The coordinator remains verifier-owned when implemented. It acquires the per-target lock, sequences variants, journals one-use challenges and content-free receipts, packages evidence, performs exact cleanup bookkeeping, and owns the host-local UI mutex. Codex carries out scored product actions and observations as a real user through Computer Use in the actual Slack and Chickpea Admin interfaces. It must not substitute direct product APIs, database reads, hidden HTTP observers, or an API actor for that journey.

## Public and private inputs

The repository ships the catalog, runner, observers, safety modules, alias-only target example, generated feature map, and operator skill. Keep the resolved target overlay, candidate provenance map, source register, privacy approvals, credentials, browser profiles, journals, evidence, screenshots, and transcripts outside Git and npm package roots.

Private config may name multiple targets, but a run resolves exactly one. `env target <alias>` produces its overlay and private-config aliases. `env attest <alias>` produces the verifier doctor snapshot from authoritative environment readback. Consume those schemas directly instead of copying immutable IDs into a lane-specific file.

Each target declares a nonempty `allowedVariants` subset and may declare `allowedSuites`. Feature targets normally use selected `case` variants. `smoke` or `deep` runs only when the target contains that suite's exact manifest-owned inventory; `dedicated-qa` alone may include `deep`. A target subset can omit unprovisioned journeys, but it cannot redefine a contract or assertion.

The selected target allowlist binds the exact workspace, Slack app, Worker, provider project, read-only provider auth config, timezone, evidence root, and required deployment bindings. The private resolver uses aliases for:

- the target, workspace, Slack app, Worker, provider project, provider read-only auth config, timezone, and evidence root;
- each role-specific browser profile and fixture identity;
- any authority needed by the private coordinator.

The public fixture kinds are exact: `actor`, `slack_channel`, `slack_dm`, `slack_app`, `agent`, `routine`, `provider_account`, and `source_fixture`. An overlay with another kind fails validation. Fixture classes are `immutable_baseline`, `resettable_fixture`, `run_owned`, and `attributed_residue`.

## Evidence root and target lock

Use one canonical absolute evidence root outside the repository and every npm package root. The private coordinator creates run directories with mode `0700` and files with mode `0600`. A run directory contains its journal, content-free observations, receipts, and failure capsules. Raw Slack or provider content never belongs in a public report.

Reuse the same four role users across dedicated QA and feature-sandbox workspaces. Their aliases must resolve to four distinct Computer Use-addressable browser apps. Do not substitute tabs in one ambiguous browser session. No API actor may replace a scored user journey.

The target lock is derived as `<evidenceRoot>/target.lock`. It records the run ID, PID, host, and start time and uses no-overwrite creation. Different targets have different locks and evidence roots; there is no separate lock-path alias to drift.

- A live PID blocks every run.
- The same run on the same host may reacquire its stale lock after proving the PID is inactive.
- A different run or foreign host cannot take over a stale lock.
- A stopped run may clear its lock only after proving the PID is inactive and the journal has no unresolved intent.
- An unresolved intent forces cleanup-only recovery. Read back the exact effect before deciding whether to reverse it. Never replay the original mutation on an unknown outcome.

The public lock module enforces these rules. The foundation CLI does not yet acquire or clear that lock; the verifier-owned coordinator must wire lock lifecycle and a safe `--clear-lock` command before the first live smoke.

There is no host-wide run lock. Different targets may run concurrently on one host. The coordinator uses one host-local Computer Use mutex only while it executes a semantic UI action or input window. A waiting human gate releases that mutex and reserves only its actor/browser. Reacquire the mutex for the short confirmation interaction, then release it after the visible page advances. Another run needing the same browser bounded-waits and becomes operationally `blocked`, never a product failure. Captures are window-scoped; never capture during secret entry or before the page advances. Environment commands and lock/journal bookkeeping on other targets do not take the UI mutex.

## Before a live run

1. Run `npm run typecheck` and the smallest relevant `tests/live-contract-*.test.ts` files.
2. After committing public changes, run `npm run verify:oss-export`. It verifies immutable `HEAD`, so it does not grade uncommitted files.
3. Claim one target with `env claim <alias>`.
4. Run `env target <alias>` and `env attest <alias>`. Use their overlay/config and snapshot outputs directly. Do not hand-copy live coordinates into public files.
5. Run `npm run verify:live:doctor -- --target <private-overlay> --snapshot <private-snapshot>`.
6. Require a ready doctor result before resolving any mutating credential or browser app.

Doctor must bind the repository and manifest digests to the serving version, one 100-percent deployment, deployment bindings, Slack workspace and app, provider project and read-only auth config, timezone, target-scoped actor roles and UI observation recipes, evidence root, and target lock. Gateway targets require matching healthy gateway identity. Events targets instead require a healthy installation verification and a fresh signed-event receipt. `dedicated-qa` and demo reject dirty source attestations; feature lanes may use an explicit `<sha>-dirty` revision. Missing roles, observer gaps, target drift, an unsafe evidence root, or any lock blocks the run.

## Choose the smallest suite

- `case` runs selected variants while developing or investigating one feature.
- `smoke` is the normal release check. It should run before `deep`.
- `deep` runs the full catalog on `dedicated-qa` and places installation reset last. Reject it on every other target, even if a caller asks for it directly.

Use the generated [feature map](../../qa/live/generated/feature-map.md) to find contracts, entry points, actors, and fixtures. Contract assertions live in the catalog, not this runbook.

The initial planning budgets are 45 minutes wall-clock and 20 minutes attended for smoke, and four hours wall-clock and two hours attended for deep. Human gates include approval, OAuth consent, login, CAPTCHA, credential entry, and provider permission. The operator completes those gates; the journal records only a bounded result and receipt digest. Measure actual elapsed and attended time during acceptance. These numbers are planning estimates, not pass criteria.

## Action, observation, and cleanup

At each step, recheck target identity and current actor authority. The coordinator issues the exact challenge, and Codex performs the declared action once through the role's real Slack or Admin browser app. Product pass/fail comes from visible user surfaces through window-scoped accessibility or screenshot evidence. If durable truth is not customer-visible, add a bounded read-only Admin diagnostic surface that Computer Use can inspect; do not silently fall back to an internal product API. A mutation may retry only after exact visible readback proves it did not apply.

Grade each assertion from its named UI observation recipe. Deployment and transport identity remain environment attestation prerequisites and should also appear in an Admin environment badge/status for Computer Use confirmation. Terminal/API access is limited to environment provisioning, deployment, target identity/fencing/attestation, lock/journal bookkeeping, and infrastructure cleanup. Keep the product result separate from cleanup. A product failure can still clean successfully, and a product pass becomes `cleanup_failed` when cleanup or postflight fails.

Cleanup reverses exact run-owned resources, restores resettable fixtures only from a captured prior revision, and records attributable Slack residue that the product cannot delete. Postflight confirms target identity, expected baselines, no unexpected resources, and no unresolved intent before releasing the lock.

Keep the accepted content-free summary. Delete superseded private run directories after review or after 14 days, whichever comes first. V1 has no retention daemon or remote evidence service.

## When to add more infrastructure

Keep the per-target file lock while runs are attended and single-host for that target. Different claimed targets may run in parallel without sharing a lock; only their Computer Use action/input windows serialize. Design a remote lease with fencing only before same-target multi-host, same-target parallel, or unattended operation. Implement the verifier-owned UI coordinator only after the environment can produce the target, claim, and attestation contracts above. Do not put resolved bindings in the OSS package.

Treat first-install as a future pre-install-stage contract in this catalog. Reuse this runner, journal, evidence, and cleanup model; do not create an installation runner beside it.

## Verifier upkeep

After unexpected behavior, rerun doctor and check feature-map freshness. Compare the smallest affected contract with current product intent. Update only verifier-owned cases, lessons, observer adapters, or generated files when intent is settled. If product behavior regressed or intent is unclear, keep the assertion and report the mismatch. V1 has no maintenance command, outcome state machine, dashboard, or background service.
