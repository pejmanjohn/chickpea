# Get started with Chickpea

Help the person get one Chickpea Agent working in their Slack: a teammate with its own name and @handle that anyone in the workspace can message, which keeps working after this chat ends. Aim for one good proposal quickly, not a menu.

<!-- include: rules -->

## 1. See what they already have

Call `get_workspace` for the workspace name and the person's role, and `list_agents` for the Agents that already exist. Use the workspace name when you mention it, and don't guess one if it's missing. If `list_agents` says `canCreate` is false, tell the person that an Owner or Admin has to add Agents and stop.

## 2. Find the chore

- **The chore is already stated** in this conversation (for example "sales keeps asking me whether orders shipped"): go straight to step 3. Don't ask anything first. If an existing Agent already does that job or nearly does, propose improving that Agent instead (`get_guide` topic `edit`).
- **The workspace already has Agents** and no chore is stated: offer to improve one of them first. Ask one question that names them, such as: "You already have @ops and @billing in Slack. Want to improve one of them, or set up a new teammate for something people keep asking you or that you do every week?"
- **Otherwise**, ask exactly one question: "What do people keep asking you for, or what do you do every week?"

Ask nothing else before the proposal unless the answer would change what you build.

**What you build from.** Build the proposal from what the person says in this conversation, and from what you already know about their work, so it fits them. Say in a short phrase what you based it on ("from what you said about your invoices") so they can correct you. Ask them for nothing but the chore. Chickpea's tools receive only the Agent setup the person approves.

If you are a coding agent on the person's computer and they would rather you look at their projects than answer, research first (`get_guide` topic `research`).

## 3. Propose one teammate

Draft one Agent for the chore with the fields `propose_agent` takes. Every Agent can already search the web and read public pages, so connect a service only for data behind a sign-in or an API. Match `services` against `list_services`; leave a service out when nothing fits and say it would need a custom connection. Name `channels` only when the person named one.

- `instructions`: about 200 to 400 words on who it serves, what it answers or does, which tools it uses, what it does when it doesn't know, and what it must never do.
- `sampleAsk`: a message the person would really send it in Slack, in their words. `promisedAnswer`: your draft of its answer. Label it an example, and never invent order numbers, names or figures in it.

Call `propose_agent` with that draft. It saves nothing. Then:

- **If your client shows Chickpea cards** and a card shows the proposal: say one short sentence, such as what you based it on, and stop. The card shows the name, the job, the example and where it answers, and its Create button creates it. Don't list them, and don't say whether the Agent exists yet.
- **No card shows,** as in a terminal: show the person
  - the name, @handle, and whether the handle is free;
  - the job in one line;
  - the sample exchange, labelled as an example;
  - what to connect after it's created, and what the person will have to do for each (sign in on a Chickpea page);
  - the Channels it would answer in, if any;
  - anything in `issues` to settle first.

  Offer at most two alternates, one line each. End by asking whether to create it. Make clear it will appear in their Slack workspace for everyone there, and that it posts a welcome in each public Channel it joins.

If the person changes something, call `propose_agent` again with the new draft before you create anything.

<!-- include: create -->

## 4. After it's created

1. For each service in the proposal, call `connect_service` with the new `agentId`, the service's `service` from `list_services`, and `owner` `team` (or `me` if it should act as the person). Give the person each `setup.url`: they sign in on Chickpea's page and finish there. When they're done, check it with `get_setup_status` or `check_agent` (`get_guide` topic `connect`).
2. Scope the new Agent with the person (`get_guide` topic `scope`): draft its brief and test questions from this conversation, then test drive it on them. The person can answer its questions while a sign-in is still open.
3. If the chore happens on a schedule ("every Monday"), offer to set that up next (`get_guide` topic `schedule`).
4. Close with one line: what to send the Agent in Slack first.
