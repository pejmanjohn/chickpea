# OpenAI Subscription

Chickpea's OpenAI Subscription method is a direct, experimental integration with OpenAI's published Codex native-client authorization flow and the private ChatGPT Codex Responses transport. It uses ordinary HTTP and Web Crypto on Node and Cloudflare Workers. It does not install, launch, proxy through, or call Codex app-server.

When Subscription is selected, the model picker starts with Chickpea's seven-model bundled compatibility catalog: `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, and `gpt-5.3-codex-spark`. All seven passed live subscription inference on 2026-07-29. A validated hosted snapshot may add a reviewed model only by mapping it to the already-compiled subscription contract; Chickpea never queries or caches an account-specific private model endpoint. The hosted data cannot change transport behavior or the selected billing lane. See [Model Catalog Operations](model-catalog.md).

This is not a stable OpenAI Platform API contract. Public implementations show current technical precedent, not an SLA or irrevocable permission for Chickpea. Treat every live acceptance gate below as release evidence for the exact build and account posture.

## Product and security boundary

- One installation stores one personal ChatGPT account connection. When Subscription is selected, any workspace member allowed to invoke an OpenAI-backed profile consumes that shared account's quota.
- API-key and Subscription credentials may coexist. With one connected credential Chickpea selects it automatically; connecting the second makes that method active and reveals the Settings selector. Every `openai/*` operation resolves the saved method again immediately before Agent construction.
- A Subscription-selected call never consults or falls back to `OPENAI_API_KEY`, including on revocation, quota exhaustion, entitlement rejection, timeout, 5xx, or protocol drift.
- Subscription-routed content follows the connected account's consumer ChatGPT data controls and retention/training policy, not the Platform API policy lane.
- Tokens, device authorization ids, verifiers, raw account ids, and attempt capabilities may exist only in the SettingsStore credential boundary or the exact outbound authorization/request boundary. They must not enter profiles, snapshots, prompts, tools, Slack, routines, audit facts, exports, URLs, cookies, HTML, or logs.
- The Settings UI exposes only a keyed account fingerprint and safe state/error categories. It cannot prove remote revocation.

Stop offering the connection if OpenAI objects, rejects `originator: chickpea`, rejects use of the published native client id/account posture, restricts the account for this use, or requires impersonation, concealment, or restriction bypass. Do not change the originator to `codex`, `opencode`, or another accepted client.

## Availability

ChatGPT subscription is a normal installation-wide OpenAI connection method on Node and Cloudflare. It has no preview or deployment flag. The Settings connection state and the installation's explicit OpenAI billing-method selection are the product controls. A disconnected or unhealthy Subscription-selected installation fails closed and never falls back to the API key.

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

After starting the exact candidate build, run one authorization check per target:

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
npm run verify:openai-subscription-runtime:live -- \
  --live --state-db ./tmp/openai-subscription-live.state.db
```

This compatibility alias runs the shared lane-aware verifier. Use `--model <id>`
to exercise a specific model. Add `--catalog-file <path>` to exercise a reviewed
hosted snapshot before publishing it. The canonical equivalent is:

```sh
npm run verify:model-compatibility:live -- \
  --live --lane subscription --model gpt-5.3-codex-spark \
  --state-db ./tmp/openai-subscription-live.state.db
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
9. Force revocation, quota exhaustion, entitlement rejection, and provider failure while Subscription is selected and both credentials remain connected. Every new OpenAI turn and routine must fail closed; no API-key fallback may occur.
10. Scan state projections, HTML/JSON, Slack replies, routine records, audits, logs, prompts, tool payloads, and exports using token-shaped fixtures. Secrets may appear only in credential storage and the exact outbound boundary.

Do not call the feature release-ready based on Settings connection state, local protocol success, or one model response. Node, deployed Worker, fresh Slack, routine, no-fallback, redaction, and refresh evidence are independent gates.

## Expected failure states

| State/code | Operator action | Billing behavior |
| --- | --- | --- |
| `auth_reconnect_required`, `authorization_missing`, `storage_invalid` | Reconnect in Settings. If unexpected, revoke remotely first. | No API fallback. |
| `subscription_quota_exhausted` | Wait for quota recovery or explicitly change the installation method in Settings. | No automatic method change. |
| `entitlement_denied` | Choose an entitled allowlisted model or explicitly use API key. | No automatic method change. |
| `client_rejected`, `originator_rejected` | Stop offering the connection and investigate. Do not impersonate. | No API fallback. |
| `protocol_drift`, `invalid_response` | Stop offering the connection, compare current primary sources, update fixtures, and rerun all gates. | No API fallback. |
| `provider_unavailable`, `request_timeout` | Retry later without changing billing authority. | No API fallback. |

Monitor safe counts of route facts and categorized failures. Never add raw provider bodies or token/account fields to observability to improve debugging.

## Disconnect, revocation, and suspected compromise

Disconnect in Settings deletes Chickpea's pending authorization, token bundle, refresh lease, identity key, and capability state. If a Platform API key remains connected, Chickpea selects it automatically; otherwise OpenAI operations fail closed. The Platform API key itself is untouched.

Local deletion does not prove every provider session was revoked. OpenAI exposes no supported revocation endpoint for this exact direct flow in the pinned sources. For intentional offboarding or suspected compromise:

1. Disconnect locally in Settings. For a fleet-wide incident, deploy an authorization block or remove the adapter before proceeding.
2. Use OpenAI account controls to sign out/revoke sessions and, when warranted, rotate the account password and review account activity.
3. Inspect only safe route/failure audit facts for the affected interval; do not retrieve or log token material.
4. Reconnect only after the account is considered safe and the product gates still pass.

## Rollback and removal

Rollback requires a code deploy that blocks new authorization and inference while preserving status and disconnect, or full adapter removal. Verify a new Subscription Slack turn and routine fail closed, an API-key turn succeeds, no `api.openai.com` request was triggered by the Subscription attempt, and status/disconnect still work.

Full code removal is intentionally localized:

1. Remove `src/openai-subscription/`, its tests/fixtures, and both subscription verification scripts.
2. Remove the internal provider registration and exact fetch boundary from `src/app.ts` and `src/config/providers.ts`.
3. Remove Subscription routing from `src/config/runtime-model.ts`, the Settings routes and UI, and safe subscription failure presentation.
4. Remove the installation method route and setting only through an explicit migration; never silently rewrite `subscription` to `api_key` while removing the adapter.
5. Remove this runbook only after the last connection has been intentionally disconnected or the credential keys have been explicitly scrubbed.
6. Run the full static, API-key provider, Node build, Worker build/smoke, Slack, routine, export/redaction, and deploy-artifact checks.

Do not introduce Codex app-server as a rollback or compatibility workaround. That would be a separate architecture decision.

## Source and attribution posture

- Official OpenAI auth documentation distinguishes ChatGPT subscription and Platform API-key billing/data-policy lanes: <https://learn.chatgpt.com/docs/auth?surface=app>.
- OpenAI's Codex repository publishes the native-client id, PKCE/device flow, scopes, and originator parameter pinned in the feature plan.
- OpenCode's MIT-licensed implementation at commit `a45c2b917e657e50881117e8c3f85f4bff06e47d` informed the independently encoded endpoint/header/refresh contract: <https://github.com/anomalyco/opencode/blob/a45c2b917e657e50881117e8c3f85f4bff06e47d/packages/opencode/src/plugin/openai/codex.ts>.
- OpenClaw at `ee814984875300466ebf10be9e384552be695b08` and Microsoft's Amplifier provider corroborate direct OAuth/transport behavior. Amp publicly offers subscription connection but does not disclose its implementation or any private provider agreement.

See [the approved feature plan](../plans/2026-07-28-001-feat-openai-subscription-auth-plan.md) for exact pinned source links, confidence levels, policy caveats, and the original decision record. The Chickpea implementation is independently structured around its credential boundary and Flue runtime; no OpenCode file is copied verbatim.
