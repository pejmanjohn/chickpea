import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { createMcpHandler } from '@modelcontextprotocol/server';

import type { McpAuthenticatedPrincipal } from '../src/auth/mcp-oauth-routes.ts';
import { CONNECTION_CATALOG_PRESETS } from '../src/config/presets.ts';
import { MANAGED_CONNECTOR_CATALOG } from '../src/connections/catalog/index.ts';
import { createWorkspaceManagementMcpServer } from '../src/management/mcp.ts';
import { getServiceOutput } from '../src/management/mcp-v5/schemas.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown> & { error?: Record<string, unknown> };
  isError?: boolean;
};
type Service = ReturnType<typeof getServiceOutput.parse>;

/** Core's MCP server in process, signed in as the fixture's Owner, or its Admin demoted to a member. */
async function harness(t: TestContext, suffix: string, as: 'owner' | 'member' = 'owner') {
  const f = await createManagementAdapterFixture(suffix);
  t.after(() => f.close());
  if (as === 'member') {
    await f.identity.updateMembershipAuthority({
      membershipId: f.admin.membership.id,
      role: 'member',
      actorMembershipId: f.owner.membership.id,
      correlationId: `${suffix}-demotion`,
      authenticationSurface: 'better_auth',
      reasonCode: 'mcp_v5_test',
    });
  }
  const person = as === 'owner' ? f.owner : f.admin;
  const principal: McpAuthenticatedPrincipal = {
    betterAuthUserId: person.binding.betterAuthUserId ?? 'ba_owner',
    userId: person.user.id,
    membershipId: person.membership.id,
    organizationId: person.membership.organizationId,
    role: as,
    clientId: `client_${suffix}`,
  };
  const handler = createMcpHandler(
    () => createWorkspaceManagementMcpServer({ principal, service: f.service, baseUrl: 'https://chickpea.example.test' }),
    { legacy: 'stateless' },
  );
  const rpc = async (method: string, params: Record<string, unknown>) => {
    const response = await handler.fetch(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }));
    const body = await response.text();
    assert.equal(response.status, 200, body);
    const json = body.trimStart().startsWith('{')
      ? body
      : body.split('\n').find((line) => line.startsWith('data: '))!.slice('data: '.length);
    return JSON.parse(json) as { result?: unknown };
  };
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await rpc('tools/call', { name, arguments: args })).result as ToolResult;
  return { f, rpc, call };
}

/** A result: everything in structuredContent, and a short text block that is not the JSON again. */
function service(result: ToolResult): Service {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.ok(result.structuredContent, JSON.stringify(result));
  const parsed = getServiceOutput.parse(result.structuredContent);
  assert.equal(result.content.length, 1);
  const text = result.content[0]!.text;
  assert.ok(!text.startsWith('{'), `the text block is a status line, not JSON: ${text}`);
  assert.ok(text.includes(`(service ${parsed.service})`), `the text names the service: ${text}`);
  assert.ok(text.endsWith(parsed.nextStep), text);
  assert.ok(text.length < 600, `${text.length} characters of text`);
  return parsed;
}

function assertNoInternals(serialized: string, f: Awaited<ReturnType<typeof createManagementAdapterFixture>>): void {
  for (const forbidden of [
    f.owner.membership.organizationId, f.owner.membership.id, f.owner.user.id, f.admin.membership.id,
    'membershipId', 'organizationId', 'revision', 'managedToolkit', 'providerId', 'placeholder', 'headerName',
  ]) assert.equal(serialized.includes(forbidden), false, `${forbidden} leaked: ${serialized.slice(0, 400)}`);
}

test('get_service lists the tool as a read with an outputSchema, and list_services points to it', async (t) => {
  const { rpc, call } = await harness(t, 'svc-list');
  const { tools } = (await rpc('tools/list', {})).result as { tools: Array<Record<string, unknown> & { name: string }> };
  const tool = tools.find(({ name }) => name === 'get_service')!;
  assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false });
  assert.deepEqual(tool.securitySchemes, [{ type: 'oauth2', scopes: ['chickpea:workspace'] }]);
  const output = tool.outputSchema as { type: string; additionalProperties?: boolean; required: string[] };
  assert.equal(output.type, 'object');
  assert.equal(output.additionalProperties, undefined, 'a listed output accepts a field a later release adds');
  assert.deepEqual(
    [...output.required].sort(),
    ['account', 'capabilitiesKnown', 'description', 'name', 'nextStep', 'practice', 'service', 'signIn'],
  );
  assert.ok(tools.findIndex(({ name }) => name === 'get_service') === tools.findIndex(({ name }) => name === 'list_services') + 1);

  const listed = (await call('list_services', { search: 'gmail' })).structuredContent!;
  assert.match(listed.nextStep as string, /\bget_service\b/);
});

test('a managed service lists its tools now, its writes as write with what they change, and practice reads them', async (t) => {
  const { f, call } = await harness(t, 'svc-managed');
  const gmail = service(await call('get_service', { service: 'gmail' }));
  assert.equal(gmail.service, 'gmail');
  assert.equal(gmail.name, 'Gmail');
  assert.equal(gmail.signIn, 'oauth');
  assert.deepEqual(gmail.account, { team: true, own: true });
  assert.equal(gmail.capabilitiesKnown, 'now');
  assert.equal(gmail.practice, 'reads_ready');
  assert.deepEqual(gmail.capabilities, [
    { name: 'gmail_get_profile', does: 'read' },
    { name: 'gmail_search_messages', does: 'read' },
    { name: 'gmail_create_draft', does: 'write', changes: 'create email draft' },
    { name: 'gmail_send_message', does: 'write', changes: 'send email' },
  ]);
  assert.match(gmail.nextStep, /connect_service with service gmail, an agentId and owner team or me/);
  assert.match(gmail.nextStep, /practice run can use its read actions/);
  const raw = JSON.stringify(gmail);
  assert.equal(raw.includes('gmail.messages.send'), false, 'no capability ID');
  assertNoInternals(raw, f);

  // By name, as list_services shows it, and a Composio service that takes a key.
  const hubspot = service(await call('get_service', { service: 'HubSpot' }));
  assert.equal(hubspot.service, 'hubspot-managed');
  assert.ok(hubspot.capabilities!.some(({ does }) => does === 'write'));
  assert.equal(service(await call('get_service', { service: 'freshdesk-managed' })).signIn, 'key');
});

test('an MCP preset says its tools come after connecting, and how practice gets its reads: update_connection, or Admin for a reviewed one', async (t) => {
  const { f, call } = await harness(t, 'svc-mcp');
  const linear = service(await call('get_service', { service: 'linear' }));
  assert.equal(linear.signIn, 'oauth');
  assert.equal(linear.capabilitiesKnown, 'after_connecting');
  assert.equal(linear.capabilities, undefined);
  // update_connection marks a catalog MCP service's reads once it is connected, and get_agent lists the tools to mark.
  assert.equal(linear.practice, 'needs_read_marks');
  assert.match(linear.nextStep, /get_agent lists its tools under tools, and a practice run leaves it out until update_connection marks the ones that only read with readTools\. Mark only the tools the person confirms only read\.$/);
  assert.doesNotMatch(linear.nextStep, /Admin|in Slack/);
  assert.equal(service(await call('get_service', { service: 'stripe' })).signIn, 'key');
  assertNoInternals(JSON.stringify(linear), f);
  // The server's URL is the catalog's business, not the model's.
  assert.equal(JSON.stringify(linear).includes('https://'), false);

  // A reviewed connector's tool choices carry Chickpea's own read marks, so its reads come with them.
  for (const reviewed of ['bugsnag', 'meta-ads']) {
    const result = service(await call('get_service', { service: reviewed }));
    assert.equal(result.practice, 'needs_read_marks', reviewed);
    assert.match(result.nextStep, /leaves it out until they are chosen on the Agent's page in Admin/);
    assert.doesNotMatch(result.nextStep, /update_connection/, 'update_connection refuses a reviewed connector');
  }
  for (const preset of CONNECTION_CATALOG_PRESETS) {
    if ('managedToolkit' in preset || preset.url === undefined) continue;
    const { practice } = service(await call('get_service', { service: preset.id }));
    assert.equal(practice, 'needs_read_marks', preset.id);
  }
});

test('an API preset lists its methods and hosts, and practice sends only GET', async (t) => {
  const { f, call } = await harness(t, 'svc-api');
  const asana = service(await call('get_service', { service: 'asana' }));
  assert.equal(asana.signIn, 'key');
  assert.equal(asana.capabilitiesKnown, 'now');
  assert.equal(asana.practice, 'get_only');
  assert.deepEqual(asana.capabilities, [
    { name: 'GET app.asana.com/api/1.0', does: 'read' },
    { name: 'POST app.asana.com/api/1.0', does: 'write' },
    { name: 'PUT app.asana.com/api/1.0', does: 'write' },
  ]);
  assert.match(asana.nextStep, /only GET and HEAD requests/);
  assertNoInternals(JSON.stringify(asana), f);
});

test('an unknown service is not_found, pointing to list_services', async (t) => {
  const { call } = await harness(t, 'svc-unknown');
  const result = await call('get_service', { service: 'Not A Real Service' });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent!.error, {
    code: 'not_found',
    message: 'Chickpea does not list a service called Not A Real Service.',
    retryable: false,
    nextStep: 'Call list_services for the services Chickpea knows.',
  });
});

test('a member reads the catalog too, and is told only an Owner or Admin connects a team account', async (t) => {
  const { call } = await harness(t, 'svc-member', 'member');
  const notion = service(await call('get_service', { service: 'Notion' }));
  assert.equal(notion.practice, 'reads_ready');
  assert.match(notion.nextStep, /owner me \(only an Owner or Admin connects a team account\)/);
  assert.doesNotMatch(notion.nextStep, /marks a team account/, 'nothing to mark for a managed service');
  // A service whose reads are marked: the member marks their own account's tools, an Owner or Admin a team account's.
  const linear = service(await call('get_service', { service: 'linear' }));
  assert.match(linear.nextStep, /Mark only the tools the person confirms only read\. The person can mark the tools of their own account; only an Owner or Admin marks a team account's\.$/);
  const owner = await harness(t, 'svc-member-owner');
  assert.doesNotMatch(service(await owner.call('get_service', { service: 'linear' })).nextStep, /only an Owner or Admin marks/);
  assert.doesNotMatch(service(await call('get_service', { service: 'bugsnag' })).nextStep, /marks a team account/, 'a reviewed one is chosen in Admin');
});

test('every catalog service returns under 28,000 characters, and every managed one lists a read', async (t) => {
  const { call } = await harness(t, 'svc-all');
  let largest = 0;
  for (const preset of CONNECTION_CATALOG_PRESETS) {
    if ('managedToolkit' in preset) {
      const header = MANAGED_CONNECTOR_CATALOG.connector(preset.managedToolkit);
      assert.ok(header, `${preset.id}: the catalog has its capability headers`);
      assert.ok(header.capabilities.some(({ effect }) => effect === 'read'), `${preset.id}: a practice run has a read to use`);
      // `does` follows effect, as a practice run does; a lane that disagreed would show a write as a read.
      for (const { toolName, effect, accessLane } of header.capabilities) {
        assert.equal(accessLane === 'read', effect === 'read', `${toolName}: its lane and effect agree`);
      }
    }
    const result = await call('get_service', { service: preset.id });
    const parsed = service(result);
    assert.equal(parsed.service, preset.id);
    largest = Math.max(largest, JSON.stringify(result).length);
  }
  assert.ok(largest < 28_000, `largest result ${largest} characters`);
});
