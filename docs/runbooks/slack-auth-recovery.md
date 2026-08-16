# Slack authentication recovery

Use this runbook only when the existing Chickpea Slack app can no longer authenticate the control plane. Recovery repairs credentials and deployment URLs for that same app and workspace. It never creates a user, changes a role or Slack binding, issues a Chickpea session, or adopts a replacement app.

## Before starting

1. Confirm the Slack app still exists. Record its non-secret `app_id` and the installed workspace `team_id`.
2. Create a new random 32-byte `CHICKPEA_RECOVERY_TOKEN` in the deployment secret store. Do not pass it on a command line or put it in chat, logs, screenshots, or tickets.
3. Ensure the deployment has a usable current credential-encryption key. If the prior root was lost, provision a new versioned key slot; do not reuse the lost key ID with different material.
4. For a changed hostname, generate a fresh short-lived Slack app configuration token. It will be used only to update the unchanged app's two OAuth redirects and Events request URL.

For a read-only preflight, run:

```sh
CHICKPEA_RECOVERY_TOKEN='<temporary 32-byte value>' \
  npm run auth:recover -- --url https://your-chickpea.example
```

On a Node deployment, add `--state-db /path/to/tag-state.db` to confirm the expected app, workspace, credential revision, and health gate without changing state.

## Repair

1. Open the preflight's exact `/admin/recovery` URL. This route is intentionally absent from normal navigation.
2. Enter the temporary deployment recovery token. A single browser-bound session is minted for 15 minutes; the token cannot mint a second session even through another supported encoding.
3. Enter the existing app ID, workspace/team ID, client ID, client secret, and signing secret. These fields are write-only and encrypted before durable storage.
4. If the deployment hostname changed, also enter the fresh Slack configuration token. Chickpea first exports the current manifest, refuses any non-URL contract difference, updates only the exact OAuth and Events URLs, exports again, and discards the configuration token from request memory.
5. Continue through Slack's bot authorization. Chickpea requires the unchanged app and workspace, a bot token, all required scopes, `auth.test` agreement, readable directory and channel capabilities, and confidential `client_secret_post`. An inactive candidate is staged; the prior usable revision remains active on failure.
6. In Slack app settings, retry and save Event Subscriptions so Slack sends a fresh signed URL-verification challenge. Return to recovery and select **Verify and promote repair**.
7. Chickpea verifies the candidate's signing secret against the exact app/workspace challenge, atomically promotes that revision, fences the runtime cache, consumes recovery authority, and returns a neutral completion page.
8. Delete or replace `CHICKPEA_RECOVERY_TOKEN`. An existing Chickpea Owner must then use normal **Sign in with Slack**. Recovery itself never signs anyone in.

## Lost encryption root

When live ciphertext references an unavailable key, Chickpea enters `recovery_only`: normal Admin, Better Auth, OIDC, and Slack execution stay closed. The same flow above may tombstone the undecryptable workspace-default revision, advance to a new key version, and stage a same-app/team candidate. Dedicated bot revisions are never reset by this operation; restore their prior key first. `recovery_only` clears only when signed Events proof promotes the replacement.

## Refusal and failure states

- A different app, workspace, broader manifest change, missing scope, user token, or mismatched Slack truth is refused.
- Slack outage, invalid response, missing Events proof, stale revision, parallel session, replay, or 15-minute expiry leaves the candidate inactive and never creates identity authority.
- If every active Owner lost their Slack identity, this runbook cannot transfer ownership. Perform an explicit destructive fresh deployment/state reset and setup again.
- If the Slack app was deleted or its identity realm is irrecoverable, do not adopt another app through recovery. Use the same explicit fresh reset.

## Safe evidence

Retain only the deployment ID, app ID, team ID, credential revision IDs, audit correlation ID, health-gate transition, and pass/fail result. Never retain recovery/configuration tokens, OAuth code/state, browser cookies, bot/client/signing secrets, Slack ID/access tokens, or raw signed event bodies.
