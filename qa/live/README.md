# Live contract catalog

This directory is the public, credential-free behavior contract for Chickpea's live QA. It is not a live runner and does not resolve credentials, browser profiles, workspace IDs, or provider accounts.

- `cases/index.ts` is the reviewed TypeScript authoring catalog.
- `compiler.ts` validates the closed action, observer, assertion, fixture, cleanup, and inventory vocabulary and emits a deterministic content-addressed manifest.
- `manifest.ts` exposes the frozen generated v1.0 manifest as data only; it never imports the authoring catalog or compiler at runtime.
- `generated/feature-map.md` is derived from that manifest and must remain byte-for-byte fresh.
- `target.example.json` demonstrates the private overlay shape using aliases only. A real overlay stays outside Git and may only bind every public required variant to matching fixtures; it cannot add or redefine coverage.

Public contract data must never contain credentials, private workspace coordinates, executable fields, raw transcripts, screenshots, local paths, or arbitrary URLs. Live code must consume the compiled data-only manifest, not import authoring helpers. Production files under `src/` and Cloudflare build configuration must not import `qa/live`.

Product-generated Slack messages are declared as generated effects with authoritative observers and attributed-residue accounting. They are never modeled as operator actions, because the verifier must observe Chickpea producing them rather than produce them itself.

V1.0 contains LC-01, LC-04, and LC-08 with their exact required variants. The other seven LC IDs remain explicit pending entries. V1.1 promotes all ten contracts only when the complete required live-variant inventory is present.
