import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createCloudflareAgentRuntime } from '@flue/runtime/internal';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

const PROBE = String.raw`
import { connectMcpServer } from '@flue/runtime';

const requests = [];
const mockFetch = async (_url, init = {}) => {
  if (init.method === 'GET') {
    return new Response(null, { status: 405 });
  }

  const message = JSON.parse(String(init.body));
  requests.push(message.method);

  if (message.method === 'initialize') {
    return Response.json({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-mcp', version: '1.0.0' },
      },
    });
  }

  if (message.method === 'notifications/initialized') {
    return new Response(null, { status: 202 });
  }

  if (message.method === 'tools/list') {
    return Response.json({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          {
            name: 'structured-result',
            description: 'Returns a structured result.',
            inputSchema: { type: 'object', properties: {} },
            outputSchema: {
              type: 'object',
              properties: { answer: { type: 'string' } },
              required: ['answer'],
            },
          },
        ],
      },
    });
  }

  if (message.method === 'tools/call') {
    const valid = message.params.arguments.valid !== false;
    return Response.json({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [{ type: 'text', text: valid ? 'valid result' : 'invalid result' }],
        structuredContent: { answer: valid ? 'yes' : 42 },
      },
    });
  }

  throw new Error('Unexpected MCP request: ' + message.method);
};

const connection = await connectMcpServer('worker-safe', {
  url: 'https://mcp.example.com/mcp',
  fetch: mockFetch,
  timeoutMs: 1_000,
});

assert.deepEqual(requests, ['initialize', 'notifications/initialized', 'tools/list']);
assert.equal(connection.tools.length, 1);
assert.equal(connection.tools[0].name, 'mcp__worker-safe__structured-result');

const adapterSymbol = Object.getOwnPropertySymbols(connection.tools[0]).find(
  symbol => symbol.description === 'flue.preparedToolAdapter',
);
assert.ok(adapterSymbol, 'Flue MCP tool adapter was not registered');
const adapter = connection.tools[0][adapterSymbol];
const validResult = await adapter.execute({ valid: true });
assert.match(validResult, /"answer": "yes"/);
await assert.rejects(
  () => adapter.execute({ valid: false }),
  /structured content does not match the tool's output schema/i,
);
assert.deepEqual(requests, [
  'initialize',
  'notifications/initialized',
  'tools/list',
  'tools/call',
  'tools/call',
]);
await connection.close();
`;

test('patched Flue MCP discovery validates output schemas without string code generation', () => {
  const result = spawnSync(
    process.execPath,
    ['--disallow-code-generation-from-strings', '--input-type=module', '--eval', PROBE],
    {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 10_000,
    },
  );

  assert.equal(
    result.status,
    0,
    ['restricted MCP probe failed', result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n'),
  );
});

test('patched Flue recovery restores instance context before materializing an unready submission', async () => {
  const instanceContext = new AsyncLocalStorage<boolean>();
  let ready = false;
  const input = {
    kind: 'direct' as const,
    submissionId: 'sub-1',
    agent: 'slack-thread',
    id: 'instance-1',
    payload: { prompt: 'x' },
    acceptedAt: new Date().toISOString(),
  };
  const submission = { submissionId: input.submissionId, sessionKey: 'session-1', input };
  const submissions = {
    async hasUnsettledSubmissions() {
      return !ready;
    },
    async listUnreadySubmissions() {
      return ready ? [] : [submission];
    },
    async markSubmissionCanonicalReady() {
      ready = true;
      return true;
    },
    async listPendingSubmissionSettlements() {
      return [];
    },
    async listAttemptMarkers() {
      return [];
    },
    async listRunningSubmissions() {
      return [];
    },
    async listRunnableSubmissions() {
      return [];
    },
  };
  const conversationStreamStore = {
    async createStream() {},
    async acquireProducer() {
      return { nextProducerSequence: 0, offset: 0 };
    },
  };
  const runtime = createCloudflareAgentRuntime({
    agents: [{ name: 'slack-thread', definition: {} as never }],
    createContext() {
      return {
        setConversationWriter() {},
        setAttachmentStore() {},
        setSubmissionId() {},
        async initializeRootHarness() {
          assert.equal(
            instanceContext.getStore(),
            true,
            'materialization must run in instance context',
          );
          return {
            async session() {
              return { conversationId: 'conversation-1' };
            },
          };
        },
      } as never;
    },
    runWithInstanceContext(_instance: unknown, _agentName: string, callback: () => unknown) {
      return instanceContext.run(true, callback);
    },
  } as never);
  const instance = {
    name: 'instance-1',
    ctx: { id: { toString: () => 'do-1' } },
    async schedule() {},
  };
  runtime.attach(instance as never, {
    agentName: 'slack-thread',
    executionStore: { submissions },
    conversationStreamStore,
  } as never);

  const originalError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args) => errors.push(args);
  try {
    await runtime.wakeSubmissions(instance as never);
  } finally {
    console.error = originalError;
  }

  assert.equal(ready, true);
  assert.deepEqual(errors, []);
});
