# Live contract verification

This runbook covers attended verification of Chickpea in real Admin, Slack, and provider flows. The public files define the behavior contract and safe record formats. They do not contain target coordinates, credentials, browser profiles, or a working live coordinator.

## Phase 1 operating model

Phase 1 starts with exactly two active targets, `amber` and `cobalt`. The environment handoff owns their workspace and app configuration. Each target binds the same exact four-variant smoke inventory; a run claims one color and may use `case` or `smoke`. The Phase 1 environment registry and allocator refuse `deep` and continuation roles. `fern` is inactive and must not become a prerequisite or substitute target. The public verifier schema remains role-agnostic and retains dormant deep contracts for continuation. Runs stay serial per target. The runner never deploys or repairs Chickpea. A local test, deployed version, traffic percentage, screenshot, or correct final reply is supporting context, not live-contract proof.

The environment layer provisions the two color targets and owns their Workers, D1, Slack workspaces and app installations, transport, worktree claims, deployment fences and receipts, target lifecycle, and infrastructure cleanup. Demo promotion, deep qualification, first-install automation, and additional environments are continuation modules. The Live Contract Verifier owns contracts, suites, its run journal, the per-target run lock, semantic actions, human gates, observers, product-state cleanup or residue, evidence, reports, and this operator skill.

The public V0 CLI is intentionally narrower than the internal runner protocol. `doctor` validates a private overlay and exact snapshot. The `case`, `smoke`, and `deep` commands return `COORDINATOR_REQUIRED` before reading private inputs or accepting caller-authored outcomes. V0 cannot authenticate to Slack, Cloudflare, Composio, or a browser and is not live-complete V1. The next-phase coordinator must supply all of these controls:

- one-use challenges bound to the run, variant, step, attempt, target, actor, expected revision, and mutation class;
- durable action and cleanup receipts;
- authoritative readback after each action and after an ambiguous outcome;
- exact-ID reversal or revision-checked restoration;
- a final target, inventory, and cleanup postflight.

That coordinator does not ship in V0. Without it, doctor and deterministic checks may run, but live mutation is blocked. After U0 and V1, claim clean `cobalt` normally and exclusively for one protected origin/main Computer Use smoke, clean it, release it, then return it to ordinary branch-lane use. If another task owns the claim, wait for release. Do not add a persistent qualification mode or dual-role registry state.

The coordinator remains verifier-owned when implemented. It acquires the per-target lock, sequences variants, journals one-use challenges and content-free receipts, packages evidence, performs exact cleanup bookkeeping, and owns the host-local UI mutex. Codex carries out scored product actions and observations as a real user through Computer Use in the actual Slack and Chickpea Admin interfaces. It must not substitute direct product APIs, database reads, hidden HTTP observers, or an API actor for that journey.

## Public and private inputs

The repository ships the catalog, runner, observers, safety modules, alias-only target example, generated feature map, and operator skill. Keep the resolved target overlay, candidate provenance map, source register, privacy approvals, credentials, browser profiles, journals, evidence, screenshots, and transcripts outside Git and npm package roots.

Private config may name multiple targets, but a run resolves exactly one. `env target <alias>` produces its overlay and private-config aliases. `env attest <alias>` produces the verifier doctor snapshot from authoritative environment readback. Consume those schemas directly instead of copying immutable IDs into a lane-specific file.

Each color target declares `allowedSuites` as exactly `case` and `smoke` and binds the same manifest-owned variants: `LC01-V1-create-welcome`, `LC01-V2-update-approve`, `LC04-V1-personal-read`, and `LC08-V1-create-due`. A selected `case` must come from that inventory; a target cannot omit, add, or redefine a Phase 1 smoke contract. The complete deep catalog remains public continuation material, not a Phase 1 fixture requirement.

The selected target allowlist binds the exact workspace, Slack app, Worker, provider project, read-only provider auth config, timezone, evidence root, and required deployment bindings. The private resolver uses aliases for:

- the target, workspace, Slack app, Worker, provider project, provider read-only auth config, timezone, and evidence root;
- each role-specific browser profile and fixture identity;
- any authority needed by the private coordinator.

The public fixture kinds are exact: `actor`, `slack_channel`, `slack_dm`, `slack_app`, `agent`, `routine`, `provider_account`, and `source_fixture`. An overlay with another kind fails validation. Fixture classes are `immutable_baseline`, `resettable_fixture`, `run_owned`, and `attributed_residue`.

## Evidence root and target lock

Use one canonical absolute evidence root outside the repository and every npm package root. The private coordinator creates run directories with mode `0700` and files with mode `0600`. A run directory contains its journal, content-free observations, receipts, and failure capsules. Raw Slack or provider content never belongs in a public report.

Each target overlay binds actor aliases to its own workspace. Doctor resolves only the distinct Computer Use-addressable aliases required by the selected variants; the exact Phase 1 smoke needs Owner and Member. Admin and second-member remain available for later cases rather than becoming a smoke prerequisite. Do not substitute tabs in one ambiguous browser session or use an API actor for a scored journey.

The target lock is derived as `<evidenceRoot>/target.lock`. It records the run ID, PID, host, and start time and uses no-overwrite creation. Different targets have different locks and evidence roots; there is no separate lock-path alias to drift.

- A live PID blocks every run.
- No run may overwrite or reacquire an existing lock in place, including the same run on the same host.
- A different run or foreign host cannot take over a stale lock.
- A stopped run may clear its lock only after proving the PID is inactive and the journal has no unresolved action, product mutation, cleanup intent, or ambiguous cleanup outcome. A fresh run then acquires a new lock atomically.
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

Doctor must bind the repository and manifest digests to the serving version, one 100-percent deployment, deployment bindings, Slack workspace and app, provider project and read-only auth config, timezone, the minimum actor aliases and UI observation recipes required by the selected variants, evidence root, and target lock. Gateway targets require matching healthy gateway identity. Events targets instead require a healthy installation verification and a fresh signed-event receipt. Color branch lanes may use an explicit `<sha>-dirty` revision; the protected origin/main smoke is claimed only from a clean attestation. Missing required actors, observer gaps, target drift, an unsafe evidence root, or any lock blocks the run.

## Choose the smallest suite

- `case` runs selected variants while developing or investigating one feature.
- `smoke` is the Phase 1 live finish line and normal release check.
- `deep` is continuation work. The environment registry rejects it on `amber` and `cobalt`, even though its contracts remain in the public catalog.

Use the generated [feature map](../../qa/live/generated/feature-map.md) to find contracts, entry points, actors, and fixtures. Contract assertions live in the catalog, not this runbook.

The initial planning budget is 45 minutes wall-clock and 20 minutes attended for smoke. Human gates include approval, OAuth consent, login, CAPTCHA, credential entry, and provider permission. The operator completes those gates; the journal records only a bounded result and receipt digest. Measure actual elapsed and attended time during acceptance. These numbers are planning estimates, not pass criteria.

## Action, observation, and cleanup

At each step, recheck target identity and current actor authority. The coordinator issues the exact challenge, and Codex performs the declared action once through the role's real Slack or Admin browser app. Product pass/fail comes from visible user surfaces through window-scoped accessibility or screenshot evidence. If durable truth is not customer-visible, add a bounded read-only Admin diagnostic surface that Computer Use can inspect; do not silently fall back to an internal product API. A mutation may retry only after exact visible readback proves it did not apply.

Grade each assertion from its named UI observation recipe. Deployment and transport identity remain environment attestation prerequisites and should also appear in an Admin environment badge/status for Computer Use confirmation. Terminal/API access is limited to environment provisioning, deployment, target identity/fencing/attestation, lock/journal bookkeeping, and infrastructure cleanup. Keep the product result separate from cleanup. A product failure can still clean successfully, and a product pass becomes `cleanup_failed` when cleanup or postflight fails.

Cleanup reverses exact run-owned resources, restores resettable fixtures only from a captured prior revision, and records attributable Slack residue that the product cannot delete. Postflight confirms target identity, expected baselines, no unexpected resources, and no unresolved intent before releasing the lock.

Keep the accepted content-free summary. Delete superseded private run directories after review or after 14 days, whichever comes first. V1 has no retention daemon or remote evidence service.

## When to add more infrastructure

Keep the per-target file lock while runs are attended and single-host for that target. Different claimed targets may run in parallel without sharing a lock; only their Computer Use action/input windows serialize. Design a remote lease with fencing only before same-target multi-host, same-target parallel, or unattended operation. Implement the verifier-owned UI coordinator only after the environment can produce the target, claim, and attestation contracts above. Do not put resolved bindings in the OSS package.

First-install automation is a continuation module. Phase 1 starts from the two provisioned color targets and scored verification begins at `LC01-V1-create-welcome`. Do not create an installation runner or score setup APIs as product proof.

## Verifier upkeep

After unexpected behavior, rerun doctor and check feature-map freshness. Compare the smallest affected contract with current product intent. Update only verifier-owned cases, lessons, observer adapters, or generated files when intent is settled. If product behavior regressed or intent is unclear, keep the assertion and report the mismatch. V1 has no maintenance command, outcome state machine, dashboard, or background service.
