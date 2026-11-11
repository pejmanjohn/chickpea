import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { createMcpHandler } from '@modelcontextprotocol/server';

import type { McpAuthenticatedPrincipal } from '../src/auth/mcp-oauth-routes.ts';
import { validatePublicMcpClientRegistration } from '../src/auth/mcp-oauth.ts';
import {
  createWorkspaceManagementMcpServer,
  V4_TOOL_REPLACEMENTS,
  V4_TOOLS_DEPRECATED_ON,
  WORKSPACE_MANAGEMENT_AGENT_AUTHORING_GUIDE_URI,
  WORKSPACE_MANAGEMENT_OPERATION_SCHEMA_URI,
  WORKSPACE_MANAGEMENT_MCP_TOOL_NAMES,
  WORKSPACE_MANAGEMENT_MCP_V4_TOOL_NAMES,
  WORKSPACE_MANAGEMENT_SERVER_INFO,
} from '../src/management/mcp.ts';
import {
  WORKSPACE_MANAGEMENT_INSTRUCTIONS,
  WORKSPACE_MANAGEMENT_INSTRUCTIONS_MAX_CHARACTERS,
  workspaceManagementAdminOrigin,
} from '../src/management/instructions.ts';
import {
  AGENT_AUTHORING_GUIDE_DIGEST,
  AGENT_AUTHORING_GUIDE_VERSION,
  DISCOVERY_GUIDE_URI,
} from '../src/management/agent-authoring/index.ts';
import { DISCOVERY_GUIDE } from '../src/management/agent-authoring/discovery-guide.ts';
import {
  AGENT_AUTHORING_GUIDE_MCP,
  AGENT_AUTHORING_GUIDE_MCP_DIGEST,
  AGENT_SKILL_CREATION_GUIDE_MCP,
} from '../src/management/agent-authoring/mcp-guide.ts';
import { MCP_MANAGEMENT_OPERATION_KINDS } from '../src/management/schemas.ts';
import {
  WORKSPACE_MANAGEMENT_PROMPT_NAMES,
  WORKSPACE_MANAGEMENT_PROMPTS,
  workspaceManagementPromptText,
  type WorkspaceManagementPromptArguments,
  type WorkspaceManagementPromptName,
} from '../src/management/prompts.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';
import { REAL_MCP_CLIENT_REGISTRATIONS } from './helpers/mcp-client-registrations.ts';

const DEPLOYMENT_BASE_URL = 'https://chickpea-team.example.test/';

/** Wording a coding agent must never be told; it has no Slack thread, DM, or Slack preview. */
const SLACK_ONLY_WORDING = /presentation\.slack|\bDMs?\b|Slack turn|Slack Lists|Slack conversation|requester message|current command on Slack|progress UI/;

/**
 * One invocation with only the required arguments and one with every optional
 * argument supplied, so a client that fills the whole slash-command line and a
 * client that fills none both get a rendered brief.
 */
const PROMPT_INVOCATIONS: {
  [K in WorkspaceManagementPromptName]: ReadonlyArray<WorkspaceManagementPromptArguments[K]>;
} = {
  'new-agent': [{}, { purpose: 'answer billing questions from the support channel' }],
  'edit-agent': [{ handle: 'editor' }, { handle: '@editor', change: 'keep British spelling' }],
  connect: [{ service: 'gmail' }, { service: 'Google Calendar', handle: '@notes' }],
  schedule: [{ handle: 'notes' }, { handle: '@notes', what: 'post the standup digest' }],
  'import-skill': [
    { url: 'owner/repo' },
    { url: 'https://github.com/owner/repo/tree/main/skills/changelog', handle: '@brief' },
  ],
  status: [{}],
};

const READ = { readOnlyHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true };
/** A 5.0 read states all three hints. */
const READ_5 = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

/** A 5.0 write states all four hints; a retry with its idempotencyKey replays. */
const ADDS_5 = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DESTRUCTIVE_5 = { ...ADDS_5, destructiveHint: true };

/** Only confirm_workspace_change and confirm_change carry out a change the person must approve first. */
const MCP_TOOL_ANNOTATIONS = {
  inspect_workspace: READ,
  prepare_connector_setup: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  prepare_provider_setup: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  discover_slack_channels: READ,
  test_connection: READ,
  save_connection_key: WRITE,
  try_connection: READ,
  inspect_memory: READ,
  inspect_routines: READ,
  export_workspace_recipe: READ,
  preview_workspace_recipe: READ,
  import_skill: WRITE,
  upload_skills: WRITE,
  manage_agent_skill: WRITE,
  apply_workspace_changes: WRITE,
  confirm_workspace_change: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  undo_workspace_change: WRITE,
  get_operation: READ,
  revoke_setup_link: WRITE,
  list_mcp_clients: READ,
  revoke_mcp_client: WRITE,
  get_account: READ_5,
  get_workspace: READ_5,
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
  // Card-only: a run that spends metered usage and reads the open web; its key returns the same run.
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
        };
        assert.equal(initializeResult.serverInfo.version, WORKSPACE_MANAGEMENT_SERVER_INFO.version, client.name);
        assert.equal(initializeResult.instructions, WORKSPACE_MANAGEMENT_INSTRUCTIONS, `${client.name} gets the 5.0 instructions`);
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
      assert.deepEqual(
        listedTools.map(({ name }) => name),
        WORKSPACE_MANAGEMENT_MCP_TOOL_NAMES,
        client.name,
      );
      assert.ok(
        listedTools.find(({ name }) => name === 'prepare_connector_setup')
          ?.inputSchema?.required?.includes('agentId'),
        `${client.name} must require an explicit Agent for connector setup`,
      );
      assert.deepEqual(
        Object.fromEntries(listedTools.map(({ name, annotations }) => [name, annotations])),
        MCP_TOOL_ANNOTATIONS,
        `${client.name} must disclose which tools write and which can destroy`,
      );
      for (const listedTool of listedTools.filter(({ name }) =>
        (WORKSPACE_MANAGEMENT_MCP_V4_TOOL_NAMES as readonly string[]).includes(name))) {
        assert.deepEqual(
          [listedTool.outputSchema, listedTool.securitySchemes, listedTool._meta],
          [undefined, undefined, undefined],
          `${client.name} ${listedTool.name}: a 4.x descriptor keeps its 4.x shape`,
        );
        const replacedBy: readonly string[] = V4_TOOL_REPLACEMENTS[listedTool.name as keyof typeof V4_TOOL_REPLACEMENTS];
        assert.match(listedTool.description ?? '', new RegExp(`^Deprecated ${V4_TOOLS_DEPRECATED_ON}: use [^\\n]+\\.$`), listedTool.name);
        assert.ok(replacedBy.length > 0 && replacedBy.every((name) =>
          listedTools.some((tool) => tool.name === name) && listedTool.description!.includes(name)),
        `${client.name} ${listedTool.name} names listed 5.0 replacements`);
      }
      const immediateSkillImport = listedTools.find(({ name }) => name === 'import_skill');
      for (const field of ['agentId', 'source', 'idempotencyKey', 'guideVersion']) {
        assert.ok(
          immediateSkillImport?.inputSchema?.required?.includes(field),
          `${client.name} must require immediate skill import ${field}`,
        );
      }
      const managedSkill = listedTools.find(({ name }) => name === 'manage_agent_skill');
      for (const field of ['agentId', 'action', 'skillName', 'idempotencyKey']) {
        assert.ok(
          managedSkill?.inputSchema?.required?.includes(field),
          `${client.name} must require managed skill ${field}`,
        );
      }
      assert.ok(
        listedTools.find(({ name }) => name === 'prepare_connector_setup')
          ?.inputSchema?.required?.includes('ownerKind'),
        `${client.name} must require an explicit personal or Team connection owner`,
      );
      assert.deepEqual(
        listedTools.find(({ name }) => name === 'save_connection_key')?.inputSchema?.required?.toSorted(),
        ['connectionId', 'key', 'path'],
        `${client.name} must require a read path for a key's check`,
      );
      assert.deepEqual(
        listedTools.find(({ name }) => name === 'try_connection')?.inputSchema?.required,
        ['path'],
        `${client.name} must require the path a try GETs`,
      );
      const inspected = await mcpCall(handler.fetch, client.protocol, 'tools/call', {
        name: 'inspect_workspace',
        arguments: {},
      });
      const inspectedResult = JSON.parse((inspected.result as {
        content: Array<{ text: string }>;
      }).content[0]!.text);
      assert.equal(inspectedResult.ok, true, client.name);
      assert.ok(
        inspectedResult.result.connectors.some((connector: { id: string }) => connector.id === 'gmail'),
        `${client.name} should discover the connector catalog`,
      );

      const connectorHandoff = await mcpCall(handler.fetch, client.protocol, 'tools/call', {
        name: 'prepare_connector_setup',
        arguments: { agentId: agent.id, connector: 'Gmail', ownerKind: 'member' },
      });
      const connectorResult = JSON.parse((connectorHandoff.result as {
        content: Array<{ text: string }>;
      }).content[0]!.text) as { ok: boolean; result: { handoffUrl: string; setupOperationId: string } };
      assert.equal(connectorResult.ok, true, client.name);
      assert.equal(
        new URL(connectorResult.result.handoffUrl).pathname,
        `/setup/${connectorResult.result.setupOperationId}`,
        `${client.name} gets the one-connection setup page, not Admin`,
      );

      const missingAgent = await mcpCall(handler.fetch, client.protocol, 'tools/call', {
        name: 'prepare_connector_setup',
        arguments: { connector: 'Gmail', ownerKind: 'member' },
      });
      assert.equal((missingAgent.result as { isError?: boolean }).isError, true, client.name);

      const missingPath = await mcpCall(handler.fetch, client.protocol, 'tools/call', {
        name: 'save_connection_key',
        arguments: { agentId: agent.id, connectionId: 'statusboard', key: 'synthetic-key' },
      });
      const pathRefusal = missingPath.result as { isError?: boolean; content: Array<{ text: string }> };
      assert.equal(pathRefusal.isError, true, client.name);
      assert.match(pathRefusal.content[0]!.text, /^Input validation error: .*\bpath\b/, client.name);
      assert.doesNotMatch(JSON.stringify(missingPath), /synthetic-key/, `${client.name} must not echo the key`);

      const operationSchema = await mcpCall(handler.fetch, client.protocol, 'resources/read', {
        uri: WORKSPACE_MANAGEMENT_OPERATION_SCHEMA_URI,
      });
      const resource = (operationSchema.result as {
        contents: Array<{ uri: string; text: string }>;
      }).contents[0]!;
      assert.equal(resource.uri, WORKSPACE_MANAGEMENT_OPERATION_SCHEMA_URI);
      const contract = JSON.parse(resource.text) as {
        schemaVersion: number;
        tools: string[];
        operationKinds: string[];
        prompts: string[];
        deprecated: Record<string, { since: string; replacedBy: string[] }>;
      };
      assert.equal(contract.schemaVersion, 2);
      assert.deepEqual(Object.keys(contract.deprecated), [...WORKSPACE_MANAGEMENT_MCP_V4_TOOL_NAMES], client.name);
      assert.deepEqual(contract.deprecated.revoke_mcp_client, { since: V4_TOOLS_DEPRECATED_ON, replacedBy: ['disconnect_app'] });
      assert.deepEqual(contract.tools, WORKSPACE_MANAGEMENT_MCP_TOOL_NAMES, client.name);
      assert.deepEqual(contract.operationKinds, MCP_MANAGEMENT_OPERATION_KINDS);
      assert.deepEqual(contract.prompts, WORKSPACE_MANAGEMENT_PROMPT_NAMES, client.name);

      const promptList = await mcpCall(handler.fetch, client.protocol, 'prompts/list', {});
      const listedPrompts = (promptList.result as {
        prompts: Array<{
          name: string;
          title?: string;
          description?: string;
          arguments?: Array<{ name: string; description?: string; required?: boolean }>;
        }>;
      }).prompts;
      assert.deepEqual(
        listedPrompts.map(({ name }) => name),
        WORKSPACE_MANAGEMENT_PROMPT_NAMES,
        `${client.name} must advertise every workspace prompt in order`,
      );
      for (const prompt of listedPrompts) {
        const definition = WORKSPACE_MANAGEMENT_PROMPTS[prompt.name as WorkspaceManagementPromptName];
        assert.equal(prompt.title, definition.title, `${client.name} ${prompt.name} title`);
        assert.equal(prompt.description, definition.description, `${client.name} ${prompt.name} description`);
        assert.ok((prompt.title ?? '').length > 0 && (prompt.description ?? '').length > 0, prompt.name);
        assert.deepEqual(
          (prompt.arguments ?? []).map(({ name, description, required }) => ({
            name,
            description,
            required: required === true,
          })),
          definition.arguments.map(({ name, description, required }) => ({ name, description, required })),
          `${client.name} ${prompt.name} arguments`,
        );
        for (const { name } of prompt.arguments ?? []) {
          // Claude Code splits a slash command's arguments on whitespace, so each name is one token.
          assert.match(name, /^[a-z]+$/, `${client.name} ${prompt.name} argument ${name}`);
        }
      }

      for (const name of WORKSPACE_MANAGEMENT_PROMPT_NAMES) {
        for (const args of PROMPT_INVOCATIONS[name]) {
          const got = await mcpCall(handler.fetch, client.protocol, 'prompts/get', {
            name,
            arguments: args,
          });
          const messages = (got.result as {
            messages: Array<{ role: string; content: { type: string; text: string } }>;
          }).messages;
          assert.equal(messages.length, 1, `${client.name} ${name} must return one message`);
          assert.equal(messages[0]!.role, 'user', `${client.name} ${name} role`);
          assert.equal(messages[0]!.content.type, 'text', `${client.name} ${name} content type`);
          const text = messages[0]!.content.text;
          assert.equal(
            text,
            workspaceManagementPromptText(name, args, DEPLOYMENT_BASE_URL),
            `${client.name} ${name} must serve the rendered brief`,
          );
          assert.ok(
            text.includes(`${new URL(DEPLOYMENT_BASE_URL).origin}/admin`),
            `${client.name} ${name} must link the real Admin origin`,
          );
          assert.doesNotMatch(text, SLACK_ONLY_WORDING, `${client.name} ${name}`);
        }
      }

      const missingArgument = await mcpCall(handler.fetch, client.protocol, 'prompts/get', {
        name: 'edit-agent',
        arguments: {},
      });
      assert.equal(
        (missingArgument.error as { code?: number } | undefined)?.code,
        -32602,
        `${client.name} must reject a prompt missing a required argument`,
      );
      assert.equal(missingArgument.result, undefined, client.name);

      const resources = await mcpCall(handler.fetch, client.protocol, 'resources/list', {});
      assert.ok((resources.result as { resources: Array<{ uri: string }> }).resources.some(
        ({ uri }) => uri === WORKSPACE_MANAGEMENT_AGENT_AUTHORING_GUIDE_URI,
      ));
      const guideResult = await mcpCall(handler.fetch, client.protocol, 'resources/read', {
        uri: WORKSPACE_MANAGEMENT_AGENT_AUTHORING_GUIDE_URI,
      });
      const guide = JSON.parse((guideResult.result as {
        contents: Array<{ text: string }>;
      }).contents[0]!.text) as {
        version: string;
        digest: string;
        guide: string;
        files: Record<string, string>;
      };
      assert.deepEqual(guide, {
        version: AGENT_AUTHORING_GUIDE_VERSION,
        digest: AGENT_AUTHORING_GUIDE_DIGEST,
        variant: 'coding-agent',
        variantDigest: AGENT_AUTHORING_GUIDE_MCP_DIGEST,
        guide: AGENT_AUTHORING_GUIDE_MCP,
        files: { 'skill-creation.md': AGENT_SKILL_CREATION_GUIDE_MCP },
      });
      assert.doesNotMatch(guide.guide.slice(guide.guide.indexOf('# Chickpea Agent authoring')), /presentation\.slack/);
      assert.ok((resources.result as { resources: Array<{ uri: string }> }).resources.some(
        ({ uri }) => uri === DISCOVERY_GUIDE_URI,
      ), `${client.name} must list the discovery guide`);
      const discovery = await mcpCall(handler.fetch, client.protocol, 'resources/read', { uri: DISCOVERY_GUIDE_URI });
      assert.deepEqual((discovery.result as { contents: unknown[] }).contents, [
        { uri: DISCOVERY_GUIDE_URI, mimeType: 'text/markdown', text: DISCOVERY_GUIDE },
      ], `${client.name} must read the discovery guide`);
      const listedDescriptions = listedTools.map(({ name, description }) => `${name}: ${description ?? ''}`);
      for (const line of listedDescriptions) {
        if (line.startsWith('discover_slack_channels:')) continue;
        assert.doesNotMatch(line, /presentation\.slack|\bDM\b|Slack turn|Slack Lists|Slack conversation|requester message/, `${client.name} ${line.slice(0, 40)}`);
      }

      const before = await f.config.getAgent(agent.id);
      const applied = await mcpCall(handler.fetch, client.protocol, 'tools/call', {
        name: 'apply_workspace_changes',
        arguments: {
          idempotencyKey: `client-${client.name}`,
          operations: [{
            itemId: 'description',
            kind: 'update_agent',
            agentId: agent.id,
            expectedRevision: before.revision,
            patch: { description: `Edited by ${client.name}.` },
          }],
        },
      });
      const appliedResult = JSON.parse((applied.result as {
        content: Array<{ text: string }>;
      }).content[0]!.text) as { ok: boolean; result: { status: string } };
      assert.equal(appliedResult.ok, true, client.name);
      assert.equal(appliedResult.result.status, 'completed', client.name);
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
  for (const name of WORKSPACE_MANAGEMENT_MCP_V4_TOOL_NAMES) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(text), `instructions must not name the deprecated ${name}`);
  }
  assert.doesNotMatch(text, SLACK_ONLY_WORDING);

  assert.equal(workspaceManagementAdminOrigin(undefined), undefined);
  assert.equal(workspaceManagementAdminOrigin('not a url'), undefined);
  assert.equal(workspaceManagementAdminOrigin('ftp://chickpea.example.test'), undefined);
  assert.equal(workspaceManagementAdminOrigin('https://chickpea.example.test/setup/abc?x=1#y'), 'https://chickpea.example.test');
  assert.equal(workspaceManagementAdminOrigin('http://localhost:8787/'), 'http://localhost:8787');
});

test('workspace management MCP publishes the version 4 server contract', () => {
  assert.deepEqual(WORKSPACE_MANAGEMENT_SERVER_INFO, {
    name: 'chickpea-workspace',
    version: '4.5.0',
  });
  assert.match(WORKSPACE_MANAGEMENT_OPERATION_SCHEMA_URI, /\/v2$/);
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
  assert.deepEqual([...inventory.matchAll(/'([a-z_]+)'/g)].map(([, name]) => name), WORKSPACE_MANAGEMENT_MCP_TOOL_NAMES);
});

test('management and evaluation runbooks track the additive authoring contract', async () => {
  const [management, evaluation, readme] = await Promise.all([
    readFile(new URL('../docs/runbooks/workspace-management-mcp.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/runbooks/agent-authoring-evaluation.md', import.meta.url), 'utf8'),
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
  ]);
  for (const value of [
    WORKSPACE_MANAGEMENT_SERVER_INFO.version,
    WORKSPACE_MANAGEMENT_AGENT_AUTHORING_GUIDE_URI,
    'propose_workspace_changes',
    'confirm_workspace_change',
  ]) assert.match(management, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(management, /contract version `2\.0\.0`/);
  assert.match(management, /\/mcp__chickpea__new-agent/);
  assert.match(management, /prompts\/list/);
  assert.match(evaluation, /no-guide-v1/);
  assert.match(evaluation, /npm run evaluate:agent-authoring:live/);
  assert.match(evaluation, /must not be committed/i);
  assert.match(readme, new RegExp(WORKSPACE_MANAGEMENT_AGENT_AUTHORING_GUIDE_URI));
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
