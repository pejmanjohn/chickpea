import assert from 'node:assert/strict';
import test from 'node:test';
import type { WebClient } from '@slack/web-api';
import type { RuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { runTurn } from '../src/slack/run-turn.ts';
import { TurnJobStoreLogic, TURN_JOB_TTL_MS } from '../src/slack/turn-jobs.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

async function fixture() {
  const f = await createManagementAdapterFixture('account-continuity');
  const settings = new SqliteSettingsStore(':memory:');
  const db = openStateDb(':memory:');
  let clock = Date.now();
  const jobs = new TurnJobStoreLogic(db, () => clock);
  const workspaceId = f.admin.binding.slackTeamId;
  const agent = await f.config.createAgent({
    id: 'agent_account_continuity', name: 'Account continuity', instructions: 'Answer directly.',
    enabled: true, kind: 'user', creatorMembershipId: f.admin.membership.id,
    editPolicy: 'creator_and_admins', skills: [], mcpServers: [], apiConnections: [], repositories: [],
  });
  const installation = await f.config.ensureWorkspaceInstallation({
    workspaceId, teamId: workspaceId, transportMode: 'direct',
    defaultAgentId: agent.id, botUserId: 'U_CHICKPEA',
  });
  await f.config.updateWorkspaceInstallation(workspaceId, { health: 'healthy' }, installation.revision);
  for (const label of ['Work', 'Personal']) {
    const account = await f.config.putConnectionAccount({
      id: `connection_${label.toLowerCase()}`, workspaceId, ownerKind: 'team',
      createdByMembershipId: f.admin.membership.id, providerId: 'mail', label,
      secretRefId: `secret_${label}`, lifecycle: 'ready',
      policy: { kind: 'api', authMode: 'credential', allowedHosts: ['api.example.com'],
        pathPrefixes: ['/mail'], allowedMethods: ['GET'], headerName: 'Authorization' },
    }, 0);
    await f.config.putAgentConnectionBinding({
      agentId: agent.id, connectionAccountId: account.id, providerId: 'mail', allowedCapabilities: ['GET'], enabled: true,
    });
  }
  const assignment: ResolvedAssignment = {
    workspaceId, channelId: 'D_CONTINUITY', agentId: agent.id, agent,
    runtimeContract: 'chickpea-v1', ownerIncarnation: 1,
    model: 'local-stub/continuity', modelAttribution: { source: 'pinned', providerId: 'local-stub' },
  };
  const client = {
    conversations: {
      history: async () => ({ ok: true, messages: [] }),
      replies: async () => ({ ok: true, messages: [] }),
    },
    chat: {
      postMessage: async () => ({ ok: true, ts: '1800000000.999999' }),
      startStream: async () => ({ ok: true, ts: '1800000000.999999' }),
      stopStream: async () => ({ ok: true }),
    },
  } as unknown as WebClient;
  let sequence = 0;
  async function run(text: string, turnOverrides: Partial<NormalizedSlackTurn> = {}, assignmentOverrides: Partial<ResolvedAssignment> = {}) {
    const id = `turn_continuity_${++sequence}`;
    const turn: NormalizedSlackTurn = {
      workspaceId, channelId: assignment.channelId, eventId: `E_CONTINUITY_${sequence}`,
      userId: f.admin.binding.slackUserId, actorMembershipId: f.admin.membership.id,
      threadTs: '1800000000.000001', messageTs: `1800000000.${String(sequence + 1).padStart(6, '0')}`,
      source: 'dm_message', contextMode: 'thread', text,
      interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
      ...turnOverrides,
    };
    const currentAssignment = { ...assignment, ...assignmentOverrides };
    jobs.enqueue({ id, evtKey: id, msgKey: id, turn, assignment: currentAssignment });
    let observed: RuntimePlanV2 | undefined;
    await runTurn(turn, currentAssignment, undefined, {
      client, turnId: id, usageRecordingEnabled: false, settingsStore: settings,
      appStores: { config: f.config, memory: f.memory, identity: f.identity, management: f.management } as never,
      getBoundRuntimePlan: jobs.getBoundRuntimePlan.bind(jobs),
      onRuntimePlan: (plan) => jobs.freezeRuntimePlan(id, plan),
      agentPrompt: async (input) => {
        assert.ok(input.runtimePlan);
        observed = input.runtimePlan;
        const envelope = jobs.prepareFlueDispatch(id, input.message, { generation: id });
        jobs.recordFlueReceipt(id, { uid: envelope.uid ?? `inst_${String(sequence).padStart(26, '0')}`, submissionId: `submission_${id}`, acceptedAt: new Date(clock).toISOString() });
        return { text: 'Done.', requestedModel: null, returnedModel: null, reportedUsage: null, usageCompleteness: 'not_reported' };
      },
    });
    assert.ok(observed, 'real runTurn must reach the agent with a frozen plan');
    assert.equal(jobs.getAgentBinding(observed.conversation.continuityKey)?.instanceId, jobs.getFrozenRuntimePlan(id)!.instanceId, 'dispatch must pin the actual conversation before the next turn');
    jobs.markDelivered(id);
    return { id, turn, plan: observed, instanceId: jobs.getFrozenRuntimePlan(id)!.instanceId };
  }
  return { ...f, jobs, run, assignment,
    advance(ms: number) { clock += ms; },
    close() { settings.close(); db.close(); f.close(); },
  };
}

test('real consecutive turn freezes retain the account and instance until explicit switch, including new subjects', async () => {
  const f = await fixture();
  try {
    const first = await f.run('Search Work for invoices');
    const next = await f.run('Open the first result');
    const newSubject = await f.run('Find my flight confirmation');
    assert.deepEqual(first.plan.connectionAccountIds, ['connection_work']);
    assert.deepEqual(next.plan.connectionAccountIds, first.plan.connectionAccountIds);
    assert.equal(next.instanceId, first.instanceId);
    assert.equal(newSubject.instanceId, first.instanceId);
    const switched = await f.run('Use Personal instead');
    assert.deepEqual(switched.plan.connectionAccountIds, ['connection_personal']);
    assert.deepEqual((await f.run('Open the next result')).plan.connectionAccountIds, ['connection_personal']);
    assert.deepEqual(f.jobs.freezeRuntimePlan(first.id, switched.plan).runtimePlan, first.plan, 'replay keeps its original immutable plan');
  } finally { f.close(); }
});

test('unavailable prior account remains withheld across repeated turns until explicit switch', async () => {
  const f = await fixture();
  try {
    await f.run('Search Work for invoices');
    const work = (await f.config.listConnectionAccounts(f.assignment.workspaceId)).find(({ id }) => id === 'connection_work')!;
    await f.config.putConnectionAccount({ ...work, lifecycle: 'revoked' }, work.revision);
    for (const text of ['Open the first result', 'Try again']) {
      const next = await f.run(text);
      assert.deepEqual(next.plan.connectionAccountIds, []);
      assert.equal(next.plan.connectionChoices?.[0]?.previousAccountUnavailable, true);
      assert.equal(next.plan.connectionSelections?.[0]?.accountId, work.id);
    }
    assert.deepEqual((await f.run('Use Personal instead')).plan.connectionAccountIds, ['connection_personal']);
  } finally { f.close(); }
});

for (const changed of ['root', 'actor', 'owner', 'agent'] as const) {
  test(`${changed} change does not inherit another conversation's account`, async () => {
    const f = await fixture();
    try {
      await f.run('Search Work for invoices');
      const replacement = changed === 'agent'
        ? await f.config.createAgent({ ...f.assignment.agent, id: 'agent_other_continuity' }) : undefined;
      if (replacement) {
        for (const binding of await f.config.listAgentConnectionBindings(f.assignment.agentId)) {
          // Accounts are owned by one Agent; use separate accounts with the same
          // visible choices to prove no preference transfers across Agents.
          const old = (await f.config.listConnectionAccounts(f.assignment.workspaceId)).find(({ id }) => id === binding.connectionAccountId)!;
          const account = await f.config.putConnectionAccount({ ...old, id: `${old.id}_other`, secretRefId: `${old.secretRefId}_other` }, 0);
          await f.config.putAgentConnectionBinding({ ...binding, agentId: replacement.id, connectionAccountId: account.id });
        }
      }
      const next = await f.run('Open the first result',
        changed === 'root' ? { threadTs: '1800000000.999001' }
          : changed === 'actor' ? { actorMembershipId: f.owner.membership.id, userId: f.owner.user.slackUserId } : {},
        changed === 'owner' ? { ownerIncarnation: 2 }
          : replacement ? { agentId: replacement.id, agent: replacement } : {});
      assert.deepEqual(next.plan.connectionAccountIds, []);
      assert.equal(next.plan.connectionChoices?.length, 1);
      assert.deepEqual(next.plan.connectionSelections, []);
    } finally { f.close(); }
  });
}

test('only latest bound dispatched context survives terminal TTL and expires with its binding', async () => {
  const f = await fixture();
  try {
    const first = await f.run('Search Work for invoices');
    const second = await f.run('Open the first result');
    // A binding without a surviving dispatched row contributes null to the
    // retention lookup; it must not make NOT IN retain every completed job.
    f.jobs.pinAgentBinding({
      continuityKey: `agent_${'a'.repeat(40)}`, instanceId: `agent_${'b'.repeat(40)}`,
      uid: 'inst_00000000000000000000000009', updatedAt: Date.now(),
    });
    assert.equal(f.jobs.getBoundRuntimePlan(second.plan.conversation.continuityKey, first.turn.messageTs), undefined, 'future messages are never prior routing context');
    f.advance(TURN_JOB_TTL_MS + 1);
    assert.ok(f.jobs.getBoundRuntimePlan(second.plan.conversation.continuityKey, '1800000001.000000'));
    assert.equal(f.jobs.getFrozenRuntimePlan(first.id), undefined);
    assert.ok(f.jobs.getFrozenRuntimePlan(second.id));
    f.advance(31 * 24 * 60 * 60 * 1000);
    assert.equal(f.jobs.getBoundRuntimePlan(second.plan.conversation.continuityKey, '1800000001.000000'), undefined);
    assert.equal(f.jobs.getFrozenRuntimePlan(second.id), undefined);
  } finally { f.close(); }
});
