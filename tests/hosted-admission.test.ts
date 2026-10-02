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

import {
  configureInstallationAdmission,
  installationAdmission,
  installationRefusesWork,
  InstallationNotAdmittedError,
  INSTALLATION_ADMISSION_LAST_KNOWN_MS,
  INSTALLATION_ADMISSION_TTL_MS,
  resetInstallationAdmissionForTests,
  type InstallationAdmission,
} from '../src/config/installation-admission.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import {
  configureModelAccessResolver,
  createModelAccessInterceptor,
  resetModelAccessForTests,
  type AttemptModelAccess,
  type ModelAccessGrant,
} from '../src/config/model-access.ts';
import { registerPiProvider, registeredPiProvider } from '../src/config/pi-provider-registry.ts';
import type { PlatformEnv } from '../src/config/state-backend.ts';

/**
 * The host's registry admits an active installation and refuses a suspended
 * or ended one. Core asks it, through a 30-second cache, before every new or
 * resumed attempt and before every model step, so a refused installation
 * makes no further model call; standalone never asks.
 */

const HOSTED = { CHICKPEA_TENANCY: 'installation' } as const;
const ENV_A = scopeInstallationEnv(HOSTED as Record<string, unknown>, { installationId: 'inst_a' });
const ENV_B = scopeInstallationEnv(HOSTED as Record<string, unknown>, { installationId: 'inst_b' });
const AGENT_OPERATION = { type: 'agent', operationId: 'op', operationKind: 'prompt' } as const;
const MODEL_OPERATION = { type: 'model', turnId: 'turn' } as const;

/** A registry the test edits, recording each read. */
function registry(initial: Record<string, InstallationAdmission | Error>) {
  const statuses = new Map(Object.entries(initial));
  const reads: string[] = [];
  return {
    statuses,
    reads,
    check: async (installationId: string): Promise<InstallationAdmission> => {
      reads.push(installationId);
      const status = statuses.get(installationId) ?? 'refused';
      if (status instanceof Error) throw status;
      return status;
    },
  };
}

function clock(t: TestContext) {
  const state = { now: 1_800_000_000_000 };
  resetInstallationAdmissionForTests({ now: () => state.now });
  t.after(() => resetInstallationAdmissionForTests());
  return state;
}

function grant(installationId: string, runId: string): ModelAccessGrant {
  return {
    installationId, providerId: 'anthropic', credentialRefId: `cred_anthropic_${installationId}`,
    credentialVersion: 1, runId, fundingSource: 'customer',
  };
}

interface Sent { step: string; apiKey: string | undefined }

/**
 * A provider registered through the production seam. Each request records
 * what it carried; a step named in `held` waits until released.
 */
function recordingProvider(sent: Sent[], held = new Map<string, Promise<void>>()): Model<'anthropic-messages'> {
  const model = {
    id: 'probe-model', name: 'Probe model', api: 'anthropic-messages', provider: 'anthropic',
    baseUrl: 'https://provider.invalid', reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16_000, maxTokens: 1_024,
  } as Model<'anthropic-messages'>;
  const stream = (_model: Model<string>, context: Context, options?: StreamOptions) => {
    const last = context.messages.at(-1);
    const step = typeof last?.content === 'string' ? last.content : '';
    sent.push({ step, apiKey: options?.apiKey });
    const output = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: 'assistant', content: [{ type: 'text', text: `done ${step}` }], api: 'anthropic-messages',
      provider: 'anthropic', model: 'probe-model', stopReason: 'stop', timestamp: 1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    void (held.get(step) ?? Promise.resolve()).then(() => {
      output.push({ type: 'done', reason: 'stop', message });
      output.end();
    });
    return output;
  };
  registerPiProvider(createProvider({
    id: 'anthropic',
    auth: { apiKey: { name: 'probe', resolve: async () => ({ auth: {} }) } },
    models: [model],
    api: { stream, streamSimple: stream },
  }));
  return model;
}

function modelCall(model: Model<string>, step: string): Promise<AssistantMessage> {
  return registeredPiProvider(model.provider)!.streamSimple(model, {
    systemPrompt: 'probe', messages: [{ role: 'user', content: step, timestamp: 1 }],
  }, {}).result();
}

/** An interceptor whose lookup answers from a table and whose resolver counts what it opened. */
function interceptorFor(t: TestContext, attempts: Map<string, AttemptModelAccess>) {
  resetModelAccessForTests();
  const resolved: string[] = [];
  configureModelAccessResolver({
    async resolve(access) {
      resolved.push(access.installationId);
      return { apiKey: `sk-ant-key-of-${access.installationId}` };
    },
  });
  t.after(() => resetModelAccessForTests());
  const interceptor = createModelAccessInterceptor({
    lookup: async (context) => attempts.get(context.instanceId!)!,
    installationGrants: async () => [grant('standalone', 'live')],
  });
  const context = (instanceId: string): FlueExecutionContext =>
    ({ instanceId, submissionId: `sub_${instanceId}`, agentName: 'chickpea-slack-v2' });
  return {
    resolved,
    attempt: (instanceId: string, run: () => Promise<unknown>) =>
      interceptor(AGENT_OPERATION, context(instanceId), run),
    step: (instanceId: string, model: Model<string>, label: string) =>
      interceptor(MODEL_OPERATION, context(instanceId), () => modelCall(model, label)),
  };
}

test('standalone never asks the admission check, even when one is configured', async (t) => {
  clock(t);
  const host = registry({ standalone: 'refused' });
  configureInstallationAdmission(host.check);
  const sent: Sent[] = [];
  const model = recordingProvider(sent);
  const { attempt, step } = interceptorFor(t, new Map<string, AttemptModelAccess>([
    ['agent_standalone', { env: undefined, grant: grant('standalone', 'sub_agent_standalone') }],
    ['coding_worker', { env: {} }],
  ]));
  await attempt('agent_standalone', () => step('agent_standalone', model, 'S1'));
  await attempt('coding_worker', () => step('coding_worker', model, 'S2'));
  assert.deepEqual(sent.map(({ step }) => step), ['S1', 'S2']);
  assert.equal(await installationRefusesWork(undefined), false);
  assert.equal(await installationRefusesWork({}), false);
  assert.deepEqual(host.reads, [], 'standalone never reads the registry');
});

test('without a configured check, a deployment serving many refuses an attempt before any key is opened', async (t) => {
  clock(t);
  const logged: string[] = [];
  t.mock.method(console, 'error', (line: string) => { logged.push(line); });
  const sent: Sent[] = [];
  const model = recordingProvider(sent);
  const { attempt, step, resolved } = interceptorFor(t, new Map<string, AttemptModelAccess>([
    ['agent_a', { env: ENV_A, grant: grant('inst_a', 'sub_agent_a') }],
  ]));
  for (let index = 0; index < 2; index += 1) {
    await assert.rejects(attempt('agent_a', () => step('agent_a', model, 'A1')), InstallationNotAdmittedError);
  }
  assert.deepEqual(sent, []);
  assert.deepEqual(resolved, [], 'no key was resolved for a refused attempt');
  assert.equal(await installationRefusesWork(ENV_A), true);
  assert.deepEqual(logged.map((line) => JSON.parse(line)),
    [{ component: 'installation_admission', event: 'admission_check_missing' }], 'logged once per isolate');
});

test('a refused installation starts no attempt, while the other installation in the isolate keeps running', async (t) => {
  clock(t);
  const host = registry({ inst_a: 'admitted', inst_b: 'refused' });
  configureInstallationAdmission(host.check);
  const sent: Sent[] = [];
  const model = recordingProvider(sent);
  const { attempt, step, resolved } = interceptorFor(t, new Map<string, AttemptModelAccess>([
    ['agent_a', { env: ENV_A, grant: grant('inst_a', 'sub_agent_a') }],
    ['agent_b', { env: ENV_B, grant: grant('inst_b', 'sub_agent_b') }],
  ]));
  let releaseB!: () => void;
  const bStarted = new Promise<void>((resolve) => { releaseB = resolve; });
  const [a, b] = await Promise.allSettled([
    attempt('agent_a', async () => {
      await step('agent_a', model, 'A1');
      releaseB();
      await step('agent_a', model, 'A2');
    }),
    bStarted.then(() => attempt('agent_b', () => step('agent_b', model, 'B1'))),
  ]);
  assert.equal(a.status, 'fulfilled');
  assert.equal(b.status, 'rejected');
  assert.ok(b.status === 'rejected' && b.reason instanceof InstallationNotAdmittedError);
  assert.deepEqual(sent, [
    { step: 'A1', apiKey: 'sk-ant-key-of-inst_a' },
    { step: 'A2', apiKey: 'sk-ant-key-of-inst_a' },
  ]);
  assert.deepEqual(resolved, ['inst_a'], 'B\'s key was never opened');
  assert.deepEqual([...new Set(host.reads)].sort(), ['inst_a', 'inst_b']);
  assert.equal(host.reads.filter((id) => id === 'inst_a').length, 1, 'A\'s later steps use the cached answer');
});

test('a suspension refuses a running attempt\'s next model step within 30 seconds; the stream in flight completes', async (t) => {
  const time = clock(t);
  const host = registry({ inst_a: 'admitted', inst_b: 'admitted' });
  configureInstallationAdmission(host.check);
  const sent: Sent[] = [];
  let releaseFirst!: () => void;
  const model = recordingProvider(sent, new Map([['A1', new Promise<void>((resolve) => { releaseFirst = resolve; })]]));
  const { attempt, step } = interceptorFor(t, new Map<string, AttemptModelAccess>([
    ['agent_a', { env: ENV_A, grant: grant('inst_a', 'sub_agent_a') }],
    ['agent_b', { env: ENV_B, grant: grant('inst_b', 'sub_agent_b') }],
  ]));
  const outcomes: string[] = [];
  await attempt('agent_a', async () => {
    const first = step('agent_a', model, 'A1');
    // The operator suspends A while its first step streams.
    host.statuses.set('inst_a', 'refused');
    time.now += INSTALLATION_ADMISSION_TTL_MS - 1;
    // Within the cache window the next step still runs: the bound is about 30 seconds.
    const second = step('agent_a', model, 'A2');
    releaseFirst();
    outcomes.push(((await first) as AssistantMessage).stopReason, ((await second) as AssistantMessage).stopReason);
    time.now += 1;
    await assert.rejects(step('agent_a', model, 'A3'), InstallationNotAdmittedError);
    // B, in the same isolate, is not suspended.
    await attempt('agent_b', () => step('agent_b', model, 'B1'));
  });
  assert.deepEqual(outcomes, ['stop', 'stop'], 'the stream already running was not cut');
  assert.deepEqual(sent.map(({ step }) => step), ['A1', 'A2', 'B1'], 'no request was sent for the refused step');
  // The next attempt of A, a retry or a resume, is refused at its start.
  await assert.rejects(attempt('agent_a', () => step('agent_a', model, 'A4')), InstallationNotAdmittedError);
  // Resuming A in the registry admits it again once the cached answer ages out.
  host.statuses.set('inst_a', 'admitted');
  time.now += INSTALLATION_ADMISSION_TTL_MS;
  await attempt('agent_a', () => step('agent_a', model, 'A5'));
  assert.deepEqual(sent.map(({ step }) => step), ['A1', 'A2', 'B1', 'A5']);
});

test('answers are cached for 30 seconds per installation, and a read error keeps the last answer for ten minutes', async (t) => {
  const time = clock(t);
  const warned: string[] = [];
  t.mock.method(console, 'warn', (line: string) => { warned.push(line); });
  const host = registry({ inst_a: 'refused', inst_b: 'admitted' });
  configureInstallationAdmission(host.check);

  // Concurrent asks share one read; a second within the window reads nothing.
  assert.deepEqual(await Promise.all([installationAdmission('inst_a'), installationAdmission('inst_a')]),
    ['refused', 'refused']);
  assert.equal(await installationAdmission('inst_b'), 'admitted', 'one installation\'s answer is its own');
  time.now += INSTALLATION_ADMISSION_TTL_MS - 1;
  assert.equal(await installationAdmission('inst_a'), 'refused');
  assert.deepEqual(host.reads, ['inst_a', 'inst_b']);
  time.now += 1;
  host.statuses.set('inst_a', 'admitted');
  assert.equal(await installationAdmission('inst_a'), 'admitted', 'read again after 30 seconds');

  // The registry becomes unreadable: the last known answer stands for ten minutes.
  host.statuses.set('inst_a', 'refused');
  time.now += INSTALLATION_ADMISSION_TTL_MS;
  assert.equal(await installationAdmission('inst_a'), 'refused');
  host.statuses.set('inst_a', new Error('registry unavailable'));
  time.now += INSTALLATION_ADMISSION_TTL_MS;
  assert.equal(await installationAdmission('inst_a'), 'refused', 'the last answer stands on a read error');
  time.now += INSTALLATION_ADMISSION_LAST_KNOWN_MS;
  assert.equal(await installationAdmission('inst_a'), 'admitted',
    'past ten minutes nothing is known, so the host boundaries decide alone');
  // With no answer ever known, a read error admits.
  host.statuses.set('inst_c', new Error('registry unavailable'));
  assert.equal(await installationAdmission('inst_c'), 'admitted');
  const unavailable = { component: 'installation_admission', event: 'admission_check_unavailable' };
  assert.deepEqual(warned.map((line) => JSON.parse(line)), [unavailable, unavailable],
    'the outage is logged at most once a minute (here ten minutes apart), naming no installation');
});

test('an env that names no installation is refused on a deployment serving many', async (t) => {
  clock(t);
  configureInstallationAdmission(async () => 'admitted');
  assert.equal(await installationRefusesWork(HOSTED as unknown as PlatformEnv), true);
  assert.equal(await installationRefusesWork(ENV_A), false);
});
