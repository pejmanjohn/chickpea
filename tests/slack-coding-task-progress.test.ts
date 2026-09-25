import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { activityStatus } from '../src/activity/semantic.ts';
import {
  CODING_WORKER_STARTED_STATUS,
  CODING_WORKSPACE_SETUP_STATUS,
  SLACK_LOADING_MESSAGE_MAX,
  createCodingTaskProgress,
  elapsedLabel,
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

const RUNNING_TESTS = activityStatus('running', 'Running', 'the test suite', 'workspace');
const OPENING_PR = activityStatus('finishing', 'Opening', 'the pull request', 'workspace');

test('elapsed time reads in whole minutes and hours', () => {
  assert.equal(elapsedLabel(59_999), undefined);
  assert.equal(elapsedLabel(60_000), '1 min');
  assert.equal(elapsedLabel(12 * 60_000 + 59_000), '12 min');
  assert.equal(elapsedLabel(60 * 60_000), '1 h');
  assert.equal(elapsedLabel(75 * 60_000), '1 h 15 min');
  assert.equal(elapsedLabel(-5), undefined);
});

test('milestones publish a phrase per step, once, and nothing once the task settled', () => {
  const progress = createCodingTaskProgress({ startedAt: START, now: () => START });
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
  const progress = createCodingTaskProgress({ startedAt: START });
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
  const progress = createCodingTaskProgress({ startedAt: START });
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

test('the working indicator shows the step, the elapsed time, and fits Slack\'s limits', () => {
  let now = START;
  const progress = createCodingTaskProgress({ startedAt: START, now: () => now });
  progress.apply(milestone('workspace', 'started'));
  assert.deepEqual(progress.display(CODING_WORKSPACE_SETUP_STATUS), {
    status: 'Setting up the coding workspace…',
    loadingMessages: ['Setting up the coding workspace…', 'Step 1 of 3 · Coding workspace'],
  });
  progress.apply(milestone('workspace', 'completed'));
  progress.apply(milestone('changes', 'started'));
  now = START + 12 * 60_000 + 30_000;
  assert.deepEqual(progress.display(RUNNING_TESTS), {
    status: 'Running the test suite · 12 min',
    loadingMessages: ['Running the test suite · 12 min', 'Step 2 of 3 · Code changes'],
  });
  now = START + 38 * 60_000;
  assert.deepEqual(progress.display(OPENING_PR), {
    status: 'Opening the pull request · 38 min',
    loadingMessages: ['Opening the pull request · 38 min', 'Step 3 of 3 · Pull request'],
  });
  now = START + 72 * 60_000;
  const long = activityStatus('reading', 'Reading code in', 'the coding workspace', 'workspace');
  const shown = progress.display(long)!;
  assert.equal(shown.status, 'Reading code in the coding workspace · 1 h 12 min');
  const longer = activityStatus('running', 'Running commands in', 'the coding workspace', 'workspace');
  assert.equal(progress.display(longer)!.status, 'Running commands in the coding workspace…',
    'a line too long for the elapsed time keeps the step phrase');
  for (const update of [RUNNING_TESTS, OPENING_PR, long, longer]) {
    const display = progress.display(update)!;
    assert.ok(display.loadingMessages.length >= 1 && display.loadingMessages.length <= 10);
    for (const message of [display.status, ...display.loadingMessages]) {
      assert.ok(message.length <= SLACK_LOADING_MESSAGE_MAX, message);
    }
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

test('a 45-minute task refreshes its indicator every 90 s with the current time, then clears once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
  const progress = createCodingTaskProgress({ startedAt: START });
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
  assert.deepEqual(writes.map((write) => write.status), [
    'Setting up the coding workspace…',
    'Working on the code changes…',
    'Running the test suite…',
  ]);

  // The same fact is refreshed before Slack's two-minute expiry, with the
  // current elapsed time, and never more often than every 90 seconds.
  for (let elapsed = 30_000; elapsed < 45 * 60_000; elapsed += 10_000) {
    t.mock.timers.tick(10_000);
    await settle();
  }
  const refreshes = writes.slice(3);
  assert.ok(refreshes.length >= 28 && refreshes.length <= 30, `refreshes: ${refreshes.length}`);
  for (const [index, write] of refreshes.entries()) {
    const previous = index === 0 ? writes[2]! : refreshes[index - 1]!;
    assert.equal(write.at - previous.at, 90_000);
    assert.match(write.status, /^Running the test suite · \d+ min$/);
    assert.deepEqual(write.loadingMessages, [write.status, 'Step 2 of 3 · Code changes']);
  }
  assert.equal(refreshes.at(-1)!.status, 'Running the test suite · 44 min');

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
