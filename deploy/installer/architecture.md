# Installer and authentication boundaries

Chickpea's default OSS journey uses Cloudflare's standard Deploy button for provisioning and customer-owned built-in accounts for runtime authentication. It does not require a Chickpea-hosted installer, Cloudflare Access, or third-party OAuth authority.

## Current one-click path

| Boundary | Purpose | OSS Cloudflare choice | Future Hosted choice |
| --- | --- | --- | --- |
| Deployment session | Let an operator authorize resources in their own Cloudflare account | Cloudflare-owned Deploy-button flow | Chickpea tenant provisioning or another supported deployment adapter |
| Deployment root recovery | Authorize first-owner setup and bounded disaster recovery | Customer-supplied `CHICKPEA_RECOVERY_TOKEN` | Hosted recovery and support policy |
| Human authentication | Prove a named person controls an account | Better Auth email/password and opaque browser sessions | Better Auth with managed OIDC/SAML and enterprise session policy |
| Product authorization | Decide what that person may do | Chickpea memberships, roles, statuses, permissions, and audit | The same semantic contract |

The Deploy button is a hosted Cloudflare onboarding surface for open-source code, but the resulting Worker, Durable Objects, D1 database, secrets, and URL belong to the customer's account. Cloudflare's deployment session is not copied into Chickpea and does not become a runtime login.

## End-user journey

1. The operator generates 32 random bytes with `openssl rand -hex 32` and stores the value in a password manager.
2. The Cloudflare Deploy form prompts for that one secret and provisions the Worker, `AUTH_GUARD`, `TAG_STATE`, `AUTH_DB`, and other declared resources.
3. Reviewed Better Auth D1 migrations apply by the `AUTH_DB` binding before the Worker deploy. A failed later deploy is retried forward from the migration ledger.
4. The completion screen points to `/admin/setup`.
5. The operator supplies the recovery secret, workspace name, owner name, email, and password. Chickpea pins the canonical HTTPS origin, creates exactly one owner, and returns a Better Auth session.
6. The existing Slack-app manifest wizard begins.
7. Owners and admins later create show-once exact-email invitation links. New teammates create a password; existing local accounts sign in and resume the invitation.

No step asks the operator to create a Zero Trust organization, email provider, OAuth client, or Chickpea account. Chickpea sends no enrollment email.

## Stable ports

Product code consumes a normalized principal plus Chickpea permissions. It does not consume Better Auth cookies, Cloudflare Access assertions, D1 row types, deployment operation state, or Cloudflare account identifiers.

The following stay replaceable:

- deployment provisioning can move from Cloudflare's Deploy button to a Hosted control plane;
- the Better Auth database can move from D1/SQLite to managed PostgreSQL with explicit ID mapping;
- built-in passwords can coexist with or yield to managed OIDC/SAML; and
- SCIM-compatible provisioning can update memberships without becoming product authorization.

Replacement must preserve invitation-only admission, owner/admin/member semantics, immediate suspension, last-owner safety, session/PAT revocation, and audit behavior.

## Optional Cloudflare Access

Access remains an explicit advanced authenticator for existing operators who want an external perimeter. Its assertion proves an external identity only; it never assigns a role or grants Cloudflare account API authority. Invalid or partial Access configuration fails closed and never falls back to passwords or a legacy token.

The earlier feasibility investigation into automatically provisioning Access is retained in [`feasibility/2026-08-07.md`](feasibility/2026-08-07.md) as historical evidence. Its blocked OAuth/account-scope result no longer blocks the default built-in-auth deployment path.

## Security boundaries

- The raw recovery secret is persistent deployment-root authority, not a daily credential. It is distinct from one-time setup/recovery capabilities and from the HKDF-derived Better Auth secret.
- Better Auth owns credential/session protocol records. Chickpea owns setup, recovery, authorization, personal-token revocation, Slack relationships, and audit.
- Human credential routes reject PATs and agent tools.
- Slack/provider callbacks remain public only at their signature or single-use-state boundary.
- Existing Access/token/shared installations boot in their prior mode if `AUTH_DB` is absent. Binding the database does not silently migrate or activate passwords.

## Pre-release installer hardening

- [ ] Replace the prototype owner-setup fragment handoff with an installer-issued, single-use, short-lived setup capability. The current bridge moves `#setup=...` into same-tab storage and immediately removes it from browser history, but it still transports the persistent `CHICKPEA_RECOVERY_TOKEN`. The released onboarding must keep that recovery credential out of browser setup URLs entirely.
- [ ] Have the custom onboarding layer mint and deliver the setup capability only after the customer-owned deployment is ready, bind it to the intended installation and owner-claim operation, store only a digest, consume it atomically, and reject expiry or replay without falling back to the recovery credential.
- [ ] Preserve a manual `/admin/setup` recovery path for operators who intentionally supply the offline recovery credential, while making the ordinary one-click journey use the one-time capability. Cloudflare's standard Deploy button remains the source deployment primitive; the private handoff belongs to the custom onboarding layer around it. See [Cloudflare's Deploy button documentation](https://developers.cloudflare.com/workers/platform/deploy-buttons/).
