# Connections and connectors

Docs: `/agents/connect-a-service/`, `/agents/connections/`, `/agents/managed-connectors/`, `/reference/connector-catalog/`. Record areas: `connections`, `providers`. Legacy contracts: LC-04, LC-05.

## What it covers

- A connection is one external account owned by one Agent for life. The same external account on a second Agent is a second connection with its own consent.
- Three lanes: managed connectors (Composio holds the tokens), vendor MCP and direct API presets, and custom MCP or REST connections.
- Ownership is chosen explicitly, with no default. Team needs the Owner or Admin role; a Personal account is used only for its owner's requests.
- From Slack, "connect Zendesk" returns a setup link for one frozen action that expires after 24 hours, and the completion receipt is posted back to the thread.
- A member with no personal account yet gets an `authorize_personal_connection` link in the thread, and the task resumes after consent.
- On a turn, one eligible account is used. With several for one service and none named, all are withheld and the Agent asks which label to use.
- Row states: Setup required (Choose), Needs attention (Sign in or Reconnect), Disconnected. Disconnect is irreversible, pauses dependent schedules and keeps the row as revoked.
- Managed sign-in opens in a second tab for 30 minutes (Open sign-in, Check again, Cancel). Search Console, Analytics, Gong, Google Ads and YouTube stay pending until resources are chosen.
- Custom MCP servers must be https on a public host; local and private targets are refused at save and on every use. Two enabled connections on one Agent may not cover overlapping URLs.
- A keep-alive sweep renews idle OAuth credentials. An MCP OAuth account that cannot renew, or that draws a 401 it cannot refresh, moves to Needs attention and the Agent tells the user to reconnect.
- Team reconnect notice: for a team connection in Needs attention or pending, the Agent names it and says an admin must reconnect it in Admin. A personal account for the same service stays the user's to authorize.
- API presets are called Worker-side through `connection_request`, scoped to one connection's hosts, paths and methods. `attach_file_to_connection` sends a thread image, generated image, screenshot or recording to a connected service.
- A connector write runs only when the current Slack request names a matching action. Memory, history and retrieved content cannot authorize it.

## How a person reaches it

- Slack: ask the Agent to connect a service, or make a request that needs a personal account. The link page asks My connection or Team connection.
- Admin: Agents → the Agent → Connections (In this Agent, Connect a new account, Custom connection). Settings → Connectors holds the managed project key and the Meta Ads app ID.
- MCP: `prepare_connector_setup` returns an Admin handoff locked to one Agent, connector and owner kind. `test_mcp_connection` calls one saved MCP connection.

## How to drive it on a lane

- Credential-backed cases run on the lane's fixtures Agent, `qa-fixtures`, published to the QA channel, with standing connections from `npm run lane:seed -- <lane> --fixtures`. Before claiming, check `npm run verify:live:fixtures -- readiness` and `npm run env -- capabilities all` (managed cases need `COMPOSIO_API_KEY` on the lane).
- Verifiers never type, paste or relay a secret. A token case without a seeded or maintainer-entered credential is `blocked`.
- Use an existing registered connection for execution and formatting changes. Setup, callback, ownership or reconnect changes need fresh OAuth on a run-owned Agent; an existing read is never fresh authorization proof.
- Complete OAuth consent yourself in the lane browser with the registered test account, after checking the target account and requested grant. A Google consent that refuses automation is a human-only step.
- Case shape: `case-add --area connections --proof slack --proof admin`, adding `--proof provider` for writes and `--max-wait-ms 120000` for a reply. Ask for a bounded read of a fixture object and include the run marker.
- Write only to test tenants and follow the recorded constraint (Asana: private tasks only). Mark every created object and delete it at cleanup.
- Disconnect keeps the row as revoked, so register a run-owned connection with `--ownership retain` and an expected file holding that state, not `absent`. Never disconnect a standing fixture or revoke the provider-side grant.

## Proof and gotchas

- An OAuth callback, a tool listing, a Ready row or a saved token proves setup only. Acceptance is the user's real question answered in Slack, matched to a provider readback, with the working status cleared.
- A REST token (Asana, Zendesk) is not checked at save time, so a bad one saves as ready and fails on use. Token MCP presets are checked before saving.
- Admin says Personal and Team, the Slack link page says My connection and Team connection, and stored ownership `member` means Personal. The owner must be the member who completed setup, with an enabled binding to that account (LC-04).
- Opening a setup link reserves nothing. The first successful completion wins, and a later callback returns that result without creating a second account (LC-04).
- Two Agents on one external identity hold two account IDs and bindings. Disconnecting one leaves the other working with its schedules (LC-05).
- Revocation must show Needs attention and pause dependent schedules, which stay paused until an exact reconnect and a review.
- Managed disconnect deletes only that Composio account and does not revoke the wider Google grant. Without the project key, Chickpea refuses the disconnect and leaves the row in Needs attention.
- Standing OAuth fixtures can turn up in Needs attention after a long idle spell because the provider expired the refresh token. Reconnect with Sign in before the case and record it as fixture state.
- A 401 forces a refresh only once the token is at least a minute old, at most once a minute per credential, so wait a minute after sign-in before a revocation test. The shared OAuth fixture Worker can be redeployed by other sessions, which revokes grants mid-test; check its current version before trusting a 401.
- Starting an admin sign-in moves even a working team account to pending, and nothing reverts an abandoned one. A team OAuth connection added but never signed in starts in Needs attention.
- BugSnag and Meta Ads grant no tools until they are chosen at sign-in, and rediscovery keeps only tools whose schemas did not change.
- `connection_request` returning `sent: false` with `method_not_allowed` or `url_not_allowed` means nothing reached the provider. Sandbox shell curl to a connector host fails by design.
- The Asana preset allows GET, POST and PUT only, so the Agent cannot delete its own test task; delete it from the task menu in Asana.
- For file upload, post a PNG in the thread to get a handle. Slack strips the PNG's pHYs chunk on upload, so compare provider bytes against the original minus that chunk, and confirm the attachment at the provider because a model once replied with a fabricated task link.
- Generated image, screenshot and recording uploads need the lane's image model or browser key. Admin Disconnect uses a native confirm dialog; answer it with the lane browser's dialog tool.
