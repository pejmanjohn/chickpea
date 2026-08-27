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
}

/**
 * Project the activity intent persisted by canonical admission before the
 * durable turn driver begins model or sandbox work. Replays are safe: the
 * presentation state either returns the same pending operation for receipt
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
  }, undefined, { agentViewPresentation: agentView });
  await agentView.beginAgentSessionProcessing();
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
  await presenter.setNativeThreadStatus(input.activity);
  return receipt.certainty === 'acknowledged';
}
