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
7. Choose the first Channel for the Default Agent. Chickpea can join a public Channel automatically. Invite it to a private Channel first, then refresh the picker.
8. Mention `@Chickpea` in that Channel. Setup is complete only after a real threaded Slack response succeeds.

## Manual adoption

Manual app adoption is a secondary recovery path on the setup page. Use the same reviewed manifest and unchanged deployment callback URLs. Client secret and signing secret inputs are write-only and encrypted before persistence. Do not use an app-level `xapp-` token; Chickpea uses Slack's HTTP Events API and a bot OAuth token issued by the install flow.

## Recovery

If credential key material or the installed Slack app credentials are lost, use the hidden scoped recovery flow in [docs/runbooks/slack-auth-recovery.md](docs/runbooks/slack-auth-recovery.md). It can repair only the unchanged app and workspace. It cannot create an Owner, grant a role, or sign anyone in.
