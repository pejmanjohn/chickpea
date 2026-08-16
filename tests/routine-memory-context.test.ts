import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { getConfigStore, getMemoryStateStore } from '../src/config/state-backend.ts';
import type { CustomAgentConfig } from '../src/config/types.ts';
import { bindAuthorizedMemoryScope } from '../src/memory/scope.ts';
import { MemoryService } from '../src/memory/service.ts';
import { prepareRoutinePrompt } from '../src/routines/prompt.ts';
import { SqliteRoutineStore } from '../src/routines/store.ts';
import type { RoutineRuntimeAccess } from '../src/routines/runtime.ts';
import { withEnv } from './helpers/env.ts';

const NOW = Date.UTC(2026, 7, 12, 12);

function agent(id: string, name: string): CustomAgentConfig {
  return {
    id,
    revision: 1,
    name,
    instructions: `Act as ${name}.`,
    enabled: true,
    model: 'local-stub/routine-memory',
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  };
}

test('routine provider input includes its current Agent and exact Channel memory only', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-routine-memory-'));
  const dbPath = join(directory, 'state.db');
  try {
    await withEnv({ SLACK_STATE_DB_PATH: dbPath }, async () => {
      const config = getConfigStore();
      const agentA = agent('agent_routine_a', 'Routine A');
      const agentB = agent('agent_routine_b', 'Routine B');
      await config.createAgent(agentA);
      await config.createAgent(agentB);
      await config.putChannel({
        workspaceId: 'T_ROUTINE', channelId: 'C_ROUTINE', label: 'routine',
        participationMode: 'mention_only', lifecycle: 'active',
      });
      await config.putChannel({
        workspaceId: 'T_ROUTINE', channelId: 'C_OTHER', label: 'other',
        participationMode: 'mention_only', lifecycle: 'active',
      });
      await config.putAssignment({
        workspaceId: 'T_ROUTINE', channelId: 'C_ROUTINE', agentId: agentA.id,
      });
      await config.putAssignment({
        workspaceId: 'T_ROUTINE', channelId: 'C_OTHER', agentId: agentB.id,
      });

      const state = getMemoryStateStore();
      const aOwner = await state.ensureOwner({
        workspaceId: 'T_ROUTINE', ownerKind: 'agent', ownerId: agentA.id,
      });
      const bOwner = await state.ensureOwner({
        workspaceId: 'T_ROUTINE', ownerKind: 'agent', ownerId: agentB.id,
      });
      const channelOwner = await state.ensureOwner({
        workspaceId: 'T_ROUTINE', ownerKind: 'channel', ownerId: 'C_ROUTINE',
      });
      const otherChannelOwner = await state.ensureOwner({
        workspaceId: 'T_ROUTINE', ownerKind: 'channel', ownerId: 'C_OTHER',
      });
      const memory = new MemoryService(state);
      for (const [owner, name, body, eventId] of [
        [aOwner, 'routine-agent-roadmap', 'Authorized Agent roadmap.', 'seed-a'],
        [bOwner, 'routine-agent-b-roadmap', 'Forbidden Agent B roadmap.', 'seed-b'],
        [channelOwner, 'routine-channel-roadmap', 'Authorized exact Channel roadmap.', 'seed-channel'],
        [otherChannelOwner, 'routine-other-channel-roadmap', 'Forbidden other Channel roadmap.', 'seed-other'],
      ] as const) {
        await memory.remember({
          scope: bindAuthorizedMemoryScope({
            surface: 'admin', workspaceId: 'T_ROUTINE',
            ...(owner.ownerKind === 'agent' ? { agentOwner: owner } : { channelOwner: owner }),
            writeOwner: owner,
          }),
          workspaceId: 'T_ROUTINE', actorId: 'U_CREATOR', eventId,
          name, description: 'Routine roadmap context', type: 'fact', body,
          idempotencyKey: eventId,
        });
      }

      const routines = new SqliteRoutineStore(dbPath, () => NOW);
      try {
        const routine = await routines.save({
          actorId: 'U_CREATOR', actorClass: 'member',
          workspaceId: 'T_ROUTINE', channelId: 'C_ROUTINE',
          draft: {
            action: 'create', routineId: 'routine_memory_context',
            definition: {
              name: 'Roadmap review', description: '',
              taskText: 'Review the roadmap context for this Channel.',
              triggerKind: 'schedule', scheduleInput: '0 * * * *',
              scheduleJson: JSON.stringify({ version: 1, kind: 'cron', expression: '0 * * * *' }),
              timezone: 'UTC', outputPolicy: 'post', authorityMode: 'live_channel_v1',
            },
            nextRunAt: NOW, projectedDailyStarts: 1,
            reservations: [{ windowStart: NOW, count: 1 }],
          },
          idempotencyKey: 'create:routine-memory-context',
        });
        const run = await routines.createOccurrence({
          runId: 'rrun_memory_context', idempotencyKey: 'run:routine-memory-context',
          routineId: routine.id, routineVersion: routine.version, scheduledFor: NOW,
          triggerSource: 'schedule', queuedAt: NOW, deadlineAt: NOW + 60_000,
        });
        const access: RoutineRuntimeAccess = {
          config: {
            workspaceId: 'T_ROUTINE', channelId: 'C_ROUTINE', agentId: agentA.id,
            agent: agentA, model: 'local-stub/routine-memory', provider: 'local-stub',
            instructions: agentA.instructions, instructionLayers: [],
          },
          accessHash: 'a'.repeat(64), botToken: 'xoxb-routine', botUserId: 'UBOT',
        };
        const client = {
          conversations: {
            async history() {
              return { ok: true, messages: [], response_metadata: { next_cursor: '' } };
            },
          },
        } as unknown as WebClient;

        const prepared = await prepareRoutinePrompt(run, routine, access, undefined, client);
        assert.match(prepared.prompt, /routine-agent-roadmap/);
        assert.match(prepared.prompt, /Authorized Agent roadmap/);
        assert.match(prepared.prompt, /routine-channel-roadmap/);
        assert.match(prepared.prompt, /Authorized exact Channel roadmap/);
        assert.doesNotMatch(prepared.prompt, /routine-agent-b-roadmap|Forbidden Agent B/);
        assert.doesNotMatch(prepared.prompt, /routine-other-channel-roadmap|Forbidden other Channel/);
      } finally {
        routines.close();
      }
    });
  } finally {
    process.env.SLACK_STATE_DB_PATH = ':memory:';
    getMemoryStateStore();
    rmSync(directory, { recursive: true, force: true });
  }
});
