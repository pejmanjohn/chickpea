# Installer and authentication boundaries

This document separates three concerns that can look like one sign-in flow in a
consumer installer but have different security and portability contracts.

## The three boundaries

| Boundary | Purpose | Current OSS Cloudflare choice | Replaceable by |
| --- | --- | --- | --- |
| Installer session | Keep one browser attached to one deployment operation | Chickpea-hosted, short-lived browser session | Any hosted session implementation |
| Provisioning authority | Let the installer create resources in the selected customer Cloudflare account | **Unresolved for the consumer path**; third-party OAuth was tested as one candidate and failed the accepted Access-write gate | A provider-supported OAuth grant, a Cloudflare first-party deployment capability, or another explicitly approved short-lived account capability |
| Runtime authentication | Prove who is opening the deployed Chickpea Admin | Cloudflare Access, normally using email one-time PIN | Hosted sessions, OIDC, SAML, or another `Authenticator` adapter |

Cloudflare Access does not authorize the hosted installer to mutate a
Cloudflare account. Conversely, a deployment grant does not sign the owner in
to the deployed Chickpea instance. The email plus six-digit-code screen is the
runtime Access login, not the deployer's account-management grant.

## Stable product contracts

The consumer experience and the authority transport are deliberately separate.
The product contract remains:

1. The operator opens a Chickpea-branded installer.
2. The installer obtains a narrowly bounded, temporary capability for one
   selected Cloudflare account. The exact provider mechanism is hidden behind
   `ProvisioningAuthority` and must pass the feasibility gate before use.
3. The operator enters an instance name and owner email.
4. The browser generates the recovery credential and requires the operator to
   save the recovery kit before the first mutation.
5. The installer deploys the customer-owned release and configures the
   path-scoped Access perimeter without asking for Zero Trust terms, issuer,
   audience, policy, or identity-provider identifiers.
6. The installer destroys or proves unusable its temporary provisioning
   authority.
7. The operator opens the new instance. Cloudflare Access sends the email
   one-time code and supplies a signed assertion to Chickpea.
8. Chickpea atomically binds the matching owner, then continues to the existing
   Slack setup wizard.
9. Later teammates are invited and assigned roles entirely inside Chickpea.

Changing the mechanism in step 2 must not change steps 3-9.

## Provisioning authority port

Installer orchestration may depend only on an opaque operation-scoped
capability with these semantics:

- identify the exact selected Cloudflare account from provider-observed data;
- prove an exact versioned permission set before mutation;
- expose a Cloudflare API client only to the fenced installer operation;
- never expose credential material to browser JavaScript, logs, analytics,
  release manifests, or the deployed runtime;
- support terminal authority removal with provider acknowledgement or a
  harmless proof that the credential can no longer be used; and
- make uncertainty explicit as `authority_purge_pending`, never success.

An OAuth implementation would additionally own authorization-code, exact
redirect URI, one-time state, S256 PKCE, token exchange, and revocation. Those
are adapter details, not requirements of Cloudflare Access or of the installer
orchestration domain.

The following are not acceptable consumer defaults:

- asking the user to create and paste a long-lived API token;
- requesting Account API Tokens Write so the broker can mint another token;
- treating an Access session or Access assertion as Cloudflare account API
  authority; or
- copying Cloudflare OS's private hosted deploy mechanism without a documented,
  supported third-party contract.

The standard Deploy button, Wrangler/CLI deployment, token mode, and manual
Access setup remain advanced customer-operated paths. They do not implement the
consumer one-click contract merely because they can install the runtime.

## Current feasibility status

U7 is blocked, not partially implemented. The 2026-08-07 phase-zero record
proved that a narrowly scoped account API token can create the required Access
application, but the current self-service third-party OAuth picker emits
`zone-access.write` instead of the account-level Access permission required by
that endpoint. It also did not prove a separately identifiable email method or
the cross-account container artifact contract.

Do not add installer product code until the gate in
[`feasibility/2026-08-07.md`](feasibility/2026-08-07.md) changes to a supported
authority mechanism and the remaining artifact and account fixtures pass.

## Hosted evolution

Hosted Chickpea should reuse `User`, `Membership`, `Invitation`, roles,
permissions, and normalized principals. It can replace two outer adapters
independently:

- the OSS deployment installer with a Hosted tenant-provisioning control plane;
  and
- Cloudflare Access with managed sessions plus OIDC, SAML, and SCIM adapters.

No Access issuer, audience, policy ID, OAuth scope, Cloudflare account ID, or
installer operation state belongs in the Chickpea identity domain. This keeps
the current OSS design useful without pretending that the single-workspace
runtime is already a multi-tenant hosted service.
