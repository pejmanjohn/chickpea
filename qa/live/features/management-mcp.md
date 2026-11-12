# Management MCP door

Docs: `/admin/management-mcp/`, `/reference/management-mcp-tools/`. Record areas: `agents`, `admin` (add `connections` or `providers` for setup handoffs). Legacy contracts: none.

## What it covers

- An OAuth-protected `/mcp` endpoint a coding agent uses as the signed-in member. Sign-in is Slack OIDC, then an "Allow workspace management?" consent for the single scope `chickpea:workspace`. No token is ever pasted.
- Reads: `get_workspace`, `list_agents`, `get_agent` and the other `get_` and `list_` tools, plus `explain_agent` and `check_agent`. `get_guide` serves the playbook a client follows.
- The client acts with the signed-in person's Admin authority, and there are no propose tools. One tool makes one change: `create_agent` creates an Agent immediately, and every other change the person may make applies in its own call: archive, restore, Channel grants, connections, edit policy.
- Like the Admin UI, a destructive change asks first: `delete_agent`, `delete_schedule`, suspending or removing a member or changing an Owner, `remove_model_provider_key`, removing an Agent's MCP server or API connection, and turning off an Agent with Channel grants. It returns `needs_confirmation` with `confirmation.preview` and a `confirmToken`, which expires after 30 minutes. The preview states each change in names a person knows, such as "Delete **Research** (@research) permanently. This cannot be undone.", and never shows IDs, Slack presence, avatar seeds or a "(not set)" diff.
- An error carries `structuredContent.error`: a stable `code`, a `message`, and a `nextStep` for the model, such as why a delete was refused.
- `confirm_change` applies that change exactly as previewed, only for the same requester from the same client. A changed revision, digest, permission or origin makes it stale or denied. `decline_change` drops it.
- A one-change call can be reversed with `undo_change` and its `undoToken`, which asks first only when the inverse is destructive. Changes take effect on the next admitted Slack event.
- Setup handoffs: `connect_service` and `reconnect_service` return the focused setup page for one connection (`/setup/<id>`), locked to one Agent. Over MCP only the person who asked can open it, for 24 hours. A connector that page cannot serve gets the Agent's Admin page instead. `connect_model_provider` (Owner or Admin) returns a 24-hour link bound to the requester; `cancel_setup_link` cancels one, and `get_setup_status` reads one.
- Change results carry `agent.links.admin` and `agent.links.slack`; the client reports the outcome itself. Admin-only settings (GitHub, coding sandbox, browser, connectors, avatars) have no tool; `get_workspace`'s Admin-only list points to their Admin pages. A hosted deployment's `get_workspace` Admin-only list and `/connect.md` leave out the coding sandbox and browser, which its Admin does not show.
- Since contract 5.0.0 the server has no MCP prompts, and every client lists the same 5.0 tools. A call of a removed 4.x tool gets a `tool_removed` error result naming its replacement in `replacedBy`; a removed prompt or resource gets a protocol error saying what replaced it.
- `/connect` and `/connect.md` are public and answer before setup; `/mcp` answers 404 until Slack is connected.

## How a person reaches it

- MCP: a coding agent pointed at `/connect.md`, or any client given the `/mcp` address.
- Admin: Settings → MCP (the Coding agents page) with per-client snippets. Every signed-in person, including a Member, can open it.
- Slack: the same management service behind `@Chickpea`. A receipt for an MCP-origin setup is also sent to the requester in Slack.

## How to drive it on a lane

- Sign a client in with `npx chickpea-cli login <lane origin>`. It prints the authorize URL; open it in the lane browser, signed in to the lane's Slack, and click Allow yourself, since consent is a declared QA action.
- Drive tools with `chickpea-cli workspace inspect` and `chickpea-cli call <tool>`, which takes any tool the server lists. For read-only acceptance, `npm run verify:management-mcp` takes its bearer token only from the environment and never prints it.
- Case shape: `case-add --area agents --proof mcp --proof admin`. Add `--proof slack` once the created Agent is published and mentioned.
- Requests: create one run-marked Agent with a caller-chosen `agentId`; edit its instructions and grant it a channel, each in one call; archive and restore it in one call each; archive it again, then delete it and read the confirmation preview before confirming; `connect_service` for a catalog connector.
- Denial variants: `confirm_change` after an edit moved the revision returns stale; `connect_model_provider` for an environment-managed provider is refused; Member-role checks need a registered Member actor, which lanes may lack.
- Removal answers: `chickpea-cli call <lane origin> inspect_workspace` prints `{ ok: false, error: { code: 'tool_removed', … } }` and exits 1. A raw `prompts/list` answers an empty list with HTTP 200 on every protocol revision.
- Cleanup: archive created Agents (`--cleanup-preset archived-agent`), revoke unused setup links, and run `chickpea-cli logout <lane origin>` to revoke the client's refresh token. Its last access token keeps working against `/mcp` for up to 15 minutes, so a revocation readback waits for that token's expiry before expecting a 401.

## Proof and gotchas

- MCP proof is the tool result plus a read of what changed, such as `get_agent`. Admin proof is the Agent page from `links.admin`. Slack proof is a real `@handle` mention answered by the new Agent.
- A created Agent gets no Slack welcome. On a Slack plan with user groups its handle is published at once, so `delete_agent` returns `still_in_use` ("Archive <name> first") until it is archived. The delete receipt carries no `links.admin`. `links.slack` opens the Chickpea app, not the Agent.
- `create_agent` takes an optional `agentId` (lowercase letters, digits, `_`, `-`) and derives one from the name without it. It may return a handle warning in `warnings` (free Slack plan or locked policy) while the Agent is still saved.
- `import_skill_from_github` over MCP installs immediately: the authenticated call is the person's command.
- `upload_skill_files` installs immediately too and keeps every other skill. A model that copies text sends one or a few files per call; `chickpea-cli skills upload` sends a whole archive from disk.
- The CLI also opens a default-browser tab. The loopback listener closes after the first callback, so a second Allow shows connection refused there. Check the CLI's own result before retrying.
- 401 with a protected-resource challenge means a missing or bad token. 403 means live membership, role or scope now refuses the request.
- A setup link from a Slack-route `request_setup` can be completed by anyone who holds it. Never paste setup links into records, reports or transcripts.
- Diagnose with the content-free `[chickpea:management]` log lines from `npm run lane:tail`.
