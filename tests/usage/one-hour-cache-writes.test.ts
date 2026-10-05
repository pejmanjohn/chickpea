import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createAssistantMessageEventStream,
  createProvider,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type Provider,
} from '@earendil-works/pi-ai';
import { defineTool, init, instrument, useModel, useTool } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import * as v from 'valibot';

import { createInstallationModelAccessResolver } from '../../src/config/installation-model-access.ts';
import { configureModelAccessResolver, resetModelAccessForTests } from '../../src/config/model-access.ts';
import { rotateInstallationModelCredential } from '../../src/config/model-credential-refs.ts';
import { registerPiProvider } from '../../src/config/pi-provider-registry.ts';
import { invalidateProviderKeyCache } from '../../src/config/provider-keys.ts';
import { SqliteSettingsStore } from '../../src/config/settings-store.ts';
import { resultFromAgentReply } from '../../src/slack/flue-dispatch.ts';
import { classifySlackInteraction } from '../../src/slack/interaction-intent.ts';
import {
  CHICKPEA_RESPONSE_METADATA_KEY,
  observeResponseMetadata,
  parseChickpeaResponseMetadata,
  responseMetadataInterceptor,
  useChickpeaResponseMetadata,
} from '../../src/usage/response-metadata.ts';
import { InteractionUsageRecorder, interactionReportedUsage } from '../../src/usage/runtime-recorder.ts';
import { SqliteUsageStore } from '../../src/usage/store.ts';
import { withEnv } from '../helpers/env.ts';

/** Report `tokens` of each response's cache writes as one-hour writes, as Anthropic does. */
function withOneHourCacheWrites(provider: Provider, tokens: () => number): Provider {
  const longWrites = (message: AssistantMessage): AssistantMessage => ({
    ...message,
    usage: {
      ...message.usage,
      cacheWrite: message.usage.cacheWrite + tokens(),
      cacheWrite1h: tokens(),
      totalTokens: message.usage.totalTokens + tokens(),
    },
  });
  const wrap = (source: AssistantMessageEventStream): AssistantMessageEventStream => {
    const target = createAssistantMessageEventStream();
    void (async () => {
      for await (const event of source) {
        if (event.type === 'done') {
          const message = longWrites(event.message);
          target.push({ ...event, message });
          target.end(message);
          return;
        }
        target.push(event);
      }
      target.end(await source.result());
    })();
    return target;
  };
  return new Proxy(provider, {
    get(target, property) {
      if (property === 'stream' || property === 'streamSimple') {
        const original = Reflect.get(target, property, target) as Provider['stream'];
        return ((model, context, options) =>
          wrap(original.call(target, model, context, options))) as Provider['stream'];
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('an Agent response sums each step\'s one-hour cache writes into its usage', async () => {
  const model = 'faux/one-hour-cache';
  const registration = instrument({
    key: Symbol('one-hour-cache-writes'),
    interceptor: responseMetadataInterceptor,
    observe: observeResponseMetadata,
    dispose() {},
  });
  function OneHourCacheProbe() {
    useModel(model);
    useChickpeaResponseMetadata(model);
    useTool(defineTool({
      name: 'look_up',
      description: 'Look the answer up.',
      input: v.object({}),
      output: v.string(),
      async run() { return { output: 'found' }; },
    }));
    return 'Look the answer up once, then answer.';
  }
  let longWrites = 7;
  const faux = fauxProvider({ models: [{ id: 'one-hour-cache' }] });
  const flue = await start({
    agents: [{ agent: OneHourCacheProbe, name: 'one-hour-cache-probe' }],
    providers: [withOneHourCacheWrites(faux.provider, () => longWrites)],
  });
  try {
    const reply = async (id: string) => {
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('look_up', {})], { stopReason: 'toolUse' }),
        fauxAssistantMessage('Found it.'),
      ]);
      const handle = init(OneHourCacheProbe, { id });
      return handle.read(await handle.dispatch({ message: 'What is the answer?' }));
    };

    const long = await reply('one-hour-cache-long');
    const envelope = parseChickpeaResponseMetadata(long.metadata?.[CHICKPEA_RESPONSE_METADATA_KEY]);
    assert.equal(envelope?.usage.cacheWrite1h, 14, 'two steps of 7');
    assert.ok(envelope && envelope.usage.cacheWrite >= 14);
    assert.equal(resultFromAgentReply(long, model).reportedUsage?.cacheWrite1hTokens, 14);

    longWrites = 0;
    const short = await reply('one-hour-cache-short');
    const shortEnvelope = parseChickpeaResponseMetadata(short.metadata?.[CHICKPEA_RESPONSE_METADATA_KEY]);
    assert.ok(shortEnvelope);
    assert.equal('cacheWrite1h' in shortEnvelope.usage, false);
    assert.equal(resultFromAgentReply(short, model).reportedUsage?.cacheWrite1hTokens, undefined);
  } finally {
    await flue.stop();
    await registration();
  }
});

test('the interaction classifier reports one-hour cache writes, so its estimate stays partial', async (t) => {
  await withEnv({
    CHICKPEA_TENANCY: undefined,
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_BASE_URL: undefined,
  }, async () => {
    resetModelAccessForTests();
    invalidateProviderKeyCache();
    const settings = new SqliteSettingsStore(':memory:');
    const usage = new SqliteUsageStore(':memory:');
    t.after(() => {
      settings.close();
      usage.close();
      resetModelAccessForTests();
    });
    configureModelAccessResolver(createInstallationModelAccessResolver({ settings: () => settings }));
    await rotateInstallationModelCredential(
      'anthropic',
      { kind: 'save', apiKey: 'sk-ant-classifier-test' },
      { env: undefined, settings, usage },
    );
    const answer: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: JSON.stringify({ disposition: 'reply', reason: 'substantive_request' }) }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      stopReason: 'stop',
      timestamp: 1,
      usage: {
        input: 12, output: 8, cacheRead: 0, cacheWrite: 900, cacheWrite1h: 900, totalTokens: 920,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const stream = () => {
      const output = createAssistantMessageEventStream();
      queueMicrotask(() => {
        output.push({ type: 'done', reason: 'stop', message: answer });
        output.end();
      });
      return output;
    };
    registerPiProvider(createProvider({
      id: 'anthropic',
      auth: { apiKey: { name: 'test', resolve: async () => ({ auth: {} }) } },
      models: [{
        id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', api: 'anthropic-messages', provider: 'anthropic',
        baseUrl: 'https://provider.invalid', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 1_024,
      } as Model<'anthropic-messages'>],
      api: { stream, streamSimple: stream },
    }));

    const classification = await classifySlackInteraction({
      workspaceId: 'T_LONG',
      channelId: 'C_LONG',
      eventId: 'Ev_LONG',
      text: '<@UBOT> What does this result mean?',
      source: 'app_mention',
      guaranteed: true,
      profileInstructions: 'Help the team.',
      requestedModel: 'anthropic/claude-haiku-4-5',
    }, undefined, undefined, 5_000, { settings });
    assert.equal(classification.failed, false);
    assert.equal(classification.result?.reportedUsage?.cacheWrite1hTokens, 900);
    const reported = interactionReportedUsage(classification.result?.reportedUsage);
    assert.equal(reported?.cacheWrite1hTokens, 900);

    const at = Date.UTC(2026, 9, 5, 6);
    const recorder = new InteractionUsageRecorder({
      operationId: 'classification_T_LONG_C_LONG_Ev_LONG',
      executionId: 'classification_exec_Ev_LONG',
      startedAt: at,
      workspaceId: 'T_LONG',
      channelId: 'C_LONG',
      agentId: 'agent_default',
      agentLabel: 'Default',
      requestedModel: 'anthropic/claude-haiku-4-5',
      credentialRefId: null,
      credentialVersion: null,
      store: usage,
      now: () => at + 1_000,
    });
    await recorder.admit();
    await recorder.recordTerminal({
      status: 'completed',
      usage: reported,
      returnedModel: classification.result?.returnedModel ?? null,
    });
    const measurement = (await usage.getOperation('classification_T_LONG_C_LONG_Ev_LONG'))?.measurements[0];
    assert.equal(measurement?.cacheWriteTokens, 900);
    assert.equal(measurement?.estimateCompleteness, 'partial');
    assert.equal(measurement?.priceUnknownReason, 'pricing_dimension_unknown');
  });
});
