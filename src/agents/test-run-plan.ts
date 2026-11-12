/**
 * A test run's plan (V5): the Agent a direct message from the caller runs,
 * from the parts `resolveAgentRunPlan` resolves for them, narrowed to reads.
 * Only admission compiles one, so nothing at Worker startup imports this.
 */
import { compileRuntimePlan, RUNTIME_PLAN_SCHEMA_VERSION, type RuntimePlanV2 } from './runtime-plan.ts';
import type { AgentRunPlanParts } from './run-plan-resolution.ts';
import type { InstallationOwnership } from '../config/installation-scope.ts';
import { mcpToolDeclaredRead } from '../config/mcp-tool-policy.ts';
import { MANAGED_CONNECTOR_CATALOG } from '../connections/catalog/index.ts';
import type { EffectiveConnectionAccount } from '../connections/types.ts';
import { opaqueId } from '../work/admission.ts';

export interface TestRunConversation {
  workspaceId: string;
  /** The caller: the run uses the connections their own direct message would. */
  actorMembershipId: string;
  /** Names the run's continuity, so each run starts an empty transcript. */
  testRunId: string;
  /** 26 base32 characters, never the card's run token. */
  coordinateToken: string;
  installation?: InstallationOwnership;
  /** Complete, already-layered model instruction text, as a direct message's. */
  instructions: string;
  memoryEpoch: number;
}

export function compileTestRunPlan(parts: AgentRunPlanParts, test: TestRunConversation): RuntimePlanV2 {
  const { handoffContext: _handoff, threadGuest: _guest, ...assignment } = parts.assignment;
  return compileRuntimePlan({
    assignment: { ...assignment, agent: { ...assignment.agent, repositories: [] } },
    ...(test.installation ? { installation: test.installation } : {}),
    instructions: test.instructions,
    memoryEpoch: test.memoryEpoch,
    runtimeModel: parts.runtimeModel,
    ...(parts.runtimeModelRoute ? { runtimeModelRoute: parts.runtimeModelRoute } : {}),
    webSearch: parts.webSearch,
    effectiveConnections: parts.connections.flatMap(readsOnly),
    ...(parts.teamReconnects ? { teamReconnects: parts.teamReconnects } : {}),
  }, {
    schemaVersion: RUNTIME_PLAN_SCHEMA_VERSION,
    actorMembershipId: test.actorMembershipId,
    conversation: {
      workspaceId: test.workspaceId,
      channelId: `test_${test.coordinateToken}`,
      threadTs: 'test',
      surface: 'test',
      continuityKey: opaqueId('agent', `test:${test.testRunId}`),
    },
  });
}

/** The caller's connections a test run cannot read through at all; a run leaves each out and lists it with its fix. */
export function untestableConnections(connections: readonly EffectiveConnectionAccount[]): EffectiveConnectionAccount[] {
  return connections.filter((connection) => readsOnly(connection).length === 0);
}

/**
 * A connection as a test run may use it, or none when it has nothing that
 * reads. An MCP tool counts only when an Admin declared it a read; the run
 * checks that again at every call. An API connection keeps its methods; on a
 * test run its egress scopes and `connection_request` allow only GET and HEAD.
 */
function readsOnly(connection: EffectiveConnectionAccount): EffectiveConnectionAccount[] {
  const { policy } = connection;
  if (policy.kind === 'mcp') {
    const allowedTools = policy.allowedTools.filter((tool) => mcpToolDeclaredRead(policy, tool));
    return allowedTools.length > 0 ? [{ ...connection, policy: { ...policy, allowedTools } }] : [];
  }
  if (policy.kind === 'managed') {
    const allowedCapabilities = policy.allowedCapabilities
      .filter((id) => MANAGED_CONNECTOR_CATALOG.capability(id)?.effect === 'read');
    return allowedCapabilities.length > 0 ? [{ ...connection, policy: { ...policy, allowedCapabilities } }] : [];
  }
  return [connection];
}
