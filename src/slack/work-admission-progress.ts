import type {
  SlackInteractionProgress,
  SlackInteractionProgressPatch,
} from '../config/state-rpc.ts';
import type { NormalizedSlackTurn } from './types.ts';
import type { WebClientPresenter } from './web-client-presenter.ts';

type AdmissionProgressTurn = Pick<
  NormalizedSlackTurn,
  'channelId' | 'threadTs' | 'messageTs' | 'reactionTargetTs'
>;

type AdmissionProgressPresenter = Pick<
  WebClientPresenter,
  'addSemanticReaction' | 'postWorkChecklist'
>;

/**
 * Publish the instant, adapter-owned part of visible Slack pickup after durable
 * admission but before the executor is armed. Unknown explicit turns get the
 * acknowledgment immediately; confirmed work also gets its checklist.
 * Execution reuses the persisted coordinates instead of creating duplicates.
 */
export async function publishSlackAdmissionProgress(input: {
  turn: AdmissionProgressTurn;
  checklist?: readonly string[];
  presenter: AdmissionProgressPresenter;
  record(patch: SlackInteractionProgressPatch): Promise<void>;
}): Promise<SlackInteractionProgress> {
  const progress: SlackInteractionProgress = {};
  const triggerCoordinate = {
    channelId: input.turn.channelId,
    messageTs: input.turn.reactionTargetTs ?? input.turn.messageTs,
  };

  try {
    const receipt = await input.presenter.addSemanticReaction('work_ack', triggerCoordinate);
    progress.acknowledgment = {
      ...triggerCoordinate,
      name: receipt.name,
      created: receipt.created,
      cleanup: receipt.created ? 'pending' : 'done',
    };
    await input.record({ acknowledgment: progress.acknowledgment });
  } catch {
    console.warn('[chickpea] Slack admission acknowledgment failed');
  }

  if (input.checklist) {
    try {
      const messageTs = await input.presenter.postWorkChecklist(input.checklist);
      if (messageTs) {
        progress.checklist = {
          channelId: input.turn.channelId,
          threadTs: input.turn.threadTs,
          messageTs,
          cleanup: 'pending',
        };
        await input.record({ checklist: progress.checklist });
      }
    } catch {
      console.warn('[chickpea] Slack admission work checklist failed');
    }
  }

  return progress;
}
