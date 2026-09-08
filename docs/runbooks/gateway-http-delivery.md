# Shared gateway HTTP delivery

Cloudflare installations on a canonical `workers.dev` origin use signed HTTP
push when the gateway supports `/v1/delivery/status`. Other origins and older
gateways keep the existing socket transport. Node behavior is unchanged.

The gateway holds routing metadata and encrypted per-binding signing keys, not
message bodies. The installation verifies the exact body, destination, timestamp,
binding, workspace, application, deployment identity and route revision in its
state Durable Object. It persists the event and arms recovery before returning
an accepted or duplicate receipt. Execution remains asynchronous.

Registration prepares a key through the existing deployment-signed control
plane. The installation encrypts and saves the candidate before activation. A
signed endpoint challenge proves possession of that key. Activation compares the
expected gateway revision and selects one transport. There is no timeout fallback
to the other transport. The first valid delivery on a prepared key promotes it
locally, so a lost activation response does not strand accepted work.

The delivery ID survives retries and transport changes. Completed inbox entries
retain a body-free tombstone for 48 hours. Transport signatures expire after five
minutes, but a delayed Slack retry receives a fresh signature with the original
delivery ID. External side effects are not guaranteed exactly once.

## Rotation and rollback

`GatewayDeploymentClient.ensureHttpDelivery(origin, {rotate: true})` prepares and
activates a new per-binding key. Ordinary maintenance resumes an unfinished
operation. Do not delete the local settings or change binding IDs to retry.

`GatewayDeploymentClient.rollbackHttpDelivery()` performs an authenticated,
revision-fenced switch to socket mode. It persists the rollback operation before
sending it, allowing maintenance to reconcile a lost response. Ordinary
maintenance leaves an explicit rollback in socket mode. Restoring an older Worker
binary alone is not a transport rollback. Preserve the inbox and binding.

The legacy Durable Object class remains during the migration window. Once HTTP
is active, its socket runner stops and its recovery alarm is removed. Removal of
the class/binding requires a separate migration after all supported deployments
have moved and the rollback window closes.

## Acceptance before rollout

- Match the gateway candidate to the serving gateway's existing authority,
  attachment, retry, lifecycle and idempotency behavior. Do not deploy an older
  branch that omits those protections.
- Prove same-account and cross-account Worker reachability using
  `global_fetch_strictly_public`. Use `redirect: manual` and reject redirects;
  Workers does not support `redirect: error`.
- Measure the actual built receiver's cold and warm admission times, including
  state initialization and alarm persistence. The complete Slack acknowledgement
  must fit within three seconds; HTTP forwarding has a two-second deadline.
- Inject response loss, alarm failure after insertion, concurrent duplicates,
  reinstall, revoked bindings, stale revision, key rotation and rollback.
- Verify route precedence and rejection of wrong-tenant signatures, oversized
  bodies, redirects and malformed receipts.
- On a disposable Slack installation, verify one real turn and reply after idle,
  restart and retry, and the supported button action. Local tests and synthetic
  HTTP probes do not establish Slack or model/tool acceptance.

A failed admission remains a failure to Slack. There is no policy that silently
acknowledges and discards events. Slack's finite retry window and app-wide failure
threshold still limit outage recovery. Delayed Events must be enabled and tested
on the shared app; its Events retry policy does not apply to button actions.

Do not display keys, route revisions, endpoint metadata or delivery receipts in
customer-facing Admin UI. Keep verification evidence private.
