# Slack Flue Vertical Slice Decision

Date: 2026-06-29

Status: continue with caveats

## Decision

Continue with Flue for the next prototype slice, with caveats around generated Cloudflare topology, beta Slack channel support, and the fact that live model calls are currently local REST calls rather than Cloudflare `AI` binding calls.

The local vertical slice proves the product contract shape without Skillet:

- a signed Slack Events `app_mention` route or local fixture starts a thread-scoped session;
- `workspace_id + channel_id` resolves to one configured custom agent;
- duplicate Slack `event_id` values are claimed before provider/tool work;
- one safe tool runs only when explicitly allowed by the agent policy;
- the same fixture runs through deterministic Claude and non-Claude provider lanes;
- thread replies continue the same session snapshot;
- Slack progress/final replies are sent to a Slack thread through `chat.postMessage`, or captured locally through the fixture sink;
- first-visible-response telemetry and basic provider usage/latency are captured;
- one generic Flue `slack-thread` agent module resolves dynamic config by instance id;
- Flue Cloudflare build and Wrangler dry-run generate the expected Durable Object bindings.

## Evidence

Commands run:

```bash
npm test
npm run flue:build
npx wrangler deploy --dry-run --config dist/slack_flue/wrangler.json
npm audit --audit-level=low
curl -fsS http://localhost:8789/health
curl -fsS https://ordering-ratings-mason-historic.trycloudflare.com/health
```

Results:

- `npm test`: 11 tests passed, including typecheck.
- `npm run flue:build`: built the Cloudflare target with discovered agent `slack-thread`.
- Wrangler dry-run: succeeded with `FLUE_SLACK_THREAD_AGENT`, `FLUE_REGISTRY`, and `AI`; upload was about 8.56 MiB / 1.54 MiB gzip with 42 attached modules.
- `npm audit --audit-level=low`: zero reported vulnerabilities.
- Paperplane Labs Slack app `Slack Flue Demo` was installed with `app_mentions:read` and `chat:write`.
- Slack Events Request URL verified against `https://ordering-ratings-mason-historic.trycloudflare.com/slack/events`.
- A live mention in `#all-paperplane-labs` reached the local server through the Cloudflare tunnel and produced a threaded progress reply plus a final deterministic non-Claude provider reply.
- The local `workers-ai` provider can now call live Cloudflare Workers AI over REST with Skillet-aligned model `@cf/zai-org/glm-5.2`.
- A local Slack fixture completed through live Workers AI with 2 reply posts and telemetry before the Slack server was restarted in live mode.

## Caveats

- The `workers-ai` lane is live only when `SLACK_FLUE_WORKERS_AI_MODE=live`; tests and offline fixtures still default to deterministic adapters.
- Local Workers AI uses Cloudflare's REST API with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. Skillet production runs Workers AI through the Cloudflare `AI` binding, so binding parity is still a follow-up.
- The `claude` lane remains deterministic in this prototype.
- Flue generated state is not product authority. Assignment, dedupe, access policy, and session snapshots remain app-owned in this slice.
- `@flue/slack` exists at `1.0.0-beta.1`, but the current channel docs are marked AI-generated/awaiting review. Keep the Slack adapter boundary thin until the package is proven against real Slack signatures and retries.
- Generated Flue DO SQLite state has not been scanned for seeded operational secrets because no live Cloudflare session was run.

## Required Next Gates

- Persist event dedupe and session snapshots in a small durable store instead of memory.
- Add a Cloudflare Worker runtime path that calls Workers AI through the `AI` binding, matching Skillet more closely than local REST.
- Add a live Anthropic provider adapter behind explicit env gates only if we need Claude comparison runs.
- Run a generated DO state/artifact redaction scan after a live Flue Cloudflare session.
- Decide whether to adopt `@flue/slack` after proving its beta route behavior, or keep an app-owned Slack adapter.
