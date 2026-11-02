import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { deriveRuntimePlanInstanceId } from '../src/agents/runtime-plan.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import type { AgentDispatchResult, promptSlackThreadAgent } from '../src/slack/flue-dispatch.ts';
import { SlackRunPresentationStoreLogic } from '../src/slack/run-presentations.ts';
import { runTurn } from '../src/slack/run-turn.ts';
import { SlackTransportError } from '../src/slack/transport/types.ts';
import { AGENT_FAILURE_TEXT } from '../src/slack/web-client-presenter.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { prepareSlackShadowAdmission } from '../src/slack/work-admission.ts';
import { SqliteWorkStore } from '../src/work/store.ts';

/**
 * Amber run #6: a burst of side threads exhausted the shared gateway's
 * per-binding rate limit while a long turn's answer was ready. The delivery
 * lease check (conversations.info, users.info, conversations.members) was
 * rate limited and read as "lease invalid", so the turn delivered the generic
 * failure notice instead of its answer. A rate limit is not a lease decision:
 * the attempt must throw so the next attempt delivers the answer.
 */

const assignment: ResolvedAssignment = {
  workspaceId: 'T_LEASE_LIMIT',
  channelId: 'C_LEASE_LIMIT',
  agentId: 'agent_lease_limit',
  model: 'local-stub/lease-limit',
  modelAttribution: { source: 'pinned', providerId: 'local-stub' },
  agent: {
    id: 'agent_lease_limit',
    kind: 'user',
    revision: 1,
    name: 'Lease Limit',
    instructions: 'Answer directly.',
    enabled: true,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  },
};

const stateDirectory = mkdtempSync(join(tmpdir(), 'chickpea-lease-limit-'));
const statePath = join(stateDirectory, 'state.sqlite');
let previousStatePath: string | undefined;

before(async () => {
  previousStatePath = process.env.SLACK_STATE_DB_PATH;
  process.env.SLACK_STATE_DB_PATH = statePath;
  const store = new SqliteConfigStore(statePath, agentRoutineDeletion, { agents: [] });
  await store.createAgent(assignment.agent);
  const installation = await store.ensureWorkspaceInstallation({
    workspaceId: assignment.workspaceId,
    transportMode: 'direct',
    defaultAgentId: assignment.agentId,
    teamId: assignment.workspaceId,
    botUserId: 'U_CHICKPEA',
  });
  await store.updateWorkspaceInstallation(assignment.workspaceId, { health: 'healthy' }, installation.revision);
  await store.putAgentChannelGrant({
    workspaceId: assignment.workspaceId, channelId: assignment.channelId, agentId: assignment.agentId,
    status: 'active', createdByMembershipId: 'membership_owner',
    channelLabel: 'lease-limit', channelIsPrivate: false,
  });
  store.close();
});

after(() => {
  if (previousStatePath === undefined) delete process.env.SLACK_STATE_DB_PATH;
  else process.env.SLACK_STATE_DB_PATH = previousStatePath;
  rmSync(stateDirectory, { recursive: true, force: true });
});

function leaseTurn(eventId: string, messageTs: string): NormalizedSlackTurn {
  return {
    workspaceId: assignment.workspaceId,
    channelId: assignment.channelId,
    channelType: 'channel',
    eventId,
    text: 'Summarize the release notes.',
    userId: 'U_LEASE_LIMIT',
    messageTs,
    threadTs: messageTs,
    source: 'app_mention',
    contextMode: 'thread',
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };
}

function presentationFor(store: SlackRunPresentationStoreLogic, runId: string, turn: NormalizedSlackTurn) {
  const sessionGeneration = Number(turn.messageTs.replace('.', ''));
  store.create({
    schemaVersion: 3,
    runId,
    turnJobId: `turn_${runId}`,
    bindingId: `binding_${runId}`,
    workBindingGeneration: 1,
    runFencingToken: 0,
    owner: { kind: 'selected_agent', persona: {
      name: 'Lease Limit',
      avatarUrl: 'https://chickpea.example/assets/agents/lease/avatar/1',
      avatarRevision: 1,
    } },
    sessionGeneration,
    currentActivity: {
      kind: 'preparing', action: 'Preparing', object: 'your request', generation: sessionGeneration,
      sequence: 1, operation: { operationId: `activity_${runId}_1`, certainty: 'pending' },
    },
    root: {
      workspaceId: turn.workspaceId, channelId: turn.channelId, threadTs: turn.threadTs,
      requesterUserId: turn.userId,
    },
  });
  return {
    getRunPresentation: (id: string) => store.get(id),
    getLatestThreadSessionGeneration: (root: Parameters<typeof store.getLatestThreadSessionGeneration>[0]) =>
      store.getLatestThreadSessionGeneration(root),
    transitionRunPresentation: (input: Parameters<typeof store.transition>[0]) => store.transition(input),
    reserveSlackAppend: (workspaceId: string) => store.reserveAppend(workspaceId),
    applySlackAppendCooldown: (workspaceId: string, retryAfterMs: number) =>
      store.applyAppendCooldown(workspaceId, retryAfterMs),
    matchFlueObservation: () => undefined,
  };
}

const ANSWER: AgentDispatchResult = {
  text: 'The release notes cover three fixes.',
  requestedModel: assignment.model ?? null,
  returnedModel: null,
  reportedUsage: null,
  usageCompleteness: 'not_reported',
};

/**
 * The reply as promptSlackThreadAgent ends it: settlement observed, then its
 * record (here, waiting up to 500 ms for `recorded`) before it returns.
 */
async function settledAnswer(
  input: Parameters<typeof promptSlackThreadAgent>[0],
  recorded: () => boolean = () => true,
  timeline?: string[],
): Promise<AgentDispatchResult> {
  input.onSettlementObserved?.(ANSWER);
  const deadline = Date.now() + 500;
  while (!recorded() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  timeline?.push('agent:returned');
  return ANSWER;
}

test('a rate-limited delivery lease check retries the attempt, and the retry delivers the answer', async () => {
  const messageTs = '1790000200.000100';
  const turn = leaseTurn('Ev_LEASE_LIMIT', messageTs);
  const work = new SqliteWorkStore(':memory:');
  const admitted = await work.admitShadowRun(prepareSlackShadowAdmission({
    turn, assignment, sourceVisibility: 'public', admittedAt: Date.now(),
  }));
  const runId = admitted.run.id;
  const db = openStateDb(':memory:');
  const store = new SlackRunPresentationStoreLogic(db);
  const state = presentationFor(store, runId, turn);
  const finals: string[] = [];
  let leaseChecks = 0;
  let rateLimitLeaseCheck: number | undefined = 2; // the post-answer check, started at settlement observed
  const client = {
    apiCall: async () => ({ ok: true }),
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    auth: { test: async () => ({ ok: true, user_id: 'U_CHICKPEA' }) },
    users: { info: async () => ({ ok: true, user: { id: turn.userId, team_id: turn.workspaceId } }) },
    conversations: {
      info: async () => {
        leaseChecks += 1;
        if (leaseChecks === rateLimitLeaseCheck) {
          throw new SlackTransportError('conversations.info', 'gateway_rate_limited', {
            retryable: true, effectOutcome: 'failed',
          });
        }
        return { ok: true, channel: { id: turn.channelId, context_team_id: turn.workspaceId, is_member: true } };
      },
      members: async () => ({ ok: true, members: [turn.userId, 'U_CHICKPEA'] }),
      replies: async () => ({ ok: true, messages: [] }),
      history: async () => ({ ok: true, messages: [] }),
    },
    chat: {
      startStream: async (input: { chunks?: Array<{ text?: string }> }) => {
        finals.push(input.chunks?.map((chunk) => chunk.text ?? '').join('') ?? '');
        return { ok: true, ts: '1790000200.000200' };
      },
      appendStream: async () => ({ ok: true }),
      stopStream: async () => ({ ok: true }),
      postMessage: async (input: { text?: string }) => {
        finals.push(input.text ?? '');
        return { ok: true, ts: '1790000200.000200' };
      },
    },
  } as unknown as WebClient;
  const attempt = () => runTurn(turn, assignment, undefined, {
    client,
    runId,
    turnId: `turn_${runId}`,
    presentationState: state,
    workStore: work,
    usageRecordingEnabled: false,
    agentPrompt: async (input) => settledAnswer(input),
  });
  try {
    await assert.rejects(
      attempt(),
      (error: unknown) => error instanceof SlackTransportError && error.code === 'gateway_rate_limited',
    );
    assert.deepEqual(finals, [], 'no failure notice is delivered for a rate-limited lease check');
    const afterFirst = store.get(runId);
    assert.equal(afterFirst?.schemaVersion, 3);
    if (afterFirst?.schemaVersion === 3) {
      assert.equal(afterFirst.terminalDelivery.state, 'none', 'no failure terminal is frozen');
    }

    rateLimitLeaseCheck = undefined;
    await attempt();
    assert.equal(finals.length, 1);
    assert.match(finals[0]!, /three fixes/);
    const delivered = store.get(runId);
    if (delivered?.schemaVersion === 3 && delivered.terminalDelivery.state === 'intended') {
      assert.equal(delivered.terminalDelivery.result, 'answer');
      assert.equal(delivered.terminalDelivery.operation.certainty, 'acknowledged');
    } else {
      assert.fail('the retried attempt did not deliver its answer');
    }
  } finally {
    db.close();
    work.close();
  }
});

// Defects caught (with the admitted status held): the context read waiting
// for the opening status writes, and the title, a presentation transition,
// landing before the lease fence decided or while the admitted status's own
// transitions are still in flight. After the run: the delivery lease's reads
// waiting for the reply's settlement record instead of starting beside it.
test('the context read runs while the owner lease is checked and the admitted status is written; the title waits for both', async () => {
  const messageTs = '1790000300.000100';
  const turn = leaseTurn('Ev_LEASE_OVERLAP', messageTs);
  const work = new SqliteWorkStore(':memory:');
  const admitted = await work.admitShadowRun(prepareSlackShadowAdmission({
    turn, assignment, sourceVisibility: 'public', admittedAt: Date.now(),
  }));
  const runId = admitted.run.id;
  const db = openStateDb(':memory:');
  const store = new SlackRunPresentationStoreLogic(db);
  const state = presentationFor(store, runId, turn);
  const timeline: string[] = [];
  const finals: string[] = [];
  const seen = <T>(method: string, result: T) => async () => {
    timeline.push(method);
    return result;
  };
  let membersChecks = 0;
  let statusWrites = 0;
  const client = {
    apiCall: async () => ({ ok: true }),
    assistant: { threads: {
      setStatus: async () => {
        statusWrites += 1;
        if (statusWrites === 1) {
          const deadline = Date.now() + 500;
          while (!timeline.includes('conversations.replies') && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          timeline.push('status:admitted_acknowledged');
        }
        return { ok: true };
      },
      setTitle: seen('assistant.threads.setTitle', { ok: true }),
    } },
    auth: { test: async () => ({ ok: true, user_id: 'U_CHICKPEA' }) },
    users: { info: async () => ({ ok: true, user: { id: turn.userId, team_id: turn.workspaceId } }) },
    conversations: {
      info: async () => ({ ok: true, channel: { id: turn.channelId, context_team_id: turn.workspaceId, is_member: true } }),
      members: async () => {
        membersChecks += 1;
        if (membersChecks === 1) {
          const deadline = Date.now() + 500;
          while (!timeline.includes('conversations.replies') && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          timeline.push('lease:members_answered');
        }
        if (membersChecks === 2) timeline.push('lease:after_run_read');
        return { ok: true, members: [turn.userId, 'U_CHICKPEA'] };
      },
      replies: seen('conversations.replies', { ok: true, messages: [] }),
      history: seen('conversations.history', { ok: true, messages: [] }),
    },
    chat: {
      startStream: async (input: { chunks?: Array<{ text?: string }> }) => {
        finals.push(input.chunks?.map((chunk) => chunk.text ?? '').join('') ?? '');
        return { ok: true, ts: '1790000300.000200' };
      },
      appendStream: async () => ({ ok: true }),
      stopStream: async () => ({ ok: true }),
      postMessage: async (input: { text?: string }) => {
        finals.push(input.text ?? '');
        return { ok: true, ts: '1790000300.000200' };
      },
    },
  } as unknown as WebClient;
  try {
    await runTurn(turn, assignment, undefined, {
      client,
      runId,
      turnId: `turn_${runId}`,
      presentationState: state,
      workStore: work,
      usageRecordingEnabled: false,
      agentPrompt: async (input) =>
        settledAnswer(input, () => timeline.includes('lease:after_run_read'), timeline),
    });
    const read = timeline.indexOf('conversations.replies');
    const leaseAnswered = timeline.indexOf('lease:members_answered');
    const statusShown = timeline.indexOf('status:admitted_acknowledged');
    const titled = timeline.indexOf('assistant.threads.setTitle');
    assert.ok(read >= 0 && leaseAnswered >= 0 && statusShown >= 0 && titled >= 0,
      `read, lease, status and title all happen: ${timeline.join(' ')}`);
    assert.ok(read < leaseAnswered, `the context read does not wait for the lease: ${timeline.join(' ')}`);
    assert.ok(read < statusShown, `the context read does not wait for the admitted status: ${timeline.join(' ')}`);
    assert.ok(titled > leaseAnswered, `the title waits for the lease: ${timeline.join(' ')}`);
    assert.ok(titled > statusShown, `the title waits for the admitted status: ${timeline.join(' ')}`);
    assert.ok(timeline.indexOf('lease:after_run_read') < timeline.indexOf('agent:returned'),
      `the delivery lease reads start at settlement observed: ${timeline.join(' ')}`);
    assert.equal(finals.length, 1);
    assert.match(finals[0]!, /three fixes/);
  } finally {
    db.close();
    work.close();
  }
});

// Defects caught: the thread's context read waiting for the plan's freeze
// (it started only once the turn's preparation ended), and a lease refused
// before the run that no longer withholds the turn once that read began
// first: no dispatch, no title, and the failure notice its only final.
test("the thread's context read starts beside the plan's freeze, before the lease check; a refused lease still withholds the turn", async () => {
  const messageTs = '1790000500.000100';
  const turn = leaseTurn('Ev_LEASE_EARLY_READ', messageTs);
  const work = new SqliteWorkStore(':memory:');
  const admitted = await work.admitShadowRun(prepareSlackShadowAdmission({
    turn, assignment, sourceVisibility: 'public', admittedAt: Date.now(),
  }));
  const runId = admitted.run.id;
  const db = openStateDb(':memory:');
  const store = new SlackRunPresentationStoreLogic(db);
  const state = presentationFor(store, runId, turn);
  const timeline: string[] = [];
  const written: string[] = [];
  const seen = <T>(method: string, result: T) => async () => {
    timeline.push(method);
    return result;
  };
  const client = {
    apiCall: async () => ({ ok: true }),
    assistant: { threads: {
      setStatus: async () => ({ ok: true }),
      setTitle: seen('assistant.threads.setTitle', { ok: true }),
    } },
    auth: { test: async () => ({ ok: true, user_id: 'U_CHICKPEA' }) },
    users: { info: async () => ({ ok: true, user: { id: turn.userId, team_id: turn.workspaceId } }) },
    conversations: {
      info: async () => ({ ok: true, channel: { id: turn.channelId, context_team_id: turn.workspaceId, is_member: true } }),
      // The person left the Channel: the owner lease is refused.
      members: seen('lease:members', { ok: true, members: ['U_CHICKPEA'] }),
      replies: seen('conversations.replies', { ok: true, messages: [] }),
      history: seen('conversations.history', { ok: true, messages: [] }),
    },
    chat: {
      startStream: async (input: { chunks?: Array<{ text?: string }> }) => {
        written.push(input.chunks?.map((chunk) => chunk.text ?? '').join('') ?? '');
        return { ok: true, ts: '1790000500.000200' };
      },
      appendStream: async () => ({ ok: true }),
      stopStream: async () => ({ ok: true }),
      postMessage: async (input: { text?: string }) => {
        written.push(input.text ?? '');
        return { ok: true, ts: '1790000500.000200' };
      },
    },
  } as unknown as WebClient;
  try {
    await runTurn(turn, assignment, undefined, {
      client,
      runId,
      turnId: `turn_${runId}`,
      presentationState: state,
      workStore: work,
      usageRecordingEnabled: false,
      // The freeze is held until the thread's read has begun (or half a second).
      onRuntimePlan: async (candidate) => {
        const deadline = Date.now() + 500;
        while (!timeline.includes('conversations.replies') && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        timeline.push('plan:frozen');
        return { runtimePlan: candidate, instanceId: deriveRuntimePlanInstanceId(candidate) };
      },
      agentPrompt: async (input) => {
        timeline.push('agent');
        return settledAnswer(input);
      },
    });
    const read = timeline.indexOf('conversations.replies');
    assert.ok(read >= 0, `the thread was read: ${timeline.join(' ')}`);
    assert.ok(read < timeline.indexOf('plan:frozen'), `the read does not wait for the plan: ${timeline.join(' ')}`);
    assert.ok(read < timeline.indexOf('lease:members'), `the read starts before the lease check: ${timeline.join(' ')}`);
    assert.equal(timeline.includes('agent'), false, 'a refused lease dispatches nothing');
    assert.equal(timeline.includes('assistant.threads.setTitle'), false, 'and titles nothing');
    assert.deepEqual(written, [AGENT_FAILURE_TEXT], 'its only final is the failure notice');
  } finally {
    db.close();
    work.close();
  }
});

// Defects caught: a refusal from the check started at settlement observed
// that no longer withholds the answer, and a second, later check in its
// place (three membership reads instead of two).
test('a delivery lease refused at settlement observed withholds the answer: the only final is the failure notice', async () => {
  const messageTs = '1790000400.000100';
  const turn = leaseTurn('Ev_LEASE_REFUSED', messageTs);
  const work = new SqliteWorkStore(':memory:');
  const admitted = await work.admitShadowRun(prepareSlackShadowAdmission({
    turn, assignment, sourceVisibility: 'public', admittedAt: Date.now(),
  }));
  const runId = admitted.run.id;
  const db = openStateDb(':memory:');
  const store = new SlackRunPresentationStoreLogic(db);
  const state = presentationFor(store, runId, turn);
  const timeline: string[] = [];
  const written: string[] = [];
  let membersChecks = 0;
  const client = {
    apiCall: async () => ({ ok: true }),
    assistant: { threads: { setStatus: async () => ({ ok: true }), setTitle: async () => ({ ok: true }) } },
    auth: { test: async () => ({ ok: true, user_id: 'U_CHICKPEA' }) },
    users: { info: async () => ({ ok: true, user: { id: turn.userId, team_id: turn.workspaceId } }) },
    conversations: {
      info: async () => ({ ok: true, channel: { id: turn.channelId, context_team_id: turn.workspaceId, is_member: true } }),
      members: async () => {
        membersChecks += 1;
        if (membersChecks === 1) return { ok: true, members: [turn.userId, 'U_CHICKPEA'] };
        timeline.push('lease:after_run_read');
        return { ok: true, members: ['U_CHICKPEA'] };
      },
      replies: async () => ({ ok: true, messages: [] }),
      history: async () => ({ ok: true, messages: [] }),
    },
    chat: {
      startStream: async (input: { chunks?: Array<{ text?: string }> }) => {
        written.push(input.chunks?.map((chunk) => chunk.text ?? '').join('') ?? '');
        return { ok: true, ts: '1790000400.000200' };
      },
      appendStream: async (input: { chunks?: Array<{ text?: string }> }) => {
        written.push(input.chunks?.map((chunk) => chunk.text ?? '').join('') ?? '');
        return { ok: true };
      },
      stopStream: async () => ({ ok: true }),
      postMessage: async (input: { text?: string }) => {
        written.push(input.text ?? '');
        return { ok: true, ts: '1790000400.000200' };
      },
    },
  } as unknown as WebClient;
  try {
    await runTurn(turn, assignment, undefined, {
      client,
      runId,
      turnId: `turn_${runId}`,
      presentationState: state,
      workStore: work,
      usageRecordingEnabled: false,
      agentPrompt: async (input) =>
        settledAnswer(input, () => timeline.includes('lease:after_run_read'), timeline),
    });
    assert.deepEqual(timeline, ['lease:after_run_read', 'agent:returned'],
      'the refusing read started at settlement observed');
    assert.equal(membersChecks, 2, 'one check before the run and the one started at settlement observed');
    assert.equal(written.length, 1);
    assert.ok(written[0]!.includes(AGENT_FAILURE_TEXT), `the final is the failure notice: ${written[0]}`);
    assert.doesNotMatch(written[0]!, /three fixes/, 'the answer is never written');
  } finally {
    db.close();
    work.close();
  }
});
