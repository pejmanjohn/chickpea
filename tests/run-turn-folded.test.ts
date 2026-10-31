import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { compileRuntimePlanV2, deriveRuntimePlanInstanceId } from '../src/agents/runtime-plan.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { currentRequestEnvelopeText } from '../src/memory/tool-policy.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import type { FoldedMessage } from '../src/slack/follow-ups.ts';
import { SlackRunPresentationStoreLogic } from '../src/slack/run-presentations.ts';
import { runTurn, type RunTurnOptions } from '../src/slack/run-turn.ts';
import { SlackStatusRegistry } from '../src/slack/status-registry.ts';
import type { TurnFoldRequest } from '../src/slack/turn-job-types.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { prepareSlackShadowAdmission } from '../src/slack/work-admission.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { SqliteWorkStore } from '../src/work/store.ts';

/**
 * A turn that took the person's queued follow-ups (steering A) reads them as
 * one request: one prompt frames every message in order, the Slack context
 * reaches the newest of them and shows none of them twice, and the first
 * status says how many it is reading.
 */

const assignment: ResolvedAssignment = {
  workspaceId: 'T_FOLDED',
  channelId: 'D_FOLDED',
  agentId: 'agent_folded',
  model: 'local-stub/folded',
  modelAttribution: { source: 'pinned', providerId: 'local-stub' },
  agent: {
    id: 'agent_folded', kind: 'user', revision: 1, name: 'Folded Agent', instructions: 'Answer directly.',
    enabled: true, skills: [], mcpServers: [], apiConnections: [], repositories: [],
  },
};

const stateDirectory = mkdtempSync(join(tmpdir(), 'chickpea-folded-'));
const statePath = join(stateDirectory, 'state.sqlite');
let previousStatePath: string | undefined;

before(async () => {
  previousStatePath = process.env.SLACK_STATE_DB_PATH;
  process.env.SLACK_STATE_DB_PATH = statePath;
  const config = new SqliteConfigStore(statePath, agentRoutineDeletion, { agents: [] });
  await config.createAgent(assignment.agent);
  const installation = await config.ensureWorkspaceInstallation({
    workspaceId: assignment.workspaceId,
    transportMode: 'direct',
    defaultAgentId: assignment.agentId,
    teamId: assignment.workspaceId,
    botUserId: 'U_CHICKPEA',
  });
  await config.updateWorkspaceInstallation(assignment.workspaceId, { health: 'healthy' }, installation.revision);
  config.close();
});

after(() => {
  if (previousStatePath === undefined) delete process.env.SLACK_STATE_DB_PATH;
  else process.env.SLACK_STATE_DB_PATH = previousStatePath;
  rmSync(stateDirectory, { recursive: true, force: true });
});

const ROOT_TS = '1790200000.000100';
const HEAD_TS = '1790200010.000100';
const SECOND_TS = '1790200020.000100';
const THIRD_TS = '1790200030.000100';
const LATER_TS = '1790200040.000100';

function threadTurn(): NormalizedSlackTurn {
  return {
    workspaceId: assignment.workspaceId,
    channelId: 'D_FOLDED',
    channelType: 'im',
    eventId: `Ev_FOLDED_${HEAD_TS}`,
    text: 'Draft the launch email.',
    userId: 'U_REQUESTER',
    messageTs: HEAD_TS,
    threadTs: ROOT_TS,
    source: 'dm_message',
    contextMode: 'thread',
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };
}

const FOLLOW_UPS: FoldedMessage[] = [
  { turnJobId: 'second', userId: 'U_REQUESTER', messageTs: SECOND_TS, text: 'Keep it under 100 words.' },
  { turnJobId: 'third', userId: 'U_REQUESTER', messageTs: THIRD_TS, text: 'Actually, address it to the beta list.' },
];

/** The thread as Slack holds it, newest message after the follow-ups included. */
const THREAD_ROWS = [
  { ts: ROOT_TS, user: 'U_LEAD', text: 'Launch is Thursday.', thread_ts: ROOT_TS },
  { ts: HEAD_TS, user: 'U_REQUESTER', text: 'Draft the launch email.', thread_ts: ROOT_TS },
  { ts: SECOND_TS, user: 'U_REQUESTER', text: 'Keep it under 100 words.', thread_ts: ROOT_TS },
  { ts: THIRD_TS, user: 'U_REQUESTER', text: 'Actually, address it to the beta list.', thread_ts: ROOT_TS },
  { ts: LATER_TS, user: 'U_LEAD', text: 'Posted after the request.', thread_ts: ROOT_TS },
];

async function harness(turn: NormalizedSlackTurn) {
  const work = new SqliteWorkStore(':memory:');
  const admitted = await work.admitShadowRun(prepareSlackShadowAdmission({
    turn, assignment, sourceVisibility: 'private', admittedAt: Date.now(),
  }));
  const runId = admitted.run.id;
  const db = openStateDb(':memory:');
  const store = new SlackRunPresentationStoreLogic(db);
  const sessionGeneration = Number(turn.messageTs.replace('.', ''));
  store.create({
    schemaVersion: 3,
    runId,
    turnJobId: `turn_${runId}`,
    bindingId: `binding_${runId}`,
    workBindingGeneration: 1,
    runFencingToken: 0,
    owner: { kind: 'selected_agent', persona: {
      name: 'Folded Agent', avatarUrl: 'https://chickpea.example/assets/agents/folded/avatar/1', avatarRevision: 1,
    } },
    sessionGeneration,
    currentActivity: {
      kind: 'preparing', action: 'Preparing', object: 'your request', generation: sessionGeneration, sequence: 1,
      operation: { operationId: `activity_${runId}_1`, certainty: 'pending' },
    },
    root: {
      workspaceId: turn.workspaceId, channelId: turn.channelId, threadTs: turn.threadTs, requesterUserId: turn.userId,
    },
  });
  const statuses: string[] = [];
  const reads: Array<Record<string, unknown>> = [];
  const client = {
    apiCall: async () => ({ ok: true }),
    assistant: { threads: {
      setStatus: async (input: Record<string, unknown>) => {
        statuses.push(String(input.status ?? ''));
        return { ok: true };
      },
      setTitle: async () => ({ ok: true }),
    } },
    users: { info: async () => ({ ok: true, user: { id: 'U_REQUESTER', profile: {} } }) },
    conversations: {
      replies: async (input: Record<string, unknown>) => {
        reads.push(input);
        return { ok: true, messages: THREAD_ROWS };
      },
      history: async () => ({ ok: true, messages: [] }),
    },
    chat: {
      startStream: async () => ({ ok: true, ts: '1790200050.000500' }),
      appendStream: async () => ({ ok: true }),
      stopStream: async () => ({ ok: true }),
      postMessage: async () => ({ ok: true, ts: '1790200050.000600' }),
      update: async () => ({ ok: true }),
      delete: async () => ({ ok: true }),
    },
  } as unknown as WebClient;
  const state = {
    getRunPresentation: (id: string) => store.get(id),
    getLatestThreadSessionGeneration: (root: Parameters<typeof store.getLatestThreadSessionGeneration>[0]) =>
      store.getLatestThreadSessionGeneration(root),
    transitionRunPresentation: (input: Parameters<typeof store.transition>[0]) => store.transition(input),
    reserveSlackAppend: (workspaceId: string) => store.reserveAppend(workspaceId),
    applySlackAppendCooldown: (workspaceId: string, retryAfterMs: number) =>
      store.applyAppendCooldown(workspaceId, retryAfterMs),
    matchFlueObservation: () => undefined,
  };
  const close = () => { db.close(); work.close(); };
  return { runId, statuses, reads, client, state, work, close };
}

type Harness = Awaited<ReturnType<typeof harness>>;

async function promptOf(h: Harness, options: Partial<RunTurnOptions> = {}): Promise<string[]> {
  const prompts: string[] = [];
  await runTurn(threadTurn(), assignment, undefined, {
    client: h.client,
    runId: h.runId,
    turnId: 'head',
    presentationState: h.state,
    statusRegistry: new SlackStatusRegistry(),
    workStore: h.work,
    usageRecordingEnabled: false,
    agentPrompt: async ({ message }) => {
      prompts.push(message);
      return {
        text: 'Here is the draft.', requestedModel: assignment.model ?? null, returnedModel: null,
        reportedUsage: null, usageCompleteness: 'not_reported',
      };
    },
    ...options,
  });
  return prompts;
}

function folding(
  claims: TurnFoldRequest[],
  messages: FoldedMessage[] = FOLLOW_UPS,
): NonNullable<RunTurnOptions['claimFold']> {
  return async (request) => {
    claims.push(request);
    return { messages, requesterText: '' };
  };
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

test('the prompt frames the trigger and its follow-ups in order, as one request, each once', async () => {
  const h = await harness(threadTurn());
  try {
    const claims: TurnFoldRequest[] = [];
    const [prompt] = await promptOf(h, { claimFold: folding(claims) });
    assert.deepEqual(claims, [{ phase: 'start', headId: 'head' }]);
    assert.ok(prompt);
    assert.match(prompt, /Current Slack request, sent as 3 messages by <@U_REQUESTER> \(together they are the only current user intent/);
    assert.doesNotMatch(prompt, /this is the only current user intent; answer this/);
    const request = prompt.slice(prompt.indexOf('Current Slack request, sent as 3 messages'));
    const order = ['Draft the launch email.', 'Keep it under 100 words.', 'Actually, address it to the beta list.']
      .map((text) => request.indexOf(text));
    assert.ok(order.every((index) => index > 0), 'every message is in the request block');
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'oldest first');
    for (const text of ['Draft the launch email.', 'Keep it under 100 words.', 'Actually, address it to the beta list.']) {
      assert.equal(occurrences(prompt, text), 1, `${text} appears once, in the request`);
    }
    assert.equal(occurrences(prompt, 'Launch is Thursday.'), 1, 'older context stays');
    assert.ok(currentRequestEnvelopeText(prompt), 'tool policy still finds the current-request envelope');
  } finally {
    h.close();
  }
});

const TEAMMATE_FOLLOW_UPS: FoldedMessage[] = [
  FOLLOW_UPS[0]!,
  // The store took it before the head's plan froze: information only, until the plan says otherwise.
  { turnJobId: 'third', userId: 'U_LEAD', messageTs: THIRD_TS, text: 'Actually, address it to the beta list.', informationOnly: true },
];

/** A frozen plan for the head; `personal` grants the requester's own CRM account. */
function frozenPlan(personal: boolean): NonNullable<RunTurnOptions['runtimePlanDecision']> {
  const runtimePlan = compileRuntimePlanV2({
    turn: threadTurn(), assignment, instructions: 'Answer directly.', memoryEpoch: 1,
    ...(personal
      ? {
          effectiveConnections: [{
            account: {
              id: 'crm_mine', workspaceId: assignment.workspaceId, revision: 1, ownerKind: 'member',
              ownerMembershipId: 'mem_requester', createdByMembershipId: 'mem_requester', providerId: 'crm',
              label: 'CRM', secretRefId: 'secret_crm', lifecycle: 'ready', createdAt: 1, updatedAt: 1,
              policy: {
                kind: 'api', allowedHosts: ['api.example.com'], pathPrefixes: ['/v1'], headerName: 'authorization',
                headerValuePrefix: 'Bearer ', allowedMethods: ['GET'], authMode: 'credential',
              },
            },
            binding: {
              agentId: assignment.agentId, connectionAccountId: 'crm_mine', providerId: 'crm',
              allowedCapabilities: ['GET'], enabled: true, createdAt: 1, updatedAt: 1,
            },
            policy: {
              kind: 'api', allowedHosts: ['api.example.com'], pathPrefixes: ['/v1'], headerName: 'authorization',
              headerValuePrefix: 'Bearer ', allowedMethods: ['GET'], authMode: 'credential',
            },
            scope: 'personal',
          }],
        }
      : {}),
  });
  return { runtimePlan, instanceId: deriveRuntimePlanInstanceId(runtimePlan) };
}

test('a teammate\'s follow-up joins the request when the run uses only the Agent\'s shared connections', async () => {
  const h = await harness(threadTurn());
  try {
    const [prompt] = await promptOf(h, {
      claimFold: folding([], TEAMMATE_FOLLOW_UPS), runtimePlanDecision: frozenPlan(false),
    });
    assert.match(prompt!, /Current Slack request, sent as 3 messages by <@U_REQUESTER> and <@U_LEAD> \(together/);
    assert.match(prompt!, /role=human\] U_LEAD: Actually, address it to the beta list\./);
    assert.doesNotMatch(prompt!, /for information only/);
  } finally {
    h.close();
  }
});

test('in a run with the requester\'s own connections a teammate\'s follow-up is information only', async () => {
  const h = await harness(threadTurn());
  try {
    const [prompt] = await promptOf(h, {
      claimFold: folding([], TEAMMATE_FOLLOW_UPS), runtimePlanDecision: frozenPlan(true),
    });
    assert.match(prompt!, /Current Slack request, sent as 2 messages by <@U_REQUESTER> \(together/);
    const section = prompt!.slice(prompt!.indexOf('Sent by teammates while you work with <@U_REQUESTER>\'s own connections'));
    assert.match(section, /^[^\n]*for information only[^\n]*\n- \[[^\]]*role=human\] U_LEAD: Actually, address it to the beta list\./);
    assert.equal(occurrences(prompt!, 'Actually, address it to the beta list.'), 1);
  } finally {
    h.close();
  }
});

test('the context reaches the newest follow-up and nothing after it', async () => {
  const h = await harness(threadTurn());
  try {
    const [prompt] = await promptOf(h, { claimFold: folding([]) });
    assert.ok(h.reads.length > 0);
    for (const read of h.reads) assert.equal(read.latest, THIRD_TS);
    assert.doesNotMatch(prompt!, /Posted after the request\./);
  } finally {
    h.close();
  }
});

test('the first status says how many messages the turn is reading', async () => {
  const h = await harness(threadTurn());
  try {
    await promptOf(h, { claimFold: folding([]) });
    assert.ok(h.statuses.includes('Reading 3 messages…'), JSON.stringify(h.statuses));
  } finally {
    h.close();
  }
  const single = await harness(threadTurn());
  try {
    await promptOf(single, { claimFold: folding([], []) });
    assert.equal(single.statuses.some((status) => status.startsWith('Reading')), false);
  } finally {
    single.close();
  }
});

test('a declined claim leaves the single-message prompt exactly as it was', async () => {
  const plain = await harness(threadTurn());
  const declined = await harness(threadTurn());
  try {
    const [without] = await promptOf(plain);
    const [empty] = await promptOf(declined, { claimFold: folding([], []) });
    assert.equal(empty, without);
    assert.match(without!, /Current Slack request \(this is the only current user intent; answer this/);
    for (const read of plain.reads) assert.equal(read.latest, HEAD_TS);
  } finally {
    plain.close();
    declined.close();
  }
});

test('the turn_latency record counts the follow-ups, content-free', async () => {
  const h = await harness(threadTurn());
  const info = console.info;
  const records: Array<Record<string, unknown>> = [];
  console.info = (record: unknown) => {
    if (record && typeof record === 'object') records.push(record as Record<string, unknown>);
  };
  try {
    await promptOf(h, { claimFold: folding([]), turnLatency: { lane: 'cloudflare', executor: 'runner' } });
  } finally {
    console.info = info;
    h.close();
  }
  const latency = records.filter((record) => record.event === 'turn_latency');
  assert.equal(latency.length, 1);
  assert.equal(latency[0]?.folded, 2);
});

test('a replay never claims follow-ups', async () => {
  const h = await harness(threadTurn());
  try {
    const claims: TurnFoldRequest[] = [];
    await promptOf(h, { claimFold: folding(claims), replayText: 'Recorded answer.' });
    assert.deepEqual(claims, []);
  } finally {
    h.close();
  }
});
