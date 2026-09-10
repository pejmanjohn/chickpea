import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createFlueContext } from '@flue/runtime/internal';
import { ChickpeaSlack, runtimeApiDeclarationStillAllowed } from '../src/agents/slack-thread.ts';
import { ChickpeaRoutineExecution } from '../src/agents/routine-execution.ts';
import { compileRuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import { getConfigStore, getIdentityStore, getSettingsStore } from '../src/config/state-backend.ts';
import { connectionAccountSecretSettingKey } from '../src/config/connector-secrets.ts';
import { apiOAuthSettingKeys, connectionAccountOAuthRef } from '../src/config/api-oauth.ts';
import { googleWorkspaceApiPolicy } from '../src/config/api-oauth-policy.ts';
import { resolveEffectiveConnectionAccounts } from '../src/connections/runtime.ts';
import { serializeCurrentRequestEnvelope } from '../src/memory/tool-policy.ts';

const basePolicy = { kind: 'api' as const, authMode: 'credential' as const, allowedHosts: ['93.184.216.34', 'app.asana.com'], pathPrefixes: ['/v1'], headerName: 'X-Test-Key', headerValuePrefix: 'Token ', allowedMethods: ['GET', 'HEAD', 'POST'] };

for (const scenario of ['live', 'empty', 'wider', 'routine', 'personal-custom'] as const) {
test(`native REST session: ${scenario}`, async (t) => {
  const policy = { ...basePolicy, allowedHosts: scenario === 'personal-custom' ? ['93.184.216.34'] : [...basePolicy.allowedHosts] };
  const store = getConfigStore();
  const identity = getIdentityStore();
  const agent = { id: 'agent_rest_test', kind: 'user', revision: 1, name: 'REST', instructions: 'Read the API', enabled: true, model: 'local-stub/proof', skills: [], mcpServers: [], apiConnections: [], repositories: [] };
  const account = { id: 'connection_rest', workspaceId: 'T_TEST', revision: 1, ownerKind: scenario === 'personal-custom' ? 'member' : 'team', ownerMembershipId: scenario === 'personal-custom' ? 'member' : undefined, createdByMembershipId: 'member', providerId: 'custom', label: 'REST', policy, secretRefId: 'rest_test', lifecycle: 'ready', createdAt: 1, updatedAt: 1 };
  const binding = { agentId: agent.id, connectionAccountId: account.id, providerId: 'custom', allowedCapabilities: ['GET', 'HEAD', 'POST'], enabled: true, createdAt: 1, updatedAt: 1 };
  t.mock.method(store, 'getAgent', async () => agent);
  const accountReads = t.mock.method(store, 'listConnectionAccounts', async () => [account]);
  const bindingReads = t.mock.method(store, 'listAgentConnectionBindings', async () => [binding]);
  t.mock.method(identity, 'getOrganization', async () => ({ id: 'org', slackTeamId: 'T_TEST' }));
  let membershipStatus = 'active';
  t.mock.method(identity, 'getMembership', async () => ({ id: 'member', organizationId: 'org', status: membershipStatus, userId: 'user' }));
  t.mock.method(identity, 'getMembershipAccessOverlay', async () => undefined);
  t.mock.method(identity, 'getUser', async () => ({ id: 'user', slackTeamId: 'T_TEST', slackUserId: 'U_TEST' }));
  t.mock.method(identity, 'resolveSlackIdentity', async () => ({ user: { id: 'user' }, membership: { id: 'member' }, binding: { membershipId: 'member' } }));
  const settings = getSettingsStore();
  const settingReads = t.mock.method(settings, 'getSetting', async (key: string) => key === connectionAccountSecretSettingKey('rest_test') ? 'fixture-secret' : key === 'egress.policy' ? JSON.stringify({ mode: 'open', domains: [] }) : undefined);
  const calls: { url: string; headers: Headers; method: string; nonce: string }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    const nonce = randomUUID();
    calls.push({ url: String(url), headers: new Headers(options.headers), method: options.method ?? 'GET', nonce });
    return String(url).endsWith('/redirect')
      ? new Response(null, { status: 302, headers: { location: 'https://93.184.216.35/v1/data' } })
      : Response.json({ nonce });
  });
  const plan = compileRuntimePlanV2({ turn: { workspaceId: 'T_TEST', channelId: 'C_TEST', eventId: 'E_TEST', text: 'Read', userId: 'U_TEST', actorMembershipId: 'member', messageTs: '1787000000.000200', threadTs: '1787000000.000100', source: 'app_mention', contextMode: 'thread' }, assignment: { workspaceId: 'T_TEST', channelId: 'C_TEST', agentId: agent.id, agent, model: agent.model, modelAttribution: { source: 'workspace_default', providerId: 'local-stub', workspaceDefaultRevision: 1 } }, instructions: agent.instructions, memoryEpoch: 1, sandboxMode: 'bash', effectiveConnections: scenario === 'empty' ? [] : [{ account, binding, policy, scope: 'team' }] } as any);
  if (scenario === 'wider') account.policy = { ...policy, allowedHosts: [...policy.allowedHosts, '93.184.216.35'] };
  const warnings = t.mock.method(console, 'warn', () => {});
  assert.doesNotMatch(JSON.stringify(plan), /fixture-secret/);
  const context = createFlueContext({ id: 'rest-test', agentName: 'chickpea-slack-v2', env: {}, agentConfig: { resolveModel: () => ({}) } as any });
  const signal = { kind: 'signal', type: 'slack.message', tagName: 'slack_message', body: serializeCurrentRequestEnvelope('Read', false, 'U_TEST', '1787000000.000200', { schemaVersion: 2, progressiveStreamingOffered: true }), attributes: { workspaceId: 'T_TEST', channelId: 'C_TEST', threadTs: plan.conversation.threadTs, slackUserId: 'U_TEST', eventId: 'E_TEST', messageTs: '1787000000.000200', turnJobId: 'proof' } } as any;
  const harness = scenario === 'routine'
    ? await context.initializeRootHarness(ChickpeaRoutineExecution, signal, { runtimePlan: plan, requestedModel: plan.model })
    : await context.initializeRootHarness(ChickpeaSlack, signal, plan);
  try {
    const instructions = String((harness as any).config.instructions);
    if (scenario === 'empty') assert.doesNotMatch(instructions, /REST connections are declared/);
    else {
      assert.match(instructions, /REST connections are declared/);
      assert.match(instructions, /bash tool with curl/);
      assert.match(instructions, /curl -sS/);
      assert.match(instructions, /Credentials are injected automatically/);
      assert.match(instructions, /93\.184\.216\.34/);
      assert.match(instructions, /"id":"connection_rest"/);
      assert.match(instructions, /"displayName":"REST"/);
      assert.doesNotMatch(instructions, /fixture-secret|X-Test-Key|Token /);
    }
    assert.equal(settingReads.mock.calls.filter(({ arguments: args }) => args[0] === 'egress.policy').length, 0);
    if (scenario === 'empty' || scenario === 'wider') {
      assert.notEqual((await harness.sandbox.exec('curl -sS https://93.184.216.34/v1/data')).exitCode, 0);
      assert.equal(calls.length, 0);
      if (scenario === 'empty') {
        assert.equal(accountReads.mock.callCount(), 0);
        assert.equal(bindingReads.mock.callCount(), 0);
      } else {
        assert.ok(warnings.mock.calls.some(({ arguments: args }) => String(args[0]).includes('unavailable under frozen policy')));
      }
      return;
    }
    if (scenario === 'routine') assert.ok((harness as any).agentTools.some((tool: any) => tool.name === 'submit_routine_result'));
    if (scenario !== 'personal-custom') assert.ok((harness as any).config.skills['asana-api']);
    else assert.equal((harness as any).config.skills?.['asana-api'], undefined);
    const first = await harness.sandbox.exec('curl -sS https://93.184.216.34/v1/data');
    assert.equal(first.exitCode, 0, JSON.stringify(first));
    assert.equal(JSON.parse(first.stdout).nonce, calls[0]?.nonce);
    assert.equal(calls[0]?.headers.get('x-test-key'), 'Token fixture-secret');
    const head = await harness.sandbox.exec('curl -sS -I https://93.184.216.34/v1/data');
    assert.equal(head.exitCode, 0, JSON.stringify(head));
    assert.equal(calls[1]?.method, 'HEAD');
    const denied = await harness.sandbox.exec('curl -sS -X DELETE https://93.184.216.34/v1/data');
    assert.equal(denied.exitCode, 3);
    assert.match(denied.stderr, /HTTP method 'DELETE' not allowed/);
    assert.equal(calls.length, 2);
    assert.notEqual((await harness.sandbox.exec('curl -sS https://93.184.216.35/v1/data')).exitCode, 0);
    assert.notEqual((await harness.sandbox.exec('curl -sS -L https://93.184.216.34/v1/redirect')).exitCode, 0);
    assert.equal(calls.length, 3);
    membershipStatus = 'suspended';
    const revokedActor = await harness.sandbox.exec('curl -sS https://93.184.216.34/v1/data');
    assert.equal(revokedActor.exitCode, 1);
    assert.match(revokedActor.stderr, /Connection authority changed/);
    assert.equal(calls.length, 3);
    membershipStatus = 'active';
    binding.allowedCapabilities = ['GET'];
    const narrowed = await harness.sandbox.exec('curl -sS -X POST https://93.184.216.34/v1/data');
    assert.equal(narrowed.exitCode, 1);
    assert.match(narrowed.stderr, /Connection authority changed/);
    assert.equal(calls.length, 3);
    binding.allowedCapabilities = ['GET', 'HEAD', 'POST'];
    binding.enabled = false;
    const disabled = await harness.sandbox.exec('curl -sS https://93.184.216.34/v1/data');
    assert.equal(disabled.exitCode, 1);
    assert.match(disabled.stderr, /Connection authority changed/);
    assert.equal(calls.length, 3);
  } finally { await harness.close(); }
});
}

test('native Google session mounts only the narrowed binding and injects its OAuth token', async (t) => {
  const store = getConfigStore();
  const identity = getIdentityStore();
  const scopes = ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/drive.readonly'];
  const policy = { kind: 'api' as const, authMode: 'oauth' as const, oauthProvider: 'google' as const, oauthScopes: scopes, ...googleWorkspaceApiPolicy(scopes) };
  const agent = { id: 'agent_google_test', kind: 'user', revision: 1, name: 'Google', instructions: 'Read Drive', enabled: true, model: 'local-stub/proof', skills: [], mcpServers: [], apiConnections: [], repositories: [] };
  const account = { id: 'connection_google', workspaceId: 'T_TEST', revision: 1, ownerKind: 'member', ownerMembershipId: 'member', createdByMembershipId: 'member', providerId: 'google', label: 'Google', policy, lifecycle: 'ready', createdAt: 1, updatedAt: 1 };
  const binding = { agentId: agent.id, connectionAccountId: account.id, providerId: 'google', allowedCapabilities: [scopes[1]!], enabled: true, createdAt: 1, updatedAt: 1 };
  t.mock.method(store, 'getAgent', async () => agent);
  t.mock.method(store, 'listConnectionAccounts', async () => [account]);
  t.mock.method(store, 'listAgentConnectionBindings', async () => [binding]);
  t.mock.method(identity, 'getOrganization', async () => ({ id: 'org', slackTeamId: 'T_TEST' }));
  t.mock.method(identity, 'getMembership', async () => ({ id: 'member', organizationId: 'org', status: 'active', userId: 'user' }));
  t.mock.method(identity, 'getMembershipAccessOverlay', async () => undefined);
  t.mock.method(identity, 'getUser', async () => ({ id: 'user', slackTeamId: 'T_TEST', slackUserId: 'U_TEST' }));
  t.mock.method(identity, 'resolveSlackIdentity', async () => ({ user: { id: 'user' }, membership: { id: 'member' }, binding: { membershipId: 'member' } }));
  const tokenKey = apiOAuthSettingKeys(connectionAccountOAuthRef(account.id))[2];
  const tokenReads = t.mock.method(getSettingsStore(), 'getSetting', async (key: string) => key === tokenKey
    ? JSON.stringify({ provider: 'google', accessToken: 'fixture-google-token', tokenType: 'Bearer', obtainedAt: Date.now() })
    : undefined);
  const calls: { url: string; authorization: string | null; nonce: string }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    const nonce = randomUUID();
    calls.push({ url: String(url), authorization: new Headers(options.headers).get('authorization'), nonce });
    return Response.json({ files: [], nonce });
  });
  const effectiveConnections = await resolveEffectiveConnectionAccounts({ config: store, workspaceId: 'T_TEST', agentId: agent.id, actorMembershipId: 'member' });
  const plan = compileRuntimePlanV2({ turn: { workspaceId: 'T_TEST', channelId: 'C_TEST', eventId: 'E_GOOGLE', text: 'Read', userId: 'U_TEST', actorMembershipId: 'member', messageTs: '1787000000.000200', threadTs: '1787000000.000100', source: 'app_mention', contextMode: 'thread' }, assignment: { workspaceId: 'T_TEST', channelId: 'C_TEST', agentId: agent.id, agent, model: agent.model, modelAttribution: { source: 'workspace_default', providerId: 'local-stub', workspaceDefaultRevision: 1 } }, instructions: agent.instructions, memoryEpoch: 1, sandboxMode: 'bash', effectiveConnections } as any);
  assert.deepEqual(plan.apiConnections[0]?.allowedHosts, ['www.googleapis.com']);
  assert.deepEqual(plan.apiConnections[0]?.pathPrefixes, ['/drive/v3']);
  assert.deepEqual(plan.apiConnections[0]?.allowedMethods, ['GET', 'HEAD']);
  assert.doesNotMatch(JSON.stringify(plan), /fixture-google-token/);
  const context = createFlueContext({ id: 'google-test', agentName: 'chickpea-slack-v2', env: {}, agentConfig: { resolveModel: () => ({}) } as any });
  const signal = { kind: 'signal', type: 'slack.message', tagName: 'slack_message', body: serializeCurrentRequestEnvelope('Read', false, 'U_TEST', '1787000000.000200', { schemaVersion: 2, progressiveStreamingOffered: true }), attributes: { workspaceId: 'T_TEST', channelId: 'C_TEST', threadTs: plan.conversation.threadTs, slackUserId: 'U_TEST', eventId: 'E_GOOGLE', messageTs: '1787000000.000200', turnJobId: 'google-proof' } } as any;
  const harness = await context.initializeRootHarness(ChickpeaSlack, signal, plan);
  try {
    assert.doesNotMatch(String((harness as any).config.instructions), /fixture-google-token/);
    const read = await harness.sandbox.exec('curl -sS "https://www.googleapis.com/drive/v3/files?pageSize=1"');
    assert.ok(tokenReads.mock.calls.some(({ arguments: args }) => args[0] === tokenKey), JSON.stringify({ declaration: plan.apiConnections, keys: tokenReads.mock.calls.map(({ arguments: args }) => args[0]) }));
    assert.equal(read.exitCode, 0, JSON.stringify(read));
    assert.equal(JSON.parse(read.stdout).nonce, calls[0]?.nonce);
    assert.equal(calls[0]?.authorization, 'Bearer fixture-google-token');
    const post = await harness.sandbox.exec('curl -sS -X POST https://www.googleapis.com/drive/v3/files');
    assert.equal(post.exitCode, 3);
    assert.match(post.stderr, /HTTP method 'POST' not allowed/);
    for (const url of ['https://www.googleapis.com/upload/drive/v3/files', 'https://gmail.googleapis.com/gmail/v1/users/me/messages']) {
      const denied = await harness.sandbox.exec(`curl -sS ${url}`);
      assert.equal(denied.exitCode, 7);
      assert.match(denied.stderr, /not in allow-list/);
    }
    assert.equal(calls.length, 1);
  } finally { await harness.close(); }
});

test('REST frozen ceiling rejects wider or changed identity and permits narrowing', () => {
  const frozen = { id: 'rest', ...basePolicy };
  assert.equal(runtimeApiDeclarationStillAllowed({ ...frozen, allowedMethods: ['GET'], pathPrefixes: ['/v1/data'] }, frozen), true);
  for (const change of [{ allowedMethods: ['DELETE'] }, { allowedHosts: ['evil.example'] }, { headerName: 'Other' }, { headerValuePrefix: 'Other ' }, { pathPrefixes: ['/v10'] }, { oauthScopes: ['extra'] }]) {
    assert.equal(runtimeApiDeclarationStillAllowed({ ...frozen, ...change }, frozen), false);
  }
});
