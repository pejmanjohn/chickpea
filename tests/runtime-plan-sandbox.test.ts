import assert from 'node:assert/strict';
import test from 'node:test';
import { createFlueContext } from '@flue/runtime/internal';
import { ChickpeaSlack, runtimeApiDeclarationStillAllowed } from '../src/agents/slack-thread.ts';
import { compileRuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import { getConfigStore, getIdentityStore, getSettingsStore } from '../src/config/state-backend.ts';
import { connectionAccountSecretSettingKey } from '../src/config/connector-secrets.ts';
import { serializeCurrentRequestEnvelope } from '../src/memory/tool-policy.ts';

const policy = { kind: 'api' as const, authMode: 'credential' as const, allowedHosts: ['93.184.216.34', 'app.asana.com'], pathPrefixes: ['/v1'], headerName: 'X-Test-Key', headerValuePrefix: 'Token ', allowedMethods: ['GET', 'POST'] };

test('native runtime mounts credentialed REST and denies changed authority in the same sandbox', async (t) => {
  const store = getConfigStore();
  const identity = getIdentityStore();
  const agent = { id: 'agent_rest_test', kind: 'user', revision: 1, name: 'REST', instructions: 'Read the API', enabled: true, model: 'local-stub/proof', skills: [], mcpServers: [], apiConnections: [], repositories: [] };
  const account = { id: 'connection_rest', workspaceId: 'T_TEST', revision: 1, ownerKind: 'team', createdByMembershipId: 'member', providerId: 'custom', label: 'REST', policy, secretRefId: 'rest_test', lifecycle: 'ready', createdAt: 1, updatedAt: 1 };
  const binding = { agentId: agent.id, connectionAccountId: account.id, providerId: 'custom', allowedCapabilities: ['GET', 'POST'], enabled: true, createdAt: 1, updatedAt: 1 };
  t.mock.method(store, 'getAgent', async () => agent);
  t.mock.method(store, 'listConnectionAccounts', async () => [account]);
  t.mock.method(store, 'listAgentConnectionBindings', async () => [binding]);
  t.mock.method(identity, 'getOrganization', async () => ({ id: 'org', slackTeamId: 'T_TEST' }));
  t.mock.method(identity, 'getMembership', async () => ({ id: 'member', organizationId: 'org', status: 'active', userId: 'user' }));
  t.mock.method(identity, 'getMembershipAccessOverlay', async () => undefined);
  t.mock.method(identity, 'getUser', async () => ({ id: 'user', slackTeamId: 'T_TEST', slackUserId: 'U_TEST' }));
  t.mock.method(identity, 'resolveSlackIdentity', async () => ({ user: { id: 'user' }, membership: { id: 'member' }, binding: { membershipId: 'member' } }));
  const settings = getSettingsStore();
  t.mock.method(settings, 'getSetting', async (key: string) => key === connectionAccountSecretSettingKey('rest_test') ? 'fixture-secret' : undefined);
  const calls: { url: string; headers: Headers }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(options.headers) });
    return String(url).endsWith('/redirect')
      ? new Response(null, { status: 302, headers: { location: 'https://93.184.216.35/v1/data' } })
      : new Response('fixture-response');
  });
  const plan = compileRuntimePlanV2({ turn: { workspaceId: 'T_TEST', channelId: 'C_TEST', eventId: 'E_TEST', text: 'Read', userId: 'U_TEST', actorMembershipId: 'member', messageTs: '1787000000.000200', threadTs: '1787000000.000100', source: 'app_mention', contextMode: 'thread' }, assignment: { workspaceId: 'T_TEST', channelId: 'C_TEST', agentId: agent.id, agent, model: agent.model, modelAttribution: { source: 'workspace_default', providerId: 'local-stub', workspaceDefaultRevision: 1 } }, instructions: agent.instructions, memoryEpoch: 1, sandboxMode: 'bash', effectiveConnections: [{ account, binding, policy, scope: 'team' }] } as any);
  assert.doesNotMatch(JSON.stringify(plan), /fixture-secret/);
  const context = createFlueContext({ id: 'rest-test', agentName: 'chickpea-slack-v2', env: {}, agentConfig: { resolveModel: () => ({}) } as any });
  const harness = await context.initializeRootHarness(ChickpeaSlack, { kind: 'signal', type: 'slack.message', tagName: 'slack_message', body: serializeCurrentRequestEnvelope('Read', false, 'U_TEST', '1787000000.000200', { schemaVersion: 2, progressiveStreamingOffered: true }), attributes: { workspaceId: 'T_TEST', channelId: 'C_TEST', threadTs: plan.conversation.threadTs, slackUserId: 'U_TEST', eventId: 'E_TEST', messageTs: '1787000000.000200', turnJobId: 'proof' } } as any, plan);
  try {
    assert.ok((harness as any).config.skills['asana-api']);
    const first = await harness.sandbox.exec('curl -sS https://93.184.216.34/v1/data');
    assert.equal(first.exitCode, 0, JSON.stringify(first));
    assert.equal(calls[0]?.headers.get('x-test-key'), 'Token fixture-secret');
    assert.notEqual((await harness.sandbox.exec('curl -sS https://93.184.216.35/v1/data')).exitCode, 0);
    assert.notEqual((await harness.sandbox.exec('curl -sS -L https://93.184.216.34/v1/redirect')).exitCode, 0);
    assert.equal(calls.length, 2);
    binding.allowedCapabilities = ['GET'];
    assert.notEqual((await harness.sandbox.exec('curl -sS -X POST https://93.184.216.34/v1/data')).exitCode, 0);
    assert.equal(calls.length, 2);
    binding.allowedCapabilities = ['GET', 'POST'];
    binding.enabled = false;
    assert.notEqual((await harness.sandbox.exec('curl -sS https://93.184.216.34/v1/data')).exitCode, 0);
    assert.equal(calls.length, 2);
  } finally { await harness.close(); }
});

test('REST frozen ceiling rejects wider or changed identity and permits narrowing', () => {
  const frozen = { id: 'rest', ...policy };
  assert.equal(runtimeApiDeclarationStillAllowed({ ...frozen, allowedMethods: ['GET'], pathPrefixes: ['/v1/data'] }, frozen), true);
  for (const change of [{ allowedMethods: ['DELETE'] }, { allowedHosts: ['evil.example'] }, { headerName: 'Other' }, { headerValuePrefix: 'Other ' }, { pathPrefixes: ['/v10'] }, { oauthScopes: ['extra'] }]) {
    assert.equal(runtimeApiDeclarationStillAllowed({ ...frozen, ...change }, frozen), false);
  }
});
