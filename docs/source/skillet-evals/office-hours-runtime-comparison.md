# Office Hours Runtime Comparison

This runbook compares Skillet Office Hours on Claude Managed Agents (CMA) versus the Cloudflare Agents SDK path. The first parity lane is Sonnet 4.6 on both runtimes. Cheaper models such as GLM 5.2 are smoke-test candidates only until the Cloudflare Sonnet path passes the parity gates.

## Current Status

- The reusable runtime contract, scenario corpus, semantic trace, canonical state, UX hash, validators, gate scoring, qualitative rubric, and report summary live in `packages/core/src/evals/office-hours-runtime/`.
- The deterministic comparison runner lives in `scripts/evals/office-hours-runtime/run-comparison.ts`.
- Live HTTP adapters exist for both runtime surfaces:
  - CMA: `POST /api/sessions`, then returned SSE worker `/turn/:sessionId` and `/stream/:sessionId?resume=1`.
  - Cloudflare Agents: `POST /api/cf-agents/office-hours/sessions`, `/cf-agents/office-hours/turn/:sessionId`, `/stream/:sessionId`, and read-only `/api/cf-agents/office-hours/manifest`.
- Live CLI runners now exist for both surfaces and write the same redacted `RunArtifact` shape:
  - CMA: `scripts/evals/office-hours-runtime/run-live-cma.ts`.
  - Cloudflare Agents: `scripts/evals/office-hours-runtime/run-live-cloudflare.ts`.
- `scripts/evals/office-hours-runtime/run-sonnet-parity-canary.ts` is the safest operator entrypoint for the fair Sonnet lane. It runs web/SSE/Cloudflare server, config, and demo-evidence preflight first; refuses to spend live quota if local readiness fails; then runs the CMA-vs-Cloudflare suite and postprocesses redaction, blind-review packets, evidence index, and decision summary artifacts.
- The preferred parity entrypoint is now `scripts/evals/office-hours-runtime/run-live-suite.ts`. It runs the CMA-vs-Cloudflare pair runner across the canary scenarios, captures optional browser evidence for each runtime, writes one child directory per scenario, and writes suite-level `comparison.json`, `comparison.md`, and `summary.json` outputs for decision review.
- `scripts/evals/office-hours-runtime/preflight-live-suite.ts` now checks the local parity harness before spending live quota: required source files, workspace wiring, Cloudflare Worker bindings, recorded demo evidence, optional server health, and the exact commands for the suite/review/decision steps. The current local preflight report is `tmp/evals/office-hours-runtime/sonnet-runtime-preflight.md` and has no local blockers when server checks are skipped.
- For single-scenario debugging, use `scripts/evals/office-hours-runtime/run-live-pair.ts`. It runs the CMA and Cloudflare live runners with the same model/scenario/turns, optionally captures both browser surfaces, attaches browser summaries to the comparison, and writes one run directory containing `cma.json`, `cloudflare.json`, `comparison.md`, `comparison.json`, and `summary.json`.
- Saved run artifacts can now be compared side-by-side with `scripts/evals/office-hours-runtime/compare-artifacts.ts`. It reads either raw `RunArtifact` JSON or the `{ artifact, findings, gates, ... }` envelopes written by the live runners, can attach CMA/Cloudflare browser verifier `summary.json` files as timeline evidence, recomputes validators/gates, checks manifest deltas, compares final UX hashes, and renders an operator-readable Markdown report.
- CMA-vs-CMA calibration now has reusable support in `packages/core/src/evals/office-hours-runtime/variance.ts` plus an operator CLI at `scripts/evals/office-hours-runtime/compare-variance.ts`. Use this before interpreting Cloudflare-vs-CMA deltas so normal Sonnet variance is explicit.
- Blind qualitative review packets can be generated for one pair with `scripts/evals/office-hours-runtime/prepare-blind-review.ts` or for every pair in a suite with `scripts/evals/office-hours-runtime/prepare-suite-blind-review.ts`. They write reviewer-facing packets with `Runtime A` / `Runtime B` labels and separate unblinding maps so runtime identity does not leak into product-quality scoring.
- CMA browser verification now has its own harness at `scripts/evals/office-hours-runtime/browser-verify-cma.ts`. It drives the incumbent Skillet UI from `/office-hours/new` through `/o?session=...`, uses the real ChatSurface composer/question/doc-pane selectors, and writes screenshot/video-ready evidence comparable to the Cloudflare demo verifier.
- The CMA adapter manifest now resolves the committed registered Office Hours record from `packages/core/src/config/skills.json` and records the real `registered-agent-manifest` and `registered-skill-content` hashes for the selected Skillet model. This replaces the previous placeholder hash and keeps manifest drift visible without making live Anthropic API calls during comparison setup.
- The Cloudflare prototype defaults to `claude-sonnet-4-6`; GLM 5.2 remains selectable as `@cf/zai-org/glm-5.2`.
- Browser verification on 2026-06-22 confirmed GLM 5.2 can produce a visible `ask_user_question` flow, resume after an answer, and disable stale answered options. Evidence screenshot:
  `apps/cf-agents-office-hours/glm-question-resume-evidence.png`.
- API-level live verification on 2026-06-22 confirmed GLM 5.2 can call `emit_section` through the Cloudflare Agents path after enough founder evidence. The strongest run drafted Section 1 with `modelId: @cf/zai-org/glm-5.2`, `sectionsDrafted: 1`, no runtime errors, no validator findings, forensic hash `fnv1a64:b393483a35c8fa65`, and UX hash `fnv1a64:58d12ad02c402f26`. The redacted artifact was written to `tmp/evals/office-hours-runtime/SC1-_cf_zai-org_glm-5.2-1782170282407.json`.
- A fuller GLM 5.2 Cloudflare run on 2026-06-22 completed all seven Office Hours sections and emitted `skillet.artifact_drafted` after fixing Cloudflare tool-aware history for blocking questions. Raw artifact:
  `tmp/evals/office-hours-runtime/SC1-_cf_zai-org_glm-5.2-1782171738192.json`.
  Recomputed with the fixed canonical reducer, the final state is `completed_artifact`, `sectionsDrafted = 7`, `totalSections = 7`, no runtime errors, forensic hash `fnv1a64:e1a2219900b22c84`, and UX hash `fnv1a64:dfd54f5e56058b6b`.
- The same full-artifact GLM run still produced two `plain_text_blocking_question` warnings where the assistant asked follow-up questions in chat instead of calling `ask_user_question`. That is model/tool-discipline evidence against final-video readiness, not a Cloudflare transport failure.
- Browser verification on 2026-06-22 confirmed the demo UI can drive the same GLM lane to one visible document section. DOM assertions: `status = Ready · @cf/zai-org/glm-5.2`, `sectionCount = 1`, `emptyAssistantBubbles = 0`, and no visible `<think>` / reasoning leak. Evidence screenshot:
  `apps/cf-agents-office-hours/cloudflare-glm-office-hours-section-clean.png`.
- The Cloudflare runtime now sanitizes malformed GLM reasoning leaks before visible chat, removes empty assistant bubbles in the demo, records `ask_user_question` tool calls in AI SDK model history only when the matching user answer produces a paired tool result, stops the turn loop on the first blocking question, and can synthesize a structured `skillet.question_requested` event when a cheaper model asks a blocking question as plain chat. This was required because GLM 5.2 emitted a malformed `</think>` reasoning leak in an earlier live run, produced a malformed empty `ask_user_question` call before a valid one in another run, and repeatedly asked Q2/Q3-style blocking questions as plain text.
- Autonomous Browser-level verification now exists at `scripts/evals/office-hours-runtime/browser-verify.ts`. On 2026-06-22 it drove the Cloudflare demo through GLM 5.2, verified one visible section with structured question UI, and wrote:
  `tmp/evals/office-hours-runtime/browser/browser__cf_zai_org_glm_5_2_1782173276599/summary.json`.
  Final DOM metrics: `status = Waiting for answer · @cf/zai-org/glm-5.2`, `sectionsDrafted = 1`, `questionCount = 3`, `plainTextBlockingQuestionCount = 0`, `emptyAssistantBubbles = 0`, and `reasoningLeakVisible = false`.
- An earlier 7-section browser attempt after the suspend/resume fixes reached 3 sections and failed on `sections:3<7`; evidence:
  `tmp/evals/office-hours-runtime/browser/browser__cf_zai_org_glm_5_2_1782173019944/summary.json`. That failure exposed a verifier/demo race where the browser could answer a question before the previous SSE handler had removed its temporary assistant bubble.
- After adding the page-settled wait to the browser verifier, a full GLM 5.2 browser run completed all seven sections with no visible protocol defects:
  `tmp/evals/office-hours-runtime/browser/browser__cf_zai_org_glm_5_2_1782173616127/summary.json`.
  Final DOM metrics: `status = Waiting for answer · @cf/zai-org/glm-5.2`, `sectionsDrafted = 7`, `sectionHeadings = [Problem, Who it's for, What it does, Why now, The risky part, What you'd build first, Open questions]`, `questionCount = 13`, `plainTextBlockingQuestionCount = 0`, `emptyAssistantBubbles = 0`, and `reasoningLeakVisible = false`.
- The final recorded GLM 5.2 demo run also completed all seven sections and produced a user-facing video:
  `tmp/evals/office-hours-runtime/browser/browser__cf_zai_org_glm_5_2_1782174180303/summary.json`.
  Video: `tmp/evals/office-hours-runtime/browser/browser__cf_zai_org_glm_5_2_1782174180303/page@f90fdfcabf35edf209b9fbf89f7c0e2a.webm`.
  Final DOM metrics: `status = Waiting for answer · @cf/zai-org/glm-5.2`, `sectionsDrafted = 7`, `questionCount = 1`, `plainTextBlockingQuestionCount = 0`, `emptyAssistantBubbles = 0`, and `reasoningLeakVisible = false`.
- The recorded GLM 5.2 demo evidence report was verified with `scripts/evals/office-hours-runtime/verify-demo-evidence.ts` and written to `tmp/evals/office-hours-runtime/cloudflare-glm-demo-evidence.md`. It confirms model `@cf/zai-org/glm-5.2`, seven sections, no browser verifier errors, no plain-text blocking questions, no empty assistant bubbles, no visible reasoning leak, an existing screenshot, and an existing 21 MB `.webm` video.
- The Cloudflare Workers package verification can be regenerated with `scripts/evals/office-hours-runtime/verify-cloudflare-app.ts`. On 2026-06-23 it ran `pnpm -C apps/cf-agents-office-hours test`, `pnpm -C apps/cf-agents-office-hours typecheck`, and `pnpm -C apps/cf-agents-office-hours build`. The dry-run build confirmed the `OfficeHoursAgent` Durable Object binding, Workers AI binding, and default `OFFICE_HOURS_MODEL = "claude-sonnet-4-6"`. Evidence: `tmp/evals/office-hours-runtime/cloudflare-app-verification.md`.
- On 2026-06-23 the Anthropic capacity probe for `claude-sonnet-4-6` succeeded with HTTP 200 using `apps/sse/.dev.vars`; the prior workspace API usage-limit blocker is no longer current.
- A no-browser live Sonnet canary completed on 2026-06-23 under `tmp/evals/office-hours-runtime/suites/sonnet-runtime-canary/`. It produced live CMA and Cloudflare artifacts for SC1, SC5, and SC6 plus suite-level `comparison.json`, `comparison.md`, `summary.json`, blind-review packets, redaction scan, and decision summary. The decision summary remains `blocked` because browser evidence, complete usage/cost evidence, variance calibration, blind scoring, and unapproved manifest/context-policy deltas still need deliberate handling before parity confidence.
- A focused browser-facing Sonnet pair completed on 2026-06-23 under `tmp/evals/office-hours-runtime/pairs/sonnet-browser-sc1-smoke/`. It records CMA and Cloudflare screenshots/videos for SC1 with `claude-sonnet-4-6`. Both runtimes reached a `Waiting for answer` state with no sections after the short run; CMA showed one browser question and one plain-text blocking-question signal, while Cloudflare showed two structured questions and no plain-text blocking-question signal. The pair comparison has no manifest blockers after approving expected runtime-surface deltas, but still has incomplete usage evidence for both runtimes.
- A browser-suite attempt on 2026-06-23 under `tmp/evals/office-hours-runtime/suites/sonnet-runtime-canary-browser/` exposed a CMA browser-verifier race rather than a runtime defect. The verifier clicked a structured question answer and then treated the same still-submitting question card as settled, which could send a normal user message while Managed Agents was still waiting for `user.custom_tool_result`. `scripts/evals/office-hours-runtime/browser-verify-cma.ts` now waits for the same pending question to clear, be replaced, draft a section, or error before continuing. Regression coverage lives in `scripts/evals/office-hours-runtime/browser-verify-cma.test.ts`.
- A focused SC1 Sonnet browser pair after that verifier fix completed under `tmp/evals/office-hours-runtime/pairs/sonnet-browser-sc1-after-cma-wait-fix/`. The Anthropic “waiting on tool result” protocol error did not recur. The run also showed that the terse default SC1 browser prompt is not a good user-facing parity scenario: both runtimes reasonably refused to draft from generic scenario labels, with CMA ending idle after a plain-text blocking question and Cloudflare continuing with structured questions.
- A richer founder-update Sonnet browser pair completed on 2026-06-23 under `tmp/evals/office-hours-runtime/pairs/sonnet-browser-founder-after-cma-wait-fix/`. CMA browser metrics: `sectionsDrafted = 3`, `sectionHeadings = [Problem, Who it's for, What it does]`, `questionCount = 1`, no browser errors, no plain-text blocking question count, and no reasoning leak. Cloudflare browser metrics: `sectionsDrafted = 1`, `sectionHeadings = [1. Problem]`, `questionCount = 6`, no browser errors, no plain-text blocking question count, and no reasoning leak. Screenshots:
  - CMA: `tmp/evals/office-hours-runtime/pairs/sonnet-browser-founder-after-cma-wait-fix/browser-cma/browser_cma_claude_sonnet_4_6_1782232855826/final.png`
  - Cloudflare: `tmp/evals/office-hours-runtime/pairs/sonnet-browser-founder-after-cma-wait-fix/browser-cloudflare/browser_claude_sonnet_4_6_1782232912209/final.png`
- That pre-limit-fix founder-update pair indicated the Cloudflare Agents path was functionally close enough to run Office Hours with Sonnet, but not yet a clean one-to-one replacement for CMA. The visible UX was coherent and structured, but Cloudflare asked more diagnostic questions and emitted fewer sections under the same seeded browser profile. The non-browser Cloudflare live artifact for the same pair recorded fewer section events than the browser session, so the machine-run adapter/evidence loop still needed tightening before it could be the sole parity source.
- On 2026-06-23 the autonomous answer strategy was tightened so API and browser verifiers answer Office Hours questions semantically instead of consuming a fixed answer queue. This specifically fixed the Cloudflare browser loop where freeform questions received the generic answer `Answer now` instead of the founder's actual workflow/evidence text. Regression coverage lives in `scripts/evals/office-hours-runtime/question-answering.test.ts`, and the helper is used by `run-live-cma.ts`, `run-live-cloudflare.ts`, `browser-verify-cma.ts`, and `browser-verify.ts`.
- After that fix, a Cloudflare-only Sonnet browser verification completed under `tmp/evals/office-hours-runtime/browser/cloudflare-sonnet-semantic-freeform/browser_claude_sonnet_4_6_1782233860548/`. Final DOM metrics: `status = Waiting for answer · claude-sonnet-4-6`, `sectionsDrafted = 2`, `sectionHeadings = [1. Problem, 2. Who it's for]`, `questionCount = 6`, `plainTextBlockingQuestionCount = 0`, `emptyAssistantBubbles = 0`, `reasoningLeakVisible = false`, and no browser errors. Screenshot: `tmp/evals/office-hours-runtime/browser/cloudflare-sonnet-semantic-freeform/browser_claude_sonnet_4_6_1782233860548/final.png`.
- A matching Cloudflare API-only Sonnet run wrote `tmp/evals/office-hours-runtime/cloudflare-sonnet-semantic-freeform-api.json`. It drafted one section, ended at a structured specific-user follow-up, had no runtime errors, and produced final UX hash `fnv1a64:3775bc184d966419`. The remaining gap is model/orchestration behavior: Cloudflare is now answering coherently and drafting, but still emits fewer sections than CMA under the same profile.
- After the provider/account-side limit was fixed, Cloudflare-only Sonnet browser verification reached the three-section target under `tmp/evals/office-hours-runtime/browser/cloudflare-sonnet-after-limit-fix/browser_claude_sonnet_4_6_1782234279561/`: `sectionsDrafted = 3`, `sectionHeadings = [1. Problem, 2. Who it's for, 3. What it does]`, `questionCount = 8`, no browser errors, no plain-text blocking questions, no empty assistant bubbles, and no reasoning leak.
- A fresh founder-update Sonnet pair then completed under `tmp/evals/office-hours-runtime/pairs/sonnet-browser-founder-after-limit-fix/`. Browser metrics now show stronger user-facing parity: CMA ended `Idle` with three visible sections (`Problem`, `Who it's for`, `What it does`) and Cloudflare ended `Waiting for answer · claude-sonnet-4-6` with the same three visible sections, no browser errors, no plain-text blocking questions, no empty assistant bubbles, and no reasoning leak.
- A follow-up maxSteps=20 founder-update API comparison resolved the earlier complete-artifact gap. CMA artifact `tmp/evals/office-hours-runtime/cma-sonnet-founder-max20-usage-after-aggregator.json` and Cloudflare artifact `tmp/evals/office-hours-runtime/cloudflare-sonnet-founder-max20-usage-after-finish-fix.json` both emitted all seven expected sections with matching headings: `Problem`, `Who it's for`, `What it does`, `Why now`, `The risky part`, `What you'd build first`, and `Open questions`. The priced comparison lives at `tmp/evals/office-hours-runtime/sonnet-founder-max20-priced-comparison.md` / `.json`. The comparison has no unapproved manifest deltas after recording the expected runtime-surface methodology decisions; its remaining automatic blockers are that these two API-only artifacts do not attach browser summaries. Cloudflare completed the artifact with no validator findings, while CMA reached all seven sections and finished in `awaiting_user_tool_result` with repeated plain-text-question warnings in the validator.
- Usage evidence now aggregates every `span.model_request_end` event instead of relying on the last model call, and `price-usage.ts` can price prompt-cache read/write tokens explicitly. The priced maxSteps=20 artifacts use Anthropic Sonnet 4.6 list pricing retrieved on 2026-06-23: input $3/MTok, output $15/MTok, 5-minute prompt-cache write $3.75/MTok, and cache read $0.30/MTok. Before the Cloudflare prompt-cache fix, the API comparison produced an estimated CMA cost of `166845750` nanos ($0.166845750) from 11 uncached input tokens, 6,709 output tokens, 68,730 cache-read tokens, and 12,149 cache-write tokens, while the direct Cloudflare Anthropic path produced `858081000` nanos ($0.858081000) from 250,367 input tokens and 7,132 output tokens with no cache tokens reported. Treat this as historical evidence of the missing-cache problem, not the current Cloudflare cost state.
- The strongest current user-facing Sonnet evidence is now `tmp/evals/office-hours-runtime/pairs/sonnet-browser-founder-max20-video/`. It ran the founder-update profile with `claude-sonnet-4-6`, `--max-steps 20`, `--target-sections 7`, `--browser`, `--record-video`, and priced usage enrichment. `comparison-priced.md` reports no automatic blockers, no unapproved manifest deltas, no validator findings, matching seven-section headings, and attached browser evidence for both runtimes. Browser CMA ended `Ready` with 7 sections, 0 questions, no errors, no plain-text blocking questions, no empty assistant bubbles, and no visible reasoning leak. Browser Cloudflare ended `Ready · claude-sonnet-4-6` with 7 sections, 10 structured question cards, no errors, no plain-text blocking questions, no empty assistant bubbles, and no visible reasoning leak. Videos:
  - CMA: `/Users/pejman/.codex/worktrees/1424/skillet/tmp/evals/office-hours-runtime/pairs/sonnet-browser-founder-max20-video/browser-cma/browser_cma_claude_sonnet_4_6_1782236951688/page@9e560d9b86a88ec4e3e21805e3ad6dab.webm`
  - Cloudflare: `/Users/pejman/.codex/worktrees/1424/skillet/tmp/evals/office-hours-runtime/pairs/sonnet-browser-founder-max20-video/browser-cloudflare/browser_claude_sonnet_4_6_1782237115944/page@667f8aebf019372e702f0cb922f3b72d.webm`
- The priced browser-backed founder-update pair estimated CMA at `187426650` nanos ($0.187426650) and Cloudflare direct Anthropic at `550341000` nanos ($0.550341000), about 2.9x higher before the top-level Cloudflare prompt-cache fix. This remains the strongest recorded user-facing video pair, but not the current cost baseline.
- A follow-up Cloudflare-only Sonnet cache-control pass first marked the stable Anthropic system prompt and tool schemas cacheable with AI SDK `providerOptions.anthropic.cacheControl = { type: "ephemeral" }`. Cloudflare MCP docs confirmed AI Gateway caching is exact request/response caching keyed by request/provider/model/auth/body, so it is not a substitute for Anthropic prompt-prefix caching on these evolving Office Hours turns. The clean static-cache artifact is `tmp/evals/office-hours-runtime/cloudflare-sonnet-founder-max20-cache-control-after-window-fix-priced.json`: all seven sections present, one artifact-drafted event, no validator findings, all gates pass, `cacheReadTokens = 233901`, `inputTokens = 153616`, `outputTokens = 10674`, and estimated cost `691128300` nanos ($0.691128300). That cost is higher than the browser-backed Cloudflare pair because this run over-asked 15 structured questions before closeout despite cache reads; use it as proof that prompt-cache reads were reported, not as a fair user-experience cost baseline.
- The current Cloudflare Sonnet cache implementation also sends top-level automatic Anthropic prompt caching with `providerOptions.anthropic.cacheControl = { type: "ephemeral" }` on the `streamText` request. Cloudflare-only artifact `tmp/evals/office-hours-runtime/cloudflare-sonnet-founder-max20-auto-cache-priced.json` passed all gates with seven sections and no validator findings, reducing uncached Cloudflare input to `25` tokens with `236106` cache-read tokens, `36027` cache-write tokens, `7227` output tokens, and estimated cost `314413050` nanos ($0.314413050). This proves the missing-cache issue is fixed, but not price parity: the comparable CMA API baseline remains about $0.167, and this Cloudflare run asked 12 structured questions across 14 model request ends versus CMA's 4 questions across 9 model request ends.
- A fresh pair rerun after the automatic-cache fix wrote `tmp/evals/office-hours-runtime/pairs/sonnet-browser-founder-max20-auto-cache/`. The API artifacts both produced all seven expected headings with no validator findings and no unapproved manifest deltas after methodology approvals. Priced usage: CMA `187768950` nanos ($0.187768950) from 15 uncached input, 7,214 output, 107,534 cache-read, and 12,601 cache-write tokens; Cloudflare `331872450` nanos ($0.331872450) from 22 uncached input, 9,576 output, 245,384 cache-read, and 30,547 cache-write tokens. The same run failed to attach browser summaries because `browser-verify-cma.ts` timed out waiting for CMA UI settling, so use this run as cost/cache evidence only; keep `sonnet-browser-founder-max20-video/` as the current recorded user-facing proof.
- The strict Cloudflare portability lane now loads `packages/skills/office-hours/system.md` plus the raw `packages/skills/office-hours/SKILL.md` body. It keeps Anthropic automatic prompt caching through AI SDK `providerOptions.anthropic.cacheControl = { type: "ephemeral" }` at the request/tool boundary, but does not use a compact method summary, question cap, or behavior-tuning prompt. The focused strict founder-update pair is `tmp/evals/office-hours-runtime/pairs/sonnet-founder-max20-strict-raw-skill-api-pair/`. With runtime-surface manifest deltas approved, both runtimes produced the same seven expected headings, no validator findings, and complete priced usage. CMA cost: `169902300` nanos ($0.169902300) from 13 uncached input, 6,598 output, 86,711 cache-read, and 11,968 cache-write tokens. Cloudflare direct Anthropic cost: `224539350` nanos ($0.224539350) from 24 uncached input, 6,186 output, 207,087 cache-read, and 18,547 cache-write tokens. Difference: `54637050` nanos, about $0.05464 or 1.32x. This proves prompt caching is active in the strict lane, but caching alone did not make strict Cloudflare cost-equivalent to CMA for this scenario. Browser evidence is still missing for this strict pair.
- The strongest optimized no-browser Sonnet cost-parity pair is `tmp/evals/office-hours-runtime/pairs/sonnet-founder-max20-question-cap-api-pair-bypass/`. The SSE worker for this pair was started with a local `--var FREE_SONNET_BUDGET_NANOS:5000000000` override so Skillet's own anonymous free-session cap did not abort the CMA side; Anthropic provider capacity was not the blocker. The priced pair produced the same seven expected headings with no validator findings, all gates passing, and no unapproved manifest deltas after methodology approvals. CMA cost: `146067900` nanos ($0.146067900) from 17 uncached input, 5,730 output, 92,098 cache-read, and 8,650 cache-write tokens. Cloudflare direct Anthropic cost: `147116850` nanos ($0.147116850) from 14 uncached input, 5,194 output, 82,262 cache-read, and 11,863 cache-write tokens. Difference: `1048950` nanos, about $0.00105. This is useful optimized-Cloudflare evidence, not strict raw-skill portability evidence, because it used compact method-summary and question-cap tuning.
- The strongest current Cloudflare Sonnet browser/video proof is `tmp/evals/office-hours-runtime/browser/cloudflare-sonnet-question-cap-video/browser_claude_sonnet_4_6_1782245741584/`. It used model `claude-sonnet-4-6`, reached `Ready · claude-sonnet-4-6`, rendered all seven sections, had `questionCount = 6`, no browser errors, no plain-text blocking questions, no empty assistant bubbles, and no visible reasoning leak. Evidence files: `final.png`, `summary.json`, and video `/Users/pejman/.codex/worktrees/1424/skillet/tmp/evals/office-hours-runtime/browser/cloudflare-sonnet-question-cap-video/browser_claude_sonnet_4_6_1782245741584/page@e9d5fd7fd347c050c3f10823c702f99e.webm`.
- The cache-control retry also exposed and fixed a Cloudflare harness bug in `apps/cf-agents-office-hours/src/runtime-state.ts`: the fixed-size conversation window could drop an old assistant `tool-call` while retaining the paired `tool-result`, which Anthropic rejects because tool results must immediately follow their matching tool use. The runtime now compacts tool-call/result pairs together and the compiler omits orphaned tool results defensively. Regression coverage lives in `apps/cf-agents-office-hours/src/runtime-state.test.ts`.
- `scripts/evals/office-hours-runtime/scan-redaction.ts` scans generated eval artifacts for unredacted sensitive JSON keys and secret-like bearer/API-key/stream-token text. The current scan report is `tmp/evals/office-hours-runtime/redaction-scan.md`; it scanned 192 text artifact files and found no redaction issues.
- A requirement-to-proof evidence index can be regenerated with `scripts/evals/office-hours-runtime/build-evidence-index.ts`. The current report is `tmp/evals/office-hours-runtime/evidence-index.md`; it marks provider capacity as ready and live Sonnet suite artifacts as proven, while keeping variance/blind review and final decision confidence incomplete.
- Live run artifacts now attribute token usage to the runtime manifest's `usageSource` (`managed_agents` for CMA, `workers_ai` for GLM, `provider` for direct Anthropic Sonnet) and preserve aggregated input/output/cache token counts when model streams report them. Cost evidence stays `complete: false` until explicitly enriched with `price-usage.ts`, which now fails closed if cache tokens are present without cache-token rates.
- The live CMA and Cloudflare runners only use the missing-section auto-continue prompt when `--complete-artifact` is set or the selected profile explicitly requests full-artifact completion. Narrow scenario runs now stop after provided turns/tool answers instead of inventing continuation turns.
- Live Sonnet-on-Cloudflare browser verification is no longer blocked by Anthropic workspace capacity in this worktree. The founder-update Sonnet lane now has cost-parity evidence and a Cloudflare browser video. The remaining broader parity work is breadth and decision confidence: run more scenario coverage with `--capture-browser-failures`, decide which manifest/context-policy deltas are acceptable methodology differences, price SC1/SC5/SC6 consistently, and score blind-review packets.
- Current Sonnet parity interpretation: use the richer founder-update browser profile for user-facing checks, not the terse canonical SC1 setup. The terse scenario is still useful for tool/protocol tests, but it primarily validates refusal-to-hallucinate behavior rather than document drafting parity.
- GLM 5.2 is now strong enough for a recorded Cloudflare Agents Office Hours demo, but it is not proven parity. It has produced a full API-level artifact and two full browser artifacts, including one recorded run with only one structured question. Earlier runs still showed inconsistent instruction-following, including idle-without-section outputs, plain-chat blocking questions before runtime fallback, and one overly long 13-question browser pass. Treat GLM as a promising cheaper-model lane that needs scenario repetition, reviewer scoring, and likely model-specific prompt/tool guardrails before substitution decisions.

## Cloudflare Resources

Use the local Cloudflare skill first for routing and product context:

```bash
cat "$CODEX_HOME/skills/cloudflare/SKILL.md"
```

Then prefer Cloudflare MCP/docs when exposed in the Codex session. As of the restarted 2026-06-23 session, `tool_search` exposes `mcp__cloudflare_api.docs`, `mcp__cloudflare_api.search`, and `mcp__cloudflare_api.execute`. Use `mcp__cloudflare_api.docs` before relying on memory for current Agents SDK docs. A docs search for Agents SDK state/routing returned current Cloudflare pages confirming the same shape this prototype uses: Agents are Durable Objects with persistent state, custom routing is available, and server code can access agent instances with `getAgentByName`.

When MCP docs are unavailable, use official Cloudflare docs directly:

- Agents overview/docs index: `https://developers.cloudflare.com/agents/llms.txt`
- HTTP/SSE runtime docs: `https://developers.cloudflare.com/agents/runtime/communication/http-sse/`
- Chat/AIChatAgent docs: `https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/`
- Sessions docs: `https://developers.cloudflare.com/agents/runtime/lifecycle/sessions/`

## Verification Commands

Run the deterministic contract and adapter checks:

```bash
pnpm -C packages/core test -- office-hours-runtime
pnpm -C packages/core typecheck
pnpm exec vitest run scripts/evals/office-hours-runtime/adapters/adapters.test.ts
pnpm exec vitest run scripts/evals/office-hours-runtime/browser-verify-cma.test.ts
pnpm exec vitest run scripts/evals/office-hours-runtime/build-evidence-index.test.ts
pnpm exec vitest run scripts/evals/office-hours-runtime/compare-artifacts.test.ts
pnpm exec vitest run scripts/evals/office-hours-runtime/compare-variance.test.ts
pnpm exec vitest run scripts/evals/office-hours-runtime/prepare-blind-review.test.ts
pnpm exec vitest run scripts/evals/office-hours-runtime/prepare-suite-blind-review.test.ts
pnpm exec vitest run scripts/evals/office-hours-runtime/postprocess-live-suite.test.ts
pnpm exec vitest run scripts/evals/office-hours-runtime/preflight-live-suite.test.ts
pnpm exec vitest run scripts/evals/office-hours-runtime/run-sonnet-parity-canary.test.ts
pnpm exec vitest run scripts/evals/office-hours-runtime/run-live-suite.test.ts
pnpm exec vitest run scripts/evals/office-hours-runtime/run-live-pair.test.ts
pnpm exec vitest run scripts/evals/office-hours-runtime/run-live-cma.test.ts
pnpm exec vitest run scripts/evals/office-hours-runtime/run-live-cloudflare.test.ts
pnpm exec vitest run scripts/evals/office-hours-runtime/scan-redaction.test.ts
pnpm exec vitest run scripts/evals/office-hours-runtime/verify-cloudflare-app.test.ts
pnpm exec vitest run scripts/evals/office-hours-runtime/verify-demo-evidence.test.ts
pnpm exec tsc -p scripts/evals/office-hours-runtime/tsconfig.json
pnpm exec tsx scripts/evals/office-hours-runtime/run-comparison.ts SC5
```

Expected deterministic comparison shape: CMA and Cloudflare forensic hashes differ because event/tool ids differ, while UX hashes match for the fixture.

Run a live CMA trace against local Skillet web/SSE dev servers:

```bash
pnpm exec tsx scripts/evals/office-hours-runtime/run-live-cma.ts \
  --base-url http://localhost:3000 \
  --model claude-sonnet-4-6 \
  --scenario SC5 \
  --max-steps 8
```

Run a full-artifact CMA exploration only when Anthropic Managed Agents capacity is available and the operator explicitly wants to spend live quota:

```bash
pnpm exec tsx scripts/evals/office-hours-runtime/run-live-cma.ts \
  --base-url http://localhost:3000 \
  --model claude-sonnet-4-6 \
  --profile founder-update-demo \
  --max-steps 12 \
  --complete-artifact
```

Run incumbent CMA browser verification against local Skillet web/SSE dev servers. This consumes Managed Agents capacity because it starts a real `/office-hours/new` session:

```bash
pnpm exec tsx scripts/evals/office-hours-runtime/browser-verify-cma.ts \
  --base-url http://localhost:3000 \
  --model claude-sonnet-4-6 \
  --profile founder-update-demo \
  --target-sections 1 \
  --max-steps 6
```

For final visual evidence, add `--record-video` after a non-recorded CMA browser pass succeeds.

Before spending live quota, run the local parity preflight:

```bash
pnpm exec tsx scripts/evals/office-hours-runtime/preflight-live-suite.ts \
  --out tmp/evals/office-hours-runtime/sonnet-runtime-preflight.md
```

This verifies the harness files, workspace wiring, Cloudflare Worker Agents SDK bindings, and recorded GLM demo evidence without requiring local servers. Add `--check-servers` only after the Skillet web/SSE dev servers and Cloudflare worker dev server are running; without it, server health appears as warnings rather than blockers.

Refresh only the Anthropic provider-capacity status when Sonnet parity is blocked and you do not want to start local servers or spend a full suite run. Use the direct provider probe; the canary wrapper proceeds into the live suite once preflight is ready.

```bash
pnpm exec tsx -e "import { checkAnthropicProviderCapacity } from './scripts/evals/office-hours-runtime/provider-capacity.ts'; async function main(){ const result = await checkAnthropicProviderCapacity({ workspaceRoot: process.cwd(), modelId: 'claude-sonnet-4-6', envFilePath: 'apps/sse/.dev.vars', timeoutMs: 15000 }); console.log(JSON.stringify(result.check, null, 2)); process.exit(result.ok ? 0 : 1); } main().catch((error)=>{ console.error(error); process.exit(1); });"
```

This makes a single minimal Sonnet Messages API request, prints the sanitized `anthropic_capacity` check, and exits non-zero if capacity is blocked. It does not update `canary-summary.json`; if you want the evidence index to reflect the result, run the full canary or add a dedicated capacity-only CLI before relying on this as persisted evidence.

Run the preferred one-command live Sonnet canary when the local ports are free and Anthropic capacity is available:

```bash
pnpm exec tsx scripts/evals/office-hours-runtime/run-sonnet-parity-canary.ts \
  --start-servers \
  --check-anthropic-capacity \
  --anthropic-env-file apps/sse/.dev.vars \
  --cma-base-url http://localhost:3000 \
  --sse-base-url http://localhost:8787 \
  --cloudflare-base-url http://localhost:8791 \
  --model claude-sonnet-4-6 \
  --scenario SC1 \
  --scenario SC5 \
  --scenario SC6 \
  --max-steps 8 \
  --target-sections 1 \
  --out-dir tmp/evals/office-hours-runtime/suites/sonnet-runtime-canary
```

This wrapper first checks Anthropic capacity with a minimal Sonnet Messages API probe, checks that the target local ports are free, starts the local web, SSE, and Cloudflare Agents dev servers, writes `preflight.md`, waits for the server health/manifest checks to pass, refuses to continue on preflight failures, runs the suite with browser evidence, and then runs postprocess. Omit `--start-servers` when you have already started all three servers yourself. Omit `--check-anthropic-capacity` only for dry harness tests where no live provider call should happen. Add `--record-video` only after a non-recorded pass succeeds. Use `--skip-server-checks` only for dry harness tests, not for a live Sonnet parity suite. The capacity probe reads the key from the named local dev-vars file or `process.env` and never writes the key into artifacts; use `--anthropic-capacity-timeout-ms` to tune its default 10s timeout.

Regenerate the evidence index whenever major artifacts change:

```bash
pnpm exec tsx scripts/evals/office-hours-runtime/scan-redaction.ts \
  --path tmp/evals/office-hours-runtime \
  --out tmp/evals/office-hours-runtime/redaction-scan.md

pnpm exec tsx scripts/evals/office-hours-runtime/build-evidence-index.ts \
  --out tmp/evals/office-hours-runtime/evidence-index.md
```

Run the redaction scan before regenerating the evidence index so the index points at a current artifact-safety report. The evidence index maps the original objective to current proof and missing evidence. It is the quickest handoff artifact for seeing why the work is ready for live Sonnet parity but not yet complete.

For lower-level debugging, run the live Sonnet parity suite directly when preflight is clean, both local servers are up, and Anthropic capacity is available:

```bash
pnpm exec tsx scripts/evals/office-hours-runtime/run-live-suite.ts \
  --cma-base-url http://localhost:3000 \
  --cloudflare-base-url http://localhost:8791 \
  --model claude-sonnet-4-6 \
  --scenario SC1 \
  --scenario SC5 \
  --scenario SC6 \
  --max-steps 8 \
  --browser \
  --capture-browser-failures \
  --target-sections 1 \
  --out-dir tmp/evals/office-hours-runtime/suites/sonnet-runtime-canary
```

This writes per-scenario pair evidence under the suite directory and a top-level `comparison.json` / `comparison.md` for the decision-summary step. Use `--capture-browser-failures` during exploration so screenshots/videos are still attached when a scenario exposes a UX or methodology failure; omit it for a strict release gate. Add `--record-video` only after a non-recorded browser suite succeeds, and use `--strict-manifest` when you want to remove even the default approvals for the unavoidable `providerEndpoint` and `usageSource` runtime-surface deltas.

After the live suite succeeds, run the postprocess command:

```bash
pnpm exec tsx scripts/evals/office-hours-runtime/postprocess-live-suite.ts \
  --suite-summary tmp/evals/office-hours-runtime/suites/sonnet-runtime-canary/summary.json \
  --suite-comparison tmp/evals/office-hours-runtime/suites/sonnet-runtime-canary/comparison.json \
  --redaction-scan-path tmp/evals/office-hours-runtime \
  --out-dir tmp/evals/office-hours-runtime/suites/sonnet-runtime-canary
```

Postprocess writes a suite redaction scan, blind-review packets, an evidence index, a postprocess summary, and a decision summary when the comparison plus optional variance/blind-score inputs are available. If the variance or blind-score inputs are not ready yet, the postprocess summary records the skipped decision step rather than hiding the missing evidence.

Use `docs/evals/office-hours-runtime-decision-template.md` for the final operator decision record. The template separates config, protocol, tool, methodology, UX, operations, and model-substitution gates so the final verdict does not collapse runtime parity, model quality, and cost evidence into one broad impression.

Run a single live Sonnet parity pair when debugging one scenario:

```bash
pnpm exec tsx scripts/evals/office-hours-runtime/run-live-pair.ts \
  --cma-base-url http://localhost:3000 \
  --cloudflare-base-url http://localhost:8791 \
  --model claude-sonnet-4-6 \
  --scenario SC5 \
  --max-steps 8 \
  --browser \
  --capture-browser-failures \
  --target-sections 1
```

This command approves only the unavoidable runtime-surface deltas by default: `providerEndpoint` and `usageSource`. It still fails the comparison on `modelId`, prompt hash, tool schema hash, sampling, context policy, retry policy, or step-limit drift. Use `--capture-browser-failures` when the purpose is evidence collection rather than a strict gate, `--strict-manifest` to remove even default approvals, `--profile founder-update-demo --complete-artifact` for a fuller exploratory run, and `--record-video` only after a non-recorded browser pair succeeds.

After at least one CMA-vs-CMA pair and one CMA-vs-Cloudflare pair are saved, compare the candidate pair against the calibration envelope:

```bash
pnpm exec tsx scripts/evals/office-hours-runtime/compare-variance.ts \
  --calibration-pair tmp/evals/office-hours-runtime/pairs/cma-a/cma.json tmp/evals/office-hours-runtime/pairs/cma-b/cma.json \
  --candidate-pair tmp/evals/office-hours-runtime/pairs/sonnet-runtime-pair/cma.json tmp/evals/office-hours-runtime/pairs/sonnet-runtime-pair/cloudflare.json \
  --out tmp/evals/office-hours-runtime/sonnet-runtime-variance.md
```

This report checks section-count, question-count, browser-evidence, critical-finding, and UX-hash deltas against the CMA calibration envelope. It should be treated as one gate input, not as a replacement for deterministic validator gates or blind qualitative review.

Prepare blind qualitative review packets for every scenario in the saved suite:

```bash
pnpm exec tsx scripts/evals/office-hours-runtime/prepare-suite-blind-review.ts \
  --suite-summary tmp/evals/office-hours-runtime/suites/sonnet-runtime-canary/summary.json \
  --out-dir tmp/evals/office-hours-runtime/suites/sonnet-runtime-canary/blind-review \
  --alternate-order
```

Give reviewers only the generated `*-blind-review.md` packet files. Keep every `*-unblinding.json` map out of the review prompt until scores, notes, and critical failures are recorded. `--alternate-order` swaps Runtime A / Runtime B on every other scenario to reduce position bias across the canary set.

For a single exploratory pair, prepare one blind qualitative review packet from saved artifacts:

```bash
pnpm exec tsx scripts/evals/office-hours-runtime/prepare-blind-review.ts \
  --baseline tmp/evals/office-hours-runtime/pairs/sonnet-runtime-pair/cma.json \
  --candidate tmp/evals/office-hours-runtime/pairs/sonnet-runtime-pair/cloudflare.json \
  --baseline-browser-summary tmp/evals/office-hours-runtime/pairs/sonnet-runtime-pair/browser-cma-summary.json \
  --candidate-browser-summary tmp/evals/office-hours-runtime/pairs/sonnet-runtime-pair/browser-cloudflare-summary.json \
  --out tmp/evals/office-hours-runtime/sonnet-runtime-blind-review.md \
  --unblinding-out tmp/evals/office-hours-runtime/sonnet-runtime-blind-review-unblinding.json
```

Use `--swap-order` on repeated single-pair packets to reduce position bias.

Record each review as JSON keyed only by blind labels:

```json
{
  "packetId": "office_hours_blind_SC5_1782174180303",
  "reviewerId": "reviewer_1",
  "reviews": [
    {
      "label": "Runtime A",
      "scores": {
        "methodology_fidelity": 4,
        "artifact_usefulness": 4,
        "interaction_efficiency": 3,
        "challenge_quality": 4,
        "ux_continuity": 4
      },
      "notes": "Concise notes from the blind review.",
      "criticalFailures": []
    },
    {
      "label": "Runtime B",
      "scores": {
        "methodology_fidelity": 4,
        "artifact_usefulness": 5,
        "interaction_efficiency": 4,
        "challenge_quality": 4,
        "ux_continuity": 4
      },
      "notes": "Concise notes from the blind review.",
      "criticalFailures": []
    }
  ]
}
```

After scores are locked, unblind and score the packet:

```bash
pnpm exec tsx scripts/evals/office-hours-runtime/score-blind-review.ts \
  --unblinding tmp/evals/office-hours-runtime/sonnet-runtime-blind-review-unblinding.json \
  --review tmp/evals/office-hours-runtime/sonnet-runtime-blind-review-reviewer-1.json \
  --format json \
  --out tmp/evals/office-hours-runtime/sonnet-runtime-blind-review-reviewer-1-score.json
```

The score output is an internal analysis artifact. It validates all rubric dimensions, turns critical failures into qualitative findings, unblinds runtime identities, and computes the paired preference using the shared qualitative rubric. Do not send the score output back to reviewers before all blind scoring is complete. Use `--format markdown` with a separate `.md` output when you want a human-readable copy.

Build a gate-oriented decision summary from the suite comparison plus calibration and blind-review inputs:

```bash
pnpm exec tsx scripts/evals/office-hours-runtime/summarize-decision.ts \
  --comparison tmp/evals/office-hours-runtime/suites/sonnet-runtime-canary/comparison.json \
  --variance tmp/evals/office-hours-runtime/sonnet-runtime-variance.json \
  --blind-score tmp/evals/office-hours-runtime/sonnet-runtime-blind-review-reviewer-1-score.json \
  --required-scenario SC1 \
  --required-scenario SC5 \
  --required-scenario SC6 \
  --out tmp/evals/office-hours-runtime/sonnet-runtime-decision-summary.md
```

The decision summary intentionally separates failed gates from missing evidence. By default it requires canary scenario coverage for SC1, SC5, and SC6 on both CMA and Cloudflare with browser evidence attached. The suite comparison preserves per-scenario pair summaries, browser summaries, manifest failures, validator findings, and blockers from the individual pair-runner outputs. A run with clean deterministic traces but no browser proof, no complete usage/cost evidence, no CMA-vs-CMA variance calibration, no scored blind review, or only a single scenario remains `insufficient_evidence`; a run with manifest drift, validator failures, variance-envelope failures, or critical qualitative findings is `blocked`. Use a narrower `--required-scenario` set only for exploratory summaries, not for canary readiness.

If pair outputs were produced manually instead of through `run-live-suite.ts`, aggregate them explicitly before the decision summary:

```bash
pnpm exec tsx scripts/evals/office-hours-runtime/aggregate-comparisons.ts \
  --comparison tmp/evals/office-hours-runtime/pairs/sonnet-runtime-sc1/comparison.json \
  --comparison tmp/evals/office-hours-runtime/pairs/sonnet-runtime-sc5/comparison.json \
  --comparison tmp/evals/office-hours-runtime/pairs/sonnet-runtime-sc6/comparison.json \
  --out tmp/evals/office-hours-runtime/sonnet-runtime-comparison-aggregate.json
```

Compare a saved CMA artifact against a saved Cloudflare artifact:

```bash
pnpm exec tsx scripts/evals/office-hours-runtime/compare-artifacts.ts \
  --baseline tmp/evals/office-hours-runtime/cma-sonnet-sc5.json \
  --candidate tmp/evals/office-hours-runtime/cloudflare-sonnet-sc5.json \
  --baseline-browser-summary tmp/evals/office-hours-runtime/browser-cma/cma-sonnet-sc5/summary.json \
  --candidate-browser-summary tmp/evals/office-hours-runtime/browser/cloudflare-sonnet-sc5/summary.json \
  --approve providerEndpoint="different runtime surfaces" \
  --approve usageSource="CMA and Cloudflare metering sources differ" \
  --out tmp/evals/office-hours-runtime/sonnet-runtime-pair.md
```

Use `--format json` when a downstream script needs the structured comparison result. The browser summary flags add DOM, screenshot, and video entries to each run's evidence count without modifying the original run artifact files. Do not approve `modelId`, prompt hashes, tool schema hashes, sampling, or context-policy deltas for the first fair Sonnet lane without recording a deliberate methodology decision.

If live artifacts include token counts but not priced totals, enrich each artifact with explicit per-token rates before running the final JSON comparison. Supply rates in nanodollars per token from current provider docs, AI Gateway logs, invoices, or another run-specific source; do not rely on stale rates in this repository.

```bash
pnpm exec tsx scripts/evals/office-hours-runtime/price-usage.ts \
  --artifact tmp/evals/office-hours-runtime/pairs/sonnet-runtime-pair/cma.json \
  --out tmp/evals/office-hours-runtime/pairs/sonnet-runtime-pair/cma-priced.json \
  --input-nanos-per-token 3000 \
  --output-nanos-per-token 15000 \
  --cache-read-nanos-per-token 300 \
  --cache-write-nanos-per-token 3750 \
  --pricing-source "Anthropic pricing page retrieved YYYY-MM-DD"

pnpm exec tsx scripts/evals/office-hours-runtime/price-usage.ts \
  --artifact tmp/evals/office-hours-runtime/pairs/sonnet-runtime-pair/cloudflare.json \
  --out tmp/evals/office-hours-runtime/pairs/sonnet-runtime-pair/cloudflare-priced.json \
  --input-nanos-per-token 3000 \
  --output-nanos-per-token 15000 \
  --cache-read-nanos-per-token 300 \
  --cache-write-nanos-per-token 3750 \
  --pricing-source "Anthropic via Cloudflare path, same model pricing source retrieved YYYY-MM-DD"
```

The pricing script fails closed when input/output token counts are absent, and also refuses to price artifacts with cache-read or cache-write tokens unless the matching cache-token rates are supplied. It preserves live-run envelopes, sets `usage.complete = true`, records the operator-supplied pricing source, and stores `totalCostNanos` so comparison reports and decision summaries can distinguish missing cost evidence from priced run evidence.

After optional pricing enrichment, write the structured comparison JSON that feeds the decision summary:

```bash
pnpm exec tsx scripts/evals/office-hours-runtime/compare-artifacts.ts \
  --baseline tmp/evals/office-hours-runtime/pairs/sonnet-runtime-pair/cma-priced.json \
  --candidate tmp/evals/office-hours-runtime/pairs/sonnet-runtime-pair/cloudflare-priced.json \
  --baseline-browser-summary tmp/evals/office-hours-runtime/pairs/sonnet-runtime-pair/browser-cma-summary.json \
  --candidate-browser-summary tmp/evals/office-hours-runtime/pairs/sonnet-runtime-pair/browser-cloudflare-summary.json \
  --approve providerEndpoint="different runtime surfaces" \
  --approve usageSource="CMA and Cloudflare metering sources differ" \
  --format json \
  --out tmp/evals/office-hours-runtime/sonnet-runtime-pair.json
```

Regenerate the Cloudflare prototype package verification artifact:

```bash
pnpm exec tsx scripts/evals/office-hours-runtime/verify-cloudflare-app.ts \
  --out tmp/evals/office-hours-runtime/cloudflare-app-verification.md
```

The verifier runs the app tests, app typecheck, and Wrangler dry-run build, then fails closed if the dry-run output does not show the `OfficeHoursAgent` Durable Object binding, Workers AI binding, and default Sonnet model environment variable. To debug a failure directly, run the underlying commands:

```bash
pnpm -C apps/cf-agents-office-hours test
pnpm -C apps/cf-agents-office-hours typecheck
pnpm -C apps/cf-agents-office-hours build
```

Start local Cloudflare Agents with Sonnet env loaded from the existing SSE dev vars:

```bash
pnpm -C apps/cf-agents-office-hours exec wrangler dev \
  --port 8791 \
  --local-protocol http \
  --env-file ../sse/.dev.vars
```

Open `http://localhost:8791/demo` with Browser automation or manually. The model selector must show `claude-sonnet-4-6` by default and `@cf/zai-org/glm-5.2` as the first cheaper candidate.

Run a live GLM trace against the local Cloudflare worker:

```bash
pnpm exec tsx scripts/evals/office-hours-runtime/run-live-cloudflare.ts \
  --base-url http://localhost:8791 \
  --model @cf/zai-org/glm-5.2 \
  --scenario SC1 \
  --max-steps 10 \
  --turn "I'm building a product for seed-stage B2B founders who have 8-15 customer calls per week and then lose the thread when they try to turn notes into investor updates and product decisions. The first workflow is: import call notes, extract buyer pain/evidence, and draft a weekly investor-update section with source snippets. Three founder friends already do this manually every Friday and said they'd pay $50/month if it saved two hours. I can reach five more seed founders through warm intros this week. Please run Office Hours and draft the first design-doc section when you have enough evidence." \
  --turn "The strongest evidence is that two founders forwarded prototype-generated investor-update sections to their investors last Friday, one came back Monday asking for the next draft because doing it manually took two hours, and all three asked me to keep the prototype running for this Friday. Please draft Section 1 now." \
  --answer "Startup, but I have a prototype/users" \
  --answer "Two founders used prototype-generated updates with investors last Friday; one came back asking for the next draft; all three asked me to keep it running this Friday."
```

The script writes a redacted JSON artifact under `tmp/evals/office-hours-runtime/`, including raw trace, semantic trace, canonical snapshots, hashes, validator findings, and gates.

Run the current fuller GLM profile:

```bash
pnpm exec tsx scripts/evals/office-hours-runtime/run-live-cloudflare.ts \
  --base-url http://localhost:8791 \
  --model @cf/zai-org/glm-5.2 \
  --profile founder-update-demo \
  --max-steps 12
```

This profile is useful for candidate exploration, not parity scoring. It intentionally includes enough founder evidence to test complete artifact drafting and should still be inspected for plain-chat blocking questions, malformed tool calls, reasoning leaks, and artifact quality.

For both live runners, `--profile founder-update-demo` opts into full-artifact completion. Short scenario checks without `--complete-artifact` should remain bounded to the supplied turns and answers.

Run autonomous browser verification against the Cloudflare demo:

```bash
pnpm exec tsx scripts/evals/office-hours-runtime/browser-verify.ts \
  --base-url http://localhost:8791 \
  --model @cf/zai-org/glm-5.2 \
  --profile founder-update-demo \
  --target-sections 1 \
  --max-steps 6
```

The browser verifier opens `/demo`, selects the requested model, sends scenario turns, answers native or synthesized structured questions, waits for each streamed turn to settle before taking the next action, saves a full-page screenshot and `summary.json`, and fails on visible errors, insufficient sections, visible reasoning leaks, empty assistant bubbles, or plain-text blocking questions.

Run the final candidate video path only after a strong non-recorded browser pass:

```bash
pnpm exec tsx scripts/evals/office-hours-runtime/browser-verify.ts \
  --base-url http://localhost:8791 \
  --model @cf/zai-org/glm-5.2 \
  --profile founder-update-demo \
  --target-sections 7 \
  --max-steps 16 \
  --record-video
```

Validate and package the final recorded Cloudflare demo evidence:

```bash
pnpm exec tsx scripts/evals/office-hours-runtime/verify-demo-evidence.ts \
  --summary tmp/evals/office-hours-runtime/browser/browser__cf_zai_org_glm_5_2_1782174180303/summary.json \
  --expected-model @cf/zai-org/glm-5.2 \
  --min-sections 7 \
  --out tmp/evals/office-hours-runtime/cloudflare-glm-demo-evidence.md
```

This does not rerun the model. It verifies the recorded browser summary, PNG screenshot signature and size, WebM/EBML video signature and minimum size, model id, section count, absence of browser errors, absence of visible reasoning leaks, absence of empty assistant bubbles, and absence of plain-text blocking questions, then writes a reviewer-ready evidence report.

## Evidence Layers

Every comparison run should produce four evidence layers:

1. Protocol proof: raw SSE frames, semantic trace, canonical snapshots, forensic hash, UX hash, manifest, and gate results.
2. Browser proof: DOM assertions for transcript, pending question, answered question, disabled stale buttons, sections, ready/error states, reconnect if applicable.
3. Visual proof: screenshot or video metadata. Final video should be recorded only after a strong Cloudflare candidate works well.
4. Operator proof: bounded report from `buildRuntimeComparisonReport`, including usage/cost completeness and any blocked gates.

## Gate Notes

- `G0_CONFIG`: manifests match, or deltas are pre-approved and visible.
- `G1_PROTOCOL`: create/turn/SSE/running/idle/error behavior passes.
- `G2_TOOLS`: `ask_user_question` and `emit_section` semantics pass.
- `G3_RECOVERY`: duplicate/stale answers, resume, and reconnect pass.
- `G4_METHODOLOGY`: Office Hours behavior remains strict and non-implementation-oriented.
- `G5_UX`: browser-facing transcript, question UI, doc pane, errors, and recovery affordances pass.
- `G6_OPERATIONS`: usage, latency, cost, logging, and trace redaction are complete.
- `G7_MODEL_SUBSTITUTION`: cheaper-model lane can begin only after Sonnet parity.

## Current Blockers

- Anthropic provider capacity is currently available for the local Sonnet lane. If the API key or workspace limit changes, rerun the capacity probe before any live canary.
- The live CMA and Cloudflare Sonnet runners both work in this worktree. The SC1/SC5/SC6 no-browser canary completed, and a focused SC1 browser pair recorded CMA and Cloudflare videos.
- CMA manifest hashes are sourced from the committed `skills.json` registration artifact. A later operations check should still verify the remote Anthropic agent metadata against that committed hash before a final canary decision.
- Usage/cost evidence includes a priced maxSteps=20 founder-update Sonnet pair in the strict raw-`SKILL.md` lane: prompt caching works, but Cloudflare was still about 1.32x CMA. The optimized Cloudflare lane reached effective cost parity only after Anthropic prompt caching, compact method-summary, and question-cap tuning. Broader canary cost confidence is still missing until SC1/SC5/SC6 are priced consistently and the strict lane gets browser evidence.
- Browser evidence now includes one rich founder-update Sonnet pair with both runtimes reaching seven visible sections and video capture. Full browser scenario coverage is still missing for the SC1/SC5/SC6 canary set. The next browser canary should use `--capture-browser-failures` so failures are recorded instead of preventing comparison artifacts.
- GLM 5.2 proved question/resume, one-section browser UX, one full seven-section API-level artifact, a runtime fallback that converts plain chat blocking questions into structured question UI, and two full seven-section browser artifacts. The recorded browser run is useful demo evidence, but not enough for substitution confidence because earlier runs showed inconsistent instruction-following. It needs repeated scenario runs, evaluator scoring, and likely model-specific prompt/tool guardrails.
- Browser video is now recorded for the GLM 5.2 candidate at `tmp/evals/office-hours-runtime/browser/browser__cf_zai_org_glm_5_2_1782174180303/page@f90fdfcabf35edf209b9fbf89f7c0e2a.webm`.
