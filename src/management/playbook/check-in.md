# Check on Agents

Give the person a short report on their Agents: what needs attention, how the team uses each one, and the one thing to do about each problem. Checking only reads. Fixes go through the other topics, after the person agrees.

<!-- include: rules -->

## 1. Health

**One Agent** ("check on Ops", "how is Ops doing", a health check of one): find its `agentId` with `list_agents`, then call `check_agent` with it. Don't stop at `list_agents` or `get_agent`: `check_agent` checks every part (connections, model, Slack presence, Channels, schedules, repositories, website logins) and returns each problem with a `fix`. It tests each custom connection once and changes nothing. If your client shows Chickpea cards and a card shows its result, say one short sentence and go on to use.

**All of them:**

1. `list_agents`: each Agent's `status` and its `needsAttention` reasons.
2. `list_schedules`: each schedule's `state`, `lastRun` and `why`.
3. For each Agent that needs attention, `check_agent` with its `agentId`.

## 2. Use

For the Agent the person asked about, or the ones they care about most, call `list_agent_runs` with its `agentId`. On the first page, `summary` covers the window, the last 7 days unless you pass `since` (at most 90 days back): how many runs, how many people asked, how many failed or stopped, and when it last ran. You see your own direct messages with the Agent and its runs in public Channels. Other people's direct messages, group DMs and private Channels are never shown. Someone who can change the Agent gets a count of them. Schedule runs aren't listed yet: `list_schedules` shows each schedule's `lastRun`.

- **No runs, or very few:** the team may not know it's there. Offer to roll it out (`get_guide` topic `roll-out`).
- **Failed or stopped runs, or an answer the person says was wrong:** call `get_agent_run` with its `runId` for the question and the Agent's reply.

## 3. Turn real asks into tests

A real ask the Agent got wrong makes the best test question. For each one:

1. Offer it as a new test question: the question as people really ask it, in your own words, and what a good answer does. Leave out names and private details, and never copy another person's message word for word.
2. Add it to the person's test questions for this Agent, in this conversation or in their file. If they have none, scope the Agent first (`get_guide` topic `scope`).
3. Offer to test drive the Agent on it (`get_guide` topic `test-drive`). If the Agent has changed since its test questions last passed, offer to practice them all again.

## 4. Report

Lead with what needs attention, one line each: the check's `name`, its `plain` words (or its `detail` when it has none), and its fix. A fix is either a link to give the person, or a tool and arguments. Never call a fix's tool until the person says yes. If it names a tool you don't have here, give the person the Agent's `links.admin` from `get_agent` instead. When the fix is `reconnect_service` or a setup link, see `get_guide` topic `connect`.

Then the use, in two or three lines: runs in the window, how many people asked, and what the failures had in common.

Then one line for everything that's fine, such as "4 other Agents and 3 schedules look healthy." Don't list healthy items one by one unless the person asks.

End with the fixes and new test questions you'd suggest, and let the person choose. Make no change until they say which.

**Why didn't it answer?** Call `check_agent` with the `place` where the person wrote: omit it for their direct messages, or pass the Channel's `channelId` from `get_agent`. The `admission` check says whether a message from them there reaches this Agent, and why not.

**Why does it act this way?** `explain_agent` shows the Agent as it will run in a place: its instructions and memory, which tools it gets from each connection and why any are missing, its model, and how much of its context is used before anyone speaks. Use it to find what to change, then change it (`get_guide` topic `edit`).
