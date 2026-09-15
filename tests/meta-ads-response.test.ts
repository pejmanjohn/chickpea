import assert from 'node:assert/strict';
import test from 'node:test';

import {
  META_ADS_ACCOUNT_HELPER_DESCRIPTION,
  advertiseMetaAdsAccountHelperOutput,
  sanitizeMetaAdsAccountHelperResponse,
} from '../src/config/meta-ads-response.ts';

const approved = ['123450001', 'act_123450001'];

function rpcResult(result: Record<string, unknown>, contentType = 'application/json'): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 7, result }), {
    headers: { 'content-type': contentType },
  });
}

const toolsListRequest = new Request('https://mcp.facebook.com/ads', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
});

function toolsListEnvelope() {
  return { jsonrpc: '2.0', id: 2, result: { tools: [
    { name: 'ads_get_ad_accounts', description: 'Provider pagination instructions.',
      inputSchema: { type: 'object', properties: { cursor: { type: 'string' } } },
      outputSchema: { type: 'object', properties: { accounts: { type: 'array' } }, required: ['accounts'] } },
    { name: 'ads_get_ad_entities', description: 'Keep me.', inputSchema: { type: 'object' },
      outputSchema: { type: 'object', properties: { data: { type: 'array' } } } },
  ], nextCursor: 'next-page' } };
}

test('account helper advertises the sanitizer-owned JSON output contract', async () => {
  const response = await advertiseMetaAdsAccountHelperOutput(toolsListRequest, Response.json(toolsListEnvelope()));
  const body = await response.json() as { result: { tools: Array<Record<string, unknown>>; nextCursor: string } };
  const helper = body.result.tools[0]!;
  assert.equal(helper.description, META_ADS_ACCOUNT_HELPER_DESCRIPTION);
  assert.deepEqual(helper.inputSchema, toolsListEnvelope().result.tools[0]!.inputSchema);
  assert.deepEqual(helper.outputSchema, {
    type: 'object',
    properties: { ad_accounts: {
      type: 'array', maxItems: 50, items: {
        type: 'object',
        properties: {
          ad_account_id: { type: 'string' },
          is_ads_mcp_enabled: { type: 'boolean' },
          is_queryable: { type: 'boolean' },
          not_queryable_reason: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          currency: { type: 'string' },
          account_status: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
          ad_account_name: { type: 'string' },
        },
        required: ['ad_account_id', 'is_ads_mcp_enabled', 'is_queryable'],
        additionalProperties: false,
      },
    } },
    required: ['ad_accounts'],
    additionalProperties: false,
  });
  assert.deepEqual(body.result.tools[1], toolsListEnvelope().result.tools[1]);
  assert.equal(body.result.nextCursor, 'next-page');
});

test('account helper advertises the same contract through SSE and preserves notifications', async () => {
  const notification = { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } };
  const response = await advertiseMetaAdsAccountHelperOutput(toolsListRequest, new Response(
    `event: message\ndata: ${JSON.stringify(notification)}\n\nevent: message\ndata: ${JSON.stringify(toolsListEnvelope())}\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  ));
  const body = await response.text();
  const payloads = [...body.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]!) as Record<string, unknown>);
  assert.equal(payloads.length, 2);
  assert.deepEqual(payloads[0], notification);
  const result = payloads[1]!.result as { tools: Array<Record<string, unknown>> };
  const schema = result.tools[0]!.outputSchema as { required: string[] };
  assert.deepEqual(schema.required, ['ad_accounts']);
  assert.deepEqual(result.tools[1], toolsListEnvelope().result.tools[1]);
});

test('account helper output advertisement fails closed on malformed JSON-RPC listings', async () => {
  for (const payload of [
    { jsonrpc: '2.0', id: {}, result: { tools: [] } },
    { jsonrpc: '2.0', id: 1, error: { code: -1 }, result: { tools: [] } },
    { jsonrpc: '2.0', id: 1, result: { tools: [
      { name: 'ads_get_ad_accounts' }, { name: 'ads_get_ad_accounts' },
    ] } },
  ]) {
    await assert.rejects(advertiseMetaAdsAccountHelperOutput(toolsListRequest, Response.json(payload)),
      /Meta Ads tool discovery returned an unsupported response/);
  }
});

test('account helper rebuilds JSON with approved canonical records only', async () => {
  const provider = {
    accounts: [
      {
        id: 'act_999', ad_account_name: 'Private other account', business_id: 'secret-business',
        is_ads_mcp_enabled: true, is_queryable: true, currency: 'EUR',
      },
      {
        ad_account_id: 'act_123450001', ad_account_name: 'Example Advertiser', business_id: 'not-forwarded',
        is_ads_mcp_enabled: true, is_queryable: true, currency: 'USD', account_status: 1,
        payment_method: 'not-forwarded',
      },
    ],
    has_more: false,
  };
  const response = await sanitizeMetaAdsAccountHelperResponse(rpcResult({
    content: [{ type: 'text', text: JSON.stringify(provider) }],
    structuredContent: provider,
  }), approved);
  const rpc = await response.json() as {
    result: { content: Array<{ text: string }>; structuredContent: unknown };
  };
  const expected = { ad_accounts: [{
    ad_account_id: '123450001',
    is_ads_mcp_enabled: true,
    is_queryable: true,
    currency: 'USD',
    account_status: 1,
    ad_account_name: 'Example Advertiser',
  }] };
  assert.deepEqual(rpc.result.structuredContent, expected);
  assert.deepEqual(JSON.parse(rpc.result.content[0]!.text), expected);
  assert.doesNotMatch(JSON.stringify(rpc), /999|secret-business|payment_method|not-forwarded/);
});

test('account helper rebuilds one SSE event without forwarding provider payload', async () => {
  const provider = { data: [
    { ad_account_id: '123450001', is_ads_mcp_enabled: true, is_queryable: false,
      not_queryable_reason: 'Setup required', internal: 'drop-me' },
    { ad_account_id: '222', is_ads_mcp_enabled: true, is_queryable: true, internal: 'private' },
  ] };
  const envelope = { jsonrpc: '2.0', id: 'call-1', result: {
    content: [{ type: 'text', text: JSON.stringify(provider) }],
  } };
  const response = await sanitizeMetaAdsAccountHelperResponse(new Response(
    `event: message\ndata: ${JSON.stringify(envelope)}\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  ), approved);
  const body = await response.text();
  assert.match(body, /^event: message\ndata: /);
  assert.match(body, /Setup required/);
  assert.match(body, /"ad_accounts"/);
  assert.doesNotMatch(body, /"accounts"/);
  assert.doesNotMatch(body, /222|drop-me|private/);
});

test('account helper accepts identical aliases and rejects conflicting aliases', async () => {
  const row = { is_ads_mcp_enabled: true, is_queryable: true, currency: 'USD' };
  const accepted = await sanitizeMetaAdsAccountHelperResponse(rpcResult({
    content: [{ type: 'text', text: JSON.stringify([
      { ...row, id: '123450001' }, { ...row, id: 'act_123450001' },
    ]) }],
  }), approved);
  assert.equal(((await accepted.json()) as { result: { structuredContent: { ad_accounts: unknown[] } } })
    .result.structuredContent.ad_accounts.length, 1);

  await assert.rejects(sanitizeMetaAdsAccountHelperResponse(rpcResult({
    content: [{ type: 'text', text: JSON.stringify([
      { ...row, id: '123450001' }, { ...row, id: 'act_123450001', is_queryable: false },
    ]) }],
  }), approved), /conflicting-account-aliases/);
});

test('account helper emits an exact stored approved alias and rejects padded provider IDs', async () => {
  const row = { is_ads_mcp_enabled: true, is_queryable: true };
  const accepted = await sanitizeMetaAdsAccountHelperResponse(rpcResult({
    structuredContent: { accounts: [{ ...row, id: '123450001' }] },
  }), ['act_123450001']);
  const body = await accepted.json() as {
    result: { structuredContent: { ad_accounts: Array<{ ad_account_id: string }> } };
  };
  assert.equal(body.result.structuredContent.ad_accounts[0]!.ad_account_id, 'act_123450001');
  await assert.rejects(sanitizeMetaAdsAccountHelperResponse(rpcResult({
    structuredContent: { accounts: [{ ...row, id: ' act_123450001 ' }] },
  }), ['act_123450001']), /account-id/);
});

test('account helper response body has an independent finite deadline', async () => {
  const stream = new ReadableStream<Uint8Array>({ start() {} });
  await assert.rejects(sanitizeMetaAdsAccountHelperResponse(new Response(stream, {
    headers: { 'content-type': 'text/event-stream' },
  }), approved, { deadlineMs: 5 }), /response-deadline/);
});

test('account helper fails closed on malformed, raw, conflicting, or incomplete responses', async () => {
  const valid = { accounts: [{ ad_account_id: '123450001', is_ads_mcp_enabled: true, is_queryable: true }] };
  const cases: Array<[string, Response]> = [
    ['non-json', new Response('private provider text', { headers: { 'content-type': 'text/plain' } })],
    ['invalid-json', new Response('{private', { headers: { 'content-type': 'application/json' } })],
    ['image-block', rpcResult({ content: [{ type: 'image', data: 'private' }] })],
    ['unknown-envelope', rpcResult({ content: [{ type: 'text', text: JSON.stringify({ unknown: [] }) }] })],
    ['conflicting', rpcResult({ content: [{ type: 'text', text: JSON.stringify(valid) }],
      structuredContent: { accounts: [] } })],
    ['pagination', rpcResult({ content: [{ type: 'text', text: JSON.stringify({ ...valid, next_cursor: 'private-cursor' }) }] })],
  ];
  for (const [label, response] of cases) {
    await assert.rejects(sanitizeMetaAdsAccountHelperResponse(response, approved),
      (error: unknown) => error instanceof Error && /unsupported response/.test(error.message) &&
        !/private provider text|private-cursor/.test(error.message), label);
  }
});
