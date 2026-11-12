import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import type { CallToolResult } from '@modelcontextprotocol/server';

import type { McpAuthenticatedPrincipal } from '../src/auth/mcp-oauth-routes.ts';
import { DISCOVERY_GUIDE_URI } from '../src/management/agent-authoring/index.ts';
import { WORKSPACE_MANAGEMENT_SERVER_INFO, workspaceManagementMcpFetch } from '../src/management/mcp.ts';
import { mcpErrorResult } from '../src/management/mcp-v5/conventions.ts';
import {
  REMOVED_PROMPT_NAMES,
  REMOVED_RESOURCE_MESSAGE,
  REMOVED_RESOURCE_URIS,
  REMOVED_TOOL_NAMES,
  REMOVED_TOOLS,
  removedPromptMessage,
  removedToolResult,
} from '../src/management/mcp-v5/removed-v4.ts';
import { FIVE_ZERO_TOOL_NAMES } from '../src/management/mcp-v5/tools.ts';
import { parseToolEnvelope as cliV020Envelope, printedCode } from './fixtures/cli-v0.2.0/tools.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';
import { jsonRequest } from './helpers/mcp-card-host.ts';

const MODERN = '2026-07-28';
const LEGS = ['2025-06-18', '2025-11-25', MODERN] as const;
const CLIENTS = [
  ['a client without cards', 'client_plain'],
  ['ChatGPT, a card host', 'https://chatgpt.com/oauth/client.json'],
] as const;
const V4_NAMED = new RegExp(`\\b(?:${REMOVED_TOOL_NAMES.join('|')})\\b`, 'g');

type Answer = { status: number; message: { result?: any; error?: { code: number; message: string } } };

/** The signed-in owner through one client, each request as the Worker serves it, with its HTTP status. */
async function server(t: TestContext, suffix: string) {
  const f = await createManagementAdapterFixture(suffix, ({ settings }) => ({ settings }));
  t.after(() => f.close());
  t.mock.method(console, 'info', () => {});
  const fetchAs = (clientId: string) => workspaceManagementMcpFetch({
    principal: {
      betterAuthUserId: f.owner.binding.betterAuthUserId ?? 'ba_owner',
      userId: f.owner.user.id,
      membershipId: f.owner.membership.id,
      organizationId: f.owner.membership.organizationId,
      role: 'owner',
      clientId,
    } satisfies McpAuthenticatedPrincipal,
    service: f.service,
    baseUrl: 'https://chickpea.example.test',
  });
  const send = async (clientId: string, protocol: string, method: string, params: Record<string, unknown> = {}): Promise<Answer> => {
    const modern = protocol === MODERN;
    const named = typeof params.name === 'string' ? params.name : typeof params.uri === 'string' ? params.uri : undefined;
    const response = await fetchAs(clientId)(jsonRequest(
      {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': protocol,
        ...modern ? { 'mcp-method': method, ...named ? { 'mcp-name': named } : {} } : {},
      },
      {
        jsonrpc: '2.0', id: 1, method,
        params: modern ? { ...params, _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN,
          'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1' },
          'io.modelcontextprotocol/clientCapabilities': {},
        } } : params,
      },
    ));
    const text = await response.text();
    const json = text.trimStart().startsWith('{') ? text : text.split('\n').find((line) => line.startsWith('data: '))!.slice(6);
    return { status: response.status, message: JSON.parse(json) };
  };
  return { f, send };
}

for (const [who, clientId] of CLIENTS) for (const protocol of LEGS) {
  test(`${who} on ${protocol}: every removed tool, prompt and resource answers with what replaced it`, async (t) => {
    const { send } = await server(t, `removed-${clientId.length}-${protocol}`);
    const modern = protocol === MODERN;

    if (!modern) {
      const initialized = (await send(clientId, protocol, 'initialize', {
        protocolVersion: protocol, capabilities: {}, clientInfo: { name: 'test-client', version: '1' },
      })).message.result;
      assert.equal(initialized.serverInfo.version, '5.0.0');
      assert.deepEqual(initialized.capabilities.prompts, { listChanged: true }, 'the prompts capability, as a card host saw it before 5.0.0');
    }
    const listed = (await send(clientId, protocol, 'tools/list')).message.result.tools as Array<{ name: string }>;
    assert.deepEqual(listed.map(({ name }) => name), FIVE_ZERO_TOOL_NAMES, 'the 5.0 tools, and only those');
    const resources = (await send(clientId, protocol, 'resources/list')).message.result.resources as Array<{ uri: string }>;
    assert.deepEqual(resources.filter(({ uri }) => !uri.startsWith('ui://chickpea/')).map(({ uri }) => uri), [DISCOVERY_GUIDE_URI],
      'the discovery guide and the card templates');

    for (const name of REMOVED_TOOL_NAMES) {
      const { status, message } = await send(clientId, protocol, 'tools/call', { name, arguments: {} });
      assert.equal(status, 200, name);
      assert.equal(message.error, undefined, `${name}: a result its client hands to the model`);
      assert.deepEqual(message.result, { ...removedToolResult(name), ...modern ? { resultType: 'complete' } : {} }, name);
    }
    // The server keeps an empty prompts capability, so every leg answers in-band with HTTP 200. Without it,
    // SDK 2.4.0's entry gate answers both methods on 2026-07-28 with HTTP 404, which can read as a broken connection.
    for (const name of REMOVED_PROMPT_NAMES) {
      const answer = await send(clientId, protocol, 'prompts/get', { name, arguments: {} });
      assert.deepEqual(answer, { status: 200, message: {
        jsonrpc: '2.0', id: 1, error: { code: -32602, message: removedPromptMessage(name) },
      } }, name);
    }
    const promptList = await send(clientId, protocol, 'prompts/list');
    assert.equal(promptList.status, 200);
    assert.equal(promptList.message.error, undefined);
    assert.deepEqual(promptList.message.result.prompts, [], 'no prompts, as a card host got before 5.0.0');
    for (const uri of REMOVED_RESOURCE_URIS) {
      const answer = await send(clientId, protocol, 'resources/read', { uri });
      assert.deepEqual(answer, { status: 200, message: {
        jsonrpc: '2.0', id: 1, error: { code: -32602, message: REMOVED_RESOURCE_MESSAGE },
      } }, uri);
    }
  });
}

test('a removed tool\'s answer names its replacements, keeps 4.x\'s ok: false, and names no other 4.x tool', () => {
  assert.equal(WORKSPACE_MANAGEMENT_SERVER_INFO.version, '5.0.0');
  assert.equal(REMOVED_TOOL_NAMES.length, 21);
  for (const name of REMOVED_TOOL_NAMES) {
    const answer = removedToolResult(name);
    const { error } = answer.structuredContent;
    assert.equal(answer.isError, true);
    assert.equal(answer.structuredContent.ok, false, name);
    assert.deepEqual([error.code, error.retryable], ['tool_removed', false], name);
    assert.deepEqual(error.replacedBy, [...REMOVED_TOOLS[name].replacedBy], name);
    assert.ok(error.replacedBy.length > 0 && error.replacedBy.every((tool) =>
      (FIVE_ZERO_TOOL_NAMES as readonly string[]).includes(tool) && error.message.includes(tool)), `${name}: every replacement is a 5.0 tool the message names`);
    assert.ok(error.message.startsWith(`Chickpea 5.0 removed ${name}. `), name);
    assert.match(error.message, /Start a new session or reconnect Chickpea to load the 5\.0 tools\. If you use chickpea-cli, update it with npx chickpea-cli@latest\.$/);
    assert.ok(error.nextStep.startsWith('This session\'s Chickpea tool list is out of date. Tell the person, and name the tools above.'), name);
    assert.deepEqual(answer.content, [{ type: 'text', text: `${error.message}\n${error.nextStep}` }]);
    assert.deepEqual([...new Set(JSON.stringify(answer).match(V4_NAMED))], [name], `${name} names only itself among the 21`);
  }
  assert.equal(removedToolResult('inspect_workspace').structuredContent.error.message,
    'Chickpea 5.0 removed inspect_workspace. Use get_workspace, list_agents, get_agent, list_services, list_models, list_members or list_slack_channels instead. ' +
    'Start a new session or reconnect Chickpea to load the 5.0 tools. If you use chickpea-cli, update it with npx chickpea-cli@latest.');
  // A recipe preview's replacement is the tool that previews, not the ones that write.
  assert.deepEqual(removedToolResult('preview_workspace_recipe').structuredContent.error.replacedBy, ['propose_agent']);
  assert.equal(removedToolResult('preview_workspace_recipe').structuredContent.error.message,
    'Chickpea 5.0 removed preview_workspace_recipe. Use propose_agent instead. ' +
    'Start a new session or reconnect Chickpea to load the 5.0 tools. If you use chickpea-cli, update it with npx chickpea-cli@latest.');
  // The ids that carry over, and the confirmation that does not.
  assert.match(removedToolResult('undo_workspace_change').structuredContent.error.nextStep, /undo_change takes the change's operationId as its undoToken\.$/);
  assert.match(removedToolResult('get_operation').structuredContent.error.nextStep, /get_setup_status takes a setup link's setupOperationId as its setupToken\.$/);
  assert.match(removedToolResult('confirm_workspace_change').structuredContent.error.nextStep,
    /A confirmation made before Chickpea 5\.0 has expired\. Call the 5\.0 tool for that change again to get a new preview, then confirm_change\.$/);
});

test('no other 5.0 result carries ok: errors are { error } and no listed output schema has ok', async (t) => {
  assert.deepEqual(Object.keys(mcpErrorResult({ code: 'not_found', message: 'Not found.', retryable: false }).structuredContent), ['error']);
  const { send } = await server(t, 'removed-no-ok');
  for (const clientId of ['client_plain', 'https://chatgpt.com/oauth/client.json']) {
    const tools = (await send(clientId, '2025-11-25', 'tools/list')).message.result.tools as Array<{ name: string; outputSchema?: any }>;
    for (const { name, outputSchema } of tools) {
      assert.ok(outputSchema, `${name} declares its output`);
      for (const shape of outputSchema.anyOf ?? [outputSchema]) {
        assert.equal(shape.properties?.ok, undefined, `${name}'s result has no ok`);
      }
    }
  }
});

test('chickpea-cli 0.2.0 reads the answer as TOOL_TOOL_REMOVED with its message', () => {
  for (const name of ['inspect_workspace', 'export_workspace_recipe', 'preview_workspace_recipe', 'upload_skills'] as const) {
    const answer = removedToolResult(name);
    const envelope = cliV020Envelope(answer as CallToolResult);
    assert.equal(envelope.ok, false);
    assert.ok(!envelope.ok && printedCode(envelope) === 'TOOL_TOOL_REMOVED', name);
    assert.ok(!envelope.ok && envelope.error.message === answer.structuredContent.error.message, name);
  }
});

test('a call of a removed tool counts by its name, and a read of a removed resource by its URI', async (t) => {
  const { send } = await server(t, 'removed-metrics');
  const metrics: Array<Record<string, unknown>> = [];
  t.mock.method(console, 'info', (record: unknown) => {
    if (record && typeof record === 'object' && (record as { event?: unknown }).event === 'mcp.request') metrics.push(record as Record<string, unknown>);
  });
  const counted = () => metrics.splice(0).map(({ method, tool, resource, outcome, errorCode }) => ({ method, tool, resource, outcome, errorCode }));
  for (const protocol of LEGS) {
    await send('client_plain', protocol, 'tools/call', { name: 'apply_workspace_changes', arguments: { idempotencyKey: 'k', operations: [] } });
    assert.deepEqual(counted(), [{ method: 'tools/call', tool: 'apply_workspace_changes', resource: undefined, outcome: 'jsonrpc_error', errorCode: '-32602' }],
      `${protocol}: counted as the SDK answered it, before the answer is reshaped`);
    for (const uri of REMOVED_RESOURCE_URIS) {
      await send('client_plain', protocol, 'resources/read', { uri });
      assert.deepEqual(counted(), [{ method: 'resources/read', tool: undefined, resource: uri, outcome: 'jsonrpc_error', errorCode: '-32602' }], `${protocol} ${uri}`);
    }
  }
});
