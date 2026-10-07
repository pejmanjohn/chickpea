import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import {
  createAssistantMessageEventStream,
  createProvider,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type Usage,
} from '@earendil-works/pi-ai';
import type { FlueExecutionContext } from '@flue/runtime';

import {
  configureInstallationAdmission,
  resetInstallationAdmissionForTests,
} from '../../src/config/installation-admission.ts';
import { scopeInstallationEnv } from '../../src/config/installation-scope.ts';
import {
  configureModelAccessResolver,
  configureModelRequestRecorder,
  createModelAccessInterceptor,
  resetModelAccessForTests,
  withModelAccess,
  type AttemptModelAccess,
  type ModelAccessGrant,
} from '../../src/config/model-access.ts';
import { registerPiProvider, registeredPiProvider } from '../../src/config/pi-provider-registry.ts';
import type { PlatformEnv } from '../../src/config/state-backend.ts';
import { ANTHROPIC_COMPAT_PROVIDER_ID } from '../../src/model-catalog/provider-alias.ts';
import type { ModelRequestRecord } from '../../src/usage/model-requests.ts';
import { USAGE_RAW_RETENTION_DAYS } from '../../src/usage/retention.ts';
import { SqliteUsageStore, UsageStateError } from '../../src/usage/store.ts';

const DAY = 24 * 60 * 60 * 1_000;
const NOW = Date.UTC(2026, 9, 7, 12);

function storedRecord(overrides: Partial<ModelRequestRecord> = {}): ModelRequestRecord {
  return {
    requestId: 'request-1',
    installationId: 'installation-1',
    runId: 'submission-1',
    attemptId: 'attempt-1',
    agentId: 'agent_default',
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    fundingSource: 'customer',
    outcome: 'completed',
    inputTokens: 1_000,
    outputTokens: 500,
    cacheReadTokens: 2_000,
    cacheWriteTokens: 400,
    cacheWrite1hTokens: null,
    reasoningTokens: 120,
    priceVersionId: 'anthropic-sonnet-5-5_2026-10-06',
    listPriceUsdMicros: 8_400,
    priceUnknownReason: null,
    finishedAt: NOW,
    ...overrides,
  };
}

test('a request record is written once: a second write under its request ID leaves the first', async () => {
  const store = new SqliteUsageStore(':memory:', () => NOW);
  try {
    const first = storedRecord();
    assert.deepEqual(await store.recordModelRequest(first), first);
    assert.deepEqual(await store.recordModelRequest(first), first);
    const rewritten = storedRecord({ outcome: 'error', inputTokens: 9, agentId: null, finishedAt: NOW + 5 });
    assert.deepEqual(await store.recordModelRequest(rewritten), first);
    assert.deepEqual(await store.getModelRequest('request-1'), first);
    assert.equal(await store.getModelRequest('request-missing'), undefined);
  } finally {
    store.close();
  }
});

test('a request record is validated where the store receives it', async () => {
  const store = new SqliteUsageStore(':memory:', () => NOW);
  try {
    for (const invalid of [
      storedRecord({ inputTokens: -1 }),
      storedRecord({ outputTokens: 1.5 }),
      storedRecord({ requestId: '' }),
      storedRecord({ outcome: 'cancelled' as ModelRequestRecord['outcome'] }),
      storedRecord({ fundingSource: 'platform' as ModelRequestRecord['fundingSource'] }),
      storedRecord({ listPriceUsdMicros: null }),
      storedRecord({ priceUnknownReason: 'price_unknown' }),
      storedRecord({ priceVersionId: null, listPriceUsdMicros: null }),
      storedRecord({ priceVersionId: null, priceUnknownReason: 'price_unknown' }),
    ]) {
      await assert.rejects(
        store.recordModelRequest(invalid),
        (error: unknown) => error instanceof UsageStateError && error.code === 'usage_invalid_input',
      );
    }
    const unpriced = storedRecord({
      requestId: 'request-unpriced',
      priceVersionId: null,
      listPriceUsdMicros: null,
      priceUnknownReason: 'price_unknown',
    });
    assert.deepEqual(await store.recordModelRequest(unpriced), unpriced);
  } finally {
    store.close();
  }
});

test('retention deletes request records past the raw cutoff and keeps fresh ones', async () => {
  const store = new SqliteUsageStore(':memory:', () => NOW);
  try {
    const expired = storedRecord({ requestId: 'request-expired', finishedAt: NOW - (USAGE_RAW_RETENTION_DAYS + 1) * DAY });
    const fresh = storedRecord({ requestId: 'request-fresh', finishedAt: NOW - (USAGE_RAW_RETENTION_DAYS - 1) * DAY });
    await store.recordModelRequest(expired);
    await store.recordModelRequest(fresh);

    const result = await store.cleanupRetention(NOW);

    assert.equal(result.modelRequestsDeleted, 1);
    assert.equal(await store.getModelRequest('request-expired'), undefined);
    assert.deepEqual(await store.getModelRequest('request-fresh'), fresh);
  } finally {
    store.close();
  }
});

test('a request record leaves the per-turn usage operations and measurements empty', async () => {
  const store = new SqliteUsageStore(':memory:', () => NOW);
  try {
    await store.recordModelRequest(storedRecord());
    const query = { from: NOW - DAY, to: NOW + DAY };
    assert.deepEqual((await store.listOperations(query)).items, []);
    const summary = await store.summarize(query);
    assert.equal(summary.totals.operationCount, 0);
    assert.equal(summary.totals.inputTokens, null);
  } finally {
    store.close();
  }
});

type Script = (output: AssistantMessageEventStream) => void;

const SONNET = 'claude-sonnet-5-5';
const AGENT_OPERATION = { type: 'agent', operationId: 'op', operationKind: 'prompt' } as const;

function usage(partial: Partial<Usage> = {}): Usage {
  const input = partial.input ?? 0;
  const output = partial.output ?? 0;
  const cacheRead = partial.cacheRead ?? 0;
  const cacheWrite = partial.cacheWrite ?? 0;
  return {
    input, output, cacheRead, cacheWrite,
    ...(partial.cacheWrite1h === undefined ? {} : { cacheWrite1h: partial.cacheWrite1h }),
    ...(partial.reasoning === undefined ? {} : { reasoning: partial.reasoning }),
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function reply(stopReason: AssistantMessage['stopReason'], tokens: Partial<Usage> = {}): AssistantMessage {
  return {
    role: 'assistant', content: stopReason === 'stop' ? [{ type: 'text', text: 'ok' }] : [],
    api: 'anthropic-messages', provider: ANTHROPIC_COMPAT_PROVIDER_ID, model: SONNET, stopReason, timestamp: 1,
    usage: usage(tokens),
    ...(stopReason === 'stop' ? {} : { errorMessage: `provider ${stopReason}` }),
  };
}

const completes = (message: AssistantMessage): Script => (output) => {
  output.push({ type: 'done', reason: 'stop', message });
  output.end();
};
const fails = (message: AssistantMessage): Script => (output) => {
  output.push({ type: 'error', reason: message.stopReason as 'error' | 'aborted', error: message });
  output.end();
};

/** An Anthropic route under its bundled alias id, registered through the production seam, that plays one script per request. */
function scriptedAnthropic(scripts: Script[]): { model: Model<'anthropic-messages'>; sent: () => number } {
  const model = {
    id: SONNET, name: 'Sonnet', api: 'anthropic-messages', provider: ANTHROPIC_COMPAT_PROVIDER_ID,
    baseUrl: 'https://provider.invalid', reasoning: true, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_192,
  } as Model<'anthropic-messages'>;
  let sent = 0;
  const stream = () => {
    sent += 1;
    const output = createAssistantMessageEventStream();
    const script = scripts.shift();
    assert.ok(script, 'a scripted reply remains for every request sent');
    queueMicrotask(() => script(output));
    return output;
  };
  registerPiProvider(createProvider({
    id: ANTHROPIC_COMPAT_PROVIDER_ID,
    auth: { apiKey: { name: 'probe', resolve: async () => ({ auth: {} }) } },
    models: [model],
    api: { stream, streamSimple: stream },
  }));
  return { model, sent: () => sent };
}

function modelCall(model: Model<string>, text = 'hello'): Promise<AssistantMessage> {
  return registeredPiProvider(model.provider)!.streamSimple(model, {
    systemPrompt: 'probe',
    messages: [{ role: 'user', content: text, timestamp: 1 }],
  }, {}).result();
}

function grant(runId: string, installationId = 'chickpea'): ModelAccessGrant {
  return {
    installationId, providerId: 'anthropic', credentialRefId: 'cred_anthropic', credentialVersion: 1,
    runId, fundingSource: 'customer',
  };
}

/** Model access with a fixed key, and request records captured as written to an in-memory usage store. */
function recordingAccess(t: TestContext, write?: (record: ModelRequestRecord) => Promise<unknown>) {
  resetModelAccessForTests();
  const store = new SqliteUsageStore(':memory:');
  const written: Array<{ record: ModelRequestRecord; env: PlatformEnv | undefined }> = [];
  configureModelAccessResolver({ resolve: async () => ({ apiKey: 'sk-ant-records-test-key' }) });
  configureModelRequestRecorder((record, env) => {
    written.push({ record, env });
    return write ? write(record) : store.recordModelRequest(record);
  });
  t.after(() => {
    store.close();
    resetModelAccessForTests();
    resetInstallationAdmissionForTests();
  });
  return { store, written };
}

function attempt(instanceId: string): FlueExecutionContext {
  return { instanceId, submissionId: `sub_${instanceId}`, agentName: 'chickpea-slack-v2' };
}

function interceptorFor(access: AttemptModelAccess) {
  return createModelAccessInterceptor({
    lookup: async () => access,
    installationGrants: async () => { throw new Error('the lookup always returns the attempt grant'); },
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('a completed request writes one record with its attempt, Agent, canonical provider and list price', async (t) => {
  const { store, written } = recordingAccess(t);
  configureInstallationAdmission(async () => 'admitted');
  const env = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_records' });
  const { model } = scriptedAnthropic([
    completes(reply('stop', { input: 1_000, output: 500, cacheRead: 2_000, cacheWrite: 400, reasoning: 120 })),
    completes(reply('stop', { input: 10, output: 5, cacheWrite: 400, cacheWrite1h: 300 })),
  ]);
  const interceptor = interceptorFor({ env, grant: grant('sub_records', 'inst_records'), agentId: 'agent_records' });
  const before = Date.now();

  await interceptor(AGENT_OPERATION, attempt('records'), async () => {
    await modelCall(model);
    await modelCall(model);
  });

  assert.equal(written.length, 2);
  assert.equal(written[0]!.env, env, 'the record is written through the attempt env');
  const [priced, oneHour] = await Promise.all(written.map(({ record }) => store.getModelRequest(record.requestId)));
  assert.match(priced!.requestId, UUID);
  assert.match(priced!.attemptId, UUID);
  assert.ok(priced!.finishedAt >= before && priced!.finishedAt <= Date.now());
  assert.deepEqual(priced, {
    requestId: priced!.requestId,
    installationId: 'inst_records',
    runId: 'sub_records',
    attemptId: priced!.attemptId,
    agentId: 'agent_records',
    provider: 'anthropic',
    model: SONNET,
    fundingSource: 'customer',
    outcome: 'completed',
    inputTokens: 1_000,
    outputTokens: 500,
    cacheReadTokens: 2_000,
    cacheWriteTokens: 400,
    cacheWrite1hTokens: null,
    reasoningTokens: 120,
    priceVersionId: 'anthropic-sonnet-5-5_2026-10-06',
    // 1,000 x 2 + 500 x 10 + 2,000 x 0.2 + 400 x 2.5 micros
    listPriceUsdMicros: 8_400,
    priceUnknownReason: null,
    finishedAt: priced!.finishedAt,
  });
  assert.notEqual(oneHour!.requestId, priced!.requestId);
  assert.deepEqual(
    { ...oneHour, requestId: undefined, finishedAt: undefined },
    {
      ...priced, requestId: undefined, finishedAt: undefined,
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 400, cacheWrite1hTokens: 300,
      reasoningTokens: null, priceVersionId: null, listPriceUsdMicros: null,
      priceUnknownReason: 'pricing_dimension_unknown',
    },
  );
});

test('a provider retry in one attempt writes a record per request; one failed before usage records zero tokens', async (t) => {
  const { store, written } = recordingAccess(t);
  const { model } = scriptedAnthropic([
    fails(reply('error')),
    completes(reply('stop', { input: 40, output: 8 })),
    completes(reply('stop', { input: 41, output: 9 })),
  ]);
  const interceptor = interceptorFor({ env: undefined, grant: grant('sub_retry'), agentId: 'agent_retry' });

  await interceptor(AGENT_OPERATION, attempt('retry'), async () => {
    assert.equal((await modelCall(model)).stopReason, 'error');
    assert.equal((await modelCall(model)).stopReason, 'stop');
  });
  await interceptor(AGENT_OPERATION, attempt('retry'), () => modelCall(model));

  const [failed, retried, resumed] = await Promise.all(written.map(({ record }) => store.getModelRequest(record.requestId)));
  assert.equal(new Set([failed!.requestId, retried!.requestId, resumed!.requestId]).size, 3);
  assert.equal(failed!.attemptId, retried!.attemptId, 'a retry stays in its attempt');
  assert.notEqual(resumed!.attemptId, retried!.attemptId, 'a new binding is a new attempt');
  assert.deepEqual(
    [failed!.outcome, failed!.inputTokens, failed!.outputTokens, failed!.cacheReadTokens, failed!.cacheWriteTokens],
    ['error', 0, 0, 0, 0],
  );
  assert.deepEqual([retried!.outcome, retried!.inputTokens, retried!.outputTokens], ['completed', 40, 8]);
  assert.deepEqual([failed!.runId, failed!.agentId, failed!.installationId], ['sub_retry', 'agent_retry', 'chickpea']);
});

test('a stream stopped part way records its partial usage as stopped', async (t) => {
  const { store, written } = recordingAccess(t);
  const partial = reply('aborted', { input: 800, output: 37 });
  const { model } = scriptedAnthropic([(output) => {
    output.push({ type: 'start', partial: { ...partial, stopReason: 'stop' } });
    fails(partial)(output);
  }]);

  const result = await withModelAccess(grant('stateless_stop'), undefined, () => modelCall(model));

  assert.deepEqual(result, partial);
  const record = await store.getModelRequest(written[0]!.record.requestId);
  assert.deepEqual(
    [record!.outcome, record!.inputTokens, record!.outputTokens, record!.runId, record!.agentId],
    ['stopped', 800, 37, 'stateless_stop', null],
  );
});

test('a request refused admission on a hosted cell sends nothing and writes no record', async (t) => {
  const { written } = recordingAccess(t);
  configureInstallationAdmission(async () => 'refused');
  const env = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_refused' });
  const { model, sent } = scriptedAnthropic([]);

  const result = await withModelAccess(grant('stateless_refused', 'inst_refused'), env, () => modelCall(model));

  assert.equal(result.stopReason, 'error');
  assert.equal(sent(), 0);
  assert.equal(written.length, 0);
});

test('a failing record write leaves the model result unchanged and logs one content-free line per failure', async (t) => {
  let writes = 0;
  const { written } = recordingAccess(t, () => {
    writes += 1;
    if (writes === 1) throw Object.assign(new Error('secret prompt text'), { code: 'usage_invalid_input' });
    return Promise.reject(new TypeError('another secret'));
  });
  const warn = t.mock.method(console, 'warn', () => undefined);
  const first = reply('stop', { input: 3, output: 2 });
  const second = reply('stop', { input: 4, output: 1 });
  const { model } = scriptedAnthropic([completes(first), completes(second)]);

  const results = await withModelAccess(grant('stateless_failing'), undefined, async () =>
    [await modelCall(model), await modelCall(model)]);

  assert.deepEqual(results, [first, second]);
  assert.deepEqual(warn.mock.calls.map((call) => call.arguments), written.map(({ record }, index) => [
    '[chickpea] model request record failed',
    { provider: 'anthropic', model: SONNET, requestId: record.requestId, error: ['usage_invalid_input', 'TypeError'][index] },
  ]));
});

test('a hanging record write lets the stream end after its budget', { timeout: 10_000 }, async (t) => {
  recordingAccess(t, () => new Promise(() => undefined));
  const message = reply('stop', { input: 1, output: 1 });
  const { model } = scriptedAnthropic([completes(message)]);
  const started = Date.now();

  const result = await withModelAccess(grant('stateless_hanging'), undefined, () => modelCall(model));

  const elapsed = Date.now() - started;
  assert.deepEqual(result, message);
  assert.ok(elapsed >= 1_900 && elapsed < 4_000, `ended after ${elapsed} ms`);
});

test('the record is in the store when the caller reads the request result', async (t) => {
  const store = new SqliteUsageStore(':memory:');
  t.after(() => store.close());
  const { written } = recordingAccess(t, async (record) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return store.recordModelRequest(record);
  });
  const { model } = scriptedAnthropic([completes(reply('stop', { input: 7, output: 3 }))]);

  await withModelAccess(grant('stateless_ordered'), undefined, async () => {
    await modelCall(model);
    assert.equal((await store.getModelRequest(written[0]!.record.requestId))?.inputTokens, 7);
  });
});
