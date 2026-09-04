# Slack setup runbook

Use the private setup link printed by the deployment. Chickpea creates the customer-owned Slack app, installs it, verifies its Events URL, and uses Slack itself for the first Owner identity. There is no password, Cloudflare Access, shared Admin token, or manual bot-token paste in the normal journey.

## Before starting

- Know the Slack workspace where Chickpea should live. The installed `team_id` becomes the deployment's immutable workspace boundary.
- Be signed in to Slack as the person who should become Chickpea's first Owner.
- Slack decides whether that person may create/install apps. Chickpea does not require the installer to hold Slack's Owner or Admin label.
- Keep the private setup link in the same browser tab. The capability is removed from the URL and kept only in same-tab storage.

## Steps

1. Open the private `/admin/setup#setup=…` link.
2. Choose **Create the Slack app**. Chickpea uses the short-lived Slack configuration token supplied in the form to create exactly one app from the reviewed manifest. The token is not stored.
3. If Slack creation returns an ambiguous network result, inspect your Slack apps. Adopt the matching app or explicitly restart; do not create another app blindly.
4. Continue to Slack and choose the intended workspace. Review the requested bot permissions and select **Allow**. If the workspace requires app approval, request it and resume from the same setup page after approval.
5. Return to setup and use **Verify and continue** after Slack accepts and saves the Events URL. Chickpea promotes the encrypted credential revision only after the exact app/team OAuth result and a revision-bound signed Slack challenge agree.
6. Select **Become the first Owner with Slack**. The OIDC result must carry the same `team_id` as the installed app; the signed-in Slack `user_id` is bound atomically as the first Chickpea Owner.
7. Finish the in-app setup: choose a model provider and a model. A fresh deployment has no user Agent yet; `@Chickpea`, the built-in workspace assistant, answers direct messages and base mentions until you create one.
8. Open a direct message with `@Chickpea` and ask for a first teammate, as the setup page suggests. Chickpea offers a few starters that work without any connected account; replying with a number creates that Agent. Setup is complete only after a real Slack reply from Chickpea succeeds.
9. Optional: connect a coding agent or a script. Every deployment serves an OAuth-protected management MCP server at `https://<deployment>/mcp`; add that URL to Claude Code, Codex, or Cursor and the client signs in through Slack by itself. From a shell, `npx chickpea-cli doctor https://<deployment>` confirms the public surface is up (it reports a 404 as unfinished setup until step 6 completes), `npx chickpea-cli mcp config https://<deployment>` prints the client snippets, and `npx chickpea-cli login https://<deployment>` gives scripts the same access. See [the workspace management runbook](docs/runbooks/workspace-management-mcp.md).

## Manual adoption

Manual app adoption is a secondary recovery path on the setup page. Use the same reviewed manifest and unchanged deployment callback URLs. Client secret and signing secret inputs are write-only and encrypted before persistence. Do not use an app-level `xapp-` token; Chickpea uses Slack's HTTP Events API and a bot OAuth token issued by the install flow.

Create the app, then add its credentials and exported JSON manifest in
Chickpea. If the app already exists, use **Already created the app? Add its
credentials** instead of creating another one. Continue through Slack OAuth;
the following setup screen directs you to verify and save the Events URL in
Slack. Do not attempt Events verification before credential adoption: Chickpea cannot authenticate
Slack's signed challenge without the signing secret.

### Agent handle prerequisite for a customer-owned app

The manual manifest already includes `usergroups:read` and `usergroups:write`.
Slack's workspace-level **Create and edit user groups** policy is separate;
there is no app-manifest field that can grant it. Agent handles also require a
paid Slack plan. See [Slack's user-group requirements](https://docs.slack.dev/reference/methods/usergroups.create/).

Before creating an Agent, have an Owner or Admin open the **intended workspace**
and go to **Roles & permissions → Account types → Create and edit user groups**.
Allow **Members** and save. This enables human members as well as the app to
manage user groups; disclose that consequence before changing the policy.
Ask an Org Owner if an organization policy locks the setting. A generic
`slack.com/admin` link can open a different signed-in workspace, so confirm the
workspace name before editing anything.

If an Agent was already saved with a permission error, return to it and select
**Retry**. Do not reinstall the app or create a duplicate Agent. Verify recovery
by selecting its real `@handle` in Slack's mention picker and observing a
threaded reply in a channel attached to that Agent.

## Recovery

If credential key material or the installed Slack app credentials are lost, use the hidden scoped recovery flow in [docs/runbooks/slack-auth-recovery.md](docs/runbooks/slack-auth-recovery.md). It can repair only the unchanged app and workspace. It cannot create an Owner, grant a role, or sign anyone in.
