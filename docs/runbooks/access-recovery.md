# Cloudflare Access recovery (optional mode)

This runbook applies only to an existing installation that explicitly uses optional Cloudflare Access authentication. Fresh Chickpea installations use Slack-only identity; see [Slack authentication recovery](slack-auth-recovery.md).

## Before changing Chickpea

1. Open Cloudflare Zero Trust from the same account that owns the Worker.
2. Confirm the Self-hosted Access application still covers both `<origin>/admin` and `<origin>/admin/*`.
3. Confirm the application's authentication-only policy and dedicated verified-email login method are enabled. Chickpea membership, not an email allowlist here, authorizes the owner.
4. Test the Access login. If Cloudflare blocks the request before it reaches Chickpea, repair that edge policy first.

Slack and OAuth callbacks must remain outside the Access application. Do not expand the application to the entire Worker hostname as a recovery shortcut.

## Audience changed or application was recreated

Recreating an Access application changes its audience. Repair the edge application first, then:

1. Open `<origin>/admin/recovery` through the repaired Access policy.
2. Choose **Update Access application audience**.
3. Enter the new audience and the offline `CHICKPEA_RECOVERY_TOKEN`.
4. Submit. Chickpea accepts the change only when the request also carries a valid assertion signed by the already configured Access issuer.
5. Reopen `/admin` and confirm normal owner access.

This operation cannot change issuer, create a user, change a role, or create a session.

## Owner subject changed

Use this only when the same owner now has a different immutable Access subject—for example, after replacing an identity provider—while the configured issuer remains valid.

1. Repair the Access policy so the intended owner can reach `<origin>/admin/recovery`.
2. Choose **Replace my owner identity binding**.
3. Enter the offline recovery credential and submit from the new identity.
4. Chickpea verifies the configured issuer signature and exact owner email, replaces one owner binding, and leaves the membership and last-owner invariant intact.

## Complete edge lockout

Chickpea cannot receive `/admin/recovery` while Access denies every request. Use the Cloudflare dashboard owner account to restore the authentication-only policy or dedicated email login method. If the application was deleted, recreate it with both Admin destinations and then perform the audience repair above. Do not add `TAG_ADMIN_TOKEN`: active Access mode never falls back to the legacy shared credential.

## Token-mode recovery

Cloudflare Access recovery and token-mode recovery are different paths. A Node/manual token-mode installation rotates an owner's credential directly against SQLite:

```bash
export CHICKPEA_RECOVERY_TOKEN='<the configured offline credential>'
printf '%s\n' "$CHICKPEA_RECOVERY_TOKEN" | \
  npm run auth:recover -- \
    --state-db ./tmp/flue.db.state \
    --owner-email owner@example.com \
    --yes
```

The command prints one replacement personal token after revoking that owner's prior personal tokens and their browser sessions. It makes no HTTP request. Store the new token immediately; Chickpea stores only its hash and cannot show it again.

## Safe evidence to retain

Record the Worker URL, the two protected Admin destinations, issuer hostname, non-secret audience fingerprint, operation performed, and pass/fail result. Never capture an Access assertion, recovery credential, personal token, invitation link, Slack secret, or provider key.
