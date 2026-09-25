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
import { registerSlackStatusTurn } from '../src/slack/status-registry.ts';
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
