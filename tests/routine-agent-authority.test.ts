import assert from 'node:assert/strict';
import { test } from 'node:test';

import { provisionSlackInteractionMember } from '../src/auth/slack-admission.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import type { ConnectionAccountOwnerKind, ResolvedAssignment } from '../src/config/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import {
  bindRoutineAgentAuthority,
  reassignRoutineAgentAuthority,
  resolveRoutineAgentAuthority,
  RoutineAuthorityError,
} from '../src/routines/agent-authority.ts';
import {
  ConnectionAccountService,
  markManagedProviderAccountsUnavailable,
  reconcileManagedProviderAccounts,
} from '../src/connections/store.ts';
import { createManagedConnectionProviderRegistry } from '../src/connections/managed.ts';
import type { RoutineDefinition } from '../src/routines/types.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const WORKSPACE = 'T_AUTHORITY';
const CHANNEL = 'C_SUPPORT';

test('Agent schedules capture one Runs as authority and safely reassign future runs', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const identity = new SqliteIdentityStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const connections = new ConnectionAccountService({
    config,
    settings,
    managedProviders: createManagedConnectionProviderRegistry([{
      id: 'composio',
      async validate() {},
      async execute() { return { data: { ok: true } }; },
      async revoke() {},
    }]),
  });
  try {
    const owner = await createSlackOwner(identity, {
      teamId: WORKSPACE,
      userId: 'U_OWNER',
      suffix: 'routine_authority',
    });
    const ownerPrincipal = {
      userId: owner.user.id,
      membershipId: owner.membership.id,
      organizationId: owner.membership.organizationId,
      role: 'owner' as const,
      authenticatorKind: 'better_auth',
      credentialId: 'session_routine_authority',
      correlationId: 'request_routine_authority',
      machine: false,
    };
    const bob = await provisionSlackInteractionMember({
      identity,
      slackTeamId: WORKSPACE,
      botUserId: 'U_BOT',
      user: {
        id: 'U_BOB', teamId: WORKSPACE, displayName: 'Bob', email: 'bob@acme.test',
        deleted: false, bot: false, appUser: false, restricted: false,
        ultraRestricted: false, stranger: false,
      },
    });
    assert.ok(bob.resolution);
    const agent = await config.createAgent({
      id: 'agent_support', name: 'Support', instructions: 'Help customers.', enabled: true,
      model: 'local-stub/routine-authority',
      lifecycle: 'active', creatorMembershipId: owner.membership.id,
      editPolicy: 'creator_and_admins', skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: WORKSPACE, transportMode: 'direct', defaultAgentId: agent.id,
    });
    await config.putAgentChannelGrant({
      workspaceId: WORKSPACE, channelId: CHANNEL, agentId: agent.id, status: 'active',
      createdByMembershipId: owner.membership.id,
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: WORKSPACE,
      transportMode: 'direct',
      defaultAgentId: agent.id,
    });
    const team = await putConnection(config, 'connection_team', 'team', owner.membership.id);
    const ownerPersonal = await putConnection(
      config, 'connection_owner', 'member', owner.membership.id, owner.membership.id,
    );
    const bobPersonal = await putConnection(
      config, 'connection_bob', 'member', bob.resolution.membership.id,
      bob.resolution.membership.id, true,
    );
    for (const account of [team, ownerPersonal, bobPersonal]) {
      await config.putAgentConnectionBinding({
        agentId: agent.id, connectionAccountId: account.id, providerId: account.providerId,
        allowedCapabilities: [], enabled: true,
      });
    }

    const routine = routineDefinition();
    const assignment: ResolvedAssignment = {
      workspaceId: WORKSPACE, channelId: CHANNEL, agentId: agent.id,
      agent,
    };
    const first = await bindRoutineAgentAuthority({
      routine, assignment, actorMembershipId: owner.membership.id, env: undefined,
    }, { config, identity });
    assert.equal(first.createdByMembershipId, owner.membership.id);
    assert.equal(first.runsAsMembershipId, owner.membership.id);
    assert.deepEqual(first.requiredConnectionAccountIds.sort(), [team.id, ownerPersonal.id].sort());

    const unavailableOwnerPersonal = await config.putConnectionAccount(
      { ...ownerPersonal, lifecycle: 'needs_attention' },
      ownerPersonal.revision,
    );
    const connectorPaused = await config.putAgentScheduleReference({
      ...first,
      state: 'needs_attention',
      connectionPauseAccountIds: [ownerPersonal.id],
    }, first.revision);
    const editedDuringOutage = await bindRoutineAgentAuthority({
      routine: { ...routine, taskText: 'Review support carefully.' },
      assignment,
      actorMembershipId: owner.membership.id,
      env: undefined,
    }, { config, identity });
    assert.equal(editedDuringOutage.state, 'needs_attention');
    assert.deepEqual(editedDuringOutage.connectionPauseAccountIds, [ownerPersonal.id]);
    assert.deepEqual(
      editedDuringOutage.requiredConnectionAccountIds.sort(),
      [team.id, ownerPersonal.id].sort(),
      'an edit during an outage must retain the temporarily unavailable dependency',
    );
    await connections.detach({
      principal: ownerPrincipal,
      agentId: agent.id,
      connectionAccountId: ownerPersonal.id,
    });
    const editedAfterDetach = await bindRoutineAgentAuthority({
      routine: { ...routine, taskText: 'Continue without the removed personal connection.' },
      assignment,
      actorMembershipId: owner.membership.id,
      env: undefined,
    }, { config, identity });
    assert.equal(editedAfterDetach.state, 'active');
    assert.deepEqual(editedAfterDetach.requiredConnectionAccountIds, [team.id]);
    assert.equal(editedAfterDetach.connectionPauseAccountIds, undefined);
    await config.putConnectionAccount(
      { ...unavailableOwnerPersonal, lifecycle: 'ready' },
      unavailableOwnerPersonal.revision,
    );
    await connections.attach({
      principal: ownerPrincipal,
      agentId: agent.id,
      connectionAccountId: ownerPersonal.id,
      allowedCapabilities: [],
    });
    assert.equal(connectorPaused.scheduleId, editedDuringOutage.scheduleId);
    await reassignRoutineAgentAuthority({
      scheduleId: routine.id,
      runsAsMembershipId: owner.membership.id,
      receiptId: 'schedule_authority_owner_recovered',
      config,
      identity,
    });

    const resolved = await resolveRoutineAgentAuthority(routine, undefined, { config, identity });
    assert.equal(resolved.actorSlackUserId, 'U_OWNER');
    assert.deepEqual(resolved.effectiveConnections.map(({ account }) => account.id).sort(), [
      team.id, ownerPersonal.id,
    ].sort());

    await assert.rejects(
      bindRoutineAgentAuthority({
        routine: { ...routine, taskText: 'Use the other member\'s account.' },
        assignment,
        actorMembershipId: bob.resolution.membership.id,
        env: undefined,
      }, { config, identity }),
      (error: unknown) => error instanceof RoutineAuthorityError &&
        error.reason === 'creator_ineligible',
    );

    const reassigned = await reassignRoutineAgentAuthority({
      scheduleId: routine.id,
      runsAsMembershipId: bob.resolution.membership.id,
      receiptId: 'schedule_authority_bob',
      config,
      identity,
    });
    assert.equal(reassigned.createdByMembershipId, owner.membership.id);
    assert.equal(reassigned.runsAsMembershipId, bob.resolution.membership.id);
    assert.notEqual(reassigned.authorityReceiptId, first.authorityReceiptId);
    assert.deepEqual(reassigned.requiredConnectionAccountIds.sort(), [team.id, bobPersonal.id].sort());
    assert.equal(reassigned.state, 'active');
    assert.equal(reassigned.connectionPauseAccountIds, undefined);

    assert.deepEqual(await markManagedProviderAccountsUnavailable(config, {
      adapterId: 'composio',
    }), { accounts: 1, schedules: 1, retryable: 0 });
    const pausedAfterReassignment = await config.getAgentScheduleReference(routine.id);
    assert.equal(pausedAfterReassignment?.state, 'needs_attention');
    assert.deepEqual(pausedAfterReassignment?.connectionPauseAccountIds, [bobPersonal.id]);
    const reassignedDuringOutage = await reassignRoutineAgentAuthority({
      scheduleId: routine.id,
      runsAsMembershipId: bob.resolution.membership.id,
      receiptId: 'schedule_authority_bob_during_outage',
      config,
      identity,
    });
    assert.equal(reassignedDuringOutage.state, 'needs_attention');
    assert.deepEqual(reassignedDuringOutage.connectionPauseAccountIds, [bobPersonal.id]);
    assert.deepEqual(
      reassignedDuringOutage.requiredConnectionAccountIds.sort(),
      [team.id, bobPersonal.id].sort(),
      'reassignment must retain a recoverable dependency for the new Runs as member',
    );
    const unavailableBob = (await config.listConnectionAccounts(WORKSPACE))
      .find(({ id }) => id === bobPersonal.id)!;
    assert.equal(unavailableBob.lifecycle, 'needs_attention');
    assert.deepEqual(await reconcileManagedProviderAccounts(config, {
      adapterId: 'composio', generation: 1, lineage: 'a'.repeat(24),
      inspect: async () => 'match',
    }), { restored: 1, needsAttention: 0, retryable: 0 });
    const resumedAfterRecovery = await config.getAgentScheduleReference(routine.id);
    assert.equal(resumedAfterRecovery?.state, 'active');
    assert.equal(resumedAfterRecovery?.connectionPauseAccountIds, undefined);
    assert.deepEqual(
      resumedAfterRecovery?.requiredConnectionAccountIds.sort(),
      [team.id, bobPersonal.id].sort(),
    );
    const readyBob = (await config.listConnectionAccounts(WORKSPACE))
      .find(({ id }) => id === bobPersonal.id)!;
    assert.equal(readyBob.lifecycle, 'ready');
    await reassignRoutineAgentAuthority({
      scheduleId: routine.id,
      runsAsMembershipId: bob.resolution.membership.id,
      receiptId: 'schedule_authority_bob_recovered',
      config,
      identity,
    });
    assert.equal(
      (await resolveRoutineAgentAuthority(routine, undefined, { config, identity })).actorSlackUserId,
      'U_BOB',
    );

    await connections.revoke({
      principal: ownerPrincipal,
      connectionAccountId: readyBob.id,
    });
    const afterRevoke = await config.getAgentScheduleReference(routine.id);
    assert.equal(afterRevoke?.state, 'needs_attention');
    assert.deepEqual(afterRevoke?.requiredConnectionAccountIds, [team.id]);
    assert.equal(afterRevoke?.connectionPauseAccountIds, undefined);
    const replacementBob = await putConnection(
      config, 'connection_bob_reconnected', 'member', bob.resolution.membership.id,
      bob.resolution.membership.id, true,
    );
    await config.putAgentConnectionBinding({
      agentId: agent.id, connectionAccountId: replacementBob.id,
      providerId: replacementBob.providerId, allowedCapabilities: [], enabled: true,
    });
    const editedAfterRevoke = await bindRoutineAgentAuthority({
      routine: { ...routine, taskText: 'Continue without the disconnected mailbox.' },
      assignment,
      actorMembershipId: bob.resolution.membership.id,
      env: undefined,
    }, { config, identity });
    assert.equal(editedAfterRevoke.state, 'active');
    assert.deepEqual(
      editedAfterRevoke.requiredConnectionAccountIds.sort(),
      [team.id, replacementBob.id].sort(),
    );
    const archived = await config.putAgentScheduleReference({
      ...editedAfterRevoke,
      state: 'archived',
    }, editedAfterRevoke.revision);
    const reassignedArchived = await reassignRoutineAgentAuthority({
      scheduleId: routine.id,
      runsAsMembershipId: bob.resolution.membership.id,
      receiptId: 'schedule_authority_archived',
      config,
      identity,
    });
    assert.equal(archived.state, 'archived');
    assert.equal(reassignedArchived.state, 'archived');
  } finally {
    config.close();
    identity.close();
    settings.close();
  }
});

test('substituted personal outages stay attached while incomplete accounts stay optional', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const identity = new SqliteIdentityStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const connections = new ConnectionAccountService({ config, settings });
  try {
    const owner = await createSlackOwner(identity, {
      teamId: WORKSPACE,
      userId: 'U_TEMPLATE_OWNER',
      suffix: 'routine_substituted_authority',
    });
    const bob = await provisionSlackInteractionMember({
      identity,
      slackTeamId: WORKSPACE,
      botUserId: 'U_BOT',
      user: {
        id: 'U_SUBSTITUTED_BOB', teamId: WORKSPACE, displayName: 'Bob',
        email: 'substituted-bob@acme.test', deleted: false, bot: false, appUser: false,
        restricted: false, ultraRestricted: false, stranger: false,
      },
    });
    assert.ok(bob.resolution);
    const agent = await config.createAgent({
      id: 'agent_substituted', name: 'Substituted', instructions: 'Use personal Gmail.',
      enabled: true, lifecycle: 'active', creatorMembershipId: owner.membership.id,
      editPolicy: 'creator_and_admins', skills: [], mcpServers: [], apiConnections: [],
      repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: WORKSPACE, transportMode: 'direct', defaultAgentId: agent.id,
    });
    await config.putAgentChannelGrant({
      workspaceId: WORKSPACE, channelId: CHANNEL, agentId: agent.id, status: 'active',
      createdByMembershipId: owner.membership.id,
    });
    const ownerTemplate = await putConnection(
      config, 'connection_owner_template', 'member', owner.membership.id,
      owner.membership.id, true,
    );
    const bobGmail = await putConnection(
      config, 'connection_bob_substituted', 'member', bob.resolution.membership.id,
      bob.resolution.membership.id, true,
    );
    await config.putAgentConnectionBinding({
      agentId: agent.id, connectionAccountId: ownerTemplate.id,
      providerId: ownerTemplate.providerId,
      allowedCapabilities: ['gmail.messages.search'], enabled: true,
    });
    const routine = { ...routineDefinition(), id: 'routine_substituted' };
    const assignment: ResolvedAssignment = {
      workspaceId: WORKSPACE, channelId: CHANNEL, agentId: agent.id, agent,
    };
    const bound = await bindRoutineAgentAuthority({
      routine,
      assignment,
      actorMembershipId: bob.resolution.membership.id,
      env: undefined,
    }, { config, identity });
    assert.deepEqual(bound.requiredConnectionAccountIds, [bobGmail.id]);

    assert.deepEqual(await markManagedProviderAccountsUnavailable(config, {
      adapterId: 'composio',
    }), { accounts: 2, schedules: 1, retryable: 0 });
    const paused = await config.getAgentScheduleReference(routine.id);
    assert.equal(paused?.state, 'needs_attention');
    assert.deepEqual(paused?.requiredConnectionAccountIds, [bobGmail.id]);
    assert.deepEqual(paused?.connectionPauseAccountIds, [bobGmail.id]);

    const edited = await bindRoutineAgentAuthority({
      routine: { ...routine, taskText: 'Keep using the substituted mailbox.' },
      assignment,
      actorMembershipId: bob.resolution.membership.id,
      env: undefined,
    }, { config, identity });
    assert.equal(edited.state, 'needs_attention');
    assert.deepEqual(edited.requiredConnectionAccountIds, [bobGmail.id]);
    assert.deepEqual(edited.connectionPauseAccountIds, [bobGmail.id]);

    assert.deepEqual(await reconcileManagedProviderAccounts(config, {
      adapterId: 'composio', generation: 1, lineage: 'b'.repeat(24),
      inspect: async () => 'match',
    }), { restored: 2, needsAttention: 0, retryable: 0 });
    const recovered = await config.getAgentScheduleReference(routine.id);
    assert.equal(recovered?.state, 'active');
    assert.equal(recovered?.connectionPauseAccountIds, undefined);
    assert.deepEqual(recovered?.requiredConnectionAccountIds, [bobGmail.id]);

    const attentionBeforeOutage = await config.putAgentScheduleReference({
      ...recovered!,
      state: 'needs_attention',
    }, recovered!.revision);
    assert.equal(attentionBeforeOutage.connectionPauseAccountIds, undefined);
    assert.deepEqual(await markManagedProviderAccountsUnavailable(config, {
      adapterId: 'composio',
    }), { accounts: 2, schedules: 0, retryable: 0 });
    const attentionWithOutage = await config.getAgentScheduleReference(routine.id);
    assert.equal(attentionWithOutage?.state, 'needs_attention');
    assert.deepEqual(attentionWithOutage?.connectionPauseAccountIds, [bobGmail.id]);
    assert.equal(attentionWithOutage?.connectionPausePreservesState, true);
    const editedAfterOverlappingOutage = await bindRoutineAgentAuthority({
      routine: { ...routine, taskText: 'Preserve overlapping authority and connector failures.' },
      assignment,
      actorMembershipId: bob.resolution.membership.id,
      env: undefined,
    }, { config, identity });
    assert.equal(editedAfterOverlappingOutage.state, 'needs_attention');
    assert.deepEqual(editedAfterOverlappingOutage.requiredConnectionAccountIds, [bobGmail.id]);
    assert.deepEqual(editedAfterOverlappingOutage.connectionPauseAccountIds, [bobGmail.id]);
    assert.equal(editedAfterOverlappingOutage.connectionPausePreservesState, true);
    assert.deepEqual(await reconcileManagedProviderAccounts(config, {
      adapterId: 'composio', generation: 2, lineage: 'c'.repeat(24),
      inspect: async () => 'match',
    }), { restored: 2, needsAttention: 0, retryable: 0 });
    const attentionAfterRecovery = await config.getAgentScheduleReference(routine.id);
    assert.equal(attentionAfterRecovery?.state, 'needs_attention');
    assert.equal(attentionAfterRecovery?.connectionPauseAccountIds, undefined);
    assert.equal(attentionAfterRecovery?.connectionPausePreservesState, undefined);

    const pendingAds = await config.putConnectionAccount({
      id: 'connection_bob_pending_ads', workspaceId: WORKSPACE, ownerKind: 'member',
      ownerMembershipId: bob.resolution.membership.id,
      createdByMembershipId: bob.resolution.membership.id,
      providerId: 'google', label: 'Incomplete Google Ads', policy: {
        kind: 'managed', adapterId: 'composio', toolkit: 'googleads',
        principalRef: 'principal_bob_pending_ads', accountRef: 'account_bob_pending_ads',
        allowedCapabilities: ['googleads.campaigns.list'],
      },
      secretRefId: 'secret_bob_pending_ads', lifecycle: 'pending',
    }, 0);
    await config.putAgentConnectionBinding({
      agentId: agent.id, connectionAccountId: pendingAds.id,
      providerId: pendingAds.providerId,
      allowedCapabilities: ['googleads.campaigns.list'], enabled: true,
    });
    const reassignedWithPendingAccount = await reassignRoutineAgentAuthority({
      scheduleId: routine.id,
      runsAsMembershipId: bob.resolution.membership.id,
      receiptId: 'schedule_authority_pending_account_ignored',
      config,
      identity,
    });
    assert.equal(reassignedWithPendingAccount.state, 'active');
    assert.equal(reassignedWithPendingAccount.connectionPauseAccountIds, undefined);
    assert.deepEqual(reassignedWithPendingAccount.requiredConnectionAccountIds, [bobGmail.id]);
    await connections.detach({
      principal: {
        userId: owner.user.id,
        membershipId: owner.membership.id,
        organizationId: owner.membership.organizationId,
        role: 'owner',
        authenticatorKind: 'better_auth',
        credentialId: 'session_substituted_detach',
        correlationId: 'request_substituted_detach',
        machine: false,
      },
      agentId: agent.id,
      connectionAccountId: ownerTemplate.id,
    });
    const afterTemplateDetach = await config.getAgentScheduleReference(routine.id);
    assert.equal(afterTemplateDetach?.state, 'active');
    assert.deepEqual(afterTemplateDetach?.requiredConnectionAccountIds, []);
    assert.equal(afterTemplateDetach?.connectionPauseAccountIds, undefined);
    const fallback = await config.createAgent({
      id: 'agent_substituted_fallback', name: 'Fallback', instructions: 'Stay active.',
      enabled: true, lifecycle: 'active', creatorMembershipId: owner.membership.id,
      editPolicy: 'creator_and_admins', skills: [], mcpServers: [], apiConnections: [],
      repositories: [],
    });
    const installation = (await config.listWorkspaceInstallations())
      .find(({ workspaceId }) => workspaceId === WORKSPACE)!;
    await config.setWorkspaceDefaultAgent(WORKSPACE, fallback.id, installation.revision);
    await config.archiveAgent(agent.id);
    assert.equal((await config.getAgentScheduleReference(routine.id))?.state, 'paused');
    await assert.rejects(
      reassignRoutineAgentAuthority({
        scheduleId: routine.id,
        runsAsMembershipId: bob.resolution.membership.id,
        receiptId: 'schedule_authority_archived_agent_rejected',
        config,
        identity,
      }),
      (error: unknown) => error instanceof RoutineAuthorityError &&
        error.reason === 'agent_unavailable',
    );
    assert.equal((await config.getAgentScheduleReference(routine.id))?.state, 'paused');
    await config.restoreAgent(agent.id);
    assert.equal((await config.getAgentScheduleReference(routine.id))?.state, 'active');
  } finally {
    config.close();
    identity.close();
    settings.close();
  }
});

async function putConnection(
  config: SqliteConfigStore,
  id: string,
  ownerKind: ConnectionAccountOwnerKind,
  createdByMembershipId: string,
  ownerMembershipId?: string,
  managed = false,
) {
  return config.putConnectionAccount({
    id,
    workspaceId: WORKSPACE,
    ownerKind,
    ...(ownerMembershipId ? { ownerMembershipId } : {}),
    createdByMembershipId,
    providerId: managed ? 'google' : 'test-provider',
    label: id,
    policy: managed ? {
      kind: 'managed', adapterId: 'composio', toolkit: 'gmail',
      principalRef: `principal_${id}`, accountRef: `account_${id}`,
      allowedCapabilities: ['gmail.messages.search'],
    } : {
      kind: 'api', allowedHosts: ['api.example.test'], pathPrefixes: ['/'],
      headerName: 'Authorization', allowedMethods: ['GET'], authMode: 'credential',
    },
    secretRefId: `secret_${id}`,
    lifecycle: 'ready',
  });
}

function routineDefinition(): RoutineDefinition {
  return {
    id: 'routine_support', workspaceId: WORKSPACE, channelId: CHANNEL, creatorUserId: 'U_OWNER',
    destination: { kind: 'channel', channelId: CHANNEL },
    name: 'Support check', description: '', taskText: 'Review support.', triggerKind: 'schedule',
    scheduleInput: '0 * * * *',
    scheduleJson: '{"version":1,"kind":"cron","expression":"0 * * * *"}',
    timezone: 'UTC', outputPolicy: 'post', authorityMode: 'live_channel_v1', state: 'active',
    version: 1, nextRunAt: 1, lastScheduledAt: null, lastFinishedAt: null,
    consecutiveFailures: 0, lastChangeKeyHash: null, projectedDailyStarts: 24,
    reservationWindows: [{ windowStart: 1, count: 1 }], createdAt: 1, createdBy: 'U_OWNER',
    updatedAt: 1, updatedBy: 'U_OWNER', pausedAt: null, pausedBy: null, pausedReason: null,
    disabledAt: null, disabledBy: null, disabledReason: null, deletedAt: null, deletedBy: null,
  };
}
