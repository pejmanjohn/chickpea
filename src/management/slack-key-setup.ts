import { approvedNewKeyedApiConnections, approvedNewKeyedConnections } from './connection-approval.ts';
import {
  addressedRequestText,
  keyTypedForApprovedConnection,
  type WorkspaceManagementServiceInput,
} from './service.ts';
import { setupWakeAgent } from './setup-wake.ts';
import type {
  LiveManagementActor,
  ManagementDeferredSetup,
  ManagementOperation,
  ManagementSetupRecord,
} from './types.ts';

export type SetupDelivery = { kind: 'link'; url: string } | { kind: 'form'; instruction: string };
export interface IssuedSetup {
  record: ManagementSetupRecord;
  delivery: SetupDelivery;
}

type RequestSetup = Extract<ManagementOperation, { kind: 'request_setup' }>;

export function formSetupInstruction(record: ManagementSetupRecord): string {
  const wake = setupWakeAgent(record)
    ? ' When they save it, Chickpea starts your next turn in this thread with a note saying so: test the connection with a real read and carry on with their request.'
    : '';
  return `Chickpea posts an Add key button under your reply, where the person adds the key in a private Slack form. Point them to that button; do not post a setup link, and never ask them to paste the key here.${wake} If they ask for a setup link instead, call revoke_setup_link with this setupOperationId and reissue true.`;
}

/**
 * The keys a Slack change set's new connections need, asked for when the
 * person approves it and it asked for none: what request_setup would issue
 * them now, an Add key card where the form applies and a setup link
 * elsewhere. A connection that signs in, or needs no key, gets nothing.
 */
export async function keySetupsAfterApproval(
  proposal: Parameters<typeof approvedNewKeyedConnections>[0],
  issue: (operation: RequestSetup) => Promise<IssuedSetup | undefined>,
): Promise<ManagementDeferredSetup[]> {
  const added = [
    ...approvedNewKeyedConnections(proposal, 'apiConnections').map((entry) => ({ ...entry, lane: 'api' as const })),
    ...approvedNewKeyedConnections(proposal, 'mcpServers').map((entry) => ({ ...entry, lane: 'mcp' as const })),
  ];
  const setups: ManagementDeferredSetup[] = [];
  for (const { lane, agentId, connection: { id: connectionId } } of added) {
    const itemId = `key_${lane}_${connectionId}`;
    const setup = await issue({
      itemId,
      kind: 'request_setup',
      target: { kind: lane === 'api' ? 'api_connection' : 'mcp_connection', agentId, connectionId },
    });
    if (!setup) continue;
    const label = setup.record.target.targetLabel;
    setups.push(setup.delivery.kind === 'link'
      ? { kind: 'issued', itemId, label, setupUrl: setup.delivery.url }
      : { kind: 'form', itemId, label });
  }
  return setups;
}

/**
 * Whether the message that proposed this approved change set holds a key
 * for an API connection it added, as the approval window reads that
 * message (keyFromApprovedConnection): one key-shaped word it would admit.
 * The person's next message then lets the Agent test it.
 */
export async function approvedProposalHoldsKey(
  actor: LiveManagementActor,
  proposalId: string,
  stores: Pick<WorkspaceManagementServiceInput, 'management' | 'identity' | 'typedSlackMessage'>,
): Promise<boolean> {
  const { origin } = actor;
  if (origin.kind !== 'slack' || !stores.typedSlackMessage) return false;
  const proposal = await stores.management.getChangeSetProposal(proposalId);
  const approved = proposal ? approvedNewKeyedApiConnections(proposal) : [];
  if (!proposal?.proposedMessageTs || approved.length === 0) return false;
  const [message, user] = await Promise.all([
    stores.typedSlackMessage({
      workspaceId: origin.workspaceId,
      channelId: origin.channelId,
      messageTs: proposal.proposedMessageTs,
    }),
    stores.identity.getUser(actor.userId),
  ]);
  if (!message || !user || message.userId !== user.slackUserId) return false;
  const text = addressedRequestText(message.text, actor.commandAddress);
  return text !== undefined && keyShapedWords(text).some((key) =>
    approved.some((connection) => keyTypedForApprovedConnection(text, key, connection)));
}

/**
 * The words of a message shaped like an API key: 16 or more key characters
 * with a letter and a digit, not starting with a slash. A word, a path or a
 * URL is none.
 */
function keyShapedWords(text: string): string[] {
  return text.split(/\s+/)
    .map((word) => word.replace(/^[(\[{'"`]+|[)\]}'"`.,;:!?]+$/g, ''))
    .filter((word) => /^[A-Za-z0-9_\-+=][A-Za-z0-9_\-+/=]{15,}$/.test(word) && /[A-Za-z]/.test(word) && /\d/.test(word));
}
