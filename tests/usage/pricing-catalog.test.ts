import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openStateDb } from '../../src/state/node-state-db.ts';
import {
  installReleasePriceCatalogs,
  RELEASE_PRICE_CATALOGS,
} from '../../src/usage/pricing/catalog.ts';

test('release catalog contains only the four fixture-proven priced routes with immutable provenance', () => {
  assert.deepEqual(
    RELEASE_PRICE_CATALOGS.map((version) => version.providerId),
    ['anthropic', 'openai', 'openrouter', 'cloudflare-workers-ai'],
  );
  for (const version of RELEASE_PRICE_CATALOGS) {
    assert.match(version.contentHash, /^[a-f0-9]{64}$/);
    assert.match(version.sourceUrl, /^https:\/\//);
    assert.equal(version.currency, 'USD');
    assert.ok(version.staleAfter > version.reviewedAt);
    assert.equal(version.rates.length, 1);
    assert.equal(version.rates[0]?.basis, 'standard_input_output');
  }
  assert.equal(
    RELEASE_PRICE_CATALOGS.some((version) => version.providerId === 'cloudflare'),
    false,
    'the operations-only Workers binding route must not become priceable by association',
  );
});

test('catalog tables install transactionally and repeated install cannot duplicate rates', () => {
  const db = openStateDb(':memory:');
  try {
    installReleasePriceCatalogs(db);
    installReleasePriceCatalogs(db);
    const versions = db.get('SELECT COUNT(*) AS count FROM usage_price_versions');
    const rates = db.get('SELECT COUNT(*) AS count FROM usage_price_rates');
    assert.equal(versions?.count, RELEASE_PRICE_CATALOGS.length);
    assert.equal(rates?.count, RELEASE_PRICE_CATALOGS.length);
    const source = db.get(
      `SELECT source_url, content_hash FROM usage_price_versions
       WHERE price_version_id = 'openai_2026-07-28'`,
    );
    assert.equal(source?.source_url, 'https://developers.openai.com/api/docs/models/gpt-4.1-mini');
    assert.match(String(source?.content_hash), /^[a-f0-9]{64}$/);
  } finally {
    db.close();
  }
});
