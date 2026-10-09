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
import { Hono } from 'hono';

import { createAdminRoutes } from '../src/admin/routes.ts';
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
  RuntimeModelReadinessError,
} from '../src/config/installation-model-access.ts';
import { installationOwnershipOf, scopeInstallationEnv } from '../src/config/installation-scope.ts';
import {
  configureModelAccessResolver,
  configureModelRequestRecorder,
  createModelAccessInterceptor,
  resetModelAccessForTests,
  withModelAccess,
  type ModelAccessGrant,
} from '../src/config/model-access.ts';
import {
  resolveModelCredentialAttribution,
  revalidateModelCredentialAttribution,
  rotateInstallationModelCredential,
} from '../src/config/model-credential-refs.ts';
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
import { SqliteConfigStore } from '../src/config/store.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { ANTHROPIC_COMPAT_PROVIDER_ID } from '../src/model-catalog/provider-alias.ts';
import { AgentPromptFailure, agentFailureText, promptSlackThreadAgent } from '../src/slack/flue-dispatch.ts';
import type { FlueDispatchEnvelopeV1 } from '../src/slack/turn-job-types.ts';
import { CREDITS_EXHAUSTED_TEXT } from '../src/slack/web-client-presenter.ts';
import type { ModelRequestRecord } from '../src/usage/model-requests.ts';
import { priceCatalogFor } from '../src/usage/pricing/catalog.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';
import { useDeploymentKeyring } from './helpers/deployment-keyring.ts';
import { withEnv } from './helpers/env.ts';
import { NO_RUN_FEES } from './helpers/platform-funding.ts';

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

function fakePort(overrides: Partial<PlatformFundingPort> = {}) {
  const calls = {
    funding: [] as string[],
    admit: [] as Array<{ grant: ModelAccessGrant; model: PlatformFundedModel }>,
    charge: [] as ModelRequestRecord[],
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
    charge: async (record, sharedPrefix) => {
      calls.charge.push(record);
      if (overrides.charge) await overrides.charge(record, sharedPrefix);
    },
    ...NO_RUN_FEES,
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
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
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
      label: "Chickpea's models", scopeLabel: null, unknownRotation: false,
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
  });
});

test('the platform credential keeps its version and relabels the row saved under the old label', async (t) => {
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
  await usageStore.putCredential({
    credentialRefId: 'platform:anthropic', version: 1, providerId: 'anthropic', sourceKind: 'platform',
    label: 'Chickpea credits', scopeLabel: null, unknownRotation: false, activeFrom: 0,
  });
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    fakePort();
    const env = hostedEnv('inst_relabelled');
    for (const request of ['first', 'second']) {
      const attribution = await resolveModelCredentialAttribution(`anthropic/${SONNET}`, env, settings, usageStore);
      assert.deepEqual([attribution?.version, attribution?.label], [1, "Chickpea's models"], request);
    }
  });
  assert.deepEqual(warnings, [], 'the registry raised no conflict');
  assert.deepEqual(
    (await usageStore.listCredentials('anthropic')).map(({ version, label }) => ({ version, label })),
    [{ version: 1, label: "Chickpea's models" }],
  );
});

test('a plan frozen under the old label still revalidates after the relabel, so retries and resumes go on', async (t) => {
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
  await usageStore.putCredential({
    credentialRefId: 'platform:anthropic', version: 1, providerId: 'anthropic', sourceKind: 'platform',
    label: 'Chickpea credits', scopeLabel: null, unknownRotation: false, activeFrom: 0,
  });
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    fakePort();
    const frozenBeforeDeploy = { credentialRefId: 'platform:anthropic', version: 1, providerId: 'anthropic' };
    await revalidateModelCredentialAttribution(
      `anthropic/${SONNET}`, frozenBeforeDeploy, hostedEnv('inst_in_flight'), settings, usageStore,
    );
  });
});

test('a port that cannot say an installation\'s funding leaves it on its own key, never on platform funding', async (t) => {
  resetPlatformFundingForTests();
  invalidateProviderKeyCache();
  const keyring = useDeploymentKeyring(t);
  const settings = new SqliteSettingsStore(':memory:');
  const usageStore = new SqliteUsageStore(':memory:');
  t.after(() => {
    settings.close();
    usageStore.close();
    resetPlatformFundingForTests();
    invalidateProviderKeyCache();
  });
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const byok = hostedEnv('inst_byok');
    const keyless = hostedEnv('inst_keyless');
    await rotateInstallationModelCredential('anthropic', { kind: 'save', apiKey: 'sk-ant-byok-installation-key' },
      { env: byok, settings, usage: usageStore, keyring });
    const keylessSettings = new SqliteSettingsStore(':memory:');
    t.after(() => keylessSettings.close());
    fakePort({ funding: async () => { throw new Error('billing registry unreachable'); } });

    assert.ok((await resolveRuntimeModel('agent', `anthropic/${SONNET}`, { settings, env: byok })).model);
    const own = await resolveModelCredentialAttribution(`anthropic/${SONNET}`, byok, settings, usageStore);
    assert.equal(own?.sourceKind, 'stored');
    assert.equal((await installationModelAccessGrant('anthropic', byok, 'run_byok', settings))?.fundingSource, 'customer');

    await assert.rejects(resolveRuntimeModel('agent', `anthropic/${SONNET}`, { settings: keylessSettings, env: keyless }),
      (error: unknown) => error instanceof RuntimeModelReadinessError && error.status === 'provider_setup_required');
    assert.equal(await installationModelAccessGrant('anthropic', keyless, 'run_keyless', keylessSettings), undefined);
    assert.deepEqual(warnings, [[JSON.stringify({ component: 'platform_funding', event: 'funding_unavailable' })]],
      'one content-free line a minute');
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

  const refused = await withModelAccess(platform, env, 'reply', () => modelCall(model));

  assert.equal(refused.stopReason, 'error');
  assert.match(refused.errorMessage ?? '', /\(credits_exhausted\)/);
  assert.equal(sentModels.length, 0, 'nothing reached the provider');
  assert.deepEqual(calls.admit, [{ grant: platform, model: { provider: 'anthropic', model: SONNET } }]);
  assert.deepEqual([recorded.length, calls.charge.length], [0, 0], 'a request refused before send has no record and no charge');

  await withModelAccess(platform, env, 'reply', () => modelCall(model));
  assert.equal(calls.admit.length, 2, 'a refusal is asked again, so added credits apply at once');
  await withModelAccess(platform, undefined, 'reply', () => modelCall(model));
  assert.equal(calls.admit.length, 3, 'a platform grant is gated even on a cell that names no installation');
  assert.equal(sentModels.length, 0);
});

test('the credit gate refuses when the port throws or none is installed, unlike installation admission', async (t) => {
  const { env } = hostedProxy(t);
  const calls = fakePort({ admit: async () => { throw new Error('ledger unreachable'); } });
  const { model, sentModels } = scriptedProvider(ANTHROPIC_COMPAT_PROVIDER_ID, SONNET, 'anthropic-messages', [completes()]);

  const unreadable = await withModelAccess(grant('inst_credits', 'platform'), env, 'reply', () => modelCall(model));
  assert.equal(unreadable.stopReason, 'error');
  assert.match(unreadable.errorMessage ?? '', /\(credits_unavailable\)/);
  assert.doesNotMatch(unreadable.errorMessage ?? '', /ledger unreachable/, 'the port error stays out of the conversation');
  assert.equal(calls.admit.length, 1);

  configurePlatformFunding(undefined);
  const portless = await withModelAccess(grant('inst_credits', 'platform'), env, 'reply', () => modelCall(model));
  assert.match(portless.errorMessage ?? '', /\(credits_unavailable\)/);
  assert.equal(sentModels.length, 0);
});

test('a refusal answered while an earlier admission is in flight is not overwritten by it', async (t) => {
  const { env } = hostedProxy(t);
  const answers: Array<(admission: 'admitted' | 'credits_exhausted') => void> = [];
  const calls = fakePort({ admit: () => new Promise((resolve) => { answers.push(resolve); }) });
  const { model, sentModels } = scriptedProvider(ANTHROPIC_COMPAT_PROVIDER_ID, SONNET, 'anthropic-messages', [completes()]);
  const platform = grant('inst_credits', 'platform');

  const early = withModelAccess(platform, env, 'reply', () => modelCall(model));
  const late = withModelAccess(platform, env, 'reply', () => modelCall(model));
  while (answers.length < 2) await new Promise((resolve) => setImmediate(resolve));
  answers[1]!('credits_exhausted');
  assert.match((await late).errorMessage ?? '', /\(credits_exhausted\)/);
  answers[0]!('admitted');
  assert.equal((await early).stopReason, 'stop', 'the earlier request was admitted when it was asked');

  const next = withModelAccess(platform, env, 'reply', () => modelCall(model));
  while (answers.length < 3) await new Promise((resolve) => setImmediate(resolve));
  answers[2]!('credits_exhausted');
  assert.match((await next).errorMessage ?? '', /\(credits_exhausted\)/, 'the next request asked the port again');
  assert.deepEqual([calls.admit.length, sentModels.length], [3, 1]);
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
    return withModelAccess(grant(installationId, 'platform'), hostedEnv(installationId), 'reply', () => modelCall(model));
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

  assert.equal((await withModelAccess(grant('inst_credits', 'customer'), env, 'reply', () => modelCall(model))).stopReason, 'stop');

  assert.equal(sentModels.length, 1);
  assert.deepEqual([calls.admit.length, calls.charge.length], [0, 0]);
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

  const results = await withModelAccess(grant('inst_credits', 'platform'), env, 'reply', async () =>
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

test('a charge names what its request was for: an attempt\'s request a reply, a stateless call its own purpose', async (t) => {
  const { env } = hostedProxy(t);
  const calls = fakePort();
  const { model } = scriptedProvider(ANTHROPIC_COMPAT_PROVIDER_ID, SONNET, 'anthropic-messages', [completes(), completes()]);
  const interceptor = createModelAccessInterceptor({
    lookup: async () => ({ env, grant: grant('inst_credits', 'platform'), agentId: 'agent_credits' }),
    installationGrants: async () => [],
  });

  await interceptor(
    { type: 'agent', operationId: 'op', operationKind: 'prompt' },
    { instanceId: 'credits', submissionId: 'sub_credits', agentName: 'chickpea-slack-v2' },
    () => modelCall(model),
  );
  const intent = { ...grant('inst_credits', 'platform'), runId: 'slack-interaction-intent' };
  await withModelAccess(intent, env, 'intent', () => modelCall(model));

  assert.deepEqual(calls.charge.map(({ purpose, runId, agentId }) => ({ purpose, runId, agentId })), [
    { purpose: 'reply', runId: 'sub_credits', agentId: 'agent_credits' },
    { purpose: 'intent', runId: 'slack-interaction-intent', agentId: null },
  ]);
});

test('a failed charge is tried once more under the same request ID, and a charge that succeeds then logs nothing', async (t) => {
  const { env, recorded } = hostedProxy(t);
  let failures = 1;
  const calls = fakePort({
    charge: async () => {
      if (failures-- > 0) throw new Error('ledger write timed out');
    },
  });
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  const { model } = scriptedProvider(ANTHROPIC_COMPAT_PROVIDER_ID, SONNET, 'anthropic-messages', [completes()]);

  assert.equal((await withModelAccess(grant('inst_credits', 'platform'), env, 'reply', () => modelCall(model))).stopReason, 'stop');

  assert.deepEqual(calls.charge, [recorded[0], recorded[0]], 'the retry carries the same record and request ID');
  assert.deepEqual(warnings, []);
});

test('a charge that fails twice is logged once without content, and the installation\'s next request asks the port again', async (t) => {
  const { env, recorded } = hostedProxy(t);
  const calls = fakePort({
    charge: async () => { throw Object.assign(new Error('ledger write failed'), { code: 'ledger_down' }); },
  });
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  const { model } = scriptedProvider(ANTHROPIC_COMPAT_PROVIDER_ID, SONNET, 'anthropic-messages', [completes(), completes()]);
  const platform = grant('inst_credits', 'platform');

  const result = await withModelAccess(platform, env, 'reply', () => modelCall(model));

  assert.equal(result.stopReason, 'stop', 'the model result is unchanged');
  assert.equal(calls.charge.length, 2);
  assert.equal(recorded.length, 1, 'the record is still written');
  assert.deepEqual(warnings, [['[chickpea] model request charge failed', {
    route: ANTHROPIC_COMPAT_PROVIDER_ID, model: SONNET, requestId: recorded[0]!.requestId, error: 'ledger_down',
  }]]);
  await withModelAccess(platform, env, 'reply', () => modelCall(model));
  assert.equal(calls.admit.length, 2, 'the failed charge dropped the cached admission');
});

test('a platform-funded request without a current list price is refused before send, whatever its provider', async (t) => {
  const { env } = hostedProxy(t);
  const calls = fakePort();
  const unpricedAnthropic = scriptedProvider(ANTHROPIC_COMPAT_PROVIDER_ID, 'claude-unpriced-test', 'anthropic-messages',
    [completes()]);
  const unpricedOpenRouter = scriptedProvider('openrouter', 'acme/unpriced-503', 'openai-completions', []);

  for (const [model, providerId] of [
    [unpricedAnthropic.model, 'anthropic'],
    [unpricedOpenRouter.model, 'openrouter'],
  ] as const) {
    const refused = await withModelAccess(grant('inst_credits', 'platform', providerId), env, 'reply', () => modelCall(model));
    assert.match(refused.errorMessage ?? '', /no current price in Chickpea credits/, providerId);
    assert.ok(!refused.errorMessage?.includes(model.id), 'the refusal names no model, whose ID may hold a status code');
  }
  assert.deepEqual([unpricedAnthropic.sentModels.length, unpricedOpenRouter.sentModels.length], [0, 0]);
  assert.equal(calls.admit.length, 0, 'an unpriced model never reaches the ledger');
  const customer = await withModelAccess(grant('inst_credits', 'customer'), env, 'reply', () => modelCall(unpricedAnthropic.model));
  assert.equal(customer.stopReason, 'stop', 'a customer-funded request needs no price');

  const priced = priceCatalogFor('standard_input_output', 'anthropic', SONNET, NOW);
  assert.ok(priced);
  t.mock.timers.setTime(priced.version.staleAfter);
  const stale = scriptedProvider(ANTHROPIC_COMPAT_PROVIDER_ID, SONNET, 'anthropic-messages', []);
  const refusedStale = await withModelAccess(grant('inst_credits', 'platform'), env, 'reply', () => modelCall(stale.model));
  assert.match(refusedStale.errorMessage ?? '', /no current price in Chickpea credits/, 'a stale price is not current');
  assert.equal(stale.sentModels.length, 0);
});

test('a platform-funded OpenRouter request names the maker\'s price as the most it may cost', async (t) => {
  const { env } = hostedProxy(t);
  t.mock.timers.setTime(Date.UTC(2026, 9, 7, 16));
  const calls = fakePort();
  const { model, sentModels } = scriptedProvider('openrouter', KIMI, 'openai-completions',
    [completes(), completes()], { openRouterRouting: { sort: 'price' } });

  await withModelAccess(grant('inst_credits', 'platform', 'openrouter'), env, 'reply', () => modelCall(model));
  await withModelAccess(grant('inst_credits', 'customer', 'openrouter'), env, 'reply', () => modelCall(model));

  assert.deepEqual(sentModels[0]!.compat, {
    openRouterRouting: { sort: 'price', max_price: { prompt: 3, completion: 15 } },
  }, 'the maker\'s own price in USD per million tokens');
  assert.deepEqual(sentModels[1]!.compat, { openRouterRouting: { sort: 'price' } }, 'a customer request is not capped');
  assert.deepEqual(calls.admit.map(({ model: admitted }) => admitted), [{ provider: 'openrouter', model: KIMI }]);
});

test('a platform-funded request past the long-context threshold is charged at the long-context rates, and capped at them', async (t) => {
  const { env } = hostedProxy(t);
  const calls = fakePort();
  const TERRA = 'openai/gpt-5.6-terra';
  const price = priceCatalogFor('standard_input_output', 'openrouter', TERRA, NOW);
  assert.ok(price?.rate.longContext);
  const long = price.rate.longContext;
  const { model, sentModels } = scriptedProvider('openrouter', TERRA, 'openai-completions',
    [completes({ input: long.fromPromptTokens, output: 1_000 })]);

  await withModelAccess(grant('inst_credits', 'platform', 'openrouter'), env, 'reply', () => modelCall(model));

  assert.deepEqual(
    [calls.charge[0]?.priceVersionId, calls.charge[0]?.listPriceUsdMicros, calls.charge[0]?.priceUnknownReason],
    [price.version.id, Math.round((long.fromPromptTokens * long.inputMicrosPerUnit + 1_000 * long.outputMicrosPerUnit) /
      price.rate.unitScale), null],
  );
  assert.deepEqual(sentModels[0]!.compat, { openRouterRouting: { max_price: { prompt: 4, completion: 18 } } },
    'the long-context list rates in USD per million tokens');
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
    "This workspace has used all of its plan's usage, so I can't continue. " +
    'An admin can add extra usage or upgrade in Chickpea.');
  assert.equal(agentFailureText(failure), CREDITS_EXHAUSTED_TEXT);
  assert.equal(sentModels.length, 0);
  assert.equal(calls.admit.length, 1, 'Flue did not retry the refused request');
});

const ADMIN_TOKEN = 'platform-funding-admin-token';
const SONNET_PRICE = priceCatalogFor('standard_input_output', 'anthropic', SONNET, NOW);
assert.ok(SONNET_PRICE, 'the Admin test model is priced at NOW');
const AFTER_SONNET_PRICE_STALE = SONNET_PRICE.version.staleAfter;
const PROVIDER_UNAVAILABLE = {
  status: 'repair_required',
  providerId: 'anthropic',
  code: 'provider_unavailable',
  repairPath: '/admin/settings/providers',
};
const NOT_OFFERED = { ...PROVIDER_UNAVAILABLE, code: 'funding_not_offered' };

async function creditsAdmin(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  resetPlatformFundingForTests();
  invalidateProviderKeyCache();
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => {
    config.close();
    settings.close();
    resetPlatformFundingForTests();
    invalidateProviderKeyCache();
  });
  const app = new Hono();
  app.route('/', createAdminRoutes({ store: config, settings, ...testAdminAuthority(ADMIN_TOKEN) }));
  const base = await config.createAgent({
    id: 'agent_base', name: 'Base', instructions: 'Start.', enabled: true, lifecycle: 'active',
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  });
  const installation = await config.ensureWorkspaceInstallation({
    workspaceId: 'T_CREDITS', transportMode: 'direct', runtimeContract: 'legacy', defaultAgentId: base.id,
  });
  await config.putWorkspaceModelDefault({
    workspaceId: installation.workspaceId,
    modelId: `anthropic/${SONNET}`,
    provenance: 'admin_selected',
    lastChangedByMembershipId: 'membership_test_owner',
  }, 1);
  await config.updateWorkspaceInstallation(installation.workspaceId, { runtimeContract: 'chickpea-v1' }, installation.revision);
  const request = (path: string, init: RequestInit = {}) => app.request(path, {
    ...init,
    headers: { ...testAdminHeaders(ADMIN_TOKEN), 'content-type': 'application/json', ...init.headers },
  }, hostedEnv('inst_credits'));
  return { config, installation, request };
}

test('Admin reads a credits installation\'s Workspace default as ready with no saved key, and a customer-funded one as repair_required', async (t) => {
  const { config, installation, request } = await creditsAdmin(t);
  const health = async () => {
    const response = await request('/admin/api/workspace-model-default');
    assert.equal(response.status, 200);
    return ((await response.json()) as { workspaceDefault: { health: unknown } }).workspaceDefault.health;
  };

  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    fakePort();
    assert.deepEqual(await health(), { status: 'ready', providerId: 'anthropic' });
    t.mock.timers.setTime(AFTER_SONNET_PRICE_STALE);
    assert.deepEqual(await health(), NOT_OFFERED, 'credits serve only a model with a current price');
    t.mock.timers.setTime(NOW);
    fakePort({ funding: async () => 'customer' });
    assert.deepEqual(await health(), PROVIDER_UNAVAILABLE, 'a customer-funded installation still needs its own key');

    await config.putWorkspaceModelDefault({
      workspaceId: installation.workspaceId,
      modelId: 'cloudflare/@cf/zai-org/glm-5.2',
      provenance: 'admin_selected',
      lastChangedByMembershipId: 'membership_test_owner',
    }, 2);
    fakePort();
    assert.deepEqual(
      await health(),
      { ...NOT_OFFERED, providerId: 'cloudflare' },
      'credits serve only a provider the deployment offers',
    );
  });
});

test('a credits installation with no saved key can choose a priced coding model, and only a priced one', async (t) => {
  const { request } = await creditsAdmin(t);
  const choose = (modelId: string) => request('/admin/api/workspace-model-roles/coding', {
    method: 'PUT',
    body: JSON.stringify({ modelId, expectedRevision: 0 }),
  });
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    fakePort({ funding: async () => 'customer' });
    const keyless = await choose(`anthropic/${SONNET}`);
    assert.equal(keyless.status, 400);
    assert.deepEqual(await keyless.json(), {
      error: 'invalid_request',
      message: `Set up anthropic in Model providers before choosing anthropic/${SONNET}.`,
    });

    fakePort();
    t.mock.timers.setTime(AFTER_SONNET_PRICE_STALE);
    const unpriced = await choose(`anthropic/${SONNET}`);
    assert.equal(unpriced.status, 400);
    assert.deepEqual(await unpriced.json(), {
      error: 'invalid_request',
      message: "Not available on Chickpea's models. Choose another model.",
    });

    t.mock.timers.setTime(NOW);
    const chosen = await choose(`anthropic/${SONNET}`);
    assert.equal(chosen.status, 200);
    assert.equal(
      ((await chosen.json()) as { workspaceModelRole: { modelId: string | null } }).workspaceModelRole.modelId,
      `anthropic/${SONNET}`,
    );
  });
});
