# Roll out an Agent

Once an Agent does its job, help the person share it with their team: where it answers, who can change it, what each person has to do, and a short announcement the person posts themselves.

<!-- include: rules -->

## 1. Read the Agent

Call `list_agents` and match the Agent the person means. If `canEdit` is false for it, say who can change it (its creator or an Owner or Admin) and stop. Call `get_agent` for its `channels`, `connections`, `whoCanEdit` and `version`, and `check_agent` with its `agentId`. Fix what fails first: a team that meets a broken Agent stops asking it.

If none of the person's test questions has passed yet, offer a test drive first (`get_guide` topic `test-drive`). Roll out after it, or when the person says to go ahead.

## 2. Settle three things

Ask only for what's missing, and put your draft answer in each question.

- **Where it answers.** Everyone in the workspace can already message it directly. For a Channel, find the ones the team asks in with `list_slack_channels`. `channels` in `get_agent` shows where it answers now.
- **Who can change it.** `creator_and_admins` keeps changes to its creator and the Owners and Admins. `all_workspace_members` lets every member change its instructions and connections. Suggest keeping it narrow unless the person wants the team to tune it.
- **Who has to sign in.** A connection whose `owner` is `member` is personal: each person signs in with their own account, and the Agent uses it only for that person's requests. Name each such service: everyone who wants the Agent to use it for them signs in first. A `team` connection needs nothing from them.

## 3. Make the changes

Preview the changes in one short block: the Channels it will join and who can change it. Say that in each public Channel it joins, it posts a welcome everyone there sees, which can't be taken back. Make the changes only after the person says yes.

- **Each Channel:** `add_agent_to_channel` with `agentId` and `channelId`, one Channel at a time.
- **Who can change it:** `propose_agent_change` with `agentId`, the `version` from `get_agent`, and `change` holding only `whoCanEdit`, then `update_agent` with the `save.arguments` it returns, unchanged.

## 4. Draft the announcement

Write a short message for the person to post in Slack, in their voice:

- what the Agent does, in one sentence, with its @handle;
- where to ask it: a direct message, or the Channels it joined;
- three things to ask it, taken from the test questions that pass, in the words people would use;
- what it won't do, in one line;
- for each personal connection, that people sign in with their own account to use it;
- who to tell when an answer is wrong.

Show it in one block the person can copy. Never post it or send it to anyone: the person posts it where they choose.

## 5. Plan the check-in

Suggest a day about a week out to see how the team uses the Agent, and say what you'll look at then: its runs, what failed, and the questions people really asked (`get_guide` topic `check-in`). Close with the Agent's `links.slack` and `links.admin` from `get_agent`.

<!-- include: confirm -->
