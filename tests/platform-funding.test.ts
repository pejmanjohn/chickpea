import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import {
  createAssistantMessageEventStream,
  createProvider,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type Usage,
} from '@earendil-works/pi-ai';
import { init, instrument, useModel } from '@flue/runtime';
import { start } from '@flue/runtime/node';

import {
  compileRuntimePlanV2,
  frozenModelCredential,
  parseRuntimePlanModelCredential,
} from '../src/agents/runtime-plan.ts';
import {
  configureInstallationAdmission,
  resetInstallationAdmissionForTests,
} from '../src/config/installation-admission.ts';
import {
  frozenModelAccessGrant,
  installationModelAccessGrant,
  resolveInstallationModelAccess,
  RuntimeModelReadinessError,
} from '../src/config/installation-model-access.ts';
import { installationOwnershipOf, scopeInstallationEnv } from '../src/config/installation-scope.ts';
import {
  ModelAccessError,
  configureModelAccessResolver,
  configureModelRequestRecorder,
  createModelAccessInterceptor,
  resetModelAccessForTests,
  withModelAccess,
  type ModelAccessGrant,
} from '../src/config/model-access.ts';
import { resolveModelCredentialAttribution } from '../src/config/model-credential-refs.ts';
import { registerPiProvider, registeredPiProvider } from '../src/config/pi-provider-registry.ts';
import {
  configurePlatformFunding,
  installationFunding,
  resetPlatformFundingForTests,
  type PlatformFundedModel,
  type PlatformFundingPort,
} from '../src/config/platform-funding.ts';
import { invalidateProviderKeyCache } from '../src/config/provider-keys.ts';
import { resolveRuntimeModel } from '../src/config/runtime-model.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import type { PlatformEnv } from '../src/config/state-backend.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { ANTHROPIC_COMPAT_PROVIDER_ID } from '../src/model-catalog/provider-alias.ts';
import { AgentPromptFailure, agentFailureText, promptSlackThreadAgent } from '../src/slack/flue-dispatch.ts';
import type { FlueDispatchEnvelopeV1 } from '../src/slack/turn-job-types.ts';
import { CREDITS_EXHAUSTED_TEXT } from '../src/slack/web-client-presenter.ts';
import type { ModelRequestRecord } from '../src/usage/model-requests.ts';
import { priceCatalogFor } from '../src/usage/pricing/catalog.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import { withEnv } from './helpers/env.ts';

const NOW = Date.UTC(2026, 9, 7, 12);
const SONNET = 'claude-sonnet-5-5';
const KIMI = 'moonshotai/kimi-k3';
const HOSTED = { CHICKPEA_TENANCY: 'installation' } as const;
const NO_DEPLOYMENT_KEYS = {
  CHICKPEA_TENANCY: undefined,
  ANTHROPIC_API_KEY: undefined,
  OPENAI_API_KEY: undefined,
  OPENROUTER_API_KEY: undefined,
  ANTHROPIC_BASE_URL: undefined,
  LOCAL_STUB_URL: undefined,
};

function hostedEnv(installationId: string): PlatformEnv {
  return scopeInstallationEnv(HOSTED as Record<string, unknown>, { installationId }) as PlatformEnv;
}

/** A host's port: platform funding, admitted, a 1.5 multiplier unless overridden; it remembers every call. */
function fakePort(overrides: Partial<PlatformFundingPort> = {}) {
  const calls = {
    funding: [] as string[],
    admit: [] as Array<{ grant: ModelAccessGrant; model: PlatformFundedModel }>,
    charge: [] as ModelRequestRecord[],
    priceMultiplier: 0,
  };
  configurePlatformFunding({
    funding: async (installationId) => {
      calls.funding.push(installationId);
      return overrides.funding ? overrides.funding(installationId) : 'platform';
    },
    admit: async (grant, model) => {
      calls.admit.push({ grant, model });
      return overrides.admit ? overrides.admit(grant, model) : 'admitted';
    },
    charge: async (record) => {
      calls.charge.push(record);
      if (overrides.charge) await overrides.charge(record);
    },
    priceMultiplier: async (grant) => {
      calls.priceMultiplier += 1;
      return overrides.priceMultiplier ? overrides.priceMultiplier(grant) : 1.5;
    },
  });
  return calls;
}

function usage(partial: Partial<Usage> = {}): Usage {
  const input = partial.input ?? 0;
  const output = partial.output ?? 0;
  return {
    input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function reply(model: Model<string>, stopReason: 'stop' | 'aborted', tokens: Partial<Usage> = {}): AssistantMessage {
  return {
    role: 'assistant', content: stopReason === 'stop' ? [{ type: 'text', text: 'ok' }] : [],
    api: model.api, provider: model.provider, model: model.id, stopReason, timestamp: 1,
    usage: usage(tokens),
    ...(stopReason === 'stop' ? {} : { errorMessage: 'stopped' }),
  };
}

type Script = (output: AssistantMessageEventStream, model: Model<string>) => void;
const completes = (tokens: Partial<Usage> = { input: 10, output: 5 }): Script => (output, model) => {
  output.push({ type: 'done', reason: 'stop', message: reply(model, 'stop', tokens) });
  output.end();
};

/** A provider registered through the production seam that remembers the model each request was sent with. */
function scriptedProvider(
  id: string,
  modelId: string,
  api: 'anthropic-messages' | 'openai-completions',
  scripts: Script[],
  compat?: Record<string, unknown>,
) {
  const model = {
    id: modelId, name: modelId, api, provider: id,
    baseUrl: 'https://provider.invalid', reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_192,
    ...(compat ? { compat } : {}),
  } as Model<typeof api>;
  const sentModels: Model<string>[] = [];
  const stream = (sentModel: Model<string>) => {
    sentModels.push(sentModel);
    const output = createAssistantMessageEventStream();
    const script = scripts.shift();
    assert.ok(script, 'a scripted reply remains for every request sent');
    queueMicrotask(() => script(output, sentModel));
    return output;
  };
  registerPiProvider(createProvider({
    id,
    auth: { apiKey: { name: 'probe', resolve: async () => ({ auth: {} }) } },
    models: [model],
    api: { stream, streamSimple: stream },
  }));
  return { model, sentModels };
}

function modelCall(model: Model<string>): Promise<AssistantMessage> {
  return registeredPiProvider(model.provider)!.streamSimple(model, {
    systemPrompt: 'probe',
    messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
  }, {}).result();
}

function grant(
  installationId: string,
  fundingSource: ModelAccessGrant['fundingSource'],
  providerId: ModelAccessGrant['providerId'] = 'anthropic',
): ModelAccessGrant {
  return {
    installationId, providerId, runId: `run_${installationId}`, fundingSource,
    credentialRefId: fundingSource === 'platform' ? `platform:${providerId}` : `cred_${providerId}`,
    credentialVersion: 1,
  };
}

/** A hosted installation whose admission passes; each request's record is kept in a store. */
function hostedProxy(t: TestContext, installationId = 'inst_credits') {
  resetModelAccessForTests();
  resetPlatformFundingForTests();
  configureInstallationAdmission(async () => 'admitted');
  const store = new SqliteUsageStore(':memory:');
  const recorded: ModelRequestRecord[] = [];
  configureModelAccessResolver({ resolve: async () => ({ apiKey: 'sk-platform-funding-test-key' }) });
  configureModelRequestRecorder(async (record) => {
    recorded.push(record);
    return store.recordModelRequest(record);
  });
  t.after(() => {
    store.close();
    resetModelAccessForTests();
    resetPlatformFundingForTests();
    resetInstallationAdmissionForTests();
  });
  return { env: hostedEnv(installationId), store, recorded };
}

test('with no port installed every installation is customer-funded, and standalone never asks a port', async (t) => {
  t.after(() => resetPlatformFundingForTests());
  resetPlatformFundingForTests();
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    assert.equal(await installationFunding(undefined), 'customer');
    assert.equal(await installationFunding(hostedEnv('inst_portless')), 'customer');

    const calls = fakePort();
    assert.equal(await installationFunding(undefined), 'customer');
    assert.deepEqual(calls.funding, [], 'standalone never asks the port');
    assert.equal(await installationFunding(hostedEnv('inst_ported')), 'platform');
    assert.deepEqual(calls.funding, ['inst_ported']);
  });
});

test('a credits installation with no saved key passes readiness and freezes platform funding into its plan and grant', async (t) => {
  resetPlatformFundingForTests();
  invalidateProviderKeyCache();
  const settings = new SqliteSettingsStore(':memory:');
  const usageStore = new SqliteUsageStore(':memory:');
  t.after(() => {
    settings.close();
    usageStore.close();
    resetPlatformFundingForTests();
    invalidateProviderKeyCache();
  });
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const env = hostedEnv('inst_no_key');
    await assert.rejects(resolveRuntimeModel('agent', `anthropic/${SONNET}`, { settings, env }), (error: unknown) =>
      error instanceof RuntimeModelReadinessError && error.status === 'provider_setup_required',
    'without platform funding a missing key needs setup');
    assert.equal(await installationModelAccessGrant('anthropic', env, 'run_no_key', settings), undefined);

    fakePort();
    assert.ok((await resolveRuntimeModel('agent', `anthropic/${SONNET}`, { settings, env })).model);
    const attribution = await resolveModelCredentialAttribution(`anthropic/${SONNET}`, env, settings, usageStore);
    assert.deepEqual(attribution, {
      credentialRefId: 'platform:anthropic', version: 1, providerId: 'anthropic', sourceKind: 'platform',
      label: 'Chickpea credits', scopeLabel: null, unknownRotation: false,
    });

    const assignment: ResolvedAssignment = {
      workspaceId: 'T1', channelId: 'C1', agentId: 'agent_credits', runtimeContract: 'chickpea-v1', ownerIncarnation: 1,
      agent: {
        id: 'agent_credits', kind: 'user', revision: 1, name: 'Credits', instructions: 'Answer.', enabled: true,
        model: `anthropic/${SONNET}`, skills: [], mcpServers: [], apiConnections: [], repositories: [],
      },
      model: `anthropic/${SONNET}`,
      modelAttribution: { source: 'pinned', providerId: 'anthropic' },
      modelCredential: attribution!,
    };
    const plan = compileRuntimePlanV2({
      installation: installationOwnershipOf(env)!,
      turn: {
        workspaceId: 'T1', channelId: 'C1', eventId: 'E1', text: 'Hello', userId: 'U1', actorMembershipId: 'membership_1',
        messageTs: '1788000000.000200', threadTs: '1788000000.000100', source: 'app_mention', contextMode: 'thread',
      },
      assignment,
      instructions: 'Answer.',
      memoryEpoch: 1,
    });
    assert.deepEqual(plan.modelCredential, {
      credentialRefId: 'platform:anthropic', version: 1, providerId: 'anthropic', fundingSource: 'platform',
    });
    const thawed = parseRuntimePlanModelCredential(JSON.parse(JSON.stringify(plan.modelCredential)));
    assert.equal(frozenModelAccessGrant(thawed, 'inst_no_key', 'run_frozen')?.fundingSource, 'platform');
    assert.deepEqual(await installationModelAccessGrant('anthropic', env, 'run_live', settings), {
      installationId: 'inst_no_key', providerId: 'anthropic', credentialRefId: 'platform:anthropic',
      credentialVersion: 1, runId: 'run_live', fundingSource: 'platform',
    });
    await assert.rejects(resolveInstallationModelAccess('openai', env, 'image-generation', settings), (error: unknown) =>
      error instanceof ModelAccessError && error.code === 'funding_not_offered',
    'a model client outside the proxy is never handed platform funding');
  });
});

test('a plan credential without a funding field parses as customer, and a funding field must match its reference', () => {
  const customer = parseRuntimePlanModelCredential({ credentialRefId: 'cred_anthropic', version: 3, providerId: 'anthropic' });
  assert.deepEqual(customer, { credentialRefId: 'cred_anthropic', version: 3, providerId: 'anthropic' });
  assert.equal(frozenModelAccessGrant(customer, 'inst', 'run')?.fundingSource, 'customer');
  assert.deepEqual(
    parseRuntimePlanModelCredential({ ...customer, fundingSource: 'customer' }),
    customer,
    'an explicit customer field reads as the absent one, so a customer plan keeps its identity',
  );
  assert.deepEqual(frozenModelCredential(customer), customer, 'a customer credential is frozen without the field');
  const platform = { credentialRefId: 'platform:openrouter', version: 1, providerId: 'openrouter', fundingSource: 'platform' };
  assert.deepEqual(parseRuntimePlanModelCredential(platform), platform);
  const { fundingSource: _platformField, ...unmarked } = platform;
  for (const mismatched of [
    unmarked,
    { ...platform, fundingSource: 'customer' },
    { ...customer, fundingSource: 'platform' },
    { ...customer, fundingSource: 'sponsor' },
  ]) {
    assert.throws(() => parseRuntimePlanModelCredential(mismatched), /fundingSource/, JSON.stringify(mismatched));
  }
});

test('an installation out of credits is refused before any provider call, and the refusal is not reused', async (t) => {
  const { env, recorded } = hostedProxy(t);
  const calls = fakePort({ admit: async () => 'credits_exhausted' });
  const { model, sentModels } = scriptedProvider(ANTHROPIC_COMPAT_PROVIDER_ID, SONNET, 'anthropic-messages', [completes()]);
  const platform = grant('inst_credits', 'platform');

  const refused = await withModelAccess(platform, env, () => modelCall(model));

  assert.equal(refused.stopReason, 'error');
  assert.match(refused.errorMessage ?? '', /\(credits_exhausted\)/);
  assert.equal(sentModels.length, 0, 'nothing reached the provider');
  assert.deepEqual(calls.admit, [{ grant: platform, model: { provider: 'anthropic', model: SONNET } }]);
  assert.deepEqual([recorded.length, calls.charge.length], [0, 0], 'a request refused before send has no record and no charge');

  await withModelAccess(platform, env, () => modelCall(model));
  assert.equal(calls.admit.length, 2, 'a refusal is asked again, so added credits apply at once');
  assert.equal(sentModels.length, 0);
});

test('the credit gate refuses when the port throws or none is installed, unlike installation admission', async (t) => {
  const { env } = hostedProxy(t);
  const calls = fakePort({ admit: async () => { throw new Error('ledger unreachable'); } });
  const { model, sentModels } = scriptedProvider(ANTHROPIC_COMPAT_PROVIDER_ID, SONNET, 'anthropic-messages', [completes()]);

  const unreadable = await withModelAccess(grant('inst_credits', 'platform'), env, () => modelCall(model));
  assert.equal(unreadable.stopReason, 'error');
  assert.match(unreadable.errorMessage ?? '', /\(credits_unavailable\)/);
  assert.doesNotMatch(unreadable.errorMessage ?? '', /ledger unreachable/, 'the port error stays out of the conversation');
  assert.equal(calls.admit.length, 1);

  configurePlatformFunding(undefined);
  const portless = await withModelAccess(grant('inst_credits', 'platform'), env, () => modelCall(model));
  assert.match(portless.errorMessage ?? '', /\(credits_unavailable\)/);
  assert.equal(sentModels.length, 0);
});

test('a positive answer serves an installation for at most 30 seconds, and only that installation', async (t) => {
  hostedProxy(t);
  let now = NOW;
  resetPlatformFundingForTests({ now: () => now });
  const calls = fakePort();
  const { model } = scriptedProvider(ANTHROPIC_COMPAT_PROVIDER_ID, SONNET, 'anthropic-messages',
    Array.from({ length: 4 }, () => completes()));
  const call = (installationId: string, at: number) => {
    now = at;
    return withModelAccess(grant(installationId, 'platform'), hostedEnv(installationId), () => modelCall(model));
  };

  await call('inst_credits', NOW);
  await call('inst_credits', NOW + 29_999);
  assert.equal(calls.admit.length, 1);
  await call('inst_other', NOW + 29_999);
  assert.equal(calls.admit.length, 2, 'another installation asks for itself');
  await call('inst_credits', NOW + 30_000);
  assert.equal(calls.admit.length, 3, 'the answer expired after 30 seconds');
});

test('a customer grant of a hosted installation is never admitted against credits nor charged', async (t) => {
  const { env, recorded } = hostedProxy(t);
  const calls = fakePort();
  const { model, sentModels } = scriptedProvider(ANTHROPIC_COMPAT_PROVIDER_ID, SONNET, 'anthropic-messages', [completes()]);

  assert.equal((await withModelAccess(grant('inst_credits', 'customer'), env, () => modelCall(model))).stopReason, 'stop');

  assert.equal(sentModels.length, 1);
  assert.deepEqual([calls.admit.length, calls.charge.length, calls.priceMultiplier], [0, 0, 0]);
  assert.equal(recorded[0]?.fundingSource, 'customer');
});

test('each finished platform-funded request is charged once with its record, a stopped stream with its partial usage', async (t) => {
  const { env, store, recorded } = hostedProxy(t);
  const calls = fakePort();
  const { model } = scriptedProvider(ANTHROPIC_COMPAT_PROVIDER_ID, SONNET, 'anthropic-messages', [
    completes({ input: 1_000, output: 200 }),
    (output, sent) => {
      const partial = reply(sent, 'aborted', { input: 800, output: 37 });
      output.push({ type: 'start', partial: { ...partial, stopReason: 'stop' } });
      output.push({ type: 'error', reason: 'aborted', error: partial });
      output.end();
    },
  ]);

  const results = await withModelAccess(grant('inst_credits', 'platform'), env, async () =>
    [await modelCall(model), await modelCall(model)]);

  assert.deepEqual(results.map((result) => result.stopReason), ['stop', 'aborted']);
  assert.equal(calls.charge.length, 2);
  assert.deepEqual(calls.charge, recorded, 'the charge carries the record the proxy wrote');
  assert.deepEqual(await Promise.all(calls.charge.map((record) => store.getModelRequest(record.requestId))), calls.charge);
  assert.deepEqual(
    calls.charge.map((record) => [record.fundingSource, record.outcome, record.inputTokens, record.outputTokens.total]),
    [['platform', 'completed', 1_000, 200], ['platform', 'stopped', 800, 37]],
  );
  assert.equal(new Set(calls.charge.map((record) => record.requestId)).size, 2);
});

test('a failed charge is logged once without content and never retried; the model result is unchanged', async (t) => {
  const { env, recorded } = hostedProxy(t);
  const calls = fakePort({
    charge: async () => { throw Object.assign(new Error('ledger write failed'), { code: 'ledger_down' }); },
  });
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  const { model } = scriptedProvider(ANTHROPIC_COMPAT_PROVIDER_ID, SONNET, 'anthropic-messages', [completes()]);

  const result = await withModelAccess(grant('inst_credits', 'platform'), env, () => modelCall(model));

  assert.equal(result.stopReason, 'stop');
  assert.equal(calls.charge.length, 1);
  assert.equal(recorded.length, 1, 'the record is still written');
  assert.deepEqual(warnings, [['[chickpea] model request charge failed', {
    route: ANTHROPIC_COMPAT_PROVIDER_ID, model: SONNET, requestId: recorded[0]!.requestId, error: 'ledger_down',
  }]]);
});

test('a platform-funded OpenRouter request names its charged price as the most it may cost', async (t) => {
  const { env } = hostedProxy(t);
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const calls = fakePort();
  const { model, sentModels } = scriptedProvider('openrouter', KIMI, 'openai-completions',
    [completes(), completes()], { openRouterRouting: { sort: 'price' } });

  await withModelAccess(grant('inst_credits', 'platform', 'openrouter'), env, () => modelCall(model));
  await withModelAccess(grant('inst_credits', 'customer', 'openrouter'), env, () => modelCall(model));

  const price = priceCatalogFor('standard_input_output', 'openrouter', KIMI, NOW);
  assert.ok(price);
  assert.deepEqual(sentModels[0]!.compat, {
    openRouterRouting: {
      sort: 'price',
      max_price: {
        prompt: (price.rate.inputMicrosPerUnit * 1.5) / price.rate.unitScale,
        completion: (price.rate.outputMicrosPerUnit * 1.5) / price.rate.unitScale,
      },
    },
  });
  assert.deepEqual(sentModels[1]!.compat, { openRouterRouting: { sort: 'price' } }, 'a customer request is not capped');
  assert.equal(calls.priceMultiplier, 1);
  assert.deepEqual(calls.admit.map(({ model: admitted }) => admitted), [{ provider: 'openrouter', model: KIMI }]);
});

test('a platform-funded OpenRouter request is refused without a list price or a usable multiplier', async (t) => {
  const { env } = hostedProxy(t);
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  fakePort({ priceMultiplier: async () => Number.NaN });
  const unpriced = scriptedProvider('openrouter', 'acme/unpriced-model', 'openai-completions', []);
  const refusedUnpriced = await withModelAccess(grant('inst_credits', 'platform', 'openrouter'), env,
    () => modelCall(unpriced.model));
  assert.match(refusedUnpriced.errorMessage ?? '', /no current list price/);
  assert.equal(unpriced.sentModels.length, 0);

  const priced = scriptedProvider('openrouter', KIMI, 'openai-completions', []);
  const refusedMultiplier = await withModelAccess(grant('inst_credits', 'platform', 'openrouter'), env,
    () => modelCall(priced.model));
  assert.match(refusedMultiplier.errorMessage ?? '', /\(credits_unavailable\)/);
  assert.equal(priced.sentModels.length, 0);
});

test('a Slack turn refused for credits ends with the credits reply, its own kind, and no retry', { timeout: 20_000 }, async (t) => {
  const { env } = hostedProxy(t, 'inst_flue');
  const calls = fakePort({ admit: async () => 'credits_exhausted' });
  const { sentModels } = scriptedProvider(ANTHROPIC_COMPAT_PROVIDER_ID, SONNET, 'anthropic-messages', []);
  const interceptor = createModelAccessInterceptor({
    lookup: async () => ({ env, grant: grant('inst_flue', 'platform'), agentId: 'agent_credits' }),
    installationGrants: async () => [],
  });
  t.after(instrument({ key: Symbol('credits'), interceptor, observe() {}, dispose() {} }));
  function CreditsProbe() {
    useModel(`${ANTHROPIC_COMPAT_PROVIDER_ID}/${SONNET}`);
    return 'Answer briefly.';
  }
  const runtime = await start({
    agents: [{ agent: CreditsProbe, name: 'credits-probe' }],
    providers: [registeredPiProvider(ANTHROPIC_COMPAT_PROVIDER_ID)!],
  });
  let failure: unknown;
  try {
    const agent = init(CreditsProbe, { id: 'credits-turn' });
    const receipt = await agent.dispatch('Hello');
    failure = await promptSlackThreadAgent({
      handle: agent, message: 'unused saved dispatch', turnId: 'credits-turn',
      conversationKey: 'T_FIXTURE:C_FIXTURE:1',
      requestedModel: `anthropic/${SONNET}`,
      state: {
        dispatchEnvelope: { instanceId: 'credits-turn' } as FlueDispatchEnvelopeV1,
        dispatchReceipt: receipt,
        prepare: () => { throw new Error('Must reuse saved dispatch'); },
        reconcileExistingInstance: () => { throw new Error('Must reuse saved instance'); },
        recordReceipt: (value) => value,
        recordSettlement: (value) => value,
        markRecoveryRequired: () => {},
      },
    }).then(() => undefined, (error: unknown) => error);
  } finally {
    await runtime.stop();
  }

  assert.ok(failure instanceof AgentPromptFailure, String(failure));
  assert.equal(failure.kind, 'credits-exhausted');
  assert.equal(failure.retryable, false);
  assert.equal(agentFailureText(failure),
    "This workspace is out of Chickpea credits, so I can't continue. An admin can add credits in Chickpea.");
  assert.equal(agentFailureText(failure), CREDITS_EXHAUSTED_TEXT);
  assert.equal(sentModels.length, 0);
  assert.equal(calls.admit.length, 1, 'Flue did not retry the refused request');
});
