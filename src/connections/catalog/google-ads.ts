import * as v from 'valibot';

import type { ManagedConnectorDefinition } from './types.ts';
import { boundedDateRange } from './ranges.ts';

const DEFAULT_RESULT_LIMIT = 256 * 1024;
const ResourceHandle = v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9_-]{0,127}$/));
const AdsId = v.pipe(v.string(), v.regex(/^\d{1,20}$/));
const DateString = v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/));
const CurrencyCode = v.pipe(v.string(), v.regex(/^[A-Z]{3}$/));
const Name = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128));
const AmountMicros = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10_000_000_000_000));
const ReportMetric = v.picklist([
  'impressions', 'clicks', 'costMicros', 'conversions', 'conversionValue',
  'ctr', 'averageCpc', 'averageCpm',
]);

const CustomerSchema = v.strictObject({ customerHandle: ResourceHandle });
const CampaignSchema = v.strictObject({ customerHandle: ResourceHandle, campaignId: AdsId });
const ReportSchema = v.pipe(v.strictObject({
  customerHandle: ResourceHandle,
  startDate: DateString,
  endDate: DateString,
  metrics: v.optional(v.pipe(v.array(ReportMetric), v.minLength(1), v.maxLength(8))),
  status: v.optional(v.picklist(['ENABLED', 'PAUSED'])),
  orderBy: v.optional(ReportMetric),
  orderDirection: v.optional(v.picklist(['ASC', 'DESC'])),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(500))),
}), v.check((input) => boundedDateRange(input.startDate, input.endDate, 366),
  'Google Ads report range must be valid and no longer than 366 days'));
const BudgetReportSchema = v.strictObject({
  customerHandle: ResourceHandle,
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(500))),
});
const CampaignCreateSchema = v.pipe(v.strictObject({
  customerHandle: ResourceHandle,
  name: Name,
  campaignBudgetId: AdsId,
  containsEuPoliticalAdvertising: v.boolean(),
  startDate: v.optional(DateString),
  endDate: v.optional(DateString),
}), v.check((input) => !input.startDate || !input.endDate || input.endDate >= input.startDate,
  'Google Ads campaign end date must not precede its start date'));
const CampaignRenameSchema = v.strictObject({
  customerHandle: ResourceHandle,
  campaignId: AdsId,
  name: Name,
});
const BudgetCreateSchema = v.strictObject({
  customerHandle: ResourceHandle,
  name: Name,
  amountMicros: AmountMicros,
  currencyCode: CurrencyCode,
});
const BudgetUpdateSchema = v.strictObject({
  customerHandle: ResourceHandle,
  campaignBudgetId: AdsId,
  amountMicros: AmountMicros,
  currencyCode: CurrencyCode,
});
const AdGroupCreateSchema = v.strictObject({
  customerHandle: ResourceHandle,
  campaignId: AdsId,
  name: Name,
});
const AdGroupRenameSchema = v.strictObject({
  customerHandle: ResourceHandle,
  adGroupId: AdsId,
  name: Name,
});
const AdGroupSchema = v.strictObject({ customerHandle: ResourceHandle, adGroupId: AdsId });
const KeywordCreateSchema = v.strictObject({
  customerHandle: ResourceHandle,
  adGroupId: AdsId,
  text: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
  matchType: v.picklist(['EXACT', 'PHRASE', 'BROAD']),
  negative: v.optional(v.boolean()),
  cpcBidMicros: v.optional(AmountMicros),
});
const KeywordSchema = v.strictObject({
  customerHandle: ResourceHandle,
  adGroupId: AdsId,
  criterionId: AdsId,
});
const AdCreateSchema = v.strictObject({
  customerHandle: ResourceHandle,
  adGroupId: AdsId,
  finalUrls: v.pipe(v.array(v.pipe(v.string(), v.url(), v.maxLength(2_000))), v.minLength(1), v.maxLength(3)),
  headlines: v.pipe(v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(30))), v.minLength(3), v.maxLength(15)),
  descriptions: v.pipe(v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(90))), v.minLength(2), v.maxLength(4)),
});
const AdSchema = v.strictObject({
  customerHandle: ResourceHandle,
  adGroupId: AdsId,
  adId: AdsId,
});

export const MANAGED_GOOGLE_ADS_CONNECTORS: readonly ManagedConnectorDefinition[] = [{
  id: 'google-ads',
  toolkit: 'googleads',
  providerId: 'google',
  label: 'Google Ads',
  description: 'Analyze and manage campaigns for explicitly selected client accounts.',
  securityDescription:
    'Google sign-in opens through Composio managed OAuth. An Admin must select one or more client customer accounts before Agents receive tools. Chickpea never receives the Google Ads developer token. Reports are structured rather than free-form GAQL; billing, access administration, conversion upload, delete, bulk, and raw mutation tools are absent.',
  resources: [{
    key: 'customerIds',
    label: 'Google Ads client accounts',
    required: true,
    multiple: true,
    localArgument: 'customerHandle',
    providerArgument: 'customerId',
  }],
  capabilities: [
    read('ads.customers.get', 'google_ads_get_customer', 'Read identity, currency, time zone, and status for one selected client account.', CustomerSchema),
    read('ads.campaigns.get', 'google_ads_get_campaign', 'Read one campaign by stable ID in a selected client account.', CampaignSchema),
    read('ads.campaigns.report', 'google_ads_report_campaigns', 'Run a bounded campaign-performance report with reviewed fields.', ReportSchema),
    read('ads.ad_groups.report', 'google_ads_report_ad_groups', 'Run a bounded ad-group performance report with reviewed fields.', ReportSchema),
    read('ads.ads.report', 'google_ads_report_ads', 'Run a bounded ad performance report with reviewed fields.', ReportSchema),
    read('ads.keywords.report', 'google_ads_report_keywords', 'Run a bounded keyword performance report with reviewed fields.', ReportSchema),
    read('ads.budgets.report', 'google_ads_report_budgets', 'List bounded campaign-budget state for a selected client account.', BudgetReportSchema),
    write('ads.campaigns.create_paused', 'google_ads_create_paused_campaign', 'Create one paused Search campaign using an existing selected-account budget.', CampaignCreateSchema, 'reversible_write', 'create a paused Google Ads campaign'),
    write('ads.campaigns.rename', 'google_ads_rename_campaign', 'Rename one campaign in a selected client account.', CampaignRenameSchema, 'reversible_write', 'rename a Google Ads campaign'),
    write('ads.campaigns.pause', 'google_ads_pause_campaign', 'Pause one campaign in a selected client account.', CampaignSchema, 'reversible_write', 'pause a Google Ads campaign'),
    write('ads.campaigns.enable', 'google_ads_enable_campaign', 'Enable one campaign so it may serve ads.', CampaignSchema, 'external_publish', 'enable a Google Ads campaign that may serve ads'),
    write('ads.budgets.create', 'google_ads_create_budget', 'Create one daily campaign budget after confirming its selected account, currency, and amount.', BudgetCreateSchema, 'spend_or_budget', 'create a Google Ads daily budget'),
    write('ads.budgets.update_amount', 'google_ads_update_budget', 'Change one daily campaign budget after confirming its selected account, currency, and amount.', BudgetUpdateSchema, 'spend_or_budget', 'change a Google Ads daily budget'),
    write('ads.ad_groups.create_paused', 'google_ads_create_paused_ad_group', 'Create one paused Search ad group.', AdGroupCreateSchema, 'reversible_write', 'create a paused Google Ads ad group'),
    write('ads.ad_groups.rename', 'google_ads_rename_ad_group', 'Rename one ad group.', AdGroupRenameSchema, 'reversible_write', 'rename a Google Ads ad group'),
    write('ads.ad_groups.pause', 'google_ads_pause_ad_group', 'Pause one ad group.', AdGroupSchema, 'reversible_write', 'pause a Google Ads ad group'),
    write('ads.ad_groups.enable', 'google_ads_enable_ad_group', 'Enable one ad group so its eligible ads may serve.', AdGroupSchema, 'external_publish', 'enable a Google Ads ad group that may serve ads'),
    write('ads.keywords.create_paused', 'google_ads_create_paused_keyword', 'Create one paused keyword criterion.', KeywordCreateSchema, 'reversible_write', 'create a paused Google Ads keyword'),
    write('ads.keywords.pause', 'google_ads_pause_keyword', 'Pause one keyword criterion.', KeywordSchema, 'reversible_write', 'pause a Google Ads keyword'),
    write('ads.keywords.enable', 'google_ads_enable_keyword', 'Enable one keyword criterion so it may match searches.', KeywordSchema, 'external_publish', 'enable a Google Ads keyword that may serve ads'),
    write('ads.ads.create_paused', 'google_ads_create_paused_responsive_search_ad', 'Create one paused responsive Search ad with bounded copy and URLs.', AdCreateSchema, 'reversible_write', 'create a paused Google Ads responsive search ad'),
    write('ads.ads.pause', 'google_ads_pause_ad', 'Pause one ad.', AdSchema, 'reversible_write', 'pause a Google Ads ad'),
    write('ads.ads.enable', 'google_ads_enable_ad', 'Enable one ad so it may be published and serve.', AdSchema, 'external_publish', 'enable a Google Ads ad that may be published'),
  ],
}] as const;

function read(
  id: string,
  toolName: string,
  description: string,
  input: ManagedConnectorDefinition['capabilities'][number]['input'],
): ManagedConnectorDefinition['capabilities'][number] {
  return {
    id, connectorToolkit: 'googleads', accessLane: 'read', effect: 'read',
    toolName, description, input, maxResultBytes: DEFAULT_RESULT_LIMIT,
  };
}

function write(
  id: string,
  toolName: string,
  description: string,
  input: ManagedConnectorDefinition['capabilities'][number]['input'],
  effect: 'reversible_write' | 'external_publish' | 'spend_or_budget',
  sideEffectLabel: string,
): ManagedConnectorDefinition['capabilities'][number] {
  return {
    id, connectorToolkit: 'googleads', accessLane: 'write', effect,
    toolName, description, input, maxResultBytes: DEFAULT_RESULT_LIMIT, sideEffectLabel,
  };
}
