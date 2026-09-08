# Live contract acceptance v1

This record separates deterministic verifier checks from live Chickpea acceptance. A green local suite does not prove Slack, Admin, provider, gateway, or cleanup behavior on a serving target.

## Integration status

The two-lane environment integration now emits selected-target v2 private
config, fixture-complete overlays, and the verifier doctor schema. Active lanes
are Amber and Cobalt, each in its own paid Slack workspace. Fern is parked.
Google Sheets uses its normal managed grant; the acceptance exercise reads only
the declared fixture. The attended coordinator is implemented; formal four-case
acceptance remains outstanding. This is not a live acceptance pass.

The local continuation integrates environment checkpoint `60c3cc7` and the
discoverable operator skill. Deterministic checks cover observation waits with
the UI mutex released, incomplete-cleanup readback, baseline connection
protection, and current-worktree selection in `env status`. LC04 now declares
a separate empty connector-test Agent per lane; its actual provisioning and
private binding are still pending. Existing lane canaries and doctor reports
do not establish readiness for this new fixture or count as formal smoke.

The environment task has now issued its explicit U0 live handoff. The coordinator
has a tested explicit same-run recovery path, including real-process contention
and recovery-process crash checks. Existing Agent and connection screens now have
closed-field saved-record disclosures for visible exact identity/revision reads.
The saved-record disclosures are deployed and have been exercised in real
failed-case cleanup and postflight. A private attended entrypoint and creation
recipe have closed failed requests through exact readback without replay.
Successful creation, the other three UI recipes, connector-test fixture
provisioning, and formal smoke remain pending.

One earlier creation failure was traced to GPT-OSS exhausting its implicit
output budget on reasoning. That fix and the optional read-only Admin creation
delivery disclosure are implemented. A subsequent request created an Agent and
one welcome, but its formal result remains ambiguous because the initial reader
failed. Exact cleanup passed. The next correctly addressed request returned an
explicit creation refusal; it closed as fail with clean postflight. Its cause
is unconfirmed. Neither run establishes a formal happy-path or smoke pass.

Local approval-verification work adds optional, read-only Slack proposal details
for the signed-in requester and selected Agent. These expose frozen instructions,
requester identity mapping, approval scope, and revisions without disclosing
unrelated operations or setup links. This addition is not deployed or live
verified. Missing evidence cannot be replaced by an API assertion or a
successful-looking reply.

## Historical V0 result

| Field | Result |
| --- | --- |
| Verifier implementation revision | `c98b7496e42b9d31a032ad8c3b551ddab6591c8e` |
| Manifest digest | `sha256:058579964b9814fa8b1ca0759a7954da0710923b8c3387ca92d2aa30fe594c38` |
| Required smoke variants | 4 |
| Required deep variants | 26 across LC-01 through LC-10 |
| Phase 1 active targets | `amber` and `cobalt`; environment/schema handoff pending |
| Deterministic verifier checks | Pass: typecheck, 131 verifier tests, 2,502 repository tests, production build, and immutable OSS export |
| Live doctor | Blocked before a scored run |
| Live smoke | Not started |
| Live deep | Continuation-only; not a Phase 1 gate |
| Live product mutations | 0 |
| Cleanup or residue verdict | Not applicable; no scored mutation was exposed |

This is not a v1 live acceptance pass.

The September 2 scope amendment starts with Amber and Cobalt only. The historical foundation snapshot does not establish the current readiness of either lane. Skill discovery is now observed in the active Codex skill catalog; that is not live product proof.

## Historical V0 blockers

The candidate environment does not yet provide `env target <alias>` and `env attest <alias>` outputs in the verifier schemas. The verifier-owned attended coordinator is not implemented to acquire the target lock and UI mutex, issue one-use challenges, persist receipts, drive real Slack/Admin journeys through Computer Use, execute exact product-state cleanup, and provide postflight proof.

The read-only readiness audit also found that the candidate target is not a clean dedicated fixture estate. It has one usable browser actor instead of the roles required by the selected suite, unresolved in-flight or recovery work, and missing exact Slack-app, provider-project, read-only auth-config, and transport attestations. The verifier source under test is not deployed to that candidate.

Several v1.1 contracts also declare missing authoritative capabilities as blockers:

- canonical avatar source and persona parity;
- durable route, grant, and admission state;
- a safe exact provider-revocation seam;
- pinned skill source provenance;
- content-safe memory and implicit-preference proof;
- private-routine existence and authority state;
- installation baseline, App Home publication, and selected-route state.

Before live scoring, expose any required durable truth through a bounded read-only Admin diagnostic surface that Computer Use can inspect. Do not replace a user journey with a direct product API, database assertion, hidden HTTP observer, operator-entered outcome, or local store read.

## What must be true before the first smoke

1. Claim one permitted target. Consume `env target <alias>` and `env attest <alias>` without copying immutable IDs into another format.
2. Resolve every required actor alias to a Computer Use-addressable browser session. The same Owner-capable actor may fulfill the Owner and Member aliases for these non-denial smoke variants; do not infer coverage of distinct-role or access-denial scenarios.
3. Implement the verifier-owned attended coordinator and prove target lock, safe clear-lock, UI mutex/browser reservation, challenge, receipt, visible readback, exact cleanup, and postflight behavior without a product mutation.
4. Make every selected UI observation recipe available, run transport-aware doctor, and require a ready result.
5. After the environment handoff releases it, take an ordinary exclusive claim on clean `cobalt` and start one immutable protected origin/main Computer Use smoke at `LC01-V1-create-welcome`.
6. If it passes with cleanup proof, clean and release the target, then return it to normal branch-lane use. Do not persist a qualification mode or dual-role registry state or require a third environment.

Both color targets bind the same exact four-variant smoke inventory. They run a selected `case` from that inventory or the complete `smoke`; the Phase 1 environment registry rejects `deep`. Different targets may run concurrently on one host; only Computer Use action, input, or observation windows take the short host-wide UI mutex.

Fable 5.1's final plan review required this foundation/live-completion split, exact shared smoke inventory, transport-aware attestation, derived lock path, UI-only scored journey, host-wide UI mutex, and verifier-owned coordinator boundaries. The environment scope keeps first-install automation and deep qualification beyond Phase 1.

## Acceptance rule

Phase 1 may mark smoke accepted only after its four variants execute under one clean attested active-target claim and source identity, all product assertions pass, exact cleanup or attributed residue is proven, postflight finds no unmatched run-era state, and the report contains no private coordinate or content. The first protected-source run uses Cobalt. Deep acceptance is continuation work.
