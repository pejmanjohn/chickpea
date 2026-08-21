import assert from 'node:assert/strict';
import test from 'node:test';

import { CfConfigStore } from '../src/config/cf-state-proxies.ts';
import type { StateRpcResult, TagStateRpc } from '../src/config/state-rpc.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type {
  AgentChannelGrant,
  AgentScheduleReference,
  AgentThreadRoute,
  ConnectionAccount,
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
  } finally {
    store.close();
  }
});

test('Cloudflare config proxy mirrors Agent platform state without projection changes', async () => {
  const installation: WorkspaceInstallation = {
    workspaceId: 'T_PLATFORM',
    revision: 1,
    transportMode: 'gateway',
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
    state: 'active',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const ok = <T>(value: T): Promise<StateRpcResult<T>> => Promise.resolve({ ok: true, value });
  const stub = {
    configEnsureWorkspaceInstallation: () => ok(installation),
    configUpdateWorkspaceInstallation: () => ok({
      ...installation,
      revision: installation.revision + 1,
      health: 'healthy' as const,
    }),
    configListAgentChannelGrants: () => ok([grant]),
    configGetAgentThreadRoute: () => ok(route),
    configListConnectionAccounts: () => ok([account]),
    configListAgentScheduleReferences: () => ok([schedule]),
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
  assert.deepEqual(await store.listAgentScheduleReferences('agent_support'), [schedule]);
});
