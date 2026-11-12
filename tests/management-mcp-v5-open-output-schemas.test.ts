import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, type TestContext } from 'node:test';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import type { ConnectionAccount } from '../src/config/types.ts';
import { workspaceManagementMcpFetch } from '../src/management/mcp.ts';
import { openOutputSchema } from '../src/management/mcp-v5/conventions.ts';
import { CARD_REFUSAL_TOOL_NAMES, FIVE_ZERO_TOOL_NAMES, FIVE_ZERO_TOOLS } from '../src/management/mcp-v5/tools.ts';
import { createFixtureAgent } from './helpers/management-adapter-fixture.ts';
import { BASE_URL, cardServer } from './helpers/mcp-card-host.ts';

/**
 * A client may check each result against the output schema it listed, and
 * keep that listing across releases (the MCP SDK client checks by default).
 * So a listed output schema accepts fields it does not name, while the server
 * still refuses to send one, and inputs stay strict.
 */

type Listed = { name: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown> };

/** Every place in a JSON Schema that refuses fields it does not name. */
function closedAt(schema: unknown, path = '#'): string[] {
  if (Array.isArray(schema)) return schema.flatMap((item, index) => closedAt(item, `${path}/${index}`));
  if (typeof schema !== 'object' || schema === null) return [];
  return Object.entries(schema).flatMap(([key, value]) => [
    ...key === 'additionalProperties' && value === false ? [path] : [],
    ...closedAt(value, `${path}/${key}`),
  ]);
}

// Mutation proof: listing `definition.output` itself in tools.ts, or the refusal without openOutputSchema in
// card-host.ts, fails this test with the paths it closes.
test('every 5.0 tool lists an output schema that refuses no field anywhere, on a card session too; inputs stay strict', async (t) => {
  assert.deepEqual(closedAt({ anyOf: [{ items: { additionalProperties: false } }] }), ['#/anyOf/0/items'], 'the walk reaches nested schemas');
  for (const cards of [false, true]) {
    const { send } = await cardServer(t, `open-output-${cards ? 'cards' : 'plain'}`, {}, { cards });
    const tools = (JSON.parse(await send('tools/list', {})).result.tools as Listed[])
      .filter(({ name }) => (FIVE_ZERO_TOOL_NAMES as readonly string[]).includes(name));
    assert.equal(tools.length, FIVE_ZERO_TOOL_NAMES.length);
    for (const tool of tools) {
      assert.ok(tool.outputSchema, tool.name);
      assert.deepEqual(closedAt(tool.outputSchema), [], `${tool.name}${cards ? ' on a card session' : ''}`);
      assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name}: an input it does not name is refused`);
    }
    assert.deepEqual(
      tools.filter(({ outputSchema }) => 'anyOf' in outputSchema!).map(({ name }) => name),
      cards ? tools.filter(({ name }) => CARD_REFUSAL_TOOL_NAMES.has(name)).map(({ name }) => name) : [],
      'a card session still lists the refusal beside each such tool\'s output',
    );
  }
});

/** A signed-in catalog Linear whose tools get_agent lists under `tools`, which ab65a0d30's listing does not name. */
async function agentWithCatalogTools(f: Awaited<ReturnType<typeof cardServer>>['f'], teamId: string) {
  await createFixtureAgent(f, 'agent_research');
  const tools = [{ name: 'list_issues', readOnlyHint: true }, { name: 'save_issue', readOnlyHint: false }];
  const account = await f.config.putConnectionAccount({
    id: 'connection_linear_team', workspaceId: teamId, ownerKind: 'team', providerId: 'linear',
    label: 'Linear', lifecycle: 'ready', identity: { workspaceName: 'Acme' },
    createdByMembershipId: f.owner.membership.id, secretRefId: 'secret_linear_team',
    policy: {
      kind: 'mcp', url: 'https://mcp.linear.example/mcp', transport: 'streamable-http', authMode: 'oauth', headerNames: [],
      discoveredTools: tools, allowedTools: tools.map(({ name }) => name), oauthScope: 'read', presetId: 'linear',
    },
  } as Omit<ConnectionAccount, 'revision' | 'createdAt' | 'updatedAt'>);
  await f.config.putAgentConnectionBinding({
    agentId: 'agent_research', connectionAccountId: account.id, providerId: 'linear', allowedCapabilities: [], enabled: true,
  });
}

/** The MCP SDK's own client, over Core's real handler. */
async function sdkClient(t: TestContext, server: Awaited<ReturnType<typeof cardServer>>): Promise<Client> {
  const handler = workspaceManagementMcpFetch({ principal: server.principal, service: server.f.service, baseUrl: BASE_URL });
  const client = new Client({ name: 'older-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), {
    fetch: (url, init) => handler(new Request(url, init)),
  }));
  t.after(() => client.close());
  return client;
}

// Mutation proof: dropping openOutputSchema from the older listing fails the first call, as the listing train 5 served fails today.
test('a client holding get_agent\'s listing from before it gained tools accepts get_agent once tools is there', async (t) => {
  const server = await cardServer(t, 'older-listing');
  await agentWithCatalogTools(server.f, server.teamId!);
  const client = await sdkClient(t, server);
  const listed = (await client.listTools()).tools.find(({ name }) => name === 'get_agent')!;
  const asServed = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/mcp-v5/get-agent-output-ab65a0d30.json'), 'utf8')) as Record<string, unknown>;
  assert.doesNotMatch(JSON.stringify(asServed), /"tools"/, 'the older listing does not name tools');
  const call = (outputSchema: Record<string, unknown>) => client.callTool(
    { name: 'get_agent', arguments: { agentId: 'agent_research' } },
    { toolDefinition: { ...listed, outputSchema: outputSchema as typeof listed.outputSchema } },
  );

  // As this release lists every output: that contract, with no field refused.
  const result = await call(openOutputSchema(asServed));
  const [linear] = (result.structuredContent as { connections: Array<Record<string, unknown>> }).connections;
  assert.deepEqual(linear?.tools, { allowedTools: ['list_issues', 'save_issue'] }, 'the result carries the field the listing does not name');
  // As it was served then: what a client that kept it hits until it lists the tools again.
  await assert.rejects(call(asServed), /does not match the tool's output schema/);
  // This release's own listing, which the client keeps for later results.
  assert.deepEqual(closedAt(listed.outputSchema), []);
  assert.ok((await client.callTool({ name: 'get_agent', arguments: { agentId: 'agent_research' } })).structuredContent);
});

test('the server still refuses to send a field the contract does not name', async (t) => {
  const { call, f } = await cardServer(t, 'still-strict');
  await createFixtureAgent(f, 'agent_research');
  const agent = (await call('get_agent', { agentId: 'agent_research' })).structuredContent as Record<string, unknown>;
  assert.equal(FIVE_ZERO_TOOLS.get_agent.output.safeParse(agent).success, true);
  assert.equal(FIVE_ZERO_TOOLS.get_agent.output.safeParse({ ...agent, revision: 3 }).success, false);
  assert.equal(FIVE_ZERO_TOOLS.get_agent.output.safeParse({ ...agent, links: { ...agent.links as object, internal: 'x' } }).success, false,
    'nested objects too');
});
