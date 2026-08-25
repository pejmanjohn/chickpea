# Chickpea system-Agent cutover

This runbook activates Chickpea as the hidden system Agent and makes the Workspace default model authoritative. The cutover is durable, revision-gated, and separate from deploying the code that understands it.

Do not deploy or activate from a development session unless the operator has explicitly authorized the external change. Never record credentials, session cookies, Slack message bodies, Agent instructions, or model responses in cutover evidence.

## Contract

Stage 1 is an activation-capable compatibility build. It continues to run the legacy routing contract until the durable installation is activated. Stage 2 makes `chickpea-v1` the creation contract for new installations by calling `ensureWorkspaceInstallation` with `runtimeContract: 'chickpea-v1'`.

Activation does all of the following in one storage transaction:

- materializes the canonical Chickpea system principal;
- records an owner incarnation for existing thread routes without changing their Agent owner;
- clears only a generated Cloudflare starter pin whose seed identity and generation are proven;
- switches the installation runtime contract to `chickpea-v1`; and
- records non-secret activation evidence.

Other Agent pins are preserved. Model-less Agents and Chickpea inherit the Workspace default live.

## Stage 1: compatibility deployment

1. Deploy the reviewed activation-capable artifact without changing the installation runtime contract.
2. Confirm every production route and worker instance serves that exact artifact. Do not activate during mixed-version traffic.
3. Verify ordinary legacy Slack traffic before preparing the cutover.
4. As an authenticated Chickpea Owner or Admin, call `POST /admin/api/chickpea-cutover/prepare` with:

```json
{ "confirm": "prepare-stage-1" }
```

Preparation is idempotent. It captures `SLACK_TAG_MODEL` once only when the Workspace default is still missing; activated runtime policy never reads that environment value.

5. Call `GET /admin/api/chickpea-cutover/preflight` and retain the returned `installationRevision` and `defaultRevision` for the activation request.

The preflight must report:

- `runtimeContract: "legacy"` before first activation;
- `readyForActivation: true`;
- an empty `blockers` array;
- `defaultHealth.status: "ready"`;
- no reserved identity collisions; and
- the expected pinned, inheriting, route-backfill, and starter-pin counts.

If the default is missing or unhealthy, set or repair it in Settings > Model Providers and run preflight again. If a user Agent occupies the reserved Chickpea ID, name, or handle, rename it before activation. Do not bypass a blocker in storage.

## Activate

After all Stage 1 traffic is confirmed, call `POST /admin/api/chickpea-cutover/activate` with the exact preflight revisions:

```json
{
  "confirm": "activate-chickpea-v1",
  "compatibilityTrafficConfirmed": true,
  "expectedInstallationRevision": 1,
  "expectedDefaultRevision": 1
}
```

Replace the sample revisions with the preflight values. A `409` means the preflight is stale or the default is not ready; fetch a fresh preflight and investigate rather than retrying the old request.

Activation acceptance:

- a new plain base-app DM is answered by Chickpea;
- a new base-app DM with exactly one user-Agent handle is answered by that Agent;
- later unmentioned replies in that thread stay with its owner;
- a later explicit handle transfers ownership for subsequent replies;
- an existing pre-cutover Agent-owned thread retains its Agent owner;
- Chickpea does not appear in the Agent sidebar or editable Agent list;
- an unpinned Agent and Chickpea reflect a Workspace default change immediately; and
- an explicitly pinned Agent does not change.

Record only the artifact identifier, time, operator, returned revisions, classifications/counts, and pass/fail results.

## Compatibility rollback

Rollback order is mandatory:

1. While the activation-capable Stage 1 artifact still owns all traffic, fetch preflight and call `POST /admin/api/chickpea-cutover/rollback` with its current installation revision:

```json
{
  "confirm": "rollback-to-legacy",
  "expectedInstallationRevision": 2
}
```

2. Confirm the returned state is `rolled_back` and `runtimeContract` is `legacy`.
3. Verify one new root and one existing root under the legacy contract.
4. Only then may traffic return to the reviewed Stage 1 artifact or another build that understands the persisted Chickpea principal.

Rollback retains the Chickpea system row so durable identity is not destroyed. It restores the proven generated starter pin only when that pin has not been edited since activation. Never route an activated installation to a pre-change worker that does not understand the Chickpea system principal.

## Stage 2 and new installations

After activated workspaces pass acceptance, deploy the post-gate build that supplies `runtimeContract: 'chickpea-v1'` when it calls `ensureWorkspaceInstallation`. This creates the installation, Workspace default, Chickpea principal, and starter-pin disposition atomically for new workspaces. Do not implement this gate with an environment-variable branch.

Thread continuity follows the durable route owner and incarnation. A deliberate owner transfer may rebuild bounded public Slack context for the new Agent; it does not copy private Agent state.

## Evidence checklist

- reviewed commit and artifact identifier
- Stage 1 all-traffic confirmation
- prepare and preflight time
- default health and non-secret classification/counts
- activation or rollback revision receipt
- new-root and existing-root Slack acceptance
- Workspace default live-inheritance acceptance
- Stage 2 creation-contract status

