# Adding `AUTH_DB` to an existing Cloudflare install

This is an infrastructure preparation step for an existing Access, token, or legacy-shared installation. It does not change that installation's active authenticator or migrate its users.

## Before the change

1. Confirm the current authentication mode and that its normal login still works.
2. Capture the deployed release/commit and a state backup appropriate for the installation.
3. Keep `CHICKPEA_RECOVERY_TOKEN` available offline. Do not add `TAG_ADMIN_TOKEN` to an installation that no longer uses it.

## Provision and bind D1

Create the database in the same Cloudflare account:

```bash
npx wrangler d1 create chickpea-auth-db
```

Copy the returned database ID into the `AUTH_DB` entry in `wrangler.jsonc`. Preserve:

```json
{
  "binding": "AUTH_DB",
  "database_name": "chickpea-auth-db",
  "database_id": "<returned-id>",
  "migrations_dir": "migrations/better-auth"
}
```

Apply only the reviewed, checked-in migrations by binding name:

```bash
npx wrangler d1 migrations apply AUTH_DB --remote
```

Then run `npm run deploy`. Migrations are forward-only and ledgered; if schema application succeeds but Worker deployment fails, fix the deployment and rerun. Do not attempt schema rollback.

## Verify without changing modes

1. Confirm the existing Access/token/shared login still works.
2. Confirm the organization remains in its prior authentication mode.
3. Confirm `/admin`, Slack callbacks, and provider callbacks behave as before.
4. Confirm no owner, membership, invitation, or password credential was created merely by binding D1.

Password migration for an existing organization is a separate, explicitly confirmed product operation. Binding `AUTH_DB` alone must never partially activate it.
