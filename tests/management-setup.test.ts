import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import type { Hono } from 'hono';

import {
  connectionAccountSecretSettingKey,
  saveConnectionAccountSecret,
} from '../src/config/connector-secrets.ts';
import { CHICKPEA_AGENT_ID } from '../src/config/agent-id.ts';
import { connectionAccountOAuthRef } from '../src/config/api-oauth.ts';
import { GOOGLE_WORKSPACE_SCOPE_OPTIONS, googleWorkspaceApiPolicy } from '../src/config/api-oauth-policy.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import type {
  ConnectionAccount,
  ConnectionAccountApiPolicy,
  ConnectionAccountMcpPolicy,
  ConnectionAccountPolicy,
} from '../src/config/types.ts';
import { resolveEffectiveConnectionAccounts } from '../src/connections/runtime.ts';
import { ConnectionAccountService } from '../src/connections/store.ts';
import type { IdentityResolution } from '../src/identity/types.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import {
  META_ADS_OAUTH_DEFAULT_SCOPE,
  META_ADS_OAUTH_MANAGEMENT_SCOPE,
  saveConfiguredMcpOAuthClient,
} from '../src/config/mcp-oauth-clients.ts';
import {
  mcpOAuthSettingKeys,
  type StartMcpOAuthInput,
} from '../src/config/mcp-oauth.ts';
import {
  describeProviderKeySources,
  PROVIDER_KEY_SETTING_KEYS,
  resolveProviderApiKey,
  saveProviderApiKey,
} from '../src/config/provider-keys.ts';
import { storedCredentialMetadata } from '../src/config/model-credential-refs.ts';
import { OPENAI_API_IMAGE_DEFAULT_MODEL_ID } from '../src/config/initial-image-default.ts';
import { GITHUB_SETTING_KEYS } from '../src/config/github-app.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { CONNECTOR_PAGE_FONTS, fontFaceCss } from '../src/assets/fonts.ts';
import { formatManagementSetupReceipt } from '../src/management/receipts.ts';
import { WorkspaceManagementService } from '../src/management/service.ts';
import { createManagementSetupRoutes } from '../src/management/setup-routes.ts';
import { SqliteManagementStore } from '../src/management/store.ts';
import {
  ManagementError,
  type ApplyWorkspaceChangesResult,
  type ManagementApplyResult,
  type ManagementSetupRecord,
} from '../src/management/types.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';
import { unstyledClasses } from './helpers/unstyled-classes.ts';

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

const TASKS_POLICY: ConnectionAccountApiPolicy = {
  kind: 'api',
  allowedHosts: ['api.example.com'],
  pathPrefixes: ['/v1'],
  headerName: 'Authorization',
  headerValuePrefix: 'Bearer ',
  allowedMethods: ['GET'],
  authMode: 'credential',
};

const LINEAR_POLICY: ConnectionAccountMcpPolicy = {
  kind: 'mcp',
  url: 'https://mcp.linear.app/mcp',
  transport: 'streamable-http',
  authMode: 'oauth',
  headerNames: [],
  discoveredTools: [],
  allowedTools: [],
  oauthScope: 'read',
};

/** A team connection on the Agent that waits for its setup link, as a management edit leaves it. */
async function seedConnection(
  stores: { config: SqliteConfigStore; settings: SqliteSettingsStore },
  owner: IdentityResolution,
  agentId: string,
  input: { providerId: string; label: string; policy: ConnectionAccountPolicy },
): Promise<ConnectionAccount> {
  const { account } = await new ConnectionAccountService(stores).createForAgent({
    principal: browserPrincipal(owner),
    agentId,
    workspaceId: owner.user.slackTeamId,
    ownerKind: 'team',
    ...input,
    pendingSetup: true,
    allowedCapabilities: [],
  });
  assert.equal(account.lifecycle, 'pending');
  return account;
}

async function currentAccount(config: SqliteConfigStore, account: ConnectionAccount): Promise<ConnectionAccount> {
  const current = (await config.listConnectionAccounts(account.workspaceId)).find(({ id }) => id === account.id);
  assert.ok(current, `${account.id} still exists`);
  return current;
}

async function storedSecret(settings: SqliteSettingsStore, account: ConnectionAccount): Promise<string | undefined> {
  return settings.getSetting(connectionAccountSecretSettingKey(account.secretRefId));
}

function receiptAccountLabel(setup: ManagementSetupRecord | undefined): string | undefined {
  const receipt = setup?.receipt;
  return receipt && 'accountLabel' in receipt ? receipt.accountLabel : undefined;
}

async function requestConnectionSetup(
  service: WorkspaceManagementService,
  owner: IdentityResolution,
  target: { kind: 'api_connection' | 'mcp_connection'; agentId: string; connectionId: string },
): Promise<string> {
  const result = await service.applyWorkspaceChanges({
    context: {
      userId: owner.user.id,
      membershipId: owner.membership.id,
      organizationId: owner.membership.organizationId,
      origin: { kind: 'mcp', clientId: 'codex' },
    },
    idempotencyKey: `setup-${target.agentId}-${target.connectionId}`,
    operations: [{ itemId: 'setup', kind: 'request_setup', target }],
  });
  requireMutationResult(result);
  assert.equal(result.outcomes[0]?.disposition, 'setup_required', JSON.stringify(result));
  return result.outcomes[0]!.setupOperationId!;
}

async function claimSetup(app: Hono, setupId: string): Promise<string> {
  const exchange = await app.request(`http://localhost/setup/${setupId}/exchange`, {
    method: 'POST',
    headers: { origin: 'http://localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ capability: CAPABILITY }),
  });
  assert.equal(exchange.status, 200, await exchange.clone().text());
  return exchange.headers.get('set-cookie')!;
}

function postSetupForm(app: Hono, setupId: string, action: string, cookie: string, fields: Record<string, string>) {
  return app.request(`http://localhost/setup/${setupId}/${action}`, {
    method: 'POST',
    headers: { origin: 'http://localhost', cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

test('the initiating member claims one authenticated browser and completes an exact connector setup', async () => {
  let now = START;
  let sequence = 0;
  const identity = new SqliteIdentityStore(':memory:', { now: () => now });
  const owner = await createSlackOwner(identity, { now, suffix: 'delegated-setup' });
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
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
      apiConnections: [],
      repositories: [],
    });
    const gmail = await seedConnection({ config, settings }, owner, 'agent_research', {
      providerId: 'gmail',
      label: 'Gmail',
      policy: {
        kind: 'api',
        allowedHosts: ['gmail.googleapis.com'],
        pathPrefixes: ['/gmail/v1'],
        headerName: 'Authorization',
        allowedMethods: ['GET'],
        authMode: 'credential',
        presetId: 'gmail',
      },
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
    const claimHtml = await initial.text();
    assert.match(claimHtml, /Checking this one-use setup link/);
    assert.match(claimHtml, /data-connector-surface="setup-claim"/);
    assert.match(claimHtml, /role="img" aria-label="Chickpea"/);
    assert.deepEqual(unstyledClasses(claimHtml), []);
    assert.equal(initial.headers.get('referrer-policy'), 'no-referrer');
    assert.match(initial.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.match(initial.headers.get('content-security-policy') ?? '', /(?:^|; )font-src 'self'(?:;|$)/);
    assert.ok(claimHtml.includes(`<style>${fontFaceCss(CONNECTOR_PAGE_FONTS)}\n`), 'the page loads the fonts its style names');

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
    const wrongMemberPage = await app.request(`http://localhost/setup/${setupId}`);
    assert.equal(wrongMemberPage.status, 410);
    const unavailableHtml = await wrongMemberPage.text();
    assert.match(unavailableHtml, /Setup link unavailable/);
    assert.match(unavailableHtml, /data-connector-surface="setup-unavailable"/);
    assert.deepEqual(unstyledClasses(unavailableHtml), []);

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
    assert.match(cookie, /Path=\/;/);
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
    assert.match(summaryHtml, /data-connector-surface="setup-summary"/);
    assert.deepEqual(unstyledClasses(summaryHtml), []);
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
        account: await currentAccount(config, gmail),
        outbox: await management.getOutboxForOperation(setupId),
      })}`,
    );
    assert.equal(await storedSecret(settings, gmail), credential);
    assert.equal((await currentAccount(config, gmail)).lifecycle, 'ready');
    assert.deepEqual((await config.getAgent('agent_research')).apiConnections, []);
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
    const terminalHtml = await terminal.text();
    assert.match(terminalHtml, /Setup complete/);
    assert.match(terminalHtml, /data-connector-surface="setup-complete"/);
    assert.deepEqual(unstyledClasses(terminalHtml), []);
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
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
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

    const falseLength = await app.request(new Request(
      'http://localhost/setup/setup_missing/exchange',
      {
        method: 'POST',
        headers: {
          origin: 'http://localhost',
          'content-type': 'application/json',
          'content-length': '1',
        },
        body: 'x'.repeat(20 * 1024),
      },
    ));
    assert.equal(falseLength.status, 413);
  } finally {
    management.close();
    config.close();
    settings.close();
  }
});

test('stored provider replacement issues its link directly and reissue invalidates the old link', async () => {
  let now = START;
  let sequence = 0;
  let capabilitySequence = 0;
  const identity = new SqliteIdentityStore(':memory:', { now: () => now });
  const owner = await createSlackOwner(identity, { now, suffix: 'provider-replacement' });
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
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
    const confirmed = await service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'replace_openai',
      operations: [{
        itemId: 'provider',
        kind: 'request_setup',
        target: { kind: 'provider_credential', providerId: 'openai' },
      }],
    });
    requireMutationResult(confirmed);
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
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
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
      // This service has no model sources, so it cannot say the key's models run.
      available: false,
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
    assert.match(
      proposed.presentation?.markdown ?? '',
      /^Remove the stored \*\*Anthropic\*\* key\. The Workspace default uses Anthropic, so Chickpea stops answering too\. \*\*Support\*\* uses Anthropic and stops answering until a key is available\.$/m,
    );
    assert.doesNotMatch(proposed.presentation?.markdown ?? '', /provider:|agent_support/);
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
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const usage = new SqliteUsageStore(':memory:');
  try {
    await config.ensureWorkspaceInstallation({
      workspaceId: owner.user.slackTeamId,
      transportMode: 'direct',
    });
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
    const imageRole = await config.getWorkspaceModelRole(owner.user.slackTeamId, 'image');
    assert.equal(imageRole?.modelId, OPENAI_API_IMAGE_DEFAULT_MODEL_ID);
    assert.equal(imageRole?.revision, 1);
    assert.equal(imageRole?.lastChangedByMembershipId, owner.membership.id);
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

test('provider setup rechecks current Admin authority before claim and completion', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => START });
  const owner = await createSlackOwner(identity, { now: START, suffix: 'provider-authority' });
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
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
      randomId: () => 'provider_authority',
      randomCapability: () => 'a'.repeat(43),
    });
    const result = await service.applyWorkspaceChanges({
      context: {
        userId: owner.user.id,
        membershipId: owner.membership.id,
        organizationId: owner.membership.organizationId,
        origin: { kind: 'mcp', clientId: 'codex' },
      },
      idempotencyKey: 'provider-authority',
      operations: [{
        itemId: 'openai',
        kind: 'request_setup',
        target: { kind: 'provider_credential', providerId: 'openai' },
      }],
    });
    requireMutationResult(result);
    const setupId = result.outcomes[0]!.setupOperationId!;
    let principal: AuthPrincipal = { ...browserPrincipal(owner), role: 'member' };
    let validationCalls = 0;
    const app = createManagementSetupRoutes({
      management,
      config,
      settings,
      usage,
      identity,
      now: () => START,
      randomCapability: () => 'b'.repeat(43),
      authenticatePrincipal: async () => principal,
      validateProviderKey: async () => {
        validationCalls += 1;
        return [];
      },
    });

    const deniedExchange = await app.request(`http://localhost/setup/${setupId}/exchange`, {
      method: 'POST',
      headers: { origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'a'.repeat(43) }),
    });
    assert.equal(deniedExchange.status, 403);
    assert.equal((await management.getSetup(setupId))?.status, 'pending');
    assert.ok((await management.getSetup(setupId))?.tokenDigest);

    principal = browserPrincipal(owner);
    const exchange = await app.request(`http://localhost/setup/${setupId}/exchange`, {
      method: 'POST',
      headers: { origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'a'.repeat(43) }),
    });
    assert.equal(exchange.status, 200, await exchange.clone().text());
    const cookie = exchange.headers.get('set-cookie')!;

    principal = { ...principal, role: 'member' };
    const deniedComplete = await app.request(`http://localhost/setup/${setupId}/complete`, {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ apiKey: 'sk-must-not-be-validated' }).toString(),
    });
    assert.equal(deniedComplete.status, 403);
    assert.equal(validationCalls, 0);
    assert.equal((await management.getSetup(setupId))?.status, 'claimed');
    assert.equal(await settings.getSetting(PROVIDER_KEY_SETTING_KEYS.openai), undefined);
  } finally {
    identity.close();
    config.close();
    management.close();
    settings.close();
    usage.close();
  }
});

test('legacy Agent OAuth setup rechecks current edit authority before start and callback', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => START });
  const owner = await createSlackOwner(identity, { now: START, suffix: 'legacy-oauth-authority' });
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await config.createAgent({
      id: 'agent_private_oauth',
      name: 'Private OAuth Agent',
      creatorMembershipId: 'membership_original_creator',
      editPolicy: 'creator_and_admins',
      instructions: 'Use the authorized connection.',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    const linear = await seedConnection({ config, settings }, owner, 'agent_private_oauth', {
      providerId: 'linear',
      label: 'Linear',
      policy: LINEAR_POLICY,
    });
    const service = new WorkspaceManagementService({
      identity,
      config,
      management,
      setupBaseUrl: 'http://localhost',
      now: () => START,
      randomId: () => 'legacy_oauth_authority',
      randomCapability: () => 'o'.repeat(43),
    });
    const result = await service.applyWorkspaceChanges({
      context: {
        userId: owner.user.id,
        membershipId: owner.membership.id,
        organizationId: owner.membership.organizationId,
        origin: { kind: 'mcp', clientId: 'codex' },
      },
      idempotencyKey: 'legacy-oauth-authority',
      operations: [{
        itemId: 'linear',
        kind: 'request_setup',
        target: {
          kind: 'mcp_connection',
          agentId: 'agent_private_oauth',
          connectionId: 'linear',
        },
      }],
    });
    requireMutationResult(result);
    const setupId = result.outcomes[0]!.setupOperationId!;
    let principal: AuthPrincipal = browserPrincipal(owner);
    let completeCalls = 0;
    const app = createManagementSetupRoutes({
      management,
      config,
      settings,
      identity,
      now: () => START,
      randomCapability: () => 's'.repeat(43),
      authenticatePrincipal: async () => principal,
      completeMcpOAuth: async () => {
        completeCalls += 1;
        return {
          ref: connectionAccountOAuthRef(linear.id),
          returnAgentId: 'agent_private_oauth',
        };
      },
    });
    const exchange = await app.request(`http://localhost/setup/${setupId}/exchange`, {
      method: 'POST',
      headers: { origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'o'.repeat(43) }),
    });
    assert.equal(exchange.status, 200, await exchange.clone().text());
    const cookie = exchange.headers.get('set-cookie')!;

    principal = { ...principal, role: 'member' };
    const deniedStart = await app.request(`http://localhost/setup/${setupId}/authorize`, {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: '',
    });
    assert.equal(deniedStart.status, 403);
    assert.equal((await management.getSetup(setupId))?.status, 'claimed');
    assert.equal((await currentAccount(config, linear)).revision, linear.revision, 'no sign-in attempt started');

    await management.authorizeSetup({
      setupOperationId: setupId,
      browserSessionDigest: createHash('sha256')
        .update('s'.repeat(43))
        .digest('base64url'),
      at: START,
    });
    assert.equal((await management.getSetup(setupId))?.status, 'authorizing');

    principal = { ...principal, role: 'member' };
    const deniedCallback = await app.request(
      `http://localhost/setup/${setupId}/oauth/mcp/callback?state=opaque-state&code=accepted`,
      { headers: { cookie } },
    );
    assert.equal(deniedCallback.status, 403);
    assert.equal(completeCalls, 0);
    assert.equal((await management.getSetup(setupId))?.status, 'authorizing');
  } finally {
    identity.close();
    config.close();
    management.close();
    settings.close();
  }
});

test('connector setup refuses the Chickpea system Agent before issuing a sign-in link', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => START });
  const owner = await createSlackOwner(identity, { now: START, suffix: 'system-agent-connector' });
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  try {
    await identity.updateOrganizationAuth({
      organizationId: owner.membership.organizationId,
      authMode: 'slack_active',
      canonicalAdminOrigin: 'https://admin.example.com',
    });
    const authControl = await identity.getAuthControl();
    assert.ok(authControl);
    await identity.updateAuthControl({
      expectedRevision: authControl.revision,
      canonicalAdminOrigin: 'https://admin.example.com',
    });
    assert.equal((await config.materializeChickpeaAgent()).kind, 'system');
    const service = new WorkspaceManagementService({
      identity,
      config,
      management,
      setupBaseUrl: 'http://localhost',
      now: () => START,
      randomId: () => 'system_agent_connector',
      randomCapability: () => 'm'.repeat(43),
    });
    await assert.rejects(service.prepareConnectorSetup({
      userId: owner.user.id,
      membershipId: owner.membership.id,
      organizationId: owner.membership.organizationId,
      origin: {
        kind: 'slack',
        workspaceId: owner.user.slackTeamId,
        channelId: 'D_SYSTEM_AGENT',
        threadTs: '1800100000.000400',
        agentId: CHICKPEA_AGENT_ID,
      },
    }, { agentId: CHICKPEA_AGENT_ID, connector: 'Meta Ads', ownerKind: 'member' }),
    (error: unknown) => error instanceof ManagementError &&
      error.code === 'invalid_request' &&
      /Chickpea cannot hold connections/.test(error.message));
    assert.equal(await management.getSetup('setup_system_agent_connector'), undefined);
  } finally {
    identity.close();
    config.close();
    management.close();
  }
});

test('Meta Ads management setup uses the canonical callback and requires explicit scoped access', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => START });
  const owner = await createSlackOwner(identity, { now: START, suffix: 'meta-ads-review' });
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await identity.updateOrganizationAuth({
      organizationId: owner.membership.organizationId,
      authMode: 'slack_active',
      canonicalAdminOrigin: 'https://admin.example.com',
    });
    const authControl = await identity.getAuthControl();
    assert.ok(authControl);
    await identity.updateAuthControl({
      expectedRevision: authControl.revision,
      canonicalAdminOrigin: 'https://admin.example.com',
    });
    const agent = await config.createAgent({
      id: 'agent_meta_ads',
      name: 'Campaign Analyst',
      creatorMembershipId: owner.membership.id,
      editPolicy: 'creator_and_admins',
      instructions: 'Review campaigns.',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    let setupSequence = 0;
    const service = new WorkspaceManagementService({
      identity,
      config,
      management,
      setupBaseUrl: 'http://localhost',
      now: () => START,
      randomId: () => `catalog_${++setupSequence}`,
      randomCapability: () => 'm'.repeat(43),
    });
    const prepared = await service.prepareConnectorSetup({
      userId: owner.user.id,
      membershipId: owner.membership.id,
      organizationId: owner.membership.organizationId,
      origin: {
        kind: 'slack',
        workspaceId: owner.user.slackTeamId,
        channelId: 'C_META',
        threadTs: '1800100000.000300',
        agentId: agent.id,
      },
    }, { agentId: agent.id, connector: 'Meta Ads', ownerKind: 'member' });
    const setupId = prepared.setupOperationId;
    assert.ok(setupId);
    const startInputs: StartMcpOAuthInput[] = [];
    let completeCalls = 0;
    const app = createManagementSetupRoutes({
      management,
      config,
      settings,
      identity,
      now: () => START,
      authenticatePrincipal: async () => browserPrincipal(owner),
      startMcpOAuth: async (input) => {
        startInputs.push(input);
        return { authorizationUrl: new URL('https://www.facebook.com/dialog/oauth'), state: 'state' };
      },
      completeMcpOAuth: async () => {
        completeCalls += 1;
        const [account] = await config.listConnectionAccounts(owner.user.slackTeamId);
        assert.ok(account?.policy.kind === 'mcp' && account.policy.oauthAttemptId);
        return {
          ref: connectionAccountOAuthRef(account.id),
          accountRevision: account.revision,
          oauthAttemptId: account.policy.oauthAttemptId,
          authorizationAuthority: {
            organizationId: owner.membership.organizationId,
            workspaceId: owner.user.slackTeamId,
            membershipId: owner.membership.id,
            agentId: agent.id,
            ownerKind: 'member',
          },
        };
      },
      resolveMcpOAuthToken: async () => 'access-token',
      discoverMcp: async () => ({
        tools: [{
          name: 'ads_get_ad_entities',
          description: 'Review campaigns for an ad account.',
          inputSchema: {
            accountFields: [{ name: 'ad_account_id', type: 'string', required: true }],
            ambiguous: false,
            fingerprint: 'a'.repeat(64),
            propertyNames: ['ad_account_id'],
          },
        }, {
          name: 'ads_create_campaign',
          description: 'Create a campaign in a paused state.',
          inputSchema: {
            accountFields: [{ name: 'ad_account_id', type: 'string', required: true }],
            ambiguous: false,
            fingerprint: 'c'.repeat(64),
            propertyNames: ['ad_account_id'],
          },
        }, {
          name: 'ambiguous_tool',
          inputSchema: {
            accountFields: [],
            ambiguous: true,
            fingerprint: 'b'.repeat(64),
            propertyNames: [],
          },
        }],
      }),
      deliverReceipt: async () => ({ deliveryRef: 'slack:C_META:receipt.1' }),
    });
    const exchanged = await app.request(`http://localhost/setup/${setupId}/exchange`, {
      method: 'POST',
      headers: { origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'm'.repeat(43) }),
    });
    assert.equal(exchanged.status, 200, await exchanged.clone().text());
    const cookie = exchanged.headers.get('set-cookie')!;
    assert.match(cookie, /Path=\/;/);
    const setupPage = await app.request(`http://localhost/setup/${setupId}`, { headers: { cookie } });
    const setupHtml = await setupPage.text();
    assert.match(setupHtml, /name="access" value="reporting" checked/);
    assert.match(setupHtml, /name="access" value="editing"/);

    const missingConfiguration = await app.request(`http://localhost/setup/${setupId}/authorize`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'x-requested-with': 'chickpea-setup',
        origin: 'http://localhost',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'ownerKind=member&access=editing',
    });
    assert.equal(missingConfiguration.status, 422);
    assert.equal((await missingConfiguration.json() as { error: string }).error, 'oauth_configuration_required');
    assert.deepEqual(await config.listConnectionAccounts(owner.user.slackTeamId), []);
    assert.equal(startInputs.length, 0);

    await saveConfiguredMcpOAuthClient(
      'https://mcp.facebook.com/ads',
      { clientId: '123456789' },
      settings,
      { randomId: () => 'configured_generation_1' },
    );

    const authorized = await app.request(`http://localhost/setup/${setupId}/authorize`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'x-requested-with': 'chickpea-setup',
        origin: 'http://localhost',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'ownerKind=member&access=editing',
    });
    assert.equal(authorized.status, 200, await authorized.clone().text());
    assert.equal(startInputs[0]?.callbackUrl, 'https://admin.example.com/oauth/callback');
    assert.equal(startInputs[0]?.setupOperationId, setupId);
    assert.equal(startInputs[0]?.scope, META_ADS_OAUTH_MANAGEMENT_SCOPE);
    const [pending] = await config.listConnectionAccounts(owner.user.slackTeamId);
    assert.equal(pending?.lifecycle, 'pending');
    assert.equal(pending?.policy.kind === 'mcp' ? pending.policy.oauthScope : undefined, META_ADS_OAUTH_MANAGEMENT_SCOPE);
    assert.deepEqual(pending?.policy.kind === 'mcp' ? pending.policy.allowedTools : undefined, []);

    assert.ok(pending && pending.policy.kind === 'mcp');
    const pendingSetup = await management.getSetup(setupId);
    const pendingBinding = await config.getAgentConnectionBindingForAccount(pending.id);
    assert.equal(pendingSetup?.status, 'authorizing');
    assert.equal(pending.providerId, pendingSetup?.target.presetId);
    assert.equal(pending.workspaceId, owner.user.slackTeamId);
    assert.equal(pending.ownerMembershipId, owner.membership.id);
    assert.equal(pendingBinding?.agentId, agent.id);
    const pendingResume = await app.request(`http://localhost/setup/${setupId}`, {
      headers: { cookie },
    });
    assert.equal(pendingResume.status, 200);
    assert.match(await pendingResume.text(), /Connect Meta Ads/);
    const ref = connectionAccountOAuthRef(pending.id);
    const state = Buffer.from(JSON.stringify({
      a: ref.agentId,
      c: ref.connectionId,
      n: 'management-continuation',
    })).toString('base64url');
    await settings.setSetting(mcpOAuthSettingKeys(ref)[1], JSON.stringify({
      state,
      expiresAt: START + 60_000,
      serverUrl: 'https://mcp.facebook.com/ads',
      callbackUrl: 'https://admin.example.com/oauth/callback',
      authorizationServerUrl: 'https://www.facebook.com/ads',
      metadata: {
        issuer: 'https://www.facebook.com/ads',
        authorization_endpoint: 'https://www.facebook.com/ads/authorize',
        token_endpoint: 'https://www.facebook.com/ads/token',
        response_types_supported: ['code'],
      },
      resource: 'https://mcp.facebook.com/ads',
      clientInformation: { client_id: '123456789' },
      codeVerifier: 'verifier',
      setupOperationId: setupId,
    }));
    const callback = await app.request(
      `https://admin.example.com/oauth/callback?state=${encodeURIComponent(state)}&code=accepted`,
      { headers: { cookie } },
    );
    assert.equal(callback.status, 303, `${await callback.clone().text()} completeCalls=${completeCalls}`);
    assert.equal(callback.headers.get('location'), `/setup/${setupId}?review=1`);

    const review = await app.request(`http://localhost/setup/${setupId}?review=1`, {
      headers: { cookie },
    });
    assert.equal(review.status, 200);
    const reviewHtml = await review.text();
    assert.match(reviewHtml, /Choose what Campaign Analyst can use/);
    assert.match(reviewHtml, /ads_get_ad_entities/);
    assert.match(reviewHtml, /Not yet supported with ad account restrictions/);
    assert.ok(reviewHtml.indexOf('Ad accounts') < reviewHtml.indexOf('Tools'));
    assert.match(reviewHtml, /Reporting access/);
    assert.match(reviewHtml, /ads_create_campaign/);
    assert.match(reviewHtml, /May change ads/);
    assert.match(reviewHtml, /Create a paused campaign/);
    assert.doesNotMatch(reviewHtml, /name="tool:ads_create_campaign" checked/);
    assert.equal((await management.getSetup(setupId))?.status, 'authorizing');

    const [editingAccount] = await config.listConnectionAccounts(owner.user.slackTeamId);
    assert.ok(editingAccount?.policy.kind === 'mcp');
    if (!editingAccount || editingAccount.policy.kind !== 'mcp') throw new Error('expected MCP');
    const reportingAccount = await config.putConnectionAccount({
      ...editingAccount,
      policy: { ...editingAccount.policy, oauthScope: META_ADS_OAUTH_DEFAULT_SCOPE },
    }, editingAccount.revision);
    assert.equal(reportingAccount.policy.kind, 'mcp');
    if (reportingAccount.policy.kind !== 'mcp') throw new Error('expected MCP');
    const reportingReview = await app.request(`http://localhost/setup/${setupId}?review=1`, {
      headers: { cookie },
    });
    assert.match(await reportingReview.text(), /Reconnect with Reporting and editing access to select this tool/);
    const rejectedWrite = await app.request(`http://localhost/setup/${setupId}/mcp/access`, {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'tool%3Aads_create_campaign=on&adAccountIds=act_123456789',
    });
    assert.equal(rejectedWrite.status, 422);
    assert.match(await rejectedWrite.text(), /Reconnect with Reporting and editing access/);
    await config.putConnectionAccount({
      ...reportingAccount,
      policy: { ...reportingAccount.policy, oauthScope: META_ADS_OAUTH_MANAGEMENT_SCOPE },
    }, reportingAccount.revision);

    const saved = await app.request(`http://localhost/setup/${setupId}/mcp/access`, {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'tool%3Aads_get_ad_entities=on&tool%3Aads_create_campaign=on&adAccountIds=act_123456789',
    });
    assert.equal(saved.status, 303, await saved.clone().text());
    assert.equal((await management.getSetup(setupId))?.status, 'completed');
    const [ready] = await config.listConnectionAccounts(owner.user.slackTeamId);
    assert.deepEqual(ready?.policy.kind === 'mcp' ? ready.policy.allowedTools : undefined,
      ['ads_get_ad_entities', 'ads_create_campaign']);
    assert.deepEqual(
      ready?.policy.kind === 'mcp'
        ? ready.policy.toolPolicies?.ads_get_ad_entities?.argumentConstraints
        : undefined,
      { ad_account_id: ['act_123456789'] },
    );
    const binding = await config.getAgentConnectionBindingForAccount(ready!.id);
    assert.deepEqual(binding?.allowedCapabilities, []);

    const linearPrepared = await service.prepareConnectorSetup({
      userId: owner.user.id,
      membershipId: owner.membership.id,
      organizationId: owner.membership.organizationId,
      origin: {
        kind: 'slack',
        workspaceId: owner.user.slackTeamId,
        channelId: 'C_META',
        threadTs: '1800100000.000301',
        agentId: agent.id,
      },
    }, { agentId: agent.id, connector: 'Linear', ownerKind: 'member' });
    const linearSetupId = linearPrepared.setupOperationId;
    assert.ok(linearSetupId);
    const linearExchange = await app.request(`http://localhost/setup/${linearSetupId}/exchange`, {
      method: 'POST',
      headers: { origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'm'.repeat(43) }),
    });
    assert.equal(linearExchange.status, 200);
    const linearCookie = linearExchange.headers.get('set-cookie')!;
    const linearAuthorize = await app.request(`http://localhost/setup/${linearSetupId}/authorize`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'x-requested-with': 'chickpea-setup',
        origin: 'http://localhost',
        cookie: linearCookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'ownerKind=member',
    });
    assert.equal(linearAuthorize.status, 200, await linearAuthorize.clone().text());
    const linearResume = await app.request(`http://localhost/setup/${linearSetupId}`, {
      headers: { cookie: linearCookie },
    });
    assert.equal(linearResume.status, 200);
    assert.match(await linearResume.text(), /Connect Linear/);
  } finally {
    identity.close();
    config.close();
    management.close();
    settings.close();
  }
});

test('repository setup reserves workspace-global GitHub App creation for current Admins', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => START });
  const owner = await createSlackOwner(identity, { now: START, suffix: 'repository-authority' });
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await config.createAgent({
      id: 'agent_shared_repository',
      name: 'Shared Repository Agent',
      creatorMembershipId: owner.membership.id,
      editPolicy: 'all_workspace_members',
      instructions: 'Work in the configured repository.',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [{
        id: 'repo_private',
        installationId: null,
        accountLogin: 'acme',
        fullName: 'acme/private',
        enabled: true,
      }],
    });
    const service = new WorkspaceManagementService({
      identity,
      config,
      management,
      setupBaseUrl: 'http://localhost',
      now: () => START,
      randomId: () => 'repository_authority',
      randomCapability: () => 'r'.repeat(43),
    });
    const result = await service.applyWorkspaceChanges({
      context: {
        userId: owner.user.id,
        membershipId: owner.membership.id,
        organizationId: owner.membership.organizationId,
        origin: { kind: 'mcp', clientId: 'codex' },
      },
      idempotencyKey: 'repository-authority',
      operations: [{
        itemId: 'repository',
        kind: 'request_setup',
        target: {
          kind: 'repository_access',
          agentId: 'agent_shared_repository',
          repositoryId: 'repo_private',
        },
      }],
    });
    requireMutationResult(result);
    const setupId = result.outcomes[0]!.setupOperationId!;
    const browserSession = 's'.repeat(43);
    const principal: AuthPrincipal = { ...browserPrincipal(owner), role: 'member' };
    const app = createManagementSetupRoutes({
      management,
      config,
      settings,
      identity,
      now: () => START,
      randomCapability: () => browserSession,
      authenticatePrincipal: async () => principal,
    });
    const exchange = await app.request(`http://localhost/setup/${setupId}/exchange`, {
      method: 'POST',
      headers: { origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'r'.repeat(43) }),
    });
    assert.equal(exchange.status, 200, await exchange.clone().text());
    const cookie = exchange.headers.get('set-cookie')!;

    const deniedStart = await app.request(`http://localhost/setup/${setupId}/authorize`, {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ organization: 'acme' }).toString(),
    });
    assert.equal(deniedStart.status, 403);
    assert.equal((await management.getSetup(setupId))?.status, 'claimed');
    assert.equal(await settings.getSetting(`management.${setupId}.github-state`), undefined);

    await management.authorizeSetup({
      setupOperationId: setupId,
      browserSessionDigest: createHash('sha256').update(browserSession).digest('base64url'),
      at: START,
    });
    const callbackState = 'github-state-that-must-not-be-consumed';
    const stateKey = `management.${setupId}.github-state`;
    const stateDigest = createHash('sha256').update(callbackState).digest('base64url');
    await settings.setSetting(stateKey, stateDigest);
    const deniedCallback = await app.request(
      `http://localhost/setup/${setupId}/github/callback?code=must-not-exchange&state=${callbackState}`,
      { headers: { cookie } },
    );
    assert.equal(deniedCallback.status, 403);
    assert.equal(await settings.getSetting(stateKey), stateDigest);
    assert.equal(await settings.getSetting(GITHUB_SETTING_KEYS.appId), undefined);
    assert.equal(await settings.getSetting(GITHUB_SETTING_KEYS.privateKey), undefined);
  } finally {
    identity.close();
    config.close();
    management.close();
    settings.close();
  }
});

test('an API setup cannot cross an Agent delete-recreate race before the ready transition', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => START });
  const owner = await createSlackOwner(identity, { now: START, suffix: 'api-incarnation-race' });
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const agentInput = {
    id: 'agent_api_setup_race',
    name: 'API setup race',
    creatorMembershipId: owner.membership.id,
    editPolicy: 'creator_and_admins' as const,
    instructions: 'Keep setup credentials on the requested incarnation.',
    enabled: true,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  };
  const connection = { providerId: 'tasks', label: 'Tasks', policy: TASKS_POLICY };
  try {
    await config.createAgent(agentInput);
    const issued = await seedConnection({ config, settings }, owner, agentInput.id, connection);
    const issuedAgent = await config.getAgent(agentInput.id);
    const service = new WorkspaceManagementService({
      identity, config, management, setupBaseUrl: 'http://localhost', now: () => START,
      randomId: () => 'api_incarnation_race', randomCapability: () => CAPABILITY,
    });
    const setupId = await requestConnectionSetup(service, owner, {
      kind: 'api_connection', agentId: agentInput.id, connectionId: 'tasks',
    });
    let replacement: ConnectionAccount | undefined;
    const racingConfig = new Proxy(config, {
      get(target, property, receiver) {
        if (property !== 'putConnectionAccount') return Reflect.get(target, property, receiver);
        return async (...args: Parameters<typeof config.putConnectionAccount>) => {
          if (!replacement) {
            // Disconnecting tombstones the slot before it marks the account revoked;
            // the setup's credential lands in between.
            const current = await currentAccount(config, issued);
            await config.putConnectionAccount({ ...current, lifecycle: 'revoked' }, current.revision);
            assert.equal(await config.deleteAgent(issuedAgent.id, issuedAgent.revision), true);
            const recreated = await config.createAgent(agentInput);
            assert.equal(recreated.revision, issuedAgent.revision);
            replacement = await seedConnection({ config, settings }, owner, recreated.id, connection);
            assert.notEqual(replacement.secretRefId, issued.secretRefId);
          }
          return config.putConnectionAccount(...args);
        };
      },
    });
    const app = createManagementSetupRoutes({
      management,
      config: racingConfig,
      settings,
      identity,
      now: () => START,
      randomCapability: () => 's'.repeat(43),
      authenticatePrincipal: async () => browserPrincipal(owner),
      deliverReceipt: async () => { throw new Error('must not deliver'); },
    });
    const cookie = await claimSetup(app, setupId);

    const response = await postSetupForm(app, setupId, 'complete', cookie, {
      credential: 'must-not-cross-incarnations',
    });
    assert.equal(response.status, 422, await response.clone().text());
    assert.ok(replacement);
    assert.equal(await storedSecret(settings, issued), undefined, 'the revoked account keeps no credential');
    assert.equal(await storedSecret(settings, replacement), undefined);
    assert.equal((await currentAccount(config, replacement)).lifecycle, 'pending');
    assert.equal((await management.getSetup(setupId))?.failureCode, 'target_changed');
    assert.equal(await management.getOutboxForOperation(setupId), undefined);
  } finally {
    identity.close();
    config.close();
    management.close();
    settings.close();
  }
});

test('a failed older API setup cannot erase a newer same-incarnation credential', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => START });
  const owner = await createSlackOwner(identity, { now: START, suffix: 'api-same-ref-race' });
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const agent = await config.createAgent({
      id: 'agent_api_same_ref_race',
      name: 'API same-ref race',
      creatorMembershipId: owner.membership.id,
      editPolicy: 'creator_and_admins',
      instructions: 'Keep the newest credential when an older setup loses its revision.',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    const tasks = await seedConnection({ config, settings }, owner, agent.id, {
      providerId: 'tasks', label: 'Tasks', policy: TASKS_POLICY,
    });
    const service = new WorkspaceManagementService({
      identity, config, management, setupBaseUrl: 'http://localhost', now: () => START,
      randomId: () => 'api_same_ref_race', randomCapability: () => CAPABILITY,
    });
    const setupId = await requestConnectionSetup(service, owner, {
      kind: 'api_connection', agentId: agent.id, connectionId: 'tasks',
    });
    let raced = false;
    const racingConfig = new Proxy(config, {
      get(target, property, receiver) {
        if (property !== 'putConnectionAccount') return Reflect.get(target, property, receiver);
        return async (...args: Parameters<typeof config.putConnectionAccount>) => {
          if (!raced) {
            raced = true;
            const current = await currentAccount(config, tasks);
            await config.putConnectionAccount({ ...current, label: 'Tasks renamed' }, current.revision);
            await saveConnectionAccountSecret(tasks.secretRefId, 'newer-credential', undefined, settings);
          }
          return config.putConnectionAccount(...args);
        };
      },
    });
    const app = createManagementSetupRoutes({
      management,
      config: racingConfig,
      settings,
      identity,
      now: () => START,
      authenticatePrincipal: async () => browserPrincipal(owner),
      deliverReceipt: async () => { throw new Error('must not deliver'); },
    });
    const cookie = await claimSetup(app, setupId);

    const response = await postSetupForm(app, setupId, 'complete', cookie, { credential: 'older-credential' });
    assert.equal(response.status, 422, await response.clone().text());
    assert.equal(await storedSecret(settings, tasks), 'newer-credential');
    const current = await currentAccount(config, tasks);
    assert.equal(current.label, 'Tasks renamed');
    assert.equal(current.lifecycle, 'pending');
    assert.equal((await management.getSetup(setupId))?.failureCode, 'target_changed');
  } finally {
    identity.close();
    config.close();
    management.close();
    settings.close();
  }
});

test('a credential API connection added over MCP is ready to run once its setup link completes', async () => {
  const f = await createManagementAdapterFixture('setup-link-api', {}, { teamId: 'T_SETUP' });
  try {
    const agent = await f.config.createAgent({
      id: 'agent_billing',
      name: 'Billing',
      instructions: 'Check invoices.',
      enabled: true,
      creatorMembershipId: f.owner.membership.id,
      editPolicy: 'creator_and_admins',
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    const context = {
      userId: f.owner.user.id,
      membershipId: f.owner.membership.id,
      organizationId: f.owner.membership.organizationId,
      origin: { kind: 'mcp' as const, clientId: 'codex' },
    };
    const added = await f.service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'add-billing',
      operations: [{
        itemId: 'add',
        kind: 'update_agent',
        agentId: agent.id,
        expectedRevision: agent.revision,
        patch: {
          apiConnections: [{
            id: 'billing',
            displayName: 'Billing API',
            allowedHosts: ['billing.example.test'],
            pathPrefixes: ['/v1'],
            headerName: 'Authorization',
            headerValuePrefix: 'Bearer ',
            allowedMethods: ['GET'],
            enabled: true,
            authMode: 'credential',
          }],
        },
      }],
    });
    requireMutationResult(added);
    assert.deepEqual(added.outcomes.map(({ disposition }) => disposition), ['applied'], JSON.stringify(added));
    const setupId = await requestConnectionSetup(f.service, f.owner, {
      kind: 'api_connection', agentId: agent.id, connectionId: 'billing',
    });
    const app = createManagementSetupRoutes({
      management: f.management,
      config: f.config,
      settings: f.settings,
      identity: f.identity,
      authenticatePrincipal: async () => browserPrincipal(f.owner),
      deliverReceipt: async () => ({ deliveryRef: 'mcp:receipt' }),
    });
    const cookie = await claimSetup(app, setupId);
    const completed = await postSetupForm(app, setupId, 'complete', cookie, { credential: 'sk-billing' });
    assert.equal(completed.status, 303, await completed.clone().text());

    const [account] = await f.config.listConnectionAccounts('T_SETUP');
    assert.ok(account);
    assert.equal(account.lifecycle, 'ready');
    assert.equal(await storedSecret(f.settings, account), 'sk-billing');
    const effective = await resolveEffectiveConnectionAccounts({
      config: f.config,
      workspaceId: 'T_SETUP',
      agentId: agent.id,
      actorMembershipId: f.owner.membership.id,
    });
    assert.deepEqual(effective.map((entry) => [entry.account.id, entry.policy.kind]), [[account.id, 'api']]);
    assert.equal((await f.management.getSetup(setupId))?.status, 'completed');
  } finally {
    f.close();
  }
});

test('a setup link needs authority over its connection account, not only the Agent', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => START });
  const owner = await createSlackOwner(identity, { now: START, suffix: 'account-authority' });
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const agent = await config.createAgent({
      id: 'agent_account_authority',
      name: 'Account authority',
      creatorMembershipId: owner.membership.id,
      editPolicy: 'creator_and_admins',
      instructions: 'Use the team connection.',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    const tasks = await seedConnection({ config, settings }, owner, agent.id, {
      providerId: 'tasks', label: 'Tasks', policy: TASKS_POLICY,
    });
    const service = new WorkspaceManagementService({
      identity, config, management, setupBaseUrl: 'http://localhost', now: () => START,
      randomId: () => 'account_authority', randomCapability: () => CAPABILITY,
    });
    const setupId = await requestConnectionSetup(service, owner, {
      kind: 'api_connection', agentId: agent.id, connectionId: 'tasks',
    });
    let principal = browserPrincipal(owner);
    const app = createManagementSetupRoutes({
      management,
      config,
      settings,
      identity,
      now: () => START,
      authenticatePrincipal: async () => principal,
      deliverReceipt: async () => ({ deliveryRef: 'mcp:receipt' }),
    });
    const cookie = await claimSetup(app, setupId);

    // As the Agent's creator, a member still edits the Agent but cannot manage a team connection.
    principal = { ...principal, role: 'member' };
    const denied = await postSetupForm(app, setupId, 'complete', cookie, { credential: 'sk-denied' });
    assert.equal(denied.status, 403);
    assert.equal(await storedSecret(settings, tasks), undefined);
    assert.equal((await currentAccount(config, tasks)).lifecycle, 'pending');
    assert.equal((await management.getSetup(setupId))?.status, 'claimed');

    principal = browserPrincipal(owner);
    const completed = await postSetupForm(app, setupId, 'complete', cookie, { credential: 'sk-tasks' });
    assert.equal(completed.status, 303, await completed.clone().text());
    assert.equal(await storedSecret(settings, tasks), 'sk-tasks');
    assert.equal((await currentAccount(config, tasks)).lifecycle, 'ready');
  } finally {
    identity.close();
    config.close();
    management.close();
    settings.close();
  }
});

test('an MCP header setup stores one credential and records the tools the server offers', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => START });
  const owner = await createSlackOwner(identity, { now: START, suffix: 'mcp-header-setup' });
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  try {
    const agent = await config.createAgent({
      id: 'agent_tracker',
      name: 'Tracker',
      creatorMembershipId: owner.membership.id,
      editPolicy: 'creator_and_admins',
      instructions: 'Search the tracker.',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    const tracker = await seedConnection({ config, settings }, owner, agent.id, {
      providerId: 'tracker',
      label: 'Tracker',
      policy: {
        kind: 'mcp',
        url: 'https://mcp.tracker.example/mcp',
        transport: 'streamable-http',
        authMode: 'none',
        headerNames: ['X-Api-Key'],
        credentialHeaderName: 'X-Api-Key',
        credentialValuePrefix: 'Token ',
        discoveredTools: [{ name: 'search' }],
        allowedTools: ['search'],
      },
    });
    const service = new WorkspaceManagementService({
      identity, config, management, setupBaseUrl: 'http://localhost', now: () => START,
      randomId: () => 'mcp_header_setup', randomCapability: () => CAPABILITY,
    });
    const setupId = await requestConnectionSetup(service, owner, {
      kind: 'mcp_connection', agentId: agent.id, connectionId: 'tracker',
    });
    assert.deepEqual((await management.getSetup(setupId))?.target.formFields, ['header:X-Api-Key']);
    const requestHeaders: Array<Record<string, string>> = [];
    const app = createManagementSetupRoutes({
      management,
      config,
      settings,
      identity,
      now: () => START,
      authenticatePrincipal: async () => browserPrincipal(owner),
      deliverReceipt: async () => ({ deliveryRef: 'mcp:receipt' }),
      discoverMcp: async (input) => {
        requestHeaders.push(input.headers ?? {});
        return { tools: [{ name: 'search' }, { name: 'delete_everything' }] };
      },
      identifyMcp: async () => ({ workspaceName: 'Tracker team' }),
    });
    const cookie = await claimSetup(app, setupId);
    const completed = await postSetupForm(app, setupId, 'complete', cookie, { 'header:X-Api-Key': 'abc123' });
    assert.equal(completed.status, 303, await completed.clone().text());

    assert.deepEqual(requestHeaders, [{ 'X-Api-Key': 'Token abc123' }]);
    assert.equal(await storedSecret(settings, tracker), 'abc123');
    const ready = await currentAccount(config, tracker);
    assert.equal(ready.lifecycle, 'ready');
    assert.equal(ready.identity?.workspaceName, 'Tracker team');
    assert.ok(ready.policy.kind === 'mcp');
    assert.deepEqual(ready.policy.discoveredTools.map(({ name }) => name), ['search', 'delete_everything']);
    assert.deepEqual(ready.policy.allowedTools, ['search'], 'discovery never widens the granted tools');
    assert.equal(receiptAccountLabel(await management.getSetup(setupId)), 'Tracker team');
  } finally {
    identity.close();
    config.close();
    management.close();
    settings.close();
  }
});

test('an MCP OAuth setup signs in to its connection account and marks it ready', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => START });
  const owner = await createSlackOwner(identity, { now: START, suffix: 'mcp-oauth-setup' });
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await config.ensureWorkspaceInstallation({
      workspaceId: owner.user.slackTeamId,
      teamId: owner.user.slackTeamId,
      transportMode: 'gateway',
      appId: 'A_SETUP',
      botUserId: 'U_BOT',
      gatewayBindingId: 'binding_setup',
    });
    const agent = await config.createAgent({
      id: 'agent_linear',
      name: 'Linear helper',
      creatorMembershipId: owner.membership.id,
      editPolicy: 'creator_and_admins',
      instructions: 'Triage issues.',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    const linear = await seedConnection({ config, settings }, owner, agent.id, {
      providerId: 'linear', label: 'Linear', policy: LINEAR_POLICY,
    });
    const service = new WorkspaceManagementService({
      identity, config, management, setupBaseUrl: 'http://localhost', now: () => START,
      randomId: () => 'mcp_oauth_setup', randomCapability: () => CAPABILITY,
    });
    const setupId = await requestConnectionSetup(service, owner, {
      kind: 'mcp_connection', agentId: agent.id, connectionId: 'linear',
    });
    const starts: StartMcpOAuthInput[] = [];
    const app = createManagementSetupRoutes({
      management,
      config,
      settings,
      identity,
      now: () => START,
      authenticatePrincipal: async () => browserPrincipal(owner),
      deliverReceipt: async () => ({ deliveryRef: 'mcp:receipt' }),
      startMcpOAuth: async (input) => {
        starts.push(input);
        return { authorizationUrl: new URL('https://linear.app/oauth/authorize'), state: 'state' };
      },
      completeMcpOAuth: async () => {
        const [start] = starts;
        assert.ok(start);
        return {
          ref: start.ref,
          ...(start.accountRevision !== undefined ? { accountRevision: start.accountRevision } : {}),
          ...(start.oauthAttemptId ? { oauthAttemptId: start.oauthAttemptId } : {}),
          ...(start.authorizationAuthority ? { authorizationAuthority: start.authorizationAuthority } : {}),
        };
      },
      resolveMcpOAuthToken: async () => 'linear-access-token',
      discoverMcp: async (input) => {
        assert.equal(input.headers?.Authorization, 'Bearer linear-access-token');
        return { tools: [{ name: 'list_issues' }] };
      },
      identifyMcp: async () => ({ workspaceName: 'Acme' }),
    });
    const cookie = await claimSetup(app, setupId);
    const started = await postSetupForm(app, setupId, 'authorize', cookie, {});
    assert.equal(started.status, 303, await started.clone().text());
    assert.equal(started.headers.get('location'), 'https://linear.app/oauth/authorize');
    const pending = await currentAccount(config, linear);
    assert.ok(pending.policy.kind === 'mcp' && pending.policy.oauthAttemptId);
    assert.deepEqual(starts.map(({ ref, accountRevision, oauthAttemptId, callbackUrl }) => ({
      ref, accountRevision, oauthAttemptId, callbackUrl,
    })), [{
      ref: connectionAccountOAuthRef(linear.id),
      accountRevision: pending.revision,
      oauthAttemptId: pending.policy.oauthAttemptId,
      callbackUrl: `http://localhost/setup/${setupId}/oauth/mcp/callback`,
    }]);

    const state = Buffer.from(JSON.stringify({ a: linear.id, c: 'account', n: 'nonce' })).toString('base64url');
    const callback = await app.request(
      `http://localhost/setup/${setupId}/oauth/mcp/callback?state=${state}&code=accepted`,
      { headers: { cookie } },
    );
    assert.equal(callback.status, 303, await callback.clone().text());
    assert.equal(callback.headers.get('location'), `/setup/${setupId}`);
    const ready = await currentAccount(config, linear);
    assert.equal(ready.lifecycle, 'ready');
    assert.equal(ready.identity?.workspaceName, 'Acme');
    assert.ok(ready.policy.kind === 'mcp');
    assert.deepEqual(ready.policy.allowedTools, ['list_issues']);
    assert.equal((await management.getSetup(setupId))?.status, 'completed');
  } finally {
    identity.close();
    config.close();
    management.close();
    settings.close();
  }
});

test('an MCP OAuth setup link completes for an account stored with a bare-origin URL', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-setup-bare-origin-'));
  const configPath = join(directory, 'config.db');
  const identity = new SqliteIdentityStore(':memory:', { now: () => START });
  const owner = await createSlackOwner(identity, { now: START, suffix: 'mcp-bare-origin' });
  const config = new SqliteConfigStore(configPath, agentRoutineDeletion, { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  try {
    await config.ensureWorkspaceInstallation({
      workspaceId: owner.user.slackTeamId, teamId: owner.user.slackTeamId, transportMode: 'gateway',
      appId: 'A_SETUP', botUserId: 'U_BOT', gatewayBindingId: 'binding_setup',
    });
    const agent = await config.createAgent({
      id: 'agent_logs', name: 'Logs helper', creatorMembershipId: owner.membership.id,
      editPolicy: 'creator_and_admins', instructions: 'Search logs.', enabled: true,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    const logs = await seedConnection({ config, settings }, owner, agent.id, {
      providerId: 'logs', label: 'Logs', policy: { ...LINEAR_POLICY, url: 'https://mcp.logs.example' },
    });
    // Stores now write the canonical URL, so restore the raw form an earlier version saved.
    const earlier = new DatabaseSync(configPath);
    earlier.prepare("UPDATE config_connection_accounts SET policy_json = json_set(policy_json, '$.url', ?) WHERE id = ?")
      .run('https://mcp.logs.example', logs.id);
    earlier.close();
    const stored = await currentAccount(config, logs);
    assert.equal(stored.policy.kind === 'mcp' ? stored.policy.url : undefined, 'https://mcp.logs.example');

    const service = new WorkspaceManagementService({
      identity, config, management, setupBaseUrl: 'http://localhost', now: () => START,
      randomId: () => 'mcp_bare_origin_setup', randomCapability: () => CAPABILITY,
    });
    const setupId = await requestConnectionSetup(service, owner, {
      kind: 'mcp_connection', agentId: agent.id, connectionId: 'logs',
    });
    const starts: StartMcpOAuthInput[] = [];
    const app = createManagementSetupRoutes({
      management, config, settings, identity, now: () => START,
      authenticatePrincipal: async () => browserPrincipal(owner),
      deliverReceipt: async () => ({ deliveryRef: 'mcp:receipt' }),
      startMcpOAuth: async (input) => {
        starts.push(input);
        return { authorizationUrl: new URL('https://auth.logs.example/authorize'), state: 'state' };
      },
      completeMcpOAuth: async () => {
        const [start] = starts;
        assert.ok(start);
        return {
          ref: start.ref,
          ...(start.accountRevision !== undefined ? { accountRevision: start.accountRevision } : {}),
          ...(start.oauthAttemptId ? { oauthAttemptId: start.oauthAttemptId } : {}),
          ...(start.authorizationAuthority ? { authorizationAuthority: start.authorizationAuthority } : {}),
        };
      },
      resolveMcpOAuthToken: async () => 'logs-access-token',
      discoverMcp: async () => ({ tools: [{ name: 'search_logs' }] }),
      identifyMcp: async () => undefined,
    });
    const cookie = await claimSetup(app, setupId);
    const started = await postSetupForm(app, setupId, 'authorize', cookie, {});
    assert.equal(started.headers.get('location'), 'https://auth.logs.example/authorize', await started.clone().text());

    const state = Buffer.from(JSON.stringify({ a: logs.id, c: 'account', n: 'nonce' })).toString('base64url');
    const callback = await app.request(
      `http://localhost/setup/${setupId}/oauth/mcp/callback?state=${state}&code=accepted`,
      { headers: { cookie } },
    );
    assert.equal(callback.headers.get('location'), `/setup/${setupId}`, await callback.clone().text());
    assert.equal((await management.getSetup(setupId))?.status, 'completed');
    const ready = await currentAccount(config, logs);
    assert.equal(ready.lifecycle, 'ready');
    assert.equal(ready.policy.kind === 'mcp' ? ready.policy.url : undefined, 'https://mcp.logs.example/');
  } finally {
    identity.close();
    config.close();
    management.close();
    settings.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an API OAuth setup stores its client on the connection account and marks it ready', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => START });
  const owner = await createSlackOwner(identity, { now: START, suffix: 'api-oauth-setup' });
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const originalFetch = globalThis.fetch;
  try {
    await config.ensureWorkspaceInstallation({
      workspaceId: owner.user.slackTeamId,
      teamId: owner.user.slackTeamId,
      transportMode: 'gateway',
      appId: 'A_SETUP',
      botUserId: 'U_BOT',
      gatewayBindingId: 'binding_setup',
    });
    const agent = await config.createAgent({
      id: 'agent_inbox',
      name: 'Inbox',
      creatorMembershipId: owner.membership.id,
      editPolicy: 'creator_and_admins',
      instructions: 'Read mail.',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    const scope = GOOGLE_WORKSPACE_SCOPE_OPTIONS.gmail.read;
    const gmail = await seedConnection({ config, settings }, owner, agent.id, {
      providerId: 'gmail',
      label: 'Gmail',
      policy: {
        kind: 'api',
        ...googleWorkspaceApiPolicy([scope]),
        authMode: 'oauth',
        oauthProvider: 'google',
        oauthScopes: [scope],
      },
    });
    const service = new WorkspaceManagementService({
      identity, config, management, setupBaseUrl: 'http://localhost', now: () => START,
      randomId: () => 'api_oauth_setup', randomCapability: () => CAPABILITY,
    });
    const setupId = await requestConnectionSetup(service, owner, {
      kind: 'api_connection', agentId: agent.id, connectionId: 'gmail',
    });
    assert.equal((await management.getSetup(setupId))?.action, 'api_oauth');
    const app = createManagementSetupRoutes({
      management,
      config,
      settings,
      identity,
      authenticatePrincipal: async () => browserPrincipal(owner),
      deliverReceipt: async () => ({ deliveryRef: 'mcp:receipt' }),
    });
    const cookie = await claimSetup(app, setupId);
    const started = await postSetupForm(app, setupId, 'authorize', cookie, {
      clientId: 'client-id.apps.googleusercontent.com',
      clientSecret: 'client-secret',
    });
    assert.equal(started.status, 303, await started.clone().text());
    const authorization = new URL(started.headers.get('location')!);
    assert.equal(authorization.origin, 'https://accounts.google.com');
    assert.equal(authorization.searchParams.get('client_id'), 'client-id.apps.googleusercontent.com');

    globalThis.fetch = async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === 'https://oauth2.googleapis.com/token') {
        return Response.json({ access_token: 'google-access', refresh_token: 'google-refresh', token_type: 'Bearer', expires_in: 3600 });
      }
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return Response.json({ email: 'ops@example.com' });
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    const callback = await app.request(
      `http://localhost/setup/${setupId}/oauth/api/callback?state=${encodeURIComponent(authorization.searchParams.get('state')!)}&code=accepted`,
      { headers: { cookie } },
    );
    assert.equal(callback.status, 303, await callback.clone().text());
    assert.equal(callback.headers.get('location'), `/setup/${setupId}`);
    const ready = await currentAccount(config, gmail);
    assert.equal(ready.lifecycle, 'ready');
    assert.equal(ready.identity?.accountName, 'ops@example.com');
    assert.equal(receiptAccountLabel(await management.getSetup(setupId)), 'ops@example.com');
  } finally {
    globalThis.fetch = originalFetch;
    identity.close();
    config.close();
    management.close();
    settings.close();
  }
});

test('an older provider setup link cannot overwrite a newer rotation', async () => {
  let sequence = 0;
  let capability = 0;
  const identity = new SqliteIdentityStore(':memory:', { now: () => START });
  const owner = await createSlackOwner(identity, { now: START, suffix: 'provider-stale-link' });
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const usage = new SqliteUsageStore(':memory:');
  try {
    await config.ensureWorkspaceInstallation({
      workspaceId: owner.user.slackTeamId,
      transportMode: 'direct',
    });
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
      const issued = await service.applyWorkspaceChanges({
        context,
        idempotencyKey: key,
        operations: [{
          itemId: 'openai', kind: 'request_setup',
          target: { kind: 'provider_credential', providerId: 'openai' },
        }],
      });
      requireMutationResult(issued);
      return issued;
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
    assert.equal(
      await config.getWorkspaceModelRole(owner.user.slackTeamId, 'image'),
      undefined,
    );
  } finally {
    identity.close(); config.close(); management.close(); settings.close(); usage.close();
  }
});

test('invalid replacement input is cleared while the prior provider credential stays active', async () => {
  let sequence = 0;
  const identity = new SqliteIdentityStore(':memory:', { now: () => START });
  const owner = await createSlackOwner(identity, { now: START, suffix: 'provider-invalid' });
  const config = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
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
    const issued = await service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'invalid_replace',
      operations: [{
        itemId: 'openai', kind: 'request_setup',
        target: { kind: 'provider_credential', providerId: 'openai' },
      }],
    });
    requireMutationResult(issued);
    const setupId = issued.outcomes[0]!.setupOperationId!;
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
