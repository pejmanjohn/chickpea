import assert from 'node:assert/strict';
import test from 'node:test';

import { CfConfigStore } from '../src/config/cf-state-proxies.ts';
import type { StateRpcResult, TagStateRpc } from '../src/config/state-rpc.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type {
  AgentChannelGrant,
  AgentScheduleReference,
  AgentThreadRoute,
  ChickpeaCutoverActivation,
  ChickpeaCutoverPreflight,
  ConnectionAccount,
  SlackPublicContextEntry,
  WorkspaceModelDefault,
  WorkspaceInstallation,
} from '../src/config/types.ts';

function agent(id: string, name: string) {
  return {
    id,
    name,
    instructions: `You are ${name}.`,
    enabled: true,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  };
}

test('fresh Agent platform state designates one normal default Agent', async () => {
  const store = new SqliteConfigStore(':memory:');
  try {
    const installation = await store.ensureWorkspaceInstallation({
      workspaceId: 'T_PLATFORM',
      transportMode: 'direct',
    });
    const agents = await store.listAgents();

    assert.equal(agents.length, 1);
    assert.equal(installation.defaultAgentId, agents[0]?.id);
    assert.equal(agents[0]?.lifecycle, 'active');
    assert.equal(agents[0]?.slackPresence?.desiredState, 'unpublished');
  } finally {
    store.close();
  }
});

test('one Chickpea deployment cannot bind a second Slack workspace', async () => {
  const store = new SqliteConfigStore(':memory:');
  try {
    await store.ensureWorkspaceInstallation({
      workspaceId: 'T_PRIMARY',
      transportMode: 'gateway',
    });
    await assert.rejects(
      store.ensureWorkspaceInstallation({
        workspaceId: 'T_OTHER',
        transportMode: 'gateway',
      }),
      /already connected to Slack workspace T_PRIMARY/,
    );
    assert.deepEqual(
      (await store.listWorkspaceInstallations()).map(({ workspaceId }) => workspaceId),
      ['T_PRIMARY'],
    );
  } finally {
    store.close();
  }
});

test('Agent grants are many-to-many and thread routes retain their coordinate', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [] });
  try {
    await store.createAgent(agent('agent_support', 'Support'));
    await store.createAgent(agent('agent_sales', 'Sales'));

    await store.putAgentChannelGrant({
      workspaceId: 'T_PLATFORM',
      channelId: 'C_SHARED',
      agentId: 'agent_support',
      status: 'active',
      createdByMembershipId: 'membership_owner',
    });
    await store.putAgentChannelGrant({
      workspaceId: 'T_PLATFORM',
      channelId: 'C_SHARED',
      agentId: 'agent_sales',
      status: 'active',
      createdByMembershipId: 'membership_owner',
    });

    assert.deepEqual(
      (await store.listAgentChannelGrants('T_PLATFORM', 'C_SHARED')).map((grant) => grant.agentId),
      ['agent_sales', 'agent_support'],
    );

    const first = await store.putAgentThreadRoute({
      workspaceId: 'T_PLATFORM',
      channelId: 'C_SHARED',
      threadTs: '1700000000.000100',
      agentId: 'agent_support',
      agentGeneration: 1,
    });
    const second = await store.putAgentThreadRoute(
      {
        workspaceId: first.workspaceId,
        channelId: first.channelId,
        threadTs: first.threadTs,
        agentId: 'agent_sales',
        agentGeneration: 2,
      },
      first.revision,
    );

    assert.equal(second.threadTs, first.threadTs);
    assert.equal(second.agentId, 'agent_sales');
    assert.equal(second.agentGeneration, 2);
    assert.equal(second.revision, first.revision + 1);
  } finally {
    store.close();
  }
});

test('the designated default Agent cannot be archived without a replacement', async () => {
  const store = new SqliteConfigStore(':memory:');
  try {
    await store.ensureWorkspaceInstallation({
      workspaceId: 'T_PLATFORM',
      transportMode: 'direct',
    });

    await assert.rejects(
      store.archiveAgent('agent_default'),
      /replacement default Agent/i,
    );

    await store.createAgent(agent('agent_replacement', 'Replacement'));
    const archived = await store.archiveAgent('agent_default', {
      replacementDefaultAgentId: 'agent_replacement',
    });

    assert.equal(archived.lifecycle, 'archived');
    assert.equal(
      (await store.getWorkspaceInstallation('T_PLATFORM'))?.defaultAgentId,
      'agent_replacement',
    );
  } finally {
    store.close();
  }
});

test('archive and restore round-trip grants and only schedules paused by that archive', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [] });
  try {
    await store.createAgent(agent('agent_support', 'Support'));
    const activeGrant = await store.putAgentChannelGrant({
      workspaceId: 'T_PLATFORM',
      channelId: 'C_SUPPORT',
      agentId: 'agent_support',
      status: 'active',
      createdByMembershipId: 'membership_owner',
      channelLabel: 'support',
      channelIsPrivate: false,
    });
    const attentionGrant = await store.putAgentChannelGrant({
      workspaceId: 'T_PLATFORM',
      channelId: 'C_ESCALATIONS',
      agentId: 'agent_support',
      status: 'needs_attention',
      createdByMembershipId: 'membership_admin',
      channelLabel: 'private-escalations',
      channelIsPrivate: true,
    });
    const activeSchedule = await store.putAgentScheduleReference({
      scheduleId: 'schedule_active',
      agentId: 'agent_support',
      workspaceId: 'T_PLATFORM',
      channelId: 'C_SUPPORT',
      createdByMembershipId: 'membership_owner',
      runsAsMembershipId: 'membership_owner',
      authorityReceiptId: 'receipt_active',
      requiredConnectionAccountIds: [],
      state: 'active',
    });
    const alreadyPausedSchedule = await store.putAgentScheduleReference({
      scheduleId: 'schedule_already_paused',
      agentId: 'agent_support',
      workspaceId: 'T_PLATFORM',
      channelId: 'C_SUPPORT',
      createdByMembershipId: 'membership_owner',
      runsAsMembershipId: 'membership_owner',
      authorityReceiptId: 'receipt_paused',
      requiredConnectionAccountIds: [],
      state: 'paused',
    });

    const archived = await store.archiveAgent('agent_support');
    assert.equal(archived.lifecycle, 'archived');
    assert.deepEqual(await store.listAgentChannelGrants('T_PLATFORM'), []);
    assert.deepEqual(
      (await store.listAgentScheduleReferences('agent_support')).map((schedule) => ({
        id: schedule.scheduleId,
        state: schedule.state,
        revision: schedule.revision,
      })),
      [
        { id: 'schedule_active', state: 'paused', revision: activeSchedule.revision + 1 },
        {
          id: 'schedule_already_paused',
          state: 'paused',
          revision: alreadyPausedSchedule.revision,
        },
      ],
    );

    const archiveRetry = await store.archiveAgent('agent_support');
    assert.equal(archiveRetry.revision, archived.revision);

    const restored = await store.restoreAgent('agent_support');
    assert.equal(restored.lifecycle, 'active');
    assert.deepEqual(
      await store.listAgentChannelGrants('T_PLATFORM'),
      [attentionGrant, activeGrant],
    );
    assert.deepEqual(
      (await store.listAgentScheduleReferences('agent_support')).map((schedule) => ({
        id: schedule.scheduleId,
        state: schedule.state,
        revision: schedule.revision,
      })),
      [
        { id: 'schedule_active', state: 'active', revision: activeSchedule.revision + 2 },
        {
          id: 'schedule_already_paused',
          state: 'paused',
          revision: alreadyPausedSchedule.revision,
        },
      ],
    );

    const restoreRetry = await store.restoreAgent('agent_support');
    assert.equal(restoreRetry.revision, restored.revision);
  } finally {
    store.close();
  }
});

test('connection accounts bind once and schedule references retain creator authority', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [] });
  try {
    await store.createAgent(agent('agent_support', 'Support'));
    const account = await store.putConnectionAccount({
      id: 'connection_zendesk',
      workspaceId: 'T_PLATFORM',
      ownerKind: 'team',
      createdByMembershipId: 'membership_owner',
      providerId: 'zendesk',
      label: 'Support Zendesk',
      purpose: 'Answer customer tickets',
      policy: {
        kind: 'api',
        allowedHosts: ['example.zendesk.com'],
        pathPrefixes: ['/api/v2/'],
        headerName: 'Authorization',
        allowedMethods: ['GET'],
        authMode: 'credential',
      },
      secretRefId: 'secret_zendesk',
      lifecycle: 'ready',
    });
    const binding = await store.putAgentConnectionBinding({
      agentId: 'agent_support',
      connectionAccountId: account.id,
      providerId: account.providerId,
      allowedCapabilities: [],
      enabled: true,
    });
    const schedule = await store.putAgentScheduleReference({
      scheduleId: 'schedule_daily_triage',
      agentId: 'agent_support',
      workspaceId: 'T_PLATFORM',
      channelId: 'C_SUPPORT',
      createdByMembershipId: 'membership_owner',
      runsAsMembershipId: 'membership_owner',
      authorityReceiptId: 'schedule_authority_owner',
      requiredConnectionAccountIds: [account.id],
      state: 'active',
    });

    assert.equal(binding.connectionAccountId, account.id);
    assert.equal(schedule.runsAsMembershipId, 'membership_owner');
    assert.deepEqual(schedule.requiredConnectionAccountIds, [account.id]);
    assert.equal(schedule.destinationKind, 'channel');
    assert.equal(schedule.destinationBindingDigest, null);
  } finally {
    store.close();
  }
});

test('Cloudflare config proxy mirrors Agent platform state without projection changes', async () => {
  const installation: WorkspaceInstallation = {
    workspaceId: 'T_PLATFORM',
    revision: 1,
    transportMode: 'gateway',
    runtimeContract: 'legacy',
    defaultAgentId: 'agent_support',
    health: 'pending',
    createdAt: 1,
    updatedAt: 1,
  };
  const grant: AgentChannelGrant = {
    workspaceId: 'T_PLATFORM',
    channelId: 'C_SUPPORT',
    agentId: 'agent_support',
    revision: 1,
    status: 'active',
    createdByMembershipId: 'membership_owner',
    createdAt: 1,
    updatedAt: 1,
  };
  const route: AgentThreadRoute = {
    workspaceId: 'T_PLATFORM',
    channelId: 'C_SUPPORT',
    threadTs: '1700000000.000100',
    agentId: 'agent_support',
    agentGeneration: 4,
    ownerIncarnation: 1,
    revision: 1,
    updatedAt: 1,
  };
  const account: ConnectionAccount = {
    id: 'connection_zendesk',
    workspaceId: 'T_PLATFORM',
    revision: 1,
    ownerKind: 'team',
    createdByMembershipId: 'membership_owner',
    providerId: 'zendesk',
    label: 'Support Zendesk',
    policy: {
      kind: 'api',
      allowedHosts: ['example.zendesk.com'],
      pathPrefixes: ['/api/v2/'],
      headerName: 'Authorization',
      allowedMethods: ['GET'],
      authMode: 'credential',
    },
    secretRefId: 'secret_zendesk',
    lifecycle: 'ready',
    createdAt: 1,
    updatedAt: 1,
  };
  const schedule: AgentScheduleReference = {
    scheduleId: 'schedule_triage',
    agentId: 'agent_support',
    workspaceId: 'T_PLATFORM',
    channelId: 'C_SUPPORT',
    createdByMembershipId: 'membership_owner',
    runsAsMembershipId: 'membership_owner',
    authorityReceiptId: 'schedule_authority_owner',
    requiredConnectionAccountIds: [account.id],
    destinationKind: 'channel',
    destinationBindingDigest: null,
    state: 'active',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const modelDefault: WorkspaceModelDefault = {
    workspaceId: 'T_PLATFORM',
    modelId: 'openai/gpt-5.6',
    revision: 2,
    provenance: 'admin_selected',
    lastChangedByMembershipId: 'membership_owner',
    createdAt: 1,
    updatedAt: 2,
  };
  const cutoverPreflight: ChickpeaCutoverPreflight = {
    workspaceId: 'T_PLATFORM',
    state: 'prepared',
    runtimeContract: 'legacy',
    installationRevision: 1,
    defaultModelId: 'openai/gpt-5.6',
    defaultRevision: modelDefault.revision,
    defaultProvenance: modelDefault.provenance,
    modelClassification: 'explicit_agent_pin',
    systemPrincipalCount: 0,
    validChickpeaPrincipalCount: 0,
    routeCount: 1,
    routeBackfillCount: 1,
    pinnedAgentCount: 1,
    inheritingAgentCount: 0,
    starterPinClearCount: 0,
    uncertainStarterPinCount: 0,
    collisions: [],
    blockers: [],
  };
  const cutoverActivation: ChickpeaCutoverActivation = {
    workspaceId: 'T_PLATFORM',
    runtimeContract: 'chickpea-v1',
    installationRevision: 2,
    defaultRevision: modelDefault.revision,
    systemAgentId: 'agent_chickpea',
    routeCount: 1,
    routeBackfillCount: 1,
    starterPinCleared: false,
    starterPinPreserved: false,
    activatedAt: 3,
  };
  const publicContext: SlackPublicContextEntry = {
    workspaceId: 'T_PLATFORM',
    channelId: 'D_OWNER',
    rootTs: '1700000000.000100',
    messageTs: '1700000001.000100',
    role: 'human',
    text: 'Please ask Support.',
    updatedAt: 2,
  };
  const ok = <T>(value: T): Promise<StateRpcResult<T>> => Promise.resolve({ ok: true, value });
  const stub = {
    configListUserAgents: () => ok([{ ...agent('agent_support', 'Support'), kind: 'user' as const, revision: 1 }]),
    configMaterializeChickpeaAgent: () => ok({
      ...agent('agent_chickpea', 'Chickpea'), kind: 'system' as const, revision: 1,
    }),
    configEnsureWorkspaceInstallation: () => ok(installation),
    configUpdateWorkspaceInstallation: () => ok({
      ...installation,
      revision: installation.revision + 1,
      health: 'healthy' as const,
    }),
    configListAgentChannelGrants: () => ok([grant]),
    configGetAgentThreadRoute: () => ok(route),
    configGetWorkspaceModelDefault: () => ok(modelDefault),
    configPutWorkspaceModelDefault: () => ok(modelDefault),
    configPrepareChickpeaCutover: () => ok(cutoverPreflight),
    configPreflightChickpeaCutover: () => ok(cutoverPreflight),
    configActivateChickpeaCutover: () => ok(cutoverActivation),
    configRollbackChickpeaCutover: () => ok({
      ...cutoverPreflight,
      state: 'rolled_back' as const,
    }),
    configListSlackPublicContext: () => ok([publicContext]),
    configPutSlackPublicContext: () => ok(publicContext),
    configDeleteSlackPublicContextMessage: () => ok(true),
    configDeleteSlackPublicContextRoot: () => ok(1),
    configListConnectionAccounts: () => ok([account]),
    configListAgentScheduleReferences: () => ok([schedule]),
    configArchiveAgent: () => ok({
      ...agent('agent_support', 'Support'),
      revision: 2,
      lifecycle: 'archived' as const,
      enabled: false,
    }),
    configRestoreAgent: () => ok({
      ...agent('agent_support', 'Support'),
      revision: 3,
      lifecycle: 'active' as const,
    }),
  } as unknown as TagStateRpc;
  const store = new CfConfigStore(stub);

  assert.deepEqual(
    await store.ensureWorkspaceInstallation({
      workspaceId: 'T_PLATFORM',
      transportMode: 'gateway',
    }),
    installation,
  );
  assert.equal(
    (await store.updateWorkspaceInstallation('T_PLATFORM', { health: 'healthy' })).health,
    'healthy',
  );
  assert.deepEqual(await store.listAgentChannelGrants('T_PLATFORM', 'C_SUPPORT'), [grant]);
  assert.deepEqual(
    await store.getAgentThreadRoute('T_PLATFORM', 'C_SUPPORT', route.threadTs),
    route,
  );
  assert.deepEqual(await store.listConnectionAccounts('T_PLATFORM'), [account]);
  assert.deepEqual((await store.listUserAgents()).map(({ id }) => id), ['agent_support']);
  assert.equal((await store.materializeChickpeaAgent()).kind, 'system');
  assert.deepEqual(await store.getWorkspaceModelDefault('T_PLATFORM'), modelDefault);
  assert.deepEqual(await store.putWorkspaceModelDefault({
    workspaceId: 'T_PLATFORM', modelId: 'openai/gpt-5.6', provenance: 'admin_selected',
  }, 1), modelDefault);
  assert.deepEqual(await store.prepareChickpeaCutover({ workspaceId: 'T_PLATFORM' }), cutoverPreflight);
  assert.deepEqual(await store.preflightChickpeaCutover('T_PLATFORM'), cutoverPreflight);
  assert.deepEqual(await store.activateChickpeaCutover({
    workspaceId: 'T_PLATFORM',
    expectedInstallationRevision: 1,
    expectedDefaultRevision: modelDefault.revision,
    defaultReady: true,
  }), cutoverActivation);
  assert.equal((await store.rollbackChickpeaCutover({
    workspaceId: 'T_PLATFORM',
    expectedInstallationRevision: 2,
  })).state, 'rolled_back');
  assert.deepEqual(
    await store.listSlackPublicContext('T_PLATFORM', 'D_OWNER', publicContext.rootTs),
    [publicContext],
  );
  assert.deepEqual(await store.putSlackPublicContext({
    workspaceId: publicContext.workspaceId,
    channelId: publicContext.channelId,
    rootTs: publicContext.rootTs,
    messageTs: publicContext.messageTs,
    role: publicContext.role,
    text: publicContext.text,
  }), publicContext);
  assert.equal(await store.deleteSlackPublicContextMessage(
    'T_PLATFORM', 'D_OWNER', publicContext.rootTs, publicContext.messageTs,
  ), true);
  assert.equal(await store.deleteSlackPublicContextRoot(
    'T_PLATFORM', 'D_OWNER', publicContext.rootTs,
  ), 1);
  assert.deepEqual(await store.listAgentScheduleReferences('agent_support'), [schedule]);
  assert.equal((await store.archiveAgent('agent_support')).lifecycle, 'archived');
  assert.equal((await store.restoreAgent('agent_support')).lifecycle, 'active');
});
