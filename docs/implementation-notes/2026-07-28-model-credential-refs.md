# Model credential references and epochs

Implemented for usage attribution on 2026-07-28.

- Chickpea records opaque credential references and positive integer epochs. It never derives an identifier from a secret, stores a key prefix, or includes a secret in a snapshot or usage row.
- Replacing or deleting an Admin-stored provider key advances its epoch. A deleted epoch is retired; adding a later key retains the same reference and advances again.
- Environment credentials have deterministic provider references. Operators can set `<PROVIDER>_CREDENTIAL_ALIAS` for a non-secret label and `<PROVIDER>_CREDENTIAL_EPOCH` to distinguish rotations. Without an epoch, reports explicitly mark rotation history as unknown.
- A Workers AI binding uses `CHICKPEA_DEPLOYMENT_EPOCH` as its optional rotation/deployment epoch. Workers AI REST tokens use the Cloudflare credential alias and epoch variables.
- Custom routes receive a generic non-secret reference and unknown-rotation state.
- Credential-registry writes are reporting-only and fail open during runtime resolution. They cannot make model execution unavailable.
- Current provider keys remain installation-global. The credential reference makes shared use visible; it does not claim provider-account or channel-level isolation.
