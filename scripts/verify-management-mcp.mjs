#!/usr/bin/env node
import { readFileSync } from 'node:fs';

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
  const resourceResponse = await fetch(resourceUrl, { redirect: 'error' });
  requireStatus(resourceResponse, 200, 'protected-resource discovery');
  const resource = await resourceResponse.json();
  requireEqual(resource.resource, new URL('/mcp', base).href, 'protected resource');
  if (!Array.isArray(resource.authorization_servers) || resource.authorization_servers.length !== 1) {
    throw new Error('Authorization-server metadata is not exact.');
  }

  const authorizationUrl = new URL('/.well-known/oauth-authorization-server/api/auth', base);
  const authorizationResponse = await fetch(authorizationUrl, { redirect: 'error' });
  requireStatus(authorizationResponse, 200, 'authorization-server discovery');
  const authorization = await authorizationResponse.json();
  requireEqual(authorization.registration_endpoint, new URL('/api/auth/oauth2/register', base).href, 'DCR endpoint');
  requireEqual(authorization.token_endpoint, new URL('/api/auth/oauth2/token', base).href, 'token endpoint');

  const challenge = await fetch(new URL('/mcp', base), {
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

  const listed = await mcpCall(base, token, 'tools/list', {});
  const names = listed?.tools?.map?.((tool) => tool?.name).filter(Boolean) ?? [];
  for (const expected of ['inspect_workspace', 'apply_workspace_changes', 'get_operation']) {
    if (!names.includes(expected)) throw new Error(`MCP tool inventory omitted ${expected}.`);
  }
  const inspected = await mcpCall(base, token, 'tools/call', {
    name: 'inspect_workspace',
    arguments: {},
  });
  assertSuccessfulToolResult(inspected, 'workspace inspection');

  // A second stateless call exercises disconnect/reconnect semantics without
  // retaining a server session or printing the private workspace snapshot.
  const relisted = await mcpCall(base, token, 'tools/list', {});
  if ((relisted?.tools?.length ?? 0) !== names.length) {
    throw new Error('Stateless reconnect returned a different tool inventory.');
  }
  console.log(`ok authenticated inspect and stateless reconnect (${names.length} tools)`);

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
  const response = await fetch(new URL('/mcp', base), {
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
