import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';

import { normalizeContext, type Context, type SimpleStreamOptions } from '@earendil-works/pi-ai';

import {
  configureModelAccessResolver,
  configureModelRequestRecorder,
  resetModelAccessForTests,
  withModelAccess,
  type ModelAccessGrant,
} from '../src/config/model-access.ts';
import { registerBuiltinPiProvider } from '../src/config/pi-provider.ts';
import { registeredPiProvider } from '../src/config/pi-provider-registry.ts';

type Provider = 'anthropic' | 'openai';

const CONTEXT: Context = {
  systemPrompt: 'Synthetic system prompt.',
  messages: [{ role: 'user', content: 'Look up record 1.', timestamp: 1 }],
  tools: [{
    name: 'lookup',
    description: 'Look up one synthetic record.',
    parameters: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
  }],
};

function sse(event: Record<string, unknown>): string {
  return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
}

const ANSWERS: Readonly<Record<Provider, string>> = {
  anthropic: [
    sse({
      type: 'message_start',
      message: { id: 'msg_compat', type: 'message', role: 'assistant', model: 'm', content: [], usage: { input_tokens: 4, output_tokens: 1 } },
    }),
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } }),
    sse({ type: 'content_block_stop', index: 0 }),
    sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }),
    sse({ type: 'message_stop' }),
  ].join(''),
  openai: readFileSync(new URL('./fixtures/usage/provider-modes/openai-gpt-5.6-luna-default.sse', import.meta.url), 'utf8'),
};

interface Sent {
  readonly betas: readonly string[];
  readonly body: Record<string, any>;
}

/** One customer-funded step through Chickpea's provider proxy, with the HTTP request as pi-ai sent it. */
async function sendStep(
  t: TestContext,
  provider: Provider,
  modelId: string,
  options: Pick<SimpleStreamOptions, 'reasoning' | 'sessionId'>,
): Promise<Sent> {
  resetModelAccessForTests();
  t.after(resetModelAccessForTests);
  registerBuiltinPiProvider(provider);
  configureModelAccessResolver({ resolve: async () => ({ apiKey: 'sk-pi-request-compat-test' }) });
  configureModelRequestRecorder(async () => undefined);
  const registered = registeredPiProvider(provider);
  const model = registered?.getModels().find((candidate) => candidate.id === modelId);
  assert.ok(registered && model, `${provider} lists ${modelId}`);
  let sent: Sent | undefined;
  const network: typeof fetch = async (_input, init) => {
    const beta = new Headers(init?.headers).get('anthropic-beta');
    sent = { betas: beta ? beta.split(',').map((name) => name.trim()) : [], body: JSON.parse(String(init?.body)) };
    return new Response(ANSWERS[provider], { headers: { 'content-type': 'text/event-stream' } });
  };
  const grant: ModelAccessGrant = {
    installationId: 'inst_pi_compat', providerId: provider, runId: 'run_pi_compat', fundingSource: 'customer',
    credentialRefId: `cred_${provider}`, credentialVersion: 1,
  };
  await withModelAccess(grant, {}, 'reply', () =>
    registered.streamSimple(model, normalizeContext(CONTEXT), { fetch: network, maxRetries: 0, ...options }).result());
  assert.ok(sent, `pi-ai sent the ${provider} request`);
  return sent;
}

// Defect caught: Pi's message threads left on, so a step with a session id,
// which Flue sets on every step, opens a server-side thread, and the next
// step sends only its new messages.
test('an Anthropic step with a session id opens no message thread', async (t) => {
  const sent = await sendStep(t, 'anthropic', 'claude-opus-5-5', { sessionId: 'agent_thread' });
  assert.equal('thread' in sent.body, false);
  assert.equal(sent.betas.some((beta) => beta.startsWith('message-threads-')), false);
});

// Defect caught: Pi's mid-conversation effort left on, so a GPT-6 step keeps
// `reasoning.effort` at medium and sends its level in a `configuration_update`
// item, which OpenAI applied only in part when measured.
test('a GPT-6 step sends its effort as reasoning.effort, with no configuration_update item', async (t) => {
  for (const reasoning of ['low', 'high'] as const) {
    const { body } = await sendStep(t, 'openai', 'gpt-6.1-sol', { reasoning, sessionId: 'agent_thread' });
    assert.equal(body.reasoning?.effort, reasoning);
    assert.equal((body.input as Array<{ type?: string }>).some((item) => item.type === 'configuration_update'), false);
  }
});
