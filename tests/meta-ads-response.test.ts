import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeMetaAdsAccountHelperResponse } from '../src/config/meta-ads-response.ts';

const approved = ['144860434', 'act_144860434'];

function rpcResult(result: Record<string, unknown>, contentType = 'application/json'): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 7, result }), {
    headers: { 'content-type': contentType },
  });
}

test('account helper rebuilds JSON with approved canonical records only', async () => {
  const provider = {
    accounts: [
      {
        id: 'act_999', ad_account_name: 'Private other account', business_id: 'secret-business',
        is_ads_mcp_enabled: true, is_queryable: true, currency: 'EUR',
      },
      {
        ad_account_id: 'act_144860434', ad_account_name: 'Magoosh', business_id: 'not-forwarded',
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
  const expected = { accounts: [{
    ad_account_id: '144860434',
    is_ads_mcp_enabled: true,
    is_queryable: true,
    currency: 'USD',
    account_status: 1,
    ad_account_name: 'Magoosh',
  }] };
  assert.deepEqual(rpc.result.structuredContent, expected);
  assert.deepEqual(JSON.parse(rpc.result.content[0]!.text), expected);
  assert.doesNotMatch(JSON.stringify(rpc), /999|secret-business|payment_method|not-forwarded/);
});

test('account helper rebuilds one SSE event without forwarding provider payload', async () => {
  const provider = { data: [
    { ad_account_id: '144860434', is_ads_mcp_enabled: true, is_queryable: false,
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
  assert.doesNotMatch(body, /222|drop-me|private/);
});

test('account helper accepts identical aliases and rejects conflicting aliases', async () => {
  const row = { is_ads_mcp_enabled: true, is_queryable: true, currency: 'USD' };
  const accepted = await sanitizeMetaAdsAccountHelperResponse(rpcResult({
    content: [{ type: 'text', text: JSON.stringify([
      { ...row, id: '144860434' }, { ...row, id: 'act_144860434' },
    ]) }],
  }), approved);
  assert.equal(((await accepted.json()) as { result: { structuredContent: { accounts: unknown[] } } })
    .result.structuredContent.accounts.length, 1);

  await assert.rejects(sanitizeMetaAdsAccountHelperResponse(rpcResult({
    content: [{ type: 'text', text: JSON.stringify([
      { ...row, id: '144860434' }, { ...row, id: 'act_144860434', is_queryable: false },
    ]) }],
  }), approved), /conflicting-account-aliases/);
});

test('account helper emits an exact stored approved alias and rejects padded provider IDs', async () => {
  const row = { is_ads_mcp_enabled: true, is_queryable: true };
  const accepted = await sanitizeMetaAdsAccountHelperResponse(rpcResult({
    structuredContent: { accounts: [{ ...row, id: '144860434' }] },
  }), ['act_144860434']);
  const body = await accepted.json() as { result: { structuredContent: { accounts: Array<{ ad_account_id: string }> } } };
  assert.equal(body.result.structuredContent.accounts[0]!.ad_account_id, 'act_144860434');
  await assert.rejects(sanitizeMetaAdsAccountHelperResponse(rpcResult({
    structuredContent: { accounts: [{ ...row, id: ' act_144860434 ' }] },
  }), ['act_144860434']), /account-id/);
});

test('account helper response body has an independent finite deadline', async () => {
  const stream = new ReadableStream<Uint8Array>({ start() {} });
  await assert.rejects(sanitizeMetaAdsAccountHelperResponse(new Response(stream, {
    headers: { 'content-type': 'text/event-stream' },
  }), approved, { deadlineMs: 5 }), /response-deadline/);
});

test('account helper fails closed on malformed, raw, conflicting, or incomplete responses', async () => {
  const valid = { accounts: [{ ad_account_id: '144860434', is_ads_mcp_enabled: true, is_queryable: true }] };
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
