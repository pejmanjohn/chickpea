# Phase 3 kickoff: provider-neutral MCP OAuth foundation

**Date:** 2026-07-24; evidence refreshed 2026-07-25  
**Status:** provider-neutral foundation implemented; Notion proved through live refresh  
**Target:** Phase 3a only

## Provenance

This plan reconciles the clean committed `main` branch at `3d0f6441` with:

- `docs/plans/2026-07-19-connector-presets-design.md`
- `docs/plans/2026-07-20-phase2-implementation.md`
- current official MCP, provider, and Claude Tag documentation

The two earlier plans were not present in any committed ref. They were copied
verbatim from the dirty main checkout into this isolated worktree under the
user's narrow authorization. The repository intentionally ignores `docs/`;
after the user requested a verified Phase 3 checkpoint commit, all three files
were deliberately force-added so those previously uncommitted design inputs
would not be lost. Do not infer implementation state from their presence.

## Facts established before implementation

### Existing Chickpea contract

- MCP connections support `none` and write-only `bearer` authentication.
- REST API connections support write-only credentials plus host, path, and
  method policy enforced at the fetch boundary.
- Secret values are stored separately from connection policy and do not appear
  in profiles, profile GET responses, browser state, model context, or sandbox
  environment.
- MCP credentials are resolved only when creating an MCP client or running an
  administrator connection test.
- `SettingsStore.applySettingsPatch` provides atomic compare-and-swap updates in
  both Node and Cloudflare implementations. This is a suitable primitive for
  OAuth transaction consumption and short leases.
- Profile deletion already has a staged cleanup mechanism for dynamic MCP
  settings keys.
- There is no Chickpea OAuth discovery, state/PKCE, callback, token storage,
  refresh coordination, or MCP OAuth header wiring on committed `main`.

### Current standards and provider evidence

- The current MCP authorization specification requires Protected Resource
  Metadata discovery, Authorization Server discovery, PKCE `S256`, state
  validation, and the OAuth `resource` parameter.
- The specification recommends Client ID Metadata Documents (CIMD) and permits
  Dynamic Client Registration (DCR). Chickpea will use CIMD only when the
  discovered authorization-server metadata explicitly advertises support, and
  will otherwise use DCR.
- The MCP TypeScript SDK version already locked transitively in this repository
  exposes discovery, DCR/CIMD selection, authorization, code exchange, refresh,
  resource validation, and PKCE helpers. Promoting the production v1 SDK to a
  direct dependency is smaller and closer to the MCP protocol than adding a
  second OAuth protocol library.
- Current official Notion documentation describes MCP OAuth with PKCE,
  discovery, DCR, exchange, refresh, and secure token storage. Notion also
  documents CIMD support, but its authorization-server metadata did not
  advertise CIMD during the 2026-07-25 live proof, so Chickpea correctly used
  DCR instead.
- Current official Linear documentation describes its Streamable HTTP MCP
  endpoint as an OAuth 2.1 flow with DCR, plus `read` and `write` scopes. A
  2026-07-25 read-only metadata probe additionally found that Linear currently
  advertises CIMD support as well as a DCR registration endpoint.
- Current official Airtable documentation supports DCR, manual OAuth, PATs, and
  a URL-form client identifier for clients that use CIMD.
- Prior research reached provider consent pages only. It did not prove a
  Chickpea callback, code-to-token exchange, refresh-token rotation, or runtime
  MCP authentication.
- Current Claude Tag documentation still supports Chickpea's architecture:
  administrators grant scoped service-account capabilities; credentials are
  separate from plugins/skills; sandboxes start without external access; and a
  proxy injects credentials without exposing them to the model or sandbox.

## Assumptions that remain unproven

- Linear will accept Chickpea's exact callback and client metadata behavior
  through registration, consent, code exchange, and refresh.
- A Notion reconnect will safely replace the current grant, and a live
  disconnect will remove Chickpea's local OAuth state without leaving an
  unexpected provider-side grant. Both are intentionally human-gated because
  reconnect requires consent and disconnect destroys the current test grant.
- DCR registrations can be safely reused across provider-specific lifecycle
  changes beyond the successful Notion registration and refresh proven here.
- Provider error and revocation behavior beyond the exercised Notion success
  path matches current documentation.
- If a provider later rejects a refresh token with `invalid_grant`, runtime
  correctly deletes the unusable token bundle and refuses the tool call, but
  the saved profile can continue to display its last `Connected` lifecycle
  label until the administrator tests or reconnects it. Reconciliation of that
  derived UI state is a follow-up rather than a reason to retain invalid tokens.
- The MCP SDK OAuth helper subset used here remains workerd-compatible after it
  becomes a direct dependency. Local typecheck/build is the first gate, not
  proof of a deployed Cloudflare provider flow.

These assumptions must not be represented as support for additional providers
or deployment environments until their own explicit proof is approved and
completed. The local Notion proof establishes interoperability for the tested
path only.

Primary references rechecked on 2026-07-24:

- Notion custom MCP client guide:
  <https://developers.notion.com/guides/mcp/build-mcp-client>
- Notion MCP connection guide:
  <https://developers.notion.com/guides/mcp/get-started-with-mcp>
- Notion MCP security guidance:
  <https://developers.notion.com/guides/mcp/mcp-security-best-practices>
- Claude Tag overview supplied for product-parity validation:
  <https://claude.com/docs/claude-tag/overview>
- Linear MCP server guide:
  <https://linear.app/docs/mcp>

## First slice: `3a-0`

Build only the provider-neutral backend needed for a later Notion or Linear
proof. Do not add provider presets, provider claims, speculative gallery UI, or
Phase 3b REST OAuth.

### Configuration and storage

- [x] Promote `@modelcontextprotocol/sdk` `1.29.0` to a direct dependency.
- [x] Add `oauth` to the MCP connection authentication mode in both schema
      sources and the TypeScript configuration type.
- [x] Keep OAuth client registrations, pending transactions, tokens, and leases
      in `app_settings`; never include their values in connection config.
- [x] Use a fixed, enumerable set of per-connection OAuth keys (client
      registration, pending transaction, token bundle, registration lease, and
      refresh lease) so existing profile deletion can stage cleanup without a
      new inventory subsystem. A new authorization start replaces the prior
      pending transaction for that connection.
- [x] Store optional DCR `client_secret`, registered `client_id`, access token,
      and refresh token as secrets. Responses and logs may expose only status
      and non-sensitive error categories.
- [x] Clear all fixed OAuth keys on connection removal, OAuth-to-non-OAuth
      edits, and profile deletion. Turn-time refresh rechecks the connection
      before and after writes so a concurrent deletion cannot repopulate an
      orphan token bundle.

### Discovery and authorization start

- [x] Discover Protected Resource Metadata and Authorization Server Metadata
      using MCP SDK helpers; never derive the authorization server from the MCP
      hostname.
- [x] Use a callback-origin CIMD URL only when the authorization server
      advertises `client_id_metadata_document_supported`.
- [x] Otherwise register once with DCR and atomically reuse the registration for
      the same connection, authorization server, and callback origin.
- [x] Generate high-entropy state and PKCE values. Store one short-lived pending
      transaction per connection, bound to its exact state, agent, connection,
      resource, authorization server, redirect URI, and code verifier. Encode
      only the validated agent/connection lookup plus random nonce in the state;
      the stored exact match is authoritative.
- [x] Add an administrator-authenticated start endpoint that returns only the
      provider authorization URL.

### Public protocol routes

- [x] Serve an HTTPS client metadata document containing the exact URL-form
      `client_id`, callback URI, authorization-code and refresh grants, and
      public-client token authentication method. Do not serve a shared secret;
      the authorization request itself always uses PKCE `S256`.
- [x] Add a public callback that atomically consumes one pending transaction
      before exchange, rejects missing/expired/replayed state, rechecks the
      target connection, exchanges the code, stores tokens, and redirects with
      a status only.

### Runtime authentication and refresh

- [x] Resolve OAuth access only at MCP client/test creation time and inject the
      bearer header there, preserving the existing credential boundary.
- [x] Refresh expired or near-expiry tokens behind a short compare-and-swap
      lease scoped to the connection.
- [x] Preserve a rotated refresh token atomically. On `invalid_grant`, clear the
      unusable token bundle and require reconnection; preserve it on transient
      failures.
- [x] Use `SettingsStore` leases rather than the Slack message claim store:
      OAuth is configuration-scoped, and the existing atomic settings primitive
      works in both runtimes without coupling authentication to Slack delivery.

## Verification gates

All tests use injected fake metadata and token endpoints. No credentials, live
OAuth requests, browser consent, or external client registration are permitted
in this slice.

- [x] Configuration round-trip accepts `oauth` without exposing secrets.
- [x] CIMD is selected only when explicitly advertised; otherwise DCR is used.
- [x] Concurrent starts reuse one stored DCR registration.
- [x] State mismatch, expiry, and replay fail; a valid callback exchanges once.
- [x] Callback and administrator responses never contain tokens or client
      secrets.
- [x] Concurrent refresh attempts perform one refresh and preserve rotation.
- [x] Runtime MCP creation and administrator testing receive the bearer header
      while profiles and policy responses remain secret-free.
- [x] Connection removal, auth-mode changes, and profile deletion remove every
      fixed OAuth setting, including during a refresh race.
- [x] Node 24 focused tests, full tests, typecheck, and production build pass.
- [x] A final diff review confirms no REST egress-policy regression and no live
      provider-compatibility claim beyond the unproven Notion test entry point.

## Follow-up slice: `3a-1` Notion live proof

This local-only slice prepared and then completed the first approved human proof.
Current official Notion documentation identifies
`https://mcp.notion.com/mcp` as the Streamable HTTP endpoint and describes OAuth
Authorization Code with PKCE, DCR, token refresh, and explicit user
authorization. The live evidence below proves Chickpea/provider interoperability
for the exercised local path; it is not a blanket deployment-support claim.

- [x] Add one Notion MCP preset with the official endpoint and an OAuth auth
      mode. Do not add Linear, Airtable, PostHog, Supabase, or Atlassian yet.
- [x] Add a guided administrator action that saves the connection policy before
      starting discovery/registration and then navigates only to an HTTPS
      authorization URL returned by the server.
- [x] Keep the authorization code, PKCE verifier, tokens, registered client
      secret, and provider errors out of profile config, client state, and the
      callback return URL.
- [x] Return success, cancellation, and exchange failure to the affected
      profile's Connections tab using status and connection identity only.
- [x] Keep a failed start recoverable in the saved connection editor.
- [x] Prevent an OAuth return notice from appearing on a different profile.
- [x] With the user present, prove live discovery and client identification,
      stop at and inspect the Notion consent boundary, then explicitly authorize.
- [x] Prove code exchange, authenticated tool discovery, and read-only tool use.
- [x] Prove expiry/refresh coordination and refresh-token rotation without
      printing token values or user content.
- [x] Add distinct reconnect and confirmed disconnect controls; locally prove
      that saving a disconnect removes policy plus every stored OAuth key.
- [x] With the user present, exercise the live reconnect consent path.
- [x] With the user present, exercise destructive live disconnect/cleanup.
- [x] Reconnect once more and restore the working Notion test grant.

### Live Notion evidence (2026-07-25)

- Protected-resource and authorization-server discovery completed against
  `https://mcp.notion.com/mcp`. The advertised metadata selected DCR, producing
  a stored registered-client record; CIMD was not selected.
- The user inspected and approved Notion's sign-in/consent flow. Chickpea
  validated and consumed state, exchanged the code, stored the token bundle,
  and returned to the correct profile without placing credentials in the URL or
  browser state.
- Authenticated discovery returned 20 tools. The guided flow selected all 20 by
  default, and the saved connection rendered a clear Connected state plus the
  returned workspace/user identity.
- Runtime calls to `notion-fetch` for `self` and `notion-search` succeeded. No
  write-capable tool was invoked, and result content was not printed into test
  output.
- A controlled expiry forced four concurrent runtime token resolutions through
  the real Notion refresh endpoint. All callers received the same effective
  refreshed access token; Notion rotated the refresh token; Chickpea persisted
  the rotated token, preserved the DCR client registration, and cleared both
  leases. A subsequent runtime `notion-fetch` succeeded.
- The user exercised Reconnect and approved Notion again. Chickpea completed a
  fresh callback about two minutes before verification, retained the DCR client
  record, stored an access/refresh token bundle, cleared pending and lease
  records, preserved the 20-tool approval set, and returned the same bounded
  workspace/account identity. A fresh real turn-time adapter resolution exposed
  all 20 tools and `notion-fetch { id: "self" }` succeeded without printing
  result content.
- The browser rendered Reconnect and Disconnect separately. The disconnect
  confirmation explains that tool approvals, tokens, and client registration
  are deleted on Save. Browser QA canceled before confirmation, preserving the
  working live grant.
- The user subsequently confirmed Disconnect and Save. The profile API then
  contained no Notion policy row, and direct settings inspection confirmed the
  client record, pending authorization, token bundle, registration lease, and
  refresh lease were all absent. The UI exposed one stale one-shot callback
  notice (`Connected to Notion. 0 tools enabled.`); a red/green regression test
  now clears that notice when its connection is removed and refuses to render a
  connected notice without a matching saved row.
- The user completed a final clean connection from the Available gallery. The
  restored profile is `ready`, contains the same bounded workspace/account
  identity, and has 20 saved approvals. A fresh DCR client record and
  access/refresh bundle are present; pending authorization and both leases are
  absent. Turn-time resolution exposed all 20 tools and a read-only
  `notion-fetch { id: "self" }` call succeeded without printing result content.
- The callback already persists all discovered tools as approved. The connected
  editor now says that access is saved and offers no redundant action until an
  operator changes a checkbox. A changed selection gets one dedicated
  `Save tool access` action that persists only MCP connection policy; it does
  not dirty the overall profile, while any unrelated profile draft remains
  unsaved and keeps the global footer visible.

### Linear read-only compatibility gate (2026-07-25)

- Official Linear documentation currently identifies
  `https://mcp.linear.app/mcp` as its read-write Streamable HTTP endpoint and
  `https://mcp.linear.app/mcp/readonly` as its server-enforced read-only
  endpoint. It says the interactive flow uses OAuth 2.1 with DCR.
- Live protected-resource metadata for `/mcp` matched the resource, advertised
  `read` and `write`, and identified `https://mcp.linear.app` as the
  authorization server.
- Live authorization-server metadata advertised authorization-code and refresh
  grants, PKCE `S256`, public-client token authentication, a registration
  endpoint, and `client_id_metadata_document_supported: true`.
- A transient isolated Chickpea start probe used a representative HTTPS
  callback, performed two metadata GETs, made no external write or registration
  request, selected CIMD according to the Phase 3 design, and constructed a
  `/authorize` URL without navigating to it. The current local HTTP loopback
  origin would instead fall back to DCR because a CIMD client identifier must
  be HTTPS.
- Linear has not been added to the gallery. Provider acceptance of Chickpea's
  URL-form client identifier remains unproven until the user is present to
  inspect the authorization boundary and choose whether to continue.

### Local verification evidence

- Node `v24.16.0`
- Focused OAuth route and disconnect lifecycle tests pass, including a
  red/green check that the state-bearing start response is `no-store`.
- Full `npm test`: 631/631 passed on Node 24, including project typecheck, the
  post-disconnect stale-notice regression, callback auto-save copy, immediate
  tool-access persistence, and preservation of unrelated profile drafts.
- Cloudflare `npm run build`: passed. The existing sandbox dynamic-import
  bundler warning remains unchanged.
- Node `npm run flue:build`: passed.
- `git diff --check`: passed.
- `npm run verify:oss-export` passed for committed `HEAD`, but is deliberately
  not counted as Phase 3 evidence: the script packages `git archive HEAD` and
  therefore excludes this uncommitted worktree slice. Re-run it after a future
  verified commit if this branch is landed.
- Local Node browser QA on port 3584: the saved Notion row reports Connected
  with 20 tools; the official mark renders cleanly; the editor shows bounded
  workspace/account identity, Reconnect, and Disconnect; and the destructive
  confirmation was inspected then canceled. Browser console: 0 errors and 0
  warnings after the authenticated navigation.
- An ignored local-only `.env` contains a fresh admin token, isolated Phase 3
  database paths, and a setup-only model fallback. It is test scaffolding, not
  deployment configuration.
- The initial verification above predated the approved live proof. The later
  proof performed Notion discovery, DCR, consent, exchange, authenticated tool
  calls, and refresh. No credential or user result content was printed. No
  commit, push, or deployment was performed.

## Explicitly deferred

- Provider gallery and guided OAuth expansion beyond the single unproven Notion
  test entry point.
- Linear gallery inclusion until its CIMD authorization boundary is inspected;
  Airtable, PostHog, Supabase, or Atlassian compatibility labels or
  provider-specific behavior. PostHog in particular requires a fresh
  compatibility probe before catalog inclusion.
- No remaining Notion lifecycle gate for the tested local Node path.
- Phase 3b BYO OAuth apps and Google Workspace.
- Push, deployment, and external OAuth client creation.

## Next human-in-the-loop gate

The tested local Notion lifecycle is complete: initial connect, reconnect,
refresh rotation/concurrency, disconnect cleanup, and clean restoration all
passed. The next provider gate must start with read-only metadata/documentation
validation and stop before any registration or human consent until explicitly
approved.
