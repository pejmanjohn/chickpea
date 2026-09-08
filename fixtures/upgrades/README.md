# Populated upgrade baseline

`v0.1.0.json` is the synthetic fixture recipe for the initial release. It contains
no account coordinates or credentials. Bind its references to registered test
actors, a disposable customer-path Worker, and a synthetic provider fixture in
the private live-verification spec. Do not use a standing QA lane as a disposable
installation. Follow `qa/live/operator/SKILL.md` for the attended record.

## Register and prepare the private fixture

Record the exact account, Worker, public origin, Slack app/workspace/channel,
Owner and distinct Member, provider fixture, and cleanup owner in the private
verification spec before mutating anything. An operator may designate an
existing disposable installation; designation does not authorize deleting its
standing data. Preserve its exact source, artifact, AUTH_DB, Durable Object
namespaces, setup authority and credential roots. Unknown-source installations
must complete reviewed adoption before entering this versioned rehearsal.

1. Retain the exact baseline source, artifact and source-export receipt. Deploy
   it through the guarded customer path to the selected disposable Worker.
   `v0.1.0.json` remains the historical fixture recipe, not a claim that every
   v0.1.0 feature works: its Worker update check and retained deployment tooling
   have known defects. Distinguish testing that historical origin from testing
   a corrected baseline. Record both exact commits and the expected defects;
   do not relabel old code or treat a private candidate as a published release.
2. Sign in as the Owner, verify a distinct Member, and create the run-named Agent,
   memory, connection reference, and bounded schedule described in the recipe.
   Record their exact IDs, saved values, scopes, grants, and resource identities
   privately. Prefer explicit existing Admin forms for repeatable Agent,
   connection and grant setup; avoid asking a model to improvise fixture setup.
   Establish a real authenticated provider read and Slack reply before
   proceeding. A saved connection marked ready is not an invocation: choose a
   supported connection/tool for that runtime. In particular, historical
   v0.1.0 core REST connection metadata does not prove a credential-aware HTTP
   invocation path. If a required capability is unavailable, record the gap
   rather than substituting an unauthenticated public request.
3. Build a compatible candidate with a different version, the initial version
   in `supportedOrigins`, and unchanged storage/migration digests. Run the same
   wrapper context and state-machine tests used by the published command.
   Test fixtures may inject release responses in process; the production CLI
   must continue to require an immutable release from the official repository.
   Use the current reviewed upgrade runner for both directions and retain the
   previous immutable source/artifact as the recovery payload. Do not patch
   retained source or fall back to a known-defective old release runner.

## Exercise each boundary

4. Exercise each listed transition with private, attended interruption controls:
   - **Before upload:** interrupt after local preparation, before the Worker
     version upload. Read back the original serving version; no new version
     should be recorded as uploaded.
   - **After upload, before activation:** wait for the `uploaded` deployment
     event containing the exact Worker version ID, then stop before its traffic
     activation. Confirm the original version still serves and retain the new
     upload ID and receipt. An upload alone is not an upgrade pass.
   - **After activation, before readiness:** if this boundary is exercised,
     retain the actual serving version and incomplete readiness event. Resume
     the same receipt; do not assume the previous code still serves.
   Resume/recover through the same receipt. Match `deploying`, `uploaded` and
   `ready` events to provider readbacks; do not infer a boundary from elapsed
   time or a process exit. Interrupt only the test command, never another
   operator's process. A rejected safety gate is evidence to diagnose, not
   permission to fabricate fields or bypass authority checks.
5. After each transition compare every `preserve` item with the recorded
   before-value. Check actual Owner/Member behavior, a fresh Slack request and
   thread follow-up, the existing connection's provider read, and a real due
   occurrence spanning the transition. Inspect canonical occurrence/delivery
   evidence for duplicates; a successful upload or an Agent's claim is not proof.
6. Pause the schedule at its occurrence budget or deadline, confirm no further
   delivery, and perform the recipe's exact cleanup. Preserve failed attempts
   and the final readbacks in the private run record. Only remove resources
   created and recorded by this run; keep standing Agents, connections, messages,
   credentials and all recovery receipts until their recovery window is closed.

## Compare captured installation state

`scripts/verify-upgrade-preservation.mjs` compares private captures; it performs
no network access, setup, repair or live acceptance. Each capture is JSON with:

```text
schema: 1
target: { account, worker, profile: "core", url }
observedAt: ISO timestamp
installation: raw serving-version inspector output
serviceConfiguration:
  source: "cloudflare-api"
  observedAt: ISO timestamp
  values: { routes, crons, observability, logpush, tailConsumers, workersDev }
```

Capture both phases from the identified Worker. Use the serving version's
binding inventory for resources and secret **names**, never secret values.
Service values must come from authoritative Cloudflare reads: route and cron
arrays, observability object (or explicitly absent `null`), logpush boolean,
tail-consumer array, and workers.dev object including `enabled` and
`previews_enabled`. Missing fields are a failed capture; never invent empty
arrays, disabled flags or copied-before values to make comparison pass. The
source label records the operator's attestation; the helper cannot authenticate
the capture or prove that a provider request occurred.

Use owner-controlled files (`0600`) in a private directory (`0700`) outside Git:

```sh
node scripts/verify-upgrade-preservation.mjs \
  --before /absolute/private/run/before.json \
  --after /absolute/private/run/after.json \
  --output /absolute/private/run/preservation-report.json
```

Output creation is exclusive. Exit 0 means captured configuration is preserved;
1 means differences; 2 means invalid evidence or paths. Reports expose only
difference categories and version/digest fingerprints, not configuration or
credential values. Setup authority is part of the preserved variables. This
does not prove secret values are unchanged or replace Agent/memory/role,
provider, Slack, schedule and duplicate-delivery readbacks.

## Published artifact gate

Private compatible candidates establish rehearsal evidence only. Before calling
a public upgrade transition supported, verify the exact immutable published
artifact, its declared origin/storage contract, installation and recovery through
the current reviewed command, and the same populated live readbacks. Keep the
historical-origin results, corrected-baseline results and published-artifact
results separate; a passing build or private fixture does not substitute for
that final gate.

The deterministic tests prove guards and retry state transitions. This recipe
defines the separate attended upgrade/recovery acceptance; its presence is not
evidence that a live deployment passed.
