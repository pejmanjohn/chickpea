import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { inspect } from 'node:util';

import { CHICKPEA_AGENT_ID } from '../src/config/agent-id.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import { createLiveWorkspaceManagementService } from '../src/management/live-service.ts';
import { invokeSlackWorkspaceManagementTool, type SlackManagementSignal } from '../src/management/slack-tools.ts';
import type {
  ManagementActorContext,
  ManagementAgentCreateInput,
  ManagementApplyResult,
  ManagementItemOutcome,
  ManagementOperation,
} from '../src/management/types.ts';
import { syncHostedWorkspaceInstallation } from '../src/slack/hosted-installation.ts';
import {
  invalidateSlackInstallationCredentialCache,
  writeHostedSlackBotCredentials,
} from '../src/slack/installation-credentials.ts';
import { REQUESTED_SLACK_BOT_SCOPES } from '../src/slack/scopes.ts';
import { useDeploymentKeyring } from './helpers/deployment-keyring.ts';
import { withEnv } from './helpers/env.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

/**
 * Slack keeps user-group handles unique, but not the bot names of Agents with
 * their own app, so Chickpea keeps its own rule. Choosing a handle (creating
 * or renaming an Agent) refuses one any other unarchived Agent stores:
 * creation picks a free handle and says so, and a rename is refused as
 * Slack's would be. Taking a handle in Slack, restore included, refuses one
 * only another Agent in Slack holds.
 */

const HOSTED = { CHICKPEA_TENANCY: 'installation' } as Record<string, unknown>;

/** Slack's user groups, refusing a handle or name another group has, as Slack does. */
function fakeSlackWorkspace(t: TestContext) {
  const groups = [{ id: 'S0DESK', name: 'Desk', handle: 'desk', description: 'Desk Agent', date_update: 1, date_delete: 0 }];
  const created: string[] = [];
  const updated: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const method = new URL(request.url).pathname.split('/').at(-1);
    if (method === 'usergroups.list') return Response.json({ ok: true, usergroups: groups });
    const form = new URLSearchParams(await request.text());
    const handle = form.get('handle') ?? '';
    if (method === 'usergroups.create') {
      created.push(handle);
      if (groups.some((group) => group.handle === handle)) return Response.json({ ok: false, error: 'handle_already_exists' });
      if (groups.some((group) => group.name === form.get('name'))) return Response.json({ ok: false, error: 'name_already_exists' });
      const group = { id: `S0${groups.length}`, name: form.get('name') ?? '', handle, description: form.get('description') ?? '', date_update: 2, date_delete: 0 };
      groups.push(group);
      return Response.json({ ok: true, usergroup: group });
    }
    if (method === 'usergroups.update') {
      updated.push(handle);
      const group = groups.find(({ id }) => id === form.get('usergroup'));
      if (!group) return Response.json({ ok: false, error: 'no_such_subteam' });
      if (groups.some((other) => other.id !== group.id && other.handle === handle)) {
        return Response.json({ ok: false, error: 'handle_already_exists' });
      }
      Object.assign(group, { handle: handle || group.handle, name: form.get('name') ?? group.name, date_update: 3 });
      return Response.json({ ok: true, usergroup: group });
    }
    throw new Error(`Unexpected Slack call: ${method}`);
  });
  return { groups, created, updated };
}

const BASE = {
  editPolicy: 'creator_and_admins' as const, lifecycle: 'active' as const, configurationGeneration: 1, enabled: true,
  skills: [], mcpServers: [], apiConnections: [], repositories: [],
};

async function handleFixture(t: TestContext) {
  const slack = fakeSlackWorkspace(t);
  const env = scopeInstallationEnv(HOSTED, { installationId: 'inst_s3a_handles' });
  const keyring = useDeploymentKeyring(t);
  const f = await createManagementAdapterFixture('s3a-handles');
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => {
    f.close();
    settings.close();
    invalidateSlackInstallationCredentialCache();
  });
  const teamId = f.owner.user.slackTeamId;
  const credentials = { state: f.identity, keyring };
  await writeHostedSlackBotCredentials(credentials, null, {
    botToken: 'xoxb-s3a-bot', userGroupToken: 'xoxp-s3a-owner', botUserId: 'UBOT', appId: 'AHOSTED1', teamId,
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
  // Helpdesk answers as its own app's bot, whose name is @support; Slack has no group for it.
  const helpdesk = await f.config.createAgent({
    ...BASE, id: 'agent_helpdesk', name: 'Helpdesk', instructions: 'Answer tickets.', creatorMembershipId: f.admin.membership.id,
  });
  await f.config.updateAgent(helpdesk.id, {
    slackPresence: {
      kind: 'agent_app', requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active', health: 'healthy',
      avatar: helpdesk.slackPresence!.avatar,
      app: {
        state: 'active', at: 1, app: { appId: 'A0HELPDESK', clientId: '1.client' }, icon: 'agent_avatar',
        botUserId: 'UHELPDESKBOT', installedAt: 1, installedBy: f.admin.binding.slackUserId,
      },
    },
  }, helpdesk.revision);
  const desk = await f.config.createAgent({
    ...BASE, id: 'agent_desk', name: 'Desk', description: 'Desk Agent', instructions: 'Answer the front desk.',
    creatorMembershipId: f.admin.membership.id,
  });
  await f.config.updateAgent(desk.id, {
    slackPresence: {
      ...desk.slackPresence!, kind: 'user_group', requestedHandle: 'desk', normalizedHandle: 'desk',
      desiredState: 'active', health: 'healthy', userGroupId: 'S0DESK',
    },
  }, desk.revision);
  const member = (await f.identity.provisionSlackMember({
    slackTeamId: teamId, slackUserId: 'UMEMBERS3A', displayName: 'Member',
  })).resolution!;
  const context = (who: { user: { id: string }; membership: { id: string; organizationId: string } }): ManagementActorContext => ({
    userId: who.user.id, membershipId: who.membership.id, organizationId: who.membership.organizationId,
    origin: { kind: 'mcp', clientId: 's3a-handles' },
  });
  let sequence = 0;
  const slackSignal = (slackUserId: string, requesterText: string): SlackManagementSignal => {
    sequence += 1;
    return {
      agentId: CHICKPEA_AGENT_ID, workspaceId: teamId, channelId: 'D0REQUESTER', threadTs: '1800000000.000100',
      conversationKind: 'im', slackUserId, eventId: `Ev0S3A${sequence}`, messageTs: `1800000000.00010${sequence}`,
      turnJobId: `turn_s3a_${sequence}`, requesterText,
    };
  };
  const slackApply = async (slackUserId: string, requesterText: string, operations: ManagementOperation[]): Promise<ManagementItemOutcome[]> => {
    const applied = await invokeSlackWorkspaceManagementTool({
      signal: slackSignal(slackUserId, requesterText), identity: f.identity, service, name: 'apply_workspace_changes',
      args: { idempotencyKey: `s3a-${sequence}`, operations },
    });
    if (!applied.ok) assert.fail(inspect(applied, { depth: 8 }));
    return (applied.result as ManagementApplyResult).outcomes;
  };
  const handleOf = async (agentId: string) => (await f.config.getAgent(agentId)).slackPresence?.normalizedHandle;
  return { f, slack, service, member, context, slackApply, handleOf };
}

function createSupport(id: string, requestedHandle = 'support'): Extract<ManagementOperation, { kind: 'create_agent' }> {
  const agent: ManagementAgentCreateInput = {
    id, name: 'Support', requestedHandle, editPolicy: 'creator_and_admins', instructions: 'Draft customer replies.', enabled: true,
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  };
  return { itemId: 'create', kind: 'create_agent', agent };
}

test("a member's request in Slack for a handle an Agent's own app holds creates the Agent on a free handle and says so", async (t) => {
  await withEnv({ CHICKPEA_TENANCY: undefined, SLACK_STATE_DB_PATH: ':memory:' }, async () => {
    const { slack, member, slackApply, handleOf } = await handleFixture(t);
    const [outcome] = await slackApply(member.binding.slackUserId, 'create me a support agent', [createSupport('agent_support')]);
    assert.equal(outcome?.disposition, 'applied', inspect(outcome));
    assert.deepEqual(outcome?.handleChange, { requested: 'support', used: 'support-team' });
    assert.deepEqual(slack.created, ['support-team'], 'Slack never saw @support asked for');
    assert.equal(await handleOf('agent_support'), 'support-team');
    assert.equal(await handleOf('agent_helpdesk'), 'support');
  });
});

test("a member's create_agent over MCP for a handle an Agent's own app holds creates the Agent on a free handle and says so", async (t) => {
  await withEnv({ CHICKPEA_TENANCY: undefined, SLACK_STATE_DB_PATH: ':memory:' }, async () => {
    const { slack, service, member, context, handleOf } = await handleFixture(t);
    const result = await service.applyWorkspaceChanges({
      context: context(member), idempotencyKey: 's3a-mcp', operations: [createSupport('agent_support_mcp')],
    });
    assert.ok('outcomes' in result, inspect(result));
    assert.deepEqual(result.outcomes[0]?.handleChange, { requested: 'support', used: 'support-team' });
    assert.deepEqual(slack.created, ['support-team']);
    assert.equal(await handleOf('agent_support_mcp'), 'support-team');
  });
});

test("a recipe's change set creating an Agent on a handle an Agent's own app holds creates it on a free handle and says so", async (t) => {
  await withEnv({ CHICKPEA_TENANCY: undefined, SLACK_STATE_DB_PATH: ':memory:' }, async () => {
    const { slack, service, f, context, handleOf } = await handleFixture(t);
    // As a recipe compiles one Agent: its creation, then its configuration.
    const result = await service.applyWorkspaceChanges({
      context: context(f.admin), idempotencyKey: 's3a-recipe',
      operations: [
        { ...createSupport('agent_support_recipe'), itemId: 'create_support' },
        {
          itemId: 'configure_support', dependsOn: ['create_support'], kind: 'update_agent',
          agentId: 'agent_support_recipe', expectedRevision: 0, patch: { enabled: false },
        },
      ],
    });
    assert.ok('outcomes' in result, inspect(result));
    assert.deepEqual(result.outcomes[0]?.handleChange, { requested: 'support', used: 'support-team' });
    assert.deepEqual(slack.created, ['support-team']);
    assert.equal(await handleOf('agent_support_recipe'), 'support-team');
  });
});

test("renaming an Agent onto a handle another Agent holds is refused as Slack's refusal is, whichever kind of Agent asks or holds it", async (t) => {
  await withEnv({ CHICKPEA_TENANCY: undefined, SLACK_STATE_DB_PATH: ':memory:' }, async () => {
    const { slack, f, slackApply, handleOf } = await handleFixture(t);
    const rename = async (agentId: string, requestedHandle: string) => {
      const [outcome] = await slackApply(f.admin.binding.slackUserId, `change its handle to @${requestedHandle}`, [{
        itemId: 'rename', kind: 'update_agent', agentId,
        expectedRevision: (await f.config.getAgent(agentId)).revision, patch: { requestedHandle },
      }]);
      assert.ok(outcome);
      return outcome;
    };

    const ontoApp = await rename('agent_desk', 'support');
    assert.deepEqual({ disposition: ontoApp.disposition, code: ontoApp.code }, { disposition: 'failed', code: 'handle_collision' });
    assert.equal(ontoApp.instruction,
      '@support is already taken in this Slack workspace, so nothing changed and the Agent keeps @desk. Suggested handles: @support-team, @support-2, @support-3. Offer these, or ask for another handle.');
    assert.equal(await handleOf('agent_desk'), 'desk');

    const appOntoGroup = await rename('agent_helpdesk', 'desk');
    assert.deepEqual({ disposition: appOntoGroup.disposition, code: appOntoGroup.code }, { disposition: 'failed', code: 'handle_collision' });
    assert.match(appOntoGroup.instruction ?? '', /^@desk is already taken in this Slack workspace, so nothing changed and the Agent keeps @support\./);
    assert.equal(await handleOf('agent_helpdesk'), 'support');
    assert.deepEqual(slack.updated, [], 'Slack is asked for nothing');
  });
});

test("an archived Agent holds no handle: another Agent is renamed onto it, and a new one created with it", async (t) => {
  await withEnv({ CHICKPEA_TENANCY: undefined, SLACK_STATE_DB_PATH: ':memory:' }, async () => {
    const { slack, f, member, slackApply, handleOf } = await handleFixture(t);
    const helpdesk: CustomAgentConfig = await f.config.getAgent('agent_helpdesk');
    await f.config.updateAgent(helpdesk.id, { lifecycle: 'archived' }, helpdesk.revision);

    const [renamed] = await slackApply(f.admin.binding.slackUserId, 'change Desk to @support', [{
      itemId: 'rename', kind: 'update_agent', agentId: 'agent_desk',
      expectedRevision: (await f.config.getAgent('agent_desk')).revision, patch: { requestedHandle: 'support' },
    }]);
    assert.equal(renamed?.disposition, 'applied', inspect(renamed));
    assert.equal(await handleOf('agent_desk'), 'support');
    assert.deepEqual(slack.updated, ['support']);

    const [back] = await slackApply(f.admin.binding.slackUserId, 'change Desk back to @desk', [{
      itemId: 'rename', kind: 'update_agent', agentId: 'agent_desk',
      expectedRevision: (await f.config.getAgent('agent_desk')).revision, patch: { requestedHandle: 'desk' },
    }]);
    assert.equal(back?.disposition, 'applied');
    const [created] = await slackApply(member.binding.slackUserId, 'create me a support agent', [createSupport('agent_support')]);
    assert.equal(created?.disposition, 'applied', inspect(created));
    assert.equal(created?.handleChange, undefined);
    assert.equal(await handleOf('agent_support'), 'support');
  });
});

test("an Agent that shared its handle with an app Agent before Chickpea kept handles unique may still be given the handle it has", async (t) => {
  await withEnv({ CHICKPEA_TENANCY: undefined, SLACK_STATE_DB_PATH: ':memory:' }, async () => {
    const { f, slackApply, handleOf } = await handleFixture(t);
    const created = await f.config.createAgent({
      ...BASE, id: 'agent_support', name: 'Support', instructions: 'Draft customer replies.', creatorMembershipId: f.admin.membership.id,
    });
    await f.config.updateAgent(created.id, {
      slackPresence: { ...created.slackPresence!, requestedHandle: 'support', normalizedHandle: 'support' },
    }, created.revision);
    const [outcome] = await slackApply(f.admin.binding.slackUserId, 'keep Support as @support', [{
      itemId: 'edit', kind: 'update_agent', agentId: 'agent_support',
      expectedRevision: (await f.config.getAgent('agent_support')).revision,
      patch: { requestedHandle: 'support' },
    }]);
    assert.equal(outcome?.disposition, 'applied', inspect(outcome));
    assert.equal(await handleOf('agent_support'), 'support');
  });
});

test("an Agent in Slack that shared its handle with an app Agent before Chickpea kept handles unique still saves, and Slack keeps its group", async (t) => {
  await withEnv({ CHICKPEA_TENANCY: undefined, SLACK_STATE_DB_PATH: ':memory:' }, async () => {
    const { f, slack, service, context, handleOf } = await handleFixture(t);
    slack.groups.push({ id: 'S0SUPPORT', name: 'Support', handle: 'support', description: 'Support Agent', date_update: 1, date_delete: 0 });
    const created = await f.config.createAgent({
      ...BASE, id: 'agent_support', name: 'Support', description: 'Support Agent', instructions: 'Draft customer replies.',
      creatorMembershipId: f.admin.membership.id,
    });
    await f.config.updateAgent(created.id, {
      slackPresence: {
        ...created.slackPresence!, kind: 'user_group', requestedHandle: 'support', normalizedHandle: 'support',
        desiredState: 'active', health: 'healthy', userGroupId: 'S0SUPPORT',
      },
    }, created.revision);
    const result = await service.applyWorkspaceChanges({
      context: context(f.admin), idempotencyKey: 's3a-sharer',
      operations: [{
        itemId: 'edit', kind: 'update_agent', agentId: 'agent_support',
        expectedRevision: (await f.config.getAgent('agent_support')).revision,
        patch: { description: 'The support desk', requestedHandle: 'support' },
      }],
    });
    assert.ok('outcomes' in result, inspect(result));
    const [outcome] = result.outcomes;
    assert.equal(outcome?.disposition, 'applied', inspect(outcome));
    assert.equal(await handleOf('agent_support'), 'support');
    assert.deepEqual(slack.updated, ['support'], 'Slack is asked, and keeps the handle');
  });
});

test("restoring an Agent over MCP while another Agent in Slack took its handle is refused with what to do, and Slack is asked nothing", async (t) => {
  await withEnv({ CHICKPEA_TENANCY: undefined, SLACK_STATE_DB_PATH: ':memory:' }, async () => {
    const { f, slack, service, context, handleOf } = await handleFixture(t);
    const desk = await f.config.getAgent('agent_desk');
    const archived = await f.config.updateAgent(desk.id, { lifecycle: 'archived' }, desk.revision);
    const helpdesk = await f.config.getAgent('agent_helpdesk');
    await f.config.updateAgent(helpdesk.id, {
      slackPresence: { ...helpdesk.slackPresence!, requestedHandle: 'desk', normalizedHandle: 'desk' },
    }, helpdesk.revision);

    const result = await service.applyWorkspaceChanges({
      context: context(f.admin), idempotencyKey: 's3a-restore',
      operations: [{ itemId: 'restore', kind: 'restore_agent', agentId: 'agent_desk', expectedRevision: archived.revision }],
    });
    assert.ok('outcomes' in result, inspect(result));
    const [outcome] = result.outcomes;
    assert.deepEqual({ disposition: outcome?.disposition, code: outcome?.code }, { disposition: 'failed', code: 'handle_collision' });
    assert.equal(outcome?.instruction, 'Another Agent in Slack uses @desk. Rename or archive that Agent, then restore this one.');
    assert.equal((await f.config.getAgent('agent_desk')).lifecycle, 'archived');
    assert.equal(await handleOf('agent_desk'), 'desk');
    assert.deepEqual({ created: slack.created, updated: slack.updated }, { created: [], updated: [] });
  });
});
