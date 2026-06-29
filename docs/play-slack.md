# Play With Slack Flue

This is the smallest real Slack loop. By default it uses the deterministic provider so fixtures do not spend model quota. Set `SLACK_FLUE_WORKERS_AI_MODE=live` to call real Cloudflare Workers AI.

## 1. Create a Slack app

Create a Slack app at `https://api.slack.com/apps`.

Add bot scopes:

- `app_mentions:read`
- `chat:write`

Install the app to the workspace, then copy:

- Signing Secret
- Bot User OAuth Token

## 2. Run the local server

```bash
export SLACK_SIGNING_SECRET="..."
export SLACK_BOT_TOKEN="xoxb-..."
export SLACK_FLUE_PROVIDER="workers-ai"
export SLACK_FLUE_WORKERS_AI_MODE="live"
export CLOUDFLARE_ACCOUNT_ID="..."
export CLOUDFLARE_API_TOKEN="..."
export CLOUDFLARE_WORKERS_AI_MODEL="@cf/zai-org/glm-5.2"
export PORT=8789
npm run dev:slack
```

The server exposes:

- `POST /slack/events`
- `GET /health`

## 3. Expose it to Slack

Use a tunnel, for example:

```bash
cloudflared tunnel --url http://localhost:8789
```

Set Slack Events Request URL to:

```text
https://<your-tunnel-host>/slack/events
```

Slack should verify the URL challenge.

Subscribe to bot event:

- `app_mention`

## 4. Try it in Slack

Invite the bot to a channel, then mention it:

```text
@Slack Flue please use channel context and draft an exec summary
```

Expected behavior:

- immediate threaded progress reply;
- final threaded reply from `Exec Research`;
- no live model call yet;
- duplicate Slack retries are acknowledged without duplicate posts.

The Paperplane Labs playtest app is configured for:

- workspace `T0AJZ12JALU`;
- channel `C0AJVCUNL4A` / `#all-paperplane-labs`;
- app name `Slack Flue Demo`;
- provider `workers-ai`;
- Skillet-aligned Workers AI model `@cf/zai-org/glm-5.2`.

That exact channel row returns a seeded channel brief when the message includes `channel context`. For broader playtesting, `src/config/seed.ts` also includes a catch-all `*/* -> agent_exec_research` assignment so any channel where the bot is invited will work. Replace the catch-all before testing anything beyond a private demo workspace.

## Safety Notes

- Do not paste Slack tokens into chat, docs, tests, or fixtures.
- Keep `.env` and `.dev.vars` uncommitted.
- Keep `SLACK_FLUE_WORKERS_AI_MODE=deterministic` for offline fixture work.
- Use `SLACK_FLUE_WORKERS_AI_MODE=live` only when the ignored local env file has `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.
