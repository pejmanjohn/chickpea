# Connect a service to an Agent

An Agent can only answer from the tools it's connected to. Connecting happens on Chickpea's own setup page: you get the link, the person signs in there, and you check that it works.

<!-- include: rules -->

## 1. Pick the Agent and the service

Call `list_agents` and match the Agent the person means. If they haven't said which, and there is more than one, ask. Call `get_agent` to see its current `connections` and their `status`: the service may already be connected, or need attention.

- Already `ready`: say so, and offer to check it with `check_agent`.
- `needs_attention`: it has to be signed in again. `reconnect_service` (below) makes the link.
- Not connected: continue.

Say in one line what the connection will let the Agent do, such as "read orders in Shopify". Ask for the narrowest access that does the job, and read-only when the job only reads.

<!-- include: connect -->

### Mark the tools that only read

A practice run calls only the tools of an MCP connection that are marked as reads. `get_agent` lists each connection's `allowedTools` with their `readTools` and `writeTools`. Ask the person which tools only look things up and change or send nothing, and never decide that from a tool's name. Then call `update_connection` with `agentId`, the `connectionId`, the `version` from `get_agent`, and `changes` holding only `readTools`. Mark only what the Agent's test questions need: some tools that only read still cost more to run, such as a research tool that makes many searches.

<!-- include: confirm -->
