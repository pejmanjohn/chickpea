import assert from 'node:assert/strict';
import test from 'node:test';

import { projectMcpPolicyInstructions } from '../src/config/mcp-policy-instructions.ts';
import {
  META_ADS_ACCOUNT_HELPER,
  META_ADS_APPROVED_ACCOUNT_SCOPE,
  META_ADS_FIELD_HELPER,
} from '../src/config/meta-ads-policy.ts';
import type { RuntimePlanMcpConnectionV2 } from '../src/agents/runtime-plan.ts';

function connection(overrides: Partial<RuntimePlanMcpConnectionV2>): RuntimePlanMcpConnectionV2 {
  return {
    id: 'connection', url: 'https://mcp.example.com/mcp', transport: 'streamable-http',
    authMode: 'none', headerNames: [], allowedTools: [], optional: true, ...overrides,
  };
}

test('Meta helper scope is separate from actual provider input restrictions', () => {
  const projection = projectMcpPolicyInstructions([connection({
    id: 'meta', url: 'https://mcp.facebook.com/ads',
    allowedTools: [META_ADS_ACCOUNT_HELPER, META_ADS_FIELD_HELPER, 'ads_get_ad_entities'],
    toolArgumentConstraints: {
      [META_ADS_ACCOUNT_HELPER]: { [META_ADS_APPROVED_ACCOUNT_SCOPE]: ['act_123'] },
      [META_ADS_FIELD_HELPER]: { [META_ADS_APPROVED_ACCOUNT_SCOPE]: ['act_123'] },
      ads_get_ad_entities: { ad_account_id: ['act_123'] },
    },
  })]);
  assert.deepEqual(projection.restrictions, [{
    connection: 'meta', tools: { ads_get_ad_entities: { ad_account_id: ['act_123'] } },
  }]);
  assert.deepEqual(projection.metaHelperScopes, [
    { connection: 'meta', tool: META_ADS_ACCOUNT_HELPER, approvedAccountIds: ['act_123'] },
    { connection: 'meta', tool: META_ADS_FIELD_HELPER, approvedAccountIds: ['act_123'] },
  ]);
});

test('custom MCP name collisions retain ordinary input restrictions', () => {
  const projection = projectMcpPolicyInstructions([connection({
    allowedTools: [META_ADS_ACCOUNT_HELPER],
    toolArgumentConstraints: { [META_ADS_ACCOUNT_HELPER]: { tenant_id: ['tenant-1'] } },
  })]);
  assert.deepEqual(projection.restrictions, [{
    connection: 'connection', tools: { [META_ADS_ACCOUNT_HELPER]: { tenant_id: ['tenant-1'] } },
  }]);
  assert.deepEqual(projection.metaHelperScopes, []);
  assert.deepEqual(projection.metaWriteScopes, []);
});

test('accountless audience writes describe ownership scope without inventing provider inputs', () => {
  const projection = projectMcpPolicyInstructions([connection({
    id: 'meta', url: 'https://mcp.facebook.com/ads', allowedTools: ['ads_delete_custom_audience'],
    toolArgumentConstraints: {
      ads_delete_custom_audience: { [META_ADS_APPROVED_ACCOUNT_SCOPE]: ['act_123'] },
    },
  })]);
  assert.deepEqual(projection.restrictions, []);
  assert.deepEqual(projection.metaHelperScopes, []);
  assert.deepEqual(projection.metaWriteScopes, [
    { connection: 'meta', tool: 'ads_delete_custom_audience', approvedAccountIds: ['act_123'] },
  ]);
});
