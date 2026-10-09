import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { inspect } from 'node:util';

import type { WebClient } from '@slack/web-api';

import { CHICKPEA_AGENT_ID } from '../src/config/agent-id.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { createLiveWorkspaceManagementService } from '../src/management/live-service.ts';
import { deliverManagementReceiptToSlack } from '../src/management/receipts.ts';
import {
  invokeSlackWorkspaceManagementTool,
  resolveSlackManagementActor,
  type SlackManagementSignal,
} from '../src/management/slack-tools.ts';
import type { ManagementApplyResult } from '../src/management/types.ts';
import { syncHostedWorkspaceInstallation } from '../src/slack/hosted-installation.ts';
import {
  invalidateSlackInstallationCredentialCache,
  writeHostedSlackBotCredentials,
} from '../src/slack/installation-credentials.ts';
import { REQUESTED_SLACK_BOT_SCOPES } from '../src/slack/scopes.ts';
import { useDeploymentKeyring } from './helpers/deployment-keyring.ts';
import { withEnv } from './helpers/env.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

const HOSTED = { CHICKPEA_TENANCY: 'installation' } as Record<string, unknown>;

function fakeSlackWorkspace(t: TestContext) {
  const groups = [
    { id: 'S0SUPPORT', name: 'Customer Support', handle: 'support', date_update: 1, date_delete: 0 },
  ];
  const memberUsernames = new Set(['support-team']);
  const createdHandles: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const method = new URL(request.url).pathname.split('/').at(-1);
    if (method === 'usergroups.list') return Response.json({ ok: true, usergroups: groups });
    if (method !== 'usergroups.create') throw new Error(`Unexpected Slack call: ${method}`);
    const form = new URLSearchParams(await request.text());
    const handle = form.get('handle') ?? '';
    createdHandles.push(handle);
    if (memberUsernames.has(handle) || groups.some((group) => group.handle === handle)) {
      return Response.json({ ok: false, error: 'handle_already_exists' });
    }
    const group = {
      id: `S0${groups.length}`, name: form.get('name') ?? '', handle, date_update: 2, date_delete: 0,
    };
    groups.push(group);
    return Response.json({ ok: true, usergroup: group });
  });
  return { groups, createdHandles };
}

test('a Slack request for a taken @support publishes @support-2 and welcomes as the Agent with a Zendesk link', async (t) => {
  const slack = fakeSlackWorkspace(t);
  await withEnv({ CHICKPEA_TENANCY: undefined, SLACK_STATE_DB_PATH: ':memory:' }, async () => {
    const env = scopeInstallationEnv(HOSTED, { installationId: 'inst_s2_handle' });
    const keyring = useDeploymentKeyring(t);
    const f = await createManagementAdapterFixture('s2-handle-live');
    const settings = new SqliteSettingsStore(':memory:');
    t.after(() => {
      f.close();
      settings.close();
      invalidateSlackInstallationCredentialCache();
    });
    const teamId = f.owner.user.slackTeamId;
    const credentials = { state: f.identity, keyring };
    await writeHostedSlackBotCredentials(credentials, null, {
      botToken: 'xoxb-s2-bot', userGroupToken: 'xoxp-s2-owner', botUserId: 'UBOT', appId: 'AHOSTED1', teamId,
      grantedScopes: [...REQUESTED_SLACK_BOT_SCOPES], validatedAt: Date.now(),
    });
    await syncHostedWorkspaceInstallation(env, { teamId, appId: 'AHOSTED1', botUserId: 'UBOT' }, f.config);
    const service = createLiveWorkspaceManagementService(env, {
      identity: f.identity, settings, slackCredentials: credentials,
      overrides: {
        config: f.config, management: f.management, memory: f.memory, routines: f.routines,
        setupBaseUrl: 'http://localhost', now: () => 1_800_000_000_000,
      },
    });
    const signal: SlackManagementSignal = {
      agentId: CHICKPEA_AGENT_ID,
      workspaceId: teamId,
      channelId: 'D0REQUESTER',
      threadTs: '1800000000.000100',
      conversationKind: 'im',
      slackUserId: f.admin.binding.slackUserId,
      eventId: 'Ev0SUPPORT',
      messageTs: '1800000000.000100',
      turnJobId: 'turn_s2_support',
      requesterText: 'create me a <!subteam^S0SUPPORT|@support> agent that ill connect to zendesk',
    };

    const applied = await invokeSlackWorkspaceManagementTool({
      signal, identity: f.identity, service, name: 'apply_workspace_changes',
      args: {
        idempotencyKey: 'create-support',
        operations: [{
          itemId: 'create',
          kind: 'create_agent',
          agent: {
            id: 'agent_support', name: 'Support', requestedHandle: 'support', editPolicy: 'creator_and_admins',
            instructions: 'Draft customer replies.', enabled: true,
            skills: [], mcpServers: [], apiConnections: [], repositories: [],
          },
        }],
      },
    });
    if (!applied.ok) assert.fail(inspect(applied, { depth: 8 }));
    const result = applied.result as ManagementApplyResult;
    const [outcome] = result.outcomes;
    assert.deepEqual(
      { status: result.status, disposition: outcome?.disposition, warning: outcome?.warning },
      { status: 'completed', disposition: 'applied', warning: undefined },
    );
    assert.deepEqual(outcome?.handleChange, { requested: 'support', used: 'support-2' });
    assert.deepEqual(slack.createdHandles, ['support-team', 'support-2'], 'Slack never saw @support created');
    const presence = (await f.config.getAgent('agent_support')).slackPresence;
    assert.deepEqual(
      { handle: presence?.normalizedHandle, health: presence?.health, userGroupId: presence?.userGroupId },
      {
        handle: 'support-2',
        health: 'healthy',
        userGroupId: slack.groups.find((group) => group.handle === 'support-2')?.id,
      },
    );

    const finalized = await service.finalizeSlackAgentCreationWelcome({
      context: await resolveSlackManagementActor(signal, f.identity),
      operationId: result.operationId,
      creationItemId: 'create',
      agentId: 'agent_support',
      connectorMentions: ['zendesk'],
      followOnNotices: [],
      turnJobId: signal.turnJobId,
    });
    const posts: Array<Record<string, unknown>> = [];
    const delivered = await deliverManagementReceiptToSlack(finalized.outbox, {
      identity: f.identity,
      resolveInstallation: async (workspaceId) => ({
        workspaceId,
        transportMode: 'direct',
        sharedAppReads: false,
        botUserId: 'UBOT',
        client: {
          chat: {
            async postMessage(message: Record<string, unknown>) {
              posts.push(message);
              return { ok: true, ts: '1800000000.000200' };
            },
          },
        } as unknown as WebClient,
      }),
    });

    assert.equal(posts.length, 1);
    assert.equal(delivered.deliveryPersona, 'agent');
    assert.deepEqual(
      { channel: posts[0]!.channel, thread: posts[0]!.thread_ts, username: posts[0]!.username },
      { channel: 'D0REQUESTER', thread: '1800000000.000100', username: 'Support' },
    );
    const text = String(posts[0]!.text);
    const paragraphs = text.split('\n\n');
    assert.equal(paragraphs[0], 'Hi — I’m *Support* (@support-2).');
    assert.equal(
      paragraphs[1],
      '@support was already taken in this Slack workspace, so my handle is @support-2. You can change it any time from View Agent.',
    );
    assert.equal(
      paragraphs.filter((paragraph) => /^<http:\/\/localhost\/setup\/[^|>]+\|Connect Zendesk>$/.test(paragraph)).length,
      1,
      text,
    );
    assert.equal(paragraphs.at(-1), '<http://localhost/admin/agents/agent_support|View Agent>');
    assert.doesNotMatch(text, /identity/i);
  });
});
