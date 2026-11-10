import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import type { McpAuthenticatedPrincipal } from '../src/auth/mcp-oauth-routes.ts';
import { workspaceManagementMcpFetch } from '../src/management/mcp.ts';
import { createFixtureAgent, createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

const BASE_URL = 'https://chickpea.example.test';
const LEGACY = '2025-11-25';
const MODERN = '2026-07-28';
const CARDS = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } };

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, any>;
  isError?: boolean;
  _meta?: Record<string, any>;
};

/**
 * Core's MCP server as the Worker serves it: a client that declares cards at
 * initialize gets a session, and each later request in it says so.
 */
async function harness(t: TestContext, suffix: string) {
  const f = await createManagementAdapterFixture(suffix, ({ settings }) => ({ settings }));
  t.after(() => f.close());
  const teamId = f.owner.binding.slackTeamId;
  const principal: McpAuthenticatedPrincipal = {
    betterAuthUserId: f.owner.binding.betterAuthUserId ?? 'ba_owner',
    userId: f.owner.user.id,
    membershipId: f.owner.membership.id,
    organizationId: f.owner.membership.organizationId,
    role: 'owner',
    clientId: `client_${suffix}`,
  };
  const fetch = workspaceManagementMcpFetch({ principal, service: f.service, baseUrl: BASE_URL });
  const post = async (body: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const response = await fetch(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
    }));
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const json = text.trimStart().startsWith('{') ? text : text.split('\n').find((line) => line.startsWith('data: '))!.slice(6);
    return { response, result: (JSON.parse(json) as { result: any }).result };
  };
  /** A 2025 client: initialize, then each call with the session initialize named, if any. */
  const connect = async (capabilities: Record<string, unknown>) => {
    const { response } = await post({
      method: 'initialize',
      params: { protocolVersion: LEGACY, capabilities, clientInfo: { name: 'test-client', version: '1' } },
    }, { 'mcp-protocol-version': LEGACY });
    const session = response.headers.get('mcp-session-id');
    const call = async (name: string, args: Record<string, unknown> = {}) => (await post(
      { method: 'tools/call', params: { name, arguments: args } },
      { 'mcp-protocol-version': LEGACY, ...session ? { 'mcp-session-id': session } : {} },
    )).result as ToolResult;
    return { session, call };
  };
  /** A 2026-07-28 client: every request carries its capabilities. */
  const modern = (capabilities: Record<string, unknown>) => async (name: string, args: Record<string, unknown> = {}) => (await post({
    method: 'tools/call',
    params: {
      name,
      arguments: args,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': MODERN,
        'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': capabilities,
      },
    },
  }, { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/call', 'mcp-name': name })).result as ToolResult;

  await createFixtureAgent(f, 'agent_support');
  await f.config.putChannel({ workspaceId: teamId, channelId: 'C_SUPPORT', label: 'support', lifecycle: 'active' });
  await f.config.putAgentChannelGrant({
    workspaceId: teamId, channelId: 'C_SUPPORT', agentId: 'agent_support', status: 'active',
    createdByMembershipId: f.owner.membership.id, channelLabel: 'support',
  });
  return { f, connect, modern };
}

async function version(call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>, agentId: string) {
  return (await call('get_agent', { agentId })).structuredContent!.version as string;
}

/** Everything a host's model reads from a result. */
function modelView(result: ToolResult): string {
  return JSON.stringify({ structuredContent: result.structuredContent, content: result.content });
}

test('Keep voids a confirmation: confirm_change with its token afterwards is refused, and nothing changes', async (t) => {
  const { f, connect } = await harness(t, 'card-keep');
  const { call } = await connect({});
  const off = await call('update_agent', { agentId: 'agent_support', version: await version(call, 'agent_support'), on: false, idempotencyKey: 'off' });
  const { confirmToken } = off.structuredContent!.confirmation;

  const kept = await call('decline_change', { confirmToken });
  assert.deepEqual(kept.structuredContent, { status: 'unchanged', summary: 'Kept as it is. Nothing changed.' });
  assert.deepEqual((await call('decline_change', { confirmToken })).structuredContent, kept.structuredContent, 'a second press says the same');

  const refused = await call('confirm_change', { confirmToken });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent!.error.message, 'That change was cancelled. Ask again to make it.');
  assert.equal((await f.config.getAgent('agent_support')).enabled, true, 'the Agent is still on');

  // Asking again makes a fresh confirmation, which works.
  const again = await call('update_agent', { agentId: 'agent_support', version: await version(call, 'agent_support'), on: false, idempotencyKey: 'off-again' });
  const done = await call('confirm_change', { confirmToken: again.structuredContent!.confirmation.confirmToken });
  assert.equal(done.structuredContent!.status, 'done');
  assert.equal((await f.config.getAgent('agent_support')).enabled, false);
});

test('Keep after the change was already made says so, and never undoes it', async (t) => {
  const { f, connect } = await harness(t, 'card-keep-late');
  const { call } = await connect({});
  const off = await call('update_agent', { agentId: 'agent_support', version: await version(call, 'agent_support'), on: false, idempotencyKey: 'off' });
  const { confirmToken } = off.structuredContent!.confirmation;
  await call('confirm_change', { confirmToken });
  const late = await call('decline_change', { confirmToken });
  assert.equal(late.structuredContent!.status, 'done');
  assert.equal(late.structuredContent!.summary, 'That change was already made.');
  assert.equal((await f.config.getAgent('agent_support')).enabled, false);

  const unknown = await call('decline_change', { confirmToken: 'proposal_nobody' });
  assert.equal(unknown.structuredContent!.error.code, 'not_found');
});

test('a client that draws cards never shows its model a confirm or undo token; its card gets them in _meta', async (t) => {
  const { f, connect } = await harness(t, 'card-host');
  const { session, call } = await connect(CARDS);
  assert.match(session ?? '', /^chickpea-cards-[0-9a-f-]{36}$/, 'initialize names a session that draws cards');

  const off = await call('update_agent', { agentId: 'agent_support', version: await version(call, 'agent_support'), on: false, idempotencyKey: 'off' });
  const held = off._meta?.['chickpea/held'] as { confirmToken?: string };
  assert.equal(typeof held?.confirmToken, 'string', 'the card holds the token');
  assert.equal(off.structuredContent!.status, 'needs_confirmation');
  assert.equal(off.structuredContent!.confirmation.confirmToken, undefined);
  assert.ok(!modelView(off).includes(held.confirmToken!), 'the model sees no confirm token');
  assert.equal(off.structuredContent!.summary,
    `Nothing has changed yet. Confirm on the card above, or in Admin: ${BASE_URL}/admin/agents/agent_support.`);
  assert.deepEqual(JSON.parse(off.content[0]!.text), off.structuredContent, 'the text says the same');
  assert.equal((await f.config.getAgent('agent_support')).enabled, true);

  // The card's press confirms with the token it holds.
  const confirmed = await call('confirm_change', { confirmToken: held.confirmToken! });
  assert.equal(confirmed.structuredContent!.status, 'done');
  assert.equal((await f.config.getAgent('agent_support')).enabled, false);

  const renamed = await call('update_agent', { agentId: 'agent_support', version: await version(call, 'agent_support'), description: 'Answers billing questions.', idempotencyKey: 'describe' });
  const undo = (renamed._meta?.['chickpea/held'] as { undoToken?: string } | undefined)?.undoToken;
  assert.equal(typeof undo, 'string', 'the card holds the undo token');
  assert.equal(renamed.structuredContent!.undoToken, undefined);
  assert.ok(!modelView(renamed).includes(undo!), 'the model sees no undo token');
  assert.match(renamed.structuredContent!.nextStep, /undo it on the card above/);

  // A write no card draws keeps its token where the model can use it.
  const memory = await call('get_agent_memory', { agentId: 'agent_support' });
  const remembered = await call('update_agent_memory', {
    agentId: 'agent_support', version: memory.structuredContent!.version, body: 'Billing questions go to #support.', idempotencyKey: 'memory',
  });
  assert.equal(typeof remembered.structuredContent!.undoToken, 'string', JSON.stringify(remembered));
  assert.equal(remembered._meta, undefined);
});

test('a client without cards keeps every token where its model reads it, as before', async (t) => {
  const { connect } = await harness(t, 'card-none');
  const { session, call } = await connect({ elicitation: { form: {} } });
  assert.equal(session, null, 'no session for a client that draws no cards');
  const off = await call('update_agent', { agentId: 'agent_support', version: await version(call, 'agent_support'), on: false, idempotencyKey: 'off' });
  const { confirmToken } = off.structuredContent!.confirmation;
  assert.equal(typeof confirmToken, 'string');
  assert.ok(off.content[0]!.text.includes(confirmToken), 'the text carries it too');
  assert.equal(off.structuredContent!.summary, 'This change waits for the person\'s confirmation. Nothing has changed yet.');
  assert.deepEqual(off._meta, { 'chickpea/tool': 'update_agent' });
});

test('a 2026-07-28 request that declares cards gets the same: the token only in _meta', async (t) => {
  const { modern } = await harness(t, 'card-modern');
  const withCards = modern(CARDS);
  const off = await withCards('update_agent', { agentId: 'agent_support', version: await version(withCards, 'agent_support'), on: false, idempotencyKey: 'off' });
  const held = off._meta?.['chickpea/held'] as { confirmToken?: string };
  assert.equal(typeof held?.confirmToken, 'string');
  assert.ok(!modelView(off).includes(held.confirmToken!));

  const plain = modern({});
  const again = await plain('update_agent', { agentId: 'agent_support', version: await version(plain, 'agent_support'), on: false, idempotencyKey: 'off-plain' });
  assert.equal(typeof again.structuredContent!.confirmation.confirmToken, 'string');
});
