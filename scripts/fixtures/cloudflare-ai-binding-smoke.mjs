import { WorkerEntrypoint } from 'cloudflare:workers';

/**
 * Workerd-local stand-in for the production Workers AI binding.
 *
 * The Cloudflare smoke binds this entrypoint as `env.AI`, so the built Worker
 * still runs its production provider-registration and model-resolution path.
 * Reject any configured gateway instead of returning a successful model stream.
 */
export default class CloudflareAiBindingSmoke extends WorkerEntrypoint {
  async run(modelId, inputs, options = {}) {
    if (options.gateway !== undefined) {
      throw new Error(
        `Workers AI smoke received forbidden gateway options: ${JSON.stringify(options.gateway)}`,
      );
    }
    if (modelId === '@cf/cloudflare/clef') return this.clef(inputs);
    if (modelId !== '@cf/zai-org/glm-4.7-flash') {
      throw new Error(`unexpected Workers AI smoke model: ${modelId}`);
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

  /**
   * With `AI_SMOKE_CLEF_URL` set (the perf harness), the fake backend owns the
   * answer and its delay and logs the call. Without it, an uncertain answer
   * sends every turn down today's path, so the smoke keeps covering the
   * fallback.
   */
  async clef(inputs) {
    const url = this.env.AI_SMOKE_CLEF_URL;
    if (!url) return UNCERTAIN_CLEF_ANSWER;
    const response = await fetch(`${url}/ai/run/clef`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(inputs),
    });
    if (!response.ok) throw new Error(`Clef relay failed: HTTP ${response.status}`);
    return await response.json();
  }
}

/** The `uncertain` profile of tests/helpers/fake-clef.ts, in Clef's wire shape. */
const UNCERTAIN_CLEF_ANSWER = {
  answers: {
    disposition: {
      type: 'choice',
      choice: 'reply',
      probabilities: { reply: 0.45, work: 0.2, react_only: 0.3, ignore: 0.05 },
      confidence: 0.2,
    },
    memory: { type: 'noul', noul: 0.02 },
  },
  usage: { input_tokens: 878 },
};
