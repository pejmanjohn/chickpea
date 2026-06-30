# Play With Slack Flue

This is the smallest real Slack loop. By default it uses the deterministic provider so fixtures do not spend model quota. Set `SLACK_FLUE_WORKERS_AI_MODE=live` to call real Cloudflare Workers AI.

## 1. Create a Slack app

Create a Slack app at `https://api.slack.com/apps`.

Add bot scopes:

- `app_mentions:read`
- `chat:write`
- `assistant:write`

Enable Slack's Agents & AI Apps surface for the app when the workspace allows it. This makes Slack eligible to render Assistant status, working indicators, and message streams. Slack-owned visual chrome such as the purple app-name flash is not directly configurable by this codebase; verify the actual rendering in the Slack client after the app is configured.

Install the app to the workspace, then copy:

- Signing Secret
- Bot User OAuth Token

## 2. Run the local server

```bash
export SLACK_SIGNING_SECRET="..."
export SLACK_BOT_TOKEN="<bot-token>"
export SLACK_FLUE_PROVIDER="workers-ai"
export SLACK_FLUE_WORKERS_AI_MODE="live"
export CLOUDFLARE_ACCOUNT_ID="..."
export CLOUDFLARE_API_TOKEN="..."
export CLOUDFLARE_WORKERS_AI_MODEL="@cf/zai-org/glm-5.2"
export PORT=8789
npm run dev:slack
```

For local UI capture only, set `SLACK_FLUE_PRESENTATION_DELAY_MS=1000` to hold each transient status long enough to observe it. Leave it unset for normal use; live Workers AI mode ignores the delay so Slack event handling is not intentionally slowed.

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
- `assistant_thread_started`
- `assistant_thread_context_changed`

## 4. Try it in Slack

Invite the bot to a channel, then mention it:

```text
@Slack Flue please use channel context and draft an exec summary
```

Expected behavior:

- immediate Assistant status such as `Slack Flue Demo is checking context` where Slack renders Assistant status for the surface;
- transient safe loading/status text during approved tool work, such as channel-context gathering;
- no permanent progress lines such as `Gathering channel context` should remain in the thread after the final answer;
- streamed final reply from `Exec Research` when Slack accepts the streaming APIs;
- fallback final threaded reply when status or streaming is unavailable;
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
- Redact Signing Secret, Bot User OAuth Token, app-level tokens, and request headers before capturing screenshots or logs.
- Pause for confirmation before enabling Agents & AI Apps, adding OAuth scopes, changing event subscriptions, or reinstalling the Slack app.
- Keep `.env` and `.dev.vars` uncommitted.
- Keep `SLACK_FLUE_WORKERS_AI_MODE=deterministic` for offline fixture work.
- Use `SLACK_FLUE_WORKERS_AI_MODE=live` only when the ignored local env file has `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.
