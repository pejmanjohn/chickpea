# Installer architecture

Chickpea's OSS installer provisions a fresh Worker, `TAG_STATE`, and one exact `AUTH_DB` D1 database in the customer's Cloudflare account. The deploy output contains a seven-day fragment capability for `/admin/setup`. The product offers two Slack transport lanes with the same Agent behavior.

| Concern | Fresh OSS authority |
| --- | --- |
| Human identity | Slack OpenID Connect through the selected Slack app; the exact Slack team/user tuple remains canonical |
| Browser session/provider account | Better Auth in the deployment's `AUTH_DB` |
| Workspace, members, roles, invitations | Chickpea's Slack-tuple identity state in `TAG_STATE` |
| Slack app/bot credentials | Shared lane: private Chickpea gateway. Customer-owned lane: versioned AES-GCM envelopes in `TAG_STATE` with an independent deployment keyring |
| Shared-app binding | Deployment-owned P-256 key and one tenant-bound gateway claim; no Slack token or app configuration token enters the deployment |
| Setup | Hashed, expiring, single-deployment capability and resumable state machine |
| Recovery | Optional scoped token for unchanged-app credential repair only |

## Fresh deployment journey

1. The deploy wrapper creates or preserves exactly one `AUTH_DB`, applies the reviewed fresh schema, provisions independent `CHICKPEA_AUTH_SECRET` and credential-key slots, builds the artifact, and uploads only after the binding checks pass.
2. The operator opens the private setup capability.
3. The operator chooses a Slack lane:
   - **Add to Slack (default):** Chickpea creates a signed one-time claim and opens the shared unlisted app installation. The private gateway binds the installed workspace to this deployment automatically.
   - **Use your own Slack app:** Chickpea creates or adopts a customer-owned app from the reviewed manifest using the configuration-token flow, with the illustrated manual manifest flow as fallback.
4. Slack applies its own workspace app-management policy. Chickpea accepts any installer Slack permits and does not duplicate Slack Owner/Admin rules.
5. The selected transport validates the exact app, team, bot identity, and grants. In the shared lane the gateway retains Slack credentials and exposes only the versioned operation allowlist; in the customer-owned lane the deployment atomically promotes its encrypted credential revision.
6. The installer completes confidential Slack OIDC. The shared gateway exchanges and verifies provider tokens and returns only a bounded identity proof; the direct lane performs that verification locally. Exact `team_id` equality is required, and the installer's `user_id` becomes the first Chickpea Owner.
7. Later control-plane members require an exact Slack tuple invitation. Ordinary Channel members can still use assigned Agents without Admin membership.

Product code consumes a normalized principal plus Chickpea permissions. It does not consume raw Better Auth cookies, Slack tokens, D1 rows, or Slack workspace role labels.

## Deliberate boundaries

- No password, email enrollment, Cloudflare Access, shared Admin token, or public sign-up.
- Eligible full Slack members are provisioned when they first interact. Guests, Slack Connect users, bots, app users, and deactivated members are excluded.
- No compatibility or migration path for earlier installs; create a fresh deployment.
- `CHICKPEA_AUTH_SECRET`, the Slack credential keyring, and `CHICKPEA_RECOVERY_TOKEN` are separate authorities.
- The shared lane maintains one renewable outbound authenticated session. Node keeps a normal WebSocket; Cloudflare rotates its outbound socket before the platform lifetime ceiling. When the deployment is offline, the gateway stores no event payload and offers no replay.
- The shared gateway receives only signed tenant-bound calls for the exact operation allowlist. It never returns Slack bot, signing, app-secret, access, or identity tokens to the deployment.
- The customer-owned lane has no dependency on the Chickpea gateway. Its runtime Slack credentials never fall back to environment bot/signing-secret values.
- A manifest or `auth.test` result is not enough to mark Connected; actual grants and HTTP Events behavior must pass.

The earlier Cloudflare Access investigation in [`feasibility/2026-08-07.md`](feasibility/2026-08-07.md) is retained only as historical research, not a supported architecture.
