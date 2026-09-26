import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { activityStatus } from '../src/activity/semantic.ts';
import {
  CODING_WORKER_STARTED_STATUS,
  CODING_WORKSPACE_SETUP_STATUS,
  SLACK_LOADING_MESSAGE_MAX,
  createCodingTaskProgress,
} from '../src/slack/coding-task-progress.ts';
import type { WorkspaceMilestoneRecord } from '../src/slack/coding-worker-run.ts';
import { SlackStatusRegistry, registerSlackStatusTurn } from '../src/slack/status-registry.ts';
import { WebClientPresenter } from '../src/slack/web-client-presenter.ts';

const START = 1_785_700_000_000;

function milestone(
  name: WorkspaceMilestoneRecord['milestone'],
  state: WorkspaceMilestoneRecord['state'],
  toolCallId = 'call_a',
): WorkspaceMilestoneRecord {
  return { schemaVersion: 1, toolCallId, milestone: name, state };
}

const CLONING = activityStatus('running', 'Cloning', 'the repository', 'workspace');
const INSTALLING = activityStatus('running', 'Installing', 'dependencies', 'workspace');
const EDITING = activityStatus('writing', 'Editing files in', 'the coding workspace', 'workspace');
const RUNNING_TESTS = activityStatus('running', 'Running', 'the test suite', 'workspace');
const COMMITTING = activityStatus('finishing', 'Committing', 'the changes', 'workspace');
const PUSHING = activityStatus('finishing', 'Pushing', 'the branch', 'workspace');
const OPENING_PR = activityStatus('finishing', 'Opening', 'the pull request', 'workspace');

/** No clock, no command text, path, branch, repository or identifier. */
const LEAK = /\d+ min\b|\d+ h\b|\/|\.ts\b|\bnpm\b|\bgit\b|feature\/|acme|call_|\bID\b/i;

test('milestones publish a phrase per step, once, and nothing once the task settled', () => {
  const progress = createCodingTaskProgress();
  assert.equal(progress.takeStatus(), undefined);
  progress.apply(milestone('workspace', 'started'));
  assert.equal(progress.active(), true);
  assert.equal(progress.takeStatus(), CODING_WORKSPACE_SETUP_STATUS);
  assert.equal(progress.takeStatus(), undefined, 'a phrase is published once');
  assert.equal(CODING_WORKSPACE_SETUP_STATUS.text, 'Setting up the coding workspace…');

  progress.apply(milestone('workspace', 'completed'));
  progress.apply(milestone('changes', 'started'));
  assert.equal(progress.takeStatus(), CODING_WORKER_STARTED_STATUS);
  assert.equal(CODING_WORKER_STARTED_STATUS.text, 'Working on the code changes…');
  // A replayed record never moves a task back.
  progress.apply(milestone('workspace', 'started'));
  assert.equal(progress.takeStatus(), undefined);

  progress.apply(milestone('changes', 'changed'));
  progress.apply(milestone('pull_request', 'completed'));
  assert.equal(progress.active(), false);
  assert.equal(progress.takeStatus(), undefined);
  assert.equal(progress.display(RUNNING_TESTS), undefined, 'the coordinator renders as usual again');
  // A settled task replayed from the start stays settled.
  progress.apply(milestone('workspace', 'started'));
  assert.equal(progress.active(), false);
});

test('a reattached turn replaying a finished task publishes nothing for it', () => {
  const progress = createCodingTaskProgress();
  for (const record of [
    milestone('workspace', 'started'),
    milestone('workspace', 'completed'),
    milestone('changes', 'started'),
    milestone('changes', 'failed'),
    milestone('pull_request', 'not_run'),
  ]) progress.apply(record);
  assert.equal(progress.takeStatus(), undefined);
  assert.equal(progress.active(), false);
});

test('each distinct milestone record counts once, by its position in the reply', () => {
  const records = [
    milestone('workspace', 'started'),
    milestone('workspace', 'completed'),
    milestone('changes', 'started'),
    milestone('changes', 'changed'),
    milestone('pull_request', 'completed'),
  ];
  const progress = createCodingTaskProgress();
  assert.equal(progress.applied(), 0);
  for (const [index, record] of records.entries()) {
    progress.apply(record);
    assert.equal(progress.applied(), index + 1);
  }
  // A record read twice is one record; a settled task's records still count.
  progress.apply(milestone('changes', 'started'));
  assert.equal(progress.applied(), 5);
  progress.apply(milestone('workspace', 'started', 'call_b'));
  assert.equal(progress.applied(), 6);

  // A reattached turn replays the same records in the same order, so the
  // count it reaches names the same records.
  const reattached = createCodingTaskProgress();
  for (const record of records.slice(0, 3)) reattached.apply(record);
  assert.equal(reattached.applied(), 3);
});

test('a second task in the same response keeps the indicator on until both settle', () => {
  const progress = createCodingTaskProgress();
  progress.apply(milestone('workspace', 'started', 'call_a'));
  progress.apply(milestone('workspace', 'completed', 'call_a'));
  progress.apply(milestone('workspace', 'started', 'call_b'));
  assert.equal(progress.takeStatus(), CODING_WORKSPACE_SETUP_STATUS, 'the newest task leads');
  progress.apply(milestone('changes', 'completed', 'call_b'));
  assert.equal(progress.active(), true);
  assert.equal(progress.takeStatus(), CODING_WORKER_STARTED_STATUS);
  progress.apply(milestone('changes', 'changed', 'call_a'));
  assert.equal(progress.active(), false);
});

test('the rotation grows with what the task has done and never shows a clock', () => {
  const progress = createCodingTaskProgress();
  progress.apply(milestone('workspace', 'started'));
  // Early: only the stage and the step are known.
  assert.deepEqual(progress.display(CODING_WORKSPACE_SETUP_STATUS), {
    status: 'Setting up the coding workspace…',
    loadingMessages: [
      'Setting up the coding workspace…',
      'Step 1 of 3 · Coding workspace',
      'Next: working on the code changes',
    ],
  });
  progress.apply(milestone('workspace', 'completed'));
  progress.apply(milestone('changes', 'started'));
  assert.deepEqual(progress.display(CODING_WORKER_STARTED_STATUS)!.loadingMessages, [
    'Working on the code changes…',
    'Step 2 of 3 · Code changes',
    'Workspace ready',
    'Next: opening the pull request',
  ]);
  // The worker's stages pass one by one; a refresh repeats a stage without
  // counting it again.
  progress.display(CLONING);
  progress.display(INSTALLING);
  progress.display(EDITING);
  progress.display(RUNNING_TESTS);
  progress.display(RUNNING_TESTS);
  assert.deepEqual(progress.display(COMMITTING), {
    status: 'Committing the changes…',
    loadingMessages: [
      'Committing the changes…',
      'Step 2 of 3 · Code changes',
      'Workspace ready',
      'Repository cloned',
      'Dependencies installed',
      'Test suite run',
      'Next: opening the pull request',
    ],
  });
  // A second round of tests and commits counts.
  progress.display(EDITING);
  progress.display(RUNNING_TESTS);
  progress.display(COMMITTING);
  progress.display(PUSHING);
  // Late: opening the pull request is step 3 and has nothing after it.
  assert.deepEqual(progress.display(OPENING_PR), {
    status: 'Opening the pull request…',
    loadingMessages: [
      'Opening the pull request…',
      'Step 3 of 3 · Pull request',
      'Workspace ready',
      'Repository cloned',
      'Dependencies installed',
      'Test suite run 2 times',
      '2 commits so far',
      'Branch pushed',
    ],
  });
  for (const update of [CODING_WORKSPACE_SETUP_STATUS, EDITING, RUNNING_TESTS, OPENING_PR]) {
    const display = progress.display(update)!;
    assert.ok(display.loadingMessages.length >= 1 && display.loadingMessages.length <= 10);
    assert.equal(new Set(display.loadingMessages).size, display.loadingMessages.length);
    for (const message of [display.status, ...display.loadingMessages]) {
      assert.ok(message.length <= SLACK_LOADING_MESSAGE_MAX, message);
      assert.doesNotMatch(message, LEAK, message);
    }
  }
});

test('the step never moves back once the pull request step has been shown', () => {
  const progress = createCodingTaskProgress();
  progress.apply(milestone('workspace', 'started'));
  progress.apply(milestone('workspace', 'completed'));
  progress.apply(milestone('changes', 'started'));
  progress.display(CLONING);
  progress.display(PUSHING);
  assert.equal(progress.display(OPENING_PR)!.loadingMessages[1], 'Step 3 of 3 · Pull request');
  // The coordinator reads the worker's result while the task is still running
  // (the live Violet sequence), then a replayed start record arrives.
  const reviewing = activityStatus('reading', 'Reviewing', 'the results', 'workspace');
  assert.deepEqual(progress.display(reviewing), {
    status: 'Reviewing the results…',
    loadingMessages: [
      'Reviewing the results…',
      'Step 3 of 3 · Pull request',
      'Workspace ready',
      'Repository cloned',
      'Branch pushed',
    ],
  });
  progress.apply(milestone('changes', 'started'));
  for (const update of [EDITING, RUNNING_TESTS, CODING_WORKER_STARTED_STATUS]) {
    const messages = progress.display(update)!.loadingMessages;
    assert.equal(messages[1], 'Step 3 of 3 · Pull request');
    assert.ok(!messages.some((message) => message.startsWith('Next:')), messages.join(' | '));
  }
});

test('a second task keeps its own step when the first reached the pull request', () => {
  const progress = createCodingTaskProgress();
  progress.apply(milestone('changes', 'started', 'call_a'));
  progress.display(OPENING_PR);
  progress.apply(milestone('workspace', 'started', 'call_b'));
  assert.equal(progress.display(CODING_WORKSPACE_SETUP_STATUS)!.loadingMessages[1],
    'Step 1 of 3 · Coding workspace');
});

test('a long stage phrase and a full history still fit Slack\'s limits', () => {
  const progress = createCodingTaskProgress();
  progress.apply(milestone('workspace', 'started'));
  progress.apply(milestone('workspace', 'completed'));
  progress.apply(milestone('changes', 'started'));
  const stages = [CLONING, INSTALLING, RUNNING_TESTS, COMMITTING, PUSHING];
  for (let round = 0; round < 12; round += 1) {
    for (const stage of stages) progress.display(stage);
  }
  const longer = activityStatus('running', 'Running commands in', 'the coding workspace', 'workspace');
  const display = progress.display(longer)!;
  assert.equal(display.status, 'Running commands in the coding workspace…');
  assert.equal(display.loadingMessages.length, 9);
  assert.ok(display.loadingMessages.includes('Test suite run 12 times'));
  assert.ok(display.loadingMessages.includes('12 commits so far'));
  assert.ok(display.loadingMessages.includes('Branch pushed 12 times'));
  for (const message of [display.status, ...display.loadingMessages]) {
    assert.ok(message.length <= SLACK_LOADING_MESSAGE_MAX, message);
  }
});

function statusClient() {
  const writes: Array<{ at: number; status: string; loadingMessages?: string[] }> = [];
  const client = {
    assistant: { threads: { async setStatus(input: Record<string, unknown>) {
      writes.push({
        at: Date.now(),
        status: String(input.status),
        ...(Array.isArray(input.loading_messages)
          ? { loadingMessages: input.loading_messages as string[] }
          : {}),
      });
      return { ok: true };
    } } },
  } as unknown as WebClient;
  return { client, writes };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('a 45-minute task refreshes its indicator every 90 s, writes only on a change, then clears once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
  const progress = createCodingTaskProgress();
  const { client, writes } = statusClient();
  const presenter = new WebClientPresenter(client, {
    channelId: 'D_PROGRESS',
    threadTs: '1785700000.000100',
    agentName: 'Chickpea',
    agentId: 'agent_default',
    userId: 'U_PROGRESS',
    workspaceId: 'T_PROGRESS',
  }, undefined, { statusDisplay: (update) => progress.display(update) });
  const turn = registerSlackStatusTurn('instance_progress', {
    setStatus: (update) => presenter.setStatus(update),
    refreshStatus: (update) => presenter.setStatus(update),
  }, { generation: 'turn_progress', telemetry: { info() {}, warn() {} } as never });

  progress.apply(milestone('workspace', 'started'));
  await turn.setStatus(progress.takeStatus()!);
  progress.apply(milestone('workspace', 'completed'));
  progress.apply(milestone('changes', 'started'));
  await turn.setStatus(progress.takeStatus()!);
  t.mock.timers.tick(30_000);
  await turn.setStatus(RUNNING_TESTS);
  // The same fact again is not a change and reaches Slack only as a refresh.
  await turn.setStatus(RUNNING_TESTS);
  assert.deepEqual(writes.map((write) => write.status), [
    'Setting up the coding workspace…',
    'Working on the code changes…',
    'Running the test suite…',
  ]);

  // The same fact is refreshed before Slack's two-minute expiry, with the
  // same rotation, and never more often than every 90 seconds.
  for (let elapsed = 30_000; elapsed < 45 * 60_000; elapsed += 10_000) {
    t.mock.timers.tick(10_000);
    await settle();
  }
  const refreshes = writes.slice(3);
  assert.ok(refreshes.length >= 28 && refreshes.length <= 30, `refreshes: ${refreshes.length}`);
  for (const [index, write] of refreshes.entries()) {
    const previous = index === 0 ? writes[2]! : refreshes[index - 1]!;
    assert.equal(write.at - previous.at, 90_000);
    assert.equal(write.status, 'Running the test suite…');
    assert.deepEqual(write.loadingMessages, [
      'Running the test suite…',
      'Step 2 of 3 · Code changes',
      'Workspace ready',
      'Next: opening the pull request',
    ]);
  }

  // The final supersedes the indicator: one clear, and no refresh after it.
  await turn.prepareFinal();
  await turn.finish(async () => { await presenter.clearStatus(); });
  const afterFinal = writes.length;
  assert.equal(writes.at(-1)!.status, '');
  for (let index = 0; index < 20; index += 1) {
    t.mock.timers.tick(60_000);
    await settle();
  }
  assert.equal(writes.length, afterFinal, 'nothing refreshes a finished turn');
});

test('a quiet coding task gives the thread to Slack\'s native indicator; the next stage brings the rotation back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
  const progress = createCodingTaskProgress();
  const { client, writes } = statusClient();
  const presenter = new WebClientPresenter(client, {
    channelId: 'D_QUIET',
    threadTs: '1785700000.000200',
    agentName: 'Chickpea',
    agentId: 'agent_default',
    userId: 'U_QUIET',
    workspaceId: 'T_QUIET',
  }, undefined, { statusDisplay: (update) => progress.display(update) });
  const native: number[] = [];
  const registry = new SlackStatusRegistry();
  const turn = registry.registerTurn('instance_quiet', {
    setStatus: (update) => presenter.setStatus(update),
    refreshStatus: (update) => presenter.setStatus(update),
    showNativeIndicator: async () => { native.push(Date.now()); return true; },
  }, { generation: 'turn_quiet', observedMinIntervalMs: 1, telemetry: { info() {} } });

  progress.apply(milestone('workspace', 'started'));
  turn.progress({ kind: 'milestone', sequence: progress.applied() });
  await turn.setStatus(progress.takeStatus()!);
  progress.apply(milestone('workspace', 'completed'));
  progress.apply(milestone('changes', 'started'));
  turn.progress({ kind: 'milestone', sequence: progress.applied() });
  await turn.setStatus(progress.takeStatus()!);
  // The worker's stage, relayed as observed activity, is progress.
  registry.setObservedStatus('instance_quiet', 'turn_quiet', RUNNING_TESTS);
  await settle();
  const busyWrites = writes.length;

  // One long test run with no further event: five minutes on, the status
  // line gives way to the native indicator instead of repeating the phrase.
  for (let elapsed = 0; elapsed < 20 * 60_000; elapsed += 10_000) {
    t.mock.timers.tick(10_000);
    await settle();
  }
  assert.deepEqual(native, [START + 5 * 60_000]);
  const quietWrites = writes.filter((write) => write.at > START + 5 * 60_000);
  assert.deepEqual(quietWrites, [], 'nothing custom is written while the run is quiet');
  assert.equal(busyWrites, 3);
  assert.equal(registry.runFactsView('turn_quiet')?.quietFor, '15+');

  // The next stage: the rotation returns and shows what the task has done.
  registry.setObservedStatus('instance_quiet', 'turn_quiet', COMMITTING);
  await settle();
  assert.deepEqual(writes.at(-1), {
    at: START + 20 * 60_000,
    status: 'Committing the changes…',
    loadingMessages: [
      'Committing the changes…',
      'Step 2 of 3 · Code changes',
      'Workspace ready',
      'Test suite run',
      'Next: opening the pull request',
    ],
  });
  for (const write of writes) {
    for (const line of [write.status, ...(write.loadingMessages ?? [])]) assert.doesNotMatch(line, LEAK, line);
  }
  await turn.prepareFinal();
  await turn.finish(async () => { await presenter.clearStatus(); });
});
