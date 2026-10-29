import assert from 'node:assert/strict';
import test from 'node:test';

import type { IdentityResolution } from '../src/identity/types.ts';
import type { ManagementApiConnection } from '../src/management/agent-connections.ts';
import {
  invokeSlackWorkspaceManagementTool,
  type SlackManagementSignal,
} from '../src/management/slack-tools.ts';
import {
  invokeWorkspaceManagementTool,
  type WorkspaceManagementToolArguments,
  type WorkspaceManagementToolName,
  type WorkspaceManagementToolResult,
} from '../src/management/tool-adapter.ts';
import type { ManagementAgentPatch, ManagementApplyResult } from '../src/management/types.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

const KB_URL = 'https://api.hubapi.com/cms/knowledge-base/2027-03-beta';
const KB_CONNECTION: ManagementApiConnection = {
  id: 'hubspot_kb',
  displayName: 'HubSpot Knowledge Base',
  allowedHosts: ['api.hubapi.com'],
  pathPrefixes: ['/cms/knowledge-base/2027-03-beta'],
  headerName: 'Authorization',
  headerValuePrefix: 'Bearer ',
  allowedMethods: ['GET', 'HEAD', 'POST', 'PATCH'],
  enabled: true,
  authMode: 'credential',
};

async function fixture() {
  const f = await createManagementAdapterFixture('custom-connection-chat');
  const agent = await f.config.createAgent({
    id: 'agent_scribe',
    name: 'Scribe',
    creatorMembershipId: f.admin.membership.id,
    editPolicy: 'creator_and_admins',
    lifecycle: 'active',
    configurationGeneration: 1,
    instructions: 'Keep the help center current.',
    enabled: true,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  });
  const member = (await f.identity.provisionSlackMember({
    slackTeamId: f.owner.binding.slackTeamId,
    slackUserId: 'U24681357',
    displayName: 'Member',
  })).resolution;
  let turn = 0;
  /** One Slack message from `by` to Scribe, then the tool it led to. */
  const slack = <TName extends WorkspaceManagementToolName>(
    name: TName,
    args: WorkspaceManagementToolArguments[TName],
    requesterText: string,
    by: IdentityResolution = f.admin,
  ): Promise<WorkspaceManagementToolResult> => {
    turn += 1;
    const signal: SlackManagementSignal = {
      agentId: agent.id,
      workspaceId: f.admin.user.slackTeamId,
      channelId: 'D_SCRIBE',
      threadTs: '500.1',
      conversationKind: 'im',
      slackUserId: by.binding.slackUserId,
      eventId: `Ev_SCRIBE_${turn}`,
      messageTs: `500.${turn + 1}`,
      turnJobId: `turn_SCRIBE_${turn}`,
      requesterText,
    };
    return invokeSlackWorkspaceManagementTool({ signal, identity: f.identity, service: f.service, name, args });
  };
  const update = async (patch: ManagementAgentPatch) => ({
    idempotencyKey: `update-${++turn}`,
    operations: [{
      itemId: 'connect',
      kind: 'update_agent' as const,
      agentId: agent.id,
      expectedRevision: (await f.config.getAgent(agent.id)).revision,
      patch,
    }],
  });
  /** update_agent from a Slack message; the item's disposition. */
  const connectFromSlack = async (
    requesterText: string,
    patch: ManagementAgentPatch = { apiConnections: [KB_CONNECTION] },
    by: IdentityResolution = f.admin,
  ) => applied(await slack('apply_workspace_changes', await update(patch), requesterText, by));
  return { ...f, agent, member, slack, update, connectFromSlack };
}

function applied(response: WorkspaceManagementToolResult): ManagementApplyResult['outcomes'][number] & { status: string } {
  assert.equal(response.ok, true, JSON.stringify(response));
  const result = (response as { result: ManagementApplyResult }).result;
  return { ...result.outcomes[0]!, status: result.status };
}

test('a new keyed connection the requester typed the URL of applies at once and waits for its key', async () => {
  const f = await fixture();
  try {
    const outcome = await f.connectFromSlack(
      `here's our HubSpot service key for the Knowledge Base API at <${KB_URL}>, set it up so you can read and write articles`,
    );
    assert.equal(outcome.disposition, 'applied', JSON.stringify(outcome));
    const stored = (await f.config.listConnectionAccounts(f.admin.user.slackTeamId))
      .find(({ label }) => label === 'HubSpot Knowledge Base');
    assert.equal(stored?.lifecycle, 'pending', 'the update carries no key, so the connection reaches nothing yet');

    const wider = await f.connectFromSlack('the CMS pages API is at https://api.hubapi.com', {
      apiConnections: [
        KB_CONNECTION,
        { ...KB_CONNECTION, id: 'hubspot_cms', displayName: 'HubSpot CMS', pathPrefixes: ['/cms/v3/pages'] },
      ],
    });
    assert.equal(wider.disposition, 'applied', 'a typed origin covers any path under it, and an unchanged connection needs no URL');

    const bearer = await f.connectFromSlack('add the MCP server https://mcp.example.com/mcp, it takes a token', {
      mcpServers: [{
        id: 'example_mcp', displayName: 'Example MCP', url: 'https://mcp.example.com/mcp',
        transport: 'streamable-http', authMode: 'bearer', headerNames: [], enabled: true, allowedTools: [],
      }],
    });
    assert.equal(bearer.disposition, 'applied');
  } finally { f.close(); }
});

test('an untyped or wider host, a narrower typed path, no key, OAuth or a second field waits for the person', async () => {
  const f = await fixture();
  try {
    for (const [requesterText, patch] of [
      ['set up the HubSpot Knowledge Base API so you can read articles', { apiConnections: [KB_CONNECTION] }],
      [`use ${KB_URL} for articles`, { apiConnections: [{ ...KB_CONNECTION, allowedHosts: ['api.hubapi.com', 'api.hubspot.com'] }] }],
      [`use ${KB_URL}/articles for articles`, { apiConnections: [KB_CONNECTION] }],
      [`<https://evil.example/cms|${KB_URL}> is the API`, { apiConnections: [KB_CONNECTION] }],
      [`use ${KB_URL} and keep answers short`, { apiConnections: [KB_CONNECTION], instructions: 'Keep answers short.' }],
      ['summarize https://mcp.example.com/mcp for me', {
        mcpServers: [{
          id: 'example_mcp', displayName: 'Example MCP', url: 'https://mcp.example.com/mcp',
          transport: 'streamable-http', authMode: 'none', headerNames: [], enabled: true, allowedTools: [],
        }],
      }],
      ['add the MCP server https://mcp.example.com/mcp with OAuth sign-in', {
        mcpServers: [{
          id: 'example_mcp', displayName: 'Example MCP', url: 'https://mcp.example.com/mcp',
          transport: 'streamable-http', authMode: 'oauth', headerNames: [], enabled: true, allowedTools: [],
        }],
      }],
    ] as const satisfies ReadonlyArray<readonly [string, ManagementAgentPatch]>) {
      const outcome = await f.connectFromSlack(requesterText, patch);
      assert.equal(outcome.disposition, 'confirmation_required', requesterText);
    }
    assert.deepEqual(await f.config.listConnectionAccounts(f.admin.user.slackTeamId), [], 'nothing applied');
  } finally { f.close(); }
});

test('an edit to an existing connection waits for the person even with its URL typed', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.connectFromSlack(`connect ${KB_URL} for articles`)).disposition, 'applied');
    const widened = await f.connectFromSlack(`let it delete articles too at ${KB_URL}`, {
      apiConnections: [{ ...KB_CONNECTION, allowedMethods: [...KB_CONNECTION.allowedMethods, 'DELETE'] }],
    });
    assert.equal(widened.disposition, 'confirmation_required');
  } finally { f.close(); }
});

test('a member who cannot edit the Agent is refused even with every URL typed', async () => {
  const f = await fixture();
  try {
    const outcome = await f.connectFromSlack(`connect ${KB_URL}`, { apiConnections: [KB_CONNECTION] }, f.member);
    assert.equal(outcome.disposition, 'failed', JSON.stringify(outcome));
    assert.deepEqual(await f.config.listConnectionAccounts(f.admin.user.slackTeamId), []);
  } finally { f.close(); }
});

test('the MCP door adds a custom connection at once without typed URLs', async () => {
  const f = await fixture();
  try {
    const response = await invokeWorkspaceManagementTool({
      service: f.service,
      resolveContext: async () => ({
        userId: f.admin.user.id,
        membershipId: f.admin.membership.id,
        organizationId: f.admin.membership.organizationId,
        origin: { kind: 'mcp', clientId: 'custom-connection-chat' },
      }),
    }, 'apply_workspace_changes', await f.update({ apiConnections: [KB_CONNECTION] }));
    assert.equal(applied(response).disposition, 'applied');
  } finally { f.close(); }
});
