import {
  createAssistantMessageEventStream,
  isContextOverflow,
  type Api,
  type Model,
  type ProviderStreams,
  type AssistantMessageEventStream,
} from '@earendil-works/pi-ai';

/** Keep a silent provider overflow out of the successful canonical transcript. */
export function withWorkersAiOverflowPolicy(streams: ProviderStreams): ProviderStreams {
  return {
    stream: (model, context, options) => normalize(streams.stream(model, context, options), model),
    streamSimple: (model, context, options) => normalize(streams.streamSimple(model, context, options), model),
  };
}

function normalize(source: AssistantMessageEventStream, model: Model<Api>): AssistantMessageEventStream {
  const target = createAssistantMessageEventStream();
  void (async () => {
    try {
      for await (const event of source) {
        if (event.type === 'done' && isContextOverflow(event.message, model.contextWindow)) {
          // Pi recognizes these successful-but-overflowing responses too, but
          // Flue 2.0 keeps their assistant tail when rebuilding after compaction.
          // Mark the unusable completion as an error before persistence, so its
          // normal error projection resumes from the preceding user/tool result.
          const error = { ...event.message, stopReason: 'error' as const,
            errorMessage: 'Workers AI input exceeds the context window.' };
          target.push({ type: 'error', reason: 'error', error });
          target.end(error);
          return;
        }
        target.push(event);
      }
      target.end(await source.result());
    } catch (error) {
      const failed = { role: 'assistant' as const, content: [], api: model.api,
        provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'error' as const,
        errorMessage: error instanceof Error ? error.message : 'Workers AI stream failed.',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      target.push({ type: 'error', reason: 'error', error: failed });
      target.end(failed);
    }
  })();
  return target;
}
