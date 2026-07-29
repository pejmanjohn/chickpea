import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseAgentDispatchEnvelope } from '../src/slack/agent-dispatch.ts';

interface ProviderRouteFixture {
  id: string;
  provider: string;
  classification: 'metered' | 'operations_only';
  priceability: 'priceable' | 'price_unknown';
  requestedModel: string;
  envelope: unknown;
  expectedUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } | null;
}

const fixturePath = fileURLToPath(
  new URL('./fixtures/usage/provider-route-matrix.json', import.meta.url),
);
const matrix = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  schemaVersion: number;
  routes: ProviderRouteFixture[];
};

const persistenceBudget = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./fixtures/usage/persistence-budget.json', import.meta.url)),
    'utf8',
  ),
) as {
  chosenPreDeliveryBudgetMs: number;
  maximumAllowedBudgetMs: number;
  probes: Array<{ p95Ms: number }>;
};

test('provider matrix covers every current Chickpea inference route', () => {
  assert.equal(matrix.schemaVersion, 1);
  assert.deepEqual(
    matrix.routes.map((route) => route.id).sort(),
    [
      'anthropic-api-key',
      'local-custom-compatible',
      'openai-api-key',
      'openrouter-api-key',
      'workers-ai-binding',
      'workers-ai-rest-api-token',
    ],
  );
  assert.ok(matrix.routes.every((route) => route.classification.length > 0));
  assert.ok(matrix.routes.every((route) => route.priceability.length > 0));
});

test('the measured pre-delivery persistence budget is bounded and evidence-backed', () => {
  assert.equal(persistenceBudget.maximumAllowedBudgetMs, 250);
  assert.equal(persistenceBudget.chosenPreDeliveryBudgetMs, 100);
  assert.ok(
    persistenceBudget.chosenPreDeliveryBudgetMs <= persistenceBudget.maximumAllowedBudgetMs,
  );
  assert.ok(
    persistenceBudget.probes.every(
      (probe) => probe.p95Ms <= persistenceBudget.chosenPreDeliveryBudgetMs,
    ),
  );
});

test('Flue result envelopes reduce to the bounded Chickpea telemetry contract', () => {
  for (const fixture of matrix.routes) {
    const result = parseAgentDispatchEnvelope(fixture.envelope, fixture.requestedModel);

    assert.deepEqual(
      Object.keys(result).sort(),
      [
        'reportedUsage',
        'requestedModel',
        'returnedModel',
        'text',
        'usageCompleteness',
      ],
      fixture.id,
    );
    assert.equal(result.requestedModel, fixture.requestedModel, fixture.id);
    assert.equal(result.returnedModel?.provider, fixture.provider, fixture.id);
    assert.deepEqual(result.reportedUsage, fixture.expectedUsage, fixture.id);
    assert.equal(
      result.usageCompleteness,
      fixture.classification === 'metered' ? 'complete' : 'not_reported',
      fixture.id,
    );

    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /submissionId|streamUrl|providerReportedCost|cacheRead|cost/);
  }
});

test('partial usage stays partial and never synthesizes a total', () => {
  const result = parseAgentDispatchEnvelope(
    {
      result: {
        text: 'partial fixture reply',
        model: { provider: 'openai', id: 'gpt-4.1-mini' },
        usage: { input: 21, output: 8 },
      },
    },
    'openai/gpt-4.1-mini',
  );

  assert.deepEqual(result.reportedUsage, {
    inputTokens: 21,
    outputTokens: 8,
    totalTokens: null,
  });
  assert.equal(result.usageCompleteness, 'partial');
});

test('invalid usage values are not reported as measured zeros', () => {
  for (const usage of [
    { input: -1, output: 2, totalTokens: 1 },
    { input: 1.5, output: 2, totalTokens: 3.5 },
    { input: 1, output: Number.POSITIVE_INFINITY, totalTokens: 1 },
  ]) {
    const result = parseAgentDispatchEnvelope(
      { result: { text: 'invalid usage fixture', usage } },
      'custom/model',
    );
    assert.equal(result.reportedUsage, null);
    assert.equal(result.usageCompleteness, 'not_reported');
  }
});

test('legacy text-only and replayed results preserve honest completeness', () => {
  const envelope = { result: 'legacy fixture reply', submissionId: 'private-id' };
  const first = parseAgentDispatchEnvelope(envelope, 'local-stub/model');
  const replay = parseAgentDispatchEnvelope(envelope, 'local-stub/model');

  assert.deepEqual(first, replay);
  assert.equal(first.text, 'legacy fixture reply');
  assert.equal(first.reportedUsage, null);
  assert.equal(first.usageCompleteness, 'not_reported');
  assert.doesNotMatch(JSON.stringify(first), /private-id/);
});

test('failed result envelopes do not become successful zero-usage operations', () => {
  assert.throws(
    () => parseAgentDispatchEnvelope({ result: { usage: { input: 0, output: 0 } } }, null),
    /no result text/,
  );
});

test('pinned Flue Workers AI binding source uses zero as its pre-report accumulator', () => {
  const sourcePath = fileURLToPath(
    new URL('../node_modules/@flue/runtime/dist/cloudflare/internal.mjs', import.meta.url),
  );
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(
    source,
    /function emptyUsage\(\) \{[\s\S]*?input: 0,[\s\S]*?output: 0,[\s\S]*?totalTokens: 0/,
  );
  assert.match(source, /if \(chunk\.usage\) output\.usage = parseChunkUsage\(chunk\.usage\)/);
});
