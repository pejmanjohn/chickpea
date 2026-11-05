# Price review

Chickpea bills Chickpea-credits requests at the list prices in
`src/usage/pricing/catalogs/`. Each price version has a review due date,
`reviewDueAt`, 90 days after its review. A review checks every current price
against public sources and adds a new catalog version for each price it
confirms.

A past-due price keeps serving and is charged at its newest price. A review
date is operator information. Customers never see it.

## When to run a review

- Cloud's release doctor warns in its `pricing` row, or the operator
  digest names prices due within 30 days.
- Otherwise, about every 60 days.

## Run a review

1. In a Chickpea Core checkout, create a topic branch from current
   `origin/main`.
2. Run the review and read the report. This step reads public pricing pages
   and changes no file.

   ```sh
   npm run prices:review
   ```

3. For each price under **Couldn't verify**, open the source URLs in its
   reasons and check the price by hand.
4. Write the new versions. Add one `--accept` for each price that you checked
   by hand:

   ```sh
   npm run prices:review -- --write --accept openai/gpt-5.6-sol@2026-11-30 --accept openrouter/deepseek/deepseek-v4.1-flash
   ```

   `--accept <provider>/<model>` renews the catalog's numbers for 90 days.
   Add `@YYYY-MM-DD` to set an earlier due date, for example when a promotional
   price ends on that date.
5. If a price changed but only one source shows the change, accept it in
   step 4. Then edit its row in the generated file. A row lists the provider,
   the model, the source (a URL or a builder such as `openAiModelUrl`), and
   the rates in micros per 1M tokens. An optional last element sets `aliases`
   or a `reviewDueAt`. Add a comment above the row that says what you checked.
6. Run the pricing tests. If you edited a generated version, the hash test
   prints the line to put in `src/usage/pricing/catalogs/released-hashes.json`.

   ```sh
   npx tsc --noEmit
   DO_NOT_TRACK=1 node scripts/run-tests.mjs tests/price-review.test.ts tests/usage/*.test.ts
   ```

7. Commit the generated file, `src/usage/pricing/catalog.ts`, and
   `released-hashes.json`. Open a pull request with the report in its body.
   List each price you accepted or edited by hand, and the URL you checked.

`--write` refuses when the day's file or one of its version ids already exists.
To write again on the same day, restore `catalog.ts` and
`released-hashes.json`, delete the generated file, and run step 4 again.

## Approve the prices

Reviewing and merging the pull request approves the prices.

- If any price changed, from the **Changed** section or by a hand edit, the
  pull request is T4 and goes to the maintainer.
- If the pull request only renews prices, it follows the T1 checks.

Cloud charges the new prices after it pins the merged Core commit.

## What the tool checks

| Catalog provider | Sources |
| --- | --- |
| `anthropic` | OpenRouter models API; Anthropic's pricing page |
| `openai`, text | OpenRouter models API; OpenAI's model page |
| `openai`, image | OpenAI's model page |
| `openrouter` | OpenRouter endpoints API, at the maker's own endpoint; Anthropic's or OpenAI's page for their models |
| `cloudflare`, `cloudflare-workers-ai` | The model's JSON file in `cloudflare/cloudflare-docs` |

The tool compares only the fields that the catalog holds. It gives each price
one verdict:

- **Unchanged**: every field is confirmed by at least one source and
  contradicted by none. The tool writes a new version with the same numbers.
- **Changed**: two sources agree on a new value for a field. The tool writes a
  new version with that value.
- **Couldn't verify**: a source failed, sources disagree, only one source shows
  a difference, a value is not whole micros, or the last review set a due date
  earlier than 90 days. The tool writes nothing for this price.
- **Current**: the price was reviewed on the same UTC day. The tool skips it.

A price with only one source can be renewed but never changed by the tool.
This applies to Cloudflare models, OpenAI image models, OpenAI long-context
rates, and OpenRouter open models. Cloudflare publishes no cache-write price,
so the tool reports the input rate for cache writes, as the catalog does.

## OpenRouter price cap

Platform-funded OpenRouter requests are capped at the catalog price. After a
maker raises its price, OpenRouter can find no endpoint under the cap. Those
requests then fail with a routing error until a review with the new price
merges and Cloud pins it.
