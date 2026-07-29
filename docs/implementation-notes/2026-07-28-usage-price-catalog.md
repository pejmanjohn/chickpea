# Usage price catalog

Implemented for the usage observability rollout on 2026-07-28.

- `USAGE_ESTIMATES=1` enables estimates independently of runtime recording and the Admin UI. The flag affects new terminal measurements only; disabling it never removes usage facts.
- V1 includes exactly four release-pinned, fixture-proven routes: Anthropic Claude Haiku 4.5, OpenAI GPT-4.1 mini, OpenRouter OpenAI GPT-4.1, and Workers AI REST GLM 5.2. The Workers AI binding and custom routes remain unpriced because their runtime usage contract is operations-only.
- Sources reviewed on 2026-07-28 are the official [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), [OpenAI model pricing](https://developers.openai.com/api/docs/models/gpt-4.1-mini), [OpenRouter provider listing](https://openrouter.ai/openai/gpt-4.1-2025-04-14/providers), and [Workers AI model pricing](https://developers.cloudflare.com/workers-ai/models/glm-5.2/).
- Catalog IDs and content hashes are immutable and stored with every estimate. Each snapshot expires to `price_stale` after 90 days until a reviewed release adds a new version; older measurements retain their original amount and version.
- Estimates use standard input/output list rates only. They do not claim invoice accuracy and do not model cache discounts/writes, batch or priority tiers, OpenRouter routing-specific adjustments, free allocations, credits, negotiated contracts, subscriptions, taxes, or work outside Chickpea.
- Missing aggregate fields produce `pricing_dimension_unknown`; unknown routes/models produce `price_unknown`; stale versions produce `price_stale`. Amounts remain null in every such case.
- Amounts are integer micro-USD. Cross-currency aggregation and FX conversion remain unsupported.
