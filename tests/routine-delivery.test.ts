import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ErrorCode, WebClient } from '@slack/web-api';

import {
  DIRECT_ROUTINE_RECOVERY_NOTICE,
  DIRECT_ROUTINE_CONSECUTIVE_FAILURE_NOTICE,
  CHANNEL_ROUTINE_CONSECUTIVE_FAILURE_NOTICE,
  CHANNEL_ROUTINE_UNKNOWN_OUTCOME_NOTICE,
  deliverRoutineRecoveryNotice,
  drainRoutinePauseNotices,
  deliverRoutineFailureNotice,
  deliverRoutineResult,
  renderRoutineDelivery,
} from '../src/routines/delivery.ts';
import { RoutineRuntimeError } from '../src/routines/runtime.ts';
import type {
  ClaimRoutineDeliveryInput,
  ClaimRoutineRecoveryDeliveryInput,
  RecordRoutineDeliveryInput,
  RecordRoutineRecoveryDeliveryInput,
  RoutineDefinition,
  RoutineRecoveryDelivery,
  RoutineRun,
  RoutineStore,
} from '../src/routines/types.ts';
import type { ShadowWorkLifecycle } from '../src/work/lifecycle.ts';

const routine = {
  id: 'routine_test', name: '<Daily & write>', channelId: 'C_TEST', timezone: 'UTC',
  triggerKind: 'schedule',
  destination: { kind: 'channel', channelId: 'C_TEST' },
} as RoutineDefinition;
const directRoutine = {
  ...routine,
  id: 'routine_direct_test',
  channelId: 'D_TEST',
  destination: {
    kind: 'direct_thread',
    conversationId: 'D_TEST',
    threadTs: '1784000000.000100',
    ownerMembershipId: 'membership_direct',
  },
} as RoutineDefinition;
const run = { id: 'rrun_test', scheduledFor: Date.UTC(2026, 6, 27, 16) } as RoutineRun;
const access = {
  config: {
    agentId: 'agent_default',
    model: 'anthropic/claude-sonnet-4',
    agent: {
      id: 'agent_default',
      name: 'Default',
      slackPresence: {
        avatar: { kind: 'generated', revision: 2, seed: 'agent_default' },
      },
    },
  } as never,
  accessHash: 'a'.repeat(64),
  botToken: 'xoxb-test',
  botUserId: 'UBOT',
  publicUrl: 'https://chickpea.example',
};

function store(events: string[]): RoutineStore {
  return {
    claimDelivery: async () => { events.push('claim'); return 'claimed'; },
    recordDelivery: async (input: RecordRoutineDeliveryInput) => {
      events.push(`record:${input.outcome}:${input.messageTs ?? ''}:${input.failureClass ?? ''}`);
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
  assert.deepEqual(events, ['claim', 'record:delivered:1785000000.000100:']);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.channel, 'C_TEST');
  assert.equal(requests[0]?.thread_ts, undefined);
  assert.equal(requests[0]?.username, 'Default');
  assert.equal(
    requests[0]?.icon_url,
    'https://chickpea.example/assets/agents/agent_default/avatar/2',
  );
  assert.match(requests[0]?.text ?? '', /Completed the write/);
  assert.doesNotMatch(requests[0]?.blocks ?? '', /rrun_test|!routines show/);
  assert.match(requests[0]?.blocks ?? '', /View schedule/);
  assert.doesNotMatch(requests[0]?.blocks ?? '', /audit-logs/);
  assert.match(requests[0]?.blocks ?? '', /anthropic\/claude-sonnet-4/);
  const rendered = renderRoutineDelivery(routine, run, 'Done.', {
    agentName: 'Default', modelLabel: 'anthropic/claude-sonnet-4',
    agentId: 'agent_default', publicUrl: 'https://chickpea.example',
  });
  assert.equal(rendered.text, 'Routine completed: &lt;Daily &amp; write&gt;\n\nDone.');
  assert.deepEqual(rendered.blocks?.at(-2), {
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: 'Scheduled Jul 27 at 4:00 PM UTC · <https://chickpea.example/admin/agents/agent_default?tab=schedules|View schedule>',
    }],
  });
  assert.match(JSON.stringify(rendered.blocks?.at(-1)), /Default.*anthropic\/claude-sonnet-4.*Configure/);
});

test('private routine results and failure notices stay in the originating thread without Admin links', async () => {
  const events: string[] = [];
  const requests: Array<Record<string, string>> = [];
  const client = new WebClient('xoxb-test', {
    slackApiUrl: 'https://slack.invalid/api/', retryConfig: { retries: 0 },
    fetch: async (_url, init) => {
      requests.push(Object.fromEntries(new URLSearchParams(String(init?.body ?? ''))));
      return new Response(
        JSON.stringify({ ok: true, channel: 'D_TEST', ts: `1785000000.000${requests.length}` }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });

  await deliverRoutineResult({
    store: store(events), run, routine: directRoutine, access,
    message: 'Private result.', changeKeyHash: null, now: () => 1_000,
  }, client);
  await deliverRoutineFailureNotice({
    store: store(events), run, routine: { ...directRoutine, state: 'paused' }, access,
    publicError: 'The private run stopped safely.', now: () => 2_000,
  }, client);

  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.channel, 'D_TEST');
    assert.equal(request.thread_ts, directRoutine.destination.kind === 'direct_thread'
      ? directRoutine.destination.threadTs
      : undefined);
    assert.equal(request.username, 'Default');
    assert.doesNotMatch(request.blocks ?? '', /View schedule|Configure|\/admin\//);
    assert.match(request.blocks ?? '', /Default.*anthropic\/claude-sonnet-4/);
  }
  assert.match(requests[0]?.text ?? '', /Private result/);
  assert.match(requests[1]?.text ?? '', /review and resume it in this DM/);
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
  assert.deepEqual(events, ['claim', 'record:unknown::']);
});

test('an explicit Slack rate limit retries once inside the claimed attempt and deadline', async () => {
  const events: string[] = [];
  const waits: number[] = [];
  let requests = 0;
  let clock = 1_000;
  const client = {
    chat: {
      postMessage: async () => {
        requests += 1;
        if (requests === 1) {
          throw { code: ErrorCode.RateLimitedError, retryAfter: 2 };
        }
        return { ok: true, channel: 'C_TEST', ts: '1785000000.000400' };
      },
    },
  } as unknown as WebClient;

  const receipt = await deliverRoutineResult({
    store: store(events),
    run: { ...run, deadlineAt: 60_000 },
    routine,
    access,
    message: 'Delivered after a safe retry.',
    changeKeyHash: null,
    now: () => clock,
    sleep: async (delayMs) => {
      waits.push(delayMs);
      clock += delayMs;
    },
  }, client);

  assert.deepEqual(receipt, { channelId: 'C_TEST', messageTs: '1785000000.000400' });
  assert.equal(requests, 2);
  assert.deepEqual(waits, [2_000]);
  assert.deepEqual(events, ['claim', 'record:delivered:1785000000.000400:']);
});

test('definitive private-thread rejections are classified without retrying or falling back', async () => {
  const cases = [
    { error: 'cannot_reply_to_message' },
    { data: { error: 'restricted_action_non_threadable_channel' } },
    { ok: false, error: 'restricted_action_thread_locked' },
  ];

  for (const [index, rejection] of cases.entries()) {
    const events: string[] = [];
    let requests = 0;
    const client = {
      chat: {
        postMessage: async () => {
          requests += 1;
          if (index < 2) throw rejection;
          return rejection;
        },
      },
    } as unknown as WebClient;

    await assert.rejects(
      () => deliverRoutineResult({
        store: store(events), run, routine: directRoutine, access, message: 'Private result.',
        changeKeyHash: null, now: () => 1_000,
      }, client),
      (error: unknown) => error instanceof RoutineRuntimeError &&
        error.failureClass === 'direct_thread_unavailable',
    );
    assert.equal(requests, 1);
    assert.deepEqual(events, ['claim', 'record:failed::direct_thread_unavailable']);
  }
});

test('a definitive private failure-notice rejection carries the terminal thread class', async () => {
  const events: string[] = [];
  const client = {
    chat: {
      postMessage: async () => { throw { error: 'cannot_reply_to_message' }; },
    },
  } as unknown as WebClient;

  await assert.rejects(
    () => deliverRoutineFailureNotice({
      store: store(events),
      run,
      routine: { ...directRoutine, state: 'paused' },
      access,
      publicError: 'The run stopped safely.',
      now: () => 1_000,
    }, client),
    (error: unknown) => error instanceof RoutineRuntimeError &&
      error.failureClass === 'direct_thread_unavailable',
  );
  assert.deepEqual(events, ['claim', 'record:failed::direct_thread_unavailable']);
});

test('unknown private-thread Slack errors remain ambiguous and never fall back', async () => {
  const events: string[] = [];
  const logs: string[] = [];
  let requests = 0;
  const rawSlackCanary = 'RAW_PRIVATE_SLACK_ERROR_MUST_NOT_LOG';
  const client = {
    chat: {
      postMessage: async () => {
        requests += 1;
        throw { data: { error: 'some_future_slack_error', detail: rawSlackCanary } };
      },
    },
  } as unknown as WebClient;
  const originalConsole = {
    error: console.error,
    warn: console.warn,
    log: console.log,
  };
  console.error = (...args: unknown[]) => { logs.push(args.join(' ')); };
  console.warn = (...args: unknown[]) => { logs.push(args.join(' ')); };
  console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
  try {
    await assert.rejects(
      () => deliverRoutineResult({
        store: store(events), run, routine: directRoutine, access, message: 'Private result.',
        changeKeyHash: null, now: () => 1_000,
      }, client),
      (error: unknown) => error instanceof RoutineRuntimeError &&
        error.failureClass === 'delivery_unknown',
    );
  } finally {
    console.error = originalConsole.error;
    console.warn = originalConsole.warn;
    console.log = originalConsole.log;
  }
  assert.equal(requests, 1);
  assert.deepEqual(events, ['claim', 'record:unknown::']);
  assert.doesNotMatch(
    logs.join('\n'),
    /RAW_PRIVATE_SLACK_ERROR_MUST_NOT_LOG|D_TEST|1784000000\.000100|Private result/,
  );
});

test('private recovery posts one sanitized Chickpea notice at the verified DM root', async () => {
  const events: string[] = [];
  const requests: Array<Record<string, unknown>> = [];
  let claimed = false;
  const recoveryStore = {
    getRecoveryDelivery: async () => ({ failureClass: 'direct_thread_unavailable' }),
    claimRecoveryDelivery: async (input: ClaimRoutineRecoveryDeliveryInput) => {
      events.push(`claim:${input.occurrenceId}`);
      if (claimed) return 'superseded' as const;
      claimed = true;
      return 'claimed' as const;
    },
    recordRecoveryDelivery: async (input: RecordRoutineRecoveryDeliveryInput) => {
      events.push(`record:${input.outcome}:${input.messageTs ?? ''}`);
      return {};
    },
  } as unknown as RoutineStore;
  const client = {
    conversations: {
      open: async (input: Record<string, unknown>) => {
        requests.push({ method: 'open', ...input });
        return { ok: true, channel: { id: 'D_TEST', is_im: true } };
      },
    },
    chat: {
      postMessage: async (input: Record<string, unknown>) => {
        requests.push({ method: 'post', ...input });
        return { ok: true, channel: 'D_TEST', ts: '1785000000.000900' };
      },
    },
  } as unknown as WebClient;
  const directAccess = { ...access, actorSlackUserId: 'U_ACTOR' };

  assert.equal(await deliverRoutineRecoveryNotice({
    store: recoveryStore, run, routine: directRoutine, access: directAccess, now: () => 2_000,
  }, client), 'accepted');
  assert.equal(await deliverRoutineRecoveryNotice({
    store: recoveryStore, run, routine: directRoutine, access: directAccess, now: () => 3_000,
  }, client), 'superseded');

  assert.deepEqual(events, [
    'claim:rrun_test',
    'record:accepted:1785000000.000900',
    'claim:rrun_test',
  ]);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], { method: 'open', users: 'U_ACTOR' });
  assert.deepEqual(requests[1], {
    method: 'post',
    channel: 'D_TEST',
    text: DIRECT_ROUTINE_RECOVERY_NOTICE,
    username: 'Chickpea',
    unfurl_links: false,
    unfurl_media: false,
  });
  assert.doesNotMatch(
    String(requests[1]?.text),
    /routine_test|Daily|Private result|1784000000\.000100|U_ACTOR|membership_direct/,
  );
});

test('a repeated-failure pause notice is content-free and posts at the verified DM root', async () => {
  let request: Record<string, unknown> | undefined;
  const recoveryStore = {
    getRecoveryDelivery: async () => ({ failureClass: 'consecutive_failures' }),
    claimRecoveryDelivery: async () => 'claimed' as const,
    recordRecoveryDelivery: async () => ({}),
  } as unknown as RoutineStore;
  const client = {
    conversations: {
      open: async () => ({ ok: true, channel: { id: 'D_TEST', is_im: true } }),
    },
    chat: {
      postMessage: async (input: Record<string, unknown>) => {
        request = input;
        return { ok: true, channel: 'D_TEST', ts: '1785000000.000901' };
      },
    },
  } as unknown as WebClient;

  assert.equal(await deliverRoutineRecoveryNotice({
    store: recoveryStore,
    run,
    routine: directRoutine,
    access: { ...access, actorSlackUserId: 'U_ACTOR' },
    now: () => 2_000,
  }, client), 'accepted');
  assert.equal(request?.text, DIRECT_ROUTINE_CONSECUTIVE_FAILURE_NOTICE);
  assert.equal(request?.thread_ts, undefined);
  assert.doesNotMatch(JSON.stringify(request), /routine_test|Daily|1784000000\.000100/);
});

test('Channel pause notices post once at the channel root for repeated and unknown failures', async () => {
  for (const [failureClass, expectedText] of [
    ['consecutive_failures', CHANNEL_ROUTINE_CONSECUTIVE_FAILURE_NOTICE],
    ['delivery_unknown', CHANNEL_ROUTINE_UNKNOWN_OUTCOME_NOTICE],
  ] as const) {
    let claimed = false;
    let status: RoutineRecoveryDelivery['status'] = 'pending';
    const requests: Array<Record<string, unknown>> = [];
    const recoveryStore = {
      getRecoveryDelivery: async () => ({
        occurrenceId: run.id,
        claimedAt: claimed ? 2_000 : null,
        status,
        messageTs: null,
        failureClass,
        updatedAt: 1_000,
      }),
      claimRecoveryDelivery: async () => {
        if (claimed || status !== 'pending') return 'superseded' as const;
        claimed = true;
        return 'claimed' as const;
      },
      recordRecoveryDelivery: async (input: RecordRoutineRecoveryDeliveryInput) => {
        status = input.outcome;
        return {};
      },
    } as unknown as RoutineStore;
    const client = {
      conversations: {
        open: async () => { throw new Error('Channel recovery must not open a DM.'); },
      },
      chat: {
        postMessage: async (input: Record<string, unknown>) => {
          requests.push(input);
          return { ok: true, channel: 'C_TEST', ts: '1785000000.000904' };
        },
      },
    } as unknown as WebClient;
    const input = {
      store: recoveryStore,
      run,
      routine,
      access,
      now: () => 2_000,
    };

    assert.equal(await deliverRoutineRecoveryNotice(input, client), 'accepted');
    assert.equal(await deliverRoutineRecoveryNotice(input, client), 'superseded');
    assert.deepEqual(requests, [{
      channel: 'C_TEST',
      text: expectedText,
      username: 'Chickpea',
      unfurl_links: false,
      unfurl_media: false,
    }]);
  }
});

test('scheduled pause-notice recovery replays pending state without posting twice', async () => {
  let claimed = false;
  let posts = 0;
  const notice: RoutineRecoveryDelivery = {
    occurrenceId: run.id,
    claimedAt: null,
    status: 'pending',
    messageTs: null,
    failureClass: 'consecutive_failures' as const,
    updatedAt: 1_000,
  };
  const recoveryStore = {
    listPendingRecoveryDeliveries: async () => [notice],
    getRun: async () => ({ ...run, routineId: directRoutine.id }),
    getRoutine: async () => directRoutine,
    getRecoveryDelivery: async () => notice,
    claimRecoveryDelivery: async () => {
      if (claimed) return 'superseded' as const;
      claimed = true;
      notice.claimedAt = 1_000;
      return 'claimed' as const;
    },
    recordRecoveryDelivery: async (input: RecordRoutineRecoveryDeliveryInput) => {
      notice.status = input.outcome;
      return notice;
    },
  } as unknown as RoutineStore;
  const client = {
    conversations: {
      open: async () => ({ ok: true, channel: { id: 'D_TEST', is_im: true } }),
    },
    chat: {
      postMessage: async () => {
        posts += 1;
        return { ok: true, channel: 'D_TEST', ts: '1785000000.000902' };
      },
    },
  } as unknown as WebClient;
  const resolveAccess = async () => ({
    ...access,
    actorSlackUserId: 'U_ACTOR',
    client,
  });

  assert.deepEqual(await drainRoutinePauseNotices(
    { store: recoveryStore, env: {} as never },
    { resolveAccess: resolveAccess as never },
  ), { scanned: 1, settled: 1 });
  assert.deepEqual(await drainRoutinePauseNotices(
    { store: recoveryStore, env: {} as never },
    { resolveAccess: resolveAccess as never },
  ), { scanned: 1, settled: 0 });
  assert.equal(posts, 1);
});

test('a pre-claim-ineligible root notice rotates behind newer deliverable notices', async () => {
  const notices: RoutineRecoveryDelivery[] = [
    {
      occurrenceId: 'rrun_blocked', claimedAt: null, status: 'pending' as const,
      messageTs: null, failureClass: 'consecutive_failures' as const, updatedAt: 1,
    },
    {
      occurrenceId: 'rrun_healthy', claimedAt: null, status: 'pending' as const,
      messageTs: null, failureClass: 'consecutive_failures' as const, updatedAt: 2,
    },
  ];
  const deferred: string[] = [];
  let posts = 0;
  const recoveryStore = {
    listPendingRecoveryDeliveries: async (limit: number) => notices
      .filter(({ status, claimedAt }) => status === 'pending' && claimedAt === null)
      .sort((left, right) => left.updatedAt - right.updatedAt)
      .slice(0, limit),
    getRun: async (occurrenceId: string) => ({
      ...run,
      id: occurrenceId,
      routineId: directRoutine.id,
    }),
    getRoutine: async () => directRoutine,
    getRecoveryDelivery: async (occurrenceId: string) =>
      notices.find((notice) => notice.occurrenceId === occurrenceId),
    deferRecoveryDelivery: async ({ occurrenceId, at }: { occurrenceId: string; at: number }) => {
      const notice = notices.find((candidate) => candidate.occurrenceId === occurrenceId)!;
      notice.updatedAt = at;
      deferred.push(occurrenceId);
      return notice;
    },
    claimRecoveryDelivery: async ({ occurrenceId }: ClaimRoutineRecoveryDeliveryInput) => {
      const notice = notices.find((candidate) => candidate.occurrenceId === occurrenceId)!;
      notice.claimedAt = 101;
      return 'claimed' as const;
    },
    recordRecoveryDelivery: async ({ occurrenceId }: RecordRoutineRecoveryDeliveryInput) => {
      const notice = notices.find((candidate) => candidate.occurrenceId === occurrenceId)!;
      notice.status = 'accepted';
      return notice;
    },
  } as unknown as RoutineStore;
  const client = {
    conversations: {
      open: async () => ({ ok: true, channel: { id: 'D_TEST', is_im: true } }),
    },
    chat: {
      postMessage: async () => {
        posts += 1;
        return { ok: true, channel: 'D_TEST', ts: '1785000000.000903' };
      },
    },
  } as unknown as WebClient;
  const resolveAccess = async (candidateRun: RoutineRun) => {
    if (candidateRun.id === 'rrun_blocked') return { ...access, client };
    return { ...access, actorSlackUserId: 'U_ACTOR', client };
  };

  assert.deepEqual(await drainRoutinePauseNotices(
    { store: recoveryStore, env: {} as never, limit: 1 },
    { resolveAccess: resolveAccess as never, now: () => 100 },
  ), { scanned: 1, settled: 0 });
  assert.deepEqual(await drainRoutinePauseNotices(
    { store: recoveryStore, env: {} as never, limit: 1 },
    { resolveAccess: resolveAccess as never, now: () => 101 },
  ), { scanned: 1, settled: 1 });
  assert.deepEqual(deferred, ['rrun_blocked']);
  assert.equal(posts, 1);
});

test('invalid recovery queue heads settle so a newer notice can be delivered', async () => {
  const notices: RoutineRecoveryDelivery[] = [
    ...Array.from({ length: 23 }, (_, index) => ({
      occurrenceId: `rrun_missing_${index}`,
      claimedAt: null,
      status: 'pending' as const,
      messageTs: null,
      failureClass: 'consecutive_failures' as const,
      updatedAt: index + 1,
    })),
    {
      occurrenceId: 'rrun_missing_routine', claimedAt: null, status: 'pending' as const,
      messageTs: null, failureClass: 'consecutive_failures' as const, updatedAt: 24,
    },
    {
      occurrenceId: 'rrun_legacy_channel', claimedAt: null, status: 'pending' as const,
      messageTs: null, failureClass: 'direct_thread_unavailable' as const, updatedAt: 25,
    },
    {
      occurrenceId: 'rrun_deliverable', claimedAt: null, status: 'pending' as const,
      messageTs: null, failureClass: 'consecutive_failures' as const, updatedAt: 26,
    },
  ];
  let posts = 0;
  const recoveryStore = {
    listPendingRecoveryDeliveries: async (limit: number) => notices
      .filter(({ status, claimedAt }) => status === 'pending' && claimedAt === null)
      .sort((left, right) => left.updatedAt - right.updatedAt)
      .slice(0, limit),
    getRun: async (occurrenceId: string) => occurrenceId.startsWith('rrun_missing_') &&
      occurrenceId !== 'rrun_missing_routine'
      ? undefined
      : {
          ...run,
          id: occurrenceId,
          routineId: occurrenceId === 'rrun_missing_routine'
            ? 'routine_missing'
            : occurrenceId === 'rrun_legacy_channel'
              ? routine.id
              : directRoutine.id,
        },
    getRoutine: async (routineId: string) => routineId === 'routine_missing'
      ? undefined
      : routineId === routine.id
        ? routine
        : directRoutine,
    getRecoveryDelivery: async (occurrenceId: string) =>
      notices.find((notice) => notice.occurrenceId === occurrenceId),
    claimRecoveryDelivery: async ({ occurrenceId, at }: ClaimRoutineRecoveryDeliveryInput) => {
      const notice = notices.find((candidate) => candidate.occurrenceId === occurrenceId)!;
      if (notice.status !== 'pending' || notice.claimedAt !== null) return 'superseded' as const;
      notice.claimedAt = at;
      return 'claimed' as const;
    },
    recordRecoveryDelivery: async ({ occurrenceId, outcome }: RecordRoutineRecoveryDeliveryInput) => {
      const notice = notices.find((candidate) => candidate.occurrenceId === occurrenceId)!;
      notice.status = outcome;
      return notice;
    },
  } as unknown as RoutineStore;
  const client = {
    conversations: {
      open: async () => ({ ok: true, channel: { id: 'D_TEST', is_im: true } }),
    },
    chat: {
      postMessage: async () => {
        posts += 1;
        return { ok: true, channel: 'D_TEST', ts: '1785000000.000905' };
      },
    },
  } as unknown as WebClient;
  const resolveAccess = async () => ({ ...access, actorSlackUserId: 'U_ACTOR', client });

  assert.deepEqual(await drainRoutinePauseNotices(
    { store: recoveryStore, env: {} as never, limit: 25 },
    { resolveAccess: resolveAccess as never, now: () => 100 },
  ), { scanned: 25, settled: 25 });
  assert.deepEqual(await drainRoutinePauseNotices(
    { store: recoveryStore, env: {} as never, limit: 25 },
    { resolveAccess: resolveAccess as never, now: () => 101 },
  ), { scanned: 1, settled: 1 });
  assert.equal(posts, 1);
});

test('private recovery rejects a mismatched or unproven DM without posting', async () => {
  for (const channel of [{ id: 'D_OTHER', is_im: true }, { id: 'D_TEST' }]) {
    const events: string[] = [];
    let posts = 0;
    const recoveryStore = {
      getRecoveryDelivery: async () => ({ failureClass: 'direct_thread_unavailable' }),
      claimRecoveryDelivery: async () => 'claimed' as const,
      recordRecoveryDelivery: async (input: RecordRoutineRecoveryDeliveryInput) => {
        events.push(input.outcome);
        return {};
      },
    } as unknown as RoutineStore;
    const client = {
      conversations: { open: async () => ({ ok: true, channel }) },
      chat: {
        postMessage: async () => { posts += 1; return { ok: true }; },
      },
    } as unknown as WebClient;

    assert.equal(await deliverRoutineRecoveryNotice({
      store: recoveryStore,
      run,
      routine: directRoutine,
      access: { ...access, actorSlackUserId: 'U_ACTOR' },
      now: () => 2_000,
    }, client), 'definitive_failure');
    assert.equal(posts, 0);
    assert.deepEqual(events, ['definitive_failure']);
  }
});

test('an ambiguous private recovery attempt is recorded unknown and never retried', async () => {
  const events: string[] = [];
  let claimed = false;
  let opens = 0;
  const recoveryStore = {
    getRecoveryDelivery: async () => ({ failureClass: 'direct_thread_unavailable' }),
    claimRecoveryDelivery: async () => {
      if (claimed) return 'superseded' as const;
      claimed = true;
      return 'claimed' as const;
    },
    recordRecoveryDelivery: async (input: RecordRoutineRecoveryDeliveryInput) => {
      events.push(input.outcome);
      return {};
    },
  } as unknown as RoutineStore;
  const client = {
    conversations: {
      open: async () => { opens += 1; throw new Error('socket closed after send'); },
    },
  } as unknown as WebClient;
  const input = {
    store: recoveryStore,
    run,
    routine: directRoutine,
    access: { ...access, actorSlackUserId: 'U_ACTOR' },
    now: () => 2_000,
  };

  assert.equal(await deliverRoutineRecoveryNotice(input, client), 'unknown');
  assert.equal(await deliverRoutineRecoveryNotice(input, client), 'superseded');
  assert.equal(opens, 1);
  assert.deepEqual(events, ['unknown']);
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
  assert.match(blocks, /View schedule/);
  assert.doesNotMatch(blocks, /audit-logs/);
  assert.match(blocks, /anthropic\/claude-sonnet-4/);
  assert.deepEqual(events, ['claim', 'record:delivered:1785000000.000200:']);
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
    'record:delivered:1785000000.000700:',
    'work:after:delivered:slack:C_TEST:1785000000.000700',
  ]);
});
