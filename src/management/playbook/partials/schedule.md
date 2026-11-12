### Save the schedule

Save it only after the person says yes. Call `save_schedule` with:

- `agentId`: the Agent that does the work.
- `channelId`: the Channel it posts in, from `list_slack_channels`.
- `name`: a short title, such as "Monday invoice chase". `description`: one sentence on what it's for.
- `task`: what the Agent does each time, written as a request to it, such as "List invoices more than 30 days overdue in Stripe and post a summary with links."
- `when`: exactly one of `{ "cron": "0 9 * * 1" }` for a repeating time (minute, hour, day of month, month, day of week), `{ "once": "2026-11-20T09:00" }` for one local time, or `{ "inMinutes": 30 }` for a delay.
- `timezone`: an IANA name such as `America/Los_Angeles`. Ask for it if you don't know it, and never guess from the server.
- `post`: `always` to post every time, or `when_changed` to post only when the result changed.
- `requiredConnections`: the `connectionId` of each connection in `get_agent` that the task uses, or `[]` for none.

To change a schedule, send its `scheduleId` and `version` from `list_schedules` with the full new settings. `{ "keep": true }` as `when` keeps its timing. Send `requiredConnections` again when the task changes. For a direct-message schedule (`where.kind` `dm`), leave `channelId` out.

- **Pause or turn off:** `pause_schedule` with `scheduleId` and `version`. Add `turnOff` `true` to turn it off. `resume_schedule` starts it again.
- **Run it now:** `run_schedule_now` with `scheduleId` posts right away and can't be taken back, so ask first.
- **Delete:** `delete_schedule` with `scheduleId` and `version`. Chickpea asks first (below).
