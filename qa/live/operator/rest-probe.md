# Corroborating native REST requests

Use this only inside an authorized, bounded `chickpea-live-verification` run.
The probe supplies independent provider evidence for the Bash REST transport.
It does not test the container transport or native Google OAuth.

Run the selected local checks first. Resolve and claim the QA lane, the serving
candidate, signed-in actor, Agent, and Slack destination through the existing
operator workflow. Keep all coordinates and receipts outside the repository.

## Start the disposable provider

Start `scripts/live-test-rest-probe.mjs` with Node 24.20.0, an absolute `--log`
path in an existing private directory outside Git, and an `--expect-bearer` value
beginning with `qa-synthetic-` followed by 8–100 letters, digits, underscores, or
hyphens. This must be a generated synthetic value, never a provider credential.
The script refuses to overwrite a log. It binds only to loopback and prints its
assigned origin. It stops after ten minutes or 100 requests.

Expose that origin with an ephemeral quick tunnel:

```sh
cloudflared --config /dev/null tunnel --url http://127.0.0.1:<assigned-port>
```

Keep both processes in owned terminals. Capture the public hostname privately.
Do not create a named tunnel, change shared gateway configuration, or add the
probe to product UI. Stop both processes at the case deadline or completion.

Before the Slack action, use the public URL to make an authenticated operator
GET and POST to `/probe/control`. Expect a fresh nonce for GET and HTTP 405 for
POST, with both calls in the log. This proves reachability and that a leaked
POST would be recorded. A nonce is returned only when authentication matches.
Record these as controls, not Agent calls.

## Attended cases

Create and register a run-owned personal REST connection for the chosen Agent.
Set its base URL to `https://<hostname>/probe`, methods to GET/HEAD, header to
Authorization, prefix to `Bearer `, and token to the synthetic probe value.
Verify the exact saved account ID and policy before starting a case.

1. **Read:** use a fresh marker containing only letters, digits, underscores, or
   hyphens. Ask the Agent to run `curl -sS https://<hostname>/probe/<marker>` and
   return the nonce without supplying any authorization header itself. Require
   a Slack reply containing the exact unpredictable nonce from an authenticated
   GET receipt for that marker. Do not count an operator control or a model's
   success claim as proof. Record retries or duplicate provider calls if present.
2. **Method denial:** in the same thread, ask for exactly one
   `curl -sS -X POST` to a fresh marker on the same provider. Require the explicit
   method refusal in the reply and zero provider receipts for that marker. A
   generic refusal, missing reply, or bare exit code is inconclusive. Verify the
   probe is still reachable with a separate authenticated control GET before
   claiming that the absence of a receipt proves anything.
3. **Revocation:** record the account's state, then disconnect that exact owned
   account through the product. Verify the disconnect readback. Ask once for a
   GET using another fresh marker. Require a failure and zero provider receipts
   for that marker, followed by a successful independent control GET. The
   product may start a new runtime after disconnect; this proves revoked access
   stays unavailable, not that a warm sandbox was reused. Same-sandbox authority
   changes are exercised by `tests/runtime-plan-sandbox.test.ts`.

The JSONL receipts contain timestamps, methods, bounded markers, status,
authentication booleans, and returned nonces. They omit headers, bodies, and
query strings. Freeze a copy after each case before recording it as hashed
evidence; do not append to a file already cited by an attempt.

Disconnect the owned account if the revocation case did not reach that step.
Verify the resulting product state, register exact cleanup, stop the two owned
processes, and release the lane claim. Preserve the first outcome and generate
the report from the run record. A stopped or unreachable probe cannot prove
that the Agent's request was denied.
