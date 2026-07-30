import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveModel } from '@flue/runtime/internal';
import type { AssistantMessageEventStream, Model } from '@earendil-works/pi-ai';

import {
  activeModelCatalogSnapshot,
  activateModelCatalog,
  resetModelCatalogActivationForTests,
  resolveActiveCatalogRoute,
} from '../src/model-catalog/catalog.ts';
import { parseModelCatalogBytes } from '../src/model-catalog/schema.ts';
import { createModelCompatibilityStream } from '../src/model-compat/provider.ts';

function hosted(
  revision: number,
  entries: unknown[],
  hashDigit = 'a',
) {
  const bytes = new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    revision,
    generatedAt: '2026-07-29T20:00:00Z',
    entries,
  }));
  return {
    document: parseModelCatalogBytes(bytes),
    sha256: hashDigit.repeat(64),
  };
}

test('revisioned aliases retain N after N+1 activation while current routing moves atomically', () => {
  resetModelCatalogActivationForTests();
  const canonical = 'openai/gpt-route-captured';
  const entry = (contextWindow: number) => ({
    canonical,
    lanes: { apiKey: 'openai-platform-responses-terra-tier@1' },
    contextWindow,
    maxTokens: 20_000,
  });

  assert.equal(activateModelCatalog(hosted(20, [entry(200_000)], 'a')).status, 'activated');
  const routeN = resolveActiveCatalogRoute(canonical, 'openai_api_key');
  assert.ok(routeN);
  assert.equal(resolveModel(routeN.modelSpecifier).contextWindow, 200_000);

  assert.equal(activateModelCatalog(hosted(21, [entry(100_000)], 'b')).status, 'activated');
  const routeN1 = resolveActiveCatalogRoute(canonical, 'openai_api_key');
  assert.ok(routeN1);
  assert.notEqual(routeN.modelSpecifier, routeN1.modelSpecifier);
  assert.equal(resolveModel(routeN.modelSpecifier).contextWindow, 200_000);
  assert.equal(resolveModel(routeN1.modelSpecifier).contextWindow, 100_000);

  const snapshot = activeModelCatalogSnapshot();
  assert.equal(Object.isFrozen(snapshot.entries[0]?.lanes), true);
  assert.throws(() => {
    (snapshot.entries[0]?.lanes as Record<string, string>).openai_api_key =
      'openai-platform-responses-sol-tier@1';
  }, TypeError);

  const ignored = activateModelCatalog(hosted(19, [entry(50_000)], 'c'));
  assert.equal(ignored.snapshot.revision, 21);
  assert.equal(resolveActiveCatalogRoute(canonical, 'openai_api_key')?.model.contextWindow, 100_000);
});

test('a thrown compatibility source becomes a sanitized terminal Pi error', async () => {
  resetModelCatalogActivationForTests();
  const canonical = 'openai/gpt-stream-failure';
  activateModelCatalog(hosted(50, [{
    canonical,
    lanes: { apiKey: 'openai-platform-responses-terra-tier@1' },
  }], 'e'));
  const route = resolveActiveCatalogRoute(canonical, 'openai_api_key');
  assert.ok(route);
  const incoming: Model<string> = {
    ...route.model,
    provider: 'chickpea-test-captured',
    api: 'chickpea-test-api',
  };
  const broken = {
    async *[Symbol.asyncIterator]() {
      throw new Error('upstream secret details');
    },
  } as unknown as AssistantMessageEventStream;
  const stream = createModelCompatibilityStream(
    incoming,
    { messages: [] },
    undefined,
    false,
    {
      route: { provider: 'openai', lane: 'openai_api_key' },
      resolveModel: () => route.model,
      openAiStream: () => broken,
    },
  );

  const events = [];
  for await (const event of stream) events.push(event);
  const result = await stream.result();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'error');
  assert.equal(result.stopReason, 'error');
  assert.equal(result.errorMessage, 'Model provider stream failed.');
  assert.doesNotMatch(result.errorMessage ?? '', /secret/);
});

test('API-key routes are native-first, subscription is never Pi-native, and lanes never substitute', () => {
  resetModelCatalogActivationForTests();
  assert.equal(activateModelCatalog(hosted(30, [
    {
      canonical: 'openai/gpt-5.4',
      lanes: { subscription: 'openai-codex-responses-standard@1', apiKey: 'openai-platform-responses-terra-tier@1' },
      contextWindow: 100_000,
      maxTokens: 100_000,
    },
    {
      canonical: 'openai/gpt-subscription-only-hosted',
      lanes: { subscription: 'openai-codex-responses-standard@1' },
    },
  ])).status, 'activated');

  const native = resolveActiveCatalogRoute('openai/gpt-5.4', 'openai_api_key');
  assert.equal(native?.source, 'pi_native');
  assert.equal(native?.modelSpecifier, 'openai/gpt-5.4');

  const subscription = resolveActiveCatalogRoute('openai/gpt-5.4', 'openai_subscription');
  assert.equal(subscription?.source, 'catalog');
  assert.equal(subscription?.model.provider, 'openai-codex');
  assert.equal(
    resolveActiveCatalogRoute('openai/gpt-subscription-only-hosted', 'openai_api_key'),
    undefined,
  );
});

test('a higher-revision removal affects new routing without mutating the captured old alias', () => {
  resetModelCatalogActivationForTests();
  const canonical = 'anthropic/claude-hosted-removal';
  activateModelCatalog(hosted(40, [{
    canonical,
    lanes: { apiKey: 'anthropic-messages-sonnet-tier@1' },
  }], 'c'));
  const old = resolveActiveCatalogRoute(canonical, 'anthropic_api_key');
  assert.ok(old);

  activateModelCatalog(hosted(41, [], 'd'));
  assert.equal(resolveActiveCatalogRoute(canonical, 'anthropic_api_key'), undefined);
  assert.equal(resolveModel(old.modelSpecifier).id, 'claude-hosted-removal');
});

test('a hosted snapshot can withdraw a bundled model instead of silently inheriting it', () => {
  resetModelCatalogActivationForTests();
  assert.ok(resolveActiveCatalogRoute('openai/gpt-5.6-sol', 'openai_subscription'));

  assert.equal(activateModelCatalog(hosted(42, [], 'f')).status, 'activated');
  assert.equal(
    resolveActiveCatalogRoute('openai/gpt-5.6-sol', 'openai_subscription'),
    undefined,
  );
});

test('runtime route reads never fetch and the seventeenth hosted activation requires restart', () => {
  resetModelCatalogActivationForTests();
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error('runtime must not fetch');
  };
  try {
    for (let revision = 1; revision <= 16; revision += 1) {
      assert.equal(activateModelCatalog(hosted(revision, [], (revision % 10).toString())).status, 'activated');
    }
    assert.equal(activateModelCatalog(hosted(17, [], 'f')).status, 'restart_required');
    resolveActiveCatalogRoute('openai/gpt-5.4', 'openai_api_key');
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
