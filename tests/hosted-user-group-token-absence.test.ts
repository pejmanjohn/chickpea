import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { inspect } from 'node:util';

import { createAdminRoutes } from '../src/admin/routes.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import type { IdentityResolution } from '../src/identity/types.ts';
import { createLiveWorkspaceManagementService } from '../src/management/live-service.ts';
import { invokeWorkspaceManagementTool } from '../src/management/tool-adapter.ts';
import type { ManagementActorContext } from '../src/management/types.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { syncHostedWorkspaceInstallation } from '../src/slack/hosted-installation.ts';
import { slackInstallationCredentialId } from '../src/slack/hosted-slack-app.ts';
import {
  invalidateSlackInstallationCredentialCache,
  resolveSlackInstallationCredentials,
  writeHostedSlackBotCredentials,
  type SlackCredentialDependencies,
} from '../src/slack/installation-credentials.ts';
import { REQUESTED_SLACK_BOT_SCOPES } from '../src/slack/scopes.ts';
import { createDirectSlackTransport } from '../src/slack/transport/direct.ts';
import { SlackTransportError } from '../src/slack/transport/types.ts';
import { ownerUserGroupTokenWorks, withUserGroupAuthority } from '../src/slack/user-group-authority.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';
import { useDeploymentKeyring } from './helpers/deployment-keyring.ts';
import { withEnv } from './helpers/env.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const OWNER_TOKEN = 'xoxp-w16-owner-secret';
const BOT_TOKEN = 'xoxb-w16-bot-secret';
const APP_ID = 'AHOSTED1';
const HOSTED = { CHICKPEA_TENANCY: 'installation' } as Record<string, unknown>;

type Credential = 'bot' | 'owner';
type SlackErrorCodeFor = (credential: Credential, method: string) => string | undefined;

const ownerRevoked: SlackErrorCodeFor = (credential, method) =>
  credential === 'owner' ? 'token_revoked' : method === 'usergroups.disable' ? 'permission_denied' : undefined;
const botDenied: SlackErrorCodeFor = (credential, method) =>
  credential === 'bot' && method === 'usergroups.disable' ? 'permission_denied' : undefined;

function captureConsole(t: TestContext): string[] {
  const lines: string[] = [];
  for (const name of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    t.mock.method(console, name, (...args: unknown[]) => {
      lines.push(args.map((arg) => typeof arg === 'string' ? arg : inspect(arg, { depth: 8 })).join(' '));
    });
  }
  return lines;
}

function fakeSlackApi(t: TestContext, errorCodeFor: SlackErrorCodeFor) {
  const calls: string[] = [];
  const group = {
    id: 'S_SUPPORT', name: 'Support', handle: 'support', description: 'Support Agent', date_update: 1, date_delete: 0,
  };
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const method = new URL(request.url).pathname.split('/').at(-1)!;
    const authorization = request.headers.get('authorization');
    assert.ok([`Bearer ${OWNER_TOKEN}`, `Bearer ${BOT_TOKEN}`].includes(authorization ?? ''), method);
    const credential: Credential = authorization === `Bearer ${OWNER_TOKEN}` ? 'owner' : 'bot';
    calls.push(`${credential}:${method}`);
    const code = errorCodeFor(credential, method);
    if (code) return Response.json({ ok: false, error: code });
    if (method === 'usergroups.disable') group.date_delete = 2;
    if (method === 'usergroups.enable') group.date_delete = 0;
    return Response.json({
      ok: true, usergroups: [group], usergroup: group, channels: [], members: [], response_metadata: { next_cursor: '' },
    });
  });
  return { calls, group };
}

function assertNoUserGroupToken(surfaces: Record<string, unknown>): void {
  for (const [surface, value] of Object.entries(surfaces)) {
    const text = typeof value === 'string' ? value : inspect(value, { depth: 12 });
    assert.equal(text.includes(OWNER_TOKEN), false, `${surface} carries no user-group token`);
    assert.equal(text.includes(BOT_TOKEN), false, `${surface} carries no bot token`);
  }
}

function settled(promise: Promise<unknown>): Promise<unknown> {
  return promise.then((value) => value, (error: unknown) => error);
}

function publishedAgent(): CustomAgentConfig {
  return {
    id: 'agent_support', kind: 'user', revision: 1, name: 'Support', instructions: 'You are Support.',
    enabled: true, lifecycle: 'active', editPolicy: 'creator_and_admins', configurationGeneration: 1,
    slackPresence: {
      requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active', health: 'healthy',
      avatar: { kind: 'generated', revision: 1, seed: 'agent_support' }, userGroupId: 'S_SUPPORT',
    },
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  };
}

async function installHostedWithBothTokensAndPublishedAgent(
  credentials: SlackCredentialDependencies,
  config: SqliteConfigStore,
  env: Record<string, unknown>,
  teamId: string,
): Promise<void> {
  await writeHostedSlackBotCredentials(credentials, null, {
    botToken: BOT_TOKEN, userGroupToken: OWNER_TOKEN, botUserId: 'UBOT', appId: APP_ID, teamId,
    grantedScopes: [...REQUESTED_SLACK_BOT_SCOPES], validatedAt: Date.now(),
  });
  await syncHostedWorkspaceInstallation(env, { teamId, appId: APP_ID, botUserId: 'UBOT' }, config);
  await config.createAgent(publishedAgent());
}

function ownerPrincipal(owner: IdentityResolution): AuthPrincipal {
  return {
    userId: owner.user.id, membershipId: owner.membership.id, organizationId: owner.membership.organizationId,
    role: 'owner', authenticatorKind: 'test_slack_session', credentialId: 'session_owner',
    correlationId: 'request_owner', machine: false,
  };
}

async function hostedAdmin(t: TestContext) {
  const env = scopeInstallationEnv(HOSTED, { installationId: 'inst_w16_admin' });
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const identity = new SqliteIdentityStore(':memory:');
  t.after(() => {
    config.close();
    settings.close();
    identity.close();
    invalidateSlackInstallationCredentialCache();
  });
  const owner = await createSlackOwner(identity, { teamId: 'TTEST', userId: 'UOWNER' });
  const credentials = { state: identity, keyring: generateCredentialKeyring() };
  await installHostedWithBothTokensAndPublishedAgent(credentials, config, env, 'TTEST');
  const app = createAdminRoutes({
    store: config, settings, slackCredentials: credentials,
    ...testAdminAuthority('w16-admin-session', undefined, identity, ownerPrincipal(owner)),
  });
  return {
    config,
    archive: async () => {
      const response = await app.request('http://localhost/admin/api/agents/agent_support/archive', {
        method: 'POST',
        headers: { ...testAdminHeaders('w16-admin-session'), 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: 1 }),
      }, env);
      return { status: response.status, body: await response.text() };
    },
  };
}

test('refusals through the authority and the direct transport leave the user-group token out of every error and log', async (t) => {
  const output = captureConsole(t);
  const decided = await withUserGroupAuthority({
    operation: 'usergroups.disable', owner: OWNER_TOKEN, bot: BOT_TOKEN,
    call: async (token: string) => token === OWNER_TOKEN ? 'token_revoked' : 'permission_denied',
    errorCode: (code) => code,
  });
  assert.deepEqual(decided, { outcome: 'permission_denied', answeredBy: 'bot' });

  const slack = fakeSlackApi(t, (credential, method) =>
    method === 'usergroups.enable' && credential === 'owner' ? 'ratelimited' : ownerRevoked(credential, method));
  const transport = createDirectSlackTransport(BOT_TOKEN, { token: OWNER_TOKEN, dead: async () => undefined });
  const denied = await settled(transport.disableUserGroup('S_SUPPORT'));
  const limited = await settled(transport.enableUserGroup('S_SUPPORT'));
  assert.ok(denied instanceof SlackTransportError && denied.code === 'permission_denied');
  assert.ok(limited instanceof SlackTransportError && limited.code === 'ratelimited');
  assert.deepEqual(slack.calls, ['owner:usergroups.disable', 'bot:usergroups.disable', 'owner:usergroups.enable']);
  assert.equal(output.length, 3, 'one line per user-group call');

  assertNoUserGroupToken({
    'the authority outcome': decided, 'the console': output, 'the transport': transport,
    'the denial': [denied.message, denied.stack, denied], 'the rate limit': [limited.message, limited.stack, limited],
  });
});

test('Admin\'s archive finishes through the installing Owner\'s token when Slack refuses the bot', async (t) => {
  const output = captureConsole(t);
  const slack = fakeSlackApi(t, botDenied);
  const admin = await hostedAdmin(t);

  const archived = await admin.archive();
  assert.equal(archived.status, 200, archived.body);
  assert.equal(JSON.parse(archived.body).agent.lifecycle, 'archived');
  assert.equal(slack.group.date_delete, 2, 'Slack holds the user group disabled');
  assert.deepEqual(slack.calls.filter((call) => call.includes(':usergroups.')),
    ['owner:usergroups.list', 'owner:usergroups.disable']);
  assertNoUserGroupToken({ 'the Admin response': archived.body, 'the console': output });
});

test('a revoked Owner token reaches Admin as today\'s archive recovery, with no token in the response or logs', async (t) => {
  const output = captureConsole(t);
  const slack = fakeSlackApi(t, ownerRevoked);
  const admin = await hostedAdmin(t);

  const denied = await admin.archive();
  assert.equal(denied.status, 409, denied.body);
  const body = JSON.parse(denied.body);
  assert.equal(body.recovery.title, 'Slack could not finish archiving @support');
  assert.equal(body.agent.slackPresence.desiredState, 'disabled');
  assert.equal(slack.group.date_delete, 0, 'the user group is still active');
  assert.deepEqual(slack.calls.filter((call) => call.includes(':usergroups.')), [
    'owner:usergroups.list', 'bot:usergroups.list', 'owner:usergroups.disable', 'bot:usergroups.disable',
  ]);
  assert.equal((await admin.config.getAgent('agent_support')).slackPresence?.errorCode, 'user_group_policy_denied');
  assertNoUserGroupToken({ 'the Admin response': denied.body, 'the console': output });
});

async function hostedManagement(
  t: TestContext,
  run: (archive: () => Promise<unknown[]>, ownerTokenWorks: () => Promise<boolean>) => Promise<void>,
) {
  await withEnv({ CHICKPEA_TENANCY: undefined, SLACK_STATE_DB_PATH: ':memory:' }, async () => {
    const env = scopeInstallationEnv(HOSTED, { installationId: 'inst_w16_management' });
    const keyring = useDeploymentKeyring(t);
    const f = await createManagementAdapterFixture('w16-user-groups');
    const settings = new SqliteSettingsStore(':memory:');
    t.after(() => {
      f.close();
      settings.close();
      invalidateSlackInstallationCredentialCache();
    });
    const credentials = { state: f.identity, keyring };
    await installHostedWithBothTokensAndPublishedAgent(credentials, f.config, env, f.owner.user.slackTeamId);
    const service = createLiveWorkspaceManagementService(env, {
      identity: f.identity, settings, slackCredentials: credentials,
      overrides: {
        config: f.config, management: f.management, memory: f.memory, routines: f.routines,
        setupBaseUrl: 'http://localhost', now: () => 1_800_000_000_000,
      },
    });
    const context: ManagementActorContext = {
      userId: f.owner.user.id, membershipId: f.owner.membership.id,
      organizationId: f.owner.membership.organizationId, origin: { kind: 'mcp', clientId: 'w16-client' },
    };
    const adapter = { service, resolveContext: async () => context };
    const ownerTokenWorks = async () => ownerUserGroupTokenWorks(
      await resolveSlackInstallationCredentials(slackInstallationCredentialId(env), env, credentials), settings,
    );
    await run(async () => {
      const applied = await invokeWorkspaceManagementTool(adapter, 'apply_workspace_changes', {
        idempotencyKey: 'w16-archive',
        operations: [{ itemId: 'archive', kind: 'archive_agent', agentId: 'agent_support', expectedRevision: 1 }],
      });
      const proposalId = (applied as { result?: { outcomes?: Array<{ proposalId?: string }> } })
        .result?.outcomes?.[0]?.proposalId;
      if (!proposalId) return [applied];
      return [applied, await invokeWorkspaceManagementTool(adapter, 'confirm_workspace_change', { proposalId })];
    }, ownerTokenWorks);
  });
}

test('a management tool\'s archive finishes through the installing Owner\'s token when Slack refuses the bot', async (t) => {
  const output = captureConsole(t);
  const slack = fakeSlackApi(t, botDenied);
  await hostedManagement(t, async (archive, ownerTokenWorks) => {
    const results = await archive();
    assert.equal(results.length, 2, 'the archive asks for confirmation first');
    assert.equal(await ownerTokenWorks(), true);
    const confirmed = results[1] as { ok: boolean; result?: { status?: string } };
    assert.equal(confirmed.ok, true, inspect(confirmed, { depth: 8 }));
    assert.equal(confirmed.result?.status, 'completed');
    assert.equal(slack.group.date_delete, 2, 'Slack holds the user group disabled');
    assert.deepEqual(slack.calls.filter((call) => call.includes(':usergroups.')),
      ['owner:usergroups.list', 'owner:usergroups.disable']);
    assertNoUserGroupToken({ 'the tool results': results, 'the console': output });
  });
});

test('a revoked Owner token reaches a management tool as a refusal with no token in its result or logs', async (t) => {
  const output = captureConsole(t);
  const slack = fakeSlackApi(t, ownerRevoked);
  await hostedManagement(t, async (archive, ownerTokenWorks) => {
    const results = await archive();
    assert.equal(slack.group.date_delete, 0, 'the user group is still active');
    assert.equal(await ownerTokenWorks(), false, 'Admin\'s bar asks for an update again');
    assert.deepEqual(slack.calls.filter((call) => call.includes(':usergroups.')), [
      'owner:usergroups.list', 'bot:usergroups.list', 'owner:usergroups.disable', 'bot:usergroups.disable',
    ]);
    assert.equal(results.length, 2, 'the archive asks for confirmation first');
    assert.deepEqual(results[1], {
      ok: false,
      error: {
        code: 'user_group_policy_denied',
        message: 'Slack did not allow Chickpea to deactivate the @support user group. The Agent is not archived until that user group is deactivated.',
      },
    });
    assertNoUserGroupToken({ 'the tool results': results, 'the console': output });
  });
});
