import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createCloudflareAgentRuntime,
  InMemoryAttachmentStore,
  InMemoryConversationStreamStore,
} from '@flue/runtime/internal';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

const MCP_PROBE = String.raw`
import assert from 'node:assert/strict';
import { createMcpConnection } from '@flue/runtime';

const requests = [];
const mockFetch = async (_url, init = {}) => {
  if (init.method === 'GET') return new Response(null, { status: 405 });
  const message = JSON.parse(String(init.body));
  requests.push(message.method);
  if (message.method === 'initialize') {
    return Response.json({
      jsonrpc: '2.0', id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-mcp', version: '1.0.0' },
      },
    });
  }
  if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
  if (message.method === 'tools/list') {
    return Response.json({
      jsonrpc: '2.0', id: message.id,
      result: { tools: [{
        name: 'structured-result',
        description: 'Returns structured data.',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: {
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
        },
      }] },
    });
  }
  if (message.method === 'tools/call') {
    const valid = message.params.arguments.valid !== false;
    return Response.json({
      jsonrpc: '2.0', id: message.id,
      result: {
        content: [{ type: 'text', text: valid ? 'valid result' : 'invalid result' }],
        structuredContent: { answer: valid ? 'yes' : 42 },
      },
    });
  }
  throw new Error('Unexpected MCP request: ' + message.method);
};

const connection = await createMcpConnection({
  name: 'worker-safe',
  url: 'https://mcp.example.com/mcp',
  fetch: mockFetch,
  timeoutMs: 1_000,
});
assert.equal(connection.tools.length, 1);
assert.equal(connection.tools[0].name, 'mcp__worker-safe__structured-result');
const adapterSymbol = Object.getOwnPropertySymbols(connection.tools[0]).find(
  symbol => symbol.description === 'flue.preparedToolAdapter',
);
assert.ok(adapterSymbol);
const adapter = connection.tools[0][adapterSymbol];
assert.match(await adapter.execute({ valid: true }), /"answer": "yes"/);
await assert.rejects(() => adapter.execute({ valid: false }), /structured content/i);
await connection.close();
`;

test('Flue 2 MCP validation works under restricted string-code generation', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--conditions=workerd',
      '--disallow-code-generation-from-strings',
      '--input-type=module',
      '--eval',
      MCP_PROBE,
    ],
    { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 10_000 },
  );
  assert.equal(
    result.status,
    0,
    [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n'),
  );
});

test('Flue 2 restores instance context before recovering unready submissions', async () => {
  const instanceContext = new AsyncLocalStorage<boolean>();
  let ready = false;
  const input = {
    kind: 'direct' as const,
    submissionId: 'sub-1',
    agent: 'slack-thread',
    id: 'instance-1',
    message: { kind: 'user' as const, body: 'x' },
    acceptedAt: new Date().toISOString(),
  };
  const submission = {
    sequence: 1,
    submissionId: input.submissionId,
    sessionKey: 'session-1',
    kind: 'direct' as const,
    input,
    status: 'queued' as const,
    acceptedAt: Date.now(),
    canonicalReadyAt: null,
    attemptCount: 0,
    maxAttempts: 3,
    timeoutAt: Date.now() + 60_000,
    leaseExpiresAt: 0,
  };
  const submissions = {
    async getSubmission() { return null; },
    async hasUnsettledSubmissions() { return !ready; },
    async listUnreadySubmissions() { return ready ? [] : [submission]; },
    async markSubmissionCanonicalReady() { ready = true; return submission; },
    async listPendingSubmissionSettlements() { return []; },
    async listRunningSubmissions() { return []; },
    async listRunnableSubmissions() { return []; },
  };
  const conversationStreamStore = new InMemoryConversationStreamStore();
  const runtime = createCloudflareAgentRuntime({
    agents: [{ name: 'slack-thread', agent: {} as never }],
    createContext() {
      return {
        setConversationWriter() {},
        setAttachmentStore() {},
        setSubmissionId() {},
        async initializeRootHarness() {
          assert.equal(instanceContext.getStore(), true);
          return { async session() { return { conversationId: 'conversation-1' }; } };
        },
      } as never;
    },
    runWithInstanceContext(_instance, _agentName, callback) {
      return instanceContext.run(true, callback);
    },
  });
  const instance = {
    name: 'instance-1',
    ctx: { id: { toString: () => 'do-1' } },
    async schedule() {},
  };
  runtime.attach(instance as never, {
    agentName: 'slack-thread',
    submissionStore: submissions,
    conversationStreamStore,
    attachmentStore: new InMemoryAttachmentStore(),
  } as never);

  await runtime.drainSubmissions(instance as never);
  assert.equal(ready, true);
});
