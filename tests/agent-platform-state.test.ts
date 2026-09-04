import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { CfConfigStore } from '../src/config/cf-state-proxies.ts';
import {
  ConnectionAccountAlreadyBoundError,
  ManagedRemoteAccountAlreadyUsedError,
} from '../src/config/errors.ts';
import type { StateRpcResult, TagStateRpc } from '../src/config/state-rpc.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { createDemoStarterAgent } from '../src/config/seed.ts';
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

test('a fresh install seeds no user Agent and makes Chickpea the installation default', async () => {
  const store = new SqliteConfigStore(':memory:');
  try {
    assert.deepEqual(await store.listUserAgents(), []);
    const installation = await store.ensureWorkspaceInstallation({
      workspaceId: 'T_PLATFORM',
      transportMode: 'direct',
    });
    const agents = await store.listAgents();

    assert.equal(installation.runtimeContract, 'chickpea-v1');
    assert.equal(installation.defaultAgentId, 'agent_chickpea');
    assert.deepEqual(agents.map(({ id, kind }) => ({ id, kind })), [
      { id: 'agent_chickpea', kind: 'system' },
    ]);
    assert.deepEqual(await store.listUserAgents(), []);
    assert.equal((await store.preflightChickpeaCutover('T_PLATFORM')).state, 'activated');
  } finally {
    store.close();
  }
});

test('a compatibility install still requires and designates one user default Agent', async () => {
  const store = new SqliteConfigStore(':memory:');
  try {
    await assert.rejects(
      store.ensureWorkspaceInstallation({
        workspaceId: 'T_PLATFORM',
        transportMode: 'direct',
        runtimeContract: 'legacy',
      }),
      /requires an active Agent/,
    );
    await store.createAgent(createDemoStarterAgent());
    const installation = await store.ensureWorkspaceInstallation({
      workspaceId: 'T_PLATFORM',
      transportMode: 'direct',
      runtimeContract: 'legacy',
    });
    assert.equal(installation.runtimeContract, 'legacy');
    assert.equal(installation.defaultAgentId, 'agent_default');
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
  const store = new SqliteConfigStore(':memory:', { agents: [createDemoStarterAgent()] });
  try {
    await store.ensureWorkspaceInstallation({
      workspaceId: 'T_PLATFORM',
      transportMode: 'direct',
      runtimeContract: 'legacy',
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
    await store.createAgent(agent('agent_sales', 'Sales'));
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
    assert.deepEqual(
      await store.getAgentConnectionBindingForAccount(account.id),
      binding,
    );
    assert.equal(
      await store.getAgentConnectionBindingForAccount('connection_unbound'),
      undefined,
    );
    await assert.rejects(
      store.putAgentConnectionBinding({
        ...binding,
        agentId: 'agent_sales',
      }),
      (error: unknown) => {
        assert.ok(error instanceof ConnectionAccountAlreadyBoundError);
        assert.equal(error.accountId, account.id);
        assert.equal(error.agentId, 'agent_support');
        return true;
      },
    );
    await store.putAgentConnectionBinding({ ...binding, enabled: false });
    await assert.rejects(
      store.putAgentConnectionBinding({
        ...binding,
        agentId: 'agent_sales',
      }),
      /already belongs to Agent agent_support/,
      'a disabled binding must continue to reserve its connection account',
    );
    assert.equal(schedule.runsAsMembershipId, 'membership_owner');
    assert.deepEqual(schedule.requiredConnectionAccountIds, [account.id]);
    assert.equal(schedule.destinationKind, 'channel');
    assert.equal(schedule.destinationBindingDigest, null);
    await assert.rejects(
      store.putAgentScheduleReference({
        scheduleId: schedule.scheduleId,
        agentId: 'agent_sales',
        workspaceId: schedule.workspaceId,
        channelId: schedule.channelId,
        createdByMembershipId: schedule.createdByMembershipId,
        runsAsMembershipId: schedule.runsAsMembershipId,
        authorityReceiptId: schedule.authorityReceiptId,
        requiredConnectionAccountIds: schedule.requiredConnectionAccountIds,
        state: schedule.state,
      }, schedule.revision),
      /reassignment requires a new receipt/,
    );
  } finally {
    store.close();
  }
});

test('connection binding ownership is atomic and workspace-scoped', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [] });
  try {
    await store.createAgent(agent('agent_support', 'Support'));
    await store.createAgent(agent('agent_sales', 'Sales'));
    await store.ensureWorkspaceInstallation({
      workspaceId: 'T_PLATFORM',
      transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    const account = await store.putConnectionAccount({
      id: 'connection_shared_race',
      workspaceId: 'T_PLATFORM',
      ownerKind: 'team',
      createdByMembershipId: 'membership_owner',
      providerId: 'zendesk',
      label: 'Race candidate',
      policy: {
        kind: 'api',
        allowedHosts: ['example.zendesk.com'],
        pathPrefixes: ['/api/v2/'],
        headerName: 'Authorization',
        allowedMethods: ['GET'],
        authMode: 'credential',
      },
      secretRefId: 'secret_race',
      lifecycle: 'ready',
    });
    const results = await Promise.allSettled([
      store.putAgentConnectionBinding({
        agentId: 'agent_support',
        connectionAccountId: account.id,
        providerId: account.providerId,
        allowedCapabilities: [],
        enabled: true,
      }),
      store.putAgentConnectionBinding({
        agentId: 'agent_sales',
        connectionAccountId: account.id,
        providerId: account.providerId,
        allowedCapabilities: [],
        enabled: true,
      }),
    ]);
    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
    const rejection = results.find(({ status }) => status === 'rejected');
    assert.ok(rejection?.status === 'rejected');
    assert.ok(rejection.reason instanceof ConnectionAccountAlreadyBoundError);
    assert.equal(
      (await store.getAgentConnectionBindingForAccount(account.id))?.agentId,
      'agent_support',
    );

    const foreignAccount = await store.putConnectionAccount({
      ...account,
      id: 'connection_foreign_workspace',
      workspaceId: 'T_OTHER',
      secretRefId: 'secret_foreign',
    });
    await assert.rejects(
      store.putAgentConnectionBinding({
        agentId: 'agent_support',
        connectionAccountId: foreignAccount.id,
        providerId: foreignAccount.providerId,
        allowedCapabilities: [],
        enabled: true,
      }),
      /belongs to workspace T_OTHER, not T_PLATFORM/,
    );
  } finally {
    store.close();
  }
});

test('managed remote account references are committed only once', async () => {
  const store = new SqliteConfigStore(':memory:', { agents: [] });
  try {
    await store.createAgent(agent('agent_support', 'Support'));
    await store.createAgent(agent('agent_sales', 'Sales'));
    await store.ensureWorkspaceInstallation({
      workspaceId: 'T_PLATFORM', transportMode: 'direct', defaultAgentId: 'agent_support',
    });
    const owned = (id: string, agentId: string, accountRef = 'ca_remote_once') =>
      store.createAgentOwnedConnection({
        account: {
          id,
          workspaceId: 'T_PLATFORM',
          ownerKind: 'team',
          createdByMembershipId: 'membership_owner',
          providerId: 'google',
          label: 'Managed Gmail',
          policy: {
            kind: 'managed', adapterId: 'composio', toolkit: 'gmail',
            principalRef: 'chickpea:organization:T_PLATFORM', accountRef,
            allowedCapabilities: ['gmail.messages.search'],
          },
          secretRefId: `secret_${id}`,
          lifecycle: 'ready',
        },
        binding: {
          agentId,
          connectionAccountId: id,
          providerId: 'google',
          allowedCapabilities: ['gmail.messages.search'],
          enabled: true,
        },
      });
    await owned('connection_remote_one', 'agent_support');
    await assert.rejects(
      owned('connection_remote_two', 'agent_sales'),
      ManagedRemoteAccountAlreadyUsedError,
    );
    assert.equal(
      (await store.listConnectionAccounts('T_PLATFORM')).filter(({ lifecycle }) =>
        lifecycle !== 'revoked').length,
      1,
    );
    assert.equal(
      await store.getAgentConnectionBindingForAccount('connection_remote_two'),
      undefined,
    );

    const second = await owned(
      'connection_remote_two',
      'agent_sales',
      'ca_remote_two',
    );
    assert.equal(second.account.policy.kind, 'managed');
    if (second.account.policy.kind !== 'managed') throw new Error('expected managed policy');
    await assert.rejects(
      store.putConnectionAccount({
        ...second.account,
        policy: { ...second.account.policy, accountRef: 'ca_remote_once' },
      }, second.account.revision),
      ManagedRemoteAccountAlreadyUsedError,
      'reconnect updates must use the same remote-reference guard as fresh setup',
    );
    const persisted = (await store.listConnectionAccounts('T_PLATFORM'))
      .find(({ id }) => id === second.account.id);
    assert.equal(persisted?.policy.kind, 'managed');
    if (persisted?.policy.kind === 'managed') {
      assert.equal(persisted.policy.accountRef, 'ca_remote_two');
    }
  } finally {
    store.close();
  }
});

test('schema startup fails closed instead of choosing among duplicate binding owners', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-connection-owner-'));
  const databasePath = join(directory, 'state.db');
  try {
    const store = new SqliteConfigStore(databasePath, { agents: [] });
    await store.createAgent(agent('agent_support', 'Support'));
    await store.createAgent(agent('agent_sales', 'Sales'));
    const account = await store.putConnectionAccount({
      id: 'connection_duplicate',
      workspaceId: 'T_PLATFORM',
      ownerKind: 'team',
      createdByMembershipId: 'membership_owner',
      providerId: 'zendesk',
      label: 'Duplicate candidate',
      policy: {
        kind: 'api',
        allowedHosts: ['example.zendesk.com'],
        pathPrefixes: ['/api/v2/'],
        headerName: 'Authorization',
        allowedMethods: ['GET'],
        authMode: 'credential',
      },
      secretRefId: 'secret_duplicate',
      lifecycle: 'ready',
    });
    await store.putAgentConnectionBinding({
      agentId: 'agent_support',
      connectionAccountId: account.id,
      providerId: account.providerId,
      allowedCapabilities: [],
      enabled: true,
    });
    store.close();

    const raw = new DatabaseSync(databasePath);
    raw.exec('DROP INDEX config_agent_connection_bindings_account_uidx');
    raw.exec(
      `INSERT INTO config_agent_connection_bindings (
        agent_id, connection_account_id, provider_id, allowed_capabilities_json,
        resource_constraints_json, enabled, created_at, updated_at
      ) SELECT 'agent_sales', connection_account_id, provider_id, allowed_capabilities_json,
               resource_constraints_json, enabled, created_at, updated_at
        FROM config_agent_connection_bindings WHERE agent_id = 'agent_support'`,
    );
    raw.close();

    assert.throws(
      () => new SqliteConfigStore(databasePath, { agents: [] }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /ownership preflight failed.*connection_duplicate/);
        assert.match(error.message, /agent_support/);
        assert.match(error.message, /agent_sales/);
        return true;
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
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
    configCreateAgentOwnedConnection: () => Promise.resolve({
      ok: false as const,
      error: {
        code: 'managed_remote_account_already_used' as const,
        message: 'remote account conflict',
        details: { adapterId: 'composio', accountRef: 'ca_remote_once' },
      },
    }),
    configGetAgentConnectionBindingForAccount: () => ok({
      agentId: 'agent_support',
      connectionAccountId: account.id,
      providerId: account.providerId,
      allowedCapabilities: [],
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    }),
    configPutAgentConnectionBinding: () => Promise.resolve({
      ok: false as const,
      error: {
        code: 'connection_account_already_bound' as const,
        message: 'binding conflict',
        details: { accountId: account.id, agentId: 'agent_support' },
      },
    }),
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
  assert.equal(
    (await store.getAgentConnectionBindingForAccount(account.id))?.agentId,
    'agent_support',
  );
  await assert.rejects(
    store.createAgentOwnedConnection({
      account,
      binding: {
        agentId: 'agent_support', connectionAccountId: account.id,
        providerId: account.providerId, allowedCapabilities: [], enabled: true,
      },
    }),
    ManagedRemoteAccountAlreadyUsedError,
  );
  await assert.rejects(
    store.putAgentConnectionBinding({
      agentId: 'agent_sales', connectionAccountId: account.id,
      providerId: account.providerId, allowedCapabilities: [], enabled: true,
    }),
    ConnectionAccountAlreadyBoundError,
  );
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
