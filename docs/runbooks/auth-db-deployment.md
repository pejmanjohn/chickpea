# AUTH_DB deployment contract

Chickpea uses one Cloudflare D1 binding named `AUTH_DB` for Better Auth sessions and provider accounts. A deploy must preserve the exact database ID already bound to the target Worker. It must stop before upload if the generated artifact omits the binding, changes its database ID, or points it at a second database.

Fresh deployments create an empty D1 database, bind it as `AUTH_DB`, and apply the checked-in migrations in `migrations/better-auth` before uploading the Worker. The migration ledger stores the reviewed SQL digests. A database with pre-existing Better Auth tables but no compatible ledger, a digestless ledger, or a different applied migration digest is incompatible. Stop and preserve its data. Only an explicitly disposable pre-release deployment may be recreated after the operator accepts the data loss.

There is no migration path from the earlier experimental password, Cloudflare Access, or shared-admin-token authority schemas. This restriction does not mean future releases may silently reset state. Versioned releases must document their supported upgrade origins and add forward migrations without editing applied SQL; see [operations and upgrades](operations.md).

Verify before upload:

1. The source and generated Wrangler configs each contain exactly one `AUTH_DB` binding.
2. The generated binding has the same non-empty database ID as the deployed Worker.
3. `migrations_dir` ends in `migrations/better-auth`.
4. Remote migration application succeeds and the recorded `0001` digest matches the checked-in file.
5. The Worker artifact was built after these checks and is the artifact being uploaded.
