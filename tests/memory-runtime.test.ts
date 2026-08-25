import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { WebClient } from '@slack/web-api';

import {
  closeNodeStateStores,
  getConfigStore,
  getMemoryStateStore,
} from '../src/config/state-backend.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { prepareMemoryTurn } from '../src/memory/runtime.ts';
import { resolveAgentRoute } from '../src/slack/agent-routing.ts';
import { AgentUserGroupLookupLimiter } from '../src/slack/agent-presence/reconciler.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';

test('an explicit base-app management mention stays memoryless without a default-Agent Channel grant', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-management-memory-'));
  const statePath = join(directory, 'state.sqlite');
  const previousStatePath = process.env.SLACK_STATE_DB_PATH;
  process.env.SLACK_STATE_DB_PATH = statePath;
  closeNodeStateStores();
  try {
    const config = getConfigStore();
    const agent = await config.getAgent('agent_default');
    const installation = await config.ensureWorkspaceInstallation({
      workspaceId: 'T_MANAGEMENT',
      teamId: 'T_MANAGEMENT',
      transportMode: 'direct',
      defaultAgentId: agent.id,
      botUserId: 'U_CHICKPEA',
    });
    await config.updateWorkspaceInstallation('T_MANAGEMENT', {
      health: 'healthy',
    }, installation.revision);
    await getMemoryStateStore().putAgentMemory({
      agentId: agent.id,
      body: 'Private default-Agent memory must not enter this Channel.',
      expectedRevision: 0,
    });

    const turn: NormalizedSlackTurn = {
      workspaceId: 'T_MANAGEMENT',
      channelId: 'C_AGENT_ONLY',
      eventId: 'Ev-management',
      text: '<@U_CHICKPEA> create an Agent',
      userId: 'U_MEMBER',
      messageTs: '100.1',
      threadTs: '100.1',
      source: 'app_mention',
      channelType: 'channel',
      contextMode: 'channel_history',
    };
    const assignment: ResolvedAssignment = {
      workspaceId: turn.workspaceId,
      channelId: turn.channelId,
      agentId: agent.id,
      agent,
      interactionMode: 'workspace_management',
    };
    const client = {
      auth: { test: async () => ({ user_id: 'U_CHICKPEA' }) },
      conversations: {
        info: async () => ({
          channel: {
            id: turn.channelId,
            context_team_id: turn.workspaceId,
            is_member: true,
          },
        }),
        members: async () => ({ members: [turn.userId, 'U_CHICKPEA'] }),
      },
      users: {
        info: async () => ({ user: { id: turn.userId, team_id: turn.workspaceId } }),
      },
    } as unknown as WebClient;

    const prepared = await prepareMemoryTurn({
      turn,
      assignment,
      client,
      botUserId: 'U_CHICKPEA',
      platformEnv: undefined,
    });
    assert.equal(prepared.promptBlock, undefined);
    assert.deepEqual(prepared.selection, { entries: [] });
    assert.match(prepared.conversationKey, /:workspace-management$/);
    assert.equal(await prepared.validateLease(), true);

    const { interactionMode: _interactionMode, ...ordinaryAssignment } = assignment;
    const recovered = await prepareMemoryTurn({
      turn,
      assignment: ordinaryAssignment,
      client,
      botUserId: 'U_CHICKPEA',
      platformEnv: undefined,
    });
    assert.equal(recovered.promptBlock, undefined);
    assert.deepEqual(recovered.selection, { entries: [] });
    assert.match(recovered.conversationKey, /:workspace-management$/);
    assert.equal(await recovered.validateLease(), true);

    const ordinary = await prepareMemoryTurn({
      turn: { ...turn, text: 'synthetic work without a base-bot mention' },
      assignment: ordinaryAssignment,
      client,
      botUserId: 'U_CHICKPEA',
      platformEnv: undefined,
    });
    assert.equal(ordinary.promptBlock, undefined);
    assert.equal(await ordinary.validateLease(), false);
  } finally {
    closeNodeStateStores();
    if (previousStatePath === undefined) delete process.env.SLACK_STATE_DB_PATH;
    else process.env.SLACK_STATE_DB_PATH = previousStatePath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an ordinary stale Slack group mapping repairs into the Agent memory path', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-agent-memory-repair-'));
  const statePath = join(directory, 'state.sqlite');
  const previousStatePath = process.env.SLACK_STATE_DB_PATH;
  process.env.SLACK_STATE_DB_PATH = statePath;
  closeNodeStateStores();
  try {
    const config = getConfigStore();
    const agent = await config.createAgent({
      id: 'agent_support', name: 'Support', description: 'Answers support questions',
      instructions: 'Help customers.', enabled: true, lifecycle: 'active',
      creatorMembershipId: 'membership_owner', editPolicy: 'creator_and_admins',
      model: 'local-stub/support', skills: [], mcpServers: [], apiConnections: [], repositories: [],
      slackPresence: {
        requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active',
        health: 'healthy', userGroupId: 'SOLD',
        avatar: { kind: 'generated', revision: 1, seed: 'support' },
      },
    });
    const installation = await config.ensureWorkspaceInstallation({
      workspaceId: 'T_REPAIR', teamId: 'T_REPAIR', transportMode: 'direct',
      defaultAgentId: 'agent_default', botUserId: 'U_CHICKPEA',
    });
    await config.updateWorkspaceInstallation(
      'T_REPAIR', { health: 'healthy' }, installation.revision,
    );
    await config.putAgentChannelGrant({
      workspaceId: 'T_REPAIR', channelId: 'C_SUPPORT', agentId: agent.id,
      status: 'active', createdByMembershipId: 'membership_owner',
      channelLabel: 'support', channelIsPrivate: false,
    });
    await getMemoryStateStore().putAgentMemory({
      agentId: agent.id,
      body: 'QA memory canary: use the blue response.',
      expectedRevision: 0,
    });
    const turn: NormalizedSlackTurn = {
      workspaceId: 'T_REPAIR', channelId: 'C_SUPPORT', eventId: 'Ev-repair',
      text: '<!subteam^SREPAIRED|@forged-label> answer', userId: 'U_MEMBER',
      messageTs: '100.1', threadTs: '100.1', source: 'agent_mention',
      channelType: 'channel', contextMode: 'channel_history',
    };
    const routed = await resolveAgentRoute({
      turn,
      surface: 'channel',
      actor: { channelMember: true, fullMember: true },
      config,
      transport: {
        lookupUserGroup: async () => ({
          id: 'SREPAIRED', name: 'Support', handle: 'support',
          description: 'Answers support questions', disabled: false,
          updatedAt: 1_800_000_000,
        }),
      },
      userGroupLookupLimiter: new AgentUserGroupLookupLimiter(),
    });
    assert.equal(routed.kind, 'routed');
    if (routed.kind !== 'routed') return;
    assert.equal(routed.assignment.agentId, agent.id);

    const client = {
      auth: { test: async () => ({ user_id: 'U_CHICKPEA' }) },
      conversations: {
        info: async () => ({
          channel: { id: turn.channelId, context_team_id: turn.workspaceId, is_member: true },
        }),
        members: async () => ({ members: [turn.userId, 'U_CHICKPEA'] }),
      },
      users: {
        info: async () => ({ user: { id: turn.userId, team_id: turn.workspaceId } }),
      },
    } as unknown as WebClient;
    const prepared = await prepareMemoryTurn({
      turn, assignment: routed.assignment, client,
      botUserId: 'U_CHICKPEA', platformEnv: undefined,
    });
    assert.match(prepared.promptBlock ?? '', /QA memory canary: use the blue response\./);
    assert.ok(prepared.selection);
    assert.equal(prepared.selection.entries[0]?.entry.agentId, agent.id);
    assert.equal((await config.getAgent(agent.id)).slackPresence?.userGroupId, 'SREPAIRED');
    assert.equal(await prepared.validateLease(), true);
  } finally {
    closeNodeStateStores();
    if (previousStatePath === undefined) delete process.env.SLACK_STATE_DB_PATH;
    else process.env.SLACK_STATE_DB_PATH = previousStatePath;
    rmSync(directory, { recursive: true, force: true });
  }
});
