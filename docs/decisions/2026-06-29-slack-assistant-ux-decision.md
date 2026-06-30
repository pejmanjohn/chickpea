# Slack Assistant UX Decision

Date: 2026-06-29

Status: continue; live Slack Assistant UX canary passed with channel-thread caveats

## Decision

Continue with the richer Slack Assistant UX implementation.
The Paperplane Labs Slack app is now configured for Slack's Agents & AI Apps surface, the local tunnel canary delivered transient status/loading text plus a final answer in Slack, and the code path remains app-owned.

The code path now preserves the app-owned Slack architecture while adding Slack-native presentation behavior:

- `app_mention` remains the only execution trigger for this slice;
- Slack Assistant container events are acknowledged without starting model work;
- the runner emits trusted lifecycle stages instead of model-authored progress;
- Assistant status is attempted before tool or provider latency dominates the turn;
- safe Assistant loading messages are emitted from fixed allowlisted labels;
- final delivery prefers Slack streaming and falls back to `chat.postMessage`;
- duplicate Slack retries remain side-effect-free;
- provider failures produce a sanitized final message and clear the visible working state;
- telemetry records the first visible response kind, delivery mode, and degradation markers.

Slack-owned visual chrome remains a verified outcome rather than a programmable contract. The app can enable Agents & AI Apps and send status/loading-message plus final stream calls, but Slack decides whether the purple app-name flash and loading treatment render in a given client surface.
In the corrected June 29 web-channel canary, Slack rendered transient status/loading text during work and only one durable final bot reply after completion.
No separate purple app-name flash was observed in the completed web-channel state.

## Evidence

Code and tests added or updated:

- `src/slack/replies.ts` adds the presentation contract, fixed safe stage labels, and local presentation event capture.
- `src/slack/web-api-replies.ts` calls `assistant.threads.setStatus` with fixed `loading_messages`, `chat.startStream`, `chat.stopStream`, and fallback `chat.postMessage` through injected `fetch`.
- `src/runtime/slack-thread-runner.ts` drives status/loading, provider, final delivery, and cleanup lifecycle ordering.
- `src/slack/events-app.ts` acknowledges `assistant_thread_started` and `assistant_thread_context_changed` without model/provider side effects.
- `tests/slack-presentation.test.ts`, `tests/slack-events-route.test.ts`, and `tests/slack-thread-runner.test.ts` cover fake Slack API sequencing, recipient ids, fixed `loading_messages`, no stream `chunks` for progress, streaming fallback, duplicate retries, provider errors, and sanitization.
- `fixtures/slack/assistant-thread-started.json` covers the Slack Assistant event surface without secrets.
- `docs/play-slack.md` now documents Agents & AI Apps, `assistant:write`, Assistant events, fallback behavior, and action-time confirmation requirements.

Commands run:

```bash
npm test
npm run flue:build
rg token-shape and known-prefix redaction patterns across changed source, docs, tests, fixtures, and screenshot evidence
curl -fsS https://fur-manuals-framed-meditation.trycloudflare.com/health
curl -fsS https://which-pure-gets-studied.trycloudflare.com/health
```

Results observed:

- `npm test`: passed with typecheck and 23 tests.
- `npm run flue:build`: passed and produced `dist/slack_flue/index.js` plus `dist/slack_flue/wrangler.json`.
- Redaction scan across changed source, docs, tests, and Slack fixtures found no Slack-token-shaped strings or bearer-token literals.
- Local Slack server: started from this worktree on port `8790` with deterministic provider mode.
- First Cloudflare quick tunnel: `https://fur-manuals-framed-meditation.trycloudflare.com`; `/health` succeeded.
- First live Slack canary: `#all-paperplane-labs`, June 29, 2026 at 5:29 PM PDT, message `@Slack Flue Demo please use channel context and draft a short exec summary for a Slack Assistant UX canary.`
- First browser evidence: `docs/slack-assistant-ux-canary-2026-06-29.png` shows the earlier incorrect durable progress-line behavior: `Gathering channel context`, `Channel context gathered`, and `Composing answer` remained as message text.
- Corrected Cloudflare quick tunnel: `https://which-pure-gets-studied.trycloudflare.com`; `/health` succeeded.
- Corrected live Slack canary: `#all-paperplane-labs`, June 29, 2026 at 9:21 PM PDT, message `@Slack Flue Demo ephemeral status canary: please use channel context and draft one short sentence. Progress should be transient status, not permanent reply text.`
- The user observed the transient status/loading text in Slack during the corrected canary.
- Corrected browser evidence: `docs/slack-assistant-ux-ephemeral-canary-2026-06-29.png` shows the completed thread with one durable Slack Flue Demo reply and no permanent progress lines.
- The corrected canary used deterministic local mode with `SLACK_FLUE_PRESENTATION_DELAY_MS=450` against the tunnel endpoint so it proved Slack UI/API integration without spending live provider quota.

## Computer Use Inspection

Computer Use inspected the Slack app settings for `Slack Flue Demo` in Paperplane Labs.

Final app state observed:

- App ID: `A0BDK8PLQ1M`.
- Workspace: Paperplane Labs.
- Agents & AI Apps `Agent or Assistant`: on.
- Slack MCP Server: off.
- Bot scopes: `app_mentions:read`, `chat:write`, `assistant:write`.
- Event Subscriptions: on.
- Request URL: `https://which-pure-gets-studied.trycloudflare.com/slack/events`, verified by Slack for the corrected canary.
- Bot event subscriptions: `app_mention`, `assistant_thread_started`, `assistant_thread_context_changed`.
- Slack reinstallation to Paperplane Labs completed after the new scope was added.

The user approved the persistent Slack app changes before they were applied.
No Slack MCP Server setting was enabled.
No Slack token, signing secret, bearer token, or provider key was copied into this doc.

## Live Verification

Completed Slack app changes:

- Enabled Agents & AI Apps `Agent or Assistant`.
- Added bot scope `assistant:write`.
- Updated Events Request URL to the current tunnel endpoint.
- Added bot events `assistant_thread_started` and `assistant_thread_context_changed`.
- Reinstalled the app to Paperplane Labs for the new scope.

Canary result:

- Slack UI showed transient status/loading behavior during the corrected canary.
- Slack UI showed final answer delivery as the only durable bot reply in the completed thread.
- Slack Web channel thread did not show a distinct purple app-name flash during the observed completed state.
- Screenshot evidence captures the completed no-progress-lines state; the transient status was observed live by the user rather than durable in the completed screenshot.
- Screenshot evidence was captured from the Slack Chrome window and contains no Slack token, signing secret, bearer token, or provider key.

## Caveats

- The current quick tunnel is ephemeral and not suitable for production.
- Local canary mode is deterministic unless `SLACK_FLUE_WORKERS_AI_MODE=live` is explicitly set with ignored Cloudflare credentials.
- The plan intentionally does not enable Slack MCP Server.
- Slack may render Assistant status and purple app-name chrome differently between channel mentions, Assistant app threads, desktop, and web clients.
- The web-channel canary proves transient status/loading behavior and final delivery. It does not prove that Slack's purple app-name flash is configurable or consistently rendered in all Slack clients.
