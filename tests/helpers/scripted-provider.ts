import assert from 'node:assert/strict';

import {
  createAssistantMessageEventStream,
  createProvider,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
} from '@earendil-works/pi-ai';

import { registerPiProvider } from '../../src/config/pi-provider-registry.ts';
import { ANTHROPIC_COMPAT_PROVIDER_ID } from '../../src/model-catalog/provider-alias.ts';

export const SCRIPTED_MODEL = 'claude-sonnet-5-5';

export type Reply = (model: Model<string>) => AssistantMessage;

export function scriptedMessage(model: Model<string>, content: AssistantMessage['content'], stopReason: 'stop' | 'toolUse'): AssistantMessage {
  return {
    role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, stopReason, timestamp: 1,
    usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

export const callsTools = (...names: string[]): Reply => (model) => scriptedMessage(
  model,
  names.map((name, index) => ({ type: 'toolCall', id: `call_${index}_${name}`, name, arguments: {} })),
  'toolUse',
);
export const answers: Reply = (model) => scriptedMessage(model, [{ type: 'text', text: 'done' }], 'stop');

function streamMessage(output: AssistantMessageEventStream, final: AssistantMessage): void {
  const partial: AssistantMessage = { ...final, content: [] };
  output.push({ type: 'start', partial: { ...partial } });
  final.content.forEach((block, contentIndex) => {
    partial.content = [...partial.content, block];
    if (block.type === 'text') {
      output.push({ type: 'text_start', contentIndex, partial: { ...partial } });
      output.push({ type: 'text_delta', contentIndex, delta: block.text, partial: { ...partial } });
      output.push({ type: 'text_end', contentIndex, content: block.text, partial: { ...partial } });
    } else if (block.type === 'toolCall') {
      output.push({ type: 'toolcall_start', contentIndex, partial: { ...partial } });
      output.push({ type: 'toolcall_end', contentIndex, toolCall: block, partial: { ...partial } });
    }
  });
  output.push({ type: 'done', reason: final.stopReason as 'stop' | 'toolUse', message: final });
  output.end();
}

export function scriptedProvider(replies: Reply[]) {
  const model = {
    id: SCRIPTED_MODEL, name: SCRIPTED_MODEL, api: 'anthropic-messages', provider: ANTHROPIC_COMPAT_PROVIDER_ID,
    baseUrl: 'https://provider.invalid', reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_192,
  } as Model<'anthropic-messages'>;
  const sent: number[] = [];
  const sentAt: number[] = [];
  const stream = (sentModel: Model<string>): AssistantMessageEventStream => {
    sent.push(sent.length);
    sentAt.push(performance.now());
    const output = createAssistantMessageEventStream();
    const reply = replies.shift();
    assert.ok(reply, 'a scripted reply remains for every request sent');
    queueMicrotask(() => streamMessage(output, reply(sentModel)));
    return output;
  };
  registerPiProvider(createProvider({
    id: ANTHROPIC_COMPAT_PROVIDER_ID,
    auth: { apiKey: { name: 'probe', resolve: async () => ({ auth: {} }) } },
    models: [model],
    api: { stream, streamSimple: stream },
  }));
  return { sent, sentAt, model };
}
