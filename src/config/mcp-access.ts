import { isMetaAdsMcpConnection } from './meta-ads-policy.ts';
import { isBugsnagMcpConnection } from './bugsnag-policy.ts';
import type { McpConnectionConfig } from './types.ts';

type ReviewPolicy = { presetId?: string | undefined; toolAccessMode?: 'auto' | 'review' | undefined; url?: string | undefined };

type DiscoveryPolicy = Pick<McpConnectionConfig, 'allowedTools' | 'discoveredTools'> &
  ReviewPolicy;

export function isMcpToolReviewRequired(connection: ReviewPolicy): boolean {
  return connection.toolAccessMode === 'review' || isBugsnagMcpConnection(connection) || isMetaAdsMcpConnection({ ...(connection.presetId ? { presetId: connection.presetId } : {}), ...(connection.url ? { url: connection.url } : {}) });
}

/** Rediscovery can narrow a reviewed grant, but cannot create or broaden one. */
export function allowedToolsAfterMcpDiscovery(
  connection: DiscoveryPolicy,
  discoveredTools: McpConnectionConfig['discoveredTools'],
): string[] {
  const review = isMcpToolReviewRequired(connection);
  if (!review && connection.discoveredTools.length === 0) return discoveredTools.map((tool) => tool.name);
  const allowed = new Set(connection.allowedTools);
  return discoveredTools.filter((tool) => {
    if (!allowed.has(tool.name)) return false;
    if (!review) return true;
    const previous = connection.discoveredTools.find((entry) => entry.name === tool.name);
    return Boolean(previous?.inputSchema?.fingerprint &&
      previous.inputSchema.fingerprint === tool.inputSchema?.fingerprint);
  }).map((tool) => tool.name);
}
