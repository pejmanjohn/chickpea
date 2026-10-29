import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import type { AgentInstanceHandle, ConversationStreamChunk, DispatchReceipt } from '@flue/runtime';
import { WebClient } from '@slack/web-api';

import { ROUTINE_RESULT_DATA_NAME } from '../src/agents/routine-execution-data.ts';
import type { EffectiveSlackConfig } from '../src/config/effective-config.ts';
import {
  configureInstallationAdmission,
  resetInstallationAdmissionForTests,
} from '../src/config/installation-admission.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { closeNodeStateStores } from '../src/config/state-backend.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { configureRunReview } from '../src/review/port.ts';
import type { RunReviewRecordV1 } from '../src/review/record.ts';
import { executeRoutineOccurrence } from '../src/routines/execution.ts';
import { routineDestinationBindingDigest } from '../src/routines/ids.ts';
import { prepareRoutinePrompt } from '../src/routines/prompt.ts';
import type { RoutineRuntimeAccess } from '../src/routines/runtime.ts';
import { agentRoutineDeletion, SqliteRoutineStore } from '../src/routines/store.ts';
import type { RoutineDefinition, RoutineDestination, RoutineRun } from '../src/routines/types.ts';

/** A hosted routine occurrence is copied once it settles, unless its Channel is shared. */

type DirectDestination = Extract<RoutineDestination, { kind: 'direct_thread' }>;

const INSTALLATION = 'inst_review_routine';
const ENV = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: INSTALLATION });
const DUE_AT = Date.UTC(2026, 9, 25, 9, 0);
const TASK = 'Post the open incidents for U0ONCALL12.';

const CONFIG = {
  workspaceId: 'T_REVIEW', channelId: 'C_REVIEW', agentId: 'agent_routine',
  agent: {
    id: 'agent_routine', kind: 'user', revision: 1, name: 'Routine', instructions: 'Be useful.', enabled: true,
    model: 'anthropic/claude-sonnet-4-6', skills: [], mcpServers: [], apiConnections: [], repositories: [],
  },
  model: 'anthropic/claude-sonnet-4-6', provider: 'anthropic', instructions: 'Be useful.',
  modelAttribution: { source: 'pinned', providerId: 'anthropic' },
} as unknown as EffectiveSlackConfig;

function state(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-review-routine-'));
  const statePath = join(directory, 'state.sqlite');
  const keys = ['SLACK_STATE_DB_PATH', 'TAG_DB_PATH', 'CHICKPEA_AUTH_DB_PATH'] as const;
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) process.env[key] = statePath;
  closeNodeStateStores();
  resetInstallationAdmissionForTests();
  configureInstallationAdmission(async () => 'admitted');
  t.after(() => {
    configureRunReview(undefined);
    resetInstallationAdmissionForTests();
    closeNodeStateStores();
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    rmSync(directory, { recursive: true, force: true });
  });
  return statePath;
}

function reviewPort(): RunReviewRecordV1[] {
  const records: RunReviewRecordV1[] = [];
  configureRunReview({
    enabled: async () => true,
    setEnabled: async (_id, change) => change.enabled,
    capturing: async () => true,
    record: async (installationId, record) => {
      assert.equal(installationId, INSTALLATION);
      records.push(record);
    },
    privacyUrl: 'https://chickpea.example/privacy',
  });
  return records;
}

/** A direct routine's store shares its database with the config store that holds its Agent's schedule reference. */
async function occurrence(
  access: Partial<RoutineRuntimeAccess> = {},
  direct?: { statePath: string; destination: DirectDestination },
): Promise<void> {
  const store = new SqliteRoutineStore(direct?.statePath ?? ':memory:', () => DUE_AT);
  const channelId = direct?.destination.conversationId ?? 'C_REVIEW';
  try {
    const routine = await store.save({
      actorId: 'U0MEMBER12', actorClass: 'member', workspaceId: 'T_REVIEW', channelId,
      ...(direct ? { destination: direct.destination, sourceVisibility: 'private' as const } : {}),
      draft: {
        action: 'create', routineId: 'routine_review', nextRunAt: DUE_AT, projectedDailyStarts: 0,
        reservations: [{ windowStart: DUE_AT, count: 1 }],
        definition: {
          name: 'Incidents', description: '', taskText: TASK, timezone: 'UTC', outputPolicy: 'post',
          authorityMode: direct ? 'live_direct_member_v1' : 'live_channel_v1',
          triggerKind: 'once', scheduleInput: '2026-10-25T09:00',
          scheduleJson: JSON.stringify({ version: 1, kind: 'once', localDateTime: '2026-10-25T09:00', at: DUE_AT }),
        },
      },
      idempotencyKey: 'create:routine_review',
    });
    if (direct) await activateDirectRoutine(store, routine, direct);
    const run = await store.createOccurrence({
      runId: 'rrun_review', idempotencyKey: 'run:review', routineId: 'routine_review',
      routineVersion: 1, scheduledFor: DUE_AT, triggerSource: 'once', queuedAt: DUE_AT, deadlineAt: DUE_AT + 60_000,
    });
    const attempt = await store.startAdmissionAttempt({
      occurrenceId: run.id, owner: 'heartbeat', invokeStartedAt: DUE_AT, leaseUntil: DUE_AT + 30_000,
    });
    const client = new WebClient('xoxb-test', {
      slackApiUrl: 'https://slack.invalid/api/', retryConfig: { retries: 0 },
      fetch: async (url) => Response.json(/conversations\.(history|replies)$/.test(String(url))
        ? { ok: true, messages: [{ ts: '1792915200.000100', user: 'U0MEMBER12', text: '<@U0BOT1234> Every morning, post incidents.' }] }
        : { ok: true }),
    });
    const receipt: DispatchReceipt = { submissionId: 'sub_routine', acceptedAt: new Date(DUE_AT).toISOString(), uid: 'uid_routine' };
    const handle: AgentInstanceHandle = {
      id: 'routineagent_review',
      dispatch: async () => receipt,
      async read(_receipt, options) {
        let index = 0;
        const emit = (chunk: Record<string, unknown>) => options?.onEvent?.({
          conversationId: 'c', position: { batch: 1, index: index++ }, ...chunk,
        } as ConversationStreamChunk);
        emit({ type: 'message-started', messageId: 'response', submissionId: receipt.submissionId });
        emit({ type: 'tool-input', messageId: 'response', toolCallId: 'call_1', toolName: 'list_incidents', input: {} });
        emit({ type: 'tool-output', toolCallId: 'call_1', output: [] });
        emit({ type: 'message-delta', messageId: 'response', kind: 'text', delta: 'Nothing open.' });
        return {
          submissionId: receipt.submissionId, uid: receipt.uid, text: '',
          data: { [ROUTINE_RESULT_DATA_NAME]: [{ outcome: 'no_op', message: '' }] },
        };
      },
      abort: async () => {},
    };
    const outcome = await executeRoutineOccurrence(
      { env: ENV, store, occurrenceId: run.id, attempt: attempt.attempt },
      {
        now: () => DUE_AT + 1,
        usageRecordingEnabled: false,
        resolveCredential: async () => null,
        resolveAccess: async (_run: RoutineRun, routine: RoutineDefinition) => ({
          config: { ...CONFIG, workspaceId: routine.workspaceId, channelId: routine.channelId },
          accessHash: 'a'.repeat(64), botToken: 'xoxb-test', botUserId: 'U0BOT1234', client,
          actorMembershipId: 'membership_member', actorSlackUserId: 'U0MEMBER12',
          ...access,
        }),
        resolveModel: async () => ({ model: CONFIG.model }),
        codingWorkspaceConfigured: async () => false,
        preparePrompt: (occurrenceRun, routine, routineAccess, env) =>
          prepareRoutinePrompt(occurrenceRun, routine, routineAccess, env, client, {
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
  } finally {
    store.close();
  }
}

test('a settled routine occurrence is copied as a routine run, its task as the trigger', async (t) => {
  state(t);
  const records = reviewPort();
  await occurrence({ channelShared: false });
  assert.equal(records.length, 1);
  const [record] = records as [RunReviewRecordV1];
  assert.equal(record.surface, 'routine');
  assert.equal(record.runId, 'rrun_review');
  assert.equal(record.agentId, 'agent_routine');
  assert.equal(record.outcome, 'no_op');
  assert.equal(record.trigger.author, 'routine');
  assert.match(record.trigger.text, /^Post the open incidents for u_[0-9a-f]{20}\.$/);
  assert.ok(record.context.some((row) => row.role === 'human' && /^u_/.test(row.author) &&
    /^<@u_[0-9a-f]{20}> Every morning/.test(row.text)), JSON.stringify(record.context));
  assert.deepEqual(record.steps, [
    { kind: 'tool', name: 'list_incidents', input: '{}', output: '[]' },
    { kind: 'text', text: 'Nothing open.' },
  ]);
  assert.equal(JSON.stringify(record).includes('U0MEMBER12'), false);
});

test('a routine whose Agent is granted a website login is not copied, though its plan froze no login', async (t) => {
  state(t);
  const records = reviewPort();
  t.mock.method(console, 'warn', () => undefined);
  // No browser key is connected, so the plan freezes no login; the grant still counts.
  const config = {
    ...CONFIG,
    agent: { ...CONFIG.agent, websiteLogins: [{ loginId: `wl_${'c'.repeat(32)}`, level: 'check', enabled: true }] },
  } as EffectiveSlackConfig;
  await occurrence({ channelShared: false, config });
  assert.equal(records.length, 0);
});

async function activateDirectRoutine(
  store: SqliteRoutineStore,
  routine: RoutineDefinition,
  direct: { statePath: string; destination: DirectDestination },
): Promise<void> {
  const { destination } = direct;
  const config = new SqliteConfigStore(direct.statePath, agentRoutineDeletion, { agents: [] });
  try {
    await config.createAgent({
      ...CONFIG.agent, lifecycle: 'active', creatorMembershipId: destination.ownerMembershipId,
      editPolicy: 'creator_and_admins',
    });
    const digest = routineDestinationBindingDigest(routine.id, routine.workspaceId, destination);
    const reference = await config.putAgentScheduleReference({
      boundRoutineVersion: routine.authorityBindingVersion ?? routine.version,
      scheduleId: routine.id, agentId: CONFIG.agentId, workspaceId: routine.workspaceId,
      channelId: destination.conversationId, destinationKind: 'direct_thread',
      destinationBindingDigest: digest, createdByMembershipId: destination.ownerMembershipId,
      runsAsMembershipId: destination.ownerMembershipId,
      authorityReceiptId: 'receipt_review', requiredConnectionAccountIds: [], state: 'active',
    });
    await store.activateDirectRoutine({
      routineId: routine.id, expectedVersion: routine.version,
      expectedReferenceRevision: reference.revision, destinationBindingDigest: digest,
    });
  } finally {
    config.close();
  }
}

test('a direct routine is copied though Slack reports no Channel sharing for it', async (t) => {
  const statePath = state(t);
  const records = reviewPort();
  await occurrence({}, {
    statePath,
    destination: {
      kind: 'direct_thread', conversationId: 'D_REVIEW', threadTs: '1792915200.000100', ownerMembershipId: 'membership_member',
    },
  });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.surface, 'routine');
  assert.equal(records[0]?.outcome, 'no_op');
});

test('a routine in a shared Channel, or one whose sharing Slack did not report, is not copied', async (t) => {
  state(t);
  const records = reviewPort();
  await occurrence({ channelShared: true });
  await occurrence();
  assert.deepEqual(records, []);
});
