# Models and Flue/Pi upgrades

This runbook is for contributors. It explains how a new model reaches a
Chickpea installation, and how to move Chickpea to a newer Flue release and
the Pi version that Flue ships with.

## How a new model reaches an installation

A model is usable only when Chickpea can route it with known request behavior.
There are four sources. Only the hosted catalog works without an application
update.

| Source | Needs an app update | What it covers |
| --- | --- | --- |
| Pi's built-in tables (`@earendil-works/pi-ai`) | Yes | Anthropic and OpenAI API-key models. The tables are generated when Pi is released and do not refresh at run time. |
| Hosted catalog (`catalog/current.json`) | No | Subscription models, and API-key models that the installed Pi does not know. Each entry maps to a compiled request profile. |
| Live provider lists (`/v1/models`) | No | The picker only. A listed model runs only if one of the sources above can route it. |
| Workers AI binding | No | Flue gives an unknown `@cf/...` ID zero metadata (no cost, no context window). Chickpea curates Workers AI models instead. |

Pi's `refresh()` only changes providers that load their model list at run time
(in Pi 1.1, only Radius). It does not add Anthropic or OpenAI models.

Installations refresh the hosted catalog about every 6 hours from the
repository's `main` branch. A merged revision is therefore a release to every
installation. A hosted entry can only select a profile that the installation
already compiles, so it cannot add new request behavior.

An installation rejects the whole hosted document, not only one entry, when
any entry names a profile that the installation does not compile
(`src/model-catalog/schema.ts`). The installation keeps its last accepted
catalog and rejects every later revision that still carries that entry.

Hosted credits charge only for models that have a reviewed list price in
`src/usage/pricing/catalogs/`. A model without one runs with the customer's own
key and is refused on credits. Pi's `cost` metadata never sets a charge.

### Add a model to the hosted catalog

1. Add the entry to `catalog/source.json` with its lanes, `provenance`, and
   `laneStatus`. Increase `revision`. Use only profiles that released
   installations already compile.
2. For each OpenAI lane, read `thinkingLevelMap.off` in Pi's own entry for the
   model: `openai` for the API-key lane, `openai-codex` for the subscription
   lane. If it is `null`, the model rejects reasoning effort `none`, so the
   lane's profile must also map `off` to `null`, which omits the effort.
   `tests/model-catalog.test.ts` enforces this for the bundled and hosted
   catalogs. For example, GPT-6.1 Sol rejects `none` and the Sol-tier profile
   sends it, so the bundled API-key lane uses the Astra-tier profile, which
   omits it.
3. Run `npm run catalog:build -- --write`. It writes `catalog/current.json` and
   the unchangeable `catalog/releases/revision-<N>.json`.
4. Run `npm run verify:model-catalog`.
5. To offer the model on credits, add a reviewed price version, with the
   provider's pricing page as `sourceUrl`.

## Upgrade Flue and Pi

1. Read Flue's release lockfile for the target version. Pin every
   `@earendil-works/*` package to the version that Flue was tested with. Use
   `overrides` for packages Chickpea does not depend on directly. If npm
   resolves a range to a newer release, the lockfile can hold two copies of
   Pi. `tests/node-lane-guard.test.ts` fails when any Pi package resolves
   twice or at a different version from `pi-ai`.
2. Run `npm ci --strict-allow-scripts`, then `npm run typecheck`.
3. Check every provider wrapper against Pi's changelog. In Pi 1.1, providers
   receive a `TranscriptContext`: the system prompt and tools are system
   messages, and later system messages can add or remove tools. Read them with
   `getCurrentSystemPrompt()` and `getCurrentTools()`. Create provider input
   only with `normalizeContext()`.
4. Run `npm run catalog:reconcile`. It reports catalog API-key lanes that the
   new Pi now ships natively. An API-key lane routes to Pi's own model as soon
   as Pi ships it (`resolveActiveCatalogRoute` in
   `src/model-catalog/catalog.ts`). `laneStatus` records the review state and
   does not change routing. The upgrade therefore moves every reported lane to
   the native route. List the reported lanes in the upgrade pull request as
   follow-up live checks. After a live check on the native route, mark the
   lane `native_verified` with a `retainUntil` date. Keep the entry until that
   date, because older installations still route through it.
5. Regenerate request snapshots that follow Pi's wire format, such as
   `UPDATE_SHARED_PREFIX=1 node --import tsx --test tests/shared-prefix.test.ts`.
   Review the diff before you accept it. The shared-prefix snapshot,
   `src/agents/shared-prefix-tools.json`, also feeds the hosted prewarm:
   `sharedPrefixRequests()` builds each prewarm from it. A prewarm carries
   `betas` beside its wire `body`, because the Anthropic API refuses `betas`
   in the body. The hosted prewarm must POST `body` as JSON to
   `https://api.anthropic.com/v1/messages?beta=true`. When `betas` is not
   empty, it must also send `anthropic-beta: <betas joined by ",">`. Pi 1.1
   added `betas`, so check that the hosted prewarm sends them this way before
   the hosted service updates to this core.
6. Run `npm run verify:regression`, then the live checks for the changed
   provider paths.
