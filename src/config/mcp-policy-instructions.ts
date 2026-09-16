import type { RuntimePlanMcpConnectionV2 } from '../agents/runtime-plan.ts';
import {
  isMetaAdsHelperTool,
  isMetaAdsAccountScopeTool,
  isMetaAdsMcpConnection,
  metaAdsApprovedAccountIds,
} from './meta-ads-policy.ts';

export interface McpPolicyInstructionProjection {
  restrictions: Array<{ connection: string; tools: Record<string, Record<string, string[]>> }>;
  metaHelperScopes: Array<{ connection: string; tool: string; approvedAccountIds: string[] }>;
  metaWriteScopes: Array<{ connection: string; tool: string; approvedAccountIds: string[] }>;
}

/** Keep helper authorization scope out of the provider-input instruction. */
export function projectMcpPolicyInstructions(
  connections: readonly RuntimePlanMcpConnectionV2[],
): McpPolicyInstructionProjection {
  const restrictions = connections.flatMap((connection) => {
    const tools = Object.fromEntries(Object.entries(connection.toolArgumentConstraints ?? {})
      .filter(([name]) => !(isMetaAdsMcpConnection(connection) && isMetaAdsAccountScopeTool(name))));
    return Object.keys(tools).length > 0 ? [{ connection: connection.id, tools }] : [];
  });
  const metaHelperScopes = connections.flatMap((connection) =>
    !isMetaAdsMcpConnection(connection) ? [] : Object.entries(connection.toolArgumentConstraints ?? {})
      .flatMap(([name, constraints]) => {
        if (!isMetaAdsHelperTool(name)) return [];
        const accountIds = metaAdsApprovedAccountIds(constraints);
        return accountIds ? [{ connection: connection.id, tool: name, approvedAccountIds: accountIds }] : [];
      }));
  const metaWriteScopes = connections.flatMap((connection) =>
    !isMetaAdsMcpConnection(connection) ? [] : Object.entries(connection.toolArgumentConstraints ?? {})
      .flatMap(([name, constraints]) => {
        if (!isMetaAdsAccountScopeTool(name) || isMetaAdsHelperTool(name)) return [];
        const accountIds = metaAdsApprovedAccountIds(constraints);
        return accountIds ? [{ connection: connection.id, tool: name, approvedAccountIds: accountIds }] : [];
      }));
  return { restrictions, metaHelperScopes, metaWriteScopes };
}
