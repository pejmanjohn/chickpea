import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

function providerHermeticEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENROUTER_API_KEY',
    'OPENROUTER_BASE_URL',
    'LOCAL_STUB_URL',
    'LOCAL_STUB_API_KEY',
    'LOCAL_STUB_MODELS',
  ]) delete env[key];
  return env;
}

test('a fresh process resolves every bundled internal model route before sandbox initialization', () => {
  const script = String.raw`
    import { resolveModel } from '@flue/runtime/internal';
    import { bootstrapRuntimeProviders } from './src/runtime-bootstrap.ts';

    bootstrapRuntimeProviders();
    const routes = [
      'openai-subscription/gpt-5.4',
      'chickpea-openai-platform-bundled-v1/gpt-5.6-terra',
      'chickpea-anthropic-api-bundled-v1/claude-opus-5',
    ];
    process.stdout.write(JSON.stringify(routes.map((route) => {
      const model = resolveModel(route);
      return { route, provider: model.provider, id: model.id };
    })));
  `;
  const output = execFileSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      env: providerHermeticEnv(),
    },
  );
  const resolved = JSON.parse(output) as Array<{
    route: string;
    provider: string;
    id: string;
  }>;

  assert.deepEqual(resolved, [
    {
      route: 'openai-subscription/gpt-5.4',
      provider: 'openai-subscription',
      id: 'gpt-5.4',
    },
    {
      route: 'chickpea-openai-platform-bundled-v1/gpt-5.6-terra',
      provider: 'chickpea-openai-platform-bundled-v1',
      id: 'gpt-5.6-terra',
    },
    {
      route: 'chickpea-anthropic-api-bundled-v1/claude-opus-5',
      provider: 'chickpea-anthropic-api-bundled-v1',
      id: 'claude-opus-5',
    },
  ]);
});

test('Cloudflare bootstrap omits the Node-only subscription provider', () => {
  const script = String.raw`
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: 'Cloudflare-Workers' },
    });
    const [{ bootstrapRuntimeProviders }, { registeredPiProvider }] = await Promise.all([
      import('./src/runtime-bootstrap.ts'),
      import('./src/config/pi-provider-registry.ts'),
    ]);
    bootstrapRuntimeProviders();
    process.stdout.write(String(registeredPiProvider('openai-subscription') === undefined));
  `;
  const output = execFileSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      env: providerHermeticEnv(),
    },
  );
  assert.equal(output, 'true');
});

test('a frozen OpenRouter live-catalog route registers its model in a fresh process', () => {
  const script = String.raw`
    import { resolveModel } from '@flue/runtime/internal';
    import { registeredPiProvider } from './src/config/pi-provider-registry.ts';
    import { registerFrozenRuntimeModelRoute } from './src/config/runtime-model.ts';
    import { bootstrapRuntimeProviders } from './src/runtime-bootstrap.ts';

    bootstrapRuntimeProviders();
    const canonical = 'openrouter/acme/fresh-live-model';
    let before = 'resolved';
    try { resolveModel(canonical); } catch (error) { before = error.message; }
    registerFrozenRuntimeModelRoute(canonical, canonical, {
      source: 'openrouter_live_catalog',
      displayName: 'Acme Fresh Live Model',
      contextWindow: 196608,
      maxTokens: 32768,
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 2.5 },
    });
    const model = resolveModel(canonical);
    const auth = await registeredPiProvider('openrouter').auth.apiKey.resolve();
    process.stdout.write(JSON.stringify({
      before,
      model: {
        provider: model.provider, id: model.id, name: model.name, api: model.api,
        contextWindow: model.contextWindow, maxTokens: model.maxTokens,
        reasoning: model.reasoning, input: model.input, cost: model.cost,
      },
      apiKey: auth?.auth.apiKey,
    }));
  `;
  const output = execFileSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      env: { ...providerHermeticEnv(), OPENROUTER_API_KEY: 'openrouter-env-key' },
    },
  );
  const result = JSON.parse(output);

  // Flue resolves the model while rendering the agent, before any app hook can
  // await the live catalog; without the frozen route a cold isolate fails here.
  assert.match(result.before, /Unknown model ID "acme\/fresh-live-model"/);
  assert.deepEqual(result.model, {
    provider: 'openrouter',
    id: 'acme/fresh-live-model',
    name: 'Acme Fresh Live Model',
    api: 'openai-completions',
    contextWindow: 196_608,
    maxTokens: 32_768,
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 2.5 },
  });
  assert.equal(result.apiKey, undefined, 'the registry never carries a key, even the deployment environment\'s');
});

test('a frozen hosted route registers its revisioned provider in a fresh process', () => {
  const script = String.raw`
    import { resolveModel } from '@flue/runtime/internal';
    import {
      registerFrozenRuntimeModelRoute,
    } from './src/config/runtime-model.ts';
    import { revisionedAlias } from './src/model-catalog/provider-alias.ts';
    import { bootstrapRuntimeProviders } from './src/runtime-bootstrap.ts';

    bootstrapRuntimeProviders();
    const sha256 = 'ab'.repeat(32);
    const cases = [
      {
        canonical: 'openai/gpt-hosted',
        family: 'openaiSubscription',
        route: {
          source: 'hosted_catalog', revision: 9, sha256,
          lane: 'openai_subscription', profile: 'openai-codex-responses-standard@1',
        },
      },
      {
        canonical: 'openai/gpt-hosted-api',
        family: 'openaiPlatform',
        route: {
          source: 'hosted_catalog', revision: 9, sha256,
          lane: 'openai_api_key', profile: 'openai-platform-responses-terra-tier@1',
        },
      },
      {
        canonical: 'anthropic/claude-hosted',
        family: 'anthropic',
        route: {
          source: 'hosted_catalog', revision: 9, sha256,
          lane: 'anthropic_api_key', profile: 'anthropic-messages-opus-tier@1',
        },
      },
    ];
    const result = cases.map((entry) => {
      const providerId = revisionedAlias(entry.family, 9, sha256).providerId;
      const runtime = providerId + '/' + entry.canonical.split('/')[1];
      registerFrozenRuntimeModelRoute(entry.canonical, runtime, entry.route);
      const model = resolveModel(runtime);
      return { runtime, provider: model.provider, id: model.id };
    });
    process.stdout.write(JSON.stringify(result));
  `;
  const output = execFileSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      env: providerHermeticEnv(),
    },
  );
  const resolved = JSON.parse(output) as Array<{
    runtime: string;
    provider: string;
    id: string;
  }>;

  assert.equal(resolved.length, 3);
  assert.deepEqual(
    resolved.map(({ provider, id }) => ({ provider, id })),
    [
      { provider: resolved[0]!.runtime.split('/')[0], id: 'gpt-hosted' },
      { provider: resolved[1]!.runtime.split('/')[0], id: 'gpt-hosted-api' },
      { provider: resolved[2]!.runtime.split('/')[0], id: 'claude-hosted' },
    ],
  );
});
