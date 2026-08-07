# Authentication and roles

Chickpea deliberately separates **who signed in** from **what that person may do**.

## Cloudflare deployments

Cloudflare Access is the default authenticator. The intended consumer installer creates the authentication perimeter during deployment; it does not make Chickpea a permanent OAuth or runtime intermediary. The standard Cloudflare Deploy button and CLI remain the advanced/manual fallback and currently require this one-time setup:

The hosted installer's temporary authority to create resources in a customer's
Cloudflare account is a separate concern from Access login. Cloudflare Access
supplies the email one-time-code screen and signed runtime assertion; it does
not grant the installer Cloudflare account API access. OAuth is one possible
implementation of the provisioning-authority adapter, not a requirement of
Access or of Chickpea's identity model. The consumer provisioning mechanism is
currently blocked on the accepted platform feasibility gate; see
[Installer and authentication boundaries](../deploy/installer/architecture.md).

1. Cloudflare deploys the source and prompts for `CHICKPEA_RECOVERY_TOKEN`.
2. `/admin/setup` uses that offline credential only to create the pending owner claim and save the expected Access issuer, audience, and Admin origin.
3. You create or reuse a Zero Trust organization, enable a dedicated verified-email login method, and protect exactly `<origin>/admin` and `<origin>/admin/*` in one Self-hosted application. Its authentication-only policy is configured once and does not enumerate Chickpea members.
4. `/admin/setup/verify` must receive a cryptographically valid `Cf-Access-Jwt-Assertion`. Chickpea verifies its signature, exact issuer, audience, expiry, subject, and email before activating the owner.
5. Later requests repeat both gates: Access must authenticate the immutable external subject, and Chickpea must resolve it to an active membership with sufficient permissions.

Do not protect the whole Worker hostname. `/channels/slack/events`, Slack interactivity, the public GitHub setup callback, and provider OAuth callbacks use their own signatures or single-use state and must remain reachable without an Access session.

## Chickpea roles

- `owner`: full administration, including owner promotion/demotion and authentication-sensitive recovery.
- `admin`: product configuration, ordinary membership management, and `member`/`admin` invitations; cannot grant or control owners.
- `member`: a minimal signed-in account and Slack handoff; no configuration console.

Suspending or removing a membership takes effect on the next Chickpea request even if Cloudflare still considers the Access session valid. The final active owner cannot be demoted, suspended, or removed.

The authentication-only perimeter deliberately allows any person who can verify an email to reach Chickpea's sign-in boundary. An unknown identity receives the same denial, creates no user or membership, and can read no product data. Only a matching invitation or existing active membership grants Chickpea authority.

## Inviting teammates

An owner or admin creates an exact-email Chickpea invitation with a role. The seven-day link carries its show-once secret only in the URL fragment. A public, no-store `/join` page moves that value into same-tab session storage, removes it from the address bar, then sends the browser through the configured sign-in perimeter. The protected join page clears the stored secret before posting it to Chickpea.

The signed assertion email must exactly match the invitation. Chickpea then consumes the secret atomically and binds the stable `(provider, issuer, subject)` identity rather than treating email as the permanent key. Resend rotates the secret; revoke, expiry, a different verified email, and replay all fail closed. No invitation, suspension, removal, resend, or role change edits Cloudflare.

## Token mode for manual or Node installs

Access is not required for a manual Node deployment. Explicit token mode uses one show-once personal token per person; browser login exchanges that token for a separate opaque, hashed, `HttpOnly`, `SameSite=Lax` session capped at 24 hours. Revoking the source personal token or suspending the membership invalidates the next request.

Bootstrap token mode directly against the Node SQLite state:

```bash
export CHICKPEA_RECOVERY_TOKEN="$(openssl rand -hex 32)"
printf '%s\n' "$CHICKPEA_RECOVERY_TOKEN" | \
  npm run auth:recover -- --bootstrap-token-mode \
    --state-db ./tmp/flue.db.state \
    --owner-email owner@example.com \
    --origin https://chickpea.example.com \
    --yes
```

The command has no HTTP transport. It stores only the personal-token hash and prints the raw token once. Use the same command without `--bootstrap-token-mode` to rotate a selected owner after credentials are lost; prior personal tokens and their browser sessions are revoked.

## Legacy shared-token migration

`TAG_ADMIN_TOKEN` exists only for an installation created before identity auth. The old credential remains usable while Access setup is pending so an interruption cannot strand the operator. Once Access or token mode activates, shared-token authentication is cut off and cannot be re-enabled as a fallback. Existing Slack credentials and product configuration stay in the same state store.

## Recovery boundaries

- Access edge or identity-provider lockout is repaired in Cloudflare first. Chickpea cannot bypass a policy that prevents the request from reaching the Worker.
- `/admin/recovery` is inside the Access perimeter. It requires the offline recovery credential plus a valid signature from the configured issuer and can repair only the Access audience or one owner binding.
- Token-mode recovery uses `npm run auth:recover` with direct SQLite access. No HTTP route accepts the recovery credential as a token-mode login.

See [Access recovery](runbooks/access-recovery.md) for exact procedures.

## Hosted compatibility

The product domain stores internal users, organization-scoped memberships, roles, invitations, and permissions independently from Access. Access, personal tokens, and a future Hosted authenticator all return the same normalized principal. Hosted Chickpea can therefore add managed OIDC, SAML, SCIM, hosted sessions, and tenant routing without redefining the role matrix or rewriting Slack product state. The OSS instance remains honestly single-organization and single-workspace; it does not claim runtime-wide multi-tenancy today.
