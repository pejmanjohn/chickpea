# Bounded product-contract diagnosis

Before another live schedule/model retry, run the real product contract:

```sh
npm run evaluate:schedule-contract
npm run evaluate:schedule-contract -- --case exact-private-span --output /private/path/contract.json
```

This extends the existing synthetic evaluation/check workflow. The corpus uses
sanitized fixtures; the evaluator imports the active `manage_scheduled_work`
schema, description and instructions. It runs the actual converter and requester
pre-admission guard at a fixed time. Storage is unavailable, and a reservation
sentinel stops accepted arguments before the first write. No returned tool action
executes. Unavailable dependencies fail the evaluation instead of passing a case.

Read the stages separately. A schema-valid call can fail exact task, cadence,
timezone or output-policy authority. Pre-admission acceptance says nothing about
actor authorization during apply, persistence, execution at the due time, provider
work, or Slack delivery. Keep those as separate attended cases. In particular,
admitting `post_on_change` does not prove a real `no_op` or silence. A standalone
structured-result study also cannot establish schedule creation reliability.

The fixtures cover contiguous exact tasks, paraphrases and splices, named dates,
local dates with IANA zones, zero seconds, trailing Z/offset rejection, and silent
policy. Keep authority guards strict. Add the smallest sanitized failing pair to
this corpus before changing instructions. Keep a failed initial diagnosis beside
the corrected one. A later synthetic reproduction proves that mechanism, not
the unknown arguments from an earlier live failure.

## Optional model comparison

Do this only when model behavior remains relevant and the requested call budget
authorizes it. The maintenance/default deterministic command spends no model calls.

```sh
npm run evaluate:schedule-contract -- --live --case exact-private-span --model PROVIDER/EXACT_MODEL --max-calls 1 --output /private/path/model-contract.json
```

Use the existing approved provider credential environment. The exact model must
exist in the installed adapter; unsupported models require a separate explicit
adapter evaluation, never substitution. Repeat `--model` for a small comparison,
select identical `--case` values, and use `--repeats 1..3`. The declared budget must
cover every selected case/model/repetition, with at most 24 calls. Each call has
zero retries, 2048 maximum output tokens and a 60-second watchdog. A new retry
requires another deliberately bounded invocation and a new output filename.

Retain identical source tree, schema/instruction hashes, requests, fixture context,
time, settings and repetition counts. Model order rotates by case/repetition.
Start from the same conversation context, and disclose adapter differences or
unsupported reasoning controls instead of calling the comparison matched.
Keep the original workspace-default model and, after a product fix, retest it
when relevant. A fix that also works on that model does not prove a model switch
was necessary. This is optional diagnosis, never a mandatory provider matrix.

Every first attempt is written before transport. Report attempted, evaluable,
passed and transport-failure counts, including interrupted attempts. An API/tool
error with no usable model payload has zero evaluable samples; its duration and
unknown cost are separate from model correctness. Do not retry it silently or
rank it as a failed model answer. Compare end-to-end call latencies only for
equivalent evaluable requests; disclose sample sizes, cache conditions and any
adapter differences. A few observations do not establish reliability or a tail
latency estimate.

Record configured identity separately from adapter-reported identity. The latter
may simply echo the request; `routedModel: null` means independent route evidence
is unavailable. Native serving-model readback, when available, is stronger proof.
Preserve input, cache-read, cache-write and output counts; Pi input is uncached,
and reasoning is already a subset of output. Do not add it again. Missing usage
is unknown, including for failed calls that may have reached the provider.
Adapter `usage.cost` is an unverified registry estimate. If comparing costs, attach
a dated official price/rate snapshot, recompute each category with those rates,
and label the result an estimate. Keep discounts, quotas and actual billing
separate; do not present stale registry prices as current bills.

## Private evidence and handoff

The output contains only synthetic requests, generated arguments, typed validation
results, stage/branch, schema/instruction snapshots, source/settings hashes, timing
and usage. The filename must be outside Git. It refuses an existing destination,
preserves partial attempts and never resumes or rewrites a historical live run.
Attach this file to the existing private run's evidence and use its existing
`modelMs`/cost fields when measured. Leave unknown cost null. Do not keep a second
manual timing table.

When exact earlier arguments were not retained, say the failed branch is unknown
until bounded evidence establishes it. Never add broad raw prompt/tool-argument
logging to production, weaken content-free telemetry, or introduce an analytics
stream for this diagnosis. Keep arbitrary provider error text out of diagnostics;
error type and the retained transport boundary are sufficient here.
