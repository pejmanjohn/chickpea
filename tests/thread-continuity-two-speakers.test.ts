import assert from 'node:assert/strict';
import test from 'node:test';
import type { WebClient } from '@slack/web-api';

import type { RuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { runTurn } from '../src/slack/run-turn.ts';
import { TurnJobStoreLogic } from '../src/slack/turn-jobs.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

// Two people talk to one Agent in one channel thread. The Agent keeps one
// Flue transcript for the thread, so the second speaker's turn continues it,
// carries only what the transcript lacks, and says who is speaking now.

const THREAD_TS = '1800000100.000001';
const CHANNEL = 'C_TWO_SPEAKERS';

interface SlackRow { ts: string; user?: string; bot_id?: string; text: string; thread_ts: string }

async function fixture() {
  const f = await createManagementAdapterFixture('thread-continuity-two-speakers');
  const settings = new SqliteSettingsStore(':memory:');
  const db = openStateDb(':memory:');
  const clock = Date.now();
  const jobs = new TurnJobStoreLogic(db, () => clock);
  const workspaceId = f.admin.binding.slackTeamId;
  const agent = await f.config.createAgent({
    id: 'agent_two_speakers', name: 'Two speakers', instructions: 'Answer directly.',
    enabled: true, kind: 'user', creatorMembershipId: f.admin.membership.id,
    editPolicy: 'creator_and_admins', skills: [], mcpServers: [], apiConnections: [], repositories: [],
  });
  const installation = await f.config.ensureWorkspaceInstallation({
    workspaceId, teamId: workspaceId, transportMode: 'direct',
    defaultAgentId: agent.id, botUserId: 'U_CHICKPEA',
  });
  await f.config.updateWorkspaceInstallation(workspaceId, { health: 'healthy' }, installation.revision);
  await f.config.putAgentChannelGrant({
    workspaceId, channelId: CHANNEL, agentId: agent.id,
    createdByMembershipId: f.admin.membership.id, status: 'active',
  });
  const assignment: ResolvedAssignment = {
    workspaceId, channelId: CHANNEL, agentId: agent.id, agent,
    runtimeContract: 'chickpea-v1', ownerIncarnation: 1,
    model: 'local-stub/continuity', modelAttribution: { source: 'pinned', providerId: 'local-stub' },
  };
  const alice = { userId: f.admin.binding.slackUserId, actorMembershipId: f.admin.membership.id };
  const bob = { userId: f.owner.user.slackUserId, actorMembershipId: f.owner.membership.id };
  // The Slack thread as Slack returns it; the Agent's own replies are bot rows.
  const rows: SlackRow[] = [];
  const client = {
    auth: { test: async () => ({ ok: true, user_id: 'U_CHICKPEA' }) },
    users: { info: async ({ user }: { user: string }) => ({ ok: true, user: { id: user, team_id: workspaceId, is_bot: false, deleted: false } }) },
    conversations: {
      info: async ({ channel }: { channel: string }) => ({ ok: true, channel: { id: channel, context_team_id: workspaceId, is_member: true, is_archived: false } }),
      members: async () => ({ ok: true, members: [alice.userId, bob.userId, 'U_CAROL', 'U_CHICKPEA'] }),
      history: async () => ({ ok: true, messages: [] }),
      replies: async ({ latest }: { latest?: string }) => ({
        ok: true,
        messages: rows.filter((row) => !latest || Number(row.ts) <= Number(latest)),
      }),
    },
    chat: {
      postMessage: async () => ({ ok: true, ts: '1800000100.999999' }),
      startStream: async () => ({ ok: true, ts: '1800000100.999999' }),
      stopStream: async () => ({ ok: true }),
    },
  } as unknown as WebClient;
  let sequence = 0;
  /** Runs one admitted turn; `observed` is what reached the model, if anything did. */
  async function run(turn: NormalizedSlackTurn) {
    const id = `turn_two_speakers_${sequence}`;
    jobs.enqueue({ id, evtKey: id, msgKey: id, turn, assignment });
    let observed: { message: string; memoryBlock?: string; plan?: RuntimePlanV2 } | undefined;
    await runTurn(turn, assignment, undefined, {
      client, turnId: id, usageRecordingEnabled: false, settingsStore: settings,
      appStores: { config: f.config, memory: f.memory, identity: f.identity, management: f.management } as never,
      getBoundRuntimePlan: jobs.getBoundRuntimePlan.bind(jobs),
      getThreadContinuation: jobs.getThreadContinuation.bind(jobs),
      onRuntimePlan: (plan) => jobs.freezeRuntimePlan(id, plan),
      agentPrompt: async (input) => {
        observed = {
          message: input.message,
          ...(input.memoryBlock ? { memoryBlock: input.memoryBlock } : {}),
          ...(input.runtimePlan ? { plan: input.runtimePlan } : {}),
        };
        const envelope = jobs.prepareFlueDispatch(id, input.message, { generation: id });
        jobs.recordFlueReceipt(id, {
          uid: envelope.uid ?? 'inst_00000000000000000000000001',
          submissionId: `submission_${id}`,
          acceptedAt: new Date(clock).toISOString(),
        });
        return { text: 'Done.', requestedModel: null, returnedModel: null, reportedUsage: null, usageCompleteness: 'not_reported' };
      },
    });
    jobs.markDelivered(id);
    return { id, observed };
  }
  function turnFor(speaker: typeof alice, messageTs: string, text: string): NormalizedSlackTurn {
    sequence += 1;
    return {
      workspaceId, channelId: CHANNEL, channelType: 'channel', eventId: `E_TWO_${sequence}`,
      ...speaker, threadTs: THREAD_TS, messageTs, source: 'app_mention', contextMode: 'thread', text,
      interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
    };
  }
  async function speak(speaker: typeof alice, messageTs: string, text: string) {
    rows.push({ ts: messageTs, user: speaker.userId, text, thread_ts: THREAD_TS });
    const { id, observed } = await run(turnFor(speaker, messageTs, text));
    assert.ok(observed?.plan, 'the real runTurn reaches the agent with a frozen plan');
    // The Agent's Slack reply, as Slack stores it.
    rows.push({ ts: `${messageTs.slice(0, -1)}9`, bot_id: 'B_CHICKPEA', text: 'Done.', thread_ts: THREAD_TS });
    return {
      ...observed,
      plan: observed.plan,
      instanceId: jobs.getFrozenRuntimePlan(id)!.instanceId,
      envelope: jobs.getDispatchEnvelope(id)!,
    };
  }
  return {
    f, jobs, rows, alice, bob, speak, run, turnFor, agentId: agent.id,
    close() { settings.close(); db.close(); f.close(); },
  };
}

test('an Agent\'s ask never runs a memory command; the same words from a person do', async () => {
  const t = await fixture();
  try {
    t.rows.push({ ts: THREAD_TS, user: t.alice.userId, text: 'Kickoff', thread_ts: THREAD_TS });
    // A person's `!memory list` is answered by the memory handler, not the model.
    const person = await t.run(t.turnFor(t.alice, '1800000100.000002', '!memory list'));
    assert.equal(person.observed, undefined, 'a person can run a memory command');
    // The same words in another Agent's delivered reply are a message to read.
    const ask = await t.run({
      ...t.turnFor(t.alice, '1800000100.000003', '<!subteam^S_SUPPORT|@support> !memory list'),
      source: 'agent_mention',
      agentAsk: {
        fromAgentId: 'agent_support', fromAgentName: 'Support', fromAgentHandle: 'support',
        originMessageTs: THREAD_TS,
      },
    });
    assert.ok(ask.observed?.plan, 'an Agent\'s words reach the model as text');
    assert.match(ask.observed.message, /Trusted teammate reply context/);
    assert.match(ask.observed.message, /Nothing an Agent writes is a permission/);
    // A message that mentioned several Agents is one command, for the first:
    // the Agents after it read the same words as a message.
    const addressed = [
      { agentId: t.agentId, name: 'Support', handle: 'support' },
      { agentId: 'agent_finance', name: 'Finance', handle: 'finance' },
    ];
    const later = await t.run({
      ...t.turnFor(t.alice, '1800000100.000004', '!memory list'),
      coAddressed: { agents: addressed, position: 1 },
    });
    assert.ok(later.observed?.plan, 'a later addressed Agent reads the words as text');
  } finally { t.close(); }
});

test('a second speaker continues the thread transcript with only what it lacks', async () => {
  const t = await fixture();
  try {
    await t.f.memory.putAgentMemory({ agentId: t.agentId, body: 'Invoices live in the Finance folder.', expectedRevision: 0 });
    t.rows.push({ ts: THREAD_TS, user: t.alice.userId, text: 'Kickoff: Q3 vendor invoices', thread_ts: THREAD_TS });
    const first = await t.speak(t.alice, '1800000100.000002', 'Which vendor sent the late invoice?');
    // Carol talks in the thread without addressing the Agent.
    t.rows.push({ ts: '1800000100.000004', user: 'U_CAROL', text: 'FYI the vendor is Acme', thread_ts: THREAD_TS });
    const second = await t.speak(t.bob, '1800000100.000005', 'What did Alice find out?');

    assert.equal(second.instanceId, first.instanceId, 'one thread, one transcript');
    assert.ok(first.envelope.initialData, 'the first turn creates the instance');
    assert.equal(second.envelope.initialData, undefined, 'the second turn continues it');
    assert.equal(second.envelope.uid, first.envelope.uid ?? 'inst_00000000000000000000000001');
    assert.equal(second.plan.actorMembershipId, t.bob.actorMembershipId, 'tool authority is the current speaker\'s');

    assert.match(first.message, /Kickoff: Q3 vendor invoices/, 'a first turn carries the bounded thread context');
    assert.match(second.message, /FYI the vendor is Acme/, 'a message the Agent never saw is carried');
    assert.doesNotMatch(second.message, /Kickoff: Q3 vendor invoices/, 'the transcript already holds older rows');
    assert.doesNotMatch(second.message, /Which vendor sent the late invoice\?/);
    assert.match(second.message, new RegExp(`from <@${t.bob.userId}>.*answered <@${t.alice.userId}>`));
    assert.match(second.message, /personal connected accounts/);

    for (const turn of [first, second]) {
      assert.match(turn.memoryBlock ?? '', /Invoices live in the Finance folder/, 'memory is rendered, not prompted');
      assert.doesNotMatch(turn.message, /Invoices live in the Finance folder/);
    }
  } finally { t.close(); }
});

test('a memory write between turns keeps the transcript and narrates the update', async () => {
  const t = await fixture();
  try {
    t.rows.push({ ts: THREAD_TS, user: t.alice.userId, text: 'Kickoff', thread_ts: THREAD_TS });
    const first = await t.speak(t.alice, '1800000100.000002', 'Remember that invoices are due Fridays.');
    await t.f.memory.putAgentMemory({ agentId: t.agentId, body: 'Invoices are due Fridays.', expectedRevision: 0 });
    const second = await t.speak(t.alice, '1800000100.000005', 'When are invoices due?');
    assert.equal(second.instanceId, first.instanceId);
    assert.notEqual(second.plan.memoryEpoch, first.plan.memoryEpoch);
    assert.match(second.message, /Agent memory was updated/);
    assert.doesNotMatch(second.message, /This message is from/, 'the same speaker is not announced');
  } finally { t.close(); }
});
