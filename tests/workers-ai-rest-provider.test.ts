import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WorkersAiRestProvider } from '../src/providers/workers-ai-rest.ts';

test('Workers AI REST provider calls Cloudflare with bearer auth and parses response text', async () => {
  const requests: Array<{ url: string; body: unknown; authorization: string | null }> = [];
  const provider = new WorkersAiRestProvider({
    accountId: 'account_123',
    apiToken: 'secret-token',
    model: '@cf/zai-org/glm-5.2',
    endpoint: 'https://api.cloudflare.test/client/v4',
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return Response.json({
        success: true,
        result: {
          response: 'Live Workers AI reply',
          usage: {
            input_tokens: 12,
            output_tokens: 5,
          },
        },
      });
    },
  });

  const response = await provider.generate({
    agent: {
      id: 'agent_exec_research',
      name: 'Exec Research',
      description: 'Test agent',
      instructions: 'Use approved context only.',
      enabled: true,
      defaultModels: {
        claude: 'anthropic/claude-sonnet-4-6',
        'workers-ai': '@cf/zai-org/glm-5.2',
      },
      allowedTools: ['lookup_channel_brief'],
    },
    message: '<@U_BOT> channel context please',
    session: {
      id: 'session_1',
      threadKey: 'T:C:1',
      snapshot: {
        agent: {
          id: 'agent_exec_research',
          name: 'Exec Research',
          description: 'Test agent',
          instructions: 'Use approved context only.',
          enabled: true,
          defaultModels: {
            claude: 'anthropic/claude-sonnet-4-6',
            'workers-ai': '@cf/zai-org/glm-5.2',
          },
          allowedTools: ['lookup_channel_brief'],
        },
        model: '@cf/zai-org/glm-5.2',
        providerId: 'workers-ai',
        allowedTools: ['lookup_channel_brief'],
        snapshotHash: 'snapshot_hash',
        createdAt: 1,
      },
      turnCount: 0,
    },
    toolResults: [
      {
        toolName: 'lookup_channel_brief',
        content: 'Paperplane Labs test context',
      },
    ],
  });

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]?.url,
    'https://api.cloudflare.test/client/v4/accounts/account_123/ai/run/@cf/zai-org/glm-5.2',
  );
  assert.equal(requests[0]?.authorization, 'Bearer secret-token');
  assert.deepEqual(response.usage, { inputTokens: 12, outputTokens: 5 });
  assert.equal(response.model, '@cf/zai-org/glm-5.2');
  assert.equal(response.text, 'Live Workers AI reply');
  assert.match(JSON.stringify(requests[0]?.body), /Paperplane Labs test context/);
});
