# AUTH_DB deployment contract

Chickpea uses one Cloudflare D1 binding named `AUTH_DB` for Better Auth sessions and provider accounts. A deploy must preserve the exact database ID already bound to the target Worker. It must stop before upload if the generated artifact omits the binding, changes its database ID, or points it at a second database.

Fresh deployments create an empty D1 database, bind it as `AUTH_DB`, and apply the checked-in migration in `migrations/better-auth` before uploading the Worker. The migration ledger stores the reviewed SQL digest. A database with pre-existing Better Auth tables, a digestless ledger, or a different `0001` digest is incompatible; discard the disposable deployment and start with a fresh empty database.

There is deliberately no upgrade or identity migration path. Chickpea has no supported password, Cloudflare Access, or shared-admin-token authority to preserve.

Verify before upload:

1. The source and generated Wrangler configs each contain exactly one `AUTH_DB` binding.
2. The generated binding has the same non-empty database ID as the deployed Worker.
3. `migrations_dir` ends in `migrations/better-auth`.
4. Remote migration application succeeds and the recorded `0001` digest matches the checked-in file.
5. The Worker artifact was built after these checks and is the artifact being uploaded.
