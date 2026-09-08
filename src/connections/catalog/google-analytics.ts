import * as v from 'valibot';

import type { ManagedConnectorDefinition } from './types.ts';
import { boundedDateRange } from './ranges.ts';

const DEFAULT_RESULT_LIMIT = 256 * 1024;
const ResourceHandle = v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9_-]{0,127}$/));
const Url = v.pipe(v.string(), v.trim(), v.url(), v.maxLength(2_000));
const DateString = v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/));
const FieldName = v.pipe(v.string(), v.regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/));
const EventName = v.pipe(v.string(), v.regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/));

const SiteSchema = v.strictObject({ siteHandle: ResourceHandle });
const SitemapListSchema = v.strictObject({
  siteHandle: ResourceHandle,
  sitemapIndex: v.optional(Url),
});
const SitemapGetSchema = v.strictObject({ siteHandle: ResourceHandle, feedpath: Url });
const UrlInspectionSchema = v.strictObject({
  siteHandle: ResourceHandle,
  inspectionUrl: Url,
  languageCode: v.optional(v.pipe(v.string(), v.regex(/^[a-z]{2}(?:-[A-Z]{2})?$/))),
});
const SearchAnalyticsSchema = v.pipe(
  v.strictObject({
    siteHandle: ResourceHandle,
    startDate: DateString,
    endDate: DateString,
    dimensions: v.optional(v.pipe(v.array(v.picklist([
      'query', 'page', 'country', 'device', 'date', 'hour', 'searchAppearance',
    ])), v.maxLength(5))),
    searchType: v.optional(v.picklist([
      'web', 'image', 'video', 'news', 'discover', 'googleNews',
    ])),
    dataState: v.optional(v.picklist(['final', 'all'])),
    rowLimit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1_000))),
    startRow: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(25_000))),
  }),
  v.check((input) => boundedDateRange(input.startDate, input.endDate, 366),
    'Search Console date range must be valid and no longer than 366 days'),
  v.check((input) => !input.dimensions?.includes('searchAppearance') ||
    input.dimensions.length === 1,
  'searchAppearance cannot be combined with another dimension'),
);

const PropertySchema = v.strictObject({ propertyHandle: ResourceHandle });
const MetadataSchema = v.strictObject({ propertyHandle: ResourceHandle });
const DateRangeFields = {
  startDate: DateString,
  endDate: DateString,
};
const StandardReportSchema = v.pipe(
  v.strictObject({
    propertyHandle: ResourceHandle,
    ...DateRangeFields,
    dimensions: v.optional(v.pipe(v.array(FieldName), v.maxLength(9))),
    metrics: v.pipe(v.array(FieldName), v.minLength(1), v.maxLength(10)),
    limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1_000))),
    offset: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100_000))),
    keepEmptyRows: v.optional(v.boolean()),
    returnPropertyQuota: v.optional(v.boolean()),
  }),
  v.check((input) => boundedDateRange(input.startDate, input.endDate, 366),
    'Analytics date range must be valid and no longer than 366 days'),
);
const RealtimeReportSchema = v.strictObject({
  propertyHandle: ResourceHandle,
  dimensions: v.optional(v.pipe(v.array(FieldName), v.maxLength(4))),
  metrics: v.pipe(v.array(FieldName), v.minLength(1), v.maxLength(4)),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1_000))),
  returnPropertyQuota: v.optional(v.boolean()),
});
const PivotReportSchema = v.pipe(
  v.strictObject({
    propertyHandle: ResourceHandle,
    ...DateRangeFields,
    rowDimensions: v.pipe(v.array(FieldName), v.minLength(1), v.maxLength(3)),
    columnDimensions: v.optional(v.pipe(v.array(FieldName), v.maxLength(2))),
    metrics: v.pipe(v.array(FieldName), v.minLength(1), v.maxLength(5)),
    rowLimit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1_000))),
    columnLimit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
    offset: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100_000))),
    returnPropertyQuota: v.optional(v.boolean()),
  }),
  v.check((input) => boundedDateRange(input.startDate, input.endDate, 366),
    'Analytics date range must be valid and no longer than 366 days'),
  v.check((input) => new Set([
    ...input.rowDimensions, ...(input.columnDimensions ?? []),
  ]).size === input.rowDimensions.length + (input.columnDimensions?.length ?? 0),
  'Pivot dimensions must be unique'),
);
const FunnelStep = v.strictObject({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
  eventName: EventName,
});
const FunnelReportSchema = v.pipe(
  v.strictObject({
    propertyHandle: ResourceHandle,
    ...DateRangeFields,
    steps: v.pipe(v.array(FunnelStep), v.minLength(2), v.maxLength(10)),
    openFunnel: v.optional(v.boolean()),
    breakdownDimension: v.optional(FieldName),
    limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1_000))),
    returnPropertyQuota: v.optional(v.boolean()),
  }),
  v.check((input) => boundedDateRange(input.startDate, input.endDate, 366),
    'Analytics date range must be valid and no longer than 366 days'),
);

export const MANAGED_GOOGLE_ANALYTICS_CONNECTORS: readonly ManagedConnectorDefinition[] = [
  {
    id: 'google-search-console',
    toolkit: 'google_search_console',
    providerId: 'google',
    label: 'Google Search Console',
    description: 'Inspect indexing, sitemaps, and search performance for selected sites.',
    securityDescription:
      'Google sign-in opens through Composio. An Admin must select one or more verified Search Console sites before Agents receive read tools. Site mutations and sitemap submission are absent.',
    resources: [{
      key: 'siteUrls',
      label: 'Search Console sites',
      required: true,
      multiple: true,
      localArgument: 'siteHandle',
      providerArgument: 'siteUrl',
    }],
    capabilities: [
      capability('search_console.sites.get', 'google_search_console', 'google_search_console_get_site', 'Read permission and metadata for one selected Search Console site.', SiteSchema),
      capability('search_console.sitemaps.list', 'google_search_console', 'google_search_console_list_sitemaps', 'List bounded sitemap metadata for one selected Search Console site.', SitemapListSchema),
      capability('search_console.sitemaps.get', 'google_search_console', 'google_search_console_get_sitemap', 'Read one sitemap from a selected Search Console site.', SitemapGetSchema),
      capability('search_console.urls.inspect', 'google_search_console', 'google_search_console_inspect_url', 'Inspect indexing status for a URL under one selected Search Console site.', UrlInspectionSchema),
      capability('search_console.analytics.query', 'google_search_console', 'google_search_console_query_analytics', 'Query bounded search performance for one selected Search Console site.', SearchAnalyticsSchema),
    ],
  },
  {
    id: 'google-analytics',
    toolkit: 'google_analytics',
    providerId: 'google',
    label: 'Google Analytics',
    description: 'Read metadata, quotas, and bounded GA4 reports for selected properties.',
    securityDescription:
      'Google sign-in opens through Composio. An Admin must select one or more GA4 properties before Agents receive read tools. Analytics administration and event ingestion are absent.',
    resources: [{
      key: 'propertyIds',
      label: 'GA4 properties',
      required: true,
      multiple: true,
      localArgument: 'propertyHandle',
      providerArgument: 'property',
    }],
    capabilities: [
      capability('analytics.properties.get', 'google_analytics', 'google_analytics_get_property', 'Read metadata for one selected GA4 property.', PropertySchema),
      capability('analytics.metadata.get', 'google_analytics', 'google_analytics_get_metadata', 'List dimensions and metrics for one selected GA4 property.', MetadataSchema),
      capability('analytics.quotas.get', 'google_analytics', 'google_analytics_get_quota', 'Read the current quota snapshot for one selected GA4 property.', PropertySchema),
      capability('analytics.reports.run', 'google_analytics', 'google_analytics_run_report', 'Run a bounded standard report for one selected GA4 property.', StandardReportSchema),
      capability('analytics.reports.realtime', 'google_analytics', 'google_analytics_run_realtime_report', 'Run a bounded realtime report for one selected GA4 property.', RealtimeReportSchema),
      capability('analytics.reports.pivot', 'google_analytics', 'google_analytics_run_pivot_report', 'Run a bounded pivot report for one selected GA4 property.', PivotReportSchema),
      capability('analytics.reports.funnel', 'google_analytics', 'google_analytics_run_funnel_report', 'Run a bounded event funnel for one selected GA4 property.', FunnelReportSchema),
    ],
  },
] as const;

function capability(
  id: string,
  toolkit: string,
  toolName: string,
  description: string,
  input: ManagedConnectorDefinition['capabilities'][number]['input'],
): ManagedConnectorDefinition['capabilities'][number] {
  return {
    id,
    connectorToolkit: toolkit,
    accessLane: 'read',
    effect: 'read',
    toolName,
    description,
    input,
    maxResultBytes: DEFAULT_RESULT_LIMIT,
  };
}
