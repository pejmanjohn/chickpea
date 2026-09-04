# Live contract catalog

Use the [operator skill](operator/SKILL.md) for current verification. It selects
`changed`, `regression`, or `release` mode and treats invocation as authorization
for the declared QA actions and exact cleanup. It uses normal browser tools and
a lightweight private run record without the legacy coordinator.

Run `npm run verify:regression -- --plan` to inspect the checks beneath browser
automation. `npm run verify:regression` executes them serially with isolated
databases and fake services. Use `--mode regression` for the fixed core inventory
or `--mode release` for full local checks of clean committed source. These
results do not claim real-model quality or live Slack/provider acceptance.

This directory also contains the public, credential-free behavior catalog and
the older resumable coordinator protocol. Their schemas remain unchanged.

The legacy `verify:live:doctor` command reads a private readiness snapshot.
Its `case`, `smoke`, and `deep` CLI siblings return `COORDINATOR_REQUIRED` and
are not the skill's mode commands. The coordinator's product API adapters remain
diagnostic-only; the skill does not need this coordinator to perform UI journeys.

- `cases/index.ts` is the reviewed TypeScript authoring catalog.
- `compiler.ts` validates the closed action, observer, assertion, fixture, cleanup, and inventory vocabulary and emits a deterministic content-addressed manifest.
- `manifest.ts` exposes the frozen generated v1.1 manifest as data only; it never imports the authoring catalog or compiler at runtime.
- `generated/feature-map.md` is derived from that manifest and must remain byte-for-byte fresh.
- `computer-use.ts` validates whether the Computer Use bridge plus real Slack and Admin surfaces are available for the selected UI recipes.
- `target.example.json` demonstrates a role-agnostic example overlay (not an active Fern registration) using aliases only. `env target <alias>` supplies one selected color in that shape, and `env attest <alias>` supplies its doctor snapshot. The Phase 1 environment registry contains exactly `amber` and `cobalt`; both bind the same exact four-variant smoke inventory and a run selects one. That registry rejects `deep` and continuation roles. The public target schema and catalog remain role-agnostic so a later deep-qualification module can use them without redefining contracts.

Public contract data must never contain credentials, private workspace coordinates, executable fields, raw transcripts, screenshots, local paths, or arbitrary URLs. Live code must consume the compiled data-only manifest, not import authoring helpers. Production files under `src/` and Cloudflare build configuration must not import `qa/live`.

Product-generated Slack messages are declared as generated effects with authoritative observers and attributed-residue accounting. They are never modeled as operator actions, because the verifier must observe Chickpea producing them rather than produce them itself.

V1.1 contains all ten contracts and their complete required live-variant inventory. Missing authoritative product projections remain explicit capability blockers rather than silently weakening a contract.
