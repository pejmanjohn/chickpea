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

Hosted credits charge only for models that have a reviewed list price in
`src/usage/pricing/catalogs/`. A model without one runs with the customer's own
key and is refused on credits. Pi's `cost` metadata never sets a charge.

### Add a model to the hosted catalog

1. Add the entry to `catalog/source.json` with its lanes, `provenance`, and
   `laneStatus`. Increase `revision`.
2. Run `npm run catalog:build -- --write`. It writes `catalog/current.json` and
   the unchangeable `catalog/releases/revision-<N>.json`.
3. Run `npm run verify:model-catalog`.
4. To offer the model on credits, add a reviewed price version, with the
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
   new Pi now ships natively. On API-key lanes, Chickpea routes Pi's own model
   first. After a live check on the native route, mark the lane
   `native_verified` with a `retainUntil` date. Keep the entry until that
   date, because older installations still route through it.
5. Regenerate request snapshots that follow Pi's wire format, such as
   `UPDATE_SHARED_PREFIX=1 node --import tsx --test tests/shared-prefix.test.ts`.
   Review the diff before you accept it.
6. Run `npm run verify:regression`, then the live checks for the changed
   provider paths.
