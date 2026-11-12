import type {
  McpConnectionConfig,
  McpConnectionToolInfo,
  McpToolPolicy,
} from './types.ts';

export const META_ADS_MCP_URL = 'https://mcp.facebook.com/ads';

export const META_ADS_WRITE_TOOL_EFFECTS = {
  ads_create_campaign: 'write',
  ads_create_ad_set: 'write',
  ads_create_ad: 'write',
  ads_update_entity: 'write',
  ads_activate_entity: 'write',
  ads_create_creative: 'write',
  ads_boost_ig_post: 'write',
  ads_create_custom_audience: 'write',
  ads_update_custom_audience: 'write',
  ads_update_custom_audience_users: 'write',
  ads_delete_custom_audience: 'write',
} as const satisfies Readonly<Record<string, 'write'>>;

/** Tools reviewed against Meta's official Ads MCP documentation. */
export const META_ADS_REVIEWED_TOOL_EFFECTS = {
  ads_get_ad_account_custom_audiences: 'read',
  ads_get_ad_accounts: 'read',
  ads_get_ad_entities: 'read',
  ads_get_customconversions: 'read',
  ads_get_field_context: 'read',
  ads_get_opportunity_score: 'read',
  ads_insights_advertiser_context: 'read',
  ads_insights_anomaly_signal: 'read',
  ads_insights_auction_ranking_benchmarks: 'read',
  ads_insights_industry_benchmark: 'read',
  ads_insights_performance_trend: 'read',
  ...META_ADS_WRITE_TOOL_EFFECTS,
} as const satisfies Readonly<Record<string, 'read' | 'write'>>;

export const META_ADS_ACCOUNT_HELPER = 'ads_get_ad_accounts';
export const META_ADS_FIELD_HELPER = 'ads_get_field_context';
export const META_ADS_APPROVED_ACCOUNT_SCOPE = '$meta_ads_approved_account_id';
const MAX_META_ADS_SCHEMA_PROPERTIES = 256;

const META_ADS_HELPER_TOOLS = new Set<string>([
  META_ADS_ACCOUNT_HELPER,
  META_ADS_FIELD_HELPER,
]);

const META_ADS_ACCOUNTLESS_WRITE_TOOLS = new Set<string>([
  'ads_update_custom_audience',
  'ads_update_custom_audience_users',
  'ads_delete_custom_audience',
]);

const META_ADS_PAUSED_CREATION_TOOLS = new Set<string>([
  'ads_create_campaign',
  'ads_create_ad_set',
  'ads_create_ad',
  'ads_boost_ig_post',
]);

export interface MetaAdsWriteSchemaContract {
  accountScoped: boolean;
  ownershipFields: readonly string[];
  referenceFields: readonly string[];
  nestedPayloadFields: readonly string[];
  blockedRuntimeFields: readonly string[];
  entityType: boolean;
}

const META_ADS_WRITE_SCHEMA_CONTRACTS = {
  ads_create_campaign: {
    accountScoped: true, ownershipFields: [], referenceFields: [],
    nestedPayloadFields: ['budget_schedule_specs', 'iterative_split_test_configs', 'promoted_object'],
    blockedRuntimeFields: ['source_campaign_id', 'topline_id'], entityType: false,
  },
  ads_create_ad_set: {
    accountScoped: true, ownershipFields: ['campaign_id'], referenceFields: ['pixel_id'],
    nestedPayloadFields: ['targeting', 'promoted_object'],
    blockedRuntimeFields: [
      'brand_audience_id', 'budget_split_set_id', 'campaign_spec', 'conversion_goal_id',
      'include_in_ad_study_cell_id', 'include_in_ad_study_id',
    ],
    entityType: false,
  },
  ads_create_ad: {
    accountScoped: true, ownershipFields: ['ad_set_id'],
    referenceFields: ['creative_id', 'source_ad_id'], nestedPayloadFields: ['creative', 'tracking_specs'],
    blockedRuntimeFields: ['adset_spec'], entityType: false,
  },
  ads_update_entity: {
    accountScoped: true, ownershipFields: ['entity_id'], referenceFields: [], nestedPayloadFields: ['fields'],
    blockedRuntimeFields: [], entityType: true,
  },
  ads_activate_entity: {
    accountScoped: true, ownershipFields: ['entity_id'], referenceFields: [], nestedPayloadFields: [],
    blockedRuntimeFields: ['object_ids'], entityType: true,
  },
  ads_create_creative: {
    accountScoped: true, ownershipFields: [],
    referenceFields: [
      'page_id', 'instagram_actor_id', 'instagram_user_id', 'object_story_id', 'source_ad_id',
      'video_id',
    ],
    nestedPayloadFields: [
      'creative', 'object_story_spec', 'link_data', 'asset_feed_spec', 'degrees_of_freedom_spec',
      'advantage_plus_creative', 'advantage_plus_creative_features', 'cards',
      'facebook_partnership_ad', 'placement_videos',
    ],
    blockedRuntimeFields: ['product_set_id'], entityType: false,
  },
  ads_boost_ig_post: {
    accountScoped: true, ownershipFields: [],
    referenceFields: ['page_id', 'ig_account_id', 'ig_media_id'],
    nestedPayloadFields: ['targeting', 'creative', 'promoted_object'],
    blockedRuntimeFields: [], entityType: false,
  },
  ads_create_custom_audience: {
    accountScoped: true, ownershipFields: [],
    referenceFields: [
      'pixel_id', 'application_id', 'source_audience_id', 'origin_audience_id', 'business_id',
    ],
    nestedPayloadFields: ['rule', 'lookalike_spec'],
    blockedRuntimeFields: [], entityType: false,
  },
  ads_update_custom_audience: {
    accountScoped: false, ownershipFields: ['custom_audience_id'], referenceFields: [],
    nestedPayloadFields: ['fields', 'rule'], blockedRuntimeFields: [], entityType: false,
  },
  ads_update_custom_audience_users: {
    accountScoped: false, ownershipFields: ['audience_id'], referenceFields: ['session_id'],
    nestedPayloadFields: ['users', 'payload', 'schema'], blockedRuntimeFields: [], entityType: false,
  },
  ads_delete_custom_audience: {
    accountScoped: false, ownershipFields: ['custom_audience_id'], referenceFields: [],
    nestedPayloadFields: [], blockedRuntimeFields: [], entityType: false,
  },
} as const satisfies Readonly<Record<keyof typeof META_ADS_WRITE_TOOL_EFFECTS, MetaAdsWriteSchemaContract>>;

/**
 * The arguments each reviewed tool may send: what the model is shown and what a
 * call may carry. Anything else in Meta's live schema stays hidden and refused
 * until it is reviewed into this list, so a tool can't gain an input when Meta
 * adds one. A tool whose live schema requires another argument is unavailable.
 *
 * Tools reviewed before Meta's November change keep the names their schemas
 * listed then, minus the entity filters and alternate routes Chickpea never
 * sends (`object_ids`, `entity_ids`, and each write's `blockedRuntimeFields`).
 * Custom audiences and custom conversions, reviewed in November, keep their
 * live names minus `dataset_id` and Meta's November correlation fields
 * (`advertiser_job`, `after_answer_offer_report`, `scheduled_task_run`), which
 * no tool sends. The helpers send request metadata only: no pagination.
 */
const META_ADS_SENDABLE_ARGUMENTS = {
  ads_get_ad_account_custom_audiences: [
    'ad_account_id', 'advertiser_request', 'client_conversation_id', 'cursor', 'limit', 'subtype_filter',
  ],
  ads_get_ad_accounts: [
    'advertiser_request', 'client_conversation_id',
  ],
  ads_get_ad_entities: [
    'ad_account_id', 'advertiser_request', 'breakdowns', 'client_conversation_id', 'cursor', 'date_preset',
    'fields', 'filtering', 'include_additional_context', 'level', 'limit', 'object_state', 'sort',
    'time_increment', 'time_range',
  ],
  ads_get_customconversions: [
    'ad_account_id', 'advertiser_request', 'client_conversation_id', 'cursor', 'limit',
  ],
  ads_get_field_context: [
    'advertiser_request', 'client_conversation_id', 'field_names',
  ],
  ads_get_opportunity_score: [
    'ad_account_id', 'advertiser_request', 'client_conversation_id',
  ],
  ads_insights_advertiser_context: [
    'ad_account_id', 'advertiser_request', 'client_conversation_id', 'date_from', 'date_preset', 'date_to',
  ],
  ads_insights_anomaly_signal: [
    'ad_account_id', 'advertiser_request', 'client_conversation_id',
  ],
  ads_insights_auction_ranking_benchmarks: [
    'ad_account_id', 'advertiser_request', 'client_conversation_id', 'date_from', 'date_preset', 'date_to',
  ],
  ads_insights_industry_benchmark: [
    'ad_account_id', 'advertiser_request', 'analysis_metric', 'cas_segment', 'client_conversation_id',
    'conversation_intent', 'conversation_topic', 'date_from', 'date_preset', 'date_to',
    'optimization_goal_override',
  ],
  ads_insights_performance_trend: [
    'ad_account_id', 'advertiser_request', 'analysis_level', 'analysis_metric', 'client_conversation_id',
    'conversation_intent', 'conversation_topic', 'hide_ui',
  ],
  ads_create_campaign: [
    'ad_account_id', 'adlabels', 'advertiser_request', 'budget_schedule_specs', 'buying_type',
    'campaign_bid_strategy', 'campaign_daily_budget', 'campaign_lifetime_budget', 'campaign_name',
    'campaign_optimization_type', 'campaign_spend_cap', 'campaign_start_time', 'campaign_stop_time',
    'client_conversation_id', 'is_skadnetwork_attribution', 'is_using_l3_schedule', 'iterative_split_test_configs',
    'objective', 'promoted_object', 'special_ad_categories', 'special_ad_category_country',
  ],
  ads_create_ad_set: [
    'ad_account_id', 'ad_set_name', 'adjust_lookalikes', 'adlabels', 'adset_schedule', 'advertiser_request',
    'attribution_spec', 'automatic_manual_state', 'bid_amount', 'bid_constraints', 'bid_strategy', 'billing_event',
    'biz_ai_enabled_state', 'brand_safety_config', 'breakdown_effect_eligibility', 'budget_schedule_specs',
    'budget_source', 'calling_settings', 'campaign_active_time', 'campaign_attribution', 'campaign_id',
    'campaign_targeting_consolidation', 'client_conversation_id', 'contextual_bundling_spec',
    'conversion_locations', 'conversion_value_expression_spec', 'cost_bidding_mode', 'creative_diversity_data',
    'creative_diversity_label', 'creative_diversity_score', 'creative_fatigue_prediction_ple', 'creative_sequence',
    'daily_budget', 'daily_imps', 'daily_min_spend_target', 'daily_spend_cap', 'destination_type',
    'dsa_beneficiary', 'dsa_payor', 'end_time', 'existing_customer_budget_percentage', 'frequency_control_specs',
    'guidance_lift_estimate', 'io_number', 'is_dynamic_creative', 'is_dynamic_creative_format_automation',
    'is_dynamic_creative_optimization', 'is_incremental_attribution_enabled',
    'is_lifetime_flex_with_valid_schedule', 'is_message_marketing', 'is_sac_cfca_terms_certified',
    'lifetime_budget', 'lifetime_imps', 'lifetime_min_spend_target', 'lifetime_spend_cap',
    'lightweight_split_test_options', 'low_creative_reach', 'marketing_goal', 'max_budget_spend_percentage',
    'metrics_metadata', 'min_budget_spend_percentage', 'multi_event_conversion_attribution_window_seconds',
    'multi_optimization_goal_weight', 'naming_template_custom_fields', 'optimization_goal',
    'optimization_sub_event', 'pacing_type', 'partnership_ad_content_lists', 'placement', 'placement_soft_opt_out',
    'promoted_object', 'relative_value', 'reporting_audience', 'saved_audience', 'shops_ads_metadata_tags',
    'split_test_config_splits_index', 'start_time', 'targeting', 'targeting_as_signal',
    'time_based_ad_rotation_id_blocks', 'time_based_ad_rotation_intervals', 'time_start', 'time_stop',
    'time_suggestion', 'tune_for_category', 'value_rules_applied', 'value_rules_spec',
  ],
  ads_create_ad: [
    'ad_account_id', 'ad_name', 'ad_schedule_end_time', 'ad_schedule_start_time', 'ad_set_id', 'adlabels',
    'advertiser_request', 'bid_amount', 'client_conversation_id', 'conversion_domain', 'creative',
    'display_sequence', 'engagement_audience', 'source_ad_id', 'tracking_specs',
  ],
  ads_update_entity: [
    'ad_account_id', 'advertiser_request', 'client_conversation_id', 'entity_id', 'entity_type', 'fields',
  ],
  ads_activate_entity: [
    'ad_account_id', 'advertiser_request', 'client_conversation_id', 'entity_id', 'entity_type',
    'ignore_validation_errors',
  ],
  ads_create_creative: [
    'ad_account_id', 'advantage_plus_creative', 'advantage_plus_creative_features', 'advertiser_request',
    'call_to_action_type', 'cards', 'client_conversation_id', 'degrees_of_freedom_spec', 'description',
    'display_link', 'facebook_partnership_ad', 'headline', 'image_hash', 'image_url', 'instagram_user_id',
    'link_url', 'message', 'name', 'object_story_id', 'page_id', 'placement_videos', 'self_ai_disclosure',
    'video_id',
  ],
  ads_boost_ig_post: [
    'ad_account_id', 'ad_name', 'ad_set_name', 'advertiser_request', 'bid_amount', 'bid_strategy', 'billing_event',
    'buying_type', 'call_to_action', 'campaign_bid_strategy', 'campaign_daily_budget', 'campaign_lifetime_budget',
    'campaign_name', 'client_conversation_id', 'confirmed', 'daily_budget', 'destination_type', 'duration_days',
    'end_time', 'ig_account_id', 'ig_media_id', 'lifetime_budget', 'objective', 'optimization_goal',
    'promoted_object', 'special_ad_categories', 'start_time', 'targeting',
  ],
  ads_create_custom_audience: [
    'ad_account_id', 'advertiser_request', 'audience_labels', 'client_conversation_id', 'customer_file_source',
    'description', 'is_value_based', 'lookalike_ratio', 'name', 'origin_audience_id', 'prefill', 'retention_days',
    'rule', 'subtype',
  ],
  ads_update_custom_audience: [
    'advertiser_request', 'audience_labels', 'client_conversation_id', 'custom_audience_id', 'description', 'name',
    'rule',
  ],
  ads_update_custom_audience_users: [
    'advertiser_request', 'audience_id', 'client_conversation_id', 'customer_consent', 'data', 'debug_identifier',
    'operation', 'schema',
  ],
  ads_delete_custom_audience: [
    'advertiser_request', 'client_conversation_id', 'custom_audience_id',
  ],
} as const satisfies Readonly<Record<keyof typeof META_ADS_REVIEWED_TOOL_EFFECTS, readonly string[]>>;

export class MetaAdsAccessPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetaAdsAccessPolicyError';
  }
}

export interface CompileMetaAdsToolAccessInput {
  discoveredTools: readonly McpConnectionToolInfo[];
  requestedTools: readonly string[];
  approvedAccountIds: readonly string[];
}

export interface CompiledMetaAdsToolAccess {
  allowedTools: string[];
  toolPolicies: Record<string, McpToolPolicy>;
}

interface MetaAdsConnectionLocator {
  presetId?: string | undefined;
  url?: string | undefined;
}

/**
 * Compile explicit installer choices into the existing exact-argument policy.
 * Tool names and server annotations never establish either account scope or a
 * read-only effect. Authenticated schema evidence is required for every grant.
 */
export function compileMetaAdsToolAccess(
  input: CompileMetaAdsToolAccessInput,
): CompiledMetaAdsToolAccess {
  const requestedTools = uniqueStrings(input.requestedTools, 'Meta Ads tool');
  if (requestedTools.length === 0) return { allowedTools: [], toolPolicies: {} };
  const accountIds = normalizeMetaAdsAccountIds(input.approvedAccountIds);
  if (accountIds.length === 0) {
    throw new MetaAdsAccessPolicyError('Select at least one Meta ad account before granting tools.');
  }
  const policyEntries: Array<[string, McpToolPolicy]> = [];
  for (const name of requestedTools) {
    if (!isReviewedMetaAdsTool(name)) {
      throw new MetaAdsAccessPolicyError(`Meta Ads tool ${name} is not in the reviewed access contract.`);
    }
    const matches = input.discoveredTools.filter((tool) => tool.name === name);
    if (matches.length !== 1) {
      throw new MetaAdsAccessPolicyError(`Meta Ads tool ${name} is not uniquely present in current discovery.`);
    }
    const tool = matches[0]!;
    if (!metaAdsToolSchemaSupported(tool)) {
      throw new MetaAdsAccessPolicyError(`Meta Ads tool ${name} cannot be restricted to an approved ad account.`);
    }
    const field = isMetaAdsAccountScopeTool(name)
      ? META_ADS_APPROVED_ACCOUNT_SCOPE
      : metaAdsAccountField(tool)!;
    policyEntries.push([name, {
      effect: META_ADS_REVIEWED_TOOL_EFFECTS[name],
      argumentConstraints: { [field]: accountIds },
    }]);
  }
  return { allowedTools: requestedTools, toolPolicies: Object.fromEntries(policyEntries) };
}

export function isMetaAdsMcpConnection(
  connection: MetaAdsConnectionLocator,
): boolean {
  if (connection.presetId === 'meta-ads') return true;
  if (!connection.url) return false;
  try {
    const url = new URL(connection.url);
    const path = decodeURIComponent(url.pathname).replace(/\/+$/, '');
    return url.protocol === 'https:' && url.hostname === 'mcp.facebook.com' && url.port === '' &&
      url.username === '' && url.password === '' && path === '/ads';
  } catch {
    return false;
  }
}

/** Return only tools whose current schema and persisted exact constraint agree. */
export function metaAdsRuntimeAllowedTools(
  connection: Pick<McpConnectionConfig, 'discoveredTools' | 'toolPolicies' | 'allowedTools'>,
): string[] {
  return connection.allowedTools.filter((name) => metaAdsRuntimeConstraint(connection, name) !== undefined);
}

/**
 * Revalidate persisted policy against current authenticated discovery. A
 * schema-less, duplicate, ambiguous, optional, or differently constrained tool
 * has no executable Meta policy.
 */
export function metaAdsRuntimeConstraint(
  connection: Pick<McpConnectionConfig, 'discoveredTools' | 'toolPolicies'>,
  name: string,
): Record<string, string[]> | undefined {
  if (!isReviewedMetaAdsTool(name)) return undefined;
  const matches = connection.discoveredTools.filter((tool) => tool.name === name);
  if (matches.length !== 1) return undefined;
  if (isMetaAdsAccountScopeTool(name)) {
    if (!metaAdsToolSchemaSupported(matches[0]!)) return undefined;
    return normalizedMetaAdsHelperScope(connection.toolPolicies?.[name]?.argumentConstraints);
  }
  const field = metaAdsAccountField(matches[0]!);
  if (!field) return undefined;
  const constraints = connection.toolPolicies?.[name]?.argumentConstraints;
  return metaAdsConstraintField(constraints) === field ? normalizedConstraint(constraints, field) : undefined;
}

/** Validate the frozen/runtime form even when authenticated discovery is not embedded in it. */
export function metaAdsConstraintField(
  constraints: Record<string, string[]> | undefined,
): 'ad_account_id' | 'account_id' | undefined {
  if (!constraints) return undefined;
  const keys = Object.keys(constraints);
  if (keys.length !== 1) return undefined;
  const field = keys[0];
  if (field !== 'ad_account_id' && field !== 'account_id') return undefined;
  return normalizedConstraint(constraints, field) ? field : undefined;
}

/** Validate a frozen Meta constraint without treating helper scope as provider input. */
export function metaAdsRuntimePolicyConstraint(
  name: string,
  constraints: Record<string, string[]> | undefined,
): Record<string, string[]> | undefined {
  if (isMetaAdsAccountScopeTool(name)) return normalizedMetaAdsHelperScope(constraints);
  const field = metaAdsConstraintField(constraints);
  return field ? normalizedConstraint(constraints, field) : undefined;
}

/** A supported account-scoped tool's one required scalar account field. */
export function metaAdsAccountField(tool: McpConnectionToolInfo): 'ad_account_id' | 'account_id' | undefined {
  if (isMetaAdsAccountScopeTool(tool.name) || !metaAdsToolSchemaSupported(tool)) return undefined;
  return tool.inputSchema!.accountFields[0]!.name;
}

/**
 * Admission from a stored discovery. Discovery already refused a schema that
 * requires an argument outside the tool's sendable list; here the account
 * field rule holds and no other account-shaped property exists. Other stored
 * names are ignored: they are never shown or sent.
 */
export function metaAdsToolSchemaSupported(tool: McpConnectionToolInfo): boolean {
  if (!isReviewedMetaAdsTool(tool.name)) return false;
  const schema = tool.inputSchema;
  if (!schema || schema.ambiguous || !/^[a-f0-9]{64}$/.test(schema.fingerprint)) return false;
  const names = schema.propertyNames;
  if (!Array.isArray(names) || names.length > MAX_META_ADS_SCHEMA_PROPERTIES || new Set(names).size !== names.length ||
      names.some((value) => typeof value !== 'string' || value.length === 0 || value.length > 120)) return false;
  // Every account-shaped name must be one the contract reviewed, such as the
  // account field itself or a boost's ig_account_id.
  const sendable = metaAdsSendableArgumentNames(tool.name);
  if (names.some((name) => /account/i.test(name) && !sendable.includes(name))) return false;
  if (isMetaAdsAccountScopeTool(tool.name)) {
    if (schema.accountFields.length !== 0) return false;
  } else {
    const [field] = schema.accountFields;
    if (schema.accountFields.length !== 1 || !field || field.type !== 'string' || !field.required ||
        !names.includes(field.name)) return false;
  }
  const contract = metaAdsWriteSchemaContract(tool.name);
  return !contract || (contract.ownershipFields.every((field) => names.includes(field)) &&
    (!contract.entityType || names.includes('entity_type')));
}

/** The arguments a reviewed tool may send. Discovery refuses a tool that requires any other. */
export function metaAdsSendableArgumentNames(name: string): readonly string[] {
  return isReviewedMetaAdsTool(name) ? META_ADS_SENDABLE_ARGUMENTS[name] : [];
}

/** Trusted server-owned effect metadata for the reviewed Meta tool contract. */
export function metaAdsToolEffect(name: string): 'read' | 'write' | undefined {
  return isReviewedMetaAdsTool(name) ? META_ADS_REVIEWED_TOOL_EFFECTS[name] : undefined;
}

/** What a call to a tool whose stored discovery the contract admits may send. */
export function metaAdsRuntimePropertyNames(
  connection: Pick<McpConnectionConfig, 'discoveredTools'>,
  name: string,
): string[] | undefined {
  const matches = connection.discoveredTools.filter((tool) => tool.name === name);
  if (matches.length !== 1 || !metaAdsToolSchemaSupported(matches[0]!)) return undefined;
  return [...metaAdsSendableArgumentNames(name)];
}

/**
 * Whether a granted tool stays granted after rediscovery: the contract still
 * admits its new schema, with the account field it had. A schema change alone
 * doesn't drop it, because the arguments it may send come from the contract.
 * A write's schema contract is part of admission.
 */
export function metaAdsGrantSurvivesDiscovery(
  previous: McpConnectionToolInfo | undefined,
  next: McpConnectionToolInfo,
): boolean {
  if (!previous?.inputSchema || !metaAdsToolSchemaSupported(next)) return false;
  const accountFields = (tool: McpConnectionToolInfo) => JSON.stringify(tool.inputSchema!.accountFields.map(({ name }) => name));
  return accountFields(previous) === accountFields(next);
}

export function isMetaAdsHelperTool(name: string): boolean {
  return META_ADS_HELPER_TOOLS.has(name);
}

export function isMetaAdsWriteTool(name: string): name is keyof typeof META_ADS_WRITE_TOOL_EFFECTS {
  return Object.hasOwn(META_ADS_WRITE_TOOL_EFFECTS, name);
}

/** Tools whose approved account list is policy scope rather than provider input. */
export function isMetaAdsAccountScopeTool(name: string): boolean {
  return isMetaAdsHelperTool(name) || META_ADS_ACCOUNTLESS_WRITE_TOOLS.has(name);
}

export function metaAdsWriteSchemaContract(name: string): MetaAdsWriteSchemaContract | undefined {
  return isMetaAdsWriteTool(name) ? META_ADS_WRITE_SCHEMA_CONTRACTS[name] : undefined;
}

/**
 * Validate mutation routing arguments and return IDs whose Graph account owner
 * must be checked before dispatch. Account IDs themselves remain constraints,
 * not ownership lookup targets.
 */
export function metaAdsWriteOwnershipTargets(name: string, argumentsValue: unknown): string[] {
  const contract = metaAdsWriteSchemaContract(name);
  if (!contract) return [];
  if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
    throw new MetaAdsAccessPolicyError(`Meta Ads write tool ${name} requires an object argument.`);
  }
  const args = argumentsValue as Record<string, unknown>;
  if (contract.accountScoped) {
    const accountFields = ['ad_account_id', 'account_id'].filter((field) => field in args);
    if (accountFields.length !== 1 || typeof args[accountFields[0]!] !== 'string' ||
        canonicalMetaAdsAccountId(args[accountFields[0]!] as string) === undefined) {
      throw new MetaAdsAccessPolicyError(`Meta Ads write tool ${name} requires one valid ad account ID.`);
    }
  } else if ('ad_account_id' in args || 'account_id' in args) {
    throw new MetaAdsAccessPolicyError(`Meta Ads write tool ${name} does not accept an ad account argument.`);
  }
  const targets = contract.ownershipFields.map((field) => {
    const value = args[field];
    if (typeof value !== 'string' || !/^[0-9]{1,32}$/.test(value)) {
      throw new MetaAdsAccessPolicyError(`Meta Ads write tool ${name} requires a valid ${field}.`);
    }
    return value;
  });
  if (contract.entityType) {
    const entityType = args.entity_type;
    if (entityType !== 'campaign' && entityType !== 'ad_set' && entityType !== 'ad') {
      throw new MetaAdsAccessPolicyError(
        `Meta Ads write tool ${name} requires entity_type campaign, ad_set, or ad.`,
      );
    }
  }
  if (META_ADS_PAUSED_CREATION_TOOLS.has(name)) {
    if ('status' in args && args.status !== 'PAUSED') {
      throw new MetaAdsAccessPolicyError(`Meta Ads write tool ${name} permits status only as PAUSED.`);
    }
  }
  if ((name === 'ads_update_entity' || name === 'ads_update_custom_audience') && 'fields' in args) {
    const fields = assertNoMetaAdsRoutingOverride(args.fields);
    if (name === 'ads_update_entity' && fields) assertMetaAdsEntityUpdateFields(fields);
  }
  return targets;
}

export function metaAdsApprovedAccountIds(
  constraints: Record<string, string[]> | undefined,
): string[] | undefined {
  return normalizedMetaAdsHelperScope(constraints)?.[META_ADS_APPROVED_ACCOUNT_SCOPE];
}

export function canonicalMetaAdsAccountId(value: string): string | undefined {
  if (value.trim() !== value || !/^(?:act_)?[0-9]{1,32}$/.test(value)) return undefined;
  return value.startsWith('act_') ? value.slice(4) : value;
}

/** Runtime value bounds for the exact helper-owned metadata arguments. */
export function assertMetaAdsHelperArguments(name: string, argumentsValue: unknown): void {
  if (!isMetaAdsHelperTool(name) || argumentsValue === undefined) return;
  if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
    throw new Error(`Meta Ads helper ${name} requires an object argument.`);
  }
  const args = argumentsValue as Record<string, unknown>;
  if ('advertiser_request' in args && !boundedHelperString(args.advertiser_request, 4_096)) {
    throw new Error(`Meta Ads helper ${name} has an invalid advertiser_request value.`);
  }
  if ('client_conversation_id' in args && args.client_conversation_id !== null &&
      !boundedHelperString(args.client_conversation_id, 4_096)) {
    throw new Error(`Meta Ads helper ${name} has an invalid client_conversation_id value.`);
  }
  if ('field_names' in args) {
    const fields = args.field_names;
    const valid = Array.isArray(fields) && fields.length > 0 && fields.length <= 64 &&
      fields.every((field) => boundedFieldName(field)) && new Set(fields).size === fields.length;
    if (!valid) throw new Error(`Meta Ads helper ${name} has an invalid field_names value.`);
  }
}

export function normalizeMetaAdsAccountIds(ids: readonly string[]): string[] {
  const values = uniqueStrings(ids, 'Meta ad account');
  if (values.length > 50) throw new MetaAdsAccessPolicyError('Select no more than 50 Meta ad accounts.');
  if (values.some((value) => !/^(?:act_)?[0-9]{1,32}$/.test(value))) {
    throw new MetaAdsAccessPolicyError('Meta ad account IDs must contain 1 to 32 digits, optionally prefixed with act_.');
  }
  return values;
}

export function isReviewedMetaAdsTool(name: string): name is keyof typeof META_ADS_REVIEWED_TOOL_EFFECTS {
  return Object.hasOwn(META_ADS_REVIEWED_TOOL_EFFECTS, name);
}

function normalizedConstraint(
  constraints: Record<string, string[]> | undefined,
  field: 'ad_account_id' | 'account_id',
): Record<string, string[]> | undefined {
  const allowed = constraints?.[field];
  if (!Array.isArray(allowed) || allowed.length === 0 ||
      allowed.some((value) => typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > 120)) {
    return undefined;
  }
  return { [field]: [...new Set(allowed)] };
}

function normalizedMetaAdsHelperScope(
  constraints: Record<string, string[]> | undefined,
): Record<string, string[]> | undefined {
  if (!constraints || Object.keys(constraints).length !== 1) return undefined;
  const allowed = constraints[META_ADS_APPROVED_ACCOUNT_SCOPE];
  if (!Array.isArray(allowed) || allowed.length === 0 || allowed.length > 50) return undefined;
  const normalized = [...new Set(allowed)];
  if (normalized.length !== allowed.length || normalized.some((value) =>
    typeof value !== 'string' || value.trim() !== value || canonicalMetaAdsAccountId(value) === undefined)) {
    return undefined;
  }
  return { [META_ADS_APPROVED_ACCOUNT_SCOPE]: normalized };
}

function assertNoMetaAdsRoutingOverride(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  let decoded: unknown = value;
  if (typeof value === 'string') {
    if (value.length === 0 || value.length > 65_536) {
      throw new MetaAdsAccessPolicyError('Meta Ads update fields are invalid.');
    }
    try {
      decoded = JSON.parse(value) as unknown;
    } catch {
      throw new MetaAdsAccessPolicyError('Meta Ads update fields must contain valid JSON.');
    }
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new MetaAdsAccessPolicyError('Meta Ads update fields must be an object.');
  }
  const routingFields = new Set([
    'ad_account_id', 'account_id', 'campaign_id', 'ad_set_id', 'adset_id', 'entity_id',
    'entity_type', 'custom_audience_id', 'audience_id',
  ]);
  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > 4_096 || depth > 16) {
      throw new MetaAdsAccessPolicyError('Meta Ads update fields exceed the supported structure.');
    }
    if (Array.isArray(current)) {
      for (const entry of current) visit(entry, depth + 1);
      return;
    }
    if (!current || typeof current !== 'object') return;
    for (const [key, entry] of Object.entries(current as Record<string, unknown>)) {
      if (routingFields.has(key) || (depth === 0 && key === 'id')) {
        throw new MetaAdsAccessPolicyError(`Meta Ads update fields cannot override ${key}.`);
      }
      visit(entry, depth + 1);
    }
  };
  visit(decoded, 0);
  return decoded as Record<string, unknown>;
}

function assertMetaAdsEntityUpdateFields(fields: Record<string, unknown>): void {
  if ('status' in fields) {
    if (fields.status !== 'PAUSED') {
      throw new MetaAdsAccessPolicyError(
        'Meta Ads entity updates permit status only as PAUSED. Use the activation tool to activate an entity.',
      );
    }
    if (Object.keys(fields).length !== 1) {
      throw new MetaAdsAccessPolicyError(
        'Meta Ads entity status changes require a dedicated status-only update.',
      );
    }
  }

  const readonlyStatuses = new Set(['configured_status', 'effective_status']);
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const entry of current) visit(entry);
      return;
    }
    if (!current || typeof current !== 'object') return;
    for (const [key, entry] of Object.entries(current as Record<string, unknown>)) {
      if (readonlyStatuses.has(key)) {
        throw new MetaAdsAccessPolicyError(
          'Meta Ads entity updates cannot write configured_status or effective_status.',
        );
      }
      visit(entry);
    }
  };
  visit(fields);
}

function uniqueStrings(values: readonly string[], label: string): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== 'string') throw new MetaAdsAccessPolicyError(`${label} selection is invalid.`);
    const value = raw.trim();
    if (!value || value.length > 120 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new MetaAdsAccessPolicyError(`${label} selection is invalid.`);
    }
    if (!seen.has(value)) {
      seen.add(value);
      unique.push(value);
    }
  }
  return unique;
}

function boundedHelperString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function boundedFieldName(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 120 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}
