import type { ApiConnectionCheck } from '../connections/connection-check.ts';
import type { ManagementSetupRecord } from './types.ts';

/**
 * The setups that, when finished from the Slack thread an Agent asked in,
 * wake that Agent there to test the connection and carry on: an API or MCP
 * key saved on the setup page, an API or MCP sign-in, and a catalog or
 * managed connector sign-in. Repository access and model provider keys keep
 * their notice.
 */
const WAKING_ACTIONS: ReadonlySet<ManagementSetupRecord['action']> = new Set([
  'api_credential',
  'api_oauth',
  'mcp_credentials',
  'mcp_oauth',
  'catalog_connection',
  'managed_connection',
]);

/**
 * The Agent a finished setup wakes, or undefined when it posts its notice
 * instead. Only an Agent that asked for its own connection from a Slack
 * thread continues there; a setup started in Admin or over MCP, or for
 * another Agent, has no turn to continue. Someone other than the person who
 * asked may finish a catalog or managed link with their own account; the
 * Agent is not woken as them in the asker's thread.
 */
export function setupWakeAgent(
  setup: Pick<ManagementSetupRecord, 'action' | 'origin' | 'target' | 'actorUserId'>,
  completedByUserId: string = setup.actorUserId,
): { agentId: string; agentName: string } | undefined {
  const { origin, target } = setup;
  if (!WAKING_ACTIONS.has(setup.action) || origin.kind !== 'slack') return undefined;
  if (!target.agentId || origin.agentId !== target.agentId) return undefined;
  if (completedByUserId !== setup.actorUserId) return undefined;
  return { agentId: target.agentId, agentName: target.agentName ?? target.targetLabel };
}

/** What Chickpea's check of a saved key found; a rejected key is never saved. */
export type SavedKeyCheck = Exclude<ApiConnectionCheck['kind'], 'key_rejected'>;

/** How the person finished the setup, as the wake's note tells the Agent. */
export type SetupWakeCompletion =
  | { kind: 'key'; check?: SavedKeyCheck }
  | { kind: 'sign_in'; access?: 'read' | 'write' };

const KEY_CHECK_FINDING: Record<SavedKeyCheck, string> = {
  ok: 'Chickpea checked it with one request, and the service accepted it.',
  not_permitted: 'Chickpea\'s check got a 403, so the key may lack a permission or scope.',
  path_not_found: 'Chickpea\'s check got a 404 at the address it tried, which says nothing about the key.',
  unreachable: 'Chickpea could not reach the service to check it.',
  inconclusive: 'Chickpea could not confirm the key with its check.',
};

/**
 * Chickpea's note that starts the wake: who finished the setup, for which
 * connection, how, and what to do now. It never holds a key, a token or an
 * ID, and its turn marks it as Chickpea's text, so no check that needs the
 * person's own typed words accepts it.
 */
export function setupWakeNote(input: {
  person: string;
  connector: string;
  completion: SetupWakeCompletion;
  /** A catalog or managed connector, reached through its tools rather than a connection request. */
  connectorTools: boolean;
}): string {
  const { person, connector, completion } = input;
  const finished = completion.kind === 'key'
    ? `${person} saved the key for ${connector} on its setup page. ${completion.check ? KEY_CHECK_FINDING[completion.check] : ''}`.trimEnd()
    : `${person} signed in to ${connector}${completion.access ? `, granting ${completion.access === 'read' ? 'read-only' : 'read and write'} access` : ''}.`;
  const read = input.connectorTools
    ? `one real read with ${connector}'s tools`
    : 'one real read through the connection';
  return [
    `Chickpea note, not typed by ${person}: ${finished}`,
    `Test it now with ${read}, then reply here with what you found and what you will do next for their request. Do not write to the service to test it.`,
  ].join('\n\n');
}
