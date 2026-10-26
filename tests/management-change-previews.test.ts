import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CustomAgentConfig } from '../src/config/types.ts';
import { invokeWorkspaceManagementTool } from '../src/management/tool-adapter.ts';
import type {
  ManagementActorContext,
  ManagementOperation,
  ManagementPresentation,
} from '../src/management/types.ts';
import { authoringProposalMetadata } from './helpers/agent-authoring.ts';
import {
  applyThroughAdapter as apply,
  createFixtureAgent,
  ownerMcpContext,
  ownerSlackDmContext as slackContext,
  withManagementAdapterFixture as withFixture,
  type ManagementAdapterFixture as Fixture,
} from './helpers/management-adapter-fixture.ts';
import { withPersonApproval } from './helpers/slack-person-approval.ts';

const SLACK_APPROVAL = 'Reply `approve` to apply these exact changes, or tell me what to adjust.';
const MARKDOWN_APPROVAL =
  'Show these changes to the person. When they approve, call confirm_workspace_change with the ' +
  'proposalId; if they want something different, inspect again and send a new change.';

const SECRET_SEED = 'chickpea-avatar-v1:08:bc2be6c2-b7b6-4806-8c87-2a91fa6099ed';
const USER_GROUP_ID = 'S0CCVAX57L0';

/** The presence a published Agent carries; none of it may reach a preview. */
const PUBLISHED_PRESENCE: NonNullable<CustomAgentConfig['slackPresence']> = {
  requestedHandle: 'research',
  normalizedHandle: 'research',
  desiredState: 'active',
  health: 'healthy',
  avatar: {
    kind: 'generated',
    revision: 1,
    seed: SECRET_SEED,
    url: 'https://chickpea.test/assets/agents/agent_research/avatar/1',
  },
  userGroupId: USER_GROUP_ID,
  observedAt: 1_792_968_987_675,
};

const knowledgeServer = {
  id: 'mcp_knowledge',
  displayName: 'Knowledge',
  url: 'https://mcp.example.test/mcp',
  transport: 'streamable-http' as const,
  authMode: 'none' as const,
  headerNames: [],
  enabled: true,
  lifecycleStatus: 'pending' as const,
  statusText: '',
  discoveredTools: [],
  allowedTools: [],
};

const billingApi = {
  id: 'api_billing',
  displayName: 'Billing',
  allowedHosts: ['billing.example.test'],
  pathPrefixes: ['/v1/'],
  headerName: 'Authorization',
  allowedMethods: ['GET'],
  enabled: true,
};

function mcpContext(f: Fixture): ManagementActorContext {
  return ownerMcpContext(f, 'preview-test');
}

async function preview(
  f: Fixture,
  context: ManagementActorContext,
  idempotencyKey: string,
  operations: ManagementOperation[],
): Promise<ManagementPresentation> {
  const result = await apply(f, context, idempotencyKey, operations);
  assert.equal(result.status, 'confirmation_required', JSON.stringify(result.outcomes));
  assert.ok(result.presentation, 'a confirmation carries its preview');
  assertNoInternals(result.presentation.slack);
  assertNoInternals(result.presentation.markdown);
  return result.presentation;
}

async function propose(
  f: Fixture,
  idempotencyKey: string,
  operations: ManagementOperation[],
): Promise<ManagementPresentation> {
  const response = await invokeWorkspaceManagementTool({
    service: f.service,
    resolveContext: async () => mcpContext(f),
  }, 'propose_workspace_changes', { ...authoringProposalMetadata(idempotencyKey), operations });
  assert.equal(response.ok, true, JSON.stringify(response));
  const { presentation } = (response as { result: { presentation: ManagementPresentation } }).result;
  assertNoInternals(presentation.slack);
  assertNoInternals(presentation.markdown);
  return presentation;
}

function slackPreview(...lines: string[]): string {
  return ['*Proposed changes*', ...lines, '', SLACK_APPROVAL].join('\n');
}

function markdownPreview(...lines: string[]): string {
  return ['**Proposed changes**', ...lines, '', MARKDOWN_APPROVAL].join('\n');
}

/** Internal identifiers and records a person must never read in a preview. */
function assertNoInternals(text: string): void {
  for (const internal of [
    /\bagent_[a-z]/,
    /\bmembership_/,
    /\b(?:agent|membership|provider|routine|channel_grant):/,
    /\bU[A-Z0-9]{8,}\b/,
    new RegExp(USER_GROUP_ID),
    new RegExp(SECRET_SEED),
    /\bmcp_knowledge\b|\bapi_billing\b/,
    /userGroupId|observedAt|normalizedHandle|desiredState|credentialRef|lifecycleStatus/,
    /configurationGeneration|creatorMembershipId|credentialIncarnation/,
    /\b(?:Id|Kind|Slack Presence|Avatar|Revision|Lifecycle|Generation|Creator|Credential|Incarnation)\b/,
    /avatar|seed/i,
    /\(not set\)/,
    /[{[]\s*$/m,
  ]) {
    assert.doesNotMatch(text, internal, `preview leaks ${internal}:\n${text}`);
  }
}

function createAgent(
  f: Fixture,
  id: string,
  extra: Partial<CustomAgentConfig> = {},
): Promise<CustomAgentConfig> {
  return createFixtureAgent(f, id, {
    description: 'Finds sources for the team.',
    slackPresence: PUBLISHED_PRESENCE,
    ...extra,
  });
}

async function grant(f: Fixture, agentId: string, channelId: string, channelLabel: string) {
  await f.config.putAgentChannelGrant({
    workspaceId: f.owner.binding.slackTeamId,
    channelId,
    agentId,
    status: 'active',
    createdByMembershipId: f.owner.membership.id,
    channelLabel,
  });
}

test('archive and restore previews state the operation and its reach, not field diffs', () =>
  withFixture('preview-archive', async (f) => {
    const agent = await createAgent(f, 'agent_research');
    await grant(f, agent.id, 'C_LAUNCH', 'launch');
    await grant(f, agent.id, 'C_SUPPORT', 'support');

    const archive = await preview(f, slackContext(f), 'archive', [{
      itemId: 'archive',
      kind: 'archive_agent',
      agentId: agent.id,
      expectedRevision: agent.revision,
    }]);
    assert.equal(archive.slack, slackPreview(
      'Archive *Research* (@research). It leaves 2 Channels and stops answering. It can be restored later.',
    ));
    assert.equal(archive.markdown, markdownPreview(
      'Archive **Research** (@research). It leaves 2 Channels and stops answering. It can be restored later.',
    ));

    const archived = await f.config.archiveAgent(agent.id, { expectedRevision: agent.revision });
    const restore = await preview(f, slackContext(f), 'restore', [{
      itemId: 'restore',
      kind: 'restore_agent',
      agentId: agent.id,
      expectedRevision: archived.revision,
    }]);
    assert.equal(restore.slack, slackPreview(
      'Restore *Research* (@research). It gets back the Channels and schedules it had before the archive.',
    ));
    assert.equal(restore.markdown, markdownPreview(
      'Restore **Research** (@research). It gets back the Channels and schedules it had before the archive.',
    ));
  }));

test('an archive whose Agent gained a Channel after the preview goes stale instead of applying', () =>
  withFixture('preview-archive-stale', async (f) => {
    const agent = await createAgent(f, 'agent_research');
    await grant(f, agent.id, 'C_LAUNCH', 'launch');
    await grant(f, agent.id, 'C_SUPPORT', 'support');
    const archive = await apply(f, slackContext(f), 'archive-two', [{
      itemId: 'archive',
      kind: 'archive_agent',
      agentId: agent.id,
      expectedRevision: agent.revision,
    }]);
    assert.match(archive.presentation?.slack ?? '', /It leaves 2 Channels/);
    const proposalId = archive.outcomes[0]?.proposalId;
    assert.ok(proposalId);

    await grant(f, agent.id, 'C_HELP', 'help');
    await assert.rejects(
      f.service.confirmWorkspaceChange({ context: withPersonApproval(slackContext(f), proposalId), proposalId }),
      (error: unknown) => (error as { code?: string }).code === 'proposal_stale',
    );
    assert.equal((await f.config.getAgent(agent.id)).lifecycle, 'active');

    const fresh = await preview(f, slackContext(f), 'archive-three', [{
      itemId: 'archive',
      kind: 'archive_agent',
      agentId: agent.id,
      expectedRevision: agent.revision,
    }]);
    assert.match(fresh.slack, /It leaves 3 Channels/);
  }));

test('an archive without Channel reach says it stops answering', () =>
  withFixture('preview-archive-alone', async (f) => {
    const agent = await createAgent(f, 'agent_research', {
      slackPresence: { ...PUBLISHED_PRESENCE, desiredState: 'unpublished', health: 'unpublished' },
    });
    const archive = await preview(f, slackContext(f), 'archive-alone', [{
      itemId: 'archive',
      kind: 'archive_agent',
      agentId: agent.id,
      expectedRevision: agent.revision,
    }]);
    assert.equal(archive.slack, slackPreview(
      'Archive *Research* (@research). It stops answering. It can be restored later.',
    ));
  }));

test('a delete preview says it is permanent', () => withFixture('preview-delete', async (f) => {
  const { userGroupId: _userGroupId, ...unpublished } = PUBLISHED_PRESENCE;
  const agent = await createAgent(f, 'agent_research', {
    slackPresence: { ...unpublished, desiredState: 'unpublished', health: 'unpublished' },
  });
  const deletion = await preview(f, mcpContext(f), 'delete', [{
    itemId: 'delete',
    kind: 'delete_agent',
    agentId: agent.id,
    expectedRevision: agent.revision,
  }]);
  assert.equal(deletion.markdown, markdownPreview(
    'Delete **Research** (@research) permanently. This cannot be undone.',
  ));
  assert.equal(deletion.slack, slackPreview(
    'Delete *Research* (@research) permanently. This cannot be undone.',
  ));
}));

test('member previews name the person and the access change', () =>
  withFixture('preview-member', async (f) => {
    const member = (await f.identity.provisionSlackMember({
      slackTeamId: f.owner.binding.slackTeamId,
      slackUserId: 'UPREVIEW01',
      displayName: 'Alex Rivera',
    })).resolution!;

    const suspend = await preview(f, mcpContext(f), 'suspend', [{
      itemId: 'suspend',
      kind: 'update_member',
      membershipId: member.membership.id,
      status: 'suspended',
    }]);
    assert.equal(suspend.markdown, markdownPreview(
      'Suspend **Alex Rivera**’s Chickpea access. They can’t use Agents or sign in until an Owner restores it.',
    ));
    assert.equal(suspend.slack, slackPreview(
      'Suspend *Alex Rivera*’s Chickpea access. They can’t use Agents or sign in until an Owner restores it.',
    ));

    const removal = await preview(f, mcpContext(f), 'remove', [{
      itemId: 'remove',
      kind: 'update_member',
      membershipId: member.membership.id,
      status: 'removed',
    }]);
    assert.equal(removal.markdown, markdownPreview(
      'Remove **Alex Rivera** from Chickpea. Removal is permanent.',
    ));

    const promotion = await preview(f, mcpContext(f), 'promote', [{
      itemId: 'promote',
      kind: 'update_member',
      membershipId: member.membership.id,
      role: 'owner',
    }]);
    assert.equal(promotion.markdown, markdownPreview('Make **Alex Rivera** an Owner.'));
  }));

test('a provider key removal preview lists the Agents that stop answering', () => {
  let storedKey = true;
  return withFixture('preview-provider', async (f) => {
    await createAgent(f, 'agent_research', { model: 'openai/gpt-5.6' });
    await createAgent(f, 'agent_writer', {
      name: 'Writer',
      model: 'openai/gpt-5.6-mini',
      slackPresence: { ...PUBLISHED_PRESENCE, requestedHandle: 'writer', normalizedHandle: 'writer' },
    });
    await createAgent(f, 'agent_claude', {
      name: 'Claude Helper',
      model: 'anthropic/claude-opus-5',
      slackPresence: { ...PUBLISHED_PRESENCE, requestedHandle: 'claude', normalizedHandle: 'claude' },
    });

    const removal = await preview(f, mcpContext(f), 'remove-openai', [{
      itemId: 'remove-key',
      kind: 'remove_provider_credential',
      providerId: 'openai',
    }]);
    assert.equal(removal.markdown, markdownPreview(
      'Remove the stored **OpenAI** key. **Research** and **Writer** use OpenAI and stop answering until a key is available.',
    ));
    assert.equal(removal.slack, slackPreview(
      'Remove the stored *OpenAI* key. *Research* and *Writer* use OpenAI and stop answering until a key is available.',
    ));

    const unused = await preview(f, mcpContext(f), 'remove-openrouter', [{
      itemId: 'remove-key',
      kind: 'remove_provider_credential',
      providerId: 'openrouter',
    }]);
    assert.equal(unused.markdown, markdownPreview(
      'Remove the stored **OpenRouter** key. No Agent pin or Workspace default currently depends on OpenRouter.',
    ));
  }, {
    providerCredentialSource: async () => storedKey ? 'stored' : 'missing',
    removeProviderCredential: async () => {
      storedKey = false;
      return 'missing';
    },
  });
});

test('a provider key removal names the Workspace image and coding models that use it', () =>
  withFixture('preview-provider-roles', async (f) => {
    const workspaceId = f.owner.binding.slackTeamId;
    await f.config.ensureWorkspaceInstallation({ workspaceId, transportMode: 'direct', teamId: workspaceId });
    await createAgent(f, 'agent_claude', { model: 'anthropic/claude-opus-5' });
    await f.config.putWorkspaceModelRole({ workspaceId, role: 'image', modelId: 'openai/gpt-image-2.5-flare' }, 0);
    await f.config.putWorkspaceModelRole({ workspaceId, role: 'coding', modelId: 'openai/gpt-5.6' }, 0);

    const removal = await preview(f, mcpContext(f), 'remove-openai-roles', [{
      itemId: 'remove-key',
      kind: 'remove_provider_credential',
      providerId: 'openai',
    }]);
    assert.equal(removal.markdown, markdownPreview(
      'Remove the stored **OpenAI** key. ' +
        'The default image model uses OpenAI, so image generation stops until a key is available. ' +
        'The default coding model uses OpenAI, so coding workspaces use each Agent’s own model until a key is available.',
    ));

    // ChatGPT Image runs on the connected subscription, so removing the key leaves it working.
    await f.config.putWorkspaceModelRole({ workspaceId, role: 'image', modelId: 'openai/chatgpt-image' }, 1);
    await f.config.putWorkspaceModelRole({ workspaceId, role: 'coding', modelId: 'anthropic/claude-opus-5' }, 1);
    const unaffected = await preview(f, mcpContext(f), 'remove-openai-subscription-image', [{
      itemId: 'remove-key',
      kind: 'remove_provider_credential',
      providerId: 'openai',
    }]);
    assert.equal(unaffected.markdown, markdownPreview(
      'Remove the stored **OpenAI** key. No Agent pin or Workspace default currently depends on OpenAI.',
    ));
  }, { providerCredentialSource: async () => 'stored' }));

test('a saved routine preview names its Channel, never the Slack Channel ID', () =>
  withFixture('preview-routine-channel', async (f) => {
    const workspaceId = f.owner.binding.slackTeamId;
    const agent = await createAgent(f, 'agent_research');
    await grant(f, agent.id, 'C0123ABCD', 'launch');
    const routine = {
      itemId: 'routine',
      kind: 'save_routine' as const,
      requiredConnectionAccountIds: [],
      agentId: agent.id,
      workspaceId,
      channelId: 'C0123ABCD',
      name: 'Morning triage',
      description: 'Triage the overnight queue.',
      taskText: 'Summarize urgent requests.',
      schedule: { kind: 'cron' as const, expression: '0 9 * * 1-5' },
      timezone: 'UTC',
      outputPolicy: 'post' as const,
    };

    const named = await propose(f, 'routine-launch', [routine]);
    assert.match(named.slack, /\*Morning triage — Destination\*\n> New messages in #launch\n/);
    assert.match(named.slack, /> 0 9 \* \* 1-5/, 'quoted values keep their formatting characters');
    assert.doesNotMatch(named.slack, /C0123ABCD/);

    await f.config.putAgentChannelGrant({
      workspaceId,
      channelId: 'C0UNNAMED1',
      agentId: agent.id,
      status: 'active',
      createdByMembershipId: f.owner.membership.id,
    });
    const unnamed = await propose(f, 'routine-unnamed', [{ ...routine, channelId: 'C0UNNAMED1' }]);
    assert.match(unnamed.markdown, /\*\*Morning triage — Destination\*\*\n> New messages in a Slack Channel\n/);
    assert.doesNotMatch(unnamed.markdown, /C0UNNAMED1/);
  }));

test('a member change with no role or status names the member and the operation', () =>
  withFixture('preview-member-empty', async (f) => {
    const member = (await f.identity.provisionSlackMember({
      slackTeamId: f.owner.binding.slackTeamId,
      slackUserId: 'UPREVIEW02',
      displayName: 'Alex Rivera',
    })).resolution!;
    const change = await propose(f, 'member-noop', [{
      itemId: 'noop',
      kind: 'update_member',
      membershipId: member.membership.id,
    }]);
    assert.equal(change.markdown, markdownPreview('**Alex Rivera — Update Member**'));
  }));

test('a connection removal preview names the connection and the Agent', () =>
  withFixture('preview-connection', async (f) => {
    for (const [field, entry, name] of [
      ['mcpServers', knowledgeServer, 'Knowledge'],
      ['apiConnections', billingApi, 'Billing'],
    ] as const) {
      const agent = await createAgent(f, `agent_remove_${field.toLowerCase()}`, { [field]: [entry] });
      const removal = await preview(f, mcpContext(f), `remove-${field}`, [{
        itemId: 'remove',
        kind: 'update_agent',
        agentId: agent.id,
        expectedRevision: agent.revision,
        patch: { [field]: [] },
      }]);
      assert.equal(removal.markdown, markdownPreview(
        `Remove **${name}** from **Research** (@research).`,
      ), field);
      assert.equal(removal.slack, slackPreview(
        `Remove *${name}* from *Research* (@research).`,
      ), field);
    }
  }));
