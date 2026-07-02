# Provider reply — cloudflare-workers-ai (STUB)

- **Provenance:** STUB. `CLOUDFLARE_API_TOKEN` is PRESENT but was verified
  INVALID (HTTP 401, error code 1000 "Invalid API Token") against
  `GET https://api.cloudflare.com/client/v4/user/tokens/verify` on 2026-07-01.
  See `workers-ai-cred-check.md`. An invalid cred runs against the existing
  `openai-completions` stub (cloudflare-workers-ai speaks that protocol).
- **Model:** `cloudflare-workers-ai/@cf/zai-org/glm-5.2` (via `SLACK_FLUE_MODEL`).
- **Provider wire protocol:** `POST <base>/v1/chat/completions` streaming SSE
  (OpenAI chat.completion.chunk deltas). Wire methods observed: `chat/completions`.
- **Routing:** the SAME `app-mention.json` fixture, answered through the Flue
  lane by swapping only `SLACK_FLUE_MODEL`.

## Reply delivered on the Slack wire

```
WORKERS_AI_STUB_REPLY::glm-5.2::exec-priorities-ack
```
