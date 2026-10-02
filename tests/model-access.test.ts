import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import {
  createAssistantMessageEventStream,
  createProvider,
  type AssistantMessage,
  type Context,
  type Model,
  type StreamOptions,
} from '@earendil-works/pi-ai';
import type { FlueExecutionContext } from '@flue/runtime';

import { lookupAttemptModelAccess } from '../src/agents/model-access-lookup.ts';
import { compileRuntimePlanV2, deriveRuntimePlanInstanceId, type RuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import { createSlackTurnInput, rememberInProcessTurnInput } from '../src/agents/turn-input.ts';
import {
  configureInstallationAdmission,
  resetInstallationAdmissionForTests,
} from '../src/config/installation-admission.ts';
import {
  createInstallationModelAccessResolver,
  installationModelAccessGrant,
  installationModelAccessGrants,
  RuntimeModelReadinessError,
  withStatelessModelAccess,
} from '../src/config/installation-model-access.ts';
import {
  deploymentServesManyInstallations,
  installationOwnershipOf,
  installationScopeOf,
  scopeInstallationEnv,
  scopedObjectName,
} from '../src/config/installation-scope.ts';
import {
  ModelAccessError,
  configureModelAccessResolver,
  createModelAccessInterceptor,
  resetModelAccessForTests,
  withDeploymentLane,
  withModelAccess,
  type AttemptModelAccess,
  type ModelAccessGrant,
} from '../src/config/model-access.ts';
import {
  ModelCredentialRevisionError,
  rotateInstallationModelCredential,
  type ModelCredentialAction,
} from '../src/config/model-credential-refs.ts';
import {
  describeProviderKeySources,
  invalidateProviderKeyCache,
  listInstallationModelProviders,
  resolveProviderApiKey,
  type ProviderKeyId,
} from '../src/config/provider-keys.ts';
import {
  cachedProviderModelCount,
  invalidateProviderModelCache,
  primeProviderModelCache,
} from '../src/config/provider-models.ts';
import { recordRegisteredProvider } from '../src/config/providers.ts';
import { registerPiProvider, registeredPiProvider } from '../src/config/pi-provider-registry.ts';
import { resolveRuntimeModel } from '../src/config/runtime-model.ts';
import { saveOpenAiAuthMethod } from '../src/config/openai-auth.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { getRoutineStore, type PlatformEnv } from '../src/config/state-backend.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { createWorkModelInvocationInterceptor } from '../src/work/model-invocation.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import { useDeploymentKeyring } from './helpers/deployment-keyring.ts';
import { withEnv } from './helpers/env.ts';

const HOSTED = { CHICKPEA_TENANCY: 'installation' } as const;
const KEY_A1 = 'sk-ant-tenant-a-version-one';
const KEY_A2 = 'sk-ant-tenant-a-version-two';
const KEY_B = 'sk-ant-tenant-b-only';
const NO_DEPLOYMENT_KEYS = {
  CHICKPEA_TENANCY: undefined,
  ANTHROPIC_API_KEY: undefined,
  OPENAI_API_KEY: undefined,
  OPENROUTER_API_KEY: undefined,
  ANTHROPIC_BASE_URL: undefined,
  LOCAL_STUB_URL: undefined,
};

interface SentRequest {
  provider: string;
  apiKey: string | undefined;
  baseUrl: string;
  step: string;
}

/** A provider registered through the production seam that records what each request carried. */
function recordingProvider(id: string, sent: SentRequest[], reply?: (options?: StreamOptions) => AssistantMessage) {
  const model = {
    id: 'probe-model', name: 'Probe model', api: 'anthropic-messages', provider: id,
    baseUrl: 'https://provider.invalid', reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16_000, maxTokens: 1_024,
  } as Model<'anthropic-messages'>;
  const stream = (requestModel: Model<string>, context: Context, options?: StreamOptions) => {
    const last = context.messages.at(-1);
    sent.push({
      provider: id,
      apiKey: options?.apiKey,
      baseUrl: requestModel.baseUrl,
      step: typeof last?.content === 'string' ? last.content : '',
    });
    const output = createAssistantMessageEventStream();
    const message = reply?.(options) ?? assistant(id, 'stop');
    queueMicrotask(() => {
      output.push(message.stopReason === 'error'
        ? { type: 'error', reason: 'error', error: message }
        : { type: 'done', reason: 'stop', message });
      output.end();
    });
    return output;
  };
  registerPiProvider(createProvider({
    id,
    auth: { apiKey: { name: 'probe', resolve: async () => ({ auth: {} }) } },
    models: [model],
    api: { stream, streamSimple: stream },
  }));
  return model;
}

function assistant(provider: string, stopReason: 'stop' | 'error', errorMessage?: string): AssistantMessage {
  return {
    role: 'assistant', content: stopReason === 'stop' ? [{ type: 'text', text: 'ok' }] : [],
    api: 'anthropic-messages', provider, model: 'probe-model', stopReason, timestamp: 1,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    ...(errorMessage ? { errorMessage } : {}),
  };
}

async function modelCall(model: Model<string>, step: string): Promise<AssistantMessage> {
  return registeredPiProvider(model.provider)!.streamSimple(model, {
    systemPrompt: 'probe',
    messages: [{ role: 'user', content: step, timestamp: 1 }],
  }, {}).result();
}

/** Two installations of a deployment serving many, each with its own settings store and key. */
async function twoInstallations(t: TestContext) {
  resetModelAccessForTests();
  invalidateProviderKeyCache();
  // The host's registry admits both, as a deployment serving many installs it.
  configureInstallationAdmission(async () => 'admitted');
  const envA = scopeInstallationEnv(HOSTED as Record<string, unknown>, { installationId: 'inst_a' });
  const envB = scopeInstallationEnv(HOSTED as Record<string, unknown>, { installationId: 'inst_b' });
  const settings = new Map([['inst_a', new SqliteSettingsStore(':memory:')], ['inst_b', new SqliteSettingsStore(':memory:')]]);
  const usage = new SqliteUsageStore(':memory:');
  t.after(() => {
    for (const store of settings.values()) store.close();
    usage.close();
    resetModelAccessForTests();
    resetInstallationAdmissionForTests();
  });
  const settingsOf = (env: PlatformEnv | undefined) => settings.get(installationScopeOf(env)?.installationId ?? '')!;
  const keyring = useDeploymentKeyring(t);
  configureModelAccessResolver(createInstallationModelAccessResolver({ settings: settingsOf, keyring: () => keyring }));
  const rotate = (env: PlatformEnv, provider: ProviderKeyId, action: ModelCredentialAction) =>
    rotateInstallationModelCredential(provider, action, { env, settings: settingsOf(env), usage, keyring });
  await rotate(envA, 'anthropic', { kind: 'save', apiKey: KEY_A1 });
  await rotate(envB, 'anthropic', { kind: 'save', apiKey: KEY_B });
  const grant = async (env: PlatformEnv, runId: string) =>
    (await installationModelAccessGrant('anthropic', env, runId, settingsOf(env)))!;
  return { envA, envB, settingsOf, usage, grant, rotate };
}

/** Flue's coordinates for one attempt, as its coordinator opens the agent operation. */
function attemptContext(instanceId: string): FlueExecutionContext {
  return { instanceId, submissionId: `sub_${instanceId}`, agentName: 'chickpea-slack-v2' };
}

const AGENT_OPERATION = { type: 'agent', operationId: 'op', operationKind: 'prompt' } as const;
const MODEL_OPERATION = { type: 'model', turnId: 'turn' } as const;

function assistantAssignment(): ResolvedAssignment {
  return {
    workspaceId: 'T1', channelId: 'C1', agentId: 'agent_lookup', runtimeContract: 'chickpea-v1', ownerIncarnation: 1,
    agent: {
      id: 'agent_lookup', kind: 'user', revision: 1, name: 'Lookup', instructions: 'Answer.', enabled: true,
      model: 'anthropic/claude-haiku-4-5', skills: [], mcpServers: [], apiConnections: [], repositories: [],
    },
    model: 'anthropic/claude-haiku-4-5',
    modelAttribution: { source: 'pinned', providerId: 'anthropic' },
    modelCredential: {
      credentialRefId: 'cred_anthropic_environment', version: 1, providerId: 'anthropic',
      sourceKind: 'environment', label: 'Environment credential', scopeLabel: null, unknownRotation: true,
    },
  };
}

function compiledPlan(env?: PlatformEnv): RuntimePlanV2 {
  const installation = installationOwnershipOf(env);
  return compileRuntimePlanV2({
    ...(installation ? { installation } : {}),
    turn: {
      workspaceId: 'T1', channelId: 'C1', eventId: 'E1', text: 'Hello', userId: 'U1', actorMembershipId: 'membership_1',
      messageTs: '1788000000.000200', threadTs: '1788000000.000100', source: 'app_mention', contextMode: 'thread',
    },
    assignment: assistantAssignment(),
    instructions: 'Answer.',
    memoryEpoch: 1,
  });
}

test('interleaved attempts of two installations each send only their own key', async (t) => {
  const { envA, envB, grant } = await twoInstallations(t);
  const sent: SentRequest[] = [];
  const model = recordingProvider('anthropic', sent);
  const records = new Map<string, AttemptModelAccess>([
    ['agent_a', { env: envA, grant: await grant(envA, 'sub_agent_a') }],
    ['agent_b', { env: envB, grant: await grant(envB, 'sub_agent_b') }],
  ]);
  let lookups = 0;
  const interceptor = createModelAccessInterceptor({
    lookup: async (context) => { lookups += 1; return records.get(context.instanceId!)!; },
    installationGrants: async () => { throw new Error('a deployment serving many never falls back'); },
  });
  const step = (instanceId: string, label: string) =>
    interceptor(MODEL_OPERATION, attemptContext(instanceId), () => modelCall(model, label));
  let releaseA!: () => void;
  const aWaits = new Promise<void>((resolve) => { releaseA = resolve; });
  let releaseB!: () => void;
  const bWaits = new Promise<void>((resolve) => { releaseB = resolve; });
  await Promise.all([
    interceptor(AGENT_OPERATION, attemptContext('agent_a'), async () => {
      await step('agent_a', 'A1');
      releaseB();
      await aWaits;
      // A structured prompt or skill opens a nested agent operation of the same instance.
      await interceptor({ ...AGENT_OPERATION, operationKind: 'skill' }, { instanceId: 'agent_a' },
        () => step('agent_a', 'A2-skill'));
    }),
    interceptor(AGENT_OPERATION, attemptContext('agent_b'), async () => {
      await bWaits;
      await step('agent_b', 'B1');
      releaseA();
      await step('agent_b', 'B2');
    }),
  ]);
  assert.deepEqual(sent.map(({ step, apiKey }) => [step, apiKey]).sort(), [
    ['A1', KEY_A1], ['A2-skill', KEY_A1], ['B1', KEY_B], ['B2', KEY_B],
  ]);
  assert.equal(lookups, 2, 'one lookup per top-level attempt; the nested operation shares the cell');
});

test('rotation mid-attempt keeps the running attempt on its version; the next attempt is refused, then deletion fails closed', async (t) => {
  const { envA, envB, settingsOf, grant, rotate } = await twoInstallations(t);
  const sent: SentRequest[] = [];
  const model = recordingProvider('anthropic', sent);
  const frozenA = await grant(envA, 'sub_agent_a');
  const records = new Map<string, AttemptModelAccess>([
    ['agent_a', { env: envA, grant: frozenA }],
    ['agent_b', { env: envB, grant: await grant(envB, 'sub_agent_b') }],
  ]);
  const interceptor = createModelAccessInterceptor({
    lookup: async (context) => records.get(context.instanceId!)!,
    installationGrants: async () => [],
  });
  const attempt = (instanceId: string, run: () => Promise<unknown>) =>
    interceptor(AGENT_OPERATION, attemptContext(instanceId), run);

  await attempt('agent_a', async () => {
    await modelCall(model, 'A-before-rotation');
    await rotate(envA, 'anthropic', { kind: 'save', apiKey: KEY_A2 });
    // The running stream and the attempt's later steps keep the version they started with.
    await modelCall(model, 'A-after-rotation');
    // Another instance's attempt started from inside A's cell binds its own.
    await attempt('agent_b', () => modelCall(model, 'B-during-rotation'));
  });
  assert.deepEqual(sent.map(({ step, apiKey }) => [step, apiKey]), [
    ['A-before-rotation', KEY_A1], ['A-after-rotation', KEY_A1], ['B-during-rotation', KEY_B],
  ]);

  // The next attempt of the run frozen to the superseded version never gets the new key.
  sent.length = 0;
  await assert.rejects(
    attempt('agent_a', () => modelCall(model, 'A-next-attempt')),
    (error: unknown) => error instanceof ModelCredentialRevisionError &&
      error.credentialRefId === frozenA.credentialRefId && error.expectedVersion === frozenA.credentialVersion &&
      !error.message.includes(KEY_A1) && !error.message.includes(KEY_A2),
  );
  assert.deepEqual(sent, [], 'nothing was sent for the refused attempt');

  // A run admitted after the rotation uses the new version.
  records.set('agent_a', { env: envA, grant: await grant(envA, 'sub_agent_a_2') });
  await attempt('agent_a', () => modelCall(model, 'A-new-run'));
  assert.deepEqual(sent.map(({ apiKey }) => apiKey), [KEY_A2]);

  // Deleting A's key fails A closed while B keeps working.
  sent.length = 0;
  await rotate(envA, 'anthropic', { kind: 'delete' });
  await assert.rejects(attempt('agent_a', () => modelCall(model, 'A-after-delete')), ModelCredentialRevisionError);
  assert.equal(await installationModelAccessGrant('anthropic', envA, 'run', settingsOf(envA)), undefined);
  await attempt('agent_b', () => modelCall(model, 'B-after-delete'));
  assert.deepEqual(sent.map(({ step, apiKey }) => [step, apiKey]), [['B-after-delete', KEY_B]]);
});

test('a grant is resolved only through the env of its own installation', async (t) => {
  const { envA, envB, grant } = await twoInstallations(t);
  const grantA = await grant(envA, 'run');
  await assert.rejects(
    withModelAccess(grantA, envB, async () => undefined),
    (error: unknown) => error instanceof ModelAccessError && error.code === 'installation_mismatch',
  );
  await assert.rejects(
    withModelAccess({ ...grantA, fundingSource: 'platform' as never }, envA, async () => undefined),
    (error: unknown) => error instanceof ModelAccessError && error.code === 'funding_not_offered',
  );
});

test('a deployment serving many installations refuses calls without scope, deployment keys, and every deployment lane', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { envA, grant } = await twoInstallations(t);
    const sent: SentRequest[] = [];
    const anthropic = recordingProvider('anthropic', sent);
    const lanes = ['cloudflare-workers-ai', 'cloudflare', 'chatgpt-plan', 'openai-subscription']
      .map((id) => recordingProvider(id, sent));
    const localStub = recordingProvider('local-stub', sent);
    const grantA = await grant(envA, 'run');

    // A stateless path invoked without withModelAccess fails before egress, whatever the provider.
    for (const model of [anthropic, ...lanes, localStub]) {
      assert.throws(() => registeredPiProvider(model.provider)!.streamSimple(model, { messages: [] }, {}),
        (error: unknown) => error instanceof ModelAccessError && error.code === 'scope_missing', model.provider);
    }
    // Inside a grant of this deployment, a lane with its own credential is refused by the cell itself.
    await withModelAccess(grantA, envA, async () => {
      for (const model of lanes) {
        assert.throws(() => registeredPiProvider(model.provider)!.streamSimple(model, { messages: [] }, {}),
          (error: unknown) => error instanceof ModelAccessError && error.code === 'provider_not_offered', model.provider);
      }
      assert.throws(() => registeredPiProvider('local-stub')!.streamSimple(localStub, { messages: [] }, {}),
        (error: unknown) => error instanceof ModelAccessError && error.code === 'provider_mismatch');
    });
    await assert.rejects(withDeploymentLane(envA, async () => undefined),
      (error: unknown) => error instanceof ModelAccessError && error.code === 'provider_not_offered');
    await assert.rejects(withStatelessModelAccess('cloudflare-workers-ai/@cf/model', { env: envA, runId: 'classifier' }, async () => undefined),
      (error: unknown) => error instanceof ModelAccessError && error.code === 'provider_not_offered');
    // The stub has no credential here even with its URL set, and its grant cannot be resolved.
    await withEnv({ LOCAL_STUB_URL: 'http://127.0.0.1:9/v1' }, async () => {
      assert.equal(await installationModelAccessGrant('local-stub', envA, 'run'), undefined);
      await assert.rejects(withModelAccess({ ...grantA, providerId: 'local-stub', credentialRefId: 'cred_local-stub_custom', credentialVersion: 1 }, envA,
        async () => undefined), ModelCredentialRevisionError);
    });
    // The runtime refuses those lanes before any binding.
    const settings = new SqliteSettingsStore(':memory:');
    t.after(() => settings.close());
    for (const model of ['local-stub/stub-model', 'cloudflare/@cf/model', 'cloudflare-workers-ai/@cf/model']) {
      await assert.rejects(resolveRuntimeModel('agent', model, { settings, env: envA }), (error: unknown) =>
        error instanceof RuntimeModelReadinessError && error.status === 'unsupported', model);
    }
    await saveOpenAiAuthMethod(settings, 'subscription');
    await assert.rejects(resolveRuntimeModel('agent', 'openai/gpt-5.4', { settings, env: envA }), (error: unknown) =>
      error instanceof RuntimeModelReadinessError && error.providerId === 'openai-subscription');

    // Flue's model operation outside any bound attempt is refused too.
    const interceptor = createModelAccessInterceptor({
      lookup: async () => ({ env: envA }),
      installationGrants: async () => { throw new Error('never on a deployment serving many'); },
    });
    await assert.rejects(interceptor(MODEL_OPERATION, attemptContext('agent_a'), async () => undefined),
      (error: unknown) => error instanceof ModelAccessError && error.code === 'scope_missing');
    await interceptor(AGENT_OPERATION, attemptContext('agent_unbound'), async () => {
      await assert.rejects(interceptor(MODEL_OPERATION, attemptContext('agent_unbound'), async () => undefined),
        (error: unknown) => error instanceof ModelAccessError && error.code === 'scope_missing');
    });

    // A deployment-level provider key makes every model call refuse, even one with a grant.
    await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-deployment-environment' }, async () => {
      for (const refused of [
        () => withModelAccess(grantA, envA, async () => undefined),
        () => withStatelessModelAccess('anthropic/claude-haiku-4-5', { env: envA, runId: 'classifier' }, async () => undefined),
        () => installationModelAccessGrant('anthropic', envA, 'run'),
      ]) {
        await assert.rejects(refused, (error: unknown) =>
          error instanceof ModelAccessError && error.code === 'deployment_key_present' &&
          error.message.includes('ANTHROPIC_API_KEY') && !error.message.includes('sk-ant-deployment-environment'));
      }
    });
    assert.deepEqual(sent, [], 'no refused path reached the provider');
  });
});

test('a caller that passes no env still gets the deployment\'s own tenancy, and a malformed one throws', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => { settings.close(); invalidateProviderKeyCache(); });
  await withEnv({ ...NO_DEPLOYMENT_KEYS, CHICKPEA_TENANCY: 'installation', ANTHROPIC_API_KEY: 'sk-ant-deployment-environment' }, async () => {
    invalidateProviderKeyCache();
    assert.equal(deploymentServesManyInstallations(undefined), true);
    assert.deepEqual(await resolveProviderApiKey('anthropic', undefined, settings), { apiKey: undefined, source: 'missing' });
    assert.equal((await describeProviderKeySources(undefined, settings)).anthropic, 'missing');
    const providers = await listInstallationModelProviders(undefined, settings);
    assert.equal(providers.find((provider) => provider.id === 'anthropic')?.configured, false,
      'readiness never counts a deployment key as configured');
  });
  await withEnv({ CHICKPEA_TENANCY: 'hosted' }, async () => {
    assert.throws(() => deploymentServesManyInstallations(undefined), /must be "standalone", "installation" or unset/);
  });
  assert.throws(() => deploymentServesManyInstallations({ CHICKPEA_TENANCY: 'hosted' }), /must be "standalone"/);
});

test('each installation lists only its own configured providers and model counts', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const { envA, envB, settingsOf, rotate } = await twoInstallations(t);
    await rotate(envB, 'openai', { kind: 'save', apiKey: 'sk-openai-tenant-b' });
    // Deployment lanes registered in this isolate are not an installation's to use.
    recordRegisteredProvider('cloudflare-workers-ai');
    recordRegisteredProvider('local-stub');
    const configured = async (env: PlatformEnv) => (await listInstallationModelProviders(env, settingsOf(env)))
      .filter((provider) => provider.configured).map((provider) => provider.id).sort();
    assert.deepEqual(await configured(envA), ['anthropic']);
    assert.deepEqual(await configured(envB), ['anthropic', 'openai']);
    assert.deepEqual((await listInstallationModelProviders(envA, settingsOf(envA))).map((provider) => provider.id).sort(),
      ['anthropic', 'openai', 'openrouter']);

    invalidateProviderModelCache();
    t.after(() => invalidateProviderModelCache());
    primeProviderModelCache('anthropic', [{ id: 'claude-tenant-a' }], envA);
    primeProviderModelCache('openrouter', [{ id: 'public/one' }, { id: 'public/two' }], envA);
    assert.equal(cachedProviderModelCount('anthropic', envA), 1);
    assert.equal(cachedProviderModelCount('anthropic', envB), undefined, 'a keyed list stays with its installation');
    assert.equal(cachedProviderModelCount('openrouter', envB), 2, 'the public OpenRouter catalog is shared');
  });
});

test('standalone resolves the deployment environment key first, then the key saved in Admin, as before', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    resetModelAccessForTests();
    invalidateProviderKeyCache();
    const settings = new SqliteSettingsStore(':memory:');
    const usage = new SqliteUsageStore(':memory:');
    t.after(() => { settings.close(); usage.close(); resetModelAccessForTests(); });
    configureModelAccessResolver(createInstallationModelAccessResolver({ settings: () => settings }));
    const sent: SentRequest[] = [];
    const model = recordingProvider('anthropic', sent);
    const call = (step: string) =>
      withStatelessModelAccess('anthropic/claude-haiku-4-5', { env: undefined, settings, runId: step }, () => modelCall(model, step));

    // No credential: the existing actionable readiness error, and no request.
    await assert.rejects(call('missing'), (error: unknown) =>
      error instanceof RuntimeModelReadinessError && error.status === 'provider_setup_required' &&
      error.message === 'Provider anthropic needs setup before this model can run.' &&
      error.repairPath === '/admin/settings#model-providers');

    await rotateInstallationModelCredential('anthropic', { kind: 'save', apiKey: 'sk-ant-stored-admin-key' }, { env: undefined, settings, usage });
    await call('stored');
    await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-worker-secret', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/anthropic' }, async () => {
      await call('environment');
      const environmentGrant = await installationModelAccessGrant('anthropic', undefined, 'run', settings);
      assert.deepEqual(
        { installationId: environmentGrant?.installationId, ref: environmentGrant?.credentialRefId, version: environmentGrant?.credentialVersion },
        { installationId: 'installation_oss', ref: 'cred_anthropic_environment', version: 1 },
      );
    });
    assert.deepEqual(sent.map(({ step, apiKey, baseUrl }) => [step, apiKey, baseUrl]), [
      ['stored', 'sk-ant-stored-admin-key', 'https://provider.invalid'],
      ['environment', 'sk-ant-worker-secret', 'http://127.0.0.1:9/anthropic'],
    ]);

    // A lane that brings its own deployment credential runs as before, inside a standalone cell.
    const workersAi = recordingProvider('cloudflare-workers-ai', sent);
    sent.length = 0;
    await withStatelessModelAccess('cloudflare-workers-ai/probe-model', { env: undefined, runId: 'classifier' },
      () => modelCall(workersAi, 'workers-ai'));
    assert.deepEqual(sent.map(({ step, apiKey }) => [step, apiKey]), [['workers-ai', undefined]]);
  });
});

test('standalone binds the coding worker to the installation\'s current keys in one read', async (t) => {
  await withEnv({ ...NO_DEPLOYMENT_KEYS, OPENAI_API_KEY: 'sk-openai-worker-secret' }, async () => {
    resetModelAccessForTests();
    invalidateProviderKeyCache();
    const settings = new SqliteSettingsStore(':memory:');
    const usage = new SqliteUsageStore(':memory:');
    t.after(() => { settings.close(); usage.close(); resetModelAccessForTests(); });
    configureModelAccessResolver(createInstallationModelAccessResolver({ settings: () => settings }));
    await rotateInstallationModelCredential('anthropic', { kind: 'save', apiKey: 'sk-ant-stored-admin-key' }, { env: undefined, settings, usage });
    const reads: string[][] = [];
    const counting = Object.create(settings) as SqliteSettingsStore;
    counting.getSettings = async (keys) => { reads.push([...keys]); return settings.getSettings(keys); };
    const sent: SentRequest[] = [];
    const anthropic = recordingProvider('anthropic', sent);
    const openai = recordingProvider('openai', sent);
    const workersAi = recordingProvider('cloudflare-workers-ai', sent);
    const interceptor = createModelAccessInterceptor({
      lookup: (context) => lookupAttemptModelAccess(context, async () => undefined),
      installationGrants: (env, runId) => installationModelAccessGrants(env, runId, counting),
    });
    await interceptor(AGENT_OPERATION, { instanceId: 'codingworker_x', submissionId: 'sub_x', agentName: 'chickpea-coding-worker-v1' },
      async () => {
        await modelCall(anthropic, 'anthropic');
        await modelCall(openai, 'openai');
        await modelCall(workersAi, 'workers-ai');
      });
    assert.equal(reads.length, 1, 'the installation-wide grants come from one settings read');
    assert.deepEqual(sent.map(({ step, apiKey }) => [step, apiKey]), [
      ['anthropic', 'sk-ant-stored-admin-key'],
      ['openai', 'sk-openai-worker-secret'],
      ['workers-ai', undefined],
    ]);
  });
});

test('the Slack lookup binds the plan staged for the attempt\'s TurnJob, and never falls back without it', async () => {
  await withEnv({ ...NO_DEPLOYMENT_KEYS, ANTHROPIC_API_KEY: 'sk-ant-worker-secret', SLACK_STATE_DB_PATH: ':memory:' }, async () => {
    const plan = compiledPlan();
    const instanceId = deriveRuntimePlanInstanceId(plan);
    rememberInProcessTurnInput(createSlackTurnInput({ turnJobId: 'turn_lookup', instanceId, runtimePlan: plan }));
    const lookupWithin = (turnJobId: string, submissionId: string) => {
      const context = { instanceId, submissionId, agentName: 'chickpea-slack-v2' };
      const work = createWorkModelInvocationInterceptor({
        resolveTarget: async () => ({ generation: 'g1', turnJobId, instanceId, submissionId }),
      });
      return work(AGENT_OPERATION, context, () => lookupAttemptModelAccess(context, async () => undefined));
    };
    const attempt = await lookupWithin('turn_lookup', 'sub_lookup');
    assert.deepEqual('grant' in attempt && attempt.grant, {
      installationId: 'installation_oss', providerId: 'anthropic', credentialRefId: 'cred_anthropic_environment',
      credentialVersion: 1, runId: 'sub_lookup', fundingSource: 'customer',
    });
    assert.equal(JSON.stringify(plan).includes('sk-ant-worker-secret'), false, 'the plan freezes a reference, never the key');

    // A thread instance's TurnJob with no staged plan: the lookup broke, so the attempt fails closed.
    await assert.rejects(lookupWithin('turn_never_staged', 'sub_other'),
      (error: unknown) => error instanceof ModelAccessError && error.code === 'scope_missing');
  });
});

test('the routine lookup binds the running occurrence\'s frozen plan, owned by the attempt\'s installation', async () => {
  await withEnv({ ...NO_DEPLOYMENT_KEYS, SLACK_STATE_DB_PATH: ':memory:' }, async () => {
    const store = getRoutineStore();
    const now = Date.now();
    // One routine per occurrence: a routine runs one occurrence at a time.
    const dispatch = async (suffix: string, instanceId: string, plan: RuntimePlanV2) => {
      const routine = await store.save({
        actorId: 'U_MEMBER', actorClass: 'member', workspaceId: 'T12345678', channelId: 'C12345678',
        idempotencyKey: `routine:lookup:save:${suffix}`,
        draft: {
          action: 'create', routineId: `routine_lookup_${suffix}`, nextRunAt: now + 3_600_000, projectedDailyStarts: 1,
          reservations: [{ windowStart: now + 3_600_000, count: 1 }],
          definition: {
            name: `Lookup ${suffix}`, description: 'Bind model access.', taskText: 'Summarize the channel.',
            triggerKind: 'schedule', scheduleInput: 'Every day at 9am',
            scheduleJson: JSON.stringify({ version: 1, kind: 'cron', expression: '0 9 * * *' }),
            timezone: 'America/Los_Angeles', outputPolicy: 'post', authorityMode: 'live_channel_v1',
          },
        },
      });
      const run = await store.createOccurrence({
        runId: `rrun_lookup_${suffix}`, idempotencyKey: `routine:lookup:${suffix}`, routineId: routine.id,
        routineVersion: routine.version, scheduledFor: now, triggerSource: 'run_now',
        requestedBy: 'U_MEMBER', queuedAt: now, deadlineAt: now + 900_000,
      });
      const admission = await store.startAdmissionAttempt({
        occurrenceId: run.id, owner: 'heartbeat', leaseUntil: now + 120_000, invokeStartedAt: now + 1,
      });
      assert.equal(await store.prepareAgentDispatch({
        occurrenceId: run.id, attempt: admission.attempt, startedAt: now + 2,
        envelope: {
          schemaVersion: 1, attemptId: admission.attemptId, instanceId, idempotencyKey: admission.attemptId,
          message: 'Run the saved task.', initialData: { runtimePlan: plan, requestedModel: plan.model },
        },
        resolvedAccessHash: 'a'.repeat(64), resolvedAgentId: 'agent_lookup',
        resolvedAuthorityReceiptId: 'receipt_lookup', resolvedRunsAsMembershipId: 'membership_owner',
        model: plan.model, traceId: `trace_${suffix}`,
      }), 'started');
    };
    const routineContext = (instanceId: string) =>
      ({ instanceId, submissionId: 'sub_routine', agentName: 'chickpea-routine-execution-v2' });

    // Standalone: the plan's frozen credential.
    await dispatch('s', 'routineagent_standalone', compiledPlan());
    const standalone = await lookupAttemptModelAccess(routineContext('routineagent_standalone'), async () => undefined);
    assert.deepEqual('grant' in standalone && standalone.grant, {
      installationId: 'installation_oss', providerId: 'anthropic', credentialRefId: 'cred_anthropic_environment',
      credentialVersion: 1, runId: 'sub_routine', fundingSource: 'customer',
    });

    // A deployment serving many: the plan, its instance and the attempt's env name one installation.
    const envA = scopeInstallationEnv(HOSTED as Record<string, unknown>, { installationId: 'inst_a' });
    const envB = scopeInstallationEnv(HOSTED as Record<string, unknown>, { installationId: 'inst_b' });
    const hostedInstance = scopedObjectName({ installationId: 'inst_a' }, 'routineagent_hosted');
    await dispatch('hosted', hostedInstance, compiledPlan(envA));
    const hosted = await lookupAttemptModelAccess(routineContext(hostedInstance), async () => envA);
    assert.equal('grant' in hosted && hosted.grant.installationId, 'inst_a');
    await assert.rejects(lookupAttemptModelAccess(routineContext(hostedInstance), async () => envB),
      /belongs to another installation/);
    await dispatch('unowned', scopedObjectName({ installationId: 'inst_a' }, 'routineagent_unowned'), compiledPlan());
    await assert.rejects(
      lookupAttemptModelAccess(routineContext(scopedObjectName({ installationId: 'inst_a' }, 'routineagent_unowned')), async () => envA),
      /another installation/, 'a plan with no installation never runs under one');

    // No running occurrence names the instance: the attempt fails closed, never falls back.
    await assert.rejects(lookupAttemptModelAccess(routineContext('routineagent_unknown'), async () => undefined),
      (error: unknown) => error instanceof ModelAccessError && error.code === 'scope_missing');
    // The coding worker has no persisted run here; only it reaches the standalone fallback.
    assert.deepEqual(
      await lookupAttemptModelAccess({ instanceId: 'codingworker_x', submissionId: 'sub', agentName: 'chickpea-coding-worker-v1' },
        async () => undefined),
      { env: undefined },
    );
  });
});

test('a provider error that echoes the injected key never records it', async (t) => {
  resetModelAccessForTests();
  t.after(resetModelAccessForTests);
  const sent: SentRequest[] = [];
  const model = recordingProvider('anthropic', sent, (options) =>
    assistant('anthropic', 'error', `401 invalid x-api-key: ${options?.apiKey}`));
  configureModelAccessResolver({ resolve: async () => ({ apiKey: KEY_A1 }) });
  const grant: ModelAccessGrant = {
    installationId: 'installation_oss', providerId: 'anthropic', credentialRefId: 'cred_x',
    credentialVersion: 1, runId: 'run', fundingSource: 'customer',
  };
  const events: string[] = [];
  const result = await withModelAccess(grant, undefined, async () => {
    const stream = registeredPiProvider('anthropic')!.streamSimple(model, { messages: [] }, {});
    for await (const event of stream) events.push(JSON.stringify(event));
    return stream.result();
  });
  assert.equal(sent[0]?.apiKey, KEY_A1, 'the request itself carried the key');
  assert.equal(result.errorMessage, '401 invalid x-api-key: [redacted]');
  assert.equal(events.some((event) => event.includes(KEY_A1)), false);
});
