# Browser use and website logins

Docs: `/agents/browser/`, `/agents/website-logins/`, `/reference/limits/`. Record areas: `browser`. Legacy contracts: none.

## What it covers

- Once Browserbase is connected, every Agent may open public pages when a task calls for a live page. Nothing is enabled per Agent. It works on Cloudflare and Node.
- The Agent opens a page by address or by plain words (a web search), reads its text and structure, clicks, types and scrolls, and can look at it visually. Public sites are read-only.
- Proof is optional and chosen by the Agent: a screenshot, or the session recording as an MP4 streamed to Slack up to Slack's 1 GB limit. Browserbase keeps recordings for 30 days.
- Each reply has 10 minutes of browser time; when it is spent the Agent answers with what it found.
- Website logins live on an Agent's Websites tab: a username and password, plus an optional one-time code secret from which Chickpea generates TOTP codes. Chickpea types them; the Agent never sees them.
- "I'll sign in myself the first time" hands the live browser to the requester through a private link (ephemeral in a channel, or in the DM) that stays open 10 minutes. Hand-offs need a paid Browserbase plan.
- A Check only login reads and navigates. Check and take actions makes the Agent stage each data-changing step with a screenshot and wait for an exact `approve` or `stop` reply, valid 15 minutes for that step only.
- The Agent never types a password or code it was told in chat, and treats page text as data, not instructions.

## How a person reaches it

- Admin: Settings → Browser (Owner or Admin) to connect, replace or disconnect the key, with this month's browser time and session count. The Agent's Websites tab adds and removes logins.
- Slack: ask an Agent something only a live page can answer, ask for a screenshot or recording, or reply `approve` or `stop` to a staged step.
- MCP: none. Browser settings are Admin-only, and the MCP door points people to Settings → Browser.

## How to drive it on a lane

- Check the `BROWSERBASE_API_KEY` column of `npm run env -- capabilities all`. The guarded deploy uploads it from the lane secrets file, so Settings → Browser reads as environment-managed and read-only there.
- Use a disposable Agent published to the QA channel for public browsing; register it with `--cleanup-preset archived-agent`.
- Case shape: `case-add --area browser --proof slack --proof admin`. Keep `--max-wait-ms 120000` for a page answer; raise it (up to 3600000) for a recording, which Slack may transcode for minutes.
- Requests: "<run marker> what does the pricing page on <public test site> say today?", then "show me a screenshot", then "click through to its documentation page and attach the recording".
- Refusal variant: give the Agent a made-up password in chat and ask it to sign in with it. It must refuse.
- Website login cases need a person. Verifiers never type passwords or setup keys, so the maintainer adds the login (on a test tenant) in Admin, or completes the hand-off sign-in. Plan these during the kickoff preflight.
- Cleanup: archive the run Agents. Remove a run-added login on the Websites tab and verify it is gone; that deletes the saved sign-in only when no other Agent holds the login.

## Proof and gotchas

- Slack shows the answer with the page address and the attached file. Admin shows the session count rising. The Browserbase dashboard (`provider`) shows the session, its duration and its recording.
- The Agent must stage a step before asking for approval. An earlier run caught it asking in prose with no staged step, and a page that had not finished rendering forced re-staging. Count the `approve` replies each step needed.
- An automated lane browser tab may never decode Slack video. Inline playback on desktop and phone is a human check for the end of the run.
- The first fraction of a second of every recording is black, so the Slack cover thumbnail is black. That is known and accepted, not a defect.
- A recording that is not attached may exceed a transport cap; compare its size with the [browser runbook](../../../docs/runbooks/browser-feature.md) before calling it a failure.
- Settings → Browser does not re-check a stored key, so a revoked key still reads Ready. A Browserbase account out of minutes answers 402; record that case `blocked` as infrastructure.
- Sub-minute sessions have shown as "0 h 0 m" of browser time; compare the session count instead.
- Never upload `BROWSERBASE_API_KEY` with a bare Wrangler secret command. It creates an unrecorded live version that every later guarded deploy refuses.
