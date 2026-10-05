import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PromptUsage } from '@flue/runtime';

import {
  CHICKPEA_RESPONSE_METADATA_KEY,
  parseChickpeaResponseMetadata,
  responseUsageMetadata,
} from '../src/usage/response-metadata.ts';

const usage: PromptUsage = {
  input: 120,
  output: 30,
  cacheRead: 20,
  cacheWrite: 10,
  totalTokens: 180,
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
};

test('response metadata carries cache-aware measured usage and bounded model identity only', () => {
  const metadata = responseUsageMetadata(
    'openai/gpt-5.4',
    usage,
    { provider: 'openai', id: 'gpt-5.4-2026-05-01' },
  );
  assert.deepEqual(metadata, {
    schemaVersion: 1,
    requestedModel: 'openai/gpt-5.4',
    returnedModel: { provider: 'openai', id: 'gpt-5.4-2026-05-01' },
    usage: {
      input: 120,
      output: 30,
      cacheRead: 20,
      cacheWrite: 10,
      totalTokens: 180,
    },
  });
  assert.equal(CHICKPEA_RESPONSE_METADATA_KEY, 'chickpea');
  assert.doesNotMatch(JSON.stringify(metadata), /cost|prompt|completion/);
});

test('response metadata carries one-hour cache writes only when there are some', () => {
  const long = responseUsageMetadata('anthropic/claude-haiku-4-5', usage, undefined, 6);
  assert.equal(long.usage.cacheWrite1h, 6);
  assert.deepEqual(parseChickpeaResponseMetadata(long), long);

  const short = responseUsageMetadata('anthropic/claude-haiku-4-5', usage);
  assert.equal('cacheWrite1h' in short.usage, false);
  for (const cacheWrite1h of [0, -1, 1.5, '6']) {
    const parsed = parseChickpeaResponseMetadata({ ...short, usage: { ...short.usage, cacheWrite1h } });
    assert.deepEqual(parsed, short, String(cacheWrite1h));
  }
});
