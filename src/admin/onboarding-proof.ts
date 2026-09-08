import { opaqueId } from '../work/admission.ts';
import type { WorkRunListItem, WorkStore } from '../work/types.ts';

interface OnboardingReplyTarget {
  workspaceId: string;
  slackUserId: string;
  tryStartedAt: number;
}

export async function hasDeliveredOnboardingReply(
  work: WorkStore,
  target: OnboardingReplyTarget,
): Promise<boolean> {
  let cursor = null;
  for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
    const page = await work.listRuns({
      kind: 'interactive',
      status: 'settled',
      limit: 100,
      cursor,
    });
    for (const item of page.items) {
      if (item.run.createdAt < target.tryStartedAt) return false;
      if (isDeliveredOnboardingReply(item, target)) return true;
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
  const { run, binding } = item;
  return run.createdAt >= target.tryStartedAt &&
    (run.triggerKind === 'slack_dm_message' || run.triggerKind === 'slack_app_mention') &&
    run.actorRef === opaqueId('actor', `slack:${target.workspaceId}:${target.slackUserId}`) &&
    run.status === 'settled' &&
    run.terminalDisposition === 'succeeded' &&
    run.deliveryStatus === 'delivered' &&
    run.deliveryMethod !== 'slack_reaction_add' &&
    binding.adapterKind === 'slack' &&
    binding.configMode === 'resolve_each_run' &&
    binding.externalAccountId === opaqueId('account', `slack:${target.workspaceId}`) &&
    run.deliveryRef?.startsWith('slack:D') === true;
}
