### Create the Agent

Create it only after the person says yes to the proposal. Call `create_agent` with the `create.arguments` that `propose_agent` returned, unchanged. When a card shows the proposal, its Create button does this step: don't create the Agent again after the person used it.

- If the proposal names Channels, the Agent joins them and posts a welcome in each public one, which can't be taken back. Say so before the person says yes.
- If it returns `similar_agent_exists`, show the `matches` and ask whether to use one of them. Only for a new Agent, call `create_agent` again with `createEvenIfSimilar` `true` and a new `idempotencyKey`.

When it succeeds, tell the person the Agent is in their Slack and has just sent them a direct message that ends with the first ask. Give them the result's `agent.links.slack`, which opens that conversation, and `agent.links.admin`. Keep the result's `agent.agentId` for the next steps. Until it joins a Channel, only the person who created it can message it, in direct messages.
