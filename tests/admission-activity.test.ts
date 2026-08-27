import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { activityStatus } from '../src/activity/status.ts';
import { presentAdmittedSlackActivity } from '../src/slack/admission-activity.ts';
import type { SlackPresentationStatePort } from '../src/slack/agent-view-presentation.ts';
import { SlackRunPresentationStoreLogic } from '../src/slack/run-presentations.ts';
import { openStateDb } from '../src/state/node-state-db.ts';

test('canonical admission posts one durable owner-authored activity before execution', async () => {
  const db = openStateDb(':memory:');
  try {
    const store = new SlackRunPresentationStoreLogic(db, () => 1_800_000_000_000);
    const runId = 'run_admission_activity';
    const operationId = 'activity_admission_activity_1';
    const activity = activityStatus('writing', 'Drafting', 'the initial skill');
    const owner = {
      kind: 'selected_agent' as const,
      persona: {
        name: 'Sprout',
        avatarUrl: 'https://chickpea.example/assets/agents/sprout/avatar/3',
        avatarRevision: 3,
      },
    };
    store.create({
      schemaVersion: 3,
      runId,
      turnJobId: 'turn_admission_activity',
      bindingId: 'binding_admission_activity',
      workBindingGeneration: 1,
      runFencingToken: 0,
      root: {
        workspaceId: 'T_ADMISSION',
        channelId: 'D_ADMISSION',
        threadTs: '1785700100.000100',
        requesterUserId: 'U_ADMISSION',
      },
      owner,
      sessionGeneration: 1785700100000100,
      currentActivity: {
        kind: activity.kind,
        action: activity.action,
        object: activity.object,
        generation: 1785700100000100,
        sequence: 1,
        operation: { operationId, certainty: 'pending' },
      },
    });
    const posts: Array<Record<string, unknown>> = [];
    const sessionStatuses: Array<Record<string, unknown>> = [];
    const nativeStatuses: Array<Record<string, unknown>> = [];
    const client = {
      async apiCall(method: string, input: Record<string, unknown>) {
        assert.equal(method, 'agents.sessions.setStatus');
        sessionStatuses.push(input);
        return { ok: true };
      },
      assistant: {
        threads: {
          async setStatus(input: Record<string, unknown>) {
            nativeStatuses.push(input);
            return { ok: true };
          },
        },
      },
      chat: {
        async postMessage(input: Record<string, unknown>) {
          posts.push(input);
          return { ok: true, ts: '1785700100.000200' };
        },
      },
    } as unknown as WebClient;
    const state: SlackPresentationStatePort = {
      getRunPresentation: (id) => store.get(id),
      getLatestThreadSessionGeneration: (root) =>
        store.getLatestThreadSessionGeneration(root),
      transitionRunPresentation: (input) => store.transition(input),
      reserveSlackAppend: (workspaceId) => store.reserveAppend(workspaceId),
      applySlackAppendCooldown: (workspaceId, retryAfterMs) =>
        store.applyAppendCooldown(workspaceId, retryAfterMs),
      matchFlueObservation: () => undefined,
    };
    const input = {
      client,
      state,
      runId,
      runFencingToken: 0,
      workspaceId: 'T_ADMISSION',
      channelId: 'D_ADMISSION',
      threadTs: '1785700100.000100',
      requesterUserId: 'U_ADMISSION',
      owner,
      agentId: 'agent_sprout',
      activity,
    };

    assert.equal(await presentAdmittedSlackActivity(input), true);
    assert.equal(await presentAdmittedSlackActivity(input), false);
    assert.deepEqual(sessionStatuses, [{
      channel_id: 'D_ADMISSION',
      thread_ts: '1785700100.000100',
      status: 'processing',
      initiator_user_id: 'U_ADMISSION',
      username: 'Sprout',
      icon_url: owner.persona.avatarUrl,
    }], 'admission starts one native processing status with the frozen owner');
    assert.deepEqual(nativeStatuses, [{
      channel_id: 'D_ADMISSION',
      thread_ts: '1785700100.000100',
      status: 'Drafting the initial skill…',
      loading_messages: ['Drafting the initial skill…'],
      username: 'Sprout',
      icon_url: owner.persona.avatarUrl,
    }], 'selected Agent activity uses one native status with frozen authorship');
    assert.deepEqual(posts, []);
    const stored = store.get(runId);
    assert.equal(stored?.schemaVersion, 3);
    if (stored?.schemaVersion === 3) {
      assert.deepEqual(stored.currentActivity?.operation, {
        operationId,
        certainty: 'acknowledged',
      });
      assert.deepEqual(stored.activityProjection, {
        surface: 'assistant_status',
        state: 'visible',
      });
      assert.deepEqual(stored.agentSession, {
        desired: 'processing',
        acknowledged: 'processing',
        operation: {
          operationId: stored.agentSession.operation?.operationId,
          certainty: 'acknowledged',
        },
      });
    }
  } finally {
    db.close();
  }
});
