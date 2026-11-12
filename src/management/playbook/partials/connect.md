### Connect a service

Connecting always goes through the setup link that `connect_service` or `reconnect_service` returns. It opens a page just for that connection. Don't send the person to Admin to connect a service, and never ask for a key here.

1. Find the service with `list_services`. If several match, ask which one. `get_service` says what it can do before it's connected: how it signs in, whose account it can be, and which of its actions only read.
2. Ask whether the connection is the team's (`owner` `team`: one sign-in for everyone who uses the Agent) or the person's own (`me`: the Agent acts as them). Default to `team` for a teammate that answers for everyone, and say so. Only an Owner or Admin can connect one for the team.
3. Call `connect_service` with `agentId`, `service` and `owner`. Give the person the `setup.url` it returns. They open it, sign in to Chickpea and to the service, and finish there. The link works only for them and expires. Nothing is connected until they finish.
4. When they say they're done, call `get_setup_status` with the `setup.setupToken`. If its connection's `status` is `ready`, call `check_agent` with the `agentId` and tell the person what its check of that connection found. If the link is still waiting, they haven't finished yet.

**Sign in again.** `connect_service` refuses a service the Agent already has. To sign it in again, replace its key, or change what it shares, call `reconnect_service` with `agentId` and the `connectionId` from `get_agent`. Hand over its `setup.url` and check afterwards the same way.

**A custom connection.** For a service that isn't in the catalog, or a part of one its catalog connection doesn't reach, show the person first: the host and path prefix, the methods, and the header the key goes in, in one short block. Say that the key is typed on Chickpea's setup page, not here. Only after they say yes, call `connect_service` with `agentId`, the `version` from `get_agent`, and `custom`:

- an API: `kind` `api`, `name`, `hosts`, `pathPrefixes`, `methods`, and `headerName` when the key doesn't go in Authorization. Add a `checkPath`: a read endpoint you plan to use, such as a list, never the bare prefix. The setup page checks the key against it.
- an MCP server: `kind` `mcp`, `name` and `url`.

It adds the connection to the Agent and returns the setup link.

**A model provider key.** Only an Owner or Admin can add one. Call `connect_model_provider` with `provider` (`anthropic`, `openai`, `openrouter` or `google`), and give the person its `setup.url` the same way.

**Remove a connection.** Call `remove_connection` with `agentId` and `connectionId`. Chickpea asks first (below), and schedules that use the connection pause.
