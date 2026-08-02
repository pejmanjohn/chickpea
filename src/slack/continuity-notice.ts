import type { SlackContinuityNoticeProgress } from '../config/state-rpc.ts';
import { slackDeliveryFailureOutcome } from './web-client-presenter.ts';

export const CONTINUITY_NOTICE_TEXT =
  'Your settings changed, so I started a fresh conversation context. Your Slack history and saved work are still here.';

export class ContinuityNoticeDeliveryError extends Error {
  constructor(readonly recoveryRequired: boolean) {
    super(recoveryRequired
      ? 'Slack continuity notice delivery requires reconciliation.'
      : 'Slack continuity notice delivery failed.');
    this.name = 'ContinuityNoticeDeliveryError';
  }
}

export interface EnsureContinuityNoticeInput {
  required: boolean;
  progress?: SlackContinuityNoticeProgress;
  post(text: string): Promise<string>;
  record(notice: SlackContinuityNoticeProgress): void | Promise<void>;
}

/** Deliver the reset notice once, before the first reply from a new incarnation. */
export async function ensureContinuityNotice(
  input: EnsureContinuityNoticeInput,
): Promise<void> {
  if (!input.required || input.progress?.status === 'delivered') return;
  if (input.progress?.status === 'posting' || input.progress?.status === 'unknown') {
    throw new ContinuityNoticeDeliveryError(true);
  }

  await input.record({ status: 'posting' });
  try {
    const messageTs = await input.post(CONTINUITY_NOTICE_TEXT);
    await input.record({ status: 'delivered', messageTs });
  } catch (error) {
    if (slackDeliveryFailureOutcome(error) === 'failed') {
      await input.record({ status: 'retryable' });
      throw new ContinuityNoticeDeliveryError(false);
    }
    await input.record({ status: 'unknown' });
    throw new ContinuityNoticeDeliveryError(true);
  }
}
