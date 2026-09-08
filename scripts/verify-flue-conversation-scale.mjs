#!/usr/bin/env node
/**
 * Measure the Flue 2 conversation-read path at the supported 20/50-turn
 * checkpoints without a deployment or external provider traffic.
 *
 * The probe uses Flue's real Node coordinator plus the same history route the
 * Cloudflare handle uses after settlement. It records:
 *   - first read latency (settlement + reply materialization),
 *   - settled reattach read latency,
 *   - serialized history-response latency and bytes, and
 *   - provider request bytes (the model-context growth reference).
 */
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { init, useInstruction, useModel } from '@flue/runtime';
import {
  agentStreamPath,
  assembleNodeAgentRuntime,
  connectPersistenceAdapter,
  handleAgentConversationRead,
  setProvider,
} from '@flue/runtime/internal';
import { sqlite } from '@flue/runtime/node';

import { FakeSlackBackend, STUB_REPLY_MARKER } from '../tests/parity/fake-slack.ts';

const CHECKPOINTS = new Set([20, 50]);
const MODEL_ID = 'scale-probe-1';
const AGENT_ID = 'conversation-scale';
const encoder = new TextEncoder();

function ScaleProbeAgent() {
  useModel(`scale-probe/${MODEL_ID}`);
  useInstruction('Reply in one short sentence and do not use tools.');
  return 'This is a deterministic conversation-scale verification probe.';
}
ScaleProbeAgent.agentName = 'conversation-scale-probe';

function byteLength(value) {
  return encoder.encode(typeof value === 'string' ? value : JSON.stringify(value)).byteLength;
}

function elapsedMs(startedAt) {
  return Number((performance.now() - startedAt).toFixed(3));
}

function makeProvider(baseUrl) {
  return createProvider({
    id: 'scale-probe',
    name: 'Conversation scale probe',
    auth: {
      apiKey: {
        name: 'Conversation scale probe key',
        resolve: async () => ({
          auth: { apiKey: 'offline-scale-probe' },
          source: 'offline scale probe',
        }),
      },
    },
    models: [
      {
        id: MODEL_ID,
        name: MODEL_ID,
        api: 'openai-completions',
        provider: 'scale-probe',
        baseUrl: `${baseUrl}/v1`,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_768,
        maxTokens: 2_048,
      },
    ],
    api: openAICompletionsApi(),
  });
}

const backend = new FakeSlackBackend();
const fake = await backend.listen();
const adapter = sqlite(':memory:');
let runtime;

try {
  setProvider(makeProvider(fake.url));
  const stores = await connectPersistenceAdapter(adapter, 'conversation scale probe');
  runtime = await assembleNodeAgentRuntime({
    agents: [{ identity: ScaleProbeAgent.agentName, agent: ScaleProbeAgent }],
    adapter,
    stores,
    env: {},
  });

  const handle = init(ScaleProbeAgent, { id: AGENT_ID, uid: null });
  const path = agentStreamPath(ScaleProbeAgent.agentName, AGENT_ID);
  const measurements = [];

  for (let turn = 1; turn <= 50; turn += 1) {
    const receipt = await handle.dispatch({
      message: `Turn ${turn}: acknowledge checkpoint token ${turn}.`,
      idempotencyKey: `scale-turn-${turn}`,
    });

    const firstReadStartedAt = performance.now();
    const reply = await handle.read(receipt);
    const firstReadMs = elapsedMs(firstReadStartedAt);
    if (!reply.text.includes(STUB_REPLY_MARKER)) {
      throw new Error(`turn ${turn} returned an unexpected reply: ${JSON.stringify(reply.text)}`);
    }

    if (!CHECKPOINTS.has(turn)) continue;

    const reattachStartedAt = performance.now();
    const reattached = await handle.read(receipt);
    const reattachReadMs = elapsedMs(reattachStartedAt);
    if (reattached.submissionId !== reply.submissionId || reattached.text !== reply.text) {
      throw new Error(`turn ${turn} did not return the same reply when read was reattached`);
    }

    const historyStartedAt = performance.now();
    const historyResponse = await handleAgentConversationRead({
      store: runtime.conversationStreamStore,
      path,
      request: new Request('https://flue.invalid/conversation?view=history'),
    });
    const historyBody = await historyResponse.text();
    const historyReadMs = elapsedMs(historyStartedAt);
    if (!historyResponse.ok) {
      throw new Error(`turn ${turn} history read failed with ${historyResponse.status}: ${historyBody}`);
    }

    const providerCall = backend.providerCalls().at(-1);
    if (!providerCall) throw new Error(`turn ${turn} did not reach the fake provider`);

    measurements.push({
      turn,
      firstReadMs,
      reattachReadMs,
      replyBytes: byteLength(reply),
      historyReadMs,
      historyBytes: byteLength(historyBody),
      providerRequestBytes: byteLength(providerCall.body),
    });
  }

  const [at20, at50] = measurements;
  if (!at20 || !at50) throw new Error('missing the 20-turn or 50-turn measurement');

  const growth = {
    historyBytes: Number((at50.historyBytes / at20.historyBytes).toFixed(3)),
    providerRequestBytes: Number(
      (at50.providerRequestBytes / at20.providerRequestBytes).toFixed(3),
    ),
    reattachReadMs: Number((at50.reattachReadMs / Math.max(at20.reattachReadMs, 0.001)).toFixed(3)),
  };

  console.log('Flue 2 conversation scale measurements:');
  console.log(JSON.stringify({ checkpoints: measurements, growth }, null, 2));
} finally {
  if (runtime) await runtime.close();
  else await adapter.close?.();
  await backend.close();
}
