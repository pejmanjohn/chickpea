# Built-in authentication recovery

Use this runbook for a fresh password-mode installation. The persistent deployment recovery secret is root authority, not a normal login.

## Lost owner password

1. Open `<origin>/admin/recovery` from the canonical Chickpea origin.
2. Enter the durable owner email, a new strong password, and `CHICKPEA_RECOVERY_TOKEN` from offline storage.
3. Submit once. Chickpea replaces exactly that owner's credential, revokes their browser sessions and personal access tokens, and does not create a new session.
4. Sign in normally at `/admin/login` with the new password.
5. Confirm the recovery audit event and that at least one owner remains active.

Do not send the recovery secret in chat, email, support tickets, screenshots, or command output. If both the owner password and recovery secret are lost, there is no online bypass.

## Administrative teammate reset

An owner or admin opens Team settings and creates a 30-minute reset link. Send the show-once link to the fixed target through a trusted channel. The target chooses a new password, then signs in normally. The old link, old password, sessions, and personal access tokens no longer authorize access. An admin cannot reset an owner.

## Suspected recovery-secret compromise

Treat compromise as deployment-root compromise because the secret also derives Better Auth's signing/encryption secret.

1. Record the current non-secret audit window and active owner roster.
2. Generate a replacement with `openssl rand -hex 32` and update the Cloudflare secret or Node secret store without printing it.
3. Revoke every browser session and personal access token.
4. Revoke every pending invitation, administrative-reset, setup, and recovery capability.
5. Require password replacement for every human account.
6. Inspect auth and membership audit events for unexpected setup, recovery, reset, role, suspension, and token activity.
7. Confirm normal login, owner invariants, invitation enrollment, and Slack/provider callback reachability.

Rotating the recovery secret changes the derived Better Auth secret. Existing sessions and any material protected by the old secret must be treated as invalid; rotation alone is not containment.

## Safe evidence

Retain the canonical origin, operation type, target's non-secret user ID, audit correlation ID, session/PAT revocation counts, and pass/fail result. Never retain the recovery secret, password, session cookie, invitation/reset capability, Slack credential, or provider key.
