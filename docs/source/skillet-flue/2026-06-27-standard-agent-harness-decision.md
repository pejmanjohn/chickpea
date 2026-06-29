# Standard Agent Harness Decision

Date: 2026-06-28

Status: accepted for next-slice planning, not accepted for product migration

Plan: `docs/plans/2026-06-27-001-feat-standard-agent-harness-migration-plan.md`

Evidence:

- `docs/decisions/2026-06-27-agent-harness-api-fit.md`
- `docs/decisions/2026-06-27-project-think-repo-dossier.md`
- `docs/decisions/2026-06-27-project-think-office-hours-decision.md`
- `docs/decisions/2026-06-27-project-think-skill-rollout-playbook.md`
- `docs/evals/office-hours-standard-harness-comparison.md`
- `packages/core/src/evals/office-hours-runtime/descriptors.ts`
- `apps/agent-runtime/src/harness-candidates/`

External review:

- Oracle session `standard-agent-harness-review-two` was incorporated before
  execution. Adopted recommendations include explicit candidate contracts,
  candidate DO/state isolation gates, product-path promotion before browser
  parity, Pi Worker/safety preflight, early Flue generated-target audit,
  baseline-vs-candidate runtime descriptors, model telemetry requirements,
  framework-state redaction checks, maintenance ownership accounting, and the
  expanded fault matrix.
- Oracle session `standard-harness-decision-review` failed after browser
  launch with `chrome-disconnected`. It did not produce additional findings to
  incorporate.
- Local correctness/testing/simplification review was run after execution.
  Adopted fixes include allowing experimental candidates only for `staff_eval`
  or `local_eval`, table-driven disabled-route coverage for Think/Pi/Flue
  create/turn/stream/state routes, explicit Pi/Flue probe-failure blocker
  classifications, manifest metadata checks for harness/framework/runtime
  contract fields, descriptor blocker alignment, and removal of accidental root
  package metadata.

## Decision

Do not migrate Office Hours to Think, Pi-direct, or Flue yet.

Keep the current custom Cloudflare Agents harness as the production control. It remains the only runtime with the full Skillet product contract proven through create, turn, SSE, stream-token auth, `ask_user_question`, `custom_tool_result`, `emit_section`, D1/R2 authority, runtime routing, budget gates, and rollback.

The next standardized-harness slice should remain **Think product-path proof**, not Flue migration. Think has the closest fit because it is Cloudflare-native and exposes a server-side streaming turn API. Follow-up upstream research found that Think now has first-class delayed client-tool-result, server-side action/tool, and AI SDK usage/telemetry surfaces. The Office Hours Think candidate also proved the first adapter layer locally: Skillet-shaped SSE, delayed `ask_user_question` / `custom_tool_result` continuation, `emit_section` through shared tool-effect logic, model-usage events, and seeded state-scan output.

Think has now entered local product-path canary once and proved the hardest
Skillet plumbing through the real browser/SSE/D1 path. It still cannot migrate
production until the remaining comparison and inspection gates pass:

1. full seven-section R2 publish is proven through Think, not only a one-section partial artifact;
2. full Think-owned DO/table/storage inspection is clean, not only the sanitized state endpoint and generated evidence files;
3. SC5 is repeated and the extra Think follow-up question is either accepted
   as quality-neutral or tuned out, and SC1/SC6 are repeated enough to
   characterize variance;
4. repeated browser proof shows the structured-question path and terminal idle
   transition are stable enough for staff/local canary;
5. a separate production-switch plan keeps the current custom Cloudflare harness as rollback.

Pi-direct remains a secondary harness fallback if Think's bridge is too awkward. Flue remains the preferred long-term framework candidate only if Skillet decides to adopt generated Cloudflare Durable Object topology and generated deploy output.

## Confidence

Confidence: medium-high for the decision not to migrate now; medium for Think as the next slice.

Reasons:

- Think, Pi, and Flue all have executable or generated-target evidence, not only docs.
- The current custom harness was preserved and verified after the `agents 0.17.0` upgrade.
- Experimental runtime contracts are registered and blocked from public/default
  assignment; only `staff_eval` and `local_eval` can select them.
- Disabled internal candidate endpoints reject unauthorized traffic and do not
  echo tokens across Think/Pi/Flue create, turn, stream, and state route shapes.
- The comparison harness now records candidate promotion blockers before browser parity is attempted, the live pair runner can produce direct current-Cloudflare-control vs Think-treatment packets, and the product-path packet builder has produced passing SC1, SC5, and SC6 packets from browser summaries plus D1 evidence.

Main uncertainty:

- Think's native delayed client-tool-result channel and Skillet's adapter now
  work through the local product path. SC5 same-model evidence exists and shows
  D1 turn-attempt/question/tool/usage/artifact lanes passing. The current
  packet has no automatic blockers, but Think asks one extra pending question
  after the first section, so SC5 still needs repetition and quality review.
- One SC1 product-path packet passed automatic gates with browser evidence, D1 usage/cost evidence, and a committed `Problem` section on both control and Think. It is still one-section synthetic browser/D1 evidence, not raw provider trace parity or full-document proof.
- Think's section and usage bridges now write live Skillet D1 product rows. SC6 replay/revision has one passing latest-write-wins packet, but full seven-section publish and repeated variance evidence are still missing.
- A direct SC1 current-control vs Think retry completed as a failure packet rather
  than hanging, but it still lacked browser evidence and complete usage, and it
  did not produce section parity. This is useful runner proof, not promotion
  proof.
- Think persists broad framework state. That is expected for the harness, but Skillet must run a full seeded-secret state scan against Think-owned storage before any production migration.
- Flue's beta and Agents SDK version posture may change quickly; revisit after upstream aligns with `agents 0.17.x+`.

## Candidate Verdict

| Candidate | Verdict | Why |
| --- | --- | --- |
| Current custom Cloudflare | Keep as production control | Full product contract is already owned and rollback-safe |
| Think | Continue staff/local spike | Best Cloudflare-native harness fit; local product-path browser/SSE/D1 proof, rollback, and SC6 replay/revision proof now exist, but repeated comparison, full storage inspection, and full publish proof are unproven |
| Pi-direct | Defer | Worker-viable, but Skillet still owns safety, telemetry, side effects, and transport glue |
| Flue/Pi | Defer | Strong framework direction, but generated DO topology/deploy pipeline is too large for the next step |

## Canary Plan

No production or public-default candidate canary should be opened from the current evidence.

Prepare a Think-only staff/local product-path canary only after these gates pass:

- Add a separate Think Durable Object class/binding or prove a namespaced-state strategy that cannot collide with current `OfficeHoursAgent` state. Done for the internal candidate path.
- Implement a candidate bridge for `POST /internal/office-hours/think/create`, `/turn/:session`, `/stream/:session`, and `/state/:session` behind an explicit disable flag. Done for direct internal local proof.
- Prove full seven-section publish, including R2 markdown output.
- Inspect full Think-owned state after seeded-secret product-path sessions for raw runtime tokens, auth headers, provider keys, internal RPC secrets, and user-sensitive runtime secrets.
- Repeat SC1/SC5/SC6 through the product-path browser verifier, D1 evidence
  collector, and product comparison packet builder for current Cloudflare
  control vs Think.
- Repeat product-path browser proof enough to characterize structured-question stability.

If those pass, candidate routing should be staff/local only:

- runtime contract: `cloudflare-think-office-hours-v0`
- route prefix: `/internal/office-hours/think`
- assignment bucket: `staff_eval` or `local_eval`
- public default: unchanged `cloudflare-agent-office-hours-v1`
- rollback: disable the Think candidate flag and keep new sessions on the current custom harness

## Follow-Up Work

| Priority | Work item | Evidence needed |
| --- | --- | --- |
| P0 | Think SC5 delayed-result comparison | Product path already accepts D1 pending-question answers before Think continuation; SC5 same-model rerun packet passes automatic gates with D1 turn-attempt/question/tool/usage/artifact proof, but Think asks one extra pending question and still needs repeat/quality review plus duplicate/stale answer proof |
| P0 | Think SC6 section replay/revision comparison | First same-model product packet passes with sections `1,2,2,3`, no canonical duplicates, and matching UX hash; repeat for variance/cost confidence |
| P0 | Think full state/secret inspection | Deterministic seeded-secret scan across Think-owned DO SQLite, storage, hibernation state, workspace state, eval artifacts, public SSE, and optional MCP state |
| P1 | Think full publish proof | Full seven-section product canary writes final artifact/R2 markdown through Think |
| P1 | Candidate browser/fault matrix | Repeat SC1/SC5/SC6 product-path browser proof and add fault/recovery drills |
| P2 | Pi-direct safety probe | Worker storage adapter and explicit permission model |
| P2 | Flue deploy-topology experiment | Generated config mounted behind `apps/agent-runtime` without taking product authority |

## Rollback

Rollback remains the current hosted runtime routing posture:

- the custom Cloudflare runtime contract stays available;
- experimental contracts are disabled by default;
- public/default route assignment rejects experimental candidate contracts;
- missing candidate deployments fail closed instead of falling back silently;
- no candidate Durable Object migration has been deployed.
