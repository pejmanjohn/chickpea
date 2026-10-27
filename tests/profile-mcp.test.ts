import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { createMcpConnection, type ToolDefinition } from '@flue/runtime';

import {
  resolveProfileMcpConnections,
  resolveRuntimePlanMcpConnections,
} from '../src/config/profile-mcp.ts';
import { ConnectionCredentialUnavailableError } from '../src/connections/errors.ts';
import { saveConnectionAccountSecret } from '../src/config/connector-secrets.ts';
import { boundMcpCredentialRef } from '../src/config/connection-credential-binding.ts';
import {
  META_ADS_ACCOUNT_HELPER,
  META_ADS_APPROVED_ACCOUNT_SCOPE,
  META_ADS_FIELD_HELPER,
} from '../src/config/meta-ads-policy.ts';
import { sanitizeMetaAdsAccountHelperResponse } from '../src/config/meta-ads-response.ts';
import { mcpOAuthSettingKeys } from '../src/config/mcp-oauth.ts';
import { createMcpGuardedFetch } from '../src/config/mcp-url.ts';
import {
  mcpBearerEnvVar,
  mcpCredentialBindingEnvVar,
  mcpHeaderEnvVar,
  mcpHeaderSettingKey,
} from '../src/config/mcp-secrets.ts';
import {
  closeNodeStateStores,
  getConfigStore,
  getSettingsStore,
} from '../src/config/state-backend.ts';
import type { McpConnectionConfig } from '../src/config/types.ts';
import { withEnv } from './helpers/env.ts';

// --- fixtures -------------------------------------------------------------

function server(overrides: Partial<McpConnectionConfig> = {}): McpConnectionConfig {
  return {
    id: 'srv',
    credentialRef: 'connection_33333333333333333333333333333333',
    displayName: 'Server',
    url: 'https://mcp.example.com/mcp',
    transport: 'streamable-http',
    authMode: 'none',
    headerNames: [],
    enabled: true,
    lifecycleStatus: 'ready',
    statusText: '',
    discoveredTools: [{ name: 'search' }, { name: 'create' }],
    allowedTools: ['search', 'create'],
    ...overrides,
  };
}

const metaAccountSchema = {
  propertyNames: ['ad_account_id'],
  accountFields: [{ name: 'ad_account_id' as const, type: 'string' as const, required: true }],
  ambiguous: false,
  fingerprint: 'a'.repeat(64),
};
const metaEntitySchema = {
  ...metaAccountSchema,
  propertyNames: ['ad_account_id', 'client_conversation_id', 'fields', 'object_ids'],
};
const metaReportTool = 'ads_get_ad_entities';
const metaScoreTool = 'ads_get_opportunity_score';
const metaAccountHelperSchema = {
  propertyNames: ['advertiser_request', 'client_conversation_id', 'cursor', 'limit'],
  accountFields: [],
  ambiguous: false,
  fingerprint: 'b'.repeat(64),
};

function metaAccountHelperServer(overrides: Partial<McpConnectionConfig> = {}): McpConnectionConfig {
  return server({
    url: 'https://mcp.facebook.com/ads',
    presetId: 'meta-ads',
    discoveredTools: [{ name: META_ADS_ACCOUNT_HELPER, inputSchema: metaAccountHelperSchema }],
    allowedTools: [META_ADS_ACCOUNT_HELPER],
    toolPolicies: { [META_ADS_ACCOUNT_HELPER]: {
      effect: 'read', argumentConstraints: {
        [META_ADS_APPROVED_ACCOUNT_SCOPE]: ['123450001', 'act_123450001'],
      },
    } },
    ...overrides,
  });
}

function providerAccountHelperFetch(wire: 'json' | 'sse'): typeof fetch {
  const respond = (payload: Record<string, unknown>): Response => wire === 'sse'
    ? new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      })
    : Response.json(payload);
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'GET') return new Response(null, { status: 405 });
    const rpc = await request.json() as { id?: string | number; method?: string; params?: Record<string, unknown> };
    if (rpc.method === 'initialize') {
      return respond({ jsonrpc: '2.0', id: rpc.id ?? 1, result: {
        protocolVersion: rpc.params?.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: 'fake-meta', version: '1' },
      } });
    }
    if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (rpc.method === 'tools/list') {
      return respond({ jsonrpc: '2.0', id: rpc.id ?? 1, result: { tools: [{
        name: META_ADS_ACCOUNT_HELPER,
        description: 'Provider account helper with pagination.',
        inputSchema: { type: 'object', properties: {
          advertiser_request: { type: 'string' },
          client_conversation_id: { type: ['string', 'null'] },
          cursor: { type: ['string', 'null'] }, limit: { type: 'integer' },
        } },
        outputSchema: {
          type: 'object', properties: { accounts: { type: 'array', items: { type: 'object' } } },
          required: ['accounts'], additionalProperties: false,
        },
      }] } });
    }
    if (rpc.method === 'tools/call') {
      return respond({ jsonrpc: '2.0', id: rpc.id ?? 1, result: { structuredContent: { accounts: [{
        id: '123450001', is_ads_mcp_enabled: true, is_queryable: true,
        currency: 'USD', ad_account_name: 'Example Advertiser', provider_private: 'drop-me',
      }] } } });
    }
    throw new Error(`Unexpected fake MCP request: ${String(rpc.method)}`);
  };
}

function preparedMcpExecutor(tool: ToolDefinition): (args: unknown) => Promise<string> {
  const symbol = Object.getOwnPropertySymbols(tool)
    .find((candidate) => candidate.description === 'flue.preparedToolAdapter');
  assert.ok(symbol);
  const adapter = Reflect.get(tool, symbol) as { execute?: (args: unknown) => Promise<string> };
  assert.equal(typeof adapter.execute, 'function');
  return (args) => adapter.execute!(args);
}

const noSecretsEnv = {} as Record<string, unknown>;

test('Flue 2 MCP definitions retain only policy and resolve rotating bearer auth live', async () => {
  const connection = server({ authMode: 'bearer', allowedTools: ['search'] });
  const ref = boundMcpCredentialRef('agent_v2', connection);
  const envVar = mcpBearerEnvVar(ref);
  await withEnv({
    [envVar]: 'first-token',
    [mcpCredentialBindingEnvVar(ref)]: ref.credentialBinding,
  }, async () => {
    const [definition] = resolveProfileMcpConnections(
      [connection],
      {
        agentId: ref.agentId,
        env: noSecretsEnv,
        resolveCurrentConnection: async () => connection,
      },
    );
    assert.ok(definition);
    assert.deepEqual(definition.tools, ['search']);
    assert.equal(definition.optional, true);
    assert.equal(typeof definition.auth, 'function');
    assert.doesNotMatch(JSON.stringify(definition), /first-token/);
    assert.equal(await (definition.auth as () => Promise<string>)(), 'first-token');

    process.env[envVar] = 'second-token';
    assert.equal(await (definition.auth as () => Promise<string>)(), 'second-token');
  });
});

test('a frozen MCP connection cannot resolve or send its credential after retargeting', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-mcp-binding-'));
  const agentId = 'agent_mcp_binding';
  let outbound = 0;
  try {
    await withEnv({ SLACK_STATE_DB_PATH: join(directory, 'state.db') }, async () => {
      const config = getConfigStore();
      const created = await config.createAgent({
        id: agentId,
        name: 'MCP binding',
        instructions: 'Use the reviewed MCP server only.',
        enabled: true,
        skills: [],
        mcpServers: [server({ authMode: 'bearer', allowedTools: ['search'] })],
        apiConnections: [],
        repositories: [],
      });
      const frozen = created.mcpServers[0]!;
      const [definition] = resolveProfileMcpConnections([frozen], {
        agentId,
        resolveBearerCredential: async () => 'old-target-secret',
        createGuardedFetch: () => async () => {
          outbound += 1;
          return Response.json({ ok: true });
        },
      });
      const auth = definition?.auth as (() => Promise<string>) | undefined;
      assert.equal(await auth?.(), 'old-target-secret');

      const retargeted = await config.updateAgent(agentId, {
        mcpServers: [{ ...frozen, url: 'https://other.example.com/rpc' }],
      }, created.revision);
      assert.notEqual(retargeted.mcpServers[0]?.credentialRef, frozen.credentialRef);
      await assert.rejects(auth!(), /policy changed/);
      await assert.rejects(definition!.fetch!('https://mcp.example.com/rpc', {
        method: 'POST',
      }), /policy changed/);
      assert.equal(outbound, 0);
    });
  } finally {
    closeNodeStateStores();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('profile MCP rechecks policy after DNS resolution and before credentialed egress', async () => {
  const frozen = server({ authMode: 'bearer', allowedTools: ['search'] });
  let current = frozen;
  let releaseDns: (() => void) | undefined;
  let reachedDns: (() => void) | undefined;
  const released = new Promise<void>((resolve) => { releaseDns = resolve; });
  const reached = new Promise<void>((resolve) => { reachedDns = resolve; });
  let outbound = 0;
  const [definition] = resolveProfileMcpConnections([frozen], {
    agentId: 'agent_dns_fence',
    resolveCurrentConnection: async () => current,
    createGuardedFetch: (options) => createMcpGuardedFetch({
      ...options,
      cloudflare: false,
      resolveAddresses: async () => {
        reachedDns?.();
        await released;
        return [{ address: '93.184.216.34', family: 4 }];
      },
      pinnedFetch: async () => {
        outbound += 1;
        return Response.json({ ok: true });
      },
    }),
  });
  const pending = definition!.fetch!('https://mcp.example.com/mcp', {
    method: 'POST',
    headers: { authorization: 'Bearer must-not-leave' },
  });
  const expectedFailure = assert.rejects(pending, /policy changed/);
  await reached;
  current = { ...current, enabled: false };
  releaseDns?.();
  await expectedFailure;
  assert.equal(outbound, 0);
});

test('runtime-plan MCP rechecks policy after DNS resolution and before credentialed egress', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-mcp-dns-fence-'));
  const agentId = 'agent_runtime_dns_fence';
  let releaseDns: (() => void) | undefined;
  let reachedDns: (() => void) | undefined;
  const released = new Promise<void>((resolve) => { releaseDns = resolve; });
  const reached = new Promise<void>((resolve) => { reachedDns = resolve; });
  let outbound = 0;
  try {
    await withEnv({ SLACK_STATE_DB_PATH: join(directory, 'state.db') }, async () => {
      const config = getConfigStore();
      const created = await config.createAgent({
        id: agentId,
        name: 'Runtime DNS fence',
        instructions: 'Authorize again at the outbound boundary.',
        enabled: true,
        skills: [],
        mcpServers: [server({ authMode: 'bearer', allowedTools: ['search'] })],
        apiConnections: [],
        repositories: [],
      });
      const frozen = created.mcpServers[0]!;
      const [definition] = resolveRuntimePlanMcpConnections(agentId, [{
        id: frozen.id,
        url: frozen.url,
        transport: frozen.transport,
        credentialRef: frozen.credentialRef!,
        authMode: frozen.authMode,
        headerNames: [],
        optional: true,
        allowedTools: ['search'],
      }], undefined, undefined, {
        createGuardedFetch: (options) => createMcpGuardedFetch({
          ...options,
          cloudflare: false,
          resolveAddresses: async () => {
            reachedDns?.();
            await released;
            return [{ address: '93.184.216.34', family: 4 }];
          },
          pinnedFetch: async () => {
            outbound += 1;
            return Response.json({ ok: true });
          },
        }),
      });
      const pending = definition!.fetch!('https://mcp.example.com/mcp', {
        method: 'POST',
        headers: { authorization: 'Bearer must-not-leave' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: 'search', arguments: {},
        } }),
      });
      const expectedFailure = assert.rejects(pending, /policy changed/);
      await reached;
      await config.updateAgent(agentId, {
        mcpServers: [{ ...frozen, enabled: false }],
      }, created.revision);
      releaseDns?.();
      await expectedFailure;
      assert.equal(outbound, 0);
    });
  } finally {
    releaseDns?.();
    closeNodeStateStores();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('runtime MCP rechecks its incarnation after an asynchronous header read', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-mcp-header-race-'));
  const agentId = 'agent_mcp_header_race';
  let releaseHeaderRead: (() => void) | undefined;
  let reachedHeaderRead: (() => void) | undefined;
  const released = new Promise<void>((resolve) => { releaseHeaderRead = resolve; });
  const reached = new Promise<void>((resolve) => { reachedHeaderRead = resolve; });
  let outbound = 0;
  try {
    await withEnv({ SLACK_STATE_DB_PATH: join(directory, 'state.db') }, async () => {
      const config = getConfigStore();
      const created = await config.createAgent({
        id: agentId,
        name: 'MCP header race',
        instructions: 'Send credentials only to the current target.',
        enabled: true,
        skills: [],
        mcpServers: [server({ headerNames: ['x-api-key'], allowedTools: ['search'] })],
        apiConnections: [],
        repositories: [],
      });
      const frozen = created.mcpServers[0]!;
      const ref = boundMcpCredentialRef(agentId, frozen);
      const settings = getSettingsStore();
      const headerKey = mcpHeaderSettingKey(ref, 'x-api-key');
      await settings.setSetting(headerKey, 'old-target-secret');
      const originalGetSetting = settings.getSetting.bind(settings);
      let delayed = false;
      settings.getSetting = async (key) => {
        if (!delayed && key === headerKey) {
          delayed = true;
          reachedHeaderRead?.();
          await released;
        }
        return originalGetSetting(key);
      };
      try {
        const [definition] = resolveRuntimePlanMcpConnections(agentId, [{
          id: frozen.id,
          url: frozen.url,
          transport: frozen.transport,
          credentialRef: ref.credentialRef,
          authMode: frozen.authMode,
          headerNames: ['x-api-key'],
          optional: true,
          allowedTools: ['search'],
          readOnlyTools: ['search'],
        }], undefined, undefined, {
          createGuardedFetch: () => (async () => {
            outbound += 1;
            return Response.json({ ok: true });
          }) as typeof fetch,
        });
        const pending = definition!.fetch!('https://mcp.example.com/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        });
        const expectedFailure = assert.rejects(pending, /policy changed/);
        await Promise.race([
          reached,
          new Promise<never>((_resolve, reject) => setTimeout(
            () => reject(new Error('runtime header read did not reach the race barrier')),
            2_000,
          )),
        ]);
        const retargeted = await config.updateAgent(agentId, {
          mcpServers: [{ ...frozen, url: 'https://mcp.example.com/retargeted' }],
        }, created.revision);
        assert.notEqual(retargeted.mcpServers[0]?.credentialRef, ref.credentialRef);
        releaseHeaderRead?.();
        await expectedFailure;
        assert.equal(outbound, 0);
      } finally {
        releaseHeaderRead?.();
        settings.getSetting = originalGetSetting;
      }
    });
  } finally {
    closeNodeStateStores();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('direct Meta definitions expose only scoped tools and reject undeclared arguments', async () => {
  let outbound = 0;
  const metaServer = server({
    url: 'https://mcp.facebook.com/ads',
    discoveredTools: [
      { name: metaReportTool, inputSchema: metaEntitySchema },
      { name: metaScoreTool },
    ],
    allowedTools: [metaReportTool, metaScoreTool],
    toolPolicies: {
      [metaReportTool]: { effect: 'read', argumentConstraints: { ad_account_id: ['act_123'] } },
      [metaScoreTool]: { effect: 'read' },
    },
  });
  const [definition] = resolveProfileMcpConnections([metaServer], {
    agentId: 'agent_test', env: noSecretsEnv,
    resolveCurrentConnection: async () => metaServer,
    createGuardedFetch: () => async () => {
      outbound += 1;
      return Response.json({});
    },
  });
  assert.deepEqual(definition?.tools, [metaReportTool]);
  await assert.rejects(definition!.fetch!('https://mcp.facebook.com/ads', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: metaReportTool, arguments: { ad_account_id: 'act_123', object_ids: ['other'] } } }),
  }), /does not permit the argument object_ids/);
  assert.equal(outbound, 0);
  await assert.rejects(definition!.fetch!('https://mcp.facebook.com/ads', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: metaReportTool, arguments: { ad_account_id: 'act_123', campaign_id: 'other' } } }),
  }), /does not permit the argument campaign_id/);
  assert.equal(outbound, 0);
  await definition!.fetch!('https://mcp.facebook.com/ads', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: metaReportTool, arguments: {
        ad_account_id: 'act_123', client_conversation_id: 'correlation-1', fields: ['spend'],
      } } }),
  });
  assert.equal(outbound, 1);
});

test('custom MCP tool with a helper-shaped name keeps ordinary argument constraints', async () => {
  let outbound = 0;
  const custom = server({
    discoveredTools: [{ name: META_ADS_ACCOUNT_HELPER }],
    allowedTools: [META_ADS_ACCOUNT_HELPER],
    toolPolicies: { [META_ADS_ACCOUNT_HELPER]: {
      effect: 'read', argumentConstraints: { tenant_id: ['tenant-1'] },
    } },
  });
  const [definition] = resolveProfileMcpConnections([custom], {
    agentId: 'agent_test', env: noSecretsEnv,
    createGuardedFetch: () => async () => {
      outbound += 1;
      return Response.json({});
    },
  });
  await assert.rejects(definition!.fetch!('https://mcp.example.com/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: META_ADS_ACCOUNT_HELPER, arguments: {},
    } }),
  }), /approved value/);
  assert.equal(outbound, 0);
});

test('Meta preset metadata cannot install the account output adapter on another endpoint', async () => {
  const spoofed = metaAccountHelperServer({ url: 'https://mcp.example.com/mcp' });
  const [definition] = resolveProfileMcpConnections([spoofed], {
    agentId: 'agent_test', env: noSecretsEnv,
    resolveCurrentConnection: async () => spoofed,
    createGuardedFetch: () => providerAccountHelperFetch('json'),
  });
  const response = await definition!.fetch!('https://mcp.example.com/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const body = await response.json() as { result: { tools: Array<Record<string, unknown>> } };
  assert.equal(body.result.tools[0]!.description, 'Provider account helper with pagination.');
  assert.deepEqual((body.result.tools[0]!.outputSchema as { required: string[] }).required, ['accounts']);
});

test('real MCP SDK rejects a sanitized account result against the untouched provider output schema', async () => {
  const provider = providerAccountHelperFetch('json');
  const connection = await createMcpConnection({
    name: 'unadapted-meta', url: 'https://mcp.facebook.com/ads',
    tools: [META_ADS_ACCOUNT_HELPER],
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const rpc = request.method === 'POST'
        ? await request.clone().json() as { method?: string }
        : undefined;
      const response = await provider(request);
      return rpc?.method === 'tools/call'
        ? sanitizeMetaAdsAccountHelperResponse(response, ['123450001'])
        : response;
    },
  });
  try {
    const execute = preparedMcpExecutor(connection.tools[0]!);
    await assert.rejects(execute({ advertiser_request: 'List approved accounts.' }),
      /structured content does not match.*output schema/i);
  } finally {
    await connection.close();
  }
});

test('Meta adapter advertises its filtered account result to the real MCP SDK over JSON and SSE', async () => {
  for (const wire of ['json', 'sse'] as const) {
    const current = metaAccountHelperServer({ id: `meta-${wire}` });
    const [definition] = resolveProfileMcpConnections([current], {
      agentId: 'agent_test', env: noSecretsEnv,
      resolveCurrentConnection: async () => current,
      createGuardedFetch: () => providerAccountHelperFetch(wire),
    });
    assert.ok(definition);
    const connection = await createMcpConnection(definition);
    try {
      assert.match(connection.tools[0]!.description, /owner-approved Meta ad accounts/);
      assert.doesNotMatch(connection.tools[0]!.description, /pagination instructions/);
      const result = await preparedMcpExecutor(connection.tools[0]!)({
        advertiser_request: 'List approved accounts.', client_conversation_id: null,
      });
      assert.match(result, /"ad_accounts"/);
      assert.match(result, /123450001|Example Advertiser/);
      assert.doesNotMatch(result, /provider_private|drop-me/);
    } finally {
      await connection.close();
    }
  }
});

test('direct Meta field helper has no phantom account input and honors live revocation', async () => {
  const fieldServer = server({
    url: 'https://mcp.facebook.com/ads', presetId: 'meta-ads',
    discoveredTools: [{ name: META_ADS_FIELD_HELPER, inputSchema: {
      propertyNames: ['advertiser_request', 'client_conversation_id', 'field_names'],
      accountFields: [], ambiguous: false, fingerprint: 'c'.repeat(64),
    } }],
    allowedTools: [META_ADS_FIELD_HELPER],
    toolPolicies: { [META_ADS_FIELD_HELPER]: { effect: 'read', argumentConstraints: {
      [META_ADS_APPROVED_ACCOUNT_SCOPE]: ['act_123'],
    } } },
  });
  let current: McpConnectionConfig | undefined = fieldServer;
  let outbound = 0;
  const [definition] = resolveProfileMcpConnections([fieldServer], {
    agentId: 'agent_test', env: noSecretsEnv,
    resolveCurrentConnection: async () => current,
    createGuardedFetch: () => async () => {
      outbound += 1;
      return Response.json({ jsonrpc: '2.0', id: 1, result: {
        content: [{ type: 'text', text: 'field metadata' }],
      } });
    },
  });
  await assert.rejects(definition!.fetch!('https://mcp.facebook.com/ads', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/call', params: {
      name: META_ADS_FIELD_HELPER, arguments: { campaign_id: 'other' },
    } }),
  }), /does not permit the argument campaign_id/);
  await assert.rejects(definition!.fetch!('https://mcp.facebook.com/ads', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/call', params: {
      name: META_ADS_FIELD_HELPER, arguments: { field_names: ['x'.repeat(121)] },
    } }),
  }), /invalid field_names/);
  await assert.rejects(definition!.fetch!('https://mcp.facebook.com/ads', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/call', params: {
      name: META_ADS_FIELD_HELPER, arguments: { advertiser_request: null, field_names: ['spend'] },
    } }),
  }), /invalid advertiser_request/);
  await assert.rejects(definition!.fetch!('https://mcp.facebook.com/ads', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/call', params: {
      name: META_ADS_FIELD_HELPER, arguments: { advertiser_request: 'Verify fields.', field_names: 'spend' },
    } }),
  }), /invalid field_names/);
  assert.equal(outbound, 0);
  await definition!.fetch!('https://mcp.facebook.com/ads', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: META_ADS_FIELD_HELPER, arguments: {
        advertiser_request: 'Verify reporting fields.',
        client_conversation_id: null,
        field_names: ['spend', 'impressions', 'reach'],
      },
    } }),
  });
  assert.equal(outbound, 1);
  current = { ...fieldServer, allowedTools: [] };
  await assert.rejects(definition!.fetch!('https://mcp.facebook.com/ads', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: META_ADS_FIELD_HELPER, arguments: {},
    } }),
  }), /policy changed/);
  assert.equal(outbound, 1);
});

test('direct Meta account helper sanitizes SSE under live profile policy', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-direct-meta-helper-'));
  const agentId = 'agent_direct_meta_helper';
  const connection = metaAccountHelperServer();
  try {
    await withEnv({ SLACK_STATE_DB_PATH: join(directory, 'state.db') }, async () => {
      await getConfigStore().createAgent({
        id: agentId, name: 'Direct Meta helper', instructions: 'Test Meta helper policy.',
        enabled: true, model: 'local-stub/direct-meta', skills: [],
        mcpServers: [connection], apiConnections: [], repositories: [],
      });
      const storedConnection = (await getConfigStore().getAgent(agentId)).mcpServers[0]!;
      const [definition] = resolveProfileMcpConnections([storedConnection], {
        agentId,
        createGuardedFetch: () => async () => {
          const envelope = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ accounts: [
            { id: 'act_999', is_ads_mcp_enabled: true, is_queryable: true, ad_account_name: 'Other' },
            { id: '123450001', is_ads_mcp_enabled: true, is_queryable: true, ad_account_name: 'Example Advertiser' },
          ] }) }] } };
          return new Response(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`, {
            headers: { 'content-type': 'text/event-stream' },
          });
        },
      });
      assert.deepEqual(definition?.tools, [META_ADS_ACCOUNT_HELPER]);
      const response = await definition!.fetch!('https://mcp.facebook.com/ads', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: META_ADS_ACCOUNT_HELPER, arguments: {
            advertiser_request: 'List approved queryable accounts.',
            client_conversation_id: 'correlation-3',
          },
        } }),
      });
      const text = await response.text();
      assert.match(text, /"ad_accounts"/);
      assert.doesNotMatch(text, /"accounts"/);
      assert.match(text, /123450001|Example Advertiser/);
      assert.doesNotMatch(text, /999|Other|meta_ads_approved/);
    });
  } finally {
    closeNodeStateStores();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('runtime-plan Meta account helper accepts bounded metadata and sanitizes JSON', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-runtime-meta-helper-'));
  const agentId = 'agent_runtime_meta_helper';
  const connection = metaAccountHelperServer({ id: 'meta' });
  try {
    await withEnv({ SLACK_STATE_DB_PATH: join(directory, 'state.db') }, async () => {
      await getConfigStore().createAgent({
        id: agentId, name: 'Runtime Meta helper', instructions: 'Test Meta helper policy.',
        enabled: true, model: 'local-stub/runtime-meta-helper', skills: [],
        mcpServers: [connection], apiConnections: [], repositories: [],
      });
      const storedConnection = (await getConfigStore().getAgent(agentId)).mcpServers[0]!;
      const credentialRef = storedConnection.credentialRef;
      assert.ok(credentialRef);
      const [definition] = resolveRuntimePlanMcpConnections(agentId, [{
        id: connection.id, url: connection.url, transport: connection.transport,
        credentialRef,
        authMode: 'none', headerNames: [], optional: true,
        allowedTools: [META_ADS_ACCOUNT_HELPER], readOnlyTools: [META_ADS_ACCOUNT_HELPER],
        toolArgumentConstraints: { [META_ADS_ACCOUNT_HELPER]: {
          [META_ADS_APPROVED_ACCOUNT_SCOPE]: ['123450001', 'act_123450001'],
        } },
      }], undefined, undefined, { createGuardedFetch: () => async (input, init) => {
        const request = new Request(input, init);
        const rpc = await request.json() as { id?: number; method?: string };
        if (rpc.method === 'tools/list') {
          return Response.json({ jsonrpc: '2.0', id: rpc.id ?? 1, result: { tools: [{
            name: META_ADS_ACCOUNT_HELPER, description: 'Provider helper.',
            inputSchema: { type: 'object', properties: { cursor: { type: 'string' } } },
            outputSchema: { type: 'object', properties: { accounts: { type: 'array' } } },
          }] } });
        }
        return Response.json({
          jsonrpc: '2.0', id: rpc.id ?? 1, result: { structuredContent: { accounts: [
            { id: 'act_999', is_ads_mcp_enabled: true, is_queryable: true, ad_account_name: 'Other' },
            { id: 'act_123450001', is_ads_mcp_enabled: true, is_queryable: true, ad_account_name: 'Example Advertiser' },
          ] } },
        });
      } });
      assert.deepEqual(definition?.tools, [META_ADS_ACCOUNT_HELPER]);
      const listing = await definition!.fetch!('https://mcp.facebook.com/ads', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} }),
      });
      const listed = await listing.json() as { result: { tools: Array<Record<string, unknown>> } };
      assert.deepEqual((listed.result.tools[0]!.outputSchema as { required: string[] }).required, ['ad_accounts']);
      const response = await definition!.fetch!('https://mcp.facebook.com/ads', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: META_ADS_ACCOUNT_HELPER, arguments: {
            advertiser_request: 'List the approved accounts.\nInclude queryability.',
            client_conversation_id: 'correlation-4',
          },
        } }),
      });
      const result = await response.json();
      assert.match(JSON.stringify(result), /"ad_accounts"/);
      assert.doesNotMatch(JSON.stringify(result), /"accounts"/);
      assert.match(JSON.stringify(result), /123450001|Example Advertiser/);
      assert.doesNotMatch(JSON.stringify(result), /999|Other|meta_ads_approved/);
    });
  } finally {
    closeNodeStateStores();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('runtime-plan direct Meta definitions withhold unscoped tools and reject another account pre-I/O', async () => {
  const [definition] = resolveRuntimePlanMcpConnections('missing-agent', [{
    id: 'meta', url: 'https://mcp.facebook.com/ads', transport: 'streamable-http',
    authMode: 'none', headerNames: [], optional: true,
    allowedTools: [metaReportTool, metaScoreTool],
    readOnlyTools: [metaReportTool, metaScoreTool],
    toolArgumentConstraints: { [metaReportTool]: { ad_account_id: ['act_123'] } },
  }]);
  assert.deepEqual(definition?.tools, [metaReportTool]);
  await assert.rejects(definition!.fetch!('https://mcp.facebook.com/ads', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: metaReportTool, arguments: { ad_account_id: 'act_456' } } }),
  }), /approved value/);
});

test('runtime-plan Meta invocation rejects optional entity targets from the current schema', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-runtime-meta-arguments-'));
  const agentId = 'agent_runtime_meta_arguments';
  const connection = server({
    id: 'meta', url: 'https://mcp.facebook.com/ads', presetId: 'meta-ads',
    discoveredTools: [{ name: metaReportTool, inputSchema: metaEntitySchema }],
    allowedTools: [metaReportTool],
    toolPolicies: { [metaReportTool]: {
      effect: 'read', argumentConstraints: { ad_account_id: ['act_123'] },
    } },
  });
  try {
    await withEnv({ SLACK_STATE_DB_PATH: join(directory, 'state.db') }, async () => {
      await getConfigStore().createAgent({
        id: agentId, name: 'Runtime Meta arguments', instructions: 'Test Meta argument policy.',
        enabled: true, model: 'local-stub/runtime-meta', skills: [],
        mcpServers: [connection], apiConnections: [], repositories: [],
      });
      const storedConnection = (await getConfigStore().getAgent(agentId)).mcpServers[0]!;
      const credentialRef = storedConnection.credentialRef;
      assert.ok(credentialRef);
      const [definition] = resolveRuntimePlanMcpConnections(agentId, [{
        id: connection.id, url: connection.url, transport: connection.transport,
        credentialRef,
        authMode: 'none', headerNames: [], optional: true,
        allowedTools: [metaReportTool], readOnlyTools: [metaReportTool],
        toolArgumentConstraints: { [metaReportTool]: { ad_account_id: ['act_123'] } },
      }]);
      await assert.rejects(definition!.fetch!('https://mcp.facebook.com/ads', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: metaReportTool,
          arguments: { ad_account_id: 'act_123', object_ids: ['other'] },
        } }),
      }), /does not permit the argument object_ids/);
    });
  } finally {
    closeNodeStateStores();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Flue 2 MCP guarded fetch resolves rotating custom headers per request', async () => {
  const connection = server({ headerNames: ['X-Api-Key'], allowedTools: ['search'] });
  const ref = boundMcpCredentialRef('agent_v2_headers', connection);
  const envVar = mcpHeaderEnvVar(ref, 'X-Api-Key');
  const captured: Request[] = [];
  await withEnv({
    [envVar]: 'header-one',
    [mcpCredentialBindingEnvVar(ref)]: ref.credentialBinding,
  }, async () => {
    const [definition] = resolveProfileMcpConnections(
      [connection],
      {
        agentId: ref.agentId,
        env: noSecretsEnv,
        resolveCurrentConnection: async () => connection,
        createGuardedFetch: () => (async (input, init) => {
          captured.push(new Request(input, init));
          return new Response('{}');
        }) as typeof fetch,
      },
    );
    assert.ok(definition?.fetch);
    await definition.fetch('https://mcp.example.com/mcp', { method: 'POST' });
    process.env[envVar] = 'header-two';
    await definition.fetch('https://mcp.example.com/mcp', { method: 'POST' });
  });
  assert.equal(captured[0]?.headers.get('x-api-key'), 'header-one');
  assert.equal(captured[1]?.headers.get('x-api-key'), 'header-two');
});

test('runtime-plan OAuth auth reuses its live policy read for a fresh token', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-runtime-mcp-oauth-'));
  const statePath = join(directory, 'state.db');
  const agentId = 'agent_runtime_oauth';
  const connection = server({
    id: 'oauth-server',
    authMode: 'oauth',
    allowedTools: ['search'],
  });
  try {
    await withEnv({ SLACK_STATE_DB_PATH: statePath }, async () => {
      const config = getConfigStore();
      await config.createAgent({
        id: agentId,
        name: 'Runtime OAuth',
        instructions: 'Test runtime OAuth policy reads.',
        enabled: true,
        model: 'local-stub/runtime-oauth',
        skills: [],
        mcpServers: [connection],
        apiConnections: [],
        repositories: [],
      });
      const settings = getSettingsStore();
      const storedConnection = (await config.getAgent(agentId)).mcpServers[0]!;
      await settings.setSetting(
        mcpOAuthSettingKeys(boundMcpCredentialRef(agentId, storedConnection))[2],
        JSON.stringify({
          serverUrl: connection.url,
          authorizationServerUrl: 'https://auth.example.com',
          metadata: {
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            response_types_supported: ['code'],
          },
          resource: connection.url,
          clientInformation: { client_id: 'runtime-client' },
          tokens: {
            access_token: 'runtime-access-token',
            token_type: 'Bearer',
            expires_in: 3_600,
          },
          obtainedAt: Date.now(),
        }),
      );

      const originalGetAgent = config.getAgent.bind(config);
      let policyReads = 0;
      config.getAgent = async (id) => {
        policyReads += 1;
        return originalGetAgent(id);
      };
      try {
        const credentialRef = storedConnection.credentialRef;
        assert.ok(credentialRef);
        policyReads = 0;
        const [definition] = resolveRuntimePlanMcpConnections(agentId, [{
          id: connection.id,
          url: connection.url,
          transport: connection.transport,
          credentialRef,
          authMode: connection.authMode,
          headerNames: [],
          allowedTools: ['search'],
          optional: true,
        }]);
        const auth = definition?.auth as (() => Promise<string>) | undefined;
        assert.equal(await auth?.(), 'runtime-access-token');
        assert.equal(await auth?.(), 'runtime-access-token');
        assert.equal(policyReads, 2, 'each auth call performs one current-policy read');
      } finally {
        config.getAgent = originalGetAgent;
      }
    });
  } finally {
    closeNodeStateStores();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('account-backed runtime MCP resolves OAuth and rechecks live tool and actor authority', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-account-mcp-'));
  try {
    await withEnv({ SLACK_STATE_DB_PATH: join(directory, 'state.db'), CHICKPEA_AUTH_DB_PATH: join(directory, 'auth.db') }, async () => {
      const { getIdentityStore } = await import('../src/config/state-backend.ts');
      const { connectionAccountOAuthRef } = await import('../src/config/api-oauth.ts');
      const config = getConfigStore();
      const identity = getIdentityStore();
      const policy = { kind: 'mcp', url: 'https://mcp.example.com/mcp', transport: 'streamable-http', authMode: 'oauth', headerNames: [], discoveredTools: [{ name: 'search' }], allowedTools: ['search'], oauthAttemptId: '11111111-1111-4111-8111-111111111111' };
      const account = { id: 'connection_test', workspaceId: 'T_TEST', providerId: 'test', label: 'Test MCP', ownerKind: 'team', lifecycle: 'ready', policy };
      const binding = { agentId: 'agent_test', connectionAccountId: account.id, providerId: 'test', enabled: true, allowedCapabilities: [] };
      let active = true;
      t.mock.method(identity, 'getOrganization', async () => ({ id: 'org', slackTeamId: 'T_TEST' }));
      t.mock.method(identity, 'getMembership', async () => ({ id: 'member', userId: 'user', organizationId: 'org', status: active ? 'active' : 'suspended' }));
      t.mock.method(identity, 'getMembershipAccessOverlay', async () => null);
      t.mock.method(identity, 'getUser', async () => ({ id: 'user', slackTeamId: 'T_TEST', slackUserId: 'U_TEST' }));
      t.mock.method(identity, 'resolveSlackIdentity', async () => ({ user: { id: 'user' }, membership: { id: 'member' }, binding: { membershipId: 'member' } }));
      t.mock.method(config, 'listConnectionAccounts', async () => [account]);
      t.mock.method(config, 'listAgentConnectionBindings', async () => [binding]);
      t.mock.method(config, 'getAgent', async () => { throw new Error('Must not read legacy MCP profile'); });
      await getSettingsStore().setSetting(mcpOAuthSettingKeys(connectionAccountOAuthRef(account.id))[2], JSON.stringify({
        serverUrl: policy.url, authorizationServerUrl: 'https://auth.example.com',
        metadata: { issuer: 'https://auth.example.com', authorization_endpoint: 'https://auth.example.com/authorize', token_endpoint: 'https://auth.example.com/token', response_types_supported: ['code'] },
        resource: policy.url, clientInformation: { client_id: 'client' },
        tokens: { access_token: 'account-token', token_type: 'Bearer', expires_in: 3600 },
        obtainedAt: Date.now(), oauthAttemptId: '11111111-1111-4111-8111-111111111111',
      }));
      const [definition] = resolveRuntimePlanMcpConnections('agent_test', [{
        id: account.id, url: policy.url, transport: 'streamable-http', authMode: 'oauth', headerNames: [], allowedTools: ['search'], optional: true,
      }], undefined, { workspaceId: 'T_TEST', actorMembershipId: 'member' });
      const auth = definition!.auth as () => Promise<string>;
      assert.equal(await auth(), 'account-token');
      // Descriptive server hints do not change selected tool permissions.
      Object.assign(policy.discoveredTools[0]!, { readOnlyHint: true });
      assert.equal(await auth(), 'account-token');
      policy.discoveredTools = [{ name: 'search' }];
      binding.enabled = false;
      await assert.rejects(auth(), /policy changed/);
      binding.enabled = true;
      policy.allowedTools = [];
      await assert.rejects(auth(), /policy changed/);
      policy.allowedTools = ['search'];
      active = false;
      await assert.rejects(auth(), /not available/);
      active = true;
      policy.oauthAttemptId = '22222222-2222-4222-8222-222222222222';
      await assert.rejects(auth());
      t.mock.restoreAll();
    });
  } finally {
    t.mock.restoreAll();
    closeNodeStateStores();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('account-backed runtime MCP resolves OAuth for an account stored with a bare-origin URL', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-account-mcp-origin-'));
  try {
    await withEnv({ SLACK_STATE_DB_PATH: join(directory, 'state.db'), CHICKPEA_AUTH_DB_PATH: join(directory, 'auth.db') }, async () => {
      const { getIdentityStore } = await import('../src/config/state-backend.ts');
      const { connectionAccountOAuthRef } = await import('../src/config/api-oauth.ts');
      const config = getConfigStore();
      const identity = getIdentityStore();
      const policy = { kind: 'mcp', url: 'https://mcp.example.com', transport: 'streamable-http', authMode: 'oauth', headerNames: [], discoveredTools: [{ name: 'search' }], allowedTools: ['search'] };
      const account = { id: 'connection_origin', workspaceId: 'T_TEST', providerId: 'test', label: 'Origin MCP', ownerKind: 'team', lifecycle: 'ready', policy };
      const binding = { agentId: 'agent_test', connectionAccountId: account.id, providerId: 'test', enabled: true, allowedCapabilities: [] };
      t.mock.method(identity, 'getOrganization', async () => ({ id: 'org', slackTeamId: 'T_TEST' }));
      t.mock.method(identity, 'getMembership', async () => ({ id: 'member', userId: 'user', organizationId: 'org', status: 'active' }));
      t.mock.method(identity, 'getMembershipAccessOverlay', async () => null);
      t.mock.method(identity, 'getUser', async () => ({ id: 'user', slackTeamId: 'T_TEST', slackUserId: 'U_TEST' }));
      t.mock.method(identity, 'resolveSlackIdentity', async () => ({ user: { id: 'user' }, membership: { id: 'member' }, binding: { membershipId: 'member' } }));
      t.mock.method(config, 'listConnectionAccounts', async () => [account]);
      t.mock.method(config, 'listAgentConnectionBindings', async () => [binding]);
      await getSettingsStore().setSetting(mcpOAuthSettingKeys(connectionAccountOAuthRef(account.id))[2], JSON.stringify({
        serverUrl: 'https://mcp.example.com/', authorizationServerUrl: 'https://auth.example.com',
        metadata: { issuer: 'https://auth.example.com', authorization_endpoint: 'https://auth.example.com/authorize', token_endpoint: 'https://auth.example.com/token', response_types_supported: ['code'] },
        resource: 'https://mcp.example.com/', clientInformation: { client_id: 'client' },
        tokens: { access_token: 'origin-token', token_type: 'Bearer', expires_in: 3600 },
        obtainedAt: Date.now(),
      }));
      const [definition] = resolveRuntimePlanMcpConnections('agent_test', [{
        id: account.id, url: policy.url, transport: 'streamable-http', authMode: 'oauth', headerNames: [], allowedTools: ['search'], optional: true,
      }], undefined, { workspaceId: 'T_TEST', actorMembershipId: 'member' });
      assert.equal(await (definition!.auth as () => Promise<string>)(), 'origin-token');
      t.mock.restoreAll();
    });
  } finally {
    t.mock.restoreAll();
    closeNodeStateStores();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an MCP 401 forces one renewal of the rejected OAuth token, then throttles', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-account-mcp-401-'));
  try {
    await withEnv({ SLACK_STATE_DB_PATH: join(directory, 'state.db'), CHICKPEA_AUTH_DB_PATH: join(directory, 'auth.db') }, async () => {
      const { getIdentityStore } = await import('../src/config/state-backend.ts');
      const { connectionAccountOAuthRef } = await import('../src/config/api-oauth.ts');
      const config = getConfigStore();
      const identity = getIdentityStore();
      const policy = { kind: 'mcp', url: 'https://mcp.example.com/mcp', transport: 'streamable-http', authMode: 'oauth', headerNames: [], discoveredTools: [{ name: 'search' }], allowedTools: ['search'] };
      const account = { id: 'connection_revoked', workspaceId: 'T_TEST', providerId: 'test', label: 'Revoked MCP', ownerKind: 'team', lifecycle: 'ready', revision: 3, policy };
      const binding = { agentId: 'agent_test', connectionAccountId: account.id, providerId: 'test', enabled: true, allowedCapabilities: [] };
      t.mock.method(identity, 'getOrganization', async () => ({ id: 'org', slackTeamId: 'T_TEST' }));
      t.mock.method(identity, 'getMembership', async () => ({ id: 'member', userId: 'user', organizationId: 'org', status: 'active' }));
      t.mock.method(identity, 'getMembershipAccessOverlay', async () => null);
      t.mock.method(identity, 'getUser', async () => ({ id: 'user', slackTeamId: 'T_TEST', slackUserId: 'U_TEST' }));
      t.mock.method(identity, 'resolveSlackIdentity', async () => ({ user: { id: 'user' }, membership: { id: 'member' }, binding: { membershipId: 'member' } }));
      t.mock.method(config, 'listConnectionAccounts', async () => [account]);
      t.mock.method(config, 'listAgentConnectionBindings', async () => [binding]);
      const refreshEvents: Array<Record<string, unknown>> = [];
      t.mock.method(console, 'info', (event: unknown) => {
        if ((event as { event?: string })?.event === 'chickpea.oauth.refresh') {
          refreshEvents.push(event as Record<string, unknown>);
        }
      });
      // Unexpired but revoked upstream. The token endpoint is unreachable, so
      // the forced renewal fails transiently and keeps the stored credential.
      await getSettingsStore().setSetting(mcpOAuthSettingKeys(connectionAccountOAuthRef(account.id))[2], JSON.stringify({
        serverUrl: policy.url, authorizationServerUrl: 'https://127.0.0.1',
        metadata: { issuer: 'https://127.0.0.1', authorization_endpoint: 'https://127.0.0.1/authorize', token_endpoint: 'https://127.0.0.1/token', response_types_supported: ['code'] },
        resource: policy.url, clientInformation: { client_id: 'client' },
        tokens: { access_token: 'revoked-token', refresh_token: 'refresh-token', token_type: 'Bearer', expires_in: 3600 },
        obtainedAt: Date.now() - 10 * 60_000,
      }));
      const presented: Array<string | null> = [];
      const [definition] = resolveRuntimePlanMcpConnections('agent_test', [{
        id: account.id, url: policy.url, transport: 'streamable-http', authMode: 'oauth', headerNames: [], allowedTools: ['search'], optional: true,
      }], undefined, { workspaceId: 'T_TEST', actorMembershipId: 'member' }, {
        createGuardedFetch: () => (async (input, init) => {
          presented.push(new Request(input, init).headers.get('authorization'));
          return new Response('unauthorized', { status: 401 });
        }) as typeof fetch,
      });

      // The transport's one 401 retry re-resolves auth, which forces the renewal.
      await assert.rejects(createMcpConnection(definition!), /refresh failed/);
      assert.deepEqual(presented, ['Bearer revoked-token']);
      assert.deepEqual(
        refreshEvents.map(({ connectionId, trigger, outcome }) => ({ connectionId, trigger, outcome })),
        [{ connectionId: account.id, trigger: 'unauthorized', outcome: 'unavailable' }],
      );

      // Within the window a second 401 presents the stored token again instead
      // of retrying the failing token endpoint.
      await assert.rejects(createMcpConnection(definition!));
      assert.deepEqual(presented, ['Bearer revoked-token', 'Bearer revoked-token', 'Bearer revoked-token']);
      assert.equal(refreshEvents.length, 1);
    });
  } finally {
    t.mock.restoreAll();
    closeNodeStateStores();
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * Send one tools/list request through an account-backed RuntimePlanV2 MCP
 * connection whose account row carries `policy`. Returns the outbound headers,
 * or the error thrown before any provider request.
 */
async function accountMcpRequest(
  t: TestContext,
  policy: Record<string, unknown> & { authMode: string; headerNames: string[] },
  options: { secret?: string; active?: boolean } = {},
): Promise<{ headers: Headers } | { error: unknown }> {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-account-mcp-headers-'));
  try {
    return await withEnv({
      SLACK_STATE_DB_PATH: join(directory, 'state.db'),
      CHICKPEA_AUTH_DB_PATH: join(directory, 'auth.db'),
    }, async () => {
      const { getIdentityStore } = await import('../src/config/state-backend.ts');
      const config = getConfigStore();
      const identity = getIdentityStore();
      const account = {
        id: 'connection_test', workspaceId: 'T_TEST', providerId: 'test', label: 'Test MCP',
        ownerKind: 'team', lifecycle: 'ready', secretRefId: 'connection_test',
        policy: {
          kind: 'mcp', url: 'https://mcp.example.com/mcp', transport: 'streamable-http',
          discoveredTools: [{ name: 'search' }], allowedTools: ['search'], ...policy,
        },
      };
      const binding = { agentId: 'agent_test', connectionAccountId: account.id, providerId: 'test', enabled: true, allowedCapabilities: [] };
      t.mock.method(identity, 'getOrganization', async () => ({ id: 'org', slackTeamId: 'T_TEST' }));
      t.mock.method(identity, 'getMembership', async () => ({
        id: 'member', userId: 'user', organizationId: 'org', status: options.active === false ? 'suspended' : 'active',
      }));
      t.mock.method(identity, 'getMembershipAccessOverlay', async () => null);
      t.mock.method(identity, 'getUser', async () => ({ id: 'user', slackTeamId: 'T_TEST', slackUserId: 'U_TEST' }));
      t.mock.method(identity, 'resolveSlackIdentity', async () => ({ user: { id: 'user' }, membership: { id: 'member' }, binding: { membershipId: 'member' } }));
      t.mock.method(config, 'listConnectionAccounts', async () => [account]);
      t.mock.method(config, 'listAgentConnectionBindings', async () => [binding]);
      if (options.secret) await saveConnectionAccountSecret(account.secretRefId, options.secret);
      const captured: Request[] = [];
      const [definition] = resolveRuntimePlanMcpConnections('agent_test', [{
        id: account.id, url: 'https://mcp.example.com/mcp', transport: 'streamable-http',
        authMode: policy.authMode as 'none' | 'bearer',
        headerNames: policy.headerNames.map((name) => name.toLowerCase()),
        allowedTools: ['search'], optional: true,
      }], undefined, { workspaceId: 'T_TEST', actorMembershipId: 'member' }, {
        createGuardedFetch: () => (async (input, init) => {
          captured.push(new Request(input, init));
          return new Response('{}');
        }) as typeof fetch,
      });
      try {
        await definition!.fetch!('https://mcp.example.com/mcp', {
          method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        });
      } catch (error) {
        assert.equal(captured.length, 0, 'a rejected request never reaches the provider');
        return { error };
      }
      assert.equal(captured.length, 1);
      return { headers: captured[0]!.headers };
    });
  } finally {
    t.mock.restoreAll();
    closeNodeStateStores();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('account-backed runtime MCP applies the preset credential header and prefix', async (t) => {
  const result = await accountMcpRequest(t, {
    authMode: 'none', headerNames: ['Authorization'],
    credentialHeaderName: 'Authorization', credentialValuePrefix: 'Sentry-Bearer ',
  }, { secret: 'sentry-user-token' });
  assert.ok('headers' in result);
  assert.equal(result.headers.get('authorization'), 'Sentry-Bearer sentry-user-token');
});

test('account-backed runtime MCP does not double a prefix the stored credential already has', async (t) => {
  const result = await accountMcpRequest(t, {
    authMode: 'none', headerNames: ['Authorization'],
    credentialHeaderName: 'Authorization', credentialValuePrefix: 'Sentry-Bearer ',
  }, { secret: 'Sentry-Bearer stored-token' });
  assert.ok('headers' in result);
  assert.equal(result.headers.get('authorization'), 'Sentry-Bearer stored-token');
});

test('an optional account MCP credential falls back to anonymous access', async (t) => {
  const result = await accountMcpRequest(t, {
    authMode: 'none', headerNames: ['x-api-key'], credentialHeaderName: 'x-api-key', credentialOptional: true,
  });
  assert.ok('headers' in result);
  assert.equal(result.headers.get('x-api-key'), null);
});

test('an optional account MCP credential still fails closed for an inactive actor', async (t) => {
  const result = await accountMcpRequest(t, {
    authMode: 'none', headerNames: ['x-api-key'], credentialHeaderName: 'x-api-key', credentialOptional: true,
  }, { secret: 'api-key', active: false });
  assert.ok('error' in result);
  assert.match(String(result.error), /not available to this actor/);
});

test('a required account MCP credential never falls back to anonymous access', async (t) => {
  const result = await accountMcpRequest(t, { authMode: 'bearer', headerNames: [] });
  assert.ok('error' in result);
  assert.ok(result.error instanceof ConnectionCredentialUnavailableError);
});
