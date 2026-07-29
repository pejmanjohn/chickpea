# Usage telemetry provider-route proof

Date: 2026-07-28

Plan: `docs/plans/2026-07-28-001-feat-usage-cost-observability-plan.md`
Unit: U0

## Result

The exact Chickpea boundary is Flue beta.8's synchronous agent response:

```text
POST /agents/slack-thread/:id?wait=result
  -> result.text
  -> result.model.{provider,id}
  -> result.usage.{input,output,totalTokens}
```

Chickpea now reduces that envelope to `AgentDispatchResult`: result text,
requested model, returned provider/model, aggregate input/output/total usage,
and completeness. It does not carry stream coordinates, submission IDs,
cache/reasoning fields, registry cost, or provider-specific charged cost across
the Slack presentation seam.

An all-zero usage object is classified `not_reported`, not measured free usage.
This is necessary because the pinned Workers AI binding adapter initializes its
usage accumulator to zeros and overwrites it only after receiving a usage
chunk.

Non-success results do not cross this boundary as zero-filled measurements:

- a provider or Agent failure is a non-2xx Flue response and produces no
  `AgentDispatchResult`;
- a timeout or interrupted stream has no terminal result envelope, so later
  persistence must retain nullable usage with a normalized unknown reason;
- replaying a stored terminal envelope reduces to the same bounded result;
  replaying provider work is a new execution and must not overwrite it.

## Current route matrix

| Route | Auth | Runtime classification | Priceability for tested no-cache model | Confidence | Evidence |
| --- | --- | --- | --- | --- | --- |
| Anthropic | API key | `metered` | `priceable` | High | Hermetic built Node app, Anthropic Messages SSE fixture, direct Flue result assertion |
| OpenAI | API key | `metered` | `priceable` | High | Hermetic built Node app, OpenAI Responses SSE fixture, direct Flue result assertion |
| OpenRouter | API key | `metered` | `priceable` | High | Hermetic built Node app, OpenAI-compatible SSE fixture, direct Flue result assertion |
| Workers AI REST | API token + account | `metered` | `priceable` | High | Hermetic built Node app, OpenAI-compatible SSE fixture, direct Flue result assertion |
| Workers AI binding | Worker binding | `operations_only` | `price_unknown` | High | Pinned adapter source proves missing usage is indistinguishable from its zero accumulator; no deployed usage-chunk proof yet |
| Local/custom compatible | Operator supplied | `operations_only` by default | `price_unknown` | High | The compatibility contract does not require usage or trustworthy pricing metadata |

`priceable` here is deliberately narrow: the tested response has non-zero
input/output/total usage, no unaccounted cache tokens, a known model, and a
reviewable standard rate. A real measurement becomes `price_unknown` whenever
those conditions do not hold. U5 still owns the immutable catalog and estimator
proof.

## Verification

- `tests/usage-telemetry-contract.test.ts` proves bounded extraction, complete,
  partial, missing, invalid, and all-zero usage behavior against the checked-in
  provider matrix.
- `tests/provider-settings.test.ts` proves hermetic base-URL overrides for the
  built-in OpenAI and OpenRouter routes.
- `node scripts/verify-providers.mjs` builds the real Node application and
  asserts non-zero usage plus returned model at the direct Flue boundary for
  Anthropic, OpenAI, OpenRouter, and Workers AI REST. The net guard proves zero
  external traffic.
- The pre-delivery telemetry write budget is **100 ms** (hard maximum 250 ms).
  A 500-sample Node SQLite probe measured p95 0.044 ms. The local workerd smoke
  measured an intentionally heavier Worker → `TagStateStore` transaction plus
  reads at p95 3.40 ms across 50 post-warmup samples. The checked-in fixture
  records both measurements and their limitations. Deployed-Worker capacity
  proof remains required after the exact U1 schema exists.
- Credential-gated live verification was not run because no provider
  credentials were present in the implementation checkout.

## Gate

U1-U6 may rely on the operation core for every route and on the metered core
only for the four proven API routes above. Workers AI binding and generic
custom routes remain visible as operations with unknown usage and spend until
their own exact fixtures prove otherwise. No provider-specific telemetry field
is promoted into the universal reporting contract.
