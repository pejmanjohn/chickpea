import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRoutineStore } from '../src/routines/store.ts';
import { executeSlackScheduleCommand } from '../src/routines/slack-command.ts';

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
import { routineDestinationBindingDigest } from '../src/routines/ids.ts';
import {
  ConnectionAccountService,
  markManagedProviderAccountsUnavailable,
  reconcileManagedProviderAccounts,
} from '../src/connections/store.ts';
import { createManagedConnectionProviderRegistry } from '../src/connections/managed.ts';
import type { RoutineDefinition } from '../src/routines/types.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';
import { compileRuntimePlanV2 } from '../src/agents/runtime-plan.ts';

const WORKSPACE = 'T_AUTHORITY';
const CHANNEL = 'C_SUPPORT';

test('exact schedule dependencies govern disconnects, mounting, metadata edits, and legacy references', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const identity = new SqliteIdentityStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const owner = await createSlackOwner(identity, { teamId: WORKSPACE, userId: 'U_OWNER', suffix: 'exact_schedule' });
    const agent = await config.createAgent({ id: 'agent_exact', name: 'Exact', instructions: 'Run the saved task.',
      model: 'local-stub/exact', enabled: true, lifecycle: 'active', creatorMembershipId: owner.membership.id,
      editPolicy: 'creator_and_admins', skills: [], mcpServers: [], apiConnections: [], repositories: [] });
    await config.ensureWorkspaceInstallation({ workspaceId: WORKSPACE, transportMode: 'direct', defaultAgentId: agent.id });
    await config.putAgentChannelGrant({ workspaceId: WORKSPACE, channelId: CHANNEL, agentId: agent.id,
      status: 'active', createdByMembershipId: owner.membership.id });
    const source = await putConnection(config, 'connection_source', 'team', owner.membership.id);
    const unrelated = await putConnection(config, 'connection_unused', 'team', owner.membership.id);
    for (const account of [source, unrelated]) await config.putAgentConnectionBinding({
      agentId: agent.id, connectionAccountId: account.id, providerId: account.providerId, allowedCapabilities: [], enabled: true,
    });
    const routine = routineDefinition();
    const assignment: ResolvedAssignment = { workspaceId: WORKSPACE, channelId: CHANNEL, agentId: agent.id, agent };
    const bind = (definition: RoutineDefinition, ids?: string[]) => bindRoutineAgentAuthority({ routine: definition,
      assignment, actorMembershipId: owner.membership.id, env: undefined,
      ...(ids !== undefined ? { requiredConnectionAccountIds: ids } : {}),
    }, { config, identity });
    await assert.rejects(bind(routine), /Declare the accounts/);
    await assert.rejects(bind(routine, ['connection_invented']), /unavailable/);
    const first = await bind(routine, [source.id]);
    const empty = await bind({ ...routine, id: 'routine_without_connections' }, []);
    assert.deepEqual(empty.requiredConnectionAccountIds, []);
    const authority = await resolveRoutineAgentAuthority(routine, undefined, { config, identity });
    const plan = compileRuntimePlanV2({ assignment: authority.assignment,
      turn: { workspaceId: WORKSPACE, channelId: CHANNEL, eventId: 'run', userId: 'U_OWNER',
        actorMembershipId: owner.membership.id, messageTs: '1785509000.000100', threadTs: '1785509000.000100', text: 'Run the saved task',
        source: 'app_mention', contextMode: 'channel_history' },
      instructions: agent.instructions, memoryEpoch: 1, sandboxMode: 'bash', effectiveConnections: authority.effectiveConnections });
    assert.deepEqual(plan.connectionAccountIds, [source.id]);
    assert.equal(plan.apiConnections.length, 1);
    const service = new ConnectionAccountService({ config, settings });
    const principal = { userId: owner.user.id, membershipId: owner.membership.id,
      organizationId: owner.membership.organizationId, role: 'owner' as const, authenticatorKind: 'better_auth',
      credentialId: 'test', correlationId: 'test', machine: false };
    await service.disconnectForAgent({ principal, agentId: agent.id, connectionAccountId: unrelated.id });
    assert.equal((await config.getAgentScheduleReference(routine.id))?.state, 'active');
    assert.equal((await config.getAgentScheduleReference(empty.scheduleId))?.state, 'active');
    const added = await putConnection(config, 'connection_later', 'team', owner.membership.id);
    await config.putAgentConnectionBinding({ agentId: agent.id, connectionAccountId: added.id,
      providerId: added.providerId, allowedCapabilities: [], enabled: true });
    const metadata = await bind({ ...routine, version: 2, name: 'Renamed' });
    assert.deepEqual(metadata.requiredConnectionAccountIds, [source.id]);
    await service.disconnectForAgent({ principal, agentId: agent.id, connectionAccountId: source.id });
    assert.equal((await config.getAgentScheduleReference(routine.id))?.state, 'needs_attention');
    assert.equal((await config.getAgentScheduleReference(empty.scheduleId))?.state, 'active');
    const outageEdit = await bind({ ...routine, version: 3, name: 'Still paused' });
    assert.deepEqual(outageEdit.requiredConnectionAccountIds, [source.id]);
    assert.equal(outageEdit.state, 'needs_attention');
    await assert.rejects(resolveRoutineAgentAuthority(routine, undefined, { config, identity }));
    const replaced = await bind({ ...routine, version: 4, taskText: 'Use the replacement source.' }, [added.id]);
    assert.deepEqual(replaced.requiredConnectionAccountIds, [added.id]);
    assert.equal(replaced.state, 'active');
    assert.deepEqual((await bind(routine, [source.id])).requiredConnectionAccountIds, [added.id], 'stale save replay cannot restore an old set');
    const { boundRoutineVersion: _boundVersion, ...legacy } = first;
    const legacyRoutine = { ...routine, id: 'routine_legacy_broad' };
    await config.putAgentScheduleReference({ ...legacy, scheduleId: legacyRoutine.id, requiredConnectionAccountIds: [added.id], state: 'active' }, 0);
    assert.deepEqual((await bind({ ...legacyRoutine, version: 2, name: 'Legacy rename' })).requiredConnectionAccountIds, [added.id]);
    assert.deepEqual((await bind({ ...legacyRoutine, version: 3 }, [])).requiredConnectionAccountIds, []);
  } finally { config.close(); identity.close(); settings.close(); }
});

test('direct schedules bind and resolve a full member without any Channel grant', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const identity = new SqliteIdentityStore(':memory:');
  try {
    const owner = await createSlackOwner(identity, {
      teamId: WORKSPACE,
      userId: 'U_DIRECT_OWNER',
      suffix: 'routine_direct_authority_owner',
    });
    const member = await provisionSlackInteractionMember({
      identity,
      slackTeamId: WORKSPACE,
      botUserId: 'U_BOT',
      user: {
        id: 'U_DIRECT_MEMBER', teamId: WORKSPACE, displayName: 'Direct member',
        email: 'direct-member@acme.test', deleted: false, bot: false, appUser: false,
        restricted: false, ultraRestricted: false, stranger: false,
      },
    });
    assert.ok(member.resolution);
    const agent = await config.createAgent({
      id: 'agent_direct', name: 'Direct', instructions: 'Run private work.', enabled: true,
      lifecycle: 'active', creatorMembershipId: owner.membership.id,
      editPolicy: 'creator_and_admins', skills: [], mcpServers: [], apiConnections: [],
      repositories: [], model: 'local-stub/routine-direct-authority',
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: WORKSPACE,
      transportMode: 'direct',
      defaultAgentId: agent.id,
    });
    const destination = {
      kind: 'direct_thread' as const,
      conversationId: 'D_DIRECT',
      threadTs: '1787853827.722389',
      ownerMembershipId: member.resolution.membership.id,
    };
    const routine = {
      ...routineDefinition(),
      id: 'routine_direct_authority',
      channelId: destination.conversationId,
      destination,
      authorityMode: 'live_direct_member_v1' as const,
    };
    const assignment: ResolvedAssignment = {
      workspaceId: WORKSPACE,
      channelId: destination.conversationId,
      agentId: agent.id,
      agent,
    };

    const reference = await bindRoutineAgentAuthority({
      requiredConnectionAccountIds: [],
      routine,
      assignment,
      actorMembershipId: member.resolution.membership.id,
      env: undefined,
    }, { config, identity });
    assert.deepEqual(await config.listAgentChannelGrants(WORKSPACE), []);
    assert.equal(reference.destinationKind, 'direct_thread');
    assert.equal(
      reference.destinationBindingDigest,
      routineDestinationBindingDigest(routine.id, routine.workspaceId, destination),
    );
    assert.equal(reference.createdByMembershipId, destination.ownerMembershipId);
    assert.equal(reference.runsAsMembershipId, destination.ownerMembershipId);
    const resolved = await resolveRoutineAgentAuthority(routine, undefined, { config, identity });
    assert.equal(resolved.agent.id, agent.id);
    assert.equal(resolved.actorSlackUserId, 'U_DIRECT_MEMBER');

    await assert.rejects(
      reassignRoutineAgentAuthority({
        scheduleId: routine.id,
        runsAsMembershipId: owner.membership.id,
        config,
        identity,
      }),
      (error: unknown) => error instanceof RoutineAuthorityError &&
        error.reason === 'creator_ineligible',
    );

    await assert.rejects(
      bindRoutineAgentAuthority({
        routine: { ...routine, id: 'routine_direct_wrong_member' },
        assignment,
        actorMembershipId: owner.membership.id,
        env: undefined,
      }, { config, identity }),
      (error: unknown) => error instanceof RoutineAuthorityError &&
        error.reason === 'creator_ineligible',
    );

    const chickpea = await config.materializeChickpeaAgent();
    await assert.rejects(
      bindRoutineAgentAuthority({
        routine: { ...routine, id: 'routine_direct_chickpea' },
        assignment: {
          workspaceId: WORKSPACE,
          channelId: destination.conversationId,
          agentId: chickpea.id,
          agent: chickpea,
        },
        actorMembershipId: destination.ownerMembershipId,
        env: undefined,
      }, { config, identity }),
      (error: unknown) => error instanceof RoutineAuthorityError &&
        error.reason === 'agent_unavailable',
    );

    await identity.setMembershipAccessOverlay({
      membershipId: member.resolution.membership.id,
      organizationId: member.resolution.membership.organizationId,
      accessStatus: 'suspended',
    });
    await assert.rejects(
      resolveRoutineAgentAuthority(routine, undefined, { config, identity }),
      (error: unknown) => error instanceof RoutineAuthorityError &&
        error.reason === 'creator_ineligible',
    );
  } finally {
    config.close();
    identity.close();
  }
});

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
      requiredConnectionAccountIds: [team.id, ownerPersonal.id],
      routine, assignment, actorMembershipId: owner.membership.id, env: undefined,
    }, { config, identity });
    assert.equal(first.createdByMembershipId, owner.membership.id);
    assert.equal(first.runsAsMembershipId, owner.membership.id);
    assert.deepEqual(first.requiredConnectionAccountIds.sort(), [team.id, ownerPersonal.id].sort());

    await config.putConnectionAccount(
      { ...ownerPersonal, lifecycle: 'needs_attention' },
      ownerPersonal.revision,
    );
    const connectorPaused = await config.putAgentScheduleReference({
      ...first,
      state: 'needs_attention',
      connectionPauseAccountIds: [ownerPersonal.id],
    }, first.revision);
    const editedDuringOutage = await bindRoutineAgentAuthority({
      routine: { ...routine, version: 2, taskText: 'Review support carefully.' },
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
    await connections.disconnectForAgent({
      principal: ownerPrincipal,
      agentId: agent.id,
      connectionAccountId: ownerPersonal.id,
    });
    const editedAfterDisconnect = await bindRoutineAgentAuthority({
      routine: { ...routine, version: 3, taskText: 'Continue without the disconnected personal connection.' },
      requiredConnectionAccountIds: [team.id],
      assignment,
      actorMembershipId: owner.membership.id,
      env: undefined,
    }, { config, identity });
    routine.version = 3;
    assert.equal(editedAfterDisconnect.state, 'active');
    assert.deepEqual(editedAfterDisconnect.requiredConnectionAccountIds, [team.id]);
    assert.equal(editedAfterDisconnect.connectionPauseAccountIds, undefined);
    const replacementPersonal = await putConnection(
      config, 'connection_owner_reauthorized', 'member', owner.membership.id,
      owner.membership.id,
    );
    await config.putAgentConnectionBinding({
      agentId: agent.id,
      connectionAccountId: replacementPersonal.id,
      providerId: replacementPersonal.providerId,
      allowedCapabilities: [],
      enabled: true,
    });
    assert.equal(connectorPaused.scheduleId, editedDuringOutage.scheduleId);
    await reassignRoutineAgentAuthority({
      scheduleId: routine.id,
      runsAsMembershipId: owner.membership.id,
      receiptId: 'schedule_authority_owner_recovered',
      requiredConnectionAccountIds: [team.id, replacementPersonal.id],
      config,
      identity,
    });

    const resolved = await resolveRoutineAgentAuthority(routine, undefined, { config, identity });
    assert.equal(resolved.actorSlackUserId, 'U_OWNER');
    assert.deepEqual(resolved.effectiveConnections.map(({ account }) => account.id).sort(), [
      team.id, replacementPersonal.id,
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

    await assert.rejects(reassignRoutineAgentAuthority({
      scheduleId: routine.id, runsAsMembershipId: bob.resolution.membership.id, config, identity,
    }), /accounts are never substituted/);
    assert.equal((await config.getAgentScheduleReference(routine.id))?.runsAsMembershipId, owner.membership.id);
    const reassigned = await reassignRoutineAgentAuthority({
      scheduleId: routine.id,
      runsAsMembershipId: bob.resolution.membership.id,
      receiptId: 'schedule_authority_bob',
      requiredConnectionAccountIds: [team.id, bobPersonal.id],
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
    assert.deepEqual(afterRevoke?.requiredConnectionAccountIds.sort(), [team.id, bobPersonal.id].sort());
    assert.deepEqual(afterRevoke?.connectionPauseAccountIds, [bobPersonal.id]);
    const replacementBob = await putConnection(
      config, 'connection_bob_reconnected', 'member', bob.resolution.membership.id,
      bob.resolution.membership.id, true,
    );
    await config.putAgentConnectionBinding({
      agentId: agent.id, connectionAccountId: replacementBob.id,
      providerId: replacementBob.providerId, allowedCapabilities: [], enabled: true,
    });
    const editedAfterRevoke = await bindRoutineAgentAuthority({
      routine: { ...routine, version: 4, taskText: 'Use the explicitly selected replacement mailbox.' },
      requiredConnectionAccountIds: [team.id, replacementBob.id],
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

test('routine authority uses only the Runs as member account exactly bound to the Agent', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const identity = new SqliteIdentityStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const connections = new ConnectionAccountService({
    config,
    settings,
    managedProviders: createManagedConnectionProviderRegistry([{
      id: 'composio',
      async validate() {},
      async execute() { return { data: {} }; },
      async revoke() {},
    }]),
  });
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
    await config.putAgentConnectionBinding({
      agentId: agent.id, connectionAccountId: bobGmail.id,
      providerId: bobGmail.providerId,
      allowedCapabilities: ['gmail.messages.search'], enabled: true,
    });
    const routine = { ...routineDefinition(), id: 'routine_substituted' };
    const assignment: ResolvedAssignment = {
      workspaceId: WORKSPACE, channelId: CHANNEL, agentId: agent.id, agent,
    };
    const bound = await bindRoutineAgentAuthority({
      requiredConnectionAccountIds: [bobGmail.id],
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
      routine: { ...routine, version: 2, taskText: 'Keep using the substituted mailbox.' },
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
      routine: { ...routine, version: 3, taskText: 'Preserve overlapping authority and connector failures.' },
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
    await connections.disconnectForAgent({
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
    assert.deepEqual(afterTemplateDetach?.requiredConnectionAccountIds, [bobGmail.id]);
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

for (const legacy of [false, true]) {
  test(`saved task authority is fenced through delayed binding and controls (legacy=${legacy})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'routine-binding-fence-'));
    const path = join(dir, 'state.sqlite');
    const config = new SqliteConfigStore(path, { agents: [] });
    const routines = new SqliteRoutineStore(path);
    const identity = new SqliteIdentityStore(':memory:');
    try {
      const owner = await createSlackOwner(identity, { teamId: WORKSPACE, userId: 'U_FENCE', suffix: 'fence' });
      const agent = await config.createAgent({ id: 'agent_fence', name: 'Fence', instructions: 'Run saved work.',
        model: 'local-stub/fence', enabled: true, lifecycle: 'active', creatorMembershipId: owner.membership.id,
        editPolicy: 'creator_and_admins', skills: [], mcpServers: [], apiConnections: [], repositories: [] });
      await config.ensureWorkspaceInstallation({ workspaceId: WORKSPACE, transportMode: 'direct', defaultAgentId: agent.id });
      await config.putAgentChannelGrant({ workspaceId: WORKSPACE, channelId: CHANNEL, agentId: agent.id,
        status: 'active', createdByMembershipId: owner.membership.id });
      const account = await putConnection(config, 'connection_fence', 'team', owner.membership.id);
      await config.putAgentConnectionBinding({ agentId: agent.id, connectionAccountId: account.id,
        providerId: account.providerId, enabled: true, allowedCapabilities: [] });
      const dependencies = { config, routines, identity, schedulingAvailable: true };
      const save = { kind: 'save' as const, actionKey: 'rsaction_fence_create', itemId: 'save',
        workspaceId: WORKSPACE, channelId: CHANNEL, agentId: agent.id,
        actorUserId: owner.user.id, actorMembershipId: owner.membership.id,
        name: 'Fence', description: '', taskText: 'Run saved work.',
        schedule: { kind: 'cron' as const, expression: '0 9 * * *' }, timezone: 'UTC',
        outputPolicy: 'post' as const, requiredConnectionAccountIds: [account.id] };
      let first = (await executeSlackScheduleCommand(save, dependencies)).routine;
      if (legacy) {
        const db = new DatabaseSync(path);
        try { db.prepare('UPDATE routines SET authority_binding_version = NULL WHERE id = ?').run(first.id); }
        finally { db.close(); }
        const reference = (await config.getAgentScheduleReference(first.id))!;
        const { boundRoutineVersion: _version, ...prior } = reference;
        await config.putAgentScheduleReference(prior, reference.revision);
        first = (await routines.getRoutine(first.id))!;
        assert.equal(first.authorityBindingVersion, undefined);
      }
      assert.equal((await resolveRoutineAgentAuthority(first, undefined, { config, identity })).effectiveConnections.length, 1);
      let entered!: () => void;
      let resume!: () => void;
      const waiting = new Promise<void>((resolve) => { entered = resolve; });
      const released = new Promise<void>((resolve) => { resume = resolve; });
      // Same task text: dependency-only edits still need a new binding epoch.
      const edit = { ...save, routineId: first.id, expectedVersion: first.version,
        actionKey: 'rsaction_fence_edit', requiredConnectionAccountIds: [] };
      const pending = executeSlackScheduleCommand(edit, { ...dependencies,
        bindAuthority: async (input) => { entered(); await released;
          return bindRoutineAgentAuthority(input, { config, identity }); },
      });
      await waiting;
      const saved = (await routines.getRoutine(first.id))!;
      assert.equal(saved.authorityBindingVersion, 2);
      assert.equal(saved.state, 'active');
      const { requiredConnectionAccountIds: _ids, ...metadataEdit } = edit;
      await assert.rejects(executeSlackScheduleCommand({ ...metadataEdit,
        expectedVersion: saved.version, name: 'Renamed while binding', actionKey: 'rsaction_pending_metadata',
      }, dependencies), /previous schedule edit is still binding/);
      assert.equal((await routines.getRoutine(first.id))!.version, saved.version);
      await assert.rejects(resolveRoutineAgentAuthority(saved, undefined, { config, identity }), RoutineAuthorityError);
      const paused = await routines.control({ routineId: saved.id, expectedVersion: saved.version,
        actorId: owner.user.id, actorClass: 'operator', action: 'pause', idempotencyKey: 'fence_pause' });
      const resumed = await routines.control({ routineId: saved.id, expectedVersion: paused.version,
        actorId: owner.user.id, actorClass: 'operator', action: 'resume', idempotencyKey: 'fence_resume' });
      assert.equal(resumed.version, 4);
      assert.equal(resumed.authorityBindingVersion, 2);
      await assert.rejects(resolveRoutineAgentAuthority(resumed, undefined, { config, identity }), RoutineAuthorityError);
      resume();
      await pending;
      assert.deepEqual((await resolveRoutineAgentAuthority(resumed, undefined, { config, identity })).effectiveConnections, []);
      // Old new-format task snapshots cannot use the replacement binding.
      await assert.rejects(resolveRoutineAgentAuthority(first, undefined, { config, identity }), RoutineAuthorityError);
      const replay = await executeSlackScheduleCommand(edit, dependencies);
      assert.equal(replay.routine.authorityBindingVersion, 2);
      assert.equal((await config.getAgentScheduleReference(first.id))!.boundRoutineVersion, 2);
      const finalPause = await routines.control({ routineId: first.id, expectedVersion: resumed.version,
        actorId: owner.user.id, actorClass: 'operator', action: 'pause', idempotencyKey: 'fence_pause_after' });
      const finalResume = await routines.control({ routineId: first.id, expectedVersion: finalPause.version,
        actorId: owner.user.id, actorClass: 'operator', action: 'resume', idempotencyKey: 'fence_resume_after' });
      assert.deepEqual((await resolveRoutineAgentAuthority(finalResume, undefined, { config, identity })).effectiveConnections, []);
      const { requiredConnectionAccountIds: _requirements, ...metadataSave } = save;
      const retryableMetadata = { ...metadataSave, routineId: first.id, expectedVersion: finalResume.version,
        actionKey: 'rsaction_retry_metadata', name: 'Rename with interrupted binding' };
      await assert.rejects(executeSlackScheduleCommand(retryableMetadata, { ...dependencies,
        bindAuthority: async () => { throw new Error('Interrupted binding'); },
      }));
      const retried = await executeSlackScheduleCommand(retryableMetadata, dependencies);
      assert.equal(retried.routine.authorityBindingVersion, finalResume.version + 1);
      assert.equal((await config.getAgentScheduleReference(first.id))!.boundRoutineVersion, finalResume.version + 1);
      assert.equal(retried.routine.state, 'paused', 'repairing the binding does not undo the failure pause');
    } finally { routines.close(); config.close(); identity.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}
