import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WebClient } from '@slack/web-api';

import {
  deliverRoutineFailureNotice,
  deliverRoutineResult,
  renderRoutineDelivery,
} from '../src/routines/delivery.ts';
import { RoutineRuntimeError } from '../src/routines/runtime.ts';
import type {
  ClaimRoutineDeliveryInput,
  RecordRoutineDeliveryInput,
  RoutineDefinition,
  RoutineRun,
  RoutineStore,
} from '../src/routines/types.ts';
import type { ShadowWorkLifecycle } from '../src/work/lifecycle.ts';

const routine = {
  id: 'routine_test', name: '<Daily & write>', channelId: 'C_TEST', timezone: 'UTC',
} as RoutineDefinition;
const run = { id: 'rrun_test', scheduledFor: Date.UTC(2026, 6, 27, 16) } as RoutineRun;
const access = {
  config: {
    agentId: 'agent_default',
    model: 'anthropic/claude-sonnet-4',
    agent: { name: 'Default' },
  } as never,
  accessHash: 'a'.repeat(64),
  botToken: 'xoxb-test',
  botUserId: 'U_BOT',
  publicUrl: 'https://chickpea.example',
};

function store(events: string[]): RoutineStore {
  return {
    claimDelivery: async () => { events.push('claim'); return 'claimed'; },
    recordDelivery: async (input: RecordRoutineDeliveryInput) => {
      events.push(`record:${input.outcome}:${input.messageTs ?? ''}`);
      return run;
    },
  } as unknown as RoutineStore;
}

test('routine delivery claims once, posts at top level, and records the Slack receipt', async () => {
  const events: string[] = [];
  const requests: Array<Record<string, string>> = [];
  const client = new WebClient('xoxb-test', {
    slackApiUrl: 'https://slack.invalid/api/', retryConfig: { retries: 0 },
    fetch: async (_url, init) => {
      requests.push(Object.fromEntries(new URLSearchParams(String(init?.body ?? ''))));
      return new Response(JSON.stringify({ ok: true, channel: 'C_TEST', ts: '1785000000.000100' }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const receipt = await deliverRoutineResult({
    store: store(events), run, routine, access, message: 'Completed the write.',
    changeKeyHash: 'b'.repeat(64), now: () => 1_000,
  }, client);
  assert.deepEqual(receipt, { channelId: 'C_TEST', messageTs: '1785000000.000100' });
  assert.deepEqual(events, ['claim', 'record:delivered:1785000000.000100']);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.channel, 'C_TEST');
  assert.equal(requests[0]?.thread_ts, undefined);
  assert.match(requests[0]?.text ?? '', /Completed the write/);
  assert.doesNotMatch(requests[0]?.blocks ?? '', /rrun_test|!routines show/);
  assert.match(requests[0]?.blocks ?? '', /View in Audit/);
  assert.match(requests[0]?.blocks ?? '', /anthropic\/claude-sonnet-4/);
  const rendered = renderRoutineDelivery(routine, run, 'Done.', {
    profileName: 'Default', modelLabel: 'anthropic/claude-sonnet-4',
    agentId: 'agent_default', publicUrl: 'https://chickpea.example',
  });
  assert.equal(rendered.text, 'Routine completed: &lt;Daily &amp; write&gt;\n\nDone.');
  assert.deepEqual(rendered.blocks?.at(-2), {
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: 'Scheduled Jul 27 at 4:00 PM UTC · <https://chickpea.example/admin/audit-logs/scheduled-work/routine_test|View in Audit>',
    }],
  });
  assert.match(JSON.stringify(rendered.blocks?.at(-1)), /Default.*anthropic\/claude-sonnet-4.*Configure/);
});

test('delivery derives its lease from one clock read', async () => {
  let clock = 1_000;
  let claim: ClaimRoutineDeliveryInput | undefined;
  const advancingStore = {
    claimDelivery: async (input: ClaimRoutineDeliveryInput) => {
      claim = input;
      return 'claimed' as const;
    },
    recordDelivery: async () => run,
  } as unknown as RoutineStore;
  const client = new WebClient('xoxb-test', {
    slackApiUrl: 'https://slack.invalid/api/', retryConfig: { retries: 0 },
    fetch: async () => new Response(
      JSON.stringify({ ok: true, channel: 'C_TEST', ts: '1785000000.000300' }),
      { headers: { 'content-type': 'application/json' } },
    ),
  });

  await deliverRoutineResult({
    store: advancingStore, run, routine, access, message: 'Done.',
    changeKeyHash: null, now: () => clock++,
  }, client);

  assert.equal(claim?.at, 1_000);
  assert.equal(claim?.leaseUntil - claim?.at, 2 * 60 * 1_000);
});

test('an ambiguous Slack failure records unknown and is never retried', async () => {
  const events: string[] = [];
  let requests = 0;
  const client = new WebClient('xoxb-test', {
    slackApiUrl: 'https://slack.invalid/api/', retryConfig: { retries: 0 },
    fetch: async () => { requests += 1; throw new Error('socket closed after send'); },
  });
  await assert.rejects(
    () => deliverRoutineResult({
      store: store(events), run, routine, access, message: 'Maybe posted.',
      changeKeyHash: null, now: () => 1_000,
    }, client),
    (error: unknown) => error instanceof RoutineRuntimeError && error.failureClass === 'delivery_unknown',
  );
  assert.equal(requests, 1);
  assert.deepEqual(events, ['claim', 'record:unknown:']);
});

test('terminal notices point to safe history and share the same dedupe lease', async () => {
  const events: string[] = [];
  let posted = '';
  let blocks = '';
  const client = new WebClient('xoxb-test', {
    slackApiUrl: 'https://slack.invalid/api/', retryConfig: { retries: 0 },
    fetch: async (_url, init) => {
      const body = new URLSearchParams(String(init?.body ?? ''));
      posted = body.get('text') ?? '';
      blocks = body.get('blocks') ?? '';
      return new Response(JSON.stringify({ ok: true, channel: 'C_TEST', ts: '1785000000.000200' }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  await deliverRoutineFailureNotice({
    store: store(events), run, routine: { ...routine, state: 'paused' }, access,
    publicError: 'The routine stopped safely.', now: () => 2_000,
  }, client);
  assert.match(posted, /Automatic scheduling is paused/);
  assert.doesNotMatch(blocks, /rrun_test|!routines show|`routine_test`/);
  assert.match(blocks, /View in Audit/);
  assert.match(blocks, /anthropic\/claude-sonnet-4/);
  assert.deepEqual(events, ['claim', 'record:delivered:1785000000.000200']);
});

test('routine render is durable before Slack and the receipt settles the same Work attempt', async () => {
  const events: string[] = [];
  const workLifecycle = {
    async beforeDelivery(input: { approvedOutput: string; renderedPayload: string }) {
      events.push('work:before');
      assert.equal(input.approvedOutput, 'Canonical routine output');
      assert.match(input.renderedPayload, /slack_chat_post_message/);
      return 'delivery_routine_work';
    },
    async afterDelivery(input: { outcome: string; deliveryRef?: string }) {
      events.push(`work:after:${input.outcome}:${input.deliveryRef ?? ''}`);
    },
  } as unknown as ShadowWorkLifecycle;
  const client = new WebClient('xoxb-test', {
    slackApiUrl: 'https://slack.invalid/api/', retryConfig: { retries: 0 },
    fetch: async () => {
      events.push('slack:post');
      return new Response(
        JSON.stringify({ ok: true, channel: 'C_TEST', ts: '1785000000.000700' }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  await deliverRoutineResult({
    store: store(events),
    run,
    routine,
    access,
    message: 'Canonical routine output',
    changeKeyHash: null,
    workLifecycle,
    now: () => 3_000,
  }, client);
  assert.deepEqual(events, [
    'claim',
    'work:before',
    'slack:post',
    'record:delivered:1785000000.000700',
    'work:after:delivered:slack:C_TEST:1785000000.000700',
  ]);
});
