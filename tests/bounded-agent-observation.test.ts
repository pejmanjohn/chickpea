import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AgentInstanceNotFoundError } from '@flue/runtime';

import {
  AgentObjectBindingUnavailableError,
  CHICKPEA_SLACK_AGENT_BINDING,
  createBoundedAgentReplyReader,
  createCloudflareBoundedAgentReplyReader,
  observeAgentSettlementBounded,
  type AgentUpdatesRoute,
} from '../src/slack/bounded-agent-observation.ts';
import { WORKSPACE_MILESTONE_DATA_NAME } from '../src/slack/coding-worker-run.ts';
import { createWorkspaceMilestoneRelay } from '../src/slack/workspace-milestone-relay.ts';

/**
 * Pages use the real updates-view protocol: Flue prepends a
 * `stream-checkpoint` to every page, so an idle page is checkpoint-only with
 * an unchanged cursor, and a caught-up page carries `Stream-Up-To-Date`.
 */
const CHECKPOINT = { type: 'stream-checkpoint', incarnation: 1 };

interface Page {
  items?: unknown[];
  next?: string;
  upToDate?: boolean;
  status?: number;
  body?: unknown;
}

function fakeRoute(pages: Page[]) {
  const requests: URL[] = [];
  const route: AgentUpdatesRoute = async (request) => {
    requests.push(new URL(request.url));
    const page = pages.shift();
    if (!page) throw new Error('unexpected extra read');
    if (page.status && page.status !== 200) {
      return Response.json(page.body ?? {}, { status: page.status });
    }
    return Response.json([CHECKPOINT, ...(page.items ?? [])], {
      headers: {
        ...(page.next ? { 'Stream-Next-Offset': page.next } : {}),
        ...(page.upToDate ? { 'Stream-Up-To-Date': 'true' } : {}),
      },
    });
  };
  return { route, requests };
}

const TARGET = { agentName: 'chickpea-slack-v2', instanceId: 'agent_1', submissionId: 'sub_1' };

function settled(submissionId = 'sub_1', outcome = 'completed') {
  return { type: 'submission-settled', submissionId, outcome };
}

test('checkpoint-only idle pages with an unchanged cursor sleep between reads', async () => {
  // The reviewer's production-shape reproducer: two idle pages, then settlement.
  const { route, requests } = fakeRoute([
    { next: '0_7', upToDate: true },
    { next: '0_7', upToDate: true },
    { items: [settled()], next: '0_8' },
  ]);
  const sleeps: number[] = [];
  const settlement = await observeAgentSettlementBounded(route, TARGET, {
    pollIntervalMs: 250, sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.deepEqual(settlement, { outcome: 'completed' });
  assert.equal(requests.length, 3);
  assert.deepEqual(sleeps, [250, 250], 'every caught-up page without settlement waits');
  assert.deepEqual(requests.map((url) => url.searchParams.get('offset')), ['-1', '0_7', '0_7']);
});

test('idle pages sleep even when the route omits the up-to-date header', async () => {
  const { route } = fakeRoute([
    { next: '0_7' },
    { next: '0_7' },
    { items: [settled()], next: '0_8' },
  ]);
  const sleeps: number[] = [];
  await observeAgentSettlementBounded(route, TARGET, { sleep: async (ms) => { sleeps.push(ms); } });
  // The first read from -1 moves the cursor to the head; the second does not.
  assert.deepEqual(sleeps, [750]);
});

test('continuously arriving data never busy-loops and lagging pages drain at once', async () => {
  const delta = (text: string) => ({ type: 'message-delta', kind: 'text', delta: text });
  const { route, requests } = fakeRoute([
    { items: [delta('a')], next: '0_1', upToDate: true },
    { items: [delta('b')], next: '0_2', upToDate: true },
    { items: [delta('c')], next: '0_3' },
    { items: [delta('d')], next: '0_4' },
    { items: [delta('e'), settled()], next: '0_6', upToDate: true },
  ]);
  const sleeps: number[] = [];
  const events: string[] = [];
  await observeAgentSettlementBounded(route, {
    ...TARGET,
    onEvent: (chunk) => events.push((chunk as { type: string; delta?: string }).delta ?? chunk.type),
  }, { pollIntervalMs: 100, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(requests.length, 5);
  for (const url of requests) {
    assert.equal(url.pathname, '/agents/chickpea-slack-v2/agent_1');
    assert.equal(url.searchParams.get('view'), 'updates');
    assert.equal(url.searchParams.has('live'), false, 'never a long-poll');
  }
  assert.deepEqual(sleeps, [100, 100], 'caught-up pages pace; lagging pages read again immediately');
  assert.deepEqual(events, ['a', 'b', 'c', 'd', 'e', 'submission-settled'], 'checkpoints are not events');
  assert.deepEqual(requests.map((url) => url.searchParams.get('offset')), ['-1', '0_1', '0_2', '0_3', '0_4']);
});

test('settlement is recognized only for the observed submission, in both projected forms', async () => {
  const other = await observeAgentSettlementBounded(fakeRoute([
    { items: [settled('sub_other')], next: '0_1', upToDate: true },
    { items: [settled('sub_1', 'failed')], next: '0_2' },
  ]).route, TARGET, { sleep: async () => {} });
  assert.deepEqual(other, { outcome: 'failed' });

  const failed = await observeAgentSettlementBounded(fakeRoute([
    { items: [{ ...settled('sub_1', 'failed'), error: { type: 'operation_failed' } }] },
  ]).route, TARGET, { sleep: async () => {} });
  assert.deepEqual(failed, { outcome: 'failed', error: { type: 'operation_failed' } });

  const reset = await observeAgentSettlementBounded(fakeRoute([
    { items: [{ type: 'conversation-reset', snapshot: { settlements: [{ submissionId: 'sub_1', outcome: 'aborted' }] } }] },
  ]).route, TARGET, { sleep: async () => {} });
  assert.deepEqual(reset, { outcome: 'aborted' });
});

test('a missing stream and an abort surface as errors without further reads', async () => {
  await assert.rejects(
    observeAgentSettlementBounded(fakeRoute([
      { status: 404, body: { error: { type: 'stream_not_found' } } },
    ]).route, TARGET, { sleep: async () => {} }),
    (error: unknown) => error instanceof AgentInstanceNotFoundError,
  );
  await assert.rejects(
    observeAgentSettlementBounded(fakeRoute([{ status: 503 }]).route, TARGET, { sleep: async () => {} }),
    { message: 'Bounded agent observation for "chickpea-slack-v2" failed with status 503.' },
  );

  const controller = new AbortController();
  const stop = new Error('stop');
  const { route, requests } = fakeRoute([{ next: '0_1', upToDate: true }, { next: '0_1', upToDate: true }]);
  await assert.rejects(
    observeAgentSettlementBounded(route, { ...TARGET, signal: controller.signal },
      { sleep: async () => { controller.abort(stop); } }),
    (error: unknown) => error === stop,
  );
  assert.equal(requests.length, 1);
});

test('the reply reader observes to settlement, then reads once through Flue', async () => {
  const { route, requests } = fakeRoute([
    { next: '0_1', upToDate: true },
    { items: [{ type: 'message-delta', kind: 'text', delta: 'x' }, settled('sub_9')], next: '0_3' },
  ]);
  const reads: unknown[] = [];
  const handle = {
    async read(receipt: unknown) {
      reads.push(receipt);
      return { text: 'final', data: {}, submissionId: 'sub_9' };
    },
  };
  const seen: string[] = [];
  const reader = createBoundedAgentReplyReader({
    agentName: 'chickpea-slack-v2',
    resolveRoute: (instanceId) => { assert.equal(instanceId, 'agent_9'); return route; },
    pollIntervalMs: 1,
    sleep: async () => {},
  });
  const reply = await reader({
    handle, instanceId: 'agent_9',
    receipt: { submissionId: 'sub_9', acceptedAt: 'now', uid: 'uid' },
    onEvent: (chunk) => seen.push(chunk.type),
  });
  assert.equal(reply.text, 'final');
  assert.equal(requests.length, 2);
  assert.deepEqual(seen, ['message-delta', 'submission-settled']);
  assert.deepEqual(reads, [{ submissionId: 'sub_9', acceptedAt: 'now', uid: 'uid' }],
    'Flue read runs once, after settlement, with no event callback to long-poll for');
});

test('the Cloudflare reader reaches the agent namespace binding and fails clearly without it', async () => {
  // Pinned to the binding Flue generates for the Slack agent (wrangler durable_objects).
  assert.equal(CHICKPEA_SLACK_AGENT_BINDING, 'FLUE_CHICKPEA_SLACK_V2_AGENT');
  assert.throws(() => createCloudflareBoundedAgentReplyReader({}), AgentObjectBindingUnavailableError);
  assert.throws(() => createCloudflareBoundedAgentReplyReader(undefined), AgentObjectBindingUnavailableError);
  assert.throws(
    () => createCloudflareBoundedAgentReplyReader({ FLUE_CHICKPEA_SLACK_V2_AGENT: { fetch() {} } }),
    AgentObjectBindingUnavailableError,
  );

  const { route, requests } = fakeRoute([{ items: [settled('sub_c')], next: '0_1' }]);
  const calls: string[] = [];
  const namespace = {
    idFromName: (name: string) => { calls.push(`idFromName:${name}`); return { name }; },
    get: (id: { name: string }) => { calls.push(`get:${id.name}`); return { fetch: route }; },
  };
  const reader = createCloudflareBoundedAgentReplyReader({ FLUE_CHICKPEA_SLACK_V2_AGENT: namespace });
  const reply = await reader({
    handle: { read: async () => ({ text: 'ok', data: {}, submissionId: 'sub_c' }) },
    instanceId: 'agent_c',
    receipt: { submissionId: 'sub_c', acceptedAt: 'now', uid: 'uid' },
    onEvent: () => {},
  });
  assert.equal(reply.text, 'ok');
  assert.deepEqual(calls, ['idFromName:agent_c', 'get:agent_c']);
  assert.equal(requests[0]?.searchParams.has('live'), false);
});

/** A fake clock the fake sleep advances, so idle time is measured in sleeps. */
function fakeClock() {
  let time = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => time,
    sleep: async (ms: number) => { sleeps.push(ms); time += ms; },
  };
}

function idlePages(count: number, next = '0_2'): Page[] {
  return Array.from({ length: count }, () => ({ next, upToDate: true }));
}

function milestoneStart(messageId = 'msg_1') {
  return {
    type: 'data-part',
    messageId,
    name: WORKSPACE_MILESTONE_DATA_NAME,
    data: { schemaVersion: 1, toolCallId: 'call_1', milestone: 'changes', state: 'started' },
  };
}

test('adaptive polling backs off after 10 s of quiet following a milestone start, and caps', async () => {
  const relay = createWorkspaceMilestoneRelay('sub_1', async () => {});
  const { route, requests } = fakeRoute([
    { items: [{ type: 'message-started', submissionId: 'sub_1', messageId: 'msg_1' }, milestoneStart()], next: '0_2', upToDate: true },
    ...idlePages(17),
    { items: [settled()], next: '0_3' },
  ]);
  const clock = fakeClock();
  const settlement = await observeAgentSettlementBounded(route, {
    ...TARGET, onEvent: relay.onEvent, isIdleCandidate: relay.isIdleCandidate,
  }, { adaptive: {}, sleep: clock.sleep, now: clock.now });
  assert.deepEqual(settlement, { outcome: 'completed' });
  assert.equal(requests.length, 19);
  // Quiet since t=0: reads at t < 10 s keep the 750 ms cadence, then it doubles to the 5 s ceiling.
  assert.deepEqual(clock.sleeps, [...Array(14).fill(750), 1500, 3000, 5000, 5000]);
  await relay.drain();
});

test('a delivered chunk returns the adaptive poll to the base interval', async () => {
  let hint = true;
  const delta = { type: 'message-delta', kind: 'text', delta: 'x' };
  const { route } = fakeRoute([
    { next: '0_1', upToDate: true },
    ...idlePages(15, '0_1'),
    { items: [delta], next: '0_2', upToDate: true },
    ...idlePages(2),
    { items: [settled()], next: '0_3' },
  ]);
  const clock = fakeClock();
  await observeAgentSettlementBounded(route, {
    ...TARGET,
    // The hint stays true across the chunk: the reset comes from the arrival itself.
    onEvent: () => { hint = true; },
    isIdleCandidate: () => hint,
  }, { adaptive: {}, sleep: clock.sleep, now: clock.now });
  assert.deepEqual(clock.sleeps, [...Array(14).fill(750), 1500, 3000, 750, 750, 750]);
});

test('without an idle hint, or with adaptive off, the cadence stays at the base interval', async () => {
  for (const variant of [
    { hint: undefined, adaptive: {} },
    { hint: () => false, adaptive: {} },
    { hint: () => true, adaptive: undefined },
  ]) {
    const { route } = fakeRoute([...idlePages(20), { items: [settled()], next: '0_3' }]);
    const clock = fakeClock();
    await observeAgentSettlementBounded(route, {
      ...TARGET, ...(variant.hint ? { isIdleCandidate: variant.hint } : {}),
    }, { ...(variant.adaptive ? { adaptive: variant.adaptive } : {}), sleep: clock.sleep, now: clock.now });
    assert.deepEqual(clock.sleeps, Array(20).fill(750));
  }
});

test('the milestone relay marks only a milestone start as the last chunk as an idle candidate', () => {
  const relay = createWorkspaceMilestoneRelay('sub_1', async () => {});
  assert.equal(relay.isIdleCandidate(), false);
  relay.onEvent({ type: 'message-started', submissionId: 'sub_1', messageId: 'msg_1' } as never);
  relay.onEvent(milestoneStart('msg_other') as never);
  assert.equal(relay.isIdleCandidate(), false, 'another submission\'s milestone is not ours');
  relay.onEvent(milestoneStart() as never);
  assert.equal(relay.isIdleCandidate(), true);
  relay.onEvent({ type: 'message-delta', kind: 'text', delta: 'x' } as never);
  assert.equal(relay.isIdleCandidate(), false);
  relay.onEvent({ ...milestoneStart(), data: { ...milestoneStart().data, state: 'completed' } } as never);
  assert.equal(relay.isIdleCandidate(), false);
});

test('an abort during a backed-off 5 s sleep throws its reason promptly', async () => {
  const controller = new AbortController();
  const yieldReason = new Error('yield');
  const { route, requests } = fakeRoute([{ next: '0_1', upToDate: true }]);
  let time = 0;
  const started = Date.now();
  setTimeout(() => controller.abort(yieldReason), 20);
  await assert.rejects(
    observeAgentSettlementBounded(route, { ...TARGET, signal: controller.signal, isIdleCandidate: () => true }, {
      // Quiet for long already and a steep factor: the first sleep is the 5 s ceiling, on a real timer.
      adaptive: { factor: 100 },
      now: () => (time += 60_000),
    }),
    (error: unknown) => error === yieldReason,
  );
  assert.ok(Date.now() - started < 1_000, 'the long sleep is abortable');
  assert.equal(requests.length, 1);
});
