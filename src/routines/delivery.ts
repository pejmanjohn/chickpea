import { ErrorCode, WebClient, type ChatPostMessageResponse } from '@slack/web-api';

import { isCloudflareTarget } from '../config/runtime-target.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import {
  appendSlackReplyFooter,
  buildSlackAdminUrl,
  escapeSlackControlCharacters,
  renderSlackMessage,
  type RenderedSlackMessage,
  type SlackReplyFooter,
} from '../slack/message-format.ts';
import { ROUTINE_LIMITS } from './limits.ts';
import {
  resolveRoutineRuntimeAccess,
  RoutineRuntimeError,
  type RoutineRuntimeAccess,
} from './runtime.ts';
import type {
  RoutineDefinition,
  RoutineRecoveryDelivery,
  RoutineRun,
  RoutineStore,
} from './types.ts';
import type { ShadowWorkLifecycle } from '../work/lifecycle.ts';
import { agentAvatarUrlForPresentation } from '../slack/agent-presence/avatar-assets.ts';

const ROUTINE_SLACK_TIMEOUT_MS = 10_000;
const DEFINITIVE_DIRECT_THREAD_ERRORS = new Set([
  'cannot_reply_to_message',
  'restricted_action_non_threadable_channel',
  'restricted_action_thread_locked',
]);

export const DIRECT_ROUTINE_RECOVERY_NOTICE =
  'Chickpea paused private scheduled work because its original thread could not receive a reply. Ask Chickpea here to list private schedules.';
export const DIRECT_ROUTINE_CONSECUTIVE_FAILURE_NOTICE =
  'Chickpea paused private scheduled work after repeated failures. Ask Chickpea here to list private schedules and resume it after reviewing the issue.';
export const DIRECT_ROUTINE_UNKNOWN_OUTCOME_NOTICE =
  'Chickpea paused private scheduled work because a result may have been delivered without a confirmed outcome. Ask Chickpea here to list private schedules before resuming it.';
export const CHANNEL_ROUTINE_CONSECUTIVE_FAILURE_NOTICE =
  'Chickpea paused scheduled work after repeated failures. Ask Chickpea in this channel to list schedules and resume it after reviewing the issue.';
export const CHANNEL_ROUTINE_UNKNOWN_OUTCOME_NOTICE =
  'Chickpea paused scheduled work because a result may have been delivered without a confirmed outcome. Ask Chickpea in this channel to list schedules before resuming it.';

export interface RoutineDeliveryReceipt {
  channelId: string;
  messageTs: string;
}

export type RoutineRecoveryDeliveryOutcome =
  | 'accepted'
  | 'definitive_failure'
  | 'unknown'
  | 'superseded';

export async function drainRoutinePauseNotices(
  input: { store: RoutineStore; env: PlatformEnv; limit?: number },
  dependencies: {
    resolveAccess?: typeof resolveRoutineRuntimeAccess;
    now?: () => number;
  } = {},
): Promise<{ scanned: number; settled: number }> {
  const pending = await input.store.listPendingRecoveryDeliveries(input.limit ?? 25);
  let settled = 0;
  for (const notice of pending) {
    const run = await input.store.getRun(notice.occurrenceId);
    const routine = run ? await input.store.getRoutine(run.routineId) : undefined;
    if (!run || !routine || !eligibleRecoveryNotice(routine, notice)) {
      if (await settleRecoveryNoticeWithoutPosting(
        input.store,
        notice.occurrenceId,
        (dependencies.now ?? Date.now)(),
      )) settled += 1;
      continue;
    }
    try {
      const access = await (dependencies.resolveAccess ?? resolveRoutineRuntimeAccess)(
        run,
        routine,
        input.env,
      );
      const outcome = await deliverRoutineRecoveryNotice({
        store: input.store,
        run,
        routine,
        access,
      }, access.client);
      if (outcome !== 'superseded') {
        settled += 1;
      } else {
        const current = await input.store.getRecoveryDelivery(notice.occurrenceId);
        if (current?.status === 'pending' && current.claimedAt === null) {
          await input.store.deferRecoveryDelivery({
            occurrenceId: notice.occurrenceId,
            at: (dependencies.now ?? Date.now)(),
          });
        }
      }
    } catch {
      // Access is resolved before claiming the notice, so a transient preflight
      // failure stays pending for a later scheduled heartbeat. Moving it to the
      // back prevents one unavailable identity from starving newer notices.
      await input.store.deferRecoveryDelivery({
        occurrenceId: notice.occurrenceId,
        at: (dependencies.now ?? Date.now)(),
      }).catch(() => undefined);
    }
  }
  return { scanned: pending.length, settled };
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
    sleep?: (delayMs: number) => Promise<void>;
  },
  client: WebClient = input.access.client ?? createRoutineSlackClient(requiredRoutineBotToken(input.access)),
): Promise<RoutineDeliveryReceipt> {
  return deliverRoutineSlackMessage(
    { ...input, approvedOutput: input.message },
    renderRoutineDelivery(
      input.routine,
      input.run,
      input.message,
      routineReplyFooter(input.access, input.routine),
    ),
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
    sleep?: (delayMs: number) => Promise<void>;
  },
  client: WebClient = input.access.client ?? createRoutineSlackClient(requiredRoutineBotToken(input.access)),
): Promise<RoutineDeliveryReceipt> {
  const direct = input.routine.destination.kind === 'direct_thread';
  const text = [
    `⚠️ **Routine needs attention**`,
    `**${escapeSlackControlCharacters(input.routine.name)}**`,
    '',
    escapeSlackControlCharacters(input.publicError),
    ...(input.routine.state === 'paused'
      ? [direct
          ? 'Automatic scheduling is paused until you review and resume it in this DM.'
          : 'Automatic scheduling is paused until a channel member reviews and resumes it.']
      : input.routine.state === 'disabled'
        ? [direct
            ? 'This routine was disabled because its current private scheduling authority is no longer eligible.'
            : 'This routine was disabled because its current channel authority is no longer eligible.']
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
        direct,
      ),
      routineReplyFooter(input.access, input.routine),
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
    sleep?: (delayMs: number) => Promise<void>;
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
    ...(input.routine.destination.kind === 'direct_thread'
      ? { thread_ts: input.routine.destination.threadTs }
      : {}),
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
  let rateLimitRetries = 0;
  while (true) {
    try {
      response = await client.chat.postMessage(payload);
      break;
    } catch (error) {
      const retryAfterMs = slackRateLimitRetryAfterMs(error);
      if (retryAfterMs !== undefined &&
          rateLimitRetries < ROUTINE_LIMITS.deliveryRateLimitMaxRetries &&
          retryAfterMs <= ROUTINE_LIMITS.deliveryRateLimitMaxRetryAfterMs &&
          now() + retryAfterMs + ROUTINE_SLACK_TIMEOUT_MS <= Math.min(
            Number.isSafeInteger(input.run.deadlineAt)
              ? input.run.deadlineAt
              : claimedAt + ROUTINE_LIMITS.deliveryLeaseMs,
            claimedAt + ROUTINE_LIMITS.deliveryLeaseMs,
          )) {
        rateLimitRetries += 1;
        await (input.sleep ?? sleep)(retryAfterMs);
        continue;
      }
      const directThreadUnavailable = input.routine.destination.kind === 'direct_thread' &&
        isDefinitiveDirectThreadError(error);
      const rateLimited = slackErrorCode(error) === ErrorCode.RateLimitedError;
      await input.workLifecycle?.afterDelivery({
        attemptId: workAttemptId,
        outcome: directThreadUnavailable || rateLimited ? 'failed' : 'unknown',
        ...(directThreadUnavailable ? { terminalDisposition: 'failed' as const } : {}),
        safeFailureCode: directThreadUnavailable
          ? 'direct_thread_unavailable'
          : rateLimited ? 'slack_rate_limited' : 'delivery_unknown',
      });
      await recordFailedDelivery(
        input.store,
        input.run.id,
        directThreadUnavailable || rateLimited ? 'failed' : 'unknown',
        now(),
        directThreadUnavailable ? 'direct_thread_unavailable' : undefined,
      );
      if (directThreadUnavailable) {
        throw new RoutineRuntimeError(
          'direct_thread_unavailable',
          'The private routine thread could not receive a reply.',
        );
      }
      throw new RoutineRuntimeError(
        rateLimited ? 'slack_rate_limited' : 'delivery_unknown',
        rateLimited
          ? 'Slack rate-limited the routine result after a bounded retry.'
          : 'Slack delivery may have completed but could not be confirmed; Chickpea did not retry it.',
      );
    }
  }
  const channelId = typeof response.channel === 'string' ? response.channel : undefined;
  const messageTs = typeof response.ts === 'string' ? response.ts : undefined;
  if (input.routine.destination.kind === 'direct_thread' &&
      isDefinitiveDirectThreadError(response)) {
    await input.workLifecycle?.afterDelivery({
      attemptId: workAttemptId,
      outcome: 'failed',
      terminalDisposition: 'failed',
      safeFailureCode: 'direct_thread_unavailable',
    });
    await recordFailedDelivery(
      input.store,
      input.run.id,
      'failed',
      now(),
      'direct_thread_unavailable',
    );
    throw new RoutineRuntimeError(
      'direct_thread_unavailable',
      'The private routine thread could not receive a reply.',
    );
  }
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

export async function deliverRoutineRecoveryNotice(
  input: {
    store: RoutineStore;
    run: RoutineRun;
    routine: RoutineDefinition;
    access: RoutineRuntimeAccess;
    now?: () => number;
  },
  client: WebClient = input.access.client ?? createRoutineSlackClient(requiredRoutineBotToken(input.access)),
): Promise<RoutineRecoveryDeliveryOutcome> {
  const destination = input.routine.destination;
  if (destination.kind === 'direct_thread' && !input.access.actorSlackUserId) {
    return 'superseded';
  }
  const now = input.now ?? Date.now;
  const claimed = await input.store.claimRecoveryDelivery({
    occurrenceId: input.run.id,
    at: now(),
  });
  if (claimed !== 'claimed') return 'superseded';
  const recovery = await input.store.getRecoveryDelivery(input.run.id);
  if (!recovery) return 'superseded';

  if (destination.kind === 'direct_thread') {
    let openResponse: Awaited<ReturnType<WebClient['conversations']['open']>>;
    try {
      openResponse = await client.conversations.open({ users: input.access.actorSlackUserId! });
    } catch (error) {
      const outcome = slackPlatformErrorCode(error) ? 'definitive_failure' : 'unknown';
      await recordRecoveryOutcome(input.store, input.run.id, outcome, now());
      return outcome;
    }
    const opened = openResponse.channel && typeof openResponse.channel === 'object'
      ? openResponse.channel as Record<string, unknown>
      : undefined;
    if (!openResponse.ok || !opened || opened.id !== destination.conversationId ||
        opened.is_mpim === true || opened.is_im !== true) {
      await recordRecoveryOutcome(input.store, input.run.id, 'definitive_failure', now());
      return 'definitive_failure';
    }
  }

  const channelId = destination.kind === 'direct_thread'
    ? destination.conversationId
    : destination.channelId;
  let response: ChatPostMessageResponse;
  try {
    response = await client.chat.postMessage({
      channel: channelId,
      text: routinePauseNotice(recovery.failureClass, destination.kind),
      username: 'Chickpea',
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (error) {
    const outcome = slackPlatformErrorCode(error) ? 'definitive_failure' : 'unknown';
    await recordRecoveryOutcome(input.store, input.run.id, outcome, now());
    return outcome;
  }
  const deliveredChannelId = typeof response.channel === 'string' ? response.channel : undefined;
  const messageTs = typeof response.ts === 'string' ? response.ts : undefined;
  if (response.ok && deliveredChannelId === channelId && messageTs) {
    await recordRecoveryOutcome(input.store, input.run.id, 'accepted', now(), messageTs);
    return 'accepted';
  }
  const outcome = slackPlatformErrorCode(response) ? 'definitive_failure' : 'unknown';
  await recordRecoveryOutcome(input.store, input.run.id, outcome, now());
  return outcome;
}

export function renderRoutineDelivery(
  routine: Pick<RoutineDefinition, 'name' | 'id' | 'timezone' | 'destination'>,
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
    routine.destination.kind === 'direct_thread',
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
  privateDestination = false,
): RenderedSlackMessage {
  return {
    ...rendered,
    blocks: [
      ...(rendered.blocks ?? []),
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: routineRunContext(routine, run, publicUrl, agentId, privateDestination),
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
  privateDestination = false,
): string {
  const scheduled = formatScheduledTime(run.scheduledFor, routine.timezone);
  if (privateDestination) return `Scheduled ${scheduled}`;
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

function routineReplyFooter(
  access: RoutineRuntimeAccess,
  routine: RoutineDefinition,
): SlackReplyFooter {
  return {
    agentName: access.config.agent.name,
    modelLabel: access.config.model,
    agentId: access.config.agentId,
    publicUrl: access.publicUrl,
    ...(routine.destination.kind === 'direct_thread' ? { includeConfigureLink: false } : {}),
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
  failureClass?: 'direct_thread_unavailable',
): Promise<void> {
  try {
    await store.recordDelivery({
      occurrenceId,
      outcome,
      at,
      ...(failureClass ? { failureClass } : {}),
    });
  } catch {
    // The outward attempt is already terminal. Never turn state-write failure
    // into a blind second Slack post.
  }
}

async function recordRecoveryOutcome(
  store: RoutineStore,
  occurrenceId: string,
  outcome: Exclude<RoutineRecoveryDeliveryOutcome, 'superseded'>,
  at: number,
  messageTs?: string,
): Promise<void> {
  try {
    await store.recordRecoveryDelivery({
      occurrenceId,
      outcome,
      at,
      ...(messageTs ? { messageTs } : {}),
    });
  } catch {
    // The durable claim prevents a second outward attempt even if its receipt
    // cannot be finalized.
  }
}

function slackErrorCode(error: unknown): unknown {
  return error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
}

function slackRateLimitRetryAfterMs(error: unknown): number | undefined {
  if (slackErrorCode(error) !== ErrorCode.RateLimitedError ||
      !error || typeof error !== 'object') return undefined;
  const retryAfter = (error as { retryAfter?: unknown }).retryAfter;
  if (typeof retryAfter !== 'number' || !Number.isFinite(retryAfter) || retryAfter <= 0) {
    return undefined;
  }
  return Math.ceil(retryAfter * 1_000);
}

function routinePauseNotice(
  failureClass: RoutineRecoveryDelivery['failureClass'],
  destinationKind: RoutineDefinition['destination']['kind'],
): string {
  if (destinationKind === 'channel') {
    return failureClass === 'consecutive_failures'
      ? CHANNEL_ROUTINE_CONSECUTIVE_FAILURE_NOTICE
      : CHANNEL_ROUTINE_UNKNOWN_OUTCOME_NOTICE;
  }
  return failureClass === 'direct_thread_unavailable'
    ? DIRECT_ROUTINE_RECOVERY_NOTICE
    : failureClass === 'consecutive_failures'
      ? DIRECT_ROUTINE_CONSECUTIVE_FAILURE_NOTICE
      : DIRECT_ROUTINE_UNKNOWN_OUTCOME_NOTICE;
}

function eligibleRecoveryNotice(
  routine: RoutineDefinition,
  notice: RoutineRecoveryDelivery,
): boolean {
  return routine.triggerKind === 'schedule' &&
    !(routine.destination.kind === 'channel' && notice.failureClass === 'direct_thread_unavailable');
}

async function settleRecoveryNoticeWithoutPosting(
  store: RoutineStore,
  occurrenceId: string,
  at: number,
): Promise<boolean> {
  let claim: Awaited<ReturnType<RoutineStore['claimRecoveryDelivery']>>;
  try {
    claim = await store.claimRecoveryDelivery({ occurrenceId, at });
  } catch {
    await store.deferRecoveryDelivery({ occurrenceId, at }).catch(() => undefined);
    return false;
  }
  if (claim !== 'claimed') return false;
  try {
    await store.recordRecoveryDelivery({
      occurrenceId,
      outcome: 'definitive_failure',
      at,
    });
    return true;
  } catch {
    // A claimed cleanup cannot block the pending queue. Maintenance settles a
    // stale ambiguous claim to unknown without another outward attempt.
    return false;
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isDefinitiveDirectThreadError(error: unknown): boolean {
  const code = slackPlatformErrorCode(error);
  return code !== undefined && DEFINITIVE_DIRECT_THREAD_ERRORS.has(code);
}

function slackPlatformErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as Record<string, unknown>;
  if (typeof record.error === 'string') return record.error;
  const data = record.data;
  if (data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string') {
    return (data as { error: string }).error;
  }
  return undefined;
}
