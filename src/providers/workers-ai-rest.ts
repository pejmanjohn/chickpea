import type { ProviderId } from '../config/types.ts';
import {
  formatSlackContextRows,
  slackContextWindowLabel,
} from '../slack/context-format.ts';
import type { ModelProvider, ProviderRequest, ProviderResponse } from './types.ts';

export interface WorkersAiRestProviderOptions {
  accountId: string;
  apiToken: string;
  model: string;
  endpoint?: string;
  fetch?: typeof fetch;
  maxTokens?: number;
}

interface WorkersAiEnvelope {
  success?: boolean;
  errors?: Array<{ message?: string; code?: number }>;
  result?: unknown;
  [key: string]: unknown;
}

export class WorkersAiRestProvider implements ModelProvider {
  readonly providerId: ProviderId = 'workers-ai';
  readonly model: string;

  private readonly accountId: string;
  private readonly apiToken: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxTokens: number;

  constructor(options: WorkersAiRestProviderOptions) {
    this.accountId = requireNonEmpty(options.accountId, 'CLOUDFLARE_ACCOUNT_ID');
    this.apiToken = requireNonEmpty(options.apiToken, 'CLOUDFLARE_API_TOKEN');
    this.model = requireNonEmpty(options.model, 'CLOUDFLARE_WORKERS_AI_MODEL');
    this.endpoint = (options.endpoint ?? 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.maxTokens = options.maxTokens ?? 512;
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const startedAt = Date.now();
    const system = buildSystemPrompt(request);
    const user = buildUserPrompt(request);
    const messagesBody = {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: this.maxTokens,
    };

    let envelope = await this.runModel(messagesBody);
    if (!envelope.ok && envelope.status === 400) {
      envelope = await this.runModel({
        prompt: `${system}\n\nUser Slack message:\n${user}`,
        max_tokens: this.maxTokens,
      });
    }

    if (!envelope.ok) {
      throw new Error(sanitizeWorkersAiError(envelope.status, envelope.body));
    }

    const text = extractText(envelope.body);
    const usage = extractUsage(envelope.body, `${system}\n\n${user}`, text);

    return {
      providerId: this.providerId,
      model: this.model,
      text,
      usage,
      latencyMs: Date.now() - startedAt,
    };
  }

  private async runModel(body: unknown): Promise<{ ok: boolean; status: number; body: unknown }> {
    const response = await this.fetchImpl(`${this.endpoint}/accounts/${this.accountId}/ai/run/${this.model}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = {};
    }

    const envelope = parsed as WorkersAiEnvelope;
    return {
      ok: response.ok && envelope.success !== false,
      status: response.status,
      body: parsed,
    };
  }
}

function buildSystemPrompt(request: ProviderRequest): string {
  const toolContext =
    request.toolResults.length > 0
      ? request.toolResults.map((result) => `- ${result.toolName}: ${result.content}`).join('\n')
      : '- No approved tool context was requested or available.';

  return [
    `You are ${request.agent.name}, a Slack channel agent.`,
    request.agent.instructions,
    'Use only the Slack message, bounded Slack context, and approved tool context below.',
    'Reply in concise standard Markdown suitable for Slack markdown blocks. Use Markdown sparingly for headings, bullets, links, and code. Do not use Slack-specific mrkdwn unless preserving Slack IDs already present in the user message.',
    'Do not mention hidden implementation details or credentials.',
    `Approved tool context:\n${toolContext}`,
  ].join('\n\n');
}

function buildUserPrompt(request: ProviderRequest): string {
  const message = request.message.replace(/<@[A-Z0-9]+>/g, '').trim() || request.message;
  const slackContext =
    request.slackContext && request.slackContext.messages.length > 0
      ? formatSlackContextRows(request.slackContext.messages, { prefix: '- ', separator: '\n' })
      : '- No bounded Slack context was available.';

  return [
    `Triggering Slack message:\n${message}`,
    `Bounded Slack context (${slackContextWindowLabel(request.slackContext, 'none')}):\n${slackContext}`,
  ].join('\n\n');
}

function extractText(body: unknown): string {
  const candidates = [
    readPath(body, ['result', 'response']),
    readPath(body, ['result', 'text']),
    readPath(body, ['result', 'output_text']),
    readPath(body, ['result', 'content']),
    readPath(body, ['result', 'choices', 0, 'message', 'content']),
    readPath(body, ['choices', 0, 'message', 'content']),
    readPath(body, ['response']),
    readPath(body, ['text']),
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  const result = readPath(body, ['result']);
  if (typeof result === 'string' && result.trim()) {
    return result.trim();
  }

  throw new Error('Workers AI response did not include text output');
}

function extractUsage(
  body: unknown,
  input: string,
  output: string,
): { inputTokens: number; outputTokens: number } {
  const usage = readPath(body, ['result', 'usage']) ?? readPath(body, ['usage']);
  const inputTokens =
    readNumberPath(usage, ['input_tokens']) ??
    readNumberPath(usage, ['prompt_tokens']) ??
    Math.ceil(input.length / 4);
  const outputTokens =
    readNumberPath(usage, ['output_tokens']) ??
    readNumberPath(usage, ['completion_tokens']) ??
    Math.ceil(output.length / 4);

  return { inputTokens, outputTokens };
}

function sanitizeWorkersAiError(status: number, body: unknown): string {
  const errors = readPath(body, ['errors']);
  if (Array.isArray(errors)) {
    const message = errors
      .map((error) =>
        error && typeof error === 'object' && 'message' in error
          ? String(error.message).slice(0, 200)
          : null,
      )
      .filter(Boolean)
      .join('; ');
    if (message) {
      return `Workers AI request failed (${status}): ${message}`;
    }
  }
  return `Workers AI request failed (${status})`;
}

function readPath(value: unknown, path: Array<string | number>): unknown {
  let current = value;
  for (const part of path) {
    if (typeof part === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[part];
      continue;
    }
    if (!current || typeof current !== 'object' || !(part in current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function readNumberPath(value: unknown, path: string[]): number | undefined {
  const result = readPath(value, path);
  return typeof result === 'number' && Number.isFinite(result) ? result : undefined;
}

function requireNonEmpty(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${name} is required for live Workers AI`);
  }
  return trimmed;
}
