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
    const ordinary = await prepareMemoryTurn({
      turn: { ...turn, source: 'agent_mention' },
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
