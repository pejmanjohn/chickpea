# Credential validity checks (Stage 4, part b)

No secret values are recorded here — only presence and validity status.

| Credential | Present? | Validity check | Result |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | No (absent from shell env and `.env.slack.local`) | n/a (absent) | Runs against a labeled anthropic-messages STUB |
| `CLOUDFLARE_API_TOKEN` | Yes (in `.env.slack.local`) | `GET https://api.cloudflare.com/client/v4/user/tokens/verify` | **INVALID** |

## Cloudflare token verify (re-tested 2026-07-01)

Command (token passed via `Authorization: Bearer`, never printed):
```
GET https://api.cloudflare.com/client/v4/user/tokens/verify
```
Response (validity fields only):
- HTTP status: `401`
- `success`: `False`
- error code: `1000`
- error message: `Invalid API Token`

The token is invalid, so the cloudflare-workers-ai evidence is a clearly-labeled
STUB run (`openai-completions` protocol). This matches the 2026-07-01 finding
of an invalid Cloudflare token.
