import type { ConfigStore } from '../config/store.ts';
import {
  WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
  type ResolvedAssignment,
  type SlackIdentity,
} from '../config/types.ts';
import type { NormalizedSlackTurn } from './types.ts';

/** Resolve old snapshots safely while new assignments carry an explicit identity. */
export function effectiveSlackIdentityId(assignment: ResolvedAssignment): string {
  return assignment.slackIdentityId ??
    assignment.agent.slackIdentityId ??
    WORKSPACE_DEFAULT_SLACK_IDENTITY_ID;
}

export function assignmentUsesSlackIdentity(
  assignment: ResolvedAssignment,
  identityId: string,
): boolean {
  return effectiveSlackIdentityId(assignment) === identityId;
}

/** U3 safety fence: U4 replaces this with identity-preserving durable clients. */
export function slackIdentityDeliverySupported(turn: NormalizedSlackTurn): boolean {
  return !turn.slackIdentityId ||
    turn.slackIdentityId === WORKSPACE_DEFAULT_SLACK_IDENTITY_ID;
}

export class SlackIdentityDeliveryNotReadyError extends Error {
  constructor(readonly identityId: string) {
    super(`Slack identity ${identityId} durable delivery is not available yet`);
    this.name = 'SlackIdentityDeliveryNotReadyError';
  }
}

export function requireSlackIdentityDeliverySupport(turn: NormalizedSlackTurn): void {
  if (!slackIdentityDeliverySupported(turn)) {
    throw new SlackIdentityDeliveryNotReadyError(turn.slackIdentityId as string);
  }
}

/**
 * A DM belongs to the receiving Slack app. Its one live DM Profile binding is
 * authoritative; the legacy global wildcard is compatibility state only.
 */
export async function resolveSlackIdentityDmAssignment(
  identity: SlackIdentity,
  workspaceId: string,
  channelId: string,
  store: ConfigStore,
): Promise<ResolvedAssignment | undefined> {
  if (identity.dmState !== 'on' || !identity.dmAgentId) return undefined;
  const agent = await store.getAgent(identity.dmAgentId);
  if (!agent.enabled) return undefined;
  return {
    workspaceId,
    channelId,
    agentId: agent.id,
    slackIdentityId: identity.id,
    participationMode: 'ambient',
    agent,
  };
}
