# Connectors: following the Claude Tag architecture (open-source)

**Status:** Draft v2 for review · 2026-07-19
**Direction (per maintainer):** Chickpea's end-state is a fully sandboxed, coding-capable agent — an open-source alternative to Claude Tag. Follow Claude Tag's design unless there is a very clear reason to diverge; every divergence below is called out explicitly with its reason.
**Research basis:** 17 agents over three sweeps on 2026-07-19: codebase maps, adversarially fact-checked web research, and a primary-source read of Anthropic's Claude Tag docs (claude.com/docs/claude-tag/*, code.claude.com sandboxing/plugins docs, github.com/anthropics/claude-tag-plugins). Quotes below are verbatim from fetched docs.

---

## 1. Summary

**Claude Tag's connector architecture, verified from Anthropic's docs (§2):** a per-thread sandbox with default-deny egress; an **Agent Proxy** that injects credentials from a separate credential store into outbound requests matching per-connection host/path/method rules ("the model and the sandbox itself are not given the key"); **connections** (credentials) decoupled from **plugins** (skills that teach the REST API); and **MCP supported but second-class** — the Recommended path for every connector in their library is a raw HTTP API credential ("This is an HTTP API connection, not an MCP server" — Datadog connection doc), with MCP available only via a plugin-carried `.mcp.json` plus a host credential.

**Chickpea already has more of this than expected.** The sandbox library we ship (`just-bash`) contains the Agent Proxy primitive natively: `NetworkConfig.allowedUrlPrefixes` with per-URL header `transform`s applied at the fetch boundary ("secrets never enter the sandbox"), path-prefix matching, method allowlists, and a DNS-rebinding-aware private-range guard. Today we run it wide open and unconfigured. Chickpea also already has: a skills system (the plugin analog), write-only credential storage, and working MCP connections.

**Roadmap — converge on Claude Tag in three phases:**

| Phase | What | Claude Tag analog | Effort |
|---|---|---|---|
| **1. MCP preset gallery** | Curated one-click connector cards prefilling the existing MCP form (~16 platforms, verified catalog §6) | their connector *gallery UX* (Recommended/Advanced modal) | days |
| **2. The Claude Tag core** | Default-deny egress + **credential connections** (host allowlist + path prefixes + header template, injected at the fetch boundary) + **connector skills** (per-platform SKILL teaching the REST API with placeholder env vars) | Agent Proxy + connections + plugins | ~1–2 weeks |
| **3. OAuth** | 3a: CIMD/DCR OAuth for vendor **MCP** servers (no app registration needed — OSS-unique). 3b: bring-your-own-OAuth-app for vendor **REST** APIs (Advanced only) | their OAuth credential types | ~2–3 weeks |

Phase 1 ships first because it is days of work on plumbing that already exists and it delivers the gallery UX immediately. Phase 2 is the strategic convergence step and becomes the **primary** connector lane over time, matching Claude Tag. Deliberate divergences from Claude Tag and their reasons: §3.

**Rejected:** Nango (§9), third-party brokers (§9), runtime dependence on the MCP registry (§8 — CI-only).

### Spike validation (2026-07-19)

Three throwaway spikes were run against live systems (scratchpad only; the disposable `cimd-spike` worker was deleted afterward). Everything below in this doc reflects their results.

- **Credential injection (just-bash, Node + workerd):** confirmed end-to-end. Injected headers never appear in sandbox env/shell or `curl -v` output; path prefixes are segment-aware; method allowlists enforce with named errors; redirects re-evaluate transforms per-hop (no cross-host credential leak) and re-check the allowlist. Overhead ≈ 0.75 ms. **One blocker:** `denyPrivateRanges: true` breaks on workerd — the DNS-rebinding sub-check fails closed (`node:dns.lookup` unavailable), blocking *every* hostname. See §5.1 for the launch stance.
- **CIMD/DCR (live, from a random workers.dev domain, zero pre-registration):** **DCR is the workhorse — 7/7 providers accepted a live registration (HTTP 201) and rendered a real consent page with our redirect URI** (Linear, Notion, Supabase, Airtable, Sentry, Cloudflare, Atlassian). CIMD is real but narrow: only 4 providers advertise it; works live on Linear, Notion, Airtable; **Canva rejects self-hosted redirect hosts despite advertising CIMD**. No provider supports RFC 7592 registration cleanup. `oauth4webapi` runs clean on workerd. Flow verified to the consent page only — token exchange needs a human login (open question §11.5).
- **Catalog smoke (repo's own `discoverMcpTools`):** DeepWiki (3 tools, ~78 ms median) and keyless Context7 connect clean. **Launch-blocker bug found: missing-token 401s from Linear/GitHub/Notion/Sentry misclassify as generic `mcp_connection_failed` ("Check the URL")** — Flue's error carries the status only in numeric `err.code`, which `classifyMcpError` never reads (fix in §4). A wrong transport hangs to the 8 s deadline rather than failing cleanly — presets must pin transport.

---

## 2. Claude Tag's actual architecture (verified 2026-07-19)

Claude Tag = Claude operating in Slack channels under its own identity (launched 2026-06-23, Team/Enterprise beta, runs Opus 4.8, replaces Claude-in-Slack). Load-bearing facts for us:

### 2.1 Execution environment
- Per-thread **sandboxed VM** ("the same managed compute behind Claude Code on the web"), ephemeral, real code execution.
- **Egress is default-deny**: "Outbound traffic from a channel session's sandbox is default-deny. Requests go only to hosts an allow layer covers."
- **Agent Proxy** is "the network layer that injects credentials into Claude's outbound requests… adds the credential at the network boundary when a request matches the rules." Credentials live in a separate store: "the credentials you provision are not placed in the sandbox; they stay in the credential store… the model and the sandbox itself are not given the key."
- Three egress outcomes: request matches a credential rule → injected; matches only the domain allowlist → sent uncredentialed; no match → blocked.
- The open-source-visible blueprint is Claude Code's sandbox `mask`/`injectHosts` mechanism (code.claude.com/docs/en/sandboxing): sandboxed process sees a sentinel; the proxy substitutes the real value only for `injectHosts` ⊆ `allowedDomains`, TLS-terminating so it can rewrite requests; fails closed.

### 2.2 Access bundle anatomy
A bundle = "a named set of connections, domain entries, repository access, and rules," attached to a scope (default / workspace / channel):

| Tab | Contents |
|---|---|
| **Credentials** | *Connections* — one service credential each. ~10 credential types on the custom form: Bearer, Basic, body parameter, AWS SigV4, GCP access token, GCP IAP, OAuth2 JWT-bearer, OAuth2 client-credentials, OAuth2 auth-code (3-legged), GitHub App. Per connection: **Allowed websites** (host, leftmost-label wildcard), optional **path prefixes**, **custom headers**, and method restrictions ("allowing GET but not DELETE"). "Never displayed again" after save. |
| **Repositories** | GitHub grants via a dedicated GitHub App (not the credential store). |
| **Domains** | The uncredentialed outbound host allowlist. |
| **Plugins** | Bundles of **Agent Skills** attached to the scope — "teaching Claude how to use a specific tool." |
| **Instructions** | Free-text rules carried into covered channels. |

### 2.3 Connections and plugins are decoupled
The connection provides the credential; the plugin provides the know-how. Datadog doc: "Pair this connection with the Datadog plugin from Anthropic's plugin marketplace so Claude knows how to call the API." The public marketplace (github.com/anthropics/claude-tag-plugins) shows each plugin is just `SKILL.md` + `references/` (endpoint catalog, read on demand) + `scripts/` (curl helpers). Critically: "Plugins contain no auth setup instructions — authentication is handled by the runtime. The environment variables each plugin references (`$DD_API_KEY`, …) exist only to keep requests well-formed and may hold placeholder values" — i.e. skills write requests with sentinel env vars and the proxy injects the real value.

### 2.4 Where MCP stands in Claude Tag (the key question, answered)
- **The Recommended path for every library connector is a raw REST credential, explicitly not MCP.** Datadog: "This is an HTTP API connection, not an MCP server or a personal claude.ai connector." Salesforce: JWT-bearer OAuth → "REST API requests," "no MCP server."
- **MCP is supported, second-class, via plugins:** "1. Add a plugin with `.mcp.json` pointing to the server URL. 2. Add a credential for the server's host on the Credentials tab." The plugin format supports `.mcp.json`; none of Anthropic's shipped Claude Tag plugins use it (skills-only).
- **Personal claude.ai MCP connectors apply only in DMs**, never in shared channels: "Connector … personal; in Slack they apply only in DMs."
- OAuth in Claude Tag is **OAuth-to-vendor-REST-API** (3-legged, client-creds, JWT-bearer), never OAuth-to-vendor-MCP.

**Why this design (from their engineering posts):** a frontier coding model in a sandbox calls raw APIs more capably and more token-cheaply than through MCP tool schemas (their measured 150K→2K example); the proxy+allowlist is what makes a broad credential safe; and REST covers the long tail (every org's internal services) that MCP never will. The trade they accept: no per-action tool approval — mitigated by method restrictions, path prefixes, and the egress allowlist.

---

## 3. Chickpea's convergence plan and the (few) deliberate divergences

We adopt the Claude Tag shape: **connection (credential) ≠ plugin (skill); egress default-deny; credentials injected at the network boundary; raw-REST as the eventual primary lane; MCP available.** Mapping:

| Claude Tag | Chickpea equivalent | Status |
|---|---|---|
| Sandbox per thread | `just-bash` in-process interpreter per turn (in-memory FS, model-visible `bash`) | exists; runs wide-open today |
| Agent Proxy (credential injection, default-deny) | `just-bash` `NetworkConfig`: `allowedUrlPrefixes[].transform.headers` at the fetch boundary, `denyPrivateRanges`, `allowedMethods` | **library ships it; we must configure it** (Phase 2) |
| Credential store ("never displayed again") | `app_settings` write-only secret store (exists for MCP; add `connector.*` namespace) | exists |
| Connections (host allowlist + path prefixes + headers + method limits) | new `ApiConnectionConfig` policy record + admin CRUD (mirror of `McpConnectionConfig`) | Phase 2 |
| Plugins (SKILL.md + references + scripts) | Chickpea skills system (markdown instructions, progressive disclosure; skill import exists) + per-connector skill shipped with the preset | Phase 2 |
| Domains tab | egress allowlist setting (uncredentialed hosts) | Phase 2 |
| Repositories tab | out of scope for now (future: GitHub App) | later |
| Instructions tab | per-profile instructions | exists |
| Connector gallery (Recommended/Advanced) | preset gallery UI (Phase 1, on MCP; Phase 2 entries add credential+skill presets) | Phase 1 |

**Divergences — each with the "very clear reason":**

1. **MCP remains a first-class connection type** (Claude Tag buries it in plugins). Reasons: (a) it's already built, tested, and live in Chickpea — demoting it deletes working value; (b) vendors now ship official remote MCP servers whose curated tools substitute for the skill-authoring work Anthropic does in-house — for a solo OSS maintainer, Linear's MCP server is a free, vendor-maintained "plugin"; (c) per-tool approval is our only per-action gate, and Chickpea installs bring their own models — often below the frontier tier Claude Tag assumes (Opus 4.8), where curated tools outperform raw-API code; (d) OAuth without app registration exists **only** on the MCP lane (CIMD/DCR — §7); vendor REST OAuth requires registered client apps, which an OSS project cannot ship. Both lanes share the gallery, the secret store, and the egress boundary, so the cost of keeping MCP is ~zero.
2. **No hosted services.** No central credential store, marketplace service, or managed sandbox — catalog, skills, and proxy config ship in-repo; state lives in each install's DO. Reason: OSS/self-hosted constraint (the reason this project exists).
3. **The "sandbox + proxy" is in-process, not a VM.** just-bash's fetch-boundary injection gives the same security property (secrets never enter the model context or the interpreter's environment) with zero infrastructure. Reason: Cloudflare-Workers deploy-button distribution. Documented upgrade path when "handle coding" becomes real: swap the session env for real containers (e.g. Cloudflare Sandbox SDK) behind the same `NetworkConfig`-shaped policy — the connection records and skills don't change.
4. **Credential types start small:** Bearer / Basic / custom header (+ OAuth per §7). SigV4, GCP IAP, JWT-bearer etc. come later as demand appears. Reason: solo-maintainer scope control.

**Security model, stated plainly** (this is the design Claude Tag's choice encodes, and ours after Phase 2): the credential never appears in the model's context, the sandbox, or the admin API responses (spike-verified, with one narrow exception — header-echoing response bodies — handled in §5.2). It is added to a request only at the egress boundary, and only when the request's host (and optional path prefix + method) matches that credential's rules. A prompt-injected agent therefore can't read the key, can't send it anywhere else, and can't use it outside the allowed host/paths/methods. What remains (accepted, as Claude Tag accepts it): within those bounds the agent can take any action the credential permits — bounded by method limits (e.g. GET-only connections), path prefixes, and scoped tokens, which the preset catalog should default to conservatively.

---

## 4. Phase 1 — MCP preset gallery (ship first)

Unchanged from v1 of this doc in mechanics; now explicitly the *gallery UX* step of the Claude Tag convergence, shipped on the lane that already works.

**Prerequisite fixes (spike-proven, small):**
1. `classifyMcpError` must read the numeric `err.code` before its message-substring checks: `401`/`403` → `unauthorized`. Verified live: Linear/GitHub/Notion/Sentry all throw with `err.code === 401` and messages containing neither "401" nor "unauthorized", so today every token-gated card would say "Check the URL" — the worst message for a correct URL missing a token. (404 stays generic; DNS failures carry no code and stay `network` — both verified not to over-fire.)
2. Presets pin `transport`; the Recommended view exposes no transport toggle. A wrong transport doesn't error — it hangs to the 8 s connect deadline with a misleading "did not respond in time" (verified; `mcp-test.ts`'s custom deadline is load-bearing, Flue's own `timeoutMs` would not have bounded it).

- **Catalog** (`src/config/presets.ts`, static, typed, in-repo — Activepieces-style entries): `{id, name, logoSvg, category, mcp?: {url, transport, auth: none|bearer|header(+valuePrefix), oauth?}, api?: {hosts, pathPrefixes?, headers, methods?}, skill?: {…}, tokenDocsUrl, tokenDocsHint, notes}`. The `api` and `skill` blocks are the Phase 2 light-up; entries are lane-agnostic by design.
- **Server change:** optional `presetId?` on `McpConnectionConfig` + the Valibot mirror (both sources of truth; keep optional — snapshots deserialize without coercion). Nothing else.
- **UI:** "Add connection" → preset card grid (+ "Custom connection" → today's raw form). Selecting a card seeds the existing `connectionEditor`; a `.seg` Recommended/Advanced toggle shows either the locked one-token view (placeholder, "Where do I find this?" link, test button) or the full form. Same save/test/secret pipeline.
- **Day-one catalog (16, all verified working with existing bearer/custom-header code):** Linear, GitHub, Sentry (⚠ `Authorization: Sentry-Bearer `), Stripe (`rk_`), Cloudflare (2–3 per-product servers), Supabase, Neon, PostHog, Airtable, Monday, Intercom (US-only), PayPal, Context7 (⚠ `CONTEXT7_API_KEY` header), Exa (⚠ `x-api-key`), Firecrawl, Hugging Face, plus DeepWiki (no auth — zero-config first card). Full survey with URLs/auth/tiers: Appendix A.
- **Excluded from one-click** (reachable via Advanced): Figma, Vercel, ClickUp, Square-remote (vendor-approved client allowlists), Asana, HubSpot (no DCR), Salesforce (per-org), Google (no DCR/CIMD on their MCPs), Atlassian (Basic + org-admin-gated), Zapier (per-user URL), Notion/Canva (OAuth-only → Phase 3a).
- **Landmines baked into the schema:** per-preset header name + value prefix (four platforms break a hardcoded `Bearer`); client-side prefix concatenation so the server secret pipeline is untouched; pinned current URLs (Atlassian `/v1/sse` died 2026-06-30; Asana `/sse` died 2026-05-11).

## 5. Phase 2 — the Claude Tag core: egress policy, credential connections, connector skills

**5.1 Egress default-deny.** Replace the CLI-default `new Bash({network: {dangerouslyAllowFullInternetAccess: true}})` with per-turn assembly: `allowedUrlPrefixes` = connector rules (credentialed) + operator "Domains" list (uncredentialed); an operator egress-mode setting (`allowlist` default on fresh installs / `open` / `off`) — the open-`curl` status quo becomes an explicit choice, not a default. This is also a standalone security fix (closes the known wide-open-egress residual) and the prerequisite for credential injection (with open egress, injected-credential *responses* are exfiltratable).

**Spike-forced decision on `denyPrivateRanges`:** on workerd the DNS-rebinding sub-check fails closed (`node:dns.lookup` unavailable) and blocks *every* hostname, so `denyPrivateRanges: true` cannot ship as-is on the Cloudflare target. **Launch stance: lexical private-IP blocking + strict host allowlist on workerd** (the lexical block — literal `10.x`, `169.254.169.254`, loopback — was verified working there, and a Workers deploy has no private network to rebind into, so the allowlist carries the lettered-host SSRF load); full `denyPrivateRanges: true` on the Node target (verified working, including a real DNS-resolution rebinding check). Follow-ups, either order: supply a DoH-based `_dnsResolve` on workerd (note it's marked `@internal`), or upstream a just-bash fix so the check degrades to lexical when no resolver exists instead of failing closed.

**5.2 Credential connections (Agent Proxy equivalent).** New `ApiConnectionConfig` policy record mirroring the Claude Tag custom-connection form: name, allowed websites (host, leftmost wildcard), optional path prefixes, header template (name + value prefix), allowed methods, enabled. Secrets under `connector.<agentId>.<connectionId>.*` in the existing write-only store. Wired into `allowedUrlPrefixes[].transform` at turn time — the model's `curl` to a matching host+path gets the header injected at the fetch boundary; anything else on that host without a match is blocked or sent uncredentialed per the Domains list. Admin CRUD clones the MCP connection UI (same list-row + editor idioms, same source-only secret display). Test = a preset-defined probe request (e.g. `GET /viewer` for Linear) executed server-side — **choose probes that don't echo request headers** (see caveat below).

Spike-verified properties we inherit from just-bash rather than build: segment-aware path-prefix matching (`/get` ≠ `/getsomething`), method allowlisting with named errors, and — the highest-risk bug class in any credential proxy — safe redirects: transforms are re-evaluated per hop against the current URL (host A's credential is never re-sent to host B) and every redirect target is re-checked against the allowlist. Overhead ≈ 0.75 ms/request.

**Honest caveat for §3's security claim:** "the secret never enters model context" holds for the sandbox env, shell vars, and even `curl -v` output (verified — verbose mode prints no injected headers). The one leak vector is a *response body* that reflects request headers (echo/debug endpoints). Real vendor APIs don't echo `Authorization`, and default-deny egress blocks exfiltration of anything that does leak — but scoped/read-only tokens remain the right default recommendation, and a cheap extra belt: scrub known secret values from tool output before it reaches the model (we hold the values server-side).

**5.3 Connector skills (plugin equivalent).** Chickpea already has skills (markdown, progressive disclosure) and skill import. Per Claude Tag's shipped plugins, a connector skill = "how to call this REST API" instructions + a reference of key endpoints, written against placeholder env names (`$LINEAR_API_KEY`) that the injection layer makes real at the boundary. Presets bundle their skill (`skill` block in the catalog entry); attaching the connector attaches the skill, mirroring "Include Linear plugin." Community connector packs = preset + skill in one PR.

**5.4 What we explicitly don't build here:** a TLS-terminating standalone proxy (just-bash injects pre-TLS inside the process — same property, no MITM infrastructure); sentinel-substitution in arbitrary subprocess env (no real subprocesses exist in just-bash); SigV4/GCP credential types (later).

**5.5 Framework boundary (Flue vs Chickpea).** Phase 2 needs no Flue fork: `AgentRuntimeConfig.sandbox` is the supported seam for replacing the CLI-scaffolded default env, and the injection primitive lives in `just-bash` (a Flue dependency), so Chickpea can supply a configured `Bash` per turn today (confirm exact wiring at implementation time). The split: **policy domain is ours** (connection records, credential store, presets, skills, per-profile `NetworkConfig` assembly — product concerns, beyond framework scope); **the seam and the default are Flue's**, and two things should be upstreamed as issues/PRs rather than owned here: (a) the scaffolded default `dangerouslyAllowFullInternetAccess: true` should become `denyPrivateRanges: true` at minimum — a known exposure we previously assessed — **but note the spike finding that this flag fails closed on workerd** (DNS sub-check can't resolve; §5.1), so the upstream ask must include the lexical-degrade fix (§11.6) or it would break workerd apps; (b) a first-class per-agent `network`/egress option on `defineAgent`, so apps set an allowlist without replacing the whole session-env factory. If Flue later ships (b), our policy assembly migrates onto it; the connection records and skills don't change.

## 6. Phase 3 — OAuth

**3a — vendor-MCP OAuth, DCR-primary with CIMD fast-path (the OSS-unique capability).** Live-tested 2026-07-19 from a random workers.dev domain with zero pre-registration:

- **DCR (RFC 7591) is the primary mechanism.** It worked end-to-start on **7/7 providers tested** — Linear, Notion, Supabase, Airtable, Sentry, Cloudflare, Atlassian: HTTP 201 registration, then a real consent page accepting our random-domain redirect URI. 16 of 18 surveyed servers expose a registration endpoint (only Asana and HubSpot don't). The earlier "CIMD-then-DCR" framing was backwards for reliability.
- **CIMD is the fast-path where advertised** (skips the registration round-trip and, crucially, avoids orphaned registrations). Advertised by only 4 providers; live-verified on **Linear, Notion, Airtable** (all rendered our client_name on a real consent page). **Canva advertises CIMD but rejects self-hosted redirect hosts** ("Invalid redirect URI. It must be from an allowed host") — dropped from the launch set. Also refuted: "@cloudflare/workers-oauth-provider servers inherit CIMD" — Cloudflare's own server and Sentry report `client_id_metadata_document_supported: false`. Never assume; read the live AS metadata.
- **Registrations are permanent: no tested provider issues an RFC 7592 management token**, so a DCR client can never be deleted. Hard requirement: **persist and reuse the registered client_id per (connection, AS)** across reconnects — re-registering leaks an orphan every time and compounds the refresh-orphaning failure mode below.
- **Supabase registers a confidential client** (returns a `client_secret`, doesn't offer `none` token auth) — the token store must hold an optional client_secret per connection, write-only like everything else.
- **Discovery must follow the metadata chain, never derive the AS from the MCP URL**: the issuer differs from the MCP host on Atlassian (`cf.mcp.atlassian.com`), Airtable, Supabase, Stripe, Vercel; and Intercom/Atlassian 401 *without* the spec's `resource_metadata` pointer, so the client needs the conventional well-known fallbacks.
- **`oauth4webapi` confirmed on workerd** (v3.8.6: discovery, PKCE S256 via WebCrypto, no polyfills).

Mechanics otherwise as before: public routes in `src/app.ts` (`/.well-known/…client-metadata.json`, `/oauth/callback`); state+PKCE keyed by `state` in `app_settings`; tokens (+ optional client_secret, + registered client_id) under `mcp.<agent>.<conn>.oauth.*`; widen `authMode` picklists in both schema sources. **Refresh concurrency remains the hard part** (alarm drains 4 concurrent job groups; `setSetting` is last-writer-wins): gate refresh behind the existing claim-store advisory lock or refresh pre-fan-out in the alarm. **Launch targets: Notion (OAuth-only — its `ntn_` tokens aren't accepted as bearer) + Linear and Airtable upgrades; Supabase once client_secret handling lands.** Promising upside discovered: Atlassian's DCR worked live to the consent page — it may graduate out of Tier 3 for the OAuth lane (unverified past consent), and ClickUp/Vercel/Figma also expose registration endpoints their docs don't advertise (gating likely at consent; verify before promising anything). Caveat: spikes stopped at the consent page (no logins) — the code→token→refresh leg is unproven until the §11.5 human-in-the-loop test.

**3b — BYO-app OAuth, with Google as the designed flagship.** Claude Tag ships 3-legged OAuth because Anthropic operates registered OAuth clients; the OSS equivalent is the admin registering their own OAuth app. For most vendors that's Advanced-tab material — but **Google (Gmail · Calendar · Drive) is important enough to get a first-class guided wizard** instead of a footnote. Verified facts (2026-07-19) that shape it:

- **Lane: REST, not Google's MCP servers.** Google's remote MCP servers (gmailmcp/drivemcp/calendarmcp.googleapis.com, streamable HTTP) do accept custom clients with a BYO OAuth client (a documented "Others" path) — but they're **Developer-Preview-gated** (per-install Cloud-project enrollment, pre-GA terms restrict use outside the enrollee's own domain), carry fixed narrow scope sets and preview-unstable tool lists, support neither DCR nor CIMD, and don't document service-account tokens. The Gmail/Calendar/Drive **REST APIs are GA and stable** — so Google lands on the **Phase 2 credential lane + a google-workspace skill**, exactly how Claude Tag does it. Revisit the MCP lane at GA (optional "experimental" toggle for preview-enrolled installs, same OAuth client).
- **Two setup tiers in the wizard, forked on the first question ("Is this a Google Workspace org?"):**
  - **Tier A — Workspace, Internal app (the happy path, most of our Slack-bot audience):** OAuth client with user type **Internal** needs **no Google verification, shows no unverified-app screen, has no user cap, and no 7-day token expiry — even for restricted Gmail/Drive scopes** (verified against Google's exemption docs). One caveat to surface: the org admin may need to allowlist the client for restricted scopes in Admin console API controls.
  - **Tier B — personal Gmail / External app:** works indefinitely unverified under a lifetime 100-user cap, with a one-time "Advanced → continue" warning screen — **but the wizard must force one step: set Publishing status to "In production" immediately, or refresh tokens die every 7 days** (Testing-mode expiry is the #1 documented pain across n8n/Activepieces/Home Assistant/LibreChat; Home Assistant's unmissable callout is the pattern to copy).
- **Wizard shape (~10 min):** account-type fork → create Cloud project + consent screen (deep links) → create Web OAuth client and paste **our install-specific redirect URI** (copy button; exact-match HTTPS registration is Google's model and `workers.dev` is on the public suffix list, so per-install random domains are a non-issue) → paste client id/secret (write-only store; the client_secret field already exists for Supabase) → scope picker defaulting to **read-only** (`gmail.readonly`, `calendar.*.readonly`, `drive.readonly`; write scopes opt-in) → Sign in with Google (`access_type=offline&prompt=consent` — required to get a refresh token) → non-echoing probe test. Plus the Claude-Tag-style banner: **use a dedicated Google account for the agent, not a personal one.**
- **Advanced option for Workspace orgs: service account + domain-wide delegation.** No browser flow, no per-user consent — the admin authorizes the SA's client id + scopes in Admin console and the agent impersonates a dedicated bot user (`claude@company.com`), matching the agent-identity model. JWT-bearer minting is RS256 = RSASSA-PKCS1-v1_5, natively supported by Workers WebCrypto (verified — no Node crypto needed). REST-only (MCP-via-DWD is undocumented). Sequencing bonus: DWD needs **no OAuth callback infra at all**, so it could ship with Phase 2 alone, before generic 3-legged support.
- **Token hygiene for the shared OAuth infra** (Google-specific but generalizable): refresh tokens don't rotate on use but die on 6-month inactivity, on user password change (Gmail scopes), and by silent eviction beyond 100 refresh tokens per account per client — the refresh path must treat `invalid_grant` as "re-auth needed," not an error loop.

Other no-DCR vendors (Asana, HubSpot) stay Advanced-tab BYO-app without a wizard until demand appears.

## 7. UX: the bundle-shaped admin surface (end state)

Phase 1 keeps today's Connections tab. As Phase 2 lands, the profile editor's capability tabs grow toward the bundle shape: **Connections** (gallery; each entry = credential + optional skill + lane badge MCP/API), **Domains** (uncredentialed allowlist + egress mode), **Instructions** (exists). "Copy setup link for another admin" (deep-link to a preset) is a cheap later add. Tier-3 platforms render greyed with a one-line "why" — it answers the question before it's asked.

## 8. Catalog maintenance

- **CI drift-check** (weekly cron + PR): fetch matching entries from the official MCP registry REST API (preview but API-frozen; `remotes[].headers[]` carries name/isSecret/description — same shape as our form) and diff against presets; live smoke against no-auth servers (DeepWiki, Context7 keyless). Registry is not consumed at runtime and not self-hosted.
- **Community PRs:** one preset = typed record + logo + docs link (+ optional skill md). Keep the first-party set ~16–25 (n8n's review backlog is the cautionary tale).

## 9. Rejected alternatives

- **Nango** — pattern, not product: Elastic-licensed; MCP feature enterprise-gated; self-host = Postgres+Redis+Elasticsearch+S3+5 services; zero-ops alternative is a per-install Nango Cloud account. Its "MCP Generic" flow (discovery+PKCE+CIMD-then-DCR) is §6-3a, implemented natively.
- **Composio / Pipedream Connect / Arcade / Klavis** — hosted-first, closed or enterprise-gated credential runtimes, per-user third-party accounts. Fails OSS/no-central-service/non-expert constraints.
- **MCP-only forever** — contradicts the Claude Tag end-state and leaves the long tail (internal APIs, MCP-less vendors) unreachable.
- **Raw-API-only (drop MCP)** — deletes working, vendor-maintained capability and our only per-action approval gate; wrong for bring-your-own-model installs.

## 10. Key sources

Claude Tag docs: claude.com/docs/claude-tag/{concepts/agent-identity, concepts/security-and-data, concepts/glossary, admins/add-connections, admins/connections/custom, admins/connections/datadog, admins/connections/salesforce} · code.claude.com/docs/en/{sandboxing, plugins} · github.com/anthropics/claude-tag-plugins · anthropic.com/news/introducing-claude-tag · MCP auth spec 2025-11-25 (CIMD/SEP-991) · Anthropic "Code execution with MCP" · Nango docs · LibreChat #11576 · Claude Code #65752 · just-bash NetworkConfig types (in-tree) · vendor MCP docs per Appendix A.

## 11. Open questions

**Phase 1 SHIPPED 2026-07-20** (PR #1 merged: 20-connector gallery, all four auth subgroups live-verified with real accounts). Phase 2 decisions locked at kickoff (2026-07-20):

1. ~~Egress default for existing installs~~ **RESOLVED: pre-launch, no installed base — `allowlist` is simply the default for everyone. No migration path, no `open` grandfathering.**
2. ~~Model-facing surface~~ **DECIDED: start Claude-Tag-faithful — bare `curl` through the sandbox allowlist + connector skills. Revisit an `http_request` tool only if weaker models fumble raw curl.**
3. ~~Skill authoring~~ **DECIDED: hand-write. MVP targets = GitHub, Asana, Zendesk REST skills — the three the maintainer personally needs that the MCP lane cannot serve (GitHub no-DCR, Asana OAuth-gated MCP, Zendesk no MCP yet), all token-friendly on REST (PAT / PAT / Basic email+token).**
4. OAuth 3a launch set (post-spike): Notion + Linear + Airtable confirmed to consent; include Supabase (needs client_secret handling)? Canva is out.
5. **Next verification step for 3a:** one human-in-the-loop run — a spike callback worker + a real login on Linear (or Notion) to prove the unproven leg: code→token exchange, refresh-token issuance (`offline_access`?), and a refresh round-trip. ~an hour with maintainer participation; converts "reached consent" into "flow proven."
6. Upstream just-bash issue: `denyPrivateRanges` should degrade to lexical-only when no DNS resolver is available (workerd) instead of failing closed; and `_dnsResolve` is `@internal` — ask for a public seam.

---

## Appendix A — remote MCP platform survey (verified 2026-07-19)

Tags: **V** fetched official doc · **L** secondary source. Tier 1 = token preset today; Tier 2 = OAuth (DCR/CIMD) capable; Tier 3 = blocked for arbitrary self-hosted clients.

| Platform | Remote MCP | URL | Auth | Tier | Notes |
|---|---|---|---|---|---|
| Linear | V | `mcp.linear.app/mcp` | OAuth 2.1+DCR **and** Bearer `lin_api_…` (V) | 1+2 | SSE endpoint deprecated Feb 2026 |
| GitHub | V | `api.githubcopilot.com/mcp/` | PAT Bearer (V); no DCR (V) | 1 | classic `ghp_`, fine-grained `github_pat_` |
| Figma | V | `mcp.figma.com/mcp` | OAuth gated to approved clients; `figd_` PAT NOT accepted remotely (V) | 3 | desktop server needs paid Dev/Full seat |
| Notion | V | `mcp.notion.com/mcp` | OAuth+PKCE+DCR (V); `ntn_` tokens NOT accepted (V) | 2 | Phase 3a flagship |
| Sentry | V | `mcp.sentry.dev/mcp` | OAuth or token via `Authorization: Sentry-Bearer <t>` (V) | 1 | non-standard scheme |
| Stripe | V | `mcp.stripe.com` | OAuth (no DCR) or Bearer `rk_…`/`sk_…` (V) | 1 | recommend restricted keys |
| Cloudflare | V | `<product>.mcp.cloudflare.com/mcp` ×~17 | OAuth or Bearer API token (V) | 1 | per-product servers; `/sse` deprecated |
| Vercel | V | `mcp.vercel.com` | OAuth, approved-client allowlist only (V) | 3 | |
| Supabase | V | `mcp.supabase.com/mcp` | OAuth+DCR or Bearer `sbp_…` (V, prefix L) | 1+2 | `?read_only=true` param |
| Neon | V | `mcp.neon.tech/mcp` | OAuth or Bearer API key (V) | 1 | key path documented for remote agents |
| PostHog | V | `mcp.posthog.com/mcp`, EU `mcp-eu.` | Bearer `phx_…` (V, prefix L) | 1 | |
| Atlassian | V | `mcp.atlassian.com/v1/mcp` | OAuth 2.1; API-token = HTTP **Basic**, org-admin-gated (V) | 3→2? | `/v1/sse` dead 2026-06-30; **live DCR from random domain worked to consent** (spike) — may graduate to the OAuth lane |
| Asana | V | `mcp.asana.com/v2/mcp` | OAuth only, no DCR, manual registration (V) | 3 | `/sse` dead 2026-05-11; re-verified 2026-07-20: MCP accepts only Asana-OAuth-issued tokens (no PAT/service-account path); Phase 3 BYO-client. REST API accepts PATs → Phase 2 credential lane works earlier |
| Zendesk | **none yet** (V, probed 2026-07-20) | MCP *server* "early access summer 2026" — nothing live (all endpoints 404, no OAuth metadata) | REST today: Basic `base64(email/token:api_token)` per `<subdomain>.zendesk.com` | watch | MCP *client* EAP shipped 2026-06; re-audit when server EAP opens (likely per-subdomain; Basic scheme would fit the two-field preset). Community Swifteq server is third-party-hosted — unsuitable for a self-hosted preset |
| Intercom | V | `mcp.intercom.com/mcp` | OAuth or Bearer (V) | 1 | US-hosted workspaces only |
| Zapier | V | `mcp.zapier.com/api/v1/connect` | Bearer, per-user-generated URL (V) | 1* | URL not preset-able |
| Monday | V | `mcp.monday.com/mcp` | Bearer or OAuth (V) | 1 | |
| ClickUp | V | `mcp.clickup.com/mcp` | OAuth, approved clients only (V) | 3 | rate-limited free tier |
| Airtable | V | `mcp.airtable.com/mcp` | OAuth+DCR or Bearer `pat…` (V) | 1+2 | all plans, free |
| HubSpot | V | `mcp.hubspot.com` | OAuth 2.1, no DCR — own app required (V) | 3 | |
| Salesforce | V | per-org URL | per-org OAuth + External Client App (V) | 3 | |
| Google (Gmail/Cal/Drive) | V (preview) | `gmailmcp.googleapis.com/mcp/v1` etc. | OAuth only, BYO client (custom clients documented); no DCR/CIMD (V); no SA/DWD documented | 3 → §6-3b wizard | MCP lane preview-gated + unstable; **ship via REST lane + guided BYO wizard instead** (Workspace-Internal happy path / External publish-to-production; DWD advanced) |
| Canva | V | `mcp.canva.com/mcp` | advertises CIMD but **rejects self-hosted redirect hosts** (live-tested) | 3 | "Invalid redirect URI. It must be from an allowed host" — CIMD gated; dropped from launch set |
| Webflow | V | `mcp.webflow.com/mcp` | OAuth (DCR unconfirmed) or self-hosted token (V) | 2? | |
| Square | V | `mcp.squareup.com/sse` | remote OAuth allowlisted; local token `sq0atp-…` (V) | 3 | SSE-only remote |
| PayPal | V | `mcp.paypal.com/http` | Bearer access token or OAuth (V) | 1 | sandbox variant exists; ⚠ spike: `/http` 404'd on initialize while OAuth metadata resolves at root — re-verify transport path before shipping |
| Context7 | V | `mcp.context7.com/mcp` | header `CONTEXT7_API_KEY: ctx7sk-…`, keyless OK (V) | 1 | |
| Exa | V | `mcp.exa.ai/mcp` | header `x-api-key` (V) | 1 | keyless rate-limited |
| Firecrawl | V | `mcp.firecrawl.dev/v2/mcp` | Bearer `fc-…` (V) | 1 | |
| DeepWiki | V | `mcp.deepwiki.com/mcp` | none (V) | 1 | public repos only |
| Hugging Face | V | `huggingface.co/mcp` | Bearer `hf_…` (V) | 1 | |
