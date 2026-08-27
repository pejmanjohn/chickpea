import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ErrorCode, type WebClient } from '@slack/web-api';

import { activityStatus } from '../src/activity/status.ts';
import {
  emitSemanticActivityTelemetry,
  semanticTelemetryForStatus,
  type SemanticActivityTelemetrySink,
} from '../src/activity/telemetry.ts';
import { registerSlackStatusTurn } from '../src/slack/status-registry.ts';
import { WebClientPresenter } from '../src/slack/web-client-presenter.ts';

function recordingSink(): SemanticActivityTelemetrySink & { records: Array<Record<string, unknown>> } {
  const records: Array<Record<string, unknown>> = [];
  return {
    records,
    info(message: string) {
      const prefix = '[chickpea:activity] ';
      assert.ok(message.startsWith(prefix));
      records.push(JSON.parse(message.slice(prefix.length)) as Record<string, unknown>);
    },
  };
}

test('semantic activity telemetry serializes only fixed enums, booleans, and bounded timing', () => {
  const sink = recordingSink();
  const credential = 'sk-live-do-not-record-this';

  emitSemanticActivityTelemetry({
    event: 'activity.transport',
    surface: 'assistant_status',
    outcome: 'acknowledged',
    durationMs: Number.MAX_SAFE_INTEGER,
    status: `Checking Gmail ${credential}`,
    prompt: credential,
    toolName: credential,
    result: credential,
    error: credential,
    workspaceId: credential,
    submissionId: credential,
  } as never, sink);

  assert.deepEqual(sink.records, [{
    schemaVersion: 1,
    event: 'activity.transport',
    surface: 'assistant_status',
    outcome: 'acknowledged',
    durationMs: 300_000,
  }]);
  assert.equal(JSON.stringify(sink.records).includes(credential), false);
  assert.equal('submissionToken' in sink.records[0]!, false);
});

test('canonical status copy reduces to closed family and phase facts without retaining labels', () => {
  const gmailStart = activityStatus('checking', 'Checking', 'Gmail');
  const gmailReview = activityStatus('reading', 'Reviewing', 'Gmail messages');

  assert.deepEqual(semanticTelemetryForStatus(gmailStart), {
    family: 'managed_connector',
    phase: 'working',
  });
  assert.deepEqual(semanticTelemetryForStatus(gmailReview), {
    family: 'managed_connector',
    phase: 'reviewing',
  });
  assert.deepEqual(
    semanticTelemetryForStatus(activityStatus('writing', 'Drafting', 'the response')),
    { family: 'response', phase: 'drafting' },
  );
  assert.deepEqual(
    semanticTelemetryForStatus(activityStatus('checking', 'Checking', 'memory')),
    { family: 'memory', phase: 'working' },
  );
});

test('status queue telemetry records coalescing, supersession, refresh, and stale drops', async () => {
  const sink = recordingSink();
  const firstWrite = Promise.withResolvers<boolean>();
  const calls: string[] = [];
  const turn = registerSlackStatusTurn('telemetry-queue-instance', {
    setStatus(update) {
      calls.push(update.text);
      return calls.length === 1 ? firstWrite.promise : Promise.resolve(true);
    },
  }, {
    generation: 'telemetry-generation',
    refreshIntervalMs: 15,
    observedMinIntervalMs: 1,
    telemetry: sink,
  });

  const thinking = activityStatus('preparing', 'Thinking', 'the request');
  const gmail = activityStatus('checking', 'Checking', 'Gmail');
  const reviewing = activityStatus('reading', 'Reviewing', 'Gmail messages');
  const first = turn.setStatus(thinking);
  const coalesced = turn.setStatus(thinking);
  const superseded = turn.setStatus(gmail);
  const newest = turn.setStatus(reviewing);

  assert.equal(await superseded, false);
  firstWrite.resolve(true);
  assert.equal(await first, true);
  assert.equal(await coalesced, true);
  assert.equal(await newest, true);
  await new Promise((resolve) => setTimeout(resolve, 25));
  await turn.prepareFinal();
  assert.equal(await turn.setStatus(gmail), false);
  turn.close();

  const dispositions = sink.records
    .filter((record) => record.event === 'activity.queue')
    .map((record) => record.disposition);
  assert.ok(dispositions.includes('enqueued'));
  assert.ok(dispositions.includes('coalesced'));
  assert.ok(dispositions.includes('superseded'));
  assert.ok(dispositions.includes('terminal_dropped'));
  assert.ok(sink.records.some((record) =>
    record.event === 'activity.refresh' && record.outcome === 'attempted'
  ));
  assert.ok(sink.records.some((record) =>
    record.event === 'activity.produced' &&
    record.family === 'managed_connector' &&
    record.phase === 'reviewing'
  ));
});

test('native transport, shared rate, rejection latch, and clear outcomes are content-free', async () => {
  const sink = recordingSink();
  const accepted = new WebClientPresenter({
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
  } as unknown as WebClient, {
    channelId: 'C_PRIVATE',
    threadTs: '1782770400.000100',
    agentName: 'Private agent name',
    agentId: 'agent_private',
  }, undefined, {
    activityTelemetry: sink,
    activityStatusCoordinator: {
      reserve: async () => ({ outcome: 'reserved' }),
      applyCooldown: async () => undefined,
    },
  });

  assert.equal(await accepted.setStatus(activityStatus('checking', 'Checking', 'Gmail')), true);
  assert.equal(await accepted.clearStatus(), 'acknowledged');

  let attempts = 0;
  const rejected = new WebClientPresenter({
    assistant: { threads: { setStatus: async () => {
      attempts += 1;
      throw Object.assign(new Error('private provider failure'), {
        code: ErrorCode.RateLimitedError,
        retryAfter: 2,
      });
    } } },
  } as unknown as WebClient, {
    channelId: 'C_PRIVATE',
    threadTs: '1782770400.000100',
    agentName: 'Private agent name',
    agentId: 'agent_private',
  }, undefined, {
    activityTelemetry: sink,
    activityStatusCoordinator: {
      reserve: async () => ({ outcome: 'reserved' }),
      applyCooldown: async () => undefined,
    },
  });

  assert.equal(await rejected.setStatus(activityStatus('checking', 'Checking', 'Gmail')), false);
  assert.equal(await rejected.setStatus(activityStatus('writing', 'Drafting', 'the response')), false);
  assert.equal(attempts, 1);

  assert.ok(sink.records.some((record) =>
    record.event === 'activity.transport' && record.outcome === 'acknowledged'
  ));
  assert.ok(sink.records.some((record) =>
    record.event === 'activity.transport' && record.outcome === 'rejected'
  ));
  assert.ok(sink.records.some((record) =>
    record.event === 'activity.transport' && record.outcome === 'latched_off'
  ));
  assert.ok(sink.records.some((record) =>
    record.event === 'activity.clear' && record.outcome === 'acknowledged'
  ));
  assert.ok(sink.records.some((record) =>
    record.event === 'activity.rate' && record.outcome === 'cooldown' &&
    record.durationMs === 2_000
  ));
  const serialized = JSON.stringify(sink.records);
  for (const forbidden of ['C_PRIVATE', 'agent_private', 'Private agent name', 'Gmail', 'provider failure']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});
