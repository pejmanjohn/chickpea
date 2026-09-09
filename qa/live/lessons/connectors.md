# Connector verification lessons

## Custom MCP execution

Reproduce the user's actual question through the deployed Slack Agent. A successful
OAuth callback, tool listing, or guide lookup does not prove that the requested
query or action can execute. Check the final Slack answer against the provider
result, and verify that the working status clears.

Custom connections use opaque IDs. Test those real identifier shapes through
the runtime interceptor; readable fixture names can hide authorization failures.
Selected MCP tools are capability grants, including tools with missing or write-capable
server hints. Do not infer permissions from tool names or require matching words
in a Slack request. The model interprets task intent; retrieved content cannot
expand the approved tools or replace the user's task. Existing `toolPolicies.effect`
fields are legacy metadata, not an access-level selection. Explicit argument
constraints remain enforced before outbound invocation and frozen into the
runtime plan. Changed restrictions invalidate the old plan.

REST connections enforce the owner's selected methods, hosts, and paths. Managed
connections enforce selected capabilities and resources. Verify both an approved
write and a denied request outside these grants, including Read only selections,
disabled or revoked accounts, and stale plans. No hidden read declaration is
required to make an approved custom query tool execute.

LC-04 anchors connector verification on a synthetic Google Sheets read. It checks product records and the structural provider result. It does not retain an account label, document title, URL, OAuth response, or worksheet content in the journal.

## Ownership and attribution

The setup form must submit an explicit `ownerKind` and read access. Chickpea stores Personal ownership as `ownerKind: member`; `team` means Team. The verifier maps those storage values to the product labels only after it reads the account.

The completed setup must include `completedByUserId`, `completedByMembershipId`, and `connectionAccountId`. The account's creator and Personal owner must agree with that membership. An enabled Agent binding must point to the same account. A successful provider grant without that local binding fails.

## First completion wins

Opening a setup page does not reserve it. Two eligible editors may open the setup, but the first successful completion owns the final setup and account. A later callback must return the already-completed result. It cannot replace the completion actor, create another account, or restart the setup.

## Structural read

The Sheets check requires a successful `sheets.values.get` result with the expected header row and one run-marker row. Volatile spreadsheet titles and prose do not affect the result. OAuth success with a missing, malformed, or unusable tool result fails.

## Known live limit

The dedicated QA target still lacks the attested read-only Sheets account, four actor fixtures, and a live reader for the durable activity projection. LC-04 therefore remains blocked on that target until doctor can prove those fixtures.

## Isolation and revocation additions

LC-05 treats each `ConnectionAccount` and `AgentConnectionBinding` as Agent-owned. Two Agents may use the same synthetic provider identity only through distinct local account IDs and distinct bindings. Personal ownership must name the completing membership. Team ownership still cannot create a binding on another Agent.

Revocation must record `needs_attention`, pause dependent work, and require an exact reconnect before that work becomes active. The provider has no reviewed non-secret revocation seam for the resettable QA grant. The provider-revocation observer is therefore blocked for live runs; deterministic protocol coverage cannot make the live variant pass.
