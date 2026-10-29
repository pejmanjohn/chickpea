import type { ManagementChangeSetProposalRecord } from './types.ts';

/** How long after a person approves a new keyed connection the key they pasted may be tried and saved. */
export const CONNECTION_APPROVAL_WINDOW_MS = 30 * 60_000;

/** An API connection a change set added to an Agent, by its Agent connection id. */
export interface ApprovedApiConnection {
  agentId: string;
  connectionId: string;
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
    const before = connectionIdsBefore(proposal.preview.changes.find(({ itemId }) => itemId === operation.itemId)?.before);
    if (outcome?.disposition !== 'applied' || !before) return [];
    return (operation.patch.apiConnections ?? [])
      .filter(({ id, authMode }) => authMode !== 'oauth' && !before.has(id))
      .map(({ id }) => ({ agentId: operation.agentId, connectionId: id }));
  });
}

/** The API connection ids an Agent had before a change; undefined when the preview does not say. */
function connectionIdsBefore(before: unknown): Set<string> | undefined {
  if (typeof before !== 'object' || before === null) return undefined;
  const connections = (before as { apiConnections?: unknown }).apiConnections;
  if (!Array.isArray(connections)) return undefined;
  return new Set(connections.flatMap((connection) =>
    typeof connection?.id === 'string' ? [connection.id as string] : []));
}
