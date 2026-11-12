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
import { assertMcpToolArgumentKeys } from '../src/config/mcp-tool-policy.ts';
import type { McpConnectionConfig, McpConnectionToolInfo } from '../src/config/types.ts';
import {
  META_ACCOUNT_READ_NAMES,
  META_ACCOUNT_READS,
  META_DEFERRED_READS,
  metaAccountReadSchema,
} from './helpers/meta-ads-account-reads.ts';

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
    discoveredTools: [discovered(reportTool), discovered(scoreTool)],
    requestedTools: [reportTool, scoreTool, reportTool],
    approvedAccountIds: [' act_123 ', 'act_123', 'act_456'],
  }), {
    allowedTools: [reportTool, scoreTool],
    toolPolicies: {
      [reportTool]: { effect: 'read', argumentConstraints: { ad_account_id: ['act_123', 'act_456'] } },
      [scoreTool]: { effect: 'read', argumentConstraints: { ad_account_id: ['act_123', 'act_456'] } },
    },
  });
  // Each tool's contract names its account field; Meta has only ever used ad_account_id.
  assert.throws(() => compileMetaAdsToolAccess({
    discoveredTools: [discovered(scoreTool, 'account_id')], requestedTools: [scoreTool], approvedAccountIds: ['act_123'],
  }), /cannot be restricted to an approved ad account/);
});

test('helpers remain explicit grants and store account scope without a provider argument', () => {
  assert.deepEqual(compileMetaAdsToolAccess({
    discoveredTools: [helper(META_ADS_ACCOUNT_HELPER), helper(META_ADS_FIELD_HELPER)],
    requestedTools: [META_ADS_ACCOUNT_HELPER, META_ADS_FIELD_HELPER],
    approvedAccountIds: ['123450001', 'act_123450001'],
  }), {
    allowedTools: [META_ADS_ACCOUNT_HELPER, META_ADS_FIELD_HELPER],
    toolPolicies: {
      [META_ADS_ACCOUNT_HELPER]: { effect: 'read', argumentConstraints: {
        [META_ADS_APPROVED_ACCOUNT_SCOPE]: ['123450001', 'act_123450001'],
      } },
      [META_ADS_FIELD_HELPER]: { effect: 'read', argumentConstraints: {
        [META_ADS_APPROVED_ACCOUNT_SCOPE]: ['123450001', 'act_123450001'],
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
  assert.deepEqual(metaAdsRuntimePropertyNames(connection, META_ADS_ACCOUNT_HELPER),
    ['advertiser_request', 'client_conversation_id']);
  account.inputSchema!.ambiguous = true;
  assert.deepEqual(metaAdsRuntimeAllowedTools(connection), []);
  account.inputSchema!.ambiguous = false;
  connection.toolPolicies[META_ADS_ACCOUNT_HELPER]!.argumentConstraints![META_ADS_APPROVED_ACCOUNT_SCOPE] = ['wrong'];
  assert.deepEqual(metaAdsRuntimeAllowedTools(connection), []);
});

// Synthetic schemas shaped like Meta's live helper listings: Meta added the
// optional `advertiser_job` and `scheduled_task_run` next to the reviewed ones.
const helperAdditions = { advertiser_job: { type: 'string' }, scheduled_task_run: { type: 'string' } };

function liveHelper(
  name: typeof META_ADS_ACCOUNT_HELPER | typeof META_ADS_FIELD_HELPER,
  extra: Record<string, unknown> = helperAdditions,
  required: string[] = name === META_ADS_FIELD_HELPER ? ['field_names'] : [],
): McpConnectionToolInfo {
  const reviewed = name === META_ADS_ACCOUNT_HELPER
    ? { cursor: { type: ['string', 'null'] }, limit: { type: 'integer' } }
    : { field_names: { type: 'array', items: { type: 'string' } } };
  return { name, inputSchema: projectMcpToolInputSchema({
    type: 'object', required, properties: {
      advertiser_request: { type: 'string' }, client_conversation_id: { type: ['string', 'null'] },
      ...reviewed, ...extra,
    },
  }, name) };
}

test('helpers whose live schema gains optional arguments stay grantable with only their reviewed arguments', () => {
  const discoveredTools = [liveHelper(META_ADS_ACCOUNT_HELPER), liveHelper(META_ADS_FIELD_HELPER)];
  const helpers = [META_ADS_ACCOUNT_HELPER, META_ADS_FIELD_HELPER];
  for (const tool of discoveredTools) assert.equal(metaAdsToolSchemaSupported(tool), true, tool.name);
  const connection = {
    discoveredTools,
    ...compileMetaAdsToolAccess({ discoveredTools, requestedTools: helpers, approvedAccountIds: ['123450001'] }),
  };
  assert.deepEqual(metaAdsRuntimeAllowedTools(connection), helpers);
  assert.deepEqual(metaAdsRuntimePropertyNames(connection, META_ADS_ACCOUNT_HELPER),
    ['advertiser_request', 'client_conversation_id']);
  assert.deepEqual(metaAdsRuntimePropertyNames(connection, META_ADS_FIELD_HELPER),
    ['advertiser_request', 'client_conversation_id', 'field_names']);
  for (const name of helpers) {
    for (const added of Object.keys(helperAdditions)) {
      assert.throws(() => assertMcpToolArgumentKeys(name, { [added]: 'synthetic' },
        metaAdsRuntimePropertyNames(connection, name)!), new RegExp(`does not permit the argument ${added}`));
    }
  }
});

test('a helper that requires an unreviewed argument or has an account field is still refused', () => {
  const refused: Array<[string, McpConnectionToolInfo]> = [
    ['required addition', liveHelper(META_ADS_ACCOUNT_HELPER, helperAdditions, ['advertiser_job'])],
    ['required addition on the field helper',
      liveHelper(META_ADS_FIELD_HELPER, helperAdditions, ['field_names', 'scheduled_task_run'])],
    ['account field', liveHelper(META_ADS_ACCOUNT_HELPER, { ...helperAdditions, ad_account_id: { type: 'string' } })],
    ['account field on the field helper',
      liveHelper(META_ADS_FIELD_HELPER, { ...helperAdditions, account_id: { type: 'string' } })],
    // Stored projections, as a reader meets them.
    ['stored account field name', { name: META_ADS_ACCOUNT_HELPER, inputSchema: {
      ...helper(META_ADS_ACCOUNT_HELPER).inputSchema!, propertyNames: ['advertiser_job', 'ad_account_id'],
    } }],
    ['stored account field name on the field helper', { name: META_ADS_FIELD_HELPER, inputSchema: {
      ...helper(META_ADS_FIELD_HELPER).inputSchema!, propertyNames: ['account_id', 'field_names'],
    } }],
    ['stored account-like name', { name: META_ADS_ACCOUNT_HELPER, inputSchema: {
      ...helper(META_ADS_ACCOUNT_HELPER).inputSchema!, propertyNames: ['advertiser_request', 'business_ad_account'],
    } }],
    ['stored account field', { name: META_ADS_FIELD_HELPER, inputSchema: {
      ...helper(META_ADS_FIELD_HELPER).inputSchema!, propertyNames: ['advertiser_job'],
      accountFields: [{ name: 'account_id', type: 'string', required: true }],
    } }],
    ['stored ambiguous schema', { name: META_ADS_ACCOUNT_HELPER, inputSchema: {
      ...helper(META_ADS_ACCOUNT_HELPER).inputSchema!, propertyNames: ['advertiser_job'], ambiguous: true,
    } }],
    ['stored invalid fingerprint', { name: META_ADS_FIELD_HELPER, inputSchema: {
      ...helper(META_ADS_FIELD_HELPER).inputSchema!, propertyNames: ['advertiser_job'], fingerprint: 'x',
    } }],
  ];
  for (const [label, tool] of refused) {
    assert.equal(metaAdsToolSchemaSupported(tool), false, label);
    assert.equal(metaAdsRuntimePropertyNames({ discoveredTools: [tool] }, tool.name), undefined, label);
    assert.throws(() => compileMetaAdsToolAccess({
      discoveredTools: [tool], requestedTools: [tool.name], approvedAccountIds: ['123450001'],
    }), MetaAdsAccessPolicyError, label);
  }
});

function accountRead(name: string, schema: Record<string, unknown> = metaAccountReadSchema(name)): McpConnectionToolInfo {
  return { name, inputSchema: projectMcpToolInputSchema(schema, name) };
}

test("Meta's account-wide reads are admitted from their live schemas and never send their filters", () => {
  const discoveredTools = META_ACCOUNT_READ_NAMES.map((name) => accountRead(name));
  for (const tool of discoveredTools) {
    assert.equal(metaAdsToolEffect(tool.name), 'read', tool.name);
    assert.equal(tool.inputSchema?.ambiguous, false, tool.name);
    assert.deepEqual(tool.inputSchema?.accountFields, [{ name: 'ad_account_id', type: 'string', required: true }], tool.name);
    assert.equal(metaAdsToolSchemaSupported(tool), true, tool.name);
  }
  const compiled = compileMetaAdsToolAccess({
    discoveredTools, requestedTools: META_ACCOUNT_READ_NAMES, approvedAccountIds: ['123450001'],
  });
  assert.deepEqual(compiled.toolPolicies, Object.fromEntries(META_ACCOUNT_READ_NAMES.map((name) =>
    [name, { effect: 'read', argumentConstraints: { ad_account_id: ['123450001'] } }])));
  const connection = { discoveredTools, ...compiled };
  assert.deepEqual(metaAdsRuntimeAllowedTools(connection), META_ACCOUNT_READ_NAMES);
  for (const { name, properties, filters } of META_ACCOUNT_READS) {
    const runtime = metaAdsRuntimePropertyNames(connection, name)!;
    assert.deepEqual(runtime, Object.keys(properties).filter((property) => !filters.includes(property)).sort(), name);
    for (const filter of filters) {
      assert.throws(() => assertMcpToolArgumentKeys(name, { ad_account_id: '123450001', [filter]: '1' }, runtime),
        new RegExp(`does not permit the argument ${filter}`));
    }
  }
});

test('a selector added to an account-wide read, ID-shaped or not, is hidden and refused', () => {
  const selectors = [
    ['entities', { type: 'array', items: { type: 'string' } }], ['business', { type: 'string' }],
    ['object_ids', { type: 'array', items: { type: 'string' } }],
  ] as const;
  for (const { name, properties, filters } of META_ACCOUNT_READS) {
    for (const [selector, definition] of selectors) {
      const tool = accountRead(name, metaAccountReadSchema(name, { extra: { [selector]: definition } }));
      assert.equal(metaAdsToolSchemaSupported(tool), true, `${name}: ${selector}`);
      const runtime = metaAdsRuntimePropertyNames({ discoveredTools: [tool] }, name)!;
      assert.deepEqual([...runtime].sort(), Object.keys(properties).filter((property) => !filters.includes(property)).sort());
      assert.throws(() => assertMcpToolArgumentKeys(name, { ad_account_id: '123450001', [selector]: '1' }, runtime),
        new RegExp(`does not permit the argument ${selector}`), `${name}: ${selector}`);
    }
  }
});

test("Meta's account-wide reads are refused with another account field, an optional account, or a required unreviewed argument", () => {
  const text = { type: 'string' };
  for (const { name, filters } of META_ACCOUNT_READS) {
    const refused: Array<[string, Record<string, unknown>]> = [
      ['a second account field', metaAccountReadSchema(name, { extra: { account_id: text } })],
      ['a second account selector', metaAccountReadSchema(name, { extra: { ad_account_ids: { type: 'array', items: text } } })],
      ['an optional account field', metaAccountReadSchema(name, { required: [] })],
      ['an unlisted required ID', metaAccountReadSchema(name, {
        extra: { business_id: text }, required: ['ad_account_id', 'business_id'],
      })],
      ['an unlisted required argument', metaAccountReadSchema(name, {
        extra: { reporting_purpose: text }, required: ['ad_account_id', 'reporting_purpose'],
      })],
      ['an account nested in an argument', metaAccountReadSchema(name, {
        extra: { filtering: { type: 'object', properties: { account_id: text } } },
      })],
      ...filters.map((filter): [string, Record<string, unknown>] =>
        [`${filter} required`, metaAccountReadSchema(name, { required: ['ad_account_id', filter] })]),
    ];
    for (const [label, schema] of refused) {
      const tool = accountRead(name, schema);
      assert.equal(tool.inputSchema?.ambiguous, true, `${name}: ${label}`);
      assert.equal(metaAdsToolSchemaSupported(tool), false, `${name}: ${label}`);
      assert.throws(() => compileMetaAdsToolAccess({
        discoveredTools: [tool], requestedTools: [name], approvedAccountIds: ['123450001'],
      }), /cannot be restricted to an approved ad account/, `${name}: ${label}`);
    }
  }
});

test("Meta's creatives and errors reads are refused as their live schemas stand", () => {
  const accountFields: Record<string, unknown> = {
    ads_get_creatives: [{ name: 'ad_account_id', type: 'string', required: false }],
    ads_get_errors: [],
  };
  for (const { name } of META_DEFERRED_READS) {
    const tool = accountRead(name);
    assert.equal(metaAdsToolEffect(tool.name), undefined, name);
    assert.deepEqual(tool.inputSchema?.accountFields, accountFields[name], name);
    assert.equal(metaAdsToolSchemaSupported(tool), false, name);
    assert.throws(() => compileMetaAdsToolAccess({
      discoveredTools: [tool], requestedTools: [name], approvedAccountIds: ['123450001'],
    }), /is not in the reviewed access contract/, name);
    assert.deepEqual(metaAdsRuntimeAllowedTools({
      discoveredTools: [tool], allowedTools: [name],
      toolPolicies: { [name]: { effect: 'read', argumentConstraints: { ad_account_id: ['123450001'] } } },
    }), [], name);
  }
});

test("Meta's activity log sends only its time window, category and limit, and a grant stored for it runs", () => {
  const name = 'ads_account_get_activity_logs';
  const tool = accountRead(name);
  assert.deepEqual(metaAdsRuntimePropertyNames({ discoveredTools: [tool] }, name),
    ['ad_account_id', 'end_time', 'event_category', 'limit', 'start_time']);
  const runtime = metaAdsRuntimePropertyNames({ discoveredTools: [tool] }, name)!;
  for (const hidden of ['object_id', 'user_id', 'advertiser_request', 'client_conversation_id', 'advertiser_job',
    'after_answer_offer_report', 'scheduled_task_run']) {
    assert.throws(() => assertMcpToolArgumentKeys(name, { ad_account_id: '123450001', [hidden]: '1' }, runtime),
      new RegExp(`does not permit the argument ${hidden}`), hidden);
  }
  assert.doesNotThrow(() => assertMcpToolArgumentKeys(name, {
    ad_account_id: '123450001', start_time: '2026-11-05', end_time: '2026-11-12', event_category: 'BUDGET', limit: 50,
  }, runtime));
  // A grant saved while the read was reviewed under #775 mounts again.
  const discoveredTools = META_ACCOUNT_READ_NAMES.map((read) => accountRead(read));
  const stored = {
    discoveredTools,
    allowedTools: [name],
    toolPolicies: { [name]: { effect: 'read' as const, argumentConstraints: { ad_account_id: ['123450001'] } } },
  };
  assert.deepEqual(metaAdsRuntimeConstraint(stored, name), { ad_account_id: ['123450001'] });
  assert.deepEqual(metaAdsRuntimeAllowedTools(stored), [name]);
});

test('compiler rejects tools without one required scalar account field', () => {
  const invalid: McpConnectionToolInfo[] = [
    { name: reportTool },
    discovered(reportTool, 'ad_account_id', {
      accountFields: [{ name: 'ad_account_id', type: 'string', required: false }],
    }),
    discovered(reportTool, 'ad_account_id', { ambiguous: true }),
    discovered(reportTool, 'ad_account_id', { accountFields: [
      { name: 'account_id', type: 'string', required: true },
      { name: 'ad_account_id', type: 'string', required: true },
    ] }),
    // A stored account field the stored names don't list.
    discovered(reportTool, 'ad_account_id', { propertyNames: ['fields'] }),
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
  for (const propertyNames of [['ad_account_id', 'entity_type'], ['ad_account_id', 'entity_id']]) {
    assert.throws(() => compileMetaAdsToolAccess({
      discoveredTools: [{ ...update, inputSchema: { ...update.inputSchema!, propertyNames } }],
      requestedTools: ['ads_update_entity'], approvedAccountIds: ['act_123'],
    }), /cannot be restricted/, propertyNames.join());
  }
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
      fields: { daily_budget: '22500' },
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

test('entity updates isolate requested status changes from ordinary field edits', () => {
  const update = (fields: unknown) => metaAdsWriteOwnershipTargets('ads_update_entity', {
    ad_account_id: 'act_123', entity_id: '456', entity_type: 'campaign', fields,
  });

  for (const fields of [
    { daily_budget: '22500' },
    JSON.stringify({ daily_budget: '22500' }),
    { status: 'PAUSED' },
    JSON.stringify({ status: 'PAUSED' }),
    { daily_budget: '22500', delivery_estimate: { status: 'PENDING' } },
    JSON.stringify({ daily_budget: '22500', delivery_estimate: { status: 'PENDING' } }),
  ]) {
    assert.deepEqual(update(fields), ['456']);
  }

  for (const fields of [
    { daily_budget: '22500', status: 'PAUSED' },
    JSON.stringify({ daily_budget: '22500', status: 'PAUSED' }),
  ]) {
    assert.throws(() => update(fields), /status-only update/);
  }

  for (const fields of [
    { status: 'ACTIVE' },
    JSON.stringify({ status: 'ACTIVE' }),
  ]) {
    assert.throws(() => update(fields), /permit status only as PAUSED/);
  }

  for (const fields of [
    { configured_status: 'PAUSED' },
    JSON.stringify({ effective_status: 'PAUSED' }),
    { delivery_estimate: { configured_status: 'PAUSED' } },
    JSON.stringify({ delivery_estimate: { effective_status: 'PAUSED' } }),
  ]) {
    assert.throws(() => update(fields), /cannot write configured_status or effective_status/);
  }
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

test('runtime sends the contract arguments, whatever the stored names, and never an entity filter', () => {
  const tool = discovered(reportTool, 'ad_account_id', {
    propertyNames: [
      'ad_account_id', 'advertiser_job', 'advertiser_request', 'client_conversation_id', 'fields', 'object_ids',
    ],
  });
  const runtime = metaAdsRuntimePropertyNames({ discoveredTools: [tool] }, reportTool)!;
  assert.deepEqual(runtime, [
    'ad_account_id', 'advertiser_request', 'breakdowns', 'client_conversation_id', 'cursor', 'date_preset', 'fields',
    'filtering', 'include_additional_context', 'level', 'limit', 'object_state', 'sort', 'time_increment', 'time_range',
  ]);
  for (const hidden of ['object_ids', 'advertiser_job']) assert.equal(runtime.includes(hidden), false, hidden);
});

test('create-ad runtime rejects the optional adset_spec alternate parent route', () => {
  const tool = discoveredWrite('ads_create_ad');
  tool.inputSchema!.propertyNames.push('adset_spec');
  const names = metaAdsRuntimePropertyNames({ discoveredTools: [tool] }, 'ads_create_ad');
  assert.ok(names);
  assert.equal(names.includes('adset_spec'), false);
  assert.throws(() => assertMcpToolArgumentKeys('ads_create_ad', {
    ad_account_id: 'act_123', ad_set_id: '456', adset_spec: '{"id":"789"}',
  }, names), /does not permit the argument adset_spec/);
});

test('observed Meta write property sets admit single-entity routes after raw-schema validation', () => {
  // These are the stored bounded projections and fingerprints supplied from a
  // real discovery. `ambiguous: false` represents the result required from a
  // fresh raw-schema pass; these literals do not invent the omitted raw types.
  const projections: McpConnectionToolInfo[] = [
    {
      name: 'ads_activate_entity',
      inputSchema: {
        accountFields: [{ name: 'ad_account_id', type: 'string', required: true }],
        propertyNames: [
          'ad_account_id', 'advertiser_request', 'client_conversation_id', 'entity_id',
          'entity_type', 'ignore_validation_errors', 'object_ids',
        ],
        ambiguous: false,
        fingerprint: '74152ad0f0f13c6daed3ce991623826fb63f2a690d54d13c01582ee4f30affc1',
      },
    },
    {
      name: 'ads_create_campaign',
      inputSchema: {
        accountFields: [{ name: 'ad_account_id', type: 'string', required: true }],
        propertyNames: [
          'ad_account_id', 'adlabels', 'advertiser_request', 'budget_schedule_specs', 'buying_type',
          'campaign_bid_strategy', 'campaign_daily_budget', 'campaign_lifetime_budget', 'campaign_name',
          'campaign_optimization_type', 'campaign_spend_cap', 'campaign_start_time', 'campaign_stop_time',
          'client_conversation_id', 'is_skadnetwork_attribution', 'is_using_l3_schedule',
          'iterative_split_test_configs', 'objective', 'promoted_object', 'source_campaign_id',
          'special_ad_categories', 'special_ad_category_country', 'topline_id',
        ],
        ambiguous: false,
        fingerprint: 'e1fbba062258cdb33c1e6034f5fde438a9f6c943ba8fd258deb11653adf35e7f',
      },
    },
    {
      name: 'ads_create_creative',
      inputSchema: {
        accountFields: [{ name: 'ad_account_id', type: 'string', required: true }],
        propertyNames: [
          'ad_account_id', 'advantage_plus_creative', 'advantage_plus_creative_features',
          'advertiser_request', 'call_to_action_type', 'cards', 'client_conversation_id',
          'degrees_of_freedom_spec', 'description', 'display_link', 'facebook_partnership_ad',
          'headline', 'image_hash', 'image_url', 'instagram_user_id', 'link_url', 'message', 'name',
          'object_story_id', 'page_id', 'placement_videos', 'product_set_id', 'self_ai_disclosure', 'video_id',
        ],
        ambiguous: false,
        fingerprint: 'ed692e7c72beebebec4829df8011e67012e6728388afc0383a601837c6566c60',
      },
    },
    {
      name: 'ads_create_ad_set',
      inputSchema: {
        accountFields: [{ name: 'ad_account_id', type: 'string', required: true }],
        propertyNames: [
          'ad_account_id', 'brand_audience_id', 'budget_split_set_id', 'campaign_id', 'campaign_spec',
          'conversion_goal_id', 'include_in_ad_study_cell_id', 'include_in_ad_study_id', 'marketing_goal',
          ...Array.from({ length: 60 }, (_, index) => `provider_option_${String(index).padStart(2, '0')}`),
          'targeting',
        ],
        ambiguous: false,
        fingerprint: '7d2d8e7135b2d4866efce2b748b024c476639d8049357abd8cc163643a77bfb0',
      },
    },
  ];

  for (const tool of projections) {
    assert.equal(metaAdsToolSchemaSupported(tool), true, tool.name);
  }
  const connection = { discoveredTools: projections };
  assert.deepEqual(metaAdsRuntimePropertyNames(connection, 'ads_activate_entity'), [
    'ad_account_id', 'advertiser_request', 'client_conversation_id', 'entity_id',
    'entity_type', 'ignore_validation_errors',
  ]);
  const activationNames = metaAdsRuntimePropertyNames(connection, 'ads_activate_entity');
  assert.ok(activationNames);
  assert.throws(() => assertMcpToolArgumentKeys('ads_activate_entity', {
    ad_account_id: 'act_123', entity_id: '456', entity_type: 'campaign', object_ids: ['789'],
  }, activationNames), /does not permit the argument object_ids/);
  const campaignNames = metaAdsRuntimePropertyNames(connection, 'ads_create_campaign');
  assert.ok(campaignNames);
  assert.equal(campaignNames.includes('source_campaign_id'), false);
  assert.equal(campaignNames.includes('topline_id'), false);
  const adSetNames = metaAdsRuntimePropertyNames(connection, 'ads_create_ad_set');
  assert.ok(adSetNames);
  for (const blocked of [
    'brand_audience_id', 'budget_split_set_id', 'campaign_spec', 'conversion_goal_id',
    'include_in_ad_study_cell_id', 'include_in_ad_study_id',
  ]) {
    assert.equal(adSetNames.includes(blocked), false, blocked);
  }
  assert.ok(adSetNames.includes('campaign_id'));
  assert.ok(adSetNames.includes('targeting'));
  assert.ok(metaAdsRuntimePropertyNames(connection, 'ads_create_creative')?.includes('video_id'));
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
