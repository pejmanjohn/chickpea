# Live contract acceptance v1

This record separates deterministic verifier checks from live Chickpea acceptance. A green local suite does not prove Slack, Admin, provider, gateway, or cleanup behavior on a serving target.

## Current result

| Field | Result |
| --- | --- |
| Readiness-audit source revision | `14b221fb09e47a651391d640056bfe0dda474eab` |
| Manifest digest | `sha256:a47cc8fa80a94fa16b9cc5b7811356cea9c52754e5206afe03f9c2255888c468` |
| Required smoke variants | 4 |
| Required deep variants | 26 across LC-01 through LC-10 |
| Deterministic verifier checks | Pass: typecheck, 120 verifier/package tests, 2,483 repository tests, production build, and immutable OSS export |
| Live doctor | Blocked before a scored run |
| Live smoke | Not started |
| Live deep | Not started |
| Live product mutations | 0 |
| Cleanup or residue verdict | Not applicable; no scored mutation was exposed |

This is not a v1 live acceptance pass.

## Why live execution is blocked

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
2. Resolve every actor required by the selected target's `allowedVariants` to distinct Computer Use-addressable browser apps. The full deep target uses Owner, Admin, Member, and second-member roles.
3. Implement the verifier-owned attended coordinator and prove target lock, safe clear-lock, UI mutex/browser reservation, challenge, receipt, visible readback, exact cleanup, and postflight behavior without a product mutation.
4. Make every selected UI observation recipe available, run transport-aware doctor, and require a ready result.
5. Start a new immutable scored smoke run. If it passes with cleanup proof, use `dedicated-qa` for the first deep run.

Feature targets run selected `case` variants and may run `smoke` only when they contain its exact inventory. `deep` is reserved for `dedicated-qa`. Different targets may run concurrently on one host; only Computer Use action, input, or observation windows take the short host-local UI mutex.

Fable 5.1's final code-backed review approved this foundation/live-completion split and required the target subset, transport-aware attestation, derived lock path, UI-only scored journey, and verifier-owned coordinator boundaries recorded above.

## Acceptance rule

A future update may mark smoke or deep accepted only after every required variant executes under one attested target and source identity, all product assertions pass, exact cleanup or attributed residue is proven, postflight finds no unmatched run-era state, and the report contains no private coordinate or content.
