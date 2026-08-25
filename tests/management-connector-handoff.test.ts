import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CHICKPEA_AGENT_ID } from '../src/config/agent-id.ts';
import { UnknownAgentError } from '../src/config/errors.ts';
import { invokeWorkspaceManagementTool } from '../src/management/tool-adapter.ts';
import {
  invokeSlackWorkspaceManagementTool,
  parseSlackManagementSignal,
} from '../src/management/slack-tools.ts';
import { safeSlackLoginDestination } from '../src/auth/setup-handoff.ts';
import type { ManagementActorContext, ManagementOperation } from '../src/management/types.ts';
import { authoringProposalMetadata } from './helpers/agent-authoring.ts';
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
    const createProposal = (created as { ok: true; result: {
      outcomes: Array<{ proposalId: string }>;
    } }).result.outcomes[0]!.proposalId;
    const confirmedCreate = await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'confirm_workspace_change',
      args: { proposalId: createProposal },
    });
    assert.equal(confirmedCreate.ok, true);
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

test('activated user Agents fully self-manage while cross-Agent authority stays with Chickpea', async () => {
  const f = await createManagementAdapterFixture('activated-agent-authority');
  const workspaceId = f.admin.binding.slackTeamId;
  const support = await f.config.createAgent({
    id: 'agent_support',
    name: 'Support',
    creatorMembershipId: f.admin.membership.id,
    editPolicy: 'creator_and_admins',
    lifecycle: 'active',
    configurationGeneration: 1,
    instructions: 'Help with support.',
    enabled: true,
    model: 'openai/gpt-5.6-terra',
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  });
  await f.config.materializeChickpeaAgent();
  const installation = await f.config.ensureWorkspaceInstallation({
    workspaceId,
    transportMode: 'direct',
    defaultAgentId: support.id,
    teamId: workspaceId,
    appId: 'A_AUTHORITY',
    botUserId: 'U_CHICKPEA',
  });
  await f.config.updateWorkspaceInstallation(
    workspaceId,
    { runtimeContract: 'chickpea-v1' },
    installation.revision,
  );
  let sequence = 0;
  const signal = (agentId: string) => ({
    agentId,
    workspaceId,
    channelId: 'D_AUTHORITY',
    threadTs: '400.1',
    slackUserId: f.admin.binding.slackUserId,
    eventId: `Ev_AUTHORITY_${++sequence}`,
    messageTs: `400.${sequence + 1}`,
    turnJobId: `turn_AUTHORITY_${sequence}`,
  });
  try {
    const scoped = await invokeSlackWorkspaceManagementTool({
      signal: signal(support.id),
      identity: f.identity,
      service: f.service,
      name: 'inspect_workspace',
      args: {},
    });
    assert.equal(scoped.ok, true);
    const snapshot = (scoped as { ok: true; result: {
      currentAgentId: string;
      agents: Array<{ id: string }>;
      connectors: Array<{ id: string }>;
      channels: unknown[];
      providers: unknown[];
      selfManagement: {
        availableModels: Array<{ id: string }>;
        routineSchedulingAvailable: boolean;
        capabilityHealth: {
          mcpConnections: { ready: number; pending: number; failed: number };
          channelGrants: { active: number; pending: number; needsAttention: number };
        };
      };
      team?: unknown;
    } }).result;
    assert.equal(snapshot.currentAgentId, support.id);
    assert.deepEqual(snapshot.agents.map(({ id }) => id), [support.id]);
    assert.ok(snapshot.connectors.some(({ id }) => id === 'zendesk'));
    assert.deepEqual(snapshot.channels, []);
    assert.deepEqual(snapshot.providers, []);
    assert.ok(snapshot.selfManagement.availableModels.some(
      ({ id }) => id === 'openai/gpt-5.6-terra',
    ));
    assert.equal(snapshot.selfManagement.routineSchedulingAvailable, true);
    assert.deepEqual(snapshot.selfManagement.capabilityHealth.mcpConnections, {
      ready: 0,
      pending: 0,
      failed: 0,
    });
    assert.deepEqual(snapshot.selfManagement.capabilityHealth.channelGrants, {
      active: 0,
      pending: 0,
      needsAttention: 0,
    });
    assert.equal(snapshot.team, undefined);

    const selfEdit = await invokeSlackWorkspaceManagementTool({
      signal: signal(support.id),
      identity: f.identity,
      service: f.service,
      name: 'apply_workspace_changes',
      args: {
        idempotencyKey: 'support-self-edit',
        operations: [{
          itemId: 'self',
          kind: 'update_agent',
          agentId: support.id,
          expectedRevision: support.revision,
          patch: { description: 'Handles escalated support.' },
        }],
      },
    });
    assert.equal(selfEdit.ok, true);
    assert.equal((await f.config.getAgent(support.id)).description, 'Handles escalated support.');

    const beforeSkill = await f.config.getAgent(support.id);
    const skillProposal = await invokeSlackWorkspaceManagementTool({
      signal: signal(support.id),
      identity: f.identity,
      service: f.service,
      name: 'propose_workspace_changes',
      args: {
        ...authoringProposalMetadata('support-full-self-edit'),
        operations: [{
          itemId: 'skill',
          kind: 'update_agent',
          agentId: support.id,
          expectedRevision: beforeSkill.revision,
          patch: {
            instructions: 'Help with support and follow the escalation playbook.',
            model: 'anthropic/claude-sonnet-4-6',
            requestedHandle: 'support-escalations',
            editPolicy: 'all_workspace_members',
            skills: [{
              name: 'support-escalation',
              description: 'Handle an escalated support request.',
              instructions: 'Classify severity, collect evidence, and notify the right owner.',
              enabled: true,
            }],
            mcpServers: [{
              id: 'zendesk-self',
              displayName: 'Zendesk',
              url: 'https://mcp.zendesk.example/mcp',
              transport: 'streamable-http',
              authMode: 'bearer',
              headerNames: ['Authorization'],
              enabled: true,
              lifecycleStatus: 'pending',
              statusText: 'Setup required',
              discoveredTools: [],
              allowedTools: [],
              presetId: 'zendesk',
            }],
            repositories: [{
              id: 'repo-support',
              installationId: null,
              accountLogin: 'acme',
              fullName: 'acme/support',
              enabled: true,
            }],
          },
        }],
      },
    });
    assert.equal(skillProposal.ok, true);
    assert.deepEqual((await f.config.getAgent(support.id)).skills, []);
    const skillProposalId = (skillProposal as { ok: true; result: {
      proposalId: string;
    } }).result.proposalId;
    const confirmedSkill = await invokeSlackWorkspaceManagementTool({
      signal: signal(support.id),
      identity: f.identity,
      service: f.service,
      name: 'confirm_workspace_change',
      args: { proposalId: skillProposalId },
    });
    assert.equal(confirmedSkill.ok, true);
    const configuredSelf = await f.config.getAgent(support.id);
    assert.equal(configuredSelf.skills[0]?.name, 'support-escalation');
    assert.equal(configuredSelf.model, 'anthropic/claude-sonnet-4-6');
    assert.equal(configuredSelf.slackPresence?.normalizedHandle, 'support-escalations');
    assert.equal(configuredSelf.editPolicy, 'all_workspace_members');
    assert.equal(configuredSelf.mcpServers[0]?.id, 'zendesk-self');
    assert.equal(configuredSelf.repositories[0]?.fullName, 'acme/support');

    const setup = await invokeSlackWorkspaceManagementTool({
      signal: signal(support.id),
      identity: f.identity,
      service: f.service,
      name: 'apply_workspace_changes',
      args: {
        idempotencyKey: 'support-zendesk-setup',
        operations: [{
          itemId: 'setup',
          kind: 'request_setup',
          target: {
            kind: 'mcp_connection',
            agentId: support.id,
            connectionId: 'zendesk-self',
          },
        }],
      },
    });
    const setupOutcome = (setup as { ok: true; result: {
      outcomes: Array<{ disposition: string; setupOperationId: string; setupUrl: string }>;
    } }).result.outcomes[0]!;
    assert.equal(setupOutcome.disposition, 'setup_required');
    assert.match(setupOutcome.setupUrl, /\/setup\/setup_/);
    const revokedSetup = await invokeSlackWorkspaceManagementTool({
      signal: signal(support.id),
      identity: f.identity,
      service: f.service,
      name: 'revoke_setup_link',
      args: { setupOperationId: setupOutcome.setupOperationId },
    });
    assert.equal((revokedSetup as { ok: true; result: {
      revoked: { status: string };
    } }).result.revoked.status, 'revoked');

    const initialMemory = await invokeSlackWorkspaceManagementTool({
      signal: signal(support.id),
      identity: f.identity,
      service: f.service,
      name: 'inspect_memory',
      args: { agentId: support.id },
    });
    assert.equal((initialMemory as { ok: true; result: { revision: number } }).result.revision, 0);
    const memoryUpdate = await invokeSlackWorkspaceManagementTool({
      signal: signal(support.id),
      identity: f.identity,
      service: f.service,
      name: 'apply_workspace_changes',
      args: {
        idempotencyKey: 'support-memory',
        operations: [{
          itemId: 'memory',
          kind: 'update_agent_memory',
          agentId: support.id,
          expectedRevision: 0,
          body: 'Escalate P0 incidents immediately.',
        }],
      },
    });
    assert.equal(memoryUpdate.ok, true);
    assert.equal((await f.memory.getAgentMemory(support.id)).body, 'Escalate P0 incidents immediately.');

    await f.config.putChannel({
      workspaceId,
      channelId: 'C_SUPPORT_AUTHORITY',
      label: 'support-authority',
      lifecycle: 'active',
    }, 0);
    const proposal = await invokeSlackWorkspaceManagementTool({
      signal: signal(support.id),
      identity: f.identity,
      service: f.service,
      name: 'apply_workspace_changes',
      args: {
        idempotencyKey: 'support-propose-own-reach',
        operations: [{
          itemId: 'grant',
          kind: 'grant_agent_channel',
          workspaceId,
          channelId: 'C_SUPPORT_AUTHORITY',
          agentId: support.id,
          expectedRevision: 0,
        }],
      },
    });
    const proposalId = (proposal as { ok: true; result: {
      outcomes: Array<{ proposalId: string }>;
    } }).result.outcomes[0]!.proposalId;
    const wrongOwnerConfirmation = await invokeSlackWorkspaceManagementTool({
      signal: signal(CHICKPEA_AGENT_ID),
      identity: f.identity,
      service: f.service,
      name: 'confirm_workspace_change',
      args: { proposalId },
    });
    assert.deepEqual(wrongOwnerConfirmation, {
      ok: false,
      error: {
        code: 'proposal_binding_mismatch',
        message: 'The confirmation does not match its initiating user and origin.',
      },
    });
    const confirmed = await invokeSlackWorkspaceManagementTool({
      signal: signal(support.id),
      identity: f.identity,
      service: f.service,
      name: 'confirm_workspace_change',
      args: { proposalId },
    });
    assert.equal(confirmed.ok, true);
    const reached = await invokeSlackWorkspaceManagementTool({
      signal: signal(support.id),
      identity: f.identity,
      service: f.service,
      name: 'inspect_workspace',
      args: {},
    });
    const reachedSnapshot = (reached as { ok: true; result: {
      channels: Array<{ channelId: string }>;
      selfManagement: { capabilityHealth: { channelGrants: { active: number } } };
    } }).result;
    assert.deepEqual(reachedSnapshot.channels.map(({ channelId }) => channelId), [
      'C_SUPPORT_AUTHORITY',
    ]);
    assert.equal(reachedSnapshot.selfManagement.capabilityHealth.channelGrants.active, 1);

    const createHandoff = await invokeSlackWorkspaceManagementTool({
      signal: signal(support.id),
      identity: f.identity,
      service: f.service,
      name: 'apply_workspace_changes',
      args: {
        idempotencyKey: 'support-create-other',
        operations: [{
          itemId: 'create',
          kind: 'create_agent',
          agent: {
            id: 'agent_other',
            name: 'Other',
            instructions: 'Do other work.',
            enabled: true,
            skills: [],
            mcpServers: [],
            apiConnections: [],
            repositories: [],
          },
        }],
      },
    });
    const createResult = (createHandoff as { ok: true; result: {
      outcomes: Array<{ disposition: string; handoff: { instruction: string; target: { id: string } } }>;
    } }).result;
    assert.equal(createResult.outcomes[0]?.disposition, 'chickpea_handoff');
    assert.equal(createResult.outcomes[0]?.handoff.target.id, 'agent_other');
    assert.equal(createResult.outcomes[0]?.handoff.instruction, 'Mention @Chickpea in this thread to continue.');
    await assert.rejects(f.config.getAgent('agent_other'), UnknownAgentError);

    const authorityOperations: ManagementOperation[] = [
      {
        itemId: 'workspace-channel',
        kind: 'put_channel',
        channel: {
          workspaceId,
          channelId: 'C_FORGED_AUTHORITY',
          lifecycle: 'active',
        },
        expectedRevision: 0,
      },
      {
        itemId: 'member-authority',
        kind: 'update_member',
        membershipId: f.admin.membership.id,
        role: 'owner',
      },
      {
        itemId: 'provider-authority',
        kind: 'remove_provider_credential',
        providerId: 'openai',
      },
    ];
    for (const operation of authorityOperations) {
      const denied = await invokeSlackWorkspaceManagementTool({
        signal: signal(support.id),
        identity: f.identity,
        service: f.service,
        name: 'apply_workspace_changes',
        args: {
          idempotencyKey: `support-authority-${operation.kind}`,
          operations: [operation],
        },
      });
      assert.equal((denied as { ok: true; result: {
        outcomes: Array<{ disposition: string }>;
      } }).result.outcomes[0]?.disposition, 'chickpea_handoff');
    }
    assert.equal(await f.config.getChannel(workspaceId, 'C_FORGED_AUTHORITY'), undefined);
    assert.equal((await f.identity.getMembership(f.admin.membership.id))?.role, 'admin');

    const recipeHandoff = await invokeSlackWorkspaceManagementTool({
      signal: signal(support.id),
      identity: f.identity,
      service: f.service,
      name: 'export_workspace_recipe',
      args: {},
    });
    assert.equal((recipeHandoff as { ok: true; result: { kind: string } }).result.kind,
      'chickpea_handoff');

    const connectorSetup = await invokeSlackWorkspaceManagementTool({
      signal: signal(support.id),
      identity: f.identity,
      service: f.service,
      name: 'prepare_connector_setup',
      args: { connector: 'Zendesk', ownerKind: 'member' },
    });
    assert.equal(connectorSetup.ok, true);
    assert.equal(
      new URL((connectorSetup as { ok: true; result: { handoffUrl: string } }).result.handoffUrl)
        .pathname,
      '/admin/agents/agent_support/connections/new/zendesk/member',
    );

    const created = await invokeSlackWorkspaceManagementTool({
      signal: signal(CHICKPEA_AGENT_ID),
      identity: f.identity,
      service: f.service,
      name: 'apply_workspace_changes',
      args: {
        idempotencyKey: 'support-create-other',
        operations: [{
          itemId: 'create',
          kind: 'create_agent',
          agent: {
            id: 'agent_other',
            name: 'Other',
            instructions: 'Do other work.',
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
    const proposedCreateResult = (created as { ok: true; result: {
      operationId: string;
      outcomes: Array<{ proposalId: string }>;
    } }).result;
    const confirmedCreate = await invokeSlackWorkspaceManagementTool({
      signal: signal(CHICKPEA_AGENT_ID),
      identity: f.identity,
      service: f.service,
      name: 'confirm_workspace_change',
      args: { proposalId: proposedCreateResult.outcomes[0]!.proposalId },
    });
    assert.equal(confirmedCreate.ok, true);
    const createdResult = (confirmedCreate as { ok: true; result: {
      outcomes: Array<{ handoffUrl?: string }>;
    } }).result;
    assert.equal(
      new URL(createdResult.outcomes[0]!.handoffUrl!).pathname,
      '/admin/agents/agent_other',
    );
    const durableCreate = await invokeSlackWorkspaceManagementTool({
      signal: signal(CHICKPEA_AGENT_ID),
      identity: f.identity,
      service: f.service,
      name: 'get_operation',
      args: { operationId: proposedCreateResult.operationId },
    });
    assert.equal(
      new URL((durableCreate as { ok: true; result: {
        operation: { outcomes: Array<{ handoffUrl: string }> };
      } }).result.operation.outcomes[0]!.handoffUrl).pathname,
      '/admin/agents/agent_other',
    );
    const baseAgent = await f.config.getAgent('agent_other');
    assert.equal(baseAgent.lifecycle, 'active');
    assert.equal(baseAgent.enabled, true);
    const crossAgentEdit = await invokeSlackWorkspaceManagementTool({
      signal: signal(support.id),
      identity: f.identity,
      service: f.service,
      name: 'apply_workspace_changes',
      args: {
        idempotencyKey: 'support-edit-other',
        operations: [{
          itemId: 'other',
          kind: 'update_agent',
          agentId: baseAgent.id,
          expectedRevision: baseAgent.revision,
          patch: { description: 'Should not be disclosed or applied.' },
        }],
      },
    });
    const crossResult = (crossAgentEdit as { ok: true; result: {
      outcomes: Array<{ disposition: string; handoff: { target: { id: string } } }>;
    } }).result.outcomes[0]!;
    assert.equal(crossResult.disposition, 'chickpea_handoff');
    assert.equal(crossResult.handoff.target.id, baseAgent.id);
    assert.equal((await f.config.getAgent(baseAgent.id)).description, undefined);
    const crossProposal = await invokeSlackWorkspaceManagementTool({
      signal: signal(support.id),
      identity: f.identity,
      service: f.service,
      name: 'propose_workspace_changes',
      args: {
        ...authoringProposalMetadata('cross-agent-proposal'),
        operations: [{
          itemId: 'other-proposal',
          kind: 'update_agent',
          agentId: baseAgent.id,
          expectedRevision: baseAgent.revision,
          patch: { instructions: 'This cross-Agent proposal must not be stored.' },
        }],
      },
    });
    assert.equal((crossProposal as { ok: true; result: {
      kind: string;
      target: { id: string };
    } }).result.kind, 'chickpea_handoff');
    assert.equal((crossProposal as { ok: true; result: {
      target: { id: string };
    } }).result.target.id, baseAgent.id);
  } finally {
    f.close();
  }
});

test('self-archive is confirmed, seals the next Agent turn, and restores from an active surface', async () => {
  const f = await createManagementAdapterFixture('self-archive');
  const workspaceId = f.admin.binding.slackTeamId;
  const fallback = await f.config.createAgent({
    id: 'agent_fallback',
    name: 'Fallback',
    creatorMembershipId: f.admin.membership.id,
    editPolicy: 'creator_and_admins',
    lifecycle: 'active',
    configurationGeneration: 1,
    instructions: 'Remain available.',
    enabled: true,
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  });
  const support = await f.config.createAgent({
    id: 'agent_archive_self',
    name: 'Archive Self',
    creatorMembershipId: f.admin.membership.id,
    editPolicy: 'creator_and_admins',
    lifecycle: 'active',
    configurationGeneration: 1,
    instructions: 'Manage this Agent.',
    enabled: true,
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
  });
  await f.config.materializeChickpeaAgent();
  const installation = await f.config.ensureWorkspaceInstallation({
    workspaceId,
    transportMode: 'direct',
    defaultAgentId: fallback.id,
  });
  await f.config.updateWorkspaceInstallation(
    workspaceId,
    { runtimeContract: 'chickpea-v1' },
    installation.revision,
  );
  const signal = {
    agentId: support.id,
    workspaceId,
    channelId: 'D_ARCHIVE',
    threadTs: '500.1',
    slackUserId: f.admin.binding.slackUserId,
    eventId: 'Ev_ARCHIVE',
    messageTs: '500.2',
    turnJobId: 'turn_ARCHIVE',
  };
  try {
    const proposed = await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'apply_workspace_changes',
      args: {
        idempotencyKey: 'self-archive',
        operations: [{
          itemId: 'archive',
          kind: 'archive_agent',
          agentId: support.id,
          expectedRevision: support.revision,
        }],
      },
    });
    const proposalId = (proposed as { ok: true; result: {
      outcomes: Array<{ proposalId: string; disposition: string }>;
    } }).result.outcomes[0]!;
    assert.equal(proposalId.disposition, 'confirmation_required');
    const confirmed = await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'confirm_workspace_change',
      args: { proposalId: proposalId.proposalId },
    });
    assert.equal(confirmed.ok, true);
    const archived = await f.config.getAgent(support.id);
    assert.equal(archived.lifecycle, 'archived');

    const sealed = await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'inspect_workspace',
      args: {},
    });
    assert.deepEqual(sealed, {
      ok: false,
      error: { code: 'forbidden', message: 'The acting Agent route is unavailable.' },
    });

    const mcpContext: ManagementActorContext = {
      userId: f.admin.user.id,
      membershipId: f.admin.membership.id,
      organizationId: f.admin.membership.organizationId,
      origin: { kind: 'mcp', clientId: 'restore-archived-agent' },
    };
    const restore = await f.service.applyWorkspaceChanges({
      context: mcpContext,
      idempotencyKey: 'restore-archived-agent',
      operations: [{
        itemId: 'restore',
        kind: 'restore_agent',
        agentId: archived.id,
        expectedRevision: archived.revision,
      }],
    });
    assert.equal(restore.status, 'confirmation_required');
    await f.service.confirmWorkspaceChange({
      context: mcpContext,
      proposalId: restore.outcomes[0]!.proposalId!,
    });
    assert.equal((await f.config.getAgent(support.id)).lifecycle, 'active');
    assert.equal((await invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'inspect_workspace',
      args: {},
    })).ok, true);
  } finally {
    f.close();
  }
});
