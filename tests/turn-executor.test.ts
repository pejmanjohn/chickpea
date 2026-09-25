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
