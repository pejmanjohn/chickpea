import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import type { ToolDefinition } from '@flue/runtime';

import { classifyMcpError, safeMcpFailureText } from '../src/config/mcp-errors.ts';
import {
  connectMcp,
  discoverMcpTools,
  projectMcpToolInputSchema,
  type McpConnectInput,
  type McpServerConnection,
  type McpServerOptions,
} from '../src/config/mcp-test.ts';

// A minimal ToolDefinition stand-in — the real adapter freezes these, but for
// discovery we only read name/description (and defensively title if present).
function tool(name: string, description = '', extra: Record<string, unknown> = {}): ToolDefinition {
  return {
    name,
    description,
    input: undefined,
    output: undefined,
    run() {
      throw new Error('not used');
    },
    ...extra,
  } as ToolDefinition;
}

function fakeConnection(tools: ToolDefinition[], onClose?: () => void): McpServerConnection {
  return {
    name: 'srv',
    tools,
    async close() {
      onClose?.();
    },
  };
}

/** A connect fn that records the args it was called with and returns a preset connection. */
function stubConnect(
  connection: McpServerConnection,
): { fn: (name: string, options: McpServerOptions) => Promise<McpServerConnection>; calls: Array<{ name: string; options: McpServerOptions }> } {
  const calls: Array<{ name: string; options: McpServerOptions }> = [];
  const fn = async (name: string, options: McpServerOptions): Promise<McpServerConnection> => {
    calls.push({ name, options });
    return connection;
  };
  return { fn, calls };
}

const baseInput: McpConnectInput = {
  id: 'srv',
  url: 'https://mcp.example.com/mcp',
  transport: 'streamable-http',
  headers: {},
};

const metaInput: McpConnectInput = {
  ...baseInput,
  id: 'meta-ads',
  url: 'https://mcp.facebook.com/ads',
};

interface ProtocolToolPage {
  tools: Array<Record<string, unknown>>;
  nextCursor?: string;
}

function pagedProtocolFetch(
  pages: Record<string, ProtocolToolPage>,
  listCursors: Array<string | undefined> = [],
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const rpc = await request.json() as { id?: number; method: string; params?: { cursor?: string } };
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    if (rpc.method === 'initialize') {
      return Response.json({
        jsonrpc: '2.0', id: rpc.id,
        result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } },
      });
    }
    const cursor = rpc.params?.cursor;
    listCursors.push(cursor);
    const page = pages[cursor ?? ''];
    if (!page) throw new Error(`Unexpected tools/list cursor ${cursor ?? '<first>'}.`);
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result: page });
  };
}

function protocolTool(name: string, inputSchema: Record<string, unknown> = { type: 'object' }): Record<string, unknown> {
  return { name, inputSchema };
}

function scopedMetaSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: { ad_account_id: { type: 'string' } },
    required: ['ad_account_id'],
  };
}

const reviewedMetaToolNames = [
  'ads_get_ad_accounts',
  'ads_get_ad_entities',
  'ads_get_field_context',
  'ads_get_opportunity_score',
  'ads_insights_advertiser_context',
  'ads_insights_anomaly_signal',
  'ads_insights_auction_ranking_benchmarks',
  'ads_insights_industry_benchmark',
  'ads_insights_performance_trend',
] as const;

test('protocol discovery preserves true, false and absent read-only declarations', async () => {
  const methods: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const rpc = await request.json() as { id?: number; method: string };
    methods.push(rpc.method);
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    const result = rpc.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } }
      : { tools: [
          { name: 'task_only', inputSchema: { type: 'object' }, execution: { taskSupport: 'required' } },
          { name: 'run_query', inputSchema: { type: 'object' }, outputSchema: { type: 'object', properties: { rows: { type: 'array' } }, required: ['rows'] }, annotations: { readOnlyHint: true } },
          { name: 'get_messages', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
          { name: 'unknown', inputSchema: { type: 'object' } },
          { name: 'x'.repeat(121), inputSchema: { type: 'object' } },
          { name: 'y'.repeat(120), inputSchema: { type: 'object' } },
        ] };
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
  };
  const result = await discoverMcpTools(baseInput, undefined, () => fakeFetch);
  assert.deepEqual(result.tools.map(({ inputSchema: _inputSchema, ...entry }) => entry), [
    { name: 'run_query', readOnlyHint: true },
    { name: 'get_messages', readOnlyHint: false },
    { name: 'unknown' },
    { name: 'y'.repeat(120) },
  ]);
  assert.ok(result.tools.every((entry) => entry.inputSchema?.ambiguous === true));
  assert.ok(methods.includes('tools/list'));
});

test('Meta protocol discovery scans past 50 tools and retains reviewed reporting tools', async () => {
  const cursors: Array<string | undefined> = [];
  const first = Array.from({ length: 60 }, (_, index) =>
    protocolTool(`unsupported_${String(index).padStart(3, '0')}`));
  const fetch = pagedProtocolFetch({
    '': { tools: first, nextCursor: 'reporting' },
    reporting: {
      tools: reviewedMetaToolNames.map((name) => protocolTool(name,
        name === 'ads_get_ad_accounts' || name === 'ads_get_field_context'
          ? { type: 'object', properties: {} }
          : name === 'ads_get_ad_entities' ? {
            type: 'object', required: ['ad_account_id'], properties: {
              ad_account_id: { type: 'string' },
              client_conversation_id: { type: 'string' },
              fields: { type: 'array', items: { type: 'string' } },
              object_ids: { type: 'array', items: { type: 'string' } },
            },
          } : scopedMetaSchema())),
    },
  }, cursors);

  const result = await discoverMcpTools(metaInput, undefined, () => fetch);

  assert.deepEqual(result.tools.map((entry) => entry.name), reviewedMetaToolNames);
  assert.deepEqual(result.tools.find(({ name }) => name === 'ads_get_ad_entities')?.inputSchema?.accountFields, [
    { name: 'ad_account_id', type: 'string', required: true },
  ]);
  assert.equal(result.tools.find(({ name }) => name === 'ads_get_ad_entities')?.inputSchema?.ambiguous, false,
    'production discovery applies the exact reviewed-tool schema exception');
  assert.deepEqual(cursors, [undefined, 'reporting']);
});

test('generic protocol discovery keeps the first 50 tools and does not scan later pages', async () => {
  const cursors: Array<string | undefined> = [];
  const fetch = pagedProtocolFetch({
    '': {
      tools: Array.from({ length: 60 }, (_, index) => protocolTool(`generic_${index}`, index === 0
        ? { type: 'object', properties: { accounts: { type: 'array', items: { type: 'string' } } } }
        : { type: 'object' })),
      nextCursor: 'later',
    },
    later: { tools: [protocolTool('ads_get_ad_entities', scopedMetaSchema())] },
  }, cursors);

  const result = await discoverMcpTools(baseInput, undefined, () => fetch);

  assert.equal(result.tools.length, 50);
  assert.equal(result.tools[0]?.name, 'generic_0');
  assert.equal(result.tools[0]?.inputSchema?.ambiguous, true,
    'generic tools remain discoverable even when their schema cannot prove Meta account scoping');
  assert.equal(result.tools[49]?.name, 'generic_49');
  assert.deepEqual(cursors, [undefined]);
});

test('Meta protocol discovery fails closed for raw bounds, pagination bounds, repeated cursors and duplicate reviewed tools', async () => {
  const tooManyTools = pagedProtocolFetch({
    '': { tools: Array.from({ length: 1_025 }, (_, index) => protocolTool(`tool_${index}`)) },
  });
  const rawLimitError = await discoverMcpTools(metaInput, undefined, () => tooManyTools).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(rawLimitError instanceof Error);
  assert.match(rawLimitError.message, /exceeded the raw tool limit/);
  assert.equal(classifyMcpError(rawLimitError), 'discovery_failed');
  assert.equal(safeMcpFailureText(rawLimitError), 'Connected, but tool discovery failed.');

  const tooManyPages: Record<string, ProtocolToolPage> = {};
  for (let index = 0; index < 20; index += 1) {
    const cursor = index === 0 ? '' : `page_${index}`;
    tooManyPages[cursor] = {
      tools: [],
      nextCursor: `page_${index + 1}`,
    };
  }
  await assert.rejects(
    () => discoverMcpTools(metaInput, undefined, () => pagedProtocolFetch(tooManyPages)),
    /exceeded the page limit/,
  );

  const repeatedCursor = pagedProtocolFetch({
    '': { tools: [], nextCursor: 'same' },
    same: { tools: [], nextCursor: 'same' },
  });
  await assert.rejects(
    () => discoverMcpTools(metaInput, undefined, () => repeatedCursor),
    /repeated a cursor/,
  );

  const duplicateReviewed = pagedProtocolFetch({
    '': {
      tools: [
        ...reviewedMetaToolNames.map((name) => protocolTool(name, scopedMetaSchema())),
        ...Array.from({ length: 60 }, (_, index) => protocolTool(`unreviewed_${index}`)),
      ],
      nextCursor: 'duplicate',
    },
    duplicate: { tools: [protocolTool('ads_get_ad_entities', scopedMetaSchema())] },
  });
  await assert.rejects(
    () => discoverMcpTools(metaInput, undefined, () => duplicateReviewed),
    /duplicate reviewed tool ads_get_ad_entities/,
  );
});

test('Meta protocol discovery omits task-required reviewed tools and rejects duplicates even when one is task-only', async () => {
  const taskOnly = protocolTool('ads_insights_performance_trend', scopedMetaSchema());
  taskOnly.execution = { taskSupport: 'required' };
  const result = await discoverMcpTools(metaInput, undefined, () => pagedProtocolFetch({
    '': { tools: [
      taskOnly,
      protocolTool('ads_get_ad_entities', scopedMetaSchema()),
    ] },
  }));
  assert.deepEqual(result.tools.map((entry) => entry.name), ['ads_get_ad_entities']);

  await assert.rejects(
    () => discoverMcpTools(metaInput, undefined, () => pagedProtocolFetch({
      '': { tools: [taskOnly], nextCursor: 'duplicate' },
      duplicate: { tools: [protocolTool('ads_insights_performance_trend', scopedMetaSchema())] },
    })),
    /duplicate reviewed tool ads_insights_performance_trend/,
  );
});

test('Meta protocol discovery applies a short total deadline to a nonresponding tools/list', async () => {
  let aborted = false;
  const startedAt = Date.now();
  const createFetch = ({ signal }: { signal?: AbortSignal }): typeof fetch => async (input, init) => {
    const request = new Request(input, init);
    const rpc = await request.json() as { id?: number; method: string };
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    if (rpc.method === 'initialize') {
      return Response.json({
        jsonrpc: '2.0', id: rpc.id,
        result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } },
      });
    }
    return new Promise<Response>((_resolve, reject) => {
      const onAbort = () => {
        aborted = true;
        reject(new Error('discovery fetch aborted'));
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  };

  const error = await discoverMcpTools(
    { ...metaInput, callTimeoutMs: 20 }, undefined, createFetch,
  ).then(() => null, (reason: unknown) => reason);

  assert.ok(error instanceof Error);
  assert.equal(classifyMcpError(error), 'timeout');
  assert.equal(aborted, true);
  assert.ok(Date.now() - startedAt < 1_000, 'total discovery deadline must stop a hung page');
});

test('input-schema projection keeps exact required account evidence and fingerprints the whole schema', () => {
  const first = projectMcpToolInputSchema({
    type: 'object',
    required: ['ad_account_id'],
    properties: {
      filters: { type: 'object', oneOf: [{ required: ['date_start'] }, { required: ['date_preset'] }] },
      ad_account_id: { type: 'string' },
    },
  });
  const reordered = projectMcpToolInputSchema({
    properties: {
      ad_account_id: { type: 'string' },
      filters: { oneOf: [{ required: ['date_start'] }, { required: ['date_preset'] }], type: 'object' },
    },
    required: ['ad_account_id'],
    type: 'object',
  });
  assert.deepEqual(first.accountFields, [{ name: 'ad_account_id', type: 'string', required: true }]);
  assert.equal(first.ambiguous, false, 'unrelated nested filter alternatives do not invalidate account scope');
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(reordered.fingerprint, first.fingerprint, 'object key order does not change the schema fingerprint');
  assert.notEqual(projectMcpToolInputSchema({
    type: 'object', required: ['ad_account_id'],
    properties: { ad_account_id: { type: 'string' }, limit: { type: 'number' } },
  }).fingerprint, first.fingerprint, 'any bounded input-schema change changes the fingerprint');
});

test('input-schema projection hashes long annotations without weakening structural account checks', () => {
  const commonPrefix = 'supported reporting field '.repeat(200);
  const firstDescription = commonPrefix + 'a'.repeat(5_000);
  const secondDescription = commonPrefix + 'b'.repeat(5_000);
  assert.equal(firstDescription.length, secondDescription.length);

  const schema = (description: unknown) => ({
    type: 'object',
    required: ['ad_account_id'],
    properties: {
      fields: { type: 'array', items: { type: 'string' }, description },
      ad_account_id: { type: 'string' },
    },
  });
  const first = projectMcpToolInputSchema(schema(firstDescription));
  const reordered = projectMcpToolInputSchema({
    properties: {
      ad_account_id: { type: 'string' },
      fields: { description: firstDescription, items: { type: 'string' }, type: 'array' },
    },
    required: ['ad_account_id'],
    type: 'object',
  });

  assert.equal(first.ambiguous, false);
  assert.deepEqual(first.accountFields, [{ name: 'ad_account_id', type: 'string', required: true }]);
  assert.equal(reordered.fingerprint, first.fingerprint, 'long-string fingerprints remain deterministic');
  assert.notEqual(
    projectMcpToolInputSchema(schema(secondDescription)).fingerprint,
    first.fingerprint,
    'same-length strings with a shared prefix retain distinct full-content fingerprints',
  );
  const stringMarkerShape = {
    '$schema-string-sha256': createHash('sha256').update(JSON.stringify(firstDescription)).digest('hex'),
    length: firstDescription.length,
  };
  for (const collisionCandidate of [stringMarkerShape, [stringMarkerShape], JSON.stringify(stringMarkerShape)]) {
    assert.notEqual(
      projectMcpToolInputSchema(schema(collisionCandidate)).fingerprint,
      first.fingerprint,
      'the long-string marker cannot collide with a schema object, array, or ordinary string',
    );
  }

  assert.equal(projectMcpToolInputSchema({
    type: 'object', required: ['ad_account_id'],
    properties: {
      ad_account_id: { type: 'number', description: firstDescription },
      campaign_id: { type: 'string' },
    },
  }).ambiguous, true, 'long annotations do not make unsupported account types or selectors eligible');
});

test('input-schema projection fails closed for optional, alternate and composed account selectors', () => {
  for (const schema of [
    { type: 'object', properties: { account_id: { type: 'string' } } },
    { type: 'object', required: ['account_id'], properties: {
      account_id: { type: 'string' }, business_account_id: { type: 'string' },
    } },
    { type: 'object', required: ['account_id'], properties: {
      account_id: { type: 'string' }, accounts: { type: 'array', items: { type: 'string' } },
    } },
    { type: 'object', required: ['account_id'], properties: {
      account_id: { type: 'string' }, ad_account: { type: 'string' },
    } },
    { type: 'object', required: ['account_id'], properties: {
      account_id: { type: 'string' }, ad_accounts: { type: 'array', items: { type: 'string' } },
    } },
    { type: 'object', required: ['account_id'], properties: {
      account_id: { type: 'string' }, account: { type: 'string' },
    } },
    { type: 'object', oneOf: [{ required: ['account_id'] }], required: ['account_id'],
      properties: { account_id: { type: 'string' } } },
    { type: 'object', required: ['account_id'], properties: { account_id: { type: 'number' } } },
    { type: 'object', required: ['account_id'], properties: {
      account_id: { type: 'string' }, target: { type: 'object', properties: { ad_account_id: { type: 'string' } } },
    } },
    { type: 'object', required: ['account_id'], properties: {
      account_id: { type: 'string' }, campaign_id: { type: 'string' },
    } },
    { type: 'object', required: ['account_id'], properties: {
      account_id: { type: 'string' }, filters: { type: 'array', items: {
        type: 'object', properties: { campaign_id: { type: 'string' } },
      } },
    } },
    { type: 'object', required: ['account_id'], properties: {
      account_id: { type: 'string' }, filters: { type: 'array', prefixItems: [{
        type: 'object', properties: { ad_account_id: { type: 'string' } },
      }] },
    } },
    { type: 'object', required: ['account_id'], properties: {
      account_id: { type: 'string' }, filters: { type: 'object', additionalProperties: {
        type: 'object', properties: { entity_id: { type: 'string' } },
      } },
    } },
    { type: 'object', required: ['account_id'], properties: {
      account_id: { type: 'string' }, filters: { type: 'array', items: {
        type: 'object', properties: { accounts: { type: 'array', items: { type: 'string' } } },
      } },
    } },
    { type: 'object', required: ['account_id'], properties: {
      account_id: { type: 'string' }, filters: { type: 'object', properties: {
        ad_account: { type: 'string' },
      } },
    } },
    { type: 'object', required: ['account_id'], properties: {
      account_id: { type: 'string' }, filters: { type: 'object', properties: {
        adAccount: { type: 'string' },
      } },
    } },
  ]) {
    assert.equal(projectMcpToolInputSchema(schema).ambiguous, true);
  }
});

test('Meta projection accepts exact observed non-account IDs without weakening target selectors', () => {
  const getEntitiesSchema = {
    type: 'object',
    required: ['ad_account_id'],
    properties: {
      ad_account_id: { type: 'string' },
      advertiser_request: { type: 'string' },
      breakdowns: { type: 'array', items: { type: 'string' } },
      client_conversation_id: { type: ['string', 'null'] },
      cursor: { type: 'string' },
      date_preset: { type: 'string' },
      fields: { type: 'array', items: { type: 'string' } },
      filtering: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' } } } },
      include_additional_context: { type: 'boolean' },
      level: { type: 'string' },
      limit: { type: 'number' },
      object_ids: { type: 'array', items: { type: 'string' } },
      object_state: { type: 'string' },
      sort: { type: 'string' },
      time_increment: { type: 'number' },
      time_range: { type: 'object', properties: { since: { type: 'string' }, until: { type: 'string' } } },
    },
  };
  const projection = projectMcpToolInputSchema(getEntitiesSchema, 'ads_get_ad_entities');
  assert.equal(projection.ambiguous, false);
  assert.deepEqual(projection.accountFields, [
    { name: 'ad_account_id', type: 'string', required: true },
  ]);
  assert.deepEqual(projection.propertyNames, Object.keys(getEntitiesSchema.properties).sort());
  assert.equal(projectMcpToolInputSchema(getEntitiesSchema).ambiguous, true,
    'generic MCP schemas do not receive Meta-specific exceptions');

  const opportunityScore = {
    type: 'object', required: ['ad_account_id', 'client_conversation_id'],
    properties: {
      ad_account_id: { type: 'string' },
      advertiser_request: { type: 'string' },
      client_conversation_id: { type: 'string' },
    },
  };
  assert.equal(projectMcpToolInputSchema(
    opportunityScore, 'ads_get_opportunity_score',
  ).ambiguous, false, 'bounded correlation metadata may be required');
  for (const union of ['anyOf', 'oneOf'] as const) {
    assert.equal(projectMcpToolInputSchema({
      ...opportunityScore,
      properties: {
        ...opportunityScore.properties,
        client_conversation_id: { [union]: [{ type: 'string' }, { type: 'null' }] },
      },
    }, 'ads_get_opportunity_score').ambiguous, false,
    `canonical ${union} string/null correlation metadata is supported`);
  }
});

test('Meta projection admits only bounded accountless helper input contracts', () => {
  for (const schema of [
    { type: 'object' },
    { type: 'object', properties: {} },
    { type: 'object', properties: {
      advertiser_request: { type: 'string' },
      client_conversation_id: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      cursor: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    }, required: ['advertiser_request', 'client_conversation_id'] },
  ]) {
    const projection = projectMcpToolInputSchema(schema, 'ads_get_ad_accounts');
    assert.equal(projection.ambiguous, false);
    assert.deepEqual(projection.accountFields, []);
  }
  const fieldContext = projectMcpToolInputSchema({
    type: 'object',
    required: ['advertiser_request', 'client_conversation_id', 'field_names'],
    properties: {
      advertiser_request: { type: 'string' },
      client_conversation_id: { type: ['string', 'null'] },
      field_names: { type: 'array', items: { type: 'string' } },
    },
  }, 'ads_get_field_context');
  assert.equal(fieldContext.ambiguous, false);
  assert.deepEqual(fieldContext.propertyNames, [
    'advertiser_request', 'client_conversation_id', 'field_names',
  ]);
  for (const [name, schema] of [
    ['required pagination', { type: 'object', required: ['cursor'], properties: { cursor: { type: 'string' } } }],
    ['unknown input', { type: 'object', properties: { fields: { type: 'array' } } }],
    ['account selector', { type: 'object', properties: { ad_account_id: { type: 'string' } } }],
    ['nested selector', { type: 'object', properties: { filter: { type: 'object', properties: { campaign_id: { type: 'string' } } } } }],
  ] as const) {
    assert.equal(projectMcpToolInputSchema(schema, 'ads_get_ad_accounts').ambiguous, true, name);
  }
  assert.equal(projectMcpToolInputSchema({ type: 'object', properties: { field: { type: 'string' } } },
    'ads_get_field_context').ambiguous, true);
  assert.equal(projectMcpToolInputSchema({ type: 'object', properties: {
    field_names: { type: 'string' },
  } }, 'ads_get_field_context').ambiguous, true, 'field names must use the declared string-array shape');
  assert.equal(projectMcpToolInputSchema({ type: 'object', properties: {
    advertiser_request: { type: ['string', 'null'] },
  } }, 'ads_get_field_context').ambiguous, true, 'advertiser request uses the conservative direct-string contract');
  assert.equal(projectMcpToolInputSchema({ type: 'object', properties: {
    client_conversation_id: { $ref: '#/$defs/conversation' },
  } }, 'ads_get_field_context').ambiguous, true, 'correlation metadata references remain unsupported');
  assert.equal(projectMcpToolInputSchema({ type: 'object', properties: {
    field_names: { type: 'array', items: { $ref: '#/$defs/field' } },
  } }, 'ads_get_field_context').ambiguous, true, 'field name item references remain unsupported');
});

test('Meta write projection requires exact account and ownership routing fields', () => {
  const project = (name: string, required: string[], properties: Record<string, unknown>) =>
    projectMcpToolInputSchema({ type: 'object', required, properties }, name);
  const account = { ad_account_id: { type: 'string' } };

  assert.equal(project('ads_create_campaign', ['ad_account_id'], {
    ...account, name: { type: 'string' }, status: { type: 'string' },
  }).ambiguous, false);
  assert.equal(project('ads_create_ad_set', ['ad_account_id', 'campaign_id'], {
    ...account, campaign_id: { type: 'string' },
    targeting: { type: 'object', properties: {
      custom_audiences: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
    } },
  }).ambiguous, false, 'known targeting payload IDs do not become mutation targets');
  assert.equal(project('ads_create_creative', ['ad_account_id', 'page_id', 'object_story_id'], {
    ...account, page_id: { type: 'string' }, instagram_user_id: { type: ['string', 'null'] },
    object_story_id: { type: 'string' },
    creative: { type: 'object', properties: { id: { type: 'string' } } },
  }).ambiguous, false, 'required and optional reference IDs retain scalar shapes');
  assert.equal(project('ads_boost_ig_post', ['ad_account_id', 'ig_account_id', 'ig_media_id'], {
    ...account, ig_account_id: { type: 'string' }, ig_media_id: { type: 'string' },
  }).ambiguous, false);
  assert.equal(project('ads_update_entity', ['ad_account_id', 'entity_id', 'entity_type'], {
    ...account, entity_id: { type: 'string' }, entity_type: { type: 'string' },
    fields: { type: 'string' },
  }).ambiguous, false, 'JSON-string update fields are checked at invocation');
  assert.equal(project('ads_update_custom_audience', ['custom_audience_id'], {
    custom_audience_id: { type: 'string' }, name: { type: 'string' },
  }).ambiguous, false, 'accountless audience writes retain one required ownership target');
  assert.equal(project('ads_update_custom_audience_users', ['audience_id'], {
    audience_id: { type: 'string' }, payload: { type: 'object', properties: {
      users: { type: 'array', items: { type: 'object', properties: { extern_id: { type: 'string' } } } },
    } },
  }).ambiguous, false);

  for (const [label, projection] of [
    ['missing account', project('ads_create_campaign', [], { name: { type: 'string' } })],
    ['optional account', project('ads_create_campaign', [], { ...account })],
    ['two accounts', project('ads_create_campaign', ['ad_account_id', 'account_id'], {
      ...account, account_id: { type: 'string' },
    })],
    ['missing parent', project('ads_create_ad_set', ['ad_account_id'], { ...account })],
    ['nullable parent', project('ads_create_ad', ['ad_account_id', 'ad_set_id'], {
      ...account, ad_set_id: { type: ['string', 'null'] },
    })],
    ['missing entity type', project('ads_update_entity', ['ad_account_id', 'entity_id'], {
      ...account, entity_id: { type: 'string' },
    })],
    ['wrong audience target', project('ads_update_custom_audience_users', ['custom_audience_id'], {
      custom_audience_id: { type: 'string' },
    })],
    ['unknown top-level ID', project('ads_create_campaign', ['ad_account_id'], {
      ...account, business_id: { type: 'string' },
    })],
    ['unknown nested routing', project('ads_create_campaign', ['ad_account_id'], {
      ...account, payload: { type: 'object', properties: { campaign_id: { type: 'string' } } },
    })],
    ['unknown nested account selector', project('ads_create_campaign', ['ad_account_id'], {
      ...account, payload: { type: 'object', properties: { ad_account_id: { type: 'string' } } },
    })],
    ['composed reference', project('ads_create_creative', ['ad_account_id'], {
      ...account, page_id: { anyOf: [{ type: 'string' }, { type: 'number' }] },
    })],
  ] as const) {
    assert.equal(projection.ambiguous, true, label);
  }
});

test('Meta write projection retains bounded large schemas and closes blocked or nested alternate routes', () => {
  const optionalProperties = Object.fromEntries(Array.from({ length: 70 }, (_, index) => [
    `provider_option_${String(index).padStart(2, '0')}`,
    { type: 'string' },
  ]));
  const adSet = projectMcpToolInputSchema({
    type: 'object',
    required: ['ad_account_id', 'campaign_id'],
    properties: {
      ad_account_id: { type: 'string' },
      campaign_id: { type: 'string' },
      campaign_spec: { type: 'object', properties: { campaign_id: { type: 'string' } } },
      brand_audience_id: { type: ['string', 'null'] },
      ...optionalProperties,
    },
  }, 'ads_create_ad_set');
  assert.equal(adSet.ambiguous, false);
  assert.equal(adSet.propertyNames.length, 74);
  assert.ok(adSet.propertyNames.includes('campaign_id'));

  const oversizedProperties = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [
    `provider_option_${String(index).padStart(3, '0')}`,
    { type: 'string' },
  ]));
  assert.equal(projectMcpToolInputSchema({
    type: 'object', required: ['ad_account_id'],
    properties: { ad_account_id: { type: 'string' }, ...oversizedProperties },
  }, 'ads_create_campaign').ambiguous, true, 'schemas beyond the full-schema key bound stay unavailable');

  assert.equal(projectMcpToolInputSchema({
    type: 'object', required: ['ad_account_id', 'entity_id', 'entity_type', 'object_ids'],
    properties: {
      ad_account_id: { type: 'string' }, entity_id: { type: 'string' }, entity_type: { type: 'string' },
      object_ids: { type: 'array', items: { type: 'string' } },
    },
  }, 'ads_activate_entity').ambiguous, true, 'a required bulk route cannot be removed at runtime');

  for (const [label, required, entityDefinition] of [
    ['optional', ['ad_account_id', 'entity_type'], { type: 'string' }],
    ['nullable', ['ad_account_id', 'entity_id', 'entity_type'], { type: ['string', 'null'] }],
  ] as const) {
    assert.equal(projectMcpToolInputSchema({
      type: 'object', required,
      properties: {
        ad_account_id: { type: 'string' }, entity_id: entityDefinition, entity_type: { type: 'string' },
        object_ids: { type: 'array', items: { type: 'string' } },
      },
    }, 'ads_activate_entity').ambiguous, true, `${label} entity_id cannot prove one ownership target`);
  }

  assert.equal(projectMcpToolInputSchema({
    type: 'object', required: ['ad_account_id', 'entity_id', 'entity_type'],
    properties: {
      ad_account_id: { type: 'string' }, entity_id: { type: 'string' }, entity_type: { type: 'string' },
      object_ids: { type: 'array', items: { type: 'string' }, default: [] },
    },
  }, 'ads_activate_entity').ambiguous, true, 'a blocked route with a provider default cannot be omitted safely');

  assert.equal(projectMcpToolInputSchema({
    type: 'object', required: ['ad_account_id', 'campaign_id'],
    properties: {
      ad_account_id: { type: 'string' }, campaign_id: { type: 'string' },
      targeting: { type: 'object', properties: { ad_account_id: { type: 'string' } } },
    },
  }, 'ads_create_ad_set').ambiguous, true, 'known payloads cannot introduce a nested account route');
});

test('Meta projection keeps entity filters optional and unknown or nested selectors closed', () => {
  const schema = (required: string[], properties: Record<string, unknown>) => ({
    type: 'object', required, properties: { ad_account_id: { type: 'string' }, ...properties },
  });
  assert.equal(projectMcpToolInputSchema(schema(['ad_account_id'], {
    object_ids: { type: 'array', items: { type: 'string' } },
  }), 'ads_get_ad_entities').ambiguous, false);
  assert.equal(projectMcpToolInputSchema(schema(['ad_account_id', 'object_ids'], {
    object_ids: { type: 'array', items: { type: 'string' } },
  }), 'ads_get_ad_entities').ambiguous, true, 'required entity targets remain unsupported');
  assert.equal(projectMcpToolInputSchema(schema(['ad_account_id'], {
    object_ids: { type: 'array', items: { type: 'string' } },
  }), 'ads_get_opportunity_score').ambiguous, true, 'exceptions are tool-specific');
  assert.equal(projectMcpToolInputSchema(schema(['ad_account_id'], {
    campaign_id: { type: 'string' },
  }), 'ads_get_ad_entities').ambiguous, true, 'unknown target selectors remain unsupported');
  assert.equal(projectMcpToolInputSchema(schema(['ad_account_id'], {
    filtering: { type: 'array', items: {
      type: 'object', properties: { campaign_id: { type: 'string' } },
    } },
  }), 'ads_get_ad_entities').ambiguous, true, 'nested target selectors remain unsupported');
  assert.equal(projectMcpToolInputSchema(schema(['ad_account_id'], {
    client_conversation_id: { type: 'number' },
  }), 'ads_get_ad_entities').ambiguous, true, 'correlation metadata must remain a bounded string');
  for (const clientConversationSchema of [
    { anyOf: [{ type: 'string' }, { $ref: '#/$defs/null' }] },
    { oneOf: [{ type: 'string' }, { type: 'object' }] },
    { anyOf: [{ type: 'string' }, { type: 'null' }, { type: 'number' }] },
    { anyOf: [{ type: 'string' }, { type: 'null', oneOf: [{ type: 'null' }] }] },
  ]) {
    assert.equal(projectMcpToolInputSchema(schema(['ad_account_id'], {
      client_conversation_id: clientConversationSchema,
    }), 'ads_get_ad_entities').ambiguous, true,
    'refs, object/third branches, and nested composition remain unsupported');
  }
});

test('input-schema projection bounds oversized property names without retaining them', () => {
  const oversized = 'x'.repeat(100_000);
  const projection = projectMcpToolInputSchema({
    type: 'object', required: ['account_id'],
    properties: { account_id: { type: 'string' }, [oversized]: { type: 'string' } },
  });
  assert.equal(projection.ambiguous, true);
  assert.deepEqual(projection.propertyNames, ['account_id']);
  assert.match(projection.fingerprint, /^[a-f0-9]{64}$/);
});

test('MCP output-schema discovery works when dynamic code generation is forbidden', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, [
    '--disallow-code-generation-from-strings', '--import', 'tsx', '--test',
    '--test-name-pattern=^protocol discovery', new URL(import.meta.url).pathname,
  ], { encoding: 'utf8', timeout: 30_000, env });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.match(child.stdout, /protocol discovery preserves/);
});

test('discoverMcpTools maps tools, strips the mcp__<id>__ prefix, and closes', async () => {
  let closed = false;
  const conn = fakeConnection(
    [tool('mcp__srv__search', 'Search things'), tool('mcp__srv__create', 'Create things')],
    () => {
      closed = true;
    },
  );
  const { fn } = stubConnect(conn);

  const result = await discoverMcpTools(baseInput, fn);

  assert.deepEqual(
    result.tools.map((t) => t.name),
    ['search', 'create'],
  );
  assert.equal(result.tools[0]?.description, 'Search things');
  assert.equal(closed, true, 'discover must close the connection');
});

test('injected Meta discovery scans the bounded adapter catalog but returns only reviewed schema-less tools', async () => {
  const unreviewed = Array.from({ length: 60 }, (_, index) =>
    tool(`mcp__meta-ads__unsupported_${index}`));
  const reviewed = reviewedMetaToolNames.map((name) => tool(`mcp__meta-ads__${name}`));
  const { fn } = stubConnect(fakeConnection([...unreviewed, ...reviewed]));

  const result = await discoverMcpTools(metaInput, fn);

  assert.deepEqual(result.tools.map((entry) => entry.name), reviewedMetaToolNames);
  assert.ok(result.tools.every((entry) => entry.inputSchema === undefined));
});

test('discoverMcpTools passes id as the server name and callTimeoutMs to connect', async () => {
  const { fn, calls } = stubConnect(fakeConnection([]));
  await discoverMcpTools({ ...baseInput, callTimeoutMs: 12_345 }, fn);
  assert.equal(calls[0]?.name, 'srv');
  assert.equal(calls[0]?.options.timeoutMs, 12_345);
  assert.equal(calls[0]?.options.transport, 'streamable-http');
  assert.equal(typeof calls[0]?.options.fetch, 'function', 'every MCP connect gets guarded fetch');
});

test('discoverMcpTools defaults callTimeoutMs to 30000', async () => {
  const { fn, calls } = stubConnect(fakeConnection([]));
  await discoverMcpTools(baseInput, fn);
  assert.equal(calls[0]?.options.timeoutMs, 30_000);
});

test('discoverMcpTools preserves supported identifiers, omits overlong names and truncates descriptions', async () => {
  // Flue's adapter folds any MCP title into the description, so the adapted
  // ToolDefinition never carries a title — we surface name + description only.
  const longName = 'a'.repeat(200);
  const longDesc = 'c'.repeat(500);
  const conn = fakeConnection([
    tool('mcp__srv__' + longName),
    tool('mcp__srv__' + 'b'.repeat(120), 'first   line\n\tsecond    line ' + longDesc),
  ]);
  const { fn } = stubConnect(conn);

  const result = await discoverMcpTools(baseInput, fn);
  const t = result.tools[0];
  assert.ok(t);
  assert.equal(result.tools.length, 1, 'unsupported identifiers are not rewritten into different tools');
  assert.equal(t.name, 'b'.repeat(120), 'supported identifier is preserved exactly');
  assert.equal(t.title, undefined, 'title never surfaced (folded into description by Flue)');
  assert.equal(t.description?.length, 400, 'description truncated to 400');
  // Whitespace collapsed: no runs of 2+ spaces, tabs, or newlines survive.
  assert.ok(!/\s\s/.test(t.description ?? ''), 'description whitespace collapsed');
});

test('discoverMcpTools omits title/description when absent (exactOptional-safe)', async () => {
  const conn = fakeConnection([tool('mcp__srv__bare', '')]);
  const { fn } = stubConnect(conn);
  const result = await discoverMcpTools(baseInput, fn);
  const t = result.tools[0];
  assert.ok(t);
  assert.equal(t.name, 'bare');
  assert.ok(!('title' in t), 'no title key when absent');
  assert.ok(!('description' in t), 'no description key when empty');
});

test('discoverMcpTools caps at 50 tools', async () => {
  const many = Array.from({ length: 75 }, (_, i) => tool('mcp__srv__t' + i, 'd'));
  const conn = fakeConnection(many);
  const { fn } = stubConnect(conn);
  const result = await discoverMcpTools(baseInput, fn);
  assert.equal(result.tools.length, 50);
  assert.equal(result.tools[0]?.name, 't0');
  assert.equal(result.tools[49]?.name, 't49');
});

test('discoverMcpTools rejects at the connect deadline when connect hangs', async () => {
  const hung = (): Promise<McpServerConnection> => new Promise(() => {});
  const err = await discoverMcpTools({ ...baseInput, connectTimeoutMs: 50 }, hung).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof Error, 'should reject');
  assert.equal(classifyMcpError(err), 'timeout');
  assert.match(safeMcpFailureText(err), /did not respond/i);
});

test('discoverMcpTools throws McpBlockedUrlError BEFORE connect is invoked (blocked URL)', async () => {
  let called = false;
  const spy = async (): Promise<McpServerConnection> => {
    called = true;
    return fakeConnection([]);
  };
  const err = await discoverMcpTools({ ...baseInput, url: 'https://10.0.0.1/mcp' }, spy).then(
    () => null,
    (e: unknown) => e,
  );
  assert.equal(called, false, 'connect must not be called for a blocked URL');
  assert.equal(classifyMcpError(err), 'blocked_url');
});

test('discoverMcpTools propagates a 401 rejection classified as unauthorized', async () => {
  const rejecting = async (): Promise<McpServerConnection> => {
    throw new Error('HTTP 401 Unauthorized');
  };
  const err = await discoverMcpTools(baseInput, rejecting).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof Error);
  assert.equal(classifyMcpError(err), 'unauthorized');
});

test('connectMcp returns the live connection without closing it', async () => {
  let closed = false;
  const conn = fakeConnection([tool('mcp__srv__x')], () => {
    closed = true;
  });
  const { fn, calls } = stubConnect(conn);

  const returned = await connectMcp(baseInput, fn);

  assert.equal(returned, conn, 'connectMcp returns the live connection');
  assert.equal(closed, false, 'connectMcp does NOT close the connection');
  assert.equal(calls[0]?.name, 'srv');
});

test('connectMcp preserves a transform request when provider fetch consumes its body', async () => {
  let transformedMethod = '';
  const connect = async (_name: string, options: McpServerOptions): Promise<McpServerConnection> => {
    await options.fetch!('https://mcp.example.com/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call' }),
    });
    return fakeConnection([]);
  };
  const createGuardedFetch = (): typeof fetch => async (input, init) => {
    const request = new Request(input, init);
    await request.text();
    return Response.json({ jsonrpc: '2.0', id: 1, result: {} });
  };
  await connectMcp({
    ...baseInput,
    transformResponse: async (request, response) => {
      transformedMethod = ((await request.json()) as { method: string }).method;
      return response;
    },
  }, connect, createGuardedFetch);
  assert.equal(transformedMethod, 'tools/call');
});

test('connectMcp also enforces the SSRF guard before connecting', async () => {
  let called = false;
  const spy = async (): Promise<McpServerConnection> => {
    called = true;
    return fakeConnection([]);
  };
  const err = await connectMcp({ ...baseInput, url: 'https://192.168.1.1/mcp' }, spy).then(
    () => null,
    (e: unknown) => e,
  );
  assert.equal(called, false, 'connect must not run for a blocked URL');
  assert.equal(classifyMcpError(err), 'blocked_url');
});

test('connectMcp rejects at the connect deadline when connect hangs', async () => {
  const hung = (): Promise<McpServerConnection> => new Promise(() => {});
  const err = await connectMcp({ ...baseInput, connectTimeoutMs: 50 }, hung).then(
    () => null,
    (e: unknown) => e,
  );
  assert.equal(classifyMcpError(err), 'timeout');
});

test('connectMcp aborts in-flight guarded fetch work at the connect deadline', async () => {
  let fetchAborted = false;
  const createGuardedFetch = ({ signal }: { signal?: AbortSignal }): typeof fetch => {
    assert.ok(signal, 'connect deadline signal must be supplied to guarded fetch');
    return (async () => {
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = () => {
          fetchAborted = true;
          reject(signal.reason);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    }) as typeof fetch;
  };

  const connect = async (
    _name: string,
    options: McpServerOptions,
  ): Promise<McpServerConnection> => {
    assert.ok(options.fetch, 'guarded fetch must be passed to Flue');
    await options.fetch(options.url);
    return fakeConnection([]);
  };

  const err = await connectMcp(
    { ...baseInput, url: 'https://8.8.8.8/mcp', connectTimeoutMs: 25 },
    connect,
    createGuardedFetch,
  ).then(
    () => null,
    (e: unknown) => e,
  );
  assert.equal(classifyMcpError(err), 'timeout');
  assert.equal(fetchAborted, true, 'deadline must abort the underlying fetch');
});
