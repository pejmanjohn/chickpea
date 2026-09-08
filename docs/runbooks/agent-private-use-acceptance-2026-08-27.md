# Agent Private Use Acceptance — 2026-08-27

## Scope

This record covers the placement-derived private-use contract in
`docs/plans/2026-08-27-2025-feat-agent-private-use-permissions-plan.md`.
It distinguishes automated authorization proof, browser-visible Admin proof,
and the narrower facts established by the shared Acme Slack canaries.

## Code under review

- Branch: `codex/agent-destinations-polish`
- Reviewed head: `024ec09`
- Base: `origin/main` at `2ce61e9`
- The 12 feature commits were rebased cleanly onto current `main`. `git
  range-diff` reported every patch as unchanged.
- No schema migration, persisted ACL, people picker, additional edit mode, or
  permissions page is present.

## Automated proof

The post-rebase gate passed on Node 24:

- `npm test`: 2,210 passed, 0 failed, 0 skipped.
- `npm run verify:admin-ui`: 15/15 checks passed.
- `npm run typecheck`: passed.
- `git diff --check origin/main...HEAD`: passed.

Focused coverage includes placement precedence and uncertainty, current-member
reauthorization for messages and reactions, public and private Agent access,
creator-only no-placement behavior, excluded guest and Slack Connect actors,
requester-only Channel denials, App Home filtering, direct/gateway fact parity,
Admin edit-only visibility, and management-authority separation.

## Admin browser proof

The deployed Admin loaded with an authenticated session while permission build
`f101364c-4ecd-4374-81f1-05b71369b9ba` was active:

- Sprout showed **All workspace members can DM this Agent** and retained its
  Agent name, description, destination card, configuration tabs, and Advanced
  section.
- Night Shift showed **DM access unavailable** rather than stale or falsely
  broad access copy.

The local fixture was then checked after the clean rebase:

- Release Scribe showed the workspace-member audience beside its Slack
  placement.
- At a 390 by 844 viewport, the Agent name, description, audience, setup tabs,
  and Advanced section remained present with no horizontal overflow.
- Unavailable fixture states rendered unavailable copy rather than a broader
  audience.

## Acme Slack canaries

At 22:59–23:03 PDT, the permission build admitted these fresh requests:

- Public Channel root:
  <https://acmeinc-m3j6333.slack.com/archives/C0BF6QR99L6/p1787896797111309>
  - Prompt: `@sprout Reply exactly: Channel access OK after DM permission fix`
  - Reply:
    <https://acmeinc-m3j6333.slack.com/archives/C0BF6QR99L6/p1787896981690109?thread_ts=1787896797.111309&cid=C0BF6QR99L6>
  - Observed response: `Channel access OK`. The Agent responded successfully,
    but shortened the requested exact text.
- Direct-message root:
  <https://acmeinc-m3j6333.slack.com/archives/D0BRBV50NCE/p1787896804608979>
  - Prompt: `Reply exactly: DM access OK after DM permission fix`
  - Reply:
    <https://acmeinc-m3j6333.slack.com/archives/D0BRBV50NCE/p1787896981214929?thread_ts=1787896804.608979&cid=D0BRBV50NCE>
  - Observed response: `DM access OK after DM permission fix`.

The tail showed both requests entering the new Worker before a shared-disposable
collision was discovered. Another active validation had deployed native table
support to the same Worker 44 seconds earlier and had already persisted
`tablePresentations` settlements. Replacing that build with the permission
build caused its older parser to reject those rows and stall the shared durable
queue. No live state was cleared or rewritten. The prior table-validation
version, `183127c4-4784-449e-b7ba-89b2823ee89f`, was restored at 100% so the
queue could drain; both canaries then completed.

This proves that the permission build admitted the public-Agent Channel and DM
requests. Because final delivery completed after restoring the concurrent
build, it is not evidence that `f101364c-4ecd-4374-81f1-05b71369b9ba` completed
the entire delivery pipeline by itself. The post-rebase head was not redeployed
over the still-active table validation.

The permission deployment had preserved the existing `AUTH_DB` binding
(`f3d78082-0141-4aad-ac9e-5e8b7f01f76a`) and reached 100% before the collision
was identified. The current shared Worker is intentionally restored to
deployment `5fe32126-38fb-46de-87d0-c872373b2d11`, version
`183127c4-4784-449e-b7ba-89b2823ee89f`, at 100%.

## Independent review

Fable approved the actor-specific precedence, routing-hint behavior, and strict
group-DM transport handling. Its suggestion to label a globally unresolved
mixed placement as private-only in Admin was not adopted: that would conflict
with KTD6 and R9 because an unresolved sibling placement could be public. A
regression test pins the distinction between actor-specific runtime access and
the conservative global Admin audience projection.

## Remaining live boundaries

- Acme currently exposes one full-member test actor, so private-Channel
  nonmember, creator revocation, guest, and Slack Connect behavior is proven by
  fixtures and integration tests rather than live actors.
- App Home guest and Slack Connect coverage is composed coverage, not a fresh
  publish-chain canary.
- Reaction revocation is router-level coverage rather than a fresh full
  `processSlackEvent` canary.
- Strict MPIM/group-DM behavior is characterized and intentionally fails
  closed.
- A failed Channel-attach response can temporarily omit the detail-only
  audience note until the next detail load; it does not render false audience
  copy.
- Scheduled direct-thread routines are outside this change and are not
  reauthorized after placement-derived access changes. Human messages and
  reactions are reauthorized on each interaction.
- A clean, single-version disposable acceptance sweep should be rerun once the
  concurrent table validation releases the shared Worker. Until then, this
  record supports code readiness but not an unqualified single-version live
  release claim.
