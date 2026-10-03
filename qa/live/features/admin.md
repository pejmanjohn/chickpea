# Admin: sign-in, team, usage, settings

Docs: `/admin/`, `/admin/tour/`, `/admin/sign-in-and-roles/`, `/admin/usage/`. Record areas: `admin`, `usage`. Legacy contracts: none.

## What it covers

- Sign in with Slack is the only sign-in. A Slack account without an active membership, a guest or a Slack Connect user sees "That Slack account cannot access Chickpea", and nothing is created.
- Membership is automatic: the installer is the first Owner, and a full Slack member joins as Member the first time they talk to an Agent. There is no invite flow.
- A Member sees only Agents; Admins and Owners also see Destinations, Team, Usage and Settings. Team is read-only for Admins, and only an Owner sees the role selector and the suspend, restore and remove menu, never on their own row.
- Suspend is reversible: it ends the person's sessions and tokens at once, blocks their Agent use and personal connections, and pauses schedules running as them. Remove is permanent. The last active Owner cannot be demoted, suspended or removed.
- An Agent profile has a header with inline rename and a status chip, the Destinations card, eight tabs with counts and an unsaved-changes dot, Advanced (who can edit), and a sticky save bar. On an Agent you cannot edit, every field is disabled.
- The overflow menu holds Duplicate Agent, Archive or Restore, and the legacy default selector.
- Destinations covers Slack: Overview, Connection (Test connection, Reconnect with Slack, Disconnect) and Channels.
- Usage has period and breakdown selectors, four cards compared with the previous period, spend by breakdown, recent activity, a coverage line and the spending-limits sentence. A model outside the pinned catalog records tokens with no price (`price_unknown`), and a stale catalog entry (`price_stale`) makes Admin say estimates need a pricing update.
- Settings has Connectors, Model providers, GitHub, Coding sandbox, Browser and Outbound access. Audit logs has no nav button and is reached by its path.
- Form behaviour: typing keeps focus and caret through background refreshes, native dropdowns stay open through background renders, a deep link loads its tab data even when the page opened hidden, and a conflicting Memory save keeps the draft.

## How a person reaches it

- Admin: `/admin` on the deployment, after Sign in with Slack.
- Slack and MCP reach the same management service with the same permissions. A Member is refused configuration with `operational_access_required`, and a non-Owner's membership change with `owner_required`.

## How to drive it on a lane

- The lane browser profile is already signed in to the lane Admin; `npm run verify:live:kickoff` reports it. A second actor's one-time sign-in is a human step, because Slack's email code is never relayed.
- Role checks need a distinct registered actor with that role. An Owner acting as a Member proves no denial, and `missing_actor` in the capability matrix limits Member checks.
- Case shape: `case-add --area admin --proof admin`, adding `--area usage` for Usage and `--proof mcp` for refusals, with `--max-wait-ms 120000`.
- For Usage, produce one run-marked reply from a disposable Agent, then find it in Recent activity and in the channel and Agent breakdowns.
- To reproduce a hidden-page load, open the page with an init script that reports `visibilityState` as hidden, because lane browsers load pages visible.
- For a native dropdown, bring the Admin tab to the front, check `:open` on the active element, and close it by clicking the page. Screenshots do not show the popup.
- Changing a registered actor's role or access is not among the declared QA actions unless the run declares it as a capability; otherwise record the variant `blocked`. When declared, register the actor with `--ownership restore` and its exact before-state, and restore it at cleanup. Never Remove a registered actor, and never act on your own row.

## Proof and gotchas

- Hidden is not denied. Pair a missing section with a refused call through MCP or Slack for the same actor.
- Usage once split one channel across two rows and showed internal IDs instead of names. Check for one row per channel and readable Agent and schedule names.
- Usage leaves out routing classification calls and DM-delivered schedules, so a missing row for those is correct.
- Do not reload right after Save, which aborts the request.
- Disconnect and schedule Delete use native confirm dialogs; answer them with the lane browser's dialog tool. The extension fallback cannot press them, and its tabs report hidden, so override visibility and use form input there.
- A row that changes size a second after load is a re-render, not a late font. The Connections tab must show a loading hint and then account rows, never the old gallery.
- An already-open second Admin tab should show Schedules and Memory changes without a reload.
- A deployment with `USAGE_ADMIN_UI` turned off has no Usage section; check that before calling it missing.
- Personal tokens have no Admin screen, so there is nothing to find there.
- A hosted deployment shows a Slack permissions bar at the top of the main column when its grant lacks a requested scope (Owners get "Update in Slack", Admins a line asking for an Owner). Standalone lanes never show it; check its absence there and leave the hosted bar to the hosted profile.
- `/admin?slack=updated`, where the hosted update returns, shows "Slack permissions updated." once. Admin reads the parameter before the canonical rewrite to `/admin/agents/<id>` drops the query, so test it on `/admin` itself.
- A hosted deployment (installation tenancy) has no About & updates, Browser or Coding sandbox section, no Coding sandbox row in an Agent's Advanced settings, and no preparation or setup refresh in Connectors. That is by design, not missing; standalone lanes show them all.
- Violet runs the sandbox profile with a stored Composio key, so its sandbox install section and Prepare connector defaults never render there; the both-mode render tests cover them.
- On a lane that keeps every model provider key environment-managed and Composio configured with a stored key (Violet), the provider key removal confirm, its key hint and the Connectors "add a project key" summary never render. The GitHub Disconnect confirm is the reachable standalone self-hosting sentence there.
