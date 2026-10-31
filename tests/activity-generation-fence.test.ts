import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { activityStatus } from '../src/activity/status.ts';
import { presentAdmittedSlackActivity } from '../src/slack/admission-activity.ts';
import {
  SlackAgentViewPresentation,
  type SlackPresentationStatePort,
} from '../src/slack/agent-view-presentation.ts';
import {
  SlackRunPresentationStoreLogic,
  type SlackPresentationMutation,
} from '../src/slack/run-presentations.ts';
import { openStateDb } from '../src/state/node-state-db.ts';

const ROOT = {
  workspaceId: 'T_FENCE',
  channelId: 'D_FENCE',
  threadTs: '1785700400.000100',
  requesterUserId: 'U_FENCE',
};
const G = 1785700400000100;
const THINKING = activityStatus('preparing', 'Thinking', '');

function harness() {
  const db = openStateDb(':memory:');
  const store = new SlackRunPresentationStoreLogic(db, () => 1_800_000_000_000);
  const statuses: string[] = [];
  const client = {
    async apiCall() {
      return { ok: true };
    },
    assistant: { threads: { setStatus: async (input: { status: string }) => {
      statuses.push(input.status);
      return { ok: true };
    } } },
  } as unknown as WebClient;
  const state: SlackPresentationStatePort = {
    getRunPresentation: (id) => store.get(id),
    getLatestThreadSessionGeneration: (root) => store.getLatestThreadSessionGeneration(root),
    transitionRunPresentation: (input) => store.transition(input),
    reserveSlackAppend: (workspaceId) => store.reserveAppend(workspaceId),
    applySlackAppendCooldown: (workspaceId, retryAfterMs) =>
      store.applyAppendCooldown(workspaceId, retryAfterMs),
    matchFlueObservation: () => undefined,
  };
  const admit = (runId: string, sessionGeneration: number) => store.create({
    schemaVersion: 3,
    runId,
    turnJobId: `turn_${runId}`,
    bindingId: `binding_${runId}`,
    workBindingGeneration: 1,
    runFencingToken: 0,
    root: ROOT,
    owner: { kind: 'chickpea' },
    sessionGeneration,
    currentActivity: {
      kind: THINKING.kind,
      action: THINKING.action,
      object: THINKING.object,
      generation: sessionGeneration,
      sequence: 1,
      operation: { operationId: `activity_${runId}_1`, certainty: 'pending' },
    },
  });
  const view = (runId: string) => new SlackAgentViewPresentation({
    client,
    state,
    runId,
    runFencingToken: 0,
    footer: { agentName: 'Chickpea', agentId: 'agent_chickpea' },
  });
  /** The turn driver's first durable step: show its admission status. */
  const showAdmissionStatus = (runId: string) => presentAdmittedSlackActivity({
    client,
    state,
    runId,
    runFencingToken: 0,
    ...ROOT,
    owner: { kind: 'chickpea' },
    agentId: 'agent_chickpea',
    activity: THINKING,
  });
  const apply = (runId: string, mutation: SlackPresentationMutation) => {
    const current = store.get(runId)!;
    const result = store.transition({
      runId,
      workBindingGeneration: current.workBindingGeneration,
      runFencingToken: current.runFencingToken,
      expectedProjectionVersion: current.projectionVersion,
      expectedStreamState: current.stream.state,
      mutation,
    });
    assert.equal(result.outcome, 'applied');
  };
  return { db, store, statuses, admit, view, showAdmissionStatus, apply };
}

async function writeStatus(view: SlackAgentViewPresentation, object: string) {
  const write = await view.beginActivity(
    activityStatus('checking', 'Searching', object),
    'assistant_status',
  );
  if (write) await view.recordActivityReceipt(write.operationId, 'acknowledged');
  return write;
}

test('a running turn keeps its status behind a queued turn and yields once that turn starts', async (t) => {
  const info = t.mock.method(console, 'info', () => {});
  const fencedEvents = () => info.mock.calls
    .map((call) => String(call.arguments[0]))
    .filter((line) => line.includes('"outcome":"fenced"'));
  for (const start of ['native_indicator', 'admission_status'] as const) {
    info.mock.resetCalls();
    const h = harness();
    try {
      h.admit('run_running', G);
      assert.equal(await h.showAdmissionStatus('run_running'), true);
      const running = h.view('run_running');

      h.admit('run_queued', G + 1);
      assert.ok(await writeStatus(running, 'the web'),
        'a turn that only queued has shown nothing, so it does not fence the running turn');
      assert.deepEqual(fencedEvents(), []);

      if (start === 'native_indicator') {
        assert.equal(await h.view('run_queued').beginAgentSessionProcessing(), true);
      } else {
        assert.equal(await h.showAdmissionStatus('run_queued'), true);
      }
      assert.equal(await writeStatus(running, 'the docs'), undefined,
        `${start}: a started newer turn owns the thread status`);
      assert.deepEqual(fencedEvents().map((line) => JSON.parse(line.slice(line.indexOf('{')))), [{
        schemaVersion: 1,
        event: 'activity.transport',
        surface: 'assistant_status',
        outcome: 'fenced',
        family: 'unknown',
        phase: 'working',
      }], 'the refusal is visible in the Worker log, without content');
    } finally {
      h.db.close();
    }
  }
});

test('an ending turn clears its status behind a queued turn but not behind a started one', async () => {
  const h = harness();
  try {
    h.admit('run_ending', G);
    assert.equal(await h.showAdmissionStatus('run_ending'), true);
    h.apply('run_ending', {
      kind: 'record_terminal_delivery_intent', operationId: 'terminal_run_ending', result: 'answer',
    });
    h.apply('run_ending', {
      kind: 'record_terminal_delivery_receipt',
      operationId: 'terminal_run_ending',
      certainty: 'acknowledged',
    });
    const ending = h.view('run_ending');

    h.admit('run_queued', G + 1);
    assert.equal((await ending.prepareActivityCleanup()).kind, 'prepared');

    assert.equal(await h.view('run_queued').beginAgentSessionProcessing(), true);
    assert.equal((await ending.prepareActivityCleanup()).kind, 'fenced');
  } finally {
    h.db.close();
  }
});

test('a folded turn shows its status while the follow-ups it absorbed stay admitted', async () => {
  const h = harness();
  try {
    h.admit('run_head', G);
    h.admit('run_member_1', G + 1);
    h.admit('run_member_2', G + 2);

    assert.equal(await h.showAdmissionStatus('run_head'), true);
    assert.equal(h.statuses.length, 1);
    assert.ok(await writeStatus(h.view('run_head'), 'the web'));
  } finally {
    h.db.close();
  }
});

test('the thread generation fence counts only turns that started', async () => {
  const h = harness();
  try {
    h.admit('run_queued_1', G + 1);
    h.admit('run_queued_2', G + 2);
    assert.equal(h.store.getLatestThreadSessionGeneration(ROOT), undefined,
      'queued turns alone own nothing');

    h.admit('run_started', G);
    assert.equal(await h.view('run_started').beginAgentSessionProcessing(), true);
    assert.equal(h.store.getLatestThreadSessionGeneration(ROOT), G);

    assert.equal(await h.showAdmissionStatus('run_queued_1'), true);
    assert.equal(h.store.getLatestThreadSessionGeneration(ROOT), G + 1,
      'an admission status that reached Slack counts as shown');

    h.store.settleUnstarted('run_queued_2');
    assert.equal(h.store.getLatestThreadSessionGeneration(ROOT), G + 1,
      'a turn closed without running (stopped or folded) never started');
  } finally {
    h.db.close();
  }
});
