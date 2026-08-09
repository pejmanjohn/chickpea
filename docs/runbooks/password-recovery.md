# Built-in authentication recovery

Use this runbook for a password-mode installation. Recovery is disabled during normal operation and does not add a code to onboarding.

## Lost owner password

1. In the Worker's Cloudflare settings, create `CHICKPEA_RECOVERY_TOKEN` with a new 32-byte random value. Cloudflare cannot show an existing secret; create or replace it.
2. Open `<origin>/admin/recovery` and enter the durable owner email, a new strong password, and that temporary value.
3. Submit once. Chickpea replaces exactly that owner's credential, revokes their browser sessions and personal access tokens, consumes the configured value, and does not create a new session.
4. Delete `CHICKPEA_RECOVERY_TOKEN` from Cloudflare, then sign in normally at `/admin/login`.
5. Confirm the recovery audit event and that at least one owner remains active.

Do not send the temporary value in chat, email, support tickets, screenshots, or command output. Another recovery requires the Cloudflare account holder to replace it with a new value.

## Administrative teammate reset

An owner or admin opens Team settings and creates a 30-minute reset link. Send the show-once link to the fixed target through a trusted channel. The target chooses a new password, then signs in normally. The old link, old password, sessions, and personal access tokens no longer authorize access. An admin cannot reset an owner.

## Suspected temporary-value compromise

Replace or delete `CHICKPEA_RECOVERY_TOKEN` immediately, inspect auth audit events, and revoke affected sessions or personal tokens. On current installations `CHICKPEA_AUTH_SECRET` is separate, so rotating the temporary recovery capability does not invalidate unrelated sessions. Legacy installations that still derive signing authority from `CHICKPEA_RECOVERY_TOKEN` require the broader legacy rotation procedure before changing it.

## Safe evidence

Retain the canonical origin, operation type, target's non-secret user ID, audit correlation ID, session/PAT revocation counts, and pass/fail result. Never retain the recovery secret, password, session cookie, invitation/reset capability, Slack credential, or provider key.
