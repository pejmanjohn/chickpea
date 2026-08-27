import type { WebClient } from '@slack/web-api';

import type { TypedActivityStatus } from '../activity/status.ts';
import {
  SlackAgentViewPresentation,
  type SlackPresentationStatePort,
} from './agent-view-presentation.ts';
import type { SlackPresentationOwner } from './run-presentations.ts';
import { WebClientPresenter } from './web-client-presenter.ts';

export interface AdmittedSlackActivityInput {
  client: WebClient;
  state: SlackPresentationStatePort;
  runId: string;
  runFencingToken: number;
  workspaceId: string;
  channelId: string;
  threadTs: string;
  requesterUserId: string;
  owner: SlackPresentationOwner;
  agentId: string;
  activity: TypedActivityStatus;
  semanticActivityEnabled?: boolean;
}

/**
 * Project the intent persisted by canonical admission at the head of the
 * durable turn driver, before model or sandbox work. Keeping the write in the
 * state owner lets one generation fence every native status writer. Replays
 * are safe: presentation state either returns the same pending operation for receipt
 * reconciliation or proves that the activity is already visible.
 */
export async function presentAdmittedSlackActivity(
  input: AdmittedSlackActivityInput,
): Promise<boolean> {
  const agentName = input.owner.kind === 'selected_agent'
    ? input.owner.persona.name
    : 'Chickpea';
  const agentView = new SlackAgentViewPresentation({
    client: input.client,
    state: input.state,
    runId: input.runId,
    runFencingToken: input.runFencingToken,
    footer: { agentName, agentId: input.agentId },
  });
  const presenter = new WebClientPresenter(input.client, {
    channelId: input.channelId,
    threadTs: input.threadTs,
    agentName,
    visibleOwner: input.owner,
    agentId: input.agentId,
    userId: input.requesterUserId,
    workspaceId: input.workspaceId,
  }, undefined, {
    agentViewPresentation: agentView,
    ...(input.state.reserveSlackActivityStatus &&
        input.state.applySlackActivityStatusCooldown
      ? {
          activityStatusCoordinator: {
            reserve: async () => input.state.reserveSlackActivityStatus!(input.workspaceId),
            applyCooldown: async (retryAfterMs: number) =>
              input.state.applySlackActivityStatusCooldown!(input.workspaceId, retryAfterMs),
          },
        }
      : {}),
  });
  await agentView.beginAgentSessionProcessing();
  if (input.semanticActivityEnabled === false) return true;
  const write = await agentView.beginActivity(
    input.activity,
    presenter.preferredActivitySurface(),
  );
  if (!write) return false;
  await presenter.setStatus(input.activity, write);
  const receipt = presenter.activityReceipt();
  await agentView.recordActivityReceipt(
    write.operationId,
    receipt.certainty,
    receipt.messageTs,
  );
  return receipt.certainty === 'acknowledged';
}
