import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { CfManagementStore } from '../src/config/cf-state-proxies.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import type { TagStateRpc } from '../src/config/state-rpc.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteManagementStore } from '../src/management/store.ts';
import type { ManagementReceiptOutboxRecord, ManagementRpcRequest } from '../src/management/types.ts';
import type { SlackStateStore } from '../src/slack/claim-store.ts';
import type { SlackRunPresentation } from '../src/slack/run-presentations.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';

const TOKEN = 'creation-status-test-token';
const principal: AuthPrincipal = {
  userId: 'user_test_owner', membershipId: 'membership_test_owner', organizationId: 'org_oss',
  role: 'owner', authenticatorKind: 'test_slack_session', credentialId: 'session_test_owner',
  correlationId: 'request_test_owner', machine: false,
};
const root = { workspaceId: 'T_TEST', channelId: 'C_CREATE', threadTs: '1800000000.000100' };
function welcome(id = 'welcome_1'): ManagementReceiptOutboxRecord {
  return {
    outboxId: id, operationId: id, destination: { kind: 'thread', ...root },
    receipt: {
      kind: 'agent_created_welcome', agentId: 'agent_create', agentName: 'Private name',
      requesterMembershipId: principal.membershipId, surface: 'channel',
      persona: { name: 'Private persona' }, presentationRunId: 'run_create',
      publication: { status: 'complete', incomplete: [] },
      setupUrl: 'https://example.test/secret-token',
      followOnNotices: [{ kind: 'pending', text: 'Private message' }],
    },
    status: 'delivered', attempts: 1, nextAttemptAt: 1, createdAt: 1, updatedAt: 2,
    deliveryRef: 'C_CREATE:1800000001.000100',
  };
}

test('creation receipt query scopes before limiting and survives the Cloudflare RPC without mutation', async () => {
  const direct = new SqliteManagementStore(':memory:');
  const proxy = new CfManagementStore({
    managementExecute: async (request: ManagementRpcRequest) => ({ ok: true, value: await direct.execute(request) }),
  } as TagStateRpc);
  const query = { kind: 'list_agent_creation_welcomes', workspaceId: 'T_TEST', agentId: 'agent_create', requesterMembershipId: principal.membershipId } as const;
  try {
    assert.deepEqual(await proxy.execute(query), { kind: 'outbox_batch', outbox: [] });
    for (const id of ['one', 'two', 'three']) await direct.putOutbox(welcome(id));
    const foreignWorkspace = welcome('foreign_workspace');
    foreignWorkspace.destination = { kind: 'thread', ...root, workspaceId: 'T_OTHER' };
    const foreignActor = welcome('foreign_actor');
    if ('kind' in foreignActor.receipt && foreignActor.receipt.kind === 'agent_created_welcome') foreignActor.receipt.requesterMembershipId = 'other';
    const foreignAgent = welcome('foreign_agent');
    if ('kind' in foreignAgent.receipt && foreignAgent.receipt.kind === 'agent_created_welcome') foreignAgent.receipt.agentId = 'other';
    const otherKind = welcome('other_kind');
    otherKind.receipt = { kind: 'chickpea_introduction', trigger: 'first_owner' };
    for (const record of [foreignWorkspace, foreignActor, foreignAgent, otherKind]) await direct.putOutbox({ ...record, createdAt: 10 });
    const before = await direct.getOutboxForOperation('two');
    const result = await proxy.execute(query);
    assert.equal(result.kind, 'outbox_batch');
    if (result.kind !== 'outbox_batch') throw new Error('wrong RPC response');
    assert.deepEqual(result.outbox.map((row) => row.outboxId), ['two', 'three']);
    assert.deepEqual(await direct.getOutboxForOperation('two'), before);
  } finally { direct.close(); }
});

test('creation status is an authenticated, content-free read of correlated durable records', async () => {
  const store = new SqliteConfigStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const management = new SqliteManagementStore(':memory:');
  let presentation: SlackRunPresentation | undefined = {
    schemaVersion: 3, root, activityProjection: { surface: 'message', state: 'cleared' },
    cleanup: { state: 'not_required' }, lifecyclePhase: 'settled',
    currentActivity: { object: 'Private activity text' },
  } as SlackRunPresentation;
  let reads = 0;
  const makeApp = (actor = principal) => createAdminRoutes({
    store, settings, management, ...testAdminAuthority(TOKEN, undefined, undefined, actor),
    slackState: { getRunPresentation: async (id: string) => { reads++; assert.equal(id, 'run_create'); return presentation; } } as SlackStateStore,
  });
  const path = '/admin/api/runtime/agents/agent_create/creation-status';
  const headers = testAdminHeaders(TOKEN);
  try {
    await store.createAgent({ id: 'agent_create', name: 'Creation', instructions: 'Private instructions', enabled: true, skills: [], mcpServers: [], apiConnections: [], repositories: [] });
    await management.putOutbox(welcome());
    const before = await management.getOutboxForOperation('welcome_1');
    const app = makeApp();
    assert.notEqual((await app.request(path)).status, 200);
    for (const actor of [{ ...principal, role: 'member' as const }, { ...principal, machine: true }]) {
      assert.equal((await makeApp(actor).request(path, { headers })).status, 403);
    }
    assert.equal(reads, 0);
    const response = await app.request(path, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.deepEqual(body, { agentId: 'agent_create', welcomes: [{
      outboxId: 'welcome_1', status: 'delivered', channelId: root.channelId, threadTs: root.threadTs,
      publication: { status: 'complete', incomplete: [] }, deliveryRef: 'C_CREATE:1800000001.000100',
      activity: { surface: 'message', state: 'cleared', cleanup: 'not_required', lifecycle: 'settled' },
    }] });
    assert.doesNotMatch(JSON.stringify(body), /Private|secret-token|presentationRunId/);
    assert.deepEqual(await management.getOutboxForOperation('welcome_1'), before);
    for (const missing of [undefined, { ...presentation, root: { ...root, threadTs: 'other' } } as SlackRunPresentation]) {
      presentation = missing;
      const next = await app.request(path, { headers });
      assert.equal((await next.json()).welcomes[0].activity, null);
    }
    const otherActor = await makeApp({ ...principal, membershipId: 'other' }).request(path, { headers });
    assert.deepEqual(await otherActor.json(), { agentId: 'agent_create', welcomes: [] });
    assert.equal((await app.request(path.replace('agent_create', 'missing'), { headers })).status, 404);
  } finally { management.close(); settings.close(); store.close(); }
});
