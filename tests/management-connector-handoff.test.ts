import assert from 'node:assert/strict';
import { test } from 'node:test';

import { invokeWorkspaceManagementTool } from '../src/management/tool-adapter.ts';
import {
  invokeSlackWorkspaceManagementTool,
  parseSlackManagementSignal,
} from '../src/management/slack-tools.ts';
import { safeSlackLoginDestination } from '../src/auth/setup-handoff.ts';
import type { ManagementActorContext } from '../src/management/types.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

test('connector setup handoff resolves the current Slack Agent and opens its connector form', async () => {
  const f = await createManagementAdapterFixture('connector-handoff');
  const agent = await f.config.createAgent({
    id: 'agent_support',
    name: 'Support',
    description: 'Helps the support team.',
    creatorMembershipId: f.admin.membership.id,
    editPolicy: 'creator_and_admins',
    lifecycle: 'active',
    configurationGeneration: 1,
    instructions: 'Help with support.',
    enabled: true,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  });
  const context: ManagementActorContext = {
    userId: f.admin.user.id,
    membershipId: f.admin.membership.id,
    organizationId: f.admin.membership.organizationId,
    origin: {
      kind: 'slack',
      workspaceId: f.admin.binding.slackTeamId,
      channelId: 'C_SUPPORT',
      threadTs: '100.1',
      agentId: agent.id,
    },
  };
  try {
    const result = await invokeWorkspaceManagementTool({
      service: f.service,
      resolveContext: async () => context,
    }, 'prepare_connector_setup', {
      connector: 'Gmail',
      ownerKind: 'member',
    });
    assert.equal(result.ok, true);
    const handoff = (result as { ok: true; result: {
      agent: { id: string; name: string };
      connector: { id: string; name: string };
      handoffUrl: string;
    } }).result;
    assert.deepEqual(handoff.agent, { id: 'agent_support', name: 'Support' });
    assert.deepEqual(handoff.connector, { id: 'gmail', name: 'Gmail' });
    const url = new URL(handoff.handoffUrl);
    assert.equal(url.pathname, '/admin/agents/agent_support/connections/new/gmail/member');
    assert.equal(url.search, '');
    assert.equal(safeSlackLoginDestination(url.pathname), url.pathname);

    const inspected = await invokeWorkspaceManagementTool({
      service: f.service,
      resolveContext: async () => context,
    }, 'inspect_workspace', {});
    assert.equal(inspected.ok, true);
    assert.ok((inspected as { ok: true; result: {
      connectors: Array<{ id: string; name: string; description: string }>;
    } }).result.connectors.some(({ id, name, description }) =>
      id === 'gmail' && name === 'Gmail' && description.length > 0));

    const teamOwner = await invokeWorkspaceManagementTool({
      service: f.service,
      resolveContext: async () => context,
    }, 'prepare_connector_setup', { connector: 'Linear', ownerKind: 'team' });
    assert.equal(teamOwner.ok, true);
    assert.equal(
      new URL((teamOwner as { ok: true; result: { handoffUrl: string } }).result.handoffUrl)
        .pathname,
      '/admin/agents/agent_support/connections/new/linear/team',
    );

    const unknown = await invokeWorkspaceManagementTool({
      service: f.service,
      resolveContext: async () => context,
    }, 'prepare_connector_setup', {
      connector: 'Definitely Not A Connector',
      ownerKind: 'team',
    });
    assert.equal(unknown.ok, false);
    assert.equal((unknown as { ok: false; error: { code: string } }).error.code, 'invalid_request');

    for (const invalidAgentId of ['.', '..']) {
      const invalidAgent = await invokeWorkspaceManagementTool({
        service: f.service,
        resolveContext: async () => context,
      }, 'prepare_connector_setup', {
        agentId: invalidAgentId,
        connector: 'Gmail',
        ownerKind: 'member',
      });
      assert.equal(invalidAgent.ok, false);
      assert.equal(
        (invalidAgent as { ok: false; error: { code: string } }).error.code,
        'invalid_request',
      );
    }
  } finally {
    f.close();
  }
});

test('connector setup handoff enforces Agent edit policy', async () => {
  const f = await createManagementAdapterFixture('connector-handoff-policy');
  const creator = (await f.identity.provisionSlackMember({
    slackTeamId: f.owner.binding.slackTeamId,
    slackUserId: 'U_CONNECTOR_CREATOR',
    displayName: 'Connector Creator',
  })).resolution!;
  const other = (await f.identity.provisionSlackMember({
    slackTeamId: f.owner.binding.slackTeamId,
    slackUserId: 'U_CONNECTOR_OTHER',
    displayName: 'Connector Other',
  })).resolution!;
  await f.config.createAgent({
    id: 'agent_private_connector',
    name: 'Private Connector Agent',
    creatorMembershipId: creator.membership.id,
    editPolicy: 'creator_and_admins',
    lifecycle: 'active',
    configurationGeneration: 1,
    instructions: 'Stay private.',
    enabled: true,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  });
  const context: ManagementActorContext = {
    userId: other.user.id,
    membershipId: other.membership.id,
    organizationId: other.membership.organizationId,
    origin: {
      kind: 'slack',
      workspaceId: f.owner.binding.slackTeamId,
      channelId: 'C_PRIVATE',
      threadTs: '200.1',
      agentId: 'agent_private_connector',
    },
  };
  try {
    const result = await invokeWorkspaceManagementTool({
      service: f.service,
      resolveContext: async () => context,
    }, 'prepare_connector_setup', { connector: 'Linear', ownerKind: 'team' });
    assert.deepEqual(result, {
      ok: false,
      error: { code: 'forbidden', message: 'The Agent is not available to this member.' },
    });
  } finally {
    f.close();
  }
});

test('Slack management lets a member create an Agent and edit it through its specific mention', async () => {
  const f = await createManagementAdapterFixture('slack-agent-management');
  const member = (await f.identity.provisionSlackMember({
    slackTeamId: f.owner.binding.slackTeamId,
    slackUserId: 'U_AGENT_CREATOR',
    displayName: 'Agent Creator',
  })).resolution!;
  const signal = parseSlackManagementSignal({
    kind: 'signal',
    type: 'slack.message',
    tagName: 'slack_message',
    body: '<slack_message>create an Agent</slack_message>',
    attributes: {
      workspaceId: member.binding.slackTeamId,
      channelId: 'C_AGENT_MANAGEMENT',
      threadTs: '300.1',
      slackUserId: member.user.slackUserId,
      eventId: 'Ev_AGENT_MANAGEMENT',
      messageTs: '300.1',
      turnJobId: 'turn_AGENT_MANAGEMENT',
    },
  } as Parameters<typeof parseSlackManagementSignal>[0], {
    agentId: 'agent_default',
    conversation: {
      workspaceId: member.binding.slackTeamId,
      channelId: 'C_AGENT_MANAGEMENT',
      threadTs: '300.1',
    },
  } as Parameters<typeof parseSlackManagementSignal>[1]);
  assert.ok(signal);
  try {
    const created = await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'apply_workspace_changes',
      args: {
        idempotencyKey: 'slack-create-specialist',
        operations: [{
          itemId: 'create-specialist',
          kind: 'create_agent',
          agent: {
            id: 'agent_specialist',
            name: 'Specialist',
            description: 'Handles specialist requests.',
            requestedHandle: 'specialist',
            editPolicy: 'creator_and_admins',
            instructions: 'Handle specialist requests.',
            enabled: true,
            skills: [],
            mcpServers: [],
            apiConnections: [],
            repositories: [],
          },
        }],
      },
    });
    assert.equal(created.ok, true);
    let agent = await f.config.getAgent('agent_specialist');
    assert.equal(agent.creatorMembershipId, member.membership.id);

    const baseUpdated = await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'apply_workspace_changes',
      args: {
        idempotencyKey: 'slack-base-edit-specialist',
        operations: [{
          itemId: 'base-edit-specialist',
          kind: 'update_agent',
          agentId: agent.id,
          expectedRevision: agent.revision,
          patch: { description: 'Handles specialist requests from base Chickpea.' },
        }],
      },
    });
    assert.equal(baseUpdated.ok, true);
    agent = await f.config.getAgent(agent.id);
    assert.equal(agent.description, 'Handles specialist requests from base Chickpea.');

    const specialistSignal = parseSlackManagementSignal({
      kind: 'signal',
      type: 'slack.message',
      tagName: 'slack_message',
      body: '<slack_message>edit this Agent</slack_message>',
      attributes: {
        workspaceId: member.binding.slackTeamId,
        channelId: 'C_AGENT_MANAGEMENT',
        threadTs: '300.1',
        slackUserId: member.user.slackUserId,
        eventId: 'Ev_AGENT_MANAGEMENT_SPECIFIC',
        messageTs: '300.2',
        turnJobId: 'turn_AGENT_MANAGEMENT_SPECIFIC',
      },
    } as Parameters<typeof parseSlackManagementSignal>[0], {
      agentId: agent.id,
      conversation: {
        workspaceId: member.binding.slackTeamId,
        channelId: 'C_AGENT_MANAGEMENT',
        threadTs: '300.1',
      },
    } as Parameters<typeof parseSlackManagementSignal>[1]);
    assert.ok(specialistSignal);

    const inspected = await invokeSlackWorkspaceManagementTool({
      signal: specialistSignal,
      identity: f.identity,
      service: f.service,
      name: 'inspect_workspace',
      args: {},
    });
    assert.equal(inspected.ok, true);
    assert.equal(
      (inspected as { ok: true; result: { currentAgentId: string } }).result.currentAgentId,
      agent.id,
    );

    const updated = await invokeSlackWorkspaceManagementTool({
      signal: specialistSignal,
      identity: f.identity,
      service: f.service,
      name: 'apply_workspace_changes',
      args: {
        idempotencyKey: 'slack-edit-specialist',
        operations: [{
          itemId: 'edit-specialist',
          kind: 'update_agent',
          agentId: agent.id,
          expectedRevision: agent.revision,
          patch: { description: 'Handles escalated specialist requests.' },
        }],
      },
    });
    assert.equal(updated.ok, true);
    assert.equal(
      (await f.config.getAgent(agent.id)).description,
      'Handles escalated specialist requests.',
    );
  } finally {
    f.close();
  }
});
