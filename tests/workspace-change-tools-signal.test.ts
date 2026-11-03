import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileRuntimePlanV2, type RuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { parseSlackManagementSignal } from '../src/management/slack-tools.ts';
import { slackAttachmentTurnContext } from '../src/slack/attachment-context.ts';
import type { TurnJob } from '../src/slack/turn-job-types.ts';
import { TurnJobStoreLogic } from '../src/slack/turn-jobs.ts';
import { openStateDb } from '../src/state/node-state-db.ts';

// The host's change-tools signal travels as one optional attribute of the
// turn's Flue dispatch: written with the envelope, read back from the store
// on a retry, and read by the Agent's render, which mounts the change tools.

const THREAD_TS = '1800000000.000100';

function job(id: string, messageTs: string): TurnJob {
  const assignment: ResolvedAssignment = {
    workspaceId: 'T_SIGNAL', channelId: 'C_SIGNAL', agentId: 'agent_signal', model: 'local-stub/signal',
    runtimeContract: 'chickpea-v1', ownerIncarnation: 1,
    agent: {
      id: 'agent_signal', kind: 'user', revision: 1, name: 'Signal', instructions: 'Help.', enabled: true,
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    },
  };
  return {
    id, evtKey: `evt:${id}`, msgKey: `msg:${id}`, assignment,
    turn: {
      workspaceId: 'T_SIGNAL', channelId: 'C_SIGNAL', eventId: `Ev_${id}`, text: 'Create an Agent named Scout.',
      userId: 'U_MEMBER', messageTs, threadTs: THREAD_TS, source: 'app_mention', contextMode: 'thread',
      channelType: 'channel',
    },
  };
}

/** Enqueue, freeze the plan, and prepare the dispatch, as a running turn does. */
function prepared(turns: TurnJobStoreLogic, queued: TurnJob, workspaceChangeTools?: boolean) {
  turns.enqueue(queued);
  const plan = compileRuntimePlanV2({
    turn: queued.turn, assignment: queued.assignment, instructions: 'Help.', memoryEpoch: 1,
  });
  turns.freezeRuntimePlan(queued.id, plan);
  const envelope = turns.prepareFlueDispatch(
    queued.id, 'Create an Agent named Scout.', { generation: queued.id },
    undefined, undefined, undefined, undefined, workspaceChangeTools,
  );
  return { envelope, plan: turns.getFrozenRuntimePlan(queued.id)!.runtimePlan };
}

type Delivery = Parameters<typeof parseSlackManagementSignal>[0];
const delivered = (message: unknown) => message as Delivery;

// Defect caught: the writer drops the signal, the store's own reader refuses
// the envelope it wrote (failing every retry of a signaled turn), or the
// render's reader drops it, so the tools never mount.
test('the change-tools signal is frozen into the dispatch, read back from the store, and read by the render', () => {
  const db = openStateDb(':memory:');
  try {
    const turns = new TurnJobStoreLogic(db, () => 1_800_000_000_000);
    const signaled = prepared(turns, job('signaled', '1800000000.000101'), true);
    assert.equal(signaled.envelope.message.kind, 'signal');
    const attributes = signaled.envelope.message.kind === 'signal' ? signaled.envelope.message.attributes : undefined;
    assert.equal(attributes?.workspaceChangeTools, 'mounted');
    assert.deepEqual(turns.getDispatchEnvelope('signaled'), signaled.envelope, 'a retry reads the same envelope');
    // A second prepare (a retry) reuses the frozen envelope whatever it is asked.
    assert.deepEqual(turns.prepareFlueDispatch('signaled', 'Create an Agent named Scout.', { generation: 'signaled' }), signaled.envelope);
    assert.equal(parseSlackManagementSignal(delivered(signaled.envelope.message), signaled.plan)?.workspaceChangeTools, true);

    for (const [id, ts, hint] of [['quiet', '1800000000.000102', false], ['legacy', '1800000000.000103', undefined]] as const) {
      const quiet = prepared(turns, job(id, ts), hint);
      const message = quiet.envelope.message;
      assert.equal(message.kind === 'signal' && 'workspaceChangeTools' in message.attributes, false, `${id}: no attribute`);
      const signal = parseSlackManagementSignal(delivered(message), quiet.plan);
      assert.ok(signal, `${id}: still a management signal`);
      assert.equal(signal.workspaceChangeTools, undefined);
    }

    // The store's reader stays exact about the value: it wrote only `mounted`.
    const json = JSON.parse(String(db.get('SELECT dispatch_envelope_json FROM turn_jobs WHERE id = ?', 'signaled')!.dispatch_envelope_json));
    json.message.attributes.workspaceChangeTools = 'always';
    db.run('UPDATE turn_jobs SET dispatch_envelope_json = ? WHERE id = ?', JSON.stringify(json), 'signaled');
    assert.throws(() => turns.getDispatchEnvelope('signaled'), /change-tools signal is invalid/);
  } finally {
    db.close();
  }
});

const PLAN = {
  agentId: 'agent_signal',
  conversation: { workspaceId: 'T_SIGNAL', channelId: 'C_SIGNAL', threadTs: THREAD_TS },
} as unknown as RuntimePlanV2;

function slackMessage(extra: Record<string, string>): Delivery {
  return delivered({
    kind: 'signal', type: 'slack.message', tagName: 'slack_message', body: 'Create an Agent named Scout.',
    attributes: {
      workspaceId: 'T_SIGNAL', channelId: 'C_SIGNAL', threadTs: THREAD_TS, slackUserId: 'U_MEMBER',
      eventId: 'Ev_SIGNAL', messageTs: '1800000000.000101', turnJobId: 'turn_signal', ...extra,
    },
  });
}

// Defect caught: the render's reader rejects an attribute it does not know,
// which in a rolling deploy strips a newer host's turn of every management,
// web, and interactive tool in an older Agent; or it admits a delivery that
// names a fact only the Agent side may set.
test('the render\'s reader ignores attributes it does not know and refuses a delivery naming a reserved fact', () => {
  const plain = parseSlackManagementSignal(slackMessage({}), PLAN);
  assert.ok(plain);
  const newer = parseSlackManagementSignal(slackMessage({ workspaceChangeTools: 'mounted', laterHostHint: 'v2' }), PLAN);
  assert.deepEqual(newer, { ...plain, workspaceChangeTools: true }, 'the unknown key is ignored, the known one read');
  assert.deepEqual(parseSlackManagementSignal(slackMessage({ workspaceChangeTools: 'always' }), PLAN), plain,
    'a value this release does not know is no signal: the turn stays lean');
  for (const reserved of [{ publicDocRead: 'true' }, { agentId: 'agent_other' }]) {
    assert.equal(parseSlackManagementSignal(slackMessage(reserved), PLAN), undefined, JSON.stringify(reserved));
  }
});

// Defect caught: the attachment analysis, which becomes the delivery later
// renders of an upload turn read, drops the signal, so the tools the first
// request mounted are withdrawn mid-turn.
test('the attachment-analysis signal carries the change-tools signal to the turn\'s later renders', () => {
  const carried = slackAttachmentTurnContext(slackMessage({ workspaceChangeTools: 'mounted' })).attributes;
  assert.equal(carried.workspaceChangeTools, 'mounted');
  const analysis = delivered({
    kind: 'signal', type: 'slack.attachment_context', tagName: 'slack_attachment_context', body: 'analysis',
    attributes: { ...carried, workspaceId: 'T_SIGNAL', channelId: 'C_SIGNAL', threadTs: THREAD_TS, attachmentStatus: 'ok' },
  });
  assert.equal(parseSlackManagementSignal(analysis, PLAN)?.workspaceChangeTools, true);
});
