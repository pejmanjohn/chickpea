# Live contract acceptance v1

This record separates deterministic verifier checks from live Chickpea acceptance. A green local suite does not prove Slack, Admin, provider, gateway, or cleanup behavior on a serving target.

## Current result

| Field | Result |
| --- | --- |
| Verifier source revision | `14b221fb09e47a651391d640056bfe0dda474eab` |
| Manifest digest | `sha256:a47cc8fa80a94fa16b9cc5b7811356cea9c52754e5206afe03f9c2255888c468` |
| Required smoke variants | 4 |
| Required deep variants | 26 across LC-01 through LC-10 |
| Deterministic verifier checks | Pass: typecheck and 115 verifier/package tests |
| Live doctor | Blocked before a scored run |
| Live smoke | Not started |
| Live deep | Not started |
| Live product mutations | 0 |
| Cleanup or residue verdict | Not applicable; no scored mutation was exposed |

This is not a v1 live acceptance pass.

## Why live execution is blocked

The candidate environment does not yet provide `env target <alias>` and `env attest <alias>` outputs in the verifier schemas. No private coordinator is installed to issue one-use challenges, persist receipts, perform authoritative readback, execute exact product-state cleanup, and provide postflight proof.

The read-only readiness audit also found that the candidate target is not a clean dedicated fixture estate. It has one usable browser actor instead of four distinct role apps, unresolved in-flight or recovery work, and missing exact Slack-app, provider-project, read-only auth-config, and gateway attestations. The verifier source under test is not deployed to that candidate.

Several v1.1 contracts also declare missing authoritative capabilities as blockers:

- canonical avatar source and persona parity;
- durable route, grant, and admission state;
- a safe exact provider-revocation seam;
- pinned skill source provenance;
- content-safe memory and implicit-preference proof;
- private-routine existence and authority state;
- installation baseline, App Home publication, and selected-route state.

Do not replace these with screenshots, response text, operator-entered outcomes, or local store reads.

## What must be true before the first smoke

1. Claim one permitted target. Consume `env target <alias>` and `env attest <alias>` without copying immutable IDs into another format.
2. Resolve Owner, Admin, Member, and second-member aliases to four distinct Computer Use-addressable browser apps in that workspace.
3. Install the private coordinator and prove challenge, receipt, readback, exact cleanup, postflight, and per-target lock behavior without a product mutation.
4. Make every smoke observer available, run doctor, and require a ready result.
5. Start a new immutable scored smoke run. If it passes with cleanup proof, use `dedicated-qa` for the first deep run.

Feature targets may run `case` and `smoke` only. `deep` is reserved for `dedicated-qa`. Different targets may run concurrently on one host; only semantic Computer Use action windows take the short host-local UI mutex.

## Acceptance rule

A future update may mark smoke or deep accepted only after every required variant executes under one attested target and source identity, all product assertions pass, exact cleanup or attributed residue is proven, postflight finds no unmatched run-era state, and the report contains no private coordinate or content.
