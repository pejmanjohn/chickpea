import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import {
  configurePlatformFunding,
  resetPlatformFundingForTests,
  type CreditBackOutcome,
  type CreditBackReason,
  type RunRef,
} from '../src/config/platform-funding.ts';
import { AgentObservationYield, AgentPromptFailure } from '../src/slack/flue-dispatch.ts';
import { SlackInstallationUnavailableError } from '../src/slack/installation-execution.ts';
import type { RunTurnOptions } from '../src/slack/run-turn.ts';
import {
  executeTurnJob,
  type TurnExecutionOptions,
  type TurnExecutionPorts,
} from '../src/slack/turn-executor.ts';
import type { FlueSettlementCheckpointV1 } from '../src/slack/turn-job-types.ts';
import { MAX_POST_DISPATCH_ATTEMPTS, type PendingTurnJob } from '../src/slack/turn-jobs.ts';
import { slackClientMessageId } from '../src/slack/transport/message-id.ts';
import { SlackTransportError } from '../src/slack/transport/types.ts';
import { AGENT_FAILURE_TEXT, DURABLE_RECOVERY_FAILURE_TEXT } from '../src/slack/web-client-presenter.ts';
import type { SlackPresentationOwner } from '../src/slack/run-presentations.ts';
import type { UsageMicros } from '../src/usage/usage-display.ts';
import { NO_RUN_FEES } from './helpers/platform-funding.ts';

type RunTurnScript = (options: RunTurnOptions) => Promise<void>;

function pendingJob(overrides: Partial<PendingTurnJob> = {}): PendingTurnJob {
  return {
    id: 'turn_1',
    evtKey: 'evt:1',
    msgKey: 'msg:1',
    turn: {
      workspaceId: 'T1',
      channelId: 'D1',
      channelType: 'im',
      threadTs: '1785900000.000100',
      ts: '1785900000.000100',
      userId: 'U1',
      text: 'hello',
      source: 'dm_message',
    },
    assignment: { agentId: 'analyst' },
    executionAuthority: 'legacy',
    attempts: 0,
    progress: {},
    enqueuedAt: 1_785_900_000_000,
    receivedAt: 1_785_899_999_000,
    ...overrides,
  } as PendingTurnJob;
}

/** Ports that record every write; `runTurn` follows the given script. */
function fakePorts(script: RunTurnScript, installation?: () => Promise<unknown>) {
  const calls: string[] = [];
  const runs: RunTurnOptions[] = [];
  const record = (name: string) => (...args: unknown[]) => {
    calls.push(`${name}(${args.map((arg) => JSON.stringify(arg)).join(',')})`);
  };
  const ports = {
    env: {},
    turnJobs: {
      recordAttempt: record('recordAttempt'),
      markRecoveryRequired: record('markRecoveryRequired'),
      markDelivered: record('markDelivered'),
      markError: record('markError'),
      recordInteractionIntent: record('recordInteractionIntent'),
    },
    slack: {
      setActiveWork: record('setActiveWork'),
      release: record('release'),
    },
    config: {},
    presentationState: { getRunPresentation: async () => undefined },
    settingsStore: { getSetting: async () => undefined },
    usageStore: {},
    workStore: {},
    appStores: {},
    managementApproval: () => ({}),
    telemetry: { capture: (event: { event: string }) => calls.push(`telemetry(${event.event})`) },
    resolveInstallation: installation ?? (async () => ({ workspaceId: 'T1', client: {} as WebClient })),
    sandboxBinding: () => undefined,
    runTurn: async (_turn: unknown, _assignment: unknown, _env: unknown, options: RunTurnOptions) => {
      runs.push(options);
      await script(options);
    },
  } as unknown as TurnExecutionPorts;
  const retries: Array<number | undefined> = [];
  const options: TurnExecutionOptions = {
    latency: { lane: 'cloudflare', executor: 'alarm' },
    onRetry: (afterMs) => { retries.push(afterMs); },
  };
  return { ports, options, calls, runs, retries };
}

test('a delivered turn settles its row, clears active work, and lets the thread continue', async () => {
  const h = fakePorts(async (options) => {
    await options.onInteractionIntent?.({ disposition: 'work' } as never);
    await options.onDelivered?.('completed' as never);
  });
  assert.equal(await executeTurnJob(pendingJob(), h.ports, h.options), true);
  const threadKey = JSON.parse(h.calls.find((call) => call.startsWith('setActiveWork'))!
    .slice('setActiveWork('.length, -1).split(',')[0]!);
  assert.deepEqual(h.calls, [
    'recordAttempt("turn_1",1)',
    'recordInteractionIntent("turn_1",{"disposition":"work"})',
    `setActiveWork("${threadKey}","turn_1",true)`,
    'markDelivered("turn_1")',
    `setActiveWork("${threadKey}","turn_1",false)`,
    'telemetry(run_completed)',
  ]);
  assert.deepEqual(h.retries, []);
  const [run] = h.runs;
  assert.equal(run?.turnId, 'turn_1');
  assert.equal(run?.usageExecutionId, 'exec:turn_1:flue');
  assert.deepEqual(run?.turnLatency, {
    admittedAt: 1_785_900_000_000,
    receivedAt: 1_785_899_999_000,
    lane: 'cloudflare',
    executor: 'alarm',
  });
  assert.equal(run?.presentationState, h.ports.presentationState, 'the injected presentation state');
  assert.equal(run?.settingsStore, h.ports.settingsStore);
  assert.equal(run?.observationSignal, undefined, 'no control, no observation signal');
});

test('a failed first attempt is retained for a retry and ends its thread for this drain', async () => {
  const h = fakePorts(async () => { throw new Error('model unavailable'); });
  assert.equal(await executeTurnJob(pendingJob(), h.ports, h.options), false);
  assert.deepEqual(h.calls, ['recordAttempt("turn_1",1)']);
  assert.deepEqual(h.retries, [undefined]);
});

test('a rate-limited attempt asks for a retry no sooner than the gateway allows, bounded to one window', async () => {
  const h = fakePorts(async () => {
    throw new SlackTransportError('conversations.info', 'gateway_rate_limited', {
      retryable: true, effectOutcome: 'failed', retryAfterMs: 12_000,
    });
  });
  assert.equal(await executeTurnJob(pendingJob(), h.ports, h.options), false);
  assert.deepEqual(h.retries, [12_000]);
  const long = fakePorts(async () => {
    throw new SlackTransportError('conversations.info', 'ratelimited', {
      retryable: true, retryAfterMs: 600_000,
    });
  });
  assert.equal(await executeTurnJob(pendingJob(), long.ports, long.options), false);
  assert.deepEqual(long.retries, [60_000]);
});

test('an installation that is briefly unavailable asks for a retry no sooner than it allows', async () => {
  const h = fakePorts(async () => assert.fail('the turn never starts'), async () => {
    throw new SlackInstallationUnavailableError('T1', 'ratelimited', {
      retryable: true,
      retryAfterMs: 30_000,
    });
  });
  assert.equal(await executeTurnJob(pendingJob(), h.ports, h.options), false);
  assert.deepEqual(h.retries, [30_000]);
  assert.deepEqual(h.calls, []);
});

test('an installation retry hint is bounded to one gateway window', async () => {
  const h = fakePorts(async () => assert.fail('the turn never starts'), async () => {
    throw new SlackInstallationUnavailableError('T1', 'ratelimited', {
      retryable: true,
      retryAfterMs: 3_600_000,
    });
  });
  assert.equal(await executeTurnJob(pendingJob(), h.ports, h.options), false);
  assert.deepEqual(h.retries, [60_000]);
});

test('an installation that cannot recover holds the row for operator recovery', async () => {
  const h = fakePorts(async () => assert.fail('the turn never starts'), async () => {
    throw new SlackInstallationUnavailableError('T1', 'installation_unknown', { retryable: false });
  });
  assert.equal(await executeTurnJob(pendingJob(), h.ports, h.options), false);
  assert.deepEqual(h.calls, ['markRecoveryRequired("turn_1","slack_installation_unavailable")']);
  assert.deepEqual(h.retries, []);
});

test('a dispatch that needs reconciliation posts the recovery notice once and settles as an error', async () => {
  const h = fakePorts(async (options) => {
    if (options.replayTerminalResult === 'failure') {
      await options.onDelivered?.();
      return;
    }
    throw new AgentPromptFailure('agent', 500, true);
  });
  const job = pendingJob({ dispatchEnvelope: { instanceId: 'agent' } as never });
  assert.equal(await executeTurnJob(job, h.ports, h.options), true);
  assert.equal(h.runs.length, 2);
  assert.equal(h.runs[1]?.replayTerminalResult, 'failure');
  assert.equal(h.runs[1]?.presentationState, h.ports.presentationState);
  assert.deepEqual(h.calls, ['recordAttempt("turn_1",1)', 'markError("turn_1")']);
});

test('exhausted reattachment posts the recovery notice fresh when the presentation is stuck', async () => {
  const posted: Array<Record<string, unknown>> = [];
  const client = {
    chat: {
      async postMessage(input: Record<string, unknown>) {
        posted.push(input);
        return { ok: true, ts: '1785900000.000900' };
      },
    },
  } as unknown as WebClient;
  // Every attempt, and the recovery notice replayed through the same
  // presentation, fails the way a stuck terminal does.
  const h = fakePorts(async () => { throw new Error('Slack Agent View presentation requires reconciliation.'); },
    async () => ({ workspaceId: 'T1', client }));
  const job = pendingJob({
    runId: 'run_stuck',
    attempts: MAX_POST_DISPATCH_ATTEMPTS - 1,
    dispatchEnvelope: { instanceId: 'agent' } as never,
  });
  assert.equal(await executeTurnJob(job, h.ports, h.options), false);
  assert.equal(h.runs.length, 2);
  assert.equal(h.runs[1]?.replayTerminalResult, 'failure');
  assert.equal(posted.length, 1, 'the notice reaches the thread once');
  assert.equal(posted[0]!.text, DURABLE_RECOVERY_FAILURE_TEXT);
  assert.equal(posted[0]!.channel, 'D1');
  assert.equal(posted[0]!.thread_ts, '1785900000.000100');
  assert.equal(posted[0]!.client_msg_id, slackClientMessageId('recovery_notice:run_stuck'));
  assert.ok(h.calls.some((call) => call.startsWith('markRecoveryRequired("turn_1","post_dispatch_attempts_exhausted")')));
});

test('the last attempt\'s failure final posts under the sender of the turn\'s replies', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const persona = {
    name: 'Analyst',
    avatarUrl: 'https://chickpea.example/assets/agents/analyst/avatar/1',
    avatarRevision: 1,
  };
  const cases: Array<[string, SlackPresentationOwner | undefined, Record<string, unknown>]> = [
    // Replies of a run owned by Chickpea come from the installation's bot.
    ['chickpea', { kind: 'chickpea' }, {}],
    ['selected Agent', { kind: 'selected_agent', persona }, { username: 'Analyst', icon_url: persona.avatarUrl }],
    // A run with no frozen presentation keeps the Agent's own name, as its replies do.
    ['no presentation', undefined, { username: 'Analyst' }],
  ];
  for (const [label, owner, expected] of cases) {
    const posted: Array<Record<string, unknown>> = [];
    const client = {
      chat: {
        async postMessage(input: Record<string, unknown>) {
          posted.push(input);
          return { ok: true, channel: 'D1', ts: '1785900000.000900' };
        },
      },
    } as unknown as WebClient;
    const h = fakePorts(async () => { throw new Error('Provider openai needs setup before this model can run.'); },
      async () => ({ workspaceId: 'T1', client }));
    const reads: string[] = [];
    (h.ports as { presentationState: unknown }).presentationState = {
      getRunPresentation: async (runId: string) => {
        reads.push(runId);
        return owner ? { schemaVersion: 3, runId, owner } : undefined;
      },
    };
    const job = pendingJob({
      runId: 'run_failed',
      attempts: 1,
      assignment: {
        workspaceId: 'T1',
        channelId: 'D1',
        agentId: 'agent_analyst',
        agent: { id: 'agent_analyst', kind: 'user', revision: 1, name: 'Analyst', instructions: '', enabled: true },
      } as never,
    });
    assert.equal(await executeTurnJob(job, h.ports, h.options), true, label);
    assert.deepEqual(reads, ['run_failed'], `${label}: the run's frozen owner is read`);
    assert.equal(posted.length, 1, `${label}: one failure final`);
    const final = posted[0]!;
    assert.equal(final.text, AGENT_FAILURE_TEXT, label);
    assert.deepEqual(
      { username: final.username, icon_url: final.icon_url },
      { username: expected.username, icon_url: expected.icon_url },
      `${label}: the sender`,
    );
    assert.ok(h.calls.includes('markError("turn_1")'), label);
  }
});

test('the failure final still posts as the Agent when its run presentation cannot be read', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  t.mock.method(console, 'warn', () => undefined);
  const unreadable: Array<[string, () => Promise<never>]> = [
    ['rejects', async () => { throw new Error('presentation store unavailable'); }],
    // A port that throws before it returns a promise.
    ['throws', () => { throw new Error('presentation store unavailable'); }],
  ];
  for (const [label, getRunPresentation] of unreadable) {
    const posted: Array<Record<string, unknown>> = [];
    const client = {
      chat: {
        async postMessage(input: Record<string, unknown>) {
          posted.push(input);
          return { ok: true, channel: 'D1', ts: '1785900000.000900' };
        },
      },
    } as unknown as WebClient;
    const h = fakePorts(async () => { throw new Error('Provider openai needs setup before this model can run.'); },
      async () => ({ workspaceId: 'T1', client }));
    const settingReads: string[] = [];
    const ports = h.ports as { presentationState: unknown; settingsStore: unknown };
    ports.presentationState = { getRunPresentation };
    // The pinned public URL the replies' footer links to.
    ports.settingsStore = {
      getSetting: async (key: string) => {
        settingReads.push(key);
        return 'https://chickpea.example/';
      },
    };
    const job = pendingJob({
      runId: 'run_failed',
      attempts: 1,
      assignment: {
        workspaceId: 'T1',
        channelId: 'D1',
        agentId: 'agent_analyst',
        agent: { id: 'agent_analyst', kind: 'user', revision: 1, name: 'Analyst', instructions: '', enabled: true },
      } as never,
    });
    assert.equal(await executeTurnJob(job, h.ports, h.options), true, label);
    assert.equal(posted.length, 1, `${label}: one failure final`);
    assert.equal(posted[0]!.text, AGENT_FAILURE_TEXT, label);
    assert.equal(posted[0]!.username, 'Analyst', label);
    assert.equal(settingReads.length, 1, `${label}: the injected settings store resolves the public URL`);
    assert.ok(h.calls.includes('markError("turn_1")'), label);
  }
});

test('a yielded observation restores its attempt count and stays pending without a retry', async () => {
  const controller = new AbortController();
  let observing = false;
  const h = fakePorts(async (options) => {
    assert.equal(options.observationSignal, controller.signal);
    options.onObservationStarted?.();
    throw new AgentObservationYield();
  });
  const job = pendingJob({
    attempts: 3,
    dispatchEnvelope: { instanceId: 'agent' } as never,
    dispatchReceipt: { submissionId: 'submission_1', acceptedAt: new Date().toISOString() } as never,
  });
  const settled = await executeTurnJob(job, h.ports, {
    ...h.options,
    control: { signal: controller.signal, observing: () => { observing = true; } },
  });
  assert.equal(settled, false);
  assert.equal(observing, true);
  assert.deepEqual(h.calls, ['recordAttempt("turn_1",4)', 'recordAttempt("turn_1",3)']);
  assert.deepEqual(h.retries, [], 'a yield is not a failed attempt');
});

/**
 * The same contract against a thread runner's port set: every write answers
 * asynchronously (an RPC to the state store), the local stores are omitted,
 * and the runner's registry and dispatch route are passed through.
 */
function runnerPorts(script: RunTurnScript) {
  const h = fakePorts(script);
  const asyncOf = <T extends Record<string, unknown>>(port: T) => Object.fromEntries(
    Object.entries(port).map(([name, method]) => [name, async (...args: unknown[]) => {
      await Promise.resolve();
      return (method as (...values: unknown[]) => unknown)(...args);
    }]),
  );
  const ports = h.ports as unknown as Record<string, unknown>;
  const prepared: unknown[] = [];
  const envelopes: unknown[] = [];
  ports.turnJobs = {
    ...asyncOf(ports.turnJobs as Record<string, unknown>),
    prepareFlueDispatch: async (
      _id: string, _message: string, observation: unknown,
      _images: unknown, _lists: unknown, turnEnvelope: unknown,
    ) => {
      prepared.push(observation);
      envelopes.push(turnEnvelope);
      return { instanceId: 'agent' };
    },
  };
  ports.slack = asyncOf(ports.slack as Record<string, unknown>);
  for (const local of ['settingsStore', 'usageStore', 'workStore', 'appStores', 'managementApproval']) {
    delete ports[local];
  }
  const statusRegistry = { runner: true };
  ports.statusRegistry = statusRegistry;
  const options: TurnExecutionOptions = {
    ...h.options,
    latency: { lane: 'cloudflare', executor: 'runner' },
    observationRoute: { executor: 'runner', runnerKey: 'T1:D1:1785900000.000100' },
  };
  return { ...h, options, prepared, envelopes, statusRegistry };
}

test('runner ports: a delivered turn records the same writes and passes its registry and route', async () => {
  const h = runnerPorts(async (options) => {
    await options.flueDispatch?.prepare('hello', { generation: 'g1' }, undefined, undefined,
      { envelope: 'frozen' } as never);
    await options.onInteractionIntent?.({ disposition: 'work' } as never);
    await options.onDelivered?.('completed' as never);
  });
  assert.equal(await executeTurnJob(pendingJob(), h.ports, h.options), true);
  assert.deepEqual(h.calls.map((call) => call.replace(/\(.*/, '')), [
    'recordAttempt', 'recordInteractionIntent', 'setActiveWork', 'markDelivered', 'setActiveWork',
    'telemetry',
  ]);
  const [run] = h.runs;
  assert.equal(run?.statusRegistry, h.statusRegistry);
  assert.equal(run?.settingsStore, undefined, 'the runner reaches settings over RPC');
  assert.equal(run?.turnLatency?.executor, 'runner');
  assert.deepEqual(h.prepared, [{
    generation: 'g1', executor: 'runner', runnerKey: 'T1:D1:1785900000.000100',
  }], 'the dispatch records where observed activity must go');
  assert.deepEqual(h.envelopes, [{ envelope: 'frozen' }], 'the turn envelope is forwarded too');
});

test('runner ports: a failure after the final is posted never re-runs the turn', async () => {
  const h = runnerPorts(async (options) => {
    await options.onDelivered?.('completed' as never);
    throw new Error('post-delivery cleanup failed');
  });
  assert.equal(await executeTurnJob(pendingJob(), h.ports, h.options), true);
  assert.deepEqual(h.retries, []);
  assert.deepEqual(h.calls.filter((call) => !call.startsWith('telemetry')),
    ['recordAttempt("turn_1",1)', 'markDelivered("turn_1")']);
});

test('runner ports: a yield restores the attempt count exactly as the alarm does', async () => {
  const controller = new AbortController();
  const h = runnerPorts(async () => { throw new AgentObservationYield(); });
  const job = pendingJob({
    attempts: 2,
    dispatchEnvelope: { instanceId: 'agent' } as never,
    dispatchReceipt: { submissionId: 'submission_1', acceptedAt: new Date().toISOString() } as never,
  });
  const settled = await executeTurnJob(job, h.ports, {
    ...h.options,
    control: { signal: controller.signal, observing: () => {} },
  });
  assert.equal(settled, false);
  assert.deepEqual(h.calls, ['recordAttempt("turn_1",3)', 'recordAttempt("turn_1",2)']);
  assert.deepEqual(h.retries, []);
});

test('runner ports: an approval turn gets the state-store approval RPC, not a local runtime', async () => {
  const h = runnerPorts(async (options) => {
    await options.onDelivered?.('completed' as never);
  });
  const requests: unknown[] = [];
  const invoke: NonNullable<TurnExecutionPorts['invokeManagementApproval']> = async (request) => {
    requests.push(request);
    return { kind: 'message', text: 'Applied the approved changes.' };
  };
  (h.ports as unknown as Record<string, unknown>).invokeManagementApproval = invoke;
  assert.equal(await executeTurnJob(pendingJob(), h.ports, h.options), true);
  const [run] = h.runs;
  assert.equal(run?.invokeManagementApproval, invoke, 'the executor forwards the runner approval port');
  assert.equal(run?.managementApproval, undefined, 'a runner has no local management runtime');
  assert.deepEqual(requests, [], 'forwarding alone never applies anything');
});

test('a platform reset surfacing after a code-update yield began is the same free yield, with its cause named', async (t) => {
  const infos: unknown[][] = [];
  t.mock.method(console, 'info', (...args: unknown[]) => { infos.push(args); });
  const errors: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
  for (const thrown of [
    // A write the turn made directly (the old runner's own storage went away).
    new Error('Durable Object reset because its code was updated.'),
    // The read of the reset agent object, wrapped as a transport interruption.
    new AgentPromptFailure('agent', 503, false, true,
      new Error('Internal error in Durable Object storage caused object to be reset; reference = x')),
  ]) {
    const controller = new AbortController();
    const h = fakePorts(async () => {
      controller.abort(new Error('code update'));
      throw thrown;
    });
    const job = pendingJob({
      attempts: 1,
      dispatchEnvelope: { instanceId: 'agent' } as never,
      dispatchReceipt: { submissionId: 'submission_1', acceptedAt: new Date().toISOString() } as never,
    });
    const settled = await executeTurnJob(job, h.ports, {
      ...h.options,
      control: { signal: controller.signal, observing: () => undefined },
    });
    assert.equal(settled, false);
    assert.deepEqual(h.calls, ['recordAttempt("turn_1",2)', 'recordAttempt("turn_1",1)'],
      'the attempt is restored: no reattachment budget spent');
    assert.deepEqual(h.retries, []);
  }
  assert.equal(errors.length, 0, 'no "durable reattachment failed"');
  assert.deepEqual(infos.map((args) => (args[1] as { interruptedBy: unknown }).interruptedBy), [
    [{ kind: 'Error', platformReset: 'code_updated' }],
    [{ kind: 'AgentPromptFailure' }, { kind: 'Error', platformReset: 'storage_reset' }],
  ]);
});

test('a settled failure after the yield began keeps its meaning', async () => {
  const controller = new AbortController();
  const h = fakePorts(async () => {
    controller.abort(new Error('code update'));
    throw new AgentPromptFailure('provider');
  });
  const job = pendingJob({
    attempts: 1,
    dispatchEnvelope: { instanceId: 'agent' } as never,
    dispatchReceipt: { submissionId: 'submission_1', acceptedAt: new Date().toISOString() } as never,
  });
  await executeTurnJob(job, h.ports, {
    ...h.options,
    control: { signal: controller.signal, observing: () => undefined },
  });
  assert.ok(!h.calls.includes('recordAttempt("turn_1",1)'), 'a decided failure is not a yield');
});

test('a bug in this code after the yield began is not a free yield', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  t.mock.method(console, 'warn', () => undefined);
  const controller = new AbortController();
  const h = fakePorts(async () => {
    controller.abort(new Error('code update'));
    throw new TypeError('Cannot read properties of undefined');
  });
  const job = pendingJob({
    attempts: 1,
    dispatchEnvelope: { instanceId: 'agent' } as never,
    dispatchReceipt: { submissionId: 'submission_1', acceptedAt: new Date().toISOString() } as never,
  });
  await executeTurnJob(job, h.ports, {
    ...h.options,
    control: { signal: controller.signal, observing: () => undefined },
  });
  assert.deepEqual(h.calls, ['recordAttempt("turn_1",2)'], 'the attempt is spent, not restored');
  assert.equal(h.retries.length, 1, 'retained for durable reattachment as before');
});

test('a delivered Channel reply hands its teammate asks over after the row is settled, and a stopped one asks nobody', async () => {
  const channelJob = pendingJob({
    turn: {
      workspaceId: 'T1', channelId: 'C1', channelType: 'channel', threadTs: '1785900000.000100',
      messageTs: '1785900000.000100', userId: 'U1', text: 'question', source: 'agent_mention',
      eventId: 'Ev1', contextMode: 'thread',
    },
    assignment: {
      agentId: 'agent_support', runtimeContract: 'chickpea-v1', agent: { kind: 'user' },
      teammates: [{ name: 'Finance', handle: 'finance', userGroupId: 'SFINANCE' }],
    } as never,
  });
  // A stop that reached the run after it finished (raced) asks nobody either.
  const cases = [
    ['completed', 1, false],
    ['stopped', 0, false],
    ['completed', 0, true],
  ] as const;
  for (const [outcome, expected, raced] of cases) {
    const h = fakePorts(async (options) => {
      await options.onPublicMessageDelivered?.({ messageTs: '1785900000.000200', text: '@finance Q3?' });
      await options.onDelivered?.(outcome as never);
    }, async () => ({
      workspaceId: 'T1',
      transportMode: 'gateway',
      client: { conversations: { info: async () => ({ ok: true, channel: { id: 'C1', is_member: true } }) } },
    }));
    const dispatched: string[] = [];
    (h.ports as { config: unknown }).config = { putSlackPublicContext: async () => undefined };
    h.ports.dispatchAgentAsks = async (request) => {
      dispatched.push(`${request.fromAgentId}:${request.deliveries.map(({ text }) => text).join('|')}`);
      h.calls.push('dispatchAgentAsks');
    };
    const options = raced ? { ...h.options, stopRecorded: async () => true } : h.options;
    assert.equal(await executeTurnJob(channelJob, h.ports, options), true);
    assert.equal(dispatched.length, expected, `${outcome}${raced ? ' (raced stop)' : ''}`);
    if (expected) {
      assert.deepEqual(dispatched, ['agent_support:@finance Q3?']);
      assert.ok(h.calls.indexOf('markDelivered("turn_1")') < h.calls.indexOf('dispatchAgentAsks'));
    }
  }
});

const CREDITED_BACK = 'Usage for this reply was credited back to your plan.';

/**
 * A hosted turn whose every reattachment fails, on its last attempt: the
 * executor gives up and posts the recovery text, through the run's
 * presentation when it `replays`, fresh in the thread when it is `stuck`.
 * A `settlement` is the run's own ending, which each attempt replays.
 * Returns the text each way and the host's credit-backs.
 */
async function givenUpHostedTurn(
  t: TestContext,
  answer: CreditBackOutcome,
  receipt: boolean,
  presentation: 'replays' | 'stuck' = 'replays',
  settlement?: FlueSettlementCheckpointV1,
) {
  const creditBacks: Array<{ run: RunRef; reason: CreditBackReason }> = [];
  configurePlatformFunding({
    funding: async () => 'customer',
    admit: async () => 'admitted',
    charge: async () => undefined,
    ...NO_RUN_FEES,
    creditBack: async (run, reason) => { creditBacks.push({ run, reason }); return answer; },
  });
  t.after(() => resetPlatformFundingForTests());
  const replayed: Array<string | undefined> = [];
  const posted: Array<Record<string, unknown>> = [];
  const client = {
    chat: {
      async postMessage(input: Record<string, unknown>) {
        posted.push(input);
        return { ok: true, ts: '1785900000.000900' };
      },
    },
  } as unknown as WebClient;
  const h = fakePorts(async (options) => {
    if (presentation === 'stuck') throw new Error('Slack Agent View presentation requires reconciliation.');
    if (options.replayTerminalResult !== 'failure') throw new Error('Flue read failed');
    replayed.push(options.replayText);
    await options.onDelivered?.();
  }, async () => ({ workspaceId: 'T1', client }));
  h.ports.env = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_executor' });
  const job = pendingJob({
    attempts: MAX_POST_DISPATCH_ATTEMPTS - 1,
    dispatchEnvelope: { instanceId: 'agent' } as never,
    ...(receipt
      ? { dispatchReceipt: { submissionId: 'sub_given_up', acceptedAt: '2026-10-08T00:00:00.000Z', uid: 'uid_given_up' } }
      : {}),
    ...(settlement ? { flueSettlement: settlement } : {}),
  });
  assert.equal(await executeTurnJob(job, h.ports, h.options), presentation === 'replays');
  return { replayed, posted, creditBacks };
}

test('a hosted turn the executor gives up on is credited back as evicted, and its recovery text says so', async (t) => {
  const { replayed, creditBacks } = await givenUpHostedTurn(
    t, { kind: 'credited', usageMicros: 80_000 as UsageMicros }, true,
  );
  assert.deepEqual(replayed, [`${DURABLE_RECOVERY_FAILURE_TEXT} ${CREDITED_BACK}`]);
  assert.deepEqual(creditBacks, [{ run: { installationId: 'inst_executor', runId: 'sub_given_up' }, reason: 'evicted' }]);
});

test('a given-up hosted turn whose presentation is stuck posts the credited-back notice fresh', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const { replayed, posted, creditBacks } = await givenUpHostedTurn(
    t, { kind: 'credited', usageMicros: 80_000 as UsageMicros }, true, 'stuck',
  );
  assert.deepEqual(replayed, []);
  assert.deepEqual(posted.map((post) => post.text), [`${DURABLE_RECOVERY_FAILURE_TEXT} ${CREDITED_BACK}`]);
  assert.deepEqual(creditBacks, [{ run: { installationId: 'inst_executor', runId: 'sub_given_up' }, reason: 'evicted' }]);
});

test('a given-up turn whose replayed ending is out of usage is not credited back', async (t) => {
  const { replayed, creditBacks } = await givenUpHostedTurn(
    t, { kind: 'credited', usageMicros: 80_000 as UsageMicros }, true, 'replays',
    { outcome: 'failed', settledAt: 1_785_900_000_000, failureKind: 'credits-exhausted' },
  );
  assert.deepEqual(replayed, [DURABLE_RECOVERY_FAILURE_TEXT]);
  assert.deepEqual(creditBacks, []);
});

test('a given-up turn whose replayed ending is a sandbox crash is credited back as one', async (t) => {
  const { replayed, creditBacks } = await givenUpHostedTurn(
    t, { kind: 'credited', usageMicros: 80_000 as UsageMicros }, true, 'replays',
    { outcome: 'failed', settledAt: 1_785_900_000_000, failureKind: 'sandbox' },
  );
  assert.deepEqual(replayed, [`${DURABLE_RECOVERY_FAILURE_TEXT} ${CREDITED_BACK}`]);
  assert.deepEqual(creditBacks, [{ run: { installationId: 'inst_executor', runId: 'sub_given_up' }, reason: 'sandbox' }]);
});

test('a given-up run with nothing to credit back posts the plain recovery text', async (t) => {
  const { replayed, creditBacks } = await givenUpHostedTurn(t, { kind: 'nothing' }, true);
  assert.deepEqual(replayed, [DURABLE_RECOVERY_FAILURE_TEXT]);
  assert.equal(creditBacks.length, 1);
});

test('a given-up turn with no receipt asks the host nothing', async (t) => {
  const { replayed, creditBacks } = await givenUpHostedTurn(
    t, { kind: 'credited', usageMicros: 80_000 as UsageMicros }, false,
  );
  assert.deepEqual(replayed, [DURABLE_RECOVERY_FAILURE_TEXT]);
  assert.deepEqual(creditBacks, []);
});
