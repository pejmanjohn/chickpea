# Runner matrix mode

The parallel-turns / runner-stack matrix is scripted. A verifier supervises one
concurrent run of about 15 minutes instead of driving each journey by hand.
Use it when a change touches turn execution, the thread runner, first-status
latency, streaming delivery, redeploy recovery, or gateway rate limits. It adds
no QA actions: it sends synthetic messages to the lane's designated test channel
and Chickpea DM, runs guarded same-candidate redeploys of the claimed lane, and
tails that lane's Worker, all within the skill's existing authorization. It
creates no Agents, schedules or grants, so cleanup is unchanged: retain the
run-marked messages as attributed QA output and stop the tail.

The driver lives in `qa/live/runner-matrix/`. `spec.json` holds the public
defaults; lane coordinates come from the environment registry, command flags,
or an owner-only `--params` file. Every generated file is private and stays in
the record directory outside Git.

## Cases and defaults

Offsets are from the armed T0. Cases overlap; only deploys serialise.

| Case | Default | Pass criteria |
| --- | --- | --- |
| `parity` | T0: channel mention (Agent A) and DM (Agent B); mention-free follow-up 5 s after the channel final | One final in each thread, no failure notice |
| `first-status` | +40 s long anchor (A), +45 s DM warm-up, +60 s eight side threads 3 s apart: both Agents, stacked A threads in one channel, one DM | Mention to first visible status (websocket `ai_assistant_status`, native or custom) max <= 10 s and p95 <= 5 s over the side threads; one final each; native-to-custom hand-over and `turn_latency` stages recorded |
| `long-turns` | +180 s four long streamed answers 1 s apart; interruption hook at +220 s | One final each; complete content (footer on the last part; continuations when over 12k characters); no failure notice. Under 90 s or under 4,000 characters is reported as a coverage gap |
| `rate-limit` | +420 s twelve short mentions 250 ms apart (two in the DM) | None dropped (status or reply for every mention, no `no assignment for turn`), one final each, no failure notice; gateway rate-limit and rejection lines counted |
| `redeploy-mid-turn` | Rounds at +480 s and +720 s: long turn A, redeploy at A+40 s, probe B at A+60 s | One full final for A, no failure notice; probe first status <= 10 s; deploy duration, captured fiber interruption and resume time (A final minus deploy end) recorded |

Phases are staggered so the first-status measurement and the burst do not share
one 60-second window of the shared gateway's per-binding limit. Change counts
with `--fs-n`, `--long-k`, `--redeploy-r` and `--burst-m`, select cases with
`--cases`, and edit a private copy of `spec.json` (`--spec`) for other offsets.

The interruption earlier runs relied on is the Flue fiber interruption that a
same-candidate redeploy causes (`fiber:run:interrupted`, then `Durable Object
reset because its code was updated`). Both deploy hooks run
`CHICKPEA_DEPLOY_TARGET=<lane> npm run verify:host -- --wait-ms 300000 npm run deploy`
from `--cwd` (the claimed candidate worktree), one at a time. Without
`--allow-deploy` they are skipped and `long-turns` and `redeploy-mid-turn` are
recorded as blocked. `--hook-command` substitutes another mechanism, such as an
RPC, when one exists; it receives `CHICKPEA_DEPLOY_TARGET` in its environment.

## Running it

Claim the lane, deploy the candidate and resolve the private spec as usual.
Record the run in the same `run.json` as the rest of the verification.

```sh
rec=/private/absolute/record/dir   # outside Git
npm run verify:live:runner-matrix -- plan --record "$rec" --lane <lane> \
  --channel <qa channel id> --agent-a <handle> --agent-b <handle>
npm run verify:live:runner-matrix -- spec-cases --record "$rec" \
  --spec "$run_dir/spec.json" --output "$run_dir/spec-matrix.json" --context <context>
npm run verify:live:record -- init --spec "$run_dir/spec-matrix.json" --run "$run_dir/run.json"
```

Both Agents must already be attached to the QA channel, so their user-group
mentions route. In the lane browser's signed-in Slack tab (`mcp__chrome-<lane>__evaluate_script`):

1. Evaluate the contents of `harness.js`. It installs the page harness and
   returns its plan summary. It uses the tab's own Slack session inside the
   page; it never returns, logs or stores the session credential.
2. Evaluate `arm.js`. It resolves the DM and both Agent user groups, schedules
   every send, and returns `t0`. A `missing` list means nothing was scheduled.
3. Start the driver in the background with that `t0`, before T0:

   ```sh
   CLOUDFLARE_ACCOUNT_ID=<lane account> npm run verify:live:runner-matrix -- run \
     --record "$rec" --t0 <t0> --allow-deploy --cwd <candidate worktree> \
     --run "$run_dir/run.json"
   ```

   It records `begin` for each matrix case, starts `wrangler tail --format json`
   (restarting on exit or stall), fires deploy hooks at their offsets, and exits
   when the plan window ends. If it refuses because T0 is too close, evaluate
   `disarm.js` and arm again.
4. Keep the tab open. `status.js` reports progress. Reloading the tab keeps
   sent-message state but loses websocket observations for the remainder.
5. After `run` exits, evaluate `collect.js`. It reads every thread back with
   `conversations.replies` and returns the chunk count. Evaluate `chunk.js`
   with each index from 0, editing the index, and write each returned string
   unchanged to `browser-export.part-000.txt`, `-001`, and so on.
6. Generate and record the results:

   ```sh
   npm run verify:live:runner-matrix -- report --record "$rec" --run "$run_dir/run.json" --finish
   ```

`report` writes `results.json`, results.md (per-case PASS/FAIL, first-status
p50/p95/max, stage breakdown per thread, hooks, evidence paths) and
`tail-runtime.json`. With `--finish` it records each attempt with its summary,
failure category, the export as Slack proof, and the evidence files. Without
it, read results.md first and finish the attempts yourself. The notebook still
grades only what the readback shows.

## Reading the results

- Percentiles are nearest-rank, so the p95 of eight samples is the maximum.
- Status times start when the harness began `chat.postMessage` in the Slack
  client. Stage times come from `turn_latency` (receipt to admission, admission
  to start, start to first write, receipt to first write) and `gateway_delivery`.
  Those records carry only an opaque turn reference, so the driver joins them to
  threads by time; an unmatched thread is reported, not guessed.
- Bot replies less than 8 s apart form one final (first message plus
  continuations). A second group in the same turn is a duplicate final.
- The Worker tail does not carry the shared gateway's per-call Slack operations.
  The rate-limit case counts rate-limit, rejection and routing-drop lines instead.
- A missing export or tail is a tool gap, not a product verdict. Missing
  telemetry proves no absence; the Slack readback remains the acceptance proof.

`npm run verify:live:runner-matrix -- dry-run --record <dir>` runs the whole
report path offline against fakes. `tests/qa-runner-matrix.test.ts` covers tail
parsing, percentile math, pass/fail evaluation and the page harness in a VM.
