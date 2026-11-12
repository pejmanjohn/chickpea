#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const REQUEST_TIMEOUT_MS = 15_000;
const DISCOVERY_GUIDE_URI = 'chickpea://guide/discovery/v1';
const MANAGEMENT_MCP_SERVER_VERSION = '5.0.0';
/** Contract 5.0.0 removed these resources; each answers with what replaced it. */
const REMOVED_RESOURCE_URIS = [
  'chickpea://schema/operations/v2',
  'chickpea://guide/agent-authoring/v1',
  'chickpea://workspace',
];
const MANAGEMENT_MCP_TOOL_NAMES = [
  'get_account',
  'get_workspace',
  'get_guide',
  'list_agents',
  'get_agent',
  'list_services',
  'get_service',
  'list_models',
  'list_members',
  'list_slack_channels',
  'get_agent_memory',
  'list_schedules',
  'get_setup_status',
  'export_agents',
  'list_connected_apps',
  'list_agent_runs',
  'get_agent_run',
  'propose_agent',
  'propose_agent_change',
  'get_creation_status',
  'practice_agent',
  'get_practice_run',
  'list_practice_runs',
  'explain_agent',
  'check_agent',
  'create_agent',
  'update_agent',
  'update_agent_memory',
  'archive_agent',
  'restore_agent',
  'delete_agent',
  'add_agent_to_channel',
  'remove_agent_from_channel',
  'save_channel_settings',
  'import_skill_from_github',
  'upload_skill_files',
  'set_agent_skill',
  'connect_service',
  'reconnect_service',
  'update_connection',
  'remove_connection',
  'remove_website_login',
  'set_agent_repositories',
  'save_schedule',
  'pause_schedule',
  'resume_schedule',
  'run_schedule_now',
  'take_over_schedule',
  'delete_schedule',
  'set_workspace_model',
  'connect_model_provider',
  'remove_model_provider_key',
  'update_member',
  'cancel_setup_link',
  'disconnect_app',
  'confirm_change',
  'decline_change',
  'get_confirmation',
  'undo_change',
];

function fetchWithDeadline(input, init = {}) {
  return fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

const rawBase = process.env.MANAGEMENT_MCP_BASE_URL?.trim();
if (!rawBase) {
  console.error('Set MANAGEMENT_MCP_BASE_URL to a disposable Chickpea deployment.');
  process.exitCode = 2;
} else {
  await main(rawBase);
}

async function main(rawBaseUrl) {
  const base = new URL(rawBaseUrl);
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(base.hostname)) {
    throw new Error('MANAGEMENT_MCP_BASE_URL must use HTTPS or loopback HTTP.');
  }
  base.pathname = '/';
  base.search = '';
  base.hash = '';

  const resourceUrl = new URL('/.well-known/oauth-protected-resource/mcp', base);
  const resourceResponse = await fetchWithDeadline(resourceUrl, { redirect: 'error' });
  requireStatus(resourceResponse, 200, 'protected-resource discovery');
  const resource = await resourceResponse.json();
  requireEqual(resource.resource, new URL('/mcp', base).href, 'protected resource');
  if (!Array.isArray(resource.authorization_servers) || resource.authorization_servers.length !== 1) {
    throw new Error('Authorization-server metadata is not exact.');
  }

  const authorizationUrl = new URL('/.well-known/oauth-authorization-server/api/auth', base);
  const authorizationResponse = await fetchWithDeadline(authorizationUrl, { redirect: 'error' });
  requireStatus(authorizationResponse, 200, 'authorization-server discovery');
  const authorization = await authorizationResponse.json();
  requireEqual(authorization.registration_endpoint, new URL('/api/auth/oauth2/register', base).href, 'DCR endpoint');
  requireEqual(authorization.token_endpoint, new URL('/api/auth/oauth2/token', base).href, 'token endpoint');

  const challenge = await fetchWithDeadline(new URL('/mcp', base), {
    method: 'POST',
    redirect: 'error',
    headers: mcpHeaders('tools/list', {}),
    body: rpcBody('tools/list', {}),
  });
  requireStatus(challenge, 401, 'unauthenticated MCP challenge');
  if (!(challenge.headers.get('www-authenticate') ?? '').includes('resource_metadata=')) {
    throw new Error('MCP challenge omitted protected-resource metadata.');
  }
  console.log('ok discovery and unauthenticated challenge');

  const token = process.env.MANAGEMENT_MCP_BEARER_TOKEN?.trim();
  if (!token) {
    console.log('skip authenticated checks: MANAGEMENT_MCP_BEARER_TOKEN is unset');
    return;
  }

  if (protocolVersion() !== '2026-07-28') {
    const initialized = await mcpCall(base, token, 'initialize', {
      protocolVersion: protocolVersion(),
      capabilities: {},
      clientInfo: { name: 'chickpea-management-canary', version: '1.0.0' },
    });
    requireEqual(
      initialized?.serverInfo?.version,
      MANAGEMENT_MCP_SERVER_VERSION,
      'workspace-management MCP server version',
    );
  }
  const listed = await mcpCall(base, token, 'tools/list', {});
  const names = listed?.tools?.map?.((tool) => tool?.name).filter(Boolean) ?? [];
  requireEqual(names.join(','), MANAGEMENT_MCP_TOOL_NAMES.join(','), 'MCP tool inventory');
  const resources = (await mcpCall(base, token, 'resources/list', {}))?.resources ?? [];
  if (!resources.some((resource) => resource?.uri === DISCOVERY_GUIDE_URI)) {
    throw new Error('MCP resource inventory omitted the discovery guide.');
  }
  if (resources.some((resource) => REMOVED_RESOURCE_URIS.includes(resource?.uri))) {
    throw new Error('MCP resource inventory still lists a resource 5.0.0 removed.');
  }
  const discovery = await mcpCall(base, token, 'resources/read', { uri: DISCOVERY_GUIDE_URI });
  if (typeof discovery?.contents?.[0]?.text !== 'string' || discovery.contents[0].text.length < 1) {
    throw new Error('The discovery guide is empty.');
  }
  // Two reads of a workspace nobody changes answer the same, and write nothing.
  for (const tool of ['get_workspace', 'list_agents']) {
    const first = assertSuccessfulToolResult(await mcpCall(base, token, 'tools/call', { name: tool, arguments: {} }), tool);
    const again = assertSuccessfulToolResult(await mcpCall(base, token, 'tools/call', { name: tool, arguments: {} }), `repeat ${tool}`);
    requireEqual(JSON.stringify(again), JSON.stringify(first), `${tool} across read-only verification`);
  }
  // A removed 4.x tool answers with its replacement, as a result its client hands to its model.
  const removed = await mcpCall(base, token, 'tools/call', { name: 'inspect_workspace', arguments: {} });
  const answer = removed?.structuredContent;
  if (removed?.isError !== true || answer?.ok !== false || answer?.error?.code !== 'tool_removed' ||
      !Array.isArray(answer.error.replacedBy) || !answer.error.replacedBy.includes('get_workspace')) {
    throw new Error('A removed 4.x tool did not answer tool_removed with its replacement.');
  }

  // A second stateless call exercises disconnect/reconnect semantics without
  // retaining a server session or printing the private workspace snapshot.
  const relisted = await mcpCall(base, token, 'tools/list', {});
  if ((relisted?.tools?.length ?? 0) !== names.length) {
    throw new Error('Stateless reconnect returned a different tool inventory.');
  }
  console.log(`ok authenticated discovery guide, repeated reads, removal answer, and stateless reconnect (${names.length} tools)`);

  const applyPath = process.env.MANAGEMENT_MCP_CANARY_APPLY_PATH?.trim();
  if (!applyPath) return;
  if (process.env.MANAGEMENT_MCP_ALLOW_MUTATION !== '1') {
    throw new Error('Set MANAGEMENT_MCP_ALLOW_MUTATION=1 to authorize the supplied canary apply payload.');
  }
  // A JSON file: { "tool": "<a 5.0 write tool>", "arguments": { ... } }.
  const canary = JSON.parse(readFileSync(applyPath, 'utf8'));
  if (typeof canary?.tool !== 'string' || !MANAGEMENT_MCP_TOOL_NAMES.includes(canary.tool)) {
    throw new Error('The canary payload must name a tool this server lists.');
  }
  const applied = await mcpCall(base, token, 'tools/call', {
    name: canary.tool,
    arguments: canary.arguments ?? {},
  });
  assertSuccessfulToolResult(applied, 'authorized canary mutation');
  console.log('ok authorized canary mutation (response body intentionally suppressed)');
}

async function mcpCall(base, token, method, params) {
  const response = await fetchWithDeadline(new URL('/mcp', base), {
    method: 'POST',
    redirect: 'error',
    headers: { ...mcpHeaders(method, params), authorization: `Bearer ${token}` },
    body: rpcBody(method, params),
  });
  requireStatus(response, 200, `MCP ${method}`);
  const body = await response.text();
  if (body.trimStart().startsWith('{')) {
    const envelope = JSON.parse(body);
    if (envelope.error) throw new Error(`MCP ${method} returned a protocol error.`);
    return envelope.result;
  }
  const event = body.split('\n').find((line) => line.startsWith('data: '));
  if (!event) throw new Error(`MCP ${method} returned no SSE data event.`);
  const envelope = JSON.parse(event.slice('data: '.length));
  if (envelope.error) throw new Error(`MCP ${method} returned a protocol error.`);
  return envelope.result;
}

/** A 5.0 result's structured content; an error result names only its code. */
function assertSuccessfulToolResult(result, label) {
  const structured = result?.structuredContent;
  if (result?.isError === true) {
    throw new Error(`${label} returned a tool error${typeof structured?.error?.code === 'string' ? ` (${structured.error.code})` : ''}.`);
  }
  if (!structured || typeof structured !== 'object') throw new Error(`${label} returned no structured result.`);
  return structured;
}

function mcpHeaders(method, params) {
  const protocol = protocolVersion();
  return {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-protocol-version': protocol,
    ...(protocol === '2026-07-28' ? { 'mcp-method': method } : {}),
    ...(protocol === '2026-07-28' && method === 'tools/call' && typeof params.name === 'string'
      ? { 'mcp-name': params.name }
      : {}),
    ...(protocol === '2026-07-28' && method === 'resources/read' && typeof params.uri === 'string'
      ? { 'mcp-name': params.uri }
      : {}),
  };
}

function rpcBody(method, params) {
  const protocol = protocolVersion();
  const bodyParams = protocol === '2026-07-28' ? {
    ...params,
    _meta: {
      'io.modelcontextprotocol/protocolVersion': protocol,
      'io.modelcontextprotocol/clientCapabilities': {},
    },
  } : params;
  return JSON.stringify({ jsonrpc: '2.0', id: `${method}:canary`, method, params: bodyParams });
}

function protocolVersion() {
  return process.env.MANAGEMENT_MCP_PROTOCOL_VERSION ?? '2025-11-25';
}

function requireStatus(response, expected, label) {
  if (response.status !== expected) {
    throw new Error(`${label} returned HTTP ${response.status}; expected ${expected}.`);
  }
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} did not match the deployment origin.`);
}
