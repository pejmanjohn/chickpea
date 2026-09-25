import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { AgentObservationYield, AgentPromptFailure } from '../src/slack/flue-dispatch.ts';
import { SlackInstallationUnavailableError } from '../src/slack/installation-execution.ts';
import type { RunTurnOptions } from '../src/slack/run-turn.ts';
import {
  executeTurnJob,
  type TurnExecutionOptions,
  type TurnExecutionPorts,
} from '../src/slack/turn-executor.ts';
import { MAX_POST_DISPATCH_ATTEMPTS, type PendingTurnJob } from '../src/slack/turn-jobs.ts';
import { slackClientMessageId } from '../src/slack/transport/message-id.ts';
import { SlackTransportError } from '../src/slack/transport/types.ts';
import { DURABLE_RECOVERY_FAILURE_TEXT } from '../src/slack/web-client-presenter.ts';

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
    presentationState: {},
    settingsStore: {},
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
