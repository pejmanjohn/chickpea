import type { WebClient } from '@slack/web-api';

import { renderSlackMessage, type SlackReplyFormat } from './message-format.ts';
import {
  slackLoadingMessages,
  slackStatusText,
  type SlackPresentationStage,
} from './replies.ts';

/**
 * The hand-rolled lane's sanitized provider-failure final (verbatim). The Flue
 * lane delivers this static text when the agent prompt call fails so no raw
 * provider error string can reach any Slack call (scenario S15). Kept as a
 * literal here rather than imported from the old runtime module to avoid
 * coupling the Flue lane to `src/runtime/*`.
 */
export const PROVIDER_FAILURE_TEXT =
  'I reached the Slack thread, but the model provider call failed before completion. I did not expose provider error details in Slack.';

export interface SlackPresenterTarget {
  channelId: string;
  threadTs: string;
  agentName: string;
  userId?: string;
  workspaceId?: string;
}

/**
 * Slack presentation over a `@slack/web-api` WebClient. This is the sole Slack
 * presentation path: it carries forward the status texts / loading messages and
 * fallback ordering that the deleted hand-rolled lane once implemented (in the
 * former src/runtime/slack-thread-runner.ts + src/slack/web-api-replies.ts),
 * now as a fresh WebClient-based module.
 *
 * Status policy: attempted per stage but latched off after the first rejection
 * for the turn (no retry storm — scenario S16); a clear is only issued when a
 * status was actually set (matching old-lane behavior).
 *
 * Final delivery: chat.startStream(markdown_text) -> chat.stopStream; on a
 * startStream rejection or missing recipient fields, fall back to a single
 * chat.postMessage with markdown blocks; a stopStream failure must NOT re-post
 * (scenario S18).
 */
export class WebClientPresenter {
  private statusFailed = false;
  private statusWasSet = false;

  constructor(
    private readonly client: WebClient,
    private readonly target: SlackPresenterTarget,
  ) {}

  /** Attempt to set the Assistant thread status for a stage. Returns whether it stuck. */
  async setStatus(stage: SlackPresentationStage): Promise<boolean> {
    if (this.statusFailed) {
      return false;
    }
    try {
      await this.client.assistant.threads.setStatus({
        channel_id: this.target.channelId,
        thread_ts: this.target.threadTs,
        status: slackStatusText(stage),
        loading_messages: slackLoadingMessages(stage),
      });
      this.statusWasSet = true;
      return true;
    } catch {
      // Latch off further status attempts for this turn (S16: <=2 non-empty).
      this.statusFailed = true;
      return false;
    }
  }

  /** Clear the Assistant thread status, but only if one was ever set. */
  async clearStatus(): Promise<void> {
    if (!this.statusWasSet) {
      return;
    }
    try {
      await this.client.assistant.threads.setStatus({
        channel_id: this.target.channelId,
        thread_ts: this.target.threadTs,
        status: '',
      });
    } catch {
      // A failed clear is non-fatal; the turn already delivered its final.
    }
  }

  /**
   * Durable progress placeholder used when status could not be set: a plain
   * chat.postMessage with NO blocks, posted before the final (scenario S16).
   */
  async postProgress(text: string): Promise<void> {
    await this.client.chat.postMessage({
      channel: this.target.channelId,
      thread_ts: this.target.threadTs,
      text,
    });
  }

  /**
   * Deliver the final answer. Streams when possible; otherwise falls back to a
   * single markdown/plain chat.postMessage. A stopStream failure is swallowed so
   * the final is never duplicated (S18). Throws only when BOTH the stream and
   * the fallback post fail, so the caller can release its claim for a retry.
   */
  async deliverFinal(text: string, format: SlackReplyFormat): Promise<void> {
    if (this.target.userId && this.target.workspaceId) {
      try {
        const started = await this.client.chat.startStream({
          channel: this.target.channelId,
          thread_ts: this.target.threadTs,
          recipient_user_id: this.target.userId,
          recipient_team_id: this.target.workspaceId,
          markdown_text: text,
        });
        try {
          await this.client.chat.stopStream({
            channel: this.target.channelId,
            ts: started.ts as string,
          });
        } catch {
          // A stopStream failure must not trigger a duplicate final (S18).
        }
        return;
      } catch {
        // startStream rejected -> fall through to the post fallback.
      }
    }

    const rendered = renderSlackMessage(text, format);
    await this.client.chat.postMessage({
      channel: this.target.channelId,
      thread_ts: this.target.threadTs,
      ...rendered,
    });
  }
}
