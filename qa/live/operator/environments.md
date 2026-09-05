# Environment selection and deployment fences

## Select one environment

1. Inspect the complete diff, including branch, staged, unstaged, and untracked
   changes. Start with `npm run verify:regression -- --plan`; use `--base REF`
   when the intended comparison differs from local `origin/main`. The mapping is
   a starting point. Include indirectly affected behavior identified in review.
2. Reuse a matching claim. Otherwise inspect `npm run env -- status --worktree
   <absolute-worktree>`, then claim one free deployed lane when needed. Never
   borrow another task's claim. A claim drops only at its `expiresAt` or by
   its holder's own `release`. When `env status` shows a holder whose worktree
   no longer exists, `npm run env -- reclaim <alias> --adopt-orphan` can adopt
   it, but freeing another task's hold is the operator's decision: report the
   holder and ask before adopting. Both busy means report availability and continue
   offline checks, not ask the operator to manufacture another environment.
3. Prefer an initialized local workerd/HTTP lane for repeated application edits.
   Run `npm run dev:cf -- status --lane <lane>` and verify its owning worktree,
   app/workspace pair, endpoint, state, and actual effective model. Follow
   [local Worker development](../../../docs/runbooks/local-worker-development.md).
   Local state is currently worktree-bound. Do not copy it into a fresh worktree;
   use an available deployed lane until an explicit local handoff is supported.
4. Use a deployed lane for shared-gateway behavior, deployed bindings/credentials,
   real due-time delivery, or release acceptance. Claim and attest through the
   existing environment commands: `npm run env -- claim <alias>`, then
   `target <alias>` and `attest <alias>` through the same command. Pass
   `--worktree <absolute-worktree>` throughout. Read the
   [lane runbook](../../../docs/runbooks/parallel-live-test-environments.md)
   for target resolution and claims. Refresh readiness when build, actor, claim,
   browser, or target state changes. A status label or live PID alone is not
   evidence that Slack is working.
5. When deploying, set `CHICKPEA_DEPLOY_TARGET=<alias>` explicitly for the
   guarded `npm run deploy`. The wrapper resolves the claimed lane's AUTH_DB ID
   and schema generation from its own preflight; explicit
   `CHICKPEA_DEPLOY_AUTH_DB_ID` / `CHICKPEA_DEPLOY_SCHEMA_GENERATION` still win.
   The preflight reads every active lane's live-authority credential, not only
   the claimed one: from `CHICKPEA_ENV_<COLOR>_LIVE_AUTHORITY_URL` and
   `_READ_TOKEN`, or from the owner-only file
   `~/.chickpea/lane-credentials/<color>-live.json` (`origin`,
   `authorityReadToken`). A `LIVE_AUTHORITY_READ_TOKEN_INVALID` on a lane you
   did not claim means that other lane's credential is missing. Never print
   the token. Never use a bare/default deploy to reach a QA lane. Preserve
   source/claim fences. Verification does not imply landing on main.
   A claim is stamped with the worktree's HEAD. Do not commit, amend, or
   rebase in that worktree while a claimed deploy is running, and re-claim
   after committing before the next deploy: a HEAD that differs from the
   claimed revision fails the deploy's final fence with
   `MUTATION_LEASE_AUTHORITY_CHANGED`, and then `release`, `reclaim`, and
   `reconciliation` all refuse with `CLAIM_REVISION_MISMATCH`. Recovery is to
   check out the claimed revision, run `npm run env -- reconciliation <alias>`
   (it adopts the uploaded version and clears the intent lock), release, and
   only then move HEAD again.
   Only the Slack manifest digest, the required scopes, and
   `src/auth/setup-capability.mjs` are hard-gated against the lane baseline; a
   mismatch refuses with `INSTALL_CONTINUATION_REQUIRED`, and the recovery is to
   prove a fresh install on a disposable target and re-record the baseline.
   Changes to the setup flow (`src/auth/setup-handoff.ts`,
   `src/management/setup-routes.ts`, `src/config/onboarding-state.ts`,
   `src/admin/onboarding-proof.ts`) deploy normally and mark the lane
   `setupFlowUnprovenSince <sha>` in `env status`. Report that marker; in
   `release` mode clear it with a fresh-install journey on a disposable target
   followed by a baseline re-record.
6. `npm run env -- attest <alias>` returns one JSON object whose `targetOverlay`
   and `doctorSnapshot` members are the two doctor inputs; write each to its
   own private file before `npm run verify:live:doctor -- --target <overlay>
   --snapshot <snapshot>`. A doctor `missing_actor` diagnostic is a registry
   gap (no registered actor alias for that lane), not a build failure: report
   it, and continue with the attended checklist as the signed-in test actor.

Use one suitable lane by default. Both colors are needed when explicitly
requested or testing cross-lane isolation, not for every application change.
Amber and Cobalt are ordinary exclusive QA lanes; the historical first protected
Cobalt qualification is not a standing requirement to merge before testing.

## Repair worktrees and serving candidates

Give repair agents separate worktrees based on an identified candidate, with
explicit file ownership and only the retained evidence needed for diagnosis.
They must not access live/shared resources, another task's checkout or processes,
Worker state, claims, credentials, or browser sessions. They return patches and
focused local validation to the verifier. One owner handles overlapping code;
tests and builds remain serial within each checkout and expensive groups use
the shared [host reservation](host-checks.md).

The verifier alone integrates reviewed repairs when authorized and owns the
live lane. Keep its serving candidate fixed for each scenario and observation
window. Fixture changes must follow the declared test actions. Finish or reconcile
open attempts before switching candidates, including pending due-time observations
and cleanup.
Apply the existing source/claim fences at every batch deployment; batching never
permits a stale claim, a mid-deploy HEAD change, or mutation of another task's lane.
Refresh affected evidence after a candidate switch. See the
[batch checkpoint policy](modes.md#repair-loop-and-final-checkpoint).

Use the existing short UI mutex for competing browser actions. Release it during
human waits and retain the affected browser reservation. A hostname change does
not change local ownership. Recovery requires proof that the prior owner stopped.
Never copy lock state between machines.

## Fixture inventory

Before choosing a lane, inventory capabilities by the operation they must enable.
Keep this in the existing private spec and evidence, not a public account list.

| Actor and observed role | Exact lane/context | Connection/provider fixture | Operation to prove |
| --- | --- | --- | --- |
| Owner or Admin | Chosen candidate | Declared synthetic provider rows and owning Agent binding | Positive read/write and exact restoration |
| Distinct Member plus authorized completer | Same candidate | Configured connector and the same pending setup | Permission denial or two-completer setup race |
| Authorized reconnect actor | Same candidate | Disposable connection and dependent run-owned schedule | Authority loss, reconnect and separately graded due recovery |
| Registered installer | Separate disposable installation target | Fresh public artifact and approved test account | Fresh installation and first real request |

Resolve actor identity/role, lane app/workspace pair, Agent/account binding,
provider fixture revision, allowed operation and evidence expiry together.
An existing Member identity does not imply a connector is configured there.
Refresh each capability's context snapshot after any relevant fixture or lane
change. Shared browser control is not shared account authority.

Check the disposable installation target at initial scope selection. If it is
unavailable, keep fresh installation blocked and finish independent cases. Do not
manufacture availability, repurpose a standing lane or provision accounts or
infrastructure merely to complete this inventory.
