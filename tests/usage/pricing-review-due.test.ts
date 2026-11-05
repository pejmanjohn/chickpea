import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { priceCatalogFor, RELEASE_PRICE_CATALOGS } from '../../src/usage/pricing/catalog.ts';
import { currentPrices, priceReviewsDue } from '../../src/usage/pricing/review-due.ts';

const RELEASED_HASHES: Record<string, string> = JSON.parse(
  readFileSync(new URL('../../src/usage/pricing/catalogs/released-hashes.json', import.meta.url), 'utf8'),
);

test('a released price version keeps its id and content hash, because installed stores refuse a changed one', () => {
  const ids = RELEASE_PRICE_CATALOGS.map((version) => version.id);
  assert.equal(new Set(ids).size, ids.length, 'every price version id is unique');
  const hashes = Object.fromEntries(RELEASE_PRICE_CATALOGS.map((version) => [version.id, version.contentHash]));
  for (const [id, hash] of Object.entries(RELEASED_HASHES)) {
    assert.equal(hashes[id], hash, `${id} still ships with its released content hash`);
  }
  for (const [id, hash] of Object.entries(hashes)) {
    assert.equal(
      RELEASED_HASHES[id],
      hash,
      `pin a new price version in src/usage/pricing/catalogs/released-hashes.json: "${id}": "${hash}"`,
    );
  }
});

test('every alias of a priced model is charged at the same version as the model', () => {
  for (const at of [Date.UTC(2026, 10, 5, 12), Date.UTC(2099, 0, 1)]) {
    for (const version of RELEASE_PRICE_CATALOGS) {
      for (const rate of version.rates) {
        assert.ok(rate.modelAliases.includes(rate.modelId), `${version.id} lists ${rate.modelId} among its aliases`);
        const model = priceCatalogFor(rate.basis, version.providerId, rate.modelId, at)?.version.id;
        for (const alias of rate.modelAliases) {
          assert.equal(
            priceCatalogFor(rate.basis, version.providerId, alias, at)?.version.id,
            model,
            `${version.providerId}/${alias} prices with ${rate.modelId}`,
          );
        }
      }
    }
  }
});

test('current prices are the versions serving charges, one per provider, basis and model', () => {
  const at = Date.UTC(2026, 10, 5, 12);
  const prices = currentPrices(at);
  const keys = prices.map(({ providerId, rate, modelId }) => `${providerId} ${rate.basis} ${modelId}`);
  assert.equal(new Set(keys).size, keys.length);
  for (const price of prices) {
    assert.equal(price.version.id, priceCatalogFor(price.rate.basis, price.providerId, price.modelId, at)?.version.id);
    assert.ok(price.version.effectiveFrom <= at);
  }
  const opus = prices.find(({ providerId, modelId }) => providerId === 'anthropic' && modelId === 'claude-opus-5-5');
  assert.equal(opus?.version.id, 'anthropic-opus-5-5_2026-10-07');
});

test('reviews due list the current prices due within the window or overdue, soonest first', () => {
  const at = Date.UTC(2026, 10, 5, 12);
  assert.deepEqual(
    priceReviewsDue(at, { withinDays: 30 }).map(({ providerId, modelId, reviewDueAt, overdue }) =>
      [providerId, modelId, new Date(reviewDueAt).toISOString().slice(0, 10), overdue]),
    [
      ['cloudflare', '@cf/zai-org/glm-5.2', '2026-11-15', false],
      ['cloudflare-workers-ai', '@cf/zai-org/glm-5.2', '2026-11-15', false],
      ['openai', 'gpt-5.6-sol', '2026-11-22', false],
      ['cloudflare', '@cf/zai-org/glm-5.3-flash', '2026-11-25', false],
      ['cloudflare-workers-ai', '@cf/zai-org/glm-5.3-flash', '2026-11-25', false],
      ['cloudflare', '@cf/zai-org/glm-4.7-flash', '2026-12-03', false],
      ['cloudflare-workers-ai', '@cf/zai-org/glm-4.7-flash', '2026-12-03', false],
    ],
  );
  const served = ['anthropic', 'openai', 'openrouter'];
  const sol = priceReviewsDue(Date.UTC(2026, 10, 22), { withinDays: 30, providers: served })[0];
  assert.deepEqual(sol, {
    providerId: 'openai',
    basis: 'standard_input_output',
    modelId: 'gpt-5.6-sol',
    priceVersionId: 'openai-gpt-5.6-sol_2026-10-07',
    reviewDueAt: Date.UTC(2026, 10, 22),
    overdue: true,
  });
  const january = priceReviewsDue(Date.UTC(2027, 0, 6), { withinDays: 30, providers: served });
  assert.ok(january.some(({ modelId, overdue }) => modelId === 'claude-opus-5-5' && overdue));
  assert.ok(january.every(({ providerId }) => served.includes(providerId)));
  assert.deepEqual(priceReviewsDue(Date.UTC(2026, 10, 5, 12), { withinDays: 0, providers: served }), []);
});
