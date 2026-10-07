import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import {
  createAssistantMessageEventStream,
  createProvider,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type StreamOptions,
  type Usage,
} from '@earendil-works/pi-ai';
import { init, instrument, useAgentStart, useModel, useTool, type FlueExecutionContext } from '@flue/runtime';
import { start } from '@flue/runtime/node';

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
import { ANTHROPIC_COMPAT_PROVIDER_ID, OPENAI_PLATFORM_COMPAT_PROVIDER_ID } from '../../src/model-catalog/provider-alias.ts';
import { createCloudflareBindingProvider } from '../../src/cloudflare-provider.ts';
import { createChickpeaPiProvider } from '../../src/config/pi-provider.ts';
import { runStatelessVisionCall } from '../../src/images/inspect-output.ts';
import { promptSlackThreadAgent } from '../../src/slack/flue-dispatch.ts';
import type { FlueDispatchEnvelopeV1 } from '../../src/slack/turn-job-types.ts';
import type { ModelRequestRecord } from '../../src/usage/model-requests.ts';
import { priceCatalogFor } from '../../src/usage/pricing/catalog.ts';
import { USAGE_RAW_RETENTION_DAYS } from '../../src/usage/retention.ts';
import { openStateDb } from '../../src/state/node-state-db.ts';
import { SqliteUsageStore, UsageStateError, UsageStoreLogic } from '../../src/usage/store.ts';

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
    outputTokens: { total: 500, reasoning: 120 },
    cacheReadTokens: 2_000,
    cacheWriteTokens: { total: 400, oneHour: null },
    priceVersionId: 'anthropic-sonnet-5-5_2026-10-06',
    listPriceUsdMicros: 8_400,
    priceUnknownReason: null,
    providerCostUsdMicros: null,
    providerResponseId: null,
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
      storedRecord({ outputTokens: { total: 1.5, reasoning: null } }),
      storedRecord({ outputTokens: { total: 5, reasoning: 6 } }),
      storedRecord({ cacheWriteTokens: { total: 400, oneHour: 401 } }),
      storedRecord({ outputTokens: 5 as unknown as ModelRequestRecord['outputTokens'] }),
      storedRecord({ requestId: '' }),
      storedRecord({ outcome: 'cancelled' as ModelRequestRecord['outcome'] }),
      storedRecord({ fundingSource: 'sponsor' as ModelRequestRecord['fundingSource'] }),
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
    const platform = storedRecord({ requestId: 'request-platform', fundingSource: 'platform' });
    assert.deepEqual(await store.recordModelRequest(platform), platform);
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

test('a request record keeps its provider-billed cost and response ID, and refuses unusable ones', async () => {
  const store = new SqliteUsageStore(':memory:', () => NOW);
  try {
    const billed = storedRecord({ requestId: 'request-billed', providerCostUsdMicros: 8, providerResponseId: 'gen-fixture-0001' });
    assert.deepEqual(await store.recordModelRequest(billed), billed);
    assert.deepEqual(await store.getModelRequest('request-billed'), billed);
    for (const invalid of [
      storedRecord({ providerCostUsdMicros: -1 }),
      storedRecord({ providerCostUsdMicros: 7.5 }),
      storedRecord({ providerResponseId: '' }),
      storedRecord({ providerResponseId: 'gen-\u0007' }),
      storedRecord({ providerResponseId: 'g'.repeat(257) }),
    ]) {
      await assert.rejects(
        store.recordModelRequest(invalid),
        (error: unknown) => error instanceof UsageStateError && error.code === 'usage_invalid_input',
      );
    }
    const { providerCostUsdMicros: _cost, providerResponseId: _id, ...older } = storedRecord({ requestId: 'request-older' });
    assert.deepEqual(
      await store.recordModelRequest(older as ModelRequestRecord),
      storedRecord({ requestId: 'request-older' }),
      'a record from a caller that predates both fields writes them as null',
    );
  } finally {
    store.close();
  }
});

test('a request table from before provider costs gains both columns, and its rows read back with nulls', () => {
  const db = openStateDb(':memory:');
  db.exec(
    `CREATE TABLE usage_model_requests (
      request_id TEXT PRIMARY KEY,
      installation_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      agent_id TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      funding_source TEXT NOT NULL,
      outcome TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      output_tokens_reasoning INTEGER,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      cache_write_tokens_one_hour INTEGER,
      price_version_id TEXT,
      list_price_usd_micros INTEGER,
      price_unknown_reason TEXT,
      finished_at INTEGER NOT NULL
    )`,
  );
  const old = storedRecord({ requestId: 'request-old' });
  db.run(
    `INSERT INTO usage_model_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    old.requestId, old.installationId, old.runId, old.attemptId, old.agentId, old.provider, old.model,
    old.fundingSource, old.outcome, old.inputTokens, old.outputTokens.total, old.outputTokens.reasoning,
    old.cacheReadTokens, old.cacheWriteTokens.total, old.cacheWriteTokens.oneHour, old.priceVersionId,
    old.listPriceUsdMicros, old.priceUnknownReason, old.finishedAt,
  );

  const store = new UsageStoreLogic(db, () => NOW);

  const columns = db.all('PRAGMA table_info(usage_model_requests)').map((row) => row.name);
  assert.ok(columns.includes('provider_cost_usd_micros') && columns.includes('provider_response_id'), String(columns));
  assert.deepEqual(store.getModelRequest('request-old'), old);
  const billed = storedRecord({ requestId: 'request-new', providerCostUsdMicros: 13, providerResponseId: 'gen-fixture-0002' });
  assert.deepEqual(store.recordModelRequest(billed), billed);
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

function scriptedAnthropic(scripts: Script[]) {
  return scriptedProvider(ANTHROPIC_COMPAT_PROVIDER_ID, 'anthropic-messages', SONNET, scripts);
}

function scriptedProvider(id: string, api: 'anthropic-messages' | 'openai-responses', modelId: string, scripts: Script[]) {
  const model = {
    id: modelId, name: modelId, api, provider: id,
    baseUrl: 'https://provider.invalid', reasoning: true, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_192,
  } as Model<typeof api>;
  let sent = 0;
  const received: Array<StreamOptions | undefined> = [];
  const stream = (_model: Model<string>, _context: unknown, options?: StreamOptions) => {
    sent += 1;
    received.push(options);
    const output = createAssistantMessageEventStream();
    const script = scripts.shift();
    assert.ok(script, 'a scripted reply remains for every request sent');
    queueMicrotask(() => script(output));
    return output;
  };
  registerPiProvider(createProvider({
    id,
    auth: { apiKey: { name: 'probe', resolve: async () => ({ auth: {} }) } },
    models: [model],
    api: { stream, streamSimple: stream },
  }));
  return { model, sent: () => sent, received };
}

function modelCall(
  model: Model<string>,
  method: 'stream' | 'streamSimple' = 'streamSimple',
  options: { fetch?: typeof fetch } = {},
): Promise<AssistantMessage> {
  return registeredPiProvider(model.provider)![method](model, {
    systemPrompt: 'probe',
    messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
  }, options).result();
}

function grant(
  runId: string,
  installationId = 'chickpea',
  providerId: ModelAccessGrant['providerId'] = 'anthropic',
): ModelAccessGrant {
  return {
    installationId, providerId, credentialRefId: `cred_${providerId}`, credentialVersion: 1,
    runId, fundingSource: 'customer',
  };
}

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
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  configureInstallationAdmission(async () => 'admitted');
  const env = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_records' });
  const { model } = scriptedAnthropic([
    completes(reply('stop', { input: 1_000, output: 500, cacheRead: 2_000, cacheWrite: 400, reasoning: 120 })),
    completes(reply('stop', { input: 10, output: 5, cacheWrite: 400, cacheWrite1h: 300 })),
  ]);
  const interceptor = interceptorFor({ env, grant: grant('sub_records', 'inst_records'), agentId: 'agent_records' });

  await interceptor(AGENT_OPERATION, attempt('records'), async () => {
    await modelCall(model, 'streamSimple');
    await modelCall(model, 'stream');
  });

  const sonnet = priceCatalogFor('standard_input_output', 'anthropic', SONNET, NOW);
  assert.ok(sonnet?.rate.cacheReadMicrosPerUnit && sonnet.rate.cacheWriteMicrosPerUnit && sonnet.rate.cacheWrite1hMicrosPerUnit);
  const { rate } = sonnet;
  assert.equal(written.length, 2);
  assert.equal(written[0]!.env, env, 'the record is written through the attempt env');
  const [priced, oneHour] = await Promise.all(written.map(({ record }) => store.getModelRequest(record.requestId)));
  assert.match(priced!.requestId, UUID);
  assert.match(priced!.attemptId, UUID);
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
    outputTokens: { total: 500, reasoning: 120 },
    cacheReadTokens: 2_000,
    cacheWriteTokens: { total: 400, oneHour: null },
    priceVersionId: sonnet.version.id,
    listPriceUsdMicros: Math.round((1_000 * rate.inputMicrosPerUnit + 500 * rate.outputMicrosPerUnit +
      2_000 * rate.cacheReadMicrosPerUnit! + 400 * rate.cacheWriteMicrosPerUnit!) / rate.unitScale),
    priceUnknownReason: null,
    providerCostUsdMicros: null,
    providerResponseId: null,
    finishedAt: NOW,
  });
  assert.notEqual(oneHour!.requestId, priced!.requestId);
  assert.deepEqual(
    { ...oneHour, requestId: undefined },
    {
      ...priced, requestId: undefined,
      inputTokens: 10, outputTokens: { total: 5, reasoning: null }, cacheReadTokens: 0,
      cacheWriteTokens: { total: 400, oneHour: 300 },
      listPriceUsdMicros: Math.round((10 * rate.inputMicrosPerUnit + 5 * rate.outputMicrosPerUnit +
        100 * rate.cacheWriteMicrosPerUnit! + 300 * rate.cacheWrite1hMicrosPerUnit!) / rate.unitScale),
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
    [failed!.outcome, failed!.inputTokens, failed!.outputTokens.total, failed!.cacheReadTokens, failed!.cacheWriteTokens.total],
    ['error', 0, 0, 0, 0],
  );
  assert.deepEqual([retried!.outcome, retried!.inputTokens, retried!.outputTokens.total], ['completed', 40, 8]);
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
    [record!.outcome, record!.inputTokens, record!.outputTokens.total, record!.runId, record!.agentId],
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
    { route: ANTHROPIC_COMPAT_PROVIDER_ID, model: SONNET, requestId: record.requestId, error: ['usage_invalid_input', 'TypeError'][index] },
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

test('an Anthropic or OpenAI request records no provider cost and its usable response ID, and its provider gets the caller fetch', async (t) => {
  const { store, written } = recordingAccess(t);
  const callerFetch: typeof fetch = async () => { throw new Error('a scripted provider sends nothing'); };
  const anthropic = scriptedAnthropic([
    completes({ ...reply('stop', { input: 5, output: 2 }), responseId: 'msg_01Fixture' }),
    completes({ ...reply('stop', { input: 6, output: 3 }), responseId: 'msg_\u0007bell' }),
  ]);
  const openaiModel = 'gpt-5.6-terra';
  const openai = scriptedProvider(OPENAI_PLATFORM_COMPAT_PROVIDER_ID, 'openai-responses', openaiModel, [completes({
    ...reply('stop', { input: 7, output: 4 }),
    api: 'openai-responses', provider: OPENAI_PLATFORM_COMPAT_PROVIDER_ID, model: openaiModel, responseId: 'resp_fixture',
  })]);

  await withModelAccess(grant('stateless_anthropic'), undefined, async () => {
    await modelCall(anthropic.model, 'streamSimple', { fetch: callerFetch });
    await modelCall(anthropic.model, 'stream', { fetch: callerFetch });
  });
  await withModelAccess(grant('stateless_openai', 'chickpea', 'openai'), undefined, () =>
    modelCall(openai.model, 'streamSimple', { fetch: callerFetch }));

  assert.deepEqual([...anthropic.received, ...openai.received].map((options) => options?.fetch),
    [callerFetch, callerFetch, callerFetch]);
  const records = await Promise.all(written.map(({ record }) => store.getModelRequest(record.requestId)));
  assert.deepEqual(
    records.map((record) => [record?.provider, record?.inputTokens, record?.providerCostUsdMicros, record?.providerResponseId]),
    [
      ['anthropic', 5, null, 'msg_01Fixture'],
      ['anthropic', 6, null, null],
      ['openai', 7, null, 'resp_fixture'],
    ],
  );
});

function instrumentedLane(agentId: string) {
  const interceptor = createModelAccessInterceptor({
    lookup: async () => ({ env: undefined, deploymentLane: true, agentId }),
    installationGrants: async () => [],
  });
  const dispose = instrument({ key: Symbol(agentId), interceptor, observe() {}, dispose() {} });
  return { dispose };
}

function workersAiResponse(content: string, input = 10, tool = false): Response {
  return new Response(`data: ${JSON.stringify({
    choices: [{ index: 0, delta: tool ? { tool_calls: [{ index: 0, id: 'call_read', type: 'function',
      function: { name: 'read_fixture', arguments: '{}' } }] } : { content }, finish_reason: tool ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: input, completion_tokens: 3, total_tokens: input + 3 },
  })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

test('a real Flue overflow compaction writes one record per provider call, the compaction included', { timeout: 20_000 }, async (t) => {
  const { store, written } = recordingAccess(t);
  const lane = instrumentedLane('agent_compact');
  t.after(lane.dispose);
  const modelId = '@cf/zai-org/glm-5.3-flash';
  function CompactionProbe() {
    useModel(`cloudflare/${modelId}`);
    useTool({ name: 'read_fixture', description: 'Read the synthetic fixture.', run: () => 'synthetic fixture' });
    return 'Follow the scripted synthetic fixture.';
  }
  let calls = 0;
  const provider = createCloudflareBindingProvider({ run: async () => {
    calls++;
    if (calls === 1) return workersAiResponse('First answer.');
    if (calls === 2) return workersAiResponse('', 10, true);
    if (calls === 3) return workersAiResponse('Partial answer.', 40_000);
    if (calls === 4) return workersAiResponse('Compacted synthetic context.', 20);
    if (calls === 5) return workersAiResponse('Recovered answer.');
    throw new Error('Unexpected additional model call.');
  } });
  const catalog = provider.getModels();
  provider.getModels = () => catalog.map((model) => ({ ...model, contextWindow: 32_768 }));
  registerPiProvider(provider);
  const runtime = await start({
    agents: [{ agent: CompactionProbe, name: 'records-compaction-probe' }],
    providers: [registeredPiProvider(provider.id)!],
  });
  try {
    const agent = init(CompactionProbe, { id: 'records-compaction' });
    await agent.read(await agent.dispatch('First synthetic context. '.repeat(5000)));
    const receipt = await agent.dispatch('Second synthetic context. '.repeat(2000));
    const reply = await promptSlackThreadAgent({
      handle: agent, message: 'unused saved dispatch', turnId: 'records-compaction',
      conversationKey: 'T_FIXTURE:C_FIXTURE:1',
      requestedModel: `cloudflare/${modelId}`,
      state: {
        dispatchEnvelope: { instanceId: 'records-compaction' } as FlueDispatchEnvelopeV1,
        dispatchReceipt: receipt,
        prepare: () => { throw new Error('Must reuse saved dispatch'); },
        reconcileExistingInstance: () => { throw new Error('Must reuse saved instance'); },
        recordReceipt: (value) => value,
        recordSettlement: (value) => value,
        markRecoveryRequired: () => {},
      },
    });
    assert.equal(reply.text, 'Recovered answer.');
  } finally {
    await runtime.stop();
  }

  assert.equal(calls, 5);
  const records = await Promise.all(written.map(({ record }) => store.getModelRequest(record.requestId)));
  assert.deepEqual(
    records.map((record) => [record!.outcome, record!.inputTokens, record!.provider, record!.model, record!.agentId]),
    [
      ['completed', 10, 'cloudflare', modelId, 'agent_compact'],
      ['completed', 10, 'cloudflare', modelId, 'agent_compact'],
      ['error', 40_000, 'cloudflare', modelId, 'agent_compact'],
      ['completed', 20, 'cloudflare', modelId, 'agent_compact'],
      ['completed', 10, 'cloudflare', modelId, 'agent_compact'],
    ],
  );
  assert.equal(records[3]!.attemptId, records[2]!.attemptId, 'the compaction runs in the overflowing attempt');
  assert.equal(new Set(records.map((record) => record!.requestId)).size, 5);
});

test('an attachment analysis prompt from agent start records under the same attempt and Agent as the reply', { timeout: 20_000 }, async (t) => {
  const { store, written } = recordingAccess(t);
  const lane = instrumentedLane('agent_attachments');
  t.after(lane.dispose);
  const replies = [
    reply('stop', { input: 300, output: 30 }),
    reply('stop', { input: 120, output: 12 }),
  ];
  const provider = createProvider({
    id: 'records-attachment-lane',
    auth: { apiKey: { name: 'probe', resolve: async () => ({ auth: {} }) } },
    models: [{
      id: 'probe', name: 'Probe', api: 'anthropic-messages', provider: 'records-attachment-lane',
      baseUrl: 'https://provider.invalid', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 1_024,
    } as Model<'anthropic-messages'>],
    api: {
      stream: () => { const output = createAssistantMessageEventStream(); queueMicrotask(() => completes(replies.shift()!)(output)); return output; },
      streamSimple: () => { const output = createAssistantMessageEventStream(); queueMicrotask(() => completes(replies.shift()!)(output)); return output; },
    },
  });
  registerPiProvider(provider);
  let analysis = '';
  function AttachmentProbe() {
    useModel('records-attachment-lane/probe');
    useAgentStart(async ({ harness }) => {
      analysis = (await harness.prompt('Describe the attached file.')).text;
    });
    return 'Answer with the attachment in mind.';
  }
  const runtime = await start({
    agents: [{ agent: AttachmentProbe, name: 'records-attachment-probe' }],
    providers: [registeredPiProvider(provider.id)!],
  });
  try {
    const agent = init(AttachmentProbe, { id: 'records-attachment' });
    await agent.read(await agent.dispatch('What is in the file?'));
  } finally {
    await runtime.stop();
  }

  assert.equal(analysis, 'ok');
  const [analyzed, answered] = await Promise.all(written.map(({ record }) => store.getModelRequest(record.requestId)));
  assert.equal(written.length, 2);
  assert.deepEqual([analyzed!.inputTokens, answered!.inputTokens], [300, 120]);
  assert.equal(analyzed!.attemptId, answered!.attemptId);
  assert.equal(analyzed!.runId, answered!.runId);
  assert.deepEqual([analyzed!.agentId, answered!.agentId], ['agent_attachments', 'agent_attachments']);
});

test('a stateless vision check inside an attempt records one request under that attempt', async (t) => {
  const { store, written } = recordingAccess(t);
  const model: Model<string> = { id: 'vision', name: 'Vision', provider: 'records-vision-lane', api: 'records-vision-lane',
    input: ['text', 'image'], reasoning: false, baseUrl: 'https://provider.invalid', contextWindow: 32_000, maxTokens: 2_048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const stream = () => {
    const output = createAssistantMessageEventStream();
    queueMicrotask(() => completes({ ...reply('stop', { input: 900, output: 4 }), provider: model.provider, model: model.id })(output));
    return output;
  };
  registerPiProvider(createChickpeaPiProvider({ id: model.provider, apiKey: 'synthetic-test-key', models: [model],
    api: { stream, streamSimple: stream } }));
  const interceptor = interceptorFor({ env: undefined, deploymentLane: true, agentId: 'agent_vision' });

  const text = await interceptor(AGENT_OPERATION, attempt('vision'), () =>
    runStatelessVisionCall(`${model.provider}/${model.id}`, { systemPrompt: 'Look.', content: 'Is it blue?' }));

  assert.equal(text, 'ok');
  assert.equal(written.length, 1);
  const record = await store.getModelRequest(written[0]!.record.requestId);
  assert.deepEqual(
    [record!.provider, record!.model, record!.inputTokens, record!.outputTokens.total, record!.runId, record!.agentId, record!.outcome],
    ['records-vision-lane', 'vision', 900, 4, 'sub_vision', 'agent_vision', 'completed'],
  );
});
