import { isMetaAdsMcpConnection, metaAdsGrantSurvivesDiscovery } from './meta-ads-policy.ts';
import { isBugsnagMcpConnection } from './bugsnag-policy.ts';
import type { McpConnectionConfig } from './types.ts';

type ReviewPolicy = { presetId?: string | undefined; toolAccessMode?: 'auto' | 'review' | undefined; url?: string | undefined };

type DiscoveryPolicy = Pick<McpConnectionConfig, 'allowedTools' | 'discoveredTools'> &
  ReviewPolicy;

export function isMcpToolReviewRequired(connection: ReviewPolicy): boolean {
  return connection.toolAccessMode === 'review' || isBugsnagMcpConnection(connection) || isMetaAdsMcpConnection(connection);
}

/**
 * Rediscovery can narrow a reviewed grant, but cannot create or broaden one.
 * A reviewed tool whose schema changed is dropped, except on Meta, whose
 * reviewed contract says what each tool may send: a Meta tool stays while the
 * contract still admits it with the same account field.
 */
export function allowedToolsAfterMcpDiscovery(
  connection: DiscoveryPolicy,
  discoveredTools: McpConnectionConfig['discoveredTools'],
): string[] {
  const review = isMcpToolReviewRequired(connection);
  if (!review && connection.discoveredTools.length === 0) return discoveredTools.map((tool) => tool.name);
  const allowed = new Set(connection.allowedTools);
  const metaAds = isMetaAdsMcpConnection(connection);
  const keptThroughChange: string[] = [];
  const kept = discoveredTools.filter((tool) => {
    if (!allowed.has(tool.name)) return false;
    if (!review) return true;
    const previous = connection.discoveredTools.find((entry) => entry.name === tool.name);
    const unchanged = Boolean(previous?.inputSchema?.fingerprint &&
      previous.inputSchema.fingerprint === tool.inputSchema?.fingerprint);
    if (!metaAds) return unchanged;
    if (!metaAdsGrantSurvivesDiscovery(previous, tool)) return false;
    if (!unchanged) keptThroughChange.push(tool.name);
    return true;
  }).map((tool) => tool.name);
  if (keptThroughChange.length > 0) {
    console.info({ event: 'chickpea.meta_ads.grant_kept_through_schema_change', tools: keptThroughChange });
  }
  return kept;
}
