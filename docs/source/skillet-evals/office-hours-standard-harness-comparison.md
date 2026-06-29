# Office Hours Standard Harness Comparison

Date: 2026-06-29

Plan: `docs/plans/2026-06-27-001-feat-standard-agent-harness-migration-plan.md`

Evidence record: `docs/decisions/2026-06-27-agent-harness-api-fit.md`

Think repo dossier: `docs/decisions/2026-06-27-project-think-repo-dossier.md`

## Summary

The current Office Hours Cloudflare path is still the only production/product-path runnable runtime. It is a custom Skillet harness on the Cloudflare Agents SDK base `Agent`, not Project Think, Pi, or Flue.

The candidate work found useful upstream leverage and a local canary-ready
Think path, but no production replacement has been switched on:

- **Think**: strongest next harness candidate because it is Cloudflare-native and exposes server-side `runTurn({ mode: "stream" })`. The Office Hours candidate now has a separate `ThinkOfficeHoursAgent` Durable Object, disabled-by-default internal `/internal/office-hours/think/*` routes, a Skillet-shaped SSE stream bridge, live delayed `ask_user_question` / `custom_tool_result` proof, live `emit_section` proof through shared tool-effect logic, `onStepFinish` model-usage events, a seeded state-scan CLI, a staff/local-only web route selector for `cloudflare-think-office-hours-v0`, and product-path proof through the real `/office-hours/new -> /o` browser/SSE/D1 flow. The live comparison runner can now express current Cloudflare control vs Think treatment, and the product-path packet builder can compare browser summaries plus D1 evidence without claiming raw provider trace parity. SC1 has a passing product packet; fresh isolated side-port SC5 and SC6 control-vs-Think packets also now pass automatic gates with browser evidence on both sides. A guarded U8 full-publish rerun passed the browser and strict product-evidence gates with all seven sections, non-empty `markdown_r2_key`, clean Think DO SQLite state scan, and clean R2 markdown redaction scan. The latest side-port bridge-fix run also reached `Ready`, drafted all seven sections, and passed strict product evidence with a non-empty `markdown_r2_key`. The remaining blockers are rollout discipline, default-off product routing, and a staff-canary UX threshold for GLM's high question count, not missing Think bridge/persistence semantics.
- **Pi-direct**: Worker-viable in a temp faux-provider probe. Blocked because Skillet would still own permission boundaries, product side effects, blocking-question resume, provider telemetry, and dependency-surface control.
- **Flue/Pi**: generated Cloudflare target builds and dry-runs. Blocked because it brings generated Durable Object topology, generated Wrangler deploy output, DO SQLite harness state, Agents SDK version reconciliation, and a larger framework adoption surface.

Update on 2026-06-28: the stale full-publish browser repeat appears consistent
with a missing POST cursor bridge, not missing D1/R2 side effects. The browser
already sent `Last-Event-ID` on GET resume, but ordinary POST `/turn` and
question-answer turns did not carry that cursor into the Cloudflare hosted
runtime or Think replay path. The code now forwards that cursor through the
hook, `apps/sse`, `packages/core`, `apps/agent-runtime`, and Think/custom-agent
replay handlers; focused tests pass. This mitigates the settlement risk but
does not replace a live full-publish browser rerun.

Live rerun note: `browser-think-full-publish-cursor-replay/` did not close the
gate. The run reached a clean local Think session and preserved structured
question UI, but Workers AI returned a remote `504 Gateway Time-out` after one
section; product evidence correctly failed `--full-publish` with
`max_sections=1` and `markdown_r2_key=missing`. The immediate retry failed at
web session creation with `POST /api/sessions 502`, while a direct internal
Think create probe still returned 200. Treat both as non-passing live evidence,
not as a rollback of the cursor-unit proof.

GLM thinking-off update on 2026-06-28: disabling GLM thinking through Workers AI
provider options materially improved Think first-response latency. Direct Think
GLM 5.2 first-question runs improved from 54.4s to 14.7s and 10.7s, with a
two-step run reaching the first question in 9.4s and the second in 20.3s. The
real browser full-publish gate is still open: the clean product-path run
`browser-think-full-publish-thinking-off/browser_cma_glm_5_2_1782675830912/`
reached first structured question in 10.3s and wrote route/usage/question/
transcript evidence, but failed `--full-publish` with zero sections after a
Workers AI 504. A later apparent six-section retry is invalid because stale
`00b1` web/SSE listeners retook the ports, and the final clean-stack retry
failed before session creation with web `POST /api/sessions 502`. The next
rerun added an explicit local port ownership guard to the browser verifier and
started from clean `3000`/`8787`/`8792` listeners under the same worktree:
`browser-think-full-publish-guarded/browser_cma_glm_5_2_1782686094522/`.
That guarded run is valid but non-passing evidence. Session
`sks_YbJOt2GNTrSBYudeRFbzpe0E` routed to
`cloudflare-think-office-hours-v0`, recorded six completed turn attempts, six
usage events, five accepted pending questions, 17 transcript rows, and one
committed `Problem` section at 115.7s from session create. The browser timed
out after 180s with one visible section and one plain-text blocking-question
finding; product evidence failed only the full-publish artifact gate
(`max_sections=1`, `markdown_r2_key=missing`). The eval artifact redaction scan
and Think DO SQLite secret scan both passed with zero findings, and post-run
port ownership still resolved to the same checkout. Treat this as provider /
model / behavior evidence, not topology noise.

U8 full-publish update on 2026-06-28: after teaching the browser verifier to
answer workflow/status-quo cards with seeded freeform evidence instead of a
coarse option label, the guarded product-path canary passed:
`tmp/evals/office-hours-runtime/browser-think-full-publish-u8/browser_cma_glm_5_2_1782688387174/`.
Session `sks_YxgK_CK3f3UsaFkZtQbcYSGt` routed to
`cloudflare-think-office-hours-v0` under `local_eval`, reached all seven
canonical sections, recorded no browser errors, no plain-text blocking
questions, no empty assistant bubbles, and no reasoning leak. Strict
`--full-publish` product evidence passed with `turn_attempts=12`,
`usage_events=20`, `total_cost_nanos=106082680`, three accepted questions,
nine committed section effects, seven distinct canonical sections,
`markdown_r2_key=design-docs/2026-06-28/d2d5a9cc-1a1d-4c23-a9b6-fd68aed4581f.md`,
and 36 transcript rows. The run artifact redaction scan, Think DO SQLite
secret scan (`tableCount=29`, `rowCount=831`), and local R2 markdown redaction
scan all passed with zero findings. Browser first visible output was 17.5s
after the first user action; first section was 59.5s after the first user
action.

Side-port update on 2026-06-29: after adding per-worktree local port profiles,
fresh `14aa` evidence used `3001`/`8788`/`8793` instead of the default
`3000`/`8787`/`8792` stack. SC5 packet
`tmp/evals/office-hours-runtime/product-packets/sc5-sideports-control-vs-think-20260629/`
reports `manifestOk=true` and no automatic blockers: sections `1 -> 1`,
questions `1 -> 2`, browser evidence `3 -> 3`, lifecycle `idle -> idle`.
SC6 packet
`tmp/evals/office-hours-runtime/product-packets/sc6-sideports-control-vs-think-20260629/`
also reports `manifestOk=true` and no automatic blockers: sections `2 -> 2`,
questions `0 -> 0`, browser evidence `3 -> 3`, lifecycle `idle -> idle`, and
matching UX hash. The final Think full-publish attempt
`tmp/evals/office-hours-runtime/browser-think-full-publish-sideports-20260629/browser_cma_glm_5_2_1782761168923/`
reached `Ready` with seven sections and passed strict product evidence
(`usage_events=15`, `tool_effects=7`, non-empty `markdown_r2_key`, 28 transcript
rows) plus Think SQLite and R2 markdown scans with zero findings, but failed the
browser gate with `plainTextBlockingQuestionCount=2`. The retry
`tmp/evals/office-hours-runtime/browser-think-full-publish-sideports-retry-20260629/browser_cma_glm_5_2_1782761483025/`
timed out after five sections; product evidence failed only the full-publish
artifact gate (`max_sections=5`, missing `markdown_r2_key`). Keep Think
`preflight_only` until this full-publish browser variance is fixed or explicitly
gated out of a very narrow staff canary.

Bridge-fix update on 2026-06-29: the side-port failure above was narrowed to two
bridge/eval issues rather than a Think topology blocker. First, synthetic
plain-text questions emitted only `skillet.question_requested`; the SSE runtime
parser intentionally drops runtime-origin synthetic question events, expecting
the product gateway to re-surface questions from `agent.custom_tool_use`. The
Think bridge now emits a synthetic `agent.custom_tool_use` with
`ask_user_question` before the synthetic question event, so the existing
pending-question ledger and browser qcard path handle it exactly like a real
tool call. Second, synthetic questions reused a fixed `qid`, which collapsed
multiple product ledger rows under `pending_question`'s `(session_id,
question_id)` key; synthetic qids now include the synthetic tool-use id.

The first post-fix browser run
`tmp/evals/office-hours-runtime/browser-think-full-publish-sideports-synthetic-tooluse-20260629/browser_cma_glm_5_2_1782768019669/`
reached `Ready`, drafted all seven sections, recorded no browser errors, no
plain-text blocking questions, no empty assistant bubbles, and no reasoning
leak. Strict product evidence passed with `turn_attempts=14`,
`usage_events=23`, `tool_effects=8`, seven canonical sections, non-empty
`markdown_r2_key`, and 39 transcript rows.

The qid-corrected rerun
`tmp/evals/office-hours-runtime/browser-think-full-publish-sideports-synthetic-qid-20260629/browser_cma_glm_5_2_1782768374090/`
also reached `Ready` with seven canonical sections. Its raw browser summary
counted six plain-text questions from the completed final recap/Open Questions
content, not from a blocked chat turn, so the verifier gate now ignores
plain-question counts once the page is `Ready` and the target section count has
been met. Strict product evidence passed with `turn_attempts=14`,
`usage_events=23`, `pending_questions=14`, `accepted=13`, seven committed
section effects, `markdown_r2_key=design-docs/2026-06-29/3b70a90d-1ccf-47b0-be81-570b76062dfa.md`,
and 49 transcript rows. The one unaccepted question is the final approval /
continue card after the artifact is already complete. Follow-up scans passed:
`think-sqlite-secret-scan.json` reports `ok=true`, `tableCount=29`,
`rowCount=1011`, and zero findings; `r2-markdown-redaction-scan.json` reports
`ok=true`, `scannedFileCount=1`, and zero findings; generated artifact
`redaction-scan.json` reports `ok=true`, `scannedFileCount=3`, and zero
findings.

## Runtime Descriptor Matrix

The committed descriptor matrix lives in `packages/core/src/evals/office-hours-runtime/descriptors.ts`.

| Runtime id | Role | Harness | Framework | Contract | Readiness | Browser parity |
| --- | --- | --- | --- | --- | --- | --- |
| `cloudflare` | control | `base-agent-manual-sse` | `none` | `cloudflare-agent-office-hours-v1` | runnable | allowed |
| `cloudflare-think` | treatment | `think` | `project-think` | `cloudflare-think-office-hours-v0` | preflight_only | skipped |
| `cloudflare-pi` | treatment | `pi-direct` | `pi` | `cloudflare-pi-office-hours-v0` | preflight_only | skipped |
| `cloudflare-flue` | treatment | `flue` | `flue` | `cloudflare-flue-office-hours-v0` | preflight_only | skipped |

## Candidate Evidence

| Candidate | Proof completed | Promotion blockers |
| --- | --- | --- |
| Current custom Cloudflare | Existing production path, `agents 0.17.0` upgrade proof, focused package tests, workspace checks, dry-run builds | Still Skillet-owned loop/state/SSE/tool side effects |
| Think | Typechecked `@cloudflare/think 0.11.0`; separate `ThinkOfficeHoursAgent` DO binding/migration; disabled-by-default internal candidate routes; Skillet-shaped SSE bridge; live delayed `ask_user_question` / `custom_tool_result` proof; live `emit_section` proof through shared product side-effect logic; usage telemetry from `onStepFinish`; staff/local route selector; product-path browser/D1/R2 proof through real `/office-hours/new -> /o`; SC1 product packet plus fresh isolated side-port SC5 and SC6 control-vs-Think packets all pass automatic gates; prior U8 full-publish canary passed browser/product/storage with seven sections; latest side-port bridge-fix full-publish run passed strict product evidence with seven sections, durable synthetic-question rows, and non-empty `markdown_r2_key` | Product path remains disabled by default; staff canary rollout not run; production switch plan remains separate; GLM question count is high enough to gate narrowly |
| Pi-direct | Temp Worker-shaped TypeScript probe passed; faux runtime execution returned a Skillet-shaped message/end-turn pair; Wrangler dry-run passed | Not in repo deps; large dependency surface; permission boundary remains Skillet-owned; no question/section/telemetry product proof |
| Flue/Pi | Temp generated Cloudflare target passed `flue build`; generated Wrangler dry-run passed with `FlueRegistry` and generated agent DO | Generated DO migration/deploy pipeline required; DO SQLite state must remain secondary; `agents 0.14.5` vs Skillet `0.17.0`; no SSE/tool/product-state proof |

## Maintenance Delta

| Responsibility | Current custom | Think | Pi-direct | Flue/Pi |
| --- | --- | --- | --- | --- |
| Prompt/context ownership | Skillet | shared with Think | shared with Pi | Flue harness |
| Tool loop | Skillet | Think can own more than originally assumed; Skillet bridges still needed | Pi can own part, bridge needed | Flue/Pi owns much of it |
| Blocking question state | Skillet proven | Think bridge now proven in internal and product paths, including synthetic plain-text fallback through the normal product question ledger | unresolved | unresolved |
| `emit_section` side effects | Skillet proven | Think server-tool path now works in candidate-local and product paths; SC6 replay/revision passed once with latest-write-wins product evidence | bridge required | bridge required |
| SSE bridge | Skillet proven | bridge required | bridge required | Flue stream mapping required |
| Event replay/recovery | Skillet custom | Think likely helps | Pi partially helps | Flue likely helps most |
| Model telemetry/cost | Skillet proven for current path | Think emits `span.model_request_end` from `onStepFinish`; live product canaries write Skillet D1 `session_usage_event` rows; repeated cost and fail-closed accounting evidence still required | unproven | unproven |
| Product data authority | Skillet D1/R2 | must remain Skillet | must remain Skillet | must remain Skillet despite Flue DO SQLite |
| Rollback | current runtime route | disabled candidate | disabled candidate | disabled candidate |

## Browser And Fault Matrix

Think browser/product-path runs have now been executed under `local_eval`.
They prove the basic Skillet product contract can route through Think, including
a repeated clean seven-section full-publish browser/product evidence packet and
fresh side-port SC5/SC6 paired browser/product packets. The descriptor remains
`preflight_only` because production routing remains default-off and the first
staff rollout still needs a narrow launch packet with rollback/fault coverage,
storage scans, and explicit GLM question-count tolerance. The
direct runner can now create current-Cloudflare-control vs Think-treatment
packets, and the product-path packet builder has produced passing SC1, SC5,
and SC6 packets from browser summaries plus D1 evidence. Direct packets do not
replace browser/D1 proof, and synthetic product packets do not replace raw
provider trace capture.

Next browser/fault matrix trigger:

- repeat the seven-section side-port full-publish canary as part of the staff
  packet, with the corrected synthetic-question bridge and verifier gate;
- full Think-owned DO/table/R2 storage inspection continues to repeat cleanly;
- SC1 remains the light one-section check; SC5 and SC6 now have fresh same-model
  side-port paired packets with browser evidence on both sides and no automatic
  blockers;
- only after those gates should the runtime descriptor change from
  `preflight_only` to runnable.

## Project Think Implementation Update

Plan: `docs/plans/2026-06-27-002-feat-project-think-harness-migration-plan.md`

Decision record: `docs/decisions/2026-06-27-project-think-office-hours-decision.md`

Rollout playbook: `docs/decisions/2026-06-27-project-think-skill-rollout-playbook.md`

Implemented and verified in the internal candidate path:

- `apps/agent-runtime` exports `ThinkOfficeHoursAgent` behind a separate Durable Object binding and migration.
- `/internal/office-hours/think/create|turn|stream|state` are fail-closed unless `THINK_OFFICE_HOURS_CANDIDATE_ENABLED` is set.
- Normal user turns stream through Think and emit Skillet-shaped SSE.
- `ask_user_question` client tools are persisted into Think, AI SDK `tool-input-available` chunks are parsed, browser-style `custom_tool_result` answers apply through Think's private tool-result bridge, and continuation uses public `runTurn({ continuation: true })`.
- `emit_section` executes through shared Office Hours tool validation/effect logic and emits Skillet-shaped section/artifact events, currently against candidate-local state.
- `onStepFinish` emits sanitized model usage events.
- `scan-think-state.ts` rejects seeded operational secrets and generic bearer/API/stream-token patterns.

Local proof captured on 2026-06-27:

- Current section-loop canary:
  session `sks_think_loop_1782590262` in
  `tmp/evals/office-hours-runtime/think-internal-current/20260627T125742-section-loop/`
  emitted `skillet.section_drafted`, `think.tool_call_detected`,
  `agent.custom_tool_use`, two `span.model_request_end` events,
  `agent.message`, and `session.status_idle`; sanitized state reported
  `section_count=1`, `tool_effect_count=1`, `model_usage_event_count=2`,
  `runtime_contract_version=cloudflare-think-office-hours-v0`,
  `harness_id=think`, and `framework_id=project-think`; seeded state and
  generated-artifact secret scans passed with no findings.
- Current delayed-question canary:
  session `sks_think_question_1782590208` in
  `tmp/evals/office-hours-runtime/think-internal-current/20260627T125648-question/`
  emitted `skillet.question_requested`, accepted browser-style
  `custom_tool_result`, emitted `user.custom_tool_result` and
  `think.tool_result_applied`, produced two `span.model_request_end` events,
  and passed seeded state/artifact secret scans.
- Artifact root redaction scan:
  `tmp/evals/office-hours-runtime/think-internal-current/redaction-scan-current.json`
  reports `ok=true`, `scannedFileCount=16`, and zero findings across the
  current internal Think artifacts.
- Product-path browser canary:
  session `sks__JIgzbDCvdKGXwAxRhQqXPBV` in
  `tmp/evals/office-hours-runtime/browser-think/browser_cma_glm_5_2_1782596941297/`
  used the real `/office-hours/new -> /o` flow with model `glm-5-2` and
  `runtime_contract_version=cloudflare-think-office-hours-v0`. The browser
  verifier reported `status=Waiting for answer`, `sectionsDrafted=1`,
  `sectionHeadings=["Problem"]`, `questionCount=1`,
  `plainTextBlockingQuestionCount=0`, `emptyAssistantBubbles=0`,
  `reasoningLeakVisible=false`, and no browser errors, with screenshot and
  video artifacts.
- Product-path D1 evidence:
  `tmp/evals/office-hours-runtime/browser-think/browser_cma_glm_5_2_1782596941297/product-evidence.json`
  reports `status=pass`: Think runtime route ready under `local_eval`,
  `usage_events=3`, `total_cost_nanos=22593120`, pending-question rows,
  `tool_effects=1`, `committed_tool_effects=1`, `design_docs=1`,
  `max_sections=1`, and transcript rows. `markdown_r2_key=missing` is expected
  for a one-section partial canary.
- Clean-stack full-publish product canary:
  `tmp/evals/office-hours-runtime/browser-think-full-publish-clean-stack/browser_cma_glm_5_2_1782624072326/`
  session `sks_eu4uulJCKlezq8vI1w8dRJ37` reports `status=Ready`,
  `sectionsDrafted=7`, all canonical section headings, no plain-text blocking
  question, no empty assistant bubbles, no visible reasoning leak, and no
  browser errors. `product-canary-evidence.json` reports `status=pass` with
  `runtime_contract_version=cloudflare-think-office-hours-v0`,
  `policy_bucket=local_eval`, `usage_events=13`,
  `total_cost_nanos=106225360`, `tool_effects=7`, `section_committed=7`,
  `design_docs=1`, `max_sections=7`, `design_doc_version=8`,
  non-empty `markdown_r2_key`, and transcript rows.
- Full-publish storage/redaction evidence:
  `tmp/evals/office-hours-runtime/browser-think-full-publish-clean-stack/browser_cma_glm_5_2_1782624072326/think-sqlite-secret-scan.json`
  reports `ok=true`, `tableCount=29`, `rowCount=1399`, and zero findings
  across the local `ThinkOfficeHoursAgent` Durable Object SQLite state using
  local operational secrets as canaries plus generic bearer/API-key/stream-token
  patterns. The report stores table names, row counts, and finding paths only.
  `r2-markdown-redaction-scan.json` reports `ok=true`, `scannedFileCount=1`,
  and zero findings for the local extensionless R2 markdown blob backing the
  published `markdown_r2_key`.
- Full-publish repeat mixed evidence:
  `tmp/evals/office-hours-runtime/browser-think-full-publish-repeat-clean-stack/browser_cma_glm_5_2_1782625402578/`
  session `sks_Y9raQJY4_ApsfDvn5OUqUi9E` is not a clean browser repeat pass.
  The browser verifier timed out with `sectionsDrafted=1`, heading `Problem`,
  `plainTextBlockingQuestionCount=1`, no empty assistant bubbles, no visible
  reasoning leak, and a final screenshot showing the left pane still in a
  drafting/continue state. The product ledger still passed the strict
  full-publish collector: `tool_effects=7`, `committed_section_effect_count=7`,
  `distinct_committed_section_number_count=7`, `design_docs=1`,
  `max_sections=7`, `design_doc_version=8`, non-empty `markdown_r2_key`,
  `usage_events=6`, and transcript rows. Repeat storage scans also passed:
  `think-sqlite-secret-scan.json` reports `ok=true`, `tableCount=29`,
  `rowCount=1682`, and zero findings; `r2-markdown-redaction-scan.json`
  reports `ok=true`, `scannedFileCount=1`, and zero findings. Treat this as a
  UI/SSE settlement risk, not a product side-effect failure.
- Product-path state/redaction evidence:
  `tmp/evals/office-hours-runtime/browser-think/browser_cma_glm_5_2_1782596941297/state/think-state-secret-scan.json`
  and `redaction-scan.json` both report `ok=true` with zero findings against
  the sanitized Think state snapshot and generated evidence files.
- Rollback drill:
  `tmp/evals/office-hours-runtime/browser-think/rollback-drill/rollback-result.json`
  reports HTTP `503`, `error=runtime_temporarily_unavailable`, and
  `detail=office_hours_cloudflare_disabled` for an existing Think-routed
  session after setting `OFFICE_HOURS_RUNTIME_DISABLE_CLOUDFLARE=1`.
- Product-path SC1 comparison packet:
  `tmp/evals/office-hours-runtime/product-packets/sc1-control-vs-think-20260627T2239/`
  reports `manifestOk=true` and no automatic blockers for current custom
  Cloudflare control vs Think on `glm-5-2`. Both sides have browser evidence,
  complete usage/cost evidence, one committed `Problem` section, and no
  validator findings. The packet is synthetic from browser+D1 evidence, not raw
  provider trace parity; UX hash differs because control ended `idle` while
  Think ended `awaiting_user_tool_result`.
- Product-path SC5 comparison packets:
  `tmp/evals/office-hours-runtime/product-packets/sc5-control-vs-think-20260627T2327/`
  is retained as a verifier-sharpening failure packet. Control and Think both
  passed D1 product evidence for structured questions, accepted answers,
  usage/cost, committed tool effects, artifacts, and transcript rows, but the
  packet failed `missing_terminal_idle` because the browser verifier treated an
  in-progress one-section snapshot as a terminal protocol failure.
  `tmp/evals/office-hours-runtime/product-packets/sc5-control-vs-think-20260627T2352/`
  is the current packet. It reports `manifestOk=true` and no automatic
  blockers. Control and Think both have completed turn attempts, usage/cost,
  accepted questions, committed tool effects, one `Problem` section, and
  transcript evidence. The remaining SC5 delta is behavior/quality, not a
  protocol blocker: control ended `idle`, while Think ended
  `awaiting_user_tool_result` with one extra pending question after the first
  section.
  2026-06-28 targeted Think repeat:
  `tmp/evals/office-hours-runtime/browser-think-sc5-forced-question-20260628/browser_cma_glm_5_2_1782690019621/`
  forced the delayed-answer path and passed browser/product evidence with one
  structured question, one accepted answer, one committed `Problem` section,
  `usage_events=4`, `tool_effects=1`, and no plain-text blocking question. The
  2026-06-29 side-port Think repeat at
  `tmp/evals/office-hours-runtime/browser-think-sc5-sideports-20260629/browser_cma_glm_5_2_1782759762594/`
  used the per-worktree `14aa` stack on `3001/8788/8793` and passed
  browser/product evidence with session `sks_X1n7L5xm0gErFiTMXJ-GoAu1`, two
  accepted structured questions, one committed `Problem` section,
  `usage_events=4`, `tool_effects=1`, no browser errors, and no plain-text
  blocking question. The matching side-port control rerun
  `tmp/evals/office-hours-runtime/browser-control-sc5-sideports-20260629/browser_cma_glm_5_2_1782760761939/`
  passed product evidence with one committed `Problem` section, one
  pending/accepted question, `usage_events=3`, `tool_effects=1`, and
  `chat_messages=8`. The paired packet
  `tmp/evals/office-hours-runtime/product-packets/sc5-sideports-control-vs-think-20260629/`
  reports `manifestOk=true` and no automatic blockers: sections `1 -> 1`,
  questions `1 -> 2`, browser evidence `3 -> 3`, and lifecycle `idle -> idle`.
- Product-path SC6 comparison packet:
  `tmp/evals/office-hours-runtime/product-packets/sc6-control-vs-think-20260628T003545Z/`
  compares current custom Cloudflare control against Think on `glm-5-2` using
  browser summaries and D1 product evidence. It reports `manifestOk=true` and
  no automatic blockers. Both sides have three visible sections with matching
  UX hash and headings `Problem`, `Who it's for`, and `What it does`. Both
  product evidence files pass with required section-revision proof:
  `committed_section_effect_count=4`,
  `repeated_section_effect_number_count=1`,
  `canonical_duplicate_section_number_count=0`, and `design_doc_version=5`.
  Control cost was `21606240` nanos; Think cost was `37807840` nanos in this
  run, so cost variance still needs repeat sampling before any promotion claim.
  2026-06-28 targeted Think repeat:
  `tmp/evals/office-hours-runtime/browser-think-sc6-forced-revision-20260628/browser_cma_glm_5_2_1782690634346/`
  explicitly asked for a Section 1 rewrite and then Section 2. Browser evidence
  shows two visible sections with no browser errors, no plain-text blocking
  questions, and no reasoning leak; product evidence passes with
  `tool_effects=3`, `distinct_sections=2`, `repeated_sections=1`,
  `max_per_section=2`, `canonical_duplicates=0`, and `design_doc_version=4`.
  The 2026-06-29 side-port Think retry at
  `tmp/evals/office-hours-runtime/browser-think-sc6-sideports-retry-20260629/browser_cma_glm_5_2_1782760114209/`
  used the per-worktree `14aa` stack on `3001/8788/8793` and passed
  browser/product evidence with session `sks_WyUbt7oKZN-BwGt-8N9fAObz`, two
  visible sections (`Problem`, `Who it's for`), no browser errors, no
  plain-text blocking questions, `usage_events=6`, `tool_effects=3`,
  `repeated_sections=1`,
  `max_per_section=2`, `canonical_duplicates=0`, and `design_doc_version=4`.
  The matching side-port control rerun
  `tmp/evals/office-hours-runtime/browser-control-sc6-sideports-20260629/browser_cma_glm_5_2_1782760906992/`
  passed product evidence with two visible sections, three committed section
  effects, one repeated section, zero canonical duplicates, `usage_events=3`,
  and `chat_messages=9`. The paired packet
  `tmp/evals/office-hours-runtime/product-packets/sc6-sideports-control-vs-think-20260629/`
  reports `manifestOk=true` and no automatic blockers: sections `2 -> 2`,
  questions `0 -> 0`, browser evidence `3 -> 3`, lifecycle `idle -> idle`, and
  matching UX hash.
- Direct comparison runner proof:
  `tmp/evals/office-hours-runtime/think-direct-pair-sc1-retry/` compares
  current Cloudflare control to `cloudflare-think` on `glm-5-2` for SC1. It
  produced `cloudflare-control.json`, `cloudflare-think.json`,
  `comparison.json`, and `comparison.md` instead of hanging. This is not a
  parity pass: both sides have incomplete usage and no browser evidence; the
  control remained awaiting a structured answer with zero sections, while Think
  reached idle with zero sections and a plain-text blocking-question finding.
- Section canary: session `sks_think_canary_1782587376` emitted `skillet.section_drafted`, two `span.model_request_end` events, `agent.message`, and `session.status_idle`; state scan passed with `ok=true`.
- Delayed-question canary: session `sks_think_question_1782587566` emitted `skillet.question_requested` for `ask_user_question`, accepted `user.custom_tool_result`, emitted `think.tool_result_applied`, continued to `agent.message`, reached idle, and state scan passed with `ok=true`.

Not yet promotion-ready:

- Candidate state endpoint is intentionally sanitized and count-only, but the
  full local Think DO SQLite table scans and local R2 markdown blob scans now
  have repeated zero-finding passes, including the latest side-port
  full-publish product/storage pass.
- The live full-publish product path now has prior clean-stack browser passes
  and a fresh side-port bridge-fix pass with strict D1/R2/transcript evidence.
  Promotion no longer depends on closing a missing bridge/persistence semantic.
  The remaining rollout risk is UX variance: the latest GLM run needed 13
  answered questions plus the final approval card before/after full publish.
- SC1 now has one passing one-section browser/product-path comparison packet;
  SC5 and SC6 have fresh isolated side-port paired packets with browser
  evidence on both control and Think and no automatic blockers.

## Follow-Up Research Notes

### Think repo dossier refresh

`docs/decisions/2026-06-27-project-think-repo-dossier.md` is the source-backed bridge map for the Think migration slice. It pins Skillet's implementation target to the published `@cloudflare/think@0.11.0` package, tag `062611de3dcf9278c5759a959d408ed0d736b64d`, while tracking upstream `cloudflare/agents` `origin/main` at `59f7bb76947d27831a0bec29248f0900b714c213` as unpublished drift.

No prior blocker classification gets stricter from the refresh. The important wording change is that Think already provides the delayed client-tool-result, server tool/action, and step-usage primitives; Skillet still needs product-contract bridge proof and state/secret canary evidence before any staff/local product path.

### Think delayed client-tool result bridge

Upstream Think no longer appears blocked on the basic delayed client-tool-result primitive. The upstream bridge is named `cf_agent_tool_result`, not `custom_tool_result`.

Primary sources checked:

- `packages/agents/src/chat/protocol.ts` defines `CF_AGENT_TOOL_RESULT` as `cf_agent_tool_result`.
- `packages/agents/src/chat/react.tsx` sends tool outputs through `addToolOutput` / `CF_AGENT_TOOL_RESULT` with `toolCallId`, `toolName`, `output`, optional `state`, `errorText`, `autoContinue`, and `clientTools`.
- `packages/think/src/think.ts` handles parsed `tool-result` protocol events, applies them through a serialized interaction queue, patches in-flight streamed assistant messages when results arrive before durable persistence, and schedules event-driven auto-continuation.
- Upstream issues and PRs around this exact area include cloudflare/agents#1507, #1586, #1608, #1649, #1651, #1657, #1667, #1684, #1709, and #1713.

Assessment change:

- Previous blocker: "No delayed `custom_tool_result` bridge."
- Current status: "Skillet has proven a candidate-local adapter from `user.custom_tool_result` into Think's tool-result machinery, including continuation of the same pending interaction."

This lowers the risk materially. The remaining proof work is product-path integration: the answer must be accepted in Skillet's D1 pending-question ledger before Think continuation, and the browser/SSE path must preserve the same behavior without adopting Think's WebSocket/client protocol.

### Think `emit_section` side-effect bridge

The earlier "no `emit_section` persistence bridge" blocker was too broad. Upstream Think has server-side action/tool surfaces that can run Skillet side effects:

- `beforeToolCall` and `afterToolCall` wrap server-side tool execution with typed input/output, timing, and outcome hooks.
- Think actions compile into AI SDK tools with an `ActionContext` that includes `requestId`, `toolCallId`, messages, `env`, and an abort signal.
- Think's action ledger provides idempotency, replay, and recovery machinery around action outputs.
- `runTurn({ mode: "stream" })` remains a usable server-side stream bridge for Skillet's candidate adapter.

Primary upstream references: `packages/think/src/think.ts` lifecycle hooks, action compilation, and ledger paths; `docs/think/actions.md`; cloudflare/agents#1340, #1414, #1623, #1790, and #1823.

Assessment change:

- Previous blocker: "No `emit_section` persistence bridge."
- Current status: "Skillet has proven an `emit_section` Think server-tool bridge using shared validation/effect helpers in candidate-local state; the real D1/R2 persistence bridge remains required before product canary."

This lowers implementation risk but does not remove the product-contract gate.

### Think state and secret redaction

Keep this as a promotion blocker, but narrow it. Upstream Think is not proven unsafe; it is simply a broad durable-state owner that Skillet must inspect before canary.

Think-owned state includes full UI message JSON in `assistant_messages.content`, FTS rows, compaction summaries, context blocks, resumable stream chunks, `cf_agents_state`, connection hibernation state, `cf_think_submissions`, action ledgers and pending approvals, optional workspace SQLite/R2 files, and MCP config/OAuth storage when those features are used. Think's sanitizer strips narrow OpenAI ephemeral metadata and enforces row-size limits; it is not a general secret-redaction or encryption layer.

Assessment change:

- Previous blocker: "No state redaction proof."
- Current status: "The candidate count-only state endpoint passed a seeded-secret scan after live local sessions; the clean-stack full-publish product run also passed a full local Think DO SQLite table scan with operational secret canaries and a local R2 markdown blob redaction scan. Repeat coverage is still required before promotion."

This remains a hard canary gate because Skillet's current token policy is stricter than Think's generic persistence model.

### Think usage and cost telemetry

The earlier "no usage telemetry proof" blocker should be downgraded. Think forwards AI SDK `experimental_telemetry` into `streamText()` and exposes the full AI SDK `StepResult` through `onStepFinish`, including usage, provider metadata, request/response, warnings, finish reason, and cache-related metadata when the provider supplies it.

Primary upstream references: cloudflare/agents#1422 and #1423 for telemetry passthrough; cloudflare/agents#1340 for full step-result hook context; `packages/think/src/think.ts` `TurnConfig.experimental_telemetry`, `streamText` forwarding, and `onStepFinish`; `packages/think/src/tests/hooks.test.ts` and `think-session.test.ts` coverage.

Assessment change:

- Previous blocker: "No usage telemetry proof."
- Current status: "The Think candidate emits `span.model_request_end` usage events from `onStepFinish`; `apps/sse` handler tests prove Think-routed hosted model-end events normalize cache tokens, compute exact `cost_nanos`, and call the existing usage-recorder seam. Product-path SC1 and SC5 canaries have captured live D1 `session_usage_event` rows; repeated provider/model/cost evidence and fail-closed accounting behavior still need broader canary coverage."

This is an integration and accounting proof, not an upstream Think capability blocker.

## Verification

Project Think candidate implementation evidence captured so far:

```bash
pnpm -C apps/agent-runtime test -- --run src/harness-candidates/think-office-hours.test.ts src/index.test.ts
pnpm -C apps/agent-runtime typecheck
pnpm -C apps/agent-runtime build
pnpm -C apps/web test -- --run app/api/sessions/route.test.ts
pnpm -C apps/web typecheck
pnpm -C apps/sse test -- --run src/handlers/stream-runtime.test.ts
pnpm -C apps/sse typecheck
pnpm -C packages/core typecheck
pnpm -C packages/core test -- --run src/runtime/tool-host.test.ts src/runtime/turn-ledger.test.ts src/artifact/persist.test.ts src/evals/office-hours-runtime/descriptors.test.ts
pnpm exec vitest run scripts/evals/office-hours-runtime/adapters/adapters.test.ts scripts/evals/office-hours-runtime/scan-think-state.test.ts
pnpm exec vitest run scripts/evals/office-hours-runtime/*.test.ts scripts/evals/office-hours-runtime/adapters/*.test.ts
pnpm exec tsc -p scripts/evals/office-hours-runtime/tsconfig.json --noEmit
pnpm typecheck
pnpm test
pnpm lint
pnpm exec biome check apps/agent-runtime/src/harness-candidates/think-office-hours.ts apps/agent-runtime/src/harness-candidates/think-office-hours.test.ts apps/agent-runtime/src/harness-candidates/think-office-hours-agent.ts apps/agent-runtime/src/index.ts apps/agent-runtime/src/index.test.ts scripts/evals/office-hours-runtime/adapters/cloudflare.ts scripts/evals/office-hours-runtime/adapters/types.ts scripts/evals/office-hours-runtime/adapters/adapters.test.ts scripts/evals/office-hours-runtime/scan-think-state.ts scripts/evals/office-hours-runtime/scan-think-state.test.ts packages/core/src/evals/office-hours-runtime/descriptors.ts packages/core/src/evals/office-hours-runtime/descriptors.test.ts
```

All commands above passed on 2026-06-27.

Live local canaries used `wrangler dev` for `apps/agent-runtime` with `THINK_OFFICE_HOURS_CANDIDATE_ENABLED=true` and existing local secrets loaded from `apps/sse/.dev.vars`. The internal canaries exercised the candidate route directly. The product-path canary exercised `apps/web`, `apps/sse`, the hosted runtime adapter, Think, D1 product ledgers, transcript tee, and the browser verifier.

The product-path evidence collector is now implemented at
`scripts/evals/office-hours-runtime/collect-product-canary-evidence.ts`, and
the product-path packet builder is implemented at
`scripts/evals/office-hours-runtime/build-product-comparison-packet.ts`. After
`browser-verify-cma.ts` creates real control and Think-routed
`/office-hours/new -> /o` sessions under local/staff routing, run the collector
against each browser summary to produce `product-evidence.json`, then build a
packet with `comparison.json` and `comparison.md`. The builder accepts
`--baseline-run-dir` and `--candidate-run-dir`, discovers nested
`summary.json` plus product-evidence files, and marks a side product-only when
product evidence exists but browser summary evidence is absent. The packet uses
synthetic trace provenance (`product_canary_synthetic_trace_v1`) so browser/D1
evidence can be compared without claiming raw provider event parity. The
collector is intentionally token-safe: it does not write raw stream tokens or
transcript bodies.

Known verification gap:

- Full Think-owned DO/table/R2 storage inspection has repeated clean local
  passes, including the latest isolated side-port full-publish product/storage
  pass; keep it in the repeat canary packet.
- Full seven-section R2 markdown publish has prior clean-stack browser passes
  and the latest side-port bridge-fix pass with strict D1/R2/storage evidence.
  The old `full_publish_browser_variance_unresolved` blocker is closed as a
  bridge/eval blocker; keep repeating it in the staff canary packet because GLM
  question-count and latency remain the practical rollout risks.
- The product-path packet builder exists and is tested; SC1 has one passing
  control-vs-Think product packet, while SC5 and SC6 now have fresh isolated
  side-port paired packets with browser evidence on both sides and no automatic
  blockers.
- `pnpm lint` exits 0 with pre-existing CSS warnings in
  `apps/web/styles/chat.css` and `apps/web/styles/print.css`; touched-file
  Biome checks pass.
