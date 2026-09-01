export const FAKE_PROVIDER_KEYS = {
  anthropic: 'anthropic-valid-key',
  openai: 'openai-valid-key',
  openrouter: 'openrouter-valid-key',
} as const;

interface FakeProviderCall {
  method: string;
  url: string;
  headers: Record<string, string>;
}

export class FakeProvidersBackend {
  readonly calls: FakeProviderCall[] = [];
  unreachableHosts = new Set<string>();

  private openAiModels = [
    { id: 'gpt-4.1', object: 'model', owned_by: 'openai' },
    { id: 'text-embedding-3-large', object: 'model', owned_by: 'openai' },
    { id: 'gpt-4.1-mini', object: 'model', owned_by: 'openai' },
    { id: 'whisper-1', object: 'model', owned_by: 'openai' },
  ];

  asFetch(): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (this.unreachableHosts.has(url.host)) {
        throw new TypeError(`unreachable fake host: ${url.host}`);
      }
      const headers = headersObject(request.headers);
      this.calls.push({ method: request.method, url: request.url, headers });

      if (url.pathname === '/v1/models') {
        if (url.host === 'anthropic.fake') {
          return this.anthropicModels(headers);
        }
        if (url.host === 'openai.fake') {
          return this.openAiModelsResponse(headers);
        }
      }

      if (url.pathname === '/models' || url.pathname === '/api/v1/models') {
        return json({
          data: [
            {
              id: 'anthropic/claude-sonnet-4',
              name: 'Claude Sonnet 4',
              context_length: 200000,
              pricing: { prompt: '3.00', completion: '15.00' },
            },
            {
              id: 'meta-llama/llama-3.3-70b-instruct',
              name: 'Llama 3.3 70B Instruct',
              context_length: 131000,
              pricing: { prompt: '0.13', completion: '0.40' },
            },
          ],
        });
      }

      if (url.pathname === '/auth/key' || url.pathname === '/api/v1/auth/key') {
        return bearer(headers) === FAKE_PROVIDER_KEYS.openrouter
          ? json({ data: { label: 'fake-openrouter-key', usage: 0 } })
          : json({ error: { message: 'invalid OpenRouter key' } }, 401);
      }

      if (url.pathname.endsWith('/ai/models/search')) {
        return json({
          result: [
            { id: '11111111-1111-4111-8111-111111111111', name: '@cf/moonshotai/kimi-k2.6' },
            { id: '22222222-2222-4222-8222-222222222222', name: '@cf/zai-org/glm-5.2' },
          ],
        });
      }

      return json({ error: { message: `unhandled fake provider path ${url.pathname}` } }, 404);
    }) as typeof fetch;
  }

  setOpenAiModels(models: Array<{ id: string; object?: string; owned_by?: string }>): void {
    this.openAiModels = models.map((model) => ({
      object: 'model',
      owned_by: 'openai',
      ...model,
    }));
  }

  callsFor(pathname: string): FakeProviderCall[] {
    return this.calls.filter((call) => new URL(call.url).pathname === pathname);
  }

  private anthropicModels(headers: Record<string, string>): Response {
    if (
      headers['x-api-key'] !== FAKE_PROVIDER_KEYS.anthropic ||
      headers['anthropic-version'] !== '2023-06-01'
    ) {
      return json(
        {
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid x-api-key' },
        },
        401,
      );
    }
    return json({
      data: [
        { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
        { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
      ],
    });
  }

  private openAiModelsResponse(headers: Record<string, string>): Response {
    if (bearer(headers) !== FAKE_PROVIDER_KEYS.openai) {
      return json(
        {
          error: {
            message: 'Incorrect API key provided',
            type: 'invalid_request_error',
            code: 'invalid_api_key',
          },
        },
        401,
      );
    }
    return json({ object: 'list', data: this.openAiModels });
  }
}

function headersObject(headers: Headers): Record<string, string> {
  return Object.fromEntries([...headers.entries()].map(([key, value]) => [key.toLowerCase(), value]));
}

function bearer(headers: Record<string, string>): string | undefined {
  const match = headers.authorization?.match(/^Bearer (.+)$/);
  return match?.[1];
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
