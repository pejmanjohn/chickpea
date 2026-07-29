import type { WebClient } from '@slack/web-api';

import {
  appendSlackReplyFooter,
  renderSlackMessage,
  renderSlackReplyFooterBlock,
  sanitizeSlackMarkdownLinks,
  type SlackReplyFormat,
  type SlackReplyFooter,
} from './message-format.ts';
import {
  slackLoadingMessages,
  slackStatusText,
  type SlackStatusUpdate,
} from './replies.ts';

/** Static failure copy keeps raw provider errors out of Slack (scenario S15). */
export const PROVIDER_FAILURE_TEXT =
  'I reached the Slack thread, but the model provider call failed before completion. I did not expose provider error details in Slack.';

export const OPENAI_SUBSCRIPTION_RECONNECT_TEXT =
  'The ChatGPT subscription connection needs attention in Settings before this profile can answer. I did not use OpenAI API-key billing as fallback.';

export const OPENAI_SUBSCRIPTION_DISABLED_TEXT =
  'The ChatGPT Subscription preview is disabled for this installation, so this profile cannot answer. I did not use OpenAI API-key billing as fallback.';

export const OPENAI_SUBSCRIPTION_QUOTA_TEXT =
  'The ChatGPT subscription quota could not serve this request. I did not switch to OpenAI API-key billing.';

export const OPENAI_SUBSCRIPTION_POLICY_TEXT =
  'The connected ChatGPT subscription did not authorize this request. An administrator can review the Subscription status in Settings; I did not switch to OpenAI API-key billing.';

/** Static workspace failures disclose the affected surface, never SDK details. */
export const SANDBOX_FAILURE_TEXT =
  'I reached the Slack thread, but the coding workspace was temporarily unavailable before completion. I did not expose internal error details in Slack. Please retry in a moment.';

export const SANDBOX_SESSION_CAP_FAILURE_TEXT =
  "I couldn't open a coding workspace because this installation's monthly sandbox session limit has been reached. An administrator can review it in Settings.";

/** Unknown failures must not be misattributed to the model provider. */
export const AGENT_FAILURE_TEXT =
  'I reached the Slack thread, but the agent run failed before completion. I did not expose internal error details in Slack.';

export interface SlackPresenterTarget {
  channelId: string;
  threadTs: string;
  agentName: string;
  agentId: string;
  modelLabel?: string | undefined;
  publicUrl?: string | undefined;
  userId?: string;
  workspaceId?: string;
  memoryFooterItems?: readonly string[];
}

export interface SlackArtifactInput {
  channel: string;
  threadTs: string;
  bytes: Uint8Array;
  filename: string;
  title?: string;
}

export type SlackArtifactResult =
  | { uploaded: true }
  | { uploaded: false; reason: 'missing-scope' };

/**
 * Slack presentation over a `@slack/web-api` WebClient. This is the sole Slack
 * presentation path and owns the complete fallback ordering.
 *
 * Status policy: attempted per stage but latched off after the first rejection
 * for the turn (no retry storm — scenario S16); a clear is only issued when a
 * status was actually set.
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

  /** Attempt to set the Assistant thread status. Returns whether it stuck. */
  async setStatus(update: SlackStatusUpdate): Promise<boolean> {
    if (this.statusFailed) {
      return false;
    }
    try {
      await this.client.assistant.threads.setStatus({
        channel_id: this.target.channelId,
        thread_ts: this.target.threadTs,
        status: slackStatusText(update),
        loading_messages: slackLoadingMessages(update),
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
   * Attach a workspace artifact to its bound Slack thread. Slack's v2 upload
   * helper performs the external-upload sequence over the same patched fetch
   * used by the rest of this client.
   */
  async postArtifact(input: SlackArtifactInput): Promise<SlackArtifactResult> {
    try {
      await this.client.files.uploadV2({
        channel_id: input.channel,
        thread_ts: input.threadTs,
        file: Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength),
        filename: input.filename,
        ...(input.title === undefined ? {} : { title: input.title }),
      });
      return { uploaded: true };
    } catch (err) {
      if (isMissingFilesScopeError(err)) {
        return { uploaded: false, reason: 'missing-scope' };
      }
      throw err;
    }
  }

  /**
   * Deliver the final answer. Streams when possible; otherwise falls back to a
   * single markdown/plain chat.postMessage. A stopStream failure is swallowed so
   * the final is never duplicated (S18). Throws only when BOTH the stream and
   * the fallback post fail, so the caller can release its claim for a retry.
   */
  async deliverFinal(text: string, format: SlackReplyFormat): Promise<void> {
    const footer = this.replyFooter();
    const displayText = format === 'markdown' ? sanitizeSlackMarkdownLinks(text) : text;

    if (this.target.userId && this.target.workspaceId) {
      try {
        const started = await this.client.chat.startStream({
          channel: this.target.channelId,
          thread_ts: this.target.threadTs,
          recipient_user_id: this.target.userId,
          recipient_team_id: this.target.workspaceId,
          markdown_text: displayText,
        });
        try {
          await this.client.chat.stopStream({
            channel: this.target.channelId,
            ts: started.ts as string,
            blocks: [renderSlackReplyFooterBlock(footer)],
          });
        } catch {
          // A stopStream failure must not trigger a duplicate final (S18).
        }
        return;
      } catch {
        // startStream rejected -> fall through to the post fallback.
      }
    }

    const rendered = appendSlackReplyFooter(renderSlackMessage(displayText, format), footer);
    await this.client.chat.postMessage({
      channel: this.target.channelId,
      thread_ts: this.target.threadTs,
      ...rendered,
    });
  }

  /** Deliver channel-contextual information only to the requesting member. */
  async deliverRequesterOnly(text: string, format: SlackReplyFormat): Promise<void> {
    if (!this.target.userId) {
      throw new Error('Requester-only Slack delivery requires a target user.');
    }
    const displayText = format === 'markdown' ? sanitizeSlackMarkdownLinks(text) : text;
    const rendered = appendSlackReplyFooter(
      renderSlackMessage(displayText, format),
      this.replyFooter(),
    );
    await this.client.chat.postEphemeral({
      channel: this.target.channelId,
      user: this.target.userId,
      ...rendered,
    });
  }

  private replyFooter(): SlackReplyFooter {
    return {
      profileName: this.target.agentName,
      modelLabel: this.target.modelLabel,
      agentId: this.target.agentId,
      publicUrl: this.target.publicUrl,
      memoryItems: this.target.memoryFooterItems,
    };
  }
}

function isMissingFilesScopeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const data = (err as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return false;
  const error = (data as { error?: unknown }).error;
  return error === 'missing_scope' || error === 'not_allowed_token_type';
}
