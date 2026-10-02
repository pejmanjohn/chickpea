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
import { compileRuntimePlanV2, deriveRuntimePlanInstanceId } from '../src/agents/runtime-plan.ts';
import { createSlackTurnInput, rememberInProcessTurnInput } from '../src/agents/turn-input.ts';
import {
  createInstallationModelAccessResolver,
  installationModelAccessGrant,
  installationModelAccessGrants,
  RuntimeModelReadinessError,
  withStatelessModelAccess,
} from '../src/config/installation-model-access.ts';
import { installationScopeOf, scopeInstallationEnv } from '../src/config/installation-scope.ts';
import {
  ModelAccessError,
  configureModelAccessResolver,
  createModelAccessInterceptor,
  declareDeploymentTenancy,
  resetModelAccessForTests,
  withModelAccess,
  type AttemptModelAccess,
  type ModelAccessGrant,
} from '../src/config/model-access.ts';
import {
  ModelCredentialRevisionError,
  rotateStoredModelCredential,
} from '../src/config/model-credential-refs.ts';
import { invalidateProviderKeyCache } from '../src/config/provider-keys.ts';
import { registerPiProvider, registeredPiProvider } from '../src/config/pi-provider-registry.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { createWorkModelInvocationInterceptor } from '../src/work/model-invocation.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';

const HOSTED = { CHICKPEA_TENANCY: 'installation' } as const;
const KEY_A1 = 'sk-ant-tenant-a-version-one';
const KEY_A2 = 'sk-ant-tenant-a-version-two';
const KEY_B = 'sk-ant-tenant-b-only';

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

function withProcessEnv(t: TestContext, values: Record<string, string | undefined>): void {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

const NO_DEPLOYMENT_KEYS = {
  ANTHROPIC_API_KEY: undefined,
  OPENAI_API_KEY: undefined,
  OPENROUTER_API_KEY: undefined,
  ANTHROPIC_BASE_URL: undefined,
  LOCAL_STUB_URL: undefined,
};

/** Two installations of a deployment serving many, each with its own settings store and key. */
async function twoInstallations(t: TestContext) {
  resetModelAccessForTests();
  invalidateProviderKeyCache();
  withProcessEnv(t, NO_DEPLOYMENT_KEYS);
  declareDeploymentTenancy('installation');
  const envA = scopeInstallationEnv(HOSTED as Record<string, unknown>, { installationId: 'inst_a' });
  const envB = scopeInstallationEnv(HOSTED as Record<string, unknown>, { installationId: 'inst_b' });
  const settings = new Map([['inst_a', new SqliteSettingsStore(':memory:')], ['inst_b', new SqliteSettingsStore(':memory:')]]);
  const usage = new SqliteUsageStore(':memory:');
  t.after(() => {
    for (const store of settings.values()) store.close();
    usage.close();
    resetModelAccessForTests();
  });
  const settingsOf = (env: Record<string, unknown> | undefined) =>
    settings.get(installationScopeOf(env)?.installationId ?? '')!;
  configureModelAccessResolver(createInstallationModelAccessResolver({ settings: settingsOf }));
  await rotateStoredModelCredential('anthropic', { kind: 'save', apiKey: KEY_A1 }, settingsOf(envA), usage);
  await rotateStoredModelCredential('anthropic', { kind: 'save', apiKey: KEY_B }, settingsOf(envB), usage);
  const grant = async (env: Record<string, unknown>, runId: string) =>
    (await installationModelAccessGrant('anthropic', env, runId, settingsOf(env)))!;
  return { envA, envB, settingsOf, usage, grant };
}

/** Flue's coordinates for one attempt, as its coordinator opens the agent operation. */
function attemptContext(instanceId: string): FlueExecutionContext {
  return { instanceId, submissionId: `sub_${instanceId}`, agentName: 'chickpea-slack-v2' };
}

const AGENT_OPERATION = { type: 'agent', operationId: 'op', operationKind: 'prompt' } as const;
const MODEL_OPERATION = { type: 'model', turnId: 'turn' } as const;

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
      // A subagent task or structured prompt opens a nested agent operation in the same cell.
      await interceptor({ ...AGENT_OPERATION, operationKind: 'task' }, attemptContext('agent_a'),
        () => step('agent_a', 'A2-task'));
    }),
    interceptor(AGENT_OPERATION, attemptContext('agent_b'), async () => {
      await bWaits;
      await step('agent_b', 'B1');
      releaseA();
      await step('agent_b', 'B2');
    }),
  ]);
  assert.deepEqual(sent.map(({ step, apiKey }) => [step, apiKey]).sort(), [
    ['A1', KEY_A1], ['A2-task', KEY_A1], ['B1', KEY_B], ['B2', KEY_B],
  ]);
  assert.equal(lookups, 2, 'one lookup per top-level attempt; the nested operation shares the cell');
});

test('rotation mid-attempt keeps the running attempt on its version; the next attempt is refused, then deletion fails closed', async (t) => {
  const { envA, envB, settingsOf, usage, grant } = await twoInstallations(t);
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
    await rotateStoredModelCredential('anthropic', { kind: 'save', apiKey: KEY_A2 }, settingsOf(envA), usage);
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
  await rotateStoredModelCredential('anthropic', { kind: 'delete' }, settingsOf(envA), usage);
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

test('a deployment serving many installations refuses calls without scope, deployment keys, and deployment lanes', async (t) => {
  const { envA, grant } = await twoInstallations(t);
  const sent: SentRequest[] = [];
  const anthropic = recordingProvider('anthropic', sent);
  const workersAi = recordingProvider('cloudflare-workers-ai', sent);
  const grantA = await grant(envA, 'run');

  // A stateless path invoked without withModelAccess fails before egress.
  assert.throws(() => registeredPiProvider('anthropic')!.streamSimple(anthropic, { messages: [] }, {}),
    (error: unknown) => error instanceof ModelAccessError && error.code === 'scope_missing');
  // So does a lane that brings its own deployment credential, even inside a grant.
  await withModelAccess(grantA, envA, async () => {
    assert.throws(() => registeredPiProvider('cloudflare-workers-ai')!.streamSimple(workersAi, { messages: [] }, {}),
      (error: unknown) => error instanceof ModelAccessError && error.code === 'provider_not_offered');
  });
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
  withProcessEnv(t, { ANTHROPIC_API_KEY: 'sk-ant-deployment-environment' });
  for (const refused of [
    () => withModelAccess(grantA, envA, async () => undefined),
    () => withStatelessModelAccess('anthropic/claude-haiku-4-5', { env: envA, runId: 'classifier' }, async () => undefined),
    () => installationModelAccessGrant('anthropic', envA, 'run'),
  ]) {
    await assert.rejects(refused, (error: unknown) =>
      error instanceof ModelAccessError && error.code === 'deployment_key_present' &&
      error.message.includes('ANTHROPIC_API_KEY') && !error.message.includes('sk-ant-deployment-environment'));
  }
  assert.deepEqual(sent, [], 'no refused path reached the provider');
});

test('standalone resolves the deployment environment key first, then the key saved in Admin, as before', async (t) => {
  resetModelAccessForTests();
  invalidateProviderKeyCache();
  withProcessEnv(t, NO_DEPLOYMENT_KEYS);
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

  await rotateStoredModelCredential('anthropic', { kind: 'save', apiKey: 'sk-ant-stored-admin-key' }, settings, usage);
  await call('stored');
  withProcessEnv(t, { ANTHROPIC_API_KEY: 'sk-ant-worker-secret', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/anthropic' });
  await call('environment');
  const environmentGrant = await installationModelAccessGrant('anthropic', undefined, 'run', settings);
  assert.deepEqual(
    { installationId: environmentGrant?.installationId, ref: environmentGrant?.credentialRefId, version: environmentGrant?.credentialVersion },
    { installationId: 'installation_oss', ref: 'cred_anthropic_environment', version: 1 },
  );
  assert.deepEqual(sent.map(({ step, apiKey, baseUrl }) => [step, apiKey, baseUrl]), [
    ['stored', 'sk-ant-stored-admin-key', 'https://provider.invalid'],
    ['environment', 'sk-ant-worker-secret', 'http://127.0.0.1:9/anthropic'],
  ]);
});

test('standalone binds an attempt no persisted run names to the installation\'s current keys', async (t) => {
  resetModelAccessForTests();
  invalidateProviderKeyCache();
  withProcessEnv(t, { ...NO_DEPLOYMENT_KEYS, OPENAI_API_KEY: 'sk-openai-worker-secret' });
  const settings = new SqliteSettingsStore(':memory:');
  const usage = new SqliteUsageStore(':memory:');
  t.after(() => { settings.close(); usage.close(); resetModelAccessForTests(); });
  configureModelAccessResolver(createInstallationModelAccessResolver({ settings: () => settings }));
  await rotateStoredModelCredential('anthropic', { kind: 'save', apiKey: 'sk-ant-stored-admin-key' }, settings, usage);
  const sent: SentRequest[] = [];
  const anthropic = recordingProvider('anthropic', sent);
  const openai = recordingProvider('openai', sent);
  const workersAi = recordingProvider('cloudflare-workers-ai', sent);
  // The coding worker: Flue's coordinates name no persisted run.
  const interceptor = createModelAccessInterceptor({
    lookup: async () => ({ env: undefined }),
    installationGrants: (env, runId) => installationModelAccessGrants(env, runId, settings),
  });
  await interceptor(AGENT_OPERATION, { instanceId: 'codingworker_x', submissionId: 'sub_x', agentName: 'chickpea-coding-worker-v1' },
    async () => {
      await modelCall(anthropic, 'anthropic');
      await modelCall(openai, 'openai');
      await modelCall(workersAi, 'workers-ai');
    });
  assert.deepEqual(sent.map(({ step, apiKey }) => [step, apiKey]), [
    ['anthropic', 'sk-ant-stored-admin-key'],
    ['openai', 'sk-openai-worker-secret'],
    // A deployment lane carries its own credential on standalone, as before.
    ['workers-ai', undefined],
  ]);
});

test('the Slack lookup binds the plan staged for the attempt\'s TurnJob, as the render reads it', async (t) => {
  resetModelAccessForTests();
  invalidateProviderKeyCache();
  withProcessEnv(t, { ...NO_DEPLOYMENT_KEYS, ANTHROPIC_API_KEY: 'sk-ant-worker-secret' });
  const assignment: ResolvedAssignment = {
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
  const plan = compileRuntimePlanV2({
    turn: {
      workspaceId: 'T1', channelId: 'C1', eventId: 'E1', text: 'Hello', userId: 'U1', actorMembershipId: 'membership_1',
      messageTs: '1788000000.000200', threadTs: '1788000000.000100', source: 'app_mention', contextMode: 'thread',
    },
    assignment,
    instructions: 'Answer.',
    memoryEpoch: 1,
  });
  const instanceId = deriveRuntimePlanInstanceId(plan);
  rememberInProcessTurnInput(createSlackTurnInput({ turnJobId: 'turn_lookup', instanceId, runtimePlan: plan }));
  const context = { instanceId, submissionId: 'sub_lookup', agentName: 'chickpea-slack-v2' };
  const work = createWorkModelInvocationInterceptor({
    resolveTarget: async () => ({ generation: 'g1', turnJobId: 'turn_lookup', instanceId, submissionId: 'sub_lookup' }),
  });
  const attempt = await work(AGENT_OPERATION, context, () => lookupAttemptModelAccess(context));
  assert.deepEqual('grant' in attempt && attempt.grant, {
    installationId: 'installation_oss', providerId: 'anthropic', credentialRefId: 'cred_anthropic_environment',
    credentialVersion: 1, runId: 'sub_lookup', fundingSource: 'customer',
  });
  assert.equal(JSON.stringify(plan).includes('sk-ant-worker-secret'), false, 'the plan freezes a reference, never the key');

  // An attempt no TurnJob names gets no grant from the lookup.
  const unmatched = createWorkModelInvocationInterceptor({ resolveTarget: async () => ({
    generation: 'g1', turnJobId: 'turn_missing', instanceId, submissionId: 'sub_other',
  }) });
  const missing = await unmatched(AGENT_OPERATION, { ...context, submissionId: 'sub_other' },
    () => lookupAttemptModelAccess({ ...context, submissionId: 'sub_other' }));
  assert.equal('grant' in missing, false);
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
