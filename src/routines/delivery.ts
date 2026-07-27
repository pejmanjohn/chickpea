import { ErrorCode, WebClient, type ChatPostMessageResponse } from '@slack/web-api';

import { isCloudflareTarget } from '../config/runtime-target.ts';
import { ROUTINE_LIMITS } from './limits.ts';
import { RoutineRuntimeError, type RoutineRuntimeAccess } from './runtime.ts';
import type { RoutineDefinition, RoutineRun, RoutineStore } from './types.ts';

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
    now?: () => number;
  },
  client: WebClient = createRoutineSlackClient(input.access.botToken),
): Promise<RoutineDeliveryReceipt> {
  return deliverRoutineSlackMessage(input, renderRoutineDelivery(input.routine, input.message), client);
}

export async function deliverRoutineFailureNotice(
  input: {
    store: RoutineStore;
    run: RoutineRun;
    routine: RoutineDefinition;
    access: RoutineRuntimeAccess;
    publicError: string;
    now?: () => number;
  },
  client: WebClient = createRoutineSlackClient(input.access.botToken),
): Promise<RoutineDeliveryReceipt> {
  const text = [
    `*Routine needs attention: ${escapeSlackText(input.routine.name)}*`,
    escapeSlackText(input.publicError),
    ...(input.routine.state === 'paused'
      ? ['Automatic scheduling is paused until a channel member reviews and resumes it.']
      : input.routine.state === 'disabled'
        ? ['This routine was disabled because its current channel authority is no longer eligible.']
        : []),
    `Inspect the safe run history with \`!routines show ${input.routine.id}\`.`,
  ].join('\n');
  return deliverRoutineSlackMessage({ ...input, changeKeyHash: null }, text, client);
}

async function deliverRoutineSlackMessage(
  input: {
    store: RoutineStore;
    run: RoutineRun;
    routine: RoutineDefinition;
    access: RoutineRuntimeAccess;
    changeKeyHash: string | null;
    now?: () => number;
  },
  text: string,
  client: WebClient,
): Promise<RoutineDeliveryReceipt> {
  const now = input.now ?? Date.now;
  const claimed = await input.store.claimDelivery({
    occurrenceId: input.run.id,
    at: now(),
    leaseUntil: now() + ROUTINE_LIMITS.deliveryLeaseMs,
  });
  if (claimed !== 'claimed') {
    throw new RoutineRuntimeError(
      'delivery_unknown',
      'The routine result already has a delivery attempt that requires inspection.',
    );
  }

  let response: ChatPostMessageResponse;
  try {
    response = await client.chat.postMessage({
      channel: input.routine.channelId,
      text,
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (error) {
    const rateLimited = slackErrorCode(error) === ErrorCode.RateLimitedError;
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
  } catch {
    throw new RoutineRuntimeError(
      'unknown_external_outcome',
      'The Slack result was posted but its receipt could not be recorded.',
    );
  }
  return { channelId, messageTs };
}

export function renderRoutineDelivery(routine: Pick<RoutineDefinition, 'name' | 'id'>, message: string): string {
  return `*Routine: ${escapeSlackText(routine.name)}*\n${escapeSlackText(message)}\n\n_Routine ID: \`${routine.id}\`_`;
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

function escapeSlackText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
