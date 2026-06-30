import type { ProviderId } from '../config/types.ts';
import {
  formatSlackContextRows,
  slackContextWindowLabel,
} from '../slack/context-format.ts';
import type { ModelProvider, ProviderRequest, ProviderResponse } from './types.ts';
import { WorkersAiRestProvider, type WorkersAiRestProviderOptions } from './workers-ai-rest.ts';

export class DeterministicProvider implements ModelProvider {
  readonly providerId: ProviderId;
  readonly model: string;
  callCount = 0;

  constructor(providerId: ProviderId, model: string) {
    this.providerId = providerId;
    this.model = model;
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.callCount += 1;
    const context = request.toolResults.map((result) => result.content).join(' ');
    const slackContext = formatSlackContext(request);
    const lane =
      this.providerId === 'claude'
        ? 'Claude lane'
        : 'non-Claude Cloudflare Workers AI lane';
    const contextText = [context, slackContext].filter(Boolean).join(' ');

    return {
      providerId: this.providerId,
      model: this.model,
      text: `**${request.agent.name}** handled turn ${request.session.turnCount + 1} on the ${lane}. ${contextText}`.trim(),
      usage: {
        inputTokens: Math.ceil(`${request.message} ${slackContext}`.length / 4),
        outputTokens: this.providerId === 'claude' ? 42 : 37,
      },
      latencyMs: this.providerId === 'claude' ? 80 : 55,
    };
  }
}

function formatSlackContext(request: ProviderRequest): string {
  const messages = request.slackContext?.messages ?? [];
  if (messages.length === 0) {
    return '';
  }

  const transcript = formatSlackContextRows(messages, { separator: ' | ' });
  return `Slack context (${slackContextWindowLabel(request.slackContext, 'bounded')}): ${transcript}`;
}

export class ProviderRegistry {
  private readonly providers: Map<ProviderId, ModelProvider>;

  constructor(
    models: Record<ProviderId, string>,
    options: { workersAi?: WorkersAiRestProviderOptions } = {},
  ) {
    this.providers = new Map<ProviderId, ModelProvider>([
      ['claude', new DeterministicProvider('claude', models.claude)],
      [
        'workers-ai',
        options.workersAi
          ? new WorkersAiRestProvider({
              ...options.workersAi,
              model: options.workersAi.model || models['workers-ai'],
            })
          : new DeterministicProvider('workers-ai', models['workers-ai']),
      ],
    ]);
  }

  get(providerId: ProviderId): ModelProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Unknown provider ${providerId}`);
    }
    return provider;
  }
}
