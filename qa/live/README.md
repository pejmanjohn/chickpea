# Live contract catalog

This directory is the public, credential-free behavior contract and resumable protocol for Chickpea's live QA. The first landing is not a working live coordinator and does not resolve credentials, browser profiles, workspace IDs, or provider accounts.

In V0, `verify:live:doctor` is the only executable live entrypoint. `case`, `smoke`, and `deep` fail closed with `COORDINATOR_REQUIRED`; product API adapters are diagnostic-only and cannot emit scored proof. V1 will add the verifier-owned attended Computer Use coordinator after the environment can provision and attest a real target.

- `cases/index.ts` is the reviewed TypeScript authoring catalog.
- `compiler.ts` validates the closed action, observer, assertion, fixture, cleanup, and inventory vocabulary and emits a deterministic content-addressed manifest.
- `manifest.ts` exposes the frozen generated v1.1 manifest as data only; it never imports the authoring catalog or compiler at runtime.
- `generated/feature-map.md` is derived from that manifest and must remain byte-for-byte fresh.
- `computer-use.ts` validates whether the Computer Use bridge plus real Slack and Admin surfaces are available for the selected UI recipes.
- `target.example.json` demonstrates the Phase 1 `fern` overlay using aliases only. `env target <alias>` supplies one selected color in that shape, and `env attest <alias>` supplies its doctor snapshot. The Phase 1 environment registry contains exactly `amber`, `cobalt`, and `fern`; all three bind the same exact four-variant smoke inventory and a run selects one. That registry rejects `deep` and continuation roles. The public target schema and catalog remain role-agnostic so a later deep-qualification module can use them without redefining contracts.

Public contract data must never contain credentials, private workspace coordinates, executable fields, raw transcripts, screenshots, local paths, or arbitrary URLs. Live code must consume the compiled data-only manifest, not import authoring helpers. Production files under `src/` and Cloudflare build configuration must not import `qa/live`.

Product-generated Slack messages are declared as generated effects with authoritative observers and attributed-residue accounting. They are never modeled as operator actions, because the verifier must observe Chickpea producing them rather than produce them itself.

V1.1 contains all ten contracts and their complete required live-variant inventory. Missing authoritative product projections remain explicit capability blockers rather than silently weakening a contract.
