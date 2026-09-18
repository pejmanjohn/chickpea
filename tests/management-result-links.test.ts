import assert from 'node:assert/strict';
import { test } from 'node:test';

import { invokeWorkspaceManagementTool } from '../src/management/tool-adapter.ts';
import type {
  ManagementActorContext,
  ManagementApplyResult,
  ProposeWorkspaceChangesResult,
} from '../src/management/types.ts';
import { authoringProposalMetadata } from './helpers/agent-authoring.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

const agentInput = {
  id: 'agent_support',
  name: 'Support Triage',
  description: 'Handles support triage.',
  requestedHandle: 'support',
  editPolicy: 'creator_and_admins' as const,
  instructions: 'Triage support requests.',
  enabled: true,
  model: 'anthropic/claude-haiku-4-5',
  skills: [],
  mcpServers: [],
  apiConnections: [],
  repositories: [],
};

type Fixture = Awaited<ReturnType<typeof createManagementAdapterFixture>>;

function mcpContext(f: Fixture, clientId: string): ManagementActorContext {
  return {
    userId: f.admin.user.id,
    membershipId: f.admin.membership.id,
    organizationId: f.admin.membership.organizationId,
    origin: { kind: 'mcp', clientId },
  };
}

async function createAgentOverMcp(
  f: Fixture,
  clientId: string,
  idempotencyKey = 'links-create',
): Promise<ManagementApplyResult> {
  const invocation = await invokeWorkspaceManagementTool({
    service: f.service,
    resolveContext: async () => mcpContext(f, clientId),
  }, 'apply_workspace_changes', {
    idempotencyKey,
    operations: [{ itemId: 'create', kind: 'create_agent', agent: agentInput }],
  });
  assert.equal(invocation.ok, true);
  return invocation.result as ManagementApplyResult;
}

test('a coding agent receives Admin and Slack links with a create_agent receipt', async () => {
  const f = await createManagementAdapterFixture('result-links-installed', {
    setupBaseUrl: 'https://chickpea.example.test',
  });
  const teamId = f.admin.binding.slackTeamId;
  try {
    assert.equal((await f.identity.getUser(f.admin.user.id))?.slackTeamId, teamId);
    await f.config.ensureWorkspaceInstallation({
      workspaceId: teamId,
      transportMode: 'direct',
      appId: 'A0TEST',
      botUserId: 'U0BOT',
    });

    const result = await createAgentOverMcp(f, 'links-test');
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.links, {
      admin: 'https://chickpea.example.test/admin/agents/agent_support',
      slack: `https://slack.com/app_redirect?team=${teamId}&app=A0TEST`,
    });
    assert.deepEqual(result.outcomes[0]?.links, result.links);

    // Links are presentation, not part of the durable result get_operation replays.
    const stored = await f.management.getRequest(result.operationId);
    assert.equal(stored?.result?.links, undefined);
    assert.equal(stored?.result?.outcomes[0]?.links, undefined);
  } finally {
    f.close();
  }
});

test('the Slack link falls back to the workspace deep link without an installation', async () => {
  const f = await createManagementAdapterFixture('result-links-no-install', {
    setupBaseUrl: 'https://chickpea.example.test',
  });
  try {
    const result = await createAgentOverMcp(f, 'links-no-install');
    assert.deepEqual(result.links, {
      admin: 'https://chickpea.example.test/admin/agents/agent_support',
      slack: `slack://open?team=${f.admin.binding.slackTeamId}`,
    });
  } finally {
    f.close();
  }
});

test('the bot user carries the Slack link when the installation has no app id', async () => {
  const f = await createManagementAdapterFixture('result-links-bot-user', {
    setupBaseUrl: 'https://chickpea.example.test',
  });
  const teamId = f.admin.binding.slackTeamId;
  try {
    await f.config.ensureWorkspaceInstallation({
      workspaceId: teamId,
      transportMode: 'direct',
      botUserId: 'U0BOT',
    });
    const result = await createAgentOverMcp(f, 'links-bot-user');
    assert.equal(
      result.links?.slack,
      `https://slack.com/app_redirect?team=${teamId}&channel=U0BOT`,
    );
  } finally {
    f.close();
  }
});

test('a local setup base URL still produces an Admin link', async () => {
  const f = await createManagementAdapterFixture('result-links-localhost');
  try {
    const result = await createAgentOverMcp(f, 'links-localhost');
    assert.equal(result.links?.admin, 'http://localhost/admin/agents/agent_support');
    assert.equal(result.outcomes[0]?.links?.admin, 'http://localhost/admin/agents/agent_support');
  } finally {
    f.close();
  }
});

test('reviewed proposals carry Slack and Markdown copy of the same change', async () => {
  const f = await createManagementAdapterFixture('result-links-proposal', {
    setupBaseUrl: 'https://chickpea.example.test',
  });
  try {
    await createAgentOverMcp(f, 'links-proposal');
    const agent = await f.config.getAgent('agent_support');
    const invocation = await invokeWorkspaceManagementTool({
      service: f.service,
      resolveContext: async () => mcpContext(f, 'links-proposal'),
    }, 'propose_workspace_changes', {
      ...authoringProposalMetadata('links-proposal-edit'),
      operations: [{
        itemId: 'edit',
        kind: 'update_agent',
        agentId: agent.id,
        expectedRevision: agent.revision,
        patch: { description: 'Handles support triage & billing <escalations>.' },
      }],
    });
    assert.equal(invocation.ok, true);
    const proposal = invocation.result as ProposeWorkspaceChangesResult;

    assert.match(proposal.presentation.slack, /^\*Proposed changes\*/);
    assert.match(proposal.presentation.slack, /Reply `approve`/);
    assert.match(proposal.presentation.slack, /triage &amp; billing &lt;escalations&gt;/);

    assert.match(proposal.presentation.markdown, /^\*\*Proposed changes\*\*/);
    assert.match(proposal.presentation.markdown, /triage & billing <escalations>\./);
    assert.doesNotMatch(proposal.presentation.markdown, /&amp;|&lt;|&gt;/);
    assert.doesNotMatch(proposal.presentation.markdown, /Reply `approve`/);
    assert.match(
      proposal.presentation.markdown,
      /call confirm_workspace_change with the proposalId/,
    );

    const confirmation = await invokeWorkspaceManagementTool({
      service: f.service,
      resolveContext: async () => mcpContext(f, 'links-proposal'),
    }, 'confirm_workspace_change', { proposalId: proposal.proposalId });
    assert.equal(confirmation.ok, true);
    const confirmed = confirmation.result as ManagementApplyResult;
    assert.equal(confirmed.status, 'completed');
    assert.equal(confirmed.links?.admin, 'https://chickpea.example.test/admin/agents/agent_support');
    assert.equal(confirmed.outcomes[0]?.links?.admin, confirmed.links?.admin);
  } finally {
    f.close();
  }
});
