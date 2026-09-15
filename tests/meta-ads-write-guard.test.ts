import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertMetaAdsWriteAccountOwnership,
  META_ADS_OWNERSHIP_ORIGIN,
} from '../src/config/meta-ads-write-guard.ts';
import { MetaAdsAccessPolicyError } from '../src/config/meta-ads-policy.ts';

const AUTHORIZATION = 'Bearer meta-runtime-token';
const SAFE_ERROR =
  'Meta Ads could not verify that the target belongs to the selected ad account. No ad changes were sent.';
const ACTIVE_BUDGET_ERROR =
  "Meta's update service may pause an active campaign during budget changes. Use Ads Manager to change this campaign's budget. No ad changes were sent.";
const UNKNOWN_BUDGET_STATUS_ERROR =
  "Meta Ads could not verify whether this campaign is active. Use Ads Manager to change this campaign's budget. No ad changes were sent.";

interface FetchCapture {
  requests: Request[];
  fetch: typeof fetch;
}

function providerFetch(
  responseFor: (request: Request) => Response | Promise<Response>,
): FetchCapture {
  const requests: Request[] = [];
  return {
    requests,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return responseFor(request);
    },
  };
}

async function captureProviderOwnershipError(action: () => Promise<void>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.equal(error.message, SAFE_ERROR);
    return error;
  }
  assert.fail('Expected Meta Ads ownership verification to fail.');
}

async function capturePolicyError(
  action: () => Promise<void>,
  expectedMessage: RegExp,
): Promise<MetaAdsAccessPolicyError> {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof MetaAdsAccessPolicyError);
    assert.match(error.message, expectedMessage);
    return error;
  }
  assert.fail('Expected Meta Ads write routing validation to fail.');
}

test('Meta Ads write ownership accepts exact provider ownership for every entity and parent route', async () => {
  const cases: Array<{
    name: string;
    argumentsValue: Record<string, unknown>;
    target: string;
  }> = [
    { name: 'ads_create_ad_set', argumentsValue: {
      ad_account_id: 'act_123', campaign_id: '1001',
    }, target: '1001' },
    { name: 'ads_create_ad', argumentsValue: {
      ad_account_id: 'act_123', ad_set_id: '1002',
    }, target: '1002' },
    ...(['campaign', 'ad_set', 'ad'] as const).flatMap((entityType, index) => [
      { name: 'ads_update_entity', argumentsValue: {
        ad_account_id: 'act_123', entity_id: String(2000 + index), entity_type: entityType,
      }, target: String(2000 + index) },
      { name: 'ads_activate_entity', argumentsValue: {
        ad_account_id: 'act_123', entity_id: String(3000 + index), entity_type: entityType,
      }, target: String(3000 + index) },
    ]),
    { name: 'ads_update_custom_audience', argumentsValue: {
      custom_audience_id: '4001',
    }, target: '4001' },
    { name: 'ads_delete_custom_audience', argumentsValue: {
      custom_audience_id: '4002',
    }, target: '4002' },
    { name: 'ads_update_custom_audience_users', argumentsValue: {
      audience_id: '4003',
    }, target: '4003' },
  ];

  for (const entry of cases) {
    const provider = providerFetch(() => Response.json({
      id: entry.target,
      account_id: '123',
    }, { headers: { 'content-type': 'application/json' } }));
    await assertMetaAdsWriteAccountOwnership({
      name: entry.name,
      argumentsValue: entry.argumentsValue,
      approvedAccountIds: ['act_123'],
      authorization: AUTHORIZATION,
      fetch: provider.fetch,
    });
    assert.equal(provider.requests.length, 1, entry.name);
    const request = provider.requests[0]!;
    assert.equal(request.method, 'GET');
    assert.equal(request.redirect, 'manual');
    assert.equal(request.headers.get('authorization'), AUTHORIZATION);
    assert.equal(request.headers.get('accept'), 'application/json');
    const url = new URL(request.url);
    assert.equal(url.origin, META_ADS_OWNERSHIP_ORIGIN);
    assert.equal(url.pathname, `/v26.0/${entry.target}`);
    assert.equal(url.searchParams.get('fields'), 'id,account_id');
  }
});

test('active entity budget updates are blocked after status readback', async () => {
  const provider = providerFetch(() => Response.json({
    id: '5001',
    account_id: '123',
    configured_status: 'ACTIVE',
  }));
  await assert.rejects(assertMetaAdsWriteAccountOwnership({
    name: 'ads_update_entity',
    argumentsValue: {
      ad_account_id: 'act_123', entity_id: '5001', entity_type: 'campaign',
      fields: { daily_budget: '22500' },
    },
    approvedAccountIds: ['123'],
    authorization: AUTHORIZATION,
    fetch: provider.fetch,
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, ACTIVE_BUDGET_ERROR);
    return true;
  });
  assert.equal(provider.requests.length, 1);
  assert.equal(new URL(provider.requests[0]!.url).searchParams.get('fields'),
    'id,account_id,configured_status');
});

test('paused entity budget updates remain eligible for MCP dispatch', async () => {
  const provider = providerFetch(() => Response.json({
    id: '5002',
    account_id: '123',
    configured_status: 'PAUSED',
  }));
  await assertMetaAdsWriteAccountOwnership({
    name: 'ads_update_entity',
    argumentsValue: {
      ad_account_id: 'act_123', entity_id: '5002', entity_type: 'ad_set',
      fields: { lifetime_budget: '45000' },
    },
    approvedAccountIds: ['123'],
    authorization: AUTHORIZATION,
    fetch: provider.fetch,
  });
  assert.equal(provider.requests.length, 1);
  assert.equal(new URL(provider.requests[0]!.url).searchParams.get('fields'),
    'id,account_id,configured_status');
});

test('JSON-string budget fields receive the same active-entity protection', async () => {
  const provider = providerFetch(() => Response.json({
    id: '5003',
    account_id: '123',
    configured_status: 'ACTIVE',
  }));
  await assert.rejects(assertMetaAdsWriteAccountOwnership({
    name: 'ads_update_entity',
    argumentsValue: {
      ad_account_id: 'act_123', entity_id: '5003', entity_type: 'ad_set',
      fields: JSON.stringify({ lifetime_budget: '45000' }),
    },
    approvedAccountIds: ['123'],
    authorization: AUTHORIZATION,
    fetch: provider.fetch,
  }), /may pause an active ad set.*Ads Manager/);
  assert.equal(provider.requests.length, 1);
  assert.equal(new URL(provider.requests[0]!.url).searchParams.get('fields'),
    'id,account_id,configured_status');
});

test('budget updates fail closed when configured status is missing or invalid', async () => {
  for (const configuredStatus of [undefined, 'CAMPAIGN_PAUSED', 123]) {
    const provider = providerFetch(() => Response.json({
      id: '5004',
      account_id: '123',
      ...(configuredStatus === undefined ? {} : { configured_status: configuredStatus }),
    }));
    await assert.rejects(assertMetaAdsWriteAccountOwnership({
      name: 'ads_update_entity',
      argumentsValue: {
        ad_account_id: 'act_123', entity_id: '5004', entity_type: 'campaign',
        fields: { daily_budget: '22500' },
      },
      approvedAccountIds: ['123'],
      authorization: AUTHORIZATION,
      fetch: provider.fetch,
    }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, UNKNOWN_BUDGET_STATUS_ERROR);
      return true;
    });
    assert.equal(provider.requests.length, 1);
  }
});

test('account-scoped creations require the invocation account and do not fetch an entity', async () => {
  for (const name of [
    'ads_create_campaign',
    'ads_create_creative',
    'ads_boost_ig_post',
    'ads_create_custom_audience',
  ]) {
    const provider = providerFetch(() => {
      throw new Error('ownership fetch was not expected');
    });
    await assertMetaAdsWriteAccountOwnership({
      name,
      argumentsValue: { ad_account_id: 'act_123' },
      approvedAccountIds: ['123'],
      authorization: null,
      fetch: provider.fetch,
    });
    assert.equal(provider.requests.length, 0, name);
  }
});

test('provider id and account ownership must both match exactly', async () => {
  const failures: Array<Record<string, unknown>> = [
    {},
    { id: '999', account_id: '123' },
    { id: '5001' },
    { id: '5001', account_id: '999' },
    { id: 5001, account_id: '123' },
    { id: '5001', account_id: 123 },
  ];
  for (const body of failures) {
    const provider = providerFetch(() => Response.json(body));
    await captureProviderOwnershipError(() => assertMetaAdsWriteAccountOwnership({
      name: 'ads_update_entity',
      argumentsValue: {
        ad_account_id: 'act_123', entity_id: '5001', entity_type: 'campaign',
      },
      approvedAccountIds: ['123'],
      authorization: AUTHORIZATION,
      fetch: provider.fetch,
    }));
    assert.equal(provider.requests.length, 1);
  }
});

test('the invocation account must match the entity even when both accounts are approved', async () => {
  const provider = providerFetch(() => Response.json({ id: '6001', account_id: '123' }));
  await captureProviderOwnershipError(() => assertMetaAdsWriteAccountOwnership({
    name: 'ads_update_entity',
    argumentsValue: {
      ad_account_id: 'act_456', entity_id: '6001', entity_type: 'ad_set',
    },
    approvedAccountIds: ['act_123', 'act_456'],
    authorization: AUTHORIZATION,
    fetch: provider.fetch,
  }));
  assert.equal(provider.requests.length, 1);
});

test('empty approved account scope fails before provider fetch', async () => {
  const provider = providerFetch(() => {
    throw new Error('provider fetch was not expected');
  });
  await captureProviderOwnershipError(() => assertMetaAdsWriteAccountOwnership({
    name: 'ads_update_entity',
    argumentsValue: { ad_account_id: 'act_123', entity_id: '7001', entity_type: 'ad' },
    approvedAccountIds: [],
    authorization: AUTHORIZATION,
    fetch: provider.fetch,
  }));
  assert.equal(provider.requests.length, 0);
});

test('the invocation account must be within the approved account scope before provider fetch', async () => {
  const provider = providerFetch(() => {
    throw new Error('provider fetch was not expected');
  });
  await captureProviderOwnershipError(() => assertMetaAdsWriteAccountOwnership({
    name: 'ads_update_entity',
    argumentsValue: { ad_account_id: 'act_999', entity_id: '7001', entity_type: 'ad' },
    approvedAccountIds: ['act_123'],
    authorization: AUTHORIZATION,
    fetch: provider.fetch,
  }));
  assert.equal(provider.requests.length, 0);
});

test('invalid routing arguments stay actionable and fail before provider fetch', async () => {
  const cases: Array<{
    name: string;
    argumentsValue: Record<string, unknown>;
    message: RegExp;
  }> = [
    {
      name: 'ads_update_entity',
      argumentsValue: { ad_account_id: 'act_123', entity_id: '../7001', entity_type: 'ad' },
      message: /requires a valid entity_id/,
    },
    {
      name: 'ads_activate_entity',
      argumentsValue: { ad_account_id: 'act_123', entity_type: 'ad' },
      message: /requires a valid entity_id/,
    },
    {
      name: 'ads_activate_entity',
      argumentsValue: { ad_account_id: 'act_123', entity_id: null, entity_type: 'ad' },
      message: /requires a valid entity_id/,
    },
    {
      name: 'ads_activate_entity',
      argumentsValue: { ad_account_id: 'act_123', entity_id: '7001' },
      message: /requires entity_type/,
    },
    {
      name: 'ads_activate_entity',
      argumentsValue: { ad_account_id: 'act_123', entity_id: '7001', entity_type: null },
      message: /requires entity_type/,
    },
    {
      name: 'ads_update_entity',
      argumentsValue: { ad_account_id: 'act_123', entity_id: '7001', entity_type: 'creative' },
      message: /requires entity_type campaign, ad_set, or ad/,
    },
    {
      name: 'ads_create_custom_audience',
      argumentsValue: { name: 'Customers' },
      message: /requires one valid ad account ID/,
    },
    {
      name: 'ads_update_custom_audience',
      argumentsValue: { ad_account_id: 'act_123', custom_audience_id: '7002' },
      message: /does not accept an ad account argument/,
    },
  ];
  for (const entry of cases) {
    const provider = providerFetch(() => {
      throw new Error('provider fetch was not expected');
    });
    await capturePolicyError(() => assertMetaAdsWriteAccountOwnership({
      name: entry.name,
      argumentsValue: entry.argumentsValue,
      approvedAccountIds: ['act_123'],
      authorization: AUTHORIZATION,
      fetch: provider.fetch,
    }), entry.message);
    assert.equal(provider.requests.length, 0, entry.name);
  }
});

test('aborts, provider failures, oversized bodies, and redirects expose one bounded error', async () => {
  const secret = 'meta-runtime-token';
  const aborted = new AbortController();
  aborted.abort(new Error(`abort ${secret}`));
  const oversized = JSON.stringify({ id: '8001', account_id: '123', padding: 'x'.repeat(16_384) });
  const redirected = Response.json({ id: '8001', account_id: '123' });
  Object.defineProperties(redirected, {
    redirected: { value: true },
    url: { value: 'https://evil.example/ownership' },
  });
  const failures: Array<{ response: () => Response | Promise<Response>; signal?: AbortSignal }> = [
    { response: () => { throw new Error(`provider ${secret}`); } },
    { response: () => new Response(`failure ${secret}`, { status: 500 }) },
    { response: () => new Response(oversized, {
      headers: { 'content-length': String(new TextEncoder().encode(oversized).byteLength) },
    }) },
    { response: () => redirected },
    { response: async () => { throw aborted.signal.reason; }, signal: aborted.signal },
  ];

  for (const failure of failures) {
    const provider = providerFetch(failure.response);
    const error = await captureProviderOwnershipError(() => assertMetaAdsWriteAccountOwnership({
      name: 'ads_update_entity',
      argumentsValue: {
        ad_account_id: 'act_123', entity_id: '8001', entity_type: 'campaign',
      },
      approvedAccountIds: ['act_123'],
      authorization: AUTHORIZATION,
      fetch: provider.fetch,
      ...(failure.signal ? { signal: failure.signal } : {}),
    }));
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.equal(provider.requests.length, 1);
  }
});
