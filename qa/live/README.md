# Live contract catalog

This directory is the public, credential-free behavior contract for Chickpea's live QA. It is not a live runner and does not resolve credentials, browser profiles, workspace IDs, or provider accounts.

- `cases/index.ts` is the reviewed TypeScript authoring catalog.
- `compiler.ts` validates the closed action, observer, assertion, fixture, cleanup, and inventory vocabulary and emits a deterministic content-addressed manifest.
- `manifest.ts` exposes the frozen generated v1.1 manifest as data only; it never imports the authoring catalog or compiler at runtime.
- `generated/feature-map.md` is derived from that manifest and must remain byte-for-byte fresh.
- `target.example.json` demonstrates the private overlay shape using aliases only. `env target <alias>` supplies one selected target in that shape, and `env attest <alias>` supplies its doctor snapshot. Private config may name several targets, but a run binds one. Optional `allowedSuites` restricts where suites run without changing their variants; only `dedicated-qa` may run `deep`.

Public contract data must never contain credentials, private workspace coordinates, executable fields, raw transcripts, screenshots, local paths, or arbitrary URLs. Live code must consume the compiled data-only manifest, not import authoring helpers. Production files under `src/` and Cloudflare build configuration must not import `qa/live`.

Product-generated Slack messages are declared as generated effects with authoritative observers and attributed-residue accounting. They are never modeled as operator actions, because the verifier must observe Chickpea producing them rather than produce them itself.

V1.1 contains all ten contracts and their complete required live-variant inventory. Missing authoritative product projections remain explicit capability blockers rather than silently weakening a contract.
