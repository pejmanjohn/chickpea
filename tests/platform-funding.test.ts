import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import {
  createAssistantMessageEventStream,
  createProvider,
  normalizeContext,
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
  CreditsExhaustedError,
  dailyLimitOf,
  DailyLimitError,
  installationFunding,
  isCreditsExhausted,
  PLATFORM_ADMISSION_TTL_MS,
  outOfUsageOf,
  resetPlatformFundingForTests,
  type AdmissionStage,
  type PlatformFundedModel,
  type PlatformFundingAdmission,
  type PlatformFundingPort,
} from '../src/config/platform-funding.ts';
import { invalidateProviderKeyCache } from '../src/config/provider-keys.ts';
import { resolveRuntimeModel } from '../src/config/runtime-model.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import type { PlatformEnv } from '../src/config/state-backend.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { ANTHROPIC_COMPAT_PROVIDER_ID } from '../src/model-catalog/provider-alias.ts';
import {
  AgentPromptFailure,
  agentFailureText,
  classifyAgentPromptFailure,
  promptSlackThreadAgent,
} from '../src/slack/flue-dispatch.ts';
import type { FlueDispatchEnvelopeV1, FlueSettlementCheckpointV1 } from '../src/slack/turn-job-types.ts';
import { fundingRefusalText } from '../src/slack/credits-ask.ts';
import type { ModelRequestRecord } from '../src/usage/model-requests.ts';
import { priceCatalogFor, RELEASE_PRICE_CATALOGS } from '../src/usage/pricing/catalog.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';
import { useDeploymentKeyring } from './helpers/deployment-keyring.ts';
import { withEnv } from './helpers/env.ts';
import { NO_RUN_FEES } from './helpers/platform-funding.ts';

const NOW = Date.UTC(2026, 9, 7, 12);
const RESUMES_AT = Date.UTC(2026, 9, 8);
const DAILY_LIMIT = { kind: 'daily_limit', scope: 'workspace', resumesAt: RESUMES_AT } as const;
const FLEET_LIMIT = { ...DAILY_LIMIT, scope: 'fleet' } as const;
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
    stages: [] as AdmissionStage[],
    charge: [] as ModelRequestRecord[],
  };
  configurePlatformFunding({
    funding: async (installationId) => {
      calls.funding.push(installationId);
      return overrides.funding ? overrides.funding(installationId) : 'platform';
    },
    admit: async (grant, model, stage) => {
      calls.admit.push({ grant, model });
      calls.stages.push(stage);
      return overrides.admit ? overrides.admit(grant, model, stage) : 'admitted';
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
  return registeredPiProvider(model.provider)!.streamSimple(model, normalizeContext({
    systemPrompt: 'probe',
    messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
  }), {}).result();
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

test('a daily limit is refused before any provider call with its own reason, scope and time, and is not reused', async (t) => {
  const { env, recorded } = hostedProxy(t);
  let answer: PlatformFundingAdmission = DAILY_LIMIT;
  const calls = fakePort({ admit: async () => answer });
  const { model, sentModels } = scriptedProvider(ANTHROPIC_COMPAT_PROVIDER_ID, SONNET, 'anthropic-messages', [completes()]);
  const platform = grant('inst_daily', 'platform');

  const refused = await withModelAccess(platform, env, 'reply', () => modelCall(model));

  assert.equal(refused.stopReason, 'error');
  assert.match(refused.errorMessage ?? '', new RegExp(String.raw`\(daily_limit:workspace:${RESUMES_AT / 1000}\)`));
  assert.doesNotMatch(refused.errorMessage ?? '', /\(credits_exhausted\)/);
  assert.deepEqual([sentModels.length, recorded.length, calls.charge.length], [0, 0, 0]);

  answer = FLEET_LIMIT;
  const fleet = await withModelAccess(platform, env, 'reply', () => modelCall(model));
  assert.equal(calls.admit.length, 2, 'a daily limit is asked again, so a plan chosen meanwhile applies at once');
  assert.match(fleet.errorMessage ?? '', new RegExp(String.raw`\(daily_limit:fleet:${RESUMES_AT / 1000}\)`));
  assert.equal(sentModels.length, 0);
});

test('a malformed daily limit fails closed as unavailable', async (t) => {
  const { env } = hostedProxy(t);
  let answer: unknown;
  fakePort({ admit: async () => answer as PlatformFundingAdmission });
  const { model, sentModels } = scriptedProvider(ANTHROPIC_COMPAT_PROVIDER_ID, SONNET, 'anthropic-messages', [completes()]);
  for (const malformed of [
    { kind: 'daily_limit', scope: 'workspace' },
    ...[Number.NaN, Number.POSITIVE_INFINITY, 0, -RESUMES_AT, RESUMES_AT + 0.5, 9e15, String(RESUMES_AT)]
      .map((resumesAt) => ({ ...DAILY_LIMIT, resumesAt })),
    { kind: 'daily_limit', resumesAt: RESUMES_AT },
    ...['team', 'Workspace', '', null].map((scope) => ({ ...DAILY_LIMIT, scope })),
    { ...DAILY_LIMIT, kind: 'weekly_limit' },
    'daily_limit',
    null,
  ]) {
    answer = malformed;
    const refused = await withModelAccess(grant('inst_daily', 'platform'), env, 'reply', () => modelCall(model));
    assert.match(refused.errorMessage ?? '', /\(credits_unavailable\)/, JSON.stringify(malformed));
  }
  assert.equal(sentModels.length, 0);
});

test('a daily limit\'s text is read back only as itself, with its scope, and only with a port', () => {
  resetPlatformFundingForTests();
  const flueFailure = (message: string) => ({ type: 'operation_failed', message: `dispatch(sub_1) failed: ${message}` });
  const daily = flueFailure(new DailyLimitError(DAILY_LIMIT).message);
  const fleet = flueFailure(new DailyLimitError(FLEET_LIMIT).message);
  const credits = flueFailure(new CreditsExhaustedError().message);
  const envelope = (failure: { type: string; message: string }) => JSON.stringify({ error: failure });

  assert.equal(dailyLimitOf(new DailyLimitError(DAILY_LIMIT)), undefined, 'no port, no daily limit');
  assert.equal(dailyLimitOf(daily), undefined);
  assert.equal(classifyAgentPromptFailure(500, envelope(daily)), 'agent');

  fakePort();
  assert.deepEqual(dailyLimitOf(new DailyLimitError(DAILY_LIMIT)), DAILY_LIMIT);
  assert.deepEqual(dailyLimitOf({ message: 'run failed', cause: { cause: daily } }), DAILY_LIMIT, 'deep in a chain');
  assert.deepEqual(classifyAgentPromptFailure(500, envelope(daily)), DAILY_LIMIT);
  assert.deepEqual(classifyAgentPromptFailure(500, envelope(fleet)), FLEET_LIMIT);
  assert.equal(isCreditsExhausted(daily), false, 'a daily limit is not taken for credits');
  assert.equal(dailyLimitOf(credits), undefined, 'nor credits for a daily limit');
  assert.equal(classifyAgentPromptFailure(500, envelope(credits)), 'credits-exhausted');
  for (const text of [
    '(daily_limit:workspace:0)', '(daily_limit:workspace:)', '(daily_limit:fleet:soon)', '(daily_limit:fleet:-1)',
    '(daily_limit:team:1793836800)', '(daily_limit:1793836800)', 'daily_limit:workspace:1793836800',
  ]) {
    assert.equal(dailyLimitOf(flueFailure(text)), undefined, text);
  }
  resetPlatformFundingForTests();
});

test('a refusal carries the host\'s cause through the text a Flue failure keeps, with no digit Flue would retry on', async (t) => {
  const { env } = hostedProxy(t);
  let answer: PlatformFundingAdmission = {
    kind: 'credits_exhausted', cause: { kind: 'top_up_limit', limitCents: 50_000 },
  };
  fakePort({ admit: async () => answer });
  const { model, sentModels } = scriptedProvider(ANTHROPIC_COMPAT_PROVIDER_ID, SONNET, 'anthropic-messages', [completes()]);
  const platform = grant('inst_credits', 'platform');

  const refused = await withModelAccess(platform, env, 'reply', () => modelCall(model));
  const text = refused.errorMessage ?? '';
  assert.match(text, /\(credits_exhausted:top_up_limit:limitCents=faaaa\)/);
  assert.doesNotMatch(text, /\d/, 'Flue retries a failure whose text holds 500 anywhere');
  const flueFailure = { type: 'operation_failed', message: `dispatch(sub_1) failed: ${text}` };
  assert.deepEqual(outOfUsageOf({ message: 'run failed', cause: flueFailure }),
    { kind: 'credits_exhausted', cause: { kind: 'top_up_limit', limitCents: 50_000 } });
  assert.equal(isCreditsExhausted(flueFailure), true);

  answer = { kind: 'credits_exhausted', cause: { kind: 'trial_used', plansFromCents: 2_500, bonusPercent: 20 } };
  const trial = await withModelAccess(platform, env, 'reply', () => modelCall(model));
  assert.deepEqual(outOfUsageOf({ message: trial.errorMessage }),
    { kind: 'credits_exhausted', cause: { kind: 'trial_used', plansFromCents: 2_500, bonusPercent: 20 } });

  for (const [hostCause, read] of [
    [{ kind: 'auto_upgrade_off' }, undefined],
    [{ kind: 'top_up_limit', limitCents: -1 }, { kind: 'top_up_limit' }],
    [{ kind: 'top_up_limit', limitCents: 12.5 }, { kind: 'top_up_limit' }],
    [{ kind: 'top_up_limit', limitCents: 1e12 }, { kind: 'top_up_limit' }],
    [{ kind: 'plan_used', limitCents: 5_000 }, { kind: 'plan_used' }],
    [{ kind: 'toString' }, undefined],
    ['top_up_limit', undefined],
  ] as const) {
    answer = { kind: 'credits_exhausted', cause: hostCause } as unknown as PlatformFundingAdmission;
    const result = await withModelAccess(platform, env, 'reply', () => modelCall(model));
    assert.deepEqual(outOfUsageOf({ message: result.errorMessage }),
      read ? { kind: 'credits_exhausted', cause: read } : { kind: 'credits_exhausted' }, JSON.stringify(hostCause));
  }
  assert.equal(sentModels.length, 0);
});

test('a cause\'s text is read back only whole, and only with a port', () => {
  resetPlatformFundingForTests();
  const limit = new CreditsExhaustedError({ kind: 'top_up_limit', limitCents: 5_000 });
  assert.equal(outOfUsageOf(limit), undefined, 'no port, no refusal');
  fakePort();
  assert.deepEqual(outOfUsageOf(limit), { kind: 'credits_exhausted', cause: { kind: 'top_up_limit', limitCents: 5_000 } });
  assert.deepEqual(outOfUsageOf({ message: new CreditsExhaustedError().message }), { kind: 'credits_exhausted' });
  assert.deepEqual(outOfUsageOf({ message: '(credits_exhausted:a_later_cause:limitCents=faaa)' }),
    { kind: 'credits_exhausted' }, 'a cause another Core version names is still a refusal, in general words');
  assert.deepEqual(outOfUsageOf({ message: '(credits_exhausted:plan_used:laterAmount=b)' }),
    { kind: 'credits_exhausted', cause: { kind: 'plan_used' } }, 'an amount it does not know is left out');
  for (const text of [
    '(credits_exhausted:top_up_limit:limitCents=5000)', '(credits_exhausted:)', 'credits_exhausted:plan_used',
    '(credits_exhausted:top_up_limit:limitCents=)',
  ]) {
    assert.equal(outOfUsageOf({ message: text }), undefined, text);
  }
  resetPlatformFundingForTests();
});

test('a top-up in flight is asked again each second, and refused as out of usage after 10 seconds', async (t) => {
  const { env } = hostedProxy(t);
  let now = NOW;
  resetPlatformFundingForTests({ now: () => now, sleep: async (ms) => { now += ms; } });
  let answers: PlatformFundingAdmission[] = ['pending', 'pending', 'admitted'];
  const calls = fakePort({ admit: async () => answers.shift() ?? 'pending' });
  const { model, sentModels } = scriptedProvider(ANTHROPIC_COMPAT_PROVIDER_ID, SONNET, 'anthropic-messages', [completes()]);
  const platform = grant('inst_topup', 'platform');

  const landed = await withModelAccess(platform, env, 'reply', () => modelCall(model));
  assert.equal(landed.stopReason, 'stop');
  assert.deepEqual([calls.admit.length, now - NOW], [3, 2_000], 'it waited for the charge to land');

  now += PLATFORM_ADMISSION_TTL_MS;
  const before = now;
  answers = [];
  const refused = await withModelAccess(platform, env, 'reply', () => modelCall(model));
  assert.match(refused.errorMessage ?? '', /\(credits_exhausted\)/);
  assert.deepEqual([calls.admit.length - 3, now - before], [11, 10_000], 'one ask, then one a second for 10 seconds');
  assert.equal(sentModels.length, 1);
});

test('an attempt\'s first request starts its run and later ones continue it, and a running run never lets a new one start', async (t) => {
  hostedProxy(t);
  let now = NOW;
  resetPlatformFundingForTests({ now: () => now });
  const env = hostedEnv('inst_credits');
  let aboveZero = true;
  const calls = fakePort({
    admit: async (_grant, _model, stage) => stage === 'continue' || aboveZero ? 'admitted' : 'credits_exhausted',
  });
  const { model, sentModels } = scriptedProvider(ANTHROPIC_COMPAT_PROVIDER_ID, SONNET, 'anthropic-messages',
    Array.from({ length: 3 }, () => completes()));
  const platform = grant('inst_credits', 'platform');

  await withModelAccess(platform, env, 'reply', async () => {
    await modelCall(model);
    await modelCall(model);
    assert.deepEqual(calls.stages, ['start'], 'a start admission serves the run\'s next request');
    aboveZero = false;
    now += PLATFORM_ADMISSION_TTL_MS;
    assert.equal((await modelCall(model)).stopReason, 'stop', 'an admitted run keeps going past zero');
  });
  assert.deepEqual(calls.stages, ['start', 'continue']);

  const next = await withModelAccess(platform, env, 'reply', () => modelCall(model));
  assert.match(next.errorMessage ?? '', /\(credits_exhausted\)/, 'the continue just admitted does not admit a new run');
  assert.deepEqual(calls.stages, ['start', 'continue', 'start']);
  assert.equal(sentModels.length, 3);
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

test('a request reporting a token part above its total is recorded and charged with the part at its total, and logs one line', async (t) => {
  const { env, store } = hostedProxy(t);
  const calls = fakePort();
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  const reports = (parts: Partial<Usage>): Script => (output, sent) => {
    const message = reply(sent, 'stop', { input: 1_000, output: 200 });
    output.push({ type: 'done', reason: 'stop', message: { ...message, usage: { ...message.usage, ...parts } } });
    output.end();
  };
  const { model } = scriptedProvider(ANTHROPIC_COMPAT_PROVIDER_ID, SONNET, 'anthropic-messages', [
    reports({ reasoning: 350 }),
    reports({ reasoning: 201, cacheWrite: 40, cacheWrite1h: 90 }),
  ]);
  const price = priceCatalogFor('standard_input_output', 'anthropic', SONNET, NOW);
  assert.ok(price?.rate.cacheWrite1hMicrosPerUnit);

  await withModelAccess(grant('inst_credits', 'platform'), env, 'reply', async () => {
    await modelCall(model);
    await modelCall(model);
  });

  assert.equal(calls.charge.length, 2);
  assert.deepEqual(await Promise.all(calls.charge.map((record) => store.getModelRequest(record.requestId))), calls.charge,
    'each request is recorded as charged');
  assert.deepEqual(calls.charge.map(({ outputTokens, cacheWriteTokens }) => [outputTokens, cacheWriteTokens]), [
    [{ total: 200, reasoning: 200 }, { total: 0, oneHour: null }],
    [{ total: 200, reasoning: 200 }, { total: 40, oneHour: 40 }],
  ]);
  assert.deepEqual(
    [calls.charge[1]?.priceVersionId, calls.charge[1]?.listPriceUsdMicros],
    [price.version.id, Math.round((1_000 * price.rate.inputMicrosPerUnit + 200 * price.rate.outputMicrosPerUnit +
      40 * price.rate.cacheWrite1hMicrosPerUnit) / price.rate.unitScale)],
    'every write is charged at the one-hour rate',
  );
  const line = ['[chickpea] model request reported a token part above its total', { provider: 'anthropic', model: SONNET }];
  assert.deepEqual(warnings, [line, line]);
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

// Defects caught: the charge released from the result's hold (a charge
// confirmed after the caller moved on), and the result held for the record
// write again.
test('a platform-funded result waits for its charge as before, but not for its record write', async (t) => {
  const { env, store } = hostedProxy(t);
  let releaseCharge!: () => void;
  const chargeHeld = new Promise<void>((resolve) => { releaseCharge = resolve; });
  const calls = fakePort({ charge: () => chargeHeld });
  let releaseRecord!: () => void;
  const recordHeld = new Promise<void>((resolve) => { releaseRecord = resolve; });
  const recorded: ModelRequestRecord[] = [];
  configureModelRequestRecorder(async (record) => {
    recorded.push(record);
    await recordHeld;
    return store.recordModelRequest(record);
  });
  const { model } = scriptedProvider(ANTHROPIC_COMPAT_PROVIDER_ID, SONNET, 'anthropic-messages', [completes()]);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
  let read = false;

  await withModelAccess(grant('inst_credits', 'platform'), env, 'reply', async () => {
    const result = modelCall(model).then((message) => { read = true; return message; });
    while (calls.charge.length === 0) await tick();
    await tick();
    assert.equal(read, false, 'the result waits for the charge');
    const charged = performance.now();
    releaseCharge();
    assert.equal((await result).stopReason, 'stop');
    const waited = performance.now() - charged;
    assert.ok(waited < 1_000, `the result arrived ${waited} ms after the charge, not at the record budget`);
    assert.equal(await store.getModelRequest(recorded[0]!.requestId), undefined, 'the record write is still held');
    releaseRecord();
  });

  assert.deepEqual(calls.charge, recorded, 'the charge carries the record the proxy wrote');
  assert.deepEqual(await store.getModelRequest(recorded[0]!.requestId), recorded[0]);
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

  const newest = priceCatalogFor('standard_input_output', 'anthropic', SONNET, Number.MAX_SAFE_INTEGER);
  assert.ok(newest);
  t.mock.timers.setTime(newest.version.staleAfter);
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

test('a Slack turn refused for credits ends with the out-of-usage reply, the host\'s cause, and no retry', { timeout: 20_000 }, async (t) => {
  const { env } = hostedProxy(t, 'inst_flue');
  const refusal = { kind: 'credits_exhausted', cause: { kind: 'top_up_limit', limitCents: 50_000 } } as const;
  const calls = fakePort({ admit: async () => refusal });
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
  assert.deepEqual(failure.outOfUsage, refusal, 'the cause survived the Flue failure\'s text');
  assert.equal(agentFailureText(failure),
    "This workspace is out of usage for now, so I can't start this one. Once an Owner adds more, send it again.",
    'the public reply names no amount and no cause');
  assert.equal(sentModels.length, 0);
  assert.equal(calls.admit.length, 1, 'Flue did not retry the refused request, though its limit holds 500');
});

test('a Slack turn at a daily limit ends with the daily-limit reply, its time, no retry, and the same on replay', { timeout: 20_000 }, async (t) => {
  const { env } = hostedProxy(t, 'inst_flue_daily');
  const calls = fakePort({ admit: async () => DAILY_LIMIT });
  const { sentModels } = scriptedProvider(ANTHROPIC_COMPAT_PROVIDER_ID, SONNET, 'anthropic-messages', []);
  const interceptor = createModelAccessInterceptor({
    lookup: async () => ({ env, grant: grant('inst_flue_daily', 'platform'), agentId: 'agent_daily' }),
    installationGrants: async () => [],
  });
  t.after(instrument({ key: Symbol('daily-limit'), interceptor, observe() {}, dispose() {} }));
  function DailyLimitProbe() {
    useModel(`${ANTHROPIC_COMPAT_PROVIDER_ID}/${SONNET}`);
    return 'Answer briefly.';
  }
  const runtime = await start({
    agents: [{ agent: DailyLimitProbe, name: 'daily-limit-probe' }],
    providers: [registeredPiProvider(ANTHROPIC_COMPAT_PROVIDER_ID)!],
  });
  const settlements: FlueSettlementCheckpointV1[] = [];
  const state = (flueSettlement?: FlueSettlementCheckpointV1) => ({
    dispatchEnvelope: { instanceId: 'daily-limit-turn' } as FlueDispatchEnvelopeV1,
    ...(flueSettlement ? { flueSettlement } : {}),
    prepare: () => { throw new Error('Must reuse saved dispatch'); },
    reconcileExistingInstance: () => { throw new Error('Must reuse saved instance'); },
    recordReceipt: (value: never) => value,
    recordSettlement: (value: FlueSettlementCheckpointV1) => { settlements.push(value); return value; },
    markRecoveryRequired: () => {},
  });
  const prompt = (input: Pick<Parameters<typeof promptSlackThreadAgent>[0], 'handle' | 'state'>) => promptSlackThreadAgent({
    ...input, message: 'unused saved dispatch', turnId: 'daily-limit-turn',
    conversationKey: 'T_FIXTURE:C_FIXTURE:1', requestedModel: `anthropic/${SONNET}`,
  }).then(() => undefined, (error: unknown) => error);
  let failure: unknown;
  let replayed: unknown;
  try {
    const agent = init(DailyLimitProbe, { id: 'daily-limit-turn' });
    const receipt = await agent.dispatch('Hello');
    failure = await prompt({ handle: agent, state: { ...state(), dispatchReceipt: receipt } });
    replayed = await prompt({ handle: agent, state: { ...state(settlements[0]), dispatchReceipt: receipt } });
  } finally {
    await runtime.stop();
  }

  assert.ok(failure instanceof AgentPromptFailure, String(failure));
  assert.deepEqual([failure.kind, failure.dailyLimit, failure.retryable], ['daily-limit', DAILY_LIMIT, false]);
  assert.equal(agentFailureText(failure), fundingRefusalText(DAILY_LIMIT));
  assert.deepEqual(settlements.map(({ settledAt: _at, ...rest }) => rest), [{
    outcome: 'failed', failureKind: 'daily-limit', dailyLimit: { scope: 'workspace', resumesAt: RESUMES_AT },
  }]);
  assert.ok(replayed instanceof AgentPromptFailure, String(replayed));
  assert.deepEqual([replayed.kind, replayed.dailyLimit], ['daily-limit', DAILY_LIMIT], 'the replayed settlement says the same');
  assert.equal(sentModels.length, 0);
  assert.equal(calls.admit.length, 1, 'Flue did not retry the refused request');
});

const ADMIN_TOKEN = 'platform-funding-admin-token';
assert.ok(priceCatalogFor('standard_input_output', 'anthropic', SONNET, NOW), 'the Admin test model is priced at NOW');
/** A later version replaces an earlier one, so the model has no current price once its newest version is stale. */
const SONNET_NEWEST_PRICE = priceCatalogFor('standard_input_output', 'anthropic', SONNET, Number.MAX_SAFE_INTEGER);
assert.ok(SONNET_NEWEST_PRICE);
const AFTER_SONNET_PRICE_STALE = SONNET_NEWEST_PRICE.version.staleAfter;
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
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
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

test('Admin reads an Agent model on a credits installation as ready by its price, and on its own key by its key', async (t) => {
  const { request } = await creditsAdmin(t);
  const unavailable = async (modelId: string) => {
    const response = await request(`/admin/api/models/readiness?modelId=${encodeURIComponent(modelId)}`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { modelId: string; unavailable: string | null };
    assert.equal(body.modelId, modelId);
    return body.unavailable;
  };
  const DROPPED = 'openai/gpt-4.1-mini-2025-04-14';
  const DROPPED_ANSWER = {
    modelId: DROPPED,
    unavailable: 'model_unsupported',
    message: 'The active OpenAI API-key catalog does not support this model.',
  };
  const dropped = async () => (await request(`/admin/api/models/readiness?modelId=${encodeURIComponent(DROPPED)}`)).json();

  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    fakePort();
    assert.equal(await unavailable(`anthropic/${SONNET}`), null, 'credits serve a priced model with no saved key');
    assert.equal(await unavailable('anthropic/claude-opus-4-5'), 'funding_not_offered', 'credits serve only a priced model');
    assert.deepEqual(
      await dropped(),
      DROPPED_ANSWER,
      'a priced model the active catalog does not serve is refused first, with the reason, as the Workspace default reads it',
    );
    assert.equal(
      await unavailable('cloudflare/@cf/zai-org/glm-5.2'),
      'funding_not_offered',
      'credits serve only a provider the deployment offers',
    );
    t.mock.timers.setTime(AFTER_SONNET_PRICE_STALE);
    assert.equal(await unavailable(`anthropic/${SONNET}`), 'funding_not_offered', 'credits serve only a current price');
    t.mock.timers.setTime(NOW);
    fakePort({ funding: async () => 'customer' });
    assert.equal(await unavailable(`anthropic/${SONNET}`), 'credential_missing', 'a customer-funded installation needs its own key');
    assert.deepEqual(await dropped(), DROPPED_ANSWER, 'a keyless own key hears the catalog reason before the missing key');
  });
});

test('on a credits installation Admin lists the models Chickpea\'s models serve and marks the providers they cover', async (t) => {
  const { request } = await creditsAdmin(t);
  const read = async <T>(path: string): Promise<T> => {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    return (await response.json()) as T;
  };
  type Listed = { id: string; configured: boolean; source: string; suggestions: string[] };
  const anthropic = async () =>
    (await read<{ providers: Listed[] }>('/admin/api/models')).providers.find(({ id }) => id === 'anthropic')!;
  const cards = async () =>
    (await read<{ providers: Array<{ id: string; platformFunded?: boolean }> }>('/admin/api/providers')).providers;

  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    fakePort();
    const served = await anthropic();
    assert.equal(served.configured, true, 'Chickpea\'s models serve Anthropic with no saved key');
    assert.equal(served.source, 'Chickpea’s models');
    assert.ok(served.suggestions.includes(`anthropic/${SONNET}`));
    for (const model of served.suggestions) {
      const readiness = await read<{ unavailable: string | null }>(`/admin/api/models/readiness?modelId=${encodeURIComponent(model)}`);
      assert.equal(readiness.unavailable, null, `${model} is listed only when the readiness rule serves it`);
    }
    assert.deepEqual(
      (await read<{ models: Array<{ id: string }> }>('/admin/api/providers/anthropic/models')).models.map(({ id }) => `anthropic/${id}`),
      served.suggestions,
      'the picker\'s live list on Chickpea\'s models is the same list',
    );
    assert.deepEqual((await cards()).map(({ id, platformFunded }) => [id, platformFunded]), [
      ['anthropic', true],
      ['openai', true],
      ['openrouter', true],
    ]);

    t.mock.timers.setTime(AFTER_SONNET_PRICE_STALE);
    assert.ok(!(await anthropic()).suggestions.includes(`anthropic/${SONNET}`), 'a stale price leaves the list');
    t.mock.timers.setTime(NOW);

    fakePort({ funding: async () => 'customer' });
    const ownKey = await anthropic();
    assert.equal(ownKey.configured, false, 'a customer-funded installation needs its own key');
    assert.notEqual(ownKey.source, 'Chickpea’s models');
    assert.ok(ownKey.suggestions.includes(`anthropic/${SONNET}`));
    assert.ok((await cards()).every((card) => !('platformFunded' in card)));
  });
});

test('on a credits installation Admin lists the OpenRouter models Chickpea\'s models price, with no key or starred model', async (t) => {
  const { request } = await creditsAdmin(t);
  const read = async <T>(path: string): Promise<T> => {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    return (await response.json()) as T;
  };
  type Listed = { id: string; configured: boolean; suggestions: string[] };
  const listed = async () => (await read<{ providers: Listed[] }>('/admin/api/models')).providers;
  const marked = async () =>
    (await read<{ providers: Array<{ id: string; platformFunded?: boolean }> }>('/admin/api/providers')).providers
      .filter(({ platformFunded }) => platformFunded).map(({ id }) => id);

  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    fakePort();
    const openrouter = (await listed()).find(({ id }) => id === 'openrouter')!;
    assert.equal(openrouter.configured, true);
    for (const chosen of ['deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash', 'moonshotai/kimi-k3']) {
      assert.ok(openrouter.suggestions.includes(`openrouter/${chosen}`), `${chosen} is listed: ${openrouter.suggestions.join(', ')}`);
    }
    for (const model of openrouter.suggestions) {
      const readiness = await read<{ unavailable: string | null }>(`/admin/api/models/readiness?modelId=${encodeURIComponent(model)}`);
      assert.equal(readiness.unavailable, null, `${model} is listed only when the readiness rule serves it`);
    }
    assert.ok((await marked()).includes('openrouter'));

    t.mock.timers.setTime(Math.max(...RELEASE_PRICE_CATALOGS.map(({ staleAfter }) => staleAfter)));
    assert.deepEqual(
      (await listed()).filter(({ configured, suggestions }) => configured || suggestions.length > 0).map(({ id }) => id),
      [],
      'with no current price Chickpea\'s models list nothing',
    );
    assert.deepEqual(await marked(), [], 'and mark no provider card');
  });
});

test('each Admin model request on a credits installation asks the funding port once', async (t) => {
  const { request } = await creditsAdmin(t);
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    for (const path of [
      '/admin/api/models',
      '/admin/api/providers',
      '/admin/api/providers/anthropic/models',
      `/admin/api/models/readiness?modelId=${encodeURIComponent(`anthropic/${SONNET}`)}`,
      '/admin/api/workspace-model-default',
    ]) {
      const calls = fakePort();
      const response = await request(path);
      assert.equal(response.status, 200, path);
      assert.equal(calls.funding.length, 1, `${path} asked the funding port ${calls.funding.length} times`);
    }
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
