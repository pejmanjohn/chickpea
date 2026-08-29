import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveConnectorCredential } from '../src/config/connector-secrets.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import {
  describeProviderKeySources,
  PROVIDER_KEY_SETTING_KEYS,
  resolveProviderApiKey,
  saveProviderApiKey,
} from '../src/config/provider-keys.ts';
import { storedCredentialMetadata } from '../src/config/model-credential-refs.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { formatManagementSetupReceipt } from '../src/management/receipts.ts';
import { WorkspaceManagementService } from '../src/management/service.ts';
import { createManagementSetupRoutes } from '../src/management/setup-routes.ts';
import { SqliteManagementStore } from '../src/management/store.ts';
import {
  ManagementError,
  type ApplyWorkspaceChangesResult,
  type ManagementApplyResult,
} from '../src/management/types.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const START = 1_800_100_000_000;
const CAPABILITY = 'c'.repeat(43);

function requireMutationResult(
  result: ApplyWorkspaceChangesResult,
): asserts result is ManagementApplyResult {
  assert.notEqual(result.status, 'clarification_required');
}

function browserPrincipal(actor: {
  user: { id: string };
  membership: { id: string; organizationId: string; role: AuthPrincipal['role'] };
}): AuthPrincipal {
  return {
    userId: actor.user.id,
    membershipId: actor.membership.id,
    organizationId: actor.membership.organizationId,
    role: actor.membership.role,
    authenticatorKind: 'better_auth',
    credentialId: `session_${actor.membership.id}`,
    correlationId: 'setup_test',
    machine: false,
  };
}

test('the initiating member claims one authenticated browser and completes an exact connector setup', async () => {
  let now = START;
  let sequence = 0;
  const identity = new SqliteIdentityStore(':memory:', { now: () => now });
  const owner = await createSlackOwner(identity, { now, suffix: 'delegated-setup' });
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await config.createAgent({
      id: 'agent_research',
      name: 'Customer Research',
      instructions: 'Research customer questions.',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [{
        id: 'gmail',
        displayName: 'Gmail',
        allowedHosts: ['gmail.googleapis.com'],
        pathPrefixes: ['/gmail/v1'],
        headerName: 'Authorization',
        allowedMethods: ['GET'],
        enabled: true,
        authMode: 'credential',
        lifecycleStatus: 'pending',
        statusText: 'Not connected',
        presetId: 'gmail',
      }],
      repositories: [],
    });
    const service = new WorkspaceManagementService({
      identity,
      config,
      management,
      setupBaseUrl: 'http://localhost',
      now: () => now,
      randomId: () => `id_${++sequence}`,
      randomCapability: () => CAPABILITY,
    });
    const result = await service.applyWorkspaceChanges({
      context: {
        userId: owner.user.id,
        membershipId: owner.membership.id,
        organizationId: owner.membership.organizationId,
        origin: {
          kind: 'slack',
          workspaceId: owner.user.slackTeamId,
          channelId: 'C_ADMIN',
          threadTs: '1800100000.000100',
        },
      },
      idempotencyKey: 'connect_gmail',
      operations: [{
        itemId: 'gmail_setup',
        kind: 'request_setup',
        target: { kind: 'api_connection', agentId: 'agent_research', connectionId: 'gmail' },
      }],
    });
    requireMutationResult(result);
    const outcome = result.outcomes[0]!;
    assert.equal(outcome.disposition, 'setup_required');
    const setupUrl = new URL(outcome.setupUrl!);
    assert.equal(setupUrl.hash, `#setup=${CAPABILITY}`);
    const setupId = outcome.setupOperationId!;
    const durableRequest = await management.getRequest(result.operationId);
    assert.equal(durableRequest?.result?.outcomes[0]?.setupUrl, undefined);
    assert.doesNotMatch(JSON.stringify(durableRequest), new RegExp(CAPABILITY));

    const delivered: string[] = [];
    let principal: AuthPrincipal | undefined;
    const app = createManagementSetupRoutes({
      management,
      config,
      settings,
      identity,
      now: () => now,
      randomCapability: () => 's'.repeat(43),
      authenticatePrincipal: async () => principal,
      deliverReceipt: async (record) => {
        delivered.push(formatManagementSetupReceipt(record.receipt));
        return { deliveryRef: 'slack:C_ADMIN:receipt.1' };
      },
    });

    const initial = await app.request(`http://localhost/setup/${setupId}`);
    assert.equal(initial.status, 200);
    assert.match(await initial.text(), /Checking this one-use setup link/);
    assert.equal(initial.headers.get('referrer-policy'), 'no-referrer');
    assert.match(initial.headers.get('content-security-policy') ?? '', /default-src 'none'/);

    const crossOrigin = await app.request(`http://localhost/setup/${setupId}/exchange`, {
      method: 'POST',
      headers: { origin: 'https://attacker.example', 'content-type': 'application/json' },
      body: JSON.stringify({ capability: CAPABILITY }),
    });
    assert.equal(crossOrigin.status, 403);

    const signedOut = await app.request(`http://localhost/setup/${setupId}/exchange`, {
      method: 'POST',
      headers: { origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ capability: CAPABILITY }),
    });
    assert.equal(signedOut.status, 401);

    principal = {
      ...browserPrincipal(owner),
      userId: 'another_user',
      membershipId: 'another_membership',
    };
    const wrongMember = await app.request(`http://localhost/setup/${setupId}/exchange`, {
      method: 'POST',
      headers: { origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ capability: CAPABILITY }),
    });
    assert.equal(wrongMember.status, 403);

    principal = browserPrincipal(owner);

    const exchanged = await app.request(`http://localhost/setup/${setupId}/exchange`, {
      method: 'POST',
      headers: { origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ capability: CAPABILITY }),
    });
    assert.equal(exchanged.status, 200);
    const cookie = exchanged.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\/setup\//);
    assert.equal((await management.getSetup(setupId))?.tokenDigest, undefined);

    const replay = await app.request(`http://localhost/setup/${setupId}/exchange`, {
      method: 'POST',
      headers: { origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ capability: CAPABILITY }),
    });
    assert.equal(replay.status, 403);

    const summary = await app.request(`http://localhost/setup/${setupId}`, {
      headers: { cookie },
    });
    const summaryHtml = await summary.text();
    assert.match(summaryHtml, /Connect Gmail/);
    assert.match(summaryHtml, /Customer Research/);
    assert.doesNotMatch(summaryHtml, new RegExp(owner.user.id));
    assert.doesNotMatch(summaryHtml, new RegExp(CAPABILITY));

    const credential = 'credential-value-only-the-browser-sees';
    const completed = await app.request(`http://localhost/setup/${setupId}/complete`, {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ credential }).toString(),
    });
    const completedBody = completed.status === 303 ? '' : await completed.clone().text();
    assert.equal(
      completed.status,
      303,
      `${completedBody}\n${JSON.stringify({
        setup: await management.getSetup(setupId),
        agent: await config.getAgent('agent_research'),
        outbox: await management.getOutboxForOperation(setupId),
      })}`,
    );
    assert.equal(await resolveConnectorCredential(
      { agentId: 'agent_research', connectionId: 'gmail' },
      undefined,
      settings,
    ), credential);
    const agent = await config.getAgent('agent_research');
    assert.equal(agent.revision, 2);
    assert.equal(agent.apiConnections[0]?.lifecycleStatus, 'ready');
    const setup = await management.getSetup(setupId);
    assert.equal(setup?.status, 'completed');
    assert.equal(setup?.browserSessionDigest, undefined);
    assert.equal(setup?.receipt?.connector, 'Gmail');
    assert.equal(delivered.length, 1);
    assert.match(delivered[0]!, /has been connected to Gmail connector/);
    assert.match(delivered[0]!, /Customer Research/);
    assert.doesNotMatch(delivered[0]!, new RegExp(credential));
    assert.equal((await management.getOutboxForOperation(setupId))?.status, 'delivered');

    now += 24 * 60 * 60_000;
    const terminal = await app.request(`http://localhost/setup/${setupId}`);
    assert.equal(terminal.status, 200);
    assert.match(await terminal.text(), /Setup complete/);
  } finally {
    identity.close();
    config.close();
    management.close();
    settings.close();
  }
});

test('expired and revoked setup capabilities cannot be claimed or resumed', async () => {
  const store = new SqliteManagementStore(':memory:');
  try {
    const record = {
      setupOperationId: 'setup_expiry',
      organizationId: 'org_1',
      actorUserId: 'user_1',
      actorMembershipId: 'member_1',
      origin: { kind: 'mcp' as const, clientId: 'client_1' },
      action: 'provider_credential' as const,
      target: {
        kind: 'provider_credential' as const,
        provider: 'openai',
        targetId: 'provider:openai',
        targetLabel: 'Workspace OpenAI model provider',
        expectedRevision: 0,
        replacement: false,
        formFields: ['apiKey'],
      },
      scopes: ['models:openai'],
      tokenDigest: 'd'.repeat(43),
      status: 'pending' as const,
      expiresAt: START + 1,
      createdAt: START,
      updatedAt: START,
    };
    await store.putSetup({ record });
    assert.equal((await store.getSetup(record.setupOperationId, START + 1))?.status, 'expired');
    await assert.rejects(
      () => store.exchangeSetup({
        setupOperationId: record.setupOperationId,
        tokenDigest: record.tokenDigest,
        browserSessionDigest: 's'.repeat(43),
        at: START + 1,
      }),
      (error: unknown) => error instanceof Error && /expired/i.test(error.message),
    );

    await store.putSetup({
      record: { ...record, setupOperationId: 'setup_revoked', expiresAt: START + 10_000 },
    });
    await store.revokeSetup({
      setupOperationId: 'setup_revoked',
      organizationId: 'org_1',
      actorUserId: 'user_1',
      at: START + 1,
    });
    assert.equal((await store.getSetup('setup_revoked'))?.tokenDigest, undefined);
    await assert.rejects(() => store.exchangeSetup({
      setupOperationId: 'setup_revoked',
      tokenDigest: record.tokenDigest,
      browserSessionDigest: 's'.repeat(43),
      at: START + 2,
    }));
  } finally {
    store.close();
  }
});

test('an Agent-owned managed setup commits once and emits one receipt', async () => {
  const store = new SqliteManagementStore(':memory:');
  const record = {
    setupOperationId: 'setup_reusable_connector',
    organizationId: 'org_shared',
    actorUserId: 'user_issuer',
    actorMembershipId: 'member_issuer',
    origin: {
      kind: 'slack' as const,
      workspaceId: 'T_SHARED',
      channelId: 'D_SHARED',
      threadTs: '1800100000.000200',
      agentId: 'agent_sprout',
    },
    action: 'managed_connection' as const,
    target: {
      kind: 'managed_connection' as const,
      provider: 'hubspot',
      targetId: 'agent:agent_sprout:managed:hubspot:member',
      targetLabel: 'HubSpot',
      expectedRevision: 1,
      agentId: 'agent_sprout',
      agentName: 'Sprout',
      replacement: false,
      ownerKind: 'member' as const,
      accessLane: 'read' as const,
      presetId: 'hubspot',
    },
    scopes: ['hubspot.objects.search'],
    tokenDigest: 'd'.repeat(64),
    status: 'pending' as const,
    expiresAt: START + 60_000,
    createdAt: START,
    updatedAt: START,
  };
  const receipt = {
    kind: 'connector_connected' as const,
    setupOperationId: record.setupOperationId,
    connector: 'HubSpot',
    toolkit: 'hubspot',
    agentId: 'agent_sprout',
    agentName: 'Sprout',
    ownerKind: 'member' as const,
    accessLane: 'read' as const,
    completedAt: START + 1,
  };
  const outbox = {
    outboxId: `receipt_${record.setupOperationId}`,
    operationId: record.setupOperationId,
    destination: {
      kind: 'thread' as const,
      workspaceId: 'T_SHARED',
      channelId: 'D_SHARED',
      threadTs: '1800100000.000200',
    },
    receipt,
    status: 'pending' as const,
    attempts: 0,
    nextAttemptAt: START + 1,
    createdAt: START + 1,
    updatedAt: START + 1,
  };
  try {
    await store.putSetup({ record });
    const completed = await store.completeSetup({
      setupOperationId: record.setupOperationId,
      browserSessionDigest: record.tokenDigest,
      completedByUserId: 'user_first',
      completedByMembershipId: 'member_first',
      connectionAccountId: 'account_first',
      receipt,
      outbox,
      at: START + 1,
    });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.completedByUserId, 'user_first');
    assert.equal(completed.completedByMembershipId, 'member_first');
    assert.equal(completed.connectionAccountId, 'account_first');

    await assert.rejects(() => store.completeSetup({
      setupOperationId: record.setupOperationId,
      browserSessionDigest: record.tokenDigest,
      completedByUserId: 'user_second',
      completedByMembershipId: 'member_second',
      connectionAccountId: 'account_second',
      receipt: { ...receipt, completedAt: START + 2 },
      outbox: { ...outbox, updatedAt: START + 2 },
      at: START + 2,
    }), (error: unknown) => error instanceof ManagementError &&
      error.code === 'setup_unavailable');

    assert.equal((await store.getSetup(record.setupOperationId))?.connectionAccountId, 'account_first');
    assert.equal((await store.getOutboxForOperation(record.setupOperationId))?.outboxId, outbox.outboxId);
  } finally {
    store.close();
  }
});

test('public setup routes reject oversized streamed bodies before buffering', async () => {
  const management = new SqliteManagementStore(':memory:');
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const app = createManagementSetupRoutes({ management, config, settings });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(20 * 1024));
        controller.close();
      },
    });
    const response = await app.request(new Request('http://localhost/setup/setup_missing/exchange', {
      method: 'POST',
      headers: { origin: 'http://localhost', 'content-type': 'application/json' },
      body,
      // @ts-expect-error undici requires duplex for streamed request bodies
      duplex: 'half',
    }));
    assert.equal(response.status, 413);
  } finally {
    management.close();
    config.close();
    settings.close();
  }
});

test('stored provider replacement requires confirmation and reissue invalidates the old link', async () => {
  let now = START;
  let sequence = 0;
  let capabilitySequence = 0;
  const identity = new SqliteIdentityStore(':memory:', { now: () => now });
  const owner = await createSlackOwner(identity, { now, suffix: 'provider-replacement' });
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  try {
    const service = new WorkspaceManagementService({
      identity,
      config,
      management,
      setupBaseUrl: 'https://chickpea.example',
      providerCredentialSource: async () => 'stored',
      now: () => now,
      randomId: () => `replacement_${++sequence}`,
      randomCapability: () => String(++capabilitySequence).padStart(43, 'a'),
    });
    const context = {
      userId: owner.user.id,
      membershipId: owner.membership.id,
      organizationId: owner.membership.organizationId,
      origin: { kind: 'mcp' as const, clientId: 'codex' },
    };
    const proposed = await service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'replace_openai',
      operations: [{
        itemId: 'provider',
        kind: 'request_setup',
        target: { kind: 'provider_credential', providerId: 'openai' },
      }],
    });
    requireMutationResult(proposed);
    assert.equal(proposed.status, 'confirmation_required');
    assert.equal(proposed.outcomes[0]?.setupUrl, undefined);

    now += 1;
    const confirmed = await service.confirmWorkspaceChange({
      context,
      proposalId: proposed.outcomes[0]!.proposalId!,
    });
    assert.equal(confirmed.outcomes[0]?.disposition, 'setup_required');
    const firstId = confirmed.outcomes[0]!.setupOperationId!;
    const firstUrl = confirmed.outcomes[0]!.setupUrl!;
    assert.match(firstUrl, /#setup=/);
    assert.equal((await management.getSetup(firstId))?.target.replacement, true);

    now += 1;
    const reissued = await service.revokeSetupLink(context, firstId, true);
    assert.equal(reissued.revoked.status, 'revoked');
    assert.ok(reissued.replacement);
    assert.notEqual(reissued.replacement!.setupOperationId, firstId);
    assert.notEqual(reissued.replacement!.setupUrl, firstUrl);
    assert.equal(
      (await management.getSetup(reissued.replacement!.setupOperationId))?.supersedesSetupOperationId,
      firstId,
    );
  } finally {
    identity.close();
    config.close();
    management.close();
  }
});

test('management provider impact includes the Workspace default and inheriting Agents', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => START });
  const owner = await createSlackOwner(identity, { now: START, suffix: 'provider-impact' });
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  try {
    const agent = await config.createAgent({
      id: 'agent_support', name: 'Support', instructions: 'Help.', enabled: true,
      lifecycle: 'active', skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    const installation = await config.ensureWorkspaceInstallation({
      workspaceId: owner.user.slackTeamId,
      transportMode: 'direct',
      defaultAgentId: agent.id,
    });
    await config.putWorkspaceModelDefault({
      workspaceId: installation.workspaceId,
      modelId: 'anthropic/claude-sonnet-4-6',
      provenance: 'admin_selected',
      lastChangedByMembershipId: owner.membership.id,
    }, 1);
    await config.updateWorkspaceInstallation(
      installation.workspaceId,
      { runtimeContract: 'chickpea-v1' },
      installation.revision,
    );
    const service = new WorkspaceManagementService({
      identity,
      config,
      management,
      providerCredentialSource: async () => 'stored',
      randomId: () => 'provider_impact',
    });
    const context = {
      userId: owner.user.id,
      membershipId: owner.membership.id,
      organizationId: owner.membership.organizationId,
      origin: { kind: 'mcp' as const, clientId: 'codex' },
    };

    const snapshot = await service.inspectWorkspace(context);
    const anthropic = snapshot.providers.find(({ id }) => id === 'anthropic');
    assert.deepEqual(anthropic, {
      id: 'anthropic',
      source: 'stored',
      mutable: true,
      workspaceDefaultAffected: true,
      inheritingAgentCount: 1,
      affectedAgents: [{ id: 'agent_support', name: 'Support' }],
    });

    const proposed = await service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'remove_anthropic_default',
      operations: [{
        itemId: 'remove_anthropic',
        kind: 'remove_provider_credential',
        providerId: 'anthropic',
      }],
    });
    requireMutationResult(proposed);
    assert.equal(proposed.status, 'confirmation_required');
    const proposal = await management.getProposal(proposed.outcomes[0]!.proposalId!);
    assert.match(proposal?.summary ?? '', /workspace_default=affected/);
    assert.match(proposal?.summary ?? '', /Support \(agent_support\)/);
  } finally {
    identity.close();
    config.close();
    management.close();
  }
});

test('a provider key is validated in the browser lane and never enters MCP state or receipts', async () => {
  let sequence = 0;
  const identity = new SqliteIdentityStore(':memory:', { now: () => START });
  const owner = await createSlackOwner(identity, { now: START, suffix: 'provider-add' });
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const usage = new SqliteUsageStore(':memory:');
  try {
    const service = new WorkspaceManagementService({
      identity,
      config,
      management,
      setupBaseUrl: 'http://localhost',
      providerCredentialSource: async () => 'missing',
      now: () => START,
      randomId: () => `provider_${++sequence}`,
      randomCapability: () => 'p'.repeat(43),
    });
    const result = await service.applyWorkspaceChanges({
      context: {
        userId: owner.user.id,
        membershipId: owner.membership.id,
        organizationId: owner.membership.organizationId,
        origin: { kind: 'mcp', clientId: 'codex' },
      },
      idempotencyKey: 'add_openai',
      operations: [{
        itemId: 'openai',
        kind: 'request_setup',
        target: { kind: 'provider_credential', providerId: 'openai' },
      }],
    });
    requireMutationResult(result);
    assert.equal(result.outcomes[0]?.disposition, 'setup_required');
    const setupId = result.outcomes[0]!.setupOperationId!;
    const app = createManagementSetupRoutes({
      management,
      config,
      settings,
      usage,
      identity,
      authenticatePrincipal: async () => browserPrincipal(owner),
      now: () => START,
      randomCapability: () => 'q'.repeat(43),
      validateProviderKey: async (provider, key) => {
        assert.equal(provider, 'openai');
        assert.equal(key, 'sk-browser-only');
        return [];
      },
      deliverReceipt: async () => ({ deliveryRef: 'slack:U1:provider.1' }),
    });
    const exchange = await app.request(`http://localhost/setup/${setupId}/exchange`, {
      method: 'POST',
      headers: { origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'p'.repeat(43) }),
    });
    const cookie = exchange.headers.get('set-cookie')!;
    const completed = await app.request(`http://localhost/setup/${setupId}/complete`, {
      method: 'POST',
      headers: {
        origin: 'http://localhost', cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ apiKey: 'sk-browser-only' }).toString(),
    });
    assert.equal(completed.status, 303);
    assert.equal((await resolveProviderApiKey('openai', undefined, settings)).apiKey, 'sk-browser-only');
    const setup = await management.getSetup(setupId);
    assert.equal(setup?.status, 'completed');
    assert.doesNotMatch(JSON.stringify(setup), /sk-browser-only/);
    assert.doesNotMatch(JSON.stringify(await management.getRequest(result.operationId)), /sk-browser-only/);
    assert.doesNotMatch(JSON.stringify(setup?.receipt), /sk-browser-only/);
  } finally {
    identity.close();
    config.close();
    management.close();
    settings.close();
    usage.close();
  }
});

test('an older provider setup link cannot overwrite a newer rotation', async () => {
  let sequence = 0;
  let capability = 0;
  const identity = new SqliteIdentityStore(':memory:', { now: () => START });
  const owner = await createSlackOwner(identity, { now: START, suffix: 'provider-stale-link' });
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const usage = new SqliteUsageStore(':memory:');
  try {
    await saveProviderApiKey('openai', 'sk-initial', undefined, settings, usage);
    const service = new WorkspaceManagementService({
      identity,
      config,
      management,
      setupBaseUrl: 'http://localhost',
      providerCredentialSource: async (id) => (await describeProviderKeySources(undefined, settings))[id],
      providerCredentialRevision: async (id) => (await storedCredentialMetadata(id, settings))?.version ?? 0,
      now: () => START,
      randomId: () => `stale_provider_${++sequence}`,
      randomCapability: () => String(++capability).padStart(43, 'p'),
    });
    const context = {
      userId: owner.user.id,
      membershipId: owner.membership.id,
      organizationId: owner.membership.organizationId,
      origin: { kind: 'mcp' as const, clientId: 'codex' },
    };
    const issue = async (key: string) => {
      const proposed = await service.applyWorkspaceChanges({
        context,
        idempotencyKey: key,
        operations: [{
          itemId: 'openai', kind: 'request_setup',
          target: { kind: 'provider_credential', providerId: 'openai' },
        }],
      });
      requireMutationResult(proposed);
      return service.confirmWorkspaceChange({
        context,
        proposalId: proposed.outcomes[0]!.proposalId!,
      });
    };
    const older = await issue('older-provider-link');
    const newer = await issue('newer-provider-link');
    const app = createManagementSetupRoutes({
      management, config, settings, usage, identity,
      authenticatePrincipal: async () => browserPrincipal(owner),
      now: () => START,
      validateProviderKey: async () => [],
      deliverReceipt: async () => ({ deliveryRef: 'slack:U1:provider' }),
    });
    const complete = async (result: typeof newer, apiKey: string) => {
      const outcome = result.outcomes[0]!;
      const token = new URL(outcome.setupUrl!).hash.slice('#setup='.length);
      const exchanged = await app.request(`http://localhost/setup/${outcome.setupOperationId}/exchange`, {
        method: 'POST',
        headers: { origin: 'http://localhost', 'content-type': 'application/json' },
        body: JSON.stringify({ capability: token }),
      });
      return app.request(`http://localhost/setup/${outcome.setupOperationId}/complete`, {
        method: 'POST',
        headers: {
          origin: 'http://localhost',
          cookie: exchanged.headers.get('set-cookie')!,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ apiKey }).toString(),
      });
    };
    assert.equal((await complete(newer, 'sk-newer')).status, 303);
    assert.equal((await complete(older, 'sk-older')).status, 422);
    assert.equal((await resolveProviderApiKey('openai', undefined, settings)).apiKey, 'sk-newer');
  } finally {
    identity.close(); config.close(); management.close(); settings.close(); usage.close();
  }
});

test('invalid replacement input is cleared while the prior provider credential stays active', async () => {
  let sequence = 0;
  const identity = new SqliteIdentityStore(':memory:', { now: () => START });
  const owner = await createSlackOwner(identity, { now: START, suffix: 'provider-invalid' });
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const usage = new SqliteUsageStore(':memory:');
  try {
    await settings.setSetting(PROVIDER_KEY_SETTING_KEYS.openai, 'sk-prior-active');
    const service = new WorkspaceManagementService({
      identity,
      config,
      management,
      setupBaseUrl: 'http://localhost',
      providerCredentialSource: async () => 'stored',
      now: () => START,
      randomId: () => `invalid_${++sequence}`,
      randomCapability: () => 'i'.repeat(43),
    });
    const context = {
      userId: owner.user.id,
      membershipId: owner.membership.id,
      organizationId: owner.membership.organizationId,
      origin: { kind: 'mcp' as const, clientId: 'codex' },
    };
    const proposed = await service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'invalid_replace',
      operations: [{
        itemId: 'openai', kind: 'request_setup',
        target: { kind: 'provider_credential', providerId: 'openai' },
      }],
    });
    requireMutationResult(proposed);
    const confirmed = await service.confirmWorkspaceChange({
      context,
      proposalId: proposed.outcomes[0]!.proposalId!,
    });
    const setupId = confirmed.outcomes[0]!.setupOperationId!;
    const app = createManagementSetupRoutes({
      management, config, settings, usage, identity,
      authenticatePrincipal: async () => browserPrincipal(owner),
      now: () => START,
      randomCapability: () => 'j'.repeat(43),
      validateProviderKey: async () => { throw new Error('provider rejected'); },
      deliverReceipt: async () => { throw new Error('must not deliver'); },
    });
    const exchange = await app.request(`http://localhost/setup/${setupId}/exchange`, {
      method: 'POST',
      headers: { origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'i'.repeat(43) }),
    });
    const cookie = exchange.headers.get('set-cookie')!;
    const rejectedValue = 'sk-rejected-browser-value';
    const response = await app.request(`http://localhost/setup/${setupId}/complete`, {
      method: 'POST',
      headers: {
        origin: 'http://localhost', cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ apiKey: rejectedValue }).toString(),
    });
    assert.equal(response.status, 422);
    const html = await response.text();
    assert.doesNotMatch(html, new RegExp(rejectedValue));
    assert.equal((await resolveProviderApiKey('openai', undefined, settings)).apiKey, 'sk-prior-active');
    assert.equal((await management.getSetup(setupId))?.status, 'failed');
    assert.equal(await management.getOutboxForOperation(setupId), undefined);
  } finally {
    identity.close();
    config.close();
    management.close();
    settings.close();
    usage.close();
  }
});
