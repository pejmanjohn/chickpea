import { opaqueId } from '../work/admission.ts';
import type { WorkRunListItem, WorkStore } from '../work/types.ts';

interface OnboardingReplyTarget {
  workspaceId: string;
  slackUserId: string;
  tryStartedAt: number;
}

export type OnboardingPresentationReader = (runId: string) => Promise<{
  root: { channelId: string };
  stream: { acknowledgedByteLength: number };
} | undefined>;

export async function hasShownOnboardingReply(
  work: WorkStore,
  target: OnboardingReplyTarget,
  readPresentation?: OnboardingPresentationReader,
): Promise<boolean> {
  let cursor = null;
  for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
    const page = await work.listRuns({ kind: 'interactive', limit: 100, cursor });
    for (const item of page.items) {
      if (item.run.createdAt < target.tryStartedAt) return false;
      if (isDeliveredOnboardingReply(item, target)) return true;
      if (isOwnerTryMessage(item, target) && await showsAnswerInDm(item.run.id, readPresentation)) return true;
    }
    if (!page.nextCursor) return false;
    cursor = page.nextCursor;
  }
  return false;
}

export function isDeliveredOnboardingReply(
  item: WorkRunListItem,
  target: OnboardingReplyTarget,
): boolean {
  const { run } = item;
  return isOwnerTryMessage(item, target) &&
    run.status === 'settled' &&
    run.terminalDisposition === 'succeeded' &&
    run.deliveryStatus === 'delivered' &&
    run.deliveryMethod !== 'slack_reaction_add' &&
    run.deliveryRef?.startsWith('slack:D') === true;
}

function isOwnerTryMessage(item: WorkRunListItem, target: OnboardingReplyTarget): boolean {
  const { run, binding } = item;
  return run.createdAt >= target.tryStartedAt &&
    (run.triggerKind === 'slack_dm_message' || run.triggerKind === 'slack_app_mention') &&
    run.actorRef === opaqueId('actor', `slack:${target.workspaceId}:${target.slackUserId}`) &&
    binding.adapterKind === 'slack' &&
    binding.configMode === 'resolve_each_run' &&
    binding.externalAccountId === opaqueId('account', `slack:${target.workspaceId}`);
}

async function showsAnswerInDm(runId: string, readPresentation: OnboardingPresentationReader | undefined): Promise<boolean> {
  if (!readPresentation) return false;
  try {
    const presentation = await readPresentation(runId);
    return presentation !== undefined && presentation.root.channelId.startsWith('D') &&
      presentation.stream.acknowledgedByteLength > 0;
  } catch {
    return false;
  }
}
