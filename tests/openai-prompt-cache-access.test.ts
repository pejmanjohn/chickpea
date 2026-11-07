import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';

import { normalizeContext } from '@earendil-works/pi-ai';
import type { Api, Context, Model, StreamOptions } from '@earendil-works/pi-ai';

import { promptCacheKey } from '../src/agents/openai-prompt-cache.ts';
import type { SharedPrefixId } from '../src/agents/shared-prefix.ts';
import { sharedSystemBlock } from '../src/agents/shared-prefix-layout.ts';
import {
  configureInstallationAdmission,
  resetInstallationAdmissionForTests,
} from '../src/config/installation-admission.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import {
  configureModelAccessResolver,
  modelAccessRequest,
  resetModelAccessForTests,
  withDeploymentLane,
  withModelAccess,
  type ModelAccessGrant,
  type ModelAccessProviderId,
} from '../src/config/model-access.ts';
import { registerBuiltinPiProvider } from '../src/config/pi-provider.ts';
import { registeredPiProvider } from '../src/config/pi-provider-registry.ts';
import { configurePlatformFunding, resetPlatformFundingForTests } from '../src/config/platform-funding.ts';
import type { PlatformEnv } from '../src/config/state-backend.ts';
import { getBuiltinModel } from '../src/model-catalog/pi-builtin-models.ts';
import { withEnv } from './helpers/env.ts';
import { EVERY_PROVIDER_FUNDED, NO_RUN_FEES } from './helpers/platform-funding.ts';

const NOW = Date.UTC(2026, 9, 7, 12);
const LUNA_DEFAULT = readFileSync(new URL('./fixtures/usage/provider-modes/openai-gpt-5.6-luna-default.sse', import.meta.url), 'utf8');
const AFFINITY_KEY = 'aff_01JTHREADALPHA';
const SLACK_TEXT = `${sharedSystemBlock('system')}\n\nYou are assigned to Slack workspace T0ALPHA0001, channel C0GENERAL01.\n\nDate: Mon, Nov 2, 2026`;
const BREAKPOINT_PART = { type: 'input_text', text: `${sharedSystemBlock('system')}\n\n`, prompt_cache_breakpoint: { mode: 'explicit' } };
const PDF = { type: 'input_file', filename: 'brief.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' };

const CONTEXT: Context = {
  systemPrompt: SLACK_TEXT,
  messages: [{ role: 'user', content: 'What can you help me with?', timestamp: 1 }],
};

interface Captured {
  readonly url: string;
  readonly body: Record<string, any>;
}

function grant(
  providerId: ModelAccessProviderId,
  fundingSource: ModelAccessGrant['fundingSource'],
  installationId = 'chickpea',
): ModelAccessGrant {
  return {
    installationId, providerId, runId: `run_${fundingSource}`, fundingSource,
    credentialRefId: fundingSource === 'platform' ? `platform:${providerId}` : `cred_${providerId}`, credentialVersion: 1,
  };
}

function hostedEnv(installationId: string): PlatformEnv {
  return scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId }) as PlatformEnv;
}

function proxied(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  resetModelAccessForTests();
  resetPlatformFundingForTests();
  resetInstallationAdmissionForTests();
  registerBuiltinPiProvider('openai');
  configureModelAccessResolver({ resolve: async () => ({ apiKey: 'sk-prompt-cache-test-key' }) });
  configureInstallationAdmission(async () => 'admitted');
  const charged: Array<SharedPrefixId | null> = [];
  configurePlatformFunding({
    ...EVERY_PROVIDER_FUNDED,
    funding: async () => 'platform',
    admit: async () => 'admitted',
    charge: async (_record, sharedPrefix) => {
      charged.push(sharedPrefix);
    },
    ...NO_RUN_FEES,
  });
  t.after(() => {
    resetModelAccessForTests();
    resetPlatformFundingForTests();
    resetInstallationAdmissionForTests();
  });
  return { charged };
}

/** One OpenAI request through the registered provider and model access, as a Flue turn sends it. */
async function send(
  modelId: string,
  access: ModelAccessGrant,
  env: PlatformEnv | undefined,
  onPayload?: StreamOptions['onPayload'],
): Promise<Captured> {
  const sent: Captured[] = [];
  const network: typeof fetch = async (input, init) => {
    sent.push({ url: input instanceof Request ? input.url : String(input), body: JSON.parse(String(init?.body)) });
    return new Response(LUNA_DEFAULT, { headers: { 'content-type': 'text/event-stream' } });
  };
  const provider = registeredPiProvider('openai');
  const model = provider?.getModels().find((candidate) => candidate.id === modelId);
  assert.ok(provider && model, `openai lists ${modelId}`);
  const result = await withModelAccess(access, env, 'reply', () => provider.streamSimple(model, normalizeContext(CONTEXT), {
    fetch: network, sessionId: AFFINITY_KEY, ...(onPayload ? { onPayload } : {}),
  }).result());
  assert.equal(result.stopReason, 'stop', result.errorMessage ?? result.stopReason);
  assert.equal(sent.length, 1);
  return sent[0]!;
}

function joined(body: Record<string, any>): string {
  const { content } = body.input[0];
  return typeof content === 'string' ? content : content.map((part: { text: string }) => part.text).join('');
}

test('a customer-funded OpenAI Slack turn carries one breakpoint and its own installation\'s key, and is not pinned', async (t) => {
  proxied(t);
  const hosted = await send('gpt-5.6-terra', grant('openai', 'customer', 'inst_byok'), hostedEnv('inst_byok'));
  const standalone = await withEnv({ CHICKPEA_INSTALLATION_ID: undefined }, () =>
    send('gpt-5.6-terra', grant('openai', 'customer'), undefined));

  for (const [label, body, installationId] of [['hosted', hosted.body, 'inst_byok'], ['standalone', standalone.body, 'chickpea']] as const) {
    assert.equal(body.prompt_cache_key, await promptCacheKey({ installationId }), label);
    assert.equal(body.input[0].role, 'developer', label);
    assert.deepEqual(body.input[0].content[0], BREAKPOINT_PART, label);
    assert.equal(body.input[0].content.length, 2, label);
    assert.equal(joined(body), SLACK_TEXT, `${label}: the model reads the same text`);
    assert.ok(!('service_tier' in body), `${label}: a customer-funded request is not pinned`);
    assert.ok(!('prompt_cache_options' in body), `${label}: the implicit write stays on`);
  }
  assert.equal(hosted.url, 'https://api.openai.com/v1/responses');
});

test('a platform-funded OpenAI Slack turn is pinned, then shares the prefix, and its charge names no shared prefix', async (t) => {
  const { charged } = proxied(t);

  const { body } = await send('gpt-5.6-terra', grant('openai', 'platform', 'inst_credits'), hostedEnv('inst_credits'));

  assert.equal(body.service_tier, 'default');
  assert.equal(body.prompt_cache_key, await promptCacheKey({ installationId: 'inst_credits' }));
  assert.deepEqual(body.input[0].content[0], BREAKPOINT_PART);
  assert.equal(joined(body), SLACK_TEXT);
  assert.deepEqual(charged, [null]);
});

for (const funding of ['customer', 'platform'] as const) {
  test(`a ${funding}-funded caller hook sees pi-ai's payload first, and the file it appends survives the breakpoint`, async (t) => {
    proxied(t);
    const seen: Array<Record<string, any>> = [];
    const callerHook: StreamOptions['onPayload'] = (payload) => {
      const built = payload as Record<string, any>;
      seen.push(structuredClone(built));
      const input = [...built.input];
      const last = input.at(-1);
      input[input.length - 1] = { ...last, content: [...last.content, PDF] };
      return { ...built, input };
    };

    const { body } = await send('gpt-5.6-terra', grant('openai', funding, 'inst_alpha'), hostedEnv('inst_alpha'), callerHook);

    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.prompt_cache_key, AFFINITY_KEY, 'the caller sees pi-ai\'s own key');
    assert.equal(seen[0]!.input[0].content, SLACK_TEXT, 'the caller sees the developer text as one string');
    assert.equal(seen[0]!.service_tier, undefined, 'the caller runs before the pin');
    assert.deepEqual(body.input.at(-1).content.at(-1), PDF, 'the appended file is sent');
    assert.deepEqual(body.input[0].content[0], BREAKPOINT_PART);
    assert.equal(body.prompt_cache_key, await promptCacheKey({ installationId: 'inst_alpha' }));
  });
}

test('a customer-funded request whose caller hook returns something other than an object is never sent', async (t) => {
  proxied(t);
  const provider = registeredPiProvider('openai')!;
  const model = provider.getModels().find((candidate) => candidate.id === 'gpt-5.6-terra')!;
  let sent = 0;
  const result = await withModelAccess(grant('openai', 'customer', 'inst_byok'), hostedEnv('inst_byok'), 'reply', () =>
    provider.streamSimple(model, normalizeContext(CONTEXT), {
      fetch: async () => {
        sent += 1;
        return new Response(LUNA_DEFAULT);
      },
      sessionId: AFFINITY_KEY,
      onPayload: () => 'payload',
    }).result());
  assert.equal(result.stopReason, 'error');
  assert.match(result.errorMessage ?? '', /A model request payload is not an object\./);
  assert.equal(sent, 0);
});

test('gpt-5.5 and a customer\'s proxy endpoint get pi-ai\'s request as it was built', async (t) => {
  proxied(t);
  const flagless = await send('gpt-5.5', grant('openai', 'customer', 'inst_byok'), hostedEnv('inst_byok'));
  assert.equal(flagless.body.prompt_cache_key, AFFINITY_KEY);
  assert.equal(flagless.body.input[0].content, SLACK_TEXT);

  configureModelAccessResolver({ resolve: async () => ({ apiKey: 'sk-prompt-cache-test-key', baseUrl: 'https://llm-proxy.example.com/v1' }) });
  const proxy = await send('gpt-5.6-terra', grant('openai', 'customer'), undefined);
  assert.equal(proxy.url, 'https://llm-proxy.example.com/v1/responses');
  assert.equal(proxy.body.prompt_cache_key, AFFINITY_KEY);
  assert.equal(proxy.body.input[0].content, SLACK_TEXT);
});

test('customer-funded Anthropic, OpenRouter and openai-codex requests still get no Core hook', async (t) => {
  proxied(t);
  const callerHook: StreamOptions['onPayload'] = (payload) => payload;
  const model = (provider: string, id: string) => {
    const found = getBuiltinModel(provider, id) as Model<Api> | undefined;
    assert.ok(found, `${provider}/${id}`);
    return found;
  };
  const routes = [
    ['anthropic', model('anthropic', 'claude-sonnet-5-5'), (fn: () => unknown) =>
      withModelAccess(grant('anthropic', 'customer', 'inst_byok'), hostedEnv('inst_byok'), 'reply', async () => fn())],
    ['openrouter', model('openrouter', 'openai/gpt-5'), (fn: () => unknown) =>
      withModelAccess(grant('openrouter', 'customer', 'inst_byok'), hostedEnv('inst_byok'), 'reply', async () => fn())],
    ['openai-codex', model('openai-codex', 'gpt-5.5'), (fn: () => unknown) =>
      withDeploymentLane(undefined, 'run_codex', 'reply', async () => fn())],
  ] as const;

  for (const [registeredId, routeModel, inScope] of routes) {
    for (const onPayload of [undefined, callerHook]) {
      const request = await inScope(() => modelAccessRequest(registeredId, routeModel, onPayload ? { onPayload } : {})) as
        ReturnType<typeof modelAccessRequest>;
      assert.equal(request.options?.onPayload, onPayload, `${registeredId}: the caller's hook, or none, goes to pi-ai as given`);
    }
  }
});
