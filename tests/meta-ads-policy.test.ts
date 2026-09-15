import assert from 'node:assert/strict';
import test from 'node:test';

import {
  META_ADS_ACCOUNT_HELPER,
  META_ADS_APPROVED_ACCOUNT_SCOPE,
  META_ADS_FIELD_HELPER,
  META_ADS_WRITE_TOOL_EFFECTS,
  compileMetaAdsToolAccess,
  isMetaAdsAccountScopeTool,
  isMetaAdsMcpConnection,
  isMetaAdsWriteTool,
  MetaAdsAccessPolicyError,
  metaAdsRuntimeAllowedTools,
  metaAdsRuntimeConstraint,
  metaAdsRuntimePropertyNames,
  metaAdsToolSchemaSupported,
  metaAdsToolEffect,
  metaAdsWriteOwnershipTargets,
  metaAdsWriteSchemaContract,
  normalizeMetaAdsAccountIds,
} from '../src/config/meta-ads-policy.ts';
import { projectMcpToolInputSchema } from '../src/config/mcp-test.ts';
import type { McpConnectionConfig, McpConnectionToolInfo } from '../src/config/types.ts';

const fingerprint = 'a'.repeat(64);
const reportTool = 'ads_get_ad_entities';
const scoreTool = 'ads_get_opportunity_score';
const writeTools = Object.keys(META_ADS_WRITE_TOOL_EFFECTS);

const requiredReferences: Readonly<Record<string, readonly string[]>> = {
  ads_create_creative: ['page_id'],
  ads_boost_ig_post: ['ig_account_id', 'ig_media_id'],
};

function discoveredWrite(name: string): McpConnectionToolInfo {
  const contract = metaAdsWriteSchemaContract(name);
  assert.ok(contract);
  const required: string[] = [];
  const properties: Record<string, unknown> = {
    advertiser_request: { type: 'string' },
    name: { type: 'string' },
  };
  if (contract.accountScoped) {
    properties.ad_account_id = { type: 'string' };
    required.push('ad_account_id');
  }
  for (const field of contract.ownershipFields) {
    properties[field] = { type: 'string' };
    required.push(field);
  }
  if (contract.entityType) {
    properties.entity_type = { type: 'string' };
    required.push('entity_type');
  }
  const requiredRefs = new Set(requiredReferences[name] ?? []);
  for (const field of contract.referenceFields) {
    properties[field] = requiredRefs.has(field) ? { type: 'string' } : { type: ['string', 'null'] };
    if (requiredRefs.has(field)) required.push(field);
  }
  if (contract.nestedPayloadFields.length > 0) {
    properties[contract.nestedPayloadFields[0]!] = { type: 'object', properties: {
      custom_audiences: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
    } };
  }
  return { name, inputSchema: projectMcpToolInputSchema(
    { type: 'object', properties, required }, name,
  ) };
}

function helper(name: typeof META_ADS_ACCOUNT_HELPER | typeof META_ADS_FIELD_HELPER): McpConnectionToolInfo {
  return {
    name,
    inputSchema: {
      accountFields: [],
      propertyNames: [],
      ambiguous: false,
      fingerprint,
    },
  };
}

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

test('helpers remain explicit grants and store account scope without a provider argument', () => {
  assert.deepEqual(compileMetaAdsToolAccess({
    discoveredTools: [helper(META_ADS_ACCOUNT_HELPER), helper(META_ADS_FIELD_HELPER)],
    requestedTools: [META_ADS_ACCOUNT_HELPER, META_ADS_FIELD_HELPER],
    approvedAccountIds: ['144860434', 'act_144860434'],
  }), {
    allowedTools: [META_ADS_ACCOUNT_HELPER, META_ADS_FIELD_HELPER],
    toolPolicies: {
      [META_ADS_ACCOUNT_HELPER]: { effect: 'read', argumentConstraints: {
        [META_ADS_APPROVED_ACCOUNT_SCOPE]: ['144860434', 'act_144860434'],
      } },
      [META_ADS_FIELD_HELPER]: { effect: 'read', argumentConstraints: {
        [META_ADS_APPROVED_ACCOUNT_SCOPE]: ['144860434', 'act_144860434'],
      } },
    },
  });
  assert.equal(metaAdsToolSchemaSupported(helper(META_ADS_ACCOUNT_HELPER)), true);
  assert.equal(metaAdsToolSchemaSupported(helper(META_ADS_FIELD_HELPER)), true);
});

test('helper schema or scope drift revokes runtime access', () => {
  const account = helper(META_ADS_ACCOUNT_HELPER);
  const connection = {
    discoveredTools: [account],
    allowedTools: [META_ADS_ACCOUNT_HELPER],
    toolPolicies: { [META_ADS_ACCOUNT_HELPER]: { effect: 'read' as const, argumentConstraints: {
      [META_ADS_APPROVED_ACCOUNT_SCOPE]: ['act_123'],
    } } },
  };
  assert.deepEqual(metaAdsRuntimeAllowedTools(connection), [META_ADS_ACCOUNT_HELPER]);
  assert.deepEqual(metaAdsRuntimeConstraint(connection, META_ADS_ACCOUNT_HELPER), {
    [META_ADS_APPROVED_ACCOUNT_SCOPE]: ['act_123'],
  });
  assert.deepEqual(metaAdsRuntimePropertyNames(connection, META_ADS_ACCOUNT_HELPER), []);
  account.inputSchema!.ambiguous = true;
  assert.deepEqual(metaAdsRuntimeAllowedTools(connection), []);
  account.inputSchema!.ambiguous = false;
  connection.toolPolicies[META_ADS_ACCOUNT_HELPER]!.argumentConstraints![META_ADS_APPROVED_ACCOUNT_SCOPE] = ['wrong'];
  assert.deepEqual(metaAdsRuntimeAllowedTools(connection), []);
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
    discoveredTools: [discovered('ads_unknown_write')], requestedTools: ['ads_unknown_write'],
    approvedAccountIds: ['act_123'],
  }), /reviewed access contract/);
});

test('all reviewed Meta writes require explicit selection and compile with write effects', () => {
  const discoveredTools = writeTools.map(discoveredWrite);
  assert.equal(discoveredTools.length, 11);
  for (const tool of discoveredTools) {
    assert.equal(tool.inputSchema?.ambiguous, false, tool.name);
    assert.equal(metaAdsToolSchemaSupported(tool), true, tool.name);
    assert.equal(isMetaAdsWriteTool(tool.name), true, tool.name);
    assert.equal(metaAdsToolEffect(tool.name), 'write', tool.name);
  }
  assert.deepEqual(compileMetaAdsToolAccess({
    discoveredTools, requestedTools: [], approvedAccountIds: [],
  }), { allowedTools: [], toolPolicies: {} });

  const compiled = compileMetaAdsToolAccess({
    discoveredTools, requestedTools: writeTools, approvedAccountIds: ['act_123'],
  });
  assert.deepEqual(compiled.allowedTools, writeTools);
  for (const name of writeTools) {
    assert.equal(compiled.toolPolicies[name]?.effect, 'write');
    const expectedField = isMetaAdsAccountScopeTool(name)
      ? META_ADS_APPROVED_ACCOUNT_SCOPE
      : 'ad_account_id';
    assert.deepEqual(compiled.toolPolicies[name]?.argumentConstraints, { [expectedField]: ['act_123'] }, name);
  }
});

test('write compiler rejects missing target evidence and duplicate discovery', () => {
  const update = discoveredWrite('ads_update_entity');
  assert.throws(() => compileMetaAdsToolAccess({
    discoveredTools: [{ ...update, inputSchema: {
      ...update.inputSchema!, propertyNames: ['ad_account_id', 'entity_type'],
    } }],
    requestedTools: ['ads_update_entity'], approvedAccountIds: ['act_123'],
  }), /cannot be restricted/);
  assert.throws(() => compileMetaAdsToolAccess({
    discoveredTools: [update, structuredClone(update)],
    requestedTools: ['ads_update_entity'], approvedAccountIds: ['act_123'],
  }), /not uniquely present/);
});

test('write ownership targets validate accounts, routes, paused creation, and update fields', () => {
  for (const [name, args, targets] of [
    ['ads_create_campaign', { ad_account_id: 'act_123', status: 'PAUSED' }, []],
    ['ads_create_ad_set', { account_id: '123', campaign_id: '456', status: 'PAUSED' }, ['456']],
    ['ads_create_ad', { ad_account_id: 'act_123', ad_set_id: '789' }, ['789']],
    ['ads_update_entity', {
      ad_account_id: 'act_123', entity_id: '456', entity_type: 'ad_set',
      fields: { status: 'ACTIVE', targeting: { custom_audiences: [{ id: '789' }] }, creative: { id: '321' } },
    }, ['456']],
    ['ads_activate_entity', {
      ad_account_id: 'act_123', entity_id: '567', entity_type: 'campaign',
    }, ['567']],
    ['ads_create_creative', { ad_account_id: 'act_123', object_story_id: '111_222' }, []],
    ['ads_boost_ig_post', { ad_account_id: 'act_123', status: 'PAUSED' }, []],
    ['ads_create_custom_audience', { ad_account_id: 'act_123' }, []],
    ['ads_update_custom_audience', { custom_audience_id: '876', fields: { name: 'Updated' } }, ['876']],
    ['ads_update_custom_audience_users', { audience_id: '987', payload: { users: [] } }, ['987']],
    ['ads_delete_custom_audience', { custom_audience_id: '654' }, ['654']],
  ] as const) {
    assert.deepEqual(metaAdsWriteOwnershipTargets(name, args), targets, name);
  }

  for (const [name, args, pattern] of [
    ['ads_create_campaign', {}, /one valid ad account ID/],
    ['ads_create_campaign', { ad_account_id: 'act_123', status: 'ACTIVE' }, /only as PAUSED/],
    ['ads_create_ad_set', { ad_account_id: 'act_123' }, /valid campaign_id/],
    ['ads_create_ad', { ad_account_id: 'act_123', ad_set_id: 'not-numeric' }, /valid ad_set_id/],
    ['ads_update_entity', { ad_account_id: 'act_123', entity_id: '456', entity_type: 'audience' }, /entity_type/],
    ['ads_update_custom_audience', { custom_audience_id: '123', account_id: '123' }, /does not accept/],
    ['ads_update_custom_audience_users', { custom_audience_id: '123' }, /valid audience_id/],
    ['ads_delete_custom_audience', { audience_id: '123' }, /valid custom_audience_id/],
  ] as const) {
    assert.throws(() => metaAdsWriteOwnershipTargets(name, args), pattern, name);
  }

  for (const name of ['ads_create_campaign', 'ads_create_ad_set', 'ads_create_ad', 'ads_boost_ig_post']) {
    const args: Record<string, string> = { ad_account_id: 'act_123', status: 'ACTIVE' };
    if (name === 'ads_create_ad_set') args.campaign_id = '456';
    if (name === 'ads_create_ad') args.ad_set_id = '789';
    assert.throws(() => metaAdsWriteOwnershipTargets(name, args), /only as PAUSED/, name);
  }

  for (const fields of [
    { account_id: '999' },
    { nested: { adset_id: '999' } },
    { entity_type: 'campaign' },
    { id: '999' },
    JSON.stringify({ nested: { campaign_id: '999' } }),
  ]) {
    assert.throws(() => metaAdsWriteOwnershipTargets('ads_update_entity', {
      ad_account_id: 'act_123', entity_id: '456', entity_type: 'campaign', fields,
    }), /cannot override/);
  }
  assert.throws(() => metaAdsWriteOwnershipTargets('ads_update_entity', {
    ad_account_id: 'act_123', entity_id: '456', entity_type: 'campaign', fields: '{bad',
  }), /valid JSON/);
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

test('runtime permits correlation metadata but withholds optional entity target arguments', () => {
  const tool = discovered(reportTool, 'ad_account_id', {
    propertyNames: [
      'ad_account_id', 'advertiser_request', 'client_conversation_id', 'fields', 'object_ids',
    ],
  });
  assert.deepEqual(metaAdsRuntimePropertyNames({ discoveredTools: [tool] }, reportTool), [
    'ad_account_id', 'advertiser_request', 'client_conversation_id', 'fields',
  ]);
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
