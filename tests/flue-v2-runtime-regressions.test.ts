import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createCloudflareAgentRuntime,
  createFlueContext,
  InMemoryAttachmentStore,
  InMemoryConversationStreamStore,
} from '@flue/runtime/internal';

import { ChickpeaSlack } from '../src/agents/slack-thread.ts';
import { compileRuntimePlanV2, type RuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import { activityStatusForObservation } from '../src/activity/status.ts';
import type { CustomAgentConfig, ResolvedAssignment } from '../src/config/types.ts';
import type { EffectiveConnectionAccount } from '../src/connections/types.ts';
import { serializeCurrentRequestEnvelope } from '../src/memory/tool-policy.ts';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOOK_MODEL = 'openai/gpt-5.4-mini';

const HOOK_AGENT: CustomAgentConfig = {
  id: 'agent_hook_activity',
  kind: 'user',
  revision: 1,
  name: 'Hook Activity',
  instructions: 'Use only the mounted capabilities.',
  enabled: true,
  model: HOOK_MODEL,
  skills: [],
  mcpServers: [],
  apiConnections: [],
  repositories: [],
};

function hookRuntimePlan(
  capability = 'gmail.messages.search',
): RuntimePlanV2 {
  const policy = {
    kind: 'managed' as const,
    adapterId: 'composio',
    toolkit: 'gmail',
    principalRef: 'principal_private',
    accountRef: 'account_private',
    allowedCapabilities: [capability],
  };
  const managed: EffectiveConnectionAccount = {
    account: {
      id: 'gmail-account',
      workspaceId: 'T_HOOK',
      revision: 1,
      ownerKind: 'team',
      createdByMembershipId: 'membership_owner',
      providerId: 'google',
      label: 'Private mailbox label',
      policy,
      secretRefId: 'secret_private',
      lifecycle: 'ready',
      createdAt: 1,
      updatedAt: 1,
    },
    binding: {
      agentId: HOOK_AGENT.id,
      connectionAccountId: 'gmail-account',
      providerId: 'google',
      allowedCapabilities: [capability],
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
    policy,
    scope: 'team',
  };
  const assignment: ResolvedAssignment = {
    workspaceId: 'T_HOOK',
    channelId: 'C_HOOK',
    agentId: HOOK_AGENT.id,
    agent: structuredClone(HOOK_AGENT),
    model: HOOK_MODEL,
    modelAttribution: {
      source: 'workspace_default',
      providerId: 'openai',
      workspaceDefaultRevision: 1,
    },
  };
  return compileRuntimePlanV2({
    turn: {
      workspaceId: 'T_HOOK',
      channelId: 'C_HOOK',
      eventId: 'E_HOOK',
      text: 'Check my inbox.',
      userId: 'U_HOOK',
      actorMembershipId: 'membership_hook',
      messageTs: '1787000000.000200',
      threadTs: '1787000000.000100',
      source: 'app_mention',
      contextMode: 'thread',
    },
    assignment,
    instructions: HOOK_AGENT.instructions,
    memoryEpoch: 1,
    sandboxMode: 'bash',
    effectiveConnections: [managed],
  });
}

function slackDelivery(plan: RuntimePlanV2, attachments = false) {
  return {
    kind: 'signal' as const,
    type: 'slack.message',
    tagName: 'slack_message',
    body: serializeCurrentRequestEnvelope(
      'Check my inbox.',
      false,
      'U_HOOK',
      '1787000000.000200',
      { schemaVersion: 2, progressiveStreamingOffered: true },
    ),
    attributes: {
      workspaceId: plan.conversation.workspaceId,
      channelId: plan.conversation.channelId,
      threadTs: plan.conversation.threadTs,
      slackUserId: 'U_HOOK',
      eventId: 'E_HOOK',
      messageTs: '1787000000.000200',
      turnJobId: 'turn_hook',
      ...(attachments
        ? {
            attachmentFileIds: 'F_HOOK',
            attachmentIntakeStatus: 'ok',
            attachmentCount: '1',
          }
        : {}),
    },
  };
}

async function renderChickpeaHook(plan: RuntimePlanV2, id: string, attachments = false) {
  const context = createFlueContext({
    id,
    agentName: 'chickpea-slack-v2',
    env: {},
    agentConfig: {
      resolveModel() {
        return undefined;
      },
    } as never,
  });
  await assert.rejects(
    context.initializeRootHarness(ChickpeaSlack, slackDelivery(plan, attachments), plan),
    /could not be resolved/,
  );
}

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

test('the ChickpeaSlack hook registers exact activity before model work can begin', async () => {
  const plan = hookRuntimePlan();
  const id = 'hook-activity-normal';

  await renderChickpeaHook(plan, id);

  assert.deepEqual(
    activityStatusForObservation({
      type: 'tool_start',
      instanceId: id,
      toolName: 'gmail_search_messages',
      toolCallId: 'call_gmail',
      args: { query: 'subject:private user text must not matter' },
    }),
    {
      kind: 'checking',
      action: 'Checking',
      object: 'Gmail',
      family: 'managed_connector',
      phase: 'working',
      text: 'Checking Gmail…',
    },
  );
  assert.equal(
    activityStatusForObservation({
      type: 'tool_start',
      instanceId: id,
      toolName: 'stream_answer',
      toolCallId: 'call_answer',
    })?.text,
    'Drafting the response…',
  );
  assert.deepEqual(
    activityStatusForObservation({
      type: 'tool_start',
      instanceId: id,
      toolName: 'gmail_get_profile',
      toolCallId: 'call_unmounted_gmail',
    }),
    {
      kind: 'running',
      action: 'Working on',
      object: 'the request',
      family: 'unknown',
      phase: 'working',
      text: 'Working on the request…',
    },
  );
  assert.deepEqual(
    activityStatusForObservation({
      type: 'tool_start',
      instanceId: id,
      toolName: 'inspect_workspace',
      toolCallId: 'call_management',
    }),
    {
      kind: 'checking',
      action: 'Inspecting',
      object: 'workspace settings',
      family: 'workspace',
      phase: 'working',
      text: 'Inspecting workspace settings…',
    },
  );
});

test('the hook refresh replaces stale managed descriptors for the same instance', async () => {
  const id = 'hook-activity-refreshed';
  await renderChickpeaHook(hookRuntimePlan(), id);
  assert.equal(
    activityStatusForObservation({
      type: 'tool_start', instanceId: id, toolName: 'gmail_search_messages',
    })?.text,
    'Checking Gmail…',
  );

  await renderChickpeaHook(hookRuntimePlan('gmail.profile.read'), id);
  assert.equal(
    activityStatusForObservation({
      type: 'tool_start', instanceId: id, toolName: 'gmail_search_messages',
    })?.text,
    'Working on the request…',
  );
  assert.equal(
    activityStatusForObservation({
      type: 'tool_start', instanceId: id, toolName: 'gmail_get_profile',
    })?.text,
    'Checking Gmail…',
  );
});

test('the ChickpeaSlack attachment hook registers no connector or management descriptors', async () => {
  const plan = hookRuntimePlan();
  const id = 'hook-activity-attachment';

  await renderChickpeaHook(plan, id, true);

  for (const toolName of ['gmail_search_messages', 'inspect_workspace', 'stream_answer']) {
    assert.deepEqual(
      activityStatusForObservation({
        type: 'tool_start',
        instanceId: id,
        toolName,
        toolCallId: `call_${toolName}`,
      }),
      {
        kind: 'running',
        action: 'Working on',
        object: 'the request',
        family: 'unknown',
        phase: 'working',
        text: 'Working on the request…',
      },
      toolName,
    );
  }
});

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
