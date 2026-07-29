# OpenAI Subscription Preview

Chickpea's OpenAI Subscription method is a direct, experimental integration with OpenAI's published Codex native-client authorization flow and the private ChatGPT Codex Responses transport. It uses ordinary HTTP and Web Crypto on Node and Cloudflare Workers. It does not install, launch, proxy through, or call Codex app-server.

This is not a stable OpenAI Platform API contract. Public implementations show current technical precedent, not an SLA or irrevocable permission for Chickpea. Keep the preview default-off until every live acceptance gate below passes for the exact build and account posture.

## Product and security boundary

- One installation stores one personal ChatGPT account connection. When Subscription is selected, any workspace member allowed to invoke an OpenAI-backed profile consumes that shared account's quota.
- API-key and Subscription credentials may coexist. Settings selects one method for every `openai/*` operation, resolved again immediately before Agent construction.
- A Subscription-selected call never consults or falls back to `OPENAI_API_KEY`, including on revocation, quota exhaustion, entitlement rejection, timeout, 5xx, protocol drift, or preview disablement.
- Subscription-routed content follows the connected account's consumer ChatGPT data controls and retention/training policy, not the Platform API policy lane.
- Tokens, device authorization ids, verifiers, raw account ids, and attempt capabilities may exist only in the SettingsStore credential boundary or the exact outbound authorization/request boundary. They must not enter profiles, snapshots, prompts, tools, Slack, routines, audit facts, exports, URLs, cookies, HTML, or logs.
- The Settings UI exposes only a keyed account fingerprint and safe state/error categories. It cannot prove remote revocation.

Stop the preview if OpenAI objects, rejects `originator: chickpea`, rejects use of the published native client id/account posture, restricts the account for this use, or requires impersonation, concealment, or restriction bypass. Do not change the originator to `codex`, `opencode`, or another accepted client.

## Default-off switch

`TAG_OPENAI_SUBSCRIPTION_ENABLED` is evaluated at authorization and inference admission. Exact string `"1"` is enabled; missing, `"0"`, `"true"`, malformed, and every other value are disabled.

Node:

```sh
TAG_OPENAI_SUBSCRIPTION_ENABLED=1 npm run flue:build
```

Cloudflare: keep the committed `wrangler.jsonc` value at `"0"` through build and smoke verification. Enable an explicitly reviewed deployment with the corresponding Worker variable only after the gates below pass. Confirm the resulting binding is exactly `"1"`; do not infer it from the Settings page alone.

Disabling the switch immediately blocks new authorization, account-change confirmation, polling, and every newly constructed subscription operation. It does not delete stored credentials or rewrite the selected installation method. Status, cancellation, and disconnect remain available. If Subscription is selected, all OpenAI calls fail closed; Chickpea never falls back to the API key. Re-enabling resumes a still-valid connected credential or surfaces reconnect-required.

## Offline prerequisites

Use Node 24 for repository verification:

```sh
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
FLUE_NODE_BIN=/opt/homebrew/opt/node@24/bin/node \
npm test

npm run verify:openai-subscription-protocol
npm run verify:admin-ui
npm run verify:providers
npm run flue:build
npm run build
npm run verify:cf-smoke
```

The offline protocol check asserts that no Codex/app-server dependency was introduced, that the pinned direct endpoint/model contract is present, and that no network request is made. The provider harness remains net-guarded and verifies existing providers independently.

## First live compatibility gate

The direct compatibility check contacts OpenAI, consumes subscription quota, and requires explicit browser authorization. It keeps tokens only in process memory:

```sh
npm run verify:openai-subscription-protocol -- --live
```

Pass only if the published client id, device authorization, account claim, `originator: chickpea`, selected allowlisted model, streaming Responses request, and exact success marker are accepted. Never paste token material, the user code, device authorization id, verifier, raw account id, authorization URL, or response body into logs, screenshots, issues, or acceptance notes.

If this gate rejects the client id or originator, stop. Do not enable the product flag and do not retry by impersonating another client.

## Target authorization checks

After starting the exact candidate build with the flag enabled, run one authorization check per target:

```sh
TAG_ADMIN_TOKEN='<local-admin-token>' \
npm run verify:openai-subscription:live -- \
  --live --target node --base-url http://127.0.0.1:3000

TAG_ADMIN_TOKEN='<worker-admin-token>' \
npm run verify:openai-subscription:live -- \
  --live --target cloudflare --base-url https://chickpea.example.workers.dev
```

The script uses Bearer admin auth, holds the attempt capability in memory, and prints the provider user code only to the initiating terminal. It does not send a model request and does not disconnect an existing connection. A passing authorization check is not runtime acceptance.

For an authorized local Node settings database, the product-path verifier sends
one minimal prompt through Chickpea's real profile resolver and internal
subscription provider. It deliberately installs an invalid Platform API key and
fails unless the request succeeds at `chatgpt.com` with no `api.openai.com`
traffic:

```sh
TAG_OPENAI_SUBSCRIPTION_ENABLED=1 \
npm run verify:openai-subscription-runtime:live -- \
  --live --state-db ./tmp/openai-subscription-live.state.db
```

This is a Node runtime/no-fallback gate, not Slack or deployed-Worker acceptance.
The exact ChatGPT Codex endpoint may omit `Content-Type` on a successful SSE
response. Chickpea accepts the missing header only at its pinned endpoint,
normalizes it to `text/event-stream`, and still rejects an explicitly
contradictory success type before the provider parser.

The next Node gate drives a signed app mention through the built Chickpea
server, the real profile resolver and subscription provider, and a loopback
fake Slack backend. It copies the authorized credential boundary into a
temporary state database, deletes that database on exit, installs an invalid
Platform API key, and permits external traffic only to the ChatGPT subscription
authorization/request hosts:

```sh
TAG_OPENAI_SUBSCRIPTION_ENABLED=1 \
npm run verify:openai-subscription-slack:live -- \
  --live --source-state-db ./tmp/openai-subscription-live.state.db
```

A pass proves local signed-Slack adapter and final-delivery integration with no
observed Platform API fallback. Slack itself remains fake, so this is not a
fresh real-Slack or deployed-Worker acceptance result.

## Runtime acceptance matrix

Record only target, build commit, timestamp, safe account fingerprint, account class without PII, model, safe auth route, destination host, outcome, and error category.

1. Configure both a valid Platform API key and a connected Subscription account.
2. Use one compatible OpenAI profile. Select `API key` in Settings, send a fresh Node Slack request, and confirm the audit route fact is `openai_api_key`.
3. Select `ChatGPT subscription` in Settings, send a fresh Node Slack request through the same profile, and confirm the audit route fact is `openai_subscription`.
4. On the deployed Worker, repeat with a fresh Slack thread. Worker acceptance is separate from local/admin proof.
5. Run one Subscription-backed routine occurrence on Cloudflare and confirm the stored route is `openai_subscription`, usage unit is `chatgpt_subscription_quota`, and monetary Platform cost is absent.
6. Exercise a tool call, structured output, retry/compaction path, streaming cancellation, and concurrent API-key/Subscription operations.
7. Force or fixture refresh rotation, expired/revoked refresh, 429/quota, entitlement rejection, timeout/5xx, malformed response/SSE, unsupported model, redirect, and originator/client rejection.
8. For every Subscription success and failure, capture the outbound destination. There must be no request to `api.openai.com` and no API-key provider registration/use.
9. Disable the flag while Subscription is selected and both credentials remain connected. A new OpenAI turn and routine must fail with `preview_disabled`; no API-key fallback may occur. Re-enable and confirm the stored connection either resumes or asks for reconnect.
10. Scan state projections, HTML/JSON, Slack replies, routine records, audits, logs, prompts, tool payloads, and exports using token-shaped fixtures. Secrets may appear only in credential storage and the exact outbound boundary.

Do not call the preview ready based on Settings connection state, local protocol success, or one model response. Node, deployed Worker, fresh Slack, routine, no-fallback, redaction, refresh, and kill-switch evidence are independent gates.

## Expected failure states

| State/code | Operator action | Billing behavior |
| --- | --- | --- |
| `preview_disabled` | Review this runbook; deliberately enable only after gates pass. | Subscription is blocked; no API fallback. |
| `auth_reconnect_required`, `authorization_missing`, `storage_invalid` | Reconnect in Settings. If unexpected, revoke remotely first. | No API fallback. |
| `subscription_quota_exhausted` | Wait for quota recovery or explicitly change the installation method in Settings. | No automatic method change. |
| `entitlement_denied` | Choose an entitled allowlisted model or explicitly use API key. | No automatic method change. |
| `client_rejected`, `originator_rejected` | Disable the preview and investigate. Do not impersonate. | No API fallback. |
| `protocol_drift`, `invalid_response` | Disable the preview, compare current primary sources, update fixtures, and rerun all gates. | No API fallback. |
| `provider_unavailable`, `request_timeout` | Retry later without changing billing authority. | No API fallback. |

Monitor safe counts of route facts and categorized failures. Never add raw provider bodies or token/account fields to observability to improve debugging.

## Disconnect, revocation, and suspected compromise

Disconnect in Settings deletes Chickpea's pending authorization, token bundle, refresh lease, identity key, and capability state. Profiles retain `Subscription` and fail closed. The Platform API key is untouched.

Local deletion does not prove every provider session was revoked. OpenAI exposes no supported revocation endpoint for this exact direct flow in the pinned sources. For intentional offboarding or suspected compromise:

1. Disable `TAG_OPENAI_SUBSCRIPTION_ENABLED`.
2. Use OpenAI account controls to sign out/revoke sessions and, when warranted, rotate the account password and review account activity.
3. Disconnect locally in Settings.
4. Inspect only safe route/failure audit facts for the affected interval; do not retrieve or log token material.
5. Reconnect only after the account is considered safe and the product gates still pass.

## Rollback and removal

Operational rollback is one variable change: set the flag to `"0"` and deploy/restart. Verify a new Subscription Slack turn and routine fail closed, an API-key turn succeeds, no `api.openai.com` request was triggered by the Subscription attempt, and status/disconnect still work.

Code removal is intentionally localized:

1. Keep the flag disabled.
2. Remove `src/openai-subscription/`, its tests/fixtures, and both subscription verification scripts.
3. Remove the internal provider registration and exact fetch boundary from `src/app.ts` and `src/config/providers.ts`.
4. Remove Subscription routing from `src/config/runtime-model.ts`, the Settings routes and UI, and safe subscription failure presentation.
5. Remove the installation method route and setting only through an explicit migration; never silently rewrite `subscription` to `api_key` while removing the adapter.
6. Remove the Worker/Node flag and this runbook only after the last connection has been intentionally disconnected or the credential keys have been explicitly scrubbed.
7. Run the full static, API-key provider, Node build, Worker build/smoke, Slack, routine, export/redaction, and deploy-artifact checks.

Do not introduce Codex app-server as a rollback or compatibility workaround. That would be a separate architecture decision.

## Source and attribution posture

- Official OpenAI auth documentation distinguishes ChatGPT subscription and Platform API-key billing/data-policy lanes: <https://learn.chatgpt.com/docs/auth?surface=app>.
- OpenAI's Codex repository publishes the native-client id, PKCE/device flow, scopes, and originator parameter pinned in the feature plan.
- OpenCode's MIT-licensed implementation at commit `a45c2b917e657e50881117e8c3f85f4bff06e47d` informed the independently encoded endpoint/header/refresh contract: <https://github.com/anomalyco/opencode/blob/a45c2b917e657e50881117e8c3f85f4bff06e47d/packages/opencode/src/plugin/openai/codex.ts>.
- OpenClaw at `ee814984875300466ebf10be9e384552be695b08` and Microsoft's Amplifier provider corroborate direct OAuth/transport behavior. Amp publicly offers subscription connection but does not disclose its implementation or any private provider agreement.

See [the approved feature plan](../plans/2026-07-28-001-feat-openai-subscription-auth-plan.md) for exact pinned source links, confidence levels, policy caveats, and the original decision record. The Chickpea implementation is independently structured around its credential boundary and Flue runtime; no OpenCode file is copied verbatim.
