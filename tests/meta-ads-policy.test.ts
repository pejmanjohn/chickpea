import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compileMetaAdsToolAccess,
  isMetaAdsMcpConnection,
  MetaAdsAccessPolicyError,
  metaAdsRuntimeAllowedTools,
  metaAdsRuntimeConstraint,
  normalizeMetaAdsAccountIds,
} from '../src/config/meta-ads-policy.ts';
import type { McpConnectionConfig, McpConnectionToolInfo } from '../src/config/types.ts';

const fingerprint = 'a'.repeat(64);
const reportTool = 'ads_get_ad_entities';
const scoreTool = 'ads_get_opportunity_score';

function discovered(
  name: string,
  field: 'ad_account_id' | 'account_id' = 'ad_account_id',
  overrides: Partial<NonNullable<McpConnectionToolInfo['inputSchema']>> = {},
): McpConnectionToolInfo {
  return {
    name,
    inputSchema: {
      accountFields: [{ name: field, type: 'string', required: true }],
      propertyNames: [field],
      ambiguous: false,
      fingerprint,
      ...overrides,
    },
  };
}

test('empty Meta review remains empty without requiring an account', () => {
  assert.deepEqual(compileMetaAdsToolAccess({
    discoveredTools: [discovered(reportTool)], requestedTools: [], approvedAccountIds: [],
  }), { allowedTools: [], toolPolicies: {} });
});

test('compiler emits exact account constraints with server-owned reviewed effects', () => {
  assert.deepEqual(compileMetaAdsToolAccess({
    discoveredTools: [discovered(reportTool), discovered(scoreTool, 'account_id')],
    requestedTools: [reportTool, scoreTool, reportTool],
    approvedAccountIds: [' act_123 ', 'act_123', 'act_456'],
  }), {
    allowedTools: [reportTool, scoreTool],
    toolPolicies: {
      [reportTool]: { effect: 'read', argumentConstraints: { ad_account_id: ['act_123', 'act_456'] } },
      [scoreTool]: { effect: 'read', argumentConstraints: { account_id: ['act_123', 'act_456'] } },
    },
  });
});

test('compiler rejects tools without one required scalar account field', () => {
  const invalid: McpConnectionToolInfo[] = [
    { name: reportTool },
    discovered(reportTool, 'account_id', {
      accountFields: [{ name: 'account_id', type: 'string', required: false }],
    }),
    discovered(reportTool, 'account_id', { ambiguous: true }),
    discovered(reportTool, 'account_id', { accountFields: [
      { name: 'account_id', type: 'string', required: true },
      { name: 'ad_account_id', type: 'string', required: true },
    ] }),
  ];
  for (const tool of invalid) {
    assert.throws(() => compileMetaAdsToolAccess({
      discoveredTools: [tool], requestedTools: [tool.name], approvedAccountIds: ['act_123'],
    }), MetaAdsAccessPolicyError);
  }
  assert.throws(() => compileMetaAdsToolAccess({
    discoveredTools: [discovered(reportTool)], requestedTools: [reportTool], approvedAccountIds: [],
  }), /Select at least one/);
  assert.throws(() => compileMetaAdsToolAccess({
    discoveredTools: [discovered('ads_create_campaign')], requestedTools: ['ads_create_campaign'],
    approvedAccountIds: ['act_123'],
  }), /reviewed reporting contract/);
});

test('runtime revalidates current schema against its exact stored constraint', () => {
  const connection = {
    discoveredTools: [discovered(reportTool), discovered(scoreTool)],
    allowedTools: [reportTool, scoreTool],
    toolPolicies: {
      [reportTool]: { effect: 'read', argumentConstraints: { ad_account_id: ['act_123'] } },
      [scoreTool]: { effect: 'read', argumentConstraints: { account_id: ['act_123'] } },
    },
  } satisfies Pick<McpConnectionConfig, 'discoveredTools' | 'allowedTools' | 'toolPolicies'>;
  assert.deepEqual(metaAdsRuntimeAllowedTools(connection), [reportTool]);
  assert.deepEqual(metaAdsRuntimeConstraint(connection, reportTool), { ad_account_id: ['act_123'] });
  connection.discoveredTools[0]!.inputSchema!.fingerprint = 'invalid';
  assert.equal(metaAdsRuntimeConstraint(connection, reportTool), undefined);
});

test('account ID normalization validates syntax, deduplicates and bounds selections', () => {
  assert.deepEqual(normalizeMetaAdsAccountIds([' act_123 ', '123', 'act_123']), ['act_123', '123']);
  for (const invalid of [[''], ['act_'], ['abc'], ['act_1x'], ['1'.repeat(33)]]) {
    assert.throws(() => normalizeMetaAdsAccountIds(invalid), MetaAdsAccessPolicyError);
  }
  assert.throws(() => normalizeMetaAdsAccountIds(Array.from({ length: 51 }, (_, index) => String(index))), /no more than 50/);
});

test('Meta recognition includes the exact endpoint when preset metadata is missing', () => {
  assert.equal(isMetaAdsMcpConnection({ presetId: 'meta-ads', url: 'https://example.com' }), true);
  assert.equal(isMetaAdsMcpConnection({ url: 'https://mcp.facebook.com/ads' }), true);
  assert.equal(isMetaAdsMcpConnection({ url: 'https://mcp.facebook.com/ads/' }), true);
  assert.equal(isMetaAdsMcpConnection({ url: 'https://mcp.facebook.com/ads?other=true' }), true);
  assert.equal(isMetaAdsMcpConnection({ url: 'https://mcp.facebook.com/other' }), false);
});
