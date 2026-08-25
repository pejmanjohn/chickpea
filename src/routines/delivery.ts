import { ErrorCode, WebClient, type ChatPostMessageResponse } from '@slack/web-api';

import { isCloudflareTarget } from '../config/runtime-target.ts';
import {
  appendSlackReplyFooter,
  buildSlackAdminUrl,
  escapeSlackControlCharacters,
  renderSlackMessage,
  type RenderedSlackMessage,
  type SlackReplyFooter,
} from '../slack/message-format.ts';
import { ROUTINE_LIMITS } from './limits.ts';
import { RoutineRuntimeError, type RoutineRuntimeAccess } from './runtime.ts';
import type { RoutineDefinition, RoutineRun, RoutineStore } from './types.ts';
import type { ShadowWorkLifecycle } from '../work/lifecycle.ts';
import { agentAvatarUrlForPresentation } from '../slack/agent-presence/avatar-assets.ts';

const ROUTINE_SLACK_TIMEOUT_MS = 10_000;

export interface RoutineDeliveryReceipt {
  channelId: string;
  messageTs: string;
}

/** One at-most-once top-level Slack delivery. Ambiguous transport failures are never retried. */
export async function deliverRoutineResult(
  input: {
    store: RoutineStore;
    run: RoutineRun;
    routine: RoutineDefinition;
    access: RoutineRuntimeAccess;
    message: string;
    changeKeyHash: string | null;
    workLifecycle?: ShadowWorkLifecycle;
    now?: () => number;
  },
  client: WebClient = input.access.client ?? createRoutineSlackClient(requiredRoutineBotToken(input.access)),
): Promise<RoutineDeliveryReceipt> {
  return deliverRoutineSlackMessage(
    { ...input, approvedOutput: input.message },
    renderRoutineDelivery(input.routine, input.run, input.message, routineReplyFooter(input.access)),
    client,
  );
}

export async function deliverRoutineFailureNotice(
  input: {
    store: RoutineStore;
    run: RoutineRun;
    routine: RoutineDefinition;
    access: RoutineRuntimeAccess;
    publicError: string;
    workLifecycle?: ShadowWorkLifecycle;
    now?: () => number;
  },
  client: WebClient = input.access.client ?? createRoutineSlackClient(requiredRoutineBotToken(input.access)),
): Promise<RoutineDeliveryReceipt> {
  const text = [
    `⚠️ **Routine needs attention**`,
    `**${escapeSlackControlCharacters(input.routine.name)}**`,
    '',
    escapeSlackControlCharacters(input.publicError),
    ...(input.routine.state === 'paused'
      ? ['Automatic scheduling is paused until a channel member reviews and resumes it.']
      : input.routine.state === 'disabled'
        ? ['This routine was disabled because its current channel authority is no longer eligible.']
        : []),
  ].join('\n');
  return deliverRoutineSlackMessage(
    { ...input, changeKeyHash: null, approvedOutput: text },
    appendSlackReplyFooter(
      appendRoutineRunContext(
        renderSlackMessage(text, 'markdown'),
        input.routine,
        input.run,
        input.access.publicUrl,
        input.access.config.agentId,
      ),
      routineReplyFooter(input.access),
    ),
    client,
  );
}

async function deliverRoutineSlackMessage(
  input: {
    store: RoutineStore;
    run: RoutineRun;
    routine: RoutineDefinition;
    access: RoutineRuntimeAccess;
    changeKeyHash: string | null;
    approvedOutput: string;
    workLifecycle?: ShadowWorkLifecycle;
    now?: () => number;
  },
  message: string | RenderedSlackMessage,
  client: WebClient,
): Promise<RoutineDeliveryReceipt> {
  const now = input.now ?? Date.now;
  const claimedAt = now();
  const claimed = await input.store.claimDelivery({
    occurrenceId: input.run.id,
    at: claimedAt,
    leaseUntil: claimedAt + ROUTINE_LIMITS.deliveryLeaseMs,
  });
  if (claimed !== 'claimed') {
    throw new RoutineRuntimeError(
      'delivery_unknown',
      'The routine result already has a delivery attempt that requires inspection.',
    );
  }

  const agentAvatarUrl = agentAvatarUrlForPresentation(
    input.access.config.agent,
    input.access.publicUrl,
  );
  const payload = {
    channel: input.routine.channelId,
    ...(typeof message === 'string' ? { text: message } : message),
    username: input.access.config.agent.name,
    ...(agentAvatarUrl
      ? { icon_url: agentAvatarUrl }
      : {}),
    unfurl_links: false,
    unfurl_media: false,
  };
  const workAttemptId = await input.workLifecycle?.beforeDelivery({
    method: 'slack_chat_post_message',
    approvedOutput: input.approvedOutput,
    renderedPayload: JSON.stringify({ method: 'slack_chat_post_message', payload }),
  });

  let response: ChatPostMessageResponse;
  try {
    response = await client.chat.postMessage(payload);
  } catch (error) {
    const rateLimited = slackErrorCode(error) === ErrorCode.RateLimitedError;
    await input.workLifecycle?.afterDelivery({
      attemptId: workAttemptId,
      outcome: rateLimited ? 'failed' : 'unknown',
      safeFailureCode: rateLimited ? 'slack_rate_limited' : 'delivery_unknown',
    });
    await recordFailedDelivery(input.store, input.run.id, rateLimited ? 'failed' : 'unknown', now());
    throw new RoutineRuntimeError(
      rateLimited ? 'slack_rate_limited' : 'delivery_unknown',
      rateLimited
        ? 'Slack rate-limited the routine result; Chickpea did not retry it.'
        : 'Slack delivery may have completed but could not be confirmed; Chickpea did not retry it.',
    );
  }
  const channelId = typeof response.channel === 'string' ? response.channel : undefined;
  const messageTs = typeof response.ts === 'string' ? response.ts : undefined;
  if (!response.ok || channelId !== input.routine.channelId || !messageTs) {
    await input.workLifecycle?.afterDelivery({
      attemptId: workAttemptId,
      outcome: 'unknown',
      safeFailureCode: 'delivery_receipt_incomplete',
    });
    await recordFailedDelivery(input.store, input.run.id, 'unknown', now());
    throw new RoutineRuntimeError(
      'delivery_unknown',
      'Slack delivery returned an incomplete receipt; Chickpea did not retry it.',
    );
  }
  try {
    await input.store.recordDelivery({
      occurrenceId: input.run.id,
      outcome: 'delivered',
      at: now(),
      channelId,
      messageTs,
      changeKeyHash: input.changeKeyHash,
    });
    await input.workLifecycle?.afterDelivery({
      attemptId: workAttemptId,
      outcome: 'delivered',
      deliveryRef: `slack:${channelId}:${messageTs}`,
    });
  } catch {
    await input.workLifecycle?.afterDelivery({
      attemptId: workAttemptId,
      outcome: 'unknown',
      safeFailureCode: 'delivery_receipt_persist_unknown',
    });
    throw new RoutineRuntimeError(
      'unknown_external_outcome',
      'The Slack result was posted but its receipt could not be recorded.',
    );
  }
  return { channelId, messageTs };
}

export function renderRoutineDelivery(
  routine: Pick<RoutineDefinition, 'name' | 'id' | 'timezone'>,
  run: Pick<RoutineRun, 'id' | 'scheduledFor'>,
  message: string,
  footer?: SlackReplyFooter,
): RenderedSlackMessage {
  const rendered = renderSlackMessage(
    `✅ **Routine completed**\n**${escapeSlackControlCharacters(routine.name)}**\n\n${message}`,
    'markdown',
  );
  const fallback = renderSlackMessage(`Routine completed: ${routine.name}\n\n${message}`, 'plain_text');
  const withRunContext = appendRoutineRunContext(
    rendered,
    routine,
    run,
    footer?.publicUrl,
    footer?.agentId,
  );
  const withFallback = { ...withRunContext, text: fallback.text };
  return footer ? appendSlackReplyFooter(withFallback, footer) : withFallback;
}

function appendRoutineRunContext(
  rendered: RenderedSlackMessage,
  routine: Pick<RoutineDefinition, 'id' | 'timezone'>,
  run: Pick<RoutineRun, 'scheduledFor'>,
  publicUrl: string | undefined,
  agentId: string | undefined,
): RenderedSlackMessage {
  return {
    ...rendered,
    blocks: [
      ...(rendered.blocks ?? []),
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: routineRunContext(routine, run, publicUrl, agentId),
        }],
      },
    ],
  };
}

function routineRunContext(
  routine: Pick<RoutineDefinition, 'id' | 'timezone'>,
  run: Pick<RoutineRun, 'scheduledFor'>,
  publicUrl: string | undefined,
  agentId: string | undefined,
): string {
  const scheduled = formatScheduledTime(run.scheduledFor, routine.timezone);
  const adminBase = buildSlackAdminUrl(publicUrl);
  if (!adminBase || !agentId) return `Scheduled ${scheduled}`;
  const detail = new URL(adminBase);
  detail.pathname = `/admin/agents/${encodeURIComponent(agentId)}`;
  detail.search = '?tab=schedules';
  return `Scheduled ${scheduled} · <${detail.toString()}|View schedule>`;
}

function formatScheduledTime(timestamp: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(timestamp).replace(/, (?=\d{1,2}:\d{2})/, ' at ');
  } catch {
    return new Date(timestamp).toISOString();
  }
}

function routineReplyFooter(access: RoutineRuntimeAccess): SlackReplyFooter {
  return {
    agentName: access.config.agent.name,
    modelLabel: access.config.model,
    agentId: access.config.agentId,
    publicUrl: access.publicUrl,
  };
}

function createRoutineSlackClient(botToken: string): WebClient {
  const slackApiUrl = process.env.SLACK_API_URL;
  return new WebClient(botToken, {
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    timeout: ROUTINE_SLACK_TIMEOUT_MS,
    fetch: (request, init) => {
      const patched = isCloudflareTarget() && init?.redirect === 'error'
        ? { ...init, redirect: 'manual' as RequestRedirect }
        : init;
      return globalThis.fetch(request, patched);
    },
    ...(slackApiUrl ? { slackApiUrl } : {}),
  });
}

function requiredRoutineBotToken(access: RoutineRuntimeAccess): string {
  if (!access.botToken) throw new RoutineRuntimeError(
    'credential_unavailable',
    'The Slack connection is unavailable for this routine.',
  );
  return access.botToken;
}

async function recordFailedDelivery(
  store: RoutineStore,
  occurrenceId: string,
  outcome: 'unknown' | 'failed',
  at: number,
): Promise<void> {
  try {
    await store.recordDelivery({ occurrenceId, outcome, at });
  } catch {
    // The outward attempt is already terminal. Never turn state-write failure
    // into a blind second Slack post.
  }
}

function slackErrorCode(error: unknown): unknown {
  return error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
}
