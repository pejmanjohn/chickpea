import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { projectMcpToolInputSchema } from '../src/config/mcp-test.ts';
import {
  resolveProfileMcpConnections,
  resolveRuntimePlanMcpConnections,
} from '../src/config/profile-mcp.ts';
import { META_ADS_OWNERSHIP_ORIGIN } from '../src/config/meta-ads-write-guard.ts';
import { projectEffectiveMcpConnections } from '../src/connections/runtime.ts';
import {
  closeNodeStateStores,
  getConfigStore,
} from '../src/config/state-backend.ts';
import type { McpConnectionConfig } from '../src/config/types.ts';
import type { RuntimePlanMcpConnectionV2 } from '../src/agents/runtime-plan.ts';
import type { EffectiveConnectionAccount } from '../src/connections/types.ts';
import { withEnv } from './helpers/env.ts';

const WRITE_TOOL = 'ads_update_entity';
const META_URL = 'https://mcp.facebook.com/ads';
const MANAGEMENT_SCOPE = 'ads_mcp_management ads_management';
const TOKEN = 'meta-write-token';
const ARGUMENTS = {
  ad_account_id: 'act_123',
  entity_id: '987654321',
  entity_type: 'campaign',
};
type GuardedFetchFactory = NonNullable<
  Parameters<typeof resolveProfileMcpConnections>[1]['createGuardedFetch']
>;
const NO_SECRETS_ENV = undefined;

function writeInputProjection() {
  const projection = projectMcpToolInputSchema({
    type: 'object',
    required: ['ad_account_id', 'entity_id', 'entity_type'],
    properties: {
      ad_account_id: { type: 'string' },
      entity_id: { type: 'string' },
      entity_type: { type: 'string', enum: ['campaign', 'ad_set', 'ad'] },
      fields: { type: 'object', properties: {
        daily_budget: { type: 'string' },
        status: { type: 'string' },
      } },
    },
    additionalProperties: false,
  }, WRITE_TOOL);
  assert.equal(projection.ambiguous, false, 'synthetic provider-shaped write schema must be admitted');
  return projection;
}

function metaWriteServer(overrides: Partial<McpConnectionConfig> = {}): McpConnectionConfig {
  return {
    id: 'meta',
    displayName: 'Meta Ads',
    url: META_URL,
    transport: 'streamable-http',
    authMode: 'oauth',
    headerNames: [],
    enabled: true,
    lifecycleStatus: 'ready',
    statusText: '',
    presetId: 'meta-ads',
    oauthAttemptId: '11111111-1111-4111-8111-111111111111',
    oauthScope: MANAGEMENT_SCOPE,
    discoveredTools: [{ name: WRITE_TOOL, inputSchema: writeInputProjection() }],
    allowedTools: [WRITE_TOOL],
    toolPolicies: {
      [WRITE_TOOL]: {
        effect: 'write',
        argumentConstraints: { ad_account_id: ['act_123'] },
      },
    },
    ...overrides,
  };
}

function effectiveMetaConnection(oauthAttemptId: string): EffectiveConnectionAccount {
  const server = metaWriteServer({ oauthAttemptId });
  const policy = {
    kind: 'mcp' as const,
    url: server.url,
    transport: server.transport,
    authMode: server.authMode,
    headerNames: [...server.headerNames],
    discoveredTools: [...server.discoveredTools],
    toolPolicies: server.toolPolicies!,
    allowedTools: [...server.allowedTools],
    oauthScope: MANAGEMENT_SCOPE,
    oauthAttemptId,
    presetId: 'meta-ads',
  };
  return {
    account: {
      id: 'connection_meta',
      workspaceId: 'T_TEST',
      revision: 1,
      ownerKind: 'team',
      createdByMembershipId: 'membership_owner',
      providerId: 'meta-ads',
      label: 'Meta Ads',
      policy,
      secretRefId: 'connection-account:connection_meta',
      lifecycle: 'ready',
      createdAt: 1,
      updatedAt: 1,
    },
    binding: {
      agentId: 'agent_meta',
      connectionAccountId: 'connection_meta',
      providerId: 'meta-ads',
      allowedCapabilities: [WRITE_TOOL],
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
    policy,
    scope: 'team',
  };
}

function toolCall(name = WRITE_TOOL, argumentsValue: unknown = ARGUMENTS): Request {
  return new Request(META_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: argumentsValue },
    }),
  });
}

function orderedProvider(
  ownerAccountId = '123',
  beforeOwnershipResponse?: () => void | Promise<void>,
  configuredStatus?: unknown,
) {
  const events: string[] = [];
  const requests: Request[] = [];
  const createGuardedFetch = ((options: { allowedOrigin: string }) => {
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      requests.push(request);
      if (options.allowedOrigin === META_ADS_OWNERSHIP_ORIGIN) {
        events.push('ownership GET');
        assert.equal(request.method, 'GET');
        assert.equal(request.headers.get('authorization'), `Bearer ${TOKEN}`);
        await beforeOwnershipResponse?.();
        return Response.json({
          id: ARGUMENTS.entity_id,
          account_id: ownerAccountId,
          ...(configuredStatus === undefined ? {} : { configured_status: configuredStatus }),
        });
      }
      events.push('MCP POST');
      assert.equal(request.method, 'POST');
      return Response.json({ jsonrpc: '2.0', id: 1, result: { content: [] } });
    };
  }) as GuardedFetchFactory;
  return { events, requests, createGuardedFetch };
}

function runtimeDeclaration(server: McpConnectionConfig): RuntimePlanMcpConnectionV2 {
  return {
    id: server.id,
    presetId: server.presetId!,
    displayName: server.displayName,
    url: server.url,
    transport: server.transport,
    authMode: server.authMode,
    headerNames: [...server.headerNames],
    oauthScope: server.oauthScope!,
    oauthAttemptId: server.oauthAttemptId!,
    allowedTools: [WRITE_TOOL],
    writeTools: [WRITE_TOOL],
    toolArgumentConstraints: {
      [WRITE_TOOL]: { ad_account_id: ['act_123'] },
    },
    optional: true,
  };
}

test('native direct profile MCP verifies ownership before sending a selected write', async () => {
  const server = metaWriteServer();
  const provider = orderedProvider();
  const [definition] = resolveProfileMcpConnections([server], {
    agentId: 'agent_direct_meta_write',
    env: NO_SECRETS_ENV,
    resolveCurrentConnection: async () => server,
    createGuardedFetch: provider.createGuardedFetch,
  });
  assert.deepEqual(definition?.tools, [WRITE_TOOL]);
  await definition!.fetch!(toolCall());
  assert.deepEqual(provider.events, ['ownership GET', 'MCP POST']);
});

test('native direct profile MCP rejects a bundled budget and pause before any provider egress', async () => {
  const server = metaWriteServer();
  const provider = orderedProvider();
  const [definition] = resolveProfileMcpConnections([server], {
    agentId: 'agent_direct_meta_mixed_status_write',
    env: NO_SECRETS_ENV,
    resolveCurrentConnection: async () => server,
    createGuardedFetch: provider.createGuardedFetch,
  });
  await assert.rejects(definition!.fetch!(toolCall(WRITE_TOOL, {
    ...ARGUMENTS,
    fields: { daily_budget: '22500', status: 'PAUSED' },
  })), /status-only update/);
  assert.deepEqual(provider.events, []);
});

test('native direct profile MCP blocks an active budget update before MCP dispatch', async () => {
  const server = metaWriteServer();
  const provider = orderedProvider('123', undefined, 'ACTIVE');
  const [definition] = resolveProfileMcpConnections([server], {
    agentId: 'agent_direct_meta_active_budget_write',
    env: NO_SECRETS_ENV,
    resolveCurrentConnection: async () => server,
    createGuardedFetch: provider.createGuardedFetch,
  });
  await assert.rejects(definition!.fetch!(toolCall(WRITE_TOOL, {
    ...ARGUMENTS,
    fields: { daily_budget: '22500' },
  })), /may pause an active campaign.*Ads Manager/);
  assert.deepEqual(provider.events, ['ownership GET']);
  assert.equal(new URL(provider.requests[0]!.url).searchParams.get('fields'),
    'id,account_id,configured_status');
});

test('RuntimePlanV2 verifies ownership before sending a selected write', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-meta-write-runtime-plan-'));
  const agentId = 'agent_runtime_plan_meta_write';
  const server = metaWriteServer();
  const provider = orderedProvider();
  try {
    await withEnv({
      SLACK_STATE_DB_PATH: join(directory, 'state.db'),
      CHICKPEA_AUTH_DB_PATH: join(directory, 'auth.db'),
    }, async () => {
      await getConfigStore().createAgent({
        id: agentId,
        name: 'Runtime Meta writer',
        instructions: 'Exercise synthetic Meta write policy.',
        enabled: true,
        model: 'local-stub/meta-write',
        skills: [],
        mcpServers: [server],
        apiConnections: [],
        repositories: [],
      });
      const [definition] = resolveRuntimePlanMcpConnections(
        agentId,
        [runtimeDeclaration(server)],
        undefined,
        undefined,
        { createGuardedFetch: provider.createGuardedFetch },
      );
      await definition!.fetch!(toolCall());
      assert.deepEqual(provider.events, ['ownership GET', 'MCP POST']);
    });
  } finally {
    closeNodeStateStores();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('RuntimePlanV2 blocks a write when Graph reports the wrong owner', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-meta-write-runtime-owner-'));
  const agentId = 'agent_runtime_plan_wrong_owner';
  const server = metaWriteServer();
  const provider = orderedProvider('999');
  try {
    await withEnv({
      SLACK_STATE_DB_PATH: join(directory, 'state.db'),
      CHICKPEA_AUTH_DB_PATH: join(directory, 'auth.db'),
    }, async () => {
      await getConfigStore().createAgent({
        id: agentId,
        name: 'Runtime Meta owner check',
        instructions: 'Exercise synthetic Meta write policy.',
        enabled: true,
        model: 'local-stub/meta-write',
        skills: [],
        mcpServers: [server],
        apiConnections: [],
        repositories: [],
      });
      const [definition] = resolveRuntimePlanMcpConnections(
        agentId,
        [runtimeDeclaration(server)],
        undefined,
        undefined,
        { createGuardedFetch: provider.createGuardedFetch },
      );
      await assert.rejects(definition!.fetch!(toolCall()), /could not verify.*No ad changes were sent/i);
      assert.deepEqual(provider.events, ['ownership GET']);
    });
  } finally {
    closeNodeStateStores();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('RuntimePlanV2 revocation during ownership preflight blocks MCP dispatch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-meta-write-runtime-revoked-'));
  const agentId = 'agent_runtime_plan_revoked';
  const frozen = metaWriteServer();
  const provider = orderedProvider('123', async () => {
    await getConfigStore().updateAgent(agentId, {
      mcpServers: [{ ...frozen, allowedTools: [] }],
    });
  });
  try {
    await withEnv({
      SLACK_STATE_DB_PATH: join(directory, 'state.db'),
      CHICKPEA_AUTH_DB_PATH: join(directory, 'auth.db'),
    }, async () => {
      await getConfigStore().createAgent({
        id: agentId,
        name: 'Runtime Meta revoked writer',
        instructions: 'Exercise synthetic Meta write policy.',
        enabled: true,
        model: 'local-stub/meta-write',
        skills: [],
        mcpServers: [frozen],
        apiConnections: [],
        repositories: [],
      });
      const [definition] = resolveRuntimePlanMcpConnections(
        agentId,
        [runtimeDeclaration(frozen)],
        undefined,
        undefined,
        { createGuardedFetch: provider.createGuardedFetch },
      );
      await assert.rejects(definition!.fetch!(toolCall()), /policy changed/);
      assert.deepEqual(provider.events, ['ownership GET']);
    });
  } finally {
    closeNodeStateStores();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('RuntimePlanV2 rejects OAuth reconnection after admission before Graph or MCP', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-meta-write-runtime-reconnected-'));
  const agentId = 'agent_runtime_plan_reconnected';
  const frozen = metaWriteServer();
  try {
    await withEnv({
      SLACK_STATE_DB_PATH: join(directory, 'state.db'),
      CHICKPEA_AUTH_DB_PATH: join(directory, 'auth.db'),
    }, async () => {
      const config = getConfigStore();
      await config.createAgent({
        id: agentId,
        name: 'Runtime Meta reconnected writer',
        instructions: 'Exercise synthetic Meta write policy.',
        enabled: true,
        model: 'local-stub/meta-write',
        skills: [],
        mcpServers: [frozen],
        apiConnections: [],
        repositories: [],
      });
      const provider = orderedProvider();
      const [definition] = resolveRuntimePlanMcpConnections(
        agentId,
        [runtimeDeclaration(frozen)],
        undefined,
        undefined,
        { createGuardedFetch: provider.createGuardedFetch },
      );
      await config.updateAgent(agentId, {
        mcpServers: [{
          ...frozen,
          oauthAttemptId: '22222222-2222-4222-8222-222222222222',
        }],
      });
      await assert.rejects(definition!.fetch!(toolCall()), /policy changed/);
      assert.deepEqual(provider.events, []);
    });
  } finally {
    closeNodeStateStores();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('RuntimePlanV2 rejects a dropped Meta preset marker before any outbound request', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-meta-write-runtime-preset-'));
  const agentId = 'agent_runtime_plan_dropped_preset';
  const server = metaWriteServer({ url: 'https://mcp.example.com/mcp' });
  const declarationWithoutPreset = runtimeDeclaration(server);
  delete declarationWithoutPreset.presetId;
  const provider = orderedProvider();
  try {
    await withEnv({
      SLACK_STATE_DB_PATH: join(directory, 'state.db'),
      CHICKPEA_AUTH_DB_PATH: join(directory, 'auth.db'),
    }, async () => {
      await getConfigStore().createAgent({
        id: agentId,
        name: 'Runtime Meta missing preset',
        instructions: 'Exercise synthetic Meta write policy.',
        enabled: true,
        model: 'local-stub/meta-write',
        skills: [],
        mcpServers: [server],
        apiConnections: [],
        repositories: [],
      });
      const [definition] = resolveRuntimePlanMcpConnections(
        agentId,
        [declarationWithoutPreset],
        undefined,
        undefined,
        { createGuardedFetch: provider.createGuardedFetch },
      );
      await assert.rejects(definition!.fetch!(toolCall()), /policy changed/);
      assert.deepEqual(provider.events, []);
    });
  } finally {
    closeNodeStateStores();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a wrong owner blocks the MCP write', async () => {
  const server = metaWriteServer();
  const provider = orderedProvider('999');
  const [definition] = resolveProfileMcpConnections([server], {
    agentId: 'agent_wrong_owner',
    env: NO_SECRETS_ENV,
    resolveCurrentConnection: async () => server,
    createGuardedFetch: provider.createGuardedFetch,
  });
  await assert.rejects(definition!.fetch!(toolCall()), /could not verify.*No ad changes were sent/i);
  assert.deepEqual(provider.events, ['ownership GET']);
});

test('revocation during ownership preflight blocks MCP dispatch', async () => {
  const frozen = metaWriteServer();
  let current = frozen;
  const provider = orderedProvider('123', () => {
    current = { ...frozen, allowedTools: [] };
  });
  const [definition] = resolveProfileMcpConnections([frozen], {
    agentId: 'agent_revoked_during_preflight',
    env: NO_SECRETS_ENV,
    resolveCurrentConnection: async () => current,
    createGuardedFetch: provider.createGuardedFetch,
  });
  await assert.rejects(definition!.fetch!(toolCall()), /policy changed/);
  assert.deepEqual(provider.events, ['ownership GET']);
});

test('read-only OAuth scope blocks writes before Graph or Meta MCP', async () => {
  const server = metaWriteServer({ oauthScope: 'ads_mcp_management ads_read' });
  const provider = orderedProvider();
  const [definition] = resolveProfileMcpConnections([server], {
    agentId: 'agent_read_scope_meta_write',
    env: NO_SECRETS_ENV,
    resolveCurrentConnection: async () => server,
    createGuardedFetch: provider.createGuardedFetch,
  });
  await assert.rejects(definition!.fetch!(toolCall()), /Reconnect Meta Ads with Reporting and editing access/);
  assert.deepEqual(provider.events, []);
});

test('bearer authentication blocks Meta writes before Graph or Meta MCP', async () => {
  const server = metaWriteServer({ authMode: 'bearer' });
  const provider = orderedProvider();
  const [definition] = resolveProfileMcpConnections([server], {
    agentId: 'agent_bearer_meta_write',
    env: NO_SECRETS_ENV,
    resolveCurrentConnection: async () => server,
    createGuardedFetch: provider.createGuardedFetch,
  });
  await assert.rejects(definition!.fetch!(toolCall()), /Reconnect Meta Ads with Reporting and editing access/);
  assert.deepEqual(provider.events, []);
});

test('OAuth reconnection during ownership preflight blocks MCP dispatch', async () => {
  const effective = effectiveMetaConnection('11111111-1111-4111-8111-111111111111');
  const [frozen] = projectEffectiveMcpConnections([effective]);
  assert.ok(frozen);
  let current = frozen;
  const provider = orderedProvider('123', () => {
    const reconnected = effectiveMetaConnection('22222222-2222-4222-8222-222222222222');
    const [projected] = projectEffectiveMcpConnections([reconnected]);
    assert.ok(projected);
    current = projected;
  });
  const [definition] = resolveProfileMcpConnections([frozen], {
    agentId: 'agent_reconnected_during_preflight',
    env: NO_SECRETS_ENV,
    resolveCurrentConnection: async () => current,
    createGuardedFetch: provider.createGuardedFetch,
  });
  await assert.rejects(definition!.fetch!(toolCall()), /policy changed/);
  assert.deepEqual(provider.events, ['ownership GET']);
});

test('unselected and unknown tools never reach Meta MCP', async () => {
  const server = metaWriteServer();
  const provider = orderedProvider();
  const [definition] = resolveProfileMcpConnections([server], {
    agentId: 'agent_unselected_meta_write',
    env: NO_SECRETS_ENV,
    resolveCurrentConnection: async () => server,
    createGuardedFetch: provider.createGuardedFetch,
  });
  for (const name of ['ads_activate_entity', 'ads_future_write']) {
    await assert.rejects(definition!.fetch!(toolCall(name)), /not selected/);
  }
  assert.deepEqual(provider.events, []);
});

test('a custom server marked with the Meta preset never sends its credential to Graph', async () => {
  const customUrl = 'https://mcp.example.com/mcp';
  const server = metaWriteServer({ url: customUrl });
  const captured: Request[] = [];
  const origins: string[] = [];
  const createGuardedFetch = ((options: { allowedOrigin: string }) => {
    origins.push(options.allowedOrigin);
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      captured.push(new Request(input, init));
      return Response.json({});
    };
  }) as GuardedFetchFactory;
  const [definition] = resolveProfileMcpConnections([server], {
    agentId: 'agent_custom_meta_spoof',
    env: NO_SECRETS_ENV,
    resolveCurrentConnection: async () => server,
    createGuardedFetch,
  });
  await assert.rejects(definition!.fetch!(new Request(customUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: WRITE_TOOL,
      arguments: ARGUMENTS,
    } }),
  })), /official Meta Ads endpoint/);
  assert.deepEqual(origins, ['https://mcp.example.com']);
  assert.deepEqual(captured, []);
});
