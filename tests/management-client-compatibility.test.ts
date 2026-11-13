import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { createMcpHandler } from '@modelcontextprotocol/server';

import type { McpAuthenticatedPrincipal } from '../src/auth/mcp-oauth-routes.ts';
import { validatePublicMcpClientRegistration } from '../src/auth/mcp-oauth.ts';
import {
  createWorkspaceManagementMcpServer,
  WORKSPACE_MANAGEMENT_SERVER_INFO,
} from '../src/management/mcp.ts';
import {
  WORKSPACE_MANAGEMENT_INSTRUCTIONS,
  WORKSPACE_MANAGEMENT_INSTRUCTIONS_MAX_CHARACTERS,
} from '../src/management/instructions.ts';
import { AGENT_AUTHORING_GUIDE_URI, DISCOVERY_GUIDE_URI } from '../src/management/agent-authoring/index.ts';
import { playbookSection } from '../src/management/playbook/index.ts';
import { REMOVED_TOOL_NAMES } from '../src/management/mcp-v5/removed-v4.ts';
import { FIVE_ZERO_TOOL_NAMES } from '../src/management/mcp-v5/tools.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';
import { REAL_MCP_CLIENT_REGISTRATIONS } from './helpers/mcp-client-registrations.ts';

const DEPLOYMENT_BASE_URL = 'https://chickpea-team.example.test/';

/** Wording a coding agent must never be told; it has no Slack thread, DM, or Slack preview. */
const SLACK_ONLY_WORDING = /presentation\.slack|\bDMs?\b|Slack turn|Slack Lists|Slack conversation|requester message|current command on Slack|progress UI/;

/** A 5.0 read states all three hints. */
const READ_5 = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

/** A 5.0 write states all four hints; a retry with its idempotencyKey replays. */
const ADDS_5 = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DESTRUCTIVE_5 = { ...ADDS_5, destructiveHint: true };

const MCP_TOOL_ANNOTATIONS = {
  get_account: READ_5,
  get_workspace: READ_5,
  get_guide: READ_5,
  list_agents: READ_5,
  get_agent: READ_5,
  list_services: READ_5,
  get_service: READ_5,
  list_models: READ_5,
  list_members: READ_5,
  list_slack_channels: READ_5,
  get_agent_memory: READ_5,
  list_schedules: READ_5,
  get_setup_status: READ_5,
  export_agents: READ_5,
  list_connected_apps: READ_5,
  list_agent_runs: READ_5,
  get_agent_run: READ_5,
  propose_agent: READ_5,
  propose_agent_change: READ_5,
  get_creation_status: READ_5,
  // A run that spends metered usage and reads the open web; its key returns the same run.
  practice_agent: { ...DESTRUCTIVE_5, openWorldHint: true },
  get_practice_run: READ_5,
  list_practice_runs: READ_5,
  show_test_report: READ_5,
  explain_agent: READ_5,
  check_agent: { ...READ_5, openWorldHint: true },
  // 5.0 writes: OpenAI's rule, so an overwrite, removal or irreversible send is destructive,
  // such as the welcome create_agent and add_agent_to_channel post in a public Channel.
  create_agent: DESTRUCTIVE_5,
  update_agent: DESTRUCTIVE_5,
  update_agent_memory: DESTRUCTIVE_5,
  archive_agent: DESTRUCTIVE_5,
  restore_agent: ADDS_5,
  add_agent_to_channel: DESTRUCTIVE_5,
  save_channel_settings: DESTRUCTIVE_5,
  import_skill_from_github: { ...DESTRUCTIVE_5, openWorldHint: true },
  upload_skill_files: DESTRUCTIVE_5,
  set_agent_skill: DESTRUCTIVE_5,
  save_schedule: DESTRUCTIVE_5,
  pause_schedule: DESTRUCTIVE_5,
  resume_schedule: ADDS_5,
  run_schedule_now: { ...DESTRUCTIVE_5, openWorldHint: true },
  take_over_schedule: DESTRUCTIVE_5,
  set_workspace_model: DESTRUCTIVE_5,
  connect_model_provider: { ...DESTRUCTIVE_5, idempotentHint: false },
  confirm_change: DESTRUCTIVE_5,
  // A card's Keep: it retires a pending confirmation and changes nothing the person has.
  decline_change: ADDS_5,
  get_confirmation: READ_5,
  undo_change: DESTRUCTIVE_5,
  // 4.5: a link that adds a connection is additive, but adding an open MCP server asks it for
  // its tools, and each call makes a new link. Everything else replaces, removes or revokes.
  connect_service: { ...ADDS_5, openWorldHint: true, idempotentHint: false },
  reconnect_service: { ...DESTRUCTIVE_5, idempotentHint: false },
  update_connection: { ...DESTRUCTIVE_5, openWorldHint: true },
  remove_connection: DESTRUCTIVE_5,
  set_agent_repositories: DESTRUCTIVE_5,
  delete_agent: DESTRUCTIVE_5,
  remove_website_login: DESTRUCTIVE_5,
  remove_agent_from_channel: DESTRUCTIVE_5,
  delete_schedule: DESTRUCTIVE_5,
  remove_model_provider_key: DESTRUCTIVE_5,
  update_member: DESTRUCTIVE_5,
  cancel_setup_link: DESTRUCTIVE_5,
  disconnect_app: DESTRUCTIVE_5,
};

const CLIENTS = [
  { name: 'Codex CLI/Desktop', protocol: '2025-11-25', registration: REAL_MCP_CLIENT_REGISTRATIONS['Codex CLI'] },
  { name: 'Claude Code', protocol: '2025-11-25', registration: REAL_MCP_CLIENT_REGISTRATIONS['Claude Code'] },
  { name: 'MCP Inspector', protocol: '2026-07-28', registration: REAL_MCP_CLIENT_REGISTRATIONS['MCP Inspector'] },
] as const;

test('supported coding clients share public PKCE registration and stateless MCP discovery', async () => {
  const f = await createManagementAdapterFixture('client-matrix');
  try {
    const principal: McpAuthenticatedPrincipal = {
      betterAuthUserId: f.admin.binding.betterAuthUserId!,
      userId: f.admin.user.id,
      membershipId: f.admin.membership.id,
      organizationId: f.admin.membership.organizationId,
      role: 'admin',
      clientId: 'client_compatibility',
    };
    const agent = await f.config.createAgent({
      id: 'agent_mcp_connector',
      name: 'MCP Connector Agent',
      creatorMembershipId: f.admin.membership.id,
      editPolicy: 'creator_and_admins',
      lifecycle: 'active',
      configurationGeneration: 1,
      instructions: 'Use configured connectors.',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    const handler = createMcpHandler(
      () => createWorkspaceManagementMcpServer({
        principal,
        service: f.service,
        baseUrl: DEPLOYMENT_BASE_URL,
      }),
      { legacy: 'stateless' },
    );

    for (const client of CLIENTS) {
      assert.equal(validatePublicMcpClientRegistration(client.registration).ok, true, client.name);

      if (client.protocol !== '2026-07-28') {
        const initialized = await mcpCall(handler.fetch, client.protocol, 'initialize', {
          protocolVersion: client.protocol,
          capabilities: {},
          clientInfo: { name: client.name, version: '1.0.0' },
        });
        const initializeResult = initialized.result as {
          serverInfo: { version: string };
          instructions?: string;
          capabilities: Record<string, unknown>;
        };
        assert.equal(initializeResult.serverInfo.version, WORKSPACE_MANAGEMENT_SERVER_INFO.version, client.name);
        assert.equal(initializeResult.instructions, WORKSPACE_MANAGEMENT_INSTRUCTIONS, `${client.name} gets the 5.0 instructions`);
        assert.deepEqual(initializeResult.capabilities.prompts, { listChanged: true }, `${client.name} is offered an empty prompt list`);
      }

      const listed = await mcpCall(handler.fetch, client.protocol, 'tools/list', {});
      const listedTools = (listed.result as {
        tools: Array<{
          name: string;
          description?: string;
          inputSchema?: { required?: string[] };
          outputSchema?: unknown;
          annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean };
          securitySchemes?: unknown;
          _meta?: unknown;
        }>;
      }).tools;
      assert.deepEqual(listedTools.map(({ name }) => name), FIVE_ZERO_TOOL_NAMES, `${client.name} lists the 5.0 tools only`);
      assert.deepEqual(
        Object.fromEntries(listedTools.map(({ name, annotations }) => [name, annotations])),
        MCP_TOOL_ANNOTATIONS,
        `${client.name} must disclose which tools write and which can destroy`,
      );
      for (const { name, outputSchema, securitySchemes } of listedTools) {
        assert.ok(outputSchema !== undefined && securitySchemes !== undefined, `${client.name} ${name} is a 5.0 descriptor`);
      }
      const listedDescriptions = listedTools.map(({ name, description }) => `${name}: ${description ?? ''}`);
      for (const line of listedDescriptions) {
        assert.doesNotMatch(line, /presentation\.slack|\bDM\b|Slack turn|Slack Lists|Slack conversation|requester message/, `${client.name} ${line.slice(0, 40)}`);
      }

      const workspace = await mcpCall(handler.fetch, client.protocol, 'tools/call', { name: 'get_workspace', arguments: {} });
      const workspaceResult = workspace.result as { isError?: boolean; structuredContent: { you: { role: string } } };
      assert.notEqual(workspaceResult.isError, true, client.name);
      assert.equal(workspaceResult.structuredContent.you.role, 'admin', client.name);

      const resources = await mcpCall(handler.fetch, client.protocol, 'resources/list', {});
      assert.deepEqual(
        (resources.result as { resources: Array<{ uri: string }> }).resources
          .map(({ uri }) => uri).filter((uri) => !uri.startsWith('ui://chickpea/')),
        [DISCOVERY_GUIDE_URI],
        `${client.name} lists the discovery guide beside the card templates`,
      );
      const discovery = await mcpCall(handler.fetch, client.protocol, 'resources/read', { uri: DISCOVERY_GUIDE_URI });
      assert.deepEqual((discovery.result as { contents: unknown[] }).contents, [
        { uri: DISCOVERY_GUIDE_URI, mimeType: 'text/markdown', text: playbookSection('research').guide },
      ], `${client.name} must read the discovery guide, the playbook's research section`);

      const read = await mcpCall(handler.fetch, client.protocol, 'tools/call', { name: 'get_agent', arguments: { agentId: agent.id } });
      const { version } = (read.result as { structuredContent: { version: string } }).structuredContent;
      const updated = await mcpCall(handler.fetch, client.protocol, 'tools/call', {
        name: 'update_agent',
        arguments: { agentId: agent.id, version, description: `Edited by ${client.name}.`, idempotencyKey: `client-${client.name}` },
      });
      const updatedResult = updated.result as { isError?: boolean; structuredContent: { status: string } };
      assert.equal(updatedResult.isError, undefined, JSON.stringify(updated));
      assert.equal(updatedResult.structuredContent.status, 'done', client.name);
      assert.equal((await f.config.getAgent(agent.id)).description, `Edited by ${client.name}.`);
    }
  } finally {
    f.close();
  }
});

test('server instructions are the 5.0 text: short, linkless, and naming only 5.0 tools', () => {
  const text = WORKSPACE_MANAGEMENT_INSTRUCTIONS;
  assert.ok(text.length <= WORKSPACE_MANAGEMENT_INSTRUCTIONS_MAX_CHARACTERS, `${text.length} characters`);
  for (const required of ['Agents', 'Slack', 'get_agent', 'propose_agent, then create_agent once the person agrees', 'connect_service', 'needs_confirmation', 'confirm_change', 'links']) {
    assert.ok(text.includes(required), `instructions must mention ${required}`);
  }
  assert.ok(!/https?:|\/admin|chickpea:\/\//.test(text), 'no link, Admin path or resource URI');
  for (const name of REMOVED_TOOL_NAMES) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(text), `instructions must not name the removed ${name}`);
  }
  assert.doesNotMatch(text, SLACK_ONLY_WORDING);
});

test('workspace management MCP publishes the version 5 server contract', () => {
  assert.deepEqual(WORKSPACE_MANAGEMENT_SERVER_INFO, {
    name: 'chickpea-workspace',
    version: '5.2.0',
  });
});

test('the deployed MCP verifier pins this server version and tool inventory', async () => {
  const verifier = await readFile(new URL('../scripts/verify-management-mcp.mjs', import.meta.url), 'utf8');
  assert.ok(verifier.includes(
    `const MANAGEMENT_MCP_SERVER_VERSION = '${WORKSPACE_MANAGEMENT_SERVER_INFO.version}';`,
  ));
  const inventory = verifier.slice(
    verifier.indexOf('const MANAGEMENT_MCP_TOOL_NAMES = ['),
    verifier.indexOf('];', verifier.indexOf('const MANAGEMENT_MCP_TOOL_NAMES = [')),
  );
  assert.deepEqual([...inventory.matchAll(/'([a-z_]+)'/g)].map(([, name]) => name), FIVE_ZERO_TOOL_NAMES);
});

test('management and evaluation runbooks track the additive authoring contract', async () => {
  const [management, evaluation, readme] = await Promise.all([
    readFile(new URL('../docs/runbooks/workspace-management-mcp.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/runbooks/agent-authoring-evaluation.md', import.meta.url), 'utf8'),
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
  ]);
  for (const value of [
    `contract version \`${WORKSPACE_MANAGEMENT_SERVER_INFO.version}\``,
    AGENT_AUTHORING_GUIDE_URI,
    'propose_workspace_changes',
    'tool_removed',
    'replacedBy',
  ]) assert.match(management, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(management, /contract version `[234]\.\d+\.\d+`/);
  assert.match(management, /5\.0\.0 removed the six MCP prompts/);
  assert.match(management, /prompts\/list/);
  assert.match(evaluation, /no-guide-v1/);
  assert.match(evaluation, /npm run evaluate:agent-authoring:live/);
  assert.match(evaluation, /must not be committed/i);
  assert.match(readme, /The `get_guide` tool serves the guidance a client follows/);
});

async function mcpCall(
  fetch: (request: Request) => Promise<Response>,
  protocol: string,
  method: string,
  params: Record<string, unknown>,
): Promise<{ result?: unknown; error?: unknown }> {
  const response = await fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': protocol,
      ...(protocol === '2026-07-28' ? { 'mcp-method': method } : {}),
      ...(protocol === '2026-07-28'
        && (method === 'tools/call' || method === 'prompts/get')
        && typeof params.name === 'string'
        ? { 'mcp-name': params.name }
        : {}),
      ...(protocol === '2026-07-28' && method === 'resources/read' && typeof params.uri === 'string'
        ? { 'mcp-name': params.uri }
        : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `${protocol}:${method}`,
      method,
      params: protocol === '2026-07-28' ? {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': protocol,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      } : params,
    }),
  }));
  const body = await response.text();
  assert.equal(response.status, 200, body);
  if (body.trimStart().startsWith('{')) return JSON.parse(body);
  const data = body.split('\n').find((line) => line.startsWith('data: '));
  assert.ok(data, 'MCP response did not contain a JSON or SSE data result.');
  return JSON.parse(data.slice('data: '.length));
}
