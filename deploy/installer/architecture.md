# Installer architecture

Chickpea's OSS installer provisions a fresh Worker, `TAG_STATE`, and one exact `AUTH_DB` D1 database in the customer's Cloudflare account. The deploy output contains a seven-day fragment capability for `/admin/setup`; no Chickpea-hosted control plane or identity service participates.

| Concern | Fresh OSS authority |
| --- | --- |
| Human identity | Slack OpenID Connect through the customer-owned Slack app |
| Browser session/provider account | Better Auth in the deployment's `AUTH_DB` |
| Workspace, members, roles, invitations | Chickpea's Slack-tuple identity state in `TAG_STATE` |
| Slack app/bot credentials | Versioned AES-GCM envelopes in `TAG_STATE` with an independent deployment keyring |
| Setup | Hashed, expiring, single-deployment capability and resumable state machine |
| Recovery | Optional scoped token for unchanged-app credential repair only |

## Fresh deployment journey

1. The deploy wrapper creates or preserves exactly one `AUTH_DB`, applies the reviewed fresh schema, provisions independent `CHICKPEA_AUTH_SECRET` and credential-key slots, builds the artifact, and uploads only after the binding checks pass.
2. The operator opens the private setup capability.
3. Chickpea creates or adopts one customer-owned Slack app from the reviewed manifest. External calls are preceded by durable pending state; ambiguous results require inspection or explicit restart.
4. Slack applies its own workspace app-management policy. Chickpea accepts any installer Slack permits and does not duplicate Slack Owner/Admin rules.
5. The confidential bot OAuth callback validates the exact app, team, token type, actual granted scopes, directory access, channel access, and signed Events proof before atomically promoting the encrypted credential revision.
6. The installer completes confidential Slack OIDC. Exact `team_id` equality is required, and the installer's `user_id` becomes the first Chickpea Owner.
7. Later control-plane members require an exact Slack tuple invitation. Ordinary Channel members can still use assigned Agents without Admin membership.

Product code consumes a normalized principal plus Chickpea permissions. It does not consume raw Better Auth cookies, Slack tokens, D1 rows, or Slack workspace role labels.

## Deliberate boundaries

- No password, email enrollment, Cloudflare Access, shared Admin token, public sign-up, or automatic member provisioning.
- No compatibility or migration path for earlier installs; create a fresh deployment.
- `CHICKPEA_AUTH_SECRET`, the Slack credential keyring, and `CHICKPEA_RECOVERY_TOKEN` are separate authorities.
- Runtime Slack credentials never fall back to environment bot/signing-secret values.
- A manifest or `auth.test` result is not enough to mark Connected; actual grants and HTTP Events behavior must pass.

The earlier Cloudflare Access investigation in [`feasibility/2026-08-07.md`](feasibility/2026-08-07.md) is retained only as historical research, not a supported architecture.
