import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as v from 'valibot';
import type { AgentInstanceHandle } from '@flue/runtime';

import {
  deriveRuntimePlanInstanceId,
  parseRuntimePlanV2,
  type RuntimePlanV2,
} from '../src/agents/runtime-plan.ts';
import { ChickpeaSlack } from '../src/agents/slack-thread.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { promptSlackThreadAgent, type SlackFlueDispatchState } from '../src/slack/flue-dispatch.ts';
import { TurnJobStoreLogic } from '../src/slack/turn-jobs.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import legacyFixture from './fixtures/runtime-plan/v0.1.26-attached-container.json' with { type: 'json' };

// Skip-upgrade (v0.1.26 straight to a release without the attached
// container): TurnJobs and Flue instances hold plans v0.1.26 admitted with
// `sandbox.mode: 'cloudflare'`. The fixture is a plan that release compiled.

const NOW = 1_950_000_000_000;
const ADMITTED = legacyFixture.slackTurnPlan;
const INSTANCE_ID = deriveRuntimePlanInstanceId(ADMITTED as never);

function turn(): NormalizedSlackTurn {
  return {
    workspaceId: 'T_LEGACY', channelId: 'C_LEGACY', eventId: 'Ev_LEGACY_ATTACHED',
    text: 'Clone acme-rails and run its tests', userId: 'U_LEGACY',
    messageTs: '1788000000.000200', threadTs: '1788000000.000100',
    source: 'app_mention', contextMode: 'thread',
  };
}

function assignment(): ResolvedAssignment {
  return {
    workspaceId: 'T_LEGACY', channelId: 'C_LEGACY', agentId: legacyFixture.agent.id,
    agent: legacyFixture.agent as ResolvedAssignment['agent'], model: legacyFixture.agent.model,
    ownerIncarnation: 1,
    modelAttribution: { source: 'workspace_default', providerId: 'local-stub', workspaceDefaultRevision: 1 },
  };
}

/** A TurnJob exactly as v0.1.26 left it: plan frozen, maybe dispatched. */
function legacyJob(options: { dispatched: boolean }) {
  const db = openStateDb(':memory:');
  const jobs = new TurnJobStoreLogic(db, () => NOW);
  jobs.enqueue({ id: 'turn_legacy', evtKey: 'evt_legacy', msgKey: 'msg_legacy', turn: turn(), assignment: assignment() });
  db.run(
    'UPDATE turn_jobs SET runtime_plan_json = ?, agent_instance_id = ? WHERE id = ?',
    JSON.stringify(ADMITTED), INSTANCE_ID, 'turn_legacy',
  );
  if (options.dispatched) {
    // Build the envelope through the store, then store v0.1.26's bytes in it.
    const envelope = jobs.prepareFlueDispatch('turn_legacy', 'Clone acme-rails', { generation: 'g1' });
    db.run(
      'UPDATE turn_jobs SET dispatch_envelope_json = ? WHERE id = ?',
      JSON.stringify({ ...envelope, initialData: ADMITTED }), 'turn_legacy',
    );
  }
  return { db, jobs };
}

test('an admitted v0.1.26 TurnJob reads as the virtual sandbox with a workspace, on the same instance', () => {
  const { db, jobs } = legacyJob({ dispatched: false });
  try {
    const frozen = jobs.getFrozenRuntimePlan('turn_legacy');
    assert.ok(frozen);
    assert.deepEqual(frozen.runtimePlan.sandbox, { mode: 'bash' });
    assert.deepEqual(frozen.runtimePlan.codingWorkspace, { available: true });
    assert.equal(frozen.instanceId, INSTANCE_ID);
    assert.equal(deriveRuntimePlanInstanceId(frozen.runtimePlan), INSTANCE_ID);
    // A retry never re-freezes: the first plan keeps owning the job.
    assert.deepEqual(jobs.freezeRuntimePlan('turn_legacy', frozen.runtimePlan), frozen);

    // Never dispatched before the update: the first dispatch creates the
    // instance from the upgraded plan, which the Agent's contract admits.
    const envelope = jobs.prepareFlueDispatch('turn_legacy', 'Clone acme-rails', { generation: 'g1' });
    assert.equal(envelope.instanceId, INSTANCE_ID);
    assert.deepEqual(envelope.initialData, frozen.runtimePlan);
    assert.equal(v.safeParse(ChickpeaSlack.initialData!, envelope.initialData).success, true);
    assert.deepEqual(jobs.getDispatchEnvelope('turn_legacy'), envelope);
  } finally {
    db.close();
  }
});

test('a v0.1.26 dispatch envelope resends its admitted creation data unchanged', async () => {
  const { db, jobs } = legacyJob({ dispatched: true });
  try {
    const envelope = jobs.getDispatchEnvelope('turn_legacy');
    assert.ok(envelope);
    // Flue counts creation data in a submission's identity; an upgraded copy
    // under the same idempotency key would be refused as a conflict.
    assert.deepEqual(envelope.initialData, ADMITTED);
    assert.equal(v.safeParse(ChickpeaSlack.initialData!, envelope.initialData).success, true);
    // A retry through the store returns the same checkpoint.
    assert.deepEqual(jobs.prepareFlueDispatch('turn_legacy', 'Clone acme-rails', { generation: 'g1' }), envelope);

    const requests: Array<{ initialData?: unknown }> = [];
    const handle = {
      id: INSTANCE_ID,
      async dispatch(request: { initialData?: unknown }) {
        requests.push(request);
        return { submissionId: 'submission_legacy', acceptedAt: new Date(NOW).toISOString(), uid: 'uid_legacy' };
      },
      async read() {
        return { text: 'done', data: {}, submissionId: 'submission_legacy', uid: 'uid_legacy', metadata: {} };
      },
      async abort() {},
    } as unknown as AgentInstanceHandle;
    const state: SlackFlueDispatchState = {
      dispatchEnvelope: envelope,
      prepare: async () => envelope,
      recordReceipt: async (receipt) => receipt,
      recordSettlement: async (settlement) => settlement,
      reconcileExistingInstance: async () => { throw new Error('not used'); },
      markRecoveryRequired: async () => {},
    };
    const reply = await promptSlackThreadAgent({
      message: 'Clone acme-rails', state, turnId: 'turn_legacy', conversationKey: 'T_LEGACY:C_LEGACY:1788000000.000100',
      requestedModel: legacyFixture.agent.model, handle,
      runtimePlan: parseRuntimePlanV2(structuredClone(ADMITTED)) as RuntimePlanV2,
    });
    assert.equal(reply.text, 'done');
    assert.deepEqual(requests.map(({ initialData }) => initialData), [ADMITTED]);
  } finally {
    db.close();
  }
});
