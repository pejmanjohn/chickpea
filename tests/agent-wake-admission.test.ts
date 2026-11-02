import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileRuntimePlanV2, deriveSlackTurnInstanceId } from '../src/agents/runtime-plan.ts';
import { CHICKPEA_AGENT_ID } from '../src/config/agent-id.ts';
import { installationOwnershipOf, scopedObjectName } from '../src/config/installation-scope.ts';
import type { ThreadRunnerJobPayload } from '../src/slack/thread-runner-rpc.ts';
import { freezeRuntimePlanForTurn } from '../src/slack/run-turn.ts';
import { slackAgentThreadKey } from '../src/slack/thread-key.ts';
import type { TurnJob } from '../src/slack/turn-job-types.ts';
import { TurnJobStoreLogic, type PendingTurnJob } from '../src/slack/turn-jobs.ts';
import type { SlackEvent } from '../src/slack/types.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import {
  AGENT_MENTION,
  delivery,
  message,
  RECEIPT_INSTALLATION_ID,
  receiptStore,
  withLane,
  type Lane,
} from './helpers/gateway-admission-lane.ts';
import { hostedInstallation } from './helpers/installation-objects.ts';

/**
 * The state store wakes a turn's Flue agent object as it hands the turn to
 * its runner (TagStateStore.wakeAgentAtHandoff), so the object activates
 * while the runner starts and the turn prepares, not once its plan froze.
 */

/** The turn row a hand-off lists, as admission stored it. */
function pending(job: TurnJob, overrides: Partial<PendingTurnJob> = {}): PendingTurnJob {
  return { ...job, executionAuthority: 'ledger', attempts: 0, progress: {}, ...overrides } as PendingTurnJob;
}

function withoutModel(assignment: PendingTurnJob['assignment']): PendingTurnJob['assignment'] {
  const { model: _model, ...rest } = assignment;
  return rest;
}

/** A value made in the probe's context, as plain data. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Settles within a second, or fails: the hand-off never waits for the wake. */
function promptly<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error('the hand-off waited for the wake')), 1_000).unref()),
  ]);
}

async function admitted(lane: Lane, event: SlackEvent): Promise<TurnJob> {
  lane.jobs.length = 0;
  await lane.admit(delivery(event));
  const [job] = lane.jobs;
  assert.ok(job, 'the delivery became a turn');
  return job;
}

// Defects caught: an admission name keyed apart from the freeze's (a fixed
// owner incarnation, the plain thread key, no installation scope, another
// Agent's or continuity policy's), a name not recorded before its wake, a
// wake sent after the hand-off, and a hand-off that does not carry it.
test('a handed-over turn wakes, before its hand-off, the Agent object its plan then names', async () => {
  await withLane(async (lane) => {
    const { config, help, stores } = lane;
    const installation = hostedInstallation(RECEIPT_INSTALLATION_ID);
    const db = openStateDb(':memory:');
    const standaloneJobs = new TurnJobStoreLogic(db);
    // A model that needs no provider key, so the built-in Agent's DM turn runs.
    config.putWorkspaceModelDefault({
      workspaceId: 'T1', modelId: 'local-stub/chickpea', provenance: 'admin_selected',
      lastChangedByMembershipId: help.creatorMembershipId!,
    }, config.getWorkspaceModelDefault('T1')?.revision ?? 0);
    // A thread @help already owns for the second time: its transcript is that tenure's.
    config.putAgentThreadRoute({
      workspaceId: 'T1', channelId: 'C1', threadTs: '7000.000100', agentId: help.id,
      agentGeneration: help.configurationGeneration ?? help.revision, ownerIncarnation: 2,
    });
    const cases: Array<[string, SlackEvent, (job: TurnJob) => void]> = [
      ['a user Agent mentioned in a Channel', AGENT_MENTION, (job) => assert.equal(job.assignment.agentId, help.id)],
      ['the built-in Agent in a DM', message({ channel: 'D1', ts: '6000.000100', text: 'hello' }),
        (job) => assert.equal(job.assignment.agentId, CHICKPEA_AGENT_ID)],
      ['a reply in a thread its owner holds again', message({ ts: '7000.000200', thread_ts: '7000.000100', text: 'go on' }),
        (job) => assert.match(slackAgentThreadKey(job.turn, job.assignment), /:owner-i2$/)],
    ];
    const names = new Set<string>();
    try {
      for (const [name, event, check] of cases) {
        const job = await admitted(lane, event);
        check(job);

        // A hosted state store: the name it wakes is recorded first, and the
        // store that freezes the plan names the same object.
        installation.stores.turnJobs.enqueue(job);
        const recorded: string[] = [];
        const hosted = receiptStore(config, {
          inventory: {
            recordAgentInstance: (kind, instanceId) => {
              recorded.push(instanceId);
              installation.stores.objectInventory.recordAgentInstance(kind, instanceId);
            },
          },
        });
        assert.equal(await hosted.probe.admitToRunner(pending(job)), true);
        assert.equal(hosted.agentWakes.length, 1, `${name}: one Agent wake`);
        const [wake] = hosted.agentWakes;
        assert.deepEqual(hosted.sent, [`agent:${wake!.name}`, `runner:${hosted.handoffs[0]}`],
          `${name}: the wake goes before the hand-off`);
        assert.deepEqual(recorded, [wake!.name], `${name}: the name is recorded before it is addressed`);
        assert.equal(wake!.turnJobId, job.id, `${name}: the wake names its turn`);
        assert.deepEqual(plain(hosted.admitted[0]!.payload as ThreadRunnerJobPayload).agentWake,
          { instanceId: wake!.name, sentAt: wake!.sentAt }, `${name}: the hand-off carries the wake`);
        const frozen = installation.stores.turnJobs.freezeRuntimePlan(job.id, compileRuntimePlanV2({
          installation: installationOwnershipOf(hosted.env)!, turn: job.turn, assignment: job.assignment,
          instructions: 'Help.', memoryEpoch: 1,
        }));
        assert.equal(frozen.instanceId, wake!.name, `${name}: the hosted freeze names the object admission woke`);
        names.add(wake!.name);

        // A standalone state store, against the turn's own freeze.
        standaloneJobs.enqueue(job);
        const standalone = receiptStore(config, { standalone: true });
        assert.equal(await standalone.probe.admitToRunner(pending(job)), true);
        const { decision } = await freezeRuntimePlanForTurn({
          turn: job.turn,
          assignment: job.assignment,
          platformEnv: undefined,
          settingsStore: stores.settings,
          configStore: stores.config,
          memoryEpoch: Promise.resolve(1),
          persist: (candidate) => standaloneJobs.freezeRuntimePlan(job.id, candidate),
        });
        assert.deepEqual(standalone.agentWakes.map(({ name: woken }) => woken), [decision.instanceId],
          `${name}: the turn's freeze names the object admission woke`);
        assert.equal(scopedObjectName({ installationId: RECEIPT_INSTALLATION_ID }, decision.instanceId), wake!.name,
          `${name}: one object per thread, scoped to its installation`);
      }
    } finally {
      db.close();
    }
    assert.equal(names.size, cases.length, 'each turn wakes its own object');
    assert.equal(installation.stores.objectInventory.counts().slack_agent, cases.length,
      'the freeze recorded no name admission had not');
    // The ownership transfer rotated the transcript: the first tenure's object is another.
    const reply = lane.jobs[0]!;
    assert.notEqual(
      deriveSlackTurnInstanceId(reply.turn, { ...reply.assignment, ownerIncarnation: 1 }, { version: 1, installationId: RECEIPT_INSTALLATION_ID }),
      [...names].at(-1),
    );
  });
});

// Defect caught: a guest Agent's wake keyed by the thread alone, which wakes
// the owner's transcript while its own turn stages beside another object.
test("an Agent answering an ask in another's thread wakes its own transcript, as its freeze names it", async () => {
  await withLane(async (lane) => {
    const installation = hostedInstallation(RECEIPT_INSTALLATION_ID);
    const owner = await admitted(lane, AGENT_MENTION);
    const guest: TurnJob = {
      ...owner,
      id: 'msg:C1:5000.000300',
      turn: {
        ...owner.turn, messageTs: '5000.000300', eventId: 'Ev_ask', source: 'agent_mention',
        agentAsk: { fromAgentId: owner.assignment.agentId, fromAgentName: 'Support', originMessageTs: '5000.000200' },
      },
      assignment: { ...owner.assignment, agentId: CHICKPEA_AGENT_ID, threadGuest: true,
        agent: { ...owner.assignment.agent, id: CHICKPEA_AGENT_ID } },
    };
    const woken: string[] = [];
    for (const job of [owner, guest]) {
      installation.stores.turnJobs.enqueue(job);
      const store = receiptStore(lane.config, { inventory: installation.stores.objectInventory });
      assert.equal(await store.probe.admitToRunner(pending(job)), true);
      const frozen = installation.stores.turnJobs.freezeRuntimePlan(job.id, compileRuntimePlanV2({
        installation: installationOwnershipOf(store.env)!, turn: job.turn, assignment: job.assignment,
        instructions: 'Help.', memoryEpoch: 1,
      }));
      assert.deepEqual(store.agentWakes.map(({ name }) => name), [frozen.instanceId]);
      woken.push(frozen.instanceId);
    }
    assert.notEqual(woken[0], woken[1], "the guest's transcript is its own");
  });
});

// Defects caught: an awaited wake (the hand-off waits for an activation), a
// rejection left unhandled, a synchronous throw or an inventory failure that
// fails or changes the hand-off.
test('a wake that never answers, rejects or throws leaves the hand-off as it was', async () => {
  await withLane(async (lane) => {
    const job = pending(await admitted(lane, AGENT_MENTION));
    const baseline = receiptStore(lane.config, { inventory: { recordAgentInstance() { throw new Error('inventory unavailable'); } } });
    assert.equal(await baseline.probe.admitToRunner(job), true);
    assert.equal(baseline.agentWakes.length, 0, 'an unrecorded name is never addressed');
    const [handoff] = baseline.admitted;
    assert.ok(handoff);
    assert.equal((handoff.payload as ThreadRunnerJobPayload).agentWake, undefined);
    const failures: Array<[string, Parameters<typeof receiptStore>[1]]> = [
      ['never answers', { agentWake: () => new Promise<void>(() => undefined) }],
      ['rejects', { agentWake: () => Promise.reject(new Error('no such method')) }],
      ['throws', { agentWake: () => { throw new Error('object unavailable'); } }],
      ['has no binding', { env: { CHICKPEA_SLACK_AGENT: undefined } }],
    ];
    for (const [name, options] of failures) {
      const store = receiptStore(lane.config, options);
      assert.equal(await promptly(store.probe.admitToRunner(job)), true, `${name}: the hand-off succeeded`);
      assert.deepEqual(store.confirmed, [job.id], `${name}: and was confirmed`);
      const { agentWake: _carried, ...payload } = plain(store.admitted[0]!.payload as ThreadRunnerJobPayload);
      assert.deepEqual(plain({ ...store.admitted[0]!, payload, sentAt: 0 }), plain({ ...handoff, sentAt: 0 }),
        `${name}: the runner was handed the same turn`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  });
});

// Defects caught: waking for a turn that freezes no plan: one a stop holds or
// stopped, one that froze or dispatched its plan already (a retry, a
// replay), one judged react_only at admission or by an earlier attempt, a
// memory or routine command, an approval, or an Agent with no model.
test('a turn that freezes no plan wakes no Agent object, and is handed over the same', async () => {
  await withLane(async (lane) => {
    const job = pending(await admitted(lane, AGENT_MENTION));
    const wakes = async (candidate: PendingTurnJob) => {
      const store = receiptStore(lane.config);
      assert.equal(await store.probe.admitToRunner(candidate), true, 'the turn is handed over');
      assert.equal(store.handoffs.length, 1);
      return store.agentWakes.length;
    };
    assert.equal(await wakes(job), 1, 'the same turn wakes its object');
    const stop = { schemaVersion: 1, role: 'stopped', source: 'typed', stopperUserId: 'U1', cutoffTs: '5000.000900', stoppedAt: 1 } as const;
    const silent: Array<[string, PendingTurnJob]> = [
      ['stopped before its dispatch', { ...job, stop }],
      ['held by a stop', { ...job, stop: { schemaVersion: 1, role: 'held', headId: 'msg:C1:4000.000100' } as NonNullable<PendingTurnJob['stop']> }],
      ['with its plan frozen', { ...job, runtimePlan: {} as NonNullable<PendingTurnJob['runtimePlan']>, agentInstanceId: `agent_${'a'.repeat(40)}` }],
      ['judged react_only at admission', { ...job, turn: { ...job.turn, interactionIntent: { disposition: 'react_only', reason: 'pure_ack', reaction: 'seen', target: 'thread_root' } } } as PendingTurnJob],
      ['judged react_only by an earlier attempt', { ...job, progress: { interactionIntent: { disposition: 'react_only', reason: 'pure_ack', reaction: 'seen', target: 'thread_root' } } } as PendingTurnJob],
      ['a memory command', { ...job, turn: { ...job.turn, text: '<@UBOT> !memory help' } }],
      ['a routine command', { ...job, turn: { ...job.turn, text: '<@UBOT> !routines' } }],
      ['an approval', { ...job, turn: { ...job.turn, managementApprovalProposalId: 'proposal_1' } }],
      ['an Agent with no model', { ...job, assignment: withoutModel(job.assignment) }],
    ];
    for (const [name, candidate] of silent) assert.equal(await wakes(candidate), 0, `${name}: no wake`);
  });
});
