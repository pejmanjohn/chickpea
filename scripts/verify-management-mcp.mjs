#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const REQUEST_TIMEOUT_MS = 15_000;
const AGENT_AUTHORING_GUIDE_URI = 'chickpea://guide/agent-authoring/v1';
const AGENT_AUTHORING_GUIDE_VERSION = '1.0.2';
const MANAGEMENT_MCP_SERVER_VERSION = '2.1.0';

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
  for (const expected of [
    'inspect_workspace',
    'propose_workspace_changes',
    'apply_workspace_changes',
    'get_operation',
  ]) {
    if (!names.includes(expected)) throw new Error(`MCP tool inventory omitted ${expected}.`);
  }
  const resources = await mcpCall(base, token, 'resources/list', {});
  if (!(resources?.resources ?? []).some((resource) => resource?.uri === AGENT_AUTHORING_GUIDE_URI)) {
    throw new Error('MCP resource inventory omitted the Agent-authoring guide.');
  }
  const guideResult = await mcpCall(base, token, 'resources/read', {
    uri: AGENT_AUTHORING_GUIDE_URI,
  });
  const guide = JSON.parse(guideResult?.contents?.[0]?.text ?? '{}');
  requireEqual(guide.version, AGENT_AUTHORING_GUIDE_VERSION, 'Agent-authoring guide version');
  if (typeof guide.digest !== 'string' || !/^[a-f0-9]{64}$/.test(guide.digest) ||
      typeof guide.guide !== 'string' || guide.guide.length < 1 ||
      typeof guide.files?.['skill-creation.md'] !== 'string' ||
      guide.files['skill-creation.md'].length < 1) {
    throw new Error('Agent-authoring guide content or digest is invalid.');
  }
  const inspected = await mcpCall(base, token, 'tools/call', {
    name: 'inspect_workspace',
    arguments: {},
  });
  const snapshot = assertSuccessfulToolResult(inspected, 'workspace inspection');

  const canaryAgentId = `agent_canary_${Date.now().toString(36)}`;
  const proposed = await mcpCall(base, token, 'tools/call', {
    name: 'propose_workspace_changes',
    arguments: {
      idempotencyKey: `canary-${Date.now().toString(36)}`,
      guideVersion: AGENT_AUTHORING_GUIDE_VERSION,
      authoringReason: 'agent_creation',
      operations: [{
        itemId: 'canary',
        kind: 'create_agent',
        agent: {
          id: canaryAgentId,
          name: 'Unconfirmed MCP canary',
          description: 'Verifies proposal behavior without creating an Agent.',
          instructions: 'This proposal is never confirmed.',
          enabled: true,
          skills: [],
          mcpServers: [],
          apiConnections: [],
          repositories: [],
        },
      }],
    },
  });
  const proposal = assertSuccessfulToolResult(proposed, 'workspace-change proposal');
  if (proposal?.guide?.version !== AGENT_AUTHORING_GUIDE_VERSION ||
      proposal?.guide?.uri !== AGENT_AUTHORING_GUIDE_URI ||
      proposal?.guide?.digest !== guide.digest ||
      !String(proposal?.proposalId ?? '').startsWith('changeset_')) {
    throw new Error('Workspace-change proposal omitted canonical guide metadata.');
  }
  const reinspected = assertSuccessfulToolResult(await mcpCall(base, token, 'tools/call', {
    name: 'inspect_workspace',
    arguments: {},
  }), 'post-proposal workspace inspection');
  requireEqual(
    reinspected?.effectiveRevision,
    snapshot?.effectiveRevision,
    'configuration revision after unconfirmed proposal',
  );
  if ((reinspected?.agents ?? []).some((agent) => agent?.id === canaryAgentId)) {
    throw new Error('Unconfirmed proposal created an Agent.');
  }

  // A second stateless call exercises disconnect/reconnect semantics without
  // retaining a server session or printing the private workspace snapshot.
  const relisted = await mcpCall(base, token, 'tools/list', {});
  if ((relisted?.tools?.length ?? 0) !== names.length) {
    throw new Error('Stateless reconnect returned a different tool inventory.');
  }
  console.log(`ok authenticated guide, no-write proposal, and stateless reconnect (${names.length} tools)`);

  const applyPath = process.env.MANAGEMENT_MCP_CANARY_APPLY_PATH?.trim();
  if (!applyPath) return;
  if (process.env.MANAGEMENT_MCP_ALLOW_MUTATION !== '1') {
    throw new Error('Set MANAGEMENT_MCP_ALLOW_MUTATION=1 to authorize the supplied canary apply payload.');
  }
  const argumentsValue = JSON.parse(readFileSync(applyPath, 'utf8'));
  const applied = await mcpCall(base, token, 'tools/call', {
    name: 'apply_workspace_changes',
    arguments: argumentsValue,
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

function assertSuccessfulToolResult(result, label) {
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error(`${label} returned no text result.`);
  const envelope = JSON.parse(text);
  if (envelope?.ok !== true) throw new Error(`${label} returned a tool error.`);
  return envelope.result;
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
