# Authentication and roles

Chickpea separates **who signed in** from **what that person may do**. Better Auth owns password credentials, users, browser sessions, organizations, memberships, roles, and invitation records. Chickpea owns setup and recovery capabilities, authorization policy, Slack relationships, audit history, and the normalized principal used by product code.

## Default: built-in accounts

A fresh Cloudflare or Node install uses invitation-only email/password accounts. It needs no Cloudflare Access configuration, email provider, hostname-specific OAuth application, or Chickpea-hosted control plane.

1. Deploy. Cloudflare automatically creates and preserves `CHICKPEA_AUTH_SECRET`; Node operators configure an equivalent stable 32-byte value.
2. Open the private fragment link printed by the deploy (or by `npm run setup:link -- <origin>` on Node).
3. Enter the owner email, password, and password confirmation. The initial organization is named `Chickpea`, and the display name is derived from the email.
4. Chickpea pins the HTTPS origin, atomically creates the first Better Auth owner and organization, returns a secure browser session, and continues to `/admin/onboarding`.

The setup capability is separate from signing authority. Only its digest and deployment time enter Worker configuration; the browser removes the raw fragment before a request and consumes it through the resumable first-owner operation. The capability expires after 24 hours and cannot create a second owner. A deliberate onboarding reset is a clean break: it invalidates every previously issued setup link and rearms owner creation only behind a freshly generated, single-use setup capability. It does not roll back or remove append-only Cloudflare Durable Object migrations or infrastructure bindings.

Browser sessions use Better Auth's opaque cookie with `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` on HTTPS. Human credential routes do not accept personal access tokens or agent credentials. State-changing forms and APIs also require the pinned origin and same-site request provenance.

## Roles

- `owner`: full administration, owner promotion/demotion, and authentication-sensitive recovery.
- `admin`: product configuration and ordinary teammate management; cannot grant or control owners.

The launch UI does not expose role selection. The person who creates the workspace is marked as Owner; every teammate added through a join link is an administrator.

Suspension and removal take effect on the next request and revoke that person's browser sessions and personal access tokens. Chickpea serializes owner changes and never permits the final active owner to be demoted, suspended, or removed.

## Inviting teammates

An owner or admin creates an exact-email, seven-day join link in Team settings. Chickpea does not send email: the operator copies the link to the invitee through a trusted channel. While it is pending, the same link remains available to authorized administrators; creating a link for the same email returns that existing link instead of producing another invitation.

The capability exists only in the URL fragment. The public, no-store `/join` page moves it into same-tab session storage and removes it from browser history before enrollment. A new invitee creates a display name and password for the fixed invited email. Someone who already has a local Chickpea account signs in normally and resumes the same tab; the invitation never overwrites an existing password.

Acceptance requires the exact invited email and creates the membership only at the final commit. Revoke or expiry invalidates the link; creating a new link after either event produces a new capability. A different signed-in user and replay both fail closed. Operators can choose `team-only` or invite-only connection visibility independently from the person's Chickpea role.

## Password changes and reset

A signed-in user changes their own password only after proving the current one. Success revokes every browser session and requires normal login.

An owner or authorized admin may create a 30-minute, show-once administrative reset link for a teammate. The fixed target is visible before the new password is accepted. Reset revokes all target sessions and personal access tokens, consumes the capability, and does not create a logged-in session. An admin cannot reset an owner.

## Owner recovery

Recovery is disabled by default. A Cloudflare account holder creates a temporary `CHICKPEA_RECOVERY_TOKEN`, opens `/admin/recovery`, and provides the durable owner email, replacement password, and temporary value. Recovery is not sign-in: it replaces exactly one owner credential, revokes the owner's sessions and personal access tokens, consumes that configured capability, and requires normal login. Cloudflare secrets are write-only, so operators create or replace the value; they do not retrieve an old one. Follow [Built-in authentication recovery](runbooks/password-recovery.md).

## Existing installs and `AUTH_DB`

Fresh Cloudflare deploys provision `AUTH_DB` D1 and apply the checked-in Better Auth migrations before the Worker deploy. Existing Access, token, and legacy-shared installations retain their current authenticator and data authority. If such an upgraded installation has no `AUTH_DB` binding, it must continue to boot in its existing mode rather than partially activating password auth. See [Adding the Better Auth database to an existing install](runbooks/auth-db-upgrade.md).

`TAG_ADMIN_TOKEN` is legacy-only and is not an active prompt for new deployments. Do not add it to a fresh installation.

## Optional Cloudflare Access mode

Cloudflare Access remains an advanced authenticator for an installation that explicitly chooses it. It supplies a signed external identity; Chickpea still resolves that identity to a live membership and role. There is never an Access-to-password fallback if Access is incomplete or invalid.

Protect only `<origin>/admin` and `<origin>/admin/*`. Slack events, Slack interactivity, the public GitHub setup callback, invitation/reset bootstrap pages, and provider OAuth callbacks use their own signatures or single-use state and must remain reachable. Existing Access operators should use the separate [Cloudflare Access recovery](runbooks/access-recovery.md) runbook.

## Node deployments

Node uses the same built-in setup, login, invitation, role, reset, and recovery behavior over the process-cached SQLite auth database. Slack credential encryption uses a separate auto-minted mode-0600 keyring at `<SLACK_STATE_DB_PATH>.credential-keyring.json` by default; `CHICKPEA_CREDENTIAL_KEYRING_PATH` can place it on separately protected storage and is required for in-memory state. Back up and restore that keyring together with the state database. A missing live key enters `recovery_only`; it never falls back to Slack environment variables or `CHICKPEA_AUTH_SECRET`. Put every non-loopback deployment behind HTTPS, restrict the SQLite and keyring files to the service account, and avoid multiple processes unless you provide a supported shared database.

The older explicit personal-token bootstrap remains a compatibility path for an installation already using token mode. A personal token is a machine credential, not password-lifecycle authority.

## Hosted compatibility

Product authorization depends on normalized users, organizations, memberships, roles, statuses, and permissions—not Better Auth cookies or Cloudflare assertions. Hosted Chickpea can therefore keep the same product model while moving Better Auth to PostgreSQL and adding managed OIDC/SAML, enterprise session policy, and SCIM-compatible provisioning. Provider/database identifiers may require an explicit mapping during that migration; semantic compatibility does not promise byte-identical stored IDs.
