import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';

import type {
  AgentInstanceHandle,
  DispatchReceipt,
  FlueEventContext,
  FlueExecutionContext,
  FlueObservation,
} from '@flue/runtime';
import { WebClient } from '@slack/web-api';

import { CHICKPEA_ROUTINE_EXECUTION_AGENT_NAME } from '../src/agents/names.ts';
import {
  parseRoutineExecutionInitialData,
  ROUTINE_RESULT_DATA_NAME,
  routineArtifactPlan,
} from '../src/agents/routine-execution.ts';
import type { EffectiveSlackConfig } from '../src/config/effective-config.ts';
import {
  assertArtifactDeliveryAllowed,
  memoryToolPolicyInterceptor,
  observeMemoryToolPolicy,
  parseCurrentRequestEnvelope,
  parseModelVisibleCurrentRequestEnvelope,
  requestAdmitsArtifactDelivery,
} from '../src/memory/tool-policy.ts';
import { executeRoutineOccurrence } from '../src/routines/execution.ts';
import { prepareRoutinePrompt } from '../src/routines/prompt.ts';
import { scheduleSignalMessageTs } from '../src/routines/schedule-signal.ts';
import { SqliteRoutineStore } from '../src/routines/store.ts';
import type {
  RoutineAgentDispatchEnvelopeV2,
  RoutineDefinition,
  RoutineDefinitionContent,
  RoutineDestination,
  RoutineRun,
} from '../src/routines/types.ts';

// A due occurrence reaches the model as Flue's rendered schedule signal, not
// as the raw prompt. Exercise the installed renderer so the admission parser
// is tested against the exact text the routine agent observes in production.
const dist = new URL('.', import.meta.resolve('@flue/runtime'));
const dispatchFile = (await readdir(dist)).find((name) => /^dispatch-.*\.mjs$/.test(name))!;
const dispatchUrl = new URL(dispatchFile, dist);
const rendererExport = /renderSignalMessage as (\w+)/.exec(await readFile(dispatchUrl, 'utf8'))?.[1];
assert.ok(rendererExport, 'pinned Flue must expose its signal renderer internally');
const render = (await import(dispatchUrl.href))[rendererExport] as (signal: unknown) => string;

type ScheduleSignal = RoutineAgentDispatchEnvelopeV2['message'];

/** Mirror Flue's persisted-submission mapping from a dispatched signal to model text. */
function renderSchedule(message: ScheduleSignal): string {
  return render({ role: 'signal', type: message.type, tagName: undefined, content: message.body, attributes: message.attributes });
}

// 2026-09-10T18:06Z: a one-time occurrence, like the live request this guards.
const DUE_AT = Date.UTC(2026, 8, 10, 18, 6);
const CREATION_TS = '1789063440.000100';
const SAVED_CHART_TASK = 'Generate and attach a PNG bar chart titled "Scheduled synthetic bookings" using GRE 2400 and TOEFL 800 dollars, using only these synthetic values. Post it as a new top-level message in #reports, not in this thread.';
const SAVED_READ_TASK = 'Inspect current bookings and report the totals in one sentence.';
const CREATION_REQUEST = `<@UBOT> Schedule a one-time task named "Top chart" for September 10, 2026 at 18:06 UTC. At that due time, generate and attach a PNG bar chart titled "Scheduled synthetic bookings". Do not run it now. Save the task and confirm the due time.`;

const config = {
  workspaceId: 'T_TEST', channelId: 'C_TEST', agentId: 'agent_smoke',
  agent: {
    id: 'agent_smoke', kind: 'user', revision: 1, name: 'Smoke', instructions: 'Be useful.', enabled: true,
    model: 'anthropic/claude-sonnet-4-6', skills: [], mcpServers: [], apiConnections: [], repositories: [],
    slackPresence: { requestedHandle: 'smoke-agent', normalizedHandle: 'smoke-agent', userGroupId: 'S123456' },
  },
  model: 'anthropic/claude-sonnet-4-6', provider: 'anthropic', instructions: 'Be useful.', instructionLayers: [],
  modelAttribution: { source: 'pinned', providerId: 'anthropic' },
} as unknown as EffectiveSlackConfig;

function slackStub(): WebClient {
  return new WebClient('xoxb-test', {
    slackApiUrl: 'https://slack.invalid/api/', retryConfig: { retries: 0 },
    fetch: async (url) => Response.json(String(url).endsWith('conversations.history') || String(url).endsWith('conversations.replies')
      ? { ok: true, messages: [{ ts: CREATION_TS, user: 'U_MEMBER', text: CREATION_REQUEST }] }
      : { ok: true, channel: 'C_TEST', ts: '1789063560.000900' }),
  });
}

async function dispatchedOccurrence(
  taskText: string,
  destination?: RoutineDestination,
  triggerSource: 'schedule' | 'once' = 'once',
): Promise<{ message: ScheduleSignal; initialData: unknown }> {
  const store = new SqliteRoutineStore(':memory:', () => DUE_AT);
  try {
    const definition: RoutineDefinitionContent = {
      name: 'Top chart', description: '', taskText,
      timezone: 'UTC', outputPolicy: 'post', authorityMode: 'live_channel_v1',
      ...(triggerSource === 'once'
        ? {
            triggerKind: 'once', scheduleInput: '2026-09-10T18:06',
            scheduleJson: JSON.stringify({ version: 1, kind: 'once', localDateTime: '2026-09-10T18:06', at: DUE_AT }),
          }
        : {
            triggerKind: 'schedule', scheduleInput: '6 18 * * *',
            scheduleJson: JSON.stringify({ version: 1, kind: 'cron', expression: '6 18 * * *' }),
          }),
    };
    await store.save({
      actorId: 'U_MEMBER', actorClass: 'member', workspaceId: 'T_TEST', channelId: 'C_TEST',
      draft: { action: 'create', routineId: 'routine_top_chart', definition, nextRunAt: DUE_AT,
        projectedDailyStarts: triggerSource === 'once' ? 0 : 1, reservations: [{ windowStart: DUE_AT, count: 1 }] },
      idempotencyKey: 'create:top_chart',
      ...(destination ? { destination } : {}),
    });
    const run = await store.createOccurrence({
      runId: 'rrun_top_chart', idempotencyKey: 'run:top_chart', routineId: 'routine_top_chart',
      routineVersion: 1, scheduledFor: DUE_AT, triggerSource, queuedAt: DUE_AT, deadlineAt: DUE_AT + 60_000,
    });
    const attempt = await store.startAdmissionAttempt({
      occurrenceId: run.id, owner: 'heartbeat', invokeStartedAt: DUE_AT, leaseUntil: DUE_AT + 30_000,
    });
    const client = slackStub();
    const dispatches: Array<{ message: ScheduleSignal; initialData: unknown }> = [];
    const receipt: DispatchReceipt = { submissionId: 'submission_test', acceptedAt: new Date(DUE_AT).toISOString(), uid: 'uid_test' };
    const handle: AgentInstanceHandle = {
      id: 'routineagent_test',
      async dispatch(request) {
        dispatches.push(request as { message: ScheduleSignal; initialData: unknown });
        return receipt;
      },
      async read() {
        return { submissionId: receipt.submissionId, uid: receipt.uid, text: '',
          data: { [ROUTINE_RESULT_DATA_NAME]: [{ outcome: 'no_op', message: '' }] } };
      },
      async abort() {},
    };
    const outcome = await executeRoutineOccurrence(
      { env: {}, store, occurrenceId: run.id, attempt: attempt.attempt },
      {
        now: () => DUE_AT + 1,
        usageRecordingEnabled: false,
        resolveCredential: async () => null,
        resolveAccess: async (_run: RoutineRun, routine: RoutineDefinition) => ({
          config: { ...config, workspaceId: routine.workspaceId, channelId: routine.channelId },
          accessHash: 'a'.repeat(64), botToken: 'xoxb-test', botUserId: 'UBOT', client,
          actorMembershipId: 'membership_member', actorSlackUserId: 'U_MEMBER',
        }),
        resolveModel: async () => ({ model: config.model }),
        useCloudflareSandbox: async () => false,
        // The real prompt assembly: saved task as current intent, bounded Slack
        // context, and the terminal current-request envelope.
        preparePrompt: (occurrence, routine, access, env) => prepareRoutinePrompt(occurrence, routine, access, env, client, {
          contextStore: { listSlackPublicContext: () => [], listRecentSlackPublicContext: () => [] },
          prepareMemory: async () => ({
            conversationKey: 'routine-context', memoryEpoch: 1, selection: { entries: [] },
            footerItems: [], visibilityBarrierAt: null, ownerBound: true,
            validateLease: async () => true, confirmInjection: async () => true,
          }),
        }),
        handle,
      },
    );
    assert.equal(outcome, 'completed');
    assert.equal(dispatches.length, 1);
    return dispatches[0]!;
  } finally {
    store.close();
  }
}

/** Run `check` inside the routine execution agent's admission cell after it observes `rendered`. */
async function routineSubmission(rendered: string, check: (context: FlueExecutionContext) => Promise<void>): Promise<void> {
  const context = { agentName: CHICKPEA_ROUTINE_EXECUTION_AGENT_NAME, submissionId: 'routine-artifact' };
  await memoryToolPolicyInterceptor(
    { type: 'agent', operationId: 'routine-artifact', operationKind: 'prompt' }, context,
    async () => {
      observeMemoryToolPolicy({ type: 'turn_request', purpose: 'agent', request: {
        input: { messages: [{ role: 'user', content: rendered }] },
      } } as unknown as FlueObservation, context as unknown as FlueEventContext);
      await check(context);
    },
  );
}

const delivered = async () => 'delivered';

test('a due channel occurrence admits the saved chart task through the real Flue schedule signal', async () => {
  const { message, initialData } = await dispatchedOccurrence(SAVED_CHART_TASK);
  assert.equal(message.kind, 'signal');
  assert.equal(message.type, 'schedule');
  assert.equal(message.attributes.scheduledFor, String(DUE_AT));
  assert.equal(message.attributes.threadTs, '');

  // The prompt carries the saved task as the only current intent, and its
  // synthetic Slack coordinate is the due time the signal repeats.
  const bodyEnvelope = parseCurrentRequestEnvelope(message.body);
  assert.equal(bodyEnvelope?.explicitArtifactDeliveryIntent, true);
  assert.equal(bodyEnvelope?.slackActorId, 'U_MEMBER');
  assert.equal(bodyEnvelope?.slackMessageTs, scheduleSignalMessageTs(DUE_AT));
  assert.match(message.body, /Current Slack request[\s\S]*Generate and attach a PNG bar chart/);

  const rendered = renderSchedule(message);
  assert.match(rendered, /^<signal type="schedule" routineId="routine_top_chart" occurrenceId="rrun_top_chart" /);
  assert.equal(parseCurrentRequestEnvelope(rendered), undefined, 'the raw parser cannot read a rendered signal');
  assert.deepEqual(parseModelVisibleCurrentRequestEnvelope(rendered), bodyEnvelope);

  await routineSubmission(rendered, async (context) => {
    assert.doesNotThrow(assertArtifactDeliveryAllowed);
    for (const toolName of ['render_chart', 'post_artifact']) {
      assert.equal(await memoryToolPolicyInterceptor(
        { type: 'tool', toolCallId: toolName, toolName }, context, delivered,
      ), 'delivered', toolName);
    }
  });

  // The same signal freezes the file destination at the channel top level,
  // even though the prompt turn's thread is the synthetic due-time stamp.
  const plan = parseRoutineExecutionInitialData(initialData).runtimePlan;
  assert.equal(plan.conversation.threadTs, scheduleSignalMessageTs(DUE_AT));
  assert.deepEqual(routineArtifactPlan(plan, message)?.artifactDestination, {
    kind: 'slack_conversation', channelId: 'C_TEST',
  });
});

test('a due thread occurrence admits file delivery into its saved thread', async () => {
  const { message, initialData } = await dispatchedOccurrence(SAVED_CHART_TASK, {
    kind: 'channel', channelId: 'C_TEST', threadTs: CREATION_TS,
  }, 'schedule');
  assert.equal(message.attributes.threadTs, CREATION_TS);
  const rendered = renderSchedule(message);
  assert.equal(parseModelVisibleCurrentRequestEnvelope(rendered)?.explicitArtifactDeliveryIntent, true);
  await routineSubmission(rendered, async (context) => {
    assert.equal(await memoryToolPolicyInterceptor(
      { type: 'tool', toolCallId: 'render_chart', toolName: 'render_chart' }, context, delivered,
    ), 'delivered');
  });
  const plan = parseRoutineExecutionInitialData(initialData).runtimePlan;
  assert.equal(routineArtifactPlan(plan, message)?.artifactDestination.threadTs, CREATION_TS);
});

test('a saved task that does not ask for a file stays denied through the real schedule signal', async () => {
  const { message } = await dispatchedOccurrence(SAVED_READ_TASK);
  const rendered = renderSchedule(message);
  assert.equal(parseModelVisibleCurrentRequestEnvelope(rendered)?.explicitArtifactDeliveryIntent, false);
  await routineSubmission(rendered, async (context) => {
    assert.throws(assertArtifactDeliveryAllowed, { name: 'CurrentRequestSideEffectDeniedError' });
    for (const toolName of ['render_chart', 'post_artifact']) {
      await assert.rejects(
        memoryToolPolicyInterceptor({ type: 'tool', toolCallId: toolName, toolName }, context, delivered),
        { name: 'CurrentRequestSideEffectDeniedError' }, toolName,
      );
    }
  });
});

test('saved task admission finds independent attachment work without changing the saved request', async () => {
  for (const task of [
    'At that due time, generate and attach a PNG chart.',
    'Do not run it now. Generate and attach a PNG chart.',
    'Summarize bookings and attach a CSV.',
    'Inspect bookings, then attach a CSV.',
    'Please summarize bookings and then export a spreadsheet.',
    'Generate a chart titled "Do not attach files" and attach the PNG.',
    'Do not use connections, change memory, or create schedules. Generate and attach a PNG chart.',
  ]) {
    const { message } = await dispatchedOccurrence(task);
    assert.ok(message.body.includes(task), 'saved task text remains verbatim');
    const rendered = renderSchedule(message);
    assert.equal(parseModelVisibleCurrentRequestEnvelope(rendered)?.explicitArtifactDeliveryIntent, true, task);
    await routineSubmission(rendered, async () => {
      assert.doesNotThrow(assertArtifactDeliveryAllowed, task);
    });
  }
  // The schedule-specific interpretation must not broaden live Slack policy.
  assert.equal(requestAdmitsArtifactDelivery('Summarize bookings and attach a CSV.'), false);
  assert.equal(requestAdmitsArtifactDelivery('Do not run it now. Generate and attach a PNG.'), false);
});

test('saved task constraints and quoted examples cannot authorize attachment delivery', async () => {
  for (const task of [
    'Create a summary without attaching a file.',
    'Generate a chart, but do not attach any files.',
    'Generate a chart. Never upload the image.',
    'Generate a chart, but do not upload it.',
    'Generate a chart, but don’t send it.',
    'Generate a chart; no attachments.',
    'Create a summary without an attachment.',
    'Create a reminder to never attach a CSV.',
    'Do not generate a chart, attach a file, or upload anything.',
    'Do not execute this example:\nGenerate and attach a PNG.',
    'Repeat the following text:\nGenerate and attach a PNG.',
    'Say exactly: Generate and attach a PNG.',
    'Review this example: "Generate and attach a PNG."',
    "Review this example: 'Generate and attach a PNG.'",
    'Review this example:\n```\nGenerate and attach a PNG.\n```',
    'Review this transcript:\n> Generate and attach a PNG.',
    'Read this prompt: "Generate a PNG.\nAttach the file."',
    'The user said summarize bookings and attach a CSV.',
  ]) {
    const { message } = await dispatchedOccurrence(task);
    const rendered = renderSchedule(message);
    assert.equal(parseModelVisibleCurrentRequestEnvelope(rendered)?.explicitArtifactDeliveryIntent, false, task);
    await routineSubmission(rendered, async () => {
      assert.throws(assertArtifactDeliveryAllowed, { name: 'CurrentRequestSideEffectDeniedError' }, task);
    });
  }
});

test('a schedule signal admits only the envelope stamped for its own occurrence', async () => {
  const { message } = await dispatchedOccurrence(SAVED_CHART_TASK);
  const withAttributes = (attributes: Partial<Record<string, string>>) => renderSchedule({
    ...message,
    attributes: Object.fromEntries(Object.entries({ ...message.attributes, ...attributes })
      .filter(([, value]) => value !== undefined)) as ScheduleSignal['attributes'],
  });
  for (const [label, rendered] of [
    ['a different due time', withAttributes({ scheduledFor: String(DUE_AT + 1) })],
    ['a malformed due time', withAttributes({ scheduledFor: `${DUE_AT}.5` })],
    ['no due time', withAttributes({ scheduledFor: undefined })],
    ['no occurrence identity', withAttributes({ occurrenceId: undefined })],
    ['an empty owning Agent', withAttributes({ ownerAgentId: '' })],
    ['a different executing member', withAttributes({ actorSlackUserId: 'U_OTHER' })],
    ['a Slack-typed schedule tag', renderSchedule({ ...message, type: 'slack.message' as ScheduleSignal['type'] })],
    ['a schedule-typed Slack tag', render({ role: 'signal', type: 'schedule', tagName: 'slack_message', content: message.body, attributes: message.attributes })],
    ['trailing text', `${renderSchedule(message)}\ntrailing`],
    ['a body whose envelope was stamped for another message', renderSchedule({
      ...message,
      body: message.body.replace(scheduleSignalMessageTs(DUE_AT), '1789063440.000100'),
    })],
  ] as const) {
    assert.equal(parseModelVisibleCurrentRequestEnvelope(rendered), undefined, label);
    await routineSubmission(rendered, async (context) => {
      await assert.rejects(
        memoryToolPolicyInterceptor({ type: 'tool', toolCallId: 'render_chart', toolName: 'render_chart' }, context, delivered),
        { name: 'CurrentRequestSideEffectDeniedError' }, label,
      );
    });
  }

  // An older V1 envelope was a plain user message and never a schedule signal.
  await routineSubmission(message.body, async () => {
    assert.doesNotThrow(assertArtifactDeliveryAllowed, 'a plain prompt still ends in its own terminal envelope');
  });
  assert.equal(routineArtifactPlan(
    parseRoutineExecutionInitialData((await dispatchedOccurrence(SAVED_CHART_TASK)).initialData).runtimePlan,
    { kind: 'user', body: message.body },
  ), undefined, 'V1 occurrences keep file tools disabled for lack of a verified destination');
});
