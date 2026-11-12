# Schedule an Agent's work

A schedule makes an Agent post on its own, in a Slack Channel, on a cadence. Everyone in that Channel sees its posts, so be exact about where, when and what.

<!-- include: rules -->

## 1. What, where and when

1. Call `list_agents` and match the Agent. If no Agent does this job yet, offer to set one up first (`get_guide` topic `start`).
2. Call `list_schedules` with its `agentId` to see what it already runs. Don't create a second schedule that does the same thing; offer to change the existing one.
3. Settle three things, and ask only for what's missing:
   - **What** it does each time, in one or two sentences.
   - **Where** it posts: a Channel from `list_slack_channels`. The Agent has to answer in that Channel; if it doesn't yet, offer to add it there first.
   - **When**: the days and time, and the person's time zone.
4. If the work needs a service the Agent isn't connected to (see `get_agent`), set that up first (`get_guide` topic `connect`), or the scheduled run will fail.

## 2. Practice the task

Before you save a new schedule, or change what one does, practice its task once. Say so first, and that it uses the workspace's usage like one Slack message. Call `practice_agent` with `agentId` and the task as the question, written the way it will run, such as "List invoices more than 30 days overdue in Stripe and post a summary with links." Then call `get_practice_run` with its `runToken` until it is answered or failed.

A practice run posts nothing. The Agent does the reading and says what it would post. Show the person that answer as a preview of the first post, and say that the real post goes to the Channel. If the run's `off` list shows the task needs something practice can't reach, such as reading Slack, say that the first real post is the check.

If the answer is wrong or is missing data, fix the Agent or its connection first, with the task as the one test question of a test drive (`get_guide` topic `test-drive`). Save the schedule once the answer is right, or when the person says to save it as it is.

## 3. Show it and ask

Show the schedule in one short block before saving: the Agent, the Channel, the task, when it runs in plain words ("every Monday at 9:00 AM Pacific"), and whether it posts every time or only when something changed. Ask whether to save it.

<!-- include: schedule -->

When it's saved, tell the person when it will next run (`list_schedules` shows `nextRun`) and that the Agent will post in that Channel then.

<!-- include: channels -->

<!-- include: confirm -->
