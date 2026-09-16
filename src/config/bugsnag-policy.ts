import type { McpConnectionConfig, McpToolPolicy } from './types.ts';

export const BUGSNAG_MCP_SERVER_URL = 'https://bugsnag.mcp.smartbear.com/mcp';

export function isBugsnagMcpConnection(connection: { presetId?: string | undefined; url?: string | undefined }): boolean {
  return connection.presetId === 'bugsnag' || connection.url === BUGSNAG_MCP_SERVER_URL;
}

// Severity overrides require server-initiated input collection, which the Slack
// runtime does not implement. Keep the ordinary status/issue operations usable.
export const BUGSNAG_ERROR_OPERATIONS = [
  'open', 'fix', 'ignore', 'discard', 'undiscard', 'snooze', 'link_issue', 'unlink_issue',
] as const;

export class BugsnagAccessPolicyError extends Error {}

export function compileBugsnagToolAccess(input: {
  discoveredTools: McpConnectionConfig['discoveredTools'];
  requestedTools: string[];
}): { allowedTools: string[]; toolPolicies: Record<string, McpToolPolicy> } {
  const allowedTools = [...new Set(input.requestedTools)];
  const toolPolicies: Record<string, McpToolPolicy> = {};
  for (const name of allowedTools) {
    const tool = input.discoveredTools.find((candidate) => candidate.name === name);
    if (!tool?.inputSchema?.fingerprint) {
      throw new BugsnagAccessPolicyError('Reconnect BugSnag to refresh its tools before choosing access.');
    }
    const updateError = name === 'bugsnag_update_error';
    if (updateError && !tool.inputSchema.propertyNames.includes('operation')) {
      throw new BugsnagAccessPolicyError('This version of the BugSnag error update tool is not supported.');
    }
    toolPolicies[name] = {
      effect: updateError || name === 'bugsnag_set_network_endpoint_groupings' || tool.readOnlyHint !== true
        ? 'write' : 'read',
      ...(updateError ? { argumentConstraints: { operation: [...BUGSNAG_ERROR_OPERATIONS] } } : {}),
    };
  }
  return { allowedTools, toolPolicies };
}
