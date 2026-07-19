import { WorkerEntrypoint } from 'cloudflare:workers';

/**
 * Workerd-local stand-in for the production Workers AI binding.
 *
 * The Cloudflare smoke binds this entrypoint as `env.AI`, so the built Worker
 * still runs its production provider-registration and model-resolution path.
 * Reject any configured gateway instead of returning a successful model stream.
 */
export default class CloudflareAiBindingSmoke extends WorkerEntrypoint {
  async run(modelId, _inputs, options = {}) {
    if (modelId !== '@cf/zai-org/glm-5.2') {
      throw new Error(`unexpected Workers AI smoke model: ${modelId}`);
    }
    if (options.gateway !== undefined) {
      throw new Error(
        `Workers AI smoke received forbidden gateway options: ${JSON.stringify(options.gateway)}`,
      );
    }
    if (options.returnRawResponse !== true) {
      throw new Error('Workers AI smoke expected returnRawResponse=true');
    }

    const base = {
      id: 'chatcmpl-workers-ai-smoke',
      object: 'chat.completion.chunk',
      created: 0,
      model: modelId,
    };
    const chunks = [
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: this.env.AI_SMOKE_REPLY },
            finish_reason: null,
          },
        ],
      },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      {
        ...base,
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ];
    const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }
}
