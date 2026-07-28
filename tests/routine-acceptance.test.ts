import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { WebClient } from '@slack/web-api';

import { createRoutineAdminApi } from '../src/admin/routines-api.ts';
import type { EffectiveSlackConfig } from '../src/config/effective-config.ts';
import { RoutineAdmissionController, type RoutineAdmissionAdapter } from '../src/routines/admission.ts';
import { handleRoutineSlackRequest } from '../src/routines/commands.ts';
import { deliverRoutineResult } from '../src/routines/delivery.ts';
import { RoutineScheduler } from '../src/routines/scheduler.ts';
import { SqliteRoutineStore } from '../src/routines/store.ts';
import type { RoutineCapability } from '../src/routines/scheduler-adapter.ts';
import type { RoutineRun, RoutineStore } from '../src/routines/types.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { initializeRoutineWorkflowRuntime } from '../src/workflows/routine.ts';

const enabled: RoutineCapability = {
  target: 'cloudflare', available: true, enabled: true, reason: 'enabled',
};

const config: EffectiveSlackConfig = {
  workspaceId: 'T_ACCEPT', channelId: 'C_ACCEPT', agentId: 'agent_accept',
  agent: {
    id: 'agent_accept', name: 'Acceptance', instructions: 'Use current channel authority.',
    enabled: true, model: 'local-stub/routine-acceptance', skills: [], mcpServers: [],
    apiConnections: [], repositories: [],
  },
  model: 'local-stub/routine-acceptance', provider: 'local-stub',
  instructions: 'Use current channel authority.', instructionLayers: [],
};

function turn(text: string, eventId: string): NormalizedSlackTurn {
  return {
    workspaceId: 'T_ACCEPT', channelId: 'C_ACCEPT', userId: 'U_CREATOR', eventId, text,
    messageTs: '1785100000.000100', threadTs: '1785100000.000100',
    source: 'app_mention', contextMode: 'channel_history',
  };
}

class AcceptanceAdmission implements RoutineAdmissionAdapter {
  readonly invoked: string[] = [];

  async invoke(run: RoutineRun): Promise<{ runId: string }> {
    this.invoked.push(run.id);
    return { runId: `run_accept_${run.id}` };
  }

  async scan() {
    return { available: true, complete: true, candidates: [] };
  }
}

test('scheduled write crosses one-message creation, heartbeat, Workflow admission, restart, live auth, Slack, and Admin', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-routine-acceptance-'));
  const statePath = join(directory, 'state.sqlite');
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = new Date().setUTCMinutes(59, 0, 0);
  let store = new SqliteRoutineStore(statePath, () => now);
  const commandOptions = {
    store,
    capability: enabled,
    now: () => now,
    canManageChannel: async () => true,
    parseIntent: async () => ({
      action: 'create' as const,
      name: 'Tracker steward',
      description: 'Updates the configured tracker and reports the result.',
      taskText: 'Update the configured tracker with unresolved blockers and post what changed.',
      scheduleExpression: '0 * * * *',
      timezone: 'UTC',
      timezoneWasDefaulted: false,
      outputPolicy: 'post' as const,
    }),
  };

  try {
    const createdText = await handleRoutineSlackRequest(
      turn(
        'Every hour, Update the configured tracker with unresolved blockers and post what changed.',
        'Ev_ACCEPT_CREATE',
      ),
      undefined,
      commandOptions,
    );
    assert.match(createdText ?? '', /Routine created/i);
    assert.match(createdText ?? '', /\*\*Tracker steward\*\* · Active/);
    assert.match(createdText ?? '', /\*\*Task:\*\* Update the configured tracker/);
    assert.doesNotMatch(createdText ?? '', /Creator:|Resource limits:|current Chickpea access/i);
    assert.doesNotMatch(createdText ?? '', /!routines confirm/);
    const [routine] = await store.listRoutines('T_ACCEPT', 'C_ACCEPT');
    assert.ok(routine);
    assert.match(routine.taskText, /Update the configured tracker/);

    now += 60_000;
    const adapter = new AcceptanceAdmission();
    const logs: string[] = [];
    const heartbeat = await new RoutineScheduler(
      store,
      new RoutineAdmissionController(store, adapter),
      { info: (message) => logs.push(message) },
      () => now,
    ).heartbeat(now, 'heartbeat-acceptance');
    assert.equal(heartbeat.claims.runs.length, 1);
    assert.equal(heartbeat.admissions.attached, 1);
    assert.deepEqual(adapter.invoked, [heartbeat.claims.runs[0]!.id]);
    assert.equal(logs.length, 1);

    // Restart at the admission boundary. The product occurrence and its Flue
    // receipt must remain the only winning execution record.
    store.close();
    store = new SqliteRoutineStore(statePath, () => now);
    const admitted = (await store.listRuns({ routineId: routine.id }))[0];
    assert.ok(admitted);
    assert.equal(admitted.status, 'admitting');
    assert.equal(admitted.flueRunId, `run_accept_${admitted.id}`);

    const lifecycle: string[] = [];
    const runtime = await initializeRoutineWorkflowRuntime(
      {
        flueRunId: admitted.flueRunId,
        env: {},
        store,
        run: admitted,
        routine: (await store.getRoutine(routine.id))!,
      },
      {
        resolveAccess: async () => {
          lifecycle.push('live-access');
          return {
            config, accessHash: 'a'.repeat(64), botToken: 'xoxb-acceptance', botUserId: 'U_BOT',
          };
        },
        useCloudflareSandbox: async () => false,
        createAgent: async ({ id }) => {
          lifecycle.push(`agent:${id}`);
          return { model: config.model, instructions: config.instructions, tools: [] };
        },
      },
    );
    assert.deepEqual(lifecycle, [
      'live-access',
      `agent:routine:${admitted.flueRunId}:T_ACCEPT:C_ACCEPT`,
    ]);

    const slackBodies: URLSearchParams[] = [];
    const client = new WebClient('xoxb-acceptance', {
      slackApiUrl: 'https://slack.invalid/api/', retryConfig: { retries: 0 },
      fetch: async (_url, init) => {
        slackBodies.push(new URLSearchParams(String(init?.body ?? '')));
        return new Response(JSON.stringify({
          ok: true, channel: 'C_ACCEPT', ts: '1785100060.000200',
        }), { headers: { 'content-type': 'application/json' } });
      },
    });
    const running = (await store.getRun(admitted.id))!;
    await deliverRoutineResult({
      store,
      run: running,
      routine: runtime.routine,
      access: runtime.access,
      message: 'Updated one reversible acceptance record.',
      changeKeyHash: 'b'.repeat(64),
      now: () => now + 1,
    }, client);
    await store.transitionRun({
      occurrenceId: running.id,
      from: ['running'],
      to: 'succeeded',
      at: now + 2,
      model: config.model,
      inputTokens: 12,
      outputTokens: 8,
      toolCallCount: 1,
      changeKeyHash: 'b'.repeat(64),
    });
    assert.equal(slackBodies.length, 1);
    assert.equal(slackBodies[0]!.get('channel'), 'C_ACCEPT');
    assert.equal(slackBodies[0]!.get('thread_ts'), null);

    const admin = createRoutineAdminApi({
      store: () => store as RoutineStore,
      capability: () => enabled,
    });
    const detail = await admin.request(`/audit/scheduled_work/routines/${routine.id}`);
    assert.equal(detail.status, 200);
    const body = await detail.json() as {
      routine: { authorityMode: string };
      runs: Array<{ status: string; deliveryStatus: string; flueRunId: string; resolvedAccessHash: string }>;
      events: Array<{ eventType: string }>;
    };
    assert.equal(body.routine.authorityMode, 'live_channel_v1');
    assert.deepEqual(body.runs.map((run) => [run.status, run.deliveryStatus]), [['succeeded', 'delivered']]);
    assert.equal(body.runs[0]!.flueRunId, admitted.flueRunId);
    assert.equal(body.runs[0]!.resolvedAccessHash, 'a'.repeat(64));
    assert.ok(body.events.some((event) => event.eventType === 'routine.occurrence_succeeded'));

    const repeat = await new RoutineScheduler(
      store,
      new RoutineAdmissionController(store, adapter),
      { info() {} },
      () => now,
    ).heartbeat(now, 'heartbeat-repeat');
    assert.equal(repeat.claims.runs.length, 0);
    assert.equal((await store.listRuns({ routineId: routine.id })).length, 1);
    assert.equal(adapter.invoked.length, 1);
  } finally {
    store.close();
  }
});
