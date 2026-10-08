import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import * as v from 'valibot';

import {
  AgentRunError,
  init,
  instrument,
  useDataWriter,
  useModel,
  useTool,
  type AgentInstanceHandle,
  type AgentReply,
  type DispatchReceipt,
} from '@flue/runtime';
import { start } from '@flue/runtime/node';
import { WebClient } from '@slack/web-api';

import type { EffectiveSlackConfig } from '../src/config/effective-config.ts';
import type { NonChatModelRole } from '../src/config/types.ts';
import { createDemoStarterAgent } from '../src/config/seed.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import {
  configureInstallationAdmission,
  resetInstallationAdmissionForTests,
} from '../src/config/installation-admission.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import {
  configurePlatformFunding,
  platformCredentialRefId,
  resetPlatformFundingForTests,
  type CreditBackReason,
  type FeeOutcome,
  type FeePost,
  type RunRef,
} from '../src/config/platform-funding.ts';
import {
  executeRoutineOccurrence,
  REFUSED_SKIP,
} from '../src/routines/execution.ts';
import {
  resolveRoutineRuntimeAccess,
  RoutineRuntimeError,
} from '../src/routines/runtime.ts';
import { hashRoutineValue, routineDestinationBindingDigest } from '../src/routines/ids.ts';
import { RoutineStoreLogic, SqliteRoutineStore } from '../src/routines/store.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { ChickpeaRoutineExecution } from '../src/agents/routine-execution.ts';
import { attachedContainerPlan } from './helpers/attached-container-plan.ts';
import type {
  RoutineDefinition,
  RoutineDefinitionContent,
  RoutineDestination,
  RoutineRun,
  RoutineStore,
} from '../src/routines/types.ts';
import {
  parseRoutineExecutionInitialData,
  routineArtifactPlan,
  ROUTINE_RESULT_DATA_NAME,
} from '../src/agents/routine-execution.ts';
import { settleCancelledOccurrences } from '../src/state/pending-work.ts';
import { CREDITS_EXHAUSTED_TEXT } from '../src/slack/web-client-presenter.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import type { UsageMicros } from '../src/usage/usage-display.ts';
import type { UsageStore } from '../src/usage/types.ts';
import { SqliteWorkStore } from '../src/work/store.ts';
import type { RunExecutionId, RunId, WorkStore } from '../src/work/types.ts';
import type { ProductTelemetryEventInput } from '../src/telemetry/events.ts';
import { withEnv } from './helpers/env.ts';
import { NO_RUN_FEES } from './helpers/platform-funding.ts';
import { SCRIPTED_MODEL, scriptedMessage, scriptedProvider } from './helpers/scripted-provider.ts';
import {
  configureModelAccessResolver,
  createModelAccessInterceptor,
  resetModelAccessForTests,
} from '../src/config/model-access.ts';
import { registeredPiProvider } from '../src/config/pi-provider-registry.ts';
import { ANTHROPIC_COMPAT_PROVIDER_ID } from '../src/model-catalog/provider-alias.ts';
import { RoutineModelResultSchema } from '../src/routines/prompt.ts';

const NOW = Date.UTC(2026, 6, 27, 12);
const offlineSlackClient = {
  chat: {
    postMessage: async () => ({
      ok: true,
      channel: 'C_TEST',
      ts: '1785153600.000000',
    }),
  },
} as unknown as WebClient;

for (const rejection of ['channel_not_found', 'is_archived', 'not_in_channel', 'ratelimited']) {
  test(`completed execution settles definite delivery rejection ${rejection} without rewriting its result`, async () => {
    const store = new SqliteRoutineStore(':memory:', () => NOW);
    let posts = 0;
    const client = new WebClient('xoxb-test', {
      retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, slackApiUrl: 'https://slack.invalid/api/',
      fetch: async () => {
        posts += 1;
        return Response.json({ ok: false, error: rejection }, rejection === 'ratelimited'
          ? { status: 429, headers: { 'retry-after': '120' } } : {});
      },
    });
    try {
      const fixture = await admittedFixture(store, rejection);
      const base = dependencies();
      const deps = { ...base,
        resolveAccess: async (...args: Parameters<typeof base.resolveAccess>) => ({ ...await base.resolveAccess(...args), client }),
        handle: fakeHandle({ reply: successfulReply() }),
      };
      const input = { env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt };
      assert.equal(await executeRoutineOccurrence(input, deps), 'completed');
      const run = await store.getRun(fixture.run.id);
      const routine = await store.getRoutine(fixture.routine.id);
      assert.equal(run?.flueAgentSettlement?.outcome, 'completed');
      assert.equal(run?.status, 'failed');
      assert.equal(run?.deliveryStatus, 'failed');
      assert.equal(run?.failureClass, rejection === 'ratelimited' ? 'slack_rate_limited' : 'channel_destination_unavailable');
      assert.equal(routine?.state, rejection === 'ratelimited' ? 'active' : 'paused');
      assert.equal(await store.getRecoveryDelivery(fixture.run.id), undefined);
      assert.equal(await executeRoutineOccurrence(input, deps), 'superseded');
      assert.equal(posts, 1);
    } finally { store.close(); }
  });
}

test('three exhausted Slack rate limits pause recurring work through the failure policy', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  let posts = 0;
  let notices = 0;
  const client = new WebClient('xoxb-test', {
    retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, slackApiUrl: 'https://slack.invalid/api/',
    fetch: async (_url, init) => {
      const text = new URLSearchParams(String(init?.body ?? '')).get('text') ?? '';
      if (text.includes('paused scheduled work')) {
        notices += 1;
        return Response.json({ ok: true, channel: 'C_TEST', ts: '1785153600.000002' });
      }
      posts += 1;
      return Response.json({ ok: false, error: 'ratelimited' },
        { status: 429, headers: { 'retry-after': '120' } });
    },
  });
  try {
    const fixture = await admittedFixture(store, 'repeated_rate_limit');
    const base = dependencies();
    const deps = { ...base,
      resolveAccess: async (...args: Parameters<typeof base.resolveAccess>) => ({ ...await base.resolveAccess(...args), client }),
      handle: fakeHandle({ reply: successfulReply() }),
    };
    for (let index = 0; index < 3; index += 1) {
      const run = index === 0 ? fixture.run : await store.createOccurrence({
        runId: `rrun_repeated_rate_limit_${index}`, idempotencyKey: `rate-limit:${index}`,
        routineId: fixture.routine.id, routineVersion: fixture.routine.version,
        scheduledFor: NOW + index, triggerSource: 'schedule', queuedAt: NOW, deadlineAt: NOW + 60_000,
      });
      const attempt = index === 0 ? fixture.attempt : await store.startAdmissionAttempt({
        occurrenceId: run.id, owner: 'heartbeat', invokeStartedAt: NOW, leaseUntil: NOW + 30_000,
      });
      assert.equal(await executeRoutineOccurrence({ env: {}, store, occurrenceId: run.id, attempt: attempt.attempt }, deps), 'completed');
      const saved = await store.getRun(run.id);
      assert.equal(saved?.flueAgentSettlement?.outcome, 'completed');
      assert.equal(saved?.failureClass, 'slack_rate_limited');
      const routine = await store.getRoutine(fixture.routine.id);
      assert.equal(routine?.consecutiveFailures, index + 1);
      assert.equal(routine?.state, index === 2 ? 'paused' : 'active');
      if (index === 2) {
        assert.equal(routine?.pausedReason, 'consecutive_failures');
        assert.equal((await store.getRecoveryDelivery(run.id))?.status, 'accepted');
      }
    }
    assert.equal(posts, 3);
    assert.equal(notices, 1);
  } finally { store.close(); }
});

for (const outcome of ['delivered', 'failed', 'unknown', 'leased'] as const) {
  test(`reentry uses durable ${outcome} delivery after a finalization interruption`, async () => {
    const store = new SqliteRoutineStore(':memory:', () => NOW);
    try {
      const fixture = await admittedFixture(store, `receipt_${outcome}`);
      const deps = dependencies();
      // First persist a genuine execution envelope/settlement but stop at the
      // delivery boundary, simulating a process interruption.
      const claim = store.claimDelivery.bind(store);
      store.claimDelivery = async () => { throw new Error('process interrupted'); };
      await assert.rejects(executeRoutineOccurrence(
        { env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt },
        { ...deps, handle: fakeHandle({ reply: successfulReply() }) },
      ), /process interrupted/);
      store.claimDelivery = claim;
      const saved = (await store.getRun(fixture.run.id))!.flueAgentSettlement;
      assert.equal(saved?.outcome, 'completed');
      await store.claimDelivery({ occurrenceId: fixture.run.id, at: NOW, leaseUntil: NOW + 10_000 });
      if (outcome !== 'leased') await store.recordDelivery({
        occurrenceId: fixture.run.id, outcome, at: NOW,
        ...(outcome === 'delivered' ? { channelId: 'C_TEST', messageTs: '1785153600.000001' }
          : { failureClass: outcome === 'failed' ? 'slack_rate_limited' : 'delivery_unknown' }),
      });
      let recoveryNotices = 0;
      const client = new WebClient('xoxb-test', {
        retryConfig: { retries: 0 },
        fetch: async (_url, init) => {
          const text = new URLSearchParams(String(init?.body ?? '')).get('text') ?? '';
          assert.match(text, /paused scheduled work/);
          recoveryNotices += 1;
          return Response.json({ ok: true, channel: 'C_TEST', ts: '1785153600.000002' });
        },
      });
      const result = await executeRoutineOccurrence(
        { env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt },
        { ...deps, resolveAccess: async (...args: Parameters<typeof deps.resolveAccess>) => ({ ...await deps.resolveAccess(...args), client }) },
      );
      assert.equal(result, outcome === 'leased' ? 'resumable' : 'completed');
      const run = await store.getRun(fixture.run.id);
      assert.deepEqual(run?.flueAgentSettlement, saved);
      assert.equal(run?.status, outcome === 'leased' ? 'running' : outcome === 'delivered' ? 'succeeded' : 'failed');
      if (outcome === 'failed') assert.equal(run?.failureClass, 'slack_rate_limited');
      assert.equal(recoveryNotices, outcome === 'unknown' ? 1 : 0);
    } finally { store.close(); }
  });
}

const config = {
  workspaceId: 'T_TEST', channelId: 'C_TEST', agentId: 'agent_default',
  agent: {
    id: 'agent_default', kind: 'user', revision: 1, name: 'Chickpea', instructions: 'Be useful.', enabled: true,
    model: 'anthropic/claude-sonnet-4-6', skills: [], mcpServers: [], apiConnections: [], repositories: [],
  },
  model: 'anthropic/claude-sonnet-4-6', provider: 'anthropic', instructions: 'Be useful.', instructionLayers: [],
  modelAttribution: { source: 'pinned', providerId: 'anthropic' },
} satisfies EffectiveSlackConfig;

async function admittedFixture(
  store: SqliteRoutineStore,
  suffix: string,
  beforeOccurrence?: (routine: RoutineDefinition) => Promise<void>,
  sourceVisibility?: 'public' | 'private' | 'unknown',
  deadlineAt = NOW + 60_000,
  destination?: RoutineDestination,
) {
  const definition: RoutineDefinitionContent = {
    name: 'Execution fixture', description: '', taskText: 'Inspect current state.',
    triggerKind: 'schedule', scheduleInput: '0 * * * *',
    scheduleJson: JSON.stringify({ version: 1, kind: 'cron', expression: '0 * * * *' }),
    timezone: 'UTC', outputPolicy: 'post', authorityMode: 'live_channel_v1',
  };
  const routineId = `routine_${suffix}`;
  const saved = await store.save({
    actorId: 'U_MEMBER', actorClass: 'member', workspaceId: 'T_TEST', channelId: 'C_TEST',
    draft: {
      action: 'create', routineId, definition, nextRunAt: NOW,
      projectedDailyStarts: 1, reservations: [{ windowStart: NOW, count: 1 }],
    },
    idempotencyKey: `create:${suffix}`,
    ...(sourceVisibility ? { sourceVisibility } : {}),
    ...(destination ? { destination } : {}),
  });
  await beforeOccurrence?.(saved);
  const run = await store.createOccurrence({
    runId: `rrun_${suffix}`,
    idempotencyKey: `run:${suffix}`,
    routineId,
    routineVersion: 1,
    scheduledFor: NOW,
    triggerSource: 'schedule',
    queuedAt: NOW,
    deadlineAt,
  });
  const attempt = await store.startAdmissionAttempt({
    occurrenceId: run.id,
    owner: 'heartbeat',
    invokeStartedAt: NOW,
    leaseUntil: NOW + 30_000,
  });
  return {
    run: (await store.getRun(run.id))!,
    routine: (await store.getRoutine(routineId))!,
    attempt,
  };
}

async function linkAgentSchedule(
  store: SqliteConfigStore,
  routine: RoutineDefinition,
): Promise<void> {
  const agent = await store.getAgent(config.agentId);
  if (!agent.model) {
    await store.updateAgent(config.agentId, { model: config.model }, agent.revision);
  }
  await store.putChannel({
    workspaceId: routine.workspaceId,
    channelId: routine.channelId,
    label: 'routine-reliability-lab',
    lifecycle: 'active',
  });
  await store.putAgentChannelGrant({
    workspaceId: routine.workspaceId,
    channelId: routine.channelId,
    agentId: config.agentId,
    status: 'active',
    createdByMembershipId: 'membership_routine_owner',
    channelLabel: 'routine-reliability-lab',
    channelIsPrivate: false,
  });
  await store.putAgentScheduleReference({
    boundRoutineVersion: routine.authorityBindingVersion ?? routine.version,
    scheduleId: routine.id,
    agentId: config.agentId,
    workspaceId: routine.workspaceId,
    channelId: routine.channelId,
    createdByMembershipId: 'membership_routine_owner',
    runsAsMembershipId: 'membership_routine_owner',
    authorityReceiptId: 'receipt_routine_reliability',
    requiredConnectionAccountIds: [],
    state: 'active',
  });
}

function dependencies(events: string[] = []) {
  return {
    now: () => NOW + 1,
    usageRecordingEnabled: false,
    resolveCredential: async () => null,
    resolveAccess: async (_run: RoutineRun, routine: RoutineDefinition) => {
      events.push('live-access');
      return {
        config: { ...config, workspaceId: routine.workspaceId, channelId: routine.channelId },
        accessHash: 'a'.repeat(64),
        botToken: 'xoxb-test',
        botUserId: 'UBOT',
      };
    },
    resolveModel: async () => {
      events.push('model');
      return { model: config.model };
    },
    codingWorkspaceConfigured: async () => false,
    preparePrompt: async (run: RoutineRun, routine: RoutineDefinition) => ({
      prompt: `Execute ${run.id}`,
      turn: {
        workspaceId: routine.workspaceId,
        channelId: routine.channelId,
        eventId: run.id,
        text: run.revision!.taskText,
        userId: routine.creatorUserId,
        messageTs: '1785100000.000100',
        threadTs: '1785100000.000100',
        source: 'app_mention' as const,
        contextMode: 'channel_history' as const,
      },
      memoryEpoch: 1,
      validateMemoryLease: async () => true,
      confirmMemory: async () => undefined,
    }),
  };
}

function offlineDependencies(events: string[] = []) {
  const base = dependencies(events);
  return {
    ...base,
    resolveAccess: async (...args: Parameters<typeof base.resolveAccess>) => ({
      ...await base.resolveAccess(...args),
      client: offlineSlackClient,
    }),
  };
}

function fakeHandle(input: {
  events?: string[];
  dispatches?: unknown[];
  reply?: AgentReply;
  dispatchError?: unknown;
  readError?: unknown;
}): AgentInstanceHandle {
  const receipt: DispatchReceipt = {
    submissionId: 'submission_test',
    acceptedAt: new Date(NOW).toISOString(),
    uid: 'uid_test',
  };
  return {
    id: 'routineagent_test',
    async dispatch(request) {
      input.events?.push('dispatch');
      input.dispatches?.push(request);
      if (input.dispatchError) throw input.dispatchError;
      return receipt;
    },
    async read() {
      input.events?.push('read');
      if (input.readError) throw input.readError;
      return input.reply ?? {
        submissionId: receipt.submissionId,
        uid: receipt.uid,
        text: '{"outcome":"succeeded"}',
        data: { [ROUTINE_RESULT_DATA_NAME]: [{ outcome: 'no_op', message: '' }] },
      };
    },
    async abort() {},
  };
}

function successfulReply(): AgentReply {
  return {
    submissionId: 'submission_test',
    uid: 'uid_test',
    text: 'Routine result',
    data: {
      [ROUTINE_RESULT_DATA_NAME]: [{ outcome: 'succeeded', message: 'Routine result' }],
    },
  };
}

function telemetrySink() {
  const info: string[] = [];
  const errors: string[] = [];
  return {
    info,
    errors,
    sink: {
      info: (message: Record<string, unknown>) => info.push(JSON.stringify(message)),
      error: (message: Record<string, unknown>) => errors.push(JSON.stringify(message)),
    },
  };
}

test('routine settlement persists measured cached tokens in the occurrence row', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    const fixture = await admittedFixture(store, 'cached_usage');
    const reply = { ...successfulReply(),
      data: { [ROUTINE_RESULT_DATA_NAME]: [{ outcome: 'no_op', message: '' }] },
      metadata: { chickpea: { schemaVersion: 1, requestedModel: 'openai/gpt-5.6-terra',
        usage: { input: 3, output: 45, cacheRead: 4482, cacheWrite: 10, totalTokens: 4540 } } },
    };
    await executeRoutineOccurrence({ env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt },
      { ...dependencies([]), handle: fakeHandle({ reply }) });
    const completed = await store.getRun(fixture.run.id);
    assert.equal(completed?.status, 'no_op');
    assert.equal(completed?.inputTokens, 3);
    assert.equal(completed?.outputTokens, 45);
    assert.equal(completed?.cacheReadTokens, 4482);
    assert.equal(completed?.cacheWriteTokens, 10);
  } finally { store.close(); }
});

test('a scheduled run refused for credits is recorded as failed with the credits reason, once', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    const fixture = await admittedFixture(store, 'credits_exhausted');
    const events: string[] = [];
    // A Flue submission's failure reaches Core as records whose messages carry the refusal's text.
    const refused = new AgentRunError({
      outcome: 'failed',
      submissionId: 'submission_test',
      cause: { type: 'operation_failed', message: 'dispatch(submission_test) failed: This installation is out of Chickpea credits (credits_exhausted).' },
    });
    await executeRoutineOccurrence({ env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt },
      { ...dependencies(events), handle: fakeHandle({ events, readError: refused }) });
    const failed = await store.getRun(fixture.run.id);
    assert.deepEqual([failed?.status, failed?.failureClass, failed?.publicError],
      ['failed', 'spend_limited', CREDITS_EXHAUSTED_TEXT]);
    assert.equal(events.filter((event) => event === 'dispatch').length, 1);
  } finally { store.close(); }
});

async function scheduledRunWithFees(
  t: TestContext,
  suffix: string,
  input: { outcome: FeeOutcome['kind']; port?: false; reply?: AgentReply; env?: Record<string, unknown> },
) {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  resetInstallationAdmissionForTests();
  resetPlatformFundingForTests();
  configureInstallationAdmission(async () => 'admitted');
  t.after(() => {
    store.close();
    resetInstallationAdmissionForTests();
    resetPlatformFundingForTests();
  });
  const events: string[] = [];
  const posts: FeePost[] = [];
  const messages: string[] = [];
  if (input.port !== false) {
    const outcome = input.outcome;
    configurePlatformFunding({
      ...NO_RUN_FEES,
      funding: async () => 'customer',
      admit: async () => 'admitted',
      charge: async () => {},
      postFee: async (post) => {
        events.push(`fee:${post.tier}`);
        posts.push(post);
        return { kind: outcome };
      },
    });
  }
  const client = {
    chat: {
      postMessage: async (message: { text?: string }) => {
        events.push('slack-post');
        messages.push(message.text ?? '');
        return { ok: true, channel: 'C_TEST', ts: '1785153600.000000' };
      },
    },
  } as unknown as WebClient;
  const fixture = await admittedFixture(store, suffix);
  const base = dependencies();
  const env = input.env ?? scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: `inst_${suffix}` });
  assert.equal(await executeRoutineOccurrence({ env, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt }, {
    ...base,
    resolveAccess: async (...args: Parameters<typeof base.resolveAccess>) => ({ ...await base.resolveAccess(...args), client }),
    handle: fakeHandle({ reply: input.reply ?? successfulReply() }),
  }), 'completed');
  return { run: await store.getRun(fixture.run.id), events, posts, messages };
}

test('a hosted scheduled run posts its task row once, before its result', async (t) => {
  const { run, events, posts } = await scheduledRunWithFees(t, 'fee_posted', { outcome: 'posted' });
  assert.equal(run?.status, 'succeeded');
  assert.deepEqual(events, ['fee:task', 'slack-post']);
  assert.deepEqual(posts, [{ installationId: 'inst_fee_posted', runId: 'submission_test', tier: 'task', agentId: config.agentId }]);
});

test('a scheduled run whose task row is a duplicate or carries no fee still posts its result', async (t) => {
  for (const outcome of ['duplicate', 'not_applicable'] as const) {
    const { run, events } = await scheduledRunWithFees(t, `fee_${outcome}`, { outcome });
    assert.equal(run?.status, 'succeeded', outcome);
    assert.deepEqual(events, ['fee:task', 'slack-post'], outcome);
  }
});

test('a quiet scheduled run posts no task row', async (t) => {
  const quiet = { ...successfulReply(), data: { [ROUTINE_RESULT_DATA_NAME]: [{ outcome: 'no_op', message: '' }] } };
  const { run, events } = await scheduledRunWithFees(t, 'fee_quiet', { outcome: 'posted', reply: quiet });
  assert.equal(run?.status, 'no_op');
  assert.deepEqual(events, []);
});

test('a scheduled run whose task row is refused fails out of usage, and its destination gets the notice, not the result', async (t) => {
  const { run, events, messages } = await scheduledRunWithFees(t, 'fee_refused', { outcome: 'refused' });
  assert.deepEqual([run?.status, run?.failureClass, run?.publicError], ['failed', 'spend_limited', CREDITS_EXHAUSTED_TEXT]);
  assert.deepEqual(events, ['fee:task', 'slack-post']);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /Routine needs attention/);
  assert.ok(messages[0]!.includes(CREDITS_EXHAUSTED_TEXT), messages[0]!);
  assert.doesNotMatch(messages[0]!, /Routine result/);
});

function RoutineFeeProbe() {
  useModel(`${ANTHROPIC_COMPAT_PROVIDER_ID}/${SCRIPTED_MODEL}`);
  const writeResult = useDataWriter(ROUTINE_RESULT_DATA_NAME, { schema: RoutineModelResultSchema });
  useTool({
    name: 'submit_routine_result',
    description: 'Submit the result.',
    input: RoutineModelResultSchema,
    output: v.string(),
    run: ({ data }) => {
      writeResult(data);
      return { output: 'Routine result submitted.', terminate: true };
    },
  });
  return 'Submit the scripted result.';
}

test('a scheduled run\'s chat row and task row carry the one run ID its requests are recorded under', { timeout: 20_000 }, async (t) => {
  const installationId = 'inst_fee_run_id';
  const env = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId });
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  resetModelAccessForTests();
  resetInstallationAdmissionForTests();
  resetPlatformFundingForTests();
  t.after(() => {
    store.close();
    resetModelAccessForTests();
    resetInstallationAdmissionForTests();
    resetPlatformFundingForTests();
  });
  configureInstallationAdmission(async () => 'admitted');
  configureModelAccessResolver({ resolve: async () => ({ apiKey: 'sk-routine-fee-test-key' }) });
  const posts: FeePost[] = [];
  configurePlatformFunding({
    ...NO_RUN_FEES,
    funding: async () => 'customer',
    admit: async () => 'admitted',
    charge: async () => {},
    postFee: async (post) => {
      posts.push(post);
      return { kind: 'posted' };
    },
  });
  const modelAccess = createModelAccessInterceptor({
    lookup: async (context) => ({
      env,
      grant: {
        installationId, providerId: 'anthropic', runId: context.submissionId!, fundingSource: 'customer',
        credentialRefId: 'cred_anthropic', credentialVersion: 1,
      },
      agentId: config.agentId,
      feeRun: { kind: 'scheduled' },
    }),
    installationGrants: async () => [],
  });
  t.after(instrument({ key: Symbol('routine-fees'), interceptor: modelAccess, observe() {}, dispose() {} }));
  scriptedProvider([(model) => scriptedMessage(model, [{
    type: 'toolCall', id: 'call_submit', name: 'submit_routine_result',
    arguments: { outcome: 'succeeded', message: 'Routine result' },
  }], 'toolUse')]);
  const runtime = await start({
    agents: [{ agent: RoutineFeeProbe, name: 'routine-fee-probe' }],
    providers: [registeredPiProvider(ANTHROPIC_COMPAT_PROVIDER_ID)!],
  });
  t.after(() => runtime.stop());
  const fixture = await admittedFixture(store, 'fee_run_id');
  const base = offlineDependencies();

  assert.equal(await executeRoutineOccurrence(
    { env, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt },
    { ...base, handle: init(RoutineFeeProbe, { id: 'routine-fee-run-id' }) },
  ), 'completed');

  assert.equal((await store.getRun(fixture.run.id))?.status, 'succeeded');
  assert.deepEqual(posts.map(({ tier }) => tier), ['chat', 'task']);
  assert.match(posts[0]!.runId, /^sub_/);
  assert.equal(posts[1]!.runId, posts[0]!.runId);
  const [admission] = await store.listAdmissions(fixture.run.id);
  assert.equal(posts[1]!.runId, admission?.flueAgentReceipt?.submissionId, 'the receipt the run recorded');
});

test('a standalone scheduled run, or one with no host port, posts its result with no fee', async (t) => {
  const standalone = await scheduledRunWithFees(t, 'fee_standalone', { outcome: 'refused', env: {} });
  assert.equal(standalone.run?.status, 'succeeded');
  assert.deepEqual(standalone.events, ['slack-post']);
  const noPort = await scheduledRunWithFees(t, 'fee_no_port', { outcome: 'refused', port: false });
  assert.equal(noPort.run?.status, 'succeeded');
  assert.deepEqual(noPort.events, ['slack-post']);
});

const CREDITED_BACK = 'Usage for this reply was credited back to your plan.';
const TOOL_CALL = { type: 'tool-input', toolName: 'post_message', toolCallId: 'call_post' } as never;
const OUT_OF_USAGE = () => new AgentRunError({
  outcome: 'failed',
  submissionId: 'submission_test',
  cause: { type: 'operation_failed', message: 'dispatch(submission_test) failed: This installation is out of Chickpea credits (credits_exhausted).' },
});
const PROVIDER_FAILED = () => new AgentRunError({
  outcome: 'failed',
  submissionId: 'submission_test',
  cause: { type: 'operation_failed', message: 'dispatch(submission_test) failed: the model provider returned an error.' },
});

/**
 * One hosted scheduled run against a host port that records its fee posts,
 * credit-backs and cost reads in `events`, beside each Slack post. A
 * `platformFunded` run's plan freezes Chickpea's credential for its provider.
 */
async function scheduledRunSettlement(
  t: TestContext,
  suffix: string,
  input: {
    handle?: (clock: { at: number }) => AgentInstanceHandle;
    platformFunded?: boolean;
    fee?: FeeOutcome['kind'];
    shown?: boolean;
    /** Slack refuses every post with this error code; `unknown` loses the connection instead. */
    rejection?: string;
    env?: Record<string, unknown>;
    port?: false;
    /** Runs the occurrence once first, as an earlier heartbeat did, and moves the clock past its deadline. */
    deadlinePassesBeforeReattach?: boolean;
    /** The channel's membership changed while the run worked, so its memory lease no longer holds. */
    accessChanged?: boolean;
  } = {},
) {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  resetInstallationAdmissionForTests();
  resetPlatformFundingForTests();
  configureInstallationAdmission(async () => 'admitted');
  t.after(() => {
    store.close();
    resetInstallationAdmissionForTests();
    resetPlatformFundingForTests();
  });
  const events: string[] = [];
  const creditBacks: Array<{ run: RunRef; reason: CreditBackReason }> = [];
  const messages: Array<{ text: string; blocks: Array<Record<string, unknown>> }> = [];
  if (input.port !== false) {
    configurePlatformFunding({
      ...NO_RUN_FEES,
      funding: async () => 'customer',
      admit: async () => 'admitted',
      charge: async () => {},
      postFee: async (post) => {
        events.push(`fee:${post.tier}`);
        return { kind: input.fee ?? 'posted' };
      },
      creditBack: async (run, reason) => {
        events.push(`credit-back:${reason}`);
        creditBacks.push({ run, reason });
        return { kind: 'credited', usageMicros: 90_000 as UsageMicros };
      },
      runCost: async () => {
        events.push('run-cost');
        return { usageMicros: 305_000 as UsageMicros, shown: input.shown ?? true };
      },
    });
  }
  const client = {
    chat: {
      postMessage: async (message: { text?: string; blocks?: Array<Record<string, unknown>> }) => {
        events.push('slack-post');
        messages.push({ text: message.text ?? '', blocks: message.blocks ?? [] });
        if (input.rejection === 'unknown') throw new Error('socket hang up');
        if (input.rejection) throw { data: { ok: false, error: input.rejection } };
        return { ok: true, channel: 'C_TEST', ts: '1785153600.000000' };
      },
    },
  } as unknown as WebClient;
  const fixture = await admittedFixture(store, suffix);
  const clock = { at: NOW + 1 };
  const base = dependencies();
  const env = input.env ?? scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: `inst_${suffix}` });
  const deps = {
    ...base,
    now: () => clock.at,
    resolveAccess: async (...args: Parameters<typeof base.resolveAccess>) => ({ ...await base.resolveAccess(...args), client }),
    ...(input.platformFunded
      ? {
          resolveCredential: async () => ({
            credentialRefId: platformCredentialRefId('anthropic'), version: 1, providerId: 'anthropic',
            sourceKind: 'platform' as const, label: 'Chickpea', scopeLabel: null, unknownRotation: false,
          }),
        }
      : {}),
    ...(input.accessChanged
      ? {
          preparePrompt: async (...args: Parameters<typeof base.preparePrompt>) => ({
            ...await base.preparePrompt(...args), validateMemoryLease: async () => false,
          }),
        }
      : {}),
    handle: input.handle?.(clock) ?? fakeHandle({ reply: successfulReply() }),
  };
  const occurrence = { env, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt };
  if (input.deadlinePassesBeforeReattach) {
    assert.equal(await executeRoutineOccurrence(occurrence, deps), 'resumable');
    clock.at = NOW + 120_000;
  }
  assert.equal(await executeRoutineOccurrence(occurrence, deps), 'completed');
  return { run: await store.getRun(fixture.run.id), events, creditBacks, messages };
}

/** A handle whose read reports what the Agent did, then ends as told. */
function readingHandle(read: (options?: { onEvent?: (event: never) => void }) => Promise<AgentReply>): AgentInstanceHandle {
  return { ...fakeHandle({}), read: async (_receipt, options) => read(options) };
}

function routineFooter(message: { blocks: Array<Record<string, unknown>> } | undefined): string[] | undefined {
  return message?.blocks
    .flatMap((block) => block.type === 'context' ? block.elements as Array<{ text?: string }> : [])
    .map((element) => String(element.text))
    .find((text) => text.includes('Scheduled'))
    ?.split(' | ');
}

test('a delivered scheduled result ends its footer with what the run used, read after its task row', async (t) => {
  const shown = await scheduledRunSettlement(t, 'cost_shown');
  assert.equal(shown.run?.status, 'succeeded');
  assert.deepEqual(shown.events, ['fee:task', 'run-cost', 'slack-post']);
  assert.equal(routineFooter(shown.messages[0])?.at(-1), 'This reply used $0.31');

  const hidden = await scheduledRunSettlement(t, 'cost_hidden', { shown: false });
  assert.deepEqual(hidden.events, ['fee:task', 'run-cost', 'slack-post']);
  assert.equal(routineFooter(hidden.messages[0])?.at(-1), 'Scheduled');
  assert.equal(JSON.stringify(hidden.messages).includes('This reply used'), false);
});

test('a platform-funded scheduled run that failed as a whole is credited back, and its notice says so', async (t) => {
  const { run, creditBacks, messages } = await scheduledRunSettlement(t, 'failed_platform', {
    platformFunded: true, handle: () => fakeHandle({ readError: PROVIDER_FAILED() }),
  });
  assert.deepEqual([run?.status, run?.failureClass], ['failed', 'tool_failed']);
  assert.deepEqual(creditBacks, [{ run: { installationId: 'inst_failed_platform', runId: 'submission_test' }, reason: 'provider' }]);
  assert.equal(messages.length, 1);
  assert.ok(messages[0]!.text.includes(`${run?.publicError} ${CREDITED_BACK}`), messages[0]!.text);
  assert.equal(run?.publicError?.includes(CREDITED_BACK), false, 'the stored error stays as it was');
  assert.equal(JSON.stringify(messages).includes('This reply used'), false);
});

test('an own-key scheduled run that failed as a whole is not credited back', async (t) => {
  const { run, creditBacks, messages } = await scheduledRunSettlement(t, 'failed_own_key', {
    handle: () => fakeHandle({ readError: PROVIDER_FAILED() }),
  });
  assert.deepEqual([run?.status, run?.failureClass], ['failed', 'tool_failed']);
  assert.deepEqual(creditBacks, []);
  assert.equal(JSON.stringify(messages).includes(CREDITED_BACK), false);
});

test('an own-key scheduled run that ran past its deadline after a tool call is credited back as a timeout', async (t) => {
  const { run, creditBacks, messages } = await scheduledRunSettlement(t, 'deadline_live', {
    handle: (clock) => readingHandle(async (options) => {
      options?.onEvent?.(TOOL_CALL);
      clock.at = NOW + 120_000;
      throw new DOMException('The read timed out.', 'TimeoutError');
    }),
  });
  assert.deepEqual([run?.status, run?.failureClass], ['failed', 'unknown_external_outcome']);
  assert.deepEqual(creditBacks, [{ run: { installationId: 'inst_deadline_live', runId: 'submission_test' }, reason: 'timeout' }]);
  assert.ok(messages.some(({ text }) => text.includes(CREDITED_BACK)));
});

test('a dispatched scheduled run whose deadline passes before it reattaches is credited back as a timeout', async (t) => {
  const { run, creditBacks, messages } = await scheduledRunSettlement(t, 'deadline_reattach', {
    deadlinePassesBeforeReattach: true,
    handle: (clock) => readingHandle(async () => {
      if (clock.at < NOW + 120_000) throw new DOMException('The read timed out.', 'TimeoutError');
      throw new Error('reattached after the deadline');
    }),
  });
  assert.deepEqual([run?.status, run?.failureClass], ['failed', 'deadline_exceeded']);
  assert.deepEqual(creditBacks, [{ run: { installationId: 'inst_deadline_reattach', runId: 'submission_test' }, reason: 'timeout' }]);
  assert.equal(messages.length, 1);
  assert.ok(messages[0]!.text.includes(`${run?.publicError} ${CREDITED_BACK}`), messages[0]!.text);
});

test('a scheduled run that ran out of usage, before or after a tool call, is not credited back', async (t) => {
  const before = await scheduledRunSettlement(t, 'usage_before_tool', {
    platformFunded: true, handle: () => fakeHandle({ readError: OUT_OF_USAGE() }),
  });
  assert.deepEqual([before.run?.status, before.run?.failureClass], ['failed', 'spend_limited']);
  const after = await scheduledRunSettlement(t, 'usage_after_tool', {
    platformFunded: true,
    handle: () => readingHandle(async (options) => { options?.onEvent?.(TOOL_CALL); throw OUT_OF_USAGE(); }),
  });
  assert.deepEqual([after.run?.status, after.run?.failureClass], ['failed', 'unknown_external_outcome']);
  for (const { creditBacks, messages } of [before, after]) {
    assert.deepEqual(creditBacks, []);
    assert.equal(JSON.stringify(messages).includes(CREDITED_BACK), false);
  }
});

test('a scheduled run whose channel access changed after a tool call is not credited back', async (t) => {
  const { run, creditBacks, messages } = await scheduledRunSettlement(t, 'access_changed', {
    platformFunded: true,
    accessChanged: true,
    handle: () => readingHandle(async (options) => { options?.onEvent?.(TOOL_CALL); return successfulReply(); }),
  });
  assert.deepEqual([run?.status, run?.failureClass], ['failed', 'unknown_external_outcome']);
  assert.deepEqual(creditBacks, []);
  assert.equal(JSON.stringify(messages).includes(CREDITED_BACK), false);
});

test('a scheduled run whose task row is refused is not credited back', async (t) => {
  const { run, creditBacks, messages } = await scheduledRunSettlement(t, 'task_refused', { platformFunded: true, fee: 'refused' });
  assert.deepEqual([run?.status, run?.failureClass], ['failed', 'spend_limited']);
  assert.deepEqual(creditBacks, []);
  assert.equal(JSON.stringify(messages).includes(CREDITED_BACK), false);
});

test('a result Slack could not take is credited back only when Slack refused it for load', async (t) => {
  const cases = [
    ['ratelimited', 'slack_rate_limited', 'chickpea'],
    ['channel_not_found', 'channel_destination_unavailable', undefined],
    ['unknown', 'delivery_unknown', undefined],
  ] as const;
  for (const [rejection, failureClass, reason] of cases) {
    const { run, creditBacks, messages } = await scheduledRunSettlement(t, `undelivered_${failureClass}`, {
      platformFunded: true, rejection,
    });
    assert.deepEqual([run?.status, run?.failureClass], ['failed', failureClass], rejection);
    assert.deepEqual(creditBacks.map((call) => call.reason), reason ? [reason] : [], rejection);
    assert.equal(JSON.stringify(messages).includes(CREDITED_BACK), false, 'nothing posted says so');
  }
});

test('a private schedule whose thread can no longer take its result is not credited back', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-direct-thread-credit-'));
  const path = join(dir, 'state.db');
  const store = new SqliteRoutineStore(path, () => NOW);
  const configStore = new SqliteConfigStore(path, { agents: [] });
  resetInstallationAdmissionForTests();
  configureInstallationAdmission(async () => 'admitted');
  const creditBacks: CreditBackReason[] = [];
  configurePlatformFunding({
    ...NO_RUN_FEES,
    funding: async () => 'customer',
    admit: async () => 'admitted',
    charge: async () => {},
    creditBack: async (_run, reason) => {
      creditBacks.push(reason);
      return { kind: 'credited', usageMicros: 90_000 as UsageMicros };
    },
  });
  t.after(() => {
    configStore.close();
    store.close();
    resetInstallationAdmissionForTests();
    resetPlatformFundingForTests();
    rmSync(dir, { recursive: true, force: true });
  });
  const destination = {
    kind: 'direct_thread' as const,
    conversationId: 'D_DIRECT',
    threadTs: '1787853827.722389',
    ownerMembershipId: 'membership_direct',
  };
  await configStore.createAgent({
    id: 'agent_direct', name: 'Direct Agent', instructions: 'Run private work.', enabled: true,
    lifecycle: 'active', creatorMembershipId: destination.ownerMembershipId,
    editPolicy: 'creator_and_admins', model: config.model,
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  });
  const pending = await store.save({
    actorId: 'U_DIRECT', actorClass: 'member', workspaceId: 'T_TEST',
    channelId: destination.conversationId, destination,
    draft: {
      action: 'create', routineId: 'routine_direct_credit',
      definition: {
        name: 'Direct fixture', description: '', taskText: 'Inspect current state.',
        triggerKind: 'schedule', scheduleInput: '0 * * * *',
        scheduleJson: JSON.stringify({ version: 1, kind: 'cron', expression: '0 * * * *' }),
        timezone: 'UTC', outputPolicy: 'post', authorityMode: 'live_direct_member_v1',
      },
      nextRunAt: NOW, projectedDailyStarts: 1,
      reservations: [{ windowStart: NOW, count: 1 }],
    },
    idempotencyKey: 'create:direct-credit', sourceVisibility: 'private',
  });
  const digest = routineDestinationBindingDigest(pending.id, pending.workspaceId, destination);
  const reference = await configStore.putAgentScheduleReference({
    boundRoutineVersion: pending.authorityBindingVersion ?? pending.version,
    scheduleId: pending.id, agentId: 'agent_direct', workspaceId: pending.workspaceId,
    channelId: destination.conversationId, destinationKind: 'direct_thread',
    destinationBindingDigest: digest, createdByMembershipId: destination.ownerMembershipId,
    runsAsMembershipId: destination.ownerMembershipId,
    authorityReceiptId: 'receipt_direct', requiredConnectionAccountIds: [], state: 'active',
  });
  const routine = await store.activateDirectRoutine({
    routineId: pending.id, expectedVersion: pending.version,
    expectedReferenceRevision: reference.revision, destinationBindingDigest: digest,
  });
  const run = await store.createOccurrence({
    runId: 'rrun_direct_credit', idempotencyKey: 'run:direct-credit',
    routineId: routine.id, routineVersion: routine.version, scheduledFor: NOW,
    triggerSource: 'schedule', queuedAt: NOW, deadlineAt: NOW + 60_000,
  });
  const attempt = await store.startAdmissionAttempt({
    occurrenceId: run.id, owner: 'heartbeat', invokeStartedAt: NOW, leaseUntil: NOW + 30_000,
  });
  const client = {
    conversations: { open: async () => ({ ok: true, channel: { id: destination.conversationId, is_im: true } }) },
    chat: {
      postMessage: async (input: Record<string, unknown>) => {
        if ('thread_ts' in input) throw { data: { error: 'cannot_reply_to_message' } };
        return { ok: true, channel: destination.conversationId, ts: '1787853828.000100' };
      },
    },
  };
  await executeRoutineOccurrence({
    env: scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_direct_credit' }),
    store, occurrenceId: run.id, attempt: attempt.attempt,
  }, {
    ...dependencies(),
    resolveCredential: async () => ({
      credentialRefId: platformCredentialRefId('anthropic'), version: 1, providerId: 'anthropic',
      sourceKind: 'platform' as const, label: 'Chickpea', scopeLabel: null, unknownRotation: false,
    }),
    resolveAccess: async () => ({
      config: {
        ...config,
        channelId: destination.conversationId,
        agentId: 'agent_direct',
        agent: { ...config.agent, id: 'agent_direct', name: 'Direct Agent' },
      },
      accessHash: 'a'.repeat(64),
      botToken: 'xoxb-test',
      botUserId: 'UBOT',
      actorSlackUserId: 'U_DIRECT',
      actorMembershipId: destination.ownerMembershipId,
      authorityReceiptId: 'receipt_direct',
      client: client as never,
    }),
    handle: fakeHandle({ reply: successfulReply() }),
  });
  assert.equal((await store.getRun(run.id))?.failureClass, 'direct_thread_unavailable');
  assert.deepEqual(creditBacks, []);
});

test('standalone, and hosted with no port, a scheduled run asks the host nothing and posts what it posted before', async (t) => {
  const standalone = await scheduledRunSettlement(t, 'settle_standalone', { env: {} });
  resetPlatformFundingForTests();
  const standaloneNoPort = await scheduledRunSettlement(t, 'settle_standalone', { env: {}, port: false });
  assert.deepEqual(standalone.events, ['slack-post']);
  assert.deepEqual(standalone.messages, standaloneNoPort.messages);
  assert.deepEqual(routineFooter(standalone.messages[0]), ['Chickpea', 'anthropic/claude-sonnet-4-6', 'Scheduled']);

  const failed = await scheduledRunSettlement(t, 'settle_standalone_failed', {
    env: {}, platformFunded: true, handle: () => fakeHandle({ readError: PROVIDER_FAILED() }),
  });
  assert.deepEqual(failed.creditBacks, []);
  assert.equal(JSON.stringify(failed.messages).includes(CREDITED_BACK), false);

  const portless = await scheduledRunSettlement(t, 'settle_portless', { port: false });
  assert.deepEqual(portless.events, ['slack-post']);
  assert.deepEqual(routineFooter(portless.messages[0]), ['Chickpea', 'anthropic/claude-sonnet-4-6', 'Scheduled']);
});

test('a scheduled run refused for credits after a tool call still pauses for its unknown outcome', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    const fixture = await admittedFixture(store, 'credits_after_tool');
    const refused = new AgentRunError({
      outcome: 'failed',
      submissionId: 'submission_test',
      cause: { type: 'operation_failed', message: 'dispatch(submission_test) failed: This installation is out of Chickpea credits (credits_exhausted).' },
    });
    const handle: AgentInstanceHandle = {
      ...fakeHandle({}),
      async read(_receipt, options) {
        options?.onEvent?.({ type: 'tool-input', toolName: 'post_message', toolCallId: 'call_post' } as never);
        throw refused;
      },
    };
    await executeRoutineOccurrence({ env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt },
      { ...dependencies([]), handle });
    const failed = await store.getRun(fixture.run.id);
    assert.deepEqual([failed?.status, failed?.failureClass], ['failed', 'unknown_external_outcome']);
    assert.equal((await store.getRoutine(fixture.run.routineId))?.state, 'paused');
  } finally { store.close(); }
});

test('a routine settlement keeps one-hour cache writes, so its Usage estimate stays partial', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  const usage = new SqliteUsageStore(':memory:');
  try {
    const runs: Record<string, string> = {};
    for (const [suffix, cacheWrite1h] of [['short_cache', undefined], ['long_cache', 10]] as const) {
      const fixture = await admittedFixture(store, suffix);
      runs[suffix] = fixture.run.id;
      const reply = { ...successfulReply(),
        data: { [ROUTINE_RESULT_DATA_NAME]: [{ outcome: 'no_op', message: '' }] },
        metadata: { chickpea: { schemaVersion: 1, requestedModel: 'anthropic/claude-haiku-4-5',
          usage: { input: 3, output: 45, cacheRead: 4482, cacheWrite: 10, totalTokens: 4540,
            ...(cacheWrite1h ? { cacheWrite1h } : {}) } } },
      };
      await executeRoutineOccurrence({ env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt },
        { ...dependencies([]), usageRecordingEnabled: true, usageStore: usage, handle: fakeHandle({ reply }) });
    }
    const settlement = (await store.getRun(runs.long_cache!))?.flueAgentSettlement;
    assert.equal(settlement?.outcome === 'completed' ? settlement.result.usage.cacheWrite1hTokens : undefined, 10);
    const estimate = async (suffix: string) => {
      const measurement = (await usage.getOperation(runs[suffix]!))?.measurements[0];
      return [measurement?.estimateCompleteness, measurement?.priceUnknownReason];
    };
    // Nothing prices this model on the fixture's date; one-hour writes still read as partial.
    assert.deepEqual(await estimate('short_cache'), ['unknown', 'price_unknown']);
    assert.deepEqual(await estimate('long_cache'), ['partial', 'pricing_dimension_unknown']);
  } finally {
    usage.close();
    store.close();
  }
});

test('the routine envelope freezes the image capability its Agent role resolves', async () => {
  const roleReader = (modelId?: string) => ({
    async getWorkspaceModelRole(workspaceId: string, role: NonChatModelRole) {
      return modelId
        ? { workspaceId, role, modelId, revision: 1, createdAt: NOW, updatedAt: NOW }
        : undefined;
    },
    async getAgentModelRole() {
      return undefined;
    },
  });
  const freeze = async (suffix: string, modelId?: string) => {
    const store = new SqliteRoutineStore(':memory:', () => NOW);
    try {
      const fixture = await admittedFixture(store, suffix);
      await executeRoutineOccurrence(
        { env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt },
        { ...dependencies([]), handle: fakeHandle({}), modelRoleReader: roleReader(modelId) },
      );
      const envelope = (await store.getRun(fixture.run.id))?.flueAgentEnvelope;
      return parseRoutineExecutionInitialData(envelope?.initialData).runtimePlan;
    } finally { store.close(); }
  };

  await withEnv({ OPENAI_API_KEY: 'sk-image-role-routine' }, async () => {
    const unset = await freeze('image_role_unset');
    assert.deepEqual(unset.imageCapability, {
      role: 'image', filled: false, acceptsImageInput: false,
    });

    const filled = await freeze('image_role_filled', 'openai/gpt-image-2.5-flare');
    assert.deepEqual(filled.imageCapability, {
      role: 'image', filled: true, acceptsImageInput: true,
    });
    assert.notEqual(filled.harnessRevision, unset.harnessRevision);
  });
});

test('live access and a frozen app checkpoint precede Flue dispatch', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  const events: string[] = [];
  const productEvents: unknown[] = [];
  const dispatches: unknown[] = [];
  try {
    const fixture = await admittedFixture(store, 'order');
    await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, {
      ...dependencies(events),
      handle: fakeHandle({ events, dispatches }),
      productTelemetry: { capture: (event: ProductTelemetryEventInput) => productEvents.push(event) },
    });

    assert.deepEqual(events, ['live-access', 'model', 'dispatch', 'read']);
    const completed = await store.getRun(fixture.run.id);
    assert.equal(completed?.status, 'no_op');
    assert.deepEqual(productEvents, [{
      event: 'run_completed',
      workspaceId: 'T_TEST',
      agentId: 'agent_default',
      triggerKind: 'scheduled',
      outcome: 'no_op',
    }]);
    assert.equal(completed?.flueRunId, null);
    assert.equal(completed?.flueAgentEnvelope?.idempotencyKey, fixture.attempt.attemptId);
    const dispatched = dispatches[0] as {
      idempotencyKey: string;
      message: unknown;
    };
    assert.equal(dispatched.idempotencyKey, fixture.attempt.attemptId);
    assert.deepEqual(dispatched.message, {
      kind: 'signal',
      type: 'schedule',
      body: `Execute ${fixture.run.id}`,
      attributes: {
        routineId: fixture.routine.id,
        occurrenceId: fixture.run.id,
        workspaceId: 'T_TEST',
        conversationId: 'C_TEST',
        destinationKind: 'channel',
        ownerAgentId: 'agent_default',
        ownerMembershipId: 'legacy_membership',
        threadTs: '',
        triggerSource: 'schedule',
        scheduledFor: String(NOW),
        // The member the saved task runs as, mirrored from the prompt envelope
        // so admission can cross-check identity as well as the due time.
        actorSlackUserId: 'U_MEMBER',
      },
    });
    assert.equal(completed?.flueAgentEnvelope?.schemaVersion, 2);
    const executionInstructions = parseRoutineExecutionInitialData(completed?.flueAgentEnvelope?.initialData).runtimePlan.instructions;
    assert.match(executionInstructions, /saved occurrence is due now/);
    assert.match(executionInstructions, /not an acknowledgement that it has been scheduled/);
    assert.deepEqual(
      parseRoutineExecutionInitialData(completed?.flueAgentEnvelope?.initialData)
        .connectorUsageCorrelation,
      { operationId: fixture.run.id },
    );
    assert.equal(
      (await store.listAdmissions(fixture.run.id))[0]?.flueAgentReceipt?.submissionId,
      'submission_test',
    );
  } finally {
    store.close();
  }
});

test('an interrupted local read stays resumable and the next execution reads the saved receipt', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  const sandboxDependencies = {
    ...dependencies(),
    sandboxInstalled: () => true,
    codingWorkspaceConfigured: async () => true,
  };
  try {
    const fixture = await admittedFixture(store, 'resume');
    const interrupted = new DOMException('local reader stopped', 'AbortError');
    const first = await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, { ...sandboxDependencies, handle: fakeHandle({ readError: interrupted }) });
    assert.equal(first, 'resumable');
    assert.equal((await store.getRun(fixture.run.id))?.status, 'running');

    let dispatches = 0;
    const resumed = fakeHandle({});
    resumed.dispatch = async () => { dispatches += 1; throw new Error('must not redispatch'); };
    const second = await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, { ...sandboxDependencies, handle: resumed });
    assert.equal(second, 'completed');
    assert.equal(dispatches, 0);
    // The Agent opens and releases its own coding workspace; the relay never
    // touches the Sandbox Durable Object for a current plan.
    assert.equal((await store.getRun(fixture.run.id))?.status, 'no_op');
  } finally {
    store.close();
  }
});

test('a catalog refresh does not reject scheduled execution reattachment after fresh access checks', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  let catalogRevision = '0';
  let conversationChecks = 0;
  let membershipChecks = 0;
  let dispatches = 0;
  let catalogLoads = 0;
  const preparationOrder: string[] = [];
  const resolveAccess = async (run: RoutineRun, routine: RoutineDefinition) => {
    preparationOrder.push('access');
    const access = await resolveRoutineRuntimeAccess(run, routine, undefined, {
      credentials: async () => ({ botToken: 'xoxb-test', signingSecret: undefined, botUserId: 'UBOT' }),
      authTest: async () => ({
        ok: true, error: undefined, teamId: 'T_TEST', teamName: 'Test',
        botName: 'Chickpea', botUserId: 'UBOT',
      }),
      conversation: async () => {
        conversationChecks += 1;
        return {
          ok: true, error: undefined, retryAfterMs: undefined,
          channel: { id: routine.channelId, name: 'test', isPrivate: false, isMember: true },
          facts: {
            id: routine.channelId, name: 'test', private: false, archived: false,
            frozen: false, shared: false, externallyShared: false,
            organizationShared: false, pendingShared: false, member: true,
            teamId: routine.workspaceId,
          },
        };
      },
      members: async () => {
        membershipChecks += 1;
        return {
          ok: true, error: undefined, memberIds: ['U_MEMBER', 'UBOT'],
          nextCursor: undefined, retryAfterMs: undefined,
        };
      },
      config: async () => ({
        ...config,
        workspaceId: routine.workspaceId,
        channelId: routine.channelId,
        modelAttribution: {
          source: 'workspace_default' as const,
          providerId: 'anthropic',
          workspaceDefaultRevision: 2,
          catalogRevision,
        },
      }),
    });
    return catalogRevision === '0'
      ? {
          ...access,
          accessHash: access.legacyAccessHashForCatalogRevision!('0'),
        }
      : access;
  };
  try {
    const fixture = await admittedFixture(store, 'catalog_refresh_reattach');
    const first = await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, {
      ...dependencies(),
      resolveAccess,
      loadCatalog: async () => {
        catalogLoads += 1;
        preparationOrder.push('catalog');
        if (catalogLoads === 2) throw new Error('transient catalog read failure');
        return { status: 'bundled', revision: 0 };
      },
      handle: fakeHandle({ readError: new DOMException('reader stopped', 'AbortError') }),
    });
    assert.equal(first, 'resumable');

    catalogRevision = '1';
    const resumed = fakeHandle({});
    resumed.dispatch = async () => {
      dispatches += 1;
      throw new Error('must not redispatch');
    };
    const second = await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, {
      ...dependencies(),
      resolveAccess,
      loadCatalog: async () => {
        catalogLoads += 1;
        preparationOrder.push('catalog');
        if (catalogLoads === 2) throw new Error('transient catalog read failure');
        return { status: 'activated', revision: 1 };
      },
      handle: resumed,
    });

    assert.equal(second, 'completed');
    assert.equal((await store.getRun(fixture.run.id))?.status, 'no_op');
    assert.equal(dispatches, 0);
    assert.equal(conversationChecks, 2);
    assert.equal(membershipChecks, 2);
    assert.equal(catalogLoads, 2);
    assert.deepEqual(preparationOrder, ['catalog', 'access', 'catalog', 'access']);
  } finally {
    store.close();
  }
});

test('an unresolved initial assignment records a skip without model or Agent side effects', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  const events: string[] = [];
  try {
    const fixture = await admittedFixture(store, 'assignment_missing');
    const outcome = await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, {
      ...dependencies(events),
      resolveAccess: async () => {
        events.push('live-access');
        throw new RoutineRuntimeError(
          'assignment_missing',
          'This Channel does not have an active Chickpea Agent.',
        );
      },
      resolveModel: async () => {
        events.push('model');
        return { model: config.model };
      },
      preparePrompt: async () => {
        events.push('prompt');
        throw new Error('must not prepare a prompt without an assignment');
      },
      handle: fakeHandle({ events }),
    });

    assert.equal(outcome, 'completed');
    assert.deepEqual(events, ['live-access']);
    const skipped = await store.getRun(fixture.run.id);
    assert.equal(skipped?.status, 'skipped');
    assert.equal(skipped?.skipReason, 'unresolved_assignment');
    assert.equal(skipped?.failureClass, 'assignment_missing');
    assert.equal(skipped?.flueAgentEnvelope, null);
  } finally {
    store.close();
  }
});

test('a direct schedule with permanently missing Agent authority fails and auto-disables', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-direct-authority-loss-'));
  const path = join(dir, 'state.db');
  const store = new SqliteRoutineStore(path, () => NOW);
  const configStore = new SqliteConfigStore(path, { agents: [] });
  const destination = {
    kind: 'direct_thread' as const,
    conversationId: 'D_DIRECT',
    threadTs: '1787853827.722389',
    ownerMembershipId: 'membership_direct',
  };
  try {
    await configStore.createAgent({
      id: 'agent_direct', name: 'Direct', instructions: 'Run private work.', enabled: true,
      lifecycle: 'active', creatorMembershipId: destination.ownerMembershipId,
      editPolicy: 'creator_and_admins', model: config.model,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    const routine = await store.save({
      actorId: 'U_DIRECT', actorClass: 'member', workspaceId: 'T_TEST',
      channelId: destination.conversationId, destination,
      draft: {
        action: 'create', routineId: 'routine_direct_assignment_missing',
        definition: {
          name: 'Direct fixture', description: '', taskText: 'Inspect current state.',
          triggerKind: 'schedule', scheduleInput: '0 * * * *',
          scheduleJson: JSON.stringify({ version: 1, kind: 'cron', expression: '0 * * * *' }),
          timezone: 'UTC', outputPolicy: 'post', authorityMode: 'live_direct_member_v1',
        },
        nextRunAt: NOW, projectedDailyStarts: 1,
        reservations: [{ windowStart: NOW, count: 1 }],
      },
      idempotencyKey: 'create:direct-assignment-missing', sourceVisibility: 'private',
    });
    const digest = routineDestinationBindingDigest(routine.id, routine.workspaceId, destination);
    const reference = await configStore.putAgentScheduleReference({
      boundRoutineVersion: routine.authorityBindingVersion ?? routine.version,
      scheduleId: routine.id, agentId: 'agent_direct', workspaceId: routine.workspaceId,
      channelId: destination.conversationId, destinationKind: 'direct_thread',
      destinationBindingDigest: digest, createdByMembershipId: destination.ownerMembershipId,
      runsAsMembershipId: destination.ownerMembershipId,
      authorityReceiptId: 'receipt_direct', requiredConnectionAccountIds: [], state: 'active',
    });
    await store.activateDirectRoutine({
      routineId: routine.id, expectedVersion: routine.version,
      expectedReferenceRevision: reference.revision, destinationBindingDigest: digest,
    });
    const run = await store.createOccurrence({
      runId: 'rrun_direct_assignment_missing', idempotencyKey: 'run:direct-assignment-missing',
      routineId: routine.id, routineVersion: routine.version, scheduledFor: NOW,
      triggerSource: 'schedule', queuedAt: NOW, deadlineAt: NOW + 60_000,
    });
    const attempt = await store.startAdmissionAttempt({
      occurrenceId: run.id, owner: 'heartbeat', invokeStartedAt: NOW, leaseUntil: NOW + 30_000,
    });

    const outcome = await executeRoutineOccurrence({
      env: {}, store, occurrenceId: run.id, attempt: attempt.attempt,
    }, {
      ...dependencies(),
      resolveAccess: async () => {
        throw new RoutineRuntimeError('assignment_missing', 'The direct Agent is unavailable.');
      },
    });

    assert.equal(outcome, 'completed');
    assert.equal((await store.getRun(run.id))?.status, 'failed');
    const disabled = await store.getRoutine(routine.id);
    assert.equal(disabled?.state, 'disabled');
    assert.equal(disabled?.disabledReason, 'assignment_missing');
  } finally {
    configStore.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a definitive private-thread rejection pauses recurring work and posts one root notice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-direct-thread-recovery-'));
  const path = join(dir, 'state.db');
  const store = new SqliteRoutineStore(path, () => NOW);
  const configStore = new SqliteConfigStore(path, { agents: [] });
  const destination = {
    kind: 'direct_thread' as const,
    conversationId: 'D_DIRECT',
    threadTs: '1787853827.722389',
    ownerMembershipId: 'membership_direct',
  };
  const slackRequests: Array<Record<string, unknown>> = [];
  const productEvents: unknown[] = [];
  try {
    await configStore.createAgent({
      id: 'agent_direct', name: 'Direct Agent', instructions: 'Run private work.', enabled: true,
      lifecycle: 'active', creatorMembershipId: destination.ownerMembershipId,
      editPolicy: 'creator_and_admins', model: config.model,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    const pending = await store.save({
      actorId: 'U_DIRECT', actorClass: 'member', workspaceId: 'T_TEST',
      channelId: destination.conversationId, destination,
      draft: {
        action: 'create', routineId: 'routine_direct_thread_recovery',
        definition: {
          name: 'Direct recurring fixture', description: '', taskText: 'Inspect current state.',
          triggerKind: 'schedule', scheduleInput: '0 * * * *',
          scheduleJson: JSON.stringify({ version: 1, kind: 'cron', expression: '0 * * * *' }),
          timezone: 'UTC', outputPolicy: 'post', authorityMode: 'live_direct_member_v1',
        },
        nextRunAt: NOW, projectedDailyStarts: 1,
        reservations: [{ windowStart: NOW, count: 1 }],
      },
      idempotencyKey: 'create:direct-thread-recovery', sourceVisibility: 'private',
    });
    const digest = routineDestinationBindingDigest(pending.id, pending.workspaceId, destination);
    const reference = await configStore.putAgentScheduleReference({
      boundRoutineVersion: pending.authorityBindingVersion ?? pending.version,
      scheduleId: pending.id, agentId: 'agent_direct', workspaceId: pending.workspaceId,
      channelId: destination.conversationId, destinationKind: 'direct_thread',
      destinationBindingDigest: digest, createdByMembershipId: destination.ownerMembershipId,
      runsAsMembershipId: destination.ownerMembershipId,
      authorityReceiptId: 'receipt_direct', requiredConnectionAccountIds: [], state: 'active',
    });
    const routine = await store.activateDirectRoutine({
      routineId: pending.id, expectedVersion: pending.version,
      expectedReferenceRevision: reference.revision, destinationBindingDigest: digest,
    });
    const run = await store.createOccurrence({
      runId: 'rrun_direct_thread_recovery', idempotencyKey: 'run:direct-thread-recovery',
      routineId: routine.id, routineVersion: routine.version, scheduledFor: NOW,
      triggerSource: 'schedule', queuedAt: NOW, deadlineAt: NOW + 60_000,
    });
    const attempt = await store.startAdmissionAttempt({
      occurrenceId: run.id, owner: 'heartbeat', invokeStartedAt: NOW, leaseUntil: NOW + 30_000,
    });
    const client = {
      conversations: {
        open: async (input: Record<string, unknown>) => {
          slackRequests.push({ method: 'open', ...input });
          return { ok: true, channel: { id: destination.conversationId, is_im: true } };
        },
      },
      chat: {
        postMessage: async (input: Record<string, unknown>) => {
          slackRequests.push({ method: 'post', ...input });
          if ('thread_ts' in input) throw { data: { error: 'cannot_reply_to_message' } };
          return { ok: true, channel: destination.conversationId, ts: '1787853828.000100' };
        },
      },
    };

    const outcome = await executeRoutineOccurrence({
      env: {}, store, occurrenceId: run.id, attempt: attempt.attempt,
    }, {
      ...dependencies(),
      resolveAccess: async () => ({
        config: {
          ...config,
          channelId: destination.conversationId,
          agentId: 'agent_direct',
          agent: { ...config.agent, id: 'agent_direct', name: 'Direct Agent' },
        },
        accessHash: 'a'.repeat(64),
        botToken: 'xoxb-test',
        botUserId: 'UBOT',
        actorSlackUserId: 'U_DIRECT',
        actorMembershipId: destination.ownerMembershipId,
        authorityReceiptId: 'receipt_direct',
        client: client as never,
      }),
      handle: fakeHandle({ reply: successfulReply() }),
      productTelemetry: { capture: (event: ProductTelemetryEventInput) => productEvents.push(event) },
    });

    assert.equal(outcome, 'completed');
    const failed = await store.getRun(run.id);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.failureClass, 'direct_thread_unavailable');
    // Files from a private schedule follow the saved originating thread.
    assert.equal(
      parseRoutineExecutionInitialData(failed?.flueAgentEnvelope?.initialData)
        .runtimePlan.artifactDestination.threadTs,
      destination.threadTs,
    );
    const legacyDirect = JSON.parse(JSON.stringify(failed!.flueAgentEnvelope!.initialData));
    delete legacyDirect.runtimePlan.artifactDestination.threadTs;
    const directEnvelope = failed!.flueAgentEnvelope!;
    assert.equal(directEnvelope.schemaVersion, 2);
    if (directEnvelope.schemaVersion !== 2) throw new Error('expected schedule signal');
    assert.equal(routineArtifactPlan(
      parseRoutineExecutionInitialData(legacyDirect).runtimePlan, directEnvelope.message,
    )?.artifactDestination.threadTs, destination.threadTs);
    assert.equal((await store.getRoutine(routine.id))?.state, 'paused');
    assert.equal((await store.getRoutine(routine.id))?.pausedReason, 'direct_thread_unavailable');
    assert.equal((await store.getRecoveryDelivery(run.id))?.status, 'accepted');
    assert.equal(slackRequests.length, 3);
    assert.equal(slackRequests[0]?.thread_ts, destination.threadTs);
    assert.deepEqual(slackRequests[1], { method: 'open', users: 'U_DIRECT' });
    assert.equal(slackRequests[2]?.thread_ts, undefined);
    assert.equal(slackRequests[2]?.username, 'Chickpea');
    assert.deepEqual(productEvents, [{
      event: 'run_completed',
      workspaceId: 'T_TEST',
      agentId: 'agent_direct',
      triggerKind: 'scheduled',
      outcome: 'failed',
    }]);
  } finally {
    configStore.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reattachment never combines a frozen Agent A envelope with current Agent B access', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    const fixture = await admittedFixture(store, 'reattach_agent_fence');
    const first = await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, {
      ...dependencies(),
      handle: fakeHandle({ readError: new DOMException('reader stopped', 'AbortError') }),
    });
    assert.equal(first, 'resumable');
    const frozen = (await store.getRun(fixture.run.id))?.flueAgentEnvelope;
    assert.equal(
      parseRoutineExecutionInitialData(frozen?.initialData).runtimePlan.agentId,
      'agent_default',
    );

    const events: string[] = [];
    const second = await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, {
      ...dependencies(events),
      resolveAccess: async (_run, routine) => {
        events.push('live-access-b');
        return {
          config: {
            ...config,
            workspaceId: routine.workspaceId,
            channelId: routine.channelId,
            agentId: 'agent_b',
            agent: { ...config.agent, id: 'agent_b', name: 'Agent B' },
          },
          accessHash: 'b'.repeat(64),
          botToken: 'xoxb-test',
          botUserId: 'UBOT',
          client: offlineSlackClient,
        };
      },
      resolveModel: async () => {
        events.push('model-b');
        return { model: config.model };
      },
      preparePrompt: async () => {
        events.push('prompt-b');
        throw new Error('must not prepare Agent B context for Agent A reattachment');
      },
      handle: fakeHandle({ events }),
    });

    assert.equal(second, 'completed');
    assert.deepEqual(events, ['live-access-b', 'live-access-b']);
    const failed = await store.getRun(fixture.run.id);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.failureClass, 'access_denied');
    assert.equal(failed?.resolvedAgentId, 'agent_default');
    assert.deepEqual(failed?.flueAgentEnvelope, frozen);
  } finally {
    store.close();
  }
});

test('a preparation failure posts one notice when fresh access can still reach the destination', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  const posts: Array<Record<string, unknown>> = [];
  const recordedTerminalError = 'The recorded terminal failure won the race.';
  let wonTerminalRace = false;
  try {
    const fixture = await admittedFixture(store, 'reattach_failure_notice');
    const first = await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, {
      ...dependencies(),
      handle: fakeHandle({ readError: new DOMException('reader stopped', 'AbortError') }),
    });
    assert.equal(first, 'resumable');

    const client = {
      chat: {
        postMessage: async (input: Record<string, unknown>) => {
          posts.push(input);
          return { ok: true, channel: 'C_TEST', ts: '1785153600.000003' };
        },
      },
    };
    const competingStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property === 'transitionRun') {
          return async (input: Parameters<RoutineStore['transitionRun']>[0]) => {
            if (input.to === 'failed' && !wonTerminalRace) {
              wonTerminalRace = true;
              await target.transitionRun({
                ...input,
                failureClass: 'policy_denied',
                publicError: recordedTerminalError,
              });
            }
            return target.transitionRun(input);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as RoutineStore;
    const second = await executeRoutineOccurrence({
      env: {}, store: competingStore, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, {
      ...dependencies(),
      resolveAccess: async (_run, routine) => ({
        config: {
          ...config,
          workspaceId: routine.workspaceId,
          channelId: routine.channelId,
          agentId: 'agent_b',
          agent: { ...config.agent, id: 'agent_b', name: 'Agent B' },
        },
        accessHash: 'b'.repeat(64),
        botToken: 'xoxb-test',
        botUserId: 'UBOT',
        client: client as never,
      }),
      handle: fakeHandle({}),
    });

    assert.equal(second, 'completed');
    const failed = await store.getRun(fixture.run.id);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.failureClass, 'policy_denied');
    assert.equal(failed?.publicError, recordedTerminalError);
    assert.equal(failed?.deliveryStatus, 'delivered');
    assert.equal(wonTerminalRace, true);
    assert.equal(posts.length, 1);
    assert.match(String(posts[0]?.text), /Routine needs attention/);
    assert.match(String(posts[0]?.text), /The recorded terminal failure won the race/);
    assert.doesNotMatch(String(posts[0]?.text), /Channel access changed while the routine was running/);
    assert.doesNotMatch(String(posts[0]?.text), /Inspect current state/);
    assert.equal(await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, { ...dependencies(), handle: fakeHandle({}) }), 'superseded');
    assert.equal(posts.length, 1);
  } finally {
    store.close();
  }
});

test('a preparation failure stays silent when fresh destination authorization fails', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  let accessChecks = 0;
  let posts = 0;
  try {
    const fixture = await admittedFixture(store, 'reattach_failure_unauthorized');
    assert.equal(await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, {
      ...dependencies(),
      handle: fakeHandle({ readError: new DOMException('reader stopped', 'AbortError') }),
    }), 'resumable');

    assert.equal(await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, {
      ...dependencies(),
      resolveAccess: async (_run, routine) => {
        accessChecks += 1;
        if (accessChecks === 2) {
          throw new RoutineRuntimeError('access_denied', 'Current channel access could not be verified.');
        }
        return {
          config: {
            ...config,
            workspaceId: routine.workspaceId,
            channelId: routine.channelId,
            agentId: 'agent_b',
            agent: { ...config.agent, id: 'agent_b', name: 'Agent B' },
          },
          accessHash: 'b'.repeat(64),
          botToken: 'xoxb-test',
          botUserId: 'UBOT',
          client: {
            chat: { postMessage: async () => {
              posts += 1;
              return { ok: true, channel: 'C_TEST', ts: '1785153600.000004' };
            } },
          } as never,
        };
      },
      handle: fakeHandle({}),
    }), 'completed');

    const failed = await store.getRun(fixture.run.id);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.failureClass, 'access_denied');
    assert.equal(failed?.deliveryStatus, 'none');
    assert.equal(accessChecks, 2);
    assert.equal(posts, 0);
  } finally {
    store.close();
  }
});

test('an ambiguous dispatch freezes the coding workspace once', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  const events: string[] = [];
  let capabilityChecks = 0;
  const sandboxDependencies = {
    ...dependencies(events),
    sandboxInstalled: () => true,
    codingWorkspaceConfigured: async () => {
      capabilityChecks += 1;
      return capabilityChecks === 1;
    },
  };
  try {
    const fixture = await admittedFixture(store, 'dispatch_retry');
    const first = await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, {
      ...sandboxDependencies,
      handle: fakeHandle({ events, dispatchError: new Error('connection ended after dispatch') }),
    });
    assert.equal(first, 'resumable');
    const frozen = (await store.getRun(fixture.run.id))?.flueAgentEnvelope;
    const plan = parseRoutineExecutionInitialData(frozen?.initialData).runtimePlan;
    assert.equal(plan.sandbox.mode, 'bash');
    assert.equal(plan.codingWorkspace?.available, true);

    const second = await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, { ...sandboxDependencies, handle: fakeHandle({ events }) });
    assert.equal(second, 'completed');
    assert.equal(capabilityChecks, 1);
    assert.deepEqual((await store.getRun(fixture.run.id))?.flueAgentEnvelope, frozen);
    assert.equal(
      (await store.listAdmissions(fixture.run.id))[0]?.flueAgentReceipt?.submissionId,
      'submission_test',
    );
  } finally {
    store.close();
  }
});

test('an unconfigured coding workspace freezes no workspace capability', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    const fixture = await admittedFixture(store, 'workspace_unconfigured');
    const outcome = await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, {
      ...dependencies(),
      sandboxInstalled: () => true,
      codingWorkspaceConfigured: async () => false,
      handle: fakeHandle({}),
    });
    assert.equal(outcome, 'completed');
    const plan = parseRoutineExecutionInitialData(
      (await store.getRun(fixture.run.id))?.flueAgentEnvelope?.initialData,
    ).runtimePlan;
    assert.equal(plan.sandbox.mode, 'bash');
    assert.equal(plan.codingWorkspace, undefined);
  } finally {
    store.close();
  }
});

test('an admitted routine with a pre-dispatch cloud plan narrows when the binding disappeared', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    const fixture = await admittedFixture(store, 'binding_removed');
    const first = await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, {
      ...dependencies(),
      sandboxInstalled: () => false,
      codingWorkspaceConfigured: async () => true,
      handle: fakeHandle({}),
    });

    assert.equal(first, 'completed');
    const completed = await store.getRun(fixture.run.id);
    assert.equal(completed?.status, 'no_op');
    const plan = parseRoutineExecutionInitialData(completed?.flueAgentEnvelope?.initialData).runtimePlan;
    assert.equal(plan.sandbox.mode, 'bash');
    assert.equal(plan.codingWorkspace, undefined);
  } finally {
    store.close();
  }
});

test('a persisted workspace plan survives a missing binding on resume', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    const fixture = await admittedFixture(store, 'persisted_binding_removed');
    const first = await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, {
      ...dependencies(),
      sandboxInstalled: () => true,
      codingWorkspaceConfigured: async () => true,
      handle: fakeHandle({ dispatchError: new Error('dispatch interrupted') }),
    });
    assert.equal(first, 'resumable');
    const persisted = (await store.getRun(fixture.run.id))?.flueAgentEnvelope;
    assert.equal(
      parseRoutineExecutionInitialData(persisted?.initialData).runtimePlan.codingWorkspace?.available,
      true,
    );

    const resumed = await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, {
      ...dependencies(),
      sandboxInstalled: () => false,
      codingWorkspaceConfigured: async () => { throw new Error('must preserve stored plan'); },
      handle: fakeHandle({}),
    });

    assert.equal(resumed, 'completed');
    const completed = await store.getRun(fixture.run.id);
    assert.equal(completed?.status, 'no_op');
    assert.deepEqual(completed?.flueAgentEnvelope, persisted);
  } finally {
    store.close();
  }
});

test('a routine occurrence admitted by v0.1.26 with an attached container resumes on the workspace tools', async () => {
  // Skip-upgrade: v0.1.26 froze this occurrence's plan with an attached
  // container, and the install updated past the release that still ran it.
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-legacy-routine-'));
  const path = join(dir, 'state.db');
  const store = new SqliteRoutineStore(path, () => NOW);
  const db = openStateDb(path);
  try {
    const fixture = await admittedFixture(store, 'legacy_attached');
    const first = await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, { ...dependencies(), handle: fakeHandle({ dispatchError: new Error('dispatch interrupted') }) });
    assert.equal(first, 'resumable');
    const persisted = (await store.getRun(fixture.run.id))!.flueAgentEnvelope!;
    const current = parseRoutineExecutionInitialData(persisted.initialData);
    const legacyData = { ...current, runtimePlan: attachedContainerPlan(current.runtimePlan) };
    const legacyEnvelope = { ...persisted, initialData: legacyData };
    db.run(
      'UPDATE routine_runs SET flue_agent_envelope_json = ? WHERE id = ?',
      JSON.stringify(legacyEnvelope),
      fixture.run.id,
    );
    // The routine agent's creation-data contract still admits the stored plan.
    assert.equal(v.safeParse(ChickpeaRoutineExecution.initialData!, legacyData).success, true);

    const dispatches: unknown[] = [];
    const resumed = await executeRoutineOccurrence({
      env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, { ...dependencies(), handle: fakeHandle({ dispatches }) });

    assert.equal(resumed, 'completed');
    assert.equal((await store.getRun(fixture.run.id))?.status, 'no_op');
    // Flue counts creation data in the submission's identity: the retry
    // resends exactly what was admitted, never an upgraded copy.
    assert.deepEqual((dispatches[0] as { initialData: unknown }).initialData, legacyData);
    // Everything that reads the plan sees the virtual sandbox and a workspace.
    const plan = parseRoutineExecutionInitialData(legacyData).runtimePlan;
    assert.deepEqual(plan.sandbox, { mode: 'bash' });
    assert.deepEqual(plan.codingWorkspace, { available: true });
  } finally {
    db.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing, multiple, and free-form JSON results fail as result_invalid without delivery', async () => {
  for (const [suffix, data] of [
    ['missing', {}],
    ['multiple', { [ROUTINE_RESULT_DATA_NAME]: [
      { outcome: 'no_op', message: '' },
      { outcome: 'no_op', message: '' },
    ] }],
  ] as Array<[string, Record<string, unknown[]>]>) {
    const store = new SqliteRoutineStore(':memory:', () => NOW);
    try {
      const fixture = await admittedFixture(store, suffix);
      await executeRoutineOccurrence({
        env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
      }, {
        ...dependencies(),
        handle: fakeHandle({
          reply: {
            submissionId: 'submission_test',
            text: '{"outcome":"succeeded","message":"ignore me"}',
            data,
          },
        }),
      });
      const failed = await store.getRun(fixture.run.id);
      assert.equal(failed?.status, 'failed');
      assert.equal(failed?.failureClass, 'result_invalid');
      assert.notEqual(failed?.deliveryStatus, 'delivered');
    } finally {
      store.close();
    }
  }
});

test('the occurrence attempt id is stable, opaque, and unique per attempt', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    const fixture = await admittedFixture(store, 'identity');
    assert.match(fixture.attempt.attemptId, /^routineattempt_/);
    assert.equal(
      fixture.attempt.attemptId,
      (await store.listAdmissions(fixture.run.id))[0]?.attemptId,
    );
    assert.notEqual(hashRoutineValue(fixture.run.id), fixture.attempt.attemptId);
  } finally {
    store.close();
  }
});

test('routine Usage repairs failed admission and terminal persistence before completion', async () => {
  const routines = new SqliteRoutineStore(':memory:', () => NOW);
  const usage = new SqliteUsageStore(':memory:');
  let admissionCalls = 0;
  let terminalCalls = 0;
  const repairingUsage = new Proxy(usage, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      const bound = value.bind(target);
      if (property === 'admitOperation') {
        return async (...args: unknown[]) => {
          if (++admissionCalls === 1) throw new Error('temporary admission outage');
          return bound(...args);
        };
      }
      if (property === 'recordTerminal') {
        return async (...args: unknown[]) => {
          if (++terminalCalls === 1) throw new Error('temporary terminal outage');
          return bound(...args);
        };
      }
      return bound;
    },
  }) as UsageStore;
  const telemetry = telemetrySink();
  try {
    const fixture = await admittedFixture(routines, 'usage_repair');
    assert.equal(await executeRoutineOccurrence({
      env: {}, store: routines, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, {
      ...dependencies(),
      usageRecordingEnabled: true,
      usageStore: repairingUsage,
      persistenceTelemetrySink: telemetry.sink,
      handle: fakeHandle({}),
    }), 'completed');

    assert.equal((await usage.getOperation(fixture.run.id))?.operation.status, 'completed');
    assert.equal(admissionCalls, 2);
    assert.equal(terminalCalls, 2);
    assert.equal(telemetry.info.length, 1);
    assert.equal(telemetry.errors.length, 0);
    assert.match(telemetry.info[0]!, /"phase":"repair","outcome":"repaired"/);
  } finally {
    usage.close();
    routines.close();
  }
});

test('routine deadline bounds a stalled durable Usage owner before dispatch', { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  const routines = new SqliteRoutineStore(':memory:', () => NOW);
  const telemetry = telemetrySink();
  const events: string[] = [];
  const deadlineAt = Date.now() + 50;
  let enteredUsage!: () => void;
  const usageEntered = new Promise<void>((resolve) => { enteredUsage = resolve; });
  const stalledUsage = {
    admitOperation: async () => {
      enteredUsage();
      return new Promise<never>(() => undefined);
    },
  } as unknown as UsageStore;
  let notices = 0;
  try {
    const fixture = await admittedFixture(
      routines,
      'usage_deadline',
      undefined,
      undefined,
      deadlineAt,
    );
    const startedAt = Date.now();
    const base = dependencies(events);
    const execution = executeRoutineOccurrence({
      env: {}, store: routines, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, {
      ...base,
      now: Date.now,
      usageRecordingEnabled: true,
      usageStore: stalledUsage,
      persistenceTelemetrySink: telemetry.sink,
      resolveAccess: async (...args: Parameters<typeof base.resolveAccess>) => ({
        ...await base.resolveAccess(...args),
        client: {
          chat: { postMessage: async () => {
            notices += 1;
            return { ok: true, channel: 'C_TEST', ts: '1785153600.000005' };
          } },
        } as never,
      }),
      handle: fakeHandle({ events }),
    });
    await usageEntered;
    t.mock.timers.tick(50);
    assert.equal(await execution, 'completed');

    assert.equal(Date.now() - startedAt, 50);
    assert.equal(events.filter((event) => event === 'dispatch').length, 0);
    assert.equal(notices, 1);
    assert.equal(telemetry.errors.length, 1);
    assert.match(telemetry.errors[0]!, /"usage":"unrepaired"/);
    assert.doesNotMatch(telemetry.errors[0]!, /usage_deadline|C_TEST/);
  } finally {
    routines.close();
  }
});

test('routine Usage and Work settle with the same canonical execution correlation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-routine-correlation-'));
  const path = join(directory, 'state.sqlite');
  const configuration = new SqliteConfigStore(path, { agents: [createDemoStarterAgent()] });
  const routines = new SqliteRoutineStore(path, () => NOW);
  const usage = new SqliteUsageStore(':memory:');
  const work = new SqliteWorkStore(path, { now: () => NOW });
  const telemetry = telemetrySink();
  try {
    const fixture = await admittedFixture(
      routines,
      'correlation',
      (routine) => linkAgentSchedule(configuration, routine),
      'public',
    );
    assert.ok(fixture.run.canonicalRunId);
    await executeRoutineOccurrence({
      env: {}, store: routines, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, {
      ...dependencies(),
      usageRecordingEnabled: true,
      usageStore: usage,
      workStore: work,
      persistenceTelemetrySink: telemetry.sink,
      handle: fakeHandle({}),
    });

    const operation = await usage.getOperation(fixture.run.id);
    const executionId = operation?.measurements[0]?.runExecutionId;
    assert.equal(operation?.operation.runId, fixture.run.canonicalRunId);
    assert.ok(executionId);
    assert.equal(
      (await work.getRunExecution(executionId as RunExecutionId))?.runId,
      fixture.run.canonicalRunId,
    );
    assert.match(telemetry.info[0]!, /"usage":"recorded","work":"recorded"/);
    assert.deepEqual(telemetry.errors, []);
  } finally {
    work.close();
    usage.close();
    configuration.close();
    routines.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A hosted occurrence whose first attempt stopped short under an admitted
 * installation, its read interrupted once dispatched or its dispatch failed,
 * so its Work execution and Usage operation are open. `refuse` runs it again
 * with the installation refused.
 */
async function interruptedHostedAttempt(t: TestContext, name: string, dispatched: boolean) {
  const directory = mkdtempSync(join(tmpdir(), `chickpea-routine-${name}-`));
  const path = join(directory, 'state.sqlite');
  const configuration = new SqliteConfigStore(path, { agents: [createDemoStarterAgent()] });
  const routines = new SqliteRoutineStore(path, () => NOW);
  const usage = new SqliteUsageStore(':memory:');
  const work = new SqliteWorkStore(path, { now: () => NOW });
  t.after(() => {
    resetInstallationAdmissionForTests();
    work.close();
    usage.close();
    configuration.close();
    routines.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const env = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: `inst_${name}` });
  resetInstallationAdmissionForTests();
  configureInstallationAdmission(async () => 'admitted');
  const fixture = await admittedFixture(
    routines,
    name,
    (routine) => linkAgentSchedule(configuration, routine),
    'public',
  );
  assert.ok(fixture.run.canonicalRunId);
  const runId = fixture.run.canonicalRunId as RunId;
  const input = { env, store: routines, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt };
  const events: string[] = [];
  assert.equal(await executeRoutineOccurrence(input, {
    ...dependencies(), usageRecordingEnabled: true, usageStore: usage, workStore: work,
    persistenceTelemetrySink: telemetrySink().sink,
    handle: fakeHandle(dispatched
      ? { events, readError: new DOMException('restarted', 'AbortError') }
      : { events, dispatchError: new Error('dispatch unavailable') }),
  }), 'resumable');
  assert.equal((await work.listRunExecutions(runId))[0]?.outcome, 'pending');
  assert.equal((await usage.getOperation(fixture.run.id))?.operation.status, 'admitted');

  const telemetry = telemetrySink();
  const handle = fakeHandle({ events });
  handle.abort = async () => { events.push('abort'); };
  return {
    env, path, routines, work, usage, fixture, runId, events, telemetry,
    refuse(overrides: Parameters<typeof executeRoutineOccurrence>[1] = {}) {
      configureInstallationAdmission(async () => 'refused');
      return executeRoutineOccurrence(input, {
        ...dependencies(), usageRecordingEnabled: true, usageStore: usage, workStore: work,
        persistenceTelemetrySink: telemetry.sink, handle, ...overrides,
      });
    },
  };
}

/** How an ended installation fails access: its Slack installation is revoked. */
async function endedInstallationAccess(): Promise<never> {
  throw new RoutineRuntimeError('credential_unavailable', 'The Slack connection is unavailable for this routine.');
}

/** A store whose `method` fails as an unavailable owner would; everything else passes through. */
function failingMethod<T extends object>(store: T, method: keyof T): T {
  return new Proxy(store, {
    get(target, property) {
      if (property === method) return async () => { throw new Error('state owner unavailable'); };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

for (const dispatched of [true, false]) {
  for (const ended of [false, true]) {
    test(`a refused attempt ${dispatched ? 'dispatched' : 'never dispatched'} settles by one rule ${ended ? 'though an ended installation resolves no access' : 'when it is prepared again'}`, async (t) => {
      const h = await interruptedHostedAttempt(
        t,
        `refused_${dispatched ? 'sent' : 'unsent'}_${ended ? 'ended' : 'live'}`,
        dispatched,
      );
      assert.equal(await h.refuse(ended ? {
        resolveAccess: async () => {
          h.events.push('access');
          return endedInstallationAccess();
        },
      } : {}), 'completed');
      if (dispatched) {
        assert.equal(h.events.filter((event) => event === 'abort').length, 1);
        if (ended) assert.deepEqual(h.events.slice(-2), ['abort', 'access'], 'stopped before access is tried');
      } else {
        assert.ok(!h.events.includes('abort'), 'nothing was dispatched to stop');
      }
      assert.equal(h.events.filter((event) => event === 'read').length, dispatched ? 1 : 0);

      const skipped = await h.routines.getRun(h.fixture.run.id);
      assert.equal(skipped?.status, 'skipped');
      assert.equal(skipped?.skipReason, 'installation_not_admitted');
      assert.equal((await h.routines.getRoutine(h.fixture.run.routineId))?.state, 'active', 'nothing is paused');
      assert.equal(await h.routines.getRecoveryDelivery(h.fixture.run.id), undefined);

      // A dispatched attempt may have reached the model, and what it did is
      // never read; one never dispatched submitted nothing. Whether the
      // occurrence could be prepared again changes neither.
      const [execution] = await h.work.listRunExecutions(h.runId);
      assert.deepEqual(
        [execution?.outcome, execution?.modelInvocationStatus, execution?.safeFailureCode],
        dispatched ? ['ambiguous', 'settled', 'policy_denied'] : ['not_submitted', 'not_invoked', 'policy_denied'],
      );
      assert.equal((await h.work.getRun(h.runId))?.terminalDisposition, 'skipped');
      const operation = await h.usage.getOperation(h.fixture.run.id);
      assert.equal(operation?.operation.status, 'failed', 'the Usage operation has its terminal');
      assert.equal(operation?.measurements[0]?.inputTokens, null);
      assert.equal(operation?.measurements[0]?.usageUnknownReason, 'provider_request_unknown');
      assert.equal(operation?.measurements[0]?.runExecutionId, execution?.id);
      assert.match(h.telemetry.info.join('\n'), /"usage":"recorded","work":"recorded"/);
      assert.deepEqual(h.telemetry.errors, []);
    });
  }
}

test('an ended installation\'s settlement that cannot be written is reported, part by part', async (t) => {
  // The Work execution stays open: its settlement is reported unrepaired.
  const work = await interruptedHostedAttempt(t, 'ended_work_down', true);
  assert.equal(await work.refuse({
    resolveAccess: endedInstallationAccess,
    workStore: failingMethod<WorkStore>(work.work, 'settleRunExecution'),
  }), 'completed');
  assert.equal((await work.routines.getRun(work.fixture.run.id))?.status, 'skipped');
  assert.equal((await work.work.listRunExecutions(work.runId))[0]?.outcome, 'pending');
  assert.equal(work.telemetry.errors.length, 1);
  assert.match(work.telemetry.errors[0]!, /"outcome":"unrepaired","usage":"recorded","work":"unrepaired"/);
  assert.doesNotMatch(work.telemetry.errors[0]!, /state owner unavailable/);

  // The Usage operation stays admitted: its terminal is reported unrepaired.
  const usage = await interruptedHostedAttempt(t, 'ended_usage_down', true);
  assert.equal(await usage.refuse({
    resolveAccess: endedInstallationAccess,
    usageStore: failingMethod<UsageStore>(usage.usage, 'recordTerminal'),
  }), 'completed');
  assert.equal((await usage.routines.getRun(usage.fixture.run.id))?.status, 'skipped');
  assert.equal((await usage.usage.getOperation(usage.fixture.run.id))?.operation.status, 'admitted');
  assert.equal(usage.telemetry.errors.length, 1);
  assert.match(usage.telemetry.errors[0]!, /"outcome":"unrepaired","usage":"unrepaired","work":"recorded"/);
});

for (const dispatched of [true, false]) {
  test(`a host's cancellation settles a running occurrence ${dispatched ? 'dispatched' : 'never dispatched'} by the refusal's rule`, async (t) => {
    const h = await interruptedHostedAttempt(t, `cancelled_${dispatched ? 'sent' : 'unsent'}`, dispatched);
    const db = openStateDb(h.path);
    t.after(() => db.close());
    const cancelled = new RoutineStoreLogic(db, () => NOW + 2).cancelPendingWork(NOW + 2, REFUSED_SKIP);
    assert.equal(cancelled.runs, 1);
    assert.deepEqual(cancelled.prepared.map(({ run, admission }) => [run.id, admission.attempt]),
      [[h.fixture.run.id, h.fixture.attempt.attempt]]);
    await settleCancelledOccurrences(cancelled.prepared, h.env, {
      workStore: h.work, usageStore: h.usage, now: () => NOW + 2, persistenceTelemetrySink: h.telemetry.sink,
    });

    const skipped = await h.routines.getRun(h.fixture.run.id);
    assert.deepEqual([skipped?.status, skipped?.failureClass, skipped?.publicError, skipped?.skipReason],
      ['skipped', REFUSED_SKIP.failureClass, REFUSED_SKIP.publicError, REFUSED_SKIP.skipReason]);
    // As a refused attempt settles, whether or not it is prepared again.
    const [execution] = await h.work.listRunExecutions(h.runId);
    assert.deepEqual(
      [execution?.outcome, execution?.modelInvocationStatus, execution?.safeFailureCode],
      dispatched ? ['ambiguous', 'settled', 'policy_denied'] : ['not_submitted', 'not_invoked', 'policy_denied'],
    );
    const workRun = await h.work.getRun(h.runId);
    assert.deepEqual([workRun?.status, workRun?.terminalDisposition, workRun?.safeFailureCode],
      ['settled', 'skipped', REFUSED_SKIP.skipReason]);
    const operation = await h.usage.getOperation(h.fixture.run.id);
    assert.equal(operation?.operation.status, 'failed', 'the Usage operation has its terminal');
    assert.equal(operation?.measurements[0]?.usageUnknownReason, 'provider_request_unknown');
    assert.equal(operation?.measurements[0]?.runExecutionId, execution?.id);
    assert.match(h.telemetry.info.join('\n'), /"usage":"recorded","work":"recorded"/);
    assert.deepEqual(h.telemetry.errors, []);
  });
}

test('a cancelled occurrence\'s settlement that cannot be written is reported, never thrown', async (t) => {
  const h = await interruptedHostedAttempt(t, 'cancelled_work_down', true);
  const db = openStateDb(h.path);
  t.after(() => db.close());
  const cancelled = new RoutineStoreLogic(db, () => NOW + 2).cancelPendingWork(NOW + 2, REFUSED_SKIP);
  await settleCancelledOccurrences(cancelled.prepared, h.env, {
    workStore: failingMethod<WorkStore>(h.work, 'settleRunExecution'), usageStore: h.usage, now: () => NOW + 2,
    persistenceTelemetrySink: h.telemetry.sink,
  });
  assert.equal((await h.routines.getRun(h.fixture.run.id))?.status, 'skipped');
  assert.equal((await h.work.listRunExecutions(h.runId))[0]?.outcome, 'pending');
  assert.equal(h.telemetry.errors.length, 1);
  assert.match(h.telemetry.errors[0]!, /"outcome":"unrepaired","usage":"recorded","work":"unrepaired"/);
  assert.doesNotMatch(h.telemetry.errors[0]!, /state owner unavailable/);
});

test('permanent Work initialization failure is one gap and never redispatches', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-routine-work-gap-'));
  const path = join(directory, 'state.sqlite');
  const configuration = new SqliteConfigStore(path, { agents: [createDemoStarterAgent()] });
  const routines = new SqliteRoutineStore(path, () => NOW);
  const telemetry = telemetrySink();
  const events: string[] = [];
  try {
    const fixture = await admittedFixture(
      routines,
      'work_gap',
      (routine) => linkAgentSchedule(configuration, routine),
      'public',
    );
    const failedWork = {
      getRun: async () => { throw new Error('work state owner unavailable'); },
    } as unknown as WorkStore;
    const executionInput = {
      env: {}, store: routines, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    };
    assert.equal(await executeRoutineOccurrence(executionInput, {
      ...dependencies(), usageRecordingEnabled: false, workStore: failedWork,
      persistenceTelemetrySink: telemetry.sink, handle: fakeHandle({ events }),
    }), 'completed');
    assert.equal(await executeRoutineOccurrence(executionInput, {
      ...dependencies(), usageRecordingEnabled: false, workStore: failedWork,
      persistenceTelemetrySink: telemetry.sink, handle: fakeHandle({ events }),
    }), 'superseded');

    assert.equal(events.filter((event) => event === 'dispatch').length, 1);
    assert.equal(telemetry.info.length, 0);
    assert.equal(telemetry.errors.length, 1);
    assert.match(telemetry.errors[0]!, /"phase":"work","outcome":"unrepaired"/);
    assert.doesNotMatch(telemetry.errors[0]!, /work state owner|routine_work_gap|C_TEST/);
  } finally {
    configuration.close();
    routines.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('routine deadline bounds a stalled durable Work owner before dispatch', { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-routine-work-deadline-'));
  const path = join(directory, 'state.sqlite');
  const configuration = new SqliteConfigStore(path, { agents: [createDemoStarterAgent()] });
  const routines = new SqliteRoutineStore(path, () => NOW);
  const telemetry = telemetrySink();
  const events: string[] = [];
  const deadlineAt = Date.now() + 50;
  try {
    const fixture = await admittedFixture(
      routines,
      'work_deadline',
      (routine) => linkAgentSchedule(configuration, routine),
      'public',
      deadlineAt,
    );
    let enteredWork!: () => void;
    const workEntered = new Promise<void>((resolve) => { enteredWork = resolve; });
    const stalledWork = {
      getRun: async () => {
        enteredWork();
        return new Promise<never>(() => undefined);
      },
    } as unknown as WorkStore;
    const startedAt = Date.now();
    const execution = executeRoutineOccurrence({
      env: {}, store: routines, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    }, {
      ...offlineDependencies(),
      now: Date.now,
      usageRecordingEnabled: false,
      workStore: stalledWork,
      persistenceTelemetrySink: telemetry.sink,
      handle: fakeHandle({ events }),
    });
    await workEntered;
    t.mock.timers.tick(50);
    assert.equal(await execution, 'completed');

    assert.equal(Date.now() - startedAt, 50);
    assert.equal(events.filter((event) => event === 'dispatch').length, 0);
    assert.equal(telemetry.errors.length, 1);
    assert.match(telemetry.errors[0]!, /"phase":"work","outcome":"unrepaired"/);
    assert.doesNotMatch(telemetry.errors[0]!, /work_deadline|C_TEST/);
  } finally {
    configuration.close();
    routines.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Work terminal failure after Slack delivery cannot post or replay twice', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-routine-terminal-gap-'));
  const path = join(directory, 'state.sqlite');
  const configuration = new SqliteConfigStore(path, { agents: [createDemoStarterAgent()] });
  const routines = new SqliteRoutineStore(path, () => NOW);
  const durableWork = new SqliteWorkStore(path, { now: () => NOW });
  const telemetry = telemetrySink();
  const productEvents: unknown[] = [];
  let posts = 0;
  const client = {
    chat: {
      postMessage: async () => {
        posts += 1;
        return { ok: true, channel: 'C_TEST', ts: '1900000000.000001' };
      },
    },
  };
  const failingTerminalWork = new Proxy(durableWork, {
    get(target, property, receiver) {
      if (property === 'finalizeRunDelivery') {
        return async () => { throw new Error('terminal Work persistence unavailable'); };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as WorkStore;
  try {
    const fixture = await admittedFixture(
      routines,
      'terminal_gap',
      (routine) => linkAgentSchedule(configuration, routine),
      'public',
    );
    const access = dependencies().resolveAccess;
    const executionInput = {
      env: {}, store: routines, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    };
    const executionDependencies = {
      ...dependencies(),
      usageRecordingEnabled: false,
      workStore: failingTerminalWork,
      persistenceTelemetrySink: telemetry.sink,
      resolveAccess: async (run: RoutineRun, routine: RoutineDefinition) => ({
        ...(await access(run, routine)),
        client: client as never,
      }),
      handle: fakeHandle({ reply: successfulReply() }),
      productTelemetry: { capture: (event: ProductTelemetryEventInput) => productEvents.push(event) },
    };
    assert.equal(await executeRoutineOccurrence(executionInput, executionDependencies), 'completed');
    assert.equal(await executeRoutineOccurrence(executionInput, executionDependencies), 'superseded');

    assert.equal(posts, 1);
    assert.equal((await routines.getRun(fixture.run.id))?.status, 'succeeded');
    assert.equal((await routines.getRun(fixture.run.id))?.deliveryStatus, 'delivered');
    assert.deepEqual(productEvents, [{
      event: 'run_completed',
      workspaceId: 'T_TEST',
      agentId: 'agent_default',
      triggerKind: 'scheduled',
      outcome: 'succeeded',
    }]);
    assert.equal(telemetry.errors.length, 1);
    assert.match(telemetry.errors[0]!, /"work":"unrepaired"/);
  } finally {
    durableWork.close();
    configuration.close();
    routines.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('permanent Usage terminal failure after Slack delivery cannot post or replay twice', async () => {
  const routines = new SqliteRoutineStore(':memory:', () => NOW);
  const usage = new SqliteUsageStore(':memory:');
  const telemetry = telemetrySink();
  let posts = 0;
  const client = {
    chat: {
      postMessage: async () => {
        posts += 1;
        return { ok: true, channel: 'C_TEST', ts: '1900000000.000002' };
      },
    },
  };
  const failingTerminalUsage = new Proxy(usage, {
    get(target, property, receiver) {
      if (property === 'recordTerminal') {
        return async () => { throw new Error('terminal Usage persistence unavailable'); };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as UsageStore;
  try {
    const fixture = await admittedFixture(routines, 'usage_terminal_gap');
    const access = dependencies().resolveAccess;
    const executionInput = {
      env: {}, store: routines, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt,
    };
    const executionDependencies = {
      ...dependencies(),
      usageRecordingEnabled: true,
      usageStore: failingTerminalUsage,
      persistenceTelemetrySink: telemetry.sink,
      resolveAccess: async (run: RoutineRun, routine: RoutineDefinition) => ({
        ...(await access(run, routine)),
        client: client as never,
      }),
      handle: fakeHandle({ reply: successfulReply() }),
    };
    assert.equal(await executeRoutineOccurrence(executionInput, executionDependencies), 'completed');
    assert.equal(await executeRoutineOccurrence(executionInput, executionDependencies), 'superseded');

    assert.equal(posts, 1);
    assert.equal((await routines.getRun(fixture.run.id))?.status, 'succeeded');
    assert.equal((await routines.getRun(fixture.run.id))?.deliveryStatus, 'delivered');
    assert.equal(telemetry.errors.length, 1);
    assert.match(telemetry.errors[0]!, /"usage":"unrepaired"/);
    assert.doesNotMatch(
      telemetry.errors[0]!,
      /terminal Usage persistence|usage_terminal_gap|C_TEST/,
    );
  } finally {
    usage.close();
    routines.close();
  }
});

test('scheduled envelopes freeze file delivery to the saved destination, never the prompt turn', async () => {
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  try {
    // A channel schedule without a saved thread posts files at the top level,
    // even though its prompt turn carries a thread-shaped due-time stamp.
    const channel = await admittedFixture(store, 'artifact_channel');
    assert.equal(await executeRoutineOccurrence({
      env: {}, store, occurrenceId: channel.run.id, attempt: channel.attempt.attempt,
    }, { ...dependencies(), handle: fakeHandle({}) }), 'completed');
    const channelPlan = parseRoutineExecutionInitialData(
      (await store.getRun(channel.run.id))?.flueAgentEnvelope?.initialData,
    ).runtimePlan;
    assert.equal(channelPlan.conversation.threadTs, '1785100000.000100');
    assert.deepEqual(channelPlan.artifactDestination, {
      kind: 'slack_conversation',
      channelId: 'C_TEST',
    });

    // A channel schedule saved into a real thread attaches there.
    const threaded = await admittedFixture(store, 'artifact_thread', undefined, undefined, undefined, {
      kind: 'channel', channelId: 'C_TEST', threadTs: '1785000000.000900',
    });
    assert.equal(await executeRoutineOccurrence({
      env: {}, store, occurrenceId: threaded.run.id, attempt: threaded.attempt.attempt,
    }, { ...dependencies(), handle: fakeHandle({}) }), 'completed');
    const threadedEnvelope = (await store.getRun(threaded.run.id))?.flueAgentEnvelope;
    const threadedPlan = parseRoutineExecutionInitialData(threadedEnvelope?.initialData).runtimePlan;
    assert.equal(threadedPlan.artifactDestination.threadTs, '1785000000.000900');
    assert.equal(threadedPlan.artifactDestination.channelId, 'C_TEST');

    // An envelope queued before artifact threads were frozen never inherits
    // the conversation stamp, which for schedules can be synthetic.
    const legacy = JSON.parse(JSON.stringify(threadedEnvelope?.initialData)) as {
      runtimePlan: { conversation: { threadTs: string }; artifactDestination: { threadTs?: string } };
    };
    delete legacy.runtimePlan.artifactDestination.threadTs;
    const legacyPlan = parseRoutineExecutionInitialData(legacy).runtimePlan;
    assert.equal(legacyPlan.conversation.threadTs, '1785100000.000100');
    assert.equal(legacyPlan.artifactDestination.threadTs, undefined);
    assert.equal(threadedEnvelope?.schemaVersion, 2);
    if (threadedEnvelope?.schemaVersion !== 2) throw new Error('expected schedule signal');
    assert.equal(routineArtifactPlan(legacyPlan, threadedEnvelope.message)?.artifactDestination.threadTs,
      '1785000000.000900');
    assert.equal(routineArtifactPlan(legacyPlan, {
      ...threadedEnvelope.message,
      attributes: { ...threadedEnvelope.message.attributes, threadTs: '' },
    })?.artifactDestination.threadTs, undefined);
    assert.equal(routineArtifactPlan(legacyPlan, { kind: 'user', body: 'old V1 task' }), undefined);
    assert.throws(() => routineArtifactPlan(legacyPlan, {
      ...threadedEnvelope.message,
      attributes: { ...threadedEnvelope.message.attributes, conversationId: 'C_OTHER' },
    }), /does not match/);
    for (const invalid of [
      { destinationKind: 'direct_thread', threadTs: '' },
      { threadTs: 'not-a-timestamp' },
      { destinationKind: 'unknown' },
    ]) {
      assert.throws(() => routineArtifactPlan(legacyPlan, {
        ...threadedEnvelope.message,
        attributes: { ...threadedEnvelope.message.attributes, ...invalid },
      }), /does not match/);
    }
  } finally {
    store.close();
  }
});

test('a routine with a coding workspace freezes the coding model its role resolves', async () => {
  const roleReader = (modelId?: string) => ({
    async getWorkspaceModelRole(workspaceId: string, role: NonChatModelRole) {
      return role === 'coding' && modelId
        ? { workspaceId, role, modelId, revision: 1, createdAt: NOW, updatedAt: NOW }
        : undefined;
    },
    async getAgentModelRole() {
      return undefined;
    },
  });
  const freeze = async (suffix: string, options: { cloudflare: boolean; modelId?: string }) => {
    const store = new SqliteRoutineStore(':memory:', () => NOW);
    try {
      const fixture = await admittedFixture(store, suffix);
      await executeRoutineOccurrence(
        { env: {}, store, occurrenceId: fixture.run.id, attempt: fixture.attempt.attempt },
        {
          ...dependencies([]),
          handle: fakeHandle({}),
          modelRoleReader: roleReader(options.modelId),
          sandboxInstalled: () => true,
          codingWorkspaceConfigured: async () => options.cloudflare,
          resolveModel: async (_agentId: string, model: string) => ({ model: `route:${model}` }),
        },
      );
      const envelope = (await store.getRun(fixture.run.id))?.flueAgentEnvelope;
      return parseRoutineExecutionInitialData(envelope?.initialData).runtimePlan;
    } finally { store.close(); }
  };

  const bash = await freeze('coding_bash', { cloudflare: false, modelId: 'openai/gpt-5.6-sol' });
  assert.equal(bash.codingWorkspace, undefined);

  const unset = await freeze('coding_unset', { cloudflare: true });
  assert.deepEqual(unset.codingWorkspace, {
    available: true,
    codingModel: {
      model: config.model,
      runtimeModel: `route:${config.model}`,
      attribution: { role: 'coding', source: 'agent_model', providerId: 'anthropic', fallback: false },
    },
  });

  const set = await freeze('coding_set', { cloudflare: true, modelId: 'openai/gpt-5.6-sol' });
  assert.deepEqual(set.codingWorkspace?.codingModel, {
    model: 'openai/gpt-5.6-sol',
    runtimeModel: 'route:openai/gpt-5.6-sol',
    attribution: { role: 'coding', source: 'workspace_default', providerId: 'openai', fallback: false },
  });
  assert.notEqual(set.harnessRevision, unset.harnessRevision);
});
