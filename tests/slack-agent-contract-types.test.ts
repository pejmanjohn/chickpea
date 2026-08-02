import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { PlanBlock, TaskCardBlock } from '@slack/types';
import type {
  AssistantThreadsSetStatusArguments,
  AssistantThreadsSetTitleArguments,
  ChatAppendStreamArguments,
  ChatStartStreamArguments,
  ChatStopStreamArguments,
} from '@slack/web-api';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const task: TaskCardBlock = {
  type: 'task_card',
  task_id: 'task_1',
  title: 'Inspect the account',
  status: 'pending',
};
const plan: PlanBlock = { type: 'plan', title: 'Account review', tasks: [task] };
const start: ChatStartStreamArguments = {
  channel: 'D_AGENT',
  thread_ts: '1783000000.000100',
  chunks: [{ type: 'markdown_text', text: 'Starting.' }],
  task_display_mode: 'plan',
};
const append: ChatAppendStreamArguments = {
  channel: start.channel,
  ts: '1783000000.000200',
  chunks: [
    { type: 'task_update', id: task.task_id, title: task.title, status: 'in_progress' },
  ],
};
const stop: ChatStopStreamArguments = {
  channel: start.channel,
  ts: append.ts,
  chunks: [{ type: 'blocks', blocks: [plan] }],
};
const status: AssistantThreadsSetStatusArguments = {
  channel_id: start.channel,
  thread_ts: start.thread_ts,
  status: 'Working',
};
const title: AssistantThreadsSetTitleArguments = {
  channel_id: start.channel,
  thread_ts: start.thread_ts,
  title: 'Account review',
};

test('stable Slack 8 types retain streams, native tasks, status, and title contracts', () => {
  const packageJson = JSON.parse(
    readFileSync(`${ROOT}/node_modules/@slack/web-api/package.json`, 'utf8'),
  ) as { version?: unknown };

  assert.equal(packageJson.version, '8.0.0');
  assert.equal(start.chunks?.[0]?.type, 'markdown_text');
  assert.equal(append.chunks?.[0]?.type, 'task_update');
  assert.equal(stop.chunks?.[0]?.type, 'blocks');
  assert.equal(plan.tasks?.[0]?.type, 'task_card');
  assert.equal(status.status, 'Working');
  assert.equal(title.title, 'Account review');
});
