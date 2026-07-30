#!/usr/bin/env node
/**
 * Explicit live check for one reviewed Chickpea model-catalog lane. The script
 * never prints credentials or model output and refuses all egress except the
 * selected provider host. Subscription checks reuse an already-authorized
 * Node settings database; API-key checks read the provider key from env.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { resolveModel } from '@flue/runtime/internal';
import { getApiProvider } from '@earendil-works/pi-ai/compat';

import { resolveRuntimeModel } from '../src/config/runtime-model.ts';
import { resolveOpenAiAuthMethod, saveOpenAiAuthMethod } from '../src/config/openai-auth.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { activateModelCatalog } from '../src/model-catalog/catalog.ts';
import { parseModelCatalogBytes } from '../src/model-catalog/schema.ts';

const args = parseArgs(process.argv.slice(2));
if (args.has('--help')) {
  console.log(
    'Usage: npm run verify:model-compatibility:live -- --live ' +
      '--lane <subscription|openai-api-key|anthropic-api-key> --model <id> ' +
      '[--state-db <path>] [--catalog-file <path>]',
  );
  console.log('Consumes provider or subscription quota and never prints model output or credentials.');
  process.exit(0);
}

assert.equal(args.has('--live'), true, 'refusing model traffic without the explicit --live flag');
const lane = String(args.get('--lane') ?? '');
assert.ok(
  lane === 'subscription' || lane === 'openai-api-key' || lane === 'anthropic-api-key',
  '--lane must be subscription, openai-api-key, or anthropic-api-key',
);
const modelId = String(args.get('--model') ?? '');
assert.match(modelId, /^[a-z0-9][a-z0-9._-]{0,127}$/, '--model must be a safe model id');

const provider = lane === 'anthropic-api-key' ? 'anthropic' : 'openai';
const canonicalModel = `${provider}/${modelId}`;
const expectedHost = lane === 'subscription' ? 'chatgpt.com' : `api.${provider}.com`;
const catalogFile = args.get('--catalog-file');
const hostedCatalog = typeof catalogFile === 'string'
  ? await readHostedCatalog(catalogFile)
  : undefined;
const statePath = lane === 'subscription' ? String(args.get('--state-db') ?? '') : ':memory:';
if (lane === 'subscription') {
  assert.ok(statePath, '--state-db is required for a subscription check');
  assert.equal(
    process.env.TAG_OPENAI_SUBSCRIPTION_ENABLED,
    '1',
    'TAG_OPENAI_SUBSCRIPTION_ENABLED must be exactly 1',
  );
} else {
  const keyName = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
  assert.ok(process.env[keyName], `${keyName} is required`);
  if (provider === 'openai') {
    assert.equal(
      process.env.OPENAI_BASE_URL ?? '',
      '',
      'OPENAI_BASE_URL must be unset for the live compatibility gate',
    );
  }
  if (provider === 'anthropic') {
    assert.equal(
      process.env.ANTHROPIC_BASE_URL ?? '',
      '',
      'ANTHROPIC_BASE_URL must be unset for the live compatibility gate',
    );
  }
}

const nativeFetch = globalThis.fetch;
const destinations = [];
globalThis.fetch = async (input, init) => {
  const url = new URL(
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  destinations.push(url.hostname);
  if (url.hostname !== expectedHost && !(lane === 'subscription' && url.hostname === 'auth.openai.com')) {
    throw new Error(`Live compatibility gate blocked unexpected host ${url.hostname}.`);
  }
  return nativeFetch(input, init);
};

const settings = new SqliteSettingsStore(statePath);
const priorOpenAiMethod = provider === 'openai'
  ? await resolveOpenAiAuthMethod(settings)
  : undefined;
try {
  if (provider === 'openai') {
    await saveOpenAiAuthMethod(settings, lane === 'subscription' ? 'subscription' : 'api_key');
  }
  const route = await resolveRuntimeModel('live_model_compatibility', canonicalModel, {
    settings,
    ...(hostedCatalog
      ? {
          loadCatalog: async () => {
            const activation = activateModelCatalog(hostedCatalog);
            return {
              status: activation.status === 'restart_required'
                ? 'restart_required'
                : 'activated',
              revision: activation.snapshot.revision,
            };
          },
        }
      : {}),
  });
  const model = resolveModel(route.model);
  const api = getApiProvider(model.api);
  assert.ok(api, `API handler ${model.api} must be registered`);
  const marker = 'CHICKPEA_MODEL_COMPATIBILITY_OK';
  const result = await api.stream(
    model,
    {
      messages: [{
        role: 'user',
        content: `Return exactly ${marker} and nothing else.`,
        timestamp: Date.now(),
      }],
    },
    {
      ...(lane === 'subscription'
        ? { apiKey: 'chickpea-boundary-managed' }
        : { apiKey: process.env[provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'] }),
      maxTokens: 64,
    },
  ).result();
  const output = result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
  assert.match(output, new RegExp(marker));
  assert.equal(result.stopReason === 'error', false);
  assert.ok(destinations.includes(expectedHost), `model traffic must reach ${expectedHost}`);
  assert.equal(
    destinations.every((host) =>
      host === expectedHost || (lane === 'subscription' && host === 'auth.openai.com')
    ),
    true,
  );
  console.log(JSON.stringify({
    ok: true,
    lane,
    canonicalModel,
    runtimeModel: route.model,
    provider: result.provider,
    destination: expectedHost,
    outputVerified: true,
  }));
} finally {
  globalThis.fetch = nativeFetch;
  if (priorOpenAiMethod) await saveOpenAiAuthMethod(settings, priorOpenAiMethod);
  settings.close();
}

function parseArgs(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value?.startsWith('--')) continue;
    const next = values[index + 1];
    if (next && !next.startsWith('--')) {
      result.set(value, next);
      index += 1;
    } else {
      result.set(value, true);
    }
  }
  return result;
}

async function readHostedCatalog(file) {
  const bytes = new Uint8Array(await readFile(file));
  return {
    document: parseModelCatalogBytes(bytes),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
