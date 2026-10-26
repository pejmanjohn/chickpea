# Management MCP door

Docs: `/admin/management-mcp/`, `/reference/management-mcp-tools/`. Record areas: `agents`, `admin` (add `connections` or `providers` for setup handoffs). Legacy contracts: none.

## What it covers

- An OAuth-protected `/mcp` endpoint a coding agent uses as the signed-in member. Sign-in is Slack OIDC, then an "Allow workspace management?" consent for the single scope `chickpea:workspace`. No token is ever pasted.
- Read tools: `inspect_workspace`, `discover_slack_channels`, `inspect_memory`, `inspect_routines`, `test_mcp_connection`, `export_workspace_recipe`, `preview_workspace_recipe` and `get_operation`.
- Contract 3.0.0: the client acts with the signed-in person's Admin authority, and there are no propose tools. One `create_agent` alone in `apply_workspace_changes` creates a base Agent immediately, and every other change the person may make applies in the call: archive, restore, Channel grants, connections, edit policy, compound edits.
- Like the Admin UI, a destructive change asks first: `delete_agent`, `delete_routine`, suspending or removing a member or changing an Owner, `remove_provider_credential`, removing an Agent's MCP server or API connection, and disabling an Agent with Channel grants. It returns `confirmation_required` with `presentation.markdown`. The preview states each change in names a person knows, such as "Delete **Research** (@research) permanently. This cannot be undone.", and never shows IDs, Slack presence, avatar seeds or a "(not set)" diff.
- A `failed` or `skipped` outcome carries `instruction`, a short explanation for the model, such as why a delete was refused.
- `confirm_workspace_change` applies that change exactly as previewed, only for the same requester from the same client. A changed revision, digest, permission or origin makes it stale or denied.
- Single-operation changes can be reversed with `undo_workspace_change`, which asks first only when the inverse is destructive. Changes take effect on the next admitted Slack event.
- Setup handoffs: `prepare_connector_setup` returns an Admin URL locked to one Agent. `prepare_provider_setup` (Owner or Admin) returns a 24-hour link bound to the requester; `revoke_setup_link` cancels or reissues one.
- Apply and confirm receipts carry `links.admin` and `links.slack`, not `presentation.markdown`; the coding agent reports the outcome itself. Skill receipts and confirmation previews carry `presentation.markdown`. Admin-only settings (GitHub, coding sandbox, browser, connectors, avatars) have no tool; the server's instructions point to their Admin pages. A hosted deployment's instructions, `status` prompt and `/connect.md` leave out the coding sandbox and browser, which its Admin does not show.
- Six MCP prompts (`new-agent`, `edit-agent`, `connect`, `schedule`, `import-skill`, `status`) that clients may show as slash commands.
- `/connect` and `/connect.md` are public and answer before setup; `/mcp` answers 404 until Slack is connected.

## How a person reaches it

- MCP: a coding agent pointed at `/connect.md`, or any client given the `/mcp` address.
- Admin: Settings → MCP (the Coding agents page) with per-client snippets. Every signed-in person, including a Member, can open it.
- Slack: the same management service behind `@Chickpea`. A receipt for an MCP-origin setup is also sent to the requester in Slack.

## How to drive it on a lane

- Sign a client in with `npx chickpea-cli login <lane origin>`. It prints the authorize URL; open it in the lane browser, signed in to the lane's Slack, and click Allow yourself, since consent is a declared QA action.
- Drive tools with `chickpea-cli workspace inspect` and `chickpea-cli call <tool>`. For read-only acceptance, `npm run verify:management-mcp` takes its bearer token only from the environment and never prints it.
- Case shape: `case-add --area agents --proof mcp --proof admin`. Add `--proof slack` once the created Agent is published and mentioned.
- Requests: create one run-marked Agent with a caller-chosen `agent.id`; edit its instructions and grant it a channel, each in one call; archive and restore it in one call each; archive it again, then delete it and read the confirmation preview before confirming; `prepare_connector_setup` for a catalog connector.
- Denial variants: `confirm_workspace_change` after an edit moved the revision returns stale; `prepare_provider_setup` for an environment-managed provider returns `invalid_request`; Member-role checks need a registered Member actor, which lanes may lack.
- Cleanup: archive created Agents (`--cleanup-preset archived-agent`), revoke unused setup links, and run `chickpea-cli logout <lane origin>` to revoke the client's refresh token. Its last access token keeps working against `/mcp` for up to 15 minutes, so a revocation readback waits for that token's expiry before expecting a 401.

## Proof and gotchas

- MCP proof is the tool result envelope plus `get_operation` for its operation ID. Admin proof is the Agent page from `links.admin`. Slack proof is a real `@handle` mention answered by the new Agent.
- A created Agent gets no Slack welcome. On a Slack plan with user groups its handle is published at once, so `delete_agent` returns `invalid_request` ("Archive <name> first") until it is archived. The delete receipt carries no `links.admin`. `links.slack` opens the Chickpea app, not the Agent.
- `create_agent` needs a caller-chosen `agent.id` (lowercase letters, digits, `_`, `-`). It may return a handle `warning` (free Slack plan or locked policy) while the Agent is still saved.
- `import_skill` over MCP installs immediately: the authenticated call is the person's command.
- The CLI also opens a default-browser tab. The loopback listener closes after the first callback, so a second Allow shows connection refused there. Check the CLI's own result before retrying.
- 401 with a protected-resource challenge means a missing or bad token. 403 means live membership, role or scope now refuses the request.
- A setup link from a Slack-route `request_setup` can be completed by anyone who holds it. Never paste setup links into records, reports or transcripts.
- Diagnose with the content-free `[chickpea:management]` log lines from `npm run lane:tail`.
