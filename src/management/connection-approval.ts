import type { ManagementAgentPatch, ManagementChangeSetProposalRecord } from './types.ts';

/** How long after a person approves a new keyed connection the key they pasted may be tried and saved. */
export const CONNECTION_APPROVAL_WINDOW_MS = 30 * 60_000;

/** An API connection a change set added to an Agent, by its Agent connection id, and where it sent a key then. */
export interface ApprovedApiConnection {
  agentId: string;
  connectionId: string;
  allowedHosts: string[];
  pathPrefixes: string[];
}

type ConnectionLane = 'apiConnections' | 'mcpServers';

/**
 * The connections in one lane that take a key which this completed change
 * set applied as new: its update_agent wrote them and the Agent had no
 * connection with that id before. Each starts pending, with no key.
 */
export function approvedNewKeyedConnections<L extends ConnectionLane>(
  proposal: Pick<ManagementChangeSetProposalRecord, 'status' | 'operations' | 'preview' | 'result'>,
  lane: L,
): Array<{ agentId: string; connection: NonNullable<ManagementAgentPatch[L]>[number] }> {
  if (proposal.status !== 'completed') return [];
  return proposal.operations.flatMap((operation) => {
    if (operation.kind !== 'update_agent') return [];
    const outcome = proposal.result?.outcomes.find(({ itemId }) => itemId === operation.itemId);
    const before = connectionIdsBefore(proposal.preview.changes.find(({ itemId }) => itemId === operation.itemId)?.before, lane);
    if (outcome?.disposition !== 'applied' || !before) return [];
    const written: NonNullable<ManagementAgentPatch[L]> = operation.patch[lane] ?? [];
    return written.filter(({ id, authMode }) => authMode !== 'oauth' && !before.has(id))
      .map((connection) => ({ agentId: operation.agentId, connection }));
  });
}

export function approvedNewKeyedApiConnections(
  proposal: Pick<ManagementChangeSetProposalRecord, 'status' | 'operations' | 'preview' | 'result'>,
): ApprovedApiConnection[] {
  return approvedNewKeyedConnections(proposal, 'apiConnections').map(({ agentId, connection }) => ({
    agentId, connectionId: connection.id, allowedHosts: [...connection.allowedHosts], pathPrefixes: [...connection.pathPrefixes],
  }));
}

/** The connection ids an Agent had in one lane before a change; undefined when the preview does not say. */
function connectionIdsBefore(before: unknown, lane: ConnectionLane): Set<string> | undefined {
  if (typeof before !== 'object' || before === null) return undefined;
  const connections = (before as Partial<Record<ConnectionLane, unknown>>)[lane];
  if (!Array.isArray(connections)) return undefined;
  return new Set(connections.flatMap((connection) =>
    typeof connection?.id === 'string' ? [connection.id as string] : []));
}
