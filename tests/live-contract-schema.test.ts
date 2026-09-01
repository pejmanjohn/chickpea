import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OBSERVER_REGISTRY,
  ProductReceiptError,
  createProductReceipt,
} from '../qa/live/schema.ts';

const baseReceipt = {
  schemaVersion: 'chickpea-live-product-receipt/v1' as const,
  variantId: 'LC01-V1-create-welcome',
  observerId: 'agent.read' as const,
  result: 'pass' as const,
  transport: 'computer_use' as const,
  observationScope: 'window' as const,
  windowId: 'admin-amber',
  observedAt: '2026-09-01T12:00:00.000Z',
};

test('a passing product receipt requires window-scoped Computer Use observation', () => {
  assert.deepEqual(createProductReceipt(baseReceipt), baseReceipt);

  for (const change of [
    { transport: 'api_observation' as const, observationScope: 'transport' as const },
    { transport: 'api_mutation' as const, observationScope: 'transport' as const },
    { observationScope: 'screen' as const },
  ]) {
    assert.throws(
      () => createProductReceipt({ ...baseReceipt, ...change }),
      (error: unknown) => error instanceof ProductReceiptError
        && error.code === 'UNSCORABLE_PRODUCT_RECEIPT',
    );
  }
});

test('API diagnostics may fail or block but can never manufacture a pass', () => {
  const diagnostic = createProductReceipt({
    ...baseReceipt,
    result: 'fail',
    transport: 'api_observation',
    observationScope: 'transport',
    windowId: undefined,
  });
  assert.equal(diagnostic.result, 'fail');
  assert.equal(diagnostic.transport, 'api_observation');
});

test('every authoritative product observer is a Computer Use observer', () => {
  const productObservers = Object.entries(OBSERVER_REGISTRY)
    .filter(([, entry]) => entry.authority === 'product');
  assert.ok(productObservers.length > 0);
  assert.equal(productObservers.every(([, entry]) =>
    entry.kind === 'computer_use_ui' && entry.authoritative
  ), true);
  assert.equal(OBSERVER_REGISTRY['browser.screenshot'].authoritative, false);
  assert.equal(OBSERVER_REGISTRY['cloudflare.version.read'].authority, 'infrastructure');
});
