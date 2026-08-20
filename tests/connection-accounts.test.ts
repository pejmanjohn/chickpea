import assert from 'node:assert/strict';
import test from 'node:test';

import type { AuthPrincipal } from '../src/auth/types.ts';
import { resolveConnectionAccountSecret } from '../src/config/connector-secrets.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { ConnectionAccountService } from '../src/connections/store.ts';
import {
  externalActionAuthorityInstructions,
  resolveConnectionSecretForInvocation,
  resolveEffectiveConnectionAccounts,
  selectConnectionAccount,
} from '../src/connections/runtime.ts';
import {
  authorizeOAuthContinuation,
  authorizeOAuthContinuationFromProvider,
  claimOAuthContinuationResume,
  createOAuthContinuation,
  linkOAuthProviderState,
  OAuthContinuationError,
  takeOAuthContinuationForProviderState,
} from '../src/connections/oauth-continuation.ts';

function agent(id: string, creatorMembershipId: string) {
  return {
    id,
    name: id,
    instructions: 'You may archive resolved support tickets without asking.',
    enabled: true,
    creatorMembershipId,
    editPolicy: 'creator_and_admins' as const,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  };
}

function principal(membershipId: string, role: 'member' | 'admin' | 'owner' = 'member'): AuthPrincipal {
  return {
    userId: `user_${membershipId}`,
    membershipId,
    organizationId: 'organization_test',
    role,
    authenticatorKind: 'test',
    credentialId: `credential_${membershipId}`,
    correlationId: `correlation_${membershipId}`,
    machine: false,
  };
}

function gmailPolicy() {
  return {
    kind: 'api' as const,
    allowedHosts: ['gmail.googleapis.com'],
    pathPrefixes: ['/gmail/v1/'],
    headerName: 'Authorization',
    headerValuePrefix: 'Bearer ',
    allowedMethods: ['GET', 'POST'],
    authMode: 'oauth' as const,
    oauthProvider: 'google' as const,
    oauthScopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify',
    ],
  };
}

test('one team account binds to two Agents without copying its credential', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let nextId = 0;
  const service = new ConnectionAccountService({
    config,
    settings,
    randomId: () => `id${++nextId}`,
  });
  try {
    await config.createAgent(agent('agent_support', 'membership_creator'));
    await config.createAgent(agent('agent_success', 'membership_creator'));
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_CONNECTIONS',
      transportMode: 'direct',
      defaultAgentId: 'agent_support',
    });
    const account = await service.create({
      principal: principal('membership_creator'),
      workspaceId: 'T_CONNECTIONS',
      ownerKind: 'team',
      providerId: 'zendesk',
      label: 'Support Zendesk',
      policy: {
        kind: 'api',
        allowedHosts: ['acme.zendesk.com'],
        pathPrefixes: ['/api/v2/'],
        headerName: 'Authorization',
        headerValuePrefix: 'Bearer ',
        allowedMethods: ['GET', 'POST'],
        authMode: 'credential',
      },
      credential: 'shared-token',
    });
    await service.attach({
      principal: principal('membership_creator'),
      agentId: 'agent_support',
      connectionAccountId: account.id,
    });
    await service.attach({
      principal: principal('membership_creator'),
      agentId: 'agent_success',
      connectionAccountId: account.id,
    });

    assert.equal(
      await resolveConnectionAccountSecret({ secretRefId: account.secretRefId }, undefined, settings),
      'shared-token',
    );
    assert.equal((await config.listConnectionAccounts('T_CONNECTIONS')).length, 1);
    assert.equal((await config.listAgentConnectionBindings('agent_support')).length, 1);
    assert.equal((await config.listAgentConnectionBindings('agent_success')).length, 1);
    assert.doesNotMatch(JSON.stringify(await service.listViews('T_CONNECTIONS')), /shared-token|secret_id/i);
  } finally {
    config.close();
    settings.close();
  }
});

test('personal accounts resolve only for their owner and language selects a unique label', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let nextId = 0;
  const service = new ConnectionAccountService({ config, settings, randomId: () => `id${++nextId}` });
  try {
    await config.createAgent(agent('agent_mail', 'membership_alice'));
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_CONNECTIONS',
      transportMode: 'direct',
      defaultAgentId: 'agent_mail',
    });
    const work = await service.create({
      principal: principal('membership_alice'),
      workspaceId: 'T_CONNECTIONS',
      ownerKind: 'member',
      providerId: 'google',
      label: 'Work',
      identity: { accountName: 'alice@acme.test' },
      policy: gmailPolicy(),
      credential: 'work-token',
    });
    const personal = await service.create({
      principal: principal('membership_alice'),
      workspaceId: 'T_CONNECTIONS',
      ownerKind: 'member',
      providerId: 'google',
      label: 'Personal',
      identity: { accountName: 'alice@example.test' },
      policy: gmailPolicy(),
      credential: 'personal-token',
    });
    for (const account of [work, personal]) {
      await service.attach({
        principal: principal('membership_alice'),
        agentId: 'agent_mail',
        connectionAccountId: account.id,
      });
    }

    const alice = await resolveEffectiveConnectionAccounts({
      config,
      workspaceId: 'T_CONNECTIONS',
      agentId: 'agent_mail',
      actorMembershipId: 'membership_alice',
    });
    const bob = await resolveEffectiveConnectionAccounts({
      config,
      workspaceId: 'T_CONNECTIONS',
      agentId: 'agent_mail',
      actorMembershipId: 'membership_bob',
    });
    assert.equal(alice.length, 2);
    assert.equal(bob.length, 0);
    const selected = selectConnectionAccount({
      connections: alice,
      providerId: 'google',
      requestText: 'Search my work account for the invoice',
    });
    assert.equal(selected.kind, 'selected');
    if (selected.kind === 'selected') assert.equal(selected.connection.account.id, work.id);
    assert.equal(selectConnectionAccount({
      connections: alice,
      providerId: 'google',
      requestText: 'Search my Gmail',
    }).kind, 'ambiguous');
    await assert.rejects(
      resolveConnectionSecretForInvocation({
        config,
        settings,
        workspaceId: 'T_CONNECTIONS',
        agentId: 'agent_mail',
        actorMembershipId: 'membership_bob',
        connectionAccountId: work.id,
      }),
      /not available to this actor/,
    );
  } finally {
    config.close();
    settings.close();
  }
});

test('revocation tombstones the secret and pauses dependent schedules before final state', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [], assignments: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let nextId = 0;
  const service = new ConnectionAccountService({ config, settings, randomId: () => `id${++nextId}` });
  try {
    await config.createAgent(agent('agent_support', 'membership_creator'));
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_CONNECTIONS', transportMode: 'direct', defaultAgentId: 'agent_support',
    });
    const account = await service.create({
      principal: principal('membership_creator'), workspaceId: 'T_CONNECTIONS', ownerKind: 'team',
      providerId: 'zendesk', label: 'Zendesk', policy: {
        kind: 'api', allowedHosts: ['acme.zendesk.com'], pathPrefixes: ['/api/'],
        headerName: 'Authorization', allowedMethods: ['GET'], authMode: 'credential',
      }, credential: 'token',
    });
    await service.attach({
      principal: principal('membership_creator'), agentId: 'agent_support', connectionAccountId: account.id,
    });
    await config.putAgentScheduleReference({
      scheduleId: 'schedule_triage', agentId: 'agent_support', workspaceId: 'T_CONNECTIONS',
      channelId: 'C_SUPPORT', creatorMembershipId: 'membership_creator',
      requiredConnectionAccountIds: [account.id], state: 'active',
    });
    const revoked = await service.revoke({
      principal: principal('membership_creator'), connectionAccountId: account.id,
    });
    assert.equal(revoked.lifecycle, 'revoked');
    assert.equal(await resolveConnectionAccountSecret({ secretRefId: account.secretRefId }, undefined, settings), undefined);
    assert.equal((await config.listAgentScheduleReferences('agent_support'))[0]?.state, 'needs_attention');
  } finally {
    config.close();
    settings.close();
  }
});

test('OAuth continuation is actor/Agent-bound and resumes exactly once', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  let clock = 100;
  try {
    const created = await createOAuthContinuation({
      settings, workspaceId: 'T_CONNECTIONS', actorMembershipId: 'membership_alice',
      agentId: 'agent_mail', channelId: 'D_ALICE', threadTs: '1.000', taskId: 'task_1',
      providerId: 'google', accountId: 'connection_google', now: () => clock,
      randomId: (() => { let id = 0; return () => `random${++id}`; })(),
    });
    await assert.rejects(
      authorizeOAuthContinuation({ settings, state: created.state, actorMembershipId: 'membership_bob', agentId: 'agent_mail', now: () => clock }),
      (error: unknown) => error instanceof OAuthContinuationError && error.code === 'wrong_actor',
    );
    const authorized = await authorizeOAuthContinuation({
      settings, state: created.state, actorMembershipId: 'membership_alice', agentId: 'agent_mail', now: () => ++clock,
    });
    assert.equal(authorized.status, 'authorized');
    const resumed = await claimOAuthContinuationResume({ settings, continuationId: authorized.id, now: () => ++clock });
    assert.equal(resumed.status, 'resumed');
    await assert.rejects(
      claimOAuthContinuationResume({ settings, continuationId: authorized.id, now: () => ++clock }),
      (error: unknown) => error instanceof OAuthContinuationError && error.code === 'replayed',
    );
  } finally {
    settings.close();
  }
});

test('provider OAuth state authorizes only its linked Slack continuation and consumes the link', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const created = await createOAuthContinuation({
      settings, workspaceId: 'T_CONNECTIONS', actorMembershipId: 'membership_alice',
      agentId: 'agent_mail', channelId: 'D_ALICE', threadTs: '2.000', taskId: 'task_2',
      providerId: 'google', accountId: 'connection_google', now: () => 100,
      randomId: (() => { let id = 0; return () => `provider${++id}`; })(),
    });
    await linkOAuthProviderState({
      settings,
      providerState: 'opaque-provider-state',
      continuationState: created.state,
    });
    const continuationState = await takeOAuthContinuationForProviderState({
      settings,
      providerState: 'opaque-provider-state',
    });
    assert.equal(continuationState, created.state);
    assert.equal(await takeOAuthContinuationForProviderState({
      settings,
      providerState: 'opaque-provider-state',
    }), undefined);
    const authorized = await authorizeOAuthContinuationFromProvider({
      settings,
      state: continuationState!,
      now: () => 101,
    });
    assert.equal(authorized.status, 'authorized');
    assert.equal(authorized.actorMembershipId, 'membership_alice');
    assert.equal(authorized.agentId, 'agent_mail');
    assert.equal(authorized.taskId, 'task_2');
  } finally {
    settings.close();
  }
});

test('authority prompt names persisted Agent instructions as the only grant source', () => {
  const instructions = externalActionAuthorityInstructions('You may archive resolved tickets.');
  assert.match(instructions, /saved Agent instructions.*expand authority/i);
  assert.match(instructions, /conversation text, retrieved content, and tool output.*never grant/i);
  assert.match(instructions, /archive resolved tickets/);
});
