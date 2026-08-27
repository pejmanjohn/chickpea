import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WebClient } from '@slack/web-api';

import type { EffectiveSlackConfig } from '../src/config/effective-config.ts';
import { RoutineAuthorityError } from '../src/routines/agent-authority.ts';
import {
  resolveRoutineRuntimeAccess,
  RoutineRuntimeError,
} from '../src/routines/runtime.ts';
import type { RoutineDefinition, RoutineRun } from '../src/routines/types.ts';
import { SlackInstallationUnavailableError } from '../src/slack/installation-execution.ts';

const config: EffectiveSlackConfig = {
  workspaceId: 'T_TEST',
  channelId: 'C_TEST',
  agentId: 'agent_default',
  agent: {
    id: 'agent_default', kind: 'user', revision: 1, name: 'Chickpea', instructions: 'Be useful.', enabled: true,
    model: 'anthropic/claude-sonnet-4-6', skills: [], mcpServers: [], apiConnections: [], repositories: [],
  },
  model: 'anthropic/claude-sonnet-4-6',
  provider: 'anthropic',
  modelAttribution: { source: 'pinned', providerId: 'anthropic' },
  instructions: 'Be useful.\nRuntime guardrail.',
  instructionLayers: [],
};

const routine = {
  id: 'routine_test', workspaceId: 'T_TEST', channelId: 'C_TEST', creatorUserId: 'U_CREATOR',
  destination: { kind: 'channel', channelId: 'C_TEST' },
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
  resolvedAccessHash: null, resolvedAgentId: null, resolvedAuthorityReceiptId: null,
  resolvedRunsAsMembershipId: null, model: null, inputTokens: null,
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
    credentials: async () => ({ botToken: 'xoxb-secret', signingSecret: undefined, botUserId: 'UBOT' }),
    authTest: async () => ({
      ok: true, error: undefined, teamId: 'T_TEST', teamName: 'Test', botName: 'Chickpea', botUserId: 'UBOT',
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
      ok: true, error: undefined, memberIds: ['U_CREATOR', 'UBOT'],
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

test('runtime access resolves the one workspace Slack installation', async () => {
  const workspaceIds: string[] = [];
  const client = {} as WebClient;
  const dedicatedConfig = { ...config };
  const access = await resolveRoutineRuntimeAccess(run, routine, undefined, dependencies({
    config: async () => dedicatedConfig,
    installationExecution: async (workspaceId: string) => {
      workspaceIds.push(workspaceId);
      return {
        workspaceId,
        transportMode: 'direct',
        botToken: 'xoxb-finance',
        botUserId: 'UBOT',
        client,
      };
    },
  }));
  const changed = await resolveRoutineRuntimeAccess(run, routine, undefined, dependencies({
    config: async () => ({ ...dedicatedConfig }),
    installationExecution: async (workspaceId: string) => ({
      workspaceId,
      transportMode: 'direct',
      botToken: 'xoxb-legal', botUserId: 'UBOT', client,
    }),
  }));

  assert.deepEqual(workspaceIds, ['T_TEST']);
  assert.equal(access.botToken, 'xoxb-finance');
  assert.equal(access.accessHash, changed.accessHash);
});

test('production routine access shares the lifecycle-gated installation client', async () => {
  const client = {} as WebClient;
  const access = await resolveRoutineRuntimeAccess(run, routine, undefined, dependencies({
    installationExecution: async (workspaceId: string) => ({
      workspaceId,
      transportMode: 'direct',
      botToken: 'xoxb-current-finance',
      botUserId: 'UBOT',
      client,
    }),
  }));
  assert.equal(access.botToken, 'xoxb-current-finance');
  assert.equal(access.client, client);

  await assert.rejects(
    () => resolveRoutineRuntimeAccess(run, routine, undefined, dependencies({
      installationExecution: async () => {
        throw new SlackInstallationUnavailableError('T_TEST', 'installation_revoked');
      },
    })),
    (error: unknown) => error instanceof RoutineRuntimeError &&
      error.failureClass === 'credential_unavailable',
  );
});

test('shared-gateway routine access needs no local Slack token', async () => {
  const client = {
    conversations: {
      info: async () => ({
        ok: true,
        channel: {
          id: 'C_TEST', name: 'test', team_id: 'T_TEST', is_member: true,
          is_private: false, is_archived: false, is_frozen: false,
          is_shared: false, is_ext_shared: false, is_org_shared: false,
          is_pending_ext_shared: false, is_im: false, is_mpim: false,
        },
      }),
      members: async () => ({
        ok: true,
        members: ['U_CREATOR', 'UBOT'],
        response_metadata: { next_cursor: '' },
      }),
    },
  } as unknown as WebClient;
  const access = await resolveRoutineRuntimeAccess(run, routine, undefined, dependencies({
    installationExecution: async (workspaceId: string) => ({
      workspaceId,
      transportMode: 'gateway',
      botUserId: 'UBOT',
      client,
    }),
  }));
  assert.equal(access.botToken, undefined);
  assert.equal(access.client, client);
  assert.equal(access.botUserId, 'UBOT');
});

test('runtime access fails closed for creator removal, bot removal, and assignment removal', async () => {
  await assert.rejects(
    () => resolveRoutineRuntimeAccess(run, routine, undefined, dependencies({
      members: async () => ({
        ok: true, error: undefined, memberIds: ['UBOT'], nextCursor: undefined, retryAfterMs: undefined,
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
      authority: async () => {
        throw new RoutineAuthorityError('schedule_authority_missing', 'gone');
      },
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

// A routine's body can be rewritten by any channel member (commands.ts gates on
// channel membership alone), but the execution-time eligibility gate only ever
// checked creatorUserId. That let an editor who has since left the channel keep
// a rewritten task running under the original creator's standing eligibility.
// The author of the CURRENT definition must be eligible too.
test('runtime access fails closed when the last editor left the channel', async () => {
  const edited = { ...routine, updatedBy: 'U_EDITOR' } satisfies RoutineDefinition;

  await assert.rejects(
    () => resolveRoutineRuntimeAccess(run, edited, undefined, dependencies({
      // Creator is still present; the editor is not.
      members: async () => ({
        ok: true, error: undefined, memberIds: ['U_BOT', 'U_CREATOR'],
        nextCursor: undefined, retryAfterMs: undefined,
      }),
    })),
    (error: unknown) => error instanceof RoutineRuntimeError &&
      error.failureClass === 'creator_ineligible',
  );

  // Negative control: both present, so the routine still runs.
  const access = await resolveRoutineRuntimeAccess(run, edited, undefined, dependencies({
    members: async () => ({
      ok: true, error: undefined, memberIds: ['U_BOT', 'U_CREATOR', 'U_EDITOR'],
      nextCursor: undefined, retryAfterMs: undefined,
    }),
  }));
  assert.equal(typeof access.accessHash, 'string');
});

test('the editor identity is part of the routine access hash', async () => {
  const members = async () => ({
    ok: true as const, error: undefined, memberIds: ['U_BOT', 'U_CREATOR', 'U_EDITOR'],
    nextCursor: undefined, retryAfterMs: undefined,
  });
  const byCreator = await resolveRoutineRuntimeAccess(
    run, routine, undefined, dependencies({ members }),
  );
  const byEditor = await resolveRoutineRuntimeAccess(
    run,
    { ...routine, updatedBy: 'U_EDITOR' } satisfies RoutineDefinition,
    undefined,
    dependencies({ members }),
  );
  // A change of author is a change of authority and must invalidate any
  // decision cached against the previous hash.
  assert.notEqual(byCreator.accessHash, byEditor.accessHash);
});
