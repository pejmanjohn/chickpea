import type { ManagementChangeSetProposalRecord } from './types.ts';

/** How long after a person approves a new keyed connection the key they pasted may be tried and saved. */
export const CONNECTION_APPROVAL_WINDOW_MS = 30 * 60_000;

/** An API connection a change set added to an Agent, by its Agent connection id, and where it sent a key then. */
export interface ApprovedApiConnection {
  agentId: string;
  connectionId: string;
  allowedHosts: string[];
  pathPrefixes: string[];
}

/**
 * The API connections that take a key which this completed change set
 * applied as new: its update_agent wrote them and the Agent had no
 * connection with that id before. Each starts pending, with no key.
 */
export function approvedNewKeyedApiConnections(
  proposal: Pick<ManagementChangeSetProposalRecord, 'status' | 'operations' | 'preview' | 'result'>,
): ApprovedApiConnection[] {
  if (proposal.status !== 'completed') return [];
  return proposal.operations.flatMap((operation) => {
    if (operation.kind !== 'update_agent') return [];
    const outcome = proposal.result?.outcomes.find(({ itemId }) => itemId === operation.itemId);
    const before = connectionIdsBefore(
      proposal.preview.changes.find(({ itemId }) => itemId === operation.itemId)?.before,
      'apiConnections',
    );
    if (outcome?.disposition !== 'applied' || !before) return [];
    return (operation.patch.apiConnections ?? [])
      .filter(({ id, authMode }) => authMode !== 'oauth' && !before.has(id))
      .map(({ id, allowedHosts, pathPrefixes }) => ({
        agentId: operation.agentId, connectionId: id, allowedHosts: [...allowedHosts], pathPrefixes: [...pathPrefixes],
      }));
  });
}

/** A connection taking a key, by its lane and Agent connection id, that a completed change set added. */
export interface ApprovedKeyedConnection {
  lane: 'api' | 'mcp';
  agentId: string;
  connectionId: string;
}

/**
 * The API connections and MCP servers that sign in with no OAuth which this
 * completed change set applied as new. An MCP server that needs no key at
 * all is among them; request_setup refuses it.
 */
export function approvedNewKeyedConnections(
  proposal: Pick<ManagementChangeSetProposalRecord, 'status' | 'operations' | 'preview' | 'result'>,
): ApprovedKeyedConnection[] {
  if (proposal.status !== 'completed') return [];
  return proposal.operations.flatMap((operation) => {
    if (operation.kind !== 'update_agent') return [];
    const outcome = proposal.result?.outcomes.find(({ itemId }) => itemId === operation.itemId);
    const before = proposal.preview.changes.find(({ itemId }) => itemId === operation.itemId)?.before;
    if (outcome?.disposition !== 'applied') return [];
    const added = (lane: ApprovedKeyedConnection['lane'], connections: ReadonlyArray<{ id: string; authMode?: string }>) => {
      const existing = connectionIdsBefore(before, lane === 'api' ? 'apiConnections' : 'mcpServers');
      return existing
        ? connections.filter(({ id, authMode }) => authMode !== 'oauth' && !existing.has(id))
          .map(({ id }) => ({ lane, agentId: operation.agentId, connectionId: id }))
        : [];
    };
    return [...added('api', operation.patch.apiConnections ?? []), ...added('mcp', operation.patch.mcpServers ?? [])];
  });
}

/** The connection ids an Agent had in one lane before a change; undefined when the preview does not say. */
function connectionIdsBefore(before: unknown, field: 'apiConnections' | 'mcpServers'): Set<string> | undefined {
  if (typeof before !== 'object' || before === null) return undefined;
  const connections = (before as Record<typeof field, unknown>)[field];
  if (!Array.isArray(connections)) return undefined;
  return new Set(connections.flatMap((connection) =>
    typeof connection?.id === 'string' ? [connection.id as string] : []));
}
