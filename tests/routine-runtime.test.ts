import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WebClient } from '@slack/web-api';

import type { EffectiveSlackConfig } from '../src/config/effective-config.ts';
import { NoAssignmentError } from '../src/config/errors.ts';
import {
  resolveRoutineRuntimeAccess,
  RoutineRuntimeError,
} from '../src/routines/runtime.ts';
import type { RoutineDefinition, RoutineRun } from '../src/routines/types.ts';
import { SlackIdentityUnavailableError } from '../src/slack/identity-execution.ts';

const config: EffectiveSlackConfig = {
  workspaceId: 'T_TEST',
  channelId: 'C_TEST',
  agentId: 'agent_default',
  slackIdentityId: 'slack_identity_default',
  agent: {
    id: 'agent_default', name: 'Chickpea', instructions: 'Be useful.', enabled: true,
    model: 'anthropic/claude-sonnet-4-6', skills: [], mcpServers: [], apiConnections: [], repositories: [],
  },
  model: 'anthropic/claude-sonnet-4-6',
  provider: 'anthropic',
  instructions: 'Be useful.\nRuntime guardrail.',
  instructionLayers: [],
};

const routine = {
  id: 'routine_test', workspaceId: 'T_TEST', channelId: 'C_TEST', creatorUserId: 'U_CREATOR',
  name: 'Test', description: '', taskText: 'Do the work.', triggerKind: 'schedule',
  scheduleInput: '0 * * * *', scheduleJson: '{"version":1,"kind":"cron","expression":"0 * * * *"}',
  timezone: 'UTC', outputPolicy: 'post', authorityMode: 'live_channel_v1', state: 'active',
  version: 1, nextRunAt: 1, lastScheduledAt: null, lastFinishedAt: null,
  consecutiveFailures: 0, lastChangeKeyHash: null, projectedDailyStarts: 24,
  reservationWindows: [{ windowStart: 1, count: 1 }], createdAt: 1, createdBy: 'U_CREATOR',
  updatedAt: 1, updatedBy: 'U_CREATOR', pausedAt: null, pausedBy: null, pausedReason: null,
  disabledAt: null, disabledBy: null, disabledReason: null, deletedAt: null, deletedBy: null,
} satisfies RoutineDefinition;

const run = {
  id: 'rrun_test', idempotencyKey: 'slot', routineId: routine.id, routineVersion: 1,
  scheduledFor: 1, triggerSource: 'schedule', requestedBy: null, status: 'admitting',
  failureClass: null, publicError: null, admissionOwner: 'heartbeat', admissionLeaseUntil: 2,
  flueRunId: 'run_test', queuedAt: 1, admittedAt: 1, startedAt: null, finishedAt: null,
  resolvedAccessHash: null, resolvedAgentId: null, model: null, inputTokens: null,
  providerAuthRoute: null,
  outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costEstimate: null,
  costUnit: null, deadlineAt: 9999999999999, sandboxSessionId: null, toolCallCount: 0,
  deliveryStatus: 'none', deliveryLeaseUntil: null, deliveryChannelId: null,
  deliveryMessageTs: null, changeKeyHash: null, baselineChangeKeyHash: null,
  suppressedAsNoOp: false, skipReason: null, missedSlotCount: 0, firstMissedAt: null,
  lastMissedAt: null, traceId: null,
  revision: {
    name: routine.name, description: routine.description, taskText: routine.taskText,
    triggerKind: 'schedule', scheduleInput: routine.scheduleInput, scheduleJson: routine.scheduleJson,
    timezone: 'UTC', outputPolicy: 'post', authorityMode: 'live_channel_v1',
  },
  revisionHash: 'a'.repeat(64),
} satisfies RoutineRun;

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    credentials: async () => ({ botToken: 'xoxb-secret', signingSecret: undefined, botUserId: 'U_BOT' }),
    authTest: async () => ({
      ok: true, error: undefined, teamId: 'T_TEST', teamName: 'Test', botName: 'Chickpea', botUserId: 'U_BOT',
    }),
    conversation: async () => ({
      ok: true, error: undefined, retryAfterMs: undefined,
      channel: { id: 'C_TEST', name: 'test', isPrivate: false, isMember: true },
      facts: {
        id: 'C_TEST', name: 'test', private: false, archived: false, frozen: false,
        shared: false, externallyShared: false, organizationShared: false,
        pendingShared: false, member: true, teamId: 'T_TEST',
      },
    }),
    members: async () => ({
      ok: true, error: undefined, memberIds: ['U_CREATOR', 'U_BOT'],
      nextCursor: undefined, retryAfterMs: undefined,
    }),
    config: async () => config,
    ...overrides,
  };
}

test('runtime access resolves current channel membership and hashes only non-secret policy', async () => {
  const access = await resolveRoutineRuntimeAccess(run, routine, undefined, dependencies());
  assert.equal(access.config.agentId, 'agent_default');
  assert.match(access.accessHash, /^[a-f0-9]{64}$/);
  assert.equal(access.botToken, 'xoxb-secret');
  assert.ok(!access.accessHash.includes('secret'));

  const changed = await resolveRoutineRuntimeAccess(run, routine, undefined, dependencies({
    config: async () => ({ ...config, model: 'openai/gpt-5', provider: 'openai' }),
  }));
  assert.notEqual(changed.accessHash, access.accessHash);
});

test('runtime access resolves the live Agent identity and includes it in the access hash', async () => {
  const identityIds: string[] = [];
  const dedicatedConfig = {
    ...config,
    slackIdentityId: 'slack_identity_finance',
  };
  const access = await resolveRoutineRuntimeAccess(run, routine, undefined, dependencies({
    config: async () => dedicatedConfig,
    identityCredentials: async (identityId: string) => {
      identityIds.push(identityId);
      return {
        botToken: 'xoxb-finance',
        signingSecret: undefined,
        botUserId: 'U_BOT',
        connectionRevision: 'rev-finance',
      };
    },
  }));
  const changed = await resolveRoutineRuntimeAccess(run, routine, undefined, dependencies({
    config: async () => ({ ...dedicatedConfig, slackIdentityId: 'slack_identity_legal' }),
    identityCredentials: async () => ({
      botToken: 'xoxb-legal', signingSecret: undefined, botUserId: 'U_BOT',
      connectionRevision: 'rev-legal',
    }),
  }));

  assert.deepEqual(identityIds, ['slack_identity_finance']);
  assert.equal(access.slackIdentityId, 'slack_identity_finance');
  assert.equal(access.botToken, 'xoxb-finance');
  assert.notEqual(access.accessHash, changed.accessHash);
});

test('production routine access shares the lifecycle-gated identity client', async () => {
  const client = {} as WebClient;
  const access = await resolveRoutineRuntimeAccess(run, routine, undefined, dependencies({
    identityExecution: async (identityId: string) => ({
      identityId,
      botToken: 'xoxb-current-finance',
      botUserId: 'U_BOT',
      teamId: 'T_TEST',
      client,
    }),
  }));
  assert.equal(access.botToken, 'xoxb-current-finance');
  assert.equal(access.client, client);

  await assert.rejects(
    () => resolveRoutineRuntimeAccess(run, routine, undefined, dependencies({
      identityExecution: async () => {
        throw new SlackIdentityUnavailableError('slack_identity_default', 'identity_retired');
      },
    })),
    (error: unknown) => error instanceof RoutineRuntimeError &&
      error.failureClass === 'credential_unavailable',
  );
});

test('runtime access fails closed for creator removal, bot removal, and assignment removal', async () => {
  await assert.rejects(
    () => resolveRoutineRuntimeAccess(run, routine, undefined, dependencies({
      members: async () => ({
        ok: true, error: undefined, memberIds: ['U_BOT'], nextCursor: undefined, retryAfterMs: undefined,
      }),
    })),
    (error: unknown) => error instanceof RoutineRuntimeError && error.failureClass === 'creator_ineligible',
  );
  await assert.rejects(
    () => resolveRoutineRuntimeAccess(run, routine, undefined, dependencies({
      conversation: async () => ({
        ok: true, error: undefined, retryAfterMs: undefined,
        channel: { id: 'C_TEST', name: 'test', isPrivate: false, isMember: false },
        facts: {
          id: 'C_TEST', name: 'test', private: false, archived: false, frozen: false,
          shared: false, externallyShared: false, organizationShared: false,
          pendingShared: false, member: false, teamId: 'T_TEST',
        },
      }),
    })),
    (error: unknown) => error instanceof RoutineRuntimeError && error.failureClass === 'channel_ineligible',
  );
  await assert.rejects(
    () => resolveRoutineRuntimeAccess(run, routine, undefined, dependencies({
      config: async () => { throw new NoAssignmentError('gone'); },
    })),
    (error: unknown) => error instanceof RoutineRuntimeError && error.failureClass === 'assignment_missing',
  );
});

test('membership pagination failures and missing Slack credentials never fall back', async () => {
  await assert.rejects(
    () => resolveRoutineRuntimeAccess(run, routine, undefined, dependencies({
      members: async () => ({
        ok: false, error: 'timeout', memberIds: [], nextCursor: undefined, retryAfterMs: undefined,
      }),
    })),
    (error: unknown) => error instanceof RoutineRuntimeError && error.failureClass === 'access_denied',
  );
  await assert.rejects(
    () => resolveRoutineRuntimeAccess(run, routine, undefined, dependencies({
      credentials: async () => ({ botToken: undefined, signingSecret: undefined, botUserId: undefined }),
    })),
    (error: unknown) => error instanceof RoutineRuntimeError && error.failureClass === 'credential_unavailable',
  );
});
