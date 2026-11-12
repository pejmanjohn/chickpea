// Meta's reviewed tools by property name, as Amber stored them. Discovery keeps
// names and the account field's flags, not definitions, so `metaToolSchema`
// fills in stand-in types and required lists.
//
// META_PRE_NOVEMBER_NAMES: the stored discovery of 2026-10-30, before Meta's
// November change (2026-10-24 stored the same names). Custom audiences and
// custom conversions were not reviewed then, so discovery kept no names.
// META_LIVE_NAMES: a fresh discovery on 2026-11-11. Meta no longer lists
// ads_update_custom_audience_users.
import { projectMcpToolInputSchema } from '../../src/config/mcp-test.ts';
import { metaAdsWriteSchemaContract } from '../../src/config/meta-ads-policy.ts';
import type { McpConnectionToolInfo } from '../../src/config/types.ts';

export const META_PRE_NOVEMBER_NAMES: Readonly<Record<string, readonly string[]>> = {
  ads_get_ad_accounts: [
    'advertiser_request', 'client_conversation_id', 'cursor', 'limit',
  ],
  ads_get_ad_entities: [
    'ad_account_id', 'advertiser_request', 'breakdowns', 'client_conversation_id', 'cursor', 'date_preset',
    'fields', 'filtering', 'include_additional_context', 'level', 'limit', 'object_ids', 'object_state', 'sort',
    'time_increment', 'time_range',
  ],
  ads_get_field_context: [
    'advertiser_request', 'client_conversation_id', 'field_names',
  ],
  ads_get_opportunity_score: [
    'ad_account_id', 'advertiser_request', 'client_conversation_id',
  ],
  ads_insights_advertiser_context: [
    'ad_account_id', 'advertiser_request', 'client_conversation_id', 'date_from', 'date_preset', 'date_to',
    'entity_ids',
  ],
  ads_insights_anomaly_signal: [
    'ad_account_id', 'advertiser_request', 'client_conversation_id', 'entity_ids',
  ],
  ads_insights_auction_ranking_benchmarks: [
    'ad_account_id', 'advertiser_request', 'client_conversation_id', 'date_from', 'date_preset', 'date_to',
    'entity_ids',
  ],
  ads_insights_industry_benchmark: [
    'ad_account_id', 'advertiser_request', 'analysis_metric', 'cas_segment', 'client_conversation_id',
    'conversation_intent', 'conversation_topic', 'date_from', 'date_preset', 'date_to', 'entity_ids',
    'optimization_goal_override',
  ],
  ads_insights_performance_trend: [
    'ad_account_id', 'advertiser_request', 'analysis_level', 'analysis_metric', 'client_conversation_id',
    'conversation_intent', 'conversation_topic', 'entity_ids', 'hide_ui',
  ],
  ads_create_campaign: [
    'ad_account_id', 'adlabels', 'advertiser_request', 'budget_schedule_specs', 'buying_type',
    'campaign_bid_strategy', 'campaign_daily_budget', 'campaign_lifetime_budget', 'campaign_name',
    'campaign_optimization_type', 'campaign_spend_cap', 'campaign_start_time', 'campaign_stop_time',
    'client_conversation_id', 'is_skadnetwork_attribution', 'is_using_l3_schedule', 'iterative_split_test_configs',
    'objective', 'promoted_object', 'source_campaign_id', 'special_ad_categories', 'special_ad_category_country',
    'topline_id',
  ],
  ads_create_ad_set: [
    'ad_account_id', 'ad_set_name', 'adjust_lookalikes', 'adlabels', 'adset_schedule', 'advertiser_request',
    'attribution_spec', 'automatic_manual_state', 'bid_amount', 'bid_constraints', 'bid_strategy', 'billing_event',
    'biz_ai_enabled_state', 'brand_audience_id', 'brand_safety_config', 'breakdown_effect_eligibility',
    'budget_schedule_specs', 'budget_source', 'budget_split_set_id', 'calling_settings', 'campaign_active_time',
    'campaign_attribution', 'campaign_id', 'campaign_spec', 'campaign_targeting_consolidation',
    'client_conversation_id', 'contextual_bundling_spec', 'conversion_goal_id', 'conversion_locations',
    'conversion_value_expression_spec', 'cost_bidding_mode', 'creative_diversity_data', 'creative_diversity_label',
    'creative_diversity_score', 'creative_fatigue_prediction_ple', 'creative_sequence', 'daily_budget',
    'daily_imps', 'daily_min_spend_target', 'daily_spend_cap', 'destination_type', 'dsa_beneficiary', 'dsa_payor',
    'end_time', 'existing_customer_budget_percentage', 'frequency_control_specs', 'guidance_lift_estimate',
    'include_in_ad_study_cell_id', 'include_in_ad_study_id', 'io_number', 'is_dynamic_creative',
    'is_dynamic_creative_format_automation', 'is_dynamic_creative_optimization',
    'is_incremental_attribution_enabled', 'is_lifetime_flex_with_valid_schedule', 'is_message_marketing',
    'is_sac_cfca_terms_certified', 'lifetime_budget', 'lifetime_imps', 'lifetime_min_spend_target',
    'lifetime_spend_cap', 'lightweight_split_test_options', 'low_creative_reach', 'marketing_goal',
    'max_budget_spend_percentage', 'metrics_metadata', 'min_budget_spend_percentage',
    'multi_event_conversion_attribution_window_seconds', 'multi_optimization_goal_weight',
    'naming_template_custom_fields', 'optimization_goal', 'optimization_sub_event', 'pacing_type',
    'partnership_ad_content_lists', 'placement', 'placement_soft_opt_out', 'promoted_object', 'relative_value',
    'reporting_audience', 'rf_prediction_id', 'saved_audience', 'saved_audience_id', 'shops_ads_metadata_tags',
    'source_adset_id', 'split_test_config_splits_index', 'start_time', 'targeting', 'targeting_as_signal',
    'time_based_ad_rotation_id_blocks', 'time_based_ad_rotation_intervals', 'time_start', 'time_stop',
    'time_suggestion', 'tune_for_category', 'value_rule_set_id', 'value_rules_applied', 'value_rules_spec',
  ],
  ads_create_ad: [
    'ad_account_id', 'ad_name', 'ad_schedule_end_time', 'ad_schedule_start_time', 'ad_set_id', 'adlabels',
    'adset_spec', 'advertiser_request', 'bid_amount', 'client_conversation_id', 'conversion_domain', 'creative',
    'display_sequence', 'engagement_audience', 'source_ad_id', 'tracking_specs',
  ],
  ads_update_entity: [
    'ad_account_id', 'advertiser_request', 'client_conversation_id', 'entity_id', 'entity_type', 'fields',
  ],
  ads_activate_entity: [
    'ad_account_id', 'advertiser_request', 'client_conversation_id', 'entity_id', 'entity_type',
    'ignore_validation_errors', 'object_ids',
  ],
  ads_create_creative: [
    'ad_account_id', 'advantage_plus_creative', 'advantage_plus_creative_features', 'advertiser_request',
    'call_to_action_type', 'cards', 'client_conversation_id', 'degrees_of_freedom_spec', 'description',
    'display_link', 'facebook_partnership_ad', 'headline', 'image_hash', 'image_url', 'instagram_user_id',
    'link_url', 'message', 'name', 'object_story_id', 'page_id', 'placement_videos', 'product_set_id',
    'self_ai_disclosure', 'video_id',
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
};

export const META_LIVE_NAMES: Readonly<Record<string, readonly string[]>> = {
  ads_get_ad_account_custom_audiences: [
    'ad_account_id', 'advertiser_job', 'advertiser_request', 'after_answer_offer_report', 'client_conversation_id',
    'cursor', 'limit', 'scheduled_task_run', 'subtype_filter',
  ],
  ads_get_ad_accounts: [
    'advertiser_job', 'advertiser_request', 'after_answer_offer_report', 'client_conversation_id', 'cursor',
    'limit', 'scheduled_task_run', 'show_suggested_actions',
  ],
  ads_get_ad_entities: [
    'action_attribution_windows', 'ad_account_id', 'advertiser_job', 'advertiser_request',
    'after_answer_offer_report', 'breakdowns', 'client_conversation_id', 'cursor', 'date_preset', 'fields',
    'filtering', 'include_additional_context', 'level', 'limit', 'object_ids', 'object_state', 'reporting_purpose',
    'scheduled_task_run', 'sort', 'time_increment', 'time_range',
  ],
  ads_get_customconversions: [
    'ad_account_id', 'advertiser_job', 'advertiser_request', 'after_answer_offer_report', 'client_conversation_id',
    'cursor', 'dataset_id', 'limit', 'scheduled_task_run',
  ],
  ads_get_field_context: [
    'advertiser_job', 'advertiser_request', 'after_answer_offer_report', 'client_conversation_id', 'field_names',
    'scheduled_task_run',
  ],
  ads_get_opportunity_score: [
    'ad_account_id', 'advertiser_job', 'advertiser_request', 'after_answer_offer_report', 'client_conversation_id',
    'scheduled_task_run',
  ],
  ads_insights_advertiser_context: [
    'ad_account_id', 'advertiser_job', 'advertiser_request', 'after_answer_offer_report', 'client_conversation_id',
    'date_from', 'date_preset', 'date_to', 'entity_ids', 'scheduled_task_run',
  ],
  ads_insights_anomaly_signal: [
    'ad_account_id', 'advertiser_job', 'advertiser_request', 'after_answer_offer_report', 'client_conversation_id',
    'entity_ids', 'scheduled_task_run',
  ],
  ads_insights_auction_ranking_benchmarks: [
    'ad_account_id', 'advertiser_job', 'advertiser_request', 'after_answer_offer_report', 'client_conversation_id',
    'date_from', 'date_preset', 'date_to', 'entity_ids', 'scheduled_task_run',
  ],
  ads_insights_industry_benchmark: [
    'ad_account_id', 'advertiser_job', 'advertiser_request', 'after_answer_offer_report', 'analysis_metric',
    'cas_segment', 'client_conversation_id', 'conversation_intent', 'conversation_topic', 'date_from',
    'date_preset', 'date_to', 'entity_ids', 'optimization_goal_override', 'scheduled_task_run', 'sub_vertical',
  ],
  ads_insights_performance_trend: [
    'ad_account_id', 'advertiser_job', 'advertiser_request', 'after_answer_offer_report', 'analysis_level',
    'analysis_metric', 'client_conversation_id', 'conversation_intent', 'conversation_topic', 'entity_ids',
    'hide_ui', 'scheduled_task_run',
  ],
  ads_create_campaign: [
    'ad_account_id', 'adlabels', 'advertiser_job', 'advertiser_request', 'budget_schedule_specs', 'buying_type',
    'campaign_bid_strategy', 'campaign_daily_budget', 'campaign_lifetime_budget', 'campaign_name',
    'campaign_optimization_type', 'campaign_spend_cap', 'campaign_start_time', 'campaign_stop_time',
    'client_conversation_id', 'hide_ui', 'is_skadnetwork_attribution', 'is_using_l3_schedule',
    'iterative_split_test_configs', 'objective', 'promoted_object', 'scheduled_task_run', 'source_campaign_id',
    'special_ad_categories', 'special_ad_category_country', 'topline_id',
  ],
  ads_create_ad_set: [
    'ad_account_id', 'ad_set_name', 'adjust_lookalikes', 'adlabels', 'adset_schedule',
    'advantage_audience_off_reason', 'advertiser_job', 'advertiser_request', 'attribution_spec',
    'automatic_manual_state', 'bid_amount', 'bid_constraints', 'bid_strategy', 'billing_event',
    'biz_ai_enabled_state', 'brand_audience_id', 'brand_safety_config', 'breakdown_effect_eligibility',
    'budget_schedule_specs', 'budget_source', 'budget_split_set_id', 'calling_settings', 'campaign_active_time',
    'campaign_attribution', 'campaign_id', 'campaign_spec', 'campaign_targeting_consolidation',
    'client_conversation_id', 'contextual_bundling_spec', 'conversion_goal_id', 'conversion_locations',
    'conversion_value_expression_spec', 'cost_bidding_mode', 'creative_diversity_data', 'creative_diversity_label',
    'creative_diversity_score', 'creative_fatigue_prediction_ple', 'creative_sequence', 'daily_budget',
    'daily_imps', 'daily_min_spend_target', 'daily_spend_cap', 'destination_type', 'dsa_beneficiary', 'dsa_payor',
    'end_time', 'existing_customer_budget_percentage', 'frequency_control_specs', 'guidance_lift_estimate',
    'hide_ui', 'include_in_ad_study_cell_id', 'include_in_ad_study_id', 'io_number', 'is_dynamic_creative',
    'is_dynamic_creative_format_automation', 'is_dynamic_creative_optimization',
    'is_incremental_attribution_enabled', 'is_lifetime_flex_with_valid_schedule', 'is_message_marketing',
    'is_sac_cfca_terms_certified', 'lifetime_budget', 'lifetime_imps', 'lifetime_min_spend_target',
    'lifetime_spend_cap', 'lightweight_split_test_options', 'low_creative_reach', 'marketing_goal',
    'max_budget_spend_percentage', 'metrics_metadata', 'min_budget_spend_percentage',
    'multi_event_conversion_attribution_window_seconds', 'multi_optimization_goal_weight',
    'naming_template_custom_fields', 'optimization_goal', 'optimization_sub_event', 'pacing_type',
    'partnership_ad_content_lists', 'placement', 'placement_soft_opt_out', 'promoted_object', 'relative_value',
    'reporting_audience', 'rf_prediction_id', 'saved_audience', 'saved_audience_id', 'scheduled_task_run',
    'shops_ads_metadata_tags', 'source_adset_id', 'split_test_config_splits_index', 'start_time', 'targeting',
    'targeting_as_signal', 'time_based_ad_rotation_id_blocks', 'time_based_ad_rotation_intervals', 'time_start',
    'time_stop', 'time_suggestion', 'tune_for_category', 'value_rule_set_id', 'value_rules_applied',
    'value_rules_spec',
  ],
  ads_create_ad: [
    'ad_account_id', 'ad_name', 'ad_schedule_end_time', 'ad_schedule_start_time', 'ad_set_id', 'adlabels',
    'adset_spec', 'advertiser_job', 'advertiser_request', 'bid_amount', 'client_conversation_id',
    'conversion_domain', 'creative', 'display_sequence', 'engagement_audience', 'hide_ui', 'scheduled_task_run',
    'source_ad_id', 'tracking_specs',
  ],
  ads_update_entity: [
    'ad_account_id', 'advantage_audience_off_reason', 'advertiser_job', 'advertiser_request',
    'client_conversation_id', 'confirmation_token', 'discard_draft_changes', 'entity_id', 'entity_type', 'fields',
    'hide_ui', 'scheduled_task_run',
  ],
  ads_activate_entity: [
    'ad_account_id', 'advertiser_job', 'advertiser_request', 'allow_partial_publish', 'client_conversation_id',
    'entity_id', 'entity_type', 'ignore_validation_errors', 'object_ids', 'publish_as_active',
    'scheduled_task_run',
  ],
  ads_create_creative: [
    'ad_account_id', 'advantage_plus_creative', 'advantage_plus_creative_features', 'advertiser_job',
    'advertiser_request', 'call_to_action_type', 'cards', 'client_conversation_id', 'conversion_location',
    'degrees_of_freedom_spec', 'description', 'descriptions', 'display_link', 'facebook_partnership_ad',
    'headline', 'headlines', 'image_hash', 'image_url', 'instagram_partnership_ad', 'instagram_user_id',
    'lead_gen_form_id', 'link_url', 'message', 'multi_media', 'name', 'object_story_id', 'objective', 'page_id',
    'placement_customizations', 'placement_videos', 'primary_texts', 'product_extensions_product_set_id',
    'product_set_id', 'scheduled_task_run', 'self_ai_disclosure', 'source_instagram_media_id', 'url_tags',
    'video_id',
  ],
  ads_boost_ig_post: [
    'ad_account_id', 'ad_code', 'ad_name', 'ad_set_name', 'advertiser_job', 'advertiser_request', 'bid_amount',
    'bid_strategy', 'billing_event', 'buying_type', 'call_to_action', 'call_to_action_type',
    'call_to_action_value', 'campaign_bid_strategy', 'campaign_daily_budget', 'campaign_lifetime_budget',
    'campaign_name', 'client_conversation_id', 'confirmed', 'daily_budget', 'destination_type', 'duration_days',
    'end_time', 'ig_account_id', 'ig_media_id', 'lifetime_budget', 'objective', 'optimization_goal',
    'promoted_object', 'scheduled_task_run', 'special_ad_categories', 'sponsor_id', 'start_time', 'targeting',
    'url_tags',
  ],
  ads_create_custom_audience: [
    'ad_account_id', 'advertiser_job', 'advertiser_request', 'audience_labels', 'client_conversation_id',
    'customer_file_source', 'description', 'is_value_based', 'lookalike_ratio', 'name', 'origin_audience_id',
    'prefill', 'retention_days', 'rule', 'scheduled_task_run', 'subtype',
  ],
  ads_update_custom_audience: [
    'advertiser_job', 'advertiser_request', 'audience_labels', 'client_conversation_id', 'custom_audience_id',
    'description', 'name', 'rule', 'scheduled_task_run',
  ],
  ads_delete_custom_audience: [
    'advertiser_job', 'advertiser_request', 'client_conversation_id', 'custom_audience_id', 'scheduled_task_run',
  ],
};

/** Meta's November correlation fields, which no reviewed tool listed before. */
export const META_NOVEMBER_CORRELATION = ['advertiser_job', 'after_answer_offer_report', 'scheduled_task_run'] as const;

/** A 15-tool grant from the QA lane before Meta's November change: seven reads, both helpers and six writes. */
export const META_ACCOUNT_GRANT = [
  'ads_activate_entity', 'ads_create_ad', 'ads_create_custom_audience', 'ads_delete_custom_audience',
  'ads_get_ad_accounts', 'ads_get_ad_entities', 'ads_get_field_context', 'ads_get_opportunity_score',
  'ads_insights_advertiser_context', 'ads_insights_anomaly_signal', 'ads_insights_auction_ranking_benchmarks',
  'ads_insights_industry_benchmark', 'ads_insights_performance_trend', 'ads_update_custom_audience',
  'ads_update_entity',
] as const;

const text = { type: 'string' };
const REQUIRED_REFERENCES: Readonly<Record<string, readonly string[]>> = {
  ads_boost_ig_post: ['ig_account_id', 'ig_media_id'],
};

function standIn(tool: string, name: string, required: boolean): unknown {
  if (name === 'client_conversation_id') return { type: ['string', 'null'] };
  if (name === 'limit') return { type: 'integer' };
  if (name === 'field_names') return { type: 'array', items: text };
  if (!required && metaAdsWriteSchemaContract(tool)?.referenceFields.includes(name)) return { type: ['string', 'null'] };
  return text;
}

/** The required names a stand-in schema declares: the account, ownership routes, and required references. */
export function metaStandInRequired(tool: string, names: readonly string[]): string[] {
  if (tool === 'ads_get_field_context') return ['field_names'];
  const contract = metaAdsWriteSchemaContract(tool);
  return [
    ...(names.includes('ad_account_id') ? ['ad_account_id'] : []),
    ...(contract?.ownershipFields ?? []),
    ...(contract?.entityType ? ['entity_type'] : []),
    ...(REQUIRED_REFERENCES[tool] ?? []),
  ].filter((name) => names.includes(name));
}

/**
 * A tool's input schema from its property names, with `extra` properties added
 * and `required` replaced when given.
 */
export function metaToolSchema(
  tool: string,
  names: readonly string[] = META_LIVE_NAMES[tool] ?? META_PRE_NOVEMBER_NAMES[tool]!,
  options: { extra?: Record<string, unknown>; required?: readonly string[]; omit?: readonly string[] } = {},
): { type: 'object'; properties: Record<string, unknown>; required: string[] } {
  const kept = names.filter((name) => !options.omit?.includes(name));
  const required = [...(options.required ?? metaStandInRequired(tool, kept))];
  return {
    type: 'object',
    properties: {
      ...Object.fromEntries(kept.map((name) => [name, standIn(tool, name, required.includes(name))])),
      ...options.extra,
    },
    required,
  };
}

/** What discovery stores for that schema. */
export function metaDiscoveredTool(
  tool: string,
  names?: readonly string[],
  options?: Parameters<typeof metaToolSchema>[2],
): McpConnectionToolInfo {
  return { name: tool, inputSchema: projectMcpToolInputSchema(metaToolSchema(tool, names, options), tool) };
}
