import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import {
  createAssistantMessageEventStream,
  createProvider,
  type AssistantMessage,
  type Context,
  type Model,
  type StreamOptions,
} from '@earendil-works/pi-ai';
import { AgentRunError, type FlueExecutionContext } from '@flue/runtime';
import type { WebClient } from '@slack/web-api';

import {
  configureInstallationAdmission,
  installationAdmission,
  installationAdmissionConfigured,
  InstallationAdmissionNotConfiguredError,
  installationRefusesWork,
  InstallationNotAdmittedError,
  requireInstallationAdmissionConfigured,
  INSTALLATION_ADMISSION_LAST_KNOWN_MS,
  INSTALLATION_ADMISSION_TTL_MS,
  resetInstallationAdmissionForTests,
  type InstallationAdmission,
} from '../src/config/installation-admission.ts';
import { compileRuntimePlanV2, deriveRuntimePlanInstanceId } from '../src/agents/runtime-plan.ts';
import {
  InstallationContextError,
  installationOwnershipOf,
  scopeInstallationEnv,
} from '../src/config/installation-scope.ts';
import {
  configureModelAccessResolver,
  createModelAccessInterceptor,
  resetModelAccessForTests,
  withModelAccess,
  type AttemptModelAccess,
  type ModelAccessGrant,
} from '../src/config/model-access.ts';
import { registerPiProvider, registeredPiProvider } from '../src/config/pi-provider-registry.ts';
import { closeNodeStateStores, type PlatformEnv } from '../src/config/state-backend.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { AgentPromptFailure } from '../src/slack/flue-dispatch.ts';
import { SlackRunPresentationStoreLogic } from '../src/slack/run-presentations.ts';
import { runTurn } from '../src/slack/run-turn.ts';
import { SlackStatusRegistry } from '../src/slack/status-registry.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { prepareSlackShadowAdmission } from '../src/slack/work-admission.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { SqliteWorkStore } from '../src/work/store.ts';

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

test('without a configured check, a deployment serving many refuses an attempt before any key is opened, loudly', async (t) => {
  const time = clock(t);
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
  assert.equal(installationAdmissionConfigured(), false, 'a boot or readiness check can see it');
  assert.throws(() => requireInstallationAdmissionConfigured(ENV_A), InstallationAdmissionNotConfiguredError);
  requireInstallationAdmissionConfigured({});
  const missing = { component: 'installation_admission', event: 'admission_check_missing' };
  assert.deepEqual(logged.map((line) => JSON.parse(line)), [missing], 'at most once a minute');
  time.now += 60_000;
  await assert.rejects(attempt('agent_a', () => step('agent_a', model, 'A2')), InstallationNotAdmittedError);
  assert.deepEqual(logged.map((line) => JSON.parse(line)), [missing, missing], 'and again the next minute');
  configureInstallationAdmission(async () => 'admitted');
  assert.equal(installationAdmissionConfigured(), true);
  requireInstallationAdmissionConfigured(ENV_A);
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
    const refused = await step('agent_a', model, 'A3') as AssistantMessage;
    assert.equal(refused.stopReason, 'error', 'the step ends as a provider failure would, not retried');
    assert.match(refused.errorMessage ?? '', /installation_not_admitted/);
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
  const readsDuringOutage = host.reads.length;
  time.now += INSTALLATION_ADMISSION_TTL_MS - 1;
  assert.equal(await installationAdmission('inst_a'), 'refused');
  assert.equal(host.reads.length, readsDuringOutage, 'the fallback is cached: an outage costs one read per 30 seconds');
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

test('work that names no installation on a deployment serving many is a wiring error', async (t) => {
  clock(t);
  configureInstallationAdmission(async () => 'admitted');
  await assert.rejects(installationRefusesWork(HOSTED as unknown as PlatformEnv), InstallationContextError);
  assert.equal(await installationRefusesWork(ENV_A), false);
});

test('stateless calls and requests inside an attempt, such as compaction, are refused before egress too', async (t) => {
  const time = clock(t);
  const host = registry({ inst_a: 'admitted' });
  configureInstallationAdmission(host.check);
  const sent: Sent[] = [];
  const model = recordingProvider(sent);
  const { attempt } = interceptorFor(t, new Map<string, AttemptModelAccess>([
    ['agent_a', { env: ENV_A, grant: grant('inst_a', 'sub_agent_a') }],
  ]));
  // A classifier at a host boundary, and a request Flue sends without a model step.
  assert.equal((await withModelAccess(grant('inst_a', 'classifier'), ENV_A, () => modelCall(model, 'C1'))).stopReason, 'stop');
  await attempt('agent_a', async () => {
    assert.equal((await modelCall(model, 'compaction-1')).stopReason, 'stop');
    host.statuses.set('inst_a', 'refused');
    time.now += INSTALLATION_ADMISSION_TTL_MS;
    const compaction = await modelCall(model, 'compaction-2');
    assert.equal(compaction.stopReason, 'error');
    assert.match(compaction.errorMessage ?? '', /installation_not_admitted/);
  });
  const classifier = await withModelAccess(grant('inst_a', 'classifier'), ENV_A, () => modelCall(model, 'C2'));
  assert.equal(classifier.stopReason, 'error');
  assert.deepEqual(sent.map(({ step }) => step), ['C1', 'compaction-1'], 'nothing was sent once refused');
});

// ── a Slack turn, with a durable presentation and a recorded Slack ───────

const TURN_ASSIGNMENT: ResolvedAssignment = {
  workspaceId: 'T_ADMISSION',
  channelId: 'D_ADMISSION',
  agentId: 'agent_admission',
  model: 'local-stub/admission',
  modelAttribution: { source: 'pinned', providerId: 'local-stub' },
  agent: {
    id: 'agent_admission', kind: 'user', revision: 1, name: 'Admission Agent', instructions: 'Answer directly.',
    enabled: true, skills: [], mcpServers: [], apiConnections: [], repositories: [],
  },
};

function dmTurn(messageTs: string): NormalizedSlackTurn {
  return {
    workspaceId: TURN_ASSIGNMENT.workspaceId, channelId: 'D_ADMISSION', channelType: 'im',
    eventId: `Ev_ADMISSION_${messageTs}`, text: 'Summarize the plan.', userId: 'U_REQUESTER',
    messageTs, threadTs: messageTs, source: 'dm_message', contextMode: 'dm_history',
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };
}

/** The local state a turn reads its memory from, created once per test and removed with it. */
async function turnState(t: TestContext): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-admission-turn-'));
  const statePath = join(directory, 'state.sqlite');
  const keys = ['SLACK_STATE_DB_PATH', 'TAG_DB_PATH', 'CHICKPEA_AUTH_DB_PATH'] as const;
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) process.env[key] = statePath;
  closeNodeStateStores();
  t.after(() => {
    closeNodeStateStores();
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    rmSync(directory, { recursive: true, force: true });
  });
  const config = new SqliteConfigStore(statePath, { agents: [] });
  await config.createAgent(TURN_ASSIGNMENT.agent);
  const installation = await config.ensureWorkspaceInstallation({
    workspaceId: TURN_ASSIGNMENT.workspaceId, transportMode: 'direct', defaultAgentId: TURN_ASSIGNMENT.agentId,
    teamId: TURN_ASSIGNMENT.workspaceId, botUserId: 'U_CHICKPEA',
  });
  await config.updateWorkspaceInstallation(TURN_ASSIGNMENT.workspaceId, { health: 'healthy' }, installation.revision);
  config.close();
}

/** A durable presentation for the turn's Run, and a Slack that records every write. */
async function presentedTurn(
  t: TestContext,
  turn: NormalizedSlackTurn,
  // The attempt failed: the model-access interceptor refused it, or a step failed.
  failure: () => unknown = () => new AgentPromptFailure('provider'),
) {
  const work = new SqliteWorkStore(':memory:');
  const admitted = await work.admitShadowRun(prepareSlackShadowAdmission({
    turn, assignment: TURN_ASSIGNMENT, sourceVisibility: 'private', admittedAt: Date.now(),
  }));
  const runId = admitted.run.id;
  const db = openStateDb(':memory:');
  t.after(() => { db.close(); work.close(); });
  const store = new SlackRunPresentationStoreLogic(db);
  const sessionGeneration = Number(turn.messageTs.replace('.', ''));
  store.create({
    schemaVersion: 3, runId, turnJobId: `turn_${runId}`, bindingId: `binding_${runId}`,
    workBindingGeneration: 1, runFencingToken: 0,
    owner: { kind: 'selected_agent', persona: {
      name: 'Admission Agent', avatarUrl: 'https://chickpea.example/assets/agents/admission/avatar/1', avatarRevision: 1,
    } },
    sessionGeneration,
    currentActivity: {
      kind: 'preparing', action: 'Preparing', object: 'your request', generation: sessionGeneration, sequence: 1,
      operation: { operationId: `activity_${runId}_1`, certainty: 'pending' },
    },
    root: {
      workspaceId: turn.workspaceId, channelId: turn.channelId, threadTs: turn.threadTs, requesterUserId: turn.userId,
    },
  });
  const posted: string[] = [];
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const statuses: string[] = [];
  const record = (method: string) => async (input: Record<string, unknown>) => {
    posted.push(method);
    calls.push({ method, input });
    return { ok: true, ts: `${turn.messageTs.split('.')[0]}.000600`, channel: turn.channelId, input };
  };
  const client = {
    apiCall: async () => ({ ok: true }),
    assistant: { threads: {
      setStatus: async (input: Record<string, unknown>) => { statuses.push(String(input.status ?? '')); return { ok: true }; },
      setTitle: async () => ({ ok: true }),
    } },
    conversations: {
      replies: async () => ({ ok: true, messages: [] }),
      history: async () => ({ ok: true, messages: [] }),
    },
    chat: {
      startStream: record('chat.startStream'), appendStream: record('chat.appendStream'),
      stopStream: record('chat.stopStream'), postMessage: record('chat.postMessage'),
      update: record('chat.update'), delete: record('chat.delete'), postEphemeral: record('chat.postEphemeral'),
    },
  } as unknown as WebClient;
  const state = {
    getRunPresentation: (id: string) => store.get(id),
    getLatestThreadSessionGeneration: (root: Parameters<typeof store.getLatestThreadSessionGeneration>[0]) =>
      store.getLatestThreadSessionGeneration(root),
    transitionRunPresentation: (input: Parameters<typeof store.transition>[0]) => store.transition(input),
    reserveSlackAppend: (workspaceId: string) => store.reserveAppend(workspaceId),
    applySlackAppendCooldown: (workspaceId: string, retryAfterMs: number) =>
      store.applyAppendCooldown(workspaceId, retryAfterMs),
    matchFlueObservation: () => undefined,
  };
  const outcomes: Array<string | undefined> = [];
  // The plan the TurnJob froze at admission, owned by the env's installation.
  const frozen = (env: PlatformEnv | undefined) => {
    const installation = installationOwnershipOf(env);
    const runtimePlan = compileRuntimePlanV2({
      ...(installation ? { installation } : {}),
      turn, assignment: TURN_ASSIGNMENT, instructions: 'Answer directly.', memoryEpoch: 1,
    });
    return { runtimePlan, instanceId: deriveRuntimePlanInstanceId(runtimePlan) };
  };
  const run = (env: PlatformEnv | undefined) => runTurn(turn, TURN_ASSIGNMENT, env, {
    client, runId, turnId: `turn_${runId}`, presentationState: state, statusRegistry: new SlackStatusRegistry(),
    workStore: work, usageRecordingEnabled: false, runtimePlanDecision: frozen(env),
    agentPrompt: async () => { throw failure(); },
    onDelivered: (outcome) => { outcomes.push(outcome); },
  });
  /** The start of an answer already streamed on this Run's presentation, as a running turn has. */
  const streamPartialAnswer = (): string => {
    const apply = (mutation: Parameters<typeof store.transition>[0]['mutation']) => {
      const current = store.get(runId)!;
      assert.equal(store.transition({
        runId: current.runId, workBindingGeneration: current.workBindingGeneration,
        runFencingToken: current.runFencingToken, expectedProjectionVersion: current.projectionVersion,
        expectedStreamState: current.stream.state, mutation,
      }).outcome, 'applied');
    };
    const streamTs = `${Math.floor(Date.now() / 1000)}.000400`;
    apply({ kind: 'freeze_progressive_eligibility', eligibility: { allowed: true, reason: 'safe_early_release' } });
    apply({ kind: 'stream_start_intent' });
    apply({ kind: 'stream_started', messageTs: streamTs,
      flue: { instanceId: 'instance_refused', submissionId: 'submission_refused', messageId: 'message_refused' } });
    apply({ kind: 'append_intent', position: { batch: 5, index: 0 }, from: 0, to: 18, hash: 'a'.repeat(64) });
    apply({ kind: 'append_acknowledged', cursor: 1, acknowledgedPrefixHash: 'a'.repeat(64) });
    return streamTs;
  };
  return { store, runId, posted, calls, statuses, outcomes, run, streamPartialAnswer };
}

test('a turn whose installation is refused posts nothing; its activity clears and the turn is settled', async (t) => {
  clock(t);
  await turnState(t);
  const host = registry({ inst_a: 'refused' });
  configureInstallationAdmission(host.check);
  const refused = await presentedTurn(t, dmTurn('1790200001.000100'));
  await refused.run(ENV_A);
  assert.deepEqual(refused.posted, [], 'no failure text, no stream, no message');
  assert.deepEqual(refused.outcomes, ['failed'], 'the turn is settled, so nothing retries it');
  assert.deepEqual(host.reads, ['inst_a']);
  const stored = refused.store.get(refused.runId);
  assert.equal(stored?.schemaVersion, 3);
  if (stored?.schemaVersion !== 3) return;
  assert.equal(stored.terminalDelivery.state, 'abandoned', 'the Run\'s presentation closes without a reply');
  assert.equal(stored.activityProjection.state === 'visible', false, 'no activity is left showing');

  // The same failure for an admitted installation still says so.
  host.statuses.set('inst_b', 'admitted');
  const admitted = await presentedTurn(t, dmTurn('1790200002.000100'));
  await admitted.run(ENV_B);
  assert.ok(admitted.posted.length > 0);
  assert.deepEqual(admitted.outcomes, ['failed']);
});

test('a turn refused after part of its answer streamed ends that stream as shown, adding nothing', async (t) => {
  clock(t);
  await turnState(t);
  configureInstallationAdmission(async () => 'refused');
  // As Flue's read raises it: the submission failed on the proxy's refusal of its next request.
  const refused = await presentedTurn(t, dmTurn('1790200004.000100'), () => new AgentRunError({
    outcome: 'failed', submissionId: 'submission_refused',
    cause: { type: 'operation_failed', message: new InstallationNotAdmittedError().message },
  }));
  const streamTs = refused.streamPartialAnswer();
  await refused.run(ENV_A);
  assert.deepEqual(refused.calls.map(({ method }) => method), ['chat.stopStream'], 'no failure text, no new message');
  const stop = refused.calls[0]!.input;
  assert.equal(stop.ts, streamTs);
  assert.equal(stop.chunks, undefined, 'nothing is appended to the streamed prefix');
  assert.deepEqual(refused.outcomes, ['failed']);
  const stored = refused.store.get(refused.runId);
  assert.equal(stored?.stream.state === 'streaming', false, 'the stream is ended, not left streaming');
  assert.equal(stored?.stream.presentationOutcome, 'progressive');
  assert.equal(stored?.schemaVersion === 3 && stored.terminalDelivery.state, 'abandoned');
});

test('a standalone turn\'s failure is posted as before, without asking the admission check', async (t) => {
  clock(t);
  await turnState(t);
  const host = registry({});
  configureInstallationAdmission(host.check);
  const standalone = await presentedTurn(t, dmTurn('1790200003.000100'));
  await standalone.run(undefined);
  assert.ok(standalone.posted.includes('chat.startStream') || standalone.posted.includes('chat.postMessage'));
  assert.deepEqual(host.reads, []);
});
