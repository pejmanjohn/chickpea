import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { allowedToolsAfterMcpDiscovery } from '../src/config/mcp-access.ts';
import { assertMcpToolArgumentKeys } from '../src/config/mcp-tool-policy.ts';
import {
  META_ADS_ACCOUNT_HELPER,
  META_ADS_FIELD_HELPER,
  compileMetaAdsToolAccess,
  isMetaAdsWriteTool,
  metaAdsRuntimeAllowedTools,
  metaAdsRuntimePropertyNames,
  metaAdsToolSchemaSupported,
} from '../src/config/meta-ads-policy.ts';
import { reviewedMetaAdsTools } from '../src/config/meta-ads-response.ts';
import type { McpConnectionConfig, McpConnectionToolInfo } from '../src/config/types.ts';
import {
  META_ACCOUNT_GRANT,
  META_LIVE_NAMES,
  META_NOVEMBER_CORRELATION,
  META_PRE_NOVEMBER_NAMES,
  metaDiscoveredTool,
  metaToolSchema,
} from './helpers/meta-ads-live-tools.ts';

// The filters and routes Chickpea never sends, by tool.
const NEVER_SENT: Readonly<Record<string, readonly string[]>> = {
  ads_get_ad_entities: ['object_ids'],
  ads_get_customconversions: ['dataset_id'],
  ads_insights_advertiser_context: ['entity_ids'],
  ads_insights_anomaly_signal: ['entity_ids'],
  ads_insights_auction_ranking_benchmarks: ['entity_ids'],
  ads_insights_industry_benchmark: ['entity_ids'],
  ads_insights_performance_trend: ['entity_ids'],
  ads_create_campaign: ['source_campaign_id', 'topline_id'],
  ads_create_ad: ['adset_spec'],
  ads_activate_entity: ['object_ids'],
  ads_create_creative: ['product_set_id'],
};

const HELPER_ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
  [META_ADS_ACCOUNT_HELPER]: ['advertiser_request', 'client_conversation_id'],
  [META_ADS_FIELD_HELPER]: ['advertiser_request', 'client_conversation_id', 'field_names'],
};

/**
 * The reviewed contract: what a tool could send before Meta's November change,
 * minus its hidden filters. Custom audiences and custom conversions were
 * reviewed against their live names.
 */
function reviewedArguments(name: string): string[] {
  if (HELPER_ARGUMENTS[name]) return [...HELPER_ARGUMENTS[name]!].sort();
  const names = META_PRE_NOVEMBER_NAMES[name] ?? META_LIVE_NAMES[name]!;
  return names.filter((value) => !(NEVER_SENT[name] ?? []).includes(value)).sort();
}

// Writes whose live schema fails their contract: an ID-shaped route the
// contract doesn't classify (ad set: since before November; boost: sponsor_id;
// creative: lead_gen_form_id and two more).
const UNAVAILABLE_LIVE = ['ads_create_ad_set', 'ads_boost_ig_post', 'ads_create_creative'];

const connectionOf = (...discoveredTools: McpConnectionToolInfo[]) => ({ discoveredTools });

test('each reviewed Meta tool may send exactly its reviewed arguments, whatever else its live schema lists', () => {
  const liveTools = Object.keys(META_LIVE_NAMES);
  assert.equal(liveTools.length, 21);
  for (const name of liveTools) {
    const tool = metaDiscoveredTool(name);
    if (UNAVAILABLE_LIVE.includes(name)) {
      assert.equal(metaAdsToolSchemaSupported(tool), false, name);
      continue;
    }
    assert.equal(metaAdsToolSchemaSupported(tool), true, name);
    assert.deepEqual([...metaAdsRuntimePropertyNames(connectionOf(tool), name)!].sort(), reviewedArguments(name), name);
  }
  // Meta no longer lists this write; a schema with its old names still admits it.
  const users = metaDiscoveredTool('ads_update_custom_audience_users', META_PRE_NOVEMBER_NAMES.ads_update_custom_audience_users);
  assert.deepEqual([...metaAdsRuntimePropertyNames(connectionOf(users), users.name)!].sort(),
    reviewedArguments(users.name));
});

test("no tool reviewed before November sends Meta's November correlation fields", () => {
  for (const name of Object.keys(META_PRE_NOVEMBER_NAMES)) {
    const tool = metaDiscoveredTool(name, META_LIVE_NAMES[name] ?? META_PRE_NOVEMBER_NAMES[name]);
    const runtime = metaAdsRuntimePropertyNames(connectionOf(tool), name);
    if (!runtime) continue;
    for (const field of META_NOVEMBER_CORRELATION) {
      assert.equal(runtime.includes(field), false, `${name}: ${field}`);
      assert.throws(() => assertMcpToolArgumentKeys(name, { [field]: 'synthetic' }, runtime),
        new RegExp(`does not permit the argument ${field}`), `${name}: ${field}`);
    }
  }
});

// One tool of each kind, from the names it was reviewed with.
const KINDS: ReadonlyArray<[string, string]> = [
  ['account helper', META_ADS_ACCOUNT_HELPER],
  ['field helper', META_ADS_FIELD_HELPER],
  ['report', 'ads_get_ad_entities'],
  ['insights read', 'ads_insights_performance_trend'],
  ['account-wide read', 'ads_get_ad_account_custom_audiences'],
  ['account write', 'ads_create_ad'],
  ['entity write', 'ads_update_entity'],
  ['audience write', 'ads_delete_custom_audience'],
];

const reviewedNames = (name: string) => META_PRE_NOVEMBER_NAMES[name] ?? META_LIVE_NAMES[name]!;

/** A live listing entry, so the listing rewrite can be checked as the model would see it. */
const listed = (name: string, schema: ReturnType<typeof metaToolSchema>) => ({ name, inputSchema: schema });

test('an added optional argument, ID-shaped or not, is neither shown nor sendable on any tool kind', () => {
  const additions: ReadonlyArray<[string, unknown]> = [
    ['entities', { type: 'array', items: { type: 'string' } }],
    ['business', { type: 'string' }],
    ['advertiser_job', { type: 'string' }],
    ['filtering_v2', { type: 'object', properties: { field: { type: 'string' } } }],
  ];
  const idShaped: ReadonlyArray<[string, unknown]> = [
    ['business_id', { type: 'string' }],
    ['campaign_ids', { type: 'array', items: { type: 'string' } }],
  ];
  for (const [kind, name] of KINDS) {
    for (const [added, definition] of [...additions, ...idShaped]) {
      if (reviewedNames(name).includes(added)) continue;
      const label = `${kind} ${name}: ${added}`;
      const schema = metaToolSchema(name, reviewedNames(name), { extra: { [added]: definition } });
      const tool = { name, inputSchema: { ...metaDiscoveredTool(name, reviewedNames(name), { extra: { [added]: definition } }).inputSchema! } };
      if (isMetaAdsWriteTool(name) && idShaped.some(([candidate]) => candidate === added)) {
        // A write keeps refusing an ID-shaped route its contract doesn't classify.
        assert.equal(metaAdsToolSchemaSupported(tool), false, label);
        continue;
      }
      assert.equal(tool.inputSchema.ambiguous, false, label);
      assert.equal(metaAdsToolSchemaSupported(tool), true, label);
      const runtime = metaAdsRuntimePropertyNames(connectionOf(tool), name)!;
      assert.deepEqual([...runtime].sort(), reviewedArguments(name), label);
      assert.throws(() => assertMcpToolArgumentKeys(name, { [added]: 'synthetic' }, runtime),
        new RegExp(`does not permit the argument ${added}`), label);
      const { tools } = reviewedMetaAdsTools([listed(name, schema)], connectionOf(tool));
      const shown = (tools[0] as { inputSchema: { properties: Record<string, unknown> } }).inputSchema.properties;
      assert.equal(Object.hasOwn(shown, added), false, label);
      assert.deepEqual(Object.keys(shown).sort(), reviewedArguments(name).filter((value) => Object.hasOwn(schema.properties, value)), label);
    }
  }
});

test('a newly required unreviewed argument makes the tool unavailable on every tool kind', () => {
  for (const [kind, name] of KINDS) {
    for (const added of ['reporting_purpose', 'advertiser_job', 'business']) {
      if (reviewedArguments(name).includes(added)) continue;
      const label = `${kind} ${name}: ${added}`;
      const base = metaToolSchema(name, reviewedNames(name));
      const tool = metaDiscoveredTool(name, reviewedNames(name), {
        extra: { [added]: { type: 'string' } }, required: [...base.required, added],
      });
      assert.equal(tool.inputSchema?.ambiguous, true, label);
      assert.equal(metaAdsToolSchemaSupported(tool), false, label);
      assert.equal(metaAdsRuntimePropertyNames(connectionOf(tool), name), undefined, label);
      assert.throws(() => compileMetaAdsToolAccess({
        discoveredTools: [tool], requestedTools: [name], approvedAccountIds: ['123450001'],
      }), /cannot be restricted to an approved ad account/, label);
    }
  }
});

test('a required reviewed argument stays admissible', () => {
  for (const [name, required] of [
    ['ads_insights_performance_trend', ['ad_account_id', 'analysis_metric', 'client_conversation_id']],
    ['ads_get_ad_entities', ['ad_account_id', 'fields']],
  ] as const) {
    const tool = metaDiscoveredTool(name, META_LIVE_NAMES[name], { required });
    assert.equal(metaAdsToolSchemaSupported(tool), true, name);
  }
});

function grantOn(discoveredTools: McpConnectionToolInfo[]): Pick<McpConnectionConfig,
  'presetId' | 'url' | 'toolAccessMode' | 'discoveredTools' | 'allowedTools' | 'toolPolicies'> {
  return {
    presetId: 'meta-ads', url: 'https://mcp.facebook.com/ads', toolAccessMode: 'review', discoveredTools,
    ...compileMetaAdsToolAccess({ discoveredTools, requestedTools: [...META_ACCOUNT_GRANT], approvedAccountIds: ['123450001'] }),
  };
}

function captureInfo(t: TestContext): unknown[] {
  const lines: unknown[] = [];
  t.mock.method(console, 'info', (line: unknown) => { lines.push(line); });
  return lines;
}

test('an account-shaped grant from before November keeps working through a reconnect to the live schemas', (t) => {
  const lines = captureInfo(t);
  const before = Object.keys(META_PRE_NOVEMBER_NAMES).map((name) => metaDiscoveredTool(name, META_PRE_NOVEMBER_NAMES[name]));
  const stored = grantOn(before);
  // No admin action: the stored grant runs with the reviewed arguments.
  assert.deepEqual(metaAdsRuntimeAllowedTools(stored), [...META_ACCOUNT_GRANT]);
  for (const name of META_ACCOUNT_GRANT) {
    assert.deepEqual([...metaAdsRuntimePropertyNames(stored, name)!].sort(), reviewedArguments(name), name);
  }

  // The reconnect's only change is the optional arguments Meta added.
  const live = Object.keys(META_LIVE_NAMES).map((name) => metaDiscoveredTool(name));
  for (const name of META_ACCOUNT_GRANT) {
    assert.notEqual(live.find((tool) => tool.name === name)?.inputSchema?.fingerprint,
      before.find((tool) => tool.name === name)?.inputSchema?.fingerprint, name);
  }
  const allowedTools = allowedToolsAfterMcpDiscovery(stored, live);
  assert.deepEqual(allowedTools, live.map(({ name }) => name).filter((name) => (META_ACCOUNT_GRANT as readonly string[]).includes(name)));
  assert.deepEqual([...allowedTools].sort(), [...META_ACCOUNT_GRANT].sort());
  assert.deepEqual(lines, [{
    event: 'chickpea.meta_ads.grant_kept_through_schema_change', tools: allowedTools,
  }]);

  const reconnected = { ...stored, discoveredTools: live, allowedTools };
  assert.deepEqual([...metaAdsRuntimeAllowedTools(reconnected)].sort(), [...META_ACCOUNT_GRANT].sort());
  for (const name of META_ACCOUNT_GRANT) {
    assert.deepEqual([...metaAdsRuntimePropertyNames(reconnected, name)!].sort(), reviewedArguments(name), name);
  }
});

test('a reconnect with an unchanged schema keeps the grant and logs nothing', (t) => {
  const lines = captureInfo(t);
  const live = Object.keys(META_LIVE_NAMES).map((name) => metaDiscoveredTool(name));
  const stored = grantOn(live);
  assert.deepEqual([...allowedToolsAfterMcpDiscovery(stored, live.map((tool) => structuredClone(tool)))].sort(),
    [...META_ACCOUNT_GRANT].sort());
  assert.deepEqual(lines, []);
});

test('a reconnect that removes the account field or adds a second one drops the tool', (t) => {
  captureInfo(t);
  const live = Object.keys(META_LIVE_NAMES).map((name) => metaDiscoveredTool(name));
  const stored = grantOn(live);
  const changed: ReadonlyArray<[string, McpConnectionToolInfo]> = [
    ['report without its account', metaDiscoveredTool('ads_get_ad_entities', undefined, { omit: ['ad_account_id'] })],
    ['insights read without its account', metaDiscoveredTool('ads_insights_anomaly_signal', undefined, {
      omit: ['ad_account_id'], required: [],
    })],
    ['report with a second account field', metaDiscoveredTool('ads_get_opportunity_score', undefined, {
      extra: { account_id: { type: 'string' } },
    })],
    ['report with a required second account field', metaDiscoveredTool('ads_insights_advertiser_context', undefined, {
      extra: { account_id: { type: 'string' } }, required: ['ad_account_id', 'account_id'],
    })],
    ['report whose account field changed name', metaDiscoveredTool('ads_insights_industry_benchmark', [
      ...META_LIVE_NAMES.ads_insights_industry_benchmark!.filter((name) => name !== 'ad_account_id'), 'account_id',
    ], { required: ['account_id'] })],
    ['write with a second account selector', metaDiscoveredTool('ads_create_ad', undefined, {
      extra: { ad_account_ids: { type: 'array', items: { type: 'string' } } },
    })],
    ['helper with an account field', metaDiscoveredTool(META_ADS_ACCOUNT_HELPER, undefined, {
      extra: { ad_account_id: { type: 'string' } },
    })],
    ['audience write with an account field', metaDiscoveredTool('ads_delete_custom_audience', undefined, {
      extra: { ad_account_id: { type: 'string' } },
    })],
  ];
  for (const [label, tool] of changed) {
    const next = live.map((entry) => entry.name === tool.name ? tool : entry);
    const allowed = allowedToolsAfterMcpDiscovery(stored, next);
    assert.equal(allowed.includes(tool.name), false, label);
    assert.equal(allowed.length, META_ACCOUNT_GRANT.length - 1, label);
  }
});

test('a reconnect drops a granted tool the reviewed contract no longer admits, even with an unchanged schema', (t) => {
  captureInfo(t);
  const live = Object.keys(META_LIVE_NAMES).map((name) => metaDiscoveredTool(name));
  const held = metaDiscoveredTool('ads_account_get_activity_logs', [
    'ad_account_id', 'advertiser_request', 'client_conversation_id', 'end_time', 'event_category', 'limit',
    'object_id', 'start_time', 'user_id',
  ]);
  const stored = { ...grantOn(live), discoveredTools: [...live, held] };
  stored.allowedTools = [...stored.allowedTools, held.name];
  const allowed = allowedToolsAfterMcpDiscovery(stored, [...live, structuredClone(held)]);
  assert.equal(allowed.includes(held.name), false);
  assert.deepEqual([...allowed].sort(), [...META_ACCOUNT_GRANT].sort());
});

test('a reconnect never adds a tool the grant did not name', (t) => {
  captureInfo(t);
  const before = Object.keys(META_PRE_NOVEMBER_NAMES).map((name) => metaDiscoveredTool(name, META_PRE_NOVEMBER_NAMES[name]));
  const live = Object.keys(META_LIVE_NAMES).map((name) => metaDiscoveredTool(name));
  const stored = { ...grantOn(before), allowedTools: ['ads_get_ad_entities'] };
  assert.deepEqual(allowedToolsAfterMcpDiscovery(stored, live), ['ads_get_ad_entities']);
  assert.deepEqual(allowedToolsAfterMcpDiscovery({ ...stored, allowedTools: [] }, live), []);
});
