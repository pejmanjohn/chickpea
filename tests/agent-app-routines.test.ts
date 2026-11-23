import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { WebClient } from '@slack/web-api';

import type { ResolvedRoutineAuthority } from '../src/routines/agent-authority.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteConfigStore } from '../src/config/store.ts';
import { deliverRoutineRecoveryNotice, deliverRoutineResult } from '../src/routines/delivery.ts';
import { executeRoutineOccurrence } from '../src/routines/execution.ts';
import { routineDestinationBindingDigest } from '../src/routines/ids.ts';
import {
  resolveRoutineRuntimeAccess,
  RoutineAgentAppUnavailableError,
  RoutineRuntimeError,
  type RoutineRuntimeAccess,
} from '../src/routines/runtime.ts';
import { agentRoutineDeletion, SqliteRoutineStore } from '../src/routines/store.ts';
import type { RoutineDefinition, RoutineDestination, RoutineRun, RoutineStore } from '../src/routines/types.ts';
import type { AgentAppLifecycle, AgentSlackPresence, CustomAgentConfig } from '../src/config/types.ts';
import { type AgentSlackAppsHost, configureAgentSlackApps } from '../src/slack/agent-apps/host.ts';
import type { SlackInstallationExecutionContext, SlackRunSpeaker } from '../src/slack/installation-execution.ts';

const TEAM = 'T_TEST';
const CHICKPEA_BOT = 'UBOT';
const AGENT_BOT = 'UAGENTBOT';
const OWNER = 'U_OWNER';
const CHANNEL = 'C_TEST';
const CHICKPEA_DM = 'D_CHICKPEA';
const AGENT_DM = 'D_AGENT';
const NOW = 1_780_000_000_000;
const HOST: AgentSlackAppsHost = {
  requestUrls: () => ({ events: 'https://cloud.test/e', interactions: 'https://cloud.test/i' }),
  redirectUri: 'https://cloud.test/slack/agent-apps/callback',
  allowUrl: (agentId) => `https://cloud.test/slack/agent-apps/allow/${agentId}`,
};
const LIVE: AgentAppLifecycle = {
  state: 'active', at: NOW, app: { appId: 'A0AGENT1', clientId: '1.client' }, icon: 'agent_avatar',
  botUserId: AGENT_BOT, installedAt: NOW, installedBy: OWNER,
};
const GROUP: AgentSlackPresence = {
  requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active', health: 'healthy',
  avatar: { kind: 'generated', revision: 1, seed: 'support' }, userGroupId: 'SSUPPORT',
};
function appPresence(app: AgentAppLifecycle = LIVE): AgentSlackPresence {
  return {
    kind: 'agent_app', requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active', health: 'healthy',
    avatar: { kind: 'generated', revision: 1, seed: 'support' }, app, released: { userGroupId: 'SSUPPORT' },
  };
}
function agent(presence: AgentSlackPresence): CustomAgentConfig {
  return {
    id: 'agent_support', kind: 'user', revision: 1, name: 'Support', instructions: 'Help.', enabled: true,
    lifecycle: 'active', editPolicy: 'creator_and_admins', configurationGeneration: 1, slackPresence: presence,
    creatorMembershipId: 'membership_owner', model: 'anthropic/claude-sonnet-4-6',
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  };
}

function routineFor(destination: RoutineDestination): RoutineDefinition {
  const direct = destination.kind === 'direct_thread';
  return {
    id: direct ? 'routine_direct' : 'routine_channel', workspaceId: TEAM,
    channelId: direct ? destination.conversationId : destination.channelId, creatorUserId: OWNER, destination,
    name: 'Standup', description: '', taskText: 'Summarize.', triggerKind: 'schedule',
    scheduleInput: '0 * * * *', scheduleJson: '{"version":1,"kind":"cron","expression":"0 * * * *"}',
    timezone: 'UTC', outputPolicy: 'post', authorityMode: direct ? 'live_direct_member_v1' : 'live_channel_v1',
    state: 'active', version: 1, nextRunAt: 1, lastScheduledAt: null, lastFinishedAt: null,
    consecutiveFailures: 0, lastChangeKeyHash: null, projectedDailyStarts: 24,
    reservationWindows: [{ windowStart: 1, count: 1 }], createdAt: 1, createdBy: OWNER,
    updatedAt: 1, updatedBy: OWNER, pausedAt: null, pausedBy: null, pausedReason: null,
    disabledAt: null, disabledBy: null, disabledReason: null, deletedAt: null, deletedBy: null,
  };
}
const channelRoutine = routineFor({ kind: 'channel', channelId: CHANNEL });
const directDestination = (conversationId: string) => ({
  kind: 'direct_thread' as const, conversationId, threadTs: '1787853827.722389', ownerMembershipId: 'membership_owner',
});
function runOf(routine: RoutineDefinition): RoutineRun {
  return {
    id: `rrun_${routine.id}`, idempotencyKey: 'slot', routineId: routine.id, routineVersion: 1,
    scheduledFor: 1, triggerSource: 'schedule', requestedBy: null, status: 'admitting',
    failureClass: null, publicError: null, admissionOwner: 'heartbeat', admissionLeaseUntil: 2,
    flueRunId: null, queuedAt: 1, admittedAt: 1, startedAt: null, finishedAt: null,
    resolvedAccessHash: null, resolvedAgentId: null, resolvedAuthorityReceiptId: null,
    resolvedRunsAsMembershipId: null, model: null, inputTokens: null, providerAuthRoute: null,
    outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costEstimate: null,
    costUnit: null, deadlineAt: 9_999_999_999_999, sandboxSessionId: null, toolCallCount: 0,
    deliveryStatus: 'none', deliveryLeaseUntil: null, deliveryChannelId: null,
    deliveryMessageTs: null, changeKeyHash: null, baselineChangeKeyHash: null,
    suppressedAsNoOp: false, skipReason: null, missedSlotCount: 0, firstMissedAt: null,
    lastMissedAt: null, traceId: null,
    revision: {
      name: routine.name, description: routine.description, taskText: routine.taskText,
      triggerKind: 'schedule', scheduleInput: routine.scheduleInput, scheduleJson: routine.scheduleJson,
      timezone: 'UTC', outputPolicy: 'post', authorityMode: routine.authorityMode,
    },
    revisionHash: 'a'.repeat(64),
  };
}
function authorityFor(routine: RoutineDefinition, presence: AgentSlackPresence): ResolvedRoutineAuthority {
  const direct = routine.destination.kind === 'direct_thread';
  const config = agent(presence);
  return {
    reference: {
      scheduleId: routine.id, agentId: config.id, workspaceId: TEAM, channelId: routine.channelId,
      destinationKind: routine.destination.kind,
      destinationBindingDigest: routine.destination.kind === 'direct_thread'
        ? routineDestinationBindingDigest(routine.id, TEAM, routine.destination)
        : null,
      createdByMembershipId: 'membership_owner', runsAsMembershipId: 'membership_owner',
      authorityReceiptId: 'receipt_owner', requiredConnectionAccountIds: [], state: 'active',
      revision: 1, createdAt: 1, updatedAt: 1,
    },
    agent: config,
    agentGrants: direct ? [] : [{
      workspaceId: TEAM, channelId: CHANNEL, agentId: config.id, status: 'active',
      createdByMembershipId: 'membership_owner', channelLabel: 'standup', channelIsPrivate: false,
      createdAt: 1, updatedAt: 1,
    }] as never,
    assignment: {
      workspaceId: TEAM, channelId: routine.channelId, agentId: config.id, agent: config,
      model: 'anthropic/claude-sonnet-4-6', modelAttribution: { source: 'pinned', providerId: 'anthropic' },
    },
    actorSlackUserId: OWNER,
    effectiveConnections: [],
  };
}

/** One bot's Slack, as Slack answers that bot: it opens only its own DM and reads only Channels it is in. */
function botClient(input: { botUserId: string; dm: string; channels: readonly string[]; calls: string[] }): WebClient {
  const record = (method: string) => input.calls.push(`${input.botUserId}:${method}`);
  return {
    users: {
      info: async ({ user }: { user: string }) => {
        record('users.info');
        return {
          ok: true,
          user: {
            id: user, team_id: TEAM, deleted: false, is_bot: false, is_app_user: false,
            is_restricted: false, is_ultra_restricted: false, is_stranger: false,
          },
        };
      },
    },
    conversations: {
      open: async () => { record('conversations.open'); return { ok: true, channel: { id: input.dm, is_im: true } }; },
      info: async ({ channel }: { channel: string }) => {
        record('conversations.info');
        if (channel === input.dm) return { ok: true, channel: { id: channel, is_im: true, is_member: true } };
        return {
          ok: true,
          channel: {
            id: channel, name: 'standup', team_id: TEAM, is_member: input.channels.includes(channel),
            is_private: false, is_archived: false, is_frozen: false, is_shared: false, is_ext_shared: false,
            is_org_shared: false, is_im: false, is_mpim: false,
          },
        };
      },
      members: async ({ channel }: { channel: string }) => {
        record('conversations.members');
        if (!input.channels.includes(channel)) {
          throw Object.assign(new Error('not_in_channel'), { code: 'slack_webapi_platform_error', data: { ok: false, error: 'not_in_channel' } });
        }
        return { ok: true, members: [OWNER, input.botUserId], response_metadata: { next_cursor: '' } };
      },
    },
  } as unknown as WebClient;
}

interface Slack {
  calls: string[];
  chickpea: SlackInstallationExecutionContext;
  app: SlackInstallationExecutionContext;
  resolver: (workspaceId: string, run?: SlackRunSpeaker) => Promise<SlackInstallationExecutionContext>;
}
function slack(input: { chickpeaChannels?: readonly string[]; appChannels?: readonly string[]; appResolves?: boolean } = {}): Slack {
  const calls: string[] = [];
  const chickpea: SlackInstallationExecutionContext = {
    workspaceId: TEAM, transportMode: 'gateway', sharedAppReads: false, botUserId: CHICKPEA_BOT,
    client: botClient({ botUserId: CHICKPEA_BOT, dm: CHICKPEA_DM, channels: input.chickpeaChannels ?? [CHANNEL], calls }),
  };
  const app: SlackInstallationExecutionContext = {
    workspaceId: TEAM, transportMode: 'gateway', sharedAppReads: false, botUserId: AGENT_BOT,
    client: botClient({ botUserId: AGENT_BOT, dm: AGENT_DM, channels: input.appChannels ?? [], calls }),
  };
  return {
    calls, chickpea, app,
    resolver: async (_workspaceId, run) => {
      if (run?.speaker?.kind !== 'own_bot') return chickpea;
      if (input.appResolves === false) throw new Error('agent_app_unavailable');
      return app;
    },
  };
}

function withHost(t: TestContext): void {
  configureAgentSlackApps(HOST);
  t.after(() => configureAgentSlackApps(undefined));
}

async function access(routine: RoutineDefinition, presence: AgentSlackPresence, slackFake: Slack) {
  return resolveRoutineRuntimeAccess(runOf(routine), routine, undefined, {
    authority: async () => authorityFor(routine, presence),
    installationExecution: slackFake.resolver,
  });
}


const directRoutine = (conversationId: string) => routineFor(directDestination(conversationId));
const appCalls = (slackFake: Slack) => slackFake.calls.filter((call) => call.startsWith(`${AGENT_BOT}:`));

test('every schedule stored before an Agent could speak as its own app keeps its digest and access hash', async (t) => {
  withHost(t);
  const direct = directRoutine(CHICKPEA_DM);
  // Values from Core before this change, for the same stored schedules and the same Slack.
  assert.equal(
    routineDestinationBindingDigest(direct.id, TEAM, directDestination(CHICKPEA_DM)),
    '426442a88349422a994b77f5495c156e8ef89ee77d1dcbd69d07f26c910a49da',
  );
  const channelGroup = await access(channelRoutine, GROUP, slack());
  assert.equal(channelGroup.accessHash, '0ba9bfa9cc874d09ed26ae9b10860af2aeb41d90e3851b29deeca852742a3955');
  const channelApp = await access(channelRoutine, appPresence(), slack({ appChannels: [] }));
  assert.equal(channelApp.accessHash, '148b233f3a4e4380346bf1316eb83a4cb94581e425b4c266f60811c70581e41b');
  assert.equal(
    channelApp.legacyAccessHashForCatalogRevision?.('rev1'),
    '7318f3c3f01b11b3979a77330ca84aecfbce4482aaa5d2fd082998e5036597ed',
  );
  assert.equal(
    (await access(direct, GROUP, slack())).accessHash,
    'aee510f17fbacc826d025aa69674501bd9e90b8a340c0c92513db944bed863a4',
  );
  const directApp = await access(direct, appPresence(), slack());
  assert.equal(directApp.accessHash, 'cb1a62f679ec412fcae99429284ebb574dcb617dd87a168f74ec88fb7096c4ea');
  assert.equal(
    directApp.legacyAccessHashForCatalogRevision?.('rev1'),
    '34e45d9ac0ddb05eabb32c4fa9317685dbaaf37c901d56af46e2e3c8cf556832',
  );
});

test('a Channel schedule of an Agent with a live app runs as its bot where that bot is in the Channel', async (t) => {
  withHost(t);
  const inChannel = slack({ appChannels: [CHANNEL] });
  const own = await access(channelRoutine, appPresence(), inChannel);
  assert.equal(own.botUserId, AGENT_BOT);
  assert.equal(own.client, inChannel.app.client);
  assert.deepEqual(own.speaker, { kind: 'own_bot', botUserId: AGENT_BOT });
  assert.ok(!inChannel.calls.some((call) => call.startsWith(`${CHICKPEA_BOT}:`)), 'Chickpea\'s bot is not asked');

  const notInChannel = slack({ appChannels: [] });
  const chickpea = await access(channelRoutine, appPresence(), notInChannel);
  assert.equal(chickpea.botUserId, CHICKPEA_BOT);
  assert.equal(chickpea.client, notInChannel.chickpea.client);
  assert.equal(chickpea.speaker, undefined);
  assert.notEqual(own.accessHash, chickpea.accessHash, 'the access hash covers the bot that speaks');

  const unreadable = slack({ appChannels: [CHANNEL], appResolves: false });
  assert.equal((await access(channelRoutine, appPresence(), unreadable)).botUserId, CHICKPEA_BOT);
});

/** A post as Slack takes it: an Agent app's token has no chat:write.customize, so it refuses a persona. */
function postingClient(posts: Array<Record<string, unknown>>, appToken: boolean): WebClient {
  return {
    conversations: { open: async () => ({ ok: true, channel: { id: AGENT_DM, is_im: true } }) },
    chat: {
      postMessage: async (payload: Record<string, unknown>) => {
        if (appToken && ('username' in payload || 'icon_url' in payload)) {
          throw Object.assign(new Error('missing_scope'), { code: 'slack_webapi_platform_error', data: { ok: false, error: 'missing_scope' } });
        }
        posts.push(payload);
        return { ok: true, channel: payload.channel, ts: '1785000000.000100' };
      },
    },
  } as unknown as WebClient;
}

function deliveryStore(): RoutineStore {
  return {
    claimDelivery: async () => 'claimed',
    recordDelivery: async () => ({}),
    claimRecoveryDelivery: async () => 'claimed',
    getRecoveryDelivery: async () => ({ failureClass: 'consecutive_failures' }),
    recordRecoveryDelivery: async () => ({}),
  } as unknown as RoutineStore;
}

test('a scheduled post on an Agent app\'s token carries no persona; Chickpea\'s carries the Agent\'s', async (t) => {
  withHost(t);
  const deliver = async (resolved: RoutineRuntimeAccess, routine: RoutineDefinition, appToken: boolean) => {
    const posts: Array<Record<string, unknown>> = [];
    const client = postingClient(posts, appToken);
    const run = runOf(routine);
    await deliverRoutineResult({ store: deliveryStore(), run, routine, access: resolved, message: 'Done.', changeKeyHash: 'b'.repeat(64) }, client);
    assert.equal(await deliverRoutineRecoveryNotice({ store: deliveryStore(), run, routine, access: resolved }, client), 'accepted');
    assert.equal(posts.length, 2, 'the result and the pause notice both post');
    return posts;
  };
  const own = await access(channelRoutine, appPresence(), slack({ appChannels: [CHANNEL] }));
  for (const post of await deliver(own, channelRoutine, true)) {
    assert.ok(!('username' in post) && !('icon_url' in post));
  }
  const ownDm = await access(directRoutine(AGENT_DM), appPresence(), slack());
  for (const post of await deliver(ownDm, directRoutine(AGENT_DM), true)) {
    assert.ok(!('username' in post) && !('icon_url' in post));
  }
  const chickpea = await access(channelRoutine, appPresence(), slack({ appChannels: [] }));
  const [result, notice] = await deliver(chickpea, channelRoutine, false);
  assert.equal(result?.username, 'Support');
  assert.equal(notice?.username, 'Chickpea');
});

test('a schedule in Chickpea\'s DM runs as Chickpea under the Agent\'s name, app or not', async (t) => {
  withHost(t);
  for (const presence of [appPresence(), GROUP]) {
    const fake = slack();
    const resolved = await access(directRoutine(CHICKPEA_DM), presence, fake);
    assert.equal(resolved.botUserId, CHICKPEA_BOT);
    assert.equal(resolved.client, fake.chickpea.client);
    assert.equal(resolved.speaker, undefined);
    assert.deepEqual(appCalls(fake), []);
  }
});

test('a schedule made in the Agent\'s own DM runs as the Agent app\'s bot', async (t) => {
  withHost(t);
  const fake = slack();
  const resolved = await access(directRoutine(AGENT_DM), appPresence(), fake);
  assert.equal(resolved.botUserId, AGENT_BOT);
  assert.equal(resolved.client, fake.app.client);
  assert.deepEqual(resolved.speaker, { kind: 'own_bot', botUserId: AGENT_BOT });
  assert.deepEqual(appCalls(fake), [`${AGENT_BOT}:conversations.open`]);
});

test('a user-group Agent\'s schedules never ask an Agent app', async (t) => {
  withHost(t);
  for (const routine of [channelRoutine, directRoutine(CHICKPEA_DM)]) {
    const fake = slack({ appChannels: [CHANNEL] });
    const resolved = await access(routine, GROUP, fake);
    assert.equal(resolved.botUserId, CHICKPEA_BOT);
    assert.deepEqual(appCalls(fake), []);
  }
});

test('a schedule in the Agent\'s own DM skips while its app is not live, stays on, and runs once it is', async (t) => {
  withHost(t);
  const removed: AgentAppLifecycle = {
    state: 'needs_attention', at: NOW, startedBy: OWNER, reason: 'app_removed', resume: 'icon_set',
    app: { appId: 'A0AGENT1', clientId: '1.client' },
  };
  await assert.rejects(access(directRoutine(AGENT_DM), appPresence(removed), slack()), RoutineAgentAppUnavailableError);
  await assert.rejects(
    access(directRoutine(AGENT_DM), appPresence(), slack({ appResolves: false })),
    RoutineAgentAppUnavailableError,
  );

  const dir = mkdtempSync(join(tmpdir(), 'chickpea-agent-dm-schedule-'));
  const path = join(dir, 'state.db');
  const store = new SqliteRoutineStore(path, () => NOW);
  const configStore = new SqliteConfigStore(path, agentRoutineDeletion, { agents: [] });
  t.after(() => {
    configStore.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const destination = directDestination(AGENT_DM);
  await configStore.createAgent(agent(appPresence(removed)));
  const saved = await store.save({
    actorId: OWNER, actorClass: 'member', workspaceId: TEAM, channelId: AGENT_DM, destination,
    draft: {
      action: 'create', routineId: 'routine_agent_dm',
      definition: {
        name: 'Standup', description: '', taskText: 'Summarize.', triggerKind: 'schedule', scheduleInput: '0 * * * *',
        scheduleJson: JSON.stringify({ version: 1, kind: 'cron', expression: '0 * * * *' }),
        timezone: 'UTC', outputPolicy: 'post', authorityMode: 'live_direct_member_v1',
      },
      nextRunAt: NOW, projectedDailyStarts: 1, reservations: [{ windowStart: NOW, count: 1 }],
    },
    idempotencyKey: 'create:agent-dm', sourceVisibility: 'private',
  });
  const digest = routineDestinationBindingDigest(saved.id, TEAM, destination);
  const reference = await configStore.putAgentScheduleReference({
    boundRoutineVersion: saved.authorityBindingVersion ?? saved.version, scheduleId: saved.id,
    agentId: 'agent_support', workspaceId: TEAM, channelId: AGENT_DM, destinationKind: 'direct_thread',
    destinationBindingDigest: digest, createdByMembershipId: 'membership_owner', runsAsMembershipId: 'membership_owner',
    authorityReceiptId: 'receipt_owner', requiredConnectionAccountIds: [], state: 'active',
  });
  const routine = await store.activateDirectRoutine({
    routineId: saved.id, expectedVersion: saved.version, expectedReferenceRevision: reference.revision, destinationBindingDigest: digest,
  });
  const occurrence = async (suffix: string, scheduledFor: number) => {
    const run = await store.createOccurrence({
      runId: `rrun_${suffix}`, idempotencyKey: `run:${suffix}`, routineId: routine.id, routineVersion: routine.version,
      scheduledFor, triggerSource: 'schedule', queuedAt: NOW, deadlineAt: NOW + 60_000,
    });
    const attempt = await store.startAdmissionAttempt({
      occurrenceId: run.id, owner: 'heartbeat', invokeStartedAt: NOW, leaseUntil: NOW + 30_000,
    });
    return { run, attempt };
  };

  const away = await occurrence('away', NOW);
  const outcome = await executeRoutineOccurrence({ env: {}, store, occurrenceId: away.run.id, attempt: away.attempt.attempt }, {
    now: () => NOW + 1,
    usageRecordingEnabled: false,
    resolveAccess: (run, current) => resolveRoutineRuntimeAccess(run, current, undefined, {
      authority: async () => authorityFor(current, appPresence(removed)),
      installationExecution: slack().resolver,
    }),
  });
  assert.equal(outcome, 'completed');
  const skipped = await store.getRun(away.run.id);
  assert.equal(skipped?.status, 'skipped');
  assert.equal(skipped?.skipReason, 'agent_app_unavailable');
  const after = await store.getRoutine(routine.id);
  assert.equal(after?.state, 'active', 'the schedule stays on');
  assert.equal(after?.disabledReason, null);
  assert.equal(after?.pausedReason, null);

  const back = await occurrence('back', NOW + 3_600_000);
  const live = await resolveRoutineRuntimeAccess((await store.getRun(back.run.id))!, after!, undefined, {
    authority: async () => authorityFor(after!, appPresence()),
    installationExecution: slack().resolver,
  });
  assert.deepEqual(live.speaker, { kind: 'own_bot', botUserId: AGENT_BOT });
});

test('without the Agent-app port a schedule never speaks as an Agent app', async () => {
  const fake = slack({ appChannels: [CHANNEL] });
  assert.equal((await access(channelRoutine, appPresence(), fake)).botUserId, CHICKPEA_BOT);
  assert.deepEqual(appCalls(fake), []);
});

test('a DM schedule neither bot can open stays ineligible, app or not', async (t) => {
  withHost(t);
  const ineligible = (error: unknown) => error instanceof RoutineRuntimeError &&
    !(error instanceof RoutineAgentAppUnavailableError) && error.failureClass === 'channel_ineligible';
  await assert.rejects(access(directRoutine('D_ELSEWHERE'), appPresence(), slack()), ineligible);
  await assert.rejects(access(directRoutine(AGENT_DM), GROUP, slack()), ineligible);
});
