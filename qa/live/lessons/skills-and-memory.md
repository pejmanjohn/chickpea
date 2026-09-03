# Skill and memory verification lessons

## Pinned skill lifecycle

LC-06 accepts one public source at an immutable commit and exact digest. The resolver must return one scriptless skill. Mutable refs, scripts, multiple candidates, digest mismatch, silent same-name replacement, and cross-Agent mutation fail.

The deterministic adapter checks the real resolver result, import receipt, Agent revision, structural Slack result, activity settlement, and final removal. Current `SkillConfig` rows store name, description, instructions, enabled state, and optional built-in provenance only. They do not store an imported source commit, path, or digest. Live LC-06 therefore blocks instead of treating the import receipt as durable provenance.

## Single-body Agent memory

LC-07 follows the current `AgentMemory` model: one body and one optimistic revision per Agent. It checks the body only in transient memory, hashes the bounded expected value locally, and returns closed tokens. The journal and public evidence never receive the raw body.

An idempotent retry keeps the revision. A stale expected revision returns `memory_version_conflict`. Forget writes the empty body at the next revision. Another Agent remains at the empty revision-zero state.

There is no authenticated content-safe memory digest projection. Implicit preference capture also has no separate durable proof. Both gaps block live grading even when a later answer appears to remember the preference.
