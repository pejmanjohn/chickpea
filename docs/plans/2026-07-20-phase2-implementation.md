# Phase 2 implementation plan — the Claude Tag core

**Status:** Kickoff 2026-07-20. Phase 1 shipped (PR #1 merged to main). Build model: **Fable orchestrates + reviews, Codex `gpt-5.6-sol` xhigh implements** each slice; every slice reviewed + live-verified before the next.
**Design source:** `2026-07-19-connector-presets-design.md` §5 (this is the how, that is the why).
**Locked decisions (2026-07-20):** pre-launch, no installed base → `allowlist` egress default for everyone, no migration/grandfathering. Model-facing surface = Claude-Tag-faithful bare `curl` through the sandbox allowlist + connector skills (no `http_request` tool unless weak models fumble). Connector skills hand-written; first three = **GitHub, Asana, Zendesk** REST (the connectors the maintainer needs that the MCP lane can't serve: GitHub no-DCR, Asana OAuth-gated MCP, Zendesk no MCP yet — all token-friendly on REST).

## Grounded facts (verified in-repo 2026-07-20)

- **Sandbox seam:** the `defineAgent` factory in `src/agents/slack-thread.ts:69-74` returns `{model, instructions, tools, skills}`. Adding `sandbox` overrides Flue's wide-open CLI default env. Verified in `@flue/runtime` `internal.mjs:730` (`resolveSessionEnv`): a provided `sandbox` supplies the SessionEnv and `toolFactory = sandbox.tools`. `bash()` (exported from `@flue/runtime`) builds a `SandboxFactory` with **`.tools` undefined**, so `createBuiltinToolGroups` (conversation-stream-store `:1849`) falls through to `createTools(env, …)` — **the built-in tools (read/write/edit/bash/grep/glob) are preserved over our sandbox env.** So `sandbox: bash(() => new Bash({ fs: new InMemoryFs(), network }))` (from `just-bash`, already a dep) is the exact, safe wiring.
- **MCP connectors are NOT affected by sandbox egress.** The worker resolves MCP secrets and connects to MCP servers directly (`profile-mcp.ts`), not through the model's `bash`/`curl`. Closing sandbox egress removes the model's *ad-hoc* internet access only; the 20 shipped MCP presets keep working. (This is why egress-deny is safe to ship before the credential lane.)
- **just-bash `NetworkConfig`** (verified in the earlier spike): `allowedUrlPrefixes[]` (origin or origin+path-prefix, each with an optional per-URL `transform.headers` injected at the fetch boundary — secrets never enter the sandbox), `allowedMethods`, `denyPrivateRanges`, `maxRedirects/maxResponseSize`. Redirects re-evaluate transforms per hop (no cross-host credential leak) and re-check the allowlist. **Open landmine:** `denyPrivateRanges: true` *fails closed on workerd* (its DNS-rebinding check can't resolve → blocks every hostname). Slice 1 depends on the exact workerd-safe config — see the spike gate below.

## Slice sequence

### Slice 0 (SPIKE) — workerd-safe egress config — ✅ DONE 2026-07-20
Verdict: the allowlist is deny-by-default (unlisted hosts incl. private IPs are blocked), **but allowlist-only is NOT SSRF-safe** — a private-IP or rebinding hostname the operator *adds* to the allowlist goes through (proven: workerd reached `10.0.0.1` HTTP 200). `denyPrivateRanges: true` is required. On **workerd it fails closed** (just-bash resolves the `browser` bundle whose `node:dns` stub throws; combined with `denyPrivateRanges` defaulting on under `nodejs_compat`, every letter-hostname is denied) — fix by supplying a DoH `_dnsResolve`. The DoH host does **not** need allowlisting (it runs outside the sandbox allowlist). Locked configs:
```js
// Node
{ allowedUrlPrefixes, allowedMethods: ['GET','HEAD','POST'], denyPrivateRanges: true }
// workerd — same + DoH resolver (A-records; add AAAA for IPv6 parity later; small per-request cache)
{ allowedUrlPrefixes, allowedMethods: ['GET','HEAD','POST'], denyPrivateRanges: true,
  _dnsResolve: async (host) => { /* fetch https://cloudflare-dns.com/dns-query?name=host&type=A (accept: application/dns-json); map A answers → [{address, family:4}]; throw {code:'ENODATA'} if none */ } }
```
Caveat: `_dnsResolve` is typed `@internal` in just-bash (rename risk). Upstream issue to file: `denyPrivateRanges` fails closed on any `browser`-condition consumer even though workerd's `node:dns.lookup` works at runtime; and defaulting it on from `typeof process` is wrong for workerd.

### Slice 1 — Egress default-deny (Phase 2 pillar 1; standalone security fix)
- New `src/config/egress.ts`: `EgressPolicy` (mode `allowlist`|`open`|`off`, + `domains: string[]` uncredentialed allowlist) and `buildEgressNetworkConfig(policy, { target })` returning the target-aware `NetworkConfig` (from Slice 0). Default policy = `allowlist`, empty domains.
- Store the policy in `app_settings` (operator setting), read at turn time.
- Wire `sandbox: bash(() => new Bash({ fs: new InMemoryFs(), network: buildEgressNetworkConfig(...) }))` into `slack-thread.ts`'s returned object.
- Admin UI: a **Domains** section (list of allowed hosts + an egress-mode control) — small, mirrors existing settings idioms.
- Tests: `egress.ts` unit tests + a live smoke (model `curl` to a non-allowlisted host blocked; to an allowlisted host allowed; private-IP blocked) via the established Codex-writes/Fable-runs harness pattern.

### Slice 2 — Credential connections (the Agent Proxy equivalent)
- New `ApiConnectionConfig` record (mirrors Claude Tag's custom-connection form): name, allowed websites (leftmost-`*` wildcard), optional path prefixes, header template (name + optional value prefix), allowed methods, enabled. Reuse the SSRF guard at the write boundary. Two sources of truth again (a TS type + a Valibot schema) — the presetId lesson: any 3rd normalizer copy must carry every field.
- Secrets under `connector.<agentId>.<connectionId>.*`, cloning the write-only MCP secret pattern (env-override, source-only reporting, cleanup markers).
- At turn time, fold each connector into `allowedUrlPrefixes[].transform.headers` (credentialed) on top of the Slice-1 base config. Model `curl`s `api.linear.app/...`; the header is injected at the fetch boundary, invisible to the model.
- Admin CRUD clones the MCP connection UI (list row + editor, source-only secret display). Test = a preset-defined probe request that does NOT echo request headers.

### Slice 3 — Connector skills (the plugin analog)
- A skill-bundle shape teaching a REST API against placeholder env names (`$GITHUB_TOKEN`), attached alongside a connector. Ship GitHub, Asana, Zendesk REST skills (hand-written; references + curl recipes). Attaching a connector attaches its skill.
- Wire so `resolveProfileSkills` (existing) picks up connector skills for covered profiles.

### Slice 4 (later, optional) — API-credential presets in the gallery
- Light up the `api` block on `ConnectorPreset` (already scoped) so REST connectors appear in the gallery next to MCP ones — including the Tier-3 MCP-gated vendors (Box, Gong, Figma) that have token-friendly REST APIs, plus Asana/Zendesk. Bundles the connector + its skill in one click.

## Not in Phase 2
No TLS-terminating standalone proxy (just-bash injects pre-TLS in-process — same property, no MITM infra). No sentinel-substitution in arbitrary subprocess env (no real subprocesses in just-bash). SigV4/GCP credential types deferred. OAuth (Phase 3). Google DWD *could* ride Slice 2 (no callback infra needed) but is scheduled with Phase 3 unless pulled forward.

## Upstream-to-Flue asks (issues, non-blocking)
Scaffolded default should not be `dangerouslyAllowFullInternetAccess: true`; and `denyPrivateRanges` should degrade to lexical when no DNS resolver exists (workerd) instead of failing closed. A first-class per-agent `network`/egress option on `defineAgent` would remove the need to hand-build the whole session-env factory.
