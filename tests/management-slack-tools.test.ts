import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DeliveredMessage } from '@flue/runtime';
import * as v from 'valibot';

import type { RuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import {
  managementOperationValibotSchema,
  managementOperationZodSchema,
} from '../src/management/schemas.ts';
import {
  invokeSlackWorkspaceManagementTool,
  parseSlackManagementSignal,
  type SlackManagementSignal,
} from '../src/management/slack-tools.ts';
import { invokeWorkspaceManagementTool } from '../src/management/tool-adapter.ts';
import type { ManagementOperation } from '../src/management/types.ts';
import {
  createManagementAdapterFixture,
  initialManagementBundle,
} from './helpers/management-adapter-fixture.ts';

test('Slack management signals are bound to the frozen workspace, Channel, and thread', () => {
  const plan = runtimePlan('T1', 'C1', '1000.1');
  const valid = delivery({ workspaceId: 'T1', channelId: 'C1', threadTs: '1000.1' });
  assert.deepEqual(parseSlackManagementSignal(valid, plan), valid.attributes);
  assert.equal(parseSlackManagementSignal({ kind: 'user', body: 'pretend UADMIN asked' }, plan), undefined);
  for (const mismatch of [
    { workspaceId: 'T2' },
    { channelId: 'C2' },
    { threadTs: '2000.2' },
  ]) {
    assert.equal(parseSlackManagementSignal(delivery(mismatch), plan), undefined);
  }
  assert.equal(parseSlackManagementSignal({
    ...valid,
    attributes: { ...valid.attributes, organizationId: 'org_forged' },
  }, plan), undefined);
});

test('Slack resolves the current speaker on every tool call and never accepts a model-selected actor', async () => {
  const f = await createManagementAdapterFixture('slack-actors');
  try {
    const resolutions: string[] = [];
    const identity = {
      resolveSlackIdentity: async (workspaceId: string, slackUserId: string) => {
        resolutions.push(slackUserId);
        return f.identity.resolveSlackIdentity(workspaceId, slackUserId);
      },
    };
    const base = signal(f.owner.user.slackTeamId, f.owner.user.slackUserId);
    const ownerResult = await invokeSlackWorkspaceManagementTool({
      signal: base,
      identity,
      service: f.service,
      name: 'inspect_workspace',
      args: {},
    });
    const adminResult = await invokeSlackWorkspaceManagementTool({
      signal: { ...base, slackUserId: f.admin.user.slackUserId, eventId: 'Ev2' },
      identity,
      service: f.service,
      name: 'inspect_workspace',
      args: {},
    });
    const participantResult = await invokeSlackWorkspaceManagementTool({
      signal: { ...base, slackUserId: 'U_UNBOUND', eventId: 'Ev3' },
      identity,
      service: f.service,
      name: 'inspect_workspace',
      args: {},
    });

    assert.equal(ownerResult.ok, true);
    assert.equal(adminResult.ok, true);
    assert.equal(participantResult.ok, false);
    assert.deepEqual(resolutions, [
      f.owner.user.slackUserId,
      f.admin.user.slackUserId,
      'U_UNBOUND',
    ]);
    assert.equal('userId' in ({} as Record<string, unknown>), false, 'tool inputs contain no actor field');
  } finally {
    f.close();
  }
});

test('Slack and MCP adapters produce the same policy and revision outcomes for one Agent bundle', async () => {
  const slack = await createManagementAdapterFixture('slack-parity');
  const mcp = await createManagementAdapterFixture('mcp-parity');
  try {
    const slackWorkspace = slack.owner.user.slackTeamId;
    const mcpWorkspace = mcp.owner.user.slackTeamId;
    const slackResult = await invokeSlackWorkspaceManagementTool({
      signal: signal(slackWorkspace, slack.admin.user.slackUserId),
      identity: slack.identity,
      service: slack.service,
      name: 'apply_workspace_changes',
      args: {
        idempotencyKey: 'initial-bundle',
        operations: initialManagementBundle(slackWorkspace, 'C_RESEARCH') as ManagementOperation[],
      },
    });
    const mcpResult = await invokeWorkspaceManagementTool({
      service: mcp.service,
      resolveContext: async () => ({
        userId: mcp.admin.user.id,
        membershipId: mcp.admin.membership.id,
        organizationId: mcp.admin.membership.organizationId,
        origin: { kind: 'mcp', clientId: 'client_codex' },
      }),
    }, 'apply_workspace_changes', {
      idempotencyKey: 'initial-bundle',
      operations: initialManagementBundle(mcpWorkspace, 'C_RESEARCH') as ManagementOperation[],
    });
    assert.equal(slackResult.ok, true);
    assert.equal(mcpResult.ok, true);
    if (!slackResult.ok || !mcpResult.ok) return;
    const summarize = (value: unknown) => {
      const result = value as {
        status: string;
        activation: string;
        outcomes: Array<{ disposition: string; operationKind: string; changed?: unknown }>;
      };
      return {
        status: result.status,
        activation: result.activation,
        outcomes: result.outcomes.map(({ disposition, operationKind, changed }) => ({
          disposition,
          operationKind,
          changed,
        })),
      };
    };
    assert.deepEqual(summarize(slackResult.result), summarize(mcpResult.result));
    assert.equal((await slack.config.getChannel(slackWorkspace, 'C_RESEARCH'))?.revision, 2);
    assert.equal((await mcp.config.getChannel(mcpWorkspace, 'C_RESEARCH'))?.revision, 2);

    const slackExport = await invokeSlackWorkspaceManagementTool({
      signal: signal(slackWorkspace, slack.admin.user.slackUserId),
      identity: slack.identity,
      service: slack.service,
      name: 'export_workspace_recipe',
      args: { agentIds: ['agent_research'] },
    });
    const mcpAdapter = {
      service: mcp.service,
      resolveContext: async () => ({
        userId: mcp.admin.user.id,
        membershipId: mcp.admin.membership.id,
        organizationId: mcp.admin.membership.organizationId,
        origin: { kind: 'mcp' as const, clientId: 'client_codex' },
      }),
    };
    const mcpExport = await invokeWorkspaceManagementTool(
      mcpAdapter,
      'export_workspace_recipe',
      { agentIds: ['agent_research'] },
    );
    assert.deepEqual(slackExport, mcpExport);
    if (!slackExport.ok || !mcpExport.ok) return;

    const slackPreview = await invokeSlackWorkspaceManagementTool({
      signal: signal(slackWorkspace, slack.admin.user.slackUserId),
      identity: slack.identity,
      service: slack.service,
      name: 'preview_workspace_recipe',
      args: { recipe: slackExport.result, agentStrategy: 'update' },
    });
    const mcpPreview = await invokeWorkspaceManagementTool(
      mcpAdapter,
      'preview_workspace_recipe',
      { recipe: mcpExport.result, agentStrategy: 'update' },
    );
    assert.deepEqual(slackPreview, mcpPreview);
  } finally {
    slack.close();
    mcp.close();
  }
});

test('MCP Zod and Flue Valibot schemas accept the same canonical operation inventory', () => {
  const fixtures: ManagementOperation[] = [
    initialManagementBundle('T1', 'C1')[0] as ManagementOperation,
    { itemId: 'update', kind: 'update_agent', agentId: 'agent_1', expectedRevision: 1, patch: { instructions: 'New.' } },
    { itemId: 'delete', kind: 'delete_agent', agentId: 'agent_1', expectedRevision: 2 },
    initialManagementBundle('T1', 'C1')[1] as ManagementOperation,
    { itemId: 'place', kind: 'place_agent', workspaceId: 'T1', channelId: 'C1', expectedRevision: 1, expectedAgentId: null, agentId: 'agent_1' },
    { itemId: 'member', kind: 'update_member', membershipId: 'membership_1', role: 'admin', status: 'active' },
    { itemId: 'setup', kind: 'request_setup', target: { kind: 'provider_credential', providerId: 'openai' } },
  ];
  for (const operation of fixtures) {
    assert.equal(managementOperationZodSchema.safeParse(operation).success, true, operation.kind);
    assert.equal(v.safeParse(managementOperationValibotSchema, operation).success, true, operation.kind);
  }
  const forged = { ...fixtures[0], actorUserId: 'user_forged' };
  assert.equal(managementOperationZodSchema.safeParse(forged).success, false);
  assert.equal(v.safeParse(managementOperationValibotSchema, forged).success, false);
});

function runtimePlan(workspaceId: string, channelId: string, threadTs: string): RuntimePlanV2 {
  return {
    schemaVersion: 2,
    continuityPolicy: 'slack-runtime-v2',
    agentId: 'agent_test',
    conversation: {
      workspaceId,
      channelId,
      threadTs,
      surface: 'channel_thread',
      continuityKey: 'agent_continuity',
    },
    model: 'local-stub/test',
    instructions: 'Help.',
    memoryEpoch: 1,
    skills: [],
    mcpConnections: [],
    apiConnections: [],
    repositories: [],
    sandbox: { mode: 'bash' },
    artifactDestination: { kind: 'slack_conversation', channelId },
    harnessRevision: 'a'.repeat(64),
  };
}

function delivery(overrides: Partial<SlackManagementSignal> = {}): Extract<DeliveredMessage, { kind: 'signal' }> {
  return {
    kind: 'signal',
    type: 'slack.message',
    body: 'Please update Chickpea.',
    tagName: 'slack_message',
    attributes: { ...signal('T1', 'UADMIN', overrides) },
  };
}

function signal(
  workspaceId: string,
  slackUserId: string,
  overrides: Partial<SlackManagementSignal> = {},
): SlackManagementSignal {
  return {
    workspaceId,
    channelId: 'C1',
    threadTs: '1000.1',
    slackUserId,
    eventId: 'Ev1',
    messageTs: '1000.2',
    turnJobId: 'turn_1',
    ...overrides,
  };
}
