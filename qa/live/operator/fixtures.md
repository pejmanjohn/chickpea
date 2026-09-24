# Private fixture declarations

Check fixture availability while selecting scope, before occupying a lane. Use
the existing private attended spec and a separate private inventory of registered
fixtures. This read-only helper checks declarations and freshness; it neither
reserves a fixture nor proves live access, creates authorization, or obtains
credentials. Follow the actor/context checks in [environments.md](environments.md)
and the ordinary run `preflight` in [records.md](records.md).

```sh
npm run verify:live:fixtures -- readiness --spec /private/path/spec.json \
  --inventory /private/path/fixtures.json --operation read --reset-rights restore
# For an upgrade/restore pair, also pass --from RELEASE_ALIAS --to RELEASE_ALIAS.
```

Exit 0 means the selected fixture declarations pass these advisory checks. Exit 1
lists per-case blockers; exit 2 means invalid input. Cases with no fixture
requirements have no fixture blockers; they still need their actors, browsers,
and authoritative live readbacks. An empty declaration set is not release proof.
Use operation and reset selectors for the actual planned action. The helper
applies them to all required fixtures in the supplied spec; split unlike fixture
operations into separate preflight specs while retaining the full run scope.

The inventory uses `chickpea-live-fixture-inventory/v1`. Each required capability
with `kind: fixture` resolves through its `identity` alias, or its capability ID
when identity is absent. Every fixture entry has exactly these fields:

```json
{
  "schemaVersion": "chickpea-live-fixture-inventory/v1",
  "observedAt": "REPLACE_WITH_CURRENT_UTC_READBACK_TIME",
  "fixtures": {
    "synthetic-provider-rows": {
      "lifecycle": "reusable",
      "allowedOperations": ["read", "write"],
      "resetRights": "restore",
      "registeredModel": null,
      "credentialHandle": "registered-test-provider",
      "owner": null,
      "expiresAt": "REPLACE_WITH_EXPIRY_TIME",
      "supportedPairs": [],
      "evidenceHash": "REPLACE_WITH_SHA256_DIGEST_OF_RETAINED_READBACK"
    }
  }
}
```

Replace every placeholder from real evidence before use. Keep the readback and
its `sha256:` digest privately; the helper validates digest syntax, not the
underlying evidence. The run notebook separately hashes its evidence files.
`credentialHandle` is an approved mechanism's alias, never a key, token, password,
cookie, local path, or setup URL. It does not grant permission to read credentials.
`registeredModel` is the exact selector when a fixture requires one; null means
no model constraint. Do not substitute models to clear a mismatch.

Lifecycle is `reusable`, `reserved_user_trial`, `disposable`, or `unavailable`.
Reserved user trials require an owner alias and always block automated use;
release that reservation only through the owner's agreed process. Reset rights
are `none`, `restore`, or `dispose`. Reusable resources require retained exact
before-values; disposable resources require exact ownership and cleanup receipts.
`supportedPairs` contains explicit `{ "from": "alias", "to": "alias" }` upgrade
or restore pairs. An empty list cannot satisfy a requested pair.

Inventory snapshots expire after 24 hours by default. `--max-age-ms` can select
a stricter observation window, or an explicitly justified longer one up to seven
days. Future or stale snapshots block dependent cases, as do expired fixtures and
unavailable, stale, or wrongly scoped capabilities. A null fixture expiry does
not disable snapshot freshness. Recheck after a lane, actor, model, grant, or
fixture change regardless of age.

If registration is missing, gather the exact target/account, allowed operations,
model, reset rights, lifetime, and evidence in one request while independent work
continues. Do not infer those values. Borrow a standing lane only through the
[exclusive installation reservation](environments.md#borrow-a-lane-for-a-fresh-install). A production
provider account, disposable Slack installation, cross-account actor, restore
pair, or local state migration may need separate provisioning work. This helper
makes those gaps visible; it does not implement that infrastructure.

## Credentials

Verifiers never type, paste, or relay a secret, even when a maintainer offers
one in chat. If a secret appears in a transcript, stop using it and report it
for revocation. Credential-backed cases use standing QA fixtures:

- A maintainer enters the test credential once per lane, on a standing QA
  connection that the fixture inventory registers under a `credentialHandle`.
  Token credentials come from the lane secrets file through
  `npm run lane:seed -- <lane> --fixtures`, which puts them on the lane's
  standing `qa-fixtures` Agent; OAuth and managed connectors are finished there
  through the Admin setup link it returns. See
  [environments.md](environments.md).
- A connection belongs to exactly one Agent and cannot be shared with or moved
  to another, so run-owned Agents cannot reuse a fixture connection.
  Credential-backed cases run on the `qa-fixtures` Agent. Do not create a new
  connection for each run. If a case truly needs its own Agent, seed it with
  `--agent`, register those connections as run-owned, and disconnect them at
  cleanup.
- A reseed reports `stale` when the lane secrets file holds a different
  credential than the one seeded. Rerun with `--replace` to rotate it in
  place; do not delete and recreate the connection.
- The credential belongs to a test tenant, such as a test workspace, project,
  or account. A case that would write to a real person's or company's tenant
  is blocked until a test tenant exists. Do not run it against real data.
- A lane secret the product reads from its environment reaches the lane only
  through `CHICKPEA_DEPLOY_SECRETS_FILE` (see
  [environments.md](environments.md)). Update the lane capability matrix
  afterward.

If the fixture is missing, ask for it once during the kickoff preflight, keep
dependent cases blocked, and finish the rest.
