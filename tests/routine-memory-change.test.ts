import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import type { AgentInstanceHandle, AgentReply, DispatchReceipt } from '@flue/runtime';
import { WebClient } from '@slack/web-api';

import { ROUTINE_RESULT_DATA_NAME } from '../src/agents/routine-execution.ts';
import type { EffectiveSlackConfig } from '../src/config/effective-config.ts';
import { closeNodeStateStores } from '../src/config/state-backend.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { prepareMemoryTurn } from '../src/memory/runtime.ts';
import { SqliteMemoryStateStore } from '../src/memory/store.ts';
import { executeRoutineOccurrence } from '../src/routines/execution.ts';
import { prepareRoutinePrompt } from '../src/routines/prompt.ts';
import { agentRoutineDeletion, SqliteRoutineStore } from '../src/routines/store.ts';
import type { RoutineDefinition, RoutineRun } from '../src/routines/types.ts';

/**
 * A routine's memory lease checks access only, as a Slack turn's does: memory
 * another run saves while a routine runs, or between its attempts, never fails
 * the run. The prompt a resumed attempt rebuilds must still match the one its
 * model ran on apart from memory. These run the real prompt and memory lease.
 */

const NOW = Date.UTC(2026, 10, 12, 1, 28);
const WORKSPACE = 'T_RMEM';
const CHANNEL = 'C_RMEM';
const BOT_USER = 'U0RMEMBOT';
const MEMBER = 'U0RMEMBER';
const MEMORY = 'Weekly summaries go to the ops lead.';
const RESULT = 'Two synthetic tickets are open.';

const config = {
  workspaceId: WORKSPACE, channelId: CHANNEL, agentId: 'agent_rmem',
  agent: {
    id: 'agent_rmem', kind: 'user', revision: 1, name: 'Ops', instructions: 'Be useful.', enabled: true,
    model: 'anthropic/claude-sonnet-4-6', skills: [], mcpServers: [], apiConnections: [], repositories: [],
  },
  model: 'anthropic/claude-sonnet-4-6', provider: 'anthropic', instructions: 'Be useful.',
  modelAttribution: { source: 'pinned', providerId: 'anthropic' },
} satisfies EffectiveSlackConfig;

interface Harness {
  memory: SqliteMemoryStateStore;
  configStore: SqliteConfigStore;
  history: Array<Record<string, unknown>>;
  posts: string[];
  attempt(read: AgentInstanceHandle['read']): Promise<string>;
  run(): Promise<RoutineRun | undefined>;
}

async function harness(t: TestContext, suffix: string): Promise<Harness> {
  const keys = ['SLACK_STATE_DB_PATH', 'TAG_DB_PATH', 'CHICKPEA_AUTH_DB_PATH'] as const;
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) process.env[key] = ':memory:';
  closeNodeStateStores();
  const store = new SqliteRoutineStore(':memory:', () => NOW);
  const configStore = new SqliteConfigStore(':memory:', agentRoutineDeletion, { agents: [] });
  const memory = new SqliteMemoryStateStore(':memory:');
  t.after(() => {
    store.close();
    configStore.close();
    memory.close();
    closeNodeStateStores();
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  });
  await configStore.createAgent({ ...config.agent, lifecycle: 'active' });
  const installation = await configStore.ensureWorkspaceInstallation({
    workspaceId: WORKSPACE, teamId: WORKSPACE, transportMode: 'direct', defaultAgentId: config.agentId, botUserId: BOT_USER,
  });
  await configStore.updateWorkspaceInstallation(WORKSPACE, { health: 'healthy' }, installation.revision);
  await configStore.putAgentChannelGrant({
    workspaceId: WORKSPACE, channelId: CHANNEL, agentId: config.agentId, status: 'active',
    createdByMembershipId: 'membership_rmem', channelLabel: 'ops', channelIsPrivate: false,
  });
  await memory.putAgentMemory({ agentId: config.agentId, body: MEMORY, expectedRevision: 0 });

  const history: Array<Record<string, unknown>> = [];
  const posts: string[] = [];
  const slack = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const method = new URL(request.url).pathname.split('/').at(-1)!;
    const body = await request.clone().text().catch(() => '');
    const form = new URLSearchParams(body);
    if (method === 'chat.postMessage') {
      posts.push(body.startsWith('{') ? body : form.get('text') ?? '');
      return Response.json({ ok: true, channel: CHANNEL, ts: '1794450000.000100' });
    }
    return Response.json(
      method === 'conversations.history' ? { ok: true, messages: history }
        : method === 'conversations.replies' ? { ok: true, messages: [] }
        : method === 'conversations.info'
          ? { ok: true, channel: { id: CHANNEL, context_team_id: WORKSPACE, name: 'ops', is_channel: true, is_member: true } }
          : method === 'users.info'
            ? { ok: true, user: { id: form.get('user'), team_id: WORKSPACE, name: 'member', deleted: false, is_bot: false } }
            : method === 'conversations.members'
              ? { ok: true, members: [MEMBER, BOT_USER], response_metadata: { next_cursor: '' } }
              : { ok: true },
    );
  }) as typeof fetch;
  t.mock.method(globalThis, 'fetch', slack);
  const client = new WebClient('xoxb-rmem', { retryConfig: { retries: 0 }, fetch: slack } as never);

  const routine = await store.save({
    actorId: MEMBER, actorClass: 'member', workspaceId: WORKSPACE, channelId: CHANNEL,
    draft: {
      action: 'create', routineId: `routine_${suffix}`, nextRunAt: NOW, projectedDailyStarts: 1,
      reservations: [{ windowStart: NOW, count: 1 }],
      definition: {
        name: 'Ticket summary', description: '', taskText: 'Summarize the open synthetic tickets.',
        triggerKind: 'schedule', scheduleInput: '0 * * * *',
        scheduleJson: JSON.stringify({ version: 1, kind: 'cron', expression: '0 * * * *' }),
        timezone: 'UTC', outputPolicy: 'post', authorityMode: 'live_channel_v1',
      },
    },
    idempotencyKey: `create:${suffix}`,
  });
  const occurrence = await store.createOccurrence({
    runId: `rrun_${suffix}`, idempotencyKey: `run:${suffix}`, routineId: routine.id, routineVersion: 1,
    scheduledFor: NOW, triggerSource: 'schedule', queuedAt: NOW, deadlineAt: NOW + 60_000,
  });
  const admission = await store.startAdmissionAttempt({
    occurrenceId: occurrence.id, owner: 'heartbeat', invokeStartedAt: NOW, leaseUntil: NOW + 30_000,
  });
  const receipt: DispatchReceipt = { submissionId: 'submission_rmem', acceptedAt: new Date(NOW).toISOString(), uid: 'uid_rmem' };
  const attempt = async (read: AgentInstanceHandle['read']) => executeRoutineOccurrence(
    { env: {}, store, occurrenceId: occurrence.id, attempt: admission.attempt },
    {
      now: () => NOW + 1,
      usageRecordingEnabled: false,
      resolveCredential: async () => null,
      resolveAccess: async (_run: RoutineRun, saved: RoutineDefinition) => ({
        config: { ...config, workspaceId: saved.workspaceId, channelId: saved.channelId },
        accessHash: 'a'.repeat(64), botToken: 'xoxb-rmem', botUserId: BOT_USER, client,
        actorSlackUserId: MEMBER, channelShared: false,
      }),
      resolveModel: async () => ({ model: config.model }),
      codingWorkspaceConfigured: async () => false,
      preparePrompt: (run, saved, access, env) => prepareRoutinePrompt(run, saved, access, env, client, {
        contextStore: { listSlackPublicContext: () => [], listRecentSlackPublicContext: () => [] },
        prepareMemory: (input) => prepareMemoryTurn({
          ...input, dependencies: { state: memory, config: configStore, identity: {} as never },
        }),
      }),
      handle: { id: 'routineagent_rmem', dispatch: async () => receipt, read, abort: async () => {} },
    },
  );
  return { memory, configStore, history, posts, attempt, run: () => store.getRun(occurrence.id) };
}

function result(): AgentReply {
  return {
    submissionId: 'submission_rmem', uid: 'uid_rmem', text: RESULT,
    data: { [ROUTINE_RESULT_DATA_NAME]: [{ outcome: 'succeeded', message: RESULT }] },
  };
}

/** Another run of the same Agent saves its memory. */
async function anotherRunSaves(h: Harness): Promise<void> {
  const live = await h.memory.getAgentMemory(config.agentId);
  await h.memory.putAgentMemory({
    agentId: config.agentId, body: `${live.body}\n\nOpen tickets are counted on weekdays.`, expectedRevision: live.revision,
  });
}

function interrupted(): never {
  throw new DOMException('reader stopped', 'AbortError');
}

async function assertDelivered(h: Harness): Promise<void> {
  const run = await h.run();
  assert.equal(run?.status, 'succeeded', `the result delivers: ${run?.publicError ?? ''}`);
  assert.equal(h.posts.length, 1);
  assert.ok(h.posts[0]!.includes(RESULT), 'with the model\'s own result');
  assert.equal((await h.memory.getAgentMemory(config.agentId)).revision, 2, "the other run's save stands");
}

test('a routine whose memory another run saves while it runs delivers its result', async (t) => {
  const h = await harness(t, 'single');
  assert.equal(await h.attempt(async () => {
    await anotherRunSaves(h);
    return result();
  }), 'completed');
  await assertDelivered(h);
});

test('a routine resumed after another run saved its memory delivers its result', async (t) => {
  const h = await harness(t, 'resumed');
  assert.equal(await h.attempt(async () => interrupted()), 'resumable');
  await anotherRunSaves(h);
  assert.equal(await h.attempt(async () => result()), 'completed');
  await assertDelivered(h);
});

test('a routine resumed after its first memory was saved delivers its result', async (t) => {
  const h = await harness(t, 'first-memory');
  const live = await h.memory.getAgentMemory(config.agentId);
  await h.memory.putAgentMemory({ agentId: config.agentId, body: '', expectedRevision: live.revision });
  assert.equal(await h.attempt(async () => interrupted()), 'resumable');
  await anotherRunSaves(h);
  assert.equal(await h.attempt(async () => result()), 'completed');
  const run = await h.run();
  assert.equal(run?.status, 'succeeded', `the result delivers: ${run?.publicError ?? ''}`);
  assert.ok(h.posts[0]?.includes(RESULT));
});

test('a routine resumed after its Channel history changed still fails: only memory may differ', async (t) => {
  const h = await harness(t, 'history');
  assert.equal(await h.attempt(async () => interrupted()), 'resumable');
  h.history.push({ ts: '1794446000.000100', user: MEMBER, text: 'A synthetic note posted between attempts.' });
  assert.equal(await h.attempt(async () => result()), 'completed');
  const run = await h.run();
  assert.equal(run?.status, 'failed');
  assert.equal(run?.publicError, 'Channel access changed while the routine was running.');
  assert.equal(h.posts.some((post) => post.includes(RESULT)), false, 'the result never posts');
});

test('a routine whose Channel grant stops being active while it runs still fails closed', async (t) => {
  const h = await harness(t, 'revoked');
  assert.equal(await h.attempt(async () => {
    await h.configStore.putAgentChannelGrant({
      workspaceId: WORKSPACE, channelId: CHANNEL, agentId: config.agentId, status: 'needs_attention',
      createdByMembershipId: 'membership_rmem', channelLabel: 'ops', channelIsPrivate: false,
    });
    return result();
  }), 'completed');
  const run = await h.run();
  assert.equal(run?.status, 'failed');
  assert.equal(h.posts.some((post) => post.includes(RESULT)), false, 'the result never posts');
});
