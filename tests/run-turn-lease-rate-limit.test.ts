import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { SqliteConfigStore } from '../src/config/store.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { SlackRunPresentationStoreLogic } from '../src/slack/run-presentations.ts';
import { runTurn } from '../src/slack/run-turn.ts';
import { SlackTransportError } from '../src/slack/transport/types.ts';
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
  const store = new SqliteConfigStore(statePath, { agents: [] });
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

test('a rate-limited delivery lease check retries the attempt, and the retry delivers the answer', async () => {
  const messageTs = '1790000200.000100';
  const turn: NormalizedSlackTurn = {
    workspaceId: assignment.workspaceId,
    channelId: assignment.channelId,
    channelType: 'channel',
    eventId: 'Ev_LEASE_LIMIT',
    text: 'Summarize the release notes.',
    userId: 'U_LEASE_LIMIT',
    messageTs,
    threadTs: messageTs,
    source: 'app_mention',
    contextMode: 'thread',
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };
  const work = new SqliteWorkStore(':memory:');
  const admitted = await work.admitShadowRun(prepareSlackShadowAdmission({
    turn, assignment, sourceVisibility: 'public', admittedAt: Date.now(),
  }));
  const runId = admitted.run.id;
  const db = openStateDb(':memory:');
  const store = new SlackRunPresentationStoreLogic(db);
  const sessionGeneration = Number(messageTs.replace('.', ''));
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
  const finals: string[] = [];
  let leaseChecks = 0;
  let rateLimitLeaseCheck: number | undefined = 2; // the post-answer check
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
  const attempt = () => runTurn(turn, assignment, undefined, {
    client,
    runId,
    turnId: `turn_${runId}`,
    presentationState: state,
    workStore: work,
    usageRecordingEnabled: false,
    agentPrompt: async () => ({
      text: 'The release notes cover three fixes.',
      requestedModel: assignment.model ?? null,
      returnedModel: null,
      reportedUsage: null,
      usageCompleteness: 'not_reported' as const,
    }),
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
