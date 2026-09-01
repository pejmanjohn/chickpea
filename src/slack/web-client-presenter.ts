import { ErrorCode, type WebClient } from '@slack/web-api';

import {
  emitSemanticActivityTelemetry,
  semanticTelemetryForStatus,
  type SemanticActivityTelemetrySink,
  type SemanticActivityTelemetrySurface,
} from '../activity/telemetry.ts';
import { isSafeTypedActivityStatus } from '../activity/status.ts';
import {
  appendSlackReplyFooter,
  canonicalSlackReplyText,
  renderSlackMessage,
  renderSlackReplyFooterBlock,
  type SlackReplyFormat,
  type SlackReplyFooter,
} from './message-format.ts';
import {
  appendSlackTableToRenderedMessage,
  renderSlackTablePresentation,
  type SlackTablePresentation,
} from './table-presentation.ts';
import {
  slackLoadingMessages,
  slackStatusText,
  type SlackStatusUpdate,
} from './replies.ts';
import {
  reactionFallbacks,
  SEMANTIC_REACTIONS,
  type SemanticReaction,
} from './interaction-intent.ts';
import type { SlackAgentViewPresentation } from './agent-view-presentation.ts';
import type {
  SlackPresentationOwner,
  SlackPresentationActivityProjection,
  SlackPresentationPlanV3,
  SlackPresentationReceiptCertainty,
} from './run-presentations.ts';
import { slackClientMessageId } from './transport/message-id.ts';
import { SlackTransportError } from './transport/types.ts';

/** Static failure copy keeps raw provider errors out of Slack (scenario S15). */
export const PROVIDER_FAILURE_TEXT =
  'I reached the Slack thread, but the model provider call failed before completion. I did not expose provider error details in Slack.';

export const OPENAI_SUBSCRIPTION_RECONNECT_TEXT =
  'The ChatGPT subscription connection needs attention in Settings before this Agent can answer. I did not use OpenAI API-key billing as fallback.';

export const OPENAI_SUBSCRIPTION_QUOTA_TEXT =
  'The ChatGPT subscription quota could not serve this request. I did not switch to OpenAI API-key billing.';

export const OPENAI_SUBSCRIPTION_POLICY_TEXT =
  'The connected ChatGPT subscription did not authorize this request. An administrator can review the Subscription status in Settings; I did not switch to OpenAI API-key billing.';

/** Static workspace failures disclose the affected surface, never SDK details. */
export const SANDBOX_FAILURE_TEXT =
  'I reached the Slack thread, but the coding workspace was temporarily unavailable before completion. I did not expose internal error details in Slack. Please retry in a moment.';

export const SANDBOX_SESSION_CAP_FAILURE_TEXT =
  "I couldn't open a coding workspace because this installation's monthly sandbox session limit has been reached. An administrator can review it in Settings.";

export const SANDBOX_UNAVAILABLE_FALLBACK_NOTICE =
  'Coding Sandbox was unavailable for this turn, so normal behavior was used without repository access.';

/** Unknown failures must not be misattributed to the model provider. */
export const AGENT_FAILURE_TEXT =
  'I reached the Slack thread, but the agent run failed before completion. I did not expose internal error details in Slack.';

export const DURABLE_RECOVERY_FAILURE_TEXT =
  "I couldn't finish this request after retrying. Please try again. If it keeps happening, ask a workspace admin to check Chickpea's Slack connection.";

export interface SlackPresenterTarget {
  channelId: string;
  threadTs: string;
  agentName: string;
  agentAvatarUrl?: string;
  /** Frozen V3 authorship. Omitted preserves legacy target-derived persona behavior. */
  visibleOwner?: SlackPresentationOwner;
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

export interface SlackReactionCoordinate {
  channelId: string;
  messageTs: string;
}

export interface SlackReactionReceipt {
  name: string;
  created: boolean;
}

export interface SlackDeliveryObserver {
  beforeDelivery(input: {
    method: string;
    approvedOutput: string;
    renderedPayload: string;
  }): Promise<string | undefined>;
  afterDelivery(input: {
    attemptId: string | undefined;
    outcome: 'delivered' | 'failed' | 'unknown';
    deliveryRef?: string;
    safeFailureCode?: string;
  }): Promise<void>;
}

export interface SlackPresenterOptions {
  deliverySafety?: 'legacy' | 'ledger';
  agentViewPresentation?: SlackAgentViewPresentation;
  /** Successful non-ephemeral final, for the ownership handoff ledger. */
  onPublicDelivery?: (input: { messageTs: string; text: string }) => void | Promise<void>;
  /** Rehydrates the one V3 activity artifact after an isolate restart. */
  activityProjection?: SlackPresentationActivityProjection;
  /** A native write had an ambiguous receipt and therefore still needs clear. */
  activityMayBeVisible?: boolean;
  /** Installation-scoped durable budget shared by native semantic status writers. */
  activityStatusCoordinator?: {
    reserve(): Promise<{ outcome: 'reserved' | 'cooldown' | 'exhausted' }>;
    applyCooldown(retryAfterMs: number): Promise<unknown>;
  };
  /** Fixed-schema content-free observability; injectable for focused tests. */
  activityTelemetry?: SemanticActivityTelemetrySink;
}

export interface SlackActivityWrite {
  operationId: string;
  surface: 'message' | 'assistant_status';
  messageTs?: string;
}

export type SlackActivityReceiptCertainty = Exclude<
  SlackPresentationReceiptCertainty,
  'pending'
>;

export class PersistedSlackDeliveryError extends Error {
  constructor(
    readonly outcome: 'failed' | 'unknown',
    readonly safeFailureCode: string,
  ) {
    super(`Persisted Slack delivery ${outcome}.`);
    this.name = 'PersistedSlackDeliveryError';
  }
}

/**
 * Slack presentation over a `@slack/web-api` WebClient. This is the sole Slack
 * presentation path and owns the complete fallback ordering.
 *
 * Status policy: attempted per truthful stage but latched off after the first
 * rejection for the turn; a clear is only issued when a status was set.
 *
 * Final delivery: chat.startStream(markdown_text) -> chat.stopStream; on a
 * startStream rejection or missing recipient fields, fall back to a single
 * chat.postMessage with markdown blocks; a stopStream failure must NOT re-post
 * (scenario S18).
 */
export class WebClientPresenter {
  private statusFailed = false;
  private statusWasSet = false;
  private activityMessageTs: string | undefined;
  private lastActivityReceiptCertainty: SlackActivityReceiptCertainty = 'failed';

  constructor(
    private readonly client: WebClient,
    private readonly target: SlackPresenterTarget,
    private readonly deliveryObserver?: SlackDeliveryObserver,
    private readonly options: SlackPresenterOptions = {},
  ) {
    const projection = options.activityProjection;
    if (projection?.surface === 'message' && projection.state === 'visible') {
      this.activityMessageTs = projection.messageTs;
      this.statusWasSet = true;
    } else if (projection?.surface === 'assistant_status' && projection.state === 'visible') {
      this.statusWasSet = true;
    } else if (projection?.surface === 'assistant_status' &&
        projection.state === 'unavailable') {
      this.statusFailed = true;
      this.statusWasSet = options.activityMayBeVisible === true;
    } else if (projection?.surface === 'assistant_status' &&
        options.activityMayBeVisible === true) {
      this.statusWasSet = true;
    }
  }

  preferredActivitySurface(): 'message' | 'assistant_status' {
    const projection = this.options.activityProjection;
    if (projection && projection.surface !== 'unselected') return projection.surface;
    // Every new semantic projection is native. `message` can only be returned
    // above when durable state proves an existing legacy coordinate.
    return 'assistant_status';
  }

  /**
   * Present one owner-authored activity artifact. New activity is native-only;
   * a legacy message may only be updated when durable state already supplies
   * its exact coordinate. A failed native write never creates a message.
   */
  async setStatus(update: SlackStatusUpdate, durable?: SlackActivityWrite): Promise<boolean> {
    const startedAt = Date.now();
    this.lastActivityReceiptCertainty = 'failed';
    if (this.statusFailed) {
      this.emitTransport(
        activitySurface(this.activityMessageTs, durable),
        'latched_off',
        startedAt,
        update,
      );
      return false;
    }
    const chat = (this.client as unknown as {
      chat?: {
        update?: (input: Record<string, unknown>) => Promise<unknown>;
      };
    }).chat;
    if (durable?.surface === 'message' && durable.messageTs) {
      this.activityMessageTs = durable.messageTs;
      this.statusWasSet = true;
    }
    if (this.activityMessageTs) {
      if (typeof chat?.update !== 'function') {
        this.statusFailed = true;
        this.emitTransport('legacy_message', 'rejected', startedAt, update);
        return false;
      }
      try {
        await chat.update({
          channel: this.target.channelId,
          ts: this.activityMessageTs,
          text: update.text,
        });
        this.lastActivityReceiptCertainty = 'acknowledged';
        this.emitTransport('legacy_message', 'acknowledged', startedAt, update);
        return true;
      } catch (error) {
        // An existing visible activity must never gain a competing fallback.
        this.lastActivityReceiptCertainty = slackDeliveryFailureOutcome(error);
        this.statusFailed = true;
        this.emitTransport(
          'legacy_message',
          transportTelemetryOutcome(this.lastActivityReceiptCertainty),
          startedAt,
          update,
        );
        return false;
      }
    }
    if (durable?.surface === 'message') {
      this.emitTransport('legacy_message', 'rejected', startedAt, update);
      return false;
    }
    const reservation = await this.reserveNativeStatus();
    if (!reservation) {
      this.emitTransport('assistant_status', 'rejected', startedAt, update);
      return false;
    }
    try {
      await this.client.assistant.threads.setStatus({
        channel_id: this.target.channelId,
        thread_ts: this.target.threadTs,
        status: slackStatusText(update),
        loading_messages: slackLoadingMessages(update),
        ...this.nativeStatusPersona(),
      });
      this.statusWasSet = true;
      this.lastActivityReceiptCertainty = 'acknowledged';
      this.emitTransport('assistant_status', 'acknowledged', startedAt, update);
      return true;
    } catch (error) {
      // Latch off further custom-status attempts for this turn.
      this.lastActivityReceiptCertainty = slackDeliveryFailureOutcome(error);
      this.statusFailed = true;
      if (this.lastActivityReceiptCertainty === 'unknown') this.statusWasSet = true;
      this.emitTransport(
        'assistant_status',
        transportTelemetryOutcome(this.lastActivityReceiptCertainty),
        startedAt,
        update,
      );
      const retryAfterMs = slackRateRetryAfterMs(error);
      if (retryAfterMs !== undefined) {
        emitSemanticActivityTelemetry({
          event: 'activity.rate',
          outcome: 'cooldown',
          durationMs: retryAfterMs,
        }, this.options.activityTelemetry ?? console);
        await this.options.activityStatusCoordinator?.applyCooldown(
          retryAfterMs,
        ).catch(() => undefined);
      }
      return false;
    }
  }

  private async reserveNativeStatus(): Promise<boolean> {
    const coordinator = this.options.activityStatusCoordinator;
    if (!coordinator) return true;
    try {
      const result = await coordinator.reserve();
      emitSemanticActivityTelemetry({
        event: 'activity.rate',
        outcome: result.outcome,
      }, this.options.activityTelemetry ?? console);
      return result.outcome === 'reserved';
    } catch {
      // Coordination is part of the cosmetic transport. A state failure must
      // not bypass the shared budget or interfere with final delivery.
      emitSemanticActivityTelemetry({
        event: 'activity.rate',
        outcome: 'unavailable',
      }, this.options.activityTelemetry ?? console);
      return false;
    }
  }

  activityReceiptCertainty(): SlackActivityReceiptCertainty {
    return this.lastActivityReceiptCertainty;
  }

  activityReceipt(): {
    certainty: SlackActivityReceiptCertainty;
    messageTs?: string;
    unavailable?: boolean;
  } {
    return {
      certainty: this.lastActivityReceiptCertainty,
      ...(this.activityMessageTs ? { messageTs: this.activityMessageTs } : {}),
      ...(this.statusFailed && !this.activityMessageTs ? { unavailable: true } : {}),
    };
  }

  /** Clear the Assistant thread status, but only if one was ever set. */
  async clearStatus(late = false): Promise<SlackActivityReceiptCertainty> {
    const startedAt = Date.now();
    if (!this.statusWasSet) {
      this.emitClear(activitySurface(this.activityMessageTs), 'skipped', late, startedAt);
      return 'acknowledged';
    }
    if (this.activityMessageTs) {
      try {
        await this.client.chat.delete({
          channel: this.target.channelId,
          ts: this.activityMessageTs,
        });
        this.activityMessageTs = undefined;
        this.statusWasSet = false;
        this.emitClear('legacy_message', 'acknowledged', late, startedAt);
        return 'acknowledged';
      } catch (error) {
        if (slackPlatformErrorCode(error) === 'message_not_found') {
          this.activityMessageTs = undefined;
          this.statusWasSet = false;
          this.emitClear('legacy_message', 'acknowledged', late, startedAt);
          return 'acknowledged';
        }
        const certainty = slackDeliveryFailureOutcome(error);
        this.emitClear(
          'legacy_message',
          clearTelemetryOutcome(certainty),
          late,
          startedAt,
        );
        return certainty;
      }
    }
    try {
      await this.client.assistant.threads.setStatus({
        channel_id: this.target.channelId,
        thread_ts: this.target.threadTs,
        status: '',
      });
      this.statusWasSet = false;
      this.emitClear('assistant_status', 'acknowledged', late, startedAt);
      return 'acknowledged';
    } catch (error) {
      const certainty = slackDeliveryFailureOutcome(error);
      this.emitClear(
        'assistant_status',
        clearTelemetryOutcome(certainty),
        late,
        startedAt,
      );
      return certainty;
    }
  }

  private emitTransport(
    surface: SemanticActivityTelemetrySurface,
    outcome: 'acknowledged' | 'rejected' | 'ambiguous' | 'latched_off',
    startedAt: number,
    update: SlackStatusUpdate,
  ): void {
    const semantic = isSafeTypedActivityStatus(update)
      ? semanticTelemetryForStatus(update)
      : { family: 'unknown' as const, phase: 'working' as const };
    emitSemanticActivityTelemetry({
      event: 'activity.transport',
      surface,
      outcome,
      ...semantic,
      durationMs: Date.now() - startedAt,
    }, this.options.activityTelemetry ?? console);
  }

  private emitClear(
    surface: SemanticActivityTelemetrySurface,
    outcome: 'acknowledged' | 'rejected' | 'ambiguous' | 'skipped',
    late: boolean,
    startedAt: number,
  ): void {
    emitSemanticActivityTelemetry({
      event: 'activity.clear',
      surface,
      outcome,
      late,
      durationMs: Date.now() - startedAt,
    }, this.options.activityTelemetry ?? console);
  }

  /** Best-effort work acknowledgment. The receipt records whether this run
   * created the reaction so terminal cleanup never removes a pre-existing eye. */
  async addSemanticReaction(
    reaction: SemanticReaction,
    coordinate: SlackReactionCoordinate,
  ): Promise<SlackReactionReceipt> {
    return addReactionChain(this.client, reactionFallbacks(reaction), coordinate);
  }

  async removeReaction(name: string, coordinate: SlackReactionCoordinate): Promise<void> {
    try {
      await this.client.reactions.remove({
        name,
        channel: coordinate.channelId,
        timestamp: coordinate.messageTs,
      });
    } catch (error) {
      if (slackPlatformErrorCode(error) === 'no_reaction') return;
      throw error;
    }
  }

  /** Canonical reaction-only delivery. The whole fallback chain is persisted
   * before the first Slack write so recovery never needs model reclassification. */
  async deliverReaction(
    reaction: SemanticReaction,
    coordinate: SlackReactionCoordinate,
  ): Promise<SlackReactionReceipt> {
    const names = reactionFallbacks(reaction);
    const payload = {
      method: 'slack_reaction_add' as const,
      semantic: reaction,
      names,
      channel: coordinate.channelId,
      timestamp: coordinate.messageTs,
      threadTs: this.target.threadTs,
      fallbackText: reactionTextEquivalent(reaction),
    };
    const attemptId = await this.observeBeforeDelivery({
      method: payload.method,
      approvedOutput: reaction,
      renderedPayload: JSON.stringify(payload),
    });
    try {
      let receipt: SlackReactionReceipt;
      try {
        receipt = await addReactionChain(this.client, names, coordinate);
      } catch (error) {
        if (slackDeliveryFailureOutcome(error) !== 'failed') throw error;
        const posted = await this.client.chat.postMessage({
          channel: this.target.channelId,
          thread_ts: this.target.threadTs,
          text: payload.fallbackText,
          ...this.persona(),
        });
        await this.observeAfterDelivery({
          attemptId,
          outcome: 'delivered',
          deliveryRef: slackDeliveryRef(this.target.channelId, posted.ts),
        });
        return { name: 'text_fallback', created: false };
      }
      await this.observeAfterDelivery({
        attemptId,
        outcome: 'delivered',
        deliveryRef: `slack:${coordinate.channelId}:${coordinate.messageTs}:reaction:${receipt.name}`,
      });
      return receipt;
    } catch (error) {
      const outcome = this.deliveryOutcome(error);
      await this.observeAfterDelivery({
        attemptId,
        outcome,
        safeFailureCode: outcome === 'failed'
          ? 'slack_reaction_failed'
          : 'slack_reaction_unknown',
      });
      throw error;
    }
  }

  /** One accessible, non-ephemeral checklist. Returns its coordinate only
   * after Slack confirms the post; unknown outcomes are deliberately not retried. */
  async postWorkChecklist(checklist: readonly string[]): Promise<string | undefined> {
    const rendered = renderWorkChecklist(checklist, false);
    const response = await this.client.chat.postMessage({
      channel: this.target.channelId,
      thread_ts: this.target.threadTs,
      text: rendered.text,
      blocks: rendered.blocks,
      ...this.persona(),
    });
    return typeof response.ts === 'string' && response.ts ? response.ts : undefined;
  }

  async updateWorkChecklist(
    messageTs: string,
    checklist: readonly string[],
    complete: boolean | 'failed',
  ): Promise<void> {
    const rendered = renderWorkChecklist(checklist, complete);
    await this.client.chat.update({
      channel: this.target.channelId,
      ts: messageTs,
      text: rendered.text,
      blocks: rendered.blocks,
    });
  }

  async deleteWorkChecklist(messageTs: string): Promise<void> {
    await this.client.chat.delete({
      channel: this.target.channelId,
      ts: messageTs,
    });
  }

  /** Message-based parity renderer for surfaces where native task details are insufficient. */
  async postMilestonePlan(plan: SlackPresentationPlanV3): Promise<string | undefined> {
    const rendered = renderMilestonePlan(plan);
    if (!rendered) return undefined;
    const response = await this.client.chat.postMessage({
      channel: this.target.channelId,
      thread_ts: this.target.threadTs,
      text: rendered.text,
      blocks: rendered.blocks,
      ...this.persona(),
    });
    return typeof response.ts === 'string' && response.ts ? response.ts : undefined;
  }

  async updateMilestonePlan(messageTs: string, plan: SlackPresentationPlanV3): Promise<void> {
    const rendered = renderMilestonePlan(plan);
    if (!rendered) return;
    await this.client.chat.update({
      channel: this.target.channelId,
      ts: messageTs,
      text: rendered.text,
      blocks: rendered.blocks,
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
        ...this.persona(),
      } as unknown as Parameters<WebClient['files']['uploadV2']>[0]);
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
  async deliverFinal(
    text: string,
    format: SlackReplyFormat,
    terminalTaskStatus: 'complete' | 'error' = 'complete',
    tablePresentation?: SlackTablePresentation,
  ): Promise<void> {
    const footer = this.replyFooter();
    const displayText = canonicalSlackReplyText(text, format);
    const renderedTable = tablePresentation
      ? renderSlackTablePresentation(tablePresentation, Math.max(0, 12_000 - displayText.length - 2))
      : undefined;

    let forcePostFallback = false;
    let fallbackOperationId: string | undefined;
    if (this.options.agentViewPresentation) {
      const result = await this.options.agentViewPresentation.finalize(
        text,
        format,
        terminalTaskStatus,
        {
          before: (input) => this.observeBeforeDelivery(input),
          after: (input) => this.observeAfterDelivery(input),
        },
        tablePresentation,
      );
      if (result.handled) {
        if (result.messageTs) await this.notifyPublicDelivery(result.messageTs, displayText);
        return;
      }
      forcePostFallback = result.fallbackPresentation;
      fallbackOperationId = result.operationId;
    }

    if (!forcePostFallback && this.target.userId && this.target.workspaceId) {
      const startPayload = {
        channel: this.target.channelId,
        thread_ts: this.target.threadTs,
        recipient_user_id: this.target.userId,
        recipient_team_id: this.target.workspaceId,
        markdown_text: displayText,
        ...this.persona(),
      } as unknown as Parameters<WebClient['chat']['startStream']>[0];
      const stopBlocks = [
        ...(renderedTable ? [renderedTable.block] : []),
        renderSlackReplyFooterBlock(footer),
      ];
      const attemptId = await this.observeBeforeDelivery({
        method: 'slack_chat_stream',
        approvedOutput: displayText,
        renderedPayload: JSON.stringify({
          method: 'slack_chat_stream',
          start: startPayload,
          stop: { blocks: stopBlocks },
        }),
      });
      let started: Awaited<ReturnType<WebClient['chat']['startStream']>>;
      try {
        started = await this.client.chat.startStream(startPayload);
      } catch (error) {
        const outcome = this.deliveryOutcome(error);
        await this.observeAfterDelivery({
          attemptId,
          outcome,
          safeFailureCode: outcome === 'failed'
            ? 'slack_stream_not_started'
            : 'slack_stream_start_unknown',
        });
        if (outcome === 'unknown') throw error;
        // A confirmed start rejection may use the documented post fallback.
        started = undefined as never;
      }
      if (started) {
        try {
          await this.client.chat.stopStream({
            channel: this.target.channelId,
            ts: started.ts as string,
            blocks: stopBlocks,
          });
        } catch (error) {
          // A stopStream failure must not trigger a duplicate final (S18).
          await this.observeAfterDelivery({
            attemptId,
            outcome: 'unknown',
            safeFailureCode: 'slack_stream_finalize_unknown',
          });
          if (this.options.deliverySafety === 'ledger') throw error;
          return;
        }
        await this.observeAfterDelivery({
          attemptId,
          outcome: 'delivered',
          deliveryRef: slackDeliveryRef(this.target.channelId, started.ts),
        });
        await this.notifyPublicDelivery(String(started.ts), displayText);
        return;
      }
    }

    const content = renderedTable
      ? appendSlackTableToRenderedMessage(
          renderSlackMessage(displayText, format),
          displayText,
          renderedTable,
        )
      : renderSlackMessage(displayText, format);
    const rendered = appendSlackReplyFooter(content, footer);
    const postPayload = {
      channel: this.target.channelId,
      thread_ts: this.target.threadTs,
      ...rendered,
      ...(forcePostFallback && fallbackOperationId
        ? { client_msg_id: slackClientMessageId(fallbackOperationId) }
        : {}),
      ...this.persona(),
    };
    const attemptId = await this.observeBeforeDelivery({
      method: 'slack_chat_post_message',
      approvedOutput: displayText,
      renderedPayload: JSON.stringify({ method: 'slack_chat_post_message', payload: postPayload }),
    });
    try {
      const posted = await this.client.chat.postMessage(postPayload);
      if (forcePostFallback) {
        // Persist the exact replacement coordinate before the Work delivery
        // receipt. A restart can then settle Work without posting again.
        await this.options.agentViewPresentation?.markFallbackDelivered(posted.ts);
      }
      await this.observeAfterDelivery({
        attemptId,
        outcome: 'delivered',
        deliveryRef: slackDeliveryRef(this.target.channelId, posted.ts),
      });
      if (typeof posted.ts === 'string' && posted.ts) {
        await this.notifyPublicDelivery(posted.ts, displayText);
      }
    } catch (error) {
      const outcome = this.deliveryOutcome(error);
      if (forcePostFallback) {
        await this.options.agentViewPresentation?.markFallbackDeliveryFailed(outcome);
      }
      await this.observeAfterDelivery({
        attemptId,
        outcome,
        safeFailureCode: outcome === 'failed' ? 'slack_post_failed' : 'slack_post_unknown',
      });
      throw error;
    }
  }

  async markCanonicalPresentationFinalized(): Promise<void> {
    await this.options.agentViewPresentation?.markCanonicalFinalized();
  }

  /** Deliver channel-contextual information only to the requesting member. */
  async deliverRequesterOnly(
    text: string,
    format: SlackReplyFormat,
    tablePresentation?: SlackTablePresentation,
  ): Promise<void> {
    if (!this.target.userId) {
      throw new Error('Requester-only Slack delivery requires a target user.');
    }
    const displayText = canonicalSlackReplyText(text, format);
    const renderedTable = tablePresentation
      ? renderSlackTablePresentation(tablePresentation, Math.max(0, 12_000 - displayText.length - 2))
      : undefined;
    const content = renderedTable
      ? appendSlackTableToRenderedMessage(
          renderSlackMessage(displayText, format),
          displayText,
          renderedTable,
        )
      : renderSlackMessage(displayText, format);
    const rendered = appendSlackReplyFooter(content, this.replyFooter());
    const payload = {
      channel: this.target.channelId,
      user: this.target.userId,
      ...rendered,
      ...this.persona(),
    };
    const attemptId = await this.observeBeforeDelivery({
      method: 'slack_chat_post_ephemeral',
      approvedOutput: displayText,
      renderedPayload: JSON.stringify({ method: 'slack_chat_post_ephemeral', payload }),
    });
    try {
      const posted = await this.client.chat.postEphemeral(payload);
      await this.observeAfterDelivery({
        attemptId,
        outcome: 'delivered',
        deliveryRef: slackDeliveryRef(this.target.channelId, posted.message_ts),
      });
    } catch (error) {
      const outcome = this.deliveryOutcome(error);
      await this.observeAfterDelivery({
        attemptId,
        outcome,
        safeFailureCode: outcome === 'failed'
          ? 'slack_ephemeral_failed'
          : 'slack_ephemeral_unknown',
      });
      throw error;
    }
  }

  private async observeBeforeDelivery(
    input: Parameters<SlackDeliveryObserver['beforeDelivery']>[0],
  ): Promise<string | undefined> {
    try {
      return await this.deliveryObserver?.beforeDelivery(input);
    } catch (error) {
      if (this.options.deliverySafety === 'ledger') throw error;
      console.warn('[work] Slack delivery observation failed; delivery will continue');
      return undefined;
    }
  }

  private async notifyPublicDelivery(messageTs: string, text: string): Promise<void> {
    try {
      await this.options.onPublicDelivery?.({ messageTs, text });
    } catch {
      // Slack delivery is the commit point. Ledger repair must never turn a
      // confirmed final into a duplicate-delivery retry.
      console.warn('[chickpea] Slack public-context recording failed');
    }
  }

  private async observeAfterDelivery(
    input: Parameters<SlackDeliveryObserver['afterDelivery']>[0],
  ): Promise<void> {
    try {
      await this.deliveryObserver?.afterDelivery(input);
    } catch (error) {
      if (this.options.deliverySafety === 'ledger') throw error;
      console.warn('[work] Slack delivery outcome observation failed');
    }
  }

  private deliveryOutcome(error: unknown): 'failed' | 'unknown' {
    return this.options.deliverySafety === 'ledger'
      ? slackDeliveryFailureOutcome(error)
      : 'failed';
  }

  private replyFooter(): SlackReplyFooter {
    return {
      agentName: this.target.agentName,
      modelLabel: this.target.modelLabel,
      agentId: this.target.agentId,
      publicUrl: this.target.publicUrl,
      memoryItems: this.target.memoryFooterItems,
    };
  }

  private persona(): { username?: string; icon_url?: string } {
    if (this.target.visibleOwner?.kind === 'chickpea') return {};
    if (this.target.visibleOwner?.kind === 'selected_agent') {
      return {
        username: this.target.visibleOwner.persona.name,
        icon_url: this.target.visibleOwner.persona.avatarUrl,
      };
    }
    return {
      username: this.target.agentName,
      ...(this.target.agentAvatarUrl ? { icon_url: this.target.agentAvatarUrl } : {}),
    };
  }

  private nativeStatusPersona(): { username?: string; icon_url?: string } {
    if (this.target.visibleOwner?.kind !== 'selected_agent') return {};
    return {
      username: this.target.visibleOwner.persona.name,
      icon_url: this.target.visibleOwner.persona.avatarUrl,
    };
  }
}

function activitySurface(
  messageTs: string | undefined,
  durable?: SlackActivityWrite,
): SemanticActivityTelemetrySurface {
  return messageTs || durable?.surface === 'message' ? 'legacy_message' : 'assistant_status';
}

function transportTelemetryOutcome(
  certainty: SlackActivityReceiptCertainty,
): 'acknowledged' | 'rejected' | 'ambiguous' {
  if (certainty === 'acknowledged') return 'acknowledged';
  return certainty === 'unknown' ? 'ambiguous' : 'rejected';
}

function clearTelemetryOutcome(
  certainty: SlackActivityReceiptCertainty,
): 'acknowledged' | 'rejected' | 'ambiguous' {
  return transportTelemetryOutcome(certainty);
}

/** Replay a previously persisted adapter render without invoking the agent or
 * re-rendering from mutable Agent/config state. */
export interface PersistedSlackDeliveryReceipt {
  method: string;
  deliveryRef: string;
  terminalTaskStatus?: 'complete' | 'error';
}

export async function deliverPersistedSlackPayload(
  client: WebClient,
  renderedPayload: string,
): Promise<PersistedSlackDeliveryReceipt> {
  const envelope = parsePersistedEnvelope(renderedPayload);
  if (envelope.method === 'slack_reaction_add') {
    try {
      try {
        const receipt = await addReactionChain(client, envelope.names, {
          channelId: envelope.channel,
          messageTs: envelope.timestamp,
        });
        return {
          method: envelope.method,
          deliveryRef: `slack:${envelope.channel}:${envelope.timestamp}:reaction:${receipt.name}`,
        };
      } catch (error) {
        if (slackDeliveryFailureOutcome(error) !== 'failed') throw error;
        const posted = await client.chat.postMessage({
          channel: envelope.channel,
          thread_ts: envelope.threadTs,
          text: envelope.fallbackText,
        });
        return {
          method: 'slack_chat_post_message',
          deliveryRef: slackDeliveryRef(envelope.channel, posted.ts),
        };
      }
    } catch (error) {
      throw persistedDeliveryError(error, 'slack_reaction_failed', 'slack_reaction_unknown');
    }
  }
  if (envelope.method === 'slack_chat_post_message') {
    try {
      const response = await client.chat.postMessage(
        envelope.payload as unknown as Parameters<WebClient['chat']['postMessage']>[0],
      );
      const channel = stringField(response, 'channel') ?? stringField(envelope.payload, 'channel');
      const ts = stringField(response, 'ts');
      if (!channel || !ts) throw new PersistedSlackDeliveryError(
        'unknown',
        'slack_delivery_receipt_incomplete',
      );
      return { method: envelope.method, deliveryRef: slackDeliveryRef(channel, ts) };
    } catch (error) {
      throw persistedDeliveryError(error, 'slack_post_failed', 'slack_post_unknown');
    }
  }
  if (envelope.method === 'slack_chat_post_ephemeral') {
    try {
      const response = await client.chat.postEphemeral(
        envelope.payload as unknown as Parameters<WebClient['chat']['postEphemeral']>[0],
      );
      const channel = stringField(envelope.payload, 'channel');
      const ts = stringField(response, 'message_ts');
      if (!channel || !ts) throw new PersistedSlackDeliveryError(
        'unknown',
        'slack_delivery_receipt_incomplete',
      );
      return { method: envelope.method, deliveryRef: slackDeliveryRef(channel, ts) };
    } catch (error) {
      throw persistedDeliveryError(error, 'slack_ephemeral_failed', 'slack_ephemeral_unknown');
    }
  }
  if (envelope.method === 'slack_chat_stream_resume') {
    try {
      await client.chat.stopStream({
        channel: envelope.channel,
        ts: envelope.ts,
        ...envelope.stop,
      });
      return {
        method: envelope.method,
        deliveryRef: slackDeliveryRef(envelope.channel, envelope.ts),
        ...terminalTaskStatusField(envelope),
      };
    } catch (error) {
      throw persistedDeliveryError(
        error,
        'slack_stream_finalize_failed',
        'slack_stream_finalize_unknown',
      );
    }
  }
  if (envelope.method === 'slack_chat_stream_correct') {
    try {
      await client.chat.stopStream({
        channel: envelope.channel,
        ts: envelope.ts,
        ...envelope.stop,
      });
      await client.chat.update(
        envelope.update as unknown as Parameters<WebClient['chat']['update']>[0],
      );
      return {
        method: envelope.method,
        deliveryRef: slackDeliveryRef(envelope.channel, envelope.ts),
        ...terminalTaskStatusField(envelope),
      };
    } catch (error) {
      throw persistedDeliveryError(
        error,
        'slack_stream_correction_failed',
        'slack_stream_correction_unknown',
      );
    }
  }
  try {
    const started = await client.chat.startStream(
      envelope.start as unknown as Parameters<WebClient['chat']['startStream']>[0],
    );
    const channel = stringField(envelope.start, 'channel');
    const ts = stringField(started, 'ts');
    if (!channel || !ts) throw new PersistedSlackDeliveryError(
      'unknown',
      'slack_delivery_receipt_incomplete',
    );
    try {
      await client.chat.stopStream({ channel, ts, ...envelope.stop });
    } catch {
      throw new PersistedSlackDeliveryError('unknown', 'slack_stream_finalize_unknown');
    }
    return {
      method: envelope.method,
      deliveryRef: slackDeliveryRef(channel, ts),
      ...terminalTaskStatusField(envelope),
    };
  } catch (error) {
    throw persistedDeliveryError(error, 'slack_stream_not_started', 'slack_stream_start_unknown');
  }
}

export function slackDeliveryFailureOutcome(error: unknown): 'failed' | 'unknown' {
  if (error instanceof SlackTransportError) return error.effectOutcome;
  const code = error && typeof error === 'object'
    ? (error as { code?: unknown }).code
    : undefined;
  return code === ErrorCode.PlatformError || code === ErrorCode.RateLimitedError
    ? 'failed'
    : 'unknown';
}

function persistedDeliveryError(
  error: unknown,
  failedCode: string,
  unknownCode: string,
): PersistedSlackDeliveryError {
  if (error instanceof PersistedSlackDeliveryError) return error;
  const outcome = slackDeliveryFailureOutcome(error);
  return new PersistedSlackDeliveryError(
    outcome,
    outcome === 'failed' ? failedCode : unknownCode,
  );
}

type PersistedEnvelope =
  | { method: 'slack_chat_post_message'; payload: Record<string, unknown> }
  | { method: 'slack_chat_post_ephemeral'; payload: Record<string, unknown> }
  | {
      method: 'slack_reaction_add';
      semantic: SemanticReaction;
      names: string[];
      channel: string;
      timestamp: string;
      threadTs: string;
      fallbackText: string;
    }
  | {
      method: 'slack_chat_stream';
      start: Record<string, unknown>;
      stop: Record<string, unknown>;
      terminalTaskStatus?: 'complete' | 'error';
    }
  | {
      method: 'slack_chat_stream_resume';
      channel: string;
      ts: string;
      stop: Record<string, unknown>;
      terminalTaskStatus?: 'complete' | 'error';
    }
  | {
      method: 'slack_chat_stream_correct';
      channel: string;
      ts: string;
      stop: Record<string, unknown>;
      update: Record<string, unknown>;
      terminalTaskStatus?: 'complete' | 'error';
    };

function parsePersistedEnvelope(raw: string): PersistedEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PersistedSlackDeliveryError('unknown', 'slack_render_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PersistedSlackDeliveryError('unknown', 'slack_render_invalid');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.method === 'slack_reaction_add' &&
    typeof record.semantic === 'string' &&
    SEMANTIC_REACTIONS.includes(record.semantic as SemanticReaction) &&
    Array.isArray(record.names) && record.names.length > 0 && record.names.length <= 3 &&
    record.names.every((name) => typeof name === 'string' && /^[a-z0-9_+-]{1,80}$/.test(name)) &&
    typeof record.channel === 'string' && record.channel.length > 0 &&
    typeof record.timestamp === 'string' && record.timestamp.length > 0 &&
    typeof record.threadTs === 'string' && record.threadTs.length > 0 &&
    typeof record.fallbackText === 'string'
  ) {
    return {
      method: record.method,
      semantic: record.semantic as SemanticReaction,
      names: record.names,
      channel: record.channel,
      timestamp: record.timestamp,
      threadTs: record.threadTs,
      fallbackText: record.fallbackText,
    };
  }
  if (
    (record.method === 'slack_chat_post_message' ||
      record.method === 'slack_chat_post_ephemeral') &&
    isRecord(record.payload)
  ) {
    return { method: record.method, payload: record.payload };
  }
  if (
    record.method === 'slack_chat_stream' &&
    isRecord(record.start) &&
    isRecord(record.stop)
  ) {
    return {
      method: record.method,
      start: record.start,
      stop: record.stop,
      ...terminalTaskStatusField(record),
    };
  }
  if (
    record.method === 'slack_chat_stream_resume' &&
    typeof record.channel === 'string' && record.channel.length > 0 &&
    typeof record.ts === 'string' && record.ts.length > 0 &&
    isRecord(record.stop)
  ) {
    return {
      method: record.method,
      channel: record.channel,
      ts: record.ts,
      stop: record.stop,
      ...terminalTaskStatusField(record),
    };
  }
  if (
    record.method === 'slack_chat_stream_correct' &&
    typeof record.channel === 'string' && record.channel.length > 0 &&
    typeof record.ts === 'string' && record.ts.length > 0 &&
    isRecord(record.stop) && isRecord(record.update)
  ) {
    return {
      method: record.method,
      channel: record.channel,
      ts: record.ts,
      stop: record.stop,
      update: record.update,
      ...terminalTaskStatusField(record),
    };
  }
  throw new PersistedSlackDeliveryError('unknown', 'slack_render_invalid');
}

function terminalTaskStatusField(
  record: { terminalTaskStatus?: unknown },
): { terminalTaskStatus?: 'complete' | 'error' } {
  return record.terminalTaskStatus === 'complete' || record.terminalTaskStatus === 'error'
    ? { terminalTaskStatus: record.terminalTaskStatus }
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === 'string' && value[key]
    ? value[key]
    : undefined;
}

function slackDeliveryRef(channelId: string, messageTs: unknown): string {
  const safeTs = typeof messageTs === 'string' && /^[0-9]+(?:\.[0-9]+)?$/.test(messageTs)
    ? messageTs
    : 'acknowledged';
  return `slack:${channelId}:${safeTs}`;
}

function isMissingFilesScopeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const data = (err as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return false;
  const error = (data as { error?: unknown }).error;
  return error === 'missing_scope' || error === 'not_allowed_token_type';
}

async function addReactionChain(
  client: WebClient,
  names: readonly string[],
  coordinate: SlackReactionCoordinate,
): Promise<SlackReactionReceipt> {
  let lastError: unknown;
  for (const name of names) {
    try {
      await client.reactions.add({
        name,
        channel: coordinate.channelId,
        timestamp: coordinate.messageTs,
      });
      return { name, created: true };
    } catch (error) {
      const code = slackPlatformErrorCode(error);
      if (code === 'already_reacted') return { name, created: false };
      lastError = error;
      if (code === 'invalid_name') continue;
      throw error;
    }
  }
  throw lastError ?? new PersistedSlackDeliveryError('failed', 'slack_reaction_failed');
}

function slackPlatformErrorCode(error: unknown): string | undefined {
  if (error instanceof SlackTransportError) return error.code;
  if (!error || typeof error !== 'object') return undefined;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return undefined;
  const code = (data as { error?: unknown }).error;
  return typeof code === 'string' ? code : undefined;
}

function slackRateRetryAfterMs(error: unknown): number | undefined {
  if (error instanceof SlackTransportError) {
    if (error.retryAfterMs !== undefined) return Math.min(15 * 60_000, error.retryAfterMs);
    if (error.code.includes('429') || error.code.includes('ratelimit')) return 1_000;
    return undefined;
  }
  if (!error || typeof error !== 'object' ||
      (error as { code?: unknown }).code !== ErrorCode.RateLimitedError) return undefined;
  const seconds = (error as { retryAfter?: unknown }).retryAfter;
  return Math.min(
    15 * 60_000,
    Math.max(1_000, Math.floor((typeof seconds === 'number' && Number.isFinite(seconds)
      ? seconds
      : 1) * 1_000)),
  );
}

function renderWorkChecklist(checklist: readonly string[], complete: boolean | 'failed'): {
  text: string;
  blocks: Array<{
    type: 'section';
    block_id: 'chickpea_work_checklist';
    text: { type: 'mrkdwn'; text: string };
  }>;
} {
  const lines = checklist.map((item, index) =>
    `${complete === true ? '✓' : complete === 'failed' ? '×' : index === 0 ? '✱' : '○'} ${item}`
  );
  const text = lines.join('\n');
  return {
    text,
    blocks: [{
      type: 'section',
      block_id: 'chickpea_work_checklist',
      text: { type: 'mrkdwn', text },
    }],
  };
}

function renderMilestonePlan(plan: SlackPresentationPlanV3): {
  text: string;
  blocks: Array<{
    type: 'section';
    block_id: 'chickpea_milestone_plan';
    text: { type: 'mrkdwn'; text: string };
  }>;
} | undefined {
  if (plan.tasks.length < 2 || plan.tasks.length > 4 ||
      plan.tasks.every((task) => task.status === 'pending')) return undefined;
  const lines = plan.tasks.map((task) => {
    const marker = task.outcome === 'not_run'
      ? '⊘'
      : task.status === 'complete'
        ? '✓'
        : task.status === 'error'
          ? '×'
          : task.status === 'in_progress'
            ? '✱'
            : '○';
    return `${marker} ${task.title}${task.detail ? ` — ${task.detail}` : ''}`;
  });
  const text = lines.join('\n');
  return {
    text,
    blocks: [{
      type: 'section',
      block_id: 'chickpea_milestone_plan',
      text: { type: 'mrkdwn', text },
    }],
  };
}

export function reactionTextEquivalent(reaction: SemanticReaction): string {
  switch (reaction) {
    case 'agreement': return 'Sounds good.';
    case 'done': return 'Done.';
    case 'seen': return 'Seen.';
    case 'appreciation': return 'Thank you.';
    case 'midwork_seen': return 'Seen.';
    case 'merged': return 'Merged.';
    case 'failed': return 'Failed.';
    case 'approved': return 'Approved.';
    case 'work_ack': return 'I picked this up.';
  }
}
